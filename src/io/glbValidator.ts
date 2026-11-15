/**
 * Independent GLB 2.0 binary structural validator + rig comparison report.
 * Zero dependency on Three.js exporters or loaders so exported files are
 * audited directly at the glTF JSON + BIN chunk level.
 */
import * as THREE from 'three';
import { hashBytes, maxPositionDelta } from '../core/topology';

export interface GlbPrimitiveReport {
  meshName: string;
  vertexCount: number;
  indexCount: number;
  hasPosition: boolean;
  hasNormal: boolean;
  hasUV: boolean;
  hasJoints: boolean;
  hasWeights: boolean;
  weightsNormalized: boolean;
  maxJointIndex: number;
  morphTargetCount: number;
  morphTargetNames: string[];
  positions: Float32Array;
  joints: Uint16Array | null;
  weights: Float32Array | null;
  uvs: Float32Array | null;
  morphPositionDeltas: Float32Array[];
}

export interface GlbSkinReport {
  name: string;
  jointCount: number;
  jointNames: string[];
  jointParents: Array<string | null>;
  inverseBindMatrices: Float32Array | null;
}

export interface GlbAnimationReport {
  name: string;
  channelCount: number;
  samplerCount: number;
  durationSec: number;
}

export interface GlbValidationReport {
  validGlb2: boolean;
  byteLength: number;
  nodeCount: number;
  meshCount: number;
  materialCount: number;
  textureCount: number;
  skinCount: number;
  animationCount: number;
  totalVertices: number;
  totalTriangles: number;
  primitives: GlbPrimitiveReport[];
  skins: GlbSkinReport[];
  animations: GlbAnimationReport[];
  errors: string[];
  warnings: string[];
}

export interface RigPreservationDiff {
  passed: boolean;
  boneCountEqual: boolean;
  boneNamesEqual: boolean;
  boneHierarchyEqual: boolean;
  inverseBindMatricesMaxDiff: number;
  jointsExactMatch: boolean;
  weightsMaxDiff: number;
  uvMaxDiff: number;
  morphTargetsEqual: boolean;
  morphDeltasMaxDiff: number;
  animationCountEqual: boolean;
  animationNamesEqual: boolean;
  materialCountEqual: boolean;
  vertexCountEqual: boolean;
  triangleCountEqual: boolean;
  sculptMaxPositionDelta: number;
  failures: string[];
}

const COMP_BYTES: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4
};
const TYPE_COMPS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16
};

function readAccessorAsFloat32(json: any, bin: ArrayBuffer, idx: number): Float32Array {
  const acc = json.accessors[idx];
  const comps = TYPE_COMPS[acc.type];
  const out = new Float32Array(acc.count * comps);
  if (acc.bufferView === undefined) return out;
  const bv = json.bufferViews[acc.bufferView];
  const compBytes = COMP_BYTES[acc.componentType];
  const stride = bv.byteStride ?? comps * compBytes;
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const dv = new DataView(bin);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < comps; c++) {
      const off = base + i * stride + c * compBytes;
      switch (acc.componentType) {
        case 5126:
          out[i * comps + c] = dv.getFloat32(off, true);
          break;
        case 5121:
          out[i * comps + c] = acc.normalized ? dv.getUint8(off) / 255 : dv.getUint8(off);
          break;
        case 5123:
          out[i * comps + c] = acc.normalized ? dv.getUint16(off, true) / 65535 : dv.getUint16(off, true);
          break;
        case 5120:
          out[i * comps + c] = acc.normalized ? Math.max(-1, dv.getInt8(off) / 127) : dv.getInt8(off);
          break;
        case 5122:
          out[i * comps + c] = acc.normalized ? Math.max(-1, dv.getInt16(off, true) / 32767) : dv.getInt16(off, true);
          break;
        default:
          out[i * comps + c] = dv.getFloat32(off, true);
      }
    }
  }
  return out;
}

