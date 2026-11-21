import * as THREE from 'three';
import { createProceduralHumanoid } from '../fixtures/proceduralHumanoid';
import { History, type HistoryEntry } from '../core/history';
import { RigSafeSculptTarget, type SparseSculptDelta } from '../core/rigSafeSculpt';
import type { CharacterRecipeV1, MaterialOverride, ProjectRecipe, RecipeAttachment } from '../core/recipe';
import { isRecipeV2, type CharacterRecipeV2 } from '../core/recipe';
import {
  compose,
  meshPath,
  validateDna,
  type Dna,
  type Layer,
  type MeshSource,
  type Variant
} from '../core/dnaLayers';
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
  saveAutosaveProject,
  type AutosaveStatus
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
  /** V2 DNA state (always present once a character is mounted). */
  variantCount: number;
  activeVariantName: string;
  layerCount: number;
  activeLayerName: string;
  autosave: AutosaveStatus | null;
}

export interface VariantPreviewCapture {
  variantId: string;
  variantName: string;
  dataUrl: string;
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
  pendingRecipeAwaitingRelink: ProjectRecipe | null = null;

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

  // --- Character DNA V2: the single authoritative editing state ---
  /** Authoritative document: variants own sculpt layers, morphs, materials, accessory config. */
  dna: Dna | null = null;
  /** Session-level editing target: which sculpt layer of the active variant strokes write to. */
  activeLayerId: string | null = null;
  /** Autosave telemetry for the Project Status panel. */
  lastAutosave: AutosaveStatus | null = null;
  /** Validation/relink messages surfaced in Project Status (distinct from import warnings). */
  dnaWarnings: string[] = [];

  private meshIdByTarget = new Map<RigSafeSculptTarget, string>();
  private targetByMeshId = new Map<string, RigSafeSculptTarget>();
  private variantAttachments = new Map<string, ActiveAttachment[]>();
  private localAttachmentBytes = new Map<string, ArrayBuffer>();
  private strokeCapture: { target: RigSafeSculptTarget; beforeMask: Float32Array } | null = null;

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
    this.mountDnaState();

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

  // =============== Character DNA V2: authoritative state ===============
  //
  // One state ownership model: `this.dna` (variants → sculpt layers, morphs,
  // materials, accessory config) is the single source of truth. The live scene
  // buffers are a deterministic projection of the active variant; history
  // entries restore doc state and re-project. Strokes, layer ops, recipes,
  // autosave and GLB export all read this same state.

  private mountDnaState(): void {
    this.meshIdByTarget.clear();
    this.targetByMeshId.clear();
    this.variantAttachments.clear();
    for (const t of this.sculptTargets) {
      const idx: number[] = [];
      let cur: THREE.Object3D | null = t.object;
      while (cur && cur !== this.root) {
        const parent: THREE.Object3D | null = cur.parent;
        if (!parent) throw new Error('Sculpt target is not a descendant of the character root');
        idx.unshift(parent.children.indexOf(cur));
        cur = parent;
      }
      const id = meshPath(idx);
      if (this.targetByMeshId.has(id)) throw new Error(`Duplicate mesh identity: ${id}`);
      this.meshIdByTarget.set(t, id);
      this.targetByMeshId.set(id, t);
    }
    this.dna = {
      schema: 'dexsculpt.dna.v2',
      sourceSha256: this.sourceSha256.toLowerCase(),
      activeId: 'original',
      variants: [
        {
          id: 'original',
          name: this.title,
          layers: [],
          morphWeights: {},
          materialOverrides: {},
          attachments: [],
          configuration: {}
        }
      ]
    };
    this.activeLayerId = null;
    this.dnaWarnings = [];
    this.variantAttachments.set('original', this.attachments);
  }

  private meshIdFor(target: RigSafeSculptTarget): string {
    const id = this.meshIdByTarget.get(target);
    if (!id) throw new Error('Sculpt target is not registered in the DNA state');
    return id;
  }

  private dnaSources(): MeshSource[] {
    return this.sculptTargets.map((t) => ({ id: this.meshIdFor(t), positions: t.snapshot.sourcePos }));
  }

  get activeVariant(): Variant | null {
    if (!this.dna) return null;
    return this.dna.variants.find((v) => v.id === this.dna!.activeId) ?? null;
  }

  get activeLayer(): Layer | null {
    return this.activeVariant?.layers.find((l) => l.id === this.activeLayerId) ?? null;
  }

  private requireDna(): Dna {
    if (!this.dna) throw new Error('No character loaded');
    return this.dna;
  }

  /** Validate + commit a DNA mutation atomically, with a single undo entry that
   * restores the exact prior document and re-projects the scene. */
  private pushDnaEdit(label: string, mutate: (draft: Dna) => void, sideEffects?: (doc: Dna) => void): void {
    const dna = this.requireDna();
    const before = structuredClone(dna) as Dna;
    const draft = structuredClone(dna) as Dna;
    mutate(draft);
    validateDna(this.dnaSources(), draft, this.sourceSha256.toLowerCase());
    this.dna = draft;
    sideEffects?.(draft);
    this.projectActiveVariant();
    const after = structuredClone(draft) as Dna;
    this.history.push({
      label,
      bytes: JSON.stringify(before).length + JSON.stringify(after).length,
      undo: () => {
        this.dna = structuredClone(before) as Dna;
        sideEffects?.(before);
        this.projectActiveVariant();
        this.vp.needsRender = true;
        this.onChange();
      },
      redo: () => {
        this.dna = structuredClone(after) as Dna;
        sideEffects?.(after);
        this.projectActiveVariant();
        this.vp.needsRender = true;
        this.onChange();
      }
    });
    this.vp.needsRender = true;
  }

