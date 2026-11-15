/**
 * DEX//SCULPT studio controller.
 *
 * Owns the loaded character, edit state, history, input routing, project
 * persistence and export/verify flows. Panels are pure render functions over
 * this state (see src/ui/*), so there is exactly one source of truth.
 */
import * as THREE from 'three';
import { Character, type MeshRecord, type MaterialSlot } from '../character/character';
import { loadCharacter } from '../character/loader';
import { exportCharacterGLB, downloadBytes, preflightExport, ExportBlockedError, type ExportResult } from '../character/exporter';
import {
  attachToBone,
  checkClearance,
  inspectAttachment,
  reattachFromRecipe,
  removeAttachment,
  setAttachmentTransform,
  type Attachment,
  type AttachmentCompatibility,
  type ClearanceReport,
} from '../character/attachments';
import { SculptEngine, BRUSHES, type BrushId, type StrokeSettings, type StrokeHit } from '../sculpt/engine';
import { verifyReimport, summariseReimport, type ReimportReport } from '../validation/reimport';
import { applyRecipe, buildRecipe, recipeSummary, RECIPE_SCHEMA, type CharacterRecipe } from '../project/recipe';
import { ProjectStore, type ProjectSummary } from '../project/store';
import { loadCatalog, filterAssets, type CatalogAsset, type CatalogSummary, type CatalogFilter } from '../catalog/catalog';
import { EXAMPLE_ASSETS, getExample, type ExampleAsset } from '../fixtures/registry';
import { History, type Command } from './history';
import { Viewport, type LightPreset, type PickHit, type Projection, type Quality, type ViewPreset } from './viewport';
import { hashArray, clamp, formatBytes, fromBase64 } from '../core/util';
import { renderLibrary } from '../ui/library';
import { renderInspector } from '../ui/inspector';
import { renderToolDock } from '../ui/dock';
import { renderViewControls, renderChips } from '../ui/hud';
import { closeModal, showModal, type ModalAction } from '../ui/modal';
import { renderExportReport } from '../ui/reports';

export type Mode = 'setup' | 'sculpt' | 'animate';
export type Tab = 'appearance' | 'rig' | 'animate' | 'attach' | 'project';
export type LibraryFilter = 'all' | 'examples' | 'metadata' | 'rigged' | 'animated';

export interface StudioState {
  mode: Mode;
  tab: Tab;
  projectId: string;
  projectName: string;
  dirty: boolean;
  tool: BrushId;
  radiusPx: number;
  strength: number;
  symmetryX: boolean;
  usePressure: boolean;
  tiltWidens: boolean;
  selectedBone: string | null;
  clip: string | null;
  playing: boolean;
  time: number;
  speed: number;
  loop: boolean;
  compare: boolean;
  grid: boolean;
  axes: boolean;
  skeleton: boolean;
  projection: Projection;
  light: LightPreset;
  quality: Quality;
  libraryQuery: string;
  libraryFilter: LibraryFilter;
  /** when false, a finger only navigates; a pen or mouse sculpts */
  fingerSculpts: boolean;
  /** last in-editor skinning probe result (bind vs posed vertex) */
  probe: {
    mesh: string;
    vertex: number;
    bind: [number, number, number];
    posed: [number, number, number];
    moved: number;
    clip: string;
    time: number;
  } | null;
  loading: boolean;
  status: string;
  showMask: boolean;
}

export interface ExportArtifact {
  fileName: string;
  bytes: ArrayBuffer;
  report: ExportResult['report'];
  reimport: ReimportReport;
  createdAt: string;
}

const TOOL_KEYS: Record<string, BrushId> = {
  '1': 'clay',
  '2': 'draw',
  '3': 'smooth',
  '4': 'inflate',
  '5': 'crease',
  '6': 'grab',
  m: 'mask',
};

export class Studio {
  readonly state: StudioState = {
    mode: 'setup',
    tab: 'appearance',
    projectId: `project-${Date.now().toString(36)}`,
    projectName: 'Untitled character',
    dirty: false,
    tool: 'clay',
    radiusPx: 62,
    strength: 0.55,
    symmetryX: true,
    usePressure: true,
    tiltWidens: true,
    selectedBone: null,
    clip: null,
    playing: false,
    time: 0,
    speed: 1,
    loop: true,
    compare: false,
    grid: true,
    axes: true,
    skeleton: false,
    projection: 'perspective',
    light: 'studio',
    quality: 'auto',
    libraryQuery: '',
    libraryFilter: 'all',
    fingerSculpts: false,
    probe: null,
    loading: false,
    status: 'Ready',
    showMask: true,
  };

  readonly history = new History(60, 48 * 1024 * 1024, () => this.refreshHistoryUI());
  readonly store = new ProjectStore();

  viewport!: Viewport;
  character: Character | null = null;
  catalog: CatalogSummary | null = null;
  catalogFailure: string | null = null;
  examples: ExampleAsset[] = EXAMPLE_ASSETS;
  loadedCatalogAsset: CatalogAsset | null = null;
  engine: SculptEngine | null = null;
  activeRecord: MeshRecord | null = null;
  lastExport: ExportArtifact | null = null;
  lastRecipe: CharacterRecipe | null = null;
  projects: ProjectSummary[] = [];
  attachmentCompat: AttachmentCompatibility | null = null;
  clearance: ClearanceReport | null = null;
  pendingRecipe: CharacterRecipe | null = null;
  pendingCatalogAsset: CatalogAsset | null = null;
  importError: string | null = null;

  private app!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private refs: Record<string, HTMLElement> = {};
  private stroke: {
    pointerId: number;
    record: MeshRecord;
    startLocal: THREE.Vector3;
    lastLocal: THREE.Vector3;
    plane: THREE.Plane;
    planePoint: THREE.Vector3;
    pressure: number;
    radiusScale: number;
    lastDabLocal: THREE.Vector3;
  } | null = null;
  private activePointers = new Map<number, { x: number; y: number; type: string }>();
  private penDown = false;
  private lastPenAt = 0;
  private clock = performance.now();
  private maskOverlay: THREE.Points | null = null;
  private maskOverlayDirty = true;
  private lastPerfUpdate = 0;
  private playingFrame = 0;
  private saveTimer: number | null = null;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.app = document.getElementById('app') as HTMLElement;
    this.canvas = document.getElementById('viewport') as HTMLCanvasElement;
    for (const id of [
      'projectName', 'dirtyFlag', 'modeNav', 'undoBtn', 'redoBtn', 'saveBtn', 'exportBtn',
      'libraryRail', 'librarySearch', 'libraryFilters', 'libraryBody', 'importBtn', 'fileInput',
      'stage', 'characterChips', 'viewControls', 'stageNotice', 'compareBtn', 'compareLabel',
      'perfReadout', 'toolDock', 'loadingOverlay', 'loadingText', 'emptyState', 'emptyStart',
      'emptyImport', 'inspector', 'inspectorTabs', 'inspectorBody', 'statusMessage',
      'statusHistory', 'statusStore', 'statusVersion', 'toasts', 'modalRoot', 'railToggle',
      'inspectorToggle', 'railClose',
    ]) {
      const node = document.getElementById(id);
      if (node) this.refs[id] = node;
    }

    this.viewport = new Viewport(this.canvas, {
      onContextLost: () => {
        this.setStatus('<strong>WebGL context lost</strong> — edits are held in CPU memory; waiting for restore');
        this.toast('Graphics context lost', 'Your sculpt edits are still in memory. The viewport will restore automatically.', 'warn', 9000);
      },
      onContextRestored: () => {
        this.viewport.invalidate();
        this.setStatus('Graphics context restored — edits intact');
        this.toast('Viewport restored', 'The WebGL context came back with all edits preserved.', 'info', 5000);
      },
    });

    this.bindTopbar();
    this.bindLibrary();
    this.bindViewControls();
    this.bindInspectorTabs();
    this.bindDock();
    this.bindPointerInput();
    this.bindKeyboard();
    this.bindEmptyState();

    const mode = await this.store.open();
    this.refs.statusStore.textContent = mode === 'indexeddb' ? 'Projects: IndexedDB' : 'Projects: memory only';
    if (this.store.lastError) this.toast('Local storage limited', this.store.lastError, 'warn', 8000);
    await this.refreshProjects();

    this.catalog = await loadCatalog();
    if (!this.catalog) {
      this.catalogFailure = 'Catalog metadata could not be loaded (public/catalog/humanoid-summary.json).';
    }
    this.refreshAll();
    this.startLoop();

