import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * Three.js Scene manager for 3D printer build plate, lighting,
 * camera view presets, and render loop.
 */
export class PrinterScene {
  constructor(containerElement, bedDimensions = { x: 350, y: 350, z: 400 }) {
    this.container = containerElement;
    this.bedDimensions = bedDimensions;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0e14); // Deep space slate

    this.clock = new THREE.Clock();
    this.followToolhead = false;
    this.toolheadRef = null;

    this.initRenderer();
    this.initCamera();
    this.initLights();
    this.initBuildPlate();
    this.initControls();

    window.addEventListener('resize', this.onResize.bind(this));
  }

  initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
    });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.container.appendChild(this.renderer.domElement);
  }

  initCamera() {
    const aspect = this.container.clientWidth / this.container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.5, 2000);
    this.resetCameraToIsometric();
  }

  initControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.screenSpacePanning = true; // Natural Blender / CAD style panning
    this.controls.minDistance = 20;
    this.controls.maxDistance = 1200;
    this.controls.maxPolarAngle = Math.PI - 0.05; // Full 360 vertical orbit freedom
    this.controls.target.set(this.bedDimensions.x / 2, this.bedDimensions.y / 2, 20);
    this.controls.update();
  }

  initLights() {
    // 1. Balanced ambient light
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.9);
    this.scene.add(this.ambientLight);

    // 2. Key directional light
    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
    this.keyLight.position.set(this.bedDimensions.x * 1.2, -this.bedDimensions.y * 0.8, 300);
    this.keyLight.castShadow = true;
    this.scene.add(this.keyLight);

    // 3. Fill directional light from opposite side
    this.fillLight = new THREE.DirectionalLight(0xffffff, 0.6);
    this.fillLight.position.set(-this.bedDimensions.x * 0.8, this.bedDimensions.y * 1.2, 250);
    this.scene.add(this.fillLight);
  }

  initBuildPlate() {
    const { x, y } = this.bedDimensions;

    if (this.bedGroup) {
      this.scene.remove(this.bedGroup);
    }

    this.bedGroup = new THREE.Group();

    // 1. Bed base plate (Textured PEI Spring Steel look)
    const bedGeom = new THREE.BoxGeometry(x, y, 4);
    this.bedColor = this.bedColor || 0x14171f; // True stealth matte black
    this.bedMaterial = new THREE.MeshStandardMaterial({
      color: this.bedColor,
      metalness: 0.2,
      roughness: 0.85,
    });
    this.bedMesh = new THREE.Mesh(bedGeom, this.bedMaterial);
    this.bedMesh.position.set(x / 2, y / 2, -2);
    this.bedMesh.receiveShadow = true;
    this.bedGroup.add(this.bedMesh);

    // 2. Subtle beveled edge border
    const edgeGeom = new THREE.BoxGeometry(x + 2, y + 2, 3.8);
    this.edgeMaterial = new THREE.MeshStandardMaterial({
      color: 0x222734,
      metalness: 0.7,
      roughness: 0.4,
    });
    this.edgeMesh = new THREE.Mesh(edgeGeom, this.edgeMaterial);
    edgeMesh.position.set(x / 2, y / 2, -2.1);
    this.bedGroup.add(this.edgeMesh);

    // 3. Precision 10mm Grid lines (aligned to printer dimensions)
    const divisions = Math.round(Math.max(x, y) / 10); // Exactly 10mm per square
    this.gridHelper = new THREE.GridHelper(
      Math.max(x, y),
      divisions,
      0x4a5568, // Center line subtle slate
      0x28303e  // Secondary lines subtle
    );
    this.gridHelper.rotation.x = Math.PI / 2;
    this.gridHelper.position.set(x / 2, y / 2, 0.02);
    this.bedGroup.add(this.gridHelper);

    // 4. Subtle origin badge
    const axesHelper = new THREE.AxesHelper(30);
    axesHelper.position.set(0, 0, 0.1);
    this.bedGroup.add(axesHelper);

    // 5. Build volume cage (subtle, off by default)
    const boundGeom = new THREE.BoxGeometry(x, y, this.bedDimensions.z);
    const boundEdges = new THREE.EdgesGeometry(boundGeom);
    this.boundLine = new THREE.LineSegments(
      boundEdges,
      new THREE.LineBasicMaterial({ color: 0x3b4252, transparent: true, opacity: 0.15 })
    );
    this.boundLine.position.set(x / 2, y / 2, this.bedDimensions.z / 2);
    this.boundLine.visible = false; // Keep clean and uncluttered by default
    this.bedGroup.add(this.boundLine);

    this.scene.add(this.bedGroup);
  }

  setBedColor(hex) {
    this.bedColor = hex;
    if (this.bedMaterial) {
      this.bedMaterial.color.set(hex);
      if (this.bedMaterial.emissive) {
        this.bedMaterial.emissive.set(0x000000);
      }
      this.bedMaterial.needsUpdate = true;
    }
  }

  setBackgroundColor(hex) {
    this.scene.background.set(hex);
  }

  setCageVisibility(visible) {
    if (this.boundLine) this.boundLine.visible = visible;
  }

  setGridVisibility(visible) {
    if (this.gridHelper) this.gridHelper.visible = visible;
  }

  focusOnBounds(bounds) {
    if (!bounds || !this.controls) return;
    const center = bounds.center || [this.bedDimensions.x / 2, this.bedDimensions.y / 2, 20];
    const size = bounds.size || [100, 100, 50];
    const maxDim = Math.max(size[0], size[1], size[2], 50);

    this.controls.target.set(center[0], center[1], center[2]);
    this.camera.position.set(
      center[0] + maxDim * 1.2,
      center[1] - maxDim * 1.4,
      center[2] + maxDim * 1.1
    );
    this.controls.update();
  }

  setBedDimensions(dims) {
    this.bedDimensions = dims;
    this.initBuildPlate();
    this.controls.target.set(dims.x / 2, dims.y / 2, 20);
    this.controls.update();
  }

  updateBedTemperature(temp, targetTemp) {
    // Keep bed surface clean; only subtly warm the edge accent if hot
    if (this.edgeMaterial) {
      const isHot = temp > 45;
      if (isHot) {
        this.edgeMaterial.color.set(0x38221f); // Warm dark undertone on edge only
      } else {
        this.edgeMaterial.color.set(0x222734);
      }
    }
  }

  resetCameraToIsometric() {
    const { x, y } = this.bedDimensions;
    this.camera.position.set(x * 0.5, -y * 1.0, 240);
    if (this.controls) {
      this.controls.target.set(x / 2, y / 2, 25);
      this.controls.update();
    }
  }

  setCameraView(preset) {
    const { x, y, z } = this.bedDimensions;
    this.followToolhead = false;

    if (preset === 'ISO') {
      this.camera.position.set(x * 0.5, -y * 0.9, 230);
      this.controls.target.set(x / 2, y / 2, 25);
    } else if (preset === 'TOP') {
      this.camera.position.set(x / 2, y / 2, 380);
      this.controls.target.set(x / 2, y / 2, 0);
    } else if (preset === 'FRONT') {
      this.camera.position.set(x / 2, -y * 1.3, 100);
      this.controls.target.set(x / 2, y / 2, 40);
    } else if (preset === 'SIDE') {
      this.camera.position.set(x * 1.8, y / 2, 100);
      this.controls.target.set(x / 2, y / 2, 40);
    } else if (preset === 'FOLLOW') {
      this.followToolhead = true;
    }

    this.controls.update();
  }

  setToolheadReference(toolhead) {
    this.toolheadRef = toolhead;
  }

  onResize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  render(onUpdateCallback) {
    const loop = () => {
      requestAnimationFrame(loop);
      const delta = this.clock.getDelta();

      if (onUpdateCallback) onUpdateCallback(delta);

      if (this.followToolhead && this.toolheadRef) {
        const targetPos = this.toolheadRef.currentPosition;
        this.controls.target.lerp(targetPos, 0.1);
      }

      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }
}
