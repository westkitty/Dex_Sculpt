// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { buildWeldMap } from '../src/sculpt/weld';
import { SpatialIndex } from '../src/sculpt/spatialIndex';
import { SculptEngine } from '../src/sculpt/engine';
import { getExample } from '../src/fixtures/registry';
import { loadCharacter } from '../src/character/loader';
import type { Character, MeshRecord } from '../src/character/character';

const settings = (overrides: Partial<Parameters<SculptEngine['begin']>[1]> = {}) => ({
  tool: 'clay' as const,
  radius: 0.08,
  strength: 0.7,
  symmetry: { x: false },
  invert: false,
  pressure: 1,
  ...overrides,
});

const hit = (point: [number, number, number] = [0, 1.2, 0.1]) => ({
  point,
  normal: [0, 0, 1] as [number, number, number],
  viewDir: [0, 0, -1] as [number, number, number],
  mirrorPlane: { origin: [0, 0, 0] as [number, number, number], axis: [1, 0, 0] as [number, number, number] },
});

describe('weld map', () => {
  it('merges duplicated positions into weld groups and keeps a representative', () => {
    // Two triangles that share two corners through duplicated vertices.
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      1, 0, 0, 1, 1, 0, 0, 1, 0,
    ]);
    const weld = buildWeldMap(positions, 6, [0, 1, 2, 3, 4, 5], 1);
    expect(weld.groupCount).toBe(4);
    expect(weld.weldedVertices).toBe(2);
    const sharedGroup = weld.groupOf[1];
    const shared = weld.groupList.slice(weld.groupStart[sharedGroup], weld.groupStart[sharedGroup + 1]);
    expect(Array.from(shared)).toContain(3);
  });

  it('indexes group representatives, so a stroke finds the right vertices', () => {
    const positions = new Float32Array([0, 0, 0, 0.02, 0, 0, 0.5, 0, 0]);
    const weld = buildWeldMap(positions, 3, [0, 1, 2], 0.6);
    const groupPositions = new Float32Array(weld.groupCount * 3);
    for (let group = 0; group < weld.groupCount; group++) {
      const rep = weld.groupList[weld.groupStart[group]];
      groupPositions[group * 3] = positions[rep * 3];
      groupPositions[group * 3 + 1] = positions[rep * 3 + 1];
      groupPositions[group * 3 + 2] = positions[rep * 3 + 2];
    }
    const index = new SpatialIndex(groupPositions, weld.groupCount);
    const out = new Uint32Array(8);
    const found = index.query(0, 0, 0, 0.05, out);
    expect(found).toBe(2);
  });
});