  /** Deterministic projection of the active variant into the live scene:
   * composed positions from immutable source + enabled layer deltas (float64
   * accumulation), morph weights and material overrides. Protected attributes
   * (UVs, skinning, morph deltas, materials, animations) are never rebuilt. */
  projectActiveVariant(): void {
    const dna = this.dna;
    const variant = this.activeVariant;
    if (!dna || !variant || !this.root) return;
    const composed = compose(this.dnaSources(), variant.layers);
    for (const t of this.sculptTargets) {
      const arr = composed[this.meshIdFor(t)];
      if (arr) t.projectRenderPositions(arr);
    }
    for (const m of this.morphs) {
      const v = variant.morphWeights[m.name] ?? 0;
      m.value = v;
      for (const ref of m.meshes) {
        if (!ref.mesh.morphTargetInfluences) ref.mesh.morphTargetInfluences = [];
        ref.mesh.morphTargetInfluences[ref.index] = v;
      }
    }
    for (const slot of this.materials) {
      slot.material.color.set(slot.original.colorHex);
      slot.material.roughness = slot.original.roughness;
      slot.material.metalness = slot.original.metalness;
      slot.material.emissive.set(slot.original.emissiveHex);
      const ov = variant.materialOverrides[slot.name];
      if (ov) {
        if (ov.colorHex) slot.material.color.set(ov.colorHex);
        if (typeof ov.roughness === 'number') slot.material.roughness = ov.roughness;
        if (typeof ov.metalness === 'number') slot.material.metalness = ov.metalness;
        if (ov.emissiveHex) slot.material.emissive.set(ov.emissiveHex);
      }
      slot.material.needsUpdate = true;
    }
    this.vp.needsRender = true;
  }

  // --- Sculpt layer operations (all history-backed, all project the same state) ---

