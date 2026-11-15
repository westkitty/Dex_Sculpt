/**
 * DEX//SCULPT — original procedural rigged humanoid fixture.
 *
 * This is the reproducible technical fixture required by the Phase A proof:
 * a skinned mesh (20 bones, genuine 4-influence weights, inverse bind matrices,
 * UVs, materials), three morph targets and three playable skeletal clips.
 * Everything here is generated from code — no third-party model bytes, no
 * licence obligations, no binary in the repository.
 *
 * Proportions are originally authored for DEX//SCULPT and do not represent or
 * reproduce any Rocketbox, KayKit, Quaternius or other library character.
 */
import * as THREE from 'three';
import {
  buildAdjacency,
  laplacianSmooth,
  sdEllipsoid,
  sdEllipsoidAt,
  sdRoundCone,
  sdRoundCone6,
  sdSphereAt,
  sdfGradient,
  smin,
  surfaceNets,
  type SdfFn,
  type Vec3,
} from './sdf';

export interface BoneDef {
  name: string;
  parent: string | null;
  head: Vec3;
  tail: Vec3;
  /** influence radius used by the procedural skinning field */
  radius: number;
  side?: 'L' | 'R';
}

const ARM_Y = 1.42;

function mirror(v: Vec3): Vec3 {
  return [-v[0], v[1], v[2]];
}

export const FIXTURE_BONES: BoneDef[] = [
  { name: 'Root', parent: null, head: [0, 0, 0], tail: [0, 0.1, 0], radius: 0 },
  { name: 'Hips', parent: 'Root', head: [0, 0.95, 0], tail: [0, 1.08, 0], radius: 0.3 },
  { name: 'Spine', parent: 'Hips', head: [0, 1.08, 0], tail: [0, 1.24, 0], radius: 0.3 },
  { name: 'Chest', parent: 'Spine', head: [0, 1.24, 0], tail: [0, 1.44, 0], radius: 0.3 },
  { name: 'Neck', parent: 'Chest', head: [0, 1.44, 0], tail: [0, 1.55, 0], radius: 0.12 },
  { name: 'Head', parent: 'Neck', head: [0, 1.55, 0], tail: [0, 1.78, 0], radius: 0.17 },
  { name: 'Shoulder_L', parent: 'Chest', head: [0.03, ARM_Y - 0.02, 0], tail: [0.16, ARM_Y, 0], radius: 0.11, side: 'L' },
  { name: 'UpperArm_L', parent: 'Shoulder_L', head: [0.16, ARM_Y, 0], tail: [0.44, ARM_Y, 0], radius: 0.13, side: 'L' },
  { name: 'LowerArm_L', parent: 'UpperArm_L', head: [0.44, ARM_Y, 0], tail: [0.68, ARM_Y, 0], radius: 0.12, side: 'L' },
  { name: 'Hand_L', parent: 'LowerArm_L', head: [0.68, ARM_Y, 0], tail: [0.8, ARM_Y, 0], radius: 0.1, side: 'L' },
  { name: 'Shoulder_R', parent: 'Chest', head: mirror([0.03, ARM_Y - 0.02, 0]), tail: mirror([0.16, ARM_Y, 0]), radius: 0.11, side: 'R' },
  { name: 'UpperArm_R', parent: 'Shoulder_R', head: mirror([0.16, ARM_Y, 0]), tail: mirror([0.44, ARM_Y, 0]), radius: 0.13, side: 'R' },
  { name: 'LowerArm_R', parent: 'UpperArm_R', head: mirror([0.44, ARM_Y, 0]), tail: mirror([0.68, ARM_Y, 0]), radius: 0.12, side: 'R' },
  { name: 'Hand_R', parent: 'LowerArm_R', head: mirror([0.68, ARM_Y, 0]), tail: mirror([0.8, ARM_Y, 0]), radius: 0.1, side: 'R' },
  { name: 'UpperLeg_L', parent: 'Hips', head: [0.095, 0.94, 0], tail: [0.1, 0.52, 0], radius: 0.17, side: 'L' },
  { name: 'LowerLeg_L', parent: 'UpperLeg_L', head: [0.1, 0.52, 0], tail: [0.105, 0.1, 0], radius: 0.15, side: 'L' },
  { name: 'Foot_L', parent: 'LowerLeg_L', head: [0.105, 0.1, 0], tail: [0.105, 0.035, 0.14], radius: 0.13, side: 'L' },
  { name: 'UpperLeg_R', parent: 'Hips', head: mirror([0.095, 0.94, 0]), tail: mirror([0.1, 0.52, 0]), radius: 0.17, side: 'R' },
  { name: 'LowerLeg_R', parent: 'UpperLeg_R', head: mirror([0.1, 0.52, 0]), tail: mirror([0.105, 0.1, 0]), radius: 0.15, side: 'R' },
  { name: 'Foot_R', parent: 'LowerLeg_R', head: mirror([0.105, 0.1, 0]), tail: mirror([0.105, 0.035, 0.14]), radius: 0.13, side: 'R' },
];

