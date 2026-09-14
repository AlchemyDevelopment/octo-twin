/**
 * High-throughput Web Worker for parsing G-code files.
 * Uses index scanning to handle multi-megabyte files with minimal memory overhead.
 */

self.onmessage = function (e) {
  const { type, gcodeText } = e.data;

  if (type === 'PARSE') {
    try {
      const result = parseGcode(gcodeText);
      self.postMessage({ type: 'SUCCESS', ...result });
    } catch (err) {
      self.postMessage({ type: 'ERROR', error: err.message });
    }
  }
};

function parseGcode(text) {
  const textLen = text.length;
  let lineStart = 0;

  let currentX = 0;
  let currentY = 0;
  let currentZ = 0;
  let currentE = 0;
  let lastE = 0;
  let isRelativeE = false;
  let isRelativeXYZ = false;

  let currentLayerIndex = 0;
  let currentLayerZ = 0;

  // Bounding box
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  const layers = [];
  let currentLayerMoves = [];
  let currentLayerTravels = [];

  function finalizeLayer() {
    if (currentLayerMoves.length > 0 || currentLayerTravels.length > 0) {
      layers.push({
        layerIndex: layers.length,
        z: currentLayerZ,
        extrusionPoints: new Float32Array(currentLayerMoves),
        travelPoints: new Float32Array(currentLayerTravels),
        moveCount: currentLayerMoves.length / 6,
      });
      currentLayerMoves = [];
      currentLayerTravels = [];
    }
  }

  let lineCount = 0;
  let lastProgressReport = 0;

  while (lineStart < textLen) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = textLen;

    let line = text.substring(lineStart, lineEnd);
    lineStart = lineEnd + 1;
    lineCount++;

    // Strip carriage return
    if (line.endsWith('\r')) {
      line = line.substring(0, line.length - 1);
    }

    // Comment extraction
    const commentIndex = line.indexOf(';');
    let comment = '';
    let command = line;

    if (commentIndex !== -1) {
      comment = line.substring(commentIndex).toUpperCase();
      command = line.substring(0, commentIndex);
    }

    command = command.trim().toUpperCase();

    // Check layer changes (PrusaSlicer, OrcaSlicer, Cura, Bambu)
    if (comment.includes('LAYER_CHANGE') || comment.includes('BEFORE_LAYER_CHANGE') || comment.includes('LAYER:')) {
      finalizeLayer();
      currentLayerIndex = layers.length;
    }

    if (comment.startsWith(';Z:')) {
      const zVal = parseFloat(comment.substring(3));
      if (!isNaN(zVal)) {
        currentLayerZ = zVal;
      }
    }

    if (!command) continue;

    // Check modal commands
    if (command === 'M82') {
      isRelativeE = false;
    } else if (command === 'M83') {
      isRelativeE = true;
    } else if (command === 'G90') {
      isRelativeXYZ = false;
    } else if (command === 'G91') {
      isRelativeXYZ = true;
    } else if (command.startsWith('G92')) {
      const match = command.match(/E([\d.-]+)/);
      if (match) {
        currentE = parseFloat(match[1]);
        lastE = currentE;
      }
    } else if (command.startsWith('G0') || command.startsWith('G1')) {
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

      if (targetZ !== currentZ && Math.abs(targetZ - currentLayerZ) > 0.04 && currentLayerMoves.length > 0) {
        finalizeLayer();
        currentLayerIndex = layers.length;
        currentLayerZ = targetZ;
      }

      if (hasMove) {
        const deltaE = isRelativeE ? targetE : (targetE - lastE);
        const isExtrusion = !isG0 && hasE && deltaE > 0.0001;

        if (isExtrusion) {
          currentLayerMoves.push(currentX, currentY, currentZ, targetX, targetY, targetZ);
          currentLayerZ = targetZ;

          minX = Math.min(minX, currentX, targetX);
          maxX = Math.max(maxX, currentX, targetX);
          minY = Math.min(minY, currentY, targetY);
          maxY = Math.max(maxY, currentY, targetY);
          minZ = Math.min(minZ, currentZ, targetZ);
          maxZ = Math.max(maxZ, currentZ, targetZ);
        } else {
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

    if (lineCount - lastProgressReport > 50000) {
      lastProgressReport = lineCount;
      self.postMessage({
        type: 'PROGRESS',
        percent: Math.round((lineStart / textLen) * 100),
      });
    }
  }

  finalizeLayer();

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
