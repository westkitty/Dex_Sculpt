import * as THREE from 'three';

export interface ProceduralAccessorySpec {
  id: string;
  name: string;
  mode: 'bone-attached' | 'skinned-compatible';
  targetBone: string;
  description: string;
  compatibleFamilies: string[];
}

export const PROCEDURAL_ACCESSORIES: ProceduralAccessorySpec[] = [
  {
    id: 'procedural/visor-crest',
    name: 'Foundry Visor Crest',
    mode: 'bone-attached',
    targetBone: 'Head',
    description: 'Rigid cyber-sculptor visor attached cleanly to the Head bone socket.',
    compatibleFamilies: ['*']
  },
  {
    id: 'procedural/pauldron-left',
    name: 'Shoulder Pauldron (L)',
    mode: 'bone-attached',
    targetBone: 'UpperArm_L',
    description: 'Layered shoulder armor prop attached to UpperArm_L.',
    compatibleFamilies: ['*']
  },
  {
    id: 'procedural/skinned-cape',
    name: 'Foundry Cloak (Skinned)',
    mode: 'skinned-compatible',
    targetBone: 'Chest',
    description: 'Skinned cloth cloak weighted to Chest, Spine, and Pelvis bones.',
    compatibleFamilies: ['dex-foundry-biped-20']
  }
];

export function buildProceduralAccessory(id: string): THREE.Object3D {
  if (id === 'procedural/visor-crest') {
    const group = new THREE.Group();
    group.name = 'Foundry_Visor_Crest';
    const band = new THREE.Mesh(
      new THREE.TorusGeometry(0.105, 0.016, 10, 24, Math.PI * 1.2),
      new THREE.MeshStandardMaterial({
        name: 'Visor_Band_Mat',
        color: 0x263238,
        roughness: 0.35,
        metalness: 0.72
      })
    );
    band.rotation.x = Math.PI / 2;
    band.rotation.z = -Math.PI * 0.1;
    band.position.set(0, 0.09, 0.015);
    const lens = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.036, 0.04),
      new THREE.MeshStandardMaterial({
        name: 'Visor_Lens_Mat',
        color: 0x38d9c0,
        emissive: 0x104a44,
        roughness: 0.18,
        metalness: 0.35
      })
    );
    lens.position.set(0, 0.09, 0.098);
    group.add(band, lens);
    return group;
  }

  if (id === 'procedural/pauldron-left') {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.088, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
      new THREE.MeshStandardMaterial({
        name: 'Pauldron_Mat',
        color: 0x455a64,
        roughness: 0.4,
        metalness: 0.65
      })
    );
    mesh.name = 'Shoulder_Pauldron_L';
    mesh.position.set(0.025, 0.03, 0);
    mesh.rotation.z = -0.35;
    return mesh;
  }

  // Skinned cloak weighted to Chest, Spine, Pelvis
  const geo = new THREE.PlaneGeometry(0.36, 0.62, 6, 8);
  const pos = geo.getAttribute('position');
  const skinIdx = new Uint16Array(pos.count * 4);
  const skinWgt = new Float32Array(pos.count * 4);

  // Local bone indices mapped during modular skinned attachment by bone name
  // Placeholder names encoded in userData.requiredBones
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    // Curve slightly backward away from torso
    const t = (0.31 - y) / 0.62; // 0 at shoulders, 1 at hem
    pos.setZ(i, -0.14 - t * 0.08 - (x * x) * 0.35);
    pos.setY(i, 1.38 - t * 0.62);

    skinIdx[i * 4] = 0; // Chest
    skinIdx[i * 4 + 1] = 1; // Spine
    skinIdx[i * 4 + 2] = 2; // Pelvis
    skinIdx[i * 4 + 3] = 0;

    if (t < 0.45) {
      const k = t / 0.45;
      skinWgt[i * 4] = 1 - k;
      skinWgt[i * 4 + 1] = k;
    } else {
      const k = (t - 0.45) / 0.55;
      skinWgt[i * 4 + 1] = 1 - k;
      skinWgt[i * 4 + 2] = k;
    }
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIdx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWgt, 4));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    name: 'Foundry_Cloak_Mat',
    color: 0x2b3e4c,
    roughness: 0.78,
    metalness: 0.08,
    side: THREE.DoubleSide
  });

  const cloak = new THREE.Mesh(geo, mat);
  cloak.name = 'Foundry_Cloak';
  cloak.userData.skinnedBindingBoneNames = ['Chest', 'Spine', 'Pelvis'];
  return cloak;
}
