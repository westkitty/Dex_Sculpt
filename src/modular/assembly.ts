import * as THREE from 'three';
import type { RecipeAttachment } from '../core/recipe';
import { buildProceduralAccessory, PROCEDURAL_ACCESSORIES } from '../fixtures/proceduralAccessories';
import { importCharacterBytes } from '../io/glbPipeline';

export interface ActiveAttachment {
  id: string;
  name: string;
  mode: 'bone-attached' | 'static-prop' | 'skinned-compatible';
  targetBone: string;
  object: THREE.Object3D;
  proceduralId?: string;
  fileName?: string;
  sha256?: string;
  warnings: string[];
}

export interface AttachmentCompatibilityResult {
  compatible: boolean;
  mode: 'bone-attached' | 'static-prop' | 'skinned-compatible';
  resolvedBone: THREE.Bone | null;
  reason: string;
}

/** Find a bone on a skeleton using exact OR sanitized glTF node name matching. */
export function findBoneByName(skeleton: THREE.Skeleton | null, targetName: string): THREE.Bone | null {
  if (!skeleton || !targetName) return null;
  const sanitized = THREE.PropertyBinding.sanitizeNodeName(targetName);
  return (
    skeleton.bones.find((b) => b.name === targetName) ??
    skeleton.bones.find((b) => THREE.PropertyBinding.sanitizeNodeName(b.name) === sanitized) ??
    null
  );
}

/**
 * Evaluate compatibility before attaching a modular item or skinned garment.
 * Blocks incompatible skinned bindings rather than silently corrupting deformation.
 */
export function checkAttachmentCompatibility(
  targetSkeleton: THREE.Skeleton | null,
  targetSkeletonFamily: string,
  mode: 'bone-attached' | 'static-prop' | 'skinned-compatible',
  targetBone: string,
  requiredSkinnedBones?: string[],
  compatibleFamilies?: string[]
): AttachmentCompatibilityResult {
  if (mode === 'static-prop') {
    return {
      compatible: true,
      mode: 'static-prop',
      resolvedBone: null,
      reason: 'Static prop attaches cleanly to character root.'
    };
  }

  if (mode === 'bone-attached') {
    const bone = findBoneByName(targetSkeleton, targetBone);
    if (!bone) {
      return {
        compatible: false,
        mode,
        resolvedBone: null,
        reason: targetSkeleton
          ? `Target bone "${targetBone}" does not exist in active skeleton (${targetSkeleton.bones.length} bones).`
          : 'Active character has no skeleton; switch to static root attachment or load a rigged character.'
      };
    }
    return {
      compatible: true,
      mode,
      resolvedBone: bone,
      reason: `Rigid socket compatible with bone "${bone.name}".`
    };
  }

  // Skinned clothing / modular body part check
  if (!targetSkeleton) {
    return {
      compatible: false,
      mode,
      resolvedBone: null,
      reason: 'Skinned clothing requires an active rigged character skeleton.'
    };
  }
  if (compatibleFamilies && !compatibleFamilies.includes('*') && !compatibleFamilies.includes(targetSkeletonFamily)) {
    return {
      compatible: false,
      mode,
      resolvedBone: null,
      reason: `Skinned garment expects family [${compatibleFamilies.join(', ')}], active character is "${targetSkeletonFamily}".`
    };
  }
  const reqBones = requiredSkinnedBones ?? [];
  const missing = reqBones.filter((name) => !findBoneByName(targetSkeleton, name));
  if (missing.length > 0) {
    return {
      compatible: false,
      mode,
      resolvedBone: null,
      reason: `Incompatible skeleton: missing required bones [${missing.join(', ')}].`
    };
  }
  return {
    compatible: true,
    mode: 'skinned-compatible',
    resolvedBone: findBoneByName(targetSkeleton, targetBone) ?? targetSkeleton.bones[0] ?? null,
    reason: `Skinned garment bones validated against active skeleton (${reqBones.length} matched bones).`
  };
}

