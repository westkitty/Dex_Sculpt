import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CharacterSession } from '../src/app/characterSession';
import type { StudioViewport } from '../src/app/viewport';
import { compareRigPreservation, disposeCharacterRoot, validateGlbBinary } from '../src/io/glbValidator';
import { importCharacterBytes } from '../src/io/glbPipeline';

const assetPath = process.env.DEX_REAL_CHARACTER ?? 'tests/fixtures/downloads/CesiumMan.glb';
if (!fs.existsSync(assetPath)) {
  throw new Error('Download the test-only CesiumMan.glb fixture with `node scripts/acquire-real-character.mjs`; see tests/fixtures/README.md');
}
const bytes = fs.readFileSync(assetPath);
const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

function viewportStub(): StudioViewport {
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

const sessions: CharacterSession[] = [];
function createSession(): CharacterSession {
  const session = new CharacterSession(viewportStub());
  sessions.push(session);
  return session;
}
function stroke(session: CharacterSession, target: CharacterSession['sculptTargets'][number], p: THREE.Vector3, radius: number): void {
  expect(session.prepareSculptStroke(target)).toBe(true);
  target.engine.begin('draw');
  const changed = target.engine.dab(p.toArray() as [number, number, number], {
    radius, strength: 0.9, invert: false, symmetry: { x: false, y: false, z: false }, pressure: 1
  });
  target.applyChangedVertices(changed);
  target.engine.end((ids) => { target.applyChangedVertices(ids); target.endStrokeMaintenance(); });
  session.commitSculptStroke(target);
}
function regionMaxDelta(target: CharacterSession['sculptTargets'][number], center: THREE.Vector3, radius: number): number {
  const p = target.geometry.getAttribute('position').array as Float32Array;
  const src = target.snapshot.sourcePos;
  let max = 0;
  for (let v = 0; v < p.length / 3; v++) {
    if (Math.hypot(src[v * 3] - center.x, src[v * 3 + 1] - center.y, src[v * 3 + 2] - center.z) > radius) continue;
    max = Math.max(max, Math.hypot(p[v * 3] - src[v * 3], p[v * 3 + 1] - src[v * 3 + 1], p[v * 3 + 2] - src[v * 3 + 2]));
  }
  return max;
}

function surfacePoint(target: CharacterSession['sculptTargets'][number], bounds: THREE.Box3, fraction: number): THREE.Vector3 {
  const sizes = bounds.getSize(new THREE.Vector3()).toArray();
  const axis = sizes.indexOf(Math.max(...sizes));
  const wanted = bounds.min.toArray()[axis] + sizes[axis] * fraction;
  const transverse = [0, 1, 2].filter(i => i !== axis);
  const mid = bounds.getCenter(new THREE.Vector3()).toArray();
  const pos = target.geometry.getAttribute('position');
  let nearestBand = Infinity;
  for (let i = 0; i < pos.count; i++) nearestBand = Math.min(nearestBand, Math.abs(pos.getComponent(i, axis) - wanted));
  const band = Math.max(nearestBand + sizes[axis] * 0.025, sizes[axis] * 0.03);
  let best = -Infinity;
  const point = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const offset = Math.abs(pos.getComponent(i, axis) - wanted);
    if (offset > band) continue;
    const radial = Math.hypot(pos.getComponent(i, transverse[0]) - mid[transverse[0]], pos.getComponent(i, transverse[1]) - mid[transverse[1]]);
    const score = radial - offset * 4;
    if (score > best) { best = score; point.fromBufferAttribute(pos, i); }
  }
  return point;
}

afterAll(() => { for (const s of sessions) s.unloadCurrent(); });

