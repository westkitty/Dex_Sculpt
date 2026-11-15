/**
 * Independent structural validation of an exported GLB against the source
 * manifest. Runs on the parsed JSON + BIN chunks only (no Three.js, no loader).
 */
import { hashArray, timeStamp } from '../core/util';
import type { SourceManifest } from '../character/manifest';
import {
  buildParentMap,
  decodeAccessor,
  glbFacts,
  jointHierarchy,
  nodeName,
  parseGLB,
  skinJointNames,
  type GlbJson,
  type ParsedGLB,
} from './glbParse';

export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface ValidationCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface ValidationReport {
  ok: boolean;
  checkedAt: string;
  byteLength: number;
  checks: ValidationCheck[];
  failures: ValidationCheck[];
  warnings: ValidationCheck[];
  facts: {
    nodeCount: number;
    meshCount: number;
    skinnedMeshCount: number;
    skinCount: number;
    animationCount: number;
    materialCount: number;
    morphTargets: number;
    accessorCount: number;
    maxSkinPositionDelta: number;
    changedVertexCount: number;
  };
}

export interface ExpectedMesh {
  name: string;
  vertexCount: number;
  /** live base+delta positions from the editor */
  expectedPositions: Float32Array;
  /** original imported positions (to measure how much the sculpt moved) */
  basePositions: Float32Array;
}

export interface ExportExpectation {
  manifest: SourceManifest;
  meshes: ExpectedMesh[];
}

const TOL_IBM = 1e-5;
const TOL_POSITION = 1e-4;
const TOL_WEIGHT_SUM = 2e-3;

