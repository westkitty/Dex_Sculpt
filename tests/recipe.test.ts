// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { getExample } from '../src/fixtures/registry';
import { loadCharacter } from '../src/character/loader';
import { SculptEngine } from '../src/sculpt/engine';
import { buildRecipe, applyRecipe, RECIPE_SCHEMA } from '../src/project/recipe';
import { inspectAttachment, attachToBone, reattachFromRecipe } from '../src/character/attachments';
import type { Character, MeshRecord } from '../src/character/character';

let bytes: ArrayBuffer;
let character: Character;
let record: MeshRecord;
let recipeJson: string;
let morphName = '';

const settings = { tool: 'clay' as const, radius: 0.08, strength: 0.8, symmetry: { x: true }, invert: false, pressure: 1 };
const hit = {
  point: [0.1, 1.25, 0.1] as [number, number, number],
  normal: [0, 0, 1] as [number, number, number],
  viewDir: [0, 0, -1] as [number, number, number],
  mirrorPlane: { origin: [0, 0, 0] as [number, number, number], axis: [1, 0, 0] as [number, number, number] },
};

beforeAll(async () => {
  const example = getExample('foundry-humanoid')!;
  bytes = await example.build();
  character = await loadCharacter(bytes.slice(0), {
    sourceKind: 'example',
    fixtureId: example.id,
    fileName: 'foundry-humanoid.glb',
    license: example.license,
    skeletonFamily: example.skeletonFamily,
  });
  record = character.meshes[0];

  const engine = new SculptEngine(character.getTarget(record));
  engine.begin('clay', settings, hit);
  for (let i = 0; i < 5; i++) engine.dab([0.1, 1.25 + i * 0.004, 0.1], 1, false);
  engine.end();
  character.flushNormals();

  const mask = new SculptEngine(character.getTarget(record));
  mask.begin('mask', { ...settings, tool: 'mask', symmetry: { x: false } }, hit);
  for (let i = 0; i < 6; i++) mask.dab([0.1, 1.25, 0.1], 1, false);
  mask.end();

  const morphTarget = record.morphTargets[0];
  expect(morphTarget).toBeDefined();
  morphName = morphTarget.name;
  character.setMorphWeight(record, morphName, 0.65);
  const slot = record.materialSlots[0];
  character.setMaterialOverride(slot, { colorHex: '#44ddcc', roughness: 0.21, metalness: 0.44 });

  const visor = getExample('foundry-visor')!;
  const visorBytes = await visor.build();
  const parsed = await inspectAttachment(visorBytes, character);
  expect(parsed.compatibility.ok).toBe(true);
  const head = character.bones.find((bone) => /head/i.test(bone.name))!;
  const attachment = attachToBone(character, parsed, head.name, 'Foundry Visor', 'foundry-visor.glb');
  attachment.root.position.set(0.01, 0.02, 0.075);
});

describe('character recipe', () => {
  it('records provenance, edits and attachments', () => {
    const recipe = buildRecipe(character, { id: 'project-test', name: 'Recipe round trip' });
    recipeJson = JSON.stringify(recipe);
    expect(recipe.schema).toBe(RECIPE_SCHEMA);
    expect(recipe.source.hash).toBe(character.meta.fileHash);
    expect(recipe.source.skeletonFamily).toBe('dexsculpt-fixture-biped-20');
    expect(recipe.source.pendingRelink).toBe(false);
    expect(recipe.source.embeddedBase64?.length ?? 0).toBeGreaterThan(1000);
    expect(recipe.stats.changedGroups).toBeGreaterThan(50);
    expect(recipe.morphs.length).toBe(1);
    expect(recipe.morphs[0].value).toBeCloseTo(0.65, 4);
    expect(recipe.materials.length).toBe(1);
    expect(recipe.materials[0].colorHex).toBe('#44ddcc');
    expect(recipe.attachments.length).toBe(1);
    expect(recipe.attachments[0].boneName.toLowerCase()).toContain('head');
    expect(recipe.attachments[0].transform.position[2]).toBeCloseTo(0.075, 4);
    expect(recipe.attachments[0].bytesBase64?.length ?? 0).toBeGreaterThan(100);
    expect(recipe.editor.app).toBe('DEX//SCULPT');
    expect(recipe.editor.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('applies the recipe on a fresh import of the same source', async () => {
    const recipe = JSON.parse(recipeJson);
    const fresh = await loadCharacter(bytes.slice(0), {
      sourceKind: 'example',
      fixtureId: 'foundry-humanoid',
      fileName: 'foundry-humanoid.glb',
    });
    const freshRecord = fresh.meshes[0];
    const result = applyRecipe(fresh, recipe);
    expect(result.blocked).toEqual([]);
    expect(result.applied.sculptGroups).toBe(recipe.stats.changedGroups);
    expect(result.applied.morphs).toBe(1);
    expect(result.applied.materials).toBe(1);
    expect(result.applied.masks).toBeGreaterThan(0);
    expect(result.applied.attachments).toBe(1);

    let worstDelta = 0;
    let worstMask = 0;
    for (const channel of recipe.sculpt as { meshName: string; count: number }[]) {
      expect(channel.meshName).toBe(record.name);
    }
    for (let group = 0; group < record.weld.groupCount; group++) {
      const a = record.weld.groupList[record.weld.groupStart[group]];
      const b = freshRecord.weld.groupList[freshRecord.weld.groupStart[group]];
      for (let axis = 0; axis < 3; axis++) {
        worstDelta = Math.max(worstDelta, Math.abs(record.delta[a * 3 + axis] - freshRecord.delta[b * 3 + axis]));
      }
      worstMask = Math.max(worstMask, Math.abs(record.mask[a] - freshRecord.mask[b]));
    }
    expect(worstDelta).toBeLessThan(1e-4);
    expect(worstMask).toBeLessThan(1 / 255 + 1e-6);

    expect(fresh.getMorphWeight(freshRecord, morphName)).toBeCloseTo(0.65, 3);
    const slot = freshRecord.materialSlots[0];
    expect(slot.colorHex.toLowerCase()).toBe('#44ddcc');
    expect(slot.roughness).toBeCloseTo(0.21, 4);
    const reattached = await reattachFromRecipe(fresh, recipe.attachments);
    expect(reattached.skipped).toEqual([]);
    expect(reattached.attached).toBe(1);
    expect(fresh.attachments.length).toBe(1);
    const restored = fresh.attachments[0];
    expect(restored.boneName.toLowerCase()).toContain('head');
    expect(restored.root.position.z).toBeCloseTo(0.075, 5);
  });

  it('refuses deltas authored against a different base mesh', async () => {
    const recipe = JSON.parse(recipeJson);
    recipe.sculpt[0].baseHash = 'deadbeef';
    const fresh = await loadCharacter(bytes.slice(0), { sourceKind: 'example', fileName: 'foundry-humanoid.glb' });
    const result = applyRecipe(fresh, recipe);
    expect(result.blocked.join(' ')).toMatch(/base mesh fingerprint differs/);
    expect(result.applied.sculptGroups).toBe(0);
    expect(fresh.meshes[0].delta.every((value) => value === 0)).toBe(true);
  });

  it('marks the source as needing a relink when embedding is disabled', () => {
    const recipe = buildRecipe(character, { embedSource: false });
    expect(recipe.source.embeddedBase64).toBeUndefined();
    expect(recipe.source.pendingRelink).toBe(true);
    expect(recipe.source.hash).toBe(character.meta.fileHash);
  });
});
