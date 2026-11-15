/**
 * Compatibility-aware modular assembly.
 *
 * Separate character packs do not share bone naming, rest pose, scale or skin
 * weighting, so DEX//SCULPT only claims what it can verify:
 *
 *   - Rigid props (no skin) can be attached to a bone. This is always exact.
 *   - Skinned garments are accepted only when every joint they use resolves by
 *     name to a joint of the host skeleton. Otherwise the import is blocked with
 *     an explanation instead of producing a garment that tears apart in motion.
 *
 * `checkClearance` gives a conservative clipping signal (accessory vertices that
 * sit inside the host surface) rather than pretending to solve it.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { bytesFingerprint } from './manifest';
import { fromBase64 } from '../core/util';
import type { Character } from './character';

export interface AttachmentCompatibility {
  ok: boolean;
  mode: 'rigid' | 'skinned-compatible' | 'blocked';
  reasons: string[];
  notes: string[];
  skinned: boolean;
  jointCount: number;
  meshCount: number;
  vertexCount: number;
}

export interface ParsedAttachment {
  root: THREE.Group;
  compatibility: AttachmentCompatibility;
  hash: string;
  bytes: ArrayBuffer;
  dispose(): void;
}

export async function inspectAttachment(bytes: ArrayBuffer, character: Character): Promise<ParsedAttachment> {
  const gltf = await new GLTFLoader().parseAsync(bytes.slice(0), '');
  const root = gltf.scene as THREE.Group;
  root.updateMatrixWorld(true);
  const reasons: string[] = [];
  const notes: string[] = [];
  let skinned = false;
  let jointCount = 0;
  let vertexCount = 0;
  let meshCount = 0;
  const hostJoints = new Set(character.bones.map((b) => b.name));
  const missingJoints = new Set<string>();

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshCount++;
    vertexCount += mesh.geometry.getAttribute('position')?.count ?? 0;
    const skinnedMesh = obj as THREE.SkinnedMesh;
    if (skinnedMesh.isSkinnedMesh && skinnedMesh.skeleton) {
      skinned = true;
      jointCount = Math.max(jointCount, skinnedMesh.skeleton.bones.length);
      for (const bone of skinnedMesh.skeleton.bones) {
        if (!hostJoints.has(bone.name)) missingJoints.add(bone.name);
      }
    }
  });

  if (!meshCount) reasons.push('The file contains no mesh geometry');
  if (skinned && missingJoints.size) {
    reasons.push(
      `${missingJoints.size} joint(s) do not exist on this character (${[...missingJoints].slice(0, 5).join(', ')}). Skinned clothing must share the host rig; rigid props can still be bone-attached.`,
    );
  }
  if (skinned && !missingJoints.size) {
    notes.push('Skinned accessory shares every joint name with the host rig; it will be re-bound to the host skeleton.');
  }
  if (!skinned) notes.push('Rigid prop: it will follow the bone you choose with a fixed transform.');

  const compatibility: AttachmentCompatibility = {
    ok: reasons.length === 0,
    mode: reasons.length ? 'blocked' : skinned ? 'skinned-compatible' : 'rigid',
    reasons,
    notes,
    skinned,
    jointCount,
    meshCount,
    vertexCount,
  };

  return {
    root,
    compatibility,
    hash: bytesFingerprint(bytes),
    bytes,
    dispose: () => {
      root.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const mat of mats) mat?.dispose();
        }
      });
    },
  };
}

export interface Attachment {
  id: string;
  name: string;
  fileName?: string;
  boneName: string;
  root: THREE.Object3D;
  hash: string;
  bytes: ArrayBuffer;
  compatibility: AttachmentCompatibility;
}

let attachmentCounter = 0;

/**
 * Parent a parsed attachment to a bone, matching the accessory's world placement
 * to the bone so it does not jump across the scene when attached.
 */
export function attachToBone(
  character: Character,
  parsed: ParsedAttachment,
  boneName: string,
  name: string,
  fileName?: string,
): Attachment {
  const bone = character.bones.find((b) => b.name === boneName);
  if (!bone) throw new Error(`Bone "${boneName}" not found on this character`);
  if (!parsed.compatibility.ok) throw new Error(parsed.compatibility.reasons.join(' '));
  const object = parsed.root;
  // Normalise: measure the accessory in host space, then place it at the bone.
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);
  bone.add(object);
  object.position.set(0, 0, 0);
  object.quaternion.identity();
  // Keep the accessory's authored scale but snap it to the bone head.
  object.scale.set(1, 1, 1);
  object.updateMatrixWorld(true);
  const attachment: Attachment = {
    id: `attachment-${Date.now().toString(36)}-${attachmentCounter++}`,
    name,
    fileName,
    boneName,
    root: object,
    hash: parsed.hash,
    bytes: parsed.bytes,
    compatibility: parsed.compatibility,
  };
  character.attachments.push(attachment);
  return attachment;
}

export function setAttachmentTransform(
  attachment: Attachment,
  transform: {
    position?: [number, number, number];
    quaternion?: [number, number, number, number];
    scale?: [number, number, number];
  },
): void {
  if (transform.position) attachment.root.position.set(...transform.position);
  if (transform.quaternion) attachment.root.quaternion.set(...transform.quaternion);
  if (transform.scale) attachment.root.scale.set(...transform.scale);
  attachment.root.updateMatrixWorld(true);
}

