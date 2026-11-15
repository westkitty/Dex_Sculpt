import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import * as THREE_185 from 'three-r185';
import { GLTFLoader as GLTFLoader185 } from 'three-r185/examples/jsm/loaders/GLTFLoader.js';
import { createProceduralHumanoid } from '../src/fixtures/proceduralHumanoid';
import { RigSafeSculptTarget } from '../src/core/rigSafeSculpt';
import { History } from '../src/core/history';
import { exportRigSafeGlb, importCharacterBytes } from '../src/io/glbPipeline';
import { compareRigPreservation, disposeCharacterRoot, validateGlbBinary } from '../src/io/glbValidator';
import { hashBytes } from '../src/core/topology';

/** Minimal PNG dataURL/blob shim for DataTexture serialization inside happy-dom Node tests if canvas 2D is absent. */
function installMinimalCanvasPngShimForNodeTest(): void {
  if (typeof document === 'undefined') return;
  const probe = document.createElement('canvas');
  if (typeof probe.getContext === 'function' && probe.getContext('2d')) return;

  const origCreate = document.createElement.bind(document);
  (document as any).createElement = (tag: string, ...args: any[]) => {
    const el = origCreate(tag, ...args);
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
      (el as any).getContext = () => ctx;
      // 1x1 transparent PNG bytes
      const png1x1 = Uint8Array.from(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
          'base64'
        )
      );
      (el as any).toBlob = (cb: (b: Blob | null) => void) => cb(new Blob([png1x1], { type: 'image/png' }));
      (el as any).toDataURL = () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    }
    return el;
  };
}

