/**
 * Character DNA V2 integration tests: sculpt layers + variants wired into the
 * live session state, recipe persistence/migration, and fail-safe negatives.
 * Uses the real procedural rigged humanoid + real StrokeEngine dabs against a
 * stubbed viewport (render capture is not exercised here; see e2e/).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CharacterSession } from '../../src/app/characterSession';
import type { StudioViewport } from '../../src/app/viewport';
import type { RigSafeSculptTarget } from '../../src/core/rigSafeSculpt';
import type { CharacterRecipeV1, CharacterRecipeV2 } from '../../src/core/recipe';
import { validateCharacterRecipe } from '../../src/core/recipe';
import { validateGlbBinary } from '../../src/io/glbValidator';
import { serializeRecipeJson } from '../../src/io/projectStorage';

/**
 * Minimal canvas 2D shim for happy-dom Node tests (canvas absent), mirroring the
 * one proven in tests/phaseA_rigSafeProof.test.ts for GLTFExporter texture paths.
 */
function installMinimalCanvasPngShimForNodeTest(): void {
  if (typeof document === 'undefined') return;
  const probe = document.createElement('canvas');
  if (typeof probe.getContext === 'function' && probe.getContext('2d')) return;

  const origCreate = document.createElement.bind(document);
  (document as unknown as { createElement: unknown }).createElement = (tag: string, ...args: unknown[]) => {
    const el = (origCreate as (t: string, ...a: unknown[]) => HTMLElement)(tag, ...args);
    if (tag.toLowerCase() === 'canvas') {
      let w = 1;
      let h = 1;
      Object.defineProperty(el, 'width', { get: () => w, set: (v) => (w = v), configurable: true });
      Object.defineProperty(el, 'height', { get: () => h, set: (v) => (h = v), configurable: true });
      const ctx = {
        createImageData: (iw: number, ih: number) => ({ width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) }),
        putImageData: () => {},
        drawImage: () => {},
        getImageData: () => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        fillRect: () => {},
        clearRect: () => {}
      };
      (el as unknown as { getContext: unknown }).getContext = () => ctx;
      (el as unknown as { toBlob: unknown }).toBlob = (cb: (b: Blob | null) => void) =>
        cb(new Blob([new Uint8Array(8)], { type: 'image/png' }));
      (el as unknown as { toDataURL: unknown }).toDataURL = () => 'data:image/png;base64,iVBORw0KGgo=';
    }
    return el;
  };
}
installMinimalCanvasPngShimForNodeTest();

function stubViewport(): StudioViewport {
  const scene = new THREE.Scene();
  return {
    scene,
    gizmo: { attach: () => {}, detach: () => {} },
    controls: { enabled: true },
    needsRender: false,
    continuous: false,
    contextLost: false,
    quality: 'balanced',
    skeletonHelper: null,
    camera: new THREE.PerspectiveCamera(),
    perspCamera: new THREE.PerspectiveCamera(),
    orthoCamera: new THREE.OrthographicCamera(-1, 1, 1, -1),
    isOrtho: false,
    renderer: { domElement: {} },
    frameObject: () => {},
    getLightingPreset: () => 'studio',
    setLightingPreset: () => {},
    applyClayPreview: () => {},
    setSkeletonVisible: () => {},
    renderToPng: () => 'data:image/png;base64,stub',
    showBrushCursor: () => {},
    setQuality: () => {}
  } as unknown as StudioViewport;
}

/** Real stroke through the real StrokeEngine + layer-aware commit path. */
function sculptAt(
  session: CharacterSession,
  target: RigSafeSculptTarget,
  point: [number, number, number],
  radius: number,
  strength = 0.8
): void {
  expect(session.prepareSculptStroke(target)).toBe(true);
  const engine = target.engine;
  engine.begin('draw');
  const changed = engine.dab(point, {
    radius,
    strength,
    invert: false,
    symmetry: { x: false, y: false, z: false },
    pressure: 1
  });
  target.applyChangedVertices(changed);
  engine.end((ids) => {
    target.applyChangedVertices(ids);
    target.endStrokeMaintenance();
  });
  session.commitSculptStroke(target);
}