  createLayer(name?: string): Layer {
    const dna = this.requireDna();
    const variant = this.activeVariant!;
    const base = (name ?? 'Sculpt Layer').trim() || 'Sculpt Layer';
    let finalName = base;
    let n = 2;
    while (variant.layers.some((l) => l.name === finalName)) finalName = `${base} ${n++}`;
    const id = `layer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.pushDnaEdit(`Add layer "${finalName}"`, (draft) => {
      const v = draft.variants.find((x) => x.id === draft.activeId)!;
      v.layers.push({ id, name: finalName, visible: true, strength: 1, deltas: {} });
    });
    this.activeLayerId = id;
    void dna;
    this.onChange();
    return this.activeVariant!.layers.find((l) => l.id === id)!;
  }

  selectLayer(id: string | null): void {
    const variant = this.activeVariant;
    if (id && !variant?.layers.some((l) => l.id === id)) return;
    this.activeLayerId = id;
    this.onChange();
  }

  renameLayer(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Layer name cannot be empty');
    this.pushDnaEdit(`Rename layer "${trimmed}"`, (draft) => {
      const v = draft.variants.find((x) => x.id === draft.activeId)!;
      const l = v.layers.find((x) => x.id === id);
      if (!l) throw new Error('Unknown layer');
      l.name = trimmed;
    });
  }

  toggleLayerVisible(id: string): void {
    let next = true;
    this.pushDnaEdit('Toggle layer visibility', (draft) => {
      const v = draft.variants.find((x) => x.id === draft.activeId)!;
      const l = v.layers.find((x) => x.id === id);
      if (!l) throw new Error('Unknown layer');
      l.visible = !l.visible;
      next = l.visible;
    });
    this.onToast(next ? 'Layer shown' : 'Layer hidden (edits preserved)', 'info');
  }

  setLayerStrength(id: string, strength: number): void {
    const s = Math.max(0, Math.min(1, strength));
    const current = this.activeVariant?.layers.find((l) => l.id === id);
    if (!current || current.strength === s) return;
    this.pushDnaEdit('Set layer strength', (draft) => {
      const v = draft.variants.find((x) => x.id === draft.activeId)!;
      const l = v.layers.find((x) => x.id === id);
      if (!l) throw new Error('Unknown layer');
      l.strength = s;
    });
  }

  duplicateLayer(id: string): Layer {
    let newId = '';
    let newName = '';
    this.pushDnaEdit('Duplicate layer', (draft) => {
      const v = draft.variants.find((x) => x.id === draft.activeId)!;
      const idx = v.layers.findIndex((x) => x.id === id);
      if (idx < 0) throw new Error('Unknown layer');
      const src = v.layers[idx];
      let base = `${src.name} copy`;
      let n = 2;
      while (v.layers.some((l) => l.name === base)) base = `${src.name} copy ${n++}`;
      newId = `layer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      newName = base;
      const clone: Layer = {
        id: newId,
        name: newName,
        visible: src.visible,
        strength: src.strength,
        deltas: structuredClone(src.deltas)
      };
      v.layers.splice(idx + 1, 0, clone);
    });
    this.activeLayerId = newId;
    this.onChange();
    return this.activeVariant!.layers.find((l) => l.id === newId)!;
  }

  resetLayer(id: string): void {
    this.pushDnaEdit('Reset layer', (draft) => {
      const v = draft.variants.find((x) => x.id === draft.activeId)!;
      const l = v.layers.find((x) => x.id === id);
      if (!l) throw new Error('Unknown layer');
      l.deltas = {};
    });
    this.onToast('Layer edits reset to source geometry', 'info');
  }

  deleteLayer(id: string): void {
    const variant = this.activeVariant;
    const layer = variant?.layers.find((l) => l.id === id);
    if (!layer) return;
    this.pushDnaEdit(`Delete layer "${layer.name}"`, (draft) => {
      const v = draft.variants.find((x) => x.id === draft.activeId)!;
      const idx = v.layers.findIndex((x) => x.id === id);
      if (idx < 0) throw new Error('Unknown layer');
      v.layers.splice(idx, 1);
    });
    if (this.activeLayerId === id) {
      this.activeLayerId = this.activeVariant?.layers[this.activeVariant.layers.length - 1]?.id ?? null;
    }
    this.onChange();
  }

  // --- Character variant operations ---

  createVariant(name?: string): Variant {
    const base = (name ?? 'Variant').trim() || 'Variant';
    const dna = this.requireDna();
    let finalName = base;
    let n = 2;
    while (dna.variants.some((v) => v.name === finalName)) finalName = `${base} ${n++}`;
    const id = `variant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.pushDnaEdit(
      `Create variant "${finalName}"`,
      (draft) => {
        draft.variants.push({
          id,
          name: finalName,
          layers: [],
          morphWeights: {},
          materialOverrides: {},
          attachments: [],
          configuration: {}
        });
        draft.activeId = id;
      },
      () => this.syncVariantAttachments()
    );
    this.activeLayerId = null;
    this.onChange();
    return this.activeVariant!;
  }

  duplicateVariant(id: string, name?: string): Variant {
    const dna = this.requireDna();
    const src = dna.variants.find((v) => v.id === id);
    if (!src) throw new Error('Unknown variant');
    let newId = '';
    let finalName = '';
    this.pushDnaEdit(
      `Duplicate variant "${src.name}"`,
      (draft) => {
        const v = draft.variants.find((x) => x.id === id)!;
        let base = name?.trim() || `${v.name} copy`;
        let n = 2;
        while (draft.variants.some((x) => x.name === base)) base = `${v.name} copy ${n++}`;
        finalName = base;
        newId = `variant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const clone = structuredClone(v) as Variant;
        clone.id = newId;
        clone.name = finalName;
        draft.variants.push(clone);
        draft.activeId = newId;
      },
      () => this.syncVariantAttachments()
    );
    // A duplicate initially matches its source exactly, then evolves independently.
    this.duplicateVariantAttachments(id, newId);
    this.activeLayerId = this.activeVariant?.layers[this.activeVariant.layers.length - 1]?.id ?? null;
    this.onChange();
    return this.activeVariant!;
  }

  renameVariant(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Variant name cannot be empty');
    this.pushDnaEdit(`Rename variant "${trimmed}"`, (draft) => {
      const v = draft.variants.find((x) => x.id === id);
      if (!v) throw new Error('Unknown variant');
      v.name = trimmed;
    });
  }

  switchVariant(id: string): void {
    const dna = this.requireDna();
    if (!dna.variants.some((v) => v.id === id)) throw new Error('Unknown variant');
    if (dna.activeId === id) return;
    this.pushDnaEdit(
      'Switch variant',
      (draft) => {
        draft.activeId = id;
      },
      () => this.syncVariantAttachments()
    );
    this.activeLayerId = this.activeVariant?.layers[this.activeVariant.layers.length - 1]?.id ?? null;
    this.onChange();
    this.onToast(`Switched to variant "${this.activeVariant!.name}"`, 'ok');
  }

  resetVariant(id: string): void {
    this.pushDnaEdit('Reset variant', (draft) => {
      const v = draft.variants.find((x) => x.id === id);
      if (!v) throw new Error('Unknown variant');
      v.layers = [];
      v.morphWeights = {};
      v.materialOverrides = {};
    });
    if (this.activeVariant?.id === id) this.activeLayerId = null;
    this.onChange();
  }

  deleteVariant(id: string): void {
    const dna = this.requireDna();
    const v = dna.variants.find((x) => x.id === id);
    if (!v) return;
    if (dna.variants.length <= 1) throw new Error('Cannot delete the only variant');
    this.pushDnaEdit(
      `Delete variant "${v.name}"`,
      (draft) => {
        const idx = draft.variants.findIndex((x) => x.id === id);
        if (idx < 0) throw new Error('Unknown variant');
        draft.variants.splice(idx, 1);
        if (draft.activeId === id) draft.activeId = draft.variants[0].id;
      },
      () => this.syncVariantAttachments()
    );
    const dropped = this.variantAttachments.get(id);
    if (dropped) {
      for (const a of dropped) {
        a.object.parent?.remove(a.object);
        disposeCharacterRoot(a.object);
      }
      this.variantAttachments.delete(id);
    }
    this.activeLayerId = this.activeVariant?.layers[this.activeVariant.layers.length - 1]?.id ?? null;
    this.onChange();
  }

  // --- Attachment ownership per variant ---

  private syncVariantAttachments(): void {
    const variant = this.activeVariant;
    if (!variant || !this.root) return;
    const seen = new Set<THREE.Object3D>();
    for (const [vid, list] of this.variantAttachments) {
      const active = vid === variant.id;
      for (const a of list) {
        a.object.visible = active;
        if (active) seen.add(a.object);
      }
    }
    let live = this.variantAttachments.get(variant.id);
    if (!live) {
      live = this.reconstructAttachments(variant);
      this.variantAttachments.set(variant.id, live);
    }
    for (const a of live) a.object.visible = true;
    this.attachments = live;
    this.selectedAttachmentId = null;
    this.vp.gizmo.detach();
    this.vp.needsRender = true;
    void seen;
  }

  private duplicateVariantAttachments(fromId: string, toId: string): void {
    const src = this.variantAttachments.get(fromId);
    const out: ActiveAttachment[] = [];
    if (src && this.root) {
      for (const a of src) {
        const cfg = serializeAttachmentToRecipe(a);
        const rebuilt = this.rebuildAttachment(cfg, out, toId);
        if (rebuilt) out.push(rebuilt);
      }
    }
    this.variantAttachments.set(toId, out);
    for (const a of out) a.object.visible = true;
    this.attachments = out;
    this.vp.needsRender = true;
  }

  private reconstructAttachments(variant: Variant): ActiveAttachment[] {
    const out: ActiveAttachment[] = [];
    for (const cfg of variant.attachments) {
      const rebuilt = this.rebuildAttachment(cfg, out, variant.id);
      if (rebuilt) out.push(rebuilt);
    }
    return out;
  }

  private rebuildAttachment(cfg: RecipeAttachment, sink: ActiveAttachment[], variantId: string): ActiveAttachment | null {
    if (!this.root) return null;
    try {
      if (cfg.proceduralId) {
        const built = attachProceduralModularItem(
          this.root,
          this.primarySkeleton,
          this.skeletonFamily,
          cfg.proceduralId,
          cfg.targetBone
        );
        built.object.position.set(...cfg.position);
        built.object.rotation.set(...cfg.rotation);
        built.object.scale.set(...cfg.scale);
        return built;
      }
      const bytes = this.localAttachmentBytes.get(cfg.sha256 ?? cfg.id);
      if (bytes && cfg.fileName) {
        // Restore from cached asset bytes (never invented geometry).
        void this.attachLocalGlbItemCached(cfg, bytes, sink, variantId);
        return null;
      }
      this.dnaWarnings.push(
        `Attachment "${cfg.name}" requires source relink (local GLB "${cfg.fileName ?? 'unknown'}" bytes unavailable). Metadata preserved; no geometry invented.`
      );
      return null;
    } catch (err) {
      this.dnaWarnings.push(`Could not restore attachment "${cfg.name}": ${(err as Error).message}`);
      return null;
    }
  }

  private async attachLocalGlbItemCached(
    cfg: RecipeAttachment,
    bytes: ArrayBuffer,
    sink: ActiveAttachment[],
    variantId: string
  ): Promise<void> {
    try {
      const att = await attachLocalGlbItem(
        this.root!,
        this.primarySkeleton,
        this.skeletonFamily,
        cfg.fileName!,
        bytes,
        cfg.mode,
        cfg.targetBone
      );
      att.object.position.set(...cfg.position);
      att.object.rotation.set(...cfg.rotation);
      att.object.scale.set(...cfg.scale);
      sink.push(att);
      att.object.visible = this.dna?.activeId === variantId;
      this.vp.needsRender = true;
      this.onChange();
    } catch (err) {
      this.dnaWarnings.push(`Could not restore attachment "${cfg.name}": ${(err as Error).message}`);
      this.onChange();
    }
  }

  // --- Layer-aware stroke pipeline (SculptTool integration) ---

  /** Called by SculptTool before a stroke begins. Returns false to block the stroke. */
  prepareSculptStroke(target: RigSafeSculptTarget): boolean {
    if (!this.dna || !this.root) return false;
    const variant = this.activeVariant;
    if (!variant) return false;
    if (!variant.layers.some((l) => l.id === this.activeLayerId)) {
      // Direct sculpting keeps working with no explicit layer: an implicit
      // history-backed layer becomes the editing target (V1 workflow preserved).
      this.createLayer(`Sculpt ${variant.layers.length + 1}`);
    }
    const layer = this.activeLayer;
    if (!layer) return false;
    if (!layer.visible) {
      this.onToast(`Layer "${layer.name}" is hidden — enable it before sculpting`, 'warn');
      return false;
    }
    this.strokeCapture = {
      target,
      beforeMask: Float32Array.from(target.mesh.mask)
    };
    this.strokeBeforePos = Float32Array.from(
      (target.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
    );
    return true;
  }

  /**
   * Commit a finished stroke into the active sculpt layer. The stroke's raw
   * displacement is added to the layer's stored deltas (layer strength scales
   * stored displacement at composition time); undo restores the exact prior
   * layer values and re-projects deterministically.
   */
  commitSculptStroke(target: RigSafeSculptTarget): void {
    const cap = this.strokeCapture;
    const beforePos = this.strokeBeforePos;
    this.strokeCapture = null;
    this.strokeBeforePos = null;
    const dna = this.dna;
    const variant = this.activeVariant;
    const layer = this.activeLayer;
    if (!cap || !beforePos || !dna || !variant || !layer || cap.target !== target) return;

    const meshId = this.meshIdFor(target);
    const posArr = (target.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const beforeMask = cap.beforeMask;

    const prevDense = layer.deltas[meshId] ?? [];
    const renderVerts = target.snapshot.renderVertexCount;
    const touched: number[] = [];
    const rawDelta: number[] = [];
    for (let r = 0; r < renderVerts; r++) {
      const i = r * 3;
      const dx = posArr[i] - beforePos[i];
      const dy = posArr[i + 1] - beforePos[i + 1];
      const dz = posArr[i + 2] - beforePos[i + 2];
      if (dx !== 0 || dy !== 0 || dz !== 0) {
        touched.push(r);
        rawDelta.push(dx, dy, dz);
      }
    }
    const maskChanged: number[] = [];
    for (let u = 0; u < target.mesh.vertCount; u++) {
      const r0 = this.firstRenderIndexOf(target, u);
      if (target.mesh.mask[u] !== beforeMask[r0]) {
        maskChanged.push(u);
      }
    }

    if (touched.length === 0 && maskChanged.length === 0) return;

    const dense = prevDense.length === renderVerts * 3 ? prevDense.slice() : new Array<number>(renderVerts * 3).fill(0);
    const beforeSparse: number[] = [];
    const afterSparse: number[] = [];
    for (let k = 0; k < touched.length; k++) {
      const i = touched[k] * 3;
      beforeSparse.push(dense[i], dense[i + 1], dense[i + 2]);
      dense[i] += rawDelta[k * 3];
      dense[i + 1] += rawDelta[k * 3 + 1];
      dense[i + 2] += rawDelta[k * 3 + 2];
      afterSparse.push(dense[i], dense[i + 1], dense[i + 2]);
    }
    const maskBeforeSparse = maskChanged.map((u) => beforeMask[this.firstRenderIndexOf(target, u)]);
    const maskAfterSparse = maskChanged.map((u) => target.mesh.mask[u]);

    const ownerVariantId = variant.id;
    const ownerLayerId = layer.id;
    const applyState = (sparse: number[], maskSparse: number[]) => {
      const d = this.dna;
      if (!d) return;
      // The stroke's layer lives in its OWNING variant, even if another variant
      // is active at undo/redo time (no cross-variant leakage).
      const v = d.variants.find((x) => x.id === ownerVariantId);
      const l = v?.layers.find((x) => x.id === ownerLayerId);
      if (l) {
        const cur = l.deltas[meshId] ?? [];
        const arr = cur.length === renderVerts * 3 ? cur.slice() : new Array<number>(renderVerts * 3).fill(0);
        for (let k = 0; k < touched.length; k++) {
          const i = touched[k] * 3;
          arr[i] = sparse[k * 3];
          arr[i + 1] = sparse[k * 3 + 1];
          arr[i + 2] = sparse[k * 3 + 2];
        }
        l.deltas[meshId] = arr;
      }
      for (let k = 0; k < maskChanged.length; k++) {
        target.mesh.mask[maskChanged[k]] = maskSparse[k];
      }
      this.projectActiveVariant();
      this.vp.needsRender = true;
      this.onChange();
    };

    // Commit the doc change first (atomic — validation failures leave state untouched),
    // then push the single reversible entry.
    const committed = structuredClone(dna) as Dna;
    {
      const v = committed.variants.find((x) => x.id === ownerVariantId)!;
      const l = v.layers.find((x) => x.id === ownerLayerId)!;
      l.deltas[meshId] = dense;
    }
    validateDna(this.dnaSources(), committed, this.sourceSha256.toLowerCase());
    this.dna = committed;
    this.projectActiveVariant();
    this.history.push({
      label: `Sculpt "${layer.name}"`,
      bytes: (beforeSparse.length + maskBeforeSparse.length) * 8,
      undo: () => applyState(beforeSparse, maskBeforeSparse),
      redo: () => applyState(afterSparse, maskAfterSparse)
    });
    this.vp.needsRender = true;
  }

  /** Pre-stroke render positions captured by `prepareSculptStroke`. */
  private strokeBeforePos: Float32Array | null = null;

  private firstRenderIndexOf(target: RigSafeSculptTarget, unique: number): number {
    return target.mesh.uniqRenderList[target.mesh.uniqRenderStart[unique]];
  }

  // --- Rendered-pixel capture (A/B comparison + acceptance evidence) ---

  /**
   * Capture the current viewport as a PNG data URL using a CANONICAL framing and
   * lighting (fixed camera derived from the character bounds, studio lighting,
   * bind pose) so captures taken at different times — or after a reload — are
   * pixel-comparable. The previous camera/lighting/pose are restored afterwards.
   */
  captureCanonicalPng(): string {
    if (!this.root) throw new Error('No character loaded');
    const vp = this.vp;
    const prevCam = vp.camera;
    const prevLight = vp.getLightingPreset();
    const prevPlaying = this.playing;
    this.resetToBindPose(true);
    if (prevLight !== 'studio') vp.setLightingPreset('studio');
    const box = new THREE.Box3().setFromObject(this.root);
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
    const cam = vp.perspCamera;
    const savedPos = cam.position.clone();
    const savedQuat = cam.quaternion.clone();
    const savedZoom = cam.zoom;
    const dist = (radius / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) * 1.12;
    cam.position.set(center.x, center.y + radius * 0.06, center.z + dist);
    cam.lookAt(center);
    cam.zoom = 1;
    cam.updateProjectionMatrix();
    vp.camera = cam;
    try {
      return vp.renderToPng();
    } finally {
      cam.position.copy(savedPos);
      cam.quaternion.copy(savedQuat);
      cam.zoom = savedZoom;
      cam.updateProjectionMatrix();
      vp.camera = prevCam;
      if (prevLight !== 'studio') vp.setLightingPreset(prevLight);
      if (prevPlaying) this.setPlaying(true);
      vp.needsRender = true;
    }
  }

  /** Capture two named variants with identical camera framing and lighting. */
  captureVariantPreviews(aId: string, bId: string): [VariantPreviewCapture, VariantPreviewCapture] {
    const dna = this.requireDna();
    const a = dna.variants.find((v) => v.id === aId);
    const b = dna.variants.find((v) => v.id === bId);
    if (!a || !b) throw new Error('Unknown variant for comparison');
    const originalActive = dna.activeId;
    const originalLayer = this.activeLayerId;
    try {
      this.switchVariantSilent(aId);
      const aCap: VariantPreviewCapture = { variantId: a.id, variantName: a.name, dataUrl: this.captureCanonicalPng() };
      this.switchVariantSilent(bId);
      const bCap: VariantPreviewCapture = { variantId: b.id, variantName: b.name, dataUrl: this.captureCanonicalPng() };
      return [aCap, bCap];
    } finally {
      this.switchVariantSilent(originalActive);
      this.activeLayerId = originalLayer;
    }
  }

  /** Internal variant projection WITHOUT history side effects (used by captures). */
  private switchVariantSilent(id: string): void {
    const dna = this.requireDna();
    if (!dna.variants.some((v) => v.id === id)) throw new Error('Unknown variant');
    dna.activeId = id;
    this.syncVariantAttachments();
    this.projectActiveVariant();
    this.vp.needsRender = true;
  }

  /**
   * Robust rendered-pixel comparison of two PNG data URLs. Returns the fraction
   * of differing pixels and the maximum per-channel difference (0..255).
   */
  async diffPngDataUrls(aUrl: string, bUrl: string): Promise<{ changedRatio: number; maxChannelDelta: number }> {
    const load = (url: string) =>
      new Promise<ImageData>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const cv = document.createElement('canvas');
          cv.width = img.width;
          cv.height = img.height;
          const ctx = cv.getContext('2d');
          if (!ctx) return reject(new Error('2D context unavailable'));
          ctx.drawImage(img, 0, 0);
          resolve(ctx.getImageData(0, 0, cv.width, cv.height));
        };
        img.onerror = () => reject(new Error('Failed to decode capture'));
        img.src = url;
      });
    const [ia, ib] = await Promise.all([load(aUrl), load(bUrl)]);
    if (ia.width !== ib.width || ia.height !== ib.height) {
      return { changedRatio: 1, maxChannelDelta: 255 };
    }
    let changed = 0;
    let maxDelta = 0;
    const n = ia.width * ia.height;
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      let localMax = 0;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(ia.data[i + c] - ib.data[i + c]);
        if (d > localMax) localMax = d;
      }
      if (localMax > 0) {
        changed++;
        if (localMax > maxDelta) maxDelta = localMax;
      }
    }
    return { changedRatio: changed / n, maxChannelDelta: maxDelta };
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
    this.dna = null;
    this.activeLayerId = null;
    this.dnaWarnings = [];
    this.meshIdByTarget.clear();
    this.targetByMeshId.clear();
    this.variantAttachments.clear();
    this.localAttachmentBytes.clear();
    this.strokeCapture = null;
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

  setMorphWeight(name: string, value: number, pushHistory = false, historyFrom?: number): void {
    const info = this.morphs.find((m) => m.name === name);
    if (!info) return;
    const clamped = Math.max(0, Math.min(1, value));
    const prev = historyFrom ?? info.value;

    const apply = (v: number) => {
      info.value = v;
      for (const ref of info.meshes) {
        if (!ref.mesh.morphTargetInfluences) ref.mesh.morphTargetInfluences = [];
        ref.mesh.morphTargetInfluences[ref.index] = v;
      }
      // Morph weights are variant-owned state; the doc is updated through the same path.
      const variant = this.activeVariant;
      if (variant) {
        if (Math.abs(v) > 1e-5) variant.morphWeights[name] = v;
        else delete variant.morphWeights[name];
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
    this.scheduleAutosave();
    this.onChange();
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
      this.syncVariantMaterialOverride(slot);
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

  /** Mirror the live material slot state into the active variant's overrides. */
  private syncVariantMaterialOverride(slot: MaterialSlotInfo): void {
    const variant = this.activeVariant;
    if (!variant) return;
    const colorHex = `#${slot.material.color.getHexString()}`;
    const emissiveHex = `#${slot.material.emissive.getHexString()}`;
    const changed =
      colorHex !== slot.original.colorHex ||
      emissiveHex !== slot.original.emissiveHex ||
      Math.abs(slot.material.roughness - slot.original.roughness) > 1e-4 ||
      Math.abs(slot.material.metalness - slot.original.metalness) > 1e-4;
    if (changed) {
      variant.materialOverrides[slot.name] = {
        colorHex,
        roughness: Number(slot.material.roughness.toFixed(4)),
        metalness: Number(slot.material.metalness.toFixed(4)),
        emissiveHex
      };
    } else {
      delete variant.materialOverrides[slot.name];
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
    const variant = this.activeVariant;
    if (!variant) return;
    const anyDeltas = variant.layers.some((l) => Object.keys(l.deltas).length > 0);
    if (!anyDeltas) return;
    this.pushDnaEdit('Reset sculpt edits', (draft) => {
      const v = draft.variants.find((x) => x.id === draft.activeId)!;
      for (const l of v.layers) l.deltas = {};
    });
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
    this.syncAttachmentDoc(att);
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
    // Cache real asset bytes (never invented geometry) for variant duplicates within the session.
    this.localAttachmentBytes.set(att.sha256 ?? att.id, bytes.slice(0));
    this.syncAttachmentDoc(att);
    this.selectAttachment(att.id);
    this.scheduleAutosave();
    this.vp.needsRender = true;
    this.onChange();
    this.onToast(`Attached ${att.name} (${att.mode})`, att.warnings.length ? 'warn' : 'ok');
    return att;
  }

  private syncAttachmentDoc(att: ActiveAttachment): void {
    const variant = this.activeVariant;
    if (!variant) return;
    variant.attachments = this.attachments.map(serializeAttachmentToRecipe);
    void att;
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
    const variant = this.activeVariant;
    if (variant) variant.attachments = this.attachments.map(serializeAttachmentToRecipe);
    this.scheduleAutosave();
    this.vp.needsRender = true;
    this.onChange();
  }

  // --- Catalog Association ---

  associateCatalogRecord(assetId: string, silent = false): CatalogRecord | null {
    const rec = getCatalogRecord(assetId);
    if (!rec) return null;

    // Catalogue provenance must never be assigned from an unrelated GLB.
    const expectedHash = rec.processed_glb_sha256?.toLowerCase();
    const currentHash = this.sourceSha256.toLowerCase();
    if (!expectedHash || expectedHash !== currentHash) {
      if (!silent) {
        this.onToast('Catalog identity does not match this GLB. Import the matching source file first.', 'warn');
      }
      return null;
    }
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

  // --- Non-Destructive Recipe & Export (V2 DNA schema + tested V1 migration) ---

  buildProjectRecipe(): CharacterRecipeV2 {
    if (this.beforeAfterOriginal) this.setBeforeAfterOriginal(false);
    const dna = this.requireDna();
    const variant = this.activeVariant!;
    if (this.attachments.length > 0 || variant.attachments.length > 0) {
      variant.attachments = this.attachments.map(serializeAttachmentToRecipe);
    }
    const doc = structuredClone(dna) as Dna;
    // Capture live accessory transforms for every variant that has live objects.
    for (const v of doc.variants) {
      const live = this.variantAttachments.get(v.id);
      if (live && live.length > 0) v.attachments = live.map(serializeAttachmentToRecipe);
    }
    return {
      schemaVersion: 'dexsculpt.recipe.v2',
      editorVersion: '0.2.0',
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
      dna: doc,
      sculptDeltas: this.deriveV1SculptDeltas(doc),
      activeVariantId: doc.activeId
    };
  }

  /** Derived V1-compat view: flattened sparse deltas of the composed ACTIVE variant. */
  private deriveV1SculptDeltas(doc: Dna): SparseSculptDelta[] {
    const variant = doc.variants.find((v) => v.id === doc.activeId)!;
    const composed = compose(this.dnaSources(), variant.layers);
    const out: SparseSculptDelta[] = [];
    for (const t of this.sculptTargets) {
      const meshId = this.meshIdFor(t);
      const arr = composed[meshId];
      const src = t.snapshot.sourcePos;
      const indices: number[] = [];
      const deltas: number[] = [];
      if (arr) {
        for (let r = 0; r < t.snapshot.renderVertexCount; r++) {
          const i = r * 3;
          const dx = arr[i] - src[i];
          const dy = arr[i + 1] - src[i + 1];
          const dz = arr[i + 2] - src[i + 2];
          if (dx !== 0 || dy !== 0 || dz !== 0) {
            indices.push(r);
            deltas.push(dx, dy, dz);
          }
        }
      }
      if (indices.length > 0) {
        out.push({ meshName: t.snapshot.meshName, vertexCount: t.snapshot.renderVertexCount, indices, deltas });
      }
    }
    return out;
  }

  /** Apply a recipe onto the currently loaded character (or load sample if recipe is procedural). */
  async loadProjectRecipe(recipe: ProjectRecipe): Promise<{ needsRelink: boolean; warnings: string[] }> {
    const warnings: string[] = [];
    if (!/^[a-f0-9]{64}$/i.test(recipe.source.sha256)) {
      throw new Error(
        'Recipe source identity is not a real SHA-256 digest; explicit relink and re-verification are required. Nothing was applied.'
      );
    }
    const expected = recipe.source.sha256.toLowerCase();
    if (recipe.source.kind === 'procedural-sample') {
      const alreadySample = this.root && this.sourceKind === 'procedural-sample';
      if (!alreadySample) await this.loadProceduralSample();
      if (this.sourceSha256 !== expected) {
        throw new Error('Recipe source SHA-256 does not match the procedural fixture build; nothing was applied');
      }
      this.installRecipe(recipe, warnings);
      return { needsRelink: false, warnings };
    }

    // Local GLB recipe: check if current loaded GLB matches source SHA-256
    if (this.sourceSha256 && this.sourceSha256 === expected && this.root) {
      this.installRecipe(recipe, warnings);
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
    const candidateHash = await sha256Hex(bytes);
    if (candidateHash !== pending.source.sha256) {
      throw new Error('Source SHA-256 differs from recipe; current character has not been replaced');
    }
    await this.loadLocalFile(fileName, bytes);
    this.installRecipe(pending, warnings);
    this.pendingRecipeAwaitingRelink = null;
    this.onChange();
    return warnings;
  }

  /**
   * Atomically install a validated recipe document. Throws BEFORE touching any
   * state when validation fails, so the currently loaded character (and its
   * valid autosave) remain unchanged.
   */
  private installRecipe(recipe: ProjectRecipe, warnings: string[]): void {
    const sources = this.dnaSources();
    let doc: Dna;
    if (isRecipeV2(recipe)) {
      doc = structuredClone(recipe.dna) as Dna;
      const sessionHash = this.sourceSha256.toLowerCase();
      if (doc.sourceSha256 !== sessionHash) {
        throw new Error('Recipe DNA source SHA-256 does not match the loaded character; nothing was applied');
      }
      validateDna(sources, doc, this.sourceSha256.toLowerCase());
    } else {
      doc = this.migrateV1RecipeLenient(recipe, warnings);
      if (doc.sourceSha256 !== this.sourceSha256.toLowerCase()) {
        throw new Error('Recipe source SHA-256 does not match the loaded character; nothing was applied');
      }
      validateDna(sources, doc, doc.sourceSha256);
    }

    // Commit point: from here on, state changes.
    this.dna = doc;
    this.projectId = recipe.projectId;
    this.title = recipe.title;
    this.createdAt = recipe.createdAt;
    if (recipe.source.assetId) this.linkedAssetId = recipe.source.assetId;
    this.activeLayerId = doc.variants.find((v) => v.id === doc.activeId)?.layers.slice(-1)[0]?.id ?? null;
    this.variantAttachments.clear();
    this.syncVariantAttachments();
    this.projectActiveVariant();
    this.history.clear();
    for (const w of warnings) this.dnaWarnings.push(w);
    this.vp.needsRender = true;
    this.scheduleAutosave();
    this.onChange();
  }

  /**
   * V1 -> V2 migration. Fail-closed rules preserved from the safety increment:
   * - a non-SHA-256 source identity is never accepted (explicit relink required);
   * - ambiguous/missing mesh names are SKIPPED with a warning, never guessed;
   * - malformed delta values abort the whole migration before anything is applied.
   */
  private migrateV1RecipeLenient(recipe: CharacterRecipeV1, warnings: string[]): Dna {
    if (!/^[a-f0-9]{64}$/i.test(recipe.source.sha256)) {
      throw new Error(
        'Legacy recipe source identity is not a real SHA-256 digest; explicit source re-verification is required. Nothing was applied.'
      );
    }
    const meshes = this.sculptTargets.map((t) => ({
      id: this.meshIdFor(t),
      name: t.snapshot.meshName,
      vertexCount: t.snapshot.renderVertexCount
    }));
    const deltas: Record<string, number[]> = Object.create(null);
    for (const entry of recipe.sculptDeltas) {
      const matches = meshes.filter((m) => m.name === entry.meshName && m.vertexCount === entry.vertexCount);
      if (matches.length !== 1) {
        warnings.push(`Skipped sculpt deltas for missing or ambiguous mesh "${entry.meshName}"`);
        continue;
      }
      const mesh = matches[0];
      if (entry.deltas.length !== entry.indices.length * 3) {
        throw new Error(`Malformed sculpt delta for "${entry.meshName}"; nothing was applied`);
      }
      const dense = new Array<number>(mesh.vertexCount * 3).fill(0);
      const seen = new Set<number>();
      entry.indices.forEach((index, i) => {
        if (!Number.isInteger(index) || index < 0 || index >= mesh.vertexCount || seen.has(index)) {
          throw new Error(`Invalid sculpt vertex index in "${entry.meshName}"; nothing was applied`);
        }
        seen.add(index);
        for (let c = 0; c < 3; c++) {
          const n = entry.deltas[i * 3 + c];
          if (!Number.isFinite(n)) throw new Error(`Invalid sculpt delta value in "${entry.meshName}"; nothing was applied`);
          dense[index * 3 + c] = n;
        }
      });
      if (Object.hasOwn(deltas, mesh.id)) throw new Error(`Duplicate legacy sculpt delta for "${entry.meshName}"; nothing was applied`);
      deltas[mesh.id] = dense;
    }
    return {
      schema: 'dexsculpt.dna.v2',
      sourceSha256: recipe.source.sha256.toLowerCase(),
      activeId: 'original',
      variants: [
        {
          id: 'original',
          name: recipe.title,
          layers: [{ id: 'legacy', name: 'Imported V1 sculpt', visible: true, strength: 1, deltas }],
          morphWeights: { ...recipe.morphWeights },
          materialOverrides: { ...recipe.materialOverrides },
          attachments: [...recipe.attachments],
          configuration: {}
        }
      ]
    };
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
      const warnings: string[] = [];
      if (bundle.recipe.source.kind === 'procedural-sample') {
        // Regenerate the deterministic fixture (preserves license/provenance metadata);
        // installRecipe verifies SHA-256 before applying any edits.
        await this.loadProceduralSample();
        this.installRecipe(bundle.recipe, warnings);
        this.onToast('Recovered local autosave session', 'info');
        return true;
      }
      // Prefer the exact cached source bytes (byte-deterministic identity match).
      if (bundle.sourceGlbBytes) {
        await this.loadLocalFile(bundle.recipe.source.fileName, bundle.sourceGlbBytes);
        this.installRecipe(bundle.recipe, warnings);
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
      try {
        const recipe = this.buildProjectRecipe();
        saveAutosaveProject(recipe, this.sourceBytes ?? undefined)
          .then((r) => {
            this.lastAutosave = {
              lastSavedAt: new Date().toISOString(),
              slot: r.slot,
              seq: r.seq,
              cachedSourceBytes: r.cachedSourceBytes
            };
            this.onChange();
          })
          .catch(() => {
            // Ignore IDB quota/teardown noise on unload
          });
      } catch {
        // Never let autosave bookkeeping break editing
      }
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
      requiresSourceRelink: !!this.pendingRecipeAwaitingRelink,
      variantCount: this.dna?.variants.length ?? 0,
      activeVariantName: this.activeVariant?.name ?? '',
      layerCount: this.activeVariant?.layers.length ?? 0,
      activeLayerName: this.activeLayer?.name ?? '',
      autosave: this.lastAutosave
    };
  }
}
