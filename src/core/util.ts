/**
 * Small, dependency-free numeric helpers shared by the geometry, sculpt,
 * validation and project layers. No Three.js, no DOM — safe to unit test in Node.
 */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Smooth bell falloff: 1 at the centre, 0 at the rim, zero slope at both ends. */
export function falloff(t: number): number {
  if (t >= 1) return 0;
  const u = 1 - t * t;
  return u * u;
}

/** Distance from point p to segment ab (all in the same space). */
export function distToSegment(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 0 ? (apx * abx + apy * aby + apz * abz) / len2 : 0;
  t = clamp(t, 0, 1);
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  const dz = apz - abz * t;
  return Math.hypot(dx, dy, dz);
}

/** FNV-1a 32-bit over bytes; used for cheap content fingerprints. */
export function fnv1a32(bytes: Uint8Array, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Stable hex fingerprint of any typed array / byte buffer. */
export function hashBytes(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x84222325;
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i];
    a ^= v;
    a = Math.imul(a, 0x01000193) >>> 0;
    b ^= (v + i) & 0xff;
    b = Math.imul(b, 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** Fingerprint a length-declared typed array (length is folded in so 0-length differs from 1 zero). */
export function hashArray(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  return `${bytes.byteLength}:${hashBytes(bytes)}`;
}

export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Round to n significant digits — used to keep recipe JSON compact and diffable. */
export function sig(v: number, digits = 6): number {
  if (!Number.isFinite(v)) return 0;
  if (v === 0) return 0;
  const m = Math.pow(10, digits - Math.ceil(Math.log10(Math.abs(v))));
  return Math.round(v * m) / m;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(2)}s`;
}

export function timeStamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

/** Union-find with path compression over integer ids. */
export class UnionFind {
  private parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(a: number): number {
    let p = this.parent;
    let root = a;
    while (p[root] !== root) root = p[root];
    while (p[a] !== root) {
      const next = p[a];
      p[a] = root;
      a = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}