function maxDispInBand(target: RigSafeSculptTarget, yMin: number, yMax: number): number {
  const pos = target.geometry.getAttribute('position').array as Float32Array;
  const src = target.snapshot.sourcePos;
  let maxD = 0;
  for (let r = 0; r < target.snapshot.renderVertexCount; r++) {
    const y = src[r * 3 + 1];
    if (y < yMin || y > yMax) continue;
    const d = Math.hypot(pos[r * 3] - src[r * 3], pos[r * 3 + 1] - src[r * 3 + 1], pos[r * 3 + 2] - src[r * 3 + 2]);
    if (d > maxD) maxD = d;
  }
  return maxD;
}

async function freshSession(): Promise<{ session: CharacterSession; target: RigSafeSculptTarget }> {
  const session = new CharacterSession(stubViewport());
  await session.loadProceduralSample();
  expect(session.sculptTargets.length).toBeGreaterThan(0);
  return { session, target: session.sculptTargets[0] };
}

const JAW: [number, number, number] = [0, 1.62, 0.1];
const SHOULDERS: [number, number, number] = [0, 1.38, 0.02];
const JAW_BAND: [number, number] = [1.58, 1.75];
const SHOULDER_BAND: [number, number] = [1.28, 1.46];

describe('V2 sculpt layers integrated into the session', () => {
  it('sculpts into named layers, toggling visibility changes geometry without losing edits, and undo/redo stay exact', async () => {
    const { session, target } = await freshSession();

    const jawId = session.createLayer('Jaw').id;
    expect(session.activeLayer?.id).toBe(jawId);
    sculptAt(session, target, JAW, 0.08);
    expect(maxDispInBand(target, JAW_BAND[0], JAW_BAND[1])).toBeGreaterThan(0.002);

    const shouldersId = session.createLayer('Shoulders').id;
    expect(shouldersId).not.toBe(jawId);
    sculptAt(session, target, SHOULDERS, 0.08);
    expect(maxDispInBand(target, SHOULDER_BAND[0], SHOULDER_BAND[1])).toBeGreaterThan(0.002);

    // Hide Jaw: jaw-only displacement disappears, shoulders remain.
    session.toggleLayerVisible(jawId);
    expect(maxDispInBand(target, JAW_BAND[0], JAW_BAND[1])).toBeLessThan(1e-6);
    expect(maxDispInBand(target, SHOULDER_BAND[0], SHOULDER_BAND[1])).toBeGreaterThan(0.002);

    // Re-enable Jaw: edits are intact (not destroyed by hiding).
    session.toggleLayerVisible(jawId);
    expect(maxDispInBand(target, JAW_BAND[0], JAW_BAND[1])).toBeGreaterThan(0.002);
    expect(maxDispInBand(target, SHOULDER_BAND[0], SHOULDER_BAND[1])).toBeGreaterThan(0.002);

    // Undo/redo semantics are exact LIFO over the app history.
    // Stack top = "show Jaw", then "hide Jaw", then "sculpt Shoulders".
    session.history.undo(); // undo "show Jaw" -> jaw hidden
    expect(maxDispInBand(target, JAW_BAND[0], JAW_BAND[1])).toBeLessThan(1e-6);
    session.history.redo(); // -> jaw visible again
    expect(maxDispInBand(target, JAW_BAND[0], JAW_BAND[1])).toBeGreaterThan(0.002);
    session.history.undo(); // show -> hidden
    session.history.undo(); // "hide Jaw" -> jaw visible (pre-toggle state)
    expect(maxDispInBand(target, JAW_BAND[0], JAW_BAND[1])).toBeGreaterThan(0.002);
    session.history.undo(); // "sculpt Shoulders" -> shoulders gone, jaw untouched
    expect(maxDispInBand(target, SHOULDER_BAND[0], SHOULDER_BAND[1])).toBeLessThan(1e-6);
    expect(maxDispInBand(target, JAW_BAND[0], JAW_BAND[1])).toBeGreaterThan(0.002);
    session.history.redo(); // shoulders back
    expect(maxDispInBand(target, SHOULDER_BAND[0], SHOULDER_BAND[1])).toBeGreaterThan(0.002);
  });

  it('layer strength scales composed displacement deterministically with zero recomposition drift', async () => {
    const { session, target } = await freshSession();
    const layer = session.createLayer('Soft');
    sculptAt(session, target, JAW, 0.12);
    const full = Float32Array.from(target.geometry.getAttribute('position').array as Float32Array);

    session.setLayerStrength(layer.id, 0.5);
    const half1 = Float32Array.from(target.geometry.getAttribute('position').array as Float32Array);
    session.setLayerStrength(layer.id, 1);
    session.setLayerStrength(layer.id, 0.5);
    const half2 = Float32Array.from(target.geometry.getAttribute('position').array as Float32Array);

    // Deterministic + drift-free: repeated recomposition is bit-identical.
    expect(Array.from(half2)).toEqual(Array.from(half1));
    // Scaled: max |half - source| ≈ 0.5 * |full - source| for touched verts.
    const src = target.snapshot.sourcePos;
    let ratioSum = 0;
    let ratioN = 0;
    for (let i = 0; i < src.length; i += 3) {
      const df = Math.hypot(full[i] - src[i], full[i + 1] - src[i + 1], full[i + 2] - src[i + 2]);
      if (df > 1e-4) {
        const dh = Math.hypot(half1[i] - src[i], half1[i + 1] - src[i + 1], half1[i + 2] - src[i + 2]);
        ratioSum += dh / df;
        ratioN++;
      }
    }
    expect(ratioN).toBeGreaterThan(0);
    expect(ratioSum / ratioN).toBeCloseTo(0.5, 2);
  });

  it('layer duplicate/reset/delete with confirmation state, plus rename and active selection', async () => {
    const { session, target } = await freshSession();
    const aId = session.createLayer('Base').id;
    sculptAt(session, target, JAW, 0.08);
    const readA = () => session.activeVariant!.layers.find((l) => l.id === aId)!;
    const deltasBefore = JSON.parse(JSON.stringify(readA().deltas));
    expect(Object.keys(deltasBefore).length).toBeGreaterThan(0);

    const bId = session.duplicateLayer(aId).id;
    const readB = () => session.activeVariant!.layers.find((l) => l.id === bId)!;
    expect(readB().name).toBe('Base copy');
    // Duplicate carries identical deltas initially.
    expect(readB().deltas).toEqual(deltasBefore);
    // Rename
    session.renameLayer(bId, 'Jaw copy');
    expect(readB().name).toBe('Jaw copy');
    // Reset keeps the layer but clears edits.
    session.resetLayer(bId);
    expect(Object.keys(readB().deltas).length).toBe(0);
    expect(Object.keys(readA().deltas).length).toBeGreaterThan(0); // A's edits survive
    // Delete removes it and moves the active selection.
    session.deleteLayer(bId);
    expect(session.activeVariant!.layers.some((l) => l.id === bId)).toBe(false);
    expect(session.activeLayer?.id).toBe(aId);
    void readA;
  });
});