export const FIXTURE_SKELETON_FAMILY = 'dexsculpt-fixture-biped-20';
export const FIXTURE_MORPH_NAMES = ['Build_Tall', 'Build_Broad', 'Head_Size'] as const;

/**
 * Smooth-union SDF of the fixture body in T-pose (metres, +Y up, +Z forward).
 * Written with scalar primitives: this closure is evaluated hundreds of
 * thousands of times during polygonization, so it must not allocate.
 */
export function buildBodySdf(): SdfFn {
  return (x, y, z) => {
    // torso: pelvis -> belly -> chest
    let d = sdEllipsoidAt(x, y, z, 0, 0.95, 0, 0.147, 0.105, 0.098);
    d = smin(d, sdEllipsoidAt(x, y, z, 0, 1.12, 0.004, 0.142, 0.13, 0.1), 0.05);
    d = smin(d, sdEllipsoidAt(x, y, z, 0, 1.315, 0, 0.168, 0.15, 0.104), 0.05);
    // neck + head
    d = smin(d, sdRoundCone6(x, y, z, 0, 1.4, 0, 0, 1.56, 0, 0.062, 0.052), 0.03);
    d = smin(d, sdEllipsoidAt(x, y, z, 0, 1.645, 0.006, 0.093, 0.116, 0.1), 0.035);
    for (const s of [1, -1]) {
      // shoulder ball keeps the T-pose silhouette organic
      d = smin(d, sdSphereAt(x, y, z, s * 0.155, ARM_Y - 0.005, 0, 0.077), 0.04);
      d = smin(d, sdRoundCone6(x, y, z, s * 0.16, ARM_Y, 0, s * 0.44, ARM_Y, 0, 0.064, 0.052), 0.03);
      d = smin(d, sdRoundCone6(x, y, z, s * 0.44, ARM_Y, 0, s * 0.68, ARM_Y, 0, 0.052, 0.041), 0.025);
      d = smin(d, sdRoundCone6(x, y, z, s * 0.68, ARM_Y, 0, s * 0.795, ARM_Y, 0, 0.043, 0.031), 0.02);
      // legs
      d = smin(d, sdRoundCone6(x, y, z, s * 0.095, 0.95, 0, s * 0.1, 0.52, 0, 0.088, 0.062), 0.05);
      d = smin(d, sdRoundCone6(x, y, z, s * 0.1, 0.52, 0, s * 0.105, 0.1, 0, 0.06, 0.042), 0.04);
      // feet: a squashed capsule from the ankle forward
      d = smin(d, sdRoundCone6(x, y, z, s * 0.105, 0.075, -0.01, s * 0.105, 0.052, 0.135, 0.05, 0.038), 0.025);
    }
    return d;
  };
}

export const BODY_BOUNDS = { min: [-0.62, -0.02, -0.22] as Vec3, max: [0.62, 1.83, 0.24] as Vec3 };
export const BODY_CELL = 0.0125;

export interface FixtureMeshData {
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  material: THREE.Material;
  morphTargets: { name: string; positions: Float32Array }[];
}

export interface BuiltFixture {
  id: string;
  root: THREE.Group;
  skeleton: THREE.Skeleton;
  bones: THREE.Bone[];
  clips: THREE.AnimationClip[];
  meshes: THREE.SkinnedMesh[];
  morphNames: string[];
  stats: { vertices: number; triangles: number; bones: number; clips: number; morphs: number; influences: number };
}

