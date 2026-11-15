/**
 * Round-trip verification: independently re-import the exported GLB with a fresh
 * GLTFLoader, then *evaluate* the rig rather than only reading it.
 *
 * The probes use `Mesh.getVertexPosition`, which applies morph targets and CPU
 * skinning (bind matrices + bone world matrices) to a vertex. If the skeleton,
 * weights, inverse bind matrices or animation survived, posed probe positions
 * must move; if they did not, the probes sit still and the check fails.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { hashArray } from '../core/util';
import type { Character, MeshRecord } from '../character/character';

export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface ReimportCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface VertexProbe {
  vertex: number;
  mesh: string;
  bind: [number, number, number];
  posed: [number, number, number];
  moved: number;
}

export interface ReimportReport {
  ok: boolean;
  checks: ReimportCheck[];
  clip?: { name: string; duration: number; time: number };
  probes: VertexProbe[];
  morphProbe?: { target: string; maxMove: number; movedVertices: number };
  maxPositionError: number;
}

const TOL_POSITION = 1e-4;
const LIMB_MOTION_THRESHOLD = 0.004; // 4 mm

export async function verifyReimport(bytes: ArrayBuffer, original: Character): Promise<ReimportReport> {
  const checks: ReimportCheck[] = [];
  const add = (id: string, label: string, status: CheckStatus, detail: string) => checks.push({ id, label, status, detail });

  let gltf: Awaited<ReturnType<GLTFLoader['parseAsync']>>;
  try {
    gltf = await new GLTFLoader().parseAsync(bytes.slice(0), '');
    add('reimport-parse', 'Re-imports cleanly', 'pass', `Fresh GLTFLoader parse produced ${gltf.scene.children.length} root child(ren)`);
  } catch (error) {
    add('reimport-parse', 'Re-imports cleanly', 'fail', (error as Error).message);
    return { ok: false, checks, probes: [], maxPositionError: Infinity };
  }

  const root = gltf.scene as THREE.Group;
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) meshes.push(obj as THREE.Mesh);
  });

  const skeleton = (meshes.find((m) => (m as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh | undefined)?.skeleton ?? null;
  const joints = skeleton ? skeleton.bones.map((b) => b.name) : [];
  const expectedJoints = new Set<string>();
  for (const mesh of original.manifest.meshes) for (const j of mesh.jointNames) expectedJoints.add(j);
  if (expectedJoints.size) {
    const missing = [...expectedJoints].filter((n) => !joints.includes(n));
    add(
      'reimport-joints',
      'Skeleton survives re-import',
      missing.length === 0 ? 'pass' : 'fail',
      missing.length ? `missing ${missing.join(', ')}` : `${joints.length} joints resolved by name`,
    );

    // Hierarchy: compare parent names for joints present in the source manifest.
    const loadedParent = new Map<string, string | null>();
    for (const bone of skeleton!.bones) {
      loadedParent.set(bone.name, bone.parent && (bone.parent as THREE.Bone).isBone ? bone.parent.name : null);
    }
    const expectedParent = new Map(original.manifest.skeleton.bones.map((b) => [b.name, b.parent]));
    const mismatches = [...expectedParent.entries()].filter(([name, parent]) => {
      if (!loadedParent.has(name)) return false;
      if (parent && !expectedJoints.has(parent)) return false;
      return loadedParent.get(name) !== parent;
    });
    add(
      'reimport-hierarchy',
      'Hierarchy survives re-import',
      mismatches.length === 0 ? 'pass' : 'fail',
      mismatches.length === 0 ? 'parent relationships match the source manifest' : mismatches.slice(0, 4).map(([n, p]) => `${n}->${p}`).join(', '),
    );

    // Inverse bind matrices, keyed by joint name.
    const sourceByName = new Map<string, number[]>();
    const sourceOrder = original.manifest.skeleton.bones.map((b) => b.name);
    const sourceIbm = original.manifest.meshes.find((m) => m.inverseBindMatrices.length)?.inverseBindMatrices ?? [];
    sourceOrder.forEach((name, i) => sourceByName.set(name, sourceIbm.slice(i * 16, i * 16 + 16)));
    let worst = 0;
    let compared = 0;
    skeleton!.bones.forEach((bone, i) => {
      const want = sourceByName.get(bone.name);
      const got = skeleton!.boneInverses[i];
      if (!want || !got) return;
      compared++;
      for (let k = 0; k < 16; k++) worst = Math.max(worst, Math.abs(got.elements[k] - want[k]));
    });
    add(
      'reimport-ibm',
      'Inverse bind matrices survive re-import',
      worst < 1e-5 && compared > 0 ? 'pass' : 'fail',
      `${compared} matrices, worst component error ${worst.toExponential(2)}`,
    );
  }

  // JOINTS/WEIGHTS hashes vs the original character's geometry.
  let rigHashFailures = 0;
  let rigHashDetail = '';
  for (const rec of original.meshes) {
    if (!rec.skinned) continue;
    const loaded = meshes.find((m) => m.name === rec.name || m.name === rec.name.replace(/#.*$/, ''));
    if (!loaded) {
      rigHashFailures++;
      rigHashDetail += `${rec.name} missing; `;
      continue;
    }
    const srcJoints = rec.mesh.geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
    const srcWeights = rec.mesh.geometry.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
    const loadedJoints = loaded.geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
    const loadedWeights = loaded.geometry.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
    if (!loadedJoints || !loadedWeights || !srcJoints || !srcWeights) {
      rigHashFailures++;
      rigHashDetail += `${rec.name} lost skin attributes; `;
      continue;
    }
    const j1 = hashArray(canonicalJoints(srcJoints));
    const j2 = hashArray(canonicalJoints(loadedJoints));
    const w1 = hashArray(canonicalWeights(srcWeights));
    const w2 = hashArray(canonicalWeights(loadedWeights));
    if (j1 !== j2) {
      rigHashFailures++;
      rigHashDetail += `${rec.name} JOINTS differ; `;
    }
    if (w1 !== w2) {
      rigHashFailures++;
      rigHashDetail += `${rec.name} WEIGHTS differ; `;
    }
  }
  add(
    'reimport-skin-attributes',
    'JOINTS_0 / WEIGHTS_0 match the source after re-import',
    rigHashFailures === 0 ? 'pass' : 'fail',
    rigHashFailures === 0 ? 'all skinned meshes keep byte-identical skin attributes' : rigHashDetail,
  );

  // Positions: exported geometry must equal base + delta.
  let maxPositionError = 0;
  for (const rec of original.meshes) {
    const loaded = meshes.find((m) => m.name === rec.name);
    if (!loaded) continue;
    const pos = loaded.geometry.getAttribute('position');
    const expected = rec.positionAttr.array as Float32Array;
    const n = Math.min(pos.count, rec.vertexCount);
    for (let i = 0; i < n; i++) {
      maxPositionError = Math.max(
        maxPositionError,
        Math.hypot(
          pos.getX(i) - expected[i * 3],
          pos.getY(i) - expected[i * 3 + 1],
          pos.getZ(i) - expected[i * 3 + 2],
        ),
      );
    }
  }
  add(
    'reimport-positions',
    'Edited geometry survives re-import',
    maxPositionError <= TOL_POSITION ? 'pass' : 'fail',
    `max |reimport − editor| = ${maxPositionError.toExponential(2)}`,
  );

  // Morph targets
  let morphDetail = '';
  let morphFailures = 0;
  let morphProbe: ReimportReport['morphProbe'];
  for (const rec of original.meshes) {
    if (!rec.morphTargets.length) continue;
    const loaded = meshes.find((m) => m.name === rec.name) as THREE.Mesh | undefined;
    if (!loaded) {
      morphFailures++;
      morphDetail += `${rec.name} missing; `;
      continue;
    }
    const targets = loaded.geometry.morphAttributes.position ?? [];
    const names = Object.keys(loaded.morphTargetDictionary ?? {});
    if (targets.length !== rec.morphTargets.length) {
      morphFailures++;
      morphDetail += `${rec.name} has ${targets.length} targets vs ${rec.morphTargets.length}; `;
      continue;
    }
    for (let t = 0; t < targets.length; t++) {
      const source = rec.mesh.geometry.morphAttributes.position?.[t] as THREE.BufferAttribute | undefined;
      if (!source) {
        morphFailures++;
        continue;
      }
      const a = hashArray(canonicalPositions(source));
      const b = hashArray(canonicalPositions(targets[t]));
      if (a !== b) {
        morphFailures++;
        morphDetail += `${rec.name}[${names[t] ?? t}] differs; `;
      }
    }
    if (!morphProbe && loaded.morphTargetInfluences && names.length) {
      loaded.morphTargetInfluences.fill(0);
      const before = probePositions(loaded, [Math.floor(loaded.geometry.getAttribute('position').count / 3)]);
      loaded.morphTargetInfluences[0] = 1;
      const after = probePositions(loaded, [Math.floor(loaded.geometry.getAttribute('position').count / 3)]);
      const move = before[0].distanceTo(after[0]);
      // measure across a sample for relevance
      let maxMove = 0;
      let moved = 0;
      const step = Math.max(1, Math.floor(loaded.geometry.getAttribute('position').count / 200));
      for (let v = 0; v < loaded.geometry.getAttribute('position').count; v += step) {
        loaded.morphTargetInfluences[0] = 0;
        const p0 = probePositions(loaded, [v])[0];
        loaded.morphTargetInfluences[0] = 1;
        const p1 = probePositions(loaded, [v])[0];
        const d = p0.distanceTo(p1);
        if (d > 1e-5) moved++;
        maxMove = Math.max(maxMove, d);
      }
      morphProbe = { target: names[0] ?? 'target_0', maxMove, movedVertices: moved };
      void move;
      loaded.morphTargetInfluences.fill(0);
    }
  }
  if (original.meshes.some((m) => m.morphTargets.length)) {
    add(
      'reimport-morphs',
      'Morph targets survive re-import',
      morphFailures === 0 ? 'pass' : 'fail',
      morphFailures === 0
        ? `${morphProbe ? `target "${morphProbe.target}" moves ${morphProbe.movedVertices} sampled vertices (max ${(morphProbe.maxMove * 1000).toFixed(1)} mm)` : 'targets present'}`
        : morphDetail,
    );
  }

  // Animation clips
  const clipNames = gltf.animations.map((c) => c.name);
  const expectedClips = original.manifest.clips.map((c) => c.name);
  const clipsOk = expectedClips.every((name) => clipNames.includes(name));
  add(
    'reimport-clips',
    'Animation clips survive re-import',
    clipsOk ? 'pass' : 'fail',
    clipsOk ? clipNames.join(', ') : `expected ${expectedClips.join(', ')}; found ${clipNames.join(', ') || 'none'}`,
  );

  // ---- evaluate the rig ----------------------------------------------------
  const probes: VertexProbe[] = [];
  let clipInfo: ReimportReport['clip'];
  if (gltf.animations.length && skeleton) {
    const clip = pickClip(gltf.animations, original.manifest.clips.map((c) => c.name));
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.play();
    mixer.setTime(0);
    root.updateMatrixWorld(true);

    const target = meshes.find((m) => (m as THREE.SkinnedMesh).isSkinnedMesh && m.geometry.getAttribute('skinIndex'))!;
    const probeIndices = chooseProbes(target);
    const bindPositions = probePositions(target, probeIndices);
    const time = clip.duration * 0.45;
    mixer.setTime(time);
    root.updateMatrixWorld(true);
    const posedPositions = probePositions(target, probeIndices);
    for (let i = 0; i < probeIndices.length; i++) {
      probes.push({
        vertex: probeIndices[i],
        mesh: target.name,
        bind: [bindPositions[i].x, bindPositions[i].y, bindPositions[i].z],
        posed: [posedPositions[i].x, posedPositions[i].y, posedPositions[i].z],
        moved: bindPositions[i].distanceTo(posedPositions[i]),
      });
    }
    const maxMoved = Math.max(...probes.map((p) => p.moved));
    add(
      'animation-deforms',
      'Preserved animation deforms the edited mesh',
      maxMoved >= LIMB_MOTION_THRESHOLD ? 'pass' : 'fail',
      `clip "${clip.name}" at ${time.toFixed(2)}s moves probe vertices by up to ${(maxMoved * 1000).toFixed(1)} mm (threshold ${(LIMB_MOTION_THRESHOLD * 1000).toFixed(0)} mm)`,
    );
    clipInfo = { name: clip.name, duration: clip.duration, time };
    action.stop();
    mixer.uncacheRoot(root);
  }

  const failures = checks.filter((c) => c.status === 'fail');
  return { ok: failures.length === 0, checks, clip: clipInfo, probes, morphProbe, maxPositionError };
}

function canonicalJoints(attr: THREE.BufferAttribute): Uint32Array {
  const out = new Uint32Array(attr.count * 4);
  for (let i = 0; i < attr.count; i++) for (let k = 0; k < 4; k++) out[i * 4 + k] = attr.getComponent(i, k) | 0;
  return out;
}

function canonicalWeights(attr: THREE.BufferAttribute): Float32Array {
  const out = new Float32Array(attr.count * 4);
  for (let i = 0; i < attr.count; i++) for (let k = 0; k < 4; k++) out[i * 4 + k] = attr.getComponent(i, k);
  return out;
}

function canonicalPositions(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const out = new Float32Array(attr.count * 3);
  for (let i = 0; i < attr.count; i++) {
    out[i * 3] = attr.getX(i);
    out[i * 3 + 1] = attr.getY(i);
    out[i * 3 + 2] = attr.getZ(i);
  }
  return out;
}

function probePositions(mesh: THREE.Mesh, indices: number[]): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const scratch = new THREE.Vector3();
  for (const index of indices) {
    mesh.getVertexPosition(index, scratch);
    out.push(scratch.clone());
  }
  return out;
}

/** Pick a clip that is likely to move limbs, preferring the fixture's wave/stride. */
function pickClip(clips: THREE.AnimationClip[], preferred: string[]): THREE.AnimationClip {
  const order = ['Wave', 'Stride', 'Walk', 'Run', 'Idle'];
  for (const key of order) {
    const found = clips.find((c) => c.name.toLowerCase().includes(key.toLowerCase()) && preferred.includes(c.name));
    if (found) return found;
  }
  return clips.find((c) => preferred.includes(c.name)) ?? clips[0];
}

