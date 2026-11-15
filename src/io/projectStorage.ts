import type { CharacterRecipeV1 } from '../core/recipe';
import { validateCharacterRecipe } from '../core/recipe';

const DB_NAME = 'dex-sculpt-storage';
const STORE_NAME = 'autosave';
const MAX_STORED_SOURCE_BYTES = 64 * 1024 * 1024; // 64 MB local browser quota guard

export interface LocalProjectBundle {
  recipe: CharacterRecipeV1;
  /** Optional local GLB bytes cached locally in IndexedDB for seamless reload (never uploaded). */
  sourceGlbBytes?: ArrayBuffer;
  savedAt: string;
}

interface AutosaveSlotRecord {
  seq: number;
  savedAt: string;
  checksum: string;
  recipeJson: string;
  sourceGlbBytes?: Uint8Array;
}

interface HeadPointer {
  slot: 'A' | 'B';
  seq: number;
}

function fnv1aString(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbTx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest | void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_NAME, mode);
    const store = t.objectStore(STORE_NAME);
    const req = fn(store);
    t.oncomplete = () => resolve(req ? (req as IDBRequest).result : (undefined as T));
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * Crash-safe alternating A/B autosave in IndexedDB.
 * Writes the new slot completely before committing the `head` pointer in a separate transaction.
 */
export async function saveAutosaveProject(
  recipe: CharacterRecipeV1,
  sourceGlbBytes?: ArrayBuffer
): Promise<{ slot: 'A' | 'B'; seq: number; cachedSourceBytes: boolean }> {
  const db = await openDb();
  try {
    const head = await idbTx<HeadPointer | undefined>(db, 'readonly', (s) => s.get('head'));
    const slot: 'A' | 'B' = head?.slot === 'A' ? 'B' : 'A';
    const seq = (head?.seq ?? 0) + 1;
    const recipeJson = JSON.stringify(recipe);
    const canCacheBytes =
      sourceGlbBytes &&
      sourceGlbBytes.byteLength > 0 &&
      sourceGlbBytes.byteLength <= MAX_STORED_SOURCE_BYTES;

    const record: AutosaveSlotRecord = {
      seq,
      savedAt: new Date().toISOString(),
      checksum: fnv1aString(recipeJson),
      recipeJson,
      ...(canCacheBytes ? { sourceGlbBytes: new Uint8Array(sourceGlbBytes) } : {})
    };

    await idbTx(db, 'readwrite', (s) => s.put(record, slot));
    await idbTx(db, 'readwrite', (s) => s.put({ slot, seq } satisfies HeadPointer, 'head'));
    return { slot, seq, cachedSourceBytes: !!canCacheBytes };
  } finally {
    db.close();
  }
}

export async function recoverAutosaveProject(): Promise<{
  bundle: LocalProjectBundle;
  slot: 'A' | 'B';
  fellBack: boolean;
} | null> {
  const db = await openDb();
  try {
    const head = await idbTx<HeadPointer | undefined>(db, 'readonly', (s) => s.get('head'));
    const order: ('A' | 'B')[] = head?.slot === 'B' ? ['B', 'A'] : ['A', 'B'];
    for (let i = 0; i < order.length; i++) {
      const slot = order[i];
      const rec = await idbTx<AutosaveSlotRecord | undefined>(db, 'readonly', (s) => s.get(slot));
      if (!rec) continue;
      try {
        if (fnv1aString(rec.recipeJson) !== rec.checksum) {
          throw new Error('Autosave checksum mismatch');
        }
        const recipe = validateCharacterRecipe(JSON.parse(rec.recipeJson));
        const sourceGlbBytes = rec.sourceGlbBytes
          ? rec.sourceGlbBytes.buffer.slice(
              rec.sourceGlbBytes.byteOffset,
              rec.sourceGlbBytes.byteOffset + rec.sourceGlbBytes.byteLength
            )
          : undefined;
        return {
          bundle: { recipe, sourceGlbBytes: sourceGlbBytes as ArrayBuffer | undefined, savedAt: rec.savedAt },
          slot,
          fellBack: i > 0
        };
      } catch {
        // Fall back to alternate slot
      }
    }
    return null;
  } finally {
    db.close();
  }
}

export async function clearAutosaveProject(): Promise<void> {
  const db = await openDb();
  try {
    await idbTx(db, 'readwrite', (s) => s.clear());
  } finally {
    db.close();
  }
}

export function serializeRecipeJson(recipe: CharacterRecipeV1): string {
  return JSON.stringify(recipe, null, 2);
}

export function parseRecipeJson(text: string): CharacterRecipeV1 {
  return validateCharacterRecipe(JSON.parse(text));
}