function readAccessorAsUint16(json: any, bin: ArrayBuffer, idx: number): Uint16Array {
  const acc = json.accessors[idx];
  const comps = TYPE_COMPS[acc.type];
  const out = new Uint16Array(acc.count * comps);
  if (acc.bufferView === undefined) return out;
  const bv = json.bufferViews[acc.bufferView];
  const compBytes = COMP_BYTES[acc.componentType];
  const stride = bv.byteStride ?? comps * compBytes;
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const dv = new DataView(bin);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < comps; c++) {
      const off = base + i * stride + c * compBytes;
      if (acc.componentType === 5121) out[i * comps + c] = dv.getUint8(off);
      else if (acc.componentType === 5123) out[i * comps + c] = dv.getUint16(off, true);
      else if (acc.componentType === 5125) out[i * comps + c] = dv.getUint32(off, true);
      else out[i * comps + c] = dv.getFloat32(off, true);
    }
  }
  return out;
}

/** Independently parse and validate a GLB 2.0 binary buffer without Three.js. */
export function validateGlbBinary(buf: ArrayBuffer): GlbValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const dv = new DataView(buf);

  if (buf.byteLength < 12) {
    return emptyReport(buf.byteLength, ['Buffer smaller than 12-byte GLB header']);
  }
  if (dv.getUint32(0, true) !== 0x46546c67) {
    return emptyReport(buf.byteLength, ['Invalid GLB magic header (expected glTF)']);
  }
  if (dv.getUint32(4, true) !== 2) {
    return emptyReport(buf.byteLength, [`Unsupported glTF version ${dv.getUint32(4, true)}`]);
  }
  const total = dv.getUint32(8, true);
  if (total !== buf.byteLength) {
    errors.push(`GLB byteLength mismatch: header=${total}, actual=${buf.byteLength}`);
  }

  let off = 12;
  let json: any = null;
  let bin: ArrayBuffer = new ArrayBuffer(0);
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const chunk = buf.slice(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) {
      json = JSON.parse(new TextDecoder().decode(chunk));
    } else if (type === 0x004e4942) {
      bin = chunk;
    }
    off += 8 + len;
  }

  if (!json) {
    return emptyReport(buf.byteLength, ['GLB missing JSON chunk']);
  }

  const nodes: any[] = json.nodes ?? [];
  const parentOf = new Array<number | null>(nodes.length).fill(null);
  nodes.forEach((node, idx) => {
    for (const child of node.children ?? []) {
      if (child >= 0 && child < nodes.length) parentOf[child] = idx;
    }
  });

  const primitives: GlbPrimitiveReport[] = [];
  let totalVertices = 0;
  let totalTriangles = 0;

  for (const m of json.meshes ?? []) {
    const targetNames: string[] = Array.isArray(m.extras?.targetNames) ? m.extras.targetNames : [];
    for (const p of m.primitives ?? []) {
      const attrs = p.attributes ?? {};
      const hasPosition = attrs.POSITION !== undefined;
      const positions = hasPosition ? readAccessorAsFloat32(json, bin, attrs.POSITION) : new Float32Array(0);
      const vertexCount = positions.length / 3;
      const indexCount = p.indices !== undefined ? json.accessors[p.indices].count : vertexCount;
      totalVertices += vertexCount;
      totalTriangles += Math.floor(indexCount / 3);

      const joints = attrs.JOINTS_0 !== undefined ? readAccessorAsUint16(json, bin, attrs.JOINTS_0) : null;
      const weights = attrs.WEIGHTS_0 !== undefined ? readAccessorAsFloat32(json, bin, attrs.WEIGHTS_0) : null;
      const uvs = attrs.TEXCOORD_0 !== undefined ? readAccessorAsFloat32(json, bin, attrs.TEXCOORD_0) : null;

      let weightsNormalized = true;
      if (weights) {
        for (let i = 0; i < vertexCount; i++) {
          const sum = weights[i * 4] + weights[i * 4 + 1] + weights[i * 4 + 2] + weights[i * 4 + 3];
          if (Math.abs(sum - 1) > 0.02) {
            weightsNormalized = false;
            break;
          }
        }
      }
      let maxJointIndex = -1;
      if (joints) {
        for (let i = 0; i < joints.length; i++) {
          if (joints[i] > maxJointIndex) maxJointIndex = joints[i];
        }
      }

      const morphTargets = Array.isArray(p.targets) ? p.targets : [];
      const morphPositionDeltas: Float32Array[] = [];
      for (const t of morphTargets) {
        if (t.POSITION !== undefined) {
          morphPositionDeltas.push(readAccessorAsFloat32(json, bin, t.POSITION));
        }
      }

      if (!hasPosition) errors.push(`Mesh "${m.name ?? 'unnamed'}" primitive missing POSITION`);
      if (joints && !weights) errors.push(`Mesh "${m.name ?? 'unnamed'}" has JOINTS_0 without WEIGHTS_0`);
      if (weights && !weightsNormalized) {
        warnings.push(`Mesh "${m.name ?? 'unnamed'}" has unnormalized skin weights`);
      }

      primitives.push({
        meshName: m.name ?? 'Mesh',
        vertexCount,
        indexCount,
        hasPosition,
        hasNormal: attrs.NORMAL !== undefined,
        hasUV: attrs.TEXCOORD_0 !== undefined,
        hasJoints: !!joints,
        hasWeights: !!weights,
        weightsNormalized,
        maxJointIndex,
        morphTargetCount: morphTargets.length,
        morphTargetNames: targetNames.length
          ? targetNames
          : morphTargets.map((_: unknown, ti: number) => `morph_${ti}`),
        positions,
        joints,
        weights,
        uvs,
        morphPositionDeltas
      });
    }
  }

  const skins: GlbSkinReport[] = (json.skins ?? []).map((s: any, si: number) => {
    const jointIndices: number[] = s.joints ?? [];
    const jointSet = new Set(jointIndices);
    const jointNames = jointIndices.map((ni) => nodes[ni]?.name ?? `bone_${ni}`);
    const jointParents = jointIndices.map((ni) => {
      const pIdx = parentOf[ni];
      if (pIdx === null || !jointSet.has(pIdx)) return null;
      return nodes[pIdx]?.name ?? null;
    });
    const ibm =
      s.inverseBindMatrices !== undefined ? readAccessorAsFloat32(json, bin, s.inverseBindMatrices) : null;
    if (ibm && ibm.length !== jointIndices.length * 16) {
      errors.push(`Skin ${si} inverseBindMatrices length mismatch`);
    }
    for (const p of primitives) {
      if (p.maxJointIndex >= jointIndices.length) {
        errors.push(`Primitive "${p.meshName}" references joint index ${p.maxJointIndex} >= ${jointIndices.length}`);
      }
    }
    return {
      name: s.name ?? `Skin_${si}`,
      jointCount: jointIndices.length,
      jointNames,
      jointParents,
      inverseBindMatrices: ibm
    };
  });

  const animations: GlbAnimationReport[] = (json.animations ?? []).map((a: any, ai: number) => {
    let durationSec = 0;
    for (const sampler of a.samplers ?? []) {
      const acc = json.accessors?.[sampler.input];
      if (acc && Array.isArray(acc.max) && typeof acc.max[0] === 'number') {
        durationSec = Math.max(durationSec, acc.max[0]);
      } else if (sampler.input !== undefined) {
        const times = readAccessorAsFloat32(json, bin, sampler.input);
        if (times.length) durationSec = Math.max(durationSec, times[times.length - 1]);
      }
    }
    return {
      name: a.name ?? `Animation_${ai}`,
      channelCount: (a.channels ?? []).length,
      samplerCount: (a.samplers ?? []).length,
      durationSec
    };
  });

  return {
    validGlb2: errors.length === 0,
    byteLength: buf.byteLength,
    nodeCount: nodes.length,
    meshCount: (json.meshes ?? []).length,
    materialCount: (json.materials ?? []).length,
    textureCount: (json.textures ?? []).length,
    skinCount: skins.length,
    animationCount: animations.length,
    totalVertices,
    totalTriangles,
    primitives,
    skins,
    animations,
    errors,
    warnings
  };
}

