/**
 * Non-destructive character recipe.
 *
 * A recipe is the editable character *delta*: morph weights, material overrides,
 * sparse sculpt deltas (quantised to int16 per group), mask state and attachment
 * transforms — keyed by source asset identity. The unedited source model is never
 * rewritten.
 *
 * Honest scope: a recipe references a source asset. Small sources (≤ 8 MB) can be
 * embedded so the recipe is self-contained; larger ones record `pendingRelink` and
 * the app asks the user to re-supply the original file. Project save (IndexedDB)
 * always stores the source bytes alongside the recipe.
 */
import { fromBase64, hashArray, sig, timeStamp, toBase64 } from '../core/util';
import type { Character, MeshRecord } from '../character/character';

export const RECIPE_SCHEMA = 'dexsculpt/recipe@1';
export const EDITOR_VERSION = '0.1.0';
export const EMBED_LIMIT = 8 * 1024 * 1024;

export interface SculptChannelData {
  meshName: string;
  meshId: string;
  /** fingerprint of the imported base positions the deltas were authored against */
  baseHash: string;
  groupCount: number;
  count: number;
  indices: string;
  deltas: string;
  scale: number;
  mask?: string;
  maskValues?: string;
  maskScale?: number;
}

export interface MaterialOverrideData {
  meshName: string;
  meshId: string;
  slot: number;
  materialName: string;
  colorHex?: string;
  metalness?: number;
  roughness?: number;
}

export interface MorphValueData {
  meshName: string;
  meshId: string;
  target: string;
  value: number;
}

export interface AttachmentTransformData {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
}

export interface AttachmentData {
  id: string;
  name: string;
  fileName?: string;
  boneName: string;
  transform: AttachmentTransformData;
  hash?: string;
  bytesBase64?: string;
  pendingRelink?: boolean;
}

export interface CharacterRecipe {
  schema: typeof RECIPE_SCHEMA;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  editor: { app: string; version: string; three: string; schemaVersion: number };
  source: {
    kind: 'fixture' | 'import' | 'example';
    fixtureId?: string;
    catalogId?: string;
    fileName?: string;
    byteLength?: number;
    hash?: string;
    skeletonFamily?: string;
    license?: string;
    provenance?: string;
    embeddedBase64?: string;
    pendingRelink: boolean;
  };
  morphs: MorphValueData[];
  materials: MaterialOverrideData[];
  sculpt: SculptChannelData[];
  attachments: AttachmentData[];
  stats: { changedGroups: number; sculptBytes: number; recipeBytes: number };
  notes?: string;
}

export interface BuildRecipeOptions {
  id?: string;
  name?: string;
  createdAt?: string;
  embedSource?: boolean;
}

export function buildRecipe(character: Character, opts: BuildRecipeOptions = {}): CharacterRecipe {
  const sculpt: SculptChannelData[] = [];
  let changedGroups = 0;
  for (const rec of character.meshes) {
    const channel = encodeSculptChannel(rec);
    if (!channel) continue;
    changedGroups += channel.count;
    sculpt.push(channel);
  }

  const morphs: MorphValueData[] = [];
  for (const rec of character.meshes) {
    for (const target of rec.morphTargets) {
      const value = character.getMorphWeight(rec, target.name);
      if (Math.abs(value) > 1e-5) {
        morphs.push({ meshName: rec.name, meshId: rec.id, target: target.name, value: sig(value, 5) });
      }
    }
  }

  const materials: MaterialOverrideData[] = [];
  for (const rec of character.meshes) {
    for (const slot of rec.materialSlots) {
      if (!slot.overridden) continue;
      materials.push({
        meshName: rec.name,
        meshId: rec.id,
        slot: slot.slot,
        materialName: slot.name,
        colorHex: slot.colorHex,
        metalness: sig(slot.metalness, 4),
        roughness: sig(slot.roughness, 4),
      });
    }
  }

  const attachments: AttachmentData[] = character.attachments.map((a) => ({
    id: a.id,
    name: a.name,
    fileName: a.fileName,
    boneName: a.boneName,
    transform: {
      position: [sig(a.root.position.x), sig(a.root.position.y), sig(a.root.position.z)],
      quaternion: [sig(a.root.quaternion.x), sig(a.root.quaternion.y), sig(a.root.quaternion.z), sig(a.root.quaternion.w)],
      scale: [sig(a.root.scale.x), sig(a.root.scale.y), sig(a.root.scale.z)],
    },
    hash: a.hash,
    bytesBase64: encodeAttachmentBytes(a),
    pendingRelink: !a.bytes,
  }));

  const bytes = character.meta.glbBytes;
  const embed = opts.embedSource !== false && !!bytes && bytes.byteLength <= EMBED_LIMIT;
  const source: CharacterRecipe['source'] = {
    kind: character.meta.sourceKind,
    fixtureId: character.meta.fixtureId,
    catalogId: character.meta.catalogId,
    fileName: character.meta.fileName,
    byteLength: character.meta.byteLength ?? bytes?.byteLength,
    hash: character.meta.fileHash,
    skeletonFamily: character.meta.skeletonFamily,
    license: character.meta.license,
    provenance: character.meta.provenance,
    embeddedBase64: embed && bytes ? toBase64(new Uint8Array(bytes)) : undefined,
    pendingRelink: !embed,
  };

  const recipe: CharacterRecipe = {
    schema: RECIPE_SCHEMA,
    id: opts.id ?? `recipe-${Date.now().toString(36)}`,
    name: opts.name ?? character.meta.fileName ?? 'Character recipe',
    createdAt: opts.createdAt ?? timeStamp(),
    updatedAt: timeStamp(),
    editor: { app: 'DEX//SCULPT', version: EDITOR_VERSION, three: '0.186.1', schemaVersion: 1 },
    source,
    morphs,
    materials,
    sculpt,
    attachments,
    stats: {
      changedGroups,
      sculptBytes: sculpt.reduce((acc, c) => acc + c.count * 6 + c.count * 4, 0),
      recipeBytes: 0,
    },
    notes: 'Sculpt channels store position deltas only; the source rig, skin weights, morph targets, UVs and clips are untouched.',
  };
  recipe.stats.recipeBytes = JSON.stringify(recipe).length;
  return recipe;
}

