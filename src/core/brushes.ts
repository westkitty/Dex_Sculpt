import type { SculptMesh } from './topology';
import { VertexGrid } from './grid';
import { StrokeRecorder, type HistoryEntry } from './history';

export type BrushId =
  | 'draw'
  | 'inflate'
  | 'clay'
  | 'smooth'
  | 'grab'
  | 'flatten'
  | 'pinch'
  | 'crease'
  | 'mask';

export const BRUSHES: { id: BrushId; label: string; key: string; hint: string }[] = [
  { id: 'draw', label: 'Draw', key: '1', hint: 'Raise surface along area normal (Ctrl/Alt: carve)' },
  { id: 'clay', label: 'Clay', key: '2', hint: 'Build fuller volume toward an offset plane' },
  { id: 'smooth', label: 'Smooth', key: '3', hint: 'Relax uneven areas (or hold Shift with any brush)' },
  { id: 'inflate', label: 'Inflate', key: '4', hint: 'Expand each vertex along its own normal' },
  { id: 'crease', label: 'Crease', key: '5', hint: 'Pinch and carve crisp folds or wrinkles' },
  { id: 'grab', label: 'Grab', key: '6', hint: 'Pull proportions softly along cursor drag' },
  { id: 'flatten', label: 'Flatten', key: '7', hint: 'Level surface toward the local average plane' },
  { id: 'pinch', label: 'Pinch', key: '8', hint: 'Pull vertices inward toward brush center' },
  { id: 'mask', label: 'Mask', key: 'M', hint: 'Protect vertices from sculpting (Ctrl: erase mask)' }
];

export type Vec3 = [number, number, number];
export interface Symmetry {
  x: boolean;
  y: boolean;
  z: boolean;
}
export interface DabParams {
  radius: number;
  strength: number;
  invert: boolean;
  symmetry: Symmetry;
  pressure?: number;
}

/** Smooth bell falloff: 1 at center, 0 at rim, zero slope at both ends. */
export function falloff(t: number): number {
  if (t >= 1) return 0;
  const u = 1 - t * t;
  return u * u;
}

function mirrors(sym: Symmetry): Vec3[] {
  const out: Vec3[] = [[1, 1, 1]];
  if (sym.x) for (const m of [...out]) out.push([-m[0], m[1], m[2]]);
  if (sym.y) for (const m of [...out]) out.push([m[0], -m[1], m[2]]);
  if (sym.z) for (const m of [...out]) out.push([m[0], m[1], -m[2]]);
  return out;
}

/**
 * Imperative non-topology-changing stroke engine.
 * One instance per sculpted mesh; a stroke is begin -> dab* (or grabStart -> grabMove*) -> end | cancel.
 */
export class StrokeEngine {
  grid: VertexGrid;
  private ids: Uint32Array;
  private w: Float32Array;
  private tmp: Float32Array;
  private rec: StrokeRecorder | null = null;
  private tool: BrushId = 'draw';
  private grabSets: { ids: Uint32Array; w: Float32Array; mirror: Vec3 }[] = [];
  private changed: Uint32Array;

  constructor(public mesh: SculptMesh) {
    this.grid = new VertexGrid(mesh);
    this.ids = new Uint32Array(mesh.vertCount);
    this.w = new Float32Array(mesh.vertCount);
    this.tmp = new Float32Array(mesh.vertCount * 3);
    this.changed = new Uint32Array(mesh.vertCount);
  }

  get active(): boolean {
    return !!this.rec;
  }

  get activeTool(): BrushId {
    return this.tool;
  }

  begin(tool: BrushId): void {
    if (this.rec) this.cancel();
    this.tool = tool;
    this.rec = new StrokeRecorder(this.mesh, BRUSHES.find((b) => b.id === tool)?.label ?? tool);
    this.grabSets = [];
  }

  /** Apply one dab at `c` (mesh-local). Returns view of changed unique vertex IDs. */
  dab(c: Vec3, p: DabParams): Uint32Array {
    if (!this.rec) throw new Error('dab outside stroke');
    let total = 0;
    const seen = new Set<number>();
    for (const m of mirrors(p.symmetry)) {
      const cc: Vec3 = [c[0] * m[0], c[1] * m[1], c[2] * m[2]];
      const n = this.dabOne(cc, p);
      for (let i = 0; i < n; i++) {
        const v = this.ids[i];
        if (!seen.has(v)) {
          seen.add(v);
          this.changed[total++] = v;
        }
      }
    }
    return this.changed.subarray(0, total);
  }

