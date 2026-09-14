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
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI / 2 + 0.05; // Prevent camera from going under bed
    this.controls.target.set(this.bedDimensions.x / 2, this.bedDimensions.y / 2, 20);
    this.controls.update();
  }

  initLights() {
    // 1. Ambient lighting for soft visibility
    const ambientLight = new THREE.AmbientLight(0xdde5ed, 0.8);
    this.scene.add(ambientLight);

    // 2. Key directional light
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
    keyLight.position.set(this.bedDimensions.x * 1.5, -this.bedDimensions.y * 0.8, 350);
    keyLight.castShadow = true;
    this.scene.add(keyLight);

    // 3. Cool rim light for depth contrast
    const rimLight = new THREE.DirectionalLight(0x00f0ff, 0.8);
    rimLight.position.set(-this.bedDimensions.x, this.bedDimensions.y * 1.5, 200);
    this.scene.add(rimLight);
  }

  initBuildPlate() {
    const { x, y } = this.bedDimensions;

    if (this.bedGroup) {
      this.scene.remove(this.bedGroup);
    }

    this.bedGroup = new THREE.Group();

    // Bed base plate (Textured dark PEI spring steel)
    const bedGeom = new THREE.BoxGeometry(x, y, 4);
    this.bedMaterial = new THREE.MeshStandardMaterial({
      color: 0x161a22,
      metalness: 0.7,
      roughness: 0.65,
      emissive: 0xff3b00,
      emissiveIntensity: 0.0, // Glows when heated
    });
    const bedMesh = new THREE.Mesh(bedGeom, this.bedMaterial);
    bedMesh.position.set(x / 2, y / 2, -2);
    bedMesh.receiveShadow = true;
    this.bedGroup.add(bedMesh);

    // Accent edge bevel
    const edgeGeom = new THREE.BoxGeometry(x + 4, y + 4, 3.8);
    const edgeMat = new THREE.MeshStandardMaterial({
      color: 0x21262d,
      metalness: 0.9,
      roughness: 0.3,
    });
    const edgeMesh = new THREE.Mesh(edgeGeom, edgeMat);
    edgeMesh.position.set(x / 2, y / 2, -2.1);
    this.bedGroup.add(edgeMesh);

    // Precision Grid lines (every 10mm and 50mm)
    const gridHelper = new THREE.GridHelper(Math.max(x, y), 24, 0x00f0ff, 0x263040);
    gridHelper.rotation.x = Math.PI / 2;
    gridHelper.position.set(x / 2, y / 2, 0.05);
    this.bedGroup.add(gridHelper);

    // Coordinate Origin Marker (X=Red, Y=Green, Z=Blue)
    const axesHelper = new THREE.AxesHelper(35);
    axesHelper.position.set(0, 0, 0.2);
    this.bedGroup.add(axesHelper);

    // Printable boundary wireframe
    const boundGeom = new THREE.BoxGeometry(x, y, this.bedDimensions.z);
    const boundEdges = new THREE.EdgesGeometry(boundGeom);
    const boundLine = new THREE.LineSegments(
      boundEdges,
      new THREE.LineBasicMaterial({ color: 0x30363d, transparent: true, opacity: 0.3 })
    );
    boundLine.position.set(x / 2, y / 2, this.bedDimensions.z / 2);
    this.bedGroup.add(boundLine);

    this.scene.add(this.bedGroup);
  }

  setBedDimensions(dims) {
    this.bedDimensions = dims;
    this.initBuildPlate();
    this.controls.target.set(dims.x / 2, dims.y / 2, 20);
    this.controls.update();
  }

  updateBedTemperature(temp, targetTemp) {
    if (!this.bedMaterial) return;
    const ratio = Math.min(1.0, Math.max(0, (temp - 30) / 80));
    this.bedMaterial.emissiveIntensity = ratio * 0.45;
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
