/**
 * Rig-safe sculpt engine.
 *
 * Every brush writes to a *position-delta buffer* that lives beside the imported
 * geometry. The original positions (`basePosition`), indices, JOINTS_0,
 * WEIGHTS_0, inverse bind matrices, morph target deltas, UVs and material groups
 * are never modified. Live positions are always `base + delta`, recomputed for
 * exactly the touched vertices, so:
 *
 *   - skinning keeps working (the shader deforms the same vertex indices),
 *   - morph targets stay relative to the same base positions,
 *   - export only has to rewrite POSITION,
 *   - undo is a delta-buffer restore rather than a re-mesh.
 *
 * Deltas are uniform inside a weld group, so UV seams and hard-normal splits do
 * not tear open while sculpting.
 */
import { falloff, clamp } from '../core/util';
import type { WeldMap } from './weld';
import { SpatialIndex } from './spatialIndex';

export type BrushId = 'clay' | 'draw' | 'smooth' | 'inflate' | 'crease' | 'grab' | 'mask';

export interface BrushInfo {
  id: BrushId;
  label: string;
  key: string;
  hint: string;
  /** mask is a paint mode rather than a shape change */
  paintsMask?: boolean;
}

export const BRUSHES: BrushInfo[] = [
  { id: 'clay', label: 'Clay', key: '1', hint: 'Builds a flat-topped layer toward the brush plane. Shift inverts.' },
  { id: 'draw', label: 'Draw', key: '2', hint: 'Raises along the averaged surface normal.' },
  { id: 'smooth', label: 'Smooth', key: '3', hint: 'Relaxes geometry toward its neighbours. Great for seams.' },
  { id: 'inflate', label: 'Inflate', key: '4', hint: 'Pushes each vertex along its own normal — volume without edges.' },
  { id: 'crease', label: 'Crease', key: '5', hint: 'Pinches toward the stroke and cuts inward.' },
  { id: 'grab', label: 'Grab', key: '6', hint: 'Drags a captured region with the cursor. Symmetry aware.' },
  { id: 'mask', label: 'Mask', key: 'M', hint: 'Paints a freeze mask. Alt erases. Masked areas ignore brushes.', paintsMask: true },
];

export interface Symmetry {
  x: boolean;
}

export interface StrokeSettings {
  tool: BrushId;
  radius: number;
  strength: number;
  symmetry: Symmetry;
  invert: boolean;
  pressure: number;
}

/** The data contract between a sculpt stroke and a character mesh. */
export interface SculptTarget {
  /** immutable imported positions (rest / bind pose) */
  basePosition: Float32Array;
  /** accumulated position deltas, same layout as basePosition */
  delta: Float32Array;
  /** per-vertex freeze mask 0..1 */
  mask: Float32Array;
  /** per-group averaged normals (unit length, xyz per group) */
  groupNormal: Float32Array;
  weld: WeldMap;
  spatial: SpatialIndex;
  groupAdjacency: { start: Uint32Array; list: Uint32Array };
  /** apply base+delta for the given groups and refresh normals + GPU buffers */
  commit(groups: Uint32Array, count: number): void;
}

export interface StrokeHit {
  /** hit point in mesh-local space */
  point: [number, number, number];
  /** surface normal in mesh-local space */
  normal: [number, number, number];
  /** camera-facing unit vector in mesh-local space (used by grab) */
  viewDir: [number, number, number];
  /** symmetry plane in mesh-local space: point on the plane + unit axis to reflect */
  mirrorPlane?: { origin: [number, number, number]; axis: [number, number, number] };
}

export interface StrokeResult {
  label: string;
  changedGroups: Uint32Array;
  maskChanges: boolean;
  bytes: number;
  before: Float32Array;
  after: Float32Array;
}

/**
 * One instance per mesh, reused across strokes. A stroke is begin → dab* → end,
 * or begin → drag* → end for Grab.
 */