  private gather(c: Vec3, r: number, useMask: boolean): number {
    const m = this.mesh;
    const n = this.grid.query(c[0], c[1], c[2], r, this.ids);
    for (let i = 0; i < n; i++) {
      const v = this.ids[i];
      const d = Math.hypot(m.pos[v * 3] - c[0], m.pos[v * 3 + 1] - c[1], m.pos[v * 3 + 2] - c[2]);
      this.w[i] = falloff(d / r) * (useMask ? 1 - m.mask[v] : 1);
    }
    return n;
  }

  private area(n: number): { N: Vec3; C: Vec3 } {
    const m = this.mesh;
    let nx = 0,
      ny = 0,
      nz = 0,
      cx = 0,
      cy = 0,
      cz = 0,
      ws = 0;
    for (let i = 0; i < n; i++) {
      const v = this.ids[i];
      const w = this.w[i] + 1e-6;
      nx += m.nrm[v * 3] * w;
      ny += m.nrm[v * 3 + 1] * w;
      nz += m.nrm[v * 3 + 2] * w;
      cx += m.pos[v * 3] * w;
      cy += m.pos[v * 3 + 1] * w;
      cz += m.pos[v * 3 + 2] * w;
      ws += w;
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    return { N: [nx / l, ny / l, nz / l], C: [cx / ws, cy / ws, cz / ws] };
  }

  private dabOne(c: Vec3, p: DabParams): number {
    const m = this.mesh;
    const P = m.pos;
    const r = p.radius;
    const s = Math.max(0, Math.min(1, p.strength * (p.pressure ?? 1)));
    const sign = p.invert ? -1 : 1;
    const tool = this.tool;
    if (tool === 'grab') return 0;

    const n = this.gather(c, r, tool !== 'mask');
    if (!n) return 0;
    this.rec!.touch(this.ids, n);

    let maxMove = 0;
    const move = (v: number, dx: number, dy: number, dz: number) => {
      P[v * 3] += dx;
      P[v * 3 + 1] += dy;
      P[v * 3 + 2] += dz;
      const d = Math.hypot(dx, dy, dz);
      if (d > maxMove) maxMove = d;
    };

    if (tool === 'mask') {
      for (let i = 0; i < n; i++) {
        const v = this.ids[i];
        m.mask[v] = Math.max(0, Math.min(1, m.mask[v] + this.w[i] * s * sign));
      }
      return n;
    }

    const { N, C } = this.area(n);
    switch (tool) {
      case 'draw': {
        const k = r * s * 0.08 * sign;
        for (let i = 0; i < n; i++) {
          const w = this.w[i] * k;
          move(this.ids[i], N[0] * w, N[1] * w, N[2] * w);
        }
        break;
      }
      case 'inflate': {
        const k = r * s * 0.06 * sign;
        for (let i = 0; i < n; i++) {
          const v = this.ids[i];
          const w = this.w[i] * k;
          move(v, m.nrm[v * 3] * w, m.nrm[v * 3 + 1] * w, m.nrm[v * 3 + 2] * w);
        }
        break;
      }
      case 'clay': {
        const off = r * 0.12 * sign;
        const P0: Vec3 = [C[0] + N[0] * off, C[1] + N[1] * off, C[2] + N[2] * off];
        for (let i = 0; i < n; i++) {
          const v = this.ids[i];
          const d = (P[v * 3] - P0[0]) * N[0] + (P[v * 3 + 1] - P0[1]) * N[1] + (P[v * 3 + 2] - P0[2]) * N[2];
          if (d * sign >= 0) continue;
          const w = -d * this.w[i] * s * 0.5;
          move(v, N[0] * w, N[1] * w, N[2] * w);
        }
        break;
      }
      case 'smooth': {
        for (let i = 0; i < n; i++) {
          const v = this.ids[i];
          let ax = 0,
            ay = 0,
            az = 0;
          const a = m.nbrStart[v];
          const b = m.nbrStart[v + 1];
          const deg = b - a;
          if (!deg) continue;
          for (let j = a; j < b; j++) {
            const u = m.nbrList[j] * 3;
            ax += P[u];
            ay += P[u + 1];
            az += P[u + 2];
          }
          const f = this.w[i] * s * 0.55;
          this.tmp[i * 3] = (ax / deg - P[v * 3]) * f;
          this.tmp[i * 3 + 1] = (ay / deg - P[v * 3 + 1]) * f;
          this.tmp[i * 3 + 2] = (az / deg - P[v * 3 + 2]) * f;
        }
        for (let i = 0; i < n; i++) {
          move(this.ids[i], this.tmp[i * 3], this.tmp[i * 3 + 1], this.tmp[i * 3 + 2]);
        }
        break;
      }
      case 'flatten': {
        for (let i = 0; i < n; i++) {
          const v = this.ids[i];
          const d = (P[v * 3] - C[0]) * N[0] + (P[v * 3 + 1] - C[1]) * N[1] + (P[v * 3 + 2] - C[2]) * N[2];
          const w = -d * this.w[i] * s * 0.55;
          move(v, N[0] * w, N[1] * w, N[2] * w);
        }
        break;
      }
      case 'pinch': {
        const k = s * 0.28 * sign;
        for (let i = 0; i < n; i++) {
          const v = this.ids[i];
          const w = this.w[i] * k;
          move(v, (c[0] - P[v * 3]) * w, (c[1] - P[v * 3 + 1]) * w, (c[2] - P[v * 3 + 2]) * w);
        }
        break;
      }
      case 'crease': {
        const kp = s * 0.25;
        const kd = r * s * 0.06 * sign;
        for (let i = 0; i < n; i++) {
          const v = this.ids[i];
          const w = this.w[i];
          const f = w * kp;
          const groove = w * w * kd;
          move(
            v,
            (c[0] - P[v * 3]) * f - N[0] * groove,
            (c[1] - P[v * 3 + 1]) * f - N[1] * groove,
            (c[2] - P[v * 3 + 2]) * f - N[2] * groove
          );
        }
        break;
      }
    }
    this.grid.slack += maxMove;
    return n;
  }

  /** Capture vertices for a Grab stroke. */
  grabStart(c: Vec3, radius: number, symmetry: Symmetry): void {
    if (!this.rec) throw new Error('grab outside stroke');
    this.grabSets = [];
    for (const mirror of mirrors(symmetry)) {
      const cc: Vec3 = [c[0] * mirror[0], c[1] * mirror[1], c[2] * mirror[2]];
      const n = this.gather(cc, radius, true);
      if (!n) continue;
      this.rec.touch(this.ids, n);
      this.grabSets.push({
        ids: this.ids.slice(0, n),
        w: this.w.slice(0, n),
        mirror
      });
    }
  }

  /** Displace captured grab vertices by delta (mesh-local). */
  grabMove(delta: Vec3, strength = 1): Uint32Array {
    if (!this.rec) throw new Error('grabMove outside stroke');
    const P = this.mesh.pos;
    let total = 0;
    let maxMove = 0;
    const seen = new Set<number>();
    for (const set of this.grabSets) {
      const dx = delta[0] * set.mirror[0] * strength;
      const dy = delta[1] * set.mirror[1] * strength;
      const dz = delta[2] * set.mirror[2] * strength;
      for (let i = 0; i < set.ids.length; i++) {
        const v = set.ids[i];
        const w = set.w[i];
        P[v * 3] += dx * w;
        P[v * 3 + 1] += dy * w;
        P[v * 3 + 2] += dz * w;
        const d = Math.hypot(dx * w, dy * w, dz * w);
        if (d > maxMove) maxMove = d;
        if (!seen.has(v)) {
          seen.add(v);
          this.changed[total++] = v;
        }
      }
    }
    this.grid.slack += maxMove;
    return this.changed.subarray(0, total);
  }

  end(apply: (verts: Uint32Array) => void): HistoryEntry | null {
    if (!this.rec) return null;
    const entry = this.rec.commit(apply);
    this.rec = null;
    this.grabSets = [];
    this.grid.rebuild();
    return entry;
  }

  cancel(): Uint32Array {
    if (!this.rec) return new Uint32Array(0);
    const touched = this.rec.cancel();
    this.rec = null;
    this.grabSets = [];
    this.grid.rebuild();
    return touched;
  }
}
