// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { getExample } from '../src/fixtures/registry';
import { loadCharacter } from '../src/character/loader';
import { exportCharacterGLB, preflightExport } from '../src/character/exporter';
import { verifyReimport } from '../src/validation/reimport';
import { SculptEngine } from '../src/sculpt/engine';
import type { Character, MeshRecord } from '../src/character/character';

let bytes: ArrayBuffer;
let character: Character;
let record: MeshRecord;
let baseline: { skin: string; base: number; morphs: number; clips: number };

beforeAll(async () => {
  const example = getExample('foundry-humanoid');
  expect(example).toBeDefined();
  bytes = await example!.build();
  character = await loadCharacter(bytes.slice(0), {
    sourceKind: 'example',
    fixtureId: example!.id,
    fileName: 'foundry-humanoid.glb',
    license: example!.license,
    skeletonFamily: example!.skeletonFamily,
  });
  record = character.meshes.find((mesh) => mesh.skinned)!;
  baseline = {
    skin: JSON.stringify(character.hashSkinAttributes()),
    base: record.basePosition.reduce((acc, value) => acc + Math.abs(value), 0),
    morphs: character.meshes.reduce((acc, mesh) => acc + mesh.morphTargets.length, 0),
    clips: character.clips.length,
  };
});

function clayStroke(): number {
  const engine = new SculptEngine(character.getTarget(record));
  engine.begin(
    'clay',
    { tool: 'clay', radius: 0.09, strength: 0.8, symmetry: { x: true }, invert: false, pressure: 1 },
    {
      point: [0, 1.24, 0.1],
      normal: [0, 0, 1],
      viewDir: [0, 0, -1],
      mirrorPlane: { origin: [0, 0, 0], axis: [1, 0, 0] },
    },
  );
  for (let i = 0; i < 6; i++) engine.dab([0, 1.24 + i * 0.005, 0.1], 1, false);
  const result = engine.end();
  expect(result).not.toBeNull();
  character.flushNormals();
  return result!.changedGroups.length;
}

describe('Phase A round trip', () => {
  it('sculpts real geometry without touching base positions or skin data', () => {
    const groupsBefore = clayStroke();
    expect(groupsBefore).toBeGreaterThan(0);
    const stats = new SculptEngine(character.getTarget(record)).getDeltaStats();
    expect(stats.maxDelta).toBeGreaterThan(0.005);
    expect(stats.movedVertices).toBeGreaterThan(100);
    // Base positions and skin attributes are immutable.
    expect(JSON.stringify(character.hashSkinAttributes())).toBe(baseline.skin);
    expect(record.basePosition.reduce((acc, value) => acc + Math.abs(value), 0)).toBeCloseTo(baseline.base, 6);
    expect(character.meshes.reduce((acc, mesh) => acc + mesh.morphTargets.length, 0)).toBe(baseline.morphs);
    expect(character.clips.length).toBe(baseline.clips);
  });

  it('passes preflight and exports a structurally valid GLB', async () => {
    expect(preflightExport(character).ok).toBe(true);
    const result = await exportCharacterGLB(character);
    expect(result.report.ok).toBe(true);
    const failed = result.report.checks.filter((check) => check.status === 'fail');
    expect(failed, failed.map((check) => `${check.id}: ${check.detail}`).join('\n')).toHaveLength(0);
    const ids = result.report.checks.map((check) => check.id);
    expect(ids).toContain('inverse-bind-matrices');
    expect(ids).toContain('joints-Body');
    expect(ids).toContain('positions-Body');
    expect(result.report.facts.changedVertexCount).toBeGreaterThan(0);
    expect(result.report.facts.animationCount).toBe(baseline.clips);
  });

  it('re-imports the edited file with skinning, morphs and clips intact', async () => {
    const result = await exportCharacterGLB(character, {});
    const reimport = await verifyReimport(result.bytes, character);
    const failed = reimport.checks.filter((check) => check.status === 'fail');
    expect(failed, failed.map((check) => `${check.id}: ${check.detail}`).join('\n')).toHaveLength(0);
    expect(reimport.ok).toBe(true);
    expect(reimport.maxPositionError).toBeLessThan(1e-5);
    const moved = Math.max(...reimport.probes.map((probe) => probe.moved));
    expect(moved).toBeGreaterThan(0.004);
    expect(reimport.morphProbe?.movedVertices ?? 0).toBeGreaterThan(0);
    expect(reimport.checks.some((check) => check.id === 'reimport-ibm')).toBe(true);
  });

  it('keeps materials and UVs byte-identical in the exported file', async () => {
    const result = await exportCharacterGLB(character, {});
    const uvChecks = result.report.checks.filter((check) => check.id.startsWith('uv-'));
    expect(uvChecks.length).toBeGreaterThan(0);
    expect(uvChecks.every((check) => check.status === 'pass' && /byte-identical/.test(check.detail))).toBe(true);
    const materialCheck = result.report.checks.find((check) => check.id === 'materials');
    expect(materialCheck?.status).toBe('pass');
    expect(character.meshes.every((mesh) => mesh.hasUVs)).toBe(true);
  });
});
