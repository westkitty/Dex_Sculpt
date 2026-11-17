/** Portable, render-vertex-space DNA model. No mutation of source geometry. */
import type { CharacterRecipeV1 } from './recipe';

export interface MeshSource { id: string; positions: ArrayLike<number> }
export interface Layer { id: string; name: string; visible: boolean; strength: number; deltas: Record<string, number[]> }
export interface Variant { id: string; name: string; layers: Layer[]; morphWeights: CharacterRecipeV1['morphWeights']; materialOverrides: CharacterRecipeV1['materialOverrides']; attachments: CharacterRecipeV1['attachments']; configuration: Record<string, unknown> }
export interface Dna { schema: 'dexsculpt.dna.v2'; sourceSha256: string; activeId: string; variants: Variant[] }
const copy = <T>(x: T): T => structuredClone(x);
function allFinite(a: ArrayLike<number>): boolean {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}

/** Path of child indices from the imported scene root; independent of display names.
 * Paths are valid only for the exact same source bytes and scene ordering. */
export function meshPath(indices: number[]): string {
  if (indices.some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('Invalid mesh path');
  return 'root/' + indices.join('/');
}

/**
 * Deterministic composition: always accumulates from the immutable source in a
 * fixed layer order using float64 accumulators, then stores float32 once per
 * component. Repeated recomposition is bit-identical and bounded against
 * floating-point drift (state is never accumulated onto a previous result).
 */
export function compose(source: MeshSource[], layers: Layer[]): Record<string, Float32Array> {
  const result: Record<string, Float32Array> = Object.create(null);
  const accum: Record<string, Float64Array> = Object.create(null);
  for (const mesh of source) {
    if (Object.hasOwn(result, mesh.id) || mesh.positions.length % 3 || !allFinite(mesh.positions)) throw new Error('Invalid source mesh');
    const base = Float64Array.from(mesh.positions);
    accum[mesh.id] = base;
    result[mesh.id] = Float32Array.from(base);
  }
  for (const layer of layers) {
    if (!Number.isFinite(layer.strength) || layer.strength < 0 || layer.strength > 1) throw new Error('Invalid layer strength');
    for (const [id, delta] of Object.entries(layer.deltas)) {
      const dest = accum[id];
      if (!dest || delta.length !== dest.length || !allFinite(delta)) throw new Error('Invalid layer delta');
      if (layer.visible) {
        for (let i = 0; i < dest.length; i++) dest[i] += delta[i] * layer.strength;
      }
    }
  }
  for (const [id, acc] of Object.entries(accum)) {
    const out = result[id];
    for (let i = 0; i < out.length; i++) out[i] = acc[i];
  }
  return result;
}

/** Migration fails closed for duplicate mesh names; never guess a correspondence. */
export function migrateRecipe(recipe: CharacterRecipeV1, meshes: { id: string; name: string; vertexCount: number }[]): Dna {
  if (!/^[a-f0-9]{64}$/i.test(recipe.source.sha256)) throw new Error('A real SHA-256 source identity is required');
  const deltas: Record<string, number[]> = Object.create(null);
  for (const entry of recipe.sculptDeltas) {
    const matches = meshes.filter(m => m.name === entry.meshName);
    if (matches.length !== 1 || matches[0].vertexCount !== entry.vertexCount) throw new Error(`Ambiguous or mismatched mesh: ${entry.meshName}`);
    const mesh = matches[0];
    if (Object.hasOwn(deltas, mesh.id) || entry.deltas.length !== entry.indices.length * 3) throw new Error('Invalid legacy delta');
    const dense = new Array<number>(mesh.vertexCount * 3).fill(0);
    const seen = new Set<number>();
    entry.indices.forEach((index, i) => {
      if (!Number.isInteger(index) || index < 0 || index >= mesh.vertexCount || seen.has(index)) throw new Error('Invalid legacy vertex index');
      seen.add(index);
      for (let c = 0; c < 3; c++) { const n = entry.deltas[i * 3 + c]; if (!Number.isFinite(n)) throw new Error('Invalid legacy delta'); dense[index * 3 + c] = n; }
    });
    deltas[mesh.id] = dense;
  }
  return { schema: 'dexsculpt.dna.v2', sourceSha256: recipe.source.sha256.toLowerCase(), activeId: 'original', variants: [{ id: 'original', name: recipe.title, layers: [{id: 'legacy', name: 'Imported V1 sculpt', visible: true, strength: 1, deltas}], morphWeights: copy(recipe.morphWeights), materialOverrides: copy(recipe.materialOverrides), attachments: copy(recipe.attachments), configuration: {} }] };
}

/** Full structural + composition validation of a DNA document against its source meshes. */
export function validateDna(source: MeshSource[], dna: Dna, hash: string): void {
  if (dna.schema !== 'dexsculpt.dna.v2' || !/^[a-f0-9]{64}$/.test(hash) || dna.sourceSha256 !== hash || !Array.isArray(dna.variants) || !dna.variants.length) throw new Error('Invalid DNA or source identity');
  const ids = new Set<string>();
  for (const v of dna.variants) {
    if (!v.id || !v.name.trim() || ids.has(v.id) || !Array.isArray(v.layers)) throw new Error('Invalid variant');
    ids.add(v.id); const layerIds = new Set<string>();
    for (const l of v.layers) { if (!l.id || !l.name.trim() || layerIds.has(l.id) || typeof l.visible !== 'boolean') throw new Error('Invalid layer'); layerIds.add(l.id); }
    compose(source, v.layers);
  }
  if (!ids.has(dna.activeId)) throw new Error('Missing active variant');
}

/** Transactions are validated before committing; callers never receive mutable internal state.
 * Undo/redo stacks are bounded (`maxEntries`), so long sessions cannot grow without limit. */
export class DnaHistory {
  private current: Dna;
  private undoStack: Dna[] = [];
  private redoStack: Dna[] = [];
  constructor(private readonly source: MeshSource[], dna: Dna, expectedHash: string, private readonly maxEntries = 128) {
    this.source = copy(source); this.current = copy(dna); this.validate(this.current, expectedHash);
  }
  private validate(dna: Dna, hash = this.current.sourceSha256): void {
    validateDna(this.source, dna, hash);
  }
  snapshot(): Dna { return copy(this.current); }
  /** Validate + apply a mutation without touching the undo stacks (for externally managed histories). */
  apply(fn: (draft: Dna) => void): void {
    const draft = copy(this.current); fn(draft); this.validate(draft);
    this.current = draft;
  }
  edit(fn: (draft: Dna) => void): void {
    const draft = copy(this.current); fn(draft); this.validate(draft);
    this.undoStack.push(this.current); this.current = draft; this.redoStack = [];
    while (this.undoStack.length > this.maxEntries && this.undoStack.length > 1) this.undoStack.shift();
    while (this.redoStack.length > this.maxEntries) this.redoStack.shift();
  }
  undo(): boolean {
    const prior = this.undoStack.pop(); if (!prior) return false;
    this.redoStack.push(this.current); this.current = prior;
    while (this.redoStack.length > this.maxEntries) this.redoStack.shift();
    return true;
  }
  redo(): boolean {
    const next = this.redoStack.pop(); if (!next) return false;
    this.undoStack.push(this.current); this.current = next;
    while (this.undoStack.length > this.maxEntries && this.undoStack.length > 1) this.undoStack.shift();
    return true;
  }
  geometry(id = this.current.activeId): Record<string, Float32Array> {
    const v = this.current.variants.find(x => x.id === id); if (!v) throw new Error('Unknown variant'); return compose(this.source, v.layers);
  }
}