function cylindricalUV(x: number, y: number, z: number, minY: number, maxY: number): [number, number] {
  const u = Math.atan2(z, x) / (Math.PI * 2) + 0.5;
  const v = (y - minY) / Math.max(1e-6, maxY - minY);
  return [u, v];
}

/**
 * Polygonize the body, then deduplicate triangle corners by (position, uv).
 * The UV seam therefore produces genuinely duplicated render vertices that share
 * a position — exactly the case that must not tear when sculpted.
 */
export function buildBodyMeshData(): FixtureMeshData {
  const sdf = buildBodySdf();
  const nets = surfaceNets(sdf, BODY_BOUNDS, BODY_CELL);
  laplacianSmooth(nets.positions, nets.indices, 1, 0.45);
  const vertCount = nets.vertexCount;
  const uvRaw = new Float32Array(vertCount * 2);
  for (let i = 0; i < vertCount; i++) {
    const [u, v] = cylindricalUV(
      nets.positions[i * 3],
      nets.positions[i * 3 + 1],
      nets.positions[i * 3 + 2],
      BODY_BOUNDS.min[1],
      BODY_BOUNDS.max[1],
    );
    uvRaw[i * 2] = u;
    uvRaw[i * 2 + 1] = v;
  }

  // Deduplicate by position+uv, keeping the seam split but welding the rest.
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const map = new Map<string, number>();
  const remap = new Int32Array(vertCount).fill(-1);
  const triCount = nets.indices.length / 3;
  for (let t = 0; t < triCount; t++) {
    const corners = [nets.indices[t * 3], nets.indices[t * 3 + 1], nets.indices[t * 3 + 2]];
    // Unwrap the cylinder seam per triangle so no triangle spans u:0.99 -> 0.01.
    const us = corners.map((c) => uvRaw[c * 2]);
    const span = Math.max(...us) - Math.min(...us);
    for (let k = 0; k < 3; k++) {
      const c = corners[k];
      let u = us[k];
      if (span > 0.5 && u < 0.5) u += 1;
      const x = nets.positions[c * 3];
      const y = nets.positions[c * 3 + 1];
      const z = nets.positions[c * 3 + 2];
      const v = uvRaw[c * 2 + 1];
      const key = `${Math.round(x * 200000)},${Math.round(y * 200000)},${Math.round(z * 200000)},${Math.round(u * 100000)},${Math.round(v * 100000)}`;
      let id = map.get(key);
      if (id === undefined) {
        id = positions.length / 3;
        map.set(key, id);
        positions.push(x, y, z);
        uvs.push(u, v);
      }
      index.push(id);
    }
  }

  const count = positions.length / 3;
  const pos = new Float32Array(positions);
  const nrm = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const g = sdfGradient(sdf, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], 0.0025);
    nrm[i * 3] = g[0];
    nrm[i * 3 + 1] = g[1];
    nrm[i * 3 + 2] = g[2];
  }

  const skin = computeSkinWeights(pos, count, index);
  return {
    name: 'Body',
    positions: pos,
    normals: nrm,
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(index),
    skinIndex: skin.skinIndex,
    skinWeight: skin.skinWeight,
    material: new THREE.MeshStandardMaterial({ name: 'Skin_Clay', color: 0xc8a284, roughness: 0.66, metalness: 0.02 }),
    morphTargets: buildMorphTargets(pos, count),
  };
}

