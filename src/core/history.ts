import type { SculptMesh } from './topology';

/** A reversible edit entry for strokes, masks, morph sliders, materials, and attachments. */
export interface HistoryEntry {
  label: string;
  bytes: number;
  undo(): void;
  redo(): void;
}

/** Records the pre-stroke xyz + mask state of every unique vertex touched during a stroke. */
export class StrokeRecorder {
  private seen: Uint8Array;
  private idx: number[] = [];
  private before: number[] = [];

  constructor(
    public mesh: SculptMesh,
    public label: string
  ) {
    this.seen = new Uint8Array(mesh.vertCount);
  }

  touch(verts: ArrayLike<number>, count: number): void {
    const m = this.mesh;
    for (let i = 0; i < count; i++) {
      const v = verts[i];
      if (this.seen[v]) continue;
      this.seen[v] = 1;
      this.idx.push(v);
      this.before.push(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2], m.mask[v]);
    }
  }

  get touchedCount(): number {
    return this.idx.length;
  }

  touched(): Uint32Array {
    return Uint32Array.from(this.idx);
  }

  /** Restore every touched vertex to its exact pre-stroke bytes. */
  cancel(): Uint32Array {
    const m = this.mesh;
    for (let i = 0; i < this.idx.length; i++) {
      const v = this.idx[i];
      m.pos[v * 3] = this.before[i * 4];
      m.pos[v * 3 + 1] = this.before[i * 4 + 1];
      m.pos[v * 3 + 2] = this.before[i * 4 + 2];
      m.mask[v] = this.before[i * 4 + 3];
    }
    return this.touched();
  }

  /** Build a compact reversible history entry if any vertex changed. */
  commit(apply: (verts: Uint32Array) => void): HistoryEntry | null {
    const m = this.mesh;
    const n = this.idx.length;
    if (!n) return null;
    const idx = Uint32Array.from(this.idx);
    const before = Float32Array.from(this.before);
    const after = new Float32Array(n * 4);
    let changed = false;
    for (let i = 0; i < n; i++) {
      const v = idx[i];
      after[i * 4] = m.pos[v * 3];
      after[i * 4 + 1] = m.pos[v * 3 + 1];
      after[i * 4 + 2] = m.pos[v * 3 + 2];
      after[i * 4 + 3] = m.mask[v];
      for (let k = 0; k < 4; k++) {
        if (after[i * 4 + k] !== before[i * 4 + k]) changed = true;
      }
    }
    if (!changed) return null;
    const write = (src: Float32Array) => {
      for (let i = 0; i < n; i++) {
        const v = idx[i];
        m.pos[v * 3] = src[i * 4];
        m.pos[v * 3 + 1] = src[i * 4 + 1];
        m.pos[v * 3 + 2] = src[i * 4 + 2];
        m.mask[v] = src[i * 4 + 3];
      }
      apply(idx);
    };
    return {
      label: this.label,
      bytes: idx.byteLength + before.byteLength + after.byteLength,
      undo: () => write(before),
      redo: () => write(after)
    };
  }
}

export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  bytes = 0;
  onChange: () => void = () => {};

  constructor(
    public maxBytes = 256 * 1024 * 1024,
    public maxEntries = 200
  ) {}

  push(entry: HistoryEntry | null): void {
    if (!entry) return;
    this.undoStack.push(entry);
    this.bytes += entry.bytes;
    for (const r of this.redoStack) this.bytes -= r.bytes;
    this.redoStack = [];
    while ((this.bytes > this.maxBytes || this.undoStack.length > this.maxEntries) && this.undoStack.length > 1) {
      const old = this.undoStack.shift()!;
      this.bytes -= old.bytes;
    }
    this.onChange();
  }

  undo(): boolean {
    const e = this.undoStack.pop();
    if (!e) return false;
    e.undo();
    this.redoStack.push(e);
    this.onChange();
    return true;
  }

  redo(): boolean {
    const e = this.redoStack.pop();
    if (!e) return false;
    e.redo();
    this.undoStack.push(e);
    this.onChange();
    return true;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.bytes = 0;
    this.onChange();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get depth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  peekLabel(): string {
    return this.undoStack[this.undoStack.length - 1]?.label ?? '';
  }

  peekRedoLabel(): string {
    return this.redoStack[this.redoStack.length - 1]?.label ?? '';
  }
}