describe('Phase A Mandatory Proof: Rig-Safe Sculpting + GLB Round-Trip', () => {
  it('1) builds procedural humanoid fixture, exports baseline GLB, sculpts geometry, exports modified GLB, reimports in r186 and r185, and verifies all rig/morph/animation invariants', async () => {
    installMinimalCanvasPngShimForNodeTest();

    // 1. Create original procedural humanoid & export baseline GLB (simulating imported GLB character)
    const bundle = createProceduralHumanoid();
    expect(bundle.skeleton.bones.length).toBe(20);
    expect(bundle.animations.length).toBe(3);
    expect(bundle.skinnedMesh.geometry.morphAttributes.position?.length).toBe(4);

    const baselineExport = await exportRigSafeGlb(bundle.root, bundle.animations);
    expect(baselineExport.validation.validGlb2).toBe(true);
    expect(baselineExport.validation.skinCount).toBe(1);
    expect(baselineExport.validation.animationCount).toBe(3);
    expect(baselineExport.validation.primitives[0].morphTargetCount).toBe(4);
    expect(baselineExport.validation.primitives[0].hasJoints).toBe(true);
    expect(baselineExport.validation.primitives[0].hasWeights).toBe(true);
    expect(baselineExport.validation.primitives[0].hasUV).toBe(true);

    // 2. Import the baseline GLB through DEX//SCULPT's import pipeline
    const imported = await importCharacterBytes('dex_foundry_humanoid.glb', baselineExport.glb);
    expect(imported.isRigged).toBe(true);
    expect(imported.animations.length).toBe(3);

    let skinnedMesh: THREE.SkinnedMesh | null = null;
    imported.root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinnedMesh) {
        skinnedMesh = o as THREE.SkinnedMesh;
      }
    });
    expect(skinnedMesh).not.toBeNull();
    const sm = skinnedMesh!;

    // Record original geometry and rig properties
    const sculptTarget = new RigSafeSculptTarget(sm);
    const history = new History();
    const initialPosHash = hashBytes(sm.geometry.getAttribute('position').array as Float32Array);

    // 3. Make a visible, measurable sculpt change on chest & head with X symmetry (multi-dab stroke)
    sculptTarget.engine.begin('draw');
    for (let step = 0; step < 4; step++) {
      const changedChest = sculptTarget.engine.dab([0.08, 1.25 + step * 0.015, 0.12], {
        radius: 0.16,
        strength: 0.9,
        invert: false,
        symmetry: { x: true, y: false, z: false },
        pressure: 1
      });
      sculptTarget.applyChangedVertices(changedChest);
    }

    const changedHead = sculptTarget.engine.dab([0.04, 1.66, 0.08], {
      radius: 0.1,
      strength: 0.75,
      invert: false,
      symmetry: { x: true, y: false, z: false },
      pressure: 1
    });
    sculptTarget.applyChangedVertices(changedHead);

    const strokeEntry = sculptTarget.engine.end((ids) => sculptTarget.applyChangedVertices(ids));
    expect(strokeEntry).not.toBeNull();
    history.push(strokeEntry);
    sculptTarget.endStrokeMaintenance();

    const maxDisp = sculptTarget.getMaxDisplacement();
    expect(maxDisp).toBeGreaterThan(0.02);
    expect(sculptTarget.getModifiedVertexCount()).toBeGreaterThan(20);

    // Check undo/redo byte-exactness
    const sculptedHash = hashBytes(sm.geometry.getAttribute('position').array as Float32Array);
    expect(sculptedHash).not.toBe(initialPosHash);
    expect(history.undo()).toBe(true);
    expect(hashBytes(sm.geometry.getAttribute('position').array as Float32Array)).toBe(initialPosHash);
    expect(history.redo()).toBe(true);
    expect(hashBytes(sm.geometry.getAttribute('position').array as Float32Array)).toBe(sculptedHash);

    // Also verify sparse delta round-trip (non-destructive recipe proof)
    const sparse = sculptTarget.exportSparseDeltas();
    expect(sparse.indices.length).toBeGreaterThan(20);

    // 4. Play animation BEFORE export (non-bind pose!) then export GLB — verify export resets to clean bind pose!
    const mixer = new THREE.AnimationMixer(imported.root);
    const walkClip = imported.animations.find((c) => c.name === 'Walk_Cycle')!;
    const walkAction = mixer.clipAction(walkClip);
    walkAction.play();
    mixer.update(0.45);
    imported.root.updateMatrixWorld(true);

    // Exercise morph target too before export
    sm.morphTargetInfluences![0] = 0.65;

    const sculptedExport = await exportRigSafeGlb(imported.root, imported.animations);

    // 5. Independent binary GLB validation & comparison against baseline
    const afterBinary = validateGlbBinary(sculptedExport.glb);
    const diff = compareRigPreservation(baselineExport.validation, afterBinary, true);
    expect(diff.failures).toEqual([]);
    expect(diff.passed).toBe(true);
    expect(diff.boneCountEqual).toBe(true);
    expect(diff.boneNamesEqual).toBe(true);
    expect(diff.boneHierarchyEqual).toBe(true);
    expect(diff.jointsExactMatch).toBe(true);
    expect(diff.weightsMaxDiff).toBeLessThan(1e-5);
    expect(diff.inverseBindMatricesMaxDiff).toBeLessThan(1e-4);
    expect(diff.uvMaxDiff).toBeLessThan(1e-6);
    expect(diff.morphTargetsEqual).toBe(true);
    expect(diff.morphDeltasMaxDiff).toBeLessThan(1e-5);
    expect(diff.animationCountEqual).toBe(true);
    expect(diff.animationNamesEqual).toBe(true);
    expect(diff.sculptMaxPositionDelta).toBeGreaterThan(0.01);

    // 6. Independently reimport into Three.js r186 AND verify skeletal deformation + morph deformation
    const reimported186 = await importCharacterBytes('sculpted_out.glb', sculptedExport.glb);
    let sm186: THREE.SkinnedMesh | null = null;
    reimported186.root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh && !sm186) sm186 = o as THREE.SkinnedMesh;
    });
    expect(sm186).not.toBeNull();
    const s186 = sm186!;

    // Confirm sculpted geometry survived in reimported mesh
    const basePos186 = s186.geometry.getAttribute('position').array as Float32Array;
    expect(hashBytes(basePos186)).toBe(sculptedHash);

    // Confirm skeletal animation actually moves bones and applies vertex skinning transform
    const mixer186 = new THREE.AnimationMixer(reimported186.root);
    const waveClip = reimported186.animations.find((c) => c.name === 'Wave_Greeting')!;
    expect(waveClip).toBeDefined();
    const action186 = mixer186.clipAction(waveClip);
    action186.play();

    // Sample a vertex weighted to Forearm_R / Hand_R before and after animation step
    const armBoneIdx = s186.skeleton.bones.findIndex((b) => b.name === 'Forearm_R');
    expect(armBoneIdx).toBeGreaterThan(-1);
    const skinIdxAttr = s186.geometry.getAttribute('skinIndex');
    let armVert = -1;
    for (let i = 0; i < skinIdxAttr.count; i++) {
      if (skinIdxAttr.getX(i) === armBoneIdx && s186.geometry.getAttribute('skinWeight').getX(i) > 0.7) {
        armVert = i;
        break;
      }
    }
    expect(armVert).toBeGreaterThan(-1);

    reimported186.root.updateMatrixWorld(true);
    s186.skeleton.update();
    const restSkinnedPos = new THREE.Vector3();
    s186.applyBoneTransform(armVert, restSkinnedPos);

    mixer186.update(0.6); // mid-wave
    reimported186.root.updateMatrixWorld(true);
    s186.skeleton.update();
    const wavedSkinnedPos = new THREE.Vector3();
    s186.applyBoneTransform(armVert, wavedSkinnedPos);
    expect(wavedSkinnedPos.distanceTo(restSkinnedPos)).toBeGreaterThan(0.1);

    // Confirm morph targets deform the sculpted mesh after round-trip
    expect(s186.morphTargetInfluences!.length).toBe(4);
    expect(s186.morphTargetDictionary).toHaveProperty('Broaden_Shoulders');
    s186.morphTargetInfluences![0] = 1.0;
    const shoulderVertIdx = s186.geometry.morphAttributes.position![0].array as Float32Array;
    let nonZeroMorph = 0;
    for (let i = 0; i < shoulderVertIdx.length; i++) {
      if (Math.abs(shoulderVertIdx[i]) > 1e-4) nonZeroMorph++;
    }
    expect(nonZeroMorph).toBeGreaterThan(30);

    // 7. Independent Three.js r185 consumer verification (per library compatibility requirement)
    const loader185 = new GLTFLoader185();
    const gltf185 = await loader185.parseAsync(sculptedExport.glb, '');
    let sm185: THREE_185.SkinnedMesh | null = null;
    gltf185.scene.traverse((o) => {
      if ((o as THREE_185.SkinnedMesh).isSkinnedMesh && !sm185) sm185 = o as THREE_185.SkinnedMesh;
    });
    expect(sm185).not.toBeNull();
    expect(sm185!.skeleton.bones.length).toBe(20);
    expect(gltf185.animations.length).toBe(3);
    expect(sm185!.geometry.morphAttributes.position?.length).toBe(4);

    const mixer185 = new THREE_185.AnimationMixer(gltf185.scene);
    const clip185 = gltf185.animations.find((c) => c.name === 'Walk_Cycle')!;
    mixer185.clipAction(clip185).play();
    mixer185.update(0.01);
    gltf185.scene.updateMatrixWorld(true);
    const thigh185Before = sm185!.skeleton.bones.find((b) => b.name === 'Thigh_L')!.quaternion.clone();
    mixer185.update(0.6);
    gltf185.scene.updateMatrixWorld(true);
    sm185!.skeleton.update();
    const thigh185After = sm185!.skeleton.bones.find((b) => b.name === 'Thigh_L')!.quaternion.clone();
    expect(thigh185Before.angleTo(thigh185After)).toBeGreaterThan(0.75);

    // 8. Resource disposal check
    sculptTarget.dispose();
    const disp1 = disposeCharacterRoot(bundle.root);
    const disp2 = disposeCharacterRoot(imported.root);
    const disp3 = disposeCharacterRoot(reimported186.root);
    const disp4 = disposeCharacterRoot(gltf185.scene);
    expect(disp1.skeletons).toBe(1);
    expect(disp2.skeletons).toBe(1);
    expect(disp3.skeletons).toBe(1);
    expect(disp4.skeletons).toBe(1);
  });
});