/** Weight field → 5 smoothing passes → top-4 prune → normalise. */
export function computeSkinWeights(
  positions: Float32Array,
  vertexCount: number,
  indices: ArrayLike<number>,
): { skinIndex: Uint16Array; skinWeight: Float32Array } {
  const deform = FIXTURE_BONES.filter((b) => b.radius > 0);
  const boneCount = deform.length;
  const weights = new Float32Array(vertexCount * boneCount);
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    let sum = 0;
    for (let b = 0; b < boneCount; b++) {
      const bone = deform[b];
      const d = distanceToBone(x, y, z, bone);
      const rel = Math.max(d / bone.radius, 0.03);
      let w = 1 / (rel * rel * rel + 0.02);
      if (bone.side === 'L' && x < -0.015) w *= 0.02;
      if (bone.side === 'R' && x > 0.015) w *= 0.02;
      weights[v * boneCount + b] = w;
      sum += w;
    }
    if (sum > 0) for (let b = 0; b < boneCount; b++) weights[v * boneCount + b] /= sum;
  }

  // Smooth over the 1-ring so joints deform without a hard weight step.
  const adj = buildAdjacency(vertexCount, indices as Uint32Array);
  const tmp = new Float32Array(weights.length);
  for (let pass = 0; pass < 5; pass++) {
    tmp.set(weights);
    for (let v = 0; v < vertexCount; v++) {
      const a = adj.start[v];
      const b = adj.start[v + 1];
      const n = b - a;
      const base = v * boneCount;
      if (n === 0) continue;
      for (let k = 0; k < boneCount; k++) {
        let acc = tmp[base + k] * 0.4;
        for (let i = a; i < b; i++) acc += tmp[adj.list[i] * boneCount + k] * 0.6 / n;
        weights[base + k] = acc;
      }
    }
  }

  const skinIndex = new Uint16Array(vertexCount * 4);
  const skinWeight = new Float32Array(vertexCount * 4);
  for (let v = 0; v < vertexCount; v++) {
    const base = v * boneCount;
    const order = Array.from({ length: boneCount }, (_, i) => i).sort((a, b) => weights[base + b] - weights[base + a]);
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const bi = order[k];
      sum += weights[base + bi];
    }
    const inv = sum > 0 ? 1 / sum : 0;
    for (let k = 0; k < 4; k++) {
      const bi = order[k];
      // map to the full bone list index (deform bones are a filtered subset)
      const fullIndex = FIXTURE_BONES.findIndex((bd) => bd.name === deform[bi].name);
      skinIndex[v * 4 + k] = fullIndex;
      skinWeight[v * 4 + k] = weights[base + bi] * inv;
    }
    // clamp float dust so JOINTS/WEIGHTS round-trip exactly through glTF
    let check = 0;
    for (let k = 0; k < 4; k++) check += skinWeight[v * 4 + k];
    skinWeight[v * 4 + 3] += 1 - check;
  }
  return { skinIndex, skinWeight };
}

function distanceToBone(x: number, y: number, z: number, bone: BoneDef): number {
  const ax = bone.head[0];
  const ay = bone.head[1];
  const az = bone.head[2];
  const bx = bone.tail[0];
  const by = bone.tail[1];
  const bz = bone.tail[2];
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const apx = x - ax;
  const apy = y - ay;
  const apz = z - az;
  const len2 = abx * abx + aby * aby + abz * abz || 1;
  let t = (apx * abx + apy * aby + apz * abz) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(apx - abx * t, apy - aby * t, apz - abz * t);
}

/** Three genuinely non-trivial morph targets (exported as glTF morph targets). */
export function buildMorphTargets(positions: Float32Array, vertexCount: number): { name: string; positions: Float32Array }[] {
  const tall = new Float32Array(vertexCount * 3);
  const broad = new Float32Array(vertexCount * 3);
  const headSize = new Float32Array(vertexCount * 3);
  const headCenter: Vec3 = [0, 1.645, 0.006];
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    // Build_Tall: stretch everything above the hips, tapering in at the head.
    const t = Math.max(0, (y - 0.9) / 0.9);
    const gain = 0.16 * t * (y > 1.6 ? 0.55 : 1);
    tall[v * 3] = 0;
    tall[v * 3 + 1] = (y - 0.9) * gain;
    tall[v * 3 + 2] = 0;
    // Build_Broad: widen the ribcage and shoulders, keep hands/feet roughly put.
    const torso = Math.exp(-Math.pow((y - 1.22) / 0.22, 2));
    const outsideArm = Math.abs(x) > 0.2 ? 0.25 : 1;
    broad[v * 3] = x * 0.19 * torso * outsideArm;
    broad[v * 3 + 1] = 0;
    broad[v * 3 + 2] = z * 0.06 * torso;
    // Head_Size: scale the head about its own centre.
    const dh = Math.hypot(x - headCenter[0], y - headCenter[1], z - headCenter[2]);
    const hw = Math.exp(-Math.pow(dh / 0.13, 2));
    headSize[v * 3] = (x - headCenter[0]) * 0.18 * hw;
    headSize[v * 3 + 1] = (y - headCenter[1]) * 0.18 * hw;
    headSize[v * 3 + 2] = (z - headCenter[2]) * 0.18 * hw;
  }
  return [
    { name: 'Build_Tall', positions: tall },
    { name: 'Build_Broad', positions: broad },
    { name: 'Head_Size', positions: headSize },
  ];
}

