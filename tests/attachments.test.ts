// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { getExample } from '../src/fixtures/registry';
import { loadCharacter } from '../src/character/loader';
import {
  attachToBone,
  checkClearance,
  inspectAttachment,
  removeAttachment,
  setAttachmentTransform,
} from '../src/character/attachments';
import type { Character } from '../src/character/character';

let character: Character;
let visorBytes: ArrayBuffer;
let humanoidBytes: ArrayBuffer;

beforeAll(async () => {
  humanoidBytes = await getExample('foundry-humanoid')!.build();
  visorBytes = await getExample('foundry-visor')!.build();
  character = await loadCharacter(humanoidBytes.slice(0), {
    sourceKind: 'example',
    fixtureId: 'foundry-humanoid',
    fileName: 'foundry-humanoid.glb',
  });
});

describe('modular assembly', () => {
  it('accepts a rigid prop and parents it to a real bone', async () => {
    const parsed = await inspectAttachment(visorBytes.slice(0), character);
    expect(parsed.compatibility.ok).toBe(true);
    expect(parsed.compatibility.mode).toBe('rigid');
    expect(parsed.compatibility.skinned).toBe(false);
    expect(parsed.compatibility.meshCount).toBeGreaterThan(0);

    const head = character.bones.find((bone) => /head/i.test(bone.name))!;
    const attachment = attachToBone(character, parsed, head.name, 'Visor', 'visor.glb');
    expect(attachment.root.parent).toBe(head);
    expect(character.attachments.length).toBe(1);

    setAttachmentTransform(attachment, { position: [0, 0.03, 0.06], scale: [1.1, 1.1, 1.1] });
    expect(attachment.root.position.y).toBeCloseTo(0.03, 5);
    expect(attachment.root.scale.x).toBeCloseTo(1.1, 5);

    const clearance = checkClearance(character, attachment);
    expect(clearance.testedVertices).toBeGreaterThan(0);
    expect(['clear', 'touching', 'clipping']).toContain(clearance.verdict);
    expect(clearance.detail.length).toBeGreaterThan(0);

    removeAttachment(character, attachment.id);
    expect(character.attachments.length).toBe(0);
    expect(attachment.root.parent).toBeNull();
  });

  it('accepts a skinned garment only when every joint resolves on the host', async () => {
    const parsed = await inspectAttachment(humanoidBytes.slice(0), character);
    expect(parsed.compatibility.skinned).toBe(true);
    expect(parsed.compatibility.jointCount).toBe(20);
    expect(parsed.compatibility.ok).toBe(true);
    expect(parsed.compatibility.mode).toBe('skinned-compatible');
    parsed.dispose();
  });

  it('blocks skinned garments whose joints are missing on the host', async () => {
    const bust = await loadCharacter(await getExample('foundry-bust')!.build(), {
      sourceKind: 'example',
      fixtureId: 'foundry-bust',
      fileName: 'foundry-bust.glb',
    });
    const parsed = await inspectAttachment(humanoidBytes.slice(0), bust);
    expect(parsed.compatibility.ok).toBe(false);
    expect(parsed.compatibility.mode).toBe('blocked');
    expect(parsed.compatibility.reasons.join(' ')).toMatch(/joint/i);
    parsed.dispose();
  });

  it('refuses a file that is not a GLB', async () => {
    const bogus = new TextEncoder().encode('this is not a model').buffer as ArrayBuffer;
    await expect(inspectAttachment(bogus, character)).rejects.toBeTruthy();
  });
});
