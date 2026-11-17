import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import {
  buildSculptMesh,
  hashBytes,
  maxPositionDelta,
  recomputeAllNormals,
  recomputeNormalsFor,
  type SculptMesh
} from './topology';
import { StrokeEngine } from './brushes';
import type { HistoryEntry } from './history';

export interface SourceMeshSnapshot {
  meshName: string;
  renderVertexCount: number;
  uniqueVertexCount: number;
  triangleCount: number;
  sourcePos: Float32Array;
  sourceNrm: Float32Array;
  hasUV: boolean;
  uvHash: string | null;
  hasSkinning: boolean;
  skinIndexHash: string | null;
  skinWeightHash: string | null;
  boneCount: number;
  boneNames: string[];
  morphTargetNames: string[];
}

export interface SparseSculptDelta {
  meshName: string;
  vertexCount: number;
  /** Render-space vertex indices with non-zero displacement */
  indices: number[];
  /** Flat [dx, dy, dz, ...] matching indices */
  deltas: number[];
}

export interface BvhMetrics {
  builds: number;
  refits: number;
  lastBuildMs: number;
  lastRefitMs: number;
}

/**
 * Ensures Three.js BufferGeometry has `morphTargetsRelative = true` so base position
 * sculpting composes additively with morph targets and exports cleanly to glTF 2.0.
 */
export function normalizeMorphTargetsRelative(geometry: THREE.BufferGeometry): void {
  const posMorphs = geometry.morphAttributes?.position;
  if (!posMorphs || posMorphs.length === 0) return;
  if (geometry.morphTargetsRelative) return;

  const basePos = geometry.getAttribute('position');
  if (!basePos) return;
  for (const attr of posMorphs) {
    const arr = attr.array as Float32Array;
    for (let i = 0; i < basePos.count; i++) {
      arr[i * 3] -= basePos.getX(i);
      arr[i * 3 + 1] -= basePos.getY(i);
      arr[i * 3 + 2] -= basePos.getZ(i);
    }
    attr.needsUpdate = true;
  }
  geometry.morphTargetsRelative = true;
}

/**
 * Expands interleaved or non-Float32 `position`/`normal` attributes in-place
 * WITHOUT touching `index`, `uv`, `skinIndex`, `skinWeight`, `color`, or `morphAttributes`.
 */
export function ensureEditableVertexBuffers(geometry: THREE.BufferGeometry): void {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr) throw new Error('Mesh geometry has no POSITION attribute');

  if (
    !(posAttr instanceof THREE.BufferAttribute) ||
    (posAttr as any).isInterleavedBufferAttribute ||
    !(posAttr.array instanceof Float32Array)
  ) {
    const P = new Float32Array(posAttr.count * 3);
    for (let i = 0; i < posAttr.count; i++) {
      P[i * 3] = posAttr.getX(i);
      P[i * 3 + 1] = posAttr.getY(i);
      P[i * 3 + 2] = posAttr.getZ(i);
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(P, 3));
  }

  const nrmAttr = geometry.getAttribute('normal');
  if (
    !nrmAttr ||
    !(nrmAttr instanceof THREE.BufferAttribute) ||
    (nrmAttr as any).isInterleavedBufferAttribute ||
    !(nrmAttr.array instanceof Float32Array)
  ) {
    const N = new Float32Array(posAttr.count * 3);
    if (nrmAttr) {
      for (let i = 0; i < nrmAttr.count; i++) {
        N[i * 3] = nrmAttr.getX(i);
        N[i * 3 + 1] = nrmAttr.getY(i);
        N[i * 3 + 2] = nrmAttr.getZ(i);
      }
      geometry.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    } else {
      geometry.setAttribute('normal', new THREE.BufferAttribute(N, 3));
      geometry.computeVertexNormals();
    }
  }

  normalizeMorphTargetsRelative(geometry);
}

/** Vertices are weld-compatible only when every non-position attribute, morph
 * attribute and material-group membership matches exactly. Splitting a UV seam
 * can leave a visible gap under sculpting; this is preferable to silently forcing
 * unrelated skin/morph/material vertices to share one displacement. */