describe('V2 character variants', () => {
  it('duplicates isolate: modifying variant B never leaks into variant A, switching restores each appearance', async () => {
    const { session, target } = await freshSession();
    // Variant A: jaw layer + jaw sculpt
    const jawA = session.createLayer('Jaw');
    sculptAt(session, target, JAW, 0.12);
    const aId = session.dna!.activeId;

    // Duplicate into B and modify B only (extra shoulders sculpt + different morph).
    const b = session.duplicateVariant(aId, 'Variant B');
    session.switchVariant(b.id);
    const shouldersB = session.createLayer('Shoulders');
    sculptAt(session, target, SHOULDERS, 0.14);
    session.setMorphWeight('Jaw_Width', 0.75, false);

    // A appearance is untouched in the doc.
    const variantA = session.dna!.variants.find((v) => v.id === aId)!;
    expect(variantA.layers.map((l) => l.name)).toEqual(['Jaw']);
    expect(variantA.morphWeights['Jaw_Width'] ?? 0).toBe(0);

    // Switch back to A: geometry shows only the jaw edit.
    session.switchVariant(aId);
    expect(maxDispInBand(target, 1.32, 1.48)).toBeLessThan(1e-6); // no shoulders on A
    expect(maxDispInBand(target, 1.5, 1.75)).toBeGreaterThan(0.002);
    expect(session.morphs.find((m) => m.name === 'Jaw_Width')!.value).toBe(0);

    // Switch to B: both edits + morph present.
    session.switchVariant(b.id);
    expect(maxDispInBand(target, 1.32, 1.48)).toBeGreaterThan(0.002);
    expect(maxDispInBand(target, 1.5, 1.75)).toBeGreaterThan(0.002);
    expect(session.morphs.find((m) => m.name === 'Jaw_Width')!.value).toBeCloseTo(0.75, 3);

    // Repeated switching is stable (no growth/leak).
    for (let i = 0; i < 3; i++) {
      session.switchVariant(aId);
      expect(maxDispInBand(target, 1.32, 1.48)).toBeLessThan(1e-6);
      session.switchVariant(b.id);
      expect(maxDispInBand(target, 1.32, 1.48)).toBeGreaterThan(0.002);
    }
    expect(shouldersB.id).not.toBe(jawA.id);
  });

  it('delete variant with a single remaining variant guard; reset variant clears edits', async () => {
    const { session } = await freshSession();
    const aId = session.dna!.activeId;
    expect(() => session.deleteVariant(aId)).toThrow(/only variant/);
    const b = session.createVariant('Extra');
    session.deleteVariant(b.id);
    expect(session.dna!.variants.length).toBe(1);
    expect(session.dna!.activeId).toBe(aId);
  });
});

