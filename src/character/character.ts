/**
 * Character model: the single place that owns imported geometry, its rig, its
 * morph targets, its clips and the sculpt delta buffers.
 *
 * Invariants enforced here (and asserted by tests):
 *   1. `basePosition` is a private copy of the imported POSITION attribute.
 *   2. Edits only ever write `delta`, `mask` and the derived `position`/`normal`
 *      attributes. Indices, JOINTS_0, WEIGHTS_0, morph attributes, UVs and
 *      material groups are never reallocated or reordered.
 *   3. Live positions are always exactly `basePosition + delta`.
 */
import * as THREE from 'three';
import { hashArray } from '../core/util';
import { SpatialIndex } from '../sculpt/spatialIndex';
import type { SculptTarget } from '../sculpt/engine';
import { bboxDiagonal, buildGroupAdjacency, buildGroupTriangles, buildWeldMap, type WeldMap } from '../sculpt/weld';
import { captureManifest, type SourceManifest } from './manifest';

export type MeshCapability = 'skinned' | 'morphs' | 'uvs' | 'indexed';

export interface MaterialSlot {
  slot: number;
  material: THREE.MeshStandardMaterial;
  name: string;
  baseColorHex: string;
  baseMetalness: number;
  baseRoughness: number;
  /** values currently applied (may differ from base after an override) */
  colorHex: string;
  metalness: number;
  roughness: number;
  overridden: boolean;
}

export interface MorphTargetRef {
  name: string;
  index: number;
  weight: number;
}

export interface MeshRecord {
  id: string;
  name: string;
  mesh: THREE.Mesh | THREE.SkinnedMesh;
  skinned: boolean;
  vertexCount: number;
  triangleCount: number;
  indexed: boolean;
  hasUVs: boolean;
  hasNormals: boolean;
  /** immutable imported positions */
  basePosition: Float32Array;
  /** immutable imported normals (used to restore normals on delta reset) */
  baseNormal: Float32Array | null;
  /** live render buffers */
  positionAttr: THREE.BufferAttribute;
  normalAttr: THREE.BufferAttribute | null;
  delta: Float32Array;
  mask: Float32Array;
  weld: WeldMap;
  /** representative position per weld group (mutable; the spatial index reads it) */
  groupPositions: Float32Array;
  spatial: SpatialIndex;
  groupAdjacency: { start: Uint32Array; list: Uint32Array };
  groupTriangles: { start: Uint32Array; list: Uint32Array };
  triNormal: Float32Array;
  groupNormal: Float32Array;
  pendingGroups: Set<number>;
  materialSlots: MaterialSlot[];
  morphTargets: MorphTargetRef[];
  capabilities: Set<MeshCapability>;
  /** influences count actually present in JOINTS_0/WEIGHTS_0 */
  maxInfluences: number;
  weightSumMaxError: number;
}

export interface AttachmentSlot {
  id: string;
  name: string;
  root: THREE.Object3D;
  boneName: string;
  fileName?: string;
  hash?: string;
  bytes?: ArrayBuffer;
  compatibility?: { ok: boolean; mode: string; reasons: string[]; notes: string[] };
}

export class Character {
  readonly meshes: MeshRecord[] = [];
  readonly root: THREE.Group;
  readonly skeleton: THREE.Skeleton | null;
  readonly bones: THREE.Bone[] = [];
  readonly clips: THREE.AnimationClip[] = [];
  readonly mixer: THREE.AnimationMixer | null;
  readonly manifest: SourceManifest;
  readonly bindTransforms = new Map<THREE.Bone, { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }>();
  readonly morphMeshes: { record: MeshRecord; dictionary: Record<string, number> }[] = [];
  /** current active clip name (null = bind pose) */
  activeClip: string | null = null;

  private targeted = new Map<string, SculptTarget>();
  private disposables: { dispose(): void }[] = [];
  attachments: AttachmentSlot[] = [];