export function vertexCompatibilityKeys(g: THREE.BufferGeometry): string[] {
  const position = g.getAttribute('position');
  const count = position.count;
  const attributes = Object.entries(g.attributes).filter(([name]) => name !== 'position' && name !== 'sculptMask').sort(([a], [b]) => a.localeCompare(b));
  const morphs = Object.entries(g.morphAttributes).sort(([a], [b]) => a.localeCompare(b));
  const memberships: number[][] = Array.from({ length: count }, () => []);
  const index = g.getIndex();
  for (let groupIndex = 0; groupIndex < g.groups.length; groupIndex++) {
    const group = g.groups[groupIndex];
    const end = Math.min(group.start + group.count, index?.count ?? count);
    for (let i = group.start; i < end; i++) {
      const v = index ? index.getX(i) : i;
      if (v >= 0 && v < count && !memberships[v].includes(groupIndex)) memberships[v].push(groupIndex);
    }
  }
  const values = (attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, v: number) => {
    if (attr.count !== count) throw new Error('Attribute vertex count mismatch');
    return Array.from({length: attr.itemSize}, (_, c) => attr.getComponent(v, c));
  };
  return Array.from({length: count}, (_, v) => JSON.stringify([
    memberships[v], attributes.map(([name, attr]) => [name, values(attr, v)]),
    morphs.map(([name, attrs]) => [name, attrs.map(attr => values(attr, v))])
  ]));
}

/** Mark unique-space vertices whose coincident render copies were separated by protected attributes. */
function markSplitPositionVertices(renderPos: Float32Array, mesh: SculptMesh, weldRel = 1e-6): Uint8Array {
  const renderCount = Math.floor(renderPos.length / 3);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < renderCount; i++) {
    const x = renderPos[i * 3], y = renderPos[i * 3 + 1], z = renderPos[i * 3 + 2];
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const inv = 1 / Math.max(diag * weldRel, 1e-8);
  const firstByPosition = new Map<string, number>();
  const split = new Uint8Array(mesh.vertCount);
  for (let r = 0; r < renderCount; r++) {
    const key = JSON.stringify([
      Math.round(renderPos[r * 3] * inv),
      Math.round(renderPos[r * 3 + 1] * inv),
      Math.round(renderPos[r * 3 + 2] * inv)
    ]);
    const u = mesh.renderToUniq[r];
    const first = firstByPosition.get(key);
    if (first === undefined) firstByPosition.set(key, u);
    else if (first !== u) { split[first] = 1; split[u] = 1; }
  }
  return split;
}

export const SPLIT_SEAM_STROKE_WARNING =
  'This brush footprint overlaps coincident render vertices split by protected attributes. The stroke was canceled to avoid opening a seam; move away from the boundary. Mask painting remains available.';

/**
 * Rig-safe sculpt controller for a single Mesh or SkinnedMesh.
 * Operates in welded unique-vertex space (`SculptMesh`) and writes changes
 * in-place to the existing `position` and `normal` attributes, leaving topology,
 * vertex count, UVs, skin weights, skeleton bindings, and morph targets intact.
 */
export class RigSafeSculptTarget {
  readonly mesh: SculptMesh;
  readonly engine: StrokeEngine;
  readonly snapshot: SourceMeshSnapshot;
  readonly bvh: BvhMetrics = { builds: 0, refits: 0, lastBuildMs: 0, lastRefitMs: 0 };

  private dirty = false;
  private strokeDisp = 0;
  private refitsSinceBuild = 0;
  private maskAttr: THREE.BufferAttribute;
  private origUniqPos: Float32Array;
  private splitPositionVertices: Uint8Array;
  private splitPositionScratch: Uint32Array;
  private splitPositionVertexCount = 0;
  private previewPausedSavedPos: Float32Array | null = null;
  private previewPausedSavedNrm: Float32Array | null = null;

