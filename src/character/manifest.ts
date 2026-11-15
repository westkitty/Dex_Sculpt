/**
 * Source manifest — the independent record of what the imported character
 * actually contained, captured before any edit is possible.
 *
 * The exporter is validated against this manifest by a GLB parser that does not
 * use Three.js, so a successful export call is never accepted as proof.
 */
import * as THREE from 'three';
import { hashArray, hashBytes, timeStamp } from '../core/util';
import type { Character, CharacterMeta } from './character';

export interface MeshManifest {
  id: string;
  name: string;
  vertexCount: number;
  triangleCount: number;
  skinned: boolean;
  jointNames: string[];
  jointCount: number;
  inverseBindMatrices: number[];
  jointsHash: string | null;
  weightsHash: string | null;
  uvHash: string | null;
  positionHash: string;
  normalHash: string | null;
  maxInfluences: number;
  weightSumMaxError: number;
  morphTargets: { name: string; hash: string; count: number }[];
  materialNames: string[];
  materialColors: { name: string; color: [number, number, number]; metalness: number; roughness: number }[];
}

export interface SourceManifest {
  schema: 'dexsculpt/source-manifest@1';
  capturedAt: string;
  source: {
    kind: CharacterMeta['sourceKind'];
    fixtureId?: string;
    catalogId?: string;
    fileName?: string;
    byteLength?: number;
    fileHash?: string;
    skeletonFamily?: string;
    license?: string;
    provenance?: string;
  };
  root: {
    name: string;
    scale: [number, number, number];
    rotation: [number, number, number, number];
    position: [number, number, number];
    bounds: { min: [number, number, number]; max: [number, number, number] };
  };
  skeleton: {
    boneCount: number;
    bones: { name: string; parent: string | null }[];
    skinCount: number;
    jointNamesPerSkin: string[][];
  };
  meshes: MeshManifest[];
  clips: { name: string; duration: number; trackCount: number; tracks: string[] }[];
  counts: {
    vertices: number;
    triangles: number;
    skinnedMeshes: number;
    morphTargets: number;
    materials: number;
    maxInfluences: number;
  };
}

