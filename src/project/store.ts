/**
 * Local project persistence (IndexedDB, no backend, no telemetry).
 *
 * A project stores the recipe *and* the original source bytes, so reopening a
 * project restores the exact character without needing the original file again.
 * If IndexedDB is unavailable (private mode, tests), the store degrades to an
 * in-memory store and says so instead of pretending to save.
 */
import type { CharacterRecipe } from './recipe';

const DB_NAME = 'dexsculpt';
const DB_VERSION = 1;
const STORE = 'projects';

export interface ProjectRecord {
  id: string;
  name: string;
  updatedAt: string;
  recipe: CharacterRecipe;
  sourceBytes?: ArrayBuffer;
  sourceFileName?: string;
  sourceHash?: string;
  attachmentBlobs: { id: string; name: string; bytes: ArrayBuffer }[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  hasSource: boolean;
  sourceFileName?: string;
  sculptGroups: number;
  sourceBytes?: number;
}

export type StoreMode = 'indexeddb' | 'memory';

export class ProjectStore {
  private db: IDBDatabase | null = null;
  private memory = new Map<string, ProjectRecord>();
  mode: StoreMode = 'memory';
  lastError: string | null = null;

  async open(): Promise<StoreMode> {
    if (typeof indexedDB === 'undefined') {
      this.mode = 'memory';
      this.lastError = 'IndexedDB is not available in this context; projects are kept in memory only.';
      return this.mode;
    }
    try {
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
        request.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
      });
      this.mode = 'indexeddb';
      this.lastError = null;
    } catch (error) {
      this.mode = 'memory';
      this.lastError = `IndexedDB unavailable: ${(error as Error).message}. Projects are kept in memory only.`;
    }
    return this.mode;
  }

  async save(record: ProjectRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
    if (this.db) {
      await new Promise<void>((resolve, reject) => {
        const tx = this.db!.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
      }).catch((error) => {
        this.memory.set(record.id, record);
        this.lastError = `IndexedDB write failed (${(error as Error).message}); kept in memory for this session.`;
      });
      return;
    }
    this.memory.set(record.id, record);
  }

  async get(id: string): Promise<ProjectRecord | null> {
    if (this.db) {
      const record = await new Promise<ProjectRecord | null>((resolve, reject) => {
        const tx = this.db!.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).get(id);
        request.onsuccess = () => resolve((request.result as ProjectRecord) ?? null);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
      }).catch(() => this.memory.get(id) ?? null);
      return record ?? this.memory.get(id) ?? null;
    }
    return this.memory.get(id) ?? null;
  }

  async list(): Promise<ProjectSummary[]> {
    let records: ProjectRecord[];
    if (this.db) {
      records = await new Promise<ProjectRecord[]>((resolve, reject) => {
        const tx = this.db!.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).getAll();
        request.onsuccess = () => resolve((request.result as ProjectRecord[]) ?? []);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB list failed'));
      }).catch(() => [...this.memory.values()]);
      for (const record of this.memory.values()) {
        if (!records.some((r) => r.id === record.id)) records.push(record);
      }
    } else {
      records = [...this.memory.values()];
    }
    return records
      .map((r) => ({
        id: r.id,
        name: r.name,
        updatedAt: r.updatedAt,
        hasSource: !!r.sourceBytes,
        sourceFileName: r.sourceFileName,
        sculptGroups: r.recipe?.sculpt?.reduce((a, c) => a + c.count, 0) ?? 0,
        sourceBytes: r.sourceBytes?.byteLength,
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async remove(id: string): Promise<void> {
    this.memory.delete(id);
    if (!this.db) return;
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'));
    }).catch(() => undefined);
  }
}