describe('SculptEngine', () => {
  let character: Character;
  let record: MeshRecord;

  beforeAll(async () => {
    const example = getExample('foundry-humanoid')!;
    const bytes = await example.build();
    character = await loadCharacter(bytes, { sourceKind: 'example', fixtureId: example.id, fileName: 'fixture.glb' });
    record = character.meshes[0];
  });

  beforeEach(() => {
    character.resetAllSculpt();
  });

  it('clay moves geometry, reports the change set and leaves skin data untouched', () => {
    const skinBefore = JSON.stringify(character.hashSkinAttributes());
    const engine = new SculptEngine(character.getTarget(record));
    engine.begin('clay', settings(), hit());
    for (let i = 0; i < 4; i++) engine.dab([0, 1.2 + i * 0.004, 0.1], 1, false);
    const result = engine.end();
    expect(result).not.toBeNull();
    expect(result!.changedGroups.length).toBeGreaterThan(10);
    const stats = new SculptEngine(character.getTarget(record)).getDeltaStats();
    expect(stats.maxDelta).toBeGreaterThan(0.002);
    expect(Number.isFinite(stats.maxDelta)).toBe(true);
    expect(JSON.stringify(character.hashSkinAttributes())).toBe(skinBefore);
  });

  it('mirrors strokes across the X plane when symmetry is enabled', () => {
    const weld = record.weld;
    const repOf = (group: number) => weld.groupList[weld.groupStart[group]];
    const engine = new SculptEngine(character.getTarget(record));
    engine.begin('clay', settings({ symmetry: { x: true } }), hit([0.12, 1.2, 0.1]));
    engine.dab([0.12, 1.2, 0.1], 1, false);
    engine.end();

    // The procedural fixture's surface is not perfectly mirror-symmetric (its
    // voxel grid is), so the assertion is about coverage and comparable energy,
    // not about vertex-exact twins.
    let rightGroups = 0;
    let leftGroups = 0;
    let rightEnergy = 0;
    let leftEnergy = 0;
    for (let group = 0; group < weld.groupCount; group++) {
      const rep = repOf(group);
      const dx = record.delta[rep * 3];
      const dy = record.delta[rep * 3 + 1];
      const dz = record.delta[rep * 3 + 2];
      const magnitude = Math.hypot(dx, dy, dz);
      if (magnitude <= 1e-6) continue;
      if (record.basePosition[rep * 3] > 0) {
        rightGroups++;
        rightEnergy += magnitude;
      } else {
        leftGroups++;
        leftEnergy += magnitude;
      }
    }
    expect(rightGroups).toBeGreaterThan(10);
    expect(leftGroups).toBeGreaterThan(10);
    expect(leftEnergy / rightEnergy).toBeGreaterThan(0.6);
    expect(leftEnergy / rightEnergy).toBeLessThan(1.6);
  });

  it('painted mask freezes the vertices underneath it', () => {
    const weld = record.weld;
    const engine = new SculptEngine(character.getTarget(record));
    engine.begin('mask', settings({ tool: 'mask', strength: 1 }), hit());
    for (let i = 0; i < 20; i++) engine.dab([0, 1.2, 0.1], 1, false);
    const painted = engine.end();
    expect(painted?.maskChanges).toBe(true);
    let frozen = 0;
    for (let group = 0; group < weld.groupCount; group++) {
      const rep = weld.groupList[weld.groupStart[group]];
      if (record.mask[rep] > 0.999) frozen++;
    }
    expect(frozen).toBeGreaterThanOrEqual(3);
    expect(character.maskCoverage()).toBeGreaterThan(0.0005);

    const before = Float32Array.from(record.delta);
    const clay = new SculptEngine(character.getTarget(record));
    clay.begin('clay', settings({ strength: 1 }), hit());
    clay.dab([0, 1.2, 0.1], 1, false);
    clay.end();
    let worstFrozenMove = 0;
    let worstFreeMove = 0;
    for (let group = 0; group < weld.groupCount; group++) {
      const rep = weld.groupList[weld.groupStart[group]];
      const moved = Math.max(
        Math.abs(record.delta[rep * 3] - before[rep * 3]),
        Math.abs(record.delta[rep * 3 + 1] - before[rep * 3 + 1]),
        Math.abs(record.delta[rep * 3 + 2] - before[rep * 3 + 2]),
      );
      if (record.mask[rep] > 0.999) worstFrozenMove = Math.max(worstFrozenMove, moved);
      else if (record.mask[rep] < 0.1) worstFreeMove = Math.max(worstFreeMove, moved);
    }
    expect(worstFrozenMove).toBeLessThan(1.5e-4);
    expect(worstFreeMove).toBeGreaterThan(worstFrozenMove * 2);
  });

  it('smooth relaxes a spike instead of adding volume', () => {
    const weld = record.weld;
    // Raise one group hard, then smooth it.
    const target = 0;
    const rep = weld.groupList[weld.groupStart[target]];
    for (let k = weld.groupStart[target]; k < weld.groupStart[target + 1]; k++) {
      record.delta[weld.groupList[k] * 3 + 1] = 0.04;
    }
    character.commitGroups(record, new Uint32Array([target]), 1);
    const before = record.delta[rep * 3 + 1];
    const engine = new SculptEngine(character.getTarget(record));
    const point: [number, number, number] = [
      record.positionAttr.getX(rep),
      record.positionAttr.getY(rep),
      record.positionAttr.getZ(rep),
    ];
    engine.begin('smooth', settings({ radius: 0.06, strength: 1 }), hit(point));
    engine.dab(point, 1, false);
    engine.end();
    expect(Math.abs(record.delta[rep * 3 + 1])).toBeLessThan(Math.abs(before));
  });

  it('grab drags a captured region and nothing else', () => {
    const weld = record.weld;
    const rep = weld.groupList[weld.groupStart[0]];
    const point: [number, number, number] = [
      record.positionAttr.getX(rep),
      record.positionAttr.getY(rep),
      record.positionAttr.getZ(rep),
    ];
    const before = Float32Array.from(record.delta);
    const engine = new SculptEngine(character.getTarget(record));
    engine.begin('grab', settings({ radius: 0.05 }), hit(point));
    engine.drag([0.01, 0, 0]);
    engine.end();
    let moved = 0;
    for (let vertex = 0; vertex < record.vertexCount; vertex++) {
      if (Math.abs(record.delta[vertex * 3] - before[vertex * 3]) > 1e-6) moved++;
    }
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(record.vertexCount / 2);
  });
});