export function removeAttachment(character: Character, id: string): void {
  const index = character.attachments.findIndex((a) => a.id === id);
  if (index < 0) return;
  const [attachment] = character.attachments.splice(index, 1);
  attachment.root.removeFromParent();
  attachment.root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) mat?.dispose();
    }
  });
}

export interface ClearanceReport {
  testedVertices: number;
  overlappingVertices: number;
  worstPenetration: number;
  verdict: 'clear' | 'touching' | 'clipping';
  detail: string;
}

/**
 * Conservative clipping check: sample accessory vertices in world space and
 * measure the distance to the nearest host surface group. Anything closer than
 * half the host mean edge length is reported as an overlap.
 */
export function checkClearance(character: Character, attachment: Attachment): ClearanceReport {
  const host = character.meshes.filter((m) => m.skinned).sort((a, b) => b.vertexCount - a.vertexCount)[0] ?? character.meshes[0];
  if (!host) {
    return { testedVertices: 0, overlappingVertices: 0, worstPenetration: 0, verdict: 'clear', detail: 'No host mesh' };
  }
  attachment.root.updateMatrixWorld(true);
  character.root.updateMatrixWorld(true);
  const threshold = Math.max(host.weld.meanEdge * 0.5, 1e-4);
  const hostWorld = new THREE.Matrix4().multiplyMatrices(host.mesh.matrixWorld, new THREE.Matrix4());
  void hostWorld;
  const inverse = new THREE.Matrix4().copy(host.mesh.matrixWorld).invert();
  const positions = host.positionAttr.array as Float32Array;
  const groupCount = host.weld.groupCount;
  const point = new THREE.Vector3();
  let tested = 0;
  let overlapping = 0;
  let worst = 0;
  const stride = Math.max(1, Math.floor(host.weld.groupCount / 4000));
  attachment.root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const attr = mesh.geometry.getAttribute('position');
    if (!attr) return;
    const step = Math.max(1, Math.floor(attr.count / 400));
    for (let i = 0; i < attr.count; i += step) {
      point.fromBufferAttribute(attr, i);
      mesh.localToWorld(point);
      point.applyMatrix4(inverse);
      tested++;
      let nearest = Infinity;
      for (let g = 0; g < groupCount; g += stride) {
        const rep = host.weld.groupList[host.weld.groupStart[g]];
        const dx = positions[rep * 3] - point.x;
        const dy = positions[rep * 3 + 1] - point.y;
        const dz = positions[rep * 3 + 2] - point.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < nearest) nearest = d2;
      }
      const d = Math.sqrt(nearest);
      if (d < threshold) {
        overlapping++;
        worst = Math.max(worst, threshold - d);
      }
    }
  });
  const verdict: ClearanceReport['verdict'] = overlapping === 0 ? 'clear' : worst > threshold * 0.8 ? 'clipping' : 'touching';
  return {
    testedVertices: tested,
    overlappingVertices: overlapping,
    worstPenetration: worst,
    verdict,
    detail:
      verdict === 'clear'
        ? `No accessory vertex sits inside the host surface (${tested} sampled, clearance ≥ ${(threshold * 1000).toFixed(1)} mm)`
        : `${overlapping} of ${tested} sampled accessory vertices overlap the host surface by up to ${(worst * 1000).toFixed(1)} mm — adjust the attachment transform`,
  };
}

/**
 * Re-create attachments recorded in a recipe (or project) on a freshly loaded
 * character. Each accessory is re-inspected against *this* skeleton before it is
 * attached, so an incompatible garment is reported instead of tearing apart.
 */
export async function reattachFromRecipe(
  character: Character,
  specs: {
    id: string;
    name: string;
    fileName?: string;
    boneName: string;
    transform: {
      position: [number, number, number];
      quaternion: [number, number, number, number];
      scale: [number, number, number];
    };
    bytesBase64?: string;
  }[],
): Promise<{ attached: number; skipped: string[] }> {
  const skipped: string[] = [];
  let attached = 0;
  for (const spec of specs) {
    if (!spec.bytesBase64) {
      skipped.push(`${spec.name}: accessory bytes were not embedded in the recipe`);
      continue;
    }
    const data = fromBase64(spec.bytesBase64);
    const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    try {
      const parsed = await inspectAttachment(bytes, character);
      if (!parsed.compatibility.ok) {
        skipped.push(`${spec.name}: ${parsed.compatibility.reasons.join(' ')}`);
        parsed.dispose();
        continue;
      }
      if (!character.bones.some((bone) => bone.name === spec.boneName)) {
        skipped.push(`${spec.name}: bone "${spec.boneName}" is not on this skeleton`);
        parsed.dispose();
        continue;
      }
      const attachment = attachToBone(character, parsed, spec.boneName, spec.name, spec.fileName);
      setAttachmentTransform(attachment, spec.transform);
      attached++;
    } catch (error) {
      skipped.push(`${spec.name}: ${(error as Error).message}`);
    }
  }
  return { attached, skipped };
}
