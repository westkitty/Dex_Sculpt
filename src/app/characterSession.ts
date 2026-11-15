import * as THREE from 'three';
import { createProceduralHumanoid } from '../fixtures/proceduralHumanoid';
import { History, type HistoryEntry } from '../core/history';
import { RigSafeSculptTarget } from '../core/rigSafeSculpt';
import type { CharacterRecipeV1, MaterialOverride } from '../core/recipe';
import {
  exportRigSafeGlb,
  importCharacterBytes,
  sha256Hex,
  type ExportGlbResult
} from '../io/glbPipeline';
import {
  compareRigPreservation,
  disposeCharacterRoot,
  validateGlbBinary,
  type GlbValidationReport,
  type RigPreservationDiff
} from '../io/glbValidator';
import {
  detectSkeletonFamilyFromBones,
  findCatalogRecordBySha256,
  getCatalogRecord,
  getCatalogSource,
  type CatalogRecord
} from '../catalog/catalogService';
import {
  attachLocalGlbItem,
  attachProceduralModularItem,
  serializeAttachmentToRecipe,
  type ActiveAttachment
} from '../modular/assembly';
import {
  recoverAutosaveProject,
  saveAutosaveProject
} from '../io/projectStorage';
import { attachMaskShaderHook, type StudioViewport } from './viewport';

export interface MaterialSlotInfo {
  key: string;
  name: string;
  material: THREE.MeshStandardMaterial;
  original: {
    colorHex: string;
    roughness: number;
    metalness: number;
    emissiveHex: string;
  };
}

export interface MorphTargetInfo {
  name: string;
  category: 'body' | 'face' | 'other';
  meshes: Array<{ mesh: THREE.Mesh; index: number }>;
  value: number;
}

export interface SessionStatusSnapshot {
  title: string;
  sourceKind: 'procedural-sample' | 'local-glb';
  sourceFileName: string;
  sourceSha256: string;
  skeletonFamily: string;
  linkedAssetId: string | null;
  licenseId: string;
  attribution?: string;
  isRigged: boolean;
  boneCount: number;
  morphCount: number;
  clipCount: number;
  totalVertices: number;
  totalTriangles: number;
  modifiedVertices: number;
  maxSculptDisplacement: number;
  beforeAfterOriginal: boolean;
  warnings: string[];
  requiresSourceRelink: boolean;
}

function classifyMorphCategory(name: string): 'body' | 'face' | 'other' {
  const n = name.toLowerCase();
  if (/(jaw|brow|eye|lip|mouth|nose|cheek|smile|blink|frown|face|chin|ear)/.test(n)) {
    return 'face';
  }
  if (/(shoulder|chest|torso|waist|hip|arm|leg|muscle|height|weight|body|broaden|volume)/.test(n)) {
    return 'body';
  }
  return 'other';
}

export class CharacterSession {
  readonly history = new History();

  projectId = `dex-${Date.now()}`;
  createdAt = new Date().toISOString();
  title = 'DEX Foundry Technical Humanoid';
  sourceKind: 'procedural-sample' | 'local-glb' = 'procedural-sample';
  sourceFileName = 'dex_foundry_humanoid.glb';
  sourceSha256 = '';
  sourceBytes: ArrayBuffer | null = null;
  skeletonFamily = 'dex-foundry-biped-20';
  linkedAssetId: string | null = null;
  licenseId = 'MIT';
  attribution: string | undefined = 'Original DEX//SCULPT Procedural Fixture (MIT)';
  provenanceUrl: string | undefined = undefined;
  pendingRecipeAwaitingRelink: CharacterRecipeV1 | null = null;

  root: THREE.Group | null = null;
  sculptTargets: RigSafeSculptTarget[] = [];
  primarySkeleton: THREE.Skeleton | null = null;
  animations: THREE.AnimationClip[] = [];
  mixer: THREE.AnimationMixer | null = null;
  activeAction: THREE.AnimationAction | null = null;
  activeClipName = '';
  playing = false;
  playbackSpeed = 1;
  currentTime = 0;

  materials: MaterialSlotInfo[] = [];
  morphs: MorphTargetInfo[] = [];
  attachments: ActiveAttachment[] = [];
  selectedAttachmentId: string | null = null;