  constructor(public readonly object: THREE.Mesh) {
    const g = object.geometry;
    ensureEditableVertexBuffers(g);

    const posAttr = g.getAttribute('position') as THREE.BufferAttribute;
    const nrmAttr = g.getAttribute('normal') as THREE.BufferAttribute;
    const pos = posAttr.array as Float32Array;
    const nrm = nrmAttr.array as Float32Array;
    const idx = g.getIndex()?.array ?? null;

    const isSkinned = (object as THREE.SkinnedMesh).isSkinnedMesh === true;
    const skinned = object as THREE.SkinnedMesh;
    const skinIdx = g.getAttribute('skinIndex');
    const skinWgt = g.getAttribute('skinWeight');
    const uv = g.getAttribute('uv');

    const compatibilityKeys = vertexCompatibilityKeys(g);
    this.mesh = buildSculptMesh(pos, idx, 1e-6, i => compatibilityKeys[i]);
    this.splitPositionVertices = markSplitPositionVertices(pos, this.mesh);
    this.splitPositionScratch = new Uint32Array(this.mesh.vertCount);
    for (const flag of this.splitPositionVertices) this.splitPositionVertexCount += flag;
    this.origUniqPos = new Float32Array(this.mesh.pos);
    // Keep original normals in snapshot, but ensure SculptMesh has normalized normals
    const sourcePos = new Float32Array(pos);
    const sourceNrm = new Float32Array(nrm);

    const morphNames = object.morphTargetDictionary
      ? Object.entries(object.morphTargetDictionary)
          .sort((a, b) => a[1] - b[1])
          .map(([name]) => name)
      : (g.morphAttributes?.position ?? []).map((a, i) => a.name || `morph_${i}`);

    this.snapshot = {
      meshName: object.name || 'CharacterMesh',
      renderVertexCount: posAttr.count,
      uniqueVertexCount: this.mesh.vertCount,
      triangleCount: this.mesh.triCount,
      sourcePos,
      sourceNrm,
      hasUV: !!uv,
      uvHash: uv && uv.array ? hashBytes(uv.array as ArrayBufferView) : null,
      hasSkinning: isSkinned && !!skinIdx && !!skinWgt && !!skinned.skeleton,
      skinIndexHash: skinIdx && skinIdx.array ? hashBytes(skinIdx.array as ArrayBufferView) : null,
      skinWeightHash: skinWgt && skinWgt.array ? hashBytes(skinWgt.array as ArrayBufferView) : null,
      boneCount: isSkinned && skinned.skeleton ? skinned.skeleton.bones.length : 0,
      boneNames: isSkinned && skinned.skeleton ? skinned.skeleton.bones.map((b) => b.name) : [],
      morphTargetNames: morphNames
    };

    this.maskAttr = new THREE.BufferAttribute(new Float32Array(posAttr.count), 1);
    g.setAttribute('sculptMask', this.maskAttr);
    this.syncMaskBuffer();

    this.engine = new StrokeEngine(this.mesh);
    this.rebuildBvh();
  }

  get geometry(): THREE.BufferGeometry {
    return this.object.geometry;
  }

  get isSkinned(): boolean {
    return this.snapshot.hasSkinning;
  }

  get hasSplitProtectedVertices(): boolean {
    return this.splitPositionVertexCount > 0;
  }

  /**
   * Fail closed for geometry-displacing strokes whose brush footprint touches a
   * coincident position split by protected attributes. Mask painting is exempt
   * at the caller because it does not move geometry.
   */
  isGeometryStrokeSafeAt(
    point: [number, number, number],
    radius: number,
    symmetry: { x: boolean; y: boolean; z: boolean }
  ): boolean {
    if (!Number.isFinite(radius) || radius <= 0) return false;
    if (!this.splitPositionVertexCount) return true;
    const centers: [number, number, number][] = [[point[0], point[1], point[2]]];
    if (symmetry.x) for (const c of [...centers]) centers.push([-c[0], c[1], c[2]]);
    if (symmetry.y) for (const c of [...centers]) centers.push([c[0], -c[1], c[2]]);
    if (symmetry.z) for (const c of [...centers]) centers.push([c[0], c[1], -c[2]]);
    for (const c of centers) {
      const n = this.engine.grid.query(c[0], c[1], c[2], radius, this.splitPositionScratch);
      for (let i = 0; i < n; i++) if (this.splitPositionVertices[this.splitPositionScratch[i]]) return false;
    }
    return true;
  }