function emptyReport(byteLength: number, errors: string[]): GlbValidationReport {
  return {
    validGlb2: false,
    byteLength,
    nodeCount: 0,
    meshCount: 0,
    materialCount: 0,
    textureCount: 0,
    skinCount: 0,
    animationCount: 0,
    totalVertices: 0,
    totalTriangles: 0,
    primitives: [],
    skins: [],
    animations: [],
    errors,
    warnings: []
  };
}

/**
 * Compare baseline GLB report (before sculpting) vs exported sculpted GLB report.
 * Enforces that sculpting measurably changed positions while preserving every rig invariant.
 */
export function compareRigPreservation(
  before: GlbValidationReport,
  after: GlbValidationReport,
  expectSculptChange = true,
  allowAddedAttachments = false
): RigPreservationDiff {
  const failures: string[] = [];

  if (!after.validGlb2) {
    failures.push(`Exported GLB failed binary validation: ${after.errors.join('; ')}`);
  }

  const p0 = before.primitives[0];
  const p1 =
    (p0
      ? after.primitives.find(
          (p) =>
            p.meshName === p0.meshName &&
            p.vertexCount === p0.vertexCount &&
            p.hasJoints === p0.hasJoints
        ) ??
        after.primitives.find(
          (p) => p.vertexCount === p0.vertexCount && p.morphTargetCount === p0.morphTargetCount
        )
      : undefined) ?? after.primitives[0];

  const s0 = before.skins[0];
  const s1 =
    (s0
      ? after.skins.find(
          (s) => s.jointCount === s0.jointCount && s.jointNames[0] === s0.jointNames[0]
        )
      : undefined) ?? after.skins[0];

  const vertexCountEqual = !!p0 && !!p1 && p0.vertexCount === p1.vertexCount;
  const triangleCountEqual = !!p0 && !!p1 && p0.indexCount === p1.indexCount;
  if (!vertexCountEqual) failures.push(`Vertex count changed: ${p0?.vertexCount} -> ${p1?.vertexCount}`);
  if (!triangleCountEqual) failures.push(`Triangle index count changed: ${p0?.indexCount} -> ${p1?.indexCount}`);

  const boneCountEqual = !!s0 && !!s1 && s0.jointCount === s1.jointCount;
  const boneNamesEqual =
    !!s0 &&
    !!s1 &&
    s0.jointNames.length === s1.jointNames.length &&
    s0.jointNames.every((n, i) => n === s1.jointNames[i]);
  const boneHierarchyEqual =
    !!s0 &&
    !!s1 &&
    s0.jointParents.length === s1.jointParents.length &&
    s0.jointParents.every((n, i) => n === s1.jointParents[i]);

  if (!boneCountEqual) failures.push(`Bone count changed: ${s0?.jointCount} -> ${s1?.jointCount}`);
  if (!boneNamesEqual) failures.push('Bone names changed during export');
  if (!boneHierarchyEqual) failures.push('Bone parent hierarchy changed during export');

  let inverseBindMatricesMaxDiff = Infinity;
  if (s0?.inverseBindMatrices && s1?.inverseBindMatrices && s0.inverseBindMatrices.length === s1.inverseBindMatrices.length) {
    inverseBindMatricesMaxDiff = 0;
    for (let i = 0; i < s0.inverseBindMatrices.length; i++) {
      const d = Math.abs(s0.inverseBindMatrices[i] - s1.inverseBindMatrices[i]);
      if (d > inverseBindMatricesMaxDiff) inverseBindMatricesMaxDiff = d;
    }
  }
  if (!(inverseBindMatricesMaxDiff < 1e-4)) {
    failures.push(`Inverse bind matrices drifted: max diff=${inverseBindMatricesMaxDiff}`);
  }

  const jointsExactMatch =
    !!p0?.joints &&
    !!p1?.joints &&
    hashBytes(p0.joints) === hashBytes(p1.joints);
  if (!jointsExactMatch) failures.push('JOINTS_0 skin indices did not match source');

  let weightsMaxDiff = Infinity;
  if (p0?.weights && p1?.weights && p0.weights.length === p1.weights.length) {
    weightsMaxDiff = 0;
    for (let i = 0; i < p0.weights.length; i++) {
      const d = Math.abs(p0.weights[i] - p1.weights[i]);
      if (d > weightsMaxDiff) weightsMaxDiff = d;
    }
  }
  if (!(weightsMaxDiff < 1e-4)) {
    failures.push(`WEIGHTS_0 skin weights drifted: max diff=${weightsMaxDiff}`);
  }

  let uvMaxDiff = Infinity;
  if (p0?.uvs && p1?.uvs && p0.uvs.length === p1.uvs.length) {
    uvMaxDiff = 0;
    for (let i = 0; i < p0.uvs.length; i++) {
      const d = Math.abs(p0.uvs[i] - p1.uvs[i]);
      if (d > uvMaxDiff) uvMaxDiff = d;
    }
  }
  if (!(uvMaxDiff < 1e-5)) {
    failures.push(`TEXCOORD_0 UVs drifted: max diff=${uvMaxDiff}`);
  }

  const morphTargetsEqual =
    !!p0 &&
    !!p1 &&
    p0.morphTargetCount === p1.morphTargetCount &&
    p0.morphTargetNames.every((n, i) => n === p1.morphTargetNames[i]);
  if (!morphTargetsEqual) {
    failures.push(`Morph target metadata changed: ${p0?.morphTargetNames.join(',')} -> ${p1?.morphTargetNames.join(',')}`);
  }

  let morphDeltasMaxDiff = 0;
  if (p0 && p1 && p0.morphPositionDeltas.length === p1.morphPositionDeltas.length) {
    for (let t = 0; t < p0.morphPositionDeltas.length; t++) {
      const a = p0.morphPositionDeltas[t];
      const b = p1.morphPositionDeltas[t];
      if (a.length !== b.length) {
        morphDeltasMaxDiff = Infinity;
        break;
      }
      for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d > morphDeltasMaxDiff) morphDeltasMaxDiff = d;
      }
    }
  } else {
    morphDeltasMaxDiff = Infinity;
  }
  if (!(morphDeltasMaxDiff < 1e-4)) {
    failures.push(`Morph target position deltas drifted: max diff=${morphDeltasMaxDiff}`);
  }

  const animationCountEqual = before.animationCount === after.animationCount;
  const animationNamesEqual =
    animationCountEqual &&
    before.animations.every((a, i) => a.name === after.animations[i]?.name);
  if (!animationCountEqual || !animationNamesEqual) {
    failures.push('Animation clips were lost or renamed');
  }

  const materialCountEqual = allowAddedAttachments
    ? after.materialCount >= before.materialCount
    : before.materialCount === after.materialCount;
  if (!materialCountEqual) {
    failures.push(`Material count changed: ${before.materialCount} -> ${after.materialCount}`);
  }

  const sculptMaxPositionDelta =
    p0 && p1 ? maxPositionDelta(p0.positions, p1.positions) : 0;
  if (expectSculptChange && !(sculptMaxPositionDelta > 1e-4)) {
    failures.push(`Expected measurable sculpt change, got maxPositionDelta=${sculptMaxPositionDelta}`);
  }

  return {
    passed: failures.length === 0,
    boneCountEqual,
    boneNamesEqual,
    boneHierarchyEqual,
    inverseBindMatricesMaxDiff,
    jointsExactMatch,
    weightsMaxDiff,
    uvMaxDiff,
    morphTargetsEqual,
    morphDeltasMaxDiff,
    animationCountEqual,
    animationNamesEqual,
    materialCountEqual,
    vertexCountEqual,
    triangleCountEqual,
    sculptMaxPositionDelta,
    failures
  };
}