  beforeAfterOriginal = false;
  warnings: string[] = [];
  baselineValidation: GlbValidationReport | null = null;
  lastExportResult: ExportGlbResult | null = null;
  lastExportDiff: RigPreservationDiff | null = null;

  onChange: () => void = () => {};
  onAnimTick: () => void = () => {};
  onToast: (msg: string, tone?: 'info' | 'warn' | 'error' | 'ok') => void = () => {};

  private autosaveTimer: number | null = null;
  private skeletonVisible = false;

  constructor(private vp: StudioViewport) {
    this.history.onChange = () => {
      this.scheduleAutosave();
      this.onChange();
    };
  }

  /** Load the built-in original procedural rigged humanoid + generate baseline GLB validation snapshot. */
  async loadProceduralSample(): Promise<void> {
    this.unloadCurrent();
    const bundle = createProceduralHumanoid();
    const baseline = await exportRigSafeGlb(bundle.root, bundle.animations);
    const sha = await sha256Hex(baseline.glb);

    this.projectId = `dex-sample-${Date.now()}`;
    this.createdAt = new Date().toISOString();
    this.title = bundle.metadata.name;
    this.sourceKind = 'procedural-sample';
    this.sourceFileName = 'dex_foundry_humanoid.glb';
    this.sourceSha256 = sha;
    this.sourceBytes = baseline.glb;
    this.skeletonFamily = bundle.metadata.skeletonFamily;
    this.linkedAssetId = bundle.metadata.id;
    this.licenseId = bundle.metadata.license;
    this.attribution = 'Original DEX//SCULPT procedural test fixture (MIT)';
    this.provenanceUrl = undefined;
    this.pendingRecipeAwaitingRelink = null;
    this.baselineValidation = baseline.validation;

    this.mountCharacter(bundle.root, bundle.animations, []);
    this.onToast('Loaded DEX Foundry Technical Humanoid (20 bones, 4 morphs, 3 clips)', 'ok');
  }

  /** Import a user-selected local GLB/glTF/OBJ/STL file without destroying skinning or morphs. */
  async loadLocalFile(fileName: string, bytes: ArrayBuffer): Promise<void> {
    const imported = await importCharacterBytes(fileName, bytes);
    this.unloadCurrent();

    this.projectId = `dex-local-${Date.now()}`;
    this.createdAt = new Date().toISOString();
    this.title = fileName.replace(/\.(glb|gltf|obj|stl)$/i, '');
    this.sourceKind = 'local-glb';
    this.sourceFileName = fileName;
    this.sourceSha256 = imported.sha256;
    this.sourceBytes = imported.sourceFormat === 'glb' ? bytes.slice(0) : null;
    this.pendingRecipeAwaitingRelink = null;

    if (imported.sourceFormat === 'glb') {
      try {
        this.baselineValidation = validateGlbBinary(bytes);
      } catch {
        this.baselineValidation = null;
      }
    } else {
      this.baselineValidation = null;
    }

    // Attempt automatic catalog association via SHA-256
    const matched = findCatalogRecordBySha256(imported.sha256);
    if (matched) {
      this.associateCatalogRecord(matched.asset_id, true);
    } else {
      this.linkedAssetId = null;
      this.licenseId = 'USER-LOCAL';
      this.attribution = undefined;
      this.provenanceUrl = undefined;
    }

    this.mountCharacter(imported.root, imported.animations, imported.warnings);
    if (!matched) {
      const boneNames = this.primarySkeleton?.bones.map((b) => b.name) ?? [];
      this.skeletonFamily = detectSkeletonFamilyFromBones(boneNames);
    }
    this.scheduleAutosave();
    this.onToast(
      imported.isRigged
        ? `Imported rigged character "${fileName}" (${this.primarySkeleton?.bones.length ?? 0} bones)`
        : `Imported static mesh "${fileName}"`,
      imported.warnings.length ? 'warn' : 'ok'
    );
  }