  constructor(
    root: THREE.Group,
    clips: THREE.AnimationClip[],
    public readonly meta: CharacterMeta,
  ) {
    this.root = root;
    this.clips = clips;
    root.updateMatrixWorld(true);

    const meshes: THREE.Mesh[] = [];
    root.traverse((obj) => {
      const asMesh = obj as THREE.Mesh;
      if ((asMesh as unknown as { isMesh?: boolean }).isMesh && asMesh.geometry?.attributes?.position) meshes.push(asMesh);
    });

    let skeleton: THREE.Skeleton | null = null;
    const bones: THREE.Bone[] = [];
    root.traverse((obj) => {
      if ((obj as THREE.Bone).isBone) {
        const bone = obj as THREE.Bone;
        if (!bones.includes(bone)) bones.push(bone);
        this.bindTransforms.set(bone, {
          position: bone.position.clone(),
          quaternion: bone.quaternion.clone(),
          scale: bone.scale.clone(),
        });
      }
    });
    for (const m of meshes) {
      const skinned = m as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh && skinned.skeleton) {
        skeleton = skinned.skeleton;
        break;
      }
    }
    this.skeleton = skeleton;
    this.bones = bones;

    meshes.forEach((mesh, i) => {
      this.meshes.push(this.buildRecord(mesh, i));
    });

    for (const record of this.meshes) {
      if (record.morphTargets.length) {
        const dict = (record.mesh as THREE.Mesh).morphTargetDictionary ?? {};
        this.morphMeshes.push({ record, dictionary: dict });
      }
    }

    if (clips.length && bones.length) {
      const mixer = new THREE.AnimationMixer(root);
      for (const clip of clips) {
        const action = mixer.clipAction(clip);
        action.clampWhenFinished = false;
        action.setLoop(THREE.LoopRepeat, Infinity);
      }
      this.mixer = mixer;
    } else {
      this.mixer = null;
    }

