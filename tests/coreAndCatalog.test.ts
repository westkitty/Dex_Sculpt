import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BRUSHES, type BrushId } from '../src/core/brushes';
import { hashBytes, maxPositionDelta } from '../src/core/topology';
import { createProceduralHumanoid } from '../src/fixtures/proceduralHumanoid';
import { RigSafeSculptTarget } from '../src/core/rigSafeSculpt';
import {
  assessCatalogCompatibility,
  detectSkeletonFamilyFromBones,
  getCatalogRecord,
  getCatalogSummary,
  searchCatalog
} from '../src/catalog/catalogService';
import {
  attachProceduralModularItem,
  checkAttachmentCompatibility
} from '../src/modular/assembly';
import { parseRecipeJson, serializeRecipeJson } from '../src/io/projectStorage';
import { validateCharacterRecipe, type CharacterRecipeV1 } from '../src/core/recipe';
import { importCharacterBytes } from '../src/io/glbPipeline';
import { StudioViewport } from '../src/app/viewport';
import { tiltFromVertical, tiltScale } from '../src/app/sculptTool';

describe('Sculpt Brushes, Masking, Symmetry & Non-Destructive Deltas', () => {
  it('produces distinct geometric outcomes across all 8 displacement brushes + mask protection', () => {
    const base = createProceduralHumanoid();
    const hashes = new Map<BrushId, string>();
    const sculptable: BrushId[] = ['draw', 'inflate', 'clay', 'smooth', 'flatten', 'pinch', 'crease'];

    for (const brush of sculptable) {
      const b = createProceduralHumanoid();
      const target = new RigSafeSculptTarget(b.skinnedMesh);
      target.engine.begin(brush);
      // Pre-bump for smooth/flatten so they have curvature to relax
      if (brush === 'smooth' || brush === 'flatten') {
        target.engine.cancel();
        target.engine.begin('draw');
        const pre = target.engine.dab([0.08, 1.25, 0.12], {
          radius: 0.16,
          strength: 1,
          invert: false,
          symmetry: { x: false, y: false, z: false }
        });
        target.applyChangedVertices(pre);
        target.engine.end((ids) => target.applyChangedVertices(ids));
        target.engine.begin(brush);
      }

      const deltaParam = brush === 'smooth' || brush === 'flatten' ? 1 : 0;
      const changed = target.engine.dab([0.08, 1.25 + deltaParam * 0.01, 0.12], {
        radius: 0.16,
        strength: 0.85,
        invert: false,
        symmetry: { x: true, y: false, z: false }
      });
      target.applyChangedVertices(changed);
      target.engine.end((ids) => target.applyChangedVertices(ids));
      hashes.set(brush, hashBytes(b.skinnedMesh.geometry.getAttribute('position').array as Float32Array));
      target.dispose();
    }

    // Grab brush
    const grabB = createProceduralHumanoid();
    const grabTarget = new RigSafeSculptTarget(grabB.skinnedMesh);
    grabTarget.engine.begin('grab');
    grabTarget.engine.grabStart([0.08, 1.25, 0.12], 0.16, { x: true, y: false, z: false });
    const grabChanged = grabTarget.engine.grabMove([0.03, 0.02, 0.05], 1);
    grabTarget.applyChangedVertices(grabChanged);
    grabTarget.engine.end((ids) => grabTarget.applyChangedVertices(ids));
    hashes.set('grab', hashBytes(grabB.skinnedMesh.geometry.getAttribute('position').array as Float32Array));
    grabTarget.dispose();

    const uniqueHashes = new Set(hashes.values());
    expect(uniqueHashes.size).toBe(BRUSHES.length - 1); // all 8 geometry brushes distinct

    // Mask freeze check
    const maskB = createProceduralHumanoid();
    const maskTarget = new RigSafeSculptTarget(maskB.skinnedMesh);
    maskTarget.engine.begin('mask');
    const maskedIds = maskTarget.engine.dab([0.0, 1.25, 0.12], {
      radius: 0.3,
      strength: 1,
      invert: false,
      symmetry: { x: true, y: false, z: false }
    });
    expect(maskedIds.length).toBeGreaterThan(10);
    // Force full 1.0 freeze on those unique vertices
    for (let i = 0; i < maskedIds.length; i++) maskTarget.mesh.mask[maskedIds[i]] = 1;
    maskTarget.engine.end((ids) => maskTarget.applyChangedVertices(ids));

    const beforePos = new Float32Array(maskB.skinnedMesh.geometry.getAttribute('position').array as Float32Array);
    maskTarget.engine.begin('draw');
    const attempt = maskTarget.engine.dab([0.0, 1.25, 0.12], {
      radius: 0.12,
      strength: 1,
      invert: false,
      symmetry: { x: false, y: false, z: false }
    });
    maskTarget.applyChangedVertices(attempt);
    maskTarget.engine.end((ids) => maskTarget.applyChangedVertices(ids));
    const afterPos = maskB.skinnedMesh.geometry.getAttribute('position').array as Float32Array;
    expect(maxPositionDelta(beforePos, afterPos)).toBe(0);
    maskTarget.dispose();
    base.skinnedMesh.geometry.dispose();
  });

  it('reconstructs sculpted mesh state deterministically from sparse CharacterRecipeV1 deltas', () => {
    const a = createProceduralHumanoid();
    const tA = new RigSafeSculptTarget(a.skinnedMesh);
    tA.engine.begin('inflate');
    const ids = tA.engine.dab([0.07, 1.22, 0.12], {
      radius: 0.15,
      strength: 0.9,
      invert: false,
      symmetry: { x: true, y: false, z: false }
    });
    tA.applyChangedVertices(ids);
    tA.engine.end((v) => tA.applyChangedVertices(v));
    const sparse = tA.exportSparseDeltas();
    expect(sparse.indices.length).toBeGreaterThan(10);

    const recipe: CharacterRecipeV1 = {
      schemaVersion: 'dexsculpt.recipe.v1',
      editorVersion: '0.1.0',
      projectId: 'test-proj',
      title: 'Test Hero',
      createdAt: '2026-11-15T00:00:00Z',
      updatedAt: '2026-11-15T00:00:00Z',
      source: {
        kind: 'procedural-sample',
        assetId: a.metadata.id,
        displayName: a.metadata.name,
        fileName: 'dex_foundry_humanoid.glb',
        sha256: 'abc123',
        skeletonFamily: a.metadata.skeletonFamily,
        licenseId: 'MIT',
        requiresSourceRelink: false
      },
      sculptDeltas: [sparse],
      morphWeights: { Broaden_Shoulders: 0.5 },
      materialOverrides: { Foundry_Body_Mat: { colorHex: '#44aa99', roughness: 0.35 } },
      attachments: []
    };

    const parsed = parseRecipeJson(serializeRecipeJson(validateCharacterRecipe(recipe)));
    const b = createProceduralHumanoid();
    const tB = new RigSafeSculptTarget(b.skinnedMesh);
    tB.applySparseDeltas(parsed.sculptDeltas[0]);
    const posA = a.skinnedMesh.geometry.getAttribute('position').array as Float32Array;
    const posB = b.skinnedMesh.geometry.getAttribute('position').array as Float32Array;
    expect(maxPositionDelta(posA, posB)).toBeLessThan(1e-6);
    expect(maxPositionDelta(posB, tB.snapshot.sourcePos)).toBeGreaterThan(0.005);
    tA.dispose();
    tB.dispose();
  });
});

