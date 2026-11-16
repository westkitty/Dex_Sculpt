import { sha256Hex as sha256HexPure } from '../core/sha256';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { ensureEditableVertexBuffers } from '../core/rigSafeSculpt';
import { validateGlbBinary, type GlbValidationReport } from './glbValidator';

export type ImportKind = 'glb' | 'gltf' | 'obj' | 'stl';
export const IMPORT_ACCEPT = '.glb,.gltf,.obj,.stl';
export const MAX_IMPORT_BYTES = 512 * 1024 * 1024;

export interface ImportedCharacterAsset {
  root: THREE.Group;
  animations: THREE.AnimationClip[];
  sourceFormat: ImportKind;
  isRigged: boolean;
  warnings: string[];
  /** SHA-256 hex digest of source file bytes (when available) */
  sha256: string;
}

export function kindOfFile(name: string): ImportKind | null {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'glb' || ext === 'gltf' || ext === 'obj' || ext === 'stl') return ext;
  return null;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return sha256HexPure(bytes);
}

/**
 * Rig-safe character importer.
 * Unlike FORM//ENGINE 0.2.0, this NEVER rebuilds BufferGeometry from scratch or
 * strips skinIndex, skinWeight, morphAttributes, skeletons, or AnimationClips.
 */
export async function importCharacterBytes(
  fileName: string,
  data: ArrayBuffer
): Promise<ImportedCharacterAsset> {
  const kind = kindOfFile(fileName);
  if (!kind) throw new Error(`Unsupported model format: ${fileName}`);
  if (data.byteLength > MAX_IMPORT_BYTES) {
    throw new Error(`File exceeds ${MAX_IMPORT_BYTES / (1024 * 1024)} MB safety cap`);
  }

  const warnings: string[] = [];
  let root: THREE.Group;
  let animations: THREE.AnimationClip[] = [];

  if (kind === 'glb' || kind === 'gltf') {
    const loader = new GLTFLoader();
    try {
      const gltf = await loader.parseAsync(data, '');
      root = new THREE.Group();
      root.name = gltf.scene.name || fileName.replace(/\.(glb|gltf)$/i, '');
      while (gltf.scene.children.length > 0) {
        root.add(gltf.scene.children[0]);
      }
      animations = gltf.animations ?? [];
    } catch (err) {
      if (kind === 'gltf') {
        throw new Error(
          `Failed to parse .gltf (${(err as Error).message}). Self-contained .glb is recommended because external .bin/texture URIs cannot resolve from a single-file pick.`
        );
      }
      throw err;
    }
  } else if (kind === 'obj') {
    root = new OBJLoader().parse(new TextDecoder().decode(data));
    warnings.push('OBJ format does not carry skeletons, skin weights, morph targets, or animations (static mesh mode).');
  } else {
    const geo = new STLLoader().parse(data);
    root = new THREE.Group();
    root.name = fileName.replace(/\.stl$/i, '');
    root.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xbcb8b1, roughness: 0.65 })));
    warnings.push('STL format has no skeletons, skin weights, UVs, morph targets, or animations (static mesh mode).');
  }

  let meshCount = 0;
  let isRigged = false;

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshCount++;
    ensureEditableVertexBuffers(mesh.geometry);
    const skinned = obj as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh && skinned.skeleton) {
      isRigged = true;
      skinned.skeleton.pose();
    }
  });

  if (meshCount === 0) {
    throw new Error('Model contains no renderable mesh geometry');
  }

  root.updateMatrixWorld(true);
  const sha256 = await sha256Hex(data);

  return {
    root,
    animations,
    sourceFormat: kind,
    isRigged,
    warnings,
    sha256
  };
}

export interface ExportGlbResult {
  glb: ArrayBuffer;
  validation: GlbValidationReport;
}

/**
 * Exports the character root + animation clips to GLB 2.0 while preserving:
 * - Skeleton hierarchy & inverse bind matrices (temporarily resets to bind pose for export)
 * - JOINTS_0 & WEIGHTS_0
 * - Morph targets & weights
 * - UVs, materials, textures, and AnimationClips
 *
 * Also temporarily strips editor-only `sculptMask` attributes so exports stay clean.
 */
export async function exportRigSafeGlb(
  root: THREE.Object3D,
  animations: THREE.AnimationClip[],
  options?: { resetToBindPose?: boolean }
): Promise<ExportGlbResult> {
  const resetToBindPose = options?.resetToBindPose ?? true;

  // Save current bone transforms & temporarily detach editor-only attributes
  const savedBoneTransforms: Array<{
    bone: THREE.Bone;
    pos: THREE.Vector3;
    quat: THREE.Quaternion;
    scale: THREE.Vector3;
  }> = [];
  const savedMaskAttrs: Array<{ geo: THREE.BufferGeometry; attr: THREE.BufferAttribute }> = [];
  const skinnedMeshes: THREE.SkinnedMesh[] = [];
  const savedMorphInfluences: Array<{ mesh: THREE.Mesh; influences: number[] }> = [];

  root.traverse((obj) => {
    const skinned = obj as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh && skinned.skeleton) {
      skinnedMeshes.push(skinned);
      if (resetToBindPose) {
        for (const bone of skinned.skeleton.bones) {
          savedBoneTransforms.push({
            bone,
            pos: bone.position.clone(),
            quat: bone.quaternion.clone(),
            scale: bone.scale.clone()
          });
        }
      }
    }
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      const maskAttr = mesh.geometry.getAttribute('sculptMask') as THREE.BufferAttribute | undefined;
      if (maskAttr) {
        savedMaskAttrs.push({ geo: mesh.geometry, attr: maskAttr });
        mesh.geometry.deleteAttribute('sculptMask');
      }
      if (mesh.morphTargetInfluences) {
        savedMorphInfluences.push({
          mesh,
          influences: [...mesh.morphTargetInfluences]
        });
      }
    }
  });

  try {
    if (resetToBindPose) {
      for (const sm of skinnedMeshes) {
        sm.skeleton.pose();
      }
    }
    root.updateMatrixWorld(true);

    const exporter = new GLTFExporter();
    const glb = (await exporter.parseAsync(root, {
      binary: true,
      animations,
      onlyVisible: true
    })) as ArrayBuffer;

    const validation = validateGlbBinary(glb);
    return { glb, validation };
  } finally {
    for (const { geo, attr } of savedMaskAttrs) {
      geo.setAttribute('sculptMask', attr);
    }
    for (const saved of savedBoneTransforms) {
      saved.bone.position.copy(saved.pos);
      saved.bone.quaternion.copy(saved.quat);
      saved.bone.scale.copy(saved.scale);
    }
    for (const { mesh, influences } of savedMorphInfluences) {
      if (mesh.morphTargetInfluences) {
        for (let i = 0; i < influences.length; i++) {
          mesh.morphTargetInfluences[i] = influences[i];
        }
      }
    }
    root.updateMatrixWorld(true);
  }
}
