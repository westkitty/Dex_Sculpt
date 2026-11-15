/**
 * Coincident-vertex ("weld") analysis for rig-safe sculpting.
 *
 * IMPORTANT DESIGN CONSTRAINT
 * ---------------------------
 * DEX//SCULPT never rebuilds or re-welds the render geometry. UV seams, per-vertex
 * skin attributes, morph targets and material groups all stay exactly as the
 * importer produced them. What we *do* is discover which render vertices share a
 * position so that a brush writes one identical position delta to every copy.
 * That keeps the surface C0-continuous across UV seams and hard normal splits
 * while touching only `position` (and derived normals).
 *
 * The weld map is read-only after construction; it is never used to rewrite
 * topology, indices, joints, weights or morphs.
 */

export interface WeldMap {
  /** render vertex -> coincident group id */
  groupOf: Uint32Array;
  /** CSR: group -> member render vertex ids */
  groupStart: Uint32Array;
  groupList: Uint32Array;
  groupCount: number;
  /** mean edge length of the render mesh (used for index cell sizing) */
  meanEdge: number;
  /** number of render vertices that were merged into a multi-vertex group */
  weldedVertices: number;
}

/**
 * Build the weld map. `epsRel` is relative to the mesh bounding-box diagonal:
 * 1e-5 of a 2 m character is 20 µm — far below any sculpting feature and far
 * above float32 noise, so genuinely distinct surfaces are never merged.
 */
export function buildWeldMap(
  positions: Float32Array,
  vertexCount: number,
  indices: ArrayLike<number> | null,
  bboxDiag: number,
  epsRel = 1e-5,
): WeldMap {
  const eps = Math.max(bboxDiag * epsRel, 1e-7);
  const inv = 1 / eps;
  const groupOf = new Uint32Array(vertexCount);
  /** representative render vertex per group */
  const reps: number[] = [];
  const buckets = new Map<number, number[]>();
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    const qx = Math.round(x * inv);
    const qy = Math.round(y * inv);
    const qz = Math.round(z * inv);
    const h = (Math.imul(qx, 73856093) ^ Math.imul(qy, 19349663) ^ Math.imul(qz, 83492791)) >>> 0;
    const bucket = buckets.get(h);
    let found = -1;
    if (bucket) {
      for (const g of bucket) {
        const rep = reps[g];
        if (
          Math.abs(positions[rep * 3] - x) <= eps &&
          Math.abs(positions[rep * 3 + 1] - y) <= eps &&
          Math.abs(positions[rep * 3 + 2] - z) <= eps
        ) {
          found = g;
          break;
        }
      }
      if (found < 0) {
        found = reps.length;
        reps.push(v);
        bucket.push(found);
      }
    } else {
      found = reps.length;
      reps.push(v);
      buckets.set(h, [found]);
    }
    groupOf[v] = found;
  }
  const denseCount = reps.length;

  const counts = new Uint32Array(denseCount);
  for (let v = 0; v < vertexCount; v++) counts[groupOf[v]]++;
  const groupStart = new Uint32Array(denseCount + 1);
  for (let g = 0; g < denseCount; g++) groupStart[g + 1] = groupStart[g] + counts[g];
  const cursor = groupStart.slice(0, denseCount);
  const groupList = new Uint32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    groupList[cursor[groupOf[v]]++] = v;
  }

  let welded = 0;
  for (let g = 0; g < denseCount; g++) {
    const n = groupStart[g + 1] - groupStart[g];
    if (n > 1) welded += n - 1;
  }

  return {
    groupOf,
    groupStart,
    groupList,
    groupCount: denseCount,
    meanEdge: meanEdgeLength(positions, vertexCount, indices),
    weldedVertices: welded,
  };
}

