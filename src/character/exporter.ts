/**
 * Rig-safe GLB export.
 *
 * The exported scene is a skeleton-aware clone of the character in which every
 * mesh receives a *new geometry that shares every attribute except POSITION*
 * (positions become base + sculpt delta, normals are refreshed). JOINTS_0,
 * WEIGHTS_0, TEXCOORD_0, morph target deltas, material groups and the skeleton's
 * inverse bind matrices are carried across untouched, so the exported file
 * deforms exactly like the edited character.
 *
 * Export is gated by a preflight check; if the character cannot be exported
 * without losing rig data the call throws instead of writing a broken file.
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Character, MeshRecord } from './character';
import { validateExportedGLB, type ValidationReport } from '../validation/validateExport';

export class ExportBlockedError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`Export blocked: ${reasons.join('; ')}`);
    this.name = 'ExportBlockedError';
  }
}

export interface PreflightResult {
  ok: boolean;
  reasons: string[];
  notes: string[];
}

export function preflightExport(character: Character): PreflightResult {
  const reasons: string[] = [];
  const notes: string[] = [];
  if (!character.meshes.length) reasons.push('No meshes are loaded');
  for (const rec of character.meshes) {
    const live = rec.positionAttr.array as Float32Array;
    for (let i = 0; i < live.length; i++) {
      if (!Number.isFinite(live[i])) {
        reasons.push(`Mesh "${rec.name}" has non-finite vertex positions`);
        break;
      }
    }
    for (let i = 0; i < rec.delta.length; i++) {
      if (!Number.isFinite(rec.delta[i])) {
        reasons.push(`Mesh "${rec.name}" has a non-finite sculpt delta`);
        break;
      }
    }
    const morphs = rec.mesh.geometry.morphAttributes.position ?? [];
    for (const attr of morphs) {
      if (attr.count !== rec.vertexCount) {
        reasons.push(`Mesh "${rec.name}" has a morph target with ${attr.count} vertices (expected ${rec.vertexCount})`);
      }
    }
    if (!rec.skinned) continue;
    const geometry = rec.mesh.geometry;
    const joints = geometry.getAttribute('skinIndex');
    const weights = geometry.getAttribute('skinWeight');
    if (!joints || !weights) {
      reasons.push(`Mesh "${rec.name}" is skinned but is missing JOINTS_0/WEIGHTS_0`);
      continue;
    }
    if (rec.maxInfluences > 4) reasons.push(`Mesh "${rec.name}" uses ${rec.maxInfluences} bone influences (glTF supports 4)`);
    if (rec.weightSumMaxError > 2e-3) {
      reasons.push(`Mesh "${rec.name}" has weights that do not sum to 1 (max error ${rec.weightSumMaxError.toExponential(2)})`);
    }
    const skeleton = (rec.mesh as THREE.SkinnedMesh).skeleton;
    if (!skeleton) {
      reasons.push(`Mesh "${rec.name}" has no skeleton object`);
      continue;
    }
    if (skeleton.boneInverses.length !== skeleton.bones.length) {
      reasons.push(`Mesh "${rec.name}" has ${skeleton.boneInverses.length} inverse bind matrices for ${skeleton.bones.length} bones`);
    }
    if (skeleton.bones.length === 0) reasons.push(`Mesh "${rec.name}" has an empty skeleton`);
    if (!rec.hasUVs) notes.push(`Mesh "${rec.name}" has no UV set — exported as-is`);
  }
  if (character.meshes.length > 1) notes.push(`${character.meshes.length} meshes share the exported skeleton graph`);
  return { ok: reasons.length === 0, reasons, notes };
}

export interface ExportOptions {
  includeAnimation?: boolean;
  includeAttachments?: boolean;
  fileName?: string;
}

export interface ExportResult {
  bytes: ArrayBuffer;
  report: ValidationReport;
  fileName: string;
  scenes: number;
}

/** Build the export-time geometry for one mesh: new POSITION, everything else shared. */
export function buildExportGeometry(rec: MeshRecord): THREE.BufferGeometry {
  const source = rec.mesh.geometry;
  const geometry = new THREE.BufferGeometry();
  geometry.name = `${rec.name}_export`;

  const positionArray = new Float32Array(rec.positionAttr.array as Float32Array);
  geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
  const normalAttr = source.getAttribute('normal');
  if (normalAttr && rec.normalAttr) {
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(rec.normalAttr.array as Float32Array), 3));
  }
  for (const [name, attr] of Object.entries(source.attributes)) {
    if (name === 'position' || name === 'normal') continue;
    const sourceAttr = attr as THREE.BufferAttribute;
    const clone = new THREE.BufferAttribute(
      (sourceAttr.array as Float32Array).slice(),
      sourceAttr.itemSize,
      sourceAttr.normalized,
    );
    geometry.setAttribute(name, clone);
  }
  const index = source.getIndex();
  if (index) {
    const IndexCtor = index.array.constructor as { new (data: ArrayLike<number>): THREE.TypedArray };
    geometry.setIndex(new THREE.BufferAttribute(new IndexCtor(index.array as ArrayLike<number>), 1));
  }
  for (const group of source.groups) geometry.addGroup(group.start, group.count, group.materialIndex ?? 0);

  const morphAttributes = source.morphAttributes;
  if (morphAttributes && Object.keys(morphAttributes).length) {
    geometry.morphAttributes = {};
    const target = geometry.morphAttributes as unknown as Record<string, THREE.BufferAttribute[]>;
    for (const [name, list] of Object.entries(morphAttributes)) {
      target[name] = (list as THREE.BufferAttribute[]).map((attr) => {
        const arr = attr.array as Float32Array;
        if (source.morphTargetsRelative) {
          return new THREE.BufferAttribute(new Float32Array(arr), attr.itemSize);
        }
        // Convert absolute morph positions to glTF-relative deltas.
        const relative = new Float32Array(arr.length);
        for (let i = 0; i < arr.length; i++) relative[i] = arr[i] - positionArray[i];
        return new THREE.BufferAttribute(relative, attr.itemSize);
      });
    }
    geometry.morphTargetsRelative = true;
  }
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