export class SculptEngine {
  private changedSet: Set<number> = new Set();
  private changedList: number[] = [];
  private grabbed: { ids: Uint32Array; weights: Float32Array; mirror: boolean }[] = [];
  private active = false;
  private tool: BrushId = 'clay';
  private settings: StrokeSettings | null = null;
  private hit: StrokeHit | null = null;
  private before: Map<number, [number, number, number]> | null = null;
  private maskBefore: Map<number, number> | null = null;
  private maxMove = 0;
  private gatherBuffer: Uint32Array;
  private weights: Float32Array;
  private dabCount = 0;

  constructor(public target: SculptTarget) {
    this.gatherBuffer = new Uint32Array(target.weld.groupCount);
    this.weights = new Float32Array(target.weld.groupCount);
  }

  get isActive(): boolean {
    return this.active;
  }

  get dabs(): number {
    return this.dabCount;
  }

  get changedCount(): number {
    return this.changedList.length;
  }

  getDeltaStats(): { maxDelta: number; movedVertices: number; movedGroups: number } {
    const d = this.target.delta;
    let max = 0;
    let movedVertices = 0;
    let movedGroups = 0;
    const weld = this.target.weld;
    for (let g = 0; g < weld.groupCount; g++) {
      const v = weld.groupList[weld.groupStart[g]];
      const m = Math.hypot(d[v * 3], d[v * 3 + 1], d[v * 3 + 2]);
      if (m > 1e-7) {
        movedGroups++;
        if (m > max) max = m;
      }
    }
    for (let v = 0; v < d.length / 3; v++) {
      if (Math.hypot(d[v * 3], d[v * 3 + 1], d[v * 3 + 2]) > 1e-7) movedVertices++;
    }
    return { maxDelta: max, movedVertices, movedGroups };
  }

  begin(tool: BrushId, settings: StrokeSettings, hit: StrokeHit): void {
    this.cancel();
    this.active = true;
    this.tool = tool;
    this.settings = { ...settings, tool };
    this.hit = hit;
    this.changedSet = new Set();
    this.changedList = [];
    this.before = new Map();
    this.maskBefore = tool === 'mask' ? new Map() : null;
    this.maxMove = 0;
    this.dabCount = 0;
    if (tool === 'grab') this.captureGrab(hit);
  }

  private mirrorOf(p: [number, number, number]): [number, number, number] | null {
    const plane = this.hit?.mirrorPlane;
    if (!plane || !this.settings?.symmetry.x) return null;
    const { origin, axis } = plane;
    const d = (p[0] - origin[0]) * axis[0] + (p[1] - origin[1]) * axis[1] + (p[2] - origin[2]) * axis[2];
    return [p[0] - 2 * d * axis[0], p[1] - 2 * d * axis[1], p[2] - 2 * d * axis[2]];
  }