    this.manifest = captureManifest(this, meta);
  }

  private buildRecord(mesh: THREE.Mesh, index: number): MeshRecord {
    const geometry = mesh.geometry;
    const positionAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const vertexCount = positionAttr.count;
    const indexed = !!geometry.getIndex();
    const triangleCount = indexed ? geometry.getIndex()!.count / 3 : vertexCount / 3;

    // Copy into a plain Float32Array (handles interleaved attributes).
    const basePosition = new Float32Array(vertexCount * 3);
    for (let v = 0; v < vertexCount; v++) {
      basePosition[v * 3] = positionAttr.getX(v);
      basePosition[v * 3 + 1] = positionAttr.getY(v);
      basePosition[v * 3 + 2] = positionAttr.getZ(v);
    }
    const normalAttr = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
    let baseNormal: Float32Array | null = null;
    if (normalAttr) {
      baseNormal = new Float32Array(vertexCount * 3);
      for (let v = 0; v < vertexCount; v++) {
        baseNormal[v * 3] = normalAttr.getX(v);
        baseNormal[v * 3 + 1] = normalAttr.getY(v);
        baseNormal[v * 3 + 2] = normalAttr.getZ(v);
      }
    }

    // Ensure the live attributes are plain non-interleaved arrays we can write.
    let livePosition = positionAttr.array as Float32Array;
    const interleaved = (positionAttr as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute === true;
    if (!(livePosition instanceof Float32Array) || interleaved || !ArrayBuffer.isView(positionAttr.array)) {
      livePosition = new Float32Array(basePosition);
      geometry.setAttribute('position', new THREE.BufferAttribute(livePosition, 3));
    } else if (livePosition.length !== vertexCount * 3) {
      livePosition = new Float32Array(basePosition);
      geometry.setAttribute('position', new THREE.BufferAttribute(livePosition, 3));
    }
    const newPositionAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const newNormalAttr = (geometry.getAttribute('normal') as THREE.BufferAttribute | undefined) ?? null;

    const indices = indexed ? geometry.getIndex()!.array : null;
    const idxArray = indices ?? buildSequentialIndex(vertexCount);
    const diag = bboxDiagonal(basePosition, vertexCount);
    const weld = buildWeldMap(basePosition, vertexCount, idxArray as ArrayLike<number>, diag);
    const groupAdjacency = buildGroupAdjacency(weld, idxArray as ArrayLike<number>);
    const groupTriangles = buildGroupTriangles(weld, idxArray as ArrayLike<number>);
    const triNormal = new Float32Array((idxArray.length / 3) * 3);
    const groupNormal = new Float32Array(weld.groupCount * 3);

    const groupPositions = new Float32Array(weld.groupCount * 3);
    for (let g = 0; g < weld.groupCount; g++) {
      const rep = weld.groupList[weld.groupStart[g]];
      groupPositions[g * 3] = basePosition[rep * 3];
      groupPositions[g * 3 + 1] = basePosition[rep * 3 + 1];
      groupPositions[g * 3 + 2] = basePosition[rep * 3 + 2];
    }

    const record: MeshRecord = {
      id: `${(mesh.name || 'mesh').replace(/\s+/g, '_')}#${index}`,
      name: mesh.name || `Mesh_${index}`,
      mesh,
      skinned: (mesh as THREE.SkinnedMesh).isSkinnedMesh === true,
      vertexCount,
      triangleCount,
      indexed,
      hasUVs: !!geometry.getAttribute('uv'),
      hasNormals: !!normalAttr,
      basePosition,
      baseNormal,
      positionAttr: newPositionAttr,
      normalAttr: newNormalAttr,
      delta: new Float32Array(vertexCount * 3),
      mask: new Float32Array(vertexCount),
      weld,
      groupPositions,
      spatial: new SpatialIndex(groupPositions, weld.groupCount, Math.max(weld.meanEdge * 2.5, diag / 128)),
      groupAdjacency,
      groupTriangles,
      triNormal,
      groupNormal,
      pendingGroups: new Set(),
      materialSlots: this.collectMaterials(mesh),
      morphTargets: this.collectMorphTargets(mesh),
      capabilities: new Set<MeshCapability>(),
      maxInfluences: 0,
      weightSumMaxError: 0,
    };
    if (record.skinned) record.capabilities.add('skinned');
    if (record.morphTargets.length) record.capabilities.add('morphs');
    if (record.hasUVs) record.capabilities.add('uvs');
    if (record.indexed) record.capabilities.add('indexed');
    this.measureSkinning(record);
    this.recomputeAllNormals(record);
    // Skinned meshes are not frustum culled: bounding spheres of bind-pose
    // geometry become stale as soon as bones move.
    if (record.skinned) mesh.frustumCulled = false;
    return record;
  }

  private collectMaterials(mesh: THREE.Mesh): MaterialSlot[] {
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    return list.map((mat, slot) => {
      const std = mat as THREE.MeshStandardMaterial;
      const hasColor = !!std.color;
      const colorHex = hasColor ? `#${std.color.getHexString()}` : '#ffffff';
      return {
        slot,
        material: std,
        name: mat.name || `Material_${slot}`,
        baseColorHex: colorHex,
        baseMetalness: std.metalness ?? 0,
        baseRoughness: std.roughness ?? 0.5,
        colorHex,
        metalness: std.metalness ?? 0,
        roughness: std.roughness ?? 0.5,
        overridden: false,
      };
    });
  }

  private collectMorphTargets(mesh: THREE.Mesh): MorphTargetRef[] {
    const dict = mesh.morphTargetDictionary;
    const influences = mesh.morphTargetInfluences;
    if (!dict || !influences) return [];
    return Object.entries(dict)
      .map(([name, index]) => ({ name, index, weight: influences[index] ?? 0 }))
      .sort((a, b) => a.index - b.index);
  }

  private measureSkinning(record: MeshRecord): void {
    const geometry = record.mesh.geometry;
    const joints = geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
    const weights = geometry.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
    if (!joints || !weights) return;
    let maxErr = 0;
    let maxInfluences = 0;
    for (let v = 0; v < record.vertexCount; v++) {
      let sum = 0;
      let used = 0;
      for (let k = 0; k < 4; k++) {
        const w = weights.getComponent(v, k);
        sum += w;
        if (w > 1e-6) used++;
      }
      maxErr = Math.max(maxErr, Math.abs(sum - 1));
      maxInfluences = Math.max(maxInfluences, used);
    }
    record.maxInfluences = maxInfluences;
    record.weightSumMaxError = maxErr;
  }

  getTarget(record: MeshRecord): SculptTarget {
    const existing = this.targeted.get(record.id);
    if (existing) return existing;
    const target: SculptTarget = {
      basePosition: record.basePosition,
      delta: record.delta,
      mask: record.mask,
      groupNormal: record.groupNormal,
      weld: record.weld,
      spatial: record.spatial,
      groupAdjacency: record.groupAdjacency,
      commit: (groups, count) => this.commitGroups(record, groups, count),
    };
    this.targeted.set(record.id, target);
    return target;
  }

  /** Write base+delta for the given groups and queue a local normal rebuild. */
  commitGroups(record: MeshRecord, groups: Uint32Array, count: number): void {
    const weld = record.weld;
    const pos = record.positionAttr.array as Float32Array;
    const base = record.basePosition;
    const delta = record.delta;
    for (let i = 0; i < count; i++) {
      const g = groups[i];
      const start = weld.groupStart[g];
      const end = weld.groupStart[g + 1];
      for (let k = start; k < end; k++) {
        const v = weld.groupList[k];
        pos[v * 3] = base[v * 3] + delta[v * 3];
        pos[v * 3 + 1] = base[v * 3 + 1] + delta[v * 3 + 1];
        pos[v * 3 + 2] = base[v * 3 + 2] + delta[v * 3 + 2];
      }
      record.pendingGroups.add(g);
      const rep = weld.groupList[start];
      record.groupPositions[g * 3] = pos[rep * 3];
      record.groupPositions[g * 3 + 1] = pos[rep * 3 + 1];
      record.groupPositions[g * 3 + 2] = pos[rep * 3 + 2];
    }
    record.positionAttr.needsUpdate = true;
    this.flushNormals(record);
  }

  /** Rebuild normals for exactly the triangles touching pending groups. */
  flushNormals(record?: MeshRecord): void {
    const records = record ? [record] : this.meshes;
    for (const rec of records) {
      if (!rec.pendingGroups.size) continue;
      const weld = rec.weld;
      const pos = rec.positionAttr.array as Float32Array;
      const normalAttr = rec.normalAttr;
      const idx = rec.indexed ? rec.mesh.geometry.getIndex()! : null;
      const triIndex = (t: number, corner: number) => (idx ? idx.getComponent(t, corner) : t * 3 + corner);
      const dirtyTris = new Set<number>();
      const dirtyGroups = new Set<number>();
      for (const g of rec.pendingGroups) {
        for (let i = rec.groupTriangles.start[g]; i < rec.groupTriangles.start[g + 1]; i++) {
          dirtyTris.add(rec.groupTriangles.list[i]);
        }
      }
      for (const t of dirtyTris) {
        const ia = triIndex(t, 0) * 3;
        const ib = triIndex(t, 1) * 3;
        const ic = triIndex(t, 2) * 3;
        const ux = pos[ib] - pos[ia];
        const uy = pos[ib + 1] - pos[ia + 1];
        const uz = pos[ib + 2] - pos[ia + 2];
        const vx = pos[ic] - pos[ia];
        const vy = pos[ic + 1] - pos[ia + 1];
        const vz = pos[ic + 2] - pos[ia + 2];
        rec.triNormal[t * 3] = uy * vz - uz * vy;
        rec.triNormal[t * 3 + 1] = uz * vx - ux * vz;
        rec.triNormal[t * 3 + 2] = ux * vy - uy * vx;
        for (let c = 0; c < 3; c++) dirtyGroups.add(weld.groupOf[triIndex(t, c)]);
      }
      for (const g of dirtyGroups) {
        let nx = 0;
        let ny = 0;
        let nz = 0;
        for (let i = rec.groupTriangles.start[g]; i < rec.groupTriangles.start[g + 1]; i++) {
          const t = rec.groupTriangles.list[i];
          nx += rec.triNormal[t * 3];
          ny += rec.triNormal[t * 3 + 1];
          nz += rec.triNormal[t * 3 + 2];
        }
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-12) {
          rec.groupNormal[g * 3] = nx / len;
          rec.groupNormal[g * 3 + 1] = ny / len;
          rec.groupNormal[g * 3 + 2] = nz / len;
        } else {
          rec.groupNormal[g * 3] = 0;
          rec.groupNormal[g * 3 + 1] = 1;
          rec.groupNormal[g * 3 + 2] = 0;
        }
      }
      if (normalAttr) {
        const normalArray = normalAttr.array as Float32Array;
        for (const g of dirtyGroups) {
          const gx = rec.groupNormal[g * 3];
          const gy = rec.groupNormal[g * 3 + 1];
          const gz = rec.groupNormal[g * 3 + 2];
          for (let k = weld.groupStart[g]; k < weld.groupStart[g + 1]; k++) {
            const v = weld.groupList[k];
            normalArray[v * 3] = gx;
            normalArray[v * 3 + 1] = gy;
            normalArray[v * 3 + 2] = gz;
          }
        }
        normalAttr.needsUpdate = true;
      }
      rec.pendingGroups.clear();
    }
  }

  private recomputeAllNormals(record: MeshRecord): void {
    const idx = record.indexed ? record.mesh.geometry.getIndex()! : null;
    const triCount = record.triangleCount;
    const pos = record.positionAttr.array as Float32Array;
    const triIndex = (t: number, corner: number) => (idx ? idx.getComponent(t, corner) : t * 3 + corner);
    for (let t = 0; t < triCount; t++) {
      const ia = triIndex(t, 0) * 3;
      const ib = triIndex(t, 1) * 3;
      const ic = triIndex(t, 2) * 3;
      const ux = pos[ib] - pos[ia];
      const uy = pos[ib + 1] - pos[ia + 1];
      const uz = pos[ib + 2] - pos[ia + 2];
      const vx = pos[ic] - pos[ia];
      const vy = pos[ic + 1] - pos[ia + 1];
      const vz = pos[ic + 2] - pos[ia + 2];
      record.triNormal[t * 3] = uy * vz - uz * vy;
      record.triNormal[t * 3 + 1] = uz * vx - ux * vz;
      record.triNormal[t * 3 + 2] = ux * vy - uy * vx;
    }
    const weld = record.weld;
    for (let g = 0; g < weld.groupCount; g++) {
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let i = record.groupTriangles.start[g]; i < record.groupTriangles.start[g + 1]; i++) {
        const t = record.groupTriangles.list[i];
        nx += record.triNormal[t * 3];
        ny += record.triNormal[t * 3 + 1];
        nz += record.triNormal[t * 3 + 2];
      }
      const len = Math.hypot(nx, ny, nz);
      if (len > 1e-12) {
        record.groupNormal[g * 3] = nx / len;
        record.groupNormal[g * 3 + 1] = ny / len;
        record.groupNormal[g * 3 + 2] = nz / len;
      } else {
        record.groupNormal[g * 3] = 0;
        record.groupNormal[g * 3 + 1] = 1;
        record.groupNormal[g * 3 + 2] = 0;
      }
    }
    if (record.normalAttr) {
      const normalArray = record.normalAttr.array as Float32Array;
      for (let g = 0; g < weld.groupCount; g++) {
        for (let k = weld.groupStart[g]; k < weld.groupStart[g + 1]; k++) {
          const v = weld.groupList[k];
          normalArray[v * 3] = record.groupNormal[g * 3];
          normalArray[v * 3 + 1] = record.groupNormal[g * 3 + 1];
          normalArray[v * 3 + 2] = record.groupNormal[g * 3 + 2];
        }
      }
      record.normalAttr.needsUpdate = true;
    }
  }

  /** Revert every sculpt delta and mask on a mesh (keeps the rig untouched). */
  resetSculpt(record: MeshRecord): void {
    record.delta.fill(0);
    record.mask.fill(0);
    const pos = record.positionAttr.array as Float32Array;
    pos.set(record.basePosition);
    record.positionAttr.needsUpdate = true;
    this.recomputeAllNormals(record);
    const weld = record.weld;
    for (let g = 0; g < weld.groupCount; g++) {
      const rep = weld.groupList[weld.groupStart[g]];
      record.groupPositions[g * 3] = record.basePosition[rep * 3];
      record.groupPositions[g * 3 + 1] = record.basePosition[rep * 3 + 1];
      record.groupPositions[g * 3 + 2] = record.basePosition[rep * 3 + 2];
    }
    record.spatial.rebuild();
    record.pendingGroups.clear();
  }

  resetAllSculpt(): void {
    for (const record of this.meshes) this.resetSculpt(record);
  }

  /** Public normal refresh (used after bulk delta application). */
  refreshAllNormals(): void {
    for (const record of this.meshes) {
      this.recomputeAllNormals(record);
      record.pendingGroups.clear();
    }
  }

  /**
   * Before/after comparison. `true` shows the imported source geometry,
   * `false` restores base + delta. Deltas are never discarded, so this is a
   * non-destructive view toggle rather than an undo.
   */
  setSourcePreview(on: boolean): void {
    for (const record of this.meshes) {
      const pos = record.positionAttr.array as Float32Array;
      if (on) {
        pos.set(record.basePosition);
        if (record.baseNormal && record.normalAttr) (record.normalAttr.array as Float32Array).set(record.baseNormal);
      } else {
        for (let v = 0; v < record.vertexCount; v++) {
          pos[v * 3] = record.basePosition[v * 3] + record.delta[v * 3];
          pos[v * 3 + 1] = record.basePosition[v * 3 + 1] + record.delta[v * 3 + 1];
          pos[v * 3 + 2] = record.basePosition[v * 3 + 2] + record.delta[v * 3 + 2];
        }
        this.recomputeAllNormals(record);
      }
      record.positionAttr.needsUpdate = true;
      if (record.normalAttr) record.normalAttr.needsUpdate = true;
    }
  }

  /** Rebuild group positions + spatial indexes from the live delta buffers. */
  refreshSpatialIndexes(): void {
    for (const record of this.meshes) {
      const weld = record.weld;
      for (let g = 0; g < weld.groupCount; g++) {
        const rep = weld.groupList[weld.groupStart[g]];
        record.groupPositions[g * 3] = record.basePosition[rep * 3] + record.delta[rep * 3];
        record.groupPositions[g * 3 + 1] = record.basePosition[rep * 3 + 1] + record.delta[rep * 3 + 1];
        record.groupPositions[g * 3 + 2] = record.basePosition[rep * 3 + 2] + record.delta[rep * 3 + 2];
      }
      record.spatial.rebuild();
    }
  }

  /** Percentage of vertices covered by the freeze mask (for the HUD). */
  maskCoverage(): number {
    let masked = 0;
    let total = 0;
    for (const record of this.meshes) {
      total += record.vertexCount;
      for (let v = 0; v < record.vertexCount; v++) if (record.mask[v] > 0.02) masked++;
    }
    return total ? masked / total : 0;
  }

  /** Restore the imported normal buffer exactly (used by tests and "reset normals"). */
  restoreBaseNormals(record: MeshRecord): void {
    if (!record.baseNormal || !record.normalAttr) return;
    (record.normalAttr.array as Float32Array).set(record.baseNormal);
    record.normalAttr.needsUpdate = true;
  }

  setMorphWeight(record: MeshRecord, targetName: string, value: number): void {
    const mesh = record.mesh as THREE.Mesh;
    const dict = mesh.morphTargetDictionary;
    if (!dict || !mesh.morphTargetInfluences) return;
    const index = dict[targetName];
    if (index === undefined) return;
    mesh.morphTargetInfluences[index] = value;
    const ref = record.morphTargets.find((m) => m.name === targetName);
    if (ref) ref.weight = value;
  }

  getMorphWeight(record: MeshRecord, targetName: string): number {
    const mesh = record.mesh as THREE.Mesh;
    const index = mesh.morphTargetDictionary?.[targetName];
    if (index === undefined || !mesh.morphTargetInfluences) return 0;
    return mesh.morphTargetInfluences[index];
  }

  setMaterialOverride(slotRef: MaterialSlot, patch: { colorHex?: string; metalness?: number; roughness?: number }): void {
    if (patch.colorHex !== undefined) {
      slotRef.material.color.set(patch.colorHex);
      slotRef.colorHex = patch.colorHex;
    }
    if (patch.metalness !== undefined) {
      slotRef.material.metalness = patch.metalness;
      slotRef.metalness = patch.metalness;
    }
    if (patch.roughness !== undefined) {
      slotRef.material.roughness = patch.roughness;
      slotRef.roughness = patch.roughness;
    }
    slotRef.overridden =
      slotRef.colorHex !== slotRef.baseColorHex ||
      slotRef.metalness !== slotRef.baseMetalness ||
      slotRef.roughness !== slotRef.baseRoughness;
    slotRef.material.needsUpdate = true;
  }

  resetMaterial(slotRef: MaterialSlot): void {
    this.setMaterialOverride(slotRef, {
      colorHex: slotRef.baseColorHex,
      metalness: slotRef.baseMetalness,
      roughness: slotRef.baseRoughness,
    });
    slotRef.overridden = false;
  }

  // ---- animation -----------------------------------------------------------

  playClip(name: string | null): void {
    if (!this.mixer) return;
    for (const clip of this.clips) {
      const action = this.mixer.clipAction(clip);
      if (clip.name === name) {
        action.reset();
        action.enabled = true;
        action.setEffectiveWeight(1);
        action.play();
      } else {
        action.stop();
      }
    }
    this.activeClip = name;
  }

  setClipTime(time: number): void {
    if (!this.mixer || !this.activeClip) return;
    this.mixer.setTime(Math.max(0, time));
    this.root.updateMatrixWorld(true);
  }

  advance(dt: number): void {
    if (!this.mixer || !this.activeClip) return;
    this.mixer.update(dt);
    this.root.updateMatrixWorld(true);
  }

  bindPose(): void {
    if (this.mixer) this.mixer.stopAllAction();
    this.activeClip = null;
    for (const [bone, trs] of this.bindTransforms) {
      bone.position.copy(trs.position);
      bone.quaternion.copy(trs.quaternion);
      bone.scale.copy(trs.scale);
    }
    this.root.updateMatrixWorld(true);
    this.skeleton?.update();
  }

  // ---- housekeeping --------------------------------------------------------

  countStats(): {
    meshes: number;
    vertices: number;
    triangles: number;
    bones: number;
    clips: number;
    morphTargets: number;
    materials: number;
    skinnedMeshes: number;
    weldedVertices: number;
  } {
    let vertices = 0;
    let triangles = 0;
    let morphTargets = 0;
    let materials = 0;
    let skinnedMeshes = 0;
    let weldedVertices = 0;
    for (const rec of this.meshes) {
      vertices += rec.vertexCount;
      triangles += rec.triangleCount;
      morphTargets += rec.morphTargets.length;
      materials += rec.materialSlots.length;
      if (rec.skinned) skinnedMeshes++;
      weldedVertices += rec.weld.weldedVertices;
    }
    return {
      meshes: this.meshes.length,
      vertices,
      triangles,
      bones: this.bones.length,
      clips: this.clips.length,
      morphTargets,
      materials,
      skinnedMeshes,
      weldedVertices,
    };
  }

  hashSkinAttributes(): { joints: string; weights: string } | null {
    const rec = this.meshes.find((m) => m.skinned);
    if (!rec) return null;
    const geometry = rec.mesh.geometry;
    const joints = geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
    const weights = geometry.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
    if (!joints || !weights) return null;
    return {
      joints: hashArray(canonicalUint16(joints)),
      weights: hashArray(canonicalFloat32(weights)),
    };
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    for (const attachment of this.attachments) {
      attachment.root.removeFromParent();
      disposeObject(attachment.root);
    }
    this.attachments = [];
    for (const rec of this.meshes) {
      rec.mesh.removeFromParent();
      (rec.mesh as THREE.SkinnedMesh).skeleton?.dispose();
      rec.mesh.geometry.dispose();
      const mats = Array.isArray(rec.mesh.material) ? rec.mesh.material : [rec.mesh.material];
      for (const mat of mats) disposeMaterial(mat);
    }
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.mixer?.uncacheRoot(this.root);
    this.root.removeFromParent();
    this.meshes.length = 0;
    this.bones.length = 0;
  }

  moveTo(scene: THREE.Object3D): void {
    scene.add(this.root);
  }
}