function encodeAttachmentBytes(a: { bytes?: ArrayBuffer }): string | undefined {
  const bytes = a.bytes;
  if (!bytes || bytes.byteLength > 4 * 1024 * 1024) return undefined;
  return toBase64(new Uint8Array(bytes));
}

export function encodeSculptChannel(rec: MeshRecord): SculptChannelData | null {
  const weld = rec.weld;
  const indices: number[] = [];
  const values: number[] = [];
  const maskValues: number[] = [];
  let maxAbs = 0;
  let maxMask = 0;
  for (let g = 0; g < weld.groupCount; g++) {
    const rep = weld.groupList[weld.groupStart[g]];
    const dx = rec.delta[rep * 3];
    const dy = rec.delta[rep * 3 + 1];
    const dz = rec.delta[rep * 3 + 2];
    const m = rec.mask[rep];
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e-9) {
      indices.push(g);
      values.push(dx, dy, dz);
      maxAbs = Math.max(maxAbs, Math.abs(dx), Math.abs(dy), Math.abs(dz));
    }
    if (m > 0.002) maxMask = Math.max(maxMask, m);
  }
  let maskGroups: number[] = [];
  let maskBytes: number[] = [];
  if (maxMask > 0) {
    for (let g = 0; g < weld.groupCount; g++) {
      const rep = weld.groupList[weld.groupStart[g]];
      if (rec.mask[rep] > 0.002) {
        maskGroups.push(g);
        maskBytes.push(Math.round((rec.mask[rep] / maxMask) * 255));
      }
    }
  }
  if (!indices.length && !maskGroups.length) return null;
  const scale = maxAbs > 0 ? maxAbs : 1;
  const q = new Int16Array(values.length);
  for (let i = 0; i < values.length; i++) q[i] = Math.round((values[i] / scale) * 32767);
  return {
    meshName: rec.name,
    meshId: rec.id,
    baseHash: hashArray(rec.basePosition),
    groupCount: weld.groupCount,
    count: indices.length,
    indices: toBase64(new Uint8Array(new Uint32Array(indices).buffer)),
    deltas: toBase64(new Uint8Array(q.buffer)),
    scale: sig(scale, 6),
    mask: maskGroups.length ? toBase64(new Uint8Array(new Uint32Array(maskGroups).buffer)) : undefined,
    maskValues: maskGroups.length ? toBase64(new Uint8Array(maskBytes)) : undefined,
    maskScale: maskGroups.length ? sig(maxMask, 6) : undefined,
  };
}

export interface ApplyRecipeResult {
  applied: { sculptGroups: number; morphs: number; materials: number; masks: number; attachments: number };
  blocked: string[];
  warnings: string[];
  appliedChannels: string[];
}

