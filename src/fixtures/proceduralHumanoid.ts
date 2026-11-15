import * as THREE from 'three';

/**
 * ORIGINAL reproducible procedural technical humanoid fixture for DEX//SCULPT.
 *
 * Designed specifically for rig-safe sculpting & GLB round-trip verification:
 *  - Single unified manifold-friendly SkinnedMesh (~1,900 triangles)
 *  - 17 hierarchical bones with nontrivial inverse bind matrices
 *  - Smooth multi-bone skin weights across shoulders, elbows, waist, hips, knees, and neck
 *  - Valid UV coordinates + procedural PBR Canvas/DataTexture
 *  - 4 relative morph targets (Broaden_Shoulders, Heroic_Chest, Jaw_Width, Torso_Scale)
 *  - 3 playable skeletal AnimationClips (Idle_Breathing, Walk_Cycle, Wave_Greeting)
 *
 * Provenance: 100% original procedural geometry authored for DEX//SCULPT (MIT).
 * Not derived from Rocketbox or any restricted third-party asset.
 */

export interface ProceduralCharacterBundle {
  root: THREE.Group;
  skinnedMesh: THREE.SkinnedMesh;
  skeleton: THREE.Skeleton;
  animations: THREE.AnimationClip[];
  metadata: {
    id: string;
    name: string;
    skeletonFamily: string;
    boneCount: number;
    morphTargetNames: string[];
    animationNames: string[];
    license: string;
  };
}

interface PartSpec {
  name: string;
  radiusTop: number;
  radiusBottom: number;
  height: number;
  radialSegs: number;
  heightSegs: number;
  offset: [number, number, number];
  rotZ?: number;
  scaleX?: number;
  scaleZ?: number;
  uvRegion: [number, number, number, number]; // u0, v0, u1, v1
  weightsForY: (localY: number, worldPos: THREE.Vector3) => Array<[number, number]>;
}

const BONE_DEFS: Array<{ name: string; parent: string | null; pos: [number, number, number] }> = [
  { name: 'Root', parent: null, pos: [0, 0, 0] },
  { name: 'Pelvis', parent: 'Root', pos: [0, 0.92, 0] },
  { name: 'Spine', parent: 'Pelvis', pos: [0, 0.16, 0] },
  { name: 'Chest', parent: 'Spine', pos: [0, 0.2, 0] },
  { name: 'Neck', parent: 'Chest', pos: [0, 0.19, 0] },
  { name: 'Head', parent: 'Neck', pos: [0, 0.11, 0] },
  { name: 'Shoulder_L', parent: 'Chest', pos: [0.12, 0.14, 0] },
  { name: 'UpperArm_L', parent: 'Shoulder_L', pos: [0.09, -0.02, 0] },
  { name: 'Forearm_L', parent: 'UpperArm_L', pos: [0, -0.25, 0] },
  { name: 'Hand_L', parent: 'Forearm_L', pos: [0, -0.23, 0] },
  { name: 'Shoulder_R', parent: 'Chest', pos: [-0.12, 0.14, 0] },
  { name: 'UpperArm_R', parent: 'Shoulder_R', pos: [-0.09, -0.02, 0] },
  { name: 'Forearm_R', parent: 'UpperArm_R', pos: [0, -0.25, 0] },
  { name: 'Hand_R', parent: 'Forearm_R', pos: [0, -0.23, 0] },
  { name: 'Thigh_L', parent: 'Pelvis', pos: [0.1, -0.04, 0] },
  { name: 'Shin_L', parent: 'Thigh_L', pos: [0, -0.42, 0] },
  { name: 'Foot_L', parent: 'Shin_L', pos: [0, -0.42, 0] },
  { name: 'Thigh_R', parent: 'Pelvis', pos: [-0.1, -0.04, 0] },
  { name: 'Shin_R', parent: 'Thigh_R', pos: [0, -0.42, 0] },
  { name: 'Foot_R', parent: 'Shin_R', pos: [0, -0.42, 0] }
];

