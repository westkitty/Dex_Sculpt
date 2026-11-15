// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { getExample } from '../src/fixtures/registry';
import { loadCharacter } from '../src/character/loader';
import { exportCharacterGLB } from '../src/character/exporter';
import { validateExportedGLB } from '../src/validation/validateExport';

const expectation = () => ({
  manifest: character.manifest,
  meshes: character.meshes.map((rec) => ({
    name: rec.name,
    vertexCount: rec.vertexCount,
    expectedPositions: rec.positionAttr.array as Float32Array,
    basePositions: rec.basePosition,
  })),
});
import type { Character } from '../src/character/character';

let character: Character;
let exported: ArrayBuffer;

beforeAll(async () => {
  const example = getExample('foundry-humanoid')!;
  character = await loadCharacter(await example.build(), {
    sourceKind: 'example',
    fixtureId: example.id,
    fileName: 'foundry-humanoid.glb',
  });
  exported = (await exportCharacterGLB(character)).bytes;
});

/** Rewrite a GLB's JSON chunk in place (used to build deliberately broken files). */
function patchGlbJson(bytes: ArrayBuffer, patch: (json: Record<string, unknown>) => void): ArrayBuffer {
  const view = new DataView(bytes);
  const total = view.getUint32(8, true);
  const jsonLength = view.getUint32(12, true);
  const jsonBytes = new Uint8Array(bytes, 20, jsonLength);
  const text = new TextDecoder().decode(jsonBytes).replace(/\u0000+$/, '');
  const json = JSON.parse(text) as Record<string, unknown>;
  patch(json);
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const padded = Math.ceil(encoded.byteLength / 4) * 4;
  const rest = new Uint8Array(bytes, 20 + jsonLength, total - 20 - jsonLength);
  const out = new Uint8Array(12 + 8 + padded + rest.byteLength);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, 0x46546c67, true);
  outView.setUint32(4, 2, true);
  outView.setUint32(8, out.byteLength, true);
  outView.setUint32(12, padded, true);
  outView.setUint32(16, 0x4e4f534a, true);
  out.set(encoded, 20);
  for (let i = 20 + encoded.byteLength; i < 20 + padded; i++) out[i] = 0x20;
  out.set(rest, 20 + padded);
  return out.buffer;
}

describe('independent structural validator', () => {
  it('passes every check on a real export', () => {
    const report = validateExportedGLB(exported, expectation());
    expect(report.ok).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(19);
    expect(report.checks.every((check) => check.status !== 'fail')).toBe(true);
    expect(report.facts.skinCount).toBeGreaterThan(0);
    expect(report.facts.animationCount).toBe(3);
    expect(report.facts.morphTargets).toBeGreaterThan(0);
  });

  it('fails when the skin block is stripped from the file', () => {
    const broken = patchGlbJson(exported, (json) => {
      delete json.skins;
      for (const node of json.nodes as Record<string, unknown>[]) delete node.skin;
    });
    const report = validateExportedGLB(broken, expectation());
    expect(report.ok).toBe(false);
    const failed = report.checks.filter((check) => check.status === 'fail').map((check) => check.id);
    expect(failed).toContain('skin-presence');
    expect(failed.length).toBeGreaterThan(1);
  });

  it('fails when animation clips are removed', () => {
    const broken = patchGlbJson(exported, (json) => {
      delete json.animations;
    });
    const report = validateExportedGLB(broken, expectation());
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'animations')?.status).toBe('fail');
  });

  it('fails when morph targets are removed', () => {
    const broken = patchGlbJson(exported, (json) => {
      for (const mesh of json.meshes as Record<string, unknown>[]) {
        for (const primitive of mesh.primitives as Record<string, unknown>[]) {
          delete primitive.targets;
        }
        delete mesh.weights;
      }
      for (const node of json.nodes as Record<string, unknown>[]) {
        delete node.weights;
        delete node.morphTargetInfluences;
      }
    });
    const report = validateExportedGLB(broken, expectation());
    expect(report.ok).toBe(false);
    const morphChecks = report.checks.filter((check) => check.id.startsWith('morphs-'));
    expect(morphChecks.length).toBeGreaterThan(0);
    expect(morphChecks.every((check) => check.status === 'fail')).toBe(true);
  });
});