/** Attach a built-in procedural accessory or skinned garment onto the active character. */
export function attachProceduralModularItem(
  characterRoot: THREE.Object3D,
  targetSkeleton: THREE.Skeleton | null,
  targetSkeletonFamily: string,
  proceduralId: string,
  overrideBone?: string
): ActiveAttachment {
  const spec = PROCEDURAL_ACCESSORIES.find((a) => a.id === proceduralId);
  if (!spec) throw new Error(`Unknown procedural accessory: ${proceduralId}`);

  const boneName = overrideBone || spec.targetBone;
  const built = buildProceduralAccessory(proceduralId);
  const reqBones = (built.userData.skinnedBindingBoneNames as string[] | undefined) ?? undefined;

  const check = checkAttachmentCompatibility(
    targetSkeleton,
    targetSkeletonFamily,
    spec.mode,
    boneName,
    reqBones,
    spec.compatibleFamilies
  );
  if (!check.compatible) {
    throw new Error(check.reason);
  }

  const warnings: string[] = [];
  let finalObject: THREE.Object3D = built;

  if (spec.mode === 'skinned-compatible' && targetSkeleton && reqBones) {
    const srcMesh = built as THREE.Mesh;
    const remappedGeo = srcMesh.geometry.clone();
    const skinIdxAttr = remappedGeo.getAttribute('skinIndex') as THREE.BufferAttribute;
    const targetBoneIndices = reqBones.map((bn) => {
      const b = findBoneByName(targetSkeleton, bn)!;
      return targetSkeleton.bones.indexOf(b);
    });
    for (let i = 0; i < skinIdxAttr.count; i++) {
      for (let c = 0; c < 4; c++) {
        const localIdx = skinIdxAttr.array[i * 4 + c];
        skinIdxAttr.array[i * 4 + c] = targetBoneIndices[localIdx] ?? targetBoneIndices[0];
      }
    }
    skinIdxAttr.needsUpdate = true;

    const skinnedAttachment = new THREE.SkinnedMesh(remappedGeo, srcMesh.material);
    skinnedAttachment.name = srcMesh.name;
    skinnedAttachment.bind(targetSkeleton, new THREE.Matrix4());
    srcMesh.geometry.dispose();
    characterRoot.add(skinnedAttachment);
    finalObject = skinnedAttachment;
  } else if (check.resolvedBone) {
    check.resolvedBone.add(built);
  } else {
    characterRoot.add(built);
  }

  // Conservative size/clipping check
  const charBox = new THREE.Box3().setFromObject(characterRoot);
  const itemBox = new THREE.Box3().setFromObject(finalObject);
  const charSize = charBox.getSize(new THREE.Vector3()).length() || 1;
  const itemSize = itemBox.getSize(new THREE.Vector3()).length();
  if (itemSize > charSize * 0.9) {
    warnings.push('Attachment bounding size is large relative to character; verify scale/clipping.');
  }

  finalObject.userData.dexAttachment = true;
  const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  finalObject.userData.dexAttachmentId = id;

  return {
    id,
    name: spec.name,
    mode: spec.mode,
    targetBone: check.resolvedBone?.name ?? 'Root',
    object: finalObject,
    proceduralId,
    warnings
  };
}