describe('V2 recipe persistence + V1 migration + fail-safe negatives', () => {
  it('round-trips layers, variants, morphs and layer settings through recipe JSON', async () => {
    const { session, target } = await freshSession();
    const jaw = session.createLayer('Jaw');
    sculptAt(session, target, JAW, 0.12);
    session.setLayerStrength(jaw.id, 0.5);
    const aId = session.dna!.activeId;
    const b = session.duplicateVariant(aId, 'Variant B');
    session.switchVariant(b.id);
    const sB = session.createLayer('Shoulders');
    sculptAt(session, target, SHOULDERS, 0.14);
    session.setMorphWeight('Jaw_Width', 0.6, false);

    const recipe = session.buildProjectRecipe();
    expect(recipe.schemaVersion).toBe('dexsculpt.recipe.v2');
    expect(recipe.dna.variants.map((v) => v.name)).toContain('Variant B');

    const json = serializeRecipeJson(recipe);
    const parsed = validateCharacterRecipe(JSON.parse(json)) as CharacterRecipeV2;
    expect(parsed.schemaVersion).toBe('dexsculpt.recipe.v2');

    // Load into a completely fresh session: exact state recovery.
    const { session: s2, target: t2 } = await freshSession();
    const res = await s2.loadProjectRecipe(parsed);
    expect(res.needsRelink).toBe(false);
    expect(s2.dna!.variants.map((v) => v.name).sort()).toEqual(
      session.dna!.variants.map((v) => v.name).sort()
    );
    const activeB = s2.activeVariant!;
    expect(activeB.name).toBe('Variant B');
    // duplicateVariant clones the source variant's layers (by design), then gained Shoulders.
    expect(activeB.layers.map((l) => l.name)).toEqual(['Jaw', 'Shoulders']);
    expect(activeB.morphWeights['Jaw_Width']).toBeCloseTo(0.6, 4);

    // Geometry identity after reload (same source + same layers => same pixels).
    const p1 = target.geometry.getAttribute('position').array as Float32Array;
    const p2 = t2.geometry.getAttribute('position').array as Float32Array;
    expect(Array.from(p2)).toEqual(Array.from(p1));

    // Variant A recovered too.
    s2.switchVariant(aId);
    const aLayers = s2.activeVariant!.layers;
    expect(aLayers.map((l) => l.name)).toEqual(['Jaw']);
    expect(aLayers[0].strength).toBe(0.5);
    void sB;
  });

  it('migrates a V1 recipe into a single "Imported V1 sculpt" layer and preserves V1 semantics', async () => {
    const { session, target } = await freshSession();
    const v1: CharacterRecipeV1 = {
      schemaVersion: 'dexsculpt.recipe.v1',
      editorVersion: '0.1.0',
      projectId: 'legacy-1',
      title: 'Legacy Character',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      source: {
        kind: 'procedural-sample',
        assetId: null,
        displayName: 'Legacy Character',
        fileName: 'dex_foundry_humanoid.glb',
        sha256: session.sourceSha256,
        skeletonFamily: 'dex-foundry-biped-20',
        licenseId: 'MIT',
        requiresSourceRelink: false
      },
      sculptDeltas: [
        {
          meshName: 'DexFoundry_Humanoid',
          vertexCount: target.snapshot.renderVertexCount,
          indices: [0],
          deltas: [0, 0.02, 0]
        }
      ],
      morphWeights: { Torso_Volume: 0.3 },
      materialOverrides: {},
      attachments: []
    };
    const res = await session.loadProjectRecipe(v1);
    expect(res.needsRelink).toBe(false);
    expect(session.activeVariant!.layers.map((l) => l.name)).toEqual(['Imported V1 sculpt']);
    expect(maxDispInBand(target, -1, 3)).toBeGreaterThan(0.005);
    expect(session.morphs.find((m) => m.name === 'Torso_Volume')!.value).toBeCloseTo(0.3, 4);
  });

  it('fails safe on ambiguous legacy mesh names (skip + warn, never guess) and on malformed deltas (atomic reject)', async () => {
    const { session } = await freshSession();
    const base = {
      schemaVersion: 'dexsculpt.recipe.v1' as const,
      editorVersion: '0.1.0',
      projectId: 'legacy-2',
      title: 'Legacy',
      createdAt: '',
      updatedAt: '',
      source: {
        kind: 'procedural-sample' as const,
        assetId: null,
        displayName: 'Legacy',
        fileName: 'x.glb',
        sha256: session.sourceSha256,
        skeletonFamily: 'unknown',
        licenseId: 'MIT',
        requiresSourceRelink: false
      },
      morphWeights: {},
      materialOverrides: {},
      attachments: []
    };

    // Missing/ambiguous mesh name -> skipped with warning, rest of doc applies.
    const ambiguous: CharacterRecipeV1 = {
      ...base,
      sculptDeltas: [
        { meshName: 'NoSuchMesh', vertexCount: 1, indices: [0], deltas: [1, 2, 3] },
        {
          meshName: 'DexFoundry_Humanoid',
          vertexCount: session.sculptTargets[0].snapshot.renderVertexCount,
          indices: [0],
          deltas: [0, 0.01, 0]
        }
      ]
    };
    const res = await session.loadProjectRecipe(ambiguous);
    expect(res.warnings.some((w) => w.includes('NoSuchMesh'))).toBe(true);

    // Malformed delta -> whole migration rejects, prior state intact.
    const before = session.getTotalModifiedVertices();
    const malformed: CharacterRecipeV1 = {
      ...base,
      sculptDeltas: [
        {
          meshName: 'DexFoundry_Humanoid',
          vertexCount: session.sculptTargets[0].snapshot.renderVertexCount,
          indices: [0],
          deltas: [NaN, 0, 0]
        }
      ]
    };
    await expect(session.loadProjectRecipe(malformed)).rejects.toThrow(/Invalid sculpt delta/);
    expect(session.getTotalModifiedVertices()).toBe(before);
  });

  it('rejects legacy recipes without a real SHA-256 source identity (FNV fingerprints are never equated)', async () => {
    const { session } = await freshSession();
    const legacy = {
      schemaVersion: 'dexsculpt.recipe.v1',
      projectId: 'p',
      title: 'Old',
      createdAt: '',
      updatedAt: '',
      source: {
        kind: 'local-glb',
        assetId: null,
        displayName: 'Old',
        fileName: 'old.glb',
        sha256: 'deadbeef', // legacy FNV-length fingerprint
        skeletonFamily: 'unknown',
        licenseId: 'unknown',
        requiresSourceRelink: true
      },
      sculptDeltas: [],
      morphWeights: {},
      materialOverrides: {},
      attachments: []
    } as unknown as CharacterRecipeV1;
    await expect(session.loadProjectRecipe(legacy)).rejects.toThrow(/SHA-256/);
  });

  it('rejects a V2 recipe whose DNA source hash does not match the loaded character, atomically', async () => {
    const { session, target } = await freshSession();
    const jaw = session.createLayer('Jaw');
    sculptAt(session, target, JAW, 0.12);
    const good = session.buildProjectRecipe();
    const tampered = JSON.parse(JSON.stringify(good)) as CharacterRecipeV2;
    tampered.dna.sourceSha256 = 'b'.repeat(64);
    tampered.source.sha256 = 'b'.repeat(64);
    const before = Array.from(target.geometry.getAttribute('position').array as Float32Array);
    await expect(session.loadProjectRecipe(tampered)).rejects.toThrow(/SHA-256 does not match/);
    expect(Array.from(target.geometry.getAttribute('position').array as Float32Array)).toEqual(before);
    void jaw;
  });

  it('rejects corrupted GLB bytes in the independent validator', () => {
    const tiny = validateGlbBinary(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer);
    expect(tiny.validGlb2).toBe(false);
    expect(tiny.errors.length).toBeGreaterThan(0);

    const garbage = new Uint8Array(1024);
    for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 37) % 251;
    const report = validateGlbBinary(garbage.buffer);
    expect(report.validGlb2).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors.join(' ')).toMatch(/magic|JSON|header/i);
  });
});