export async function exportCharacterGLB(character: Character, options: ExportOptions = {}): Promise<ExportResult> {
  const preflight = preflightExport(character);
  if (!preflight.ok) throw new ExportBlockedError(preflight.reasons);

  character.flushNormals();
  character.root.updateMatrixWorld(true);

  const cloned = cloneSkeleton(character.root) as THREE.Group;
  cloned.updateMatrixWorld(true);

  const clonedMeshes: THREE.Mesh[] = [];
  cloned.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) clonedMeshes.push(mesh);
  });
  if (clonedMeshes.length !== character.meshes.length) {
    throw new ExportBlockedError([
      `Skeleton clone produced ${clonedMeshes.length} meshes for ${character.meshes.length} records`,
    ]);
  }

  for (let i = 0; i < character.meshes.length; i++) {
    const rec = character.meshes[i];
    const target = clonedMeshes[i];
    if (target.name !== rec.name) {
      const byName = clonedMeshes.find((m) => m.name === rec.name);
      if (!byName) throw new ExportBlockedError([`Could not match exported mesh "${rec.name}"`]);
      applyRecordToMesh(byName, rec);
    } else {
      applyRecordToMesh(target, rec);
    }
  }

  if (options.includeAttachments !== false) {
    for (const attachment of character.attachments) {
      const bone = cloned.getObjectByName(attachment.boneName);
      if (!bone) continue;
      const copy = attachment.root.clone(true);
      copy.position.copy(attachment.root.position);
      copy.quaternion.copy(attachment.root.quaternion);
      copy.scale.copy(attachment.root.scale);
      bone.add(copy);
    }
  }

  cloned.updateMatrixWorld(true);
  const exporter = new GLTFExporter();
  const animations = options.includeAnimation === false ? [] : character.clips;
  const output = await exporter.parseAsync(cloned, {
    binary: true,
    animations,
    onlyVisible: false,
    trs: false,
    includeCustomExtensions: false,
  });
  if (!(output instanceof ArrayBuffer)) throw new ExportBlockedError(['Exporter did not return binary GLB data']);
  const bytes = output;

  const report = validateExportedGLB(bytes, {
    manifest: character.manifest,
    meshes: character.meshes.map((rec) => ({
      name: rec.name,
      vertexCount: rec.vertexCount,
      expectedPositions: rec.positionAttr.array as Float32Array,
      basePositions: rec.basePosition,
    })),
  });

  disposeClone(cloned);
  const baseName = character.meta.fileName?.replace(/\.(glb|gltf)$/i, '') ?? character.meta.fixtureId ?? 'character';
  return {
    bytes,
    report,
    fileName: options.fileName ?? `${baseName}-dexsculpt.glb`,
    scenes: 1,
  };
}

function applyRecordToMesh(mesh: THREE.Mesh, rec: MeshRecord): void {
  const original = mesh.geometry;
  mesh.geometry = buildExportGeometry(rec);
  original.dispose();
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const clonedMaterials = materials.map((mat) => mat.clone());
  mesh.material = Array.isArray(mesh.material) ? clonedMaterials : clonedMaterials[0];
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh && rec.morphTargets.length) {
    const influences = (rec.mesh as THREE.Mesh).morphTargetInfluences;
    if (influences) (mesh as THREE.Mesh).morphTargetInfluences = [...influences];
  }
}

function disposeClone(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) mat?.dispose();
    const skinned = obj as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh) skinned.skeleton?.dispose();
  });
}

export function downloadBytes(bytes: ArrayBuffer | Uint8Array, fileName: string, mime = 'model/gltf-binary'): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Export a plain Three.js scene (used to serialise the procedural fixtures). */
export async function sceneToGLB(
  scene: THREE.Object3D,
  animations: THREE.AnimationClip[] = [],
): Promise<ArrayBuffer> {
  scene.updateMatrixWorld(true);
  const exporter = new GLTFExporter();
  const output = await exporter.parseAsync(scene, {
    binary: true,
    animations,
    onlyVisible: false,
    trs: false,
    includeCustomExtensions: false,
  });
  if (!(output instanceof ArrayBuffer)) throw new Error('Expected binary GLB output');
  return output;
}