/** Dispose all GPU resources of a Three.js character subtree (including skeleton boneTextures!). */
export function disposeCharacterRoot(root: THREE.Object3D): {
  geometries: number;
  materials: number;
  textures: number;
  skeletons: number;
} {
  let geometries = 0;
  let materials = 0;
  let textures = 0;
  let skeletons = 0;

  const seenGeo = new Set<THREE.BufferGeometry>();
  const seenMat = new Set<THREE.Material>();
  const seenTex = new Set<THREE.Texture>();
  const seenSkel = new Set<THREE.Skeleton>();

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry && !seenGeo.has(mesh.geometry)) {
      seenGeo.add(mesh.geometry);
      const g = mesh.geometry as THREE.BufferGeometry & { disposeBoundsTree?: () => void };
      if (g.disposeBoundsTree) g.disposeBoundsTree();
      g.dispose();
      geometries++;
    }
    const skinned = obj as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh && skinned.skeleton && !seenSkel.has(skinned.skeleton)) {
      seenSkel.add(skinned.skeleton);
      skinned.skeleton.dispose();
      skeletons++;
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats) {
      if (!seenMat.has(m)) {
        seenMat.add(m);
        for (const val of Object.values(m)) {
          if (val && (val as THREE.Texture).isTexture && !seenTex.has(val as THREE.Texture)) {
            seenTex.add(val as THREE.Texture);
            (val as THREE.Texture).dispose();
            textures++;
          }
        }
        m.dispose();
        materials++;
      }
    }
  });

  return { geometries, materials, textures, skeletons };
}
