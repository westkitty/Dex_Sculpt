/**
 * Uniform-grid spatial index over weld groups.
 *
 * Brushes need "which surface region is under the cursor" at 60–120 Hz. Cells are
 * sized from the mesh's mean edge length so each cell holds a handful of groups.
 * After a stroke the grid is rebuilt once from the updated positions (never per
 * dab); during a stroke the query radius grows by the accumulated maximum vertex
 * displacement (`slack`), which keeps queries correct without any rebuild.
 */
export class SpatialIndex {
  private cell = 1;
  private ox = 0;
  private oy = 0;
  private oz = 0;
  private nx = 1;
  private ny = 1;
  private nz = 1;
  private start: Uint32Array = new Uint32Array(1);
  private list: Uint32Array = new Uint32Array(0);
  slack = 0;
  buildMs = 0;

  constructor(
    private points: Float32Array,
    private count: number,
    cellHint?: number,
  ) {
    this.rebuild(cellHint);
  }

  rebuild(cellHint?: number): void {
    const t0 = performance.now();
    const pts = this.points;
    const n = this.count;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 3];
      const y = pts[i * 3 + 1];
      const z = pts[i * 3 + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
    const cell = Math.max(cellHint ?? diag / 96, 1e-5);
    this.cell = cell;
    this.ox = minX;
    this.oy = minY;
    this.oz = minZ;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
    this.ny = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
    this.nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);
    const cells = this.nx * this.ny * this.nz;
    const counts = new Uint32Array(cells + 1);
    const cellOf = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const cx = Math.min(this.nx - 1, Math.max(0, Math.floor((pts[i * 3] - this.ox) / cell)));
      const cy = Math.min(this.ny - 1, Math.max(0, Math.floor((pts[i * 3 + 1] - this.oy) / cell)));
      const cz = Math.min(this.nz - 1, Math.max(0, Math.floor((pts[i * 3 + 2] - this.oz) / cell)));
      const id = cx + this.nx * (cy + this.ny * cz);
      cellOf[i] = id;
      counts[id + 1]++;
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    const list = new Uint32Array(n);
    const cursor = counts.slice(0, cells);
    for (let i = 0; i < n; i++) list[cursor[cellOf[i]]++] = i;
    this.start = counts;
    this.list = list;
    this.slack = 0;
    this.buildMs = performance.now() - t0;
  }

  /** Fill `out` with group ids within `radius` (+ accumulated slack) of p. */
  query(x: number, y: number, z: number, radius: number, out: Uint32Array): number {
    const r = radius + this.slack;
    const cell = this.cell;
    const pts = this.points;
    const i0 = Math.max(0, Math.floor((x - r - this.ox) / cell));
    const i1 = Math.min(this.nx - 1, Math.floor((x + r - this.ox) / cell));
    const j0 = Math.max(0, Math.floor((y - r - this.oy) / cell));
    const j1 = Math.min(this.ny - 1, Math.floor((y + r - this.oy) / cell));
    const k0 = Math.max(0, Math.floor((z - r - this.oz) / cell));
    const k1 = Math.min(this.nz - 1, Math.floor((z + r - this.oz) / cell));
    const r2 = r * r;
    let n = 0;
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        const rowBase = this.nx * (j + this.ny * k);
        for (let i = i0; i <= i1; i++) {
          const c = rowBase + i;
          const s = this.start[c];
          const e = this.start[c + 1];
          for (let p = s; p < e; p++) {
            const g = this.list[p];
            const dx = pts[g * 3] - x;
            const dy = pts[g * 3 + 1] - y;
            const dz = pts[g * 3 + 2] - z;
            if (dx * dx + dy * dy + dz * dz <= r2) out[n++] = g;
          }
        }
      }
    }
    return n;
  }
}
