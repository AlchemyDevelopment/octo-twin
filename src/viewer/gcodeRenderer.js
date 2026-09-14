import * as THREE from 'three';

/**
 * High-performance G-code toolpath renderer for Three.js.
 * Handles layer-by-layer dynamic slicing, progress clipping, and filament materials.
 */
export class GcodeRenderer {
  constructor(scene) {
    this.scene = scene;
    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);

    this.layers = [];
    this.layerMeshes = [];
    this.travelMeshes = [];
    this.activeLayerMesh = null;
    this.activeLayerGeometry = null;

    this.filamentColor = 0x00f0ff; // Neon Cyan default
    this.travelColor = 0x3b4252;
    this.ghostColor = 0x2e3440;

    this.currentLayerIndex = 0;
    this.currentProgressInLayer = 1.0;
    this.showGhost = true;
    this.showTravel = false;
    this.viewMode = 'LIVE'; // 'LIVE', 'FULL', 'LAYER_SOLO'

    this.initMaterials();
  }

  initMaterials() {
    this.solidMaterial = new THREE.LineBasicMaterial({
      color: this.filamentColor,
      linewidth: 1,
    });

    this.ghostMaterial = new THREE.LineBasicMaterial({
      color: 0x4c566a,
      transparent: true,
      opacity: 0.15,
      depthWrite: false,
    });

    this.activeMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff, // Glowing active line
      linewidth: 2,
    });

    this.travelMaterial = new THREE.LineBasicMaterial({
      color: this.travelColor,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
    });
  }

  setFilamentColor(hex) {
    this.filamentColor = hex;
    this.solidMaterial.color.set(hex);
  }

  setGcodeData(parsedData) {
    this.clear();
    this.layers = parsedData.layers || [];
    this.bounds = parsedData.bounds;

    if (this.layers.length === 0) return;

    // Create LineSegments for each layer
    this.layers.forEach((layer, idx) => {
      // Extrusion geometry
      if (layer.extrusionPoints && layer.extrusionPoints.length > 0) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute(
          'position',
          new THREE.BufferAttribute(layer.extrusionPoints, 3)
        );

        const mesh = new THREE.LineSegments(geom, this.solidMaterial);
        mesh.userData = { layerIndex: idx, z: layer.z };
        this.modelGroup.add(mesh);
        this.layerMeshes.push(mesh);
      } else {
        this.layerMeshes.push(null);
      }

      // Travel geometry
      if (layer.travelPoints && layer.travelPoints.length > 0) {
        const travelGeom = new THREE.BufferGeometry();
        travelGeom.setAttribute(
          'position',
          new THREE.BufferAttribute(layer.travelPoints, 3)
        );
        const travelMesh = new THREE.LineSegments(travelGeom, this.travelMaterial);
        travelMesh.visible = this.showTravel;
        this.modelGroup.add(travelMesh);
        this.travelMeshes.push(travelMesh);
      } else {
        this.travelMeshes.push(null);
      }
    });

    // Dynamic active layer mesh
    this.activeLayerGeometry = new THREE.BufferGeometry();
    this.activeLayerMesh = new THREE.LineSegments(this.activeLayerGeometry, this.activeMaterial);
    this.modelGroup.add(this.activeLayerMesh);

    // Initial update
    this.updateProgress(0, 0);
  }

  updateProgress(layerIndex, progressRatio = 1.0, isLive = false) {
    if (this.layers.length === 0) return;

    const clampedLayer = Math.max(0, Math.min(layerIndex, this.layers.length - 1));
    const clampedRatio = Math.max(0, Math.min(1.0, progressRatio));

    const layerChanged = (clampedLayer !== this.currentLayerIndex);
    const viewChanged = (this.viewMode !== this.lastRenderedViewMode);
    const ghostChanged = (this.showGhost !== this.lastRenderedGhost);
    const travelChanged = (this.showTravel !== this.lastRenderedTravel);
    const liveChanged = (isLive !== this.lastRenderedIsLive);

    this.currentLayerIndex = clampedLayer;
    this.currentProgressInLayer = clampedRatio;

    // Early return in live mode if layer and view options haven't changed
    if (isLive && !layerChanged && !viewChanged && !ghostChanged && !travelChanged && !liveChanged) {
      return;
    }

    this.lastRenderedViewMode = this.viewMode;
    this.lastRenderedGhost = this.showGhost;
    this.lastRenderedTravel = this.showTravel;
    this.lastRenderedIsLive = isLive;

    if (this.viewMode === 'FULL') {
      // Show all layers in solid
      this.layerMeshes.forEach((mesh) => {
        if (mesh) {
          mesh.visible = true;
          mesh.material = this.solidMaterial;
        }
      });
      if (this.activeLayerMesh) this.activeLayerMesh.visible = false;
      return;
    }

    if (this.viewMode === 'LAYER_SOLO') {
      // Show only current layer
      this.layerMeshes.forEach((mesh, idx) => {
        if (mesh) mesh.visible = (idx === this.currentLayerIndex);
      });
      if (this.activeLayerMesh) this.activeLayerMesh.visible = false;
      return;
    }

    // Default: 'LIVE' print progress mode
    for (let i = 0; i < this.layerMeshes.length; i++) {
      const mesh = this.layerMeshes[i];
      if (!mesh) continue;

      if (i < this.currentLayerIndex || (isLive && i === this.currentLayerIndex)) {
        // Printed layers (including active layer in live mode)
        mesh.visible = true;
        mesh.material = this.solidMaterial;
      } else if (i === this.currentLayerIndex && !isLive) {
        // In simulation scrub, hide full mesh and draw partial
        mesh.visible = false;
      } else {
        // Future unprinted layers: ghosted or hidden
        mesh.visible = this.showGhost;
        mesh.material = this.ghostMaterial;
      }

      if (this.travelMeshes[i]) {
        this.travelMeshes[i].visible = this.showTravel && (i <= this.currentLayerIndex);
      }
    }

    // Progressive active layer only for simulation playback, not live printer
    if (!isLive) {
      const activeLayer = this.layers[this.currentLayerIndex];
      if (activeLayer && activeLayer.extrusionPoints && activeLayer.extrusionPoints.length > 0) {
        const totalPoints = activeLayer.extrusionPoints.length / 3;
        const countToDraw = Math.floor(totalPoints * this.currentProgressInLayer);
        const clampedCount = countToDraw - (countToDraw % 2);

        if (clampedCount > 0) {
          const subArray = activeLayer.extrusionPoints.subarray(0, clampedCount * 3);
          this.activeLayerGeometry.setAttribute(
            'position',
            new THREE.BufferAttribute(subArray, 3)
          );
          this.activeLayerMesh.visible = true;
        } else {
          this.activeLayerMesh.visible = false;
        }
      } else if (this.activeLayerMesh) {
        this.activeLayerMesh.visible = false;
      }
    } else if (this.activeLayerMesh) {
      this.activeLayerMesh.visible = false;
    }
  }

  getCurrentLayerCoordinates(progressRatio) {
    const layer = this.layers[this.currentLayerIndex];
    if (!layer || !layer.extrusionPoints || layer.extrusionPoints.length === 0) {
      return null;
    }
    const totalMoves = layer.extrusionPoints.length / 6;
    const moveIdx = Math.min(totalMoves - 1, Math.floor(totalMoves * progressRatio));
    const base = moveIdx * 6;
    return {
      x: layer.extrusionPoints[base + 3],
      y: layer.extrusionPoints[base + 4],
      z: layer.extrusionPoints[base + 5],
    };
  }

  setViewMode(mode) {
    this.viewMode = mode;
    this.updateProgress(this.currentLayerIndex, this.currentProgressInLayer);
  }

  setShowGhost(show) {
    this.showGhost = show;
    this.updateProgress(this.currentLayerIndex, this.currentProgressInLayer);
  }

  setShowTravel(show) {
    this.showTravel = show;
    this.travelMeshes.forEach((mesh, idx) => {
      if (mesh) mesh.visible = show && (idx <= this.currentLayerIndex);
    });
  }

  clear() {
    while (this.modelGroup.children.length > 0) {
      const child = this.modelGroup.children[0];
      if (child.geometry) child.geometry.dispose();
      this.modelGroup.remove(child);
    }
    this.layerMeshes = [];
    this.travelMeshes = [];
    this.layers = [];
    this.activeLayerMesh = null;
    this.activeLayerGeometry = null;
  }
}
