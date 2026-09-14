/**
 * Generates a realistic, sleek demonstration G-code model.
 * Produces a stylized twisted polygonal vase with solid base, perimeters, and infill.
 */
export function generateDemoGcode() {
  const lines = [];
  lines.push('; --- OCTO-TWIN DEMO G-CODE ---');
  lines.push('; Generated for real-time 3D simulation');
  lines.push('G90 ; Absolute positioning');
  lines.push('M83 ; Relative extrusion');
  lines.push('M104 S215 ; Set Hotend Temp');
  lines.push('M140 S60 ; Set Bed Temp');
  lines.push('G28 ; Home all axes');

  const centerX = 117.5;
  const centerY = 117.5;
  const numLayers = 45;
  const layerHeight = 0.28;
  const sides = 6;
  const baseRadius = 28;

  let currentE = 0;

  // Layer 0: Prime line
  lines.push(';LAYER:0');
  lines.push('G1 Z0.28 F3000');
  lines.push(`G1 X${centerX - 40} Y${centerY - 40} F6000`);
  lines.push(`G1 X${centerX + 40} Y${centerY - 40} E4.5 F1200`);
  lines.push(`G1 X${centerX + 40} Y${centerY - 39} E0.5 F3000`);
  lines.push(`G1 X${centerX - 40} Y${centerY - 39} E4.5 F1200`);

  // Layers 1 to 4: Solid bottom base
  for (let l = 1; l <= 4; l++) {
    const z = (l * layerHeight).toFixed(2);
    lines.push(`;LAYER:${l}`);
    lines.push(`G1 Z${z} F3000`);

    // Infill lines
    const step = 2.0;
    const r = baseRadius * 0.95;
    for (let y = -r; y <= r; y += step) {
      const halfWidth = Math.sqrt(Math.max(0, r * r - y * y));
      const x1 = (centerX - halfWidth).toFixed(2);
      const x2 = (centerX + halfWidth).toFixed(2);
      const yCoord = (centerY + y).toFixed(2);

      lines.push(`G0 X${x1} Y${yCoord} F6000`);
      const len = 2 * halfWidth;
      const e = (len * 0.05).toFixed(3);
      lines.push(`G1 X${x2} Y${yCoord} E${e} F1800`);
    }

    // Outer ring for base
    for (let s = 0; s <= sides; s++) {
      const angle = (s / sides) * Math.PI * 2;
      const x = (centerX + Math.cos(angle) * r).toFixed(2);
      const y = (centerY + Math.sin(angle) * r).toFixed(2);
      if (s === 0) {
        lines.push(`G0 X${x} Y${y} F6000`);
      } else {
        lines.push(`G1 X${x} Y${y} E1.8 F2400`);
      }
    }
  }

  // Layers 5 to numLayers: Twisted geometric vase with dual perimeters
  for (let l = 5; l <= numLayers; l++) {
    const z = (l * layerHeight).toFixed(2);
    lines.push(`;LAYER:${l}`);
    lines.push(`G1 Z${z} F3000`);

    const twist = (l * 0.07);
    const radiusMod = 1 + 0.25 * Math.sin((l / numLayers) * Math.PI);
    const rOuter = baseRadius * radiusMod;
    const rInner = rOuter - 0.8;

    // Outer perimeter
    for (let s = 0; s <= sides; s++) {
      const angle = (s / sides) * Math.PI * 2 + twist;
      const x = (centerX + Math.cos(angle) * rOuter).toFixed(2);
      const y = (centerY + Math.sin(angle) * rOuter).toFixed(2);
      if (s === 0) {
        lines.push(`G0 X${x} Y${y} F6000`);
      } else {
        const segLen = (2 * Math.PI * rOuter) / sides;
        const e = (segLen * 0.045).toFixed(3);
        lines.push(`G1 X${x} Y${y} E${e} F2700`);
      }
    }

    // Inner perimeter
    for (let s = 0; s <= sides; s++) {
      const angle = (s / sides) * Math.PI * 2 + twist;
      const x = (centerX + Math.cos(angle) * rInner).toFixed(2);
      const y = (centerY + Math.sin(angle) * rInner).toFixed(2);
      if (s === 0) {
        lines.push(`G0 X${x} Y${y} F6000`);
      } else {
        const segLen = (2 * Math.PI * rInner) / sides;
        const e = (segLen * 0.045).toFixed(3);
        lines.push(`G1 X${x} Y${y} E${e} F2400`);
      }
    }
  }

  lines.push('; --- END OF GCODE ---');
  lines.push('M104 S0 ; Turn off hotend');
  lines.push('M140 S0 ; Turn off bed');
  lines.push('G1 Z50 F3000 ; Raise head');
  lines.push('G28 X0 Y0 ; Park');
  lines.push('M84 ; Disable motors');

  return lines.join('\n');
}
