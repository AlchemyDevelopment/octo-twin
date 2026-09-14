import * as THREE from 'three';

/**
 * 3D Toolhead assembly with realistic nozzle, heater block, heatsink,
 * LED illumination downlight, and position lerping.
 */
export class Toolhead {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.targetPosition = new THREE.Vector3(0, 0, 10);
    this.currentPosition = new THREE.Vector3(0, 0, 10);
    this.lerpFactor = 0.25; // Smooth 60fps tracking

    this.initModel();
    this.scene.add(this.group);
  }

  initModel() {
    // 1. Brass Nozzle Tip (Pointed cone)
    const nozzleGeom = new THREE.ConeGeometry(0.8, 1.6, 16);
    nozzleGeom.rotateX(Math.PI); // Point down
    this.nozzleMaterial = new THREE.MeshStandardMaterial({
      color: 0xe5a93c, // Brass
      metalness: 0.85,
      roughness: 0.25,
      emissive: 0xff3b00,
      emissiveIntensity: 0.15,
    });
    const nozzleMesh = new THREE.Mesh(nozzleGeom, this.nozzleMaterial);
    nozzleMesh.position.set(0, 0, 0.8);
    this.group.add(nozzleMesh);

    // 2. Aluminum Heater Block
    const blockGeom = new THREE.BoxGeometry(3.5, 3.0, 2.2);
    this.blockMaterial = new THREE.MeshStandardMaterial({
      color: 0xcccccc,
      metalness: 0.9,
      roughness: 0.3,
    });
    const blockMesh = new THREE.Mesh(blockGeom, this.blockMaterial);
    blockMesh.position.set(0, 0, 2.7);
    this.group.add(blockMesh);

    // 3. Heat Break & Heatsink (Anodized Dark Aluminum with fins)
    const heatsinkGroup = new THREE.Group();
    const sinkMaterial = new THREE.MeshStandardMaterial({
      color: 0x1f242d,
      metalness: 0.8,
      roughness: 0.4,
    });

    // Vertical core
    const coreGeom = new THREE.CylinderGeometry(0.8, 0.8, 8, 16);
    const coreMesh = new THREE.Mesh(coreGeom, sinkMaterial);
    coreMesh.rotateX(Math.PI / 2);
    coreMesh.position.set(0, 0, 7.8);
    heatsinkGroup.add(coreMesh);

    // Radiator Fins
    for (let i = 0; i < 6; i++) {
      const finGeom = new THREE.CylinderGeometry(2.4, 2.4, 0.3, 16);
      const finMesh = new THREE.Mesh(finGeom, sinkMaterial);
      finMesh.rotateX(Math.PI / 2);
      finMesh.position.set(0, 0, 4.8 + i * 1.0);
      heatsinkGroup.add(finMesh);
    }
    this.group.add(heatsinkGroup);

    // 4. Downlight LED (illuminates current extrusion spot)
    this.workLight = new THREE.SpotLight(0xffffff, 4, 35, Math.PI / 4, 0.3, 1);
    this.workLight.position.set(0, 0, 6);
    this.workLight.target = nozzleMesh;
    this.group.add(this.workLight);

    // 5. Ambient Nozzle Point Light (glow effect onto bed/model)
    this.glowLight = new THREE.PointLight(0xff6600, 0.8, 12);
    this.glowLight.position.set(0, 0, 1.2);
    this.group.add(this.glowLight);

    this.group.visible = true;
  }

  setTargetPosition(x, y, z) {
    this.targetPosition.set(x, y, z);
  }

  setPositionImmediate(x, y, z) {
    this.targetPosition.set(x, y, z);
    this.currentPosition.set(x, y, z);
    this.group.position.set(x, y, z);
  }

  updateTemperature(temp, targetTemp) {
    // Thermal emissive glow when hot (> 50C)
    const ratio = Math.min(1.0, Math.max(0, temp / 250));
    if (this.nozzleMaterial) {
      this.nozzleMaterial.emissiveIntensity = 0.1 + ratio * 0.7;
      if (temp > 170) {
        this.nozzleMaterial.emissive.setHex(0xff3300);
        this.glowLight.color.setHex(0xff5500);
        this.glowLight.intensity = 0.5 + ratio * 0.8;
      } else {
        this.nozzleMaterial.emissive.setHex(0x331100);
        this.glowLight.intensity = 0.1;
      }
    }
  }

  setVisible(visible) {
    this.group.visible = visible;
  }

  update(deltaTime) {
    // Smooth interpolation towards target coordinates
    this.currentPosition.lerp(this.targetPosition, this.lerpFactor);
    this.group.position.copy(this.currentPosition);
  }
}