describe('Humanoid Catalog & Modular Compatibility Engine', () => {
  it('indexes 786 sanitized catalog records, 43 sources, and detects compatibility rules accurately', () => {
    const summary = getCatalogSummary();
    expect(summary.totalRecords).toBe(786);
    expect(summary.sourceCount).toBe(43);

    const rocket = getCatalogRecord('rocketbox/adults/female_adult_01');
    const kaykitAnim = searchCatalog({ skeletonFamily: 'kaykit-rig-medium', assetType: 'animation_pack' })[0];
    expect(rocket).not.toBeNull();
    expect(kaykitAnim).toBeDefined();

    // Explicitly incompatible families
    const bad = assessCatalogCompatibility('rocketbox-bip01', kaykitAnim);
    expect(bad.compatible).toBe(false);

    // Same family compatible
    const kaykitChar = searchCatalog({ skeletonFamily: 'kaykit-rig-medium', assetType: 'character' })[0];
    const good = assessCatalogCompatibility('kaykit-rig-medium', kaykitChar);
    expect(good.compatible).toBe(true);
    expect(good.mode).toBe('exact-family');

    // Bone-name detection heuristic
    const bundle = createProceduralHumanoid();
    expect(detectSkeletonFamilyFromBones(bundle.skeleton.bones.map((b) => b.name))).toBe('dex-foundry-biped-20');
  });

  it('attaches procedural bone sockets & compatible skinned cloak, while blocking incompatible skinned bindings', () => {
    const bundle = createProceduralHumanoid();

    const visor = attachProceduralModularItem(
      bundle.root,
      bundle.skeleton,
      bundle.metadata.skeletonFamily,
      'procedural/visor-crest'
    );
    expect(visor.targetBone).toBe('Head');

    const cloak = attachProceduralModularItem(
      bundle.root,
      bundle.skeleton,
      bundle.metadata.skeletonFamily,
      'procedural/skinned-cape'
    );
    expect(cloak.mode).toBe('skinned-compatible');
    expect((cloak.object as THREE.SkinnedMesh).isSkinnedMesh).toBe(true);

    // Block skinned cloak on an incompatible skeleton family
    const incompat = checkAttachmentCompatibility(
      bundle.skeleton,
      'kaykit-rig-medium',
      'skinned-compatible',
      'Chest',
      ['Chest', 'Spine', 'Pelvis'],
      ['dex-foundry-biped-20']
    );
    expect(incompat.compatible).toBe(false);
    expect(incompat.reason).toContain('expects family');
  });

  it('flags static OBJ import with honest static-only warning and handles pen/DPR math', async () => {
    const objText = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
    const imported = await importCharacterBytes('triangle.obj', new TextEncoder().encode(objText).buffer);
    expect(imported.isRigged).toBe(false);
    expect(imported.warnings[0]).toContain('static mesh mode');

    expect(tiltFromVertical({ tiltX: 0, tiltY: 0 })).toBeCloseTo(0, 4);
    expect(tiltFromVertical({ tiltX: 60, tiltY: 0 })).toBeCloseTo(60, 2);
    expect(tiltScale(60)).toBeCloseTo(1.6, 4);
    expect(StudioViewport.effectiveDpr(1480, 924, 2, StudioViewport.BUDGET.balanced)).toBeLessThan(1.6);
  });
});