    // Start on the reproducible fixture so the app is immediately usable.
    await this.loadExample('foundry-humanoid', { silent: true });
  }

  // ---------------------------------------------------------------- rendering

  refreshAll(): void {
    renderChips(this);
    renderViewControls(this);
    renderToolDock(this);
    renderInspector(this);
    renderLibrary(this);
    this.refreshHistoryUI();
    this.refreshModeUI();
    this.refreshProjectMeta();
  }

  refreshPanel(): void {
    renderInspector(this);
    renderChips(this);
  }

  refreshModeUI(): void {
    this.app.dataset.mode = this.state.mode;
    for (const button of this.refs.modeNav.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
      button.setAttribute('aria-selected', String(button.dataset.mode === this.state.mode));
    }
    const dock = this.refs.toolDock;
    dock.hidden = this.state.mode !== 'sculpt';
    this.refs.emptyState.hidden = !!this.character;
    (this.refs.compareBtn as HTMLButtonElement).disabled = !this.character;
    this.refs.compareBtn.setAttribute('aria-pressed', String(this.state.compare));
    this.refs.compareLabel.textContent = this.state.compare ? 'Showing source' : 'Before';
  }

  refreshHistoryUI(): void {
    const undo = this.refs.undoBtn as HTMLButtonElement;
    const redo = this.refs.redoBtn as HTMLButtonElement;
    if (!undo) return;
    undo.disabled = !this.history.canUndo;
    redo.disabled = !this.history.canRedo;
    undo.title = this.history.undoLabel ? `Undo ${this.history.undoLabel} (Ctrl+Z)` : 'Nothing to undo';
    redo.title = this.history.redoLabel ? `Redo ${this.history.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo';
    this.refs.statusHistory.textContent = this.history.size
      ? `${this.history.size} step${this.history.size === 1 ? '' : 's'} · ${formatBytes(this.history.byteWeight)}`
      : 'No history';
  }

  refreshProjectMeta(): void {
    const input = this.refs.projectName as HTMLInputElement | undefined;
    if (input && input.value !== this.state.projectName) input.value = this.state.projectName;
    this.refs.dirtyFlag.hidden = !this.state.dirty;
    document.title = `${this.state.projectName} — DEX//SCULPT`;
  }

  setStatus(html: string): void {
    this.state.status = html;
    this.refs.statusMessage.innerHTML = html;
  }

  toast(title: string, body: string, kind: 'info' | 'warn' | 'fail' = 'info', ttl = 6000): void {
    const node = document.createElement('div');
    node.className = `toast toast--${kind === 'info' ? 'info' : kind}`;
    const strong = document.createElement('strong');
    strong.textContent = title;
    node.append(strong, document.createTextNode(body));
    this.refs.toasts.append(node);
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transition = 'opacity 200ms ease';
      setTimeout(() => node.remove(), 260);
    }, ttl);
  }

  setNotice(message: string | null, kind: 'warn' | 'info' = 'warn'): void {
    const node = this.refs.stageNotice;
    if (!message) {
      node.hidden = true;
      node.innerHTML = '';
      return;
    }
    node.hidden = false;
    node.style.borderColor = kind === 'info' ? 'var(--accent-line)' : 'var(--warn)';
    node.innerHTML = message;
  }

  private async withLoading<T>(label: string, task: () => Promise<T>): Promise<T | null> {
    this.state.loading = true;
    this.refs.loadingText.textContent = label;
    this.refs.loadingOverlay.hidden = false;
    this.setStatus(label);
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 16)));
    try {
      return await task();
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      this.toast('Something went wrong', message, 'fail', 9000);
      this.setStatus(`<strong>Error</strong> — ${escapeHtml(message)}`);
      return null;
    } finally {
      this.state.loading = false;
      this.refs.loadingOverlay.hidden = true;
    }
  }

  // ------------------------------------------------------------- character io

  async loadExample(id: string, options: { silent?: boolean } = {}): Promise<void> {
    const example = getExample(id);
    if (!example) return;
    await this.withLoading(`Generating ${example.name}…`, async () => {
      const started = performance.now();
      const bytes = await example.build();
      const character = await loadCharacter(bytes, {
        sourceKind: 'example',
        fixtureId: example.id,
        fileName: `${example.id}.glb`,
        license: example.license,
        skeletonFamily: example.skeletonFamily,
        provenance: 'Generated procedurally in the browser by DEX//SCULPT, then serialised to GLB',
      });
      this.setCharacter(character);
      this.loadedCatalogAsset = null;
      this.state.projectName = example.name;
      this.state.projectId = `project-${Date.now().toString(36)}`;
      this.refreshProjectMeta();
      const ms = Math.round(performance.now() - started);
      this.setStatus(`<strong>${example.name}</strong> loaded in ${ms} ms · ${character.countStats().vertices.toLocaleString()} verts · ${character.countStats().bones} bones`);
      if (!options.silent) this.toast('Example loaded', `${example.name} was generated, exported to GLB and re-imported (${ms} ms).`, 'info', 5000);
    });
    this.refreshAll();
  }

  async importFile(file: File): Promise<void> {
    if (!file) return;
    if (/\.json$/i.test(file.name)) {
      await this.importRecipeFile(file);
      return;
    }
    this.importError = null;
    const result = await this.withLoading(`Importing ${file.name}…`, async () => {
      const bytes = await file.arrayBuffer();
      const asset = this.pendingCatalogAsset;
      const character = await loadCharacter(
        bytes,
        {
          sourceKind: 'import',
          fileName: file.name,
          catalogId: asset?.id,
          skeletonFamily: asset?.family ?? undefined,
          license: asset?.license ?? 'User-supplied file — verify its licence before redistributing exports.',
          provenance: asset ? `Relinked to catalog record ${asset.id}` : 'Local file import',
        },
        (message) => {
          this.refs.loadingText.textContent = message;
        },
      );
      this.setCharacter(character);
      this.loadedCatalogAsset = asset;
      this.state.projectName = asset ? asset.name : file.name.replace(/\.glb$/i, '');
      this.state.projectId = `project-${Date.now().toString(36)}`;
      this.refreshProjectMeta();
      return { character, asset };
    });
    if (result) {
      const { character, asset } = result;
      if (asset) {
        this.toast('Catalog record relinked', `${asset.name} now points at ${file.name}. The binary stays on your device.`, 'info', 7000);
      }
      const recordedFamily = character.meta.skeletonFamily;
      if (asset && recordedFamily && asset.family && recordedFamily !== asset.family) {
        this.toast('Skeleton mismatch', `The catalog says ${asset.family}; the loaded file reports ${recordedFamily}. Compatibility warnings will follow the file.`, 'warn', 8000);
      }
      this.pendingCatalogAsset = null;
      if (this.pendingRecipe) {
        await this.applyPendingRecipe();
      }
      this.setStatus(`<strong>${file.name}</strong> imported · ${character.countStats().vertices.toLocaleString()} verts · ${character.countStats().bones} bones · ${character.countStats().clips} clips`);
      this.refreshAll();
    }
  }

  setCharacter(character: Character): void {
    if (this.engine) {
      this.engine.cancel();
      this.engine = null;
    }
    this.stroke = null;
    if (this.character) {
      this.viewport.setCharacter(null);
      this.character.dispose();
    }
    this.character = character;
    this.history.clear();
    this.viewport.setCharacter(character);
    this.viewport.setSkeletonVisible(false);
    this.state.skeleton = false;
    this.state.compare = false;
    this.state.selectedBone = character.bones.find((b) => /hips|pelvis|root/i.test(b.name))?.name ?? character.bones[0]?.name ?? null;
    this.state.clip = character.clips[0]?.name ?? null;
    this.state.playing = false;
    this.state.time = 0;
    this.state.dirty = false;
    this.lastExport = null;
    this.lastRecipe = null;
    this.attachmentCompat = null;
    this.clearance = null;
    this.state.probe = null;
    this.morphDrafts.clear();
    this.materialDrafts.clear();
    character.bindPose();
    this.viewport.setSelectedBone(this.state.selectedBone);
    this.maskOverlayDirty = true;
    this.refreshMaskOverlay();
    this.viewport.invalidate();
    this.setNotice(this.capabilityNotice());
    if (this.state.mode === 'sculpt') this.enterSculptMode();
    this.refreshAll();
  }

  private capabilityNotice(): string | null {
    const character = this.character;
    if (!character) return null;
    const stats = character.countStats();
    if (!stats.bones) {
      return 'This file has <strong>no skeleton</strong>. Sculpting and export work; appearance morphs, rig inspection and animation are disabled with an explanation in each panel.';
    }
    if (!stats.clips) {
      return 'This file has a skeleton but <strong>no animation clips</strong>. Rig inspection works; timeline playback is unavailable.';
    }
    return null;
  }

  unloadCharacter(): void {
    if (!this.character) return;
    this.engine?.cancel();
    this.engine = null;
    this.viewport.setCharacter(null);
    this.character.dispose();
    this.character = null;
    this.stroke = null;
    this.history.clear();
    this.removeMaskOverlay();
    this.state.projectName = 'Untitled character';
    this.state.projectId = `project-${Date.now().toString(36)}`;
    this.state.dirty = false;
    this.refreshProjectMeta();
    this.setNotice(null);
    this.setStatus('Workspace cleared');
    this.refreshAll();
  }

  // ---------------------------------------------------------------- modes/tabs

  setMode(mode: Mode): void {
    if (this.state.mode === mode) return;
    this.state.mode = mode;
    this.engine?.cancel();
    this.stroke = null;
    this.viewport.hideCursor();
    if (mode === 'sculpt') {
      this.enterSculptMode();
    } else if (mode === 'animate') {
      this.state.playing = false;
      if (this.character) {
        if (!this.character.clips.length) {
          this.toast('No animation clips', 'This character has no AnimationClips, so the timeline stays idle. Rig inspection is still available.', 'warn', 7000);
        } else if (this.state.clip) {
          this.character.playClip(this.state.clip);
          this.character.setClipTime(this.state.time);
        }
      }
      this.refreshModeUI();
    } else {
      this.state.playing = false;
      this.character?.bindPose();
      this.state.time = 0;
      this.refreshModeUI();
    }
    this.refreshAll();
  }

  private enterSculptMode(): void {
    const character = this.character;
    if (!character) return;
    this.state.playing = false;
    character.bindPose();
    character.setClipTime(0);
    this.state.time = 0;
    this.setNotice(
      character.countStats().skinnedMeshes
        ? 'Sculpting edits <strong>bind-pose vertex positions only</strong>. Skin weights, joints, inverse bind matrices, morph targets and clips are preserved.'
        : 'Sculpting changes <strong>vertex positions only</strong>. No rig data is modified.',
      'info',
    );
    this.refreshModeUI();
  }

  setTab(tab: Tab): void {
    this.state.tab = tab;
    if (tab === 'rig' || tab === 'animate') {
      if (this.character?.bones.length && !this.viewport.skeletonVisible()) {
        this.viewport.setSkeletonVisible(true);
        this.state.skeleton = true;
      }
    }
    renderInspector(this);
    renderViewControls(this);
    for (const button of this.refs.inspectorTabs.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      button.setAttribute('aria-selected', String(button.dataset.tab === tab));
    }
    if (window.innerWidth <= 980) this.app.dataset.inspector = 'open';
  }

  private bindInspectorTabs(): void {
    this.refs.inspectorTabs.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]');
      if (target) this.setTab(target.dataset.tab as Tab);
    });
    for (const button of this.refs.inspectorTabs.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      button.setAttribute('aria-selected', String(button.dataset.tab === this.state.tab));
    }
  }

  // ------------------------------------------------------------------- wiring

  private bindTopbar(): void {
    this.refs.modeNav.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-mode]');
      if (target) this.setMode(target.dataset.mode as Mode);
    });
    this.refs.undoBtn.addEventListener('click', () => this.undo());
    this.refs.redoBtn.addEventListener('click', () => this.redo());
    this.refs.saveBtn.addEventListener('click', () => void this.saveProject());
    document.getElementById('exportBtn')!.addEventListener('click', () => void this.exportAndVerify());
    const projectName = this.refs.projectName as HTMLInputElement;
    projectName.addEventListener('input', () => {
      this.state.projectName = projectName.value || 'Untitled character';
      this.state.dirty = true;
      this.refreshProjectMeta();
    });
    projectName.addEventListener('change', () => this.scheduleAutosave());
    (this.refs.compareBtn as HTMLButtonElement).addEventListener('click', () => {
      this.setCompare(!this.state.compare);
    });
    this.refs.railToggle.addEventListener('click', () => {
      this.app.dataset.rail = this.app.dataset.rail === 'open' ? '' : 'open';
    });
    this.refs.inspectorToggle.addEventListener('click', () => {
      this.app.dataset.inspector = this.app.dataset.inspector === 'open' ? '' : 'open';
    });
    this.refs.railClose.addEventListener('click', () => {
      this.app.dataset.rail = '';
    });
  }

  private bindLibrary(): void {
    const search = this.refs.librarySearch as HTMLInputElement;
    search.addEventListener('input', () => {
      this.state.libraryQuery = search.value;
      renderLibrary(this);
    });
    this.refs.libraryFilters.addEventListener('click', (event) => {
      const chip = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-filter]');
      if (!chip) return;
      this.state.libraryFilter = chip.dataset.filter as LibraryFilter;
      renderLibrary(this);
    });
    const importBtn = this.refs.importBtn as HTMLButtonElement;
    const fileInput = this.refs.fileInput as HTMLInputElement;
    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) void this.importFile(file);
      fileInput.value = '';
    });
    this.refs.libraryBody.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!item) return;
      const action = item.dataset.action;
      if (action === 'example') {
        void this.loadExample(item.dataset.id!);
      } else if (action === 'catalog') {
        this.openCatalogAsset(item.dataset.id!);
      } else if (action === 'relink') {
        const asset = this.catalog?.assets.find((a) => a.id === item.dataset.id);
        if (asset) this.relinkCatalogAsset(asset);
      }
    });
  }

  private bindViewControls(): void {
    this.refs.viewControls.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-view]');
      if (!button) return;
      const view = button.dataset.view!;
      switch (view) {
        case 'front':
        case 'side':
        case 'back':
        case 'top':
          this.viewport.setViewPreset(view as ViewPreset);
          break;
        case 'frame':
          this.viewport.frameCharacter();
          break;
        case 'reset':
          this.viewport.frameCharacter();
          this.viewport.setViewPreset('three-quarter');
          break;
        case 'projection':
          this.setProjection(this.state.projection === 'perspective' ? 'ortho' : 'perspective');
          break;
        case 'grid':
          this.state.grid = !this.state.grid;
          this.viewport.setGridVisible(this.state.grid);
          break;
        case 'axes':
          this.state.axes = !this.state.axes;
          this.viewport.setAxesVisible(this.state.axes);
          break;
        case 'skeleton':
          this.toggleSkeleton();
          break;
        case 'light': {
          const order: LightPreset[] = ['studio', 'clay', 'dramatic'];
          const next = order[(order.indexOf(this.state.light) + 1) % order.length];
          this.state.light = next;
          this.viewport.setLightPreset(next);
          this.setStatus(`Lighting preset: <strong>${next}</strong>`);
          break;
        }
      }
      renderViewControls(this);
    });
  }

  private bindDock(): void {
    const dock = this.refs.toolDock;
    dock.addEventListener('click', (event) => {
      const tool = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tool]');
      if (tool && tool.dataset.tool) {
        this.setTool(tool.dataset.tool as BrushId);
        return;
      }
      const toggle = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-toggle]');
      if (!toggle) return;
      if (toggle.dataset.toggle === 'symmetry') {
        this.state.symmetryX = !this.state.symmetryX;
        this.setStatus(`Mirror symmetry <strong>${this.state.symmetryX ? 'on' : 'off'}</strong>`);
      } else if (toggle.dataset.toggle === 'pressure') {
        this.state.usePressure = !this.state.usePressure;
        this.setStatus(`Pen pressure <strong>${this.state.usePressure ? 'on' : 'off'}</strong>`);
      } else if (toggle.dataset.toggle === 'maskview') {
        this.state.showMask = !this.state.showMask;
        this.refreshMaskOverlay();
      } else if (toggle.dataset.toggle === 'finger') {
        this.state.fingerSculpts = !this.state.fingerSculpts;
        this.setStatus(
          this.state.fingerSculpts
            ? 'Finger sculpting <strong>on</strong> — two-finger gestures still pan and zoom'
            : 'Finger sculpting <strong>off</strong> — fingers orbit, pan and zoom only',
        );
      }
      renderToolDock(this);
    });
    dock.addEventListener('input', (event) => {
      const input = event.target as HTMLInputElement;
      if (input.dataset.setting === 'radius') {
        this.state.radiusPx = Number(input.value);
        this.updateCursorFromLastHit();
      } else if (input.dataset.setting === 'strength') {
        this.state.strength = Number(input.value);
      }
    });
  }

  private bindEmptyState(): void {
    document.getElementById('emptyStart')!.addEventListener('click', () => void this.loadExample('foundry-humanoid'));
    document.getElementById('emptyImport')!.addEventListener('click', () => (this.refs.fileInput as HTMLInputElement).click());
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (meta && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        this.redo();
        return;
      }
      if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void this.saveProject();
        return;
      }
      if (event.key === 'Escape') {
        if (this.stroke) this.cancelStroke();
        closeModal();
        return;
      }
      const key = event.key.toLowerCase();
      if (TOOL_KEYS[key] && this.state.mode === 'sculpt') {
        this.setTool(TOOL_KEYS[key]);
        event.preventDefault();
        return;
      }
      switch (key) {
        case '[':
          this.state.radiusPx = clamp(this.state.radiusPx - 6, 6, 260);
          renderToolDock(this);
          break;
        case ']':
          this.state.radiusPx = clamp(this.state.radiusPx + 6, 6, 260);
          renderToolDock(this);
          break;
        case 'f':
          this.viewport.frameCharacter();
          break;
        case 'r':
          this.viewport.setViewPreset('three-quarter');
          break;
        case 'g':
          this.state.grid = !this.state.grid;
          this.viewport.setGridVisible(this.state.grid);
          renderViewControls(this);
          break;
        case 'x':
          this.state.symmetryX = !this.state.symmetryX;
          renderToolDock(this);
          break;
        case 'p':
          this.setProjection(this.state.projection === 'perspective' ? 'ortho' : 'perspective');
          renderViewControls(this);
          break;
        case 'b':
          if (!event.repeat) this.setCompare(true);
          break;
        case ' ':
          event.preventDefault();
          if (this.state.mode === 'animate') this.togglePlayback();
          break;
        default:
          break;
      }
    });
    window.addEventListener('keyup', (event) => {
      if (event.key.toLowerCase() === 'b') this.setCompare(false);
    });
  }

  setProjection(projection: Projection): void {
    this.state.projection = projection;
    this.viewport.setProjection(projection);
    this.setStatus(`Camera: <strong>${projection === 'ortho' ? 'orthographic' : 'perspective'}</strong>`);
  }

  toggleSkeleton(): void {
    if (!this.character?.bones.length) {
      this.toast('No skeleton', 'This character has no bones to display.', 'warn');
      return;
    }
    const next = !this.viewport.skeletonVisible();
    this.viewport.setSkeletonVisible(next);
    this.state.skeleton = next;
    renderViewControls(this);
  }

  setCompare(on: boolean): void {
    if (!this.character || this.state.compare === on) return;
    this.state.compare = on;
    this.character.setSourcePreview(on);
    this.viewport.invalidate();
    this.updateCursorFromLastHit();
    this.refreshModeUI();
    this.setStatus(on ? 'Previewing <strong>source geometry</strong> (edits preserved)' : 'Showing <strong>edited geometry</strong>');
  }

  setTool(tool: BrushId): void {
    this.state.tool = tool;
    for (const button of this.refs.toolDock.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
      button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
    }
    const info = BRUSHES.find((b) => b.id === tool);
    if (info) this.setStatus(`<strong>${info.label}</strong> — ${info.hint}`);
    renderToolDock(this);
  }

  // ------------------------------------------------------------------ sculpt

  private bindPointerInput(): void {
    const stage = this.refs.stage;
    stage.addEventListener('contextmenu', (event) => event.preventDefault());
    // Capture phase on the stage runs *before* OrbitControls' canvas listeners,
    // so a sculpt stroke can claim the pointer without the camera orbiting
    // underneath it. Move/up listen on window so a stroke survives leaving the
    // canvas while the pointer is captured.
    stage.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    window.addEventListener('pointermove', this.onPointerMove, { capture: true });
    window.addEventListener('pointerup', this.onPointerUp, { capture: true });
    window.addEventListener('pointercancel', this.onPointerCancel, { capture: true });
    stage.addEventListener('pointerleave', () => {
      if (!this.stroke) this.viewport.hideCursor();
    });
  }

  private isPen(event: PointerEvent): boolean {
    return event.pointerType === 'pen';
  }

  private penRecentlyActive(): boolean {
    return this.penDown || performance.now() - this.lastPenAt < 320;
  }

  /** Fingers navigate by default; a pen or mouse sculpts. The dock can opt in. */
  private pointerSculpts(event: PointerEvent): boolean {
    if (event.pointerType === 'touch') return this.state.fingerSculpts;
    return event.pointerType === 'pen' || event.pointerType === 'mouse' || event.pointerType === '';
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType });
    if (this.isPen(event)) {
      this.penDown = true;
      this.lastPenAt = performance.now();
    }
    if (event.pointerType === 'touch') {
      // Palm rejection: any touch while the pen is down or hovering is ignored.
      if (this.penRecentlyActive()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (this.activePointers.size > 1) {
        // A second finger always means navigation, never sculpting.
        this.cancelStroke();
        this.viewport.setPausedNavigation(false);
        return;
      }
    }
    if (this.state.mode !== 'sculpt' || this.state.compare) return;
    if (event.button !== 0) return;
    if (event.altKey) return; // Alt-drag stays with the camera in every mode
    if (!this.character) return;
    if (!this.pointerSculpts(event)) return;
    const hit = this.viewport.pick(event.clientX, event.clientY);
    if (!hit) return;
    const record = this.character.meshes.find((m) => m.mesh === hit.mesh);
    if (!record) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture is best-effort */
    }
    this.beginStroke(event, record, hit);
  };

  private beginStroke(event: PointerEvent, record: MeshRecord, hit: PickHit): void {
    const character = this.character!;
    const tool = this.state.tool;
    const pressure = this.effectivePressure(event);
    const radiusScale = this.effectiveRadiusScale(event);
    const radiusLocal = this.radiusInLocal(record, hit.world, radiusScale);
    const planeNormal = new THREE.Vector3();
    this.viewport.activeCamera.getWorldDirection(planeNormal);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal.clone().negate(), hit.world);
    const settings: StrokeSettings = {
      tool,
      radius: radiusLocal,
      strength: this.state.strength,
      symmetry: { x: this.state.symmetryX },
      invert: event.shiftKey || event.buttons === 2,
      pressure,
    };
    const strokeHit: StrokeHit = {
      point: [hit.local.x, hit.local.y, hit.local.z],
      normal: [hit.localNormal.x, hit.localNormal.y, hit.localNormal.z],
      viewDir: [planeNormal.x, planeNormal.y, planeNormal.z],
      mirrorPlane: this.mirrorPlaneFor(record),
    };
    this.engine = new SculptEngine(character.getTarget(record));
    this.engine.begin(tool, settings, strokeHit);
    this.activeRecord = record;
    this.stroke = {
      pointerId: event.pointerId,
      record,
      startLocal: hit.local.clone(),
      lastLocal: hit.local.clone(),
      plane,
      planePoint: hit.world.clone(),
      pressure,
      radiusScale,
      lastDabLocal: hit.local.clone(),
    };
    this.viewport.setPausedNavigation(true);
    this.viewport.setCursorInvert(settings.invert);
    this.viewport.updateCursor(hit, this.radiusInWorld(record, radiusLocal));
    this.setStatus(`<strong>${BRUSHES.find((b) => b.id === tool)?.label}</strong> stroke · radius ${(radiusLocal * 1000).toFixed(0)} mm`);
  }

  private onPointerMove = (event: PointerEvent): void => {
    const existing = this.activePointers.get(event.pointerId);
    if (existing) {
      existing.x = event.clientX;
      existing.y = event.clientY;
    }
    if (this.isPen(event)) this.lastPenAt = performance.now();
    if (!this.character) return;

    if (this.stroke && event.pointerId === this.stroke.pointerId) {
      this.continueStroke(event);
      return;
    }
    if (this.state.mode !== 'sculpt' || this.state.compare) {
      this.viewport.hideCursor();
      return;
    }
    if (event.target !== this.canvas) return;
    if (event.pointerType === 'touch') {
      // Finger gestures belong to OrbitControls; no brush cursor.
      this.viewport.hideCursor();
      return;
    }
    const hit = this.viewport.pick(event.clientX, event.clientY);
    if (!hit) {
      this.viewport.hideCursor();
      this.lastHit = null;
      return;
    }
    const record = this.character.meshes.find((m) => m.mesh === hit.mesh);
    if (!record) {
      this.viewport.hideCursor();
      this.lastHit = null;
      return;
    }
    this.lastHit = { hit, event };
    const radiusLocal = this.radiusInLocal(record, hit.world, this.effectiveRadiusScale(event));
    this.viewport.updateCursor(hit, this.radiusInWorld(record, radiusLocal));
    this.viewport.setCursorInvert(event.shiftKey || event.buttons === 2);
  };

  private lastHit: { hit: ReturnType<Viewport['pick']>; event: PointerEvent } | null = null;

  updateCursorFromLastHit(): void {
    if (!this.lastHit || !this.character) return;
    const record = this.character.meshes.find((m) => m.mesh === this.lastHit!.hit?.mesh);
    if (!record || !this.lastHit.hit) return;
    const radiusLocal = this.radiusInLocal(record, this.lastHit.hit.world, this.effectiveRadiusScale(this.lastHit.event));
    this.viewport.updateCursor(this.lastHit.hit, this.radiusInWorld(record, radiusLocal));
  }

  private continueStroke(event: PointerEvent): void {
    const stroke = this.stroke;
    const record = this.activeRecord;
    const engine = this.engine;
    if (!stroke || !record || !engine) return;
    event.preventDefault();
    const tool = this.state.tool;
    const hit = this.viewport.pick(event.clientX, event.clientY);
    const radiusLocal = this.radiusInLocal(record, stroke.planePoint, stroke.radiusScale);
    const pressure = this.effectivePressure(event);
    const invert = event.shiftKey || event.buttons === 2;

    if (tool === 'grab') {
      const ray = this.rayFromEvent(event);
      const point = new THREE.Vector3();
      if (!ray.intersectPlane(stroke.plane, point)) return;
      const local = record.mesh.worldToLocal(point.clone());
      const delta = local.clone().sub(stroke.lastLocal);
      if (delta.lengthSq() > 0) engine.drag([delta.x, delta.y, delta.z]);
      stroke.lastLocal.copy(local);
      this.viewport.updateCursor(
        hit ?? {
          mesh: record.mesh,
          world: point,
          local,
          worldNormal: new THREE.Vector3(0, 1, 0),
          localNormal: new THREE.Vector3(0, 1, 0),
          distance: 0,
          faceIndex: undefined,
        },
        this.radiusInWorld(record, radiusLocal),
      );
      this.viewport.invalidate();
      return;
    }

    if (!hit) return;
    const local = hit.local.clone();
    // Space dabs along the stroke so fast pointer movement does not leave gaps.
    const spacing = Math.max(radiusLocal * 0.18, 1e-4);
    const distance = local.distanceTo(stroke.lastDabLocal);
    const steps = Math.min(24, Math.max(1, Math.floor(distance / spacing)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const point = stroke.lastDabLocal.clone().lerp(local, t);
      engine.dab([point.x, point.y, point.z], pressure, invert);
    }
    if (steps > 0) stroke.lastDabLocal.copy(local);
    stroke.lastLocal.copy(local);
    this.viewport.updateCursor(hit, this.radiusInWorld(record, radiusLocal));
    this.viewport.setCursorInvert(invert);
    this.viewport.invalidate();
  }

  private onPointerUp = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId);
    if (this.isPen(event)) {
      this.penDown = false;
      this.lastPenAt = performance.now();
    }
    if (this.stroke && event.pointerId === this.stroke.pointerId) {
      if (event.type === 'pointercancel') this.cancelStroke();
      else this.finishStroke();
    }
    if (this.activePointers.size === 0) this.viewport.setPausedNavigation(false);
  };

  private onPointerCancel = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId);
    if (this.isPen(event)) this.penDown = false;
    if (this.stroke && event.pointerId === this.stroke.pointerId) this.cancelStroke();
    if (this.activePointers.size === 0) this.viewport.setPausedNavigation(false);
  };

  private finishStroke(): void {
    const engine = this.engine;
    const record = this.activeRecord;
    this.stroke = null;
    if (!engine || !record) return;
    const result = engine.end();
    this.viewport.setPausedNavigation(false);
    this.viewport.setCursorInvert(false);
    if (result) {
      const character = this.character!;
      const apply = (values: Float32Array) => {
        const weld = record.weld;
        for (let i = 0; i < result.changedGroups.length; i++) {
          const g = result.changedGroups[i];
          if (result.maskChanges) {
            const value = values[i * 3];
            for (let k = weld.groupStart[g]; k < weld.groupStart[g + 1]; k++) record.mask[weld.groupList[k]] = value;
          } else {
            for (let k = weld.groupStart[g]; k < weld.groupStart[g + 1]; k++) {
              const v = weld.groupList[k];
              record.delta[v * 3] = values[i * 3];
              record.delta[v * 3 + 1] = values[i * 3 + 1];
              record.delta[v * 3 + 2] = values[i * 3 + 2];
            }
          }
        }
        const groups = result.changedGroups;
        character.commitGroups(record, groups, groups.length);
        record.spatial.rebuild();
        character.flushNormals(record);
        this.maskOverlayDirty = true;
        this.refreshMaskOverlay();
        this.viewport.invalidate();
        this.state.dirty = true;
        this.scheduleAutosave();
        this.refreshProjectMeta();
      };
      this.history.push({
        label: `${result.label} stroke`,
        bytes: result.bytes,
        undo: () => apply(result.before),
        redo: () => apply(result.after),
      });
      const moved = engine.getDeltaStats().maxDelta;
      this.setStatus(
        `<strong>${result.label}</strong> stroke · ${result.changedGroups.length} groups · max Δ ${(moved * 1000).toFixed(2)} mm · rig untouched`,
      );
    }
    this.engine = null;
    this.activeRecord = null;
    this.refreshPanel();
  }

  private cancelStroke(): void {
    if (!this.stroke) return;
    this.engine?.cancel();
    this.engine = null;
    this.activeRecord = null;
    this.stroke = null;
    this.viewport.setPausedNavigation(false);
    this.setStatus('Stroke cancelled — geometry restored exactly');
    this.viewport.invalidate();
  }

  private rayFromEvent(event: PointerEvent): THREE.Ray {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.viewport.activeCamera);
    return raycaster.ray.clone();
  }

  private effectivePressure(event: PointerEvent): number {
    if (!this.state.usePressure) return 1;
    if (event.pointerType !== 'pen') return 1;
    const pressure = Number.isFinite(event.pressure) && event.pressure > 0 ? event.pressure : 0.5;
    return clamp(pressure, 0.08, 1);
  }

  private effectiveRadiusScale(event: PointerEvent): number {
    if (!this.state.tiltWidens || event.pointerType !== 'pen') return 1;
    const tiltX = event.tiltX ?? 0;
    const tiltY = event.tiltY ?? 0;
    const tilt = (Math.atan(Math.sqrt(Math.tan((tiltX * Math.PI) / 180) ** 2 + Math.tan((tiltY * Math.PI) / 180) ** 2)) * 180) / Math.PI;
    return 1 + 0.5 * clamp(tilt / 60, 0, 1);
  }

  private radiusInLocal(record: MeshRecord, worldPoint: THREE.Vector3, scale: number): number {
    const worldRadius = this.viewport.worldPerPixel(worldPoint) * this.state.radiusPx * scale;
    return worldRadius / this.viewport.objectScale(record.mesh);
  }

  private radiusInWorld(record: MeshRecord, radiusLocal: number): number {
    return radiusLocal * this.viewport.objectScale(record.mesh);
  }

  private mirrorPlaneFor(record: MeshRecord): { origin: [number, number, number]; axis: [number, number, number] } | undefined {
    if (!this.state.symmetryX || !this.character) return undefined;
    const root = this.character.root;
    root.updateMatrixWorld(true);
    const originWorld = new THREE.Vector3().setFromMatrixPosition(root.matrixWorld);
    const axisWorld = new THREE.Vector3(1, 0, 0).transformDirection(root.matrixWorld).normalize();
    const origin = record.mesh.worldToLocal(originWorld.clone());
    const normalMatrix = new THREE.Matrix3().setFromMatrix4(record.mesh.matrixWorld).invert();
    const axis = axisWorld.clone().applyMatrix3(normalMatrix).normalize();
    return {
      origin: [origin.x, origin.y, origin.z],
      axis: [axis.x, axis.y, axis.z],
    };
  }

  // ------------------------------------------------------------- mask overlay

  private refreshMaskOverlay(): void {
    if (!this.maskOverlayDirty) return;
    this.maskOverlayDirty = false;
    if (!this.character || !this.state.showMask) {
      this.removeMaskOverlay();
      return;
    }
    const points: number[] = [];
    for (const record of this.character.meshes) {
      const weld = record.weld;
      const pos = record.positionAttr.array as Float32Array;
      const step = Math.max(1, Math.floor(weld.groupCount / 12000));
      for (let g = 0; g < weld.groupCount; g += step) {
        const rep = weld.groupList[weld.groupStart[g]];
        if (record.mask[rep] <= 0.02) continue;
        points.push(pos[rep * 3], pos[rep * 3 + 1], pos[rep * 3 + 2]);
        if (points.length > 12000 * 3) break;
      }
    }
    if (!points.length) {
      this.removeMaskOverlay();
      return;
    }
    if (!this.maskOverlay) {
      const geometry = new THREE.BufferGeometry();
      const material = new THREE.PointsMaterial({
        color: 0xffcc66,
        size: 7,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.85,
        depthTest: true,
      });
      this.maskOverlay = new THREE.Points(geometry, material);
      this.maskOverlay.frustumCulled = false;
      this.maskOverlay.renderOrder = 950;
      this.viewport.scene.add(this.maskOverlay);
    }
    const attribute = new THREE.Float32BufferAttribute(points, 3);
    this.maskOverlay.geometry.setAttribute('position', attribute);
    this.maskOverlay.geometry.computeBoundingSphere();
    this.viewport.invalidate();
  }

  private removeMaskOverlay(): void {
    if (!this.maskOverlay) return;
    this.viewport.scene.remove(this.maskOverlay);
    this.maskOverlay.geometry.dispose();
    (this.maskOverlay.material as THREE.Material).dispose();
    this.maskOverlay = null;
    this.viewport.invalidate();
  }

  // ---------------------------------------------------------------- appearance

  /** Slider edits remember the pre-drag value so one gesture is one undo step. */
  private morphDrafts = new Map<string, number>();
  private materialDrafts = new Map<string, { colorHex: string; metalness: number; roughness: number }>();

  setMorphWeight(record: MeshRecord, target: string, value: number, commit = false): void {
    const character = this.character;
    if (!character) return;
    const key = `morph:${record.id}:${target}`;
    if (!this.morphDrafts.has(key)) this.morphDrafts.set(key, character.getMorphWeight(record, target));
    character.setMorphWeight(record, target, value);
    this.state.dirty = true;
    this.viewport.invalidate();
    if (commit) {
      const before = this.morphDrafts.get(key) ?? 0;
      this.morphDrafts.delete(key);
      const command = {
        label: `Morph ${target}`,
        bytes: 64,
        key,
        value,
        undo: () => character.setMorphWeight(record, target, before),
        redo: () => character.setMorphWeight(record, target, command.value),
        merge: (next: Command) => {
          command.value = (next as unknown as { value: number }).value;
        },
      };
      this.history.push(command);
      this.scheduleAutosave();
    }
    this.refreshProjectMeta();
  }

  resetMorph(record: MeshRecord, target: string): void {
    this.morphDrafts.clear();
    this.setMorphWeight(record, target, 0, true);
    this.refreshPanel();
  }

  setMaterial(slot: MaterialSlot, patch: { colorHex?: string; metalness?: number; roughness?: number }, commit = false): void {
    const character = this.character;
    if (!character) return;
    const key = `material:${slot.name}`;
    if (!this.materialDrafts.has(key)) {
      this.materialDrafts.set(key, { colorHex: slot.colorHex, metalness: slot.metalness, roughness: slot.roughness });
    }
    character.setMaterialOverride(slot, patch);
    this.state.dirty = true;
    this.viewport.invalidate();
    if (commit) {
      const before = this.materialDrafts.get(key) ?? { colorHex: slot.colorHex, metalness: slot.metalness, roughness: slot.roughness };
      this.materialDrafts.delete(key);
      const command = {
        label: `Material ${slot.name}`,
        bytes: 96,
        key,
        patch: { ...patch },
        undo: () => character.setMaterialOverride(slot, before),
        redo: () => character.setMaterialOverride(slot, command.patch),
        merge: (next: Command) => {
          Object.assign(command.patch, (next as unknown as { patch: Record<string, number | string> }).patch);
        },
      };
      this.history.push(command);
      this.scheduleAutosave();
    }
    this.refreshProjectMeta();
  }

  resetMaterial(slot: MaterialSlot): void {
    const character = this.character;
    if (!character) return;
    const before = { colorHex: slot.colorHex, metalness: slot.metalness, roughness: slot.roughness };
    this.materialDrafts.delete(`material:${slot.name}`);
    character.resetMaterial(slot);
    this.viewport.invalidate();
    this.history.push({
      label: `Reset material ${slot.name}`,
      bytes: 96,
      undo: () => character.setMaterialOverride(slot, before),
      redo: () => character.resetMaterial(slot),
    });
    this.state.dirty = true;
    this.scheduleAutosave();
    this.refreshProjectMeta();
    this.refreshPanel();
  }

  resetSculpt(): void {
    const character = this.character;
    if (!character) return;
    const snapshots = character.meshes.map((record) => ({
      record,
      delta: new Float32Array(record.delta),
      mask: new Float32Array(record.mask),
    }));
    character.resetAllSculpt();
    this.maskOverlayDirty = true;
    this.refreshMaskOverlay();
    this.viewport.invalidate();
    this.state.dirty = true;
    this.history.push({
      label: 'Reset sculpt',
      bytes: snapshots.reduce((acc, s) => acc + s.delta.byteLength + s.mask.byteLength, 0),
      undo: () => {
        for (const snapshot of snapshots) {
          snapshot.record.delta.set(snapshot.delta);
          snapshot.record.mask.set(snapshot.mask);
          snapshot.record.spatial.rebuild();
        }
        character.refreshSpatialIndexes();
        character.setSourcePreview(false);
        this.maskOverlayDirty = true;
        this.refreshMaskOverlay();
        this.viewport.invalidate();
      },
      redo: () => {
        character.resetAllSculpt();
        this.maskOverlayDirty = true;
        this.refreshMaskOverlay();
        this.viewport.invalidate();
      },
    });
    this.setStatus('Sculpt deltas cleared — imported geometry restored, rig untouched');
    this.refreshPanel();
  }

  clearMask(): void {
    const character = this.character;
    if (!character) return;
    const snapshots = character.meshes.map((record) => ({ record, mask: new Float32Array(record.mask) }));
    for (const record of character.meshes) record.mask.fill(0);
    this.maskOverlayDirty = true;
    this.refreshMaskOverlay();
    this.state.dirty = true;
    this.history.push({
      label: 'Clear mask',
      bytes: snapshots.reduce((acc, s) => acc + s.mask.byteLength, 0),
      undo: () => {
        for (const snapshot of snapshots) snapshot.record.mask.set(snapshot.mask);
        this.maskOverlayDirty = true;
        this.refreshMaskOverlay();
      },
      redo: () => {
        for (const record of character.meshes) record.mask.fill(0);
        this.maskOverlayDirty = true;
        this.refreshMaskOverlay();
      },
    });
    this.setStatus('Mask cleared');
    this.refreshPanel();
  }

  // ------------------------------------------------------------------- rig/anim

  playClip(name: string): void {
    if (!this.character) return;
    this.state.clip = name;
    this.state.time = 0;
    this.character.playClip(name);
    this.character.setClipTime(0);
    if (this.state.mode !== 'animate') this.setMode('animate');
    this.state.playing = true;
    this.viewport.invalidate();
    this.refreshPanel();
  }

  togglePlayback(): void {
    if (!this.character?.clips.length) return;
    if (this.state.mode !== 'animate') {
      this.setMode('animate');
      return;
    }
    this.state.playing = !this.state.playing;
    if (this.state.playing && !this.character.activeClip && this.state.clip) {
      this.character.playClip(this.state.clip);
    }
    this.setStatus(this.state.playing ? 'Playback <strong>running</strong>' : 'Playback <strong>paused</strong>');
    this.refreshPanel();
  }

  setClipTime(time: number): void {
    if (!this.character) return;
    this.state.time = time;
    this.state.playing = false;
    if (!this.character.activeClip && this.state.clip) this.character.playClip(this.state.clip);
    this.character.setClipTime(time);
    this.viewport.invalidate();
  }

  setSpeed(speed: number): void {
    this.state.speed = speed;
    this.refreshPanel();
  }

  resetBindPose(): void {
    if (!this.character) return;
    this.state.playing = false;
    this.state.time = 0;
    this.character.bindPose();
    this.character.setClipTime(0);
    this.viewport.invalidate();
    this.setStatus('Bind pose restored');
    this.refreshPanel();
  }

  selectBone(name: string): void {
    this.state.selectedBone = name;
    this.viewport.setSelectedBone(name);
    if (!this.viewport.skeletonVisible()) {
      this.viewport.setSkeletonVisible(true);
      this.state.skeleton = true;
    }
    this.refreshPanel();
    renderViewControls(this);
  }

  /**
   * In-editor skinning probe: samples one vertex in bind pose, then again
   * mid-clip with the file's own skin weights. This is the same question the
   * export re-import asks, answered without leaving the tab.
   */
  runDeformationProbe(): void {
    const character = this.character;
    if (!character) return;
    const record = character.meshes
      .filter((mesh) => mesh.skinned)
      .sort((a, b) => b.vertexCount - a.vertexCount)[0];
    if (!record) {
      this.toast('No skinned mesh', 'This character has no skin, so there is no deformation to probe.', 'warn');
      return;
    }
    const clip = character.clips.find((c) => c.name === this.state.clip) ?? character.clips[0];
    if (!clip) {
      this.toast('No clips', 'The file contains no AnimationClips to sample.', 'warn');
      return;
    }
    const mesh = record.mesh as THREE.SkinnedMesh;
    const previousTime = this.state.time;
    const previousClip = character.activeClip;
    const wasPlaying = this.state.playing;
    const wasMode = this.state.mode;

    character.bindPose();
    character.root.updateMatrixWorld(true);
    const stride = Math.max(1, Math.floor(record.vertexCount / 320));
    const sample: number[] = [];
    for (let v = 0; v < record.vertexCount; v += stride) sample.push(v);
    const scratch = new THREE.Vector3();
    const bind = sample.map((v) => mesh.getVertexPosition(v, scratch.clone()).clone());

    this.state.playing = false;
    character.playClip(clip.name);
    const time = clip.duration * 0.45;
    character.setClipTime(time);
    character.root.updateMatrixWorld(true);
    let best = 0;
    let moved = 0;
    const posed = sample.map((v, i) => {
      const point = mesh.getVertexPosition(v, scratch.clone()).clone();
      const distance = point.distanceTo(bind[i]);
      if (distance > moved) {
        moved = distance;
        best = i;
      }
      return point;
    });

    this.state.probe = {
      mesh: record.name,
      vertex: sample[best] ?? 0,
      bind: [bind[best].x, bind[best].y, bind[best].z],
      posed: [posed[best].x, posed[best].y, posed[best].z],
      moved,
      clip: clip.name,
      time,
    };

    // Restore whatever the user was looking at before the probe ran.
    if (wasPlaying && previousClip) {
      character.playClip(previousClip);
      character.setClipTime(previousTime);
      this.state.time = previousTime;
      this.state.playing = true;
    } else {
      character.bindPose();
      this.state.time = 0;
      character.setClipTime(0);
      character.bindPose();
      this.state.playing = false;
    }
    this.state.mode = wasMode;
    this.viewport.invalidate();
    this.setStatus(
      moved > 0.004
        ? `<strong>Skinning verified</strong> — vertex ${sample[best]} of ${record.name} moves ${(moved * 1000).toFixed(1)} mm with clip “${clip.name}”`
        : `<strong>Skinning probe inconclusive</strong> — ${(moved * 1000).toFixed(2)} mm of movement at 45% of “${clip.name}”`,
    );
    this.refreshPanel();
  }

  // --------------------------------------------------------------- attachments

  async addAttachmentFile(file: File): Promise<void> {
    const character = this.character;
    if (!character) {
      this.toast('No character', 'Load a character before attaching accessories.', 'warn');
      return;
    }
    const result = await this.withLoading(`Inspecting ${file.name}…`, async () => {
      const bytes = await file.arrayBuffer();
      const parsed = await inspectAttachment(bytes, character);
      if (!parsed.compatibility.ok) {
        showModal({
          title: 'Attachment blocked',
          subtitle: file.name,
          body: [
            document.createTextNode('This file cannot be attached to the current character without breaking its deformation:'),
            ...parsed.compatibility.reasons.map((reason) => {
              const p = document.createElement('p');
              p.style.marginTop = '8px';
              p.textContent = `• ${reason}`;
              return p;
            }),
          ],
          actions: [{ label: 'Close', kind: 'primary', onClick: closeModal }],
        });
        parsed.dispose();
        return null;
      }
      const bone = this.state.selectedBone ?? character.bones.find((b) => /head/i.test(b.name))?.name ?? character.bones[0]?.name;
      if (!bone) {
        this.toast('No bones', 'This character has no skeleton; attach the prop as a static child instead.', 'warn');
        parsed.dispose();
        return null;
      }
      const attachment = attachToBone(character, parsed, bone, file.name.replace(/\.glb$/i, ''), file.name);
      attachment.root.position.set(0, 0.02, 0.06);
      this.attachmentCompat = parsed.compatibility;
      this.state.dirty = true;
      this.viewport.invalidate();
      this.clearance = checkClearance(character, attachment as unknown as Attachment);
      this.history.push({
        label: 'Attach accessory',
        bytes: bytes.byteLength,
        undo: () => {
          removeAttachment(character, attachment.id);
          this.viewport.invalidate();
          this.refreshPanel();
        },
        redo: () => {
          character.attachments.push(attachment);
          const target = character.bones.find((b) => b.name === attachment.boneName);
          target?.add(attachment.root);
          this.viewport.invalidate();
          this.refreshPanel();
        },
      });
      return attachment;
    });
    if (result) {
      this.toast('Accessory attached', `${result.name} follows the "${result.boneName}" bone. Exports keep the rigid transform.`, 'info', 6000);
      this.setStatus(`Attachment <strong>${result.name}</strong> bound to bone ${result.boneName} · ${this.clearance?.verdict ?? 'clearance unknown'}`);
      this.scheduleAutosave();
      this.refreshAll();
    }
  }

  updateAttachment(id: string, patch: { position?: [number, number, number]; scale?: [number, number, number] }): void {
    const character = this.character;
    if (!character) return;
    const attachment = character.attachments.find((a) => a.id === id);
    if (!attachment) return;
    setAttachmentTransform(attachment as unknown as Attachment, patch);
    this.viewport.invalidate();
    this.state.dirty = true;
    this.refreshPanel();
  }

  removeAttachment(id: string): void {
    const character = this.character;
    if (!character) return;
    removeAttachment(character, id);
    this.viewport.invalidate();
    this.state.dirty = true;
    this.clearance = null;
    this.refreshPanel();
  }

  runClearanceCheck(id: string): void {
    const character = this.character;
    if (!character) return;
    const attachment = character.attachments.find((a) => a.id === id);
    if (!attachment) return;
    this.clearance = checkClearance(character, attachment as unknown as Attachment);
    this.setStatus(`Clearance check: <strong>${this.clearance.verdict}</strong> — ${this.clearance.detail}`);
    this.refreshPanel();
  }

  // --------------------------------------------------------------------- catalog

  openCatalogAsset(id: string): void {
    const asset = this.catalog?.assets.find((a) => a.id === id);
    if (!asset) return;
    const body: Node[] = [];
    const p = (text: string) => {
      const node = document.createElement('p');
      node.style.margin = '6px 0';
      node.style.fontSize = '12px';
      node.style.lineHeight = '1.6';
      node.style.color = 'var(--text-dim)';
      node.textContent = text;
      body.push(node);
      return node;
    };
    const dl = document.createElement('dl');
    dl.className = 'kv';
    const rows: [string, string][] = [
      ['Asset id', asset.id],
      ['Type', asset.type],
      ['Skeleton family', asset.family ?? 'none recorded'],
      ['Joints', String(asset.joints ?? '—')],
      ['Clips', String(asset.clips ?? '—')],
      ['Size', asset.bytes ? formatBytes(asset.bytes) : '—'],
      ['Licence', asset.license ?? '—'],
      ['Upstream QA', asset.qa ?? '—'],
    ];
    for (const [key, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = value;
      dl.append(dt, dd);
    }
    body.push(dl);
    p('This is a catalog record only. The model binary is not distributed with DEX//SCULPT. Relink a local file you are licensed to use, and the record metadata (skeleton family, licence, provenance) will follow it into the recipe.');
    if (asset.family) {
      const family = this.catalog?.families.find((f) => f.id === asset.family);
      if (family) {
        p(
          `Compatibility: ${family.jointCountRange ? `${family.jointCountRange[0]}–${family.jointCountRange[1]} joints` : 'joint count not recorded'}${
            family.rootBone ? `, root "${family.rootBone}"` : ''
          }. ${family.directClipSharing ?? ''}`,
        );
      }
    }
    const actions: ModalAction[] = [
      { label: 'Close', kind: 'ghost', onClick: closeModal },
      {
        label: 'Relink local GLB…',
        kind: 'primary',
        onClick: () => {
          closeModal();
          this.relinkCatalogAsset(asset);
        },
      },
    ];
    showModal({ title: asset.name, subtitle: `${asset.id} · metadata only`, body, actions });
  }

  relinkCatalogAsset(asset: CatalogAsset): void {
    this.pendingCatalogAsset = asset;
    this.setStatus(`Relinking <strong>${asset.name}</strong> — choose the matching local GLB`);
    (this.refs.fileInput as HTMLInputElement).click();
  }

  // --------------------------------------------------------------------- export

  async exportAndVerify(): Promise<ExportArtifact | null> {
    const character = this.character;
    if (!character) {
      this.toast('Nothing to export', 'Load a character first.', 'warn');
      return null;
    }
    const preflight = preflightExport(character);
    if (!preflight.ok) {
      showModal({
        title: 'Export blocked',
        subtitle: 'The file would lose rig data',
        body: [
          ...preflight.reasons.map((reason) => {
            const p = document.createElement('p');
            p.textContent = `• ${reason}`;
            p.style.margin = '6px 0';
            return p;
          }),
        ],
        actions: [{ label: 'Close', kind: 'primary', onClick: closeModal }],
      });
      this.setStatus('<strong>Export blocked</strong> — see the dialog for the exact reason');
      return null;
    }
    const artifact = await this.withLoading('Exporting GLB, validating structure, re-importing…', async () => {
      const result = await exportCharacterGLB(character, {});
      const reimport = await verifyReimport(result.bytes, character);
      const artifact: ExportArtifact = {
        fileName: result.fileName,
        bytes: result.bytes,
        report: result.report,
        reimport,
        createdAt: new Date().toISOString(),
      };
      this.lastExport = artifact;
      const ok = result.report.ok && reimport.ok;
      this.setStatus(
        ok
          ? `<strong>Export verified</strong> — ${formatBytes(result.bytes.byteLength)} · rig, weights, morphs and clips preserved`
          : '<strong>Export validation failed</strong> — see the report',
      );
      return artifact;
    });
    if (artifact) {
      this.showExportReport();
      this.refreshPanel();
    }
    return artifact;
  }

  showExportReport(): void {
    if (!this.lastExport) return;
    const artifact = this.lastExport;
    showModal({
      title: 'Export verification',
      subtitle: `${artifact.fileName} · ${formatBytes(artifact.bytes.byteLength)}`,
      body: renderExportReport(this, artifact),
      wide: true,
      actions: [
        {
          label: 'Copy report',
          kind: 'ghost',
          onClick: () => {
            const text = [
              '# DEX//SCULPT export verification',
              `file: ${artifact.fileName}`,
              `bytes: ${artifact.bytes.byteLength}`,
              `structural: ${artifact.report.ok ? 'PASS' : 'FAIL'}`,
              `reimport: ${artifact.reimport.ok ? 'PASS' : 'FAIL'}`,
              '',
              ...artifact.report.checks.map((c) => `[${c.status}] ${c.label}: ${c.detail}`),
              ...artifact.reimport.checks.map((c) => `[${c.status}] (reimport) ${c.label}: ${c.detail}`),
            ].join('\n');
            void navigator.clipboard?.writeText(text);
            this.toast('Report copied', 'The full verification report is on your clipboard.', 'info', 4000);
          },
        },
        { label: 'Close', kind: 'ghost', onClick: closeModal },
        {
          label: 'Download GLB',
          kind: 'primary',
          onClick: () => {
            if (!artifact.report.ok || !artifact.reimport.ok) {
              this.toast('Blocked', 'This file failed validation, so the download is disabled.', 'fail', 6000);
              return;
            }
            downloadBytes(artifact.bytes, artifact.fileName);
          },
        },
      ],
    });
  }

  // -------------------------------------------------------------------- projects

  async saveProject(): Promise<void> {
    const character = this.character;
    if (!character) {
      this.toast('Nothing to save', 'Load a character first.', 'warn');
      return;
    }
    const recipe = buildRecipe(character, { id: this.state.projectId, name: this.state.projectName });
    this.lastRecipe = recipe;
    await this.store.save({
      id: this.state.projectId,
      name: this.state.projectName,
      updatedAt: new Date().toISOString(),
      recipe,
      sourceBytes: character.meta.glbBytes,
      sourceFileName: character.meta.fileName,
      sourceHash: character.meta.fileHash,
      attachmentBlobs: character.attachments
        .filter((a) => a.bytes)
        .map((a) => ({ id: a.id, name: a.name, bytes: a.bytes as ArrayBuffer })),
    });
    this.state.dirty = false;
    this.refreshProjectMeta();
    await this.refreshProjects();
    const where = this.store.mode === 'indexeddb' ? 'IndexedDB' : 'memory (session only)';
    this.toast('Project saved', `“${this.state.projectName}” and its source model are stored in ${where}. Source: ${formatBytes(recipe.source.byteLength ?? 0)}.`, this.store.mode === 'indexeddb' ? 'info' : 'warn', 6000);
    this.setStatus(`Saved <strong>${this.state.projectName}</strong> · ${recipeSummary(recipe)}`);
    this.refreshPanel();
  }

  async refreshProjects(): Promise<void> {
    try {
      this.projects = await this.store.list();
    } catch {
      this.projects = [];
    }
    if (this.state.tab === 'project') this.refreshPanel();
  }

  async openProject(id: string): Promise<void> {
    const record = await this.store.get(id);
    if (!record) {
      this.toast('Project missing', 'That project could not be read from local storage.', 'fail');
      return;
    }
    let bytes = record.sourceBytes;
    if (!bytes && record.recipe.source.embeddedBase64) {
      const data = fromBase64(record.recipe.source.embeddedBase64);
      bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    }
    if (!bytes) {
      this.pendingRecipe = record.recipe;
      this.toast('Source model needed', 'This recipe references a model that was not stored with the project. Import the original GLB to finish reopening it.', 'warn', 9000);
      (this.refs.fileInput as HTMLInputElement).click();
      return;
    }
    const result = await this.withLoading(`Opening ${record.name}…`, async () => {
      const character = await loadCharacter(bytes as ArrayBuffer, {
        sourceKind: record.recipe.source.kind,
        fixtureId: record.recipe.source.fixtureId,
        catalogId: record.recipe.source.catalogId,
        fileName: record.sourceFileName ?? record.recipe.source.fileName,
        license: record.recipe.source.license,
        provenance: record.recipe.source.provenance,
        skeletonFamily: record.recipe.source.skeletonFamily,
      });
      this.setCharacter(character);
      const applied = applyRecipe(character, record.recipe);
      character.flushNormals();
      character.refreshSpatialIndexes();
      this.viewport.invalidate();
      this.maskOverlayDirty = true;
      this.refreshMaskOverlay();
      this.state.projectId = record.id;
      this.state.projectName = record.name;
      this.state.dirty = false;
      this.refreshProjectMeta();
      return { character, applied, record };
    });
    if (!result) return;
    const { character, applied, record: record2 } = result;
    // Re-attach accessory blobs that were saved with the project.
    for (const blob of record2.attachmentBlobs) {
      try {
        const parsed = await inspectAttachment(blob.bytes, character);
        const spec = record2.recipe.attachments.find((a) => a.id === blob.id);
        if (!parsed.compatibility.ok || !spec) continue;
        const attachment = attachToBone(character, parsed, spec.boneName, spec.name, blob.name);
        setAttachmentTransform(attachment, {
          position: spec.transform.position,
          quaternion: spec.transform.quaternion,
          scale: spec.transform.scale,
        });
      } catch {
        this.toast('Attachment skipped', `${blob.name} could not be re-attached to this rig.`, 'warn', 6000);
      }
    }
    this.viewport.invalidate();
    this.refreshAll();
    if (applied.blocked.length) {
      this.toast('Recipe partially applied', applied.blocked.slice(0, 3).join(' '), 'warn', 9000);
    } else {
      this.toast('Project opened', `${record.name}: ${applied.applied.sculptGroups} sculpted groups, ${applied.applied.morphs} morph values, ${applied.applied.materials} material overrides restored.`, 'info', 6000);
    }
    this.setStatus(`Opened <strong>${record.name}</strong> · ${record.recipe.sculpt.reduce((a, c) => a + c.count, 0)} sculpted groups restored`);
  }

  async deleteProject(id: string): Promise<void> {
    await this.store.remove(id);
    await this.refreshProjects();
    this.refreshPanel();
  }

  private async applyPendingRecipe(): Promise<void> {
    const recipe = this.pendingRecipe;
    const character = this.character;
    if (!recipe || !character) return;
    const applied = applyRecipe(character, recipe);
    character.flushNormals();
    character.refreshSpatialIndexes();
    const reattached = await reattachFromRecipe(character, recipe.attachments);
    if (reattached.skipped.length) {
      this.toast('Some accessories were skipped', reattached.skipped.slice(0, 3).join(' '), 'warn', 9000);
    }
    this.pendingRecipe = null;
    this.maskOverlayDirty = true;
    this.refreshMaskOverlay();
    this.viewport.invalidate();
    this.state.dirty = false;
    this.setStatus(`Recipe applied · ${applied.applied.sculptGroups} sculpted groups, ${applied.applied.morphs} morph values`);
    if (applied.blocked.length) this.toast('Recipe partially applied', applied.blocked.join(' '), 'warn', 9000);
    this.refreshAll();
  }

  downloadRecipe(): void {
    const character = this.character;
    if (!character) return;
    const recipe = buildRecipe(character, { id: this.state.projectId, name: this.state.projectName });
    this.lastRecipe = recipe;
    const text = JSON.stringify(recipe, null, 2);
    downloadBytes(new TextEncoder().encode(text), `${slug(this.state.projectName)}.dexsculpt.json`, 'application/json');
    this.toast('Recipe exported', `${recipe.sculpt.reduce((a, c) => a + c.count, 0)} sculpted groups · ${recipeSummary(recipe)}${recipe.source.pendingRelink ? ' — relink the source model when reopening.' : ' — source model embedded.'}`, 'info', 7000);
  }

  async importRecipeFile(file: File): Promise<void> {
    const text = await file.text();
    let recipe: CharacterRecipe;
    try {
      recipe = JSON.parse(text) as CharacterRecipe;
    } catch (error) {
      this.toast('Invalid recipe', `Could not parse ${file.name}: ${(error as Error).message}`, 'fail', 8000);
      return;
    }
    if (recipe.schema !== RECIPE_SCHEMA) {
      this.toast('Unsupported recipe', `Expected ${RECIPE_SCHEMA}, found ${recipe.schema}.`, 'fail', 8000);
      return;
    }
    if (recipe.source.embeddedBase64) {
      const data = fromBase64(recipe.source.embeddedBase64);
      const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      const character = await this.withLoading('Rebuilding from embedded source…', async () =>
        loadCharacter(bytes, {
          sourceKind: recipe.source.kind,
          fixtureId: recipe.source.fixtureId,
          catalogId: recipe.source.catalogId,
          fileName: recipe.source.fileName,
          license: recipe.source.license,
          provenance: recipe.source.provenance,
          skeletonFamily: recipe.source.skeletonFamily,
        }),
      );
      if (!character) return;
      this.setCharacter(character);
      this.pendingRecipe = recipe;
      await this.applyPendingRecipe();
      this.state.projectName = recipe.name;
      this.refreshProjectMeta();
      return;
    }
    this.pendingRecipe = recipe;
    this.toast('Recipe needs its source', 'This recipe does not embed its source model. Import the original GLB and the recipe will be applied automatically.', 'warn', 9000);
    (this.refs.fileInput as HTMLInputElement).click();
  }

  private scheduleAutosave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      if (this.character && this.state.dirty) void this.saveProject();
    }, 2500);
  }

  // ---------------------------------------------------------------- undo/redo

  undo(): void {
    const command = this.history.undo();
    if (!command) {
      this.setStatus('Nothing to undo');
      return;
    }
    this.character?.flushNormals();
    this.character?.refreshSpatialIndexes();
    this.maskOverlayDirty = true;
    this.refreshMaskOverlay();
    this.viewport.invalidate();
    this.state.dirty = true;
    this.setStatus(`Undid <strong>${command.label}</strong>`);
    this.refreshPanel();
  }

  redo(): void {
    const command = this.history.redo();
    if (!command) {
      this.setStatus('Nothing to redo');
      return;
    }
    this.character?.flushNormals();
    this.character?.refreshSpatialIndexes();
    this.maskOverlayDirty = true;
    this.refreshMaskOverlay();
    this.viewport.invalidate();
    this.state.dirty = true;
    this.setStatus(`Redid <strong>${command.label}</strong>`);
    this.refreshPanel();
  }

  // --------------------------------------------------------------------- loop

  private startLoop(): void {
    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - this.clock) / 1000);
      this.clock = now;
      this.viewport.tick();
      if (this.state.playing && this.character && this.character.activeClip) {
        this.character.advance(dt * this.state.speed);
        this.state.time = this.character.mixer?.time ?? this.state.time;
        this.viewport.invalidate();
        this.playingFrame++;
        if (this.playingFrame % 6 === 0) this.updateTimelineUI();
      }
      if (now - this.lastPerfUpdate > 500) {
        this.lastPerfUpdate = now;
        const info = this.viewport.info();
        this.refs.perfReadout.textContent = `${info.fps} fps · ${info.calls} draws · ${(info.triangles / 1000).toFixed(1)}k tris · dpr ${info.dpr.toFixed(2)}`;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private updateTimelineUI(): void {
    const fill = document.getElementById('timelineFill');
    const timeLabel = document.getElementById('timelineTime');
    const scrub = document.getElementById('timelineScrub') as HTMLInputElement | null;
    if (!fill || !this.character) return;
    const clip = this.character.clips.find((c) => c.name === this.character!.activeClip);
    const duration = clip?.duration ?? 1;
    const pct = clamp(this.state.time / duration, 0, 1);
    fill.style.width = `${pct * 100}%`;
    if (timeLabel) timeLabel.textContent = `${this.state.time.toFixed(2)} / ${duration.toFixed(2)}s`;
    if (scrub && document.activeElement !== scrub) scrub.value = String(this.state.time);
  }

  /**
   * Drive one stroke through the real pointer pipeline (used by the Playwright
   * smoke test). Synthetic PointerEvents go to the canvas so the capture-phase
   * routing, pressure handling and stroke transaction all run for real.
   */
  async debugStroke(x: number, y: number, dx = 26, steps = 6): Promise<boolean> {
    if (!this.character) return false;
    const canvas = this.canvas;
    const fire = (type: string, cx: number, cy: number) => {
      canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 91,
          pointerType: 'mouse',
          isPrimary: true,
          button: type === 'pointermove' ? -1 : 0,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX: cx,
          clientY: cy,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    fire('pointerdown', x, y);
    if (!this.stroke) return false;
    for (let i = 1; i <= steps; i++) {
      fire('pointermove', x + (dx * i) / steps, y + (dx * i) / (steps * 2));
      await frame();
    }
    fire('pointerup', x + dx, y + dx / 2);
    await frame();
    return true;
  }

  // ----------------------------------------------------------------- debug api

  debugApi(): Record<string, unknown> {
    const studio = this;
    return {
      ready: () => !!studio.character,
      state: () => ({
        mode: studio.state.mode,
        tab: studio.state.tab,
        tool: studio.state.tool,
        radiusPx: studio.state.radiusPx,
        strength: studio.state.strength,
        symmetry: studio.state.symmetryX,
        playing: studio.state.playing,
        clip: studio.state.clip,
        time: studio.state.time,
        compare: studio.state.compare,
        dirty: studio.state.dirty,
        projectName: studio.state.projectName,
        loading: studio.state.loading,
        status: studio.state.status,
        history: { undo: studio.history.canUndo, redo: studio.history.canRedo, size: studio.history.size },
        viewport: studio.viewport.info(),
      }),
      character: () => {
        if (!studio.character) return null;
        const stats = studio.character.countStats();
        return {
          ...stats,
          manifestBones: studio.character.manifest.skeleton.boneCount,
          morphNames: studio.character.meshes.flatMap((m) => m.morphTargets.map((t) => t.name)),
          clips: studio.character.clips.map((c) => ({ name: c.name, duration: c.duration, tracks: c.tracks.length })),
          skeletonFamily: studio.character.meta.skeletonFamily ?? null,
          catalogId: studio.character.meta.catalogId ?? null,
          maskCoverage: studio.character.maskCoverage(),
        };
      },
      sculptStats: () => {
        if (!studio.character) return null;
        const record = studio.character.meshes[0];
        const engine = new SculptEngine(studio.character.getTarget(record));
        const stats = engine.getDeltaStats();
        return {
          ...stats,
          meshName: record.name,
          deltaHash: hashArray(record.delta),
          positionHash: hashArray(record.positionAttr.array as Float32Array),
          baseHash: hashArray(record.basePosition),
          skinHash: studio.character.hashSkinAttributes(),
          maskCoverage: studio.character.maskCoverage(),
        };
      },
      loadExample: (id: string) => studio.loadExample(id),
      setMode: (mode: Mode) => studio.setMode(mode),
      setTab: (tab: Tab) => studio.setTab(tab),
      setTool: (tool: BrushId) => studio.setTool(tool),
      setRadius: (px: number) => {
        studio.state.radiusPx = px;
        renderToolDock(studio);
      },
      undo: () => studio.undo(),
      redo: () => studio.redo(),
      compare: (on: boolean) => studio.setCompare(on),
      playClip: (name: string) => studio.playClip(name),
      togglePlayback: () => studio.togglePlayback(),
      setTime: (t: number) => studio.setClipTime(t),
      resetSculpt: () => studio.resetSculpt(),
      exportAndVerify: async () => {
        const artifact = await studio.exportAndVerify();
        if (!artifact) return null;
        return {
          bytes: artifact.bytes.byteLength,
          fileName: artifact.fileName,
          structuralOk: artifact.report.ok,
          reimportOk: artifact.reimport.ok,
          checks: artifact.report.checks.map((c) => ({ id: c.id, status: c.status, detail: c.detail })),
          reimportChecks: artifact.reimport.checks.map((c) => ({ id: c.id, status: c.status, detail: c.detail })),
          probes: artifact.reimport.probes.map((p) => ({ vertex: p.vertex, moved: p.moved })),
          morphProbe: artifact.reimport.morphProbe ?? null,
          downloadBytes: artifact.bytes,
        };
      },
      closeModal,
      saveProject: () => studio.saveProject(),
      listProjects: () => studio.store.list(),
      openProject: (id: string) => studio.openProject(id),
      deleteProject: (id: string) => studio.deleteProject(id),
      storeMode: () => studio.store.mode,
      catalog: () => studio.catalog,
      filterCatalog: (query: string, filter?: CatalogFilter) =>
        studio.catalog ? filterAssets(studio.catalog, query, filter ?? 'all').slice(0, 20) : [],
      relinkCatalog: (id: string) => {
        const asset = studio.catalog?.assets.find((a) => a.id === id);
        if (asset) studio.relinkCatalogAsset(asset);
      },
      screenPoint: () => {
        const character = studio.character;
        if (!character) return null;
        const record =
          character.meshes.filter((mesh) => mesh.skinned).sort((a, b) => b.vertexCount - a.vertexCount)[0] ??
          character.meshes[0];
        if (!record) return null;
        const center = new THREE.Box3().setFromObject(record.mesh).getCenter(new THREE.Vector3());
        const projected = studio.viewport.projectToScreen(center);
        return { ...projected, mesh: record.name };
      },
      pickAt: (x: number, y: number) => {
        const hit = studio.viewport.pick(x, y);
        if (!hit) return null;
        const record = studio.character?.meshes.find((mesh) => mesh.mesh === hit.mesh);
        return { mesh: record?.name ?? hit.mesh.name, x: hit.local.x, y: hit.local.y, z: hit.local.z };
      },
      strokeScreen: async (dx = 24, steps = 6) => {
        const point = (studio.debugApi() as { screenPoint: () => { x: number; y: number } | null }).screenPoint();
        if (!point) return null;
        await studio.debugStroke(point.x, point.y, dx, steps);
        return { x: point.x, y: point.y };
      },
      attachFile: (file: File) => studio.addAttachmentFile(file),
      currentAsset: () => studio.loadedCatalogAsset?.id ?? null,
      fingerSculpts: (on?: boolean) => {
        if (on !== undefined) studio.state.fingerSculpts = on;
        return studio.state.fingerSculpts;
      },
      boneNames: () => studio.character?.bones.map((bone) => bone.name) ?? [],
      skinHash: () => studio.character?.hashSkinAttributes() ?? null,
      morphTargets: () =>
        studio.character?.meshes.flatMap((mesh) =>
          mesh.morphTargets.map((target) => ({
            mesh: mesh.name,
            meshId: mesh.id,
            target: target.name,
            weight: studio.character!.getMorphWeight(mesh, target.name),
          })),
        ) ?? [],
      setMorphWeight: (meshId: string, target: string, value: number) => {
        const mesh = studio.character?.meshes.find((m) => m.id === meshId || m.name === meshId);
        if (!mesh) return false;
        studio.setMorphWeight(mesh, target, value, true);
        return true;
      },
      materialOverrides: () =>
        studio.character?.meshes.flatMap((mesh) =>
          mesh.materialSlots.map((slot) => ({ mesh: mesh.name, slot: slot.name, colorHex: slot.colorHex, overridden: slot.overridden })),
        ) ?? [],
      runProbe: () => studio.runDeformationProbe(),
      probe: () => studio.state.probe,
      storageMode: () => studio.store.mode,
      attachExampleProp: async () => {
        const example = getExample('foundry-visor');
        if (!example) return null;
        const bytes = await example.build();
        const file = new File([bytes], 'foundry-visor.glb', { type: 'model/gltf-binary' });
        await studio.addAttachmentFile(file);
        return studio.character?.attachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          bone: attachment.boneName,
        })) ?? [];
      },
      attachments: () =>
        studio.character?.attachments.map((a) => ({ id: a.id, name: a.name, bone: a.boneName })) ?? [],
      clearance: () => studio.clearance,
      notice: () => (document.getElementById('stageNotice') as HTMLElement).hidden ? null : (document.getElementById('stageNotice') as HTMLElement).textContent,
      lastExport: () => studio.lastExport,
      setLight: (preset: LightPreset) => {
        studio.state.light = preset;
        studio.viewport.setLightPreset(preset);
        renderViewControls(studio);
      },
      setProjection: (projection: Projection) => studio.setProjection(projection),
      viewPreset: (preset: ViewPreset) => studio.viewport.setViewPreset(preset),
      frameCamera: () => studio.viewport.frameCharacter(),
      downloadRecipe: () => studio.downloadRecipe(),
      applyRecipeJson: async (json: string) => {
        const file = new File([json], 'recipe.dexsculpt.json', { type: 'application/json' });
        await studio.importRecipeFile(file);
      },
      buildRecipe: () => (studio.character ? buildRecipe(studio.character, { id: studio.state.projectId, name: studio.state.projectName }) : null),
      summarise: () => {
        if (!studio.lastExport) return null;
        return {
          structural: studio.lastExport.report.ok,
          reimport: studio.lastExport.reimport.ok,
          summary: summariseReimport(studio.lastExport.reimport),
        };
      },
    };
  }
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'character';
}

export type { CatalogSummary, ExampleAsset };