/** Simple hemisphere hair shell, skinned 100% to the head bone. */
export function buildHairMeshData(): FixtureMeshData {
  const rings = 12;
  const segs = 24;
  const center: Vec3 = [0, 1.66, 0.004];
  const radii: Vec3 = [0.1, 0.118, 0.106];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const push = (vx: number, vy: number, vz: number, nx: number, ny: number, nz: number, tu: number, tv: number) => {
    positions.push(vx, vy, vz);
    normals.push(nx, ny, nz);
    uvs.push(tu, tv);
    return positions.length / 3 - 1;
  };
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * (Math.PI * 0.52);
    for (let s = 0; s <= segs; s++) {
      const theta = (s / segs) * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(theta);
      const ny = Math.cos(phi);
      const nz = Math.sin(phi) * Math.sin(theta);
      push(
        center[0] + nx * radii[0],
        center[1] + ny * radii[1],
        center[2] + nz * radii[2],
        nx / radii[0],
        ny / radii[1],
        nz / radii[2],
        s / segs,
        r / rings,
      );
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segs; s++) {
      const a = r * (segs + 1) + s;
      const b = a + 1;
      const c = a + segs + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const count = positions.length / 3;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const headIdx = FIXTURE_BONES.findIndex((b) => b.name === 'Head');
  for (let v = 0; v < count; v++) {
    skinIndex[v * 4] = headIdx;
    skinWeight[v * 4] = 1;
  }
  return {
    name: 'Hair',
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    skinIndex,
    skinWeight,
    material: new THREE.MeshStandardMaterial({ name: 'Hair_Slate', color: 0x2f3542, roughness: 0.45, metalness: 0.08 }),
    morphTargets: [],
  };
}

function quatTrack(boneName: string, times: number[], eulersDeg: Vec3[]): THREE.QuaternionKeyframeTrack {
  const values: number[] = [];
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (const deg of eulersDeg) {
    e.set(THREE.MathUtils.degToRad(deg[0]), THREE.MathUtils.degToRad(deg[1]), THREE.MathUtils.degToRad(deg[2]), 'XYZ');
    q.setFromEuler(e);
    values.push(q.x, q.y, q.z, q.w);
  }
  return new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values);
}