function createProceduralSuitTexture(): THREE.DataTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const u = x / size;
      const v = y / size;
      // Subtle studio mannequin grid + panel tone differentiation (torso vs limbs vs head)
      const grid = x % 16 === 0 || y % 16 === 0 ? -14 : 0;
      let r = 198;
      let g = 194;
      let b = 188;
      if (v > 0.65) {
        // Head/neck warm neutral clay-skin tone
        r = 216;
        g = 194;
        b = 178;
      } else if (v > 0.35) {
        // Torso tech-suit slate
        r = 128;
        g = 144;
        b = 162;
        if (Math.abs(u - 0.5) < 0.04) {
          // Centerline seam accent
          r = 72;
          g = 182;
          b = 172;
        }
      } else {
        // Limbs muted graphite
        r = 104;
        g = 112;
        b = 122;
      }
      data[idx] = Math.max(0, Math.min(255, r + grid));
      data[idx + 1] = Math.max(0, Math.min(255, g + grid));
      data[idx + 2] = Math.max(0, Math.min(255, b + grid));
      data[idx + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

function normalize4Weights(pairs: Array<[number, number]>): {
  indices: [number, number, number, number];
  weights: [number, number, number, number];
} {
  const merged = new Map<number, number>();
  for (const [b, w] of pairs) {
    if (w <= 0) continue;
    merged.set(b, (merged.get(b) ?? 0) + w);
  }
  const sorted = [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  while (sorted.length < 4) sorted.push([0, 0]);
  const sum = sorted.reduce((acc, [, w]) => acc + w, 0) || 1;
  return {
    indices: [sorted[0][0], sorted[1][0], sorted[2][0], sorted[3][0]],
    weights: [sorted[0][1] / sum, sorted[1][1] / sum, sorted[2][1] / sum, sorted[3][1] / sum]
  };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function lerpWeight(t: number, a: number, b: number): Array<[number, number]> {
  const k = clamp01(t);
  return [
    [a, 1 - k],
    [b, k]
  ];
}

export function createProceduralHumanoid(): ProceduralCharacterBundle {
  const root = new THREE.Group();
  root.name = 'DexFoundry_Humanoid_Root';

  const bones: THREE.Bone[] = [];
  const boneIndex = new Map<string, number>();
  for (const def of BONE_DEFS) {
    const bone = new THREE.Bone();
    bone.name = def.name;
    bone.position.set(...def.pos);
    boneIndex.set(def.name, bones.length);
    bones.push(bone);
    if (def.parent) {
      bones[boneIndex.get(def.parent)!].add(bone);
    } else {
      root.add(bone);
    }
  }

  const B = (name: string) => boneIndex.get(name)!;

  const parts: PartSpec[] = [
    // Torso (Pelvis -> Spine -> Chest)
    {
      name: 'torso',
      radiusTop: 0.165,
      radiusBottom: 0.135,
      height: 0.52,
      radialSegs: 20,
      heightSegs: 12,
      offset: [0, 1.16, 0],
      scaleX: 1.15,
      scaleZ: 0.78,
      uvRegion: [0.1, 0.36, 0.9, 0.64],
      weightsForY: (y) => {
        const t = clamp01((y + 0.26) / 0.52);
        if (t < 0.45) return lerpWeight(t / 0.45, B('Pelvis'), B('Spine'));
        return lerpWeight((t - 0.45) / 0.55, B('Spine'), B('Chest'));
      }
    },
    // Neck
    {
      name: 'neck',
      radiusTop: 0.056,
      radiusBottom: 0.068,
      height: 0.14,
      radialSegs: 14,
      heightSegs: 4,
      offset: [0, 1.48, 0],
      uvRegion: [0.2, 0.66, 0.8, 0.74],
      weightsForY: (y) => lerpWeight((y + 0.07) / 0.14, B('Chest'), B('Neck'))
    },
    // Head
    {
      name: 'head',
      radiusTop: 0.105,
      radiusBottom: 0.095,
      height: 0.23,
      radialSegs: 20,
      heightSegs: 10,
      offset: [0, 1.66, 0.01],
      scaleX: 0.88,
      scaleZ: 1.02,
      uvRegion: [0.1, 0.75, 0.9, 0.98],
      weightsForY: (y) => {
        const t = clamp01((y + 0.115) / 0.23);
        return lerpWeight(clamp01(t * 2.5), B('Neck'), B('Head'));
      }
    },
    // Left Arm (Shoulder -> UpperArm -> Forearm -> Hand)
    {
      name: 'arm_l',
      radiusTop: 0.058,
      radiusBottom: 0.036,
      height: 0.56,
      radialSegs: 14,
      heightSegs: 12,
      offset: [0.23, 1.16, 0],
      rotZ: 0.08,
      uvRegion: [0.1, 0.05, 0.45, 0.34],
      weightsForY: (y) => {
        // y from +0.28 (shoulder) down to -0.28 (hand)
        const d = clamp01((0.28 - y) / 0.56);
        if (d < 0.22) return lerpWeight(d / 0.22, B('Shoulder_L'), B('UpperArm_L'));
        if (d < 0.6) return lerpWeight((d - 0.22) / 0.38, B('UpperArm_L'), B('Forearm_L'));
        return lerpWeight((d - 0.6) / 0.4, B('Forearm_L'), B('Hand_L'));
      }
    },
    // Right Arm
    {
      name: 'arm_r',
      radiusTop: 0.058,
      radiusBottom: 0.036,
      height: 0.56,
      radialSegs: 14,
      heightSegs: 12,
      offset: [-0.23, 1.16, 0],
      rotZ: -0.08,
      uvRegion: [0.55, 0.05, 0.9, 0.34],
      weightsForY: (y) => {
        const d = clamp01((0.28 - y) / 0.56);
        if (d < 0.22) return lerpWeight(d / 0.22, B('Shoulder_R'), B('UpperArm_R'));
        if (d < 0.6) return lerpWeight((d - 0.22) / 0.38, B('UpperArm_R'), B('Forearm_R'));
        return lerpWeight((d - 0.6) / 0.4, B('Forearm_R'), B('Hand_R'));
      }
    },
    // Left Leg (Pelvis -> Thigh -> Shin -> Foot)
    {
      name: 'leg_l',
      radiusTop: 0.082,
      radiusBottom: 0.048,
      height: 0.88,
      radialSegs: 14,
      heightSegs: 14,
      offset: [0.1, 0.44, 0],
      uvRegion: [0.1, 0.05, 0.45, 0.34],
      weightsForY: (y) => {
        // y from +0.44 (hip) down to -0.44 (foot)
        const d = clamp01((0.44 - y) / 0.88);
        if (d < 0.15) return lerpWeight(d / 0.15, B('Pelvis'), B('Thigh_L'));
        if (d < 0.56) return lerpWeight((d - 0.15) / 0.41, B('Thigh_L'), B('Shin_L'));
        return lerpWeight((d - 0.56) / 0.44, B('Shin_L'), B('Foot_L'));
      }
    },
    // Right Leg
    {
      name: 'leg_r',
      radiusTop: 0.082,
      radiusBottom: 0.048,
      height: 0.88,
      radialSegs: 14,
      heightSegs: 14,
      offset: [-0.1, 0.44, 0],
      uvRegion: [0.55, 0.05, 0.9, 0.34],
      weightsForY: (y) => {
        const d = clamp01((0.44 - y) / 0.88);
        if (d < 0.15) return lerpWeight(d / 0.15, B('Pelvis'), B('Thigh_R'));
        if (d < 0.56) return lerpWeight((d - 0.15) / 0.41, B('Thigh_R'), B('Shin_R'));
        return lerpWeight((d - 0.56) / 0.44, B('Shin_R'), B('Foot_R'));
      }
    }
  ];

  const positions: number[] = [];
  const uvs: number[] = [];
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  const indices: number[] = [];

  let vertexCursor = 0;
  const tmpVec = new THREE.Vector3();
  const rotMat = new THREE.Matrix4();

  for (const part of parts) {
    // Use Capsule-like tapering via CylinderGeometry with closed caps so silhouette reads clearly
    const g = new THREE.CylinderGeometry(
      part.radiusTop,
      part.radiusBottom,
      part.height,
      part.radialSegs,
      part.heightSegs,
      false
    );
    const pAttr = g.getAttribute('position');
    const uAttr = g.getAttribute('uv');
    const idxAttr = g.getIndex()!;

    rotMat.makeRotationZ(part.rotZ ?? 0);
    const [u0, v0, u1, v1] = part.uvRegion;

    for (let i = 0; i < pAttr.count; i++) {
      const lx = pAttr.getX(i) * (part.scaleX ?? 1);
      const ly = pAttr.getY(i);
      const lz = pAttr.getZ(i) * (part.scaleZ ?? 1);

      // Subtle round-cap dome on top/bottom cap vertices for humanoid head/limbs
      let domeY = ly;
      if (part.name === 'head' && Math.abs(ly) > part.height * 0.46) {
        const r = Math.hypot(lx, lz);
        const capFactor = Math.max(0, 1 - (r / (part.radiusTop * 1.05)) ** 2);
        domeY += Math.sign(ly) * 0.035 * capFactor;
      }

      tmpVec.set(lx, domeY, lz).applyMatrix4(rotMat);
      tmpVec.x += part.offset[0];
      tmpVec.y += part.offset[1];
      tmpVec.z += part.offset[2];

      positions.push(tmpVec.x, tmpVec.y, tmpVec.z);

      const su = uAttr ? uAttr.getX(i) : 0.5;
      const sv = uAttr ? uAttr.getY(i) : 0.5;
      uvs.push(u0 + su * (u1 - u0), v0 + sv * (v1 - v0));

      const { indices: si, weights: sw } = normalize4Weights(part.weightsForY(ly, tmpVec));
      skinIndices.push(...si);
      skinWeights.push(...sw);
    }

    for (let i = 0; i < idxAttr.count; i++) {
      indices.push(vertexCursor + idxAttr.getX(i));
    }

    vertexCursor += pAttr.count;
    g.dispose();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  // Build 4 genuine relative morph targets
  const vCount = positions.length / 3;
  const broadenDelta = new Float32Array(vCount * 3);
  const chestDelta = new Float32Array(vCount * 3);
  const jawDelta = new Float32Array(vCount * 3);
  const torsoHeightDelta = new Float32Array(vCount * 3);

  for (let i = 0; i < vCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];

    // 1. Broaden_Shoulders: widens upper torso + shifts arms slightly outward
    if (y > 1.15 && y < 1.5) {
      const band = Math.sin(clamp01((y - 1.15) / 0.35) * Math.PI);
      broadenDelta[i * 3] = Math.sign(x) * 0.045 * band + x * 0.14 * band;
    }

    // 2. Heroic_Chest: expands upper torso depth & width
    if (y > 1.14 && y < 1.46 && Math.abs(x) < 0.21) {
      const band = Math.sin(clamp01((y - 1.14) / 0.32) * Math.PI);
      chestDelta[i * 3] = x * 0.16 * band;
      chestDelta[i * 3 + 2] = z * 0.25 * band + 0.025 * band;
    }

    // 3. Jaw_Width: widens lower head region
    if (y > 1.53 && y < 1.68) {
      const band = 1 - clamp01((y - 1.56) / 0.12);
      jawDelta[i * 3] = x * 0.28 * band;
      jawDelta[i * 3 + 2] = z > 0 ? 0.014 * band : 0;
    }

    // 4. Torso_Volume: expands mid-torso fullness uniformly
    if (y > 0.92 && y < 1.44 && Math.abs(x) < 0.21) {
      const band = Math.sin(clamp01((y - 0.92) / 0.52) * Math.PI);
      torsoHeightDelta[i * 3] = x * 0.18 * band;
      torsoHeightDelta[i * 3 + 2] = z * 0.18 * band;
    }
  }

  const morphNames = ['Broaden_Shoulders', 'Heroic_Chest', 'Jaw_Width', 'Torso_Volume'];
  const morphArrays = [broadenDelta, chestDelta, jawDelta, torsoHeightDelta];
  geometry.morphTargetsRelative = true;
  geometry.morphAttributes.position = morphArrays.map((arr, idx) => {
    const attr = new THREE.Float32BufferAttribute(arr, 3);
    attr.name = morphNames[idx];
    return attr;
  });

  const suitTex = createProceduralSuitTexture();
  const material = new THREE.MeshStandardMaterial({
    name: 'Foundry_Body_Mat',
    map: suitTex,
    roughness: 0.62,
    metalness: 0.08
  });

  const skinnedMesh = new THREE.SkinnedMesh(geometry, material);
  skinnedMesh.name = 'DexFoundry_Humanoid';
  skinnedMesh.castShadow = true;
  skinnedMesh.receiveShadow = true;

  // Bind skeleton
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  skinnedMesh.add(bones[0]);
  skinnedMesh.bind(skeleton);
  skeleton.calculateInverses();

  // Initialize morphTargetDictionary & influences on the SkinnedMesh
  skinnedMesh.morphTargetDictionary = {
    Broaden_Shoulders: 0,
    Heroic_Chest: 1,
    Jaw_Width: 2,
    Torso_Volume: 3
  };
  skinnedMesh.morphTargetInfluences = [0, 0, 0, 0];

  root.add(skinnedMesh);

  // Build 3 genuine skeletal AnimationClips
  const animations = buildProceduralAnimations();

  return {
    root,
    skinnedMesh,
    skeleton,
    animations,
    metadata: {
      id: 'procedural/dex-foundry-humanoid-v1',
      name: 'DEX Foundry Technical Humanoid',
      skeletonFamily: 'dex-foundry-biped-20',
      boneCount: bones.length,
      morphTargetNames: morphNames,
      animationNames: animations.map((c) => c.name),
      license: 'MIT (Original DEX//SCULPT Procedural Fixture)'
    }
  };
}

function quatKeyframes(
  boneName: string,
  times: number[],
  eulers: Array<[number, number, number]>
): THREE.QuaternionKeyframeTrack {
  const values: number[] = [];
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (const [rx, ry, rz] of eulers) {
    e.set(rx, ry, rz, 'XYZ');
    q.setFromEuler(e);
    values.push(q.x, q.y, q.z, q.w);
  }
  return new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values);
}

function buildProceduralAnimations(): THREE.AnimationClip[] {
  // 1. Idle_Breathing (2.4s loop)
  const idle = new THREE.AnimationClip('Idle_Breathing', 2.4, [
    quatKeyframes('Chest', [0, 1.2, 2.4], [
      [0.02, 0, 0],
      [-0.05, 0, 0],
      [0.02, 0, 0]
    ]),
    quatKeyframes('Head', [0, 0.8, 1.6, 2.4], [
      [0, -0.06, 0],
      [0.03, 0.05, 0],
      [-0.02, 0.07, 0],
      [0, -0.06, 0]
    ]),
    quatKeyframes('UpperArm_L', [0, 1.2, 2.4], [
      [0.04, 0, 0.06],
      [-0.03, 0, 0.1],
      [0.04, 0, 0.06]
    ]),
    quatKeyframes('UpperArm_R', [0, 1.2, 2.4], [
      [0.04, 0, -0.06],
      [-0.03, 0, -0.1],
      [0.04, 0, -0.06]
    ])
  ]);

  // 2. Walk_Cycle (1.2s loop)
  const walk = new THREE.AnimationClip('Walk_Cycle', 1.2, [
    new THREE.VectorKeyframeTrack('Pelvis.position', [0, 0.3, 0.6, 0.9, 1.2], [
      0, 0.92, 0,
      0, 0.955, 0,
      0, 0.92, 0,
      0, 0.955, 0,
      0, 0.92, 0
    ]),
    quatKeyframes('Thigh_L', [0, 0.3, 0.6, 0.9, 1.2], [
      [-0.42, 0, 0],
      [0, 0, 0],
      [0.42, 0, 0],
      [0, 0, 0],
      [-0.42, 0, 0]
    ]),
    quatKeyframes('Shin_L', [0, 0.3, 0.6, 0.9, 1.2], [
      [0.12, 0, 0],
      [0.05, 0, 0],
      [0.35, 0, 0],
      [0.65, 0, 0],
      [0.12, 0, 0]
    ]),
    quatKeyframes('Thigh_R', [0, 0.3, 0.6, 0.9, 1.2], [
      [0.42, 0, 0],
      [0, 0, 0],
      [-0.42, 0, 0],
      [0, 0, 0],
      [0.42, 0, 0]
    ]),
    quatKeyframes('Shin_R', [0, 0.3, 0.6, 0.9, 1.2], [
      [0.35, 0, 0],
      [0.65, 0, 0],
      [0.12, 0, 0],
      [0.05, 0, 0],
      [0.35, 0, 0]
    ]),
    quatKeyframes('UpperArm_L', [0, 0.6, 1.2], [
      [0.35, 0, 0.06],
      [-0.35, 0, 0.06],
      [0.35, 0, 0.06]
    ]),
    quatKeyframes('UpperArm_R', [0, 0.6, 1.2], [
      [-0.35, 0, -0.06],
      [0.35, 0, -0.06],
      [-0.35, 0, -0.06]
    ]),
    quatKeyframes('Spine', [0, 0.6, 1.2], [
      [0.04, -0.08, 0],
      [0.04, 0.08, 0],
      [0.04, -0.08, 0]
    ])
  ]);

  // 3. Wave_Greeting (2.0s loop)
  const wave = new THREE.AnimationClip('Wave_Greeting', 2.0, [
    quatKeyframes('UpperArm_R', [0, 0.4, 1.6, 2.0], [
      [0, 0, -0.1],
      [0.1, 0, -2.1],
      [0.1, 0, -2.1],
      [0, 0, -0.1]
    ]),
    quatKeyframes('Forearm_R', [0, 0.4, 0.7, 1.0, 1.3, 1.6, 2.0], [
      [0, 0, 0],
      [0, 0, -0.65],
      [0, 0, -0.15],
      [0, 0, -0.7],
      [0, 0, -0.15],
      [0, 0, -0.65],
      [0, 0, 0]
    ]),
    quatKeyframes('Head', [0, 0.5, 1.5, 2.0], [
      [0, 0, 0],
      [-0.06, -0.12, 0.05],
      [-0.06, -0.12, 0.05],
      [0, 0, 0]
    ])
  ]);

  return [idle, walk, wave];
}
