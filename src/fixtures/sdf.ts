/**
 * Signed-distance primitives and a table-free surface-nets polygonizer.
 *
 * The Phase A fixture (a rigged, animated, morph-targeted humanoid) is generated
 * from this file so that the proof asset is fully reproducible from source, has
 * no third-party licence obligations, and needs no binary in the repository.
 */

export type Vec3 = [number, number, number];
export type SdfFn = (x: number, y: number, z: number) => number;

export function sdSphere(x: number, y: number, z: number, c: Vec3, r: number): number {
  const dx = x - c[0];
  const dy = y - c[1];
  const dz = z - c[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}

/** Scalar form of sdSphere — no allocation, for hot inner loops. */
export function sdSphereAt(x: number, y: number, z: number, cx: number, cy: number, cz: number, r: number): number {
  const dx = x - cx;
  const dy = y - cy;
  const dz = z - cz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}

/** Scalar form of sdEllipsoid — no allocation, for hot inner loops. */
export function sdEllipsoidAt(
  x: number, y: number, z: number,
  cx: number, cy: number, cz: number,
  rx: number, ry: number, rz: number,
): number {
  const ax = (x - cx) / rx;
  const ay = (y - cy) / ry;
  const az = (z - cz) / rz;
  const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
  if (k0 === 0) return -Math.min(rx, ry, rz);
  if (k0 === 1) return 0;
  const bx = (x - cx) / (rx * rx);
  const by = (y - cy) / (ry * ry);
  const bz = (z - cz) / (rz * rz);
  const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
  return (k0 * (k0 - 1)) / k1;
}

/** Approximate signed distance to an axis-aligned ellipsoid (iq's bound). */
export function sdEllipsoid(x: number, y: number, z: number, c: Vec3, r: Vec3): number {
  const px = x - c[0];
  const py = y - c[1];
  const pz = z - c[2];
  const ax = px / r[0];
  const ay = py / r[1];
  const az = pz / r[2];
  const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
  if (k0 === 0) return -Math.min(r[0], r[1], r[2]);
  if (k0 === 1) return 0;
  const bx = px / (r[0] * r[0]);
  const by = py / (r[1] * r[1]);
  const bz = pz / (r[2] * r[2]);
  const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
  return (k0 * (k0 - 1)) / k1;
}

/** Rounded cone (capsule with different end radii) between a and b. */
export function sdRoundCone(x: number, y: number, z: number, a: Vec3, b: Vec3, r1: number, r2: number): number {
  const bax = b[0] - a[0];
  const bay = b[1] - a[1];
  const baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = x - a[0];
  const pay = y - a[1];
  const paz = z - a[2];
  const yy = pax * bax + pay * bay + paz * baz;
  const zz = yy - l2;
  const qx = pax * l2 - bax * yy;
  const qy = pay * l2 - bay * yy;
  const qz = paz * l2 - baz * yy;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = yy * yy * l2;
  const z2 = zz * zz * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r1;
  if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r2;
  return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
}

/** Allocation-free rounded cone with scalar endpoints. */
export function sdRoundCone6(
  x: number, y: number, z: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r1: number, r2: number,
): number {
  const bax = bx - ax;
  const bay = by - ay;
  const baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = x - ax;
  const pay = y - ay;
  const paz = z - az;
  const yy = pax * bax + pay * bay + paz * baz;
  const zz = yy - l2;
  const qx = pax * l2 - bax * yy;
  const qy = pay * l2 - bay * yy;
  const qz = paz * l2 - baz * yy;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = yy * yy * l2;
  const z2 = zz * zz * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r1;
  if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r2;
  return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
}

/** Polynomial smooth minimum. */
export function smin(a: number, b: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

/** Ellipsoid flattened along Y — handy for feet and pauldrons. */
export function sdFlattenedEllipsoid(x: number, y: number, z: number, c: Vec3, r: Vec3, ySquash: number): number {
  return sdEllipsoid(x, y / ySquash, z, [c[0], c[1] / ySquash, c[2]], r) * ySquash;
}

const gradientScratch: Vec3 = [0, 0, 0];

/** Central-difference normal. Returns a shared scratch vector unless `out` is given. */
export function sdfGradient(sdf: SdfFn, x: number, y: number, z: number, eps = 0.002, out?: Vec3): Vec3 {
  const gx = sdf(x + eps, y, z) - sdf(x - eps, y, z);
  const gy = sdf(x, y + eps, z) - sdf(x, y - eps, z);
  const gz = sdf(x, y, z + eps) - sdf(x, y, z - eps);
  const len = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
  const t = out ?? gradientScratch;
  t[0] = gx / len;
  t[1] = gy / len;
  t[2] = gz / len;
  return t;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export interface NetsMesh {
  /** one vertex per surface cell, shared between neighbouring quads */
  positions: Float32Array;
  /** triangle list (indexed into positions) */
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

const CORNERS: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];

const EDGES: [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/**
 * Naive surface nets: one vertex per sign-changing cell (placed at the mean of
 * its edge crossings) and one quad per sign-changing grid edge. No static
 * triangle tables, deterministic output, watertight within the sampled bounds.
 *
 * `band` enables coarse-to-fine sampling: a coarse (2× cell) grid is evaluated
 * first and only fine samples within `band` cells of the surface are evaluated
 * exactly. Far samples take their sign from the interpolated coarse field, which
 * is all the polygonizer needs and makes fixture generation ~5× faster.
 */
export const netsProfile = { coarse: 0, fine: 0, cells: 0, quads: 0, orient: 0, exact: 0 };

export function surfaceNets(sdf: SdfFn, bounds: Bounds, cell: number, band = 2): NetsMesh {
  const T0 = performance.now();
  const min = bounds.min;
  const nx = Math.max(2, Math.ceil((bounds.max[0] - min[0]) / cell) + 1);
  const ny = Math.max(2, Math.ceil((bounds.max[1] - min[1]) / cell) + 1);
  const nz = Math.max(2, Math.ceil((bounds.max[2] - min[2]) / cell) + 1);
  const field = new Float32Array(nx * ny * nz);
  let exactCount = 0;
  const xOf = (i: number) => min[0] + i * cell;
  const yOf = (j: number) => min[1] + j * cell;
  const zOf = (k: number) => min[2] + k * cell;

  // Coarse probe grid (2 cells per coarse step, padded by one on each side).
  const cf = 2;
  const pad = 1;
  const cnx = Math.ceil((nx - 1) / cf) + 1 + pad * 2;
  const cny = Math.ceil((ny - 1) / cf) + 1 + pad * 2;
  const cnz = Math.ceil((nz - 1) / cf) + 1 + pad * 2;
  const coarse = new Float32Array(cnx * cny * cnz);
  const coarseAt = (i: number, j: number, k: number) => {
    const ii = Math.min(cnx - 1, Math.max(0, i + pad));
    const jj = Math.min(cny - 1, Math.max(0, j + pad));
    const kk = Math.min(cnz - 1, Math.max(0, k + pad));
    return coarse[ii + cnx * (jj + cny * kk)];
  };
  for (let k = 0; k < cnz; k++) {
    const z = min[2] + (k - pad) * cell * cf;
    for (let j = 0; j < cny; j++) {
      const y = min[1] + (j - pad) * cell * cf;
      const rowBase = cnx * (j + cny * k);
      for (let i = 0; i < cnx; i++) {
        coarse[rowBase + i] = sdf(min[0] + (i - pad) * cell * cf, y, z);
      }
    }
  }
  netsProfile.coarse = performance.now() - T0;
  const Tf = performance.now();
  const threshold = band * cell * cf;
  for (let k = 0; k < nz; k++) {
    const gz = k / cf;
    const k0 = Math.floor(gz);
    const tz = gz - k0;
    for (let j = 0; j < ny; j++) {
      const gy = j / cf;
      const j0 = Math.floor(gy);
      const ty = gy - j0;
      const rowBase = nx * (j + ny * k);
      for (let i = 0; i < nx; i++) {
        const gx = i / cf;
        const i0 = Math.floor(gx);
        const tx = gx - i0;
        const c00 = coarseAt(i0, j0, k0) * (1 - tx) + coarseAt(i0 + 1, j0, k0) * tx;
        const c10 = coarseAt(i0, j0 + 1, k0) * (1 - tx) + coarseAt(i0 + 1, j0 + 1, k0) * tx;
        const c01 = coarseAt(i0, j0, k0 + 1) * (1 - tx) + coarseAt(i0 + 1, j0, k0 + 1) * tx;
        const c11 = coarseAt(i0, j0 + 1, k0 + 1) * (1 - tx) + coarseAt(i0 + 1, j0 + 1, k0 + 1) * tx;
        const approx = (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
        if (Math.abs(approx) > threshold) {
          field[rowBase + i] = approx;
        } else {
          field[rowBase + i] = sdf(xOf(i), yOf(j), zOf(k));
          exactCount++;
        }
      }
    }
  }

  netsProfile.fine = performance.now() - Tf;
  netsProfile.exact = exactCount;
  const Tc = performance.now();
  const cx = nx - 1;
  const cy = ny - 1;
  const cz = nz - 1;
  const cellVertex = new Int32Array(cx * cy * cz).fill(-1);
  const verts: number[] = [];
  const cornerVal = new Float64Array(8);
  const crossing: number[] = [0, 0, 0];

  for (let k = 0; k < cz; k++) {
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const o = CORNERS[c];
          const v = field[i + o[0] + nx * (j + o[1] + ny * (k + o[2]))];
          cornerVal[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let ax = 0;
        let ay = 0;
        let az = 0;
        let n = 0;
        for (let e = 0; e < 12; e++) {
          const [a, b] = EDGES[e];
          const va = cornerVal[a];
          const vb = cornerVal[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          const oa = CORNERS[a];
          const ob = CORNERS[b];
          ax += (oa[0] + (ob[0] - oa[0]) * t) * cell;
          ay += (oa[1] + (ob[1] - oa[1]) * t) * cell;
          az += (oa[2] + (ob[2] - oa[2]) * t) * cell;
          n++;
        }
        if (n === 0) continue;
        const vi = verts.length / 3;
        verts.push(xOf(i) + ax / n, yOf(j) + ay / n, zOf(k) + az / n);
        cellVertex[i + cx * (j + cy * k)] = vi;
      }
    }
  }
  // `crossing` kept for readability of the loop above
  void crossing;

  netsProfile.cells = performance.now() - Tc;
  const Tq = performance.now();
  const tris: number[] = [];
  const quad = (a: number, b: number, c: number, d: number) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    tris.push(a, b, c, a, c, d);
  };
  const cellAt = (i: number, j: number, k: number) => {
    if (i < 0 || j < 0 || k < 0 || i >= cx || j >= cy || k >= cz) return -1;
    return cellVertex[i + cx * (j + cy * k)];
  };

  // x edges
  for (let k = 1; k < cz; k++) {
    for (let j = 1; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        const a = field[i + nx * (j + ny * k)];
        const b = field[i + 1 + nx * (j + ny * k)];
        if ((a < 0) === (b < 0)) continue;
        const c00 = cellAt(i, j - 1, k - 1);
        const c10 = cellAt(i, j, k - 1);
        const c11 = cellAt(i, j, k);
        const c01 = cellAt(i, j - 1, k);
        if (a < 0) quad(c00, c10, c11, c01);
        else quad(c01, c11, c10, c00);
      }
    }
  }
  // y edges
  for (let k = 1; k < cz; k++) {
    for (let j = 0; j < cy; j++) {
      for (let i = 1; i < cx; i++) {
        const a = field[i + nx * (j + ny * k)];
        const b = field[i + nx * (j + 1 + ny * k)];
        if ((a < 0) === (b < 0)) continue;
        const c00 = cellAt(i - 1, j, k - 1);
        const c10 = cellAt(i, j, k - 1);
        const c11 = cellAt(i, j, k);
        const c01 = cellAt(i - 1, j, k);
        // Around a Y edge the (x,z) cycle winds toward -Y, so the sign rule is
        // inverted relative to the X and Z edge loops.
        if (a < 0) quad(c01, c11, c10, c00);
        else quad(c00, c10, c11, c01);
      }
    }
  }
  // z edges
  for (let k = 0; k < cz; k++) {
    for (let j = 1; j < cy; j++) {
      for (let i = 1; i < cx; i++) {
        const a = field[i + nx * (j + ny * k)];
        const b = field[i + nx * (j + ny * (k + 1))];
        if ((a < 0) === (b < 0)) continue;
        const c00 = cellAt(i - 1, j - 1, k);
        const c10 = cellAt(i, j - 1, k);
        const c11 = cellAt(i, j, k);
        const c01 = cellAt(i - 1, j, k);
        if (a < 0) quad(c00, c10, c11, c01);
        else quad(c01, c11, c10, c00);
      }
    }
  }

  netsProfile.quads = performance.now() - Tq;
  const To = performance.now();
  // The quad rule above is consistent, so one sampled gradient test decides the
  // global winding; a full per-triangle pass is only used if the sample disagrees
  // (which would indicate a mixed-winding mesh).
  const tmpPositions = new Float32Array(verts);
  const triCount = tris.length / 3;
  const agrees = (t: number): boolean | null => {
    const i0 = tris[t * 3] * 3;
    const i1 = tris[t * 3 + 1] * 3;
    const i2 = tris[t * 3 + 2] * 3;
    const ux = tmpPositions[i1] - tmpPositions[i0];
    const uy = tmpPositions[i1 + 1] - tmpPositions[i0 + 1];
    const uz = tmpPositions[i1 + 2] - tmpPositions[i0 + 2];
    const vx = tmpPositions[i2] - tmpPositions[i0];
    const vy = tmpPositions[i2 + 1] - tmpPositions[i0 + 1];
    const vz = tmpPositions[i2 + 2] - tmpPositions[i0 + 2];
    const nxv = uy * vz - uz * vy;
    const nyv = uz * vx - ux * vz;
    const nzv = ux * vy - uy * vx;
    if (nxv === 0 && nyv === 0 && nzv === 0) return null;
    const g = sdfGradient(
      sdf,
      (tmpPositions[i0] + tmpPositions[i1] + tmpPositions[i2]) / 3,
      (tmpPositions[i0 + 1] + tmpPositions[i1 + 1] + tmpPositions[i2 + 1]) / 3,
      (tmpPositions[i0 + 2] + tmpPositions[i1 + 2] + tmpPositions[i2 + 2]) / 3,
      cell,
    );
    return nxv * g[0] + nyv * g[1] + nzv * g[2] > 0;
  };
  let sampleAgree = 0;
  let sampleDisagree = 0;
  const stride = Math.max(1, Math.floor(triCount / 64));
  for (let t = 0; t < triCount; t += stride) {
    const ok = agrees(t);
    if (ok === true) sampleAgree++;
    else if (ok === false) sampleDisagree++;
  }
  const flip = sampleDisagree > sampleAgree;
  if (flip) {
    for (let t = 0; t < tris.length; t += 3) {
      const tmp = tris[t + 1];
      tris[t + 1] = tris[t + 2];
      tris[t + 2] = tmp;
    }
  }
  if (sampleAgree > 0 && sampleDisagree > 0) {
    // mixed winding: repair conservatively
    for (let t = 0; t < triCount; t++) {
      const ok = agrees(t);
      if (ok === false) {
        const tmp = tris[t * 3 + 1];
        tris[t * 3 + 1] = tris[t * 3 + 2];
        tris[t * 3 + 2] = tmp;
      }
    }
  }
  const positions = tmpPositions;
  netsProfile.orient = performance.now() - To;
  return {
    positions,
    indices: new Uint32Array(tris),
    vertexCount: positions.length / 3,
    triangleCount: tris.length / 3,
  };
}

/** Build 1-ring CSR adjacency for a triangle mesh. */
export function buildAdjacency(vertexCount: number, indices: Uint32Array): { start: Uint32Array; list: Uint32Array } {
  const degree = new Uint32Array(vertexCount + 1);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    degree[a] += 2;
    degree[b] += 2;
    degree[c] += 2;
  }
  const start = new Uint32Array(vertexCount + 1);
  let acc = 0;
  for (let v = 0; v < vertexCount; v++) {
    start[v] = acc;
    acc += degree[v];
  }
  start[vertexCount] = acc;
  const list = new Uint32Array(acc);
  const cursor = start.slice(0, vertexCount);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    list[cursor[a]++] = b;
    list[cursor[a]++] = c;
    list[cursor[b]++] = c;
    list[cursor[b]++] = a;
    list[cursor[c]++] = a;
    list[cursor[c]++] = b;
  }
  return { start, list };
}

/** Laplacian smoothing of a point set (in place), preserving position count. */
export function laplacianSmooth(positions: Float32Array, indices: Uint32Array, iterations: number, lambda = 0.5): void {
  const n = positions.length / 3;
  const adj = buildAdjacency(n, indices);
  const tmp = new Float32Array(n * 3);
  for (let it = 0; it < iterations; it++) {
    tmp.set(positions);
    for (let v = 0; v < n; v++) {
      const a = adj.start[v];
      const b = adj.start[v + 1];
      if (b === a) continue;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let count = 0;
      for (let i = a; i < b; i++) {
        const u = adj.list[i] * 3;
        sx += tmp[u];
        sy += tmp[u + 1];
        sz += tmp[u + 2];
        count++;
      }
      positions[v * 3] = tmp[v * 3] + (sx / count - tmp[v * 3]) * lambda;
      positions[v * 3 + 1] = tmp[v * 3 + 1] + (sy / count - tmp[v * 3 + 1]) * lambda;
      positions[v * 3 + 2] = tmp[v * 3 + 2] + (sz / count - tmp[v * 3 + 2]) * lambda;
    }
  }
}
