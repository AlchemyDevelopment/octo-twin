/**
 * Real-time 3D print telemetry simulator.
 * Steps through parsed G-code toolpaths, simulating live printer movements,
 * temperatures, layer progression, and print statistics.
 */
export class PrintSimulator {
  constructor(gcodeRenderer, toolhead, onTelemetry) {
    this.renderer = gcodeRenderer;
    this.toolhead = toolhead;
    this.onTelemetry = onTelemetry;

    this.isPlaying = false;
    this.speedMultiplier = 10; // Default 10x
    this.currentLayer = 0;
    this.progressInLayer = 0;
    this.totalLayers = 0;

    this.simulatedExtruderTemp = 215;
    this.simulatedBedTemp = 60;
    this.currentExtruderTemp = 25;
    this.currentBedTemp = 25;

    this.elapsedSeconds = 0;
    this.estimatedTotalSeconds = 1200; // 20 mins simulated
  }

  setGcodeData(parsedData) {
    this.parsedData = parsedData;
    this.totalLayers = parsedData.layers ? parsedData.layers.length : 0;
    this.reset();
  }

  reset() {
    this.isPlaying = false;
    this.currentLayer = 0;
    this.progressInLayer = 0;
    this.elapsedSeconds = 0;
    this.currentExtruderTemp = 25;
    this.currentBedTemp = 25;

    if (this.renderer) {
      this.renderer.updateProgress(0, 0);
    }
    if (this.toolhead) {
      this.toolhead.setPositionImmediate(117.5, 117.5, 10);
      this.toolhead.updateTemperature(25, 215);
    }
    this.emitTelemetry();
  }

  play() {
    this.isPlaying = true;
  }

  pause() {
    this.isPlaying = false;
  }

  setSpeed(multiplier) {
    this.speedMultiplier = Math.max(1, multiplier);
  }

  scrub(overallRatio) {
    if (!this.parsedData || this.totalLayers === 0) return;
    const clamped = Math.max(0, Math.min(1.0, overallRatio));
    const totalStep = clamped * this.totalLayers;
    this.currentLayer = Math.min(this.totalLayers - 1, Math.floor(totalStep));
    this.progressInLayer = totalStep - this.currentLayer;

    this.updateVisuals();
    this.emitTelemetry();
  }

  update(deltaSeconds) {
    if (!this.isPlaying || !this.parsedData || this.totalLayers === 0) return;

    // Simulate heating up in the first few seconds
    if (this.currentExtruderTemp < this.simulatedExtruderTemp) {
      this.currentExtruderTemp = Math.min(this.simulatedExtruderTemp, this.currentExtruderTemp + deltaSeconds * 30);
    }
    if (this.currentBedTemp < this.simulatedBedTemp) {
      this.currentBedTemp = Math.min(this.simulatedBedTemp, this.currentBedTemp + deltaSeconds * 10);
    }

    // Advance print progress based on speed
    const layer = this.parsedData.layers[this.currentLayer];
    const movesInLayer = (layer && layer.moveCount) ? layer.moveCount : 50;

    // Time per move scaled by speed
    const baseMovesPerSec = 8;
    const movesThisTick = baseMovesPerSec * this.speedMultiplier * deltaSeconds;
    const progressDelta = movesThisTick / movesInLayer;

    this.progressInLayer += progressDelta;
    this.elapsedSeconds += deltaSeconds * this.speedMultiplier;

    if (this.progressInLayer >= 1.0) {
      this.progressInLayer = 0;
      this.currentLayer++;

      if (this.currentLayer >= this.totalLayers) {
        this.currentLayer = this.totalLayers - 1;
        this.progressInLayer = 1.0;
        this.isPlaying = false; // Finished!
      }
    }

    this.updateVisuals();
    this.emitTelemetry();
  }

  updateVisuals() {
    if (this.renderer) {
      this.renderer.updateProgress(this.currentLayer, this.progressInLayer);
    }

    // Find nozzle position from current progress
    if (this.renderer && this.toolhead) {
      const coords = this.renderer.getCurrentLayerCoordinates(this.progressInLayer);
      if (coords) {
        this.toolhead.setTargetPosition(coords.x, coords.y, coords.z);
      }
      this.toolhead.updateTemperature(this.currentExtruderTemp, this.simulatedExtruderTemp);
    }
  }

  emitTelemetry() {
    if (!this.onTelemetry) return;

    const overallProgress = this.totalLayers > 0
      ? (this.currentLayer + this.progressInLayer) / this.totalLayers
      : 0;

    const remainingSec = Math.max(0, this.estimatedTotalSeconds - this.elapsedSeconds);

    const coords = this.renderer
      ? this.renderer.getCurrentLayerCoordinates(this.progressInLayer)
      : null;

    this.onTelemetry({
      type: 'TELEMETRY',
      isSimulated: true,
      x: coords ? coords.x : 117.5,
      y: coords ? coords.y : 117.5,
      z: coords ? coords.z : 0.28,
      currentLayer: this.currentLayer + 1,
      totalLayers: this.totalLayers,
      progress: overallProgress,
      toolTemp: Math.round(this.currentExtruderTemp),
      toolTarget: this.simulatedExtruderTemp,
      bedTemp: Math.round(this.currentBedTemp),
      bedTarget: this.simulatedBedTemp,
      elapsedTime: Math.round(this.elapsedSeconds),
      remainingTime: Math.round(remainingSec),
      printState: this.isPlaying ? 'PRINTING' : (overallProgress >= 0.999 ? 'COMPLETE' : 'PAUSED'),
      filename: 'demo_vase.gcode',
    });
  }
}
