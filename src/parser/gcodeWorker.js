/**
 * Web Worker for parsing G-code asynchronously.
 * Extracts linear moves (G0, G1), layer transitions, and extrusion paths.
 */

self.onmessage = function (e) {
  const { type, gcodeText, filamentDiameter = 1.75 } = e.data;

  if (type === 'PARSE') {
    try {
      const result = parseGcode(gcodeText, filamentDiameter);
      self.postMessage({ type: 'SUCCESS', ...result });
    } catch (err) {
      self.postMessage({ type: 'ERROR', error: err.message });
    }
  }
};

function parseGcode(text, filamentDiameter) {
  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;

  let currentX = 0;
  let currentY = 0;
  let currentZ = 0;
  let currentE = 0;
  let lastE = 0;
  let isRelativeE = false;
  let isRelativeXYZ = false;

  let currentLayerIndex = -1;
  let currentLayerZ = 0;

  // Bounding box
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  // Temporary storage per layer
  // Each layer has extrusion moves: [x1, y1, z1, x2, y2, z2, ...]
  const layers = [];
  let currentLayerMoves = [];
  let currentLayerTravels = [];

  function finalizeLayer() {
    if (currentLayerMoves.length > 0 || currentLayerTravels.length > 0) {
      layers.push({
        layerIndex: currentLayerIndex >= 0 ? currentLayerIndex : layers.length,
        z: currentLayerZ,
        extrusionPoints: new Float32Array(currentLayerMoves),
        travelPoints: new Float32Array(currentLayerTravels),
        moveCount: currentLayerMoves.length / 6,
      });
      currentLayerMoves = [];
      currentLayerTravels = [];
    }
  }

  for (let i = 0; i < totalLines; i++) {
    const rawLine = lines[i];
    // Remove comments while checking for layer hints
    const commentIndex = rawLine.indexOf(';');
    let comment = '';
    let command = rawLine;

    if (commentIndex !== -1) {
      comment = rawLine.substring(commentIndex).toUpperCase();
      command = rawLine.substring(0, commentIndex);
    }

    command = command.trim().toUpperCase();

    // Check layer change comments from common slicers (PrusaSlicer, OrcaSlicer, Bambu, Cura)
    if (
      comment.includes('LAYER_CHANGE') ||
      comment.includes('LAYER:') ||
      comment.includes('BEFORE_LAYER_CHANGE')
    ) {
      const match = comment.match(/LAYER[:\s]+(\d+)/i);
      const nextLayerIdx = match ? parseInt(match[1], 10) : layers.length;
      if (nextLayerIdx !== currentLayerIndex) {
        finalizeLayer();
        currentLayerIndex = nextLayerIdx;
      }
    }

    if (!command) continue;

    // Check modal settings
    if (command === 'M82') {
      isRelativeE = false;
    } else if (command === 'M83') {
      isRelativeE = true;
    } else if (command === 'G90') {
      isRelativeXYZ = false;
    } else if (command === 'G91') {
      isRelativeXYZ = true;
    } else if (command.startsWith('G92')) {
      // Coordinate reset
      const eMatch = command.match(/E([\d.-]+)/);
      if (eMatch) {
        currentE = parseFloat(eMatch[1]);
        lastE = currentE;
      }
    } else if (command.startsWith('G0') || command.startsWith('G1')) {
      // Linear move
      const isG0 = command.startsWith('G0');
      const tokens = command.split(/\s+/);

      let targetX = currentX;
      let targetY = currentY;
      let targetZ = currentZ;
      let targetE = currentE;
      let hasE = false;
      let hasMove = false;

      for (let t = 1; t < tokens.length; t++) {
        const token = tokens[t];
        const prefix = token[0];
        const val = parseFloat(token.substring(1));
        if (isNaN(val)) continue;

        if (prefix === 'X') {
          targetX = isRelativeXYZ ? currentX + val : val;
          hasMove = true;
        } else if (prefix === 'Y') {
          targetY = isRelativeXYZ ? currentY + val : val;
          hasMove = true;
        } else if (prefix === 'Z') {
          targetZ = isRelativeXYZ ? currentZ + val : val;
          hasMove = true;
        } else if (prefix === 'E') {
          targetE = isRelativeE ? currentE + val : val;
          hasE = true;
        }
      }

      // Check if Z changed significantly without a layer comment
      if (targetZ !== currentZ && Math.abs(targetZ - currentLayerZ) > 0.05 && currentLayerMoves.length > 0) {
        finalizeLayer();
        currentLayerIndex++;
        currentLayerZ = targetZ;
      }

      if (hasMove) {
        const deltaE = isRelativeE ? (targetE - currentE) : (targetE - lastE);
        const isExtrusion = !isG0 && hasE && deltaE > 0.0001;

        if (isExtrusion) {
          currentLayerMoves.push(currentX, currentY, currentZ, targetX, targetY, targetZ);
          currentLayerZ = targetZ;

          // Track bounds for extrusion only
          minX = Math.min(minX, currentX, targetX);
          maxX = Math.max(maxX, currentX, targetX);
          minY = Math.min(minY, currentY, targetY);
          maxY = Math.max(maxY, currentY, targetY);
          minZ = Math.min(minZ, currentZ, targetZ);
          maxZ = Math.max(maxZ, currentZ, targetZ);
        } else {
          // Travel move (skip pure Z hops or huge origin resets to keep buffer clean)
          const distSq = (targetX - currentX) ** 2 + (targetY - currentY) ** 2;
          if (distSq > 0.01 && distSq < 50000) {
            currentLayerTravels.push(currentX, currentY, currentZ, targetX, targetY, targetZ);
          }
        }

        currentX = targetX;
        currentY = targetY;
        currentZ = targetZ;
        if (hasE) {
          lastE = targetE;
          currentE = targetE;
        }
      }
    }

    // Periodic progress report for very large files
    if (i % 25000 === 0 && i > 0) {
      self.postMessage({
        type: 'PROGRESS',
        percent: Math.round((i / totalLines) * 100),
      });
    }
  }

  finalizeLayer();

  // If no bounding box found, set defaults
  if (minX === Infinity) {
    minX = 0; maxX = 100;
    minY = 0; maxY = 100;
    minZ = 0; maxZ = 20;
  }

  return {
    layers,
    totalLayers: layers.length,
    bounds: {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      size: [maxX - minX, maxY - minY, maxZ - minZ],
      center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    },
  };
}