/** Import a local GLB file and attach it safely as a bone-attached prop, static prop, or compatible skinned part. */
export async function attachLocalGlbItem(
  characterRoot: THREE.Object3D,
  targetSkeleton: THREE.Skeleton | null,
  targetSkeletonFamily: string,
  fileName: string,
  bytes: ArrayBuffer,
  requestedMode: 'bone-attached' | 'static-prop' | 'skinned-compatible',
  targetBone: string
): Promise<ActiveAttachment> {
  const imported = await importCharacterBytes(fileName, bytes);
  const warnings: string[] = [...imported.warnings];

  // Collect skinned meshes if any
  const importedSkinned: THREE.SkinnedMesh[] = [];
  imported.root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) importedSkinned.push(o as THREE.SkinnedMesh);
  });

  if (requestedMode === 'skinned-compatible') {
    if (importedSkinned.length === 0 || !targetSkeleton) {
      throw new Error('Selected GLB has no skinned mesh or active character is unrigged; attach as a rigid bone socket instead.');
    }
    const srcSkinned = importedSkinned[0];
    const srcBones = srcSkinned.skeleton.bones.map((b) => b.name);
    const missing = srcBones.filter((bn) => !findBoneByName(targetSkeleton, bn));
    if (missing.length > 0) {
      throw new Error(
        `Skinned garment "${fileName}" cannot bind directly: missing bones [${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}]. Try attaching as a rigid bone socket.`
      );
    }
    // Remap skinIndex onto target skeleton
    const geo = srcSkinned.geometry;
    const skinIdxAttr = geo.getAttribute('skinIndex') as THREE.BufferAttribute;
    const boneMap = srcBones.map((bn) => targetSkeleton.bones.indexOf(findBoneByName(targetSkeleton, bn)!));
    for (let i = 0; i < skinIdxAttr.count; i++) {
      for (let c = 0; c < 4; c++) {
        const oldIdx = skinIdxAttr.array[i * 4 + c];
        skinIdxAttr.array[i * 4 + c] = boneMap[oldIdx] ?? 0;
      }
    }
    skinIdxAttr.needsUpdate = true;
    const rebound = new THREE.SkinnedMesh(geo, srcSkinned.material);
    rebound.name = srcSkinned.name || fileName.replace(/\.glb$/i, '');
    rebound.bind(targetSkeleton, new THREE.Matrix4());
    rebound.userData.dexAttachment = true;
    const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    rebound.userData.dexAttachmentId = id;
    characterRoot.add(rebound);
    return {
      id,
      name: rebound.name,
      mode: 'skinned-compatible',
      targetBone: targetSkeleton.bones[0]?.name ?? 'Root',
      object: rebound,
      fileName,
      sha256: imported.sha256,
      warnings
    };
  }

  // Rigid bone-attached or static-prop
  const check = checkAttachmentCompatibility(
    targetSkeleton,
    targetSkeletonFamily,
    requestedMode,
    targetBone
  );
  if (!check.compatible) throw new Error(check.reason);

  if (importedSkinned.length > 0) {
    warnings.push('Imported file contained skinning; attached rigidly in bind pose as requested.');
  }

  const wrapper = new THREE.Group();
  wrapper.name = fileName.replace(/\.(glb|gltf|obj|stl)$/i, '');
  while (imported.root.children.length > 0) {
    wrapper.add(imported.root.children[0]);
  }
  wrapper.userData.dexAttachment = true;
  const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  wrapper.userData.dexAttachmentId = id;

  if (check.resolvedBone) {
    check.resolvedBone.add(wrapper);
  } else {
    characterRoot.add(wrapper);
  }

  return {
    id,
    name: wrapper.name,
    mode: requestedMode,
    targetBone: check.resolvedBone?.name ?? 'Root',
    object: wrapper,
    fileName,
    sha256: imported.sha256,
    warnings
  };
}

export function serializeAttachmentToRecipe(att: ActiveAttachment): RecipeAttachment {
  return {
    id: att.id,
    name: att.name,
    mode: att.mode,
    targetBone: att.targetBone,
    position: [
      Number(att.object.position.x.toFixed(4)),
      Number(att.object.position.y.toFixed(4)),
      Number(att.object.position.z.toFixed(4))
    ],
    rotation: [
      Number(att.object.rotation.x.toFixed(4)),
      Number(att.object.rotation.y.toFixed(4)),
      Number(att.object.rotation.z.toFixed(4))
    ],
    scale: [
      Number(att.object.scale.x.toFixed(4)),
      Number(att.object.scale.y.toFixed(4)),
      Number(att.object.scale.z.toFixed(4))
    ],
    proceduralId: att.proceduralId,
    fileName: att.fileName,
    sha256: att.sha256,
    requiresLocalFile: !att.proceduralId
  };
}