describe('Third-party Cesium Man local GLB acceptance (extended; explicit opt-in)', () => {
  it('imports a real skinned/animated GLB, sculpts independent layers and variants, saves/reloads, exports, validates, and deforms on animation', async () => {
    const session = createSession();
    await session.loadLocalFile('CesiumMan.glb', arrayBuffer);
    expect(session.sculptTargets).toHaveLength(1);
    expect(session.primarySkeleton?.bones.length).toBe(19);
    expect(session.animations.length).toBe(1);
    const target = session.sculptTargets[0];
    expect(target.isSkinned).toBe(true);
    expect(target.snapshot.hasUV).toBe(true);
    expect(target.snapshot.hasSkinning).toBe(true);
    expect(target.snapshot.triangleCount).toBeGreaterThan(1000);
    expect(target.geometry.getAttribute('skinIndex').count).toBe(target.snapshot.renderVertexCount);
    expect(target.geometry.getAttribute('skinWeight').count).toBe(target.snapshot.renderVertexCount);
    expect(target.geometry.getAttribute('uv').count).toBe(target.snapshot.renderVertexCount);
    expect(target.geometry.morphAttributes.position ?? []).toHaveLength(0);

    const source = Float32Array.from(target.snapshot.sourcePos);
    const beforeWeights = Float32Array.from(target.geometry.getAttribute('skinWeight').array as Float32Array);
    const beforeJoints = Array.from(target.geometry.getAttribute('skinIndex').array as ArrayLike<number>);
    const beforeUvs = Float32Array.from(target.geometry.getAttribute('uv').array as Float32Array);
    const baseline = session.baselineValidation!;
    expect(baseline.validGlb2).toBe(true);
    expect(baseline.skinCount).toBe(1);
    expect(baseline.animationCount).toBe(1);

    const bounds = new THREE.Box3().setFromBufferAttribute(target.geometry.getAttribute('position') as THREE.BufferAttribute);
    const longestExtent = Math.max(...bounds.getSize(new THREE.Vector3()).toArray());
    const upper = surfacePoint(target, bounds, 0.72);
    const lower = surfacePoint(target, bounds, 0.24);
    const radius = longestExtent * 0.12;
    const first = session.createLayer('Upper body acceptance');
    stroke(session, target, upper, radius);
    session.createLayer('Lower body acceptance');
    stroke(session, target, lower, radius);
    const upperDelta = regionMaxDelta(target, upper, radius);
    const lowerDelta = regionMaxDelta(target, lower, radius);
    expect(upperDelta).toBeGreaterThan(1e-5);
    expect(lowerDelta).toBeGreaterThan(1e-5);

    session.toggleLayerVisible(first.id);
    const hiddenUpperDelta = regionMaxDelta(target, upper, radius);
    const remainingLowerDelta = regionMaxDelta(target, lower, radius);
    expect(hiddenUpperDelta).toBeLessThan(1e-7);
    expect(remainingLowerDelta).toBeGreaterThan(1e-5);
    session.toggleLayerVisible(first.id);
    expect(regionMaxDelta(target, upper, radius)).toBeGreaterThan(1e-5);

    const variantA = session.dna!.activeId;
    const variantB = session.duplicateVariant(variantA, 'Independent test variant').id;
    session.createLayer('Variant-only layer');
    const sidePoint = surfacePoint(target, bounds, 0.5);
    stroke(session, target, sidePoint, radius);
    const variantBPositions = Float32Array.from(target.geometry.getAttribute('position').array as Float32Array);
    session.switchVariant(variantA);
    expect(session.activeVariant!.layers).toHaveLength(2);
    const variantAPositions = target.geometry.getAttribute('position').array as Float32Array;
    let variantDelta = 0;
    for (let i = 0; i < variantAPositions.length; i++) variantDelta = Math.max(variantDelta, Math.abs(variantAPositions[i] - variantBPositions[i]));
    expect(variantDelta).toBeGreaterThan(1e-5);
    session.switchVariant(variantB);
    session.switchVariant(variantA);
    session.switchVariant(variantB);
    const recipe = session.buildProjectRecipe();
    expect(recipe.dna.variants).toHaveLength(2);
    const expectedActive = session.dna!.variants.find(v => v.id === variantB)!;
    expect(expectedActive.layers).toHaveLength(3);

    // Exercise the serialized project-file boundary, then reconstruct against the exact source SHA.
    const savedRecipeBytes = new TextEncoder().encode(JSON.stringify(recipe));
    const reloadedRecipe = JSON.parse(new TextDecoder().decode(savedRecipeBytes)) as typeof recipe;
    const reloaded = createSession();
    await reloaded.loadLocalFile('CesiumMan.glb', arrayBuffer);
    const reloadResult = await reloaded.loadProjectRecipe(reloadedRecipe);
    expect(reloadResult.needsRelink).toBe(false);
    expect(reloaded.dna!.variants.map(v => v.name)).toEqual(session.dna!.variants.map(v => v.name));
    expect(reloaded.dna!.activeId).toBe(variantB);
    expect(reloaded.dna!.variants.find(v => v.id === variantB)!.layers).toHaveLength(3);
    expect(reloaded.getTotalModifiedVertices()).toBeGreaterThan(0);

    const { result, diff } = await reloaded.exportCharacterGlb();
    expect(result.validation.validGlb2).toBe(true);
    expect(result.validation.skinCount).toBe(1);
    expect(result.validation.animationCount).toBe(1);
    expect(result.validation.totalVertices).toBeGreaterThan(0);
    expect(diff?.passed).toBe(true);
    expect(diff?.boneCountEqual).toBe(true);
    expect(diff?.jointsExactMatch).toBe(true);
    expect(diff?.weightsMaxDiff).toBeLessThan(1e-6);
    expect(diff?.uvMaxDiff).toBe(0);
    expect(diff?.inverseBindMatricesMaxDiff).toBeLessThan(1e-5);
    expect(diff?.sculptMaxPositionDelta).toBeGreaterThan(0.005);
    expect(target.snapshot.sourcePos).toEqual(source);
    expect(target.geometry.getAttribute('skinWeight').array).toEqual(beforeWeights);
    expect(Array.from(target.geometry.getAttribute('skinIndex').array as ArrayLike<number>)).toEqual(beforeJoints);
    expect(target.geometry.getAttribute('uv').array).toEqual(beforeUvs);

    fs.writeFileSync(path.join(path.dirname(assetPath), 'acceptance-export.glb'), Buffer.from(result.glb));
    const independent = await importCharacterBytes('acceptance-export.glb', result.glb);
    const externalAgain = validateGlbBinary(result.glb);
    expect(externalAgain.validGlb2).toBe(true);
    expect(compareRigPreservation(baseline, externalAgain, true).passed).toBe(true);
    expect(independent.animations).toHaveLength(1);
    const skinned: THREE.SkinnedMesh[] = [];
    independent.root.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh); });
    expect(skinned).toHaveLength(1);
    const reimportMesh = skinned[0];
    independent.root.updateMatrixWorld(true);
    reimportMesh.skeleton.update();
    const restPositions: THREE.Vector3[] = [];
    for (let v = 0; v < reimportMesh.geometry.getAttribute('position').count; v++) {
      restPositions.push(reimportMesh.applyBoneTransform(v, new THREE.Vector3()).clone());
    }
    const mixer = new THREE.AnimationMixer(independent.root);
    mixer.clipAction(independent.animations[0]).play();
    mixer.update(Math.max(0.15, independent.animations[0].duration * 0.37));
    independent.root.updateMatrixWorld(true);
    reimportMesh.skeleton.update();
    let maxMotion = 0;
    for (let v = 0; v < restPositions.length; v++) {
      const animated = reimportMesh.applyBoneTransform(v, new THREE.Vector3());
      maxMotion = Math.max(maxMotion, restPositions[v].distanceTo(animated));
    }
    expect(maxMotion).toBeGreaterThan(0.01);
    expect(independent.animations[0].duration).toBeGreaterThan(0);
    fs.writeFileSync(path.join(path.dirname(assetPath), 'acceptance-report.json'), JSON.stringify({
      model: { name: 'Cesium Man', sourceSha256: 'b7001eaeea8254bd44773bcd247e78696d94169388fbb2a1800fc69434e777d9', bytes: bytes.byteLength },
      sourceStructure: { meshes: session.sculptTargets.length, renderVertices: target.snapshot.renderVertexCount, triangles: target.snapshot.triangleCount, joints: session.primarySkeleton?.bones.length, animations: session.animations.length, animationDurationSec: session.animations[0]?.duration },
      layerDisplacement: { upperRegionMax: upperDelta, lowerRegionMax: lowerDelta, upperAfterHide: hiddenUpperDelta, lowerRemained: remainingLowerDelta },
      variantMaxCoordinateDifference: variantDelta,
      export: { bytes: result.glb.byteLength, inverseBindMatrixMaxDiff: diff?.inverseBindMatricesMaxDiff, weightsMaxDiff: diff?.weightsMaxDiff, uvsMaxDiff: diff?.uvMaxDiff, sculptMaxPositionDelta: diff?.sculptMaxPositionDelta, passed: diff?.passed },
      reimportedAnimation: { clipName: independent.animations[0].name, durationSec: independent.animations[0].duration, maximumSkinnedVertexMotion: maxMotion }
    }, null, 2));
    disposeCharacterRoot(independent.root);
  });
});