  rebuildBvh(): void {
    const t0 = performance.now();
    const g = this.geometry as THREE.BufferGeometry & {
      boundsTree?: ReturnType<typeof computeBoundsTree>;
      computeBoundsTree?: typeof computeBoundsTree;
      disposeBoundsTree?: typeof disposeBoundsTree;
    };
    if (!g.computeBoundsTree) g.computeBoundsTree = computeBoundsTree;
    if (!g.disposeBoundsTree) g.disposeBoundsTree = disposeBoundsTree;
    if (g.boundsTree) g.disposeBoundsTree();
    g.boundsTree = computeBoundsTree.call(g, { setBoundingBox: true });
    this.bvh.lastBuildMs = performance.now() - t0;
    this.bvh.builds++;
    this.refitsSinceBuild = 0;
    this.dirty = false;
    g.computeBoundingSphere();
    g.computeBoundingBox();
  }

  maintainBvh(): void {
    if (!this.dirty) return;
    const t0 = performance.now();
    const g = this.geometry as THREE.BufferGeometry & { boundsTree?: { refit: () => void } };
    g.boundsTree?.refit();
    this.bvh.lastRefitMs = performance.now() - t0;
    this.bvh.refits++;
    this.refitsSinceBuild++;
    this.dirty = false;
  }

  endStrokeMaintenance(): void {
    this.maintainBvh();
    const r = this.geometry.boundingSphere?.radius ?? 1;
    if (this.strokeDisp > r * 0.15 || this.refitsSinceBuild > 400) {
      this.rebuildBvh();
    } else {
      this.geometry.computeBoundingSphere();
      this.geometry.computeBoundingBox();
    }
    this.strokeDisp = 0;
  }

  /** Push changed unique vertices to render buffers (positions, normals, mask) in-place using exact delta from source. */
  applyChangedVertices(ids: ArrayLike<number>, count = ids.length): void {
    if (!count) return;
    const posAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const nrmAttr = this.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const posArr = posAttr.array as Float32Array;
    const nrmArr = nrmAttr.array as Float32Array;

    const nrmVerts = recomputeNormalsFor(this.mesh, ids, count);
    this.syncPositionsFor(ids, count, posArr);
    this.syncNormalsFor(nrmVerts, nrmVerts.length, nrmArr);
    this.syncMaskFor(ids, count);

    posAttr.needsUpdate = true;
    nrmAttr.needsUpdate = true;
    this.maskAttr.needsUpdate = true;
    this.dirty = true;
    this.strokeDisp += this.mesh.meanEdge * 0.1;
  }

  private syncPositionsFor(ids: ArrayLike<number>, count: number, posArr: Float32Array): void {
    const m = this.mesh;
    const src = this.snapshot.sourcePos;
    const orig = this.origUniqPos;
    for (let i = 0; i < count; i++) {
      const v = ids[i];
      const dx = m.pos[v * 3] - orig[v * 3];
      const dy = m.pos[v * 3 + 1] - orig[v * 3 + 1];
      const dz = m.pos[v * 3 + 2] - orig[v * 3 + 2];
      for (let j = m.uniqRenderStart[v]; j < m.uniqRenderStart[v + 1]; j++) {
        const r = m.uniqRenderList[j];
        posArr[r * 3] = dx === 0 ? src[r * 3] : src[r * 3] + dx;
        posArr[r * 3 + 1] = dy === 0 ? src[r * 3 + 1] : src[r * 3 + 1] + dy;
        posArr[r * 3 + 2] = dz === 0 ? src[r * 3 + 2] : src[r * 3 + 2] + dz;
      }
    }
  }

  private syncNormalsFor(ids: ArrayLike<number>, count: number, nrmArr: Float32Array): void {
    const m = this.mesh;
    const src = this.snapshot.sourcePos;
    const srcN = this.snapshot.sourceNrm;
    const orig = this.origUniqPos;
    for (let i = 0; i < count; i++) {
      const v = ids[i];
      const moved =
        m.pos[v * 3] !== orig[v * 3] ||
        m.pos[v * 3 + 1] !== orig[v * 3 + 1] ||
        m.pos[v * 3 + 2] !== orig[v * 3 + 2];
      const nx = m.nrm[v * 3];
      const ny = m.nrm[v * 3 + 1];
      const nz = m.nrm[v * 3 + 2];
      for (let j = m.uniqRenderStart[v]; j < m.uniqRenderStart[v + 1]; j++) {
        const r = m.uniqRenderList[j];
        if (!moved && src.length === nrmArr.length) {
          nrmArr[r * 3] = srcN[r * 3];
          nrmArr[r * 3 + 1] = srcN[r * 3 + 1];
          nrmArr[r * 3 + 2] = srcN[r * 3 + 2];
        } else {
          nrmArr[r * 3] = nx;
          nrmArr[r * 3 + 1] = ny;
          nrmArr[r * 3 + 2] = nz;
        }
      }
    }
  }