export function buildFixtureClips(): THREE.AnimationClip[] {
  const idle = new THREE.AnimationClip('Foundry_Idle', 3, [
    quatTrack('Spine', [0, 0.75, 1.5, 2.25, 3], [
      [0, 0, 0], [1.4, 0, 0.6], [0, 0, 0], [-1.4, 0, -0.6], [0, 0, 0],
    ]),
    quatTrack('Chest', [0, 0.75, 1.5, 2.25, 3], [
      [0, 0, 0], [1.8, 1.2, 0], [0.4, 0, 0], [1.8, -1.2, 0], [0, 0, 0],
    ]),
    quatTrack('Head', [0, 1, 2, 3], [
      [0, 0, 0], [0, 7, 0], [0, 0, 0], [0, -5, 0],
    ]),
    quatTrack('UpperArm_L', [0, 1.5, 3], [
      [0, 0, 2], [0, 0, -3], [0, 0, 2],
    ]),
    quatTrack('UpperArm_R', [0, 1.5, 3], [
      [0, 0, -2], [0, 0, 3], [0, 0, -2],
    ]),
  ]);

  const wave = new THREE.AnimationClip('Foundry_Wave', 2.4, [
    quatTrack('UpperArm_L', [0, 0.5, 1.2, 1.8, 2.4], [
      [0, 0, 0], [10, 0, 62], [10, 0, 58], [10, 0, 64], [0, 0, 0],
    ]),
    quatTrack('LowerArm_L', [0, 0.5, 0.9, 1.3, 1.7, 2.4], [
      [0, 0, 0], [0, -18, 24], [0, 15, -8], [0, -18, 24], [0, 15, -8], [0, 0, 0],
    ]),
    quatTrack('Hand_L', [0, 0.6, 1.2, 1.8, 2.4], [
      [0, 0, 0], [0, 0, 18], [0, 0, -14], [0, 0, 18], [0, 0, 0],
    ]),
    quatTrack('Chest', [0, 1.2, 2.4], [
      [0, 0, 0], [0, -5, 0], [0, 0, 0],
    ]),
    quatTrack('Head', [0, 1.2, 2.4], [
      [0, 0, 0], [0, 6, -3], [0, 0, 0],
    ]),
  ]);

  const stride = new THREE.AnimationClip('Foundry_Stride', 1.6, [
    quatTrack('UpperLeg_L', [0, 0.4, 0.8, 1.2, 1.6], [
      [26, 0, 0], [0, 0, 0], [-26, 0, 0], [0, 0, 0], [26, 0, 0],
    ]),
    quatTrack('LowerLeg_L', [0, 0.4, 0.8, 1.2, 1.6], [
      [-6, 0, 0], [-30, 0, 0], [-4, 0, 0], [-8, 0, 0], [-6, 0, 0],
    ]),
    quatTrack('UpperLeg_R', [0, 0.4, 0.8, 1.2, 1.6], [
      [-26, 0, 0], [0, 0, 0], [26, 0, 0], [0, 0, 0], [-26, 0, 0],
    ]),
    quatTrack('LowerLeg_R', [0, 0.4, 0.8, 1.2, 1.6], [
      [-4, 0, 0], [-8, 0, 0], [-6, 0, 0], [-30, 0, 0], [-4, 0, 0],
    ]),
    new THREE.VectorKeyframeTrack('Hips.position', [0, 0.4, 0.8, 1.2, 1.6], [
      0, 0.95, 0,
      0, 0.925, 0,
      0, 0.95, 0,
      0, 0.925, 0,
      0, 0.95, 0,
    ]),
    quatTrack('Spine', [0, 0.4, 0.8, 1.2, 1.6], [
      [0, 2, 0], [0, 0, 0], [0, -2, 0], [0, 0, 0], [0, 2, 0],
    ]),
  ]);

  return [idle, wave, stride];
}

function makeBones(): { bones: THREE.Bone[]; byName: Map<string, THREE.Bone> } {
  const byName = new Map<string, THREE.Bone>();
  const bones: THREE.Bone[] = [];
  for (const def of FIXTURE_BONES) {
    const bone = new THREE.Bone();
    bone.name = def.name;
    const parentHead = def.parent ? FIXTURE_BONES.find((b) => b.name === def.parent)!.head : [0, 0, 0];
    bone.position.set(def.head[0] - parentHead[0], def.head[1] - parentHead[1], def.head[2] - parentHead[2]);
    byName.set(def.name, bone);
    bones.push(bone);
  }
  for (const def of FIXTURE_BONES) {
    if (def.parent) byName.get(def.parent)!.add(byName.get(def.name)!);
  }
  return { bones, byName };
}

function meshFromData(data: FixtureMeshData, skeleton: THREE.Skeleton): THREE.SkinnedMesh {
  const geometry = new THREE.BufferGeometry();
  geometry.name = `${data.name}_Geometry`;
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(data.skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(data.skinWeight, 4));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  if (data.morphTargets.length) {
    geometry.morphAttributes.position = data.morphTargets.map(
      (t) => new THREE.BufferAttribute(t.positions, 3),
    );
    geometry.morphTargetsRelative = true;
  }
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  const mesh = new THREE.SkinnedMesh(geometry, data.material);
  mesh.name = data.name;
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  mesh.add(skeleton.bones[0]);
  mesh.bind(skeleton);
  if (data.morphTargets.length) {
    mesh.morphTargetDictionary = {};
    data.morphTargets.forEach((t, i) => {
      mesh.morphTargetDictionary![t.name] = i;
    });
    mesh.morphTargetInfluences = data.morphTargets.map(() => 0);
  }
  return mesh;
}

