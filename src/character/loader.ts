/**
 * Character import: GLB / glTF → Character.
 *
 * Everything enters through this single path — bundled examples, the file picker
 * and (in tests) in-memory fixtures — so the editor always works against the same
 * post-import representation.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { bytesFingerprint } from './manifest';
import { Character, type CharacterMeta } from './character';

export class ImportError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface LoadedCharacter {
  character: Character;
  gltf: { scene: THREE.Group; animations: THREE.AnimationClip[] };
}

const MAX_IMPORT_BYTES = 120 * 1024 * 1024;

export async function loadCharacter(
  bytes: ArrayBuffer,
  meta: CharacterMeta,
  onProgress?: (message: string) => void,
): Promise<Character> {
  if (bytes.byteLength === 0) throw new ImportError('The file is empty');
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new ImportError(`File is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; the import limit is 120 MB`);
  }
  const header = new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength));
  const magic = header.length >= 4 ? new DataView(bytes, 0, 4).getUint32(0, true) : 0;
  if (magic !== 0x46546c67) {
    // glTF JSON? Detect and explain rather than failing opaquely.
    const first = new TextDecoder().decode(header).trimStart();
    if (first.startsWith('{')) {
      throw new ImportError('This is a .gltf (JSON) file. Export it as a single .glb before importing.');
    }
    throw new ImportError('Not a GLB file: the glTF binary magic header is missing.');
  }

  onProgress?.('Reading glTF…');
  const loader = new GLTFLoader();
  let gltf: Awaited<ReturnType<GLTFLoader['parseAsync']>>;
  try {
    gltf = await loader.parseAsync(bytes.slice(0), '');
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    if (/DRACO|KHR_draco/i.test(message)) {
      throw new ImportError('This file uses Draco compression, which DEX//SCULPT does not decode. Re-export without Draco.', error);
    }
    if (/meshopt|EXT_meshopt/i.test(message)) {
      throw new ImportError('This file uses meshopt compression, which DEX//SCULPT does not decode. Re-export without meshopt.', error);
    }
    throw new ImportError(`Could not read the glTF file: ${message}`, error);
  }

  const scene = gltf.scene as THREE.Group;
  if (!scene) throw new ImportError('The file contains no scene');
  scene.updateMatrixWorld(true);
  if (!scene.children.length) throw new ImportError('The scene is empty');
  let hasMesh = false;
  scene.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) hasMesh = true;
  });
  if (!hasMesh) throw new ImportError('The file contains no mesh geometry');

  onProgress?.('Building rig-safe edit state…');
  const resolvedMeta: CharacterMeta = {
    ...meta,
    byteLength: bytes.byteLength,
    fileHash: bytesFingerprint(bytes),
    glbBytes: bytes,
  };
  const character = new Character(scene, gltf.animations ?? [], resolvedMeta);
  if (!character.meshes.length) throw new ImportError('The GLB parsed but no usable mesh was found');
  return character;
}

export async function loadCharacterFromFile(file: File, catalogId?: string): Promise<Character> {
  const bytes = await file.arrayBuffer();
  return loadCharacter(bytes, {
    sourceKind: 'import',
    fileName: file.name,
    catalogId,
    license: 'User-supplied file — verify its licence before redistributing exports.',
    provenance: 'Local file import',
  });
}