  /**
   * Project absolute composed render-space positions (length `renderCount * 3`,
   * e.g. from deterministic DNA layer composition) into the live buffers. The
   * welded unique-space positions are rebuilt from the projected render values so
   * later strokes continue from the exact composed state. Protected attributes
   * (UVs, skin weights, morphs, materials) are never touched.
   */
  projectRenderPositions(renderPos: Float32Array): void {
    if (renderPos.length !== this.snapshot.renderVertexCount * 3) {
      throw new Error('Composed position size mismatch');
    }
    const posAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const nrmAttr = this.geometry.getAttribute('normal') as THREE.BufferAttribute;
    (posAttr.array as Float32Array).set(renderPos);
    for (let r = 0; r < this.mesh.renderCount; r++) {
      const u = this.mesh.renderToUniq[r];
      this.mesh.pos[u * 3] = renderPos[r * 3];
      this.mesh.pos[u * 3 + 1] = renderPos[r * 3 + 1];
      this.mesh.pos[u * 3 + 2] = renderPos[r * 3 + 2];
    }
    recomputeAllNormals(this.mesh);
    const nrmArr = nrmAttr.array as Float32Array;
    for (let r = 0; r < this.mesh.renderCount; r++) {
      const u = this.mesh.renderToUniq[r];
      nrmArr[r * 3] = this.mesh.nrm[u * 3];
      nrmArr[r * 3 + 1] = this.mesh.nrm[u * 3 + 1];
      nrmArr[r * 3 + 2] = this.mesh.nrm[u * 3 + 2];
    }
    this.syncMaskBuffer();
    posAttr.needsUpdate = true;
    nrmAttr.needsUpdate = true;
    this.maskAttr.needsUpdate = true;
    this.engine.grid.rebuild();
    this.rebuildBvh();
    this.dirty = false;
    this.geometry.computeBoundingSphere();
    this.geometry.computeBoundingBox();
  }

  /** Refresh entire render buffer from current SculptMesh state. */
  syncAll(): void {
    const posAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const nrmAttr = this.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const posArr = posAttr.array as Float32Array;
    const nrmArr = nrmAttr.array as Float32Array;
    recomputeAllNormals(this.mesh);
    const allIds = new Uint32Array(this.mesh.vertCount);
    for (let i = 0; i < this.mesh.vertCount; i++) allIds[i] = i;
    this.syncPositionsFor(allIds, allIds.length, posArr);
    this.syncNormalsFor(allIds, allIds.length, nrmArr);
    this.syncMaskBuffer();
    posAttr.needsUpdate = true;
    nrmAttr.needsUpdate = true;
    this.maskAttr.needsUpdate = true;
    this.rebuildBvh();
  }

  private syncMaskFor(ids: ArrayLike<number>, count: number): void {
    const maskArr = this.maskAttr.array as Float32Array;
    const m = this.mesh;
    for (let i = 0; i < count; i++) {
      const v = ids[i];
      const val = m.mask[v];
      for (let j = m.uniqRenderStart[v]; j < m.uniqRenderStart[v + 1]; j++) {
        maskArr[m.uniqRenderList[j]] = val;
      }
    }
  }

  private syncMaskBuffer(): void {
    const maskArr = this.maskAttr.array as Float32Array;
    const m = this.mesh;
    for (let r = 0; r < m.renderCount; r++) {
      maskArr[r] = m.mask[m.renderToUniq[r]];
    }
  }

  /** Computes max Euclidean displacement from original imported source positions. */
  getMaxDisplacement(): number {
    const posArr = this.geometry.getAttribute('position').array as Float32Array;
    return maxPositionDelta(posArr, this.snapshot.sourcePos);
  }