/** Assemble the fixture: bones + skinned body + skinned hair + morphs + clips. */
export function buildFoundryHumanoid(): BuiltFixture {
  const body = buildBodyMeshData();
  const hair = buildHairMeshData();
  const { bones, byName } = makeBones();
  const root = new THREE.Group();
  root.name = 'FoundryHumanoid';
  const rootBone = byName.get('Root')!;
  root.add(rootBone);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  const bodyMesh = meshFromData(body, skeleton);
  const hairMesh = meshFromData(hair, skeleton);
  root.add(bodyMesh, hairMesh);
  root.updateMatrixWorld(true);

  const vertices = body.positions.length / 3 + hair.positions.length / 3;
  const triangles = body.indices.length / 3 + hair.indices.length / 3;
  return {
    id: 'fixture-foundry-humanoid',
    root,
    skeleton,
    bones,
    clips: buildFixtureClips(),
    meshes: [bodyMesh, hairMesh],
    morphNames: [...FIXTURE_MORPH_NAMES],
    stats: {
      vertices,
      triangles,
      bones: bones.length,
      clips: 3,
      morphs: FIXTURE_MORPH_NAMES.length,
      influences: 4,
    },
  };
}

/** A deliberately unrigged prop mesh: used to demonstrate honest feature gating. */
export function buildFoundryBust(): { root: THREE.Group; stats: { vertices: number; triangles: number } } {
  const sdf = (x: number, y: number, z: number) => {
    let d = sdEllipsoid(x, y, z, [0, 0.16, 0], [0.17, 0.21, 0.14]);
    d = smin(d, sdRoundCone(x, y, z, [0, 0.02, 0], [0, -0.16, 0], 0.13, 0.16), 0.06);
    d = smin(d, sdEllipsoid(x, y, z, [0, 0.36, 0.01], [0.1, 0.12, 0.105]), 0.04);
    return d;
  };
  const nets = surfaceNets(sdf, { min: [-0.3, -0.35, -0.25], max: [0.3, 0.52, 0.25] }, 0.012);
  laplacianSmooth(nets.positions, nets.indices, 1, 0.4);
  const count = nets.vertexCount;
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const g = sdfGradient(sdf, nets.positions[i * 3], nets.positions[i * 3 + 1], nets.positions[i * 3 + 2]);
    normals.set(g, i * 3);
    const [u, v] = cylindricalUV(nets.positions[i * 3], nets.positions[i * 3 + 1], nets.positions[i * 3 + 2], -0.35, 0.52);
    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(nets.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(nets.indices, 1));
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ name: 'Bust_Stone', color: 0x9aa3ad, roughness: 0.8, metalness: 0.05 }),
  );
  mesh.name = 'StaticBust';
  const root = new THREE.Group();
  root.name = 'FoundryStaticBust';
  root.add(mesh);
  root.updateMatrixWorld(true);
  return { root, stats: { vertices: count, triangles: nets.triangleCount } };
}

/** An original rigid accessory: a visor prop that can be bone-attached to Head. */
export function buildFoundryVisor(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'FoundryVisor';
  const band = new THREE.Mesh(
    new THREE.TorusGeometry(0.108, 0.011, 8, 40, Math.PI * 1.25),
    new THREE.MeshStandardMaterial({ name: 'Visor_Glass', color: 0x6fd6ff, roughness: 0.18, metalness: 0.6 }),
  );
  band.rotation.z = Math.PI * 0.375;
  band.rotation.x = Math.PI / 2;
  const stem = new THREE.Mesh(
    new THREE.BoxGeometry(0.012, 0.05, 0.05),
    new THREE.MeshStandardMaterial({ name: 'Visor_Frame', color: 0x2a2f38, roughness: 0.35, metalness: 0.7 }),
  );
  stem.position.set(0.108, 0, 0);
  const stem2 = stem.clone();
  stem2.position.set(-0.108, 0, 0);
  group.add(band, stem, stem2);
  group.updateMatrixWorld(true);
  return group;
}