  private captureGrab(hit: StrokeHit): void {
    if (!this.settings) return;
    const r = this.settings.radius;
    const sides: { p: [number, number, number]; mirror: boolean }[] = [{ p: hit.point, mirror: false }];
    const m = this.mirrorOf(hit.point);
    if (m) sides.push({ p: m, mirror: true });
    this.grabbed = [];
    for (const side of sides) {
      const n = this.target.spatial.query(side.p[0], side.p[1], side.p[2], r, this.gatherBuffer);
      const ids = new Uint32Array(n);
      const weights = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const g = this.gatherBuffer[i];
        const v = this.target.weld.groupList[this.target.weld.groupStart[g]];
        const dx = this.target.basePosition[v * 3] + this.target.delta[v * 3] - side.p[0];
        const dy = this.target.basePosition[v * 3 + 1] + this.target.delta[v * 3 + 1] - side.p[1];
        const dz = this.target.basePosition[v * 3 + 2] + this.target.delta[v * 3 + 2] - side.p[2];
        ids[i] = g;
        weights[i] = falloff(Math.hypot(dx, dy, dz) / r);
      }
      this.grabbed.push({ ids, weights, mirror: side.mirror });
    }
  }

  /** Apply one dab at a mesh-local point. */
  dab(point: [number, number, number], pressure = 1, invert = false): void {
    if (!this.active || !this.settings) return;
    this.dabCount++;
    const mirrored = this.mirrorOf(point);
    this.dabAt(point, pressure, invert);
    if (mirrored) this.dabAt(mirrored, pressure, invert);
  }

  private markChanged(g: number): void {
    if (this.changedSet.has(g)) return;
    this.changedSet.add(g);
    this.changedList.push(g);
    if (this.tool === 'mask') {
      const rep = this.target.weld.groupList[this.target.weld.groupStart[g]];
      this.maskBefore!.set(g, this.target.mask[rep]);
    } else {
      const rep = this.target.weld.groupList[this.target.weld.groupStart[g]];
      this.before!.set(g, [
        this.target.delta[rep * 3],
        this.target.delta[rep * 3 + 1],
        this.target.delta[rep * 3 + 2],
      ]);
    }
  }

  private dabAt(center: [number, number, number], pressure: number, invert: boolean): void {
    const s = this.settings!;
    const target = this.target;
    const r = s.radius;
    const n = target.spatial.query(center[0], center[1], center[2], r, this.gatherBuffer);
    if (!n) return;
    const P = target.basePosition;
    const D = target.delta;
    const strength = clamp(s.strength * pressure, 0, 1) * (invert ? -1 : 1);
    if (strength === 0) return;
    const ids = this.gatherBuffer;
    const w = this.weights;

    // gather weights and the weighted area frame
    let nx = 0;
    let ny = 0;
    let nz = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let wsum = 0;
    for (let i = 0; i < n; i++) {
      const g = ids[i];
      const rep = target.weld.groupList[target.weld.groupStart[g]];
      const dx = P[rep * 3] + D[rep * 3] - center[0];
      const dy = P[rep * 3 + 1] + D[rep * 3 + 1] - center[1];
      const dz = P[rep * 3 + 2] + D[rep * 3 + 2] - center[2];
      const f = falloff(Math.sqrt(dx * dx + dy * dy + dz * dz) / r) * (1 - target.mask[rep]);
      w[i] = f;
      if (f <= 0) continue;
      const gnx = target.groupNormal[g * 3];
      const gny = target.groupNormal[g * 3 + 1];
      const gnz = target.groupNormal[g * 3 + 2];
      nx += gnx * f;
      ny += gny * f;
      nz += gnz * f;
      cx += (P[rep * 3] + D[rep * 3]) * f;
      cy += (P[rep * 3 + 1] + D[rep * 3 + 1]) * f;
      cz += (P[rep * 3 + 2] + D[rep * 3 + 2]) * f;
      wsum += f;
    }
    if (wsum <= 0) return;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    const N: [number, number, number] = [nx / nl, ny / nl, nz / nl];
    const C: [number, number, number] = [cx / wsum, cy / wsum, cz / wsum];

    const apply = (g: number, dx: number, dy: number, dz: number) => {
      if (dx === 0 && dy === 0 && dz === 0) return;
      this.markChanged(g);
      const weld = target.weld;
      const start = weld.groupStart[g];
      const end = weld.groupStart[g + 1];
      for (let k = start; k < end; k++) {
        const v = weld.groupList[k];
        D[v * 3] += dx;
        D[v * 3 + 1] += dy;
        D[v * 3 + 2] += dz;
      }
      const m = Math.hypot(dx, dy, dz);
      if (m > this.maxMove) this.maxMove = m;
    };

    switch (s.tool) {
      case 'mask': {
        for (let i = 0; i < n; i++) {
          const g = ids[i];
          if (w[i] <= 0) continue;
          this.markChanged(g);
          const weld = target.weld;
          for (let k = weld.groupStart[g]; k < weld.groupStart[g + 1]; k++) {
            const v = weld.groupList[k];
            target.mask[v] = clamp(target.mask[v] + w[i] * Math.abs(strength) * 0.35 * (invert ? -1 : 1), 0, 1);
          }
        }
        break;
      }
      case 'draw': {
        const k = r * strength * 0.09;
        for (let i = 0; i < n; i++) {
          const g = ids[i];
          if (w[i] <= 0) continue;
          apply(g, N[0] * w[i] * k, N[1] * w[i] * k, N[2] * w[i] * k);
        }
        break;
      }
      case 'inflate': {
        const k = r * strength * 0.07;
        for (let i = 0; i < n; i++) {
          const g = ids[i];
          if (w[i] <= 0) continue;
          apply(
            g,
            target.groupNormal[g * 3] * w[i] * k,
            target.groupNormal[g * 3 + 1] * w[i] * k,
            target.groupNormal[g * 3 + 2] * w[i] * k,
          );
        }
        break;
      }
      case 'clay': {
        const offset = r * 0.14 * (strength < 0 ? -1 : 1);
        const px = C[0] + N[0] * offset;
        const py = C[1] + N[1] * offset;
        const pz = C[2] + N[2] * offset;
        const sign = strength < 0 ? -1 : 1;
        for (let i = 0; i < n; i++) {
          const g = ids[i];
          if (w[i] <= 0) continue;
          const rep = target.weld.groupList[target.weld.groupStart[g]];
          const vx = P[rep * 3] + D[rep * 3];
          const vy = P[rep * 3 + 1] + D[rep * 3 + 1];
          const vz = P[rep * 3 + 2] + D[rep * 3 + 2];
          const d = (vx - px) * N[0] + (vy - py) * N[1] + (vz - pz) * N[2];
          if (d * sign >= 0) continue;
          const push = -d * w[i] * Math.abs(strength) * 0.55;
          apply(g, N[0] * push * sign, N[1] * push * sign, N[2] * push * sign);
        }
        break;
      }
      case 'smooth': {
        const lapX = new Float32Array(n);
        const lapY = new Float32Array(n);
        const lapZ = new Float32Array(n);
        const adj = target.groupAdjacency;
        for (let i = 0; i < n; i++) {
          const g = ids[i];
          const a = adj.start[g];
          const b = adj.start[g + 1];
          if (b === a) continue;
          let ax = 0;
          let ay = 0;
          let az = 0;
          for (let k = a; k < b; k++) {
            const rep = target.weld.groupList[target.weld.groupStart[adj.list[k]]];
            ax += P[rep * 3] + D[rep * 3];
            ay += P[rep * 3 + 1] + D[rep * 3 + 1];
            az += P[rep * 3 + 2] + D[rep * 3 + 2];
          }
          const inv = 1 / (b - a);
          const rep = target.weld.groupList[target.weld.groupStart[g]];
          lapX[i] = ax * inv - (P[rep * 3] + D[rep * 3]);
          lapY[i] = ay * inv - (P[rep * 3 + 1] + D[rep * 3 + 1]);
          lapZ[i] = az * inv - (P[rep * 3 + 2] + D[rep * 3 + 2]);
        }
        for (let i = 0; i < n; i++) {
          const g = ids[i];
          if (w[i] <= 0) continue;
          const k = w[i] * Math.min(1, Math.abs(strength) * 1.6);
          apply(g, lapX[i] * k, lapY[i] * k, lapZ[i] * k);
        }
        break;
      }
      case 'crease': {
        const pinch = 0.35 * strength;
        const carve = -r * Math.abs(strength) * 0.06 * (strength < 0 ? -1 : 1);
        for (let i = 0; i < n; i++) {
          const g = ids[i];
          if (w[i] <= 0) continue;
          const rep = target.weld.groupList[target.weld.groupStart[g]];
          let tx = center[0] - (P[rep * 3] + D[rep * 3]);
          let ty = center[1] - (P[rep * 3 + 1] + D[rep * 3 + 1]);
          let tz = center[2] - (P[rep * 3 + 2] + D[rep * 3 + 2]);
          const dn = tx * N[0] + ty * N[1] + tz * N[2];
          tx -= N[0] * dn;
          ty -= N[1] * dn;
          tz -= N[2] * dn;
          const k = w[i];
          apply(
            g,
            tx * k * pinch + N[0] * k * carve,
            ty * k * pinch + N[1] * k * carve,
            tz * k * pinch + N[2] * k * carve,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  /** Move the captured region (Grab) by a mesh-local translation. */
  drag(delta: [number, number, number]): void {
    if (!this.active || this.tool !== 'grab' || !this.settings) return;
    const target = this.target;
    const D = target.delta;
    for (const set of this.grabbed) {
      const dx = delta[0] * (set.mirror ? -1 : 1);
      for (let i = 0; i < set.ids.length; i++) {
        const g = set.ids[i];
        const wt = set.weights[i];
        if (wt <= 0) continue;
        this.markChanged(g);
        for (let k = target.weld.groupStart[g]; k < target.weld.groupStart[g + 1]; k++) {
          const v = target.weld.groupList[k];
          D[v * 3] += dx * wt;
          D[v * 3 + 1] += delta[1] * wt;
          D[v * 3 + 2] += delta[2] * wt;
        }
      }
    }
    this.maxMove = Math.max(this.maxMove, Math.hypot(delta[0], delta[1], delta[2]));
    target.spatial.slack = this.maxMove;
    this.commitChanged();
  }

  private commitChanged(): void {
    if (!this.changedList.length) return;
    const arr = new Uint32Array(this.changedList);
    this.target.commit(arr, arr.length);
  }

  /** Finish the stroke; returns undo data (null when nothing changed). */
  end(): StrokeResult | null {
    if (!this.active) return null;
    this.active = false;
    this.commitChanged();
    const count = this.changedList.length;
    this.target.spatial.slack = 0;
    this.target.spatial.rebuild();
    if (!count) return null;
    const before = new Float32Array(count * 3);
    const after = new Float32Array(count * 3);
    const isMask = this.tool === 'mask';
    for (let i = 0; i < count; i++) {
      const g = this.changedList[i];
      if (isMask) {
        before[i * 3] = this.maskBefore!.get(g) ?? 0;
        after[i * 3] = this.target.mask[this.target.weld.groupList[this.target.weld.groupStart[g]]];
        before[i * 3 + 1] = before[i * 3 + 2] = after[i * 3 + 1] = after[i * 3 + 2] = 0;
      } else {
        const [bx, by, bz] = this.before!.get(g) ?? [0, 0, 0];
        const rep = this.target.weld.groupList[this.target.weld.groupStart[g]];
        before[i * 3] = bx;
        before[i * 3 + 1] = by;
        before[i * 3 + 2] = bz;
        after[i * 3] = this.target.delta[rep * 3];
        after[i * 3 + 1] = this.target.delta[rep * 3 + 1];
        after[i * 3 + 2] = this.target.delta[rep * 3 + 2];
      }
    }
    return {
      label: BRUSHES.find((b) => b.id === this.tool)?.label ?? this.tool,
      changedGroups: new Uint32Array(this.changedList),
      maskChanges: isMask,
      bytes: count * 24,
      before,
      after,
    };
  }

  /** Abort the stroke and restore the exact pre-stroke state. */
  cancel(): void {
    if (!this.active) return;
    this.active = false;
    const target = this.target;
    if (this.before) {
      for (const [g, [bx, by, bz]] of this.before) {
        for (let k = target.weld.groupStart[g]; k < target.weld.groupStart[g + 1]; k++) {
          const v = target.weld.groupList[k];
          target.delta[v * 3] = bx;
          target.delta[v * 3 + 1] = by;
          target.delta[v * 3 + 2] = bz;
        }
      }
    }
    if (this.maskBefore) {
      for (const [g, mv] of this.maskBefore) {
        for (let k = target.weld.groupStart[g]; k < target.weld.groupStart[g + 1]; k++) {
          target.mask[target.weld.groupList[k]] = mv;
        }
      }
    }
    this.commitChanged();
    this.changedList = [];
    this.changedSet = new Set();
    this.maxMove = 0;
    target.spatial.slack = 0;
    target.spatial.rebuild();
  }
}