  private mountCharacter(
    root: THREE.Group,
    animations: THREE.AnimationClip[],
    warnings: string[]
  ): void {
    this.root = root;
    this.animations = animations;
    this.warnings = [...warnings];
    this.history.clear();
    this.beforeAfterOriginal = false;
    this.lastExportResult = null;
    this.lastExportDiff = null;

    this.sculptTargets = [];
    this.materials = [];
    const seenMat = new Set<THREE.Material>();
    let firstSkeleton: THREE.Skeleton | null = null;

    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;

      const skinned = obj as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh && skinned.skeleton && !firstSkeleton) {
        firstSkeleton = skinned.skeleton;
      }

      const target = new RigSafeSculptTarget(mesh);
      this.sculptTargets.push(target);

      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m, idx) => {
        if (m instanceof THREE.MeshStandardMaterial) {
          attachMaskShaderHook(m);
          if (!seenMat.has(m)) {
            seenMat.add(m);
            const name = m.name || `Material_${this.materials.length + 1}`;
            const key = `${name}#${this.materials.length}`;
            this.materials.push({
              key,
              name,
              material: m,
              original: {
                colorHex: `#${m.color.getHexString()}`,
                roughness: m.roughness,
                metalness: m.metalness,
                emissiveHex: `#${m.emissive.getHexString()}`
              }
            });
          }
        } else if (m) {
          this.warnings.push(`Material slot ${idx} on "${mesh.name}" is not MeshStandardMaterial (limited PBR edit).`);
        }
      });
    });

    this.primarySkeleton = firstSkeleton;
    this.rebuildMorphList();

    this.mixer = new THREE.AnimationMixer(root);
    this.activeAction = null;
    this.playing = false;
    this.currentTime = 0;
    this.activeClipName = animations[0]?.name ?? '';

    this.vp.scene.add(root);
    this.vp.frameObject(root);
    if (this.vp.getLightingPreset() === 'clay') {
      this.vp.applyClayPreview(true, root);
    }
    if (this.skeletonVisible) {
      this.vp.setSkeletonVisible(true, root);
    }
    this.vp.needsRender = true;
    this.onChange();
  }

  private rebuildMorphList(): void {
    const map = new Map<string, MorphTargetInfo>();
    for (const t of this.sculptTargets) {
      const m = t.object;
      const dict = m.morphTargetDictionary;
      const count = m.geometry.morphAttributes?.position?.length ?? 0;
      if (dict) {
        for (const [name, idx] of Object.entries(dict)) {
          let entry = map.get(name);
          if (!entry) {
            entry = {
              name,
              category: classifyMorphCategory(name),
              meshes: [],
              value: m.morphTargetInfluences?.[idx] ?? 0
            };
            map.set(name, entry);
          }
          entry.meshes.push({ mesh: m, index: idx });
        }
      } else {
        const posMorphs = m.geometry.morphAttributes?.position ?? [];
        for (let idx = 0; idx < count; idx++) {
          const name = posMorphs[idx]?.name || `morph_${idx}`;
          let entry = map.get(name);
          if (!entry) {
            entry = {
              name,
              category: classifyMorphCategory(name),
              meshes: [],
              value: m.morphTargetInfluences?.[idx] ?? 0
            };
            map.set(name, entry);
          }
          entry.meshes.push({ mesh: m, index: idx });
        }
      }
    }
    this.morphs = Array.from(map.values());
  }

  unloadCurrent(): void {
    this.vp.gizmo.detach();
    this.vp.setSkeletonVisible(false);
    if (this.vp.getLightingPreset() === 'clay') {
      this.vp.applyClayPreview(false);
    }
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer = null;
    }
    for (const t of this.sculptTargets) {
      t.dispose();
    }
    this.sculptTargets = [];
    if (this.root) {
      this.vp.scene.remove(this.root);
      disposeCharacterRoot(this.root);
      this.root = null;
    }
    this.attachments = [];
    this.selectedAttachmentId = null;
    this.materials = [];
    this.morphs = [];
    this.primarySkeleton = null;
    this.animations = [];
    this.activeAction = null;
    this.playing = false;
  }

  // --- Animation & Pose Controls ---

  selectClip(name: string): void {
    this.activeClipName = name;
    this.currentTime = 0;
    this.playing = false;
    if (this.mixer && this.root) {
      this.mixer.stopAllAction();
      const clip = this.animations.find((c) => c.name === name);
      if (clip) {
        this.activeAction = this.mixer.clipAction(clip);
        this.activeAction.play();
        this.activeAction.paused = true;
        this.mixer.setTime(0);
      } else {
        this.activeAction = null;
      }
    }
    this.vp.needsRender = true;
    this.onChange();
  }

  setPlaying(play: boolean): void {
    if (!this.mixer || this.animations.length === 0) return;
    if (this.beforeAfterOriginal) this.setBeforeAfterOriginal(false);
    if (!this.activeAction && this.activeClipName) {
      this.selectClip(this.activeClipName);
    }
    if (!this.activeAction) return;
    this.playing = play;
    this.activeAction.paused = !play;
    this.vp.continuous = play;
    this.vp.needsRender = true;
    this.onChange();
  }

  scrubAnimation(timeSec: number): void {
    if (!this.mixer) return;
    if (!this.activeAction && this.activeClipName) {
      this.selectClip(this.activeClipName);
    }
    if (!this.activeAction) return;
    const dur = this.activeAction.getClip().duration || 1;
    const clamped = Math.max(0, Math.min(dur, timeSec));
    this.playing = false;
    this.activeAction.paused = true;
    this.mixer.setTime(clamped);
    this.currentTime = clamped;
    this.root?.updateMatrixWorld(true);
    this.vp.continuous = false;
    this.vp.needsRender = true;
    this.onChange();
  }

  resetToBindPose(silent = false): void {
    this.playing = false;
    this.vp.continuous = false;
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.activeAction = null;
    }
    this.currentTime = 0;
    if (this.root) {
      this.root.traverse((o) => {
        const sm = o as THREE.SkinnedMesh;
        if (sm.isSkinnedMesh && sm.skeleton) {
          sm.skeleton.pose();
        }
      });
      this.root.updateMatrixWorld(true);
    }
    this.vp.needsRender = true;
    if (!silent) this.onToast('Reset rig to clean bind pose', 'info');
    this.onChange();
  }

  ensureBindPoseForSculpting(): void {
    if (!this.primarySkeleton) return;
    const wasActive = this.playing || this.activeAction !== null;
    if (wasActive) {
      this.resetToBindPose(true);
      this.onToast('Switched to Bind Pose for accurate symmetrical sculpting (animation preserved)', 'info');
    }
  }

  tickFrame(dtSec: number): void {
    if (!this.playing || !this.mixer || !this.activeAction) return;
    this.mixer.update(dtSec * this.playbackSpeed);
    const dur = this.activeAction.getClip().duration || 1;
    this.currentTime = this.activeAction.time % dur;
    this.root?.updateMatrixWorld(true);
    this.vp.needsRender = true;
    this.onAnimTick();
  }

  setSkeletonVisible(visible: boolean): void {
    this.skeletonVisible = visible;
    this.vp.setSkeletonVisible(visible, this.root ?? undefined);
  }

  // --- Morph Target Controls ---

  setMorphWeight(name: string, value: number, pushHistory = false): void {
    const info = this.morphs.find((m) => m.name === name);
    if (!info) return;
    const clamped = Math.max(0, Math.min(1, value));
    const prev = info.value;

    const apply = (v: number) => {
      info.value = v;
      for (const ref of info.meshes) {
        if (!ref.mesh.morphTargetInfluences) ref.mesh.morphTargetInfluences = [];
        ref.mesh.morphTargetInfluences[ref.index] = v;
      }
      this.vp.needsRender = true;
    };

    apply(clamped);
    if (pushHistory && Math.abs(clamped - prev) > 1e-4) {
      this.history.push({
        label: `Morph ${name}`,
        bytes: 32,
        undo: () => {
          apply(prev);
          this.onChange();
        },
        redo: () => {
          apply(clamped);
          this.onChange();
        }
      });
    } else {
      this.scheduleAutosave();
      this.onChange();
    }
  }

  resetAllMorphs(): void {
    const changed = this.morphs.filter((m) => Math.abs(m.value) > 1e-4);
    if (changed.length === 0) return;
    const prev = changed.map((m) => ({ name: m.name, val: m.value }));
    const write = (valMap: Array<{ name: string; val: number }>) => {
      for (const item of valMap) {
        this.setMorphWeight(item.name, item.val, false);
      }
    };
    write(prev.map((p) => ({ name: p.name, val: 0 })));
    this.history.push({
      label: 'Reset morph targets',
      bytes: prev.length * 32,
      undo: () => write(prev),
      redo: () => write(prev.map((p) => ({ name: p.name, val: 0 })))
    });
  }

  // --- Material Overrides ---

  updateMaterial(key: string, patch: MaterialOverride, pushHistory = true): void {
    const slot = this.materials.find((m) => m.key === key);
    if (!slot) return;
    const prev: MaterialOverride = {
      colorHex: `#${slot.material.color.getHexString()}`,
      roughness: slot.material.roughness,
      metalness: slot.material.metalness,
      emissiveHex: `#${slot.material.emissive.getHexString()}`
    };

    const apply = (ov: MaterialOverride) => {
      if (ov.colorHex) slot.material.color.set(ov.colorHex);
      if (typeof ov.roughness === 'number') slot.material.roughness = ov.roughness;
      if (typeof ov.metalness === 'number') slot.material.metalness = ov.metalness;
      if (ov.emissiveHex) slot.material.emissive.set(ov.emissiveHex);
      slot.material.needsUpdate = true;
      this.vp.needsRender = true;
    };

    apply(patch);
    if (pushHistory) {
      this.history.push({
        label: `Material ${slot.name}`,
        bytes: 128,
        undo: () => {
          apply(prev);
          this.onChange();
        },
        redo: () => {
          apply(patch);
          this.onChange();
        }
      });
    } else {
      this.scheduleAutosave();
      this.onChange();
    }
  }

  resetMaterial(key: string): void {
    const slot = this.materials.find((m) => m.key === key);
    if (!slot) return;
    this.updateMaterial(key, slot.original, true);
  }

  // --- Sculpt Reset & Mask & Before/After ---

  setBeforeAfterOriginal(showOriginal: boolean): void {
    this.beforeAfterOriginal = showOriginal;
    for (const t of this.sculptTargets) {
      t.setBeforeAfterPreview(showOriginal);
    }
    this.vp.needsRender = true;
    this.onChange();
  }

  resetAllSculptDeltas(): void {
    const entries: HistoryEntry[] = [];
    for (const t of this.sculptTargets) {
      const e = t.createResetSculptEntry();
      if (e) entries.push(e);
    }
    if (entries.length === 0) return;
    this.history.push({
      label: 'Reset sculpt edits',
      bytes: entries.reduce((acc, e) => acc + e.bytes, 0),
      undo: () => {
        entries.forEach((e) => e.undo());
        this.vp.needsRender = true;
        this.onChange();
      },
      redo: () => {
        entries.forEach((e) => e.redo());
        this.vp.needsRender = true;
        this.onChange();
      }
    });
    this.vp.needsRender = true;
    this.onToast('Reset sculpt geometry deltas to source mesh', 'info');
  }

  editMask(mode: 'clear' | 'invert'): void {
    const entries: HistoryEntry[] = [];
    for (const t of this.sculptTargets) {
      const e = t.createMaskEditEntry(mode);
      if (e) entries.push(e);
    }
    if (entries.length === 0) return;
    this.history.push({
      label: mode === 'clear' ? 'Clear Mask' : 'Invert Mask',
      bytes: entries.reduce((acc, e) => acc + e.bytes, 0),
      undo: () => {
        entries.forEach((e) => e.undo());
        this.vp.needsRender = true;
      },
      redo: () => {
        entries.forEach((e) => e.redo());
        this.vp.needsRender = true;
      }
    });
    this.vp.needsRender = true;
  }

  // --- Modular Assembly ---

  attachProcedural(proceduralId: string, targetBone?: string): ActiveAttachment {
    if (!this.root) throw new Error('No character loaded');
    const att = attachProceduralModularItem(
      this.root,
      this.primarySkeleton,
      this.skeletonFamily,
      proceduralId,
      targetBone
    );
    this.attachments.push(att);
    this.selectAttachment(att.id);
    this.scheduleAutosave();
    this.vp.needsRender = true;
    this.onChange();
    this.onToast(
      att.warnings.length ? `${att.name} attached (${att.warnings[0]})` : `Attached ${att.name} -> ${att.targetBone}`,
      att.warnings.length ? 'warn' : 'ok'
    );
    return att;
  }

  async attachLocalFile(
    fileName: string,
    bytes: ArrayBuffer,
    mode: 'bone-attached' | 'static-prop' | 'skinned-compatible',
    targetBone: string
  ): Promise<ActiveAttachment> {
    if (!this.root) throw new Error('No character loaded');
    const att = await attachLocalGlbItem(
      this.root,
      this.primarySkeleton,
      this.skeletonFamily,
      fileName,
      bytes,
      mode,
      targetBone
    );
    this.attachments.push(att);
    this.selectAttachment(att.id);
    this.scheduleAutosave();
    this.vp.needsRender = true;
    this.onChange();
    this.onToast(`Attached ${att.name} (${att.mode})`, att.warnings.length ? 'warn' : 'ok');
    return att;
  }

  selectAttachment(id: string | null): void {
    this.selectedAttachmentId = id;
    const att = this.attachments.find((a) => a.id === id);
    if (att && att.mode !== 'skinned-compatible') {
      this.vp.gizmo.attach(att.object);
    } else {
      this.vp.gizmo.detach();
    }
    this.vp.needsRender = true;
    this.onChange();
  }

  removeAttachment(id: string): void {
    const idx = this.attachments.findIndex((a) => a.id === id);
    if (idx < 0) return;
    const att = this.attachments[idx];
    if (this.selectedAttachmentId === id) {
      this.vp.gizmo.detach();
      this.selectedAttachmentId = null;
    }
    att.object.parent?.remove(att.object);
    disposeCharacterRoot(att.object);
    this.attachments.splice(idx, 1);
    this.scheduleAutosave();
    this.vp.needsRender = true;
    this.onChange();
  }

  // --- Catalog Association ---

  associateCatalogRecord(assetId: string, silent = false): CatalogRecord | null {
    const rec = getCatalogRecord(assetId);
    if (!rec) return null;
    this.linkedAssetId = rec.asset_id;
    this.skeletonFamily = rec.skeleton_family ?? this.skeletonFamily;
    this.licenseId = rec.license_id;
    const src = getCatalogSource(rec.source_id);
    this.provenanceUrl = src?.official_url;
    this.attribution =
      rec.license_id === 'CC-BY-4.0'
        ? `Attribution required (${rec.license_id}): ${src?.name ?? rec.source_id}`
        : `${src?.name ?? rec.source_id} (${rec.license_id})`;
    this.scheduleAutosave();
    this.onChange();
    if (!silent) {
      this.onToast(`Associated loaded character with catalog ID: ${rec.asset_id}`, 'ok');
    }
    return rec;
  }

  // --- Non-Destructive Recipe & Export ---

  buildRecipe(): CharacterRecipeV1 {
    if (this.beforeAfterOriginal) this.setBeforeAfterOriginal(false);
    const morphWeights: Record<string, number> = {};
    for (const m of this.morphs) {
      if (Math.abs(m.value) > 1e-5) morphWeights[m.name] = Number(m.value.toFixed(4));
    }

    const materialOverrides: Record<string, MaterialOverride> = {};
    for (const slot of this.materials) {
      const colorHex = `#${slot.material.color.getHexString()}`;
      const emissiveHex = `#${slot.material.emissive.getHexString()}`;
      if (
        colorHex !== slot.original.colorHex ||
        emissiveHex !== slot.original.emissiveHex ||
        Math.abs(slot.material.roughness - slot.original.roughness) > 1e-4 ||
        Math.abs(slot.material.metalness - slot.original.metalness) > 1e-4
      ) {
        materialOverrides[slot.name] = {
          colorHex,
          roughness: Number(slot.material.roughness.toFixed(4)),
          metalness: Number(slot.material.metalness.toFixed(4)),
          emissiveHex
        };
      }
    }

    return {
      schemaVersion: 'dexsculpt.recipe.v1',
      editorVersion: '0.1.0',
      projectId: this.projectId,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      source: {
        kind: this.sourceKind,
        assetId: this.linkedAssetId,
        displayName: this.title,
        fileName: this.sourceFileName,
        sha256: this.sourceSha256,
        skeletonFamily: this.skeletonFamily,
        licenseId: this.licenseId,
        attribution: this.attribution,
        provenanceUrl: this.provenanceUrl,
        requiresSourceRelink: this.sourceKind !== 'procedural-sample'
      },
      sculptDeltas: this.sculptTargets
        .map((t) => t.exportSparseDeltas())
        .filter((d) => d.indices.length > 0),
      morphWeights,
      materialOverrides,
      attachments: this.attachments.map(serializeAttachmentToRecipe)
    };
  }

  /** Apply a recipe onto the currently loaded character (or load sample if recipe is procedural). */
  async loadRecipe(recipe: CharacterRecipeV1): Promise<{ needsRelink: boolean; warnings: string[] }> {
    const warnings: string[] = [];
    if (recipe.source.kind === 'procedural-sample') {
      await this.loadProceduralSample();
      this.applyRecipeEdits(recipe, warnings);
      return { needsRelink: false, warnings };
    }

    // Local GLB recipe: check if current loaded GLB matches source SHA-256
    if (this.sourceSha256 && this.sourceSha256 === recipe.source.sha256 && this.root) {
      this.applyRecipeEdits(recipe, warnings);
      return { needsRelink: false, warnings };
    }

    this.pendingRecipeAwaitingRelink = recipe;
    this.onChange();
    return { needsRelink: true, warnings };
  }

  async relinkSourceForPendingRecipe(fileName: string, bytes: ArrayBuffer): Promise<string[]> {
    const pending = this.pendingRecipeAwaitingRelink;
    if (!pending) throw new Error('No pending recipe awaiting relink');
    const warnings: string[] = [];
    await this.loadLocalFile(fileName, bytes);
    if (this.sourceSha256 !== pending.source.sha256) {
      warnings.push(
        `Source SHA-256 differs from recipe (${this.sourceSha256.slice(0, 12)} vs ${pending.source.sha256.slice(0, 12)}). Attempting vertex-count compatible apply.`
      );
    }
    this.applyRecipeEdits(pending, warnings);
    this.pendingRecipeAwaitingRelink = null;
    this.onChange();
    return warnings;
  }

  private applyRecipeEdits(recipe: CharacterRecipeV1, warnings: string[]): void {
    this.projectId = recipe.projectId;
    this.title = recipe.title;
    this.createdAt = recipe.createdAt;
    if (recipe.source.assetId) this.linkedAssetId = recipe.source.assetId;

    // Apply sparse sculpt deltas
    for (const d of recipe.sculptDeltas) {
      const target =
        this.sculptTargets.find((t) => t.snapshot.meshName === d.meshName) ??
        this.sculptTargets.find((t) => t.snapshot.renderVertexCount === d.vertexCount);
      if (!target) {
        warnings.push(`Skipped sculpt deltas for missing mesh "${d.meshName}"`);
        continue;
      }
      target.applySparseDeltas(d);
    }

    // Apply morph weights
    for (const [name, weight] of Object.entries(recipe.morphWeights)) {
      this.setMorphWeight(name, weight, false);
    }

    // Apply material overrides
    for (const [matName, ov] of Object.entries(recipe.materialOverrides)) {
      const slot = this.materials.find((m) => m.name === matName);
      if (slot) this.updateMaterial(slot.key, ov, false);
    }

    // Reconstruct procedural attachments (local file attachments flagged if missing)
    for (const att of recipe.attachments) {
      if (att.proceduralId) {
        try {
          const built = this.attachProcedural(att.proceduralId, att.targetBone);
          built.object.position.set(...att.position);
          built.object.rotation.set(...att.rotation);
          built.object.scale.set(...att.scale);
        } catch (err) {
          warnings.push(`Could not reattach "${att.name}": ${(err as Error).message}`);
        }
      } else if (att.requiresLocalFile) {
        warnings.push(`Attachment "${att.name}" (${att.fileName ?? 'local GLB'}) requires manual local re-import.`);
      }
    }

    this.vp.needsRender = true;
    this.scheduleAutosave();
    this.onChange();
  }

  async exportCharacterGlb(): Promise<{ result: ExportGlbResult; diff: RigPreservationDiff | null }> {
    if (!this.root) throw new Error('No character loaded');
    if (this.beforeAfterOriginal) this.setBeforeAfterOriginal(false);

    // Temporarily restore materials if in Clay preview so exported GLB keeps real PBR materials!
    const wasClay = this.vp.getLightingPreset() === 'clay';
    if (wasClay) this.vp.applyClayPreview(false);

    try {
      const result = await exportRigSafeGlb(this.root, this.animations, { resetToBindPose: true });
      let diff: RigPreservationDiff | null = null;
      if (this.baselineValidation && result.validation.skinCount > 0 && this.baselineValidation.skinCount > 0) {
        diff = compareRigPreservation(
          this.baselineValidation,
          result.validation,
          this.getTotalModifiedVertices() > 0,
          this.attachments.length > 0
        );
      }
      this.lastExportResult = result;
      this.lastExportDiff = diff;
      this.onChange();
      return { result, diff };
    } finally {
      if (wasClay) this.vp.applyClayPreview(true, this.root);
    }
  }

  /** Re-import the last exported GLB directly into the studio to prove round-trip fidelity! */
  async verifyReimportLastExport(): Promise<void> {
    if (!this.lastExportResult) throw new Error('Export a GLB first');
    await this.loadLocalFile(`${this.title}_reimported.glb`, this.lastExportResult.glb);
    this.onToast('Re-imported exported GLB cleanly — inspect rig & play animations to verify!', 'ok');
  }

  async tryRecoverAutosave(): Promise<boolean> {
    try {
      const recovered = await recoverAutosaveProject();
      if (!recovered) return false;
      const { bundle } = recovered;
      if (bundle.recipe.source.kind === 'procedural-sample') {
        await this.loadProceduralSample();
        this.applyRecipeEdits(bundle.recipe, []);
        this.onToast('Recovered local autosave session', 'info');
        return true;
      }
      if (bundle.sourceGlbBytes) {
        await this.loadLocalFile(bundle.recipe.source.fileName, bundle.sourceGlbBytes);
        this.applyRecipeEdits(bundle.recipe, []);
        this.onToast(`Recovered autosaved "${bundle.recipe.title}"`, 'info');
        return true;
      }
      this.pendingRecipeAwaitingRelink = bundle.recipe;
      return false;
    } catch {
      return false;
    }
  }

  private scheduleAutosave(): void {
    if (!this.root || typeof indexedDB === 'undefined') return;
    if (this.autosaveTimer !== null) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = null;
      const recipe = this.buildRecipe();
      saveAutosaveProject(recipe, this.sourceBytes ?? undefined).catch(() => {
        // Ignore IDB quota/teardown noise on unload
      });
    }, 500);
  }

  getTotalModifiedVertices(): number {
    return this.sculptTargets.reduce((acc, t) => acc + t.getModifiedVertexCount(), 0);
  }

  getMaxSculptDisplacement(): number {
    return this.sculptTargets.reduce((acc, t) => Math.max(acc, t.getMaxDisplacement()), 0);
  }

  getStatus(): SessionStatusSnapshot {
    const totalVertices = this.sculptTargets.reduce((a, t) => a + t.snapshot.renderVertexCount, 0);
    const totalTriangles = this.sculptTargets.reduce((a, t) => a + t.snapshot.triangleCount, 0);
    return {
      title: this.title,
      sourceKind: this.sourceKind,
      sourceFileName: this.sourceFileName,
      sourceSha256: this.sourceSha256,
      skeletonFamily: this.skeletonFamily,
      linkedAssetId: this.linkedAssetId,
      licenseId: this.licenseId,
      attribution: this.attribution,
      isRigged: !!this.primarySkeleton,
      boneCount: this.primarySkeleton?.bones.length ?? 0,
      morphCount: this.morphs.length,
      clipCount: this.animations.length,
      totalVertices,
      totalTriangles,
      modifiedVertices: this.getTotalModifiedVertices(),
      maxSculptDisplacement: this.getMaxSculptDisplacement(),
      beforeAfterOriginal: this.beforeAfterOriginal,
      warnings: this.warnings,
      requiresSourceRelink: !!this.pendingRecipeAwaitingRelink
    };
  }
}