export function meanEdgeLength(
  positions: Float32Array,
  vertexCount: number,
  indices: ArrayLike<number> | null,
): number {
  let acc = 0;
  let n = 0;
  if (indices && indices.length >= 3) {
    const triCount = Math.floor(indices.length / 3);
    const stride = Math.max(1, Math.floor(triCount / 4000));
    for (let tao = 0; tao < triCount; tao += stride) {
      for (let e = 0; e < 3; e++) {
        const a = indices[tao * 3 + e] * 3;
        const b = indices[tao * 3 + ((e + 1) % 3)] * 3;
        acc += Math.hypot(
          positions[a] - positions[b],
          positions[a + 1] - positions[b + 1],
          positions[a + 2] - positions[b + 2],
        );
        n++;
      }
    }
  }
  if (!n) {
    // fall back to the mean distance between consecutive vertices
    for (let v = 1; v < Math.min(vertexCount, 2000); v++) {
      acc += Math.hypot(
        positions[v * 3] - positions[(v - 1) * 3],
        positions[v * 3 + 1] - positions[(v - 1) * 3 + 1],
        positions[v * 3 + 2] - positions[(v - 1) * 3 + 2],
      );
      n++;
    }
  }
  return n ? Math.max(acc / n, 1e-5) : 0.01;
}

/** Group-space 1-ring adjacency, used by the smooth brush. */
export function buildGroupAdjacency(
  weld: WeldMap,
  indices: ArrayLike<number> | null,
): { start: Uint32Array; list: Uint32Array } {
  const n = weld.groupCount;
  const neighbours: number[][] = new Array(n);
  const seen: Set<number>[] = new Array(n);
  for (let g = 0; g < n; g++) {
    neighbours[g] = [];
    seen[g] = new Set();
  }
  if (indices) {
    const triCount = Math.floor(indices.length / 3);
    for (let t = 0; t < triCount; t++) {
      const a = weld.groupOf[indices[t * 3]];
      const b = weld.groupOf[indices[t * 3 + 1]];
      const c = weld.groupOf[indices[t * 3 + 2]];
      const add = (p: number, q: number) => {
        if (p === q) return;
        if (seen[p].has(q)) return;
        seen[p].add(q);
        neighbours[p].push(q);
      };
      add(a, b);
      add(b, c);
      add(c, a);
      add(b, a);
      add(c, b);
      add(a, c);
    }
  }
  let total = 0;
  for (let g = 0; g < n; g++) total += neighbours[g].length;
  const start = new Uint32Array(n + 1);
  for (let g = 0; g < n; g++) start[g + 1] = start[g] + neighbours[g].length;
  const list = new Uint32Array(total);
  let at = 0;
  for (let g = 0; g < n; g++) for (const v of neighbours[g]) list[at++] = v;
  return { start, list };
}

/** group -> incident triangle ids (triangle index, not corner), for local normal rebuild. */
export function buildGroupTriangles(
  weld: WeldMap,
  indices: ArrayLike<number> | null,
): { start: Uint32Array; list: Uint32Array } {
  const n = weld.groupCount;
  const triCount = indices ? Math.floor(indices.length / 3) : 0;
  const counts = new Uint32Array(n);
  const push = (g: number) => {
    counts[g]++;
  };
  for (let t = 0; t < triCount; t++) {
    push(weld.groupOf[indices![t * 3]]);
    push(weld.groupOf[indices![t * 3 + 1]]);
    push(weld.groupOf[indices![t * 3 + 2]]);
  }
  const start = new Uint32Array(n + 1);
  for (let g = 0; g < n; g++) start[g + 1] = start[g] + counts[g];
  const list = new Uint32Array(start[n]);
  const cursor = start.slice(0, n);
  for (let t = 0; t < triCount; t++) {
    const a = weld.groupOf[indices![t * 3]];
    const b = weld.groupOf[indices![t * 3 + 1]];
    const c = weld.groupOf[indices![t * 3 + 2]];
    list[cursor[a]++] = t;
    list[cursor[b]++] = t;
    list[cursor[c]++] = t;
  }
  return { start, list };
}

export function bboxDiagonal(positions: Float32Array, vertexCount: number): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
}