export function applyRecipe(character: Character, recipe: CharacterRecipe): ApplyRecipeResult {
  const result: ApplyRecipeResult = {
    applied: { sculptGroups: 0, morphs: 0, materials: 0, masks: 0, attachments: 0 },
    blocked: [],
    warnings: [],
    appliedChannels: [],
  };
  if (recipe.schema !== RECIPE_SCHEMA) {
    result.blocked.push(`Unsupported recipe schema "${recipe.schema}" (expected ${RECIPE_SCHEMA})`);
    return result;
  }
  if (recipe.source.hash && character.meta.fileHash && recipe.source.hash !== character.meta.fileHash) {
    result.warnings.push(
      `Recipe source hash ${recipe.source.hash} differs from the loaded file ${character.meta.fileHash}; sculpt deltas will be verified per mesh.`,
    );
  }

  for (const channel of recipe.sculpt) {
    const rec = character.meshes.find((m) => m.name === channel.meshName);
    if (!rec) {
      result.blocked.push(`Sculpt channel for "${channel.meshName}" skipped: mesh not found in the loaded character`);
      continue;
    }
    const currentHash = hashArray(rec.basePosition);
    if (currentHash !== channel.baseHash) {
      result.blocked.push(
        `Sculpt channel for "${channel.meshName}" skipped: base mesh fingerprint differs (${channel.baseHash} ≠ ${currentHash}). Relink the original file.`,
      );
      continue;
    }
    if (rec.weld.groupCount !== channel.groupCount) {
      result.blocked.push(
        `Sculpt channel for "${channel.meshName}" skipped: ${rec.weld.groupCount} weld groups vs ${channel.groupCount} in the recipe`,
      );
      continue;
    }
    const indicesBytes = fromBase64(channel.indices);
    const indices = new Uint32Array(indicesBytes.buffer, indicesBytes.byteOffset, indicesBytes.byteLength / 4);
    const deltaBytes = fromBase64(channel.deltas);
    const quant = new Int16Array(deltaBytes.buffer, deltaBytes.byteOffset, deltaBytes.byteLength / 2);
    const scale = channel.scale;
    const touched = new Uint32Array(indices.length);
    let written = 0;
    for (let i = 0; i < indices.length; i++) {
      const g = indices[i];
      if (g >= rec.weld.groupCount) continue;
      const dx = (quant[i * 3] / 32767) * scale;
      const dy = (quant[i * 3 + 1] / 32767) * scale;
      const dz = (quant[i * 3 + 2] / 32767) * scale;
      for (let k = rec.weld.groupStart[g]; k < rec.weld.groupStart[g + 1]; k++) {
        const v = rec.weld.groupList[k];
        rec.delta[v * 3] = dx;
        rec.delta[v * 3 + 1] = dy;
        rec.delta[v * 3 + 2] = dz;
      }
      touched[written++] = g;
    }
    result.applied.sculptGroups += written;
    if (channel.mask && channel.maskValues && channel.maskScale) {
      const maskIdxBytes = fromBase64(channel.mask);
      const maskIdx = new Uint32Array(maskIdxBytes.buffer, maskIdxBytes.byteOffset, maskIdxBytes.byteLength / 4);
      const maskVals = fromBase64(channel.maskValues);
      for (let i = 0; i < maskIdx.length; i++) {
        const g = maskIdx[i];
        if (g >= rec.weld.groupCount) continue;
        const value = (maskVals[i] / 255) * channel.maskScale;
        for (let k = rec.weld.groupStart[g]; k < rec.weld.groupStart[g + 1]; k++) {
          rec.mask[rec.weld.groupList[k]] = value;
        }
        result.applied.masks++;
      }
    }
    character.commitGroups(rec, touched, written);
    rec.spatial.rebuild();
    character.flushNormals(rec);
    result.appliedChannels.push(`${rec.name}: ${indices.length} groups`);
  }

  for (const morph of recipe.morphs) {
    const rec = character.meshes.find((m) => m.name === morph.meshName);
    if (!rec) {
      result.warnings.push(`Morph target "${morph.target}" skipped: mesh "${morph.meshName}" not found`);
      continue;
    }
    if (!rec.morphTargets.some((t) => t.name === morph.target)) {
      result.warnings.push(`Morph target "${morph.target}" not present on "${morph.meshName}"`);
      continue;
    }
    character.setMorphWeight(rec, morph.target, morph.value);
    result.applied.morphs++;
  }

  for (const mat of recipe.materials) {
    const rec = character.meshes.find((m) => m.name === mat.meshName);
    const slot = rec?.materialSlots.find((s) => s.slot === mat.slot);
    if (!slot) {
      result.warnings.push(`Material override for "${mat.meshName}" slot ${mat.slot} skipped`);
      continue;
    }
    character.setMaterialOverride(slot, {
      colorHex: mat.colorHex,
      metalness: mat.metalness,
      roughness: mat.roughness,
    });
    result.applied.materials++;
  }

  result.applied.attachments = recipe.attachments.length;
  return result;
}

export function recipeSummary(recipe: CharacterRecipe): string {
  const parts = [
    `${recipe.sculpt.reduce((a, c) => a + c.count, 0)} sculpted groups`,
    `${recipe.morphs.length} morph values`,
    `${recipe.materials.length} material overrides`,
    `${recipe.attachments.length} attachments`,
  ];
  return parts.join(' · ');
}