export function captureManifest(character: Character, meta: CharacterMeta): SourceManifest {
  const root = character.root;
  root.updateMatrixWorld(true);
  const boneParent = new Map<string, string | null>();
  for (const bone of character.bones) {
    const parent = bone.parent;
    boneParent.set(bone.name, parent && (parent as THREE.Bone).isBone ? parent.name : null);
  }

  const bounds = new THREE.Box3().setFromObject(root);
  const skeleton = character.skeleton;
  const jointNames = skeleton ? skeleton.bones.map((b) => b.name) : [];

  const meshes: MeshManifest[] = character.meshes.map((rec) => {
    const geometry = rec.mesh.geometry;
    const joints = geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
    const weights = geometry.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
    const uv = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const morphs = (geometry.morphAttributes.position ?? []).map((attr, i) => {
      const name = rec.morphTargets.find((m) => m.index === i)?.name ?? `target_${i}`;
      const canonical = new Float32Array(attr.count * 3);
      for (let v = 0; v < attr.count; v++) {
        canonical[v * 3] = attr.getX(v);
        canonical[v * 3 + 1] = attr.getY(v);
        canonical[v * 3 + 2] = attr.getZ(v);
      }
      return { name, hash: hashArray(canonical), count: attr.count };
    });
    const canonicalPos = new Float32Array(rec.vertexCount * 3);
    canonicalPos.set(rec.basePosition);
    const canonicalNormal = rec.baseNormal ? new Float32Array(rec.baseNormal) : null;
    return {
      id: rec.id,
      name: rec.name,
      vertexCount: rec.vertexCount,
      triangleCount: rec.triangleCount,
      skinned: rec.skinned,
      jointNames: rec.skinned ? jointNames : [],
      jointCount: rec.skinned ? jointNames.length : 0,
      inverseBindMatrices: skeleton ? flattenMatrices(skeleton.boneInverses) : [],
      jointsHash: joints ? hashArray(canonicalJoints(joints)) : null,
      weightsHash: weights ? hashArray(canonicalWeights(weights)) : null,
      uvHash: uv ? hashArray(canonicalUV(uv)) : null,
      positionHash: hashArray(canonicalPos),
      normalHash: canonicalNormal ? hashArray(canonicalNormal) : null,
      maxInfluences: rec.maxInfluences,
      weightSumMaxError: rec.weightSumMaxError,
      morphTargets: morphs,
      materialNames: rec.materialSlots.map((s) => s.name),
      materialColors: rec.materialSlots.map((s) => ({
        name: s.name,
        color: [s.material.color.r, s.material.color.g, s.material.color.b] as [number, number, number],
        metalness: s.material.metalness ?? 0,
        roughness: s.material.roughness ?? 0.5,
      })),
    };
  });

  const counts = character.countStats();
  return {
    schema: 'dexsculpt/source-manifest@1',
    capturedAt: timeStamp(),
    source: {
      kind: meta.sourceKind,
      fixtureId: meta.fixtureId,
      catalogId: meta.catalogId,
      fileName: meta.fileName,
      byteLength: meta.byteLength,
      fileHash: meta.fileHash,
      skeletonFamily: meta.skeletonFamily,
      license: meta.license,
      provenance: meta.provenance,
    },
    root: {
      name: root.name,
      scale: [root.scale.x, root.scale.y, root.scale.z],
      rotation: [root.quaternion.x, root.quaternion.y, root.quaternion.z, root.quaternion.w],
      position: [root.position.x, root.position.y, root.position.z],
      bounds: {
        min: [bounds.min.x, bounds.min.y, bounds.min.z],
        max: [bounds.max.x, bounds.max.y, bounds.max.z],
      },
    },
    skeleton: {
      boneCount: character.bones.length,
      bones: character.bones.map((b) => ({ name: b.name, parent: boneParent.get(b.name) ?? null })),
      skinCount: character.meshes.filter((m) => m.skinned).length,
      jointNamesPerSkin: character.meshes.filter((m) => m.skinned).map(() => jointNames),
    },
    meshes,
    clips: character.clips.map((clip) => ({
      name: clip.name,
      duration: clip.duration,
      trackCount: clip.tracks.length,
      tracks: clip.tracks.map((t) => t.name),
    })),
    counts: {
      vertices: counts.vertices,
      triangles: counts.triangles,
      skinnedMeshes: counts.skinnedMeshes,
      morphTargets: counts.morphTargets,
      materials: counts.materials,
      maxInfluences: Math.max(0, ...meshes.map((m) => m.maxInfluences)),
    },
  };
}

export function canonicalJoints(attr: THREE.BufferAttribute): Uint32Array {
  const out = new Uint32Array(attr.count * 4);
  for (let i = 0; i < attr.count; i++) {
    for (let k = 0; k < 4; k++) out[i * 4 + k] = attr.getComponent(i, k) | 0;
  }
  return out;
}

export function canonicalWeights(attr: THREE.BufferAttribute): Float32Array {
  const out = new Float32Array(attr.count * 4);
  for (let i = 0; i < attr.count; i++) {
    for (let k = 0; k < 4; k++) out[i * 4 + k] = attr.getComponent(i, k);
  }
  return out;
}

export function canonicalUV(attr: THREE.BufferAttribute): Float32Array {
  const out = new Float32Array(attr.count * 2);
  for (let i = 0; i < attr.count; i++) {
    out[i * 2] = attr.getX(i);
    out[i * 2 + 1] = attr.getY(i);
  }
  return out;
}

export function flattenMatrices(matrices: THREE.Matrix4[]): number[] {
  const out: number[] = [];
  for (const m of matrices) out.push(...m.elements);
  return out;
}

/** Fingerprint of a byte buffer, exposed for provenance records. */
export function bytesFingerprint(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return `${u8.byteLength}:${hashBytes(u8)}`;
}