  getModifiedVertexCount(eps = 1e-6): number {
    const posArr = this.geometry.getAttribute('position').array as Float32Array;
    const src = this.snapshot.sourcePos;
    let count = 0;
    for (let i = 0; i < posArr.length; i += 3) {
      if (
        Math.abs(posArr[i] - src[i]) > eps ||
        Math.abs(posArr[i + 1] - src[i + 1]) > eps ||
        Math.abs(posArr[i + 2] - src[i + 2]) > eps
      ) {
        count++;
      }
    }
    return count;
  }

  /** Extract sparse render-vertex deltas relative to sourcePos for recipe persistence. */
  exportSparseDeltas(eps = 1e-6): SparseSculptDelta {
    const posArr = this.geometry.getAttribute('position').array as Float32Array;
    const src = this.snapshot.sourcePos;
    const indices: number[] = [];
    const deltas: number[] = [];
    for (let i = 0; i < this.snapshot.renderVertexCount; i++) {
      const dx = posArr[i * 3] - src[i * 3];
      const dy = posArr[i * 3 + 1] - src[i * 3 + 1];
      const dz = posArr[i * 3 + 2] - src[i * 3 + 2];
      if (Math.abs(dx) > eps || Math.abs(dy) > eps || Math.abs(dz) > eps) {
        indices.push(i);
        deltas.push(dx, dy, dz);
      }
    }
    return {
      meshName: this.snapshot.meshName,
      vertexCount: this.snapshot.renderVertexCount,
      indices,
      deltas
    };
  }

  /** Apply sparse deltas from a saved Character Recipe onto the source base geometry. */
  applySparseDeltas(delta: SparseSculptDelta): void {
    if (delta.vertexCount !== this.snapshot.renderVertexCount) {
      throw new Error(
        `Vertex count mismatch for ${this.snapshot.meshName}: recipe expects ${delta.vertexCount}, mesh has ${this.snapshot.renderVertexCount}`
      );
    }
    if (delta.deltas.length !== delta.indices.length * 3) throw new Error('Malformed sculpt delta');
    const seen = new Set<number>();
    for (const index of delta.indices) {
      if (!Number.isInteger(index) || index < 0 || index >= delta.vertexCount || seen.has(index)) throw new Error('Invalid sculpt vertex index');
      seen.add(index);
    }
    if (!delta.deltas.every(Number.isFinite)) throw new Error('Invalid sculpt delta value');
    const posAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const posArr = posAttr.array as Float32Array;
    posArr.set(this.snapshot.sourcePos);

    for (let k = 0; k < delta.indices.length; k++) {
      const idx = delta.indices[k];
      if (idx < 0 || idx >= this.snapshot.renderVertexCount) continue;
      posArr[idx * 3] += delta.deltas[k * 3];
      posArr[idx * 3 + 1] += delta.deltas[k * 3 + 1];
      posArr[idx * 3 + 2] += delta.deltas[k * 3 + 2];
    }

    // Update SculptMesh unique positions from render positions
    for (let r = 0; r < this.mesh.renderCount; r++) {
      const u = this.mesh.renderToUniq[r];
      this.mesh.pos[u * 3] = posArr[r * 3];
      this.mesh.pos[u * 3 + 1] = posArr[r * 3 + 1];
      this.mesh.pos[u * 3 + 2] = posArr[r * 3 + 2];
    }

    if (delta.indices.length === 0) {
      const nrmAttr = this.geometry.getAttribute('normal') as THREE.BufferAttribute;
      (nrmAttr.array as Float32Array).set(this.snapshot.sourceNrm);
      nrmAttr.needsUpdate = true;
      posAttr.needsUpdate = true;
      recomputeAllNormals(this.mesh);
      this.rebuildBvh();
    } else {
      this.syncAll();
    }
    this.engine.grid.rebuild();
  }