export interface CharacterMeta {
  sourceKind: 'fixture' | 'import' | 'example';
  fixtureId?: string;
  catalogId?: string;
  fileName?: string;
  byteLength?: number;
  fileHash?: string;
  skeletonFamily?: string;
  license?: string;
  provenance?: string;
  glbBytes?: ArrayBuffer;
}

function buildSequentialIndex(vertexCount: number): Uint32Array {
  const idx = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) idx[i] = i;
  return idx;
}

function canonicalUint16(attr: THREE.BufferAttribute): Uint16Array {
  const out = new Uint16Array(attr.count * 4);
  for (let i = 0; i < attr.count; i++) {
    for (let k = 0; k < 4; k++) out[i * 4 + k] = attr.getComponent(i, k);
  }
  return out;
}

function canonicalFloat32(attr: THREE.BufferAttribute): Float32Array {
  const out = new Float32Array(attr.count * 4);
  for (let i = 0; i < attr.count; i++) {
    for (let k = 0; k < 4; k++) out[i * 4 + k] = attr.getComponent(i, k);
  }
  return out;
}

export function disposeMaterial(mat: THREE.Material): void {
  for (const key of Object.keys(mat) as (keyof THREE.Material)[]) {
    const value = (mat as unknown as Record<string, unknown>)[key as string];
    if (value && typeof value === 'object' && (value as THREE.Texture).isTexture) {
      (value as THREE.Texture).dispose();
    }
  }
  mat.dispose();
}

export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) if (m) disposeMaterial(m);
    }
    const skinned = child as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh) skinned.skeleton?.dispose();
  });
}