/** Probe vertices biased to extremities: a hand/arm vertex and a central torso vertex. */
function chooseProbes(mesh: THREE.Mesh): number[] {
  const position = mesh.geometry.getAttribute('position');
  const count = position.count;
  let maxX = -Infinity;
  let maxXIndex = 0;
  let centreIndex = 0;
  let centreScore = Infinity;
  for (let i = 0; i < count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    if (x > maxX) {
      maxX = x;
      maxXIndex = i;
    }
    const score = Math.abs(x) + Math.abs(y - 0.95) + Math.abs(z);
    if (score < centreScore) {
      centreScore = score;
      centreIndex = i;
    }
  }
  const out = [maxXIndex, centreIndex];
  const stride = Math.max(1, Math.floor(count / 10));
  for (let i = stride; i < count && out.length < 12; i += stride) {
    if (i !== maxXIndex && i !== centreIndex) out.push(i);
  }
  return out;
}

export function summariseReimport(report: ReimportReport): string {
  if (report.ok) {
    const moved = report.probes.length ? Math.max(...report.probes.map((p) => p.moved)) * 1000 : 0;
    return `Round-trip verified: rig, skin weights, morphs and clips intact; animated deformation up to ${moved.toFixed(1)} mm`;
  }
  return `Round-trip failed: ${report.checks.filter((c) => c.status === 'fail').map((c) => c.label).join('; ')}`;
}