export function validateExportedGLB(bytes: ArrayBuffer | Uint8Array, expected: ExportExpectation): ValidationReport {
  const checks: ValidationCheck[] = [];
  const add = (id: string, label: string, status: CheckStatus, detail: string) => {
    checks.push({ id, label, status, detail });
  };
  const byteLength = bytes instanceof Uint8Array ? bytes.byteLength : bytes.byteLength;
  let glb: ParsedGLB;
  try {
    glb = parseGLB(bytes);
    add('glb-parse', 'GLB container', 'pass', `Valid GLB 2.0 container, ${byteLength} bytes, BIN ${glb.binChunkLength} bytes`);
  } catch (error) {
    add('glb-parse', 'GLB container', 'fail', (error as Error).message);
    return {
      ok: false,
      checkedAt: timeStamp(),
      byteLength,
      checks,
      failures: checks.filter((c) => c.status === 'fail'),
      warnings: [],
      facts: emptyFacts(),
    };
  }

  const json = glb.json;
  const facts = { ...glbFacts(json), maxSkinPositionDelta: 0, changedVertexCount: 0 };
  const manifest = expected.manifest;
  const skeleton = json.skins?.length ? skeletonView(json) : null;

  // --- skin presence -------------------------------------------------------
  if (manifest.counts.skinnedMeshes > 0) {
    add(
      'skin-presence',
      'Skin data survives',
      json.skins?.length ? 'pass' : 'fail',
      json.skins?.length ? `${json.skins.length} skin(s), ${facts.skinnedMeshCount} skinned mesh node(s)` : 'Export contains no skins',
    );
  } else {
    add('skin-presence', 'Skin data', 'pass', 'Source has no skinned meshes; nothing to preserve');
  }

  // --- bone names + hierarchy ---------------------------------------------
  const expectedJoints = new Set<string>();
  for (const mesh of manifest.meshes) for (const j of mesh.jointNames) expectedJoints.add(j);
  if (expectedJoints.size) {
    const exported = jointHierarchy(json);
    const exportedNames = new Set(exported.map((j) => j.name));
    const missing = [...expectedJoints].filter((n) => !exportedNames.has(n));
    const extra = [...exportedNames].filter((n) => !expectedJoints.has(n));
    add(
      'joint-set',
      'Joint names survive',
      missing.length === 0 && extra.length === 0 ? 'pass' : 'fail',
      missing.length || extra.length
        ? `missing ${missing.slice(0, 6).join(', ') || '—'}${extra.length ? `; unexpected ${extra.slice(0, 6).join(', ')}` : ''}`
        : `all ${expectedJoints.size} joints present by name`,
    );

    const expectedParent = new Map<string, string | null>();
    for (const bone of manifest.skeleton.bones) expectedParent.set(bone.name, bone.parent);
    const parentMismatch = exported.filter((j) => {
      const want = expectedParent.get(j.name);
      if (!expectedParent.has(j.name)) return false;
      const parentIsJoint = j.parent !== null && expectedJoints.has(j.parent);
      return parentIsJoint && j.parent !== want;
    });
    add(
      'bone-hierarchy',
      'Bone hierarchy survives',
      parentMismatch.length === 0 ? 'pass' : 'fail',
      parentMismatch.length === 0
        ? `${exported.length} joints keep their parent relationships`
        : parentMismatch.slice(0, 4).map((m) => `${m.name}->${m.parent ?? 'null'}`).join(', '),
    );
  }

  // --- inverse bind matrices ----------------------------------------------
  if (skeleton && manifest.meshes.some((m) => m.inverseBindMatrices.length)) {
    const sourceOrder = manifest.skeleton.bones.map((b) => b.name);
    const sourceIbm = manifest.meshes.find((m) => m.inverseBindMatrices.length)!.inverseBindMatrices;
    const sourceByName = new Map<string, number[]>();
    sourceOrder.forEach((name, i) => {
      sourceByName.set(name, sourceIbm.slice(i * 16, i * 16 + 16));
    });
    let compared = 0;
    let worst = 0;
    let mismatches = 0;
    for (const skin of json.skins ?? []) {
      if (skin.inverseBindMatrices === undefined) {
        mismatches++;
        continue;
      }
      const decoded = decodeAccessor(glb, skin.inverseBindMatrices);
      skin.joints.forEach((jointNode, i) => {
        const name = nodeName(json, jointNode);
        const want = sourceByName.get(name);
        if (!want) return;
        compared++;
        for (let k = 0; k < 16; k++) {
          const diff = Math.abs((decoded.values[i * 16 + k] ?? 0) - want[k]);
          if (diff > worst) worst = diff;
          if (diff > TOL_IBM) mismatches++;
        }
      });
    }
    add(
      'inverse-bind-matrices',
      'Inverse bind matrices survive',
      mismatches === 0 && compared > 0 ? 'pass' : 'fail',
      `${compared} matrices compared, worst component error ${worst.toExponential(2)}`,
    );
  }

  // --- per-mesh attributes -------------------------------------------------
  const meshNodes = new Map<string, { node: number; skin?: number; mesh: number }>();
  json.nodes?.forEach((node, i) => {
    if (node.mesh === undefined) return;
    const name = json.meshes?.[node.mesh]?.name ?? nodeName(json, i);
    if (!meshNodes.has(name)) meshNodes.set(name, { node: i, mesh: node.mesh, skin: node.skin });
  });

  for (const sourceMesh of manifest.meshes) {
    const exported = meshNodes.get(sourceMesh.name) ?? meshNodes.get(sourceMesh.name.replace(/\s+/g, '_'));
    if (!exported) {
      if (sourceMesh.skinned) add(`mesh-${sourceMesh.name}`, `Mesh "${sourceMesh.name}"`, 'fail', 'Mesh missing from export');
      continue;
    }
    const gltfMesh = json.meshes![exported.mesh];
    const primitive = gltfMesh.primitives[0];
    const attrs = primitive.attributes;
    const positionAccessor = attrs.POSITION;
    const pos = decodeAccessor(glb, positionAccessor);
    if (pos.count !== sourceMesh.vertexCount) {
      add(`vertices-${sourceMesh.name}`, `Vertex count "${sourceMesh.name}"`, 'fail', `${pos.count} vs source ${sourceMesh.vertexCount}`);
    }

    if (sourceMesh.skinned) {
      const jointsIdx = attrs.JOINTS_0;
      const weightsIdx = attrs.WEIGHTS_0;
      const jointsOk = jointsIdx !== undefined;
      const weightsOk = weightsIdx !== undefined;
      let jointsDetail = 'JOINTS_0 missing';
      let jointsStatus: CheckStatus = 'fail';
      if (jointsOk && weightsOk) {
        const joints = decodeAccessor(glb, jointsIdx);
        const weights = decodeAccessor(glb, weightsIdx);
        const canonical = new Uint32Array(joints.count * 4);
        for (let i = 0; i < joints.count; i++) {
          for (let k = 0; k < 4; k++) canonical[i * 4 + k] = Math.round(joints.values[i * 4 + k]);
        }
        const wcanon = new Float32Array(weights.count * 4);
        for (let i = 0; i < weights.count; i++) {
          for (let k = 0; k < 4; k++) wcanon[i * 4 + k] = weights.values[i * 4 + k];
        }
        const jointHash = hashArray(canonical);
        const weightHash = hashArray(wcanon);
        const jointsMatch = sourceMesh.jointsHash === jointHash;
        const weightsMatch = sourceMesh.weightsHash === weightHash;
        let maxSumErr = 0;
        for (let i = 0; i < weights.count; i++) {
          const sum = wcanon[i * 4] + wcanon[i * 4 + 1] + wcanon[i * 4 + 2] + wcanon[i * 4 + 3];
          maxSumErr = Math.max(maxSumErr, Math.abs(sum - 1));
        }
        jointsStatus = jointsMatch && weightsMatch ? 'pass' : 'fail';
        jointsDetail = `${joints.count} vertices; JOINTS hash ${jointsMatch ? 'identical' : 'CHANGED'}, WEIGHTS hash ${weightsMatch ? 'identical' : 'CHANGED'}, max |Σw−1| ${maxSumErr.toExponential(2)}`;
        add(
          `weights-${sourceMesh.name}`,
          `Skin weights normalised "${sourceMesh.name}"`,
          maxSumErr < TOL_WEIGHT_SUM ? 'pass' : 'fail',
          `max weight-sum error ${maxSumErr.toExponential(2)}`,
        );
        if (exported.skin === undefined || !json.skins?.[exported.skin]) {
          add(`skinref-${sourceMesh.name}`, `Mesh "${sourceMesh.name}" bound to a skin`, 'fail', 'Node has no skin reference');
        }
      }
      add(`joints-${sourceMesh.name}`, `JOINTS_0 / WEIGHTS_0 "${sourceMesh.name}"`, jointsStatus, jointsDetail);
      const uvIdx = attrs.TEXCOORD_0;
      if (sourceMesh.uvHash) {
        if (uvIdx === undefined) {
          add(`uv-${sourceMesh.name}`, `UV set "${sourceMesh.name}"`, 'fail', 'TEXCOORD_0 missing');
        } else {
          const uv = decodeAccessor(glb, uvIdx);
          const canonical = new Float32Array(uv.count * 2);
          for (let i = 0; i < uv.count; i++) {
            canonical[i * 2] = uv.values[i * 2];
            canonical[i * 2 + 1] = uv.values[i * 2 + 1];
          }
          add(
            `uv-${sourceMesh.name}`,
            `UV set "${sourceMesh.name}"`,
            hashArray(canonical) === sourceMesh.uvHash ? 'pass' : 'fail',
            `${uv.count} UVs ${hashArray(canonical) === sourceMesh.uvHash ? 'byte-identical to source' : 'DIFFER from source'}`,
          );
        }
      }
    }

    if (sourceMesh.morphTargets.length) {
      const targets = primitive.targets ?? [];
      if (targets.length !== sourceMesh.morphTargets.length) {
        add(
          `morphs-${sourceMesh.name}`,
          `Morph targets "${sourceMesh.name}"`,
          'fail',
          `${targets.length} exported vs ${sourceMesh.morphTargets.length} in source`,
        );
      } else {
        let allMatch = true;
        let detail = '';
        for (let t = 0; t < targets.length; t++) {
          const idx = targets[t].POSITION;
          if (idx === undefined) {
            allMatch = false;
            detail = `target ${t} has no POSITION accessor`;
            continue;
          }
          const decoded = decodeAccessor(glb, idx);
          const canonical = new Float32Array(decoded.count * 3);
          for (let i = 0; i < decoded.count; i++) {
            canonical[i * 3] = decoded.values[i * 3];
            canonical[i * 3 + 1] = decoded.values[i * 3 + 1];
            canonical[i * 3 + 2] = decoded.values[i * 3 + 2];
          }
          const want = sourceMesh.morphTargets[t];
          if (hashArray(canonical) !== want.hash) {
            allMatch = false;
            detail += `${want.name} differs; `;
          }
        }
        const names = gltfMesh.extras?.targetNames ?? [];
        add(
          `morphs-${sourceMesh.name}`,
          `Morph targets "${sourceMesh.name}"`,
          allMatch ? 'pass' : 'fail',
          allMatch
            ? `${targets.length} target(s) byte-identical${names.length ? ` (${names.join(', ')})` : ''}`
            : detail || 'morph data differs',
        );
      }
    }

    // POSITION compare
    const expectedMesh = expected.meshes.find((m) => m.name === sourceMesh.name);
    if (expectedMesh) {
      let maxDiff = 0;
      let changed = 0;
      const n = Math.min(pos.count, expectedMesh.expectedPositions.length / 3);
      for (let i = 0; i < n; i++) {
        const dx = pos.values[i * 3] - expectedMesh.expectedPositions[i * 3];
        const dy = pos.values[i * 3 + 1] - expectedMesh.expectedPositions[i * 3 + 1];
        const dz = pos.values[i * 3 + 2] - expectedMesh.expectedPositions[i * 3 + 2];
        const d = Math.hypot(dx, dy, dz);
        if (d > maxDiff) maxDiff = d;
        const bx = expectedMesh.expectedPositions[i * 3] - expectedMesh.basePositions[i * 3];
        const by = expectedMesh.expectedPositions[i * 3 + 1] - expectedMesh.basePositions[i * 3 + 1];
        const bz = expectedMesh.expectedPositions[i * 3 + 2] - expectedMesh.basePositions[i * 3 + 2];
        if (Math.hypot(bx, by, bz) > 1e-6) changed++;
      }
      add(
        `positions-${sourceMesh.name}`,
        `Edited positions "${sourceMesh.name}"`,
        maxDiff <= TOL_POSITION ? 'pass' : 'fail',
        `${changed} vertex(es) carry sculpt deltas; max |export − editor| = ${maxDiff.toExponential(2)}`,
      );
      facts.maxSkinPositionDelta = Math.max(facts.maxSkinPositionDelta, maxDiff);
      facts.changedVertexCount = Math.max(facts.changedVertexCount, changed);
    }
  }

  // --- animations ----------------------------------------------------------
  if (manifest.clips.length) {
    const exportedClips = json.animations ?? [];
    const byName = new Map(exportedClips.map((c) => [c.name ?? 'unnamed', c]));
    let ok = exportedClips.length >= manifest.clips.length;
    const problems: string[] = [];
    for (const clip of manifest.clips) {
      const found = byName.get(clip.name);
      if (!found) {
        ok = false;
        problems.push(`${clip.name} missing`);
        continue;
      }
      if (found.channels.length !== clip.trackCount) {
        ok = false;
        problems.push(`${clip.name}: ${found.channels.length} channels vs ${clip.trackCount} tracks`);
      }
      let duration = 0;
      for (const sampler of found.samplers) {
        try {
          const input = decodeAccessor(glb, sampler.input);
          for (let i = 0; i < input.values.length; i++) duration = Math.max(duration, input.values[i]);
        } catch (error) {
          ok = false;
          problems.push(`${clip.name}: sampler unreadable`);
        }
      }
      if (Math.abs(duration - clip.duration) > 1e-3) {
        ok = false;
        problems.push(`${clip.name}: duration ${duration.toFixed(3)}s vs ${clip.duration.toFixed(3)}s`);
      }
      for (const channel of found.channels) {
        const target = channel.target.node;
        if (target === undefined || !json.nodes?.[target]) {
          ok = false;
          problems.push(`${clip.name}: channel targets a missing node`);
        }
      }
    }
    add(
      'animations',
      'Animation clips survive',
      ok ? 'pass' : 'fail',
      ok
        ? `${manifest.clips.map((c) => `${c.name} (${c.duration.toFixed(2)}s, ${c.trackCount} tracks)`).join('; ')}`
        : problems.slice(0, 5).join('; '),
    );
  } else {
    add('animations', 'Animation clips', 'pass', 'Source has no animation clips');
  }

  // --- materials -----------------------------------------------------------
  if (manifest.counts.materials > 0) {
    const names = new Set((json.materials ?? []).map((m) => m.name ?? ''));
    const missing = new Set<string>();
    for (const mesh of manifest.meshes) for (const name of mesh.materialNames) if (!names.has(name)) missing.add(name);
    add(
      'materials',
      'Materials survive',
      missing.size === 0 ? 'pass' : 'fail',
      missing.size === 0 ? `${names.size} material(s) exported: ${[...names].join(', ')}` : `missing ${[...missing].join(', ')}`,
    );
    // Colour drift is reported as a warning: colour-space conversion in the
    // exporter is allowed to round-trip within a small tolerance.
    let worstColor = 0;
    for (const mesh of manifest.meshes) {
      for (const mat of mesh.materialColors) {
        const exported = (json.materials ?? []).find((m) => (m.name ?? '') === mat.name);
        const factor = exported?.pbrMetallicRoughness?.baseColorFactor;
        if (!factor) continue;
        for (let k = 0; k < 3; k++) worstColor = Math.max(worstColor, Math.abs((factor[k] ?? 0) - mat.color[k]));
      }
    }
    add(
      'material-color',
      'Base colours survive',
      worstColor < 0.01 ? 'pass' : 'warn',
      `worst channel error ${worstColor.toFixed(4)} (linear working space)`,
    );
  }

  // --- root transform ------------------------------------------------------
  const parents = buildParentMap(json);
  const sceneRoot = json.scenes?.[json.scene ?? 0]?.nodes?.[0];
  const rootNode = sceneRoot !== undefined ? json.nodes?.[sceneRoot] : undefined;
  if (rootNode) {
    const scale = rootNode.scale ?? [1, 1, 1];
    const rot = rootNode.rotation ?? [0, 0, 0, 1];
    const wanted = manifest.root;
    const scaleErr = Math.max(...wanted.scale.map((v, i) => Math.abs(v - scale[i])));
    const rotErr = Math.max(...wanted.rotation.map((v, i) => Math.abs(v - rot[i])));
    add(
      'root-transform',
      'Model scale and orientation survive',
      scaleErr < 1e-4 && rotErr < 1e-4 ? 'pass' : 'warn',
      `root "${rootNode.name ?? '(unnamed)'}" scale error ${scaleErr.toExponential(2)}, rotation error ${rotErr.toExponential(2)}`,
    );
  } else {
    add('root-transform', 'Model scale and orientation', 'warn', 'Could not identify the scene root node');
  }
  void parents;

  if (json.extensionsRequired?.length) {
    add('extensions', 'No required extensions', 'warn', `requires ${json.extensionsRequired.join(', ')}`);
  }

  // Geometry edits are meaningful only if the export actually differs.
  if (facts.changedVertexCount === 0) {
    add('edit-evidence', 'Export contains geometry edits', 'warn', 'No vertex carried a non-zero sculpt delta');
  } else {
    add(
      'edit-evidence',
      'Export contains geometry edits',
      'pass',
      `${facts.changedVertexCount} vertex(es) differ from the imported base mesh`,
    );
  }

  const failures = checks.filter((c) => c.status === 'fail');
  const warnings = checks.filter((c) => c.status === 'warn');
  return {
    ok: failures.length === 0,
    checkedAt: timeStamp(),
    byteLength,
    checks,
    failures,
    warnings,
    facts,
  };
}

function emptyFacts(): ValidationReport['facts'] {
  return {
    nodeCount: 0,
    meshCount: 0,
    skinnedMeshCount: 0,
    skinCount: 0,
    animationCount: 0,
    materialCount: 0,
    morphTargets: 0,
    accessorCount: 0,
    maxSkinPositionDelta: 0,
    changedVertexCount: 0,
  };
}

function skeletonView(json: GlbJson): { joints: string[][] } {
  return { joints: skinJointNames(json) };
}