  /** Temporarily display original un-sculpted source (t=0) vs sculpted (t=1) for Before/After inspection. */
  setBeforeAfterPreview(showOriginal: boolean): void {
    const posAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const nrmAttr = this.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const posArr = posAttr.array as Float32Array;
    const nrmArr = nrmAttr.array as Float32Array;

    if (showOriginal) {
      if (!this.previewPausedSavedPos) {
        this.previewPausedSavedPos = new Float32Array(posArr);
        this.previewPausedSavedNrm = new Float32Array(nrmArr);
        posArr.set(this.snapshot.sourcePos);
        nrmArr.set(this.snapshot.sourceNrm);
        posAttr.needsUpdate = true;
        nrmAttr.needsUpdate = true;
      }
    } else if (this.previewPausedSavedPos && this.previewPausedSavedNrm) {
      posArr.set(this.previewPausedSavedPos);
      nrmArr.set(this.previewPausedSavedNrm);
      this.previewPausedSavedPos = null;
      this.previewPausedSavedNrm = null;
      posAttr.needsUpdate = true;
      nrmAttr.needsUpdate = true;
    }
  }

  /** Create a reversible history entry that resets all sculpt deltas on this mesh. */
  createResetSculptEntry(): HistoryEntry | null {
    this.setBeforeAfterPreview(false);
    if (this.getMaxDisplacement() <= 1e-7) return null;
    const beforeUniquePos = new Float32Array(this.mesh.pos);
    const beforeRenderNrm = new Float32Array(
      (this.geometry.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array
    );
    const beforeMask = new Float32Array(this.mesh.mask);

    const applyState = (useSource: boolean) => {
      const posAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
      const nrmAttr = this.geometry.getAttribute('normal') as THREE.BufferAttribute;
      const posArr = posAttr.array as Float32Array;
      const nrmArr = nrmAttr.array as Float32Array;
      if (useSource) {
        posArr.set(this.snapshot.sourcePos);
        nrmArr.set(this.snapshot.sourceNrm);
        for (let r = 0; r < this.mesh.renderCount; r++) {
          const u = this.mesh.renderToUniq[r];
          this.mesh.pos[u * 3] = posArr[r * 3];
          this.mesh.pos[u * 3 + 1] = posArr[r * 3 + 1];
          this.mesh.pos[u * 3 + 2] = posArr[r * 3 + 2];
        }
        recomputeAllNormals(this.mesh);
      } else {
        this.mesh.pos.set(beforeUniquePos);
        this.mesh.mask.set(beforeMask);
        const allIds = new Uint32Array(this.mesh.vertCount);
        for (let i = 0; i < this.mesh.vertCount; i++) allIds[i] = i;
        this.syncPositionsFor(allIds, allIds.length, posArr);
        nrmArr.set(beforeRenderNrm);
      }
      this.syncMaskBuffer();
      posAttr.needsUpdate = true;
      nrmAttr.needsUpdate = true;
      this.maskAttr.needsUpdate = true;
      this.engine.grid.rebuild();
      this.rebuildBvh();
    };

    applyState(true);
    return {
      label: `Reset sculpt (${this.snapshot.meshName})`,
      bytes: beforeUniquePos.byteLength + beforeRenderNrm.byteLength + beforeMask.byteLength,
      undo: () => applyState(false),
      redo: () => applyState(true)
    };
  }

  /** Clear or invert vertex freeze mask with an undoable history entry. */
  createMaskEditEntry(mode: 'clear' | 'invert'): HistoryEntry | null {
    const before = new Float32Array(this.mesh.mask);
    const after = new Float32Array(this.mesh.vertCount);
    let changed = false;
    for (let i = 0; i < this.mesh.vertCount; i++) {
      after[i] = mode === 'clear' ? 0 : 1 - before[i];
      if (after[i] !== before[i]) changed = true;
    }
    if (!changed) return null;
    const write = (src: Float32Array) => {
      this.mesh.mask.set(src);
      this.syncMaskBuffer();
      this.maskAttr.needsUpdate = true;
    };
    write(after);
    return {
      label: mode === 'clear' ? 'Clear Mask' : 'Invert Mask',
      bytes: before.byteLength + after.byteLength,
      undo: () => write(before),
      redo: () => write(after)
    };
  }

  dispose(): void {
    const g = this.geometry as THREE.BufferGeometry & {
      boundsTree?: unknown;
      disposeBoundsTree?: () => void;
    };
    if (g.boundsTree && g.disposeBoundsTree) {
      g.disposeBoundsTree();
    }
    if (g.getAttribute('sculptMask')) {
      g.deleteAttribute('sculptMask');
    }
  }
}
