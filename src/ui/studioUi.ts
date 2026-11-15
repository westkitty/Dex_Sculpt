import * as THREE from 'three';
import { BRUSHES } from '../core/brushes';
import { PROCEDURAL_ACCESSORIES } from '../fixtures/proceduralAccessories';
import {
  assessCatalogCompatibility,
  getCatalogSummary,
  getCatalogSource,
  listCatalogSources,
  searchCatalog
} from '../catalog/catalogService';
import { IMPORT_ACCEPT } from '../io/glbPipeline';
import { parseRecipeJson, serializeRecipeJson } from '../io/projectStorage';
import type { CharacterSession } from '../app/characterSession';
import type { SculptTool } from '../app/sculptTool';
import type { CameraViewPreset, LightingPresetId, StudioViewport } from '../app/viewport';

type InspectorTab = 'shape' | 'materials' | 'rig' | 'assemble' | 'catalog';

export class StudioUI {
  private activeTab: InspectorTab = 'shape';
  private leftOpen = false;
  private rightOpen = false;
  private modalKind: 'none' | 'export' | 'shortcuts' | 'tablet' = 'none';
  private toast: { msg: string; tone: 'info' | 'warn' | 'error' | 'ok'; timer?: number } | null = null;
  private catalogQuery = '';
  private catalogSource = '';
  private catalogType = '';
  private catalogFamily = '';
  private catalogAnimatedOnly = false;
  private selectedBone = 'Head';
  private attachMode: 'bone-attached' | 'static-prop' | 'skinned-compatible' = 'bone-attached';

  private leftRailEl!: HTMLElement;
  private rightInspectorEl!: HTMLElement;
  private inspectorBodyEl!: HTMLElement;
  private topStatusEl!: HTMLElement;
  private hudOverlayEl!: HTMLElement;
  private bannerEl!: HTMLElement;
  private modalRootEl!: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private beforeAfterBtn!: HTMLButtonElement;
  private modeSculptBtn!: HTMLButtonElement;
  private modeXformBtn!: HTMLButtonElement;
  private glbInput!: HTMLInputElement;
  private recipeInput!: HTMLInputElement;
  private relinkInput!: HTMLInputElement;
  private accessoryInput!: HTMLInputElement;
  private animScrubInput: HTMLInputElement | null = null;
  private animScrubLabel: HTMLElement | null = null;

  constructor(
    private rootEl: HTMLElement,
    private vp: StudioViewport,
    private session: CharacterSession,
    private tool: SculptTool
  ) {
    this.buildShell();
    this.bindGlobalShortcuts();
    this.session.onChange = () => this.refresh();
    this.session.onAnimTick = () => this.syncAnimTimelineDom();
    this.session.onToast = (msg, tone = 'info') => this.showToast(msg, tone);
    this.tool.onPenActivity = () => {
      if (this.modalKind === 'tablet') this.renderModal();
      this.renderHud();
    };
    this.vp.onContextChange = () => this.renderBanner();
    this.refresh();
  }

  private buildShell(): void {
    this.rootEl.innerHTML = '';
    const shell = document.createElement('div');
    shell.className = 'studio-shell';

    // Hidden file inputs
    this.glbInput = document.createElement('input');
    this.glbInput.type = 'file';
    this.glbInput.accept = IMPORT_ACCEPT;
    this.glbInput.hidden = true;
    this.glbInput.addEventListener('change', async () => {
      const file = this.glbInput.files?.[0];
      this.glbInput.value = '';
      if (!file) return;
      try {
        await this.session.loadLocalFile(file.name, await file.arrayBuffer());
      } catch (err) {
        this.showToast(`Import failed: ${(err as Error).message}`, 'error');
      }
    });

    this.recipeInput = document.createElement('input');
    this.recipeInput.type = 'file';
    this.recipeInput.accept = '.json,.dexsculpt.json';
    this.recipeInput.hidden = true;
    this.recipeInput.addEventListener('change', async () => {
      const file = this.recipeInput.files?.[0];
      this.recipeInput.value = '';
      if (!file) return;
      try {
        const recipe = parseRecipeJson(await file.text());
        const res = await this.session.loadRecipe(recipe);
        if (res.needsRelink) {
          this.showToast(
            `Recipe loaded — please relink "${recipe.source.fileName}" to reconstruct mesh.`,
            'warn'
          );
        } else {
          this.showToast(
            res.warnings.length ? `Recipe applied (${res.warnings[0]})` : 'Character recipe applied!',
            res.warnings.length ? 'warn' : 'ok'
          );
        }
      } catch (err) {
        this.showToast(`Invalid recipe: ${(err as Error).message}`, 'error');
      }
    });

    this.relinkInput = document.createElement('input');
    this.relinkInput.type = 'file';
    this.relinkInput.accept = '.glb,.gltf';
    this.relinkInput.hidden = true;
    this.relinkInput.addEventListener('change', async () => {
      const file = this.relinkInput.files?.[0];
      this.relinkInput.value = '';
      if (!file) return;
      try {
        const warnings = await this.session.relinkSourceForPendingRecipe(file.name, await file.arrayBuffer());
        this.showToast(
          warnings.length ? warnings[0] : 'Source GLB relinked and recipe reconstructed!',
          warnings.length ? 'warn' : 'ok'
        );
      } catch (err) {
        this.showToast(`Relink failed: ${(err as Error).message}`, 'error');
      }
    });

    this.accessoryInput = document.createElement('input');
    this.accessoryInput.type = 'file';
    this.accessoryInput.accept = IMPORT_ACCEPT;
    this.accessoryInput.hidden = true;
    this.accessoryInput.addEventListener('change', async () => {
      const file = this.accessoryInput.files?.[0];
      this.accessoryInput.value = '';
      if (!file) return;
      try {
        await this.session.attachLocalFile(
          file.name,
          await file.arrayBuffer(),
          this.attachMode,
          this.selectedBone
        );
      } catch (err) {
        this.showToast(`Attachment blocked: ${(err as Error).message}`, 'error');
      }
    });

    // Topbar
    const topbar = document.createElement('header');
    topbar.className = 'topbar';

    const brand = document.createElement('div');
    brand.className = 'brand-group';
    brand.innerHTML = `<div class="brand-mark">DEX<span>//</span>SCULPT</div>`;
    this.topStatusEl = document.createElement('div');
    this.topStatusEl.className = 'status-pill';
    brand.appendChild(this.topStatusEl);

    const actions = document.createElement('div');
    actions.className = 'topbar-actions';

    const drawerBtns = document.createElement('div');
    drawerBtns.className = 'mobile-drawer-toggles';
    const toggleLeft = this.btn('Tools', () => {
      this.leftOpen = !this.leftOpen;
      this.rightOpen = false;
      this.syncDrawerClasses();
    });
    const toggleRight = this.btn('Inspector', () => {
      this.rightOpen = !this.rightOpen;
      this.leftOpen = false;
      this.syncDrawerClasses();
    });
    drawerBtns.append(toggleLeft, toggleRight);

    this.undoBtn = this.btn('Undo', () => this.session.history.undo());
    this.redoBtn = this.btn('Redo', () => this.session.history.redo());
    this.beforeAfterBtn = this.btn('Before / After', () => {
      this.session.setBeforeAfterOriginal(!this.session.beforeAfterOriginal);
    });
    this.beforeAfterBtn.dataset.testid = 'btn-before-after';

    const importBtn = this.btn('Import GLB', () => this.glbInput.click());
    importBtn.dataset.testid = 'btn-import-glb';
    const sampleBtn = this.btn('Sample Rig', () => this.session.loadProceduralSample());
    sampleBtn.dataset.testid = 'btn-load-sample';
    const saveRecipeBtn = this.btn('Save Recipe', () => this.downloadRecipe());
    saveRecipeBtn.dataset.testid = 'btn-save-recipe';
    const loadRecipeBtn = this.btn('Load Recipe', () => this.recipeInput.click());
    loadRecipeBtn.dataset.testid = 'btn-load-recipe';
    const exportGlbBtn = this.btn('Export GLB', () => this.handleExportGlb(), 'primary');
    exportGlbBtn.dataset.testid = 'btn-export-glb';
    const tabletBtn = this.btn('Pen / Touch', () => {
      this.modalKind = this.modalKind === 'tablet' ? 'none' : 'tablet';
      this.renderModal();
    });
    const helpBtn = this.btn('?', () => {
      this.modalKind = this.modalKind === 'shortcuts' ? 'none' : 'shortcuts';
      this.renderModal();
    });
    helpBtn.title = 'Keyboard shortcuts (?)';

    actions.append(
      drawerBtns,
      importBtn,
      sampleBtn,
      this.sep(),
      this.undoBtn,
      this.redoBtn,
      this.beforeAfterBtn,
      this.sep(),
      saveRecipeBtn,
      loadRecipeBtn,
      exportGlbBtn,
      this.sep(),
      tabletBtn,
      helpBtn
    );

    topbar.append(brand, actions);

    // Workspace 3-column grid
    const workspace = document.createElement('div');
    workspace.className = 'workspace';

    // Left Rail
    this.leftRailEl = document.createElement('aside');
    this.leftRailEl.className = 'left-rail';
    this.buildLeftRail();

    // Center Viewport Stage
    const stage = document.createElement('main');
    stage.className = 'viewport-stage';
    stage.appendChild(this.vp.renderer.domElement);

    this.hudOverlayEl = document.createElement('div');
    this.hudOverlayEl.className = 'viewport-hud-top';
    this.bannerEl = document.createElement('div');
    this.bannerEl.style.display = 'none';
    stage.append(this.hudOverlayEl, this.bannerEl);

    // Right Contextual Inspector
    this.rightInspectorEl = document.createElement('aside');
    this.rightInspectorEl.className = 'right-inspector';
    const tabBar = document.createElement('div');
    tabBar.className = 'tab-bar';
    const tabs: Array<{ id: InspectorTab; label: string }> = [
      { id: 'shape', label: 'Shape' },
      { id: 'materials', label: 'Material' },
      { id: 'rig', label: 'Rig' },
      { id: 'assemble', label: 'Assemble' },
      { id: 'catalog', label: 'Catalog' }
    ];
    for (const t of tabs) {
      const b = document.createElement('button');
      b.className = `tab-btn ${t.id === this.activeTab ? 'active' : ''}`;
      b.textContent = t.label;
      b.dataset.tab = t.id;
      b.addEventListener('click', () => {
        this.activeTab = t.id;
        tabBar.querySelectorAll('.tab-btn').forEach((el) => {
          el.classList.toggle('active', (el as HTMLElement).dataset.tab === t.id);
        });
        this.renderInspectorTab();
      });
      tabBar.appendChild(b);
    }
    this.inspectorBodyEl = document.createElement('div');
    this.inspectorBodyEl.className = 'inspector-body';
    this.rightInspectorEl.append(tabBar, this.inspectorBodyEl);

    workspace.append(this.leftRailEl, stage, this.rightInspectorEl);

    this.modalRootEl = document.createElement('div');
    shell.append(topbar, workspace, this.glbInput, this.recipeInput, this.relinkInput, this.accessoryInput, this.modalRootEl);
    this.rootEl.appendChild(shell);
  }

  private buildLeftRail(): void {
    this.leftRailEl.innerHTML = '';

    // Mode toggle
    const modeSec = document.createElement('div');
    modeSec.innerHTML = `<div class="section-label">Workspace Mode</div>`;
    const modeGrid = document.createElement('div');
    modeGrid.className = 'mini-grid';
    this.modeSculptBtn = this.btn('Sculpt Mesh', () => {
      this.tool.mode = 'sculpt';
      this.vp.gizmo.detach();
      this.refreshLeftState();
    });
    this.modeXformBtn = this.btn('Move Prop', () => {
      this.tool.mode = 'transform';
      if (this.session.selectedAttachmentId) {
        this.session.selectAttachment(this.session.selectedAttachmentId);
      }
      this.refreshLeftState();
    });
    modeGrid.append(this.modeSculptBtn, this.modeXformBtn);
    modeSec.appendChild(modeGrid);

    // Brushes
    const brushSec = document.createElement('div');
    brushSec.innerHTML = `<div class="section-label">Sculpt Brushes</div>`;
    const brushGrid = document.createElement('div');
    brushGrid.className = 'brush-grid';
    for (const b of BRUSHES) {
      const btn = document.createElement('button');
      btn.className = 'brush-btn';
      btn.dataset.brush = b.id;
      btn.title = b.hint;
      btn.innerHTML = `<span>${b.label}</span><span class="key">${b.key}</span>`;
      btn.addEventListener('click', () => {
        this.tool.mode = 'sculpt';
        this.tool.settings.tool = b.id;
        this.refreshLeftState();
      });
      brushGrid.appendChild(btn);
    }
    brushSec.appendChild(brushGrid);

    // Symmetry
    const symSec = document.createElement('div');
    symSec.innerHTML = `<div class="section-label">Mirror Symmetry</div>`;
    const symRow = document.createElement('div');
    symRow.className = 'sym-row';
    (['x', 'y', 'z'] as const).forEach((axis) => {
      const btn = this.btn(axis.toUpperCase(), () => {
        this.tool.settings.symmetry[axis] = !this.tool.settings.symmetry[axis];
        this.refreshLeftState();
      });
      btn.dataset.sym = axis;
      symRow.appendChild(btn);
    });
    symSec.appendChild(symRow);

    // Size & Strength & Invert
    const paramSec = document.createElement('div');
    paramSec.innerHTML = `<div class="section-label">Brush Controls</div>`;

    const sizeRow = this.slider('Size (px)', 10, 140, 1, this.tool.settings.radiusPx, (v) => {
      this.tool.settings.radiusPx = v;
    });
    const strRow = this.slider('Strength', 0.05, 1.0, 0.05, this.tool.settings.strength, (v) => {
      this.tool.settings.strength = v;
    });

    const modGrid = document.createElement('div');
    modGrid.className = 'mini-grid';
    const invBtn = this.btn('Invert / Carve', () => {
      this.tool.settings.invertLatch = !this.tool.settings.invertLatch;
      this.refreshLeftState();
    });
    invBtn.dataset.role = 'invert';
    const clearMaskBtn = this.btn('Clear Mask', () => this.session.editMask('clear'));
    const invMaskBtn = this.btn('Invert Mask', () => this.session.editMask('invert'));
    const resetSculptBtn = this.btn('Reset Sculpt', () => this.session.resetAllSculptDeltas());
    modGrid.append(invBtn, resetSculptBtn, clearMaskBtn, invMaskBtn);
    paramSec.append(sizeRow, strRow, modGrid);

    // Camera & Viewport
    const viewSec = document.createElement('div');
    viewSec.innerHTML = `<div class="section-label">Viewport & Views</div>`;
    const viewGrid = document.createElement('div');
    viewGrid.className = 'view-grid';
    const presets: Array<{ id: CameraViewPreset; label: string }> = [
      { id: 'threeQuarter', label: '3/4' },
      { id: 'front', label: 'Front' },
      { id: 'back', label: 'Back' },
      { id: 'left', label: 'Left' },
      { id: 'right', label: 'Right' }
    ];
    for (const p of presets) {
      viewGrid.appendChild(this.btn(p.label, () => this.vp.setViewPreset(p.id)));
    }
    const frameBtn = this.btn('Frame', () => {
      if (this.session.root) this.vp.frameObject(this.session.root);
    });
    viewGrid.appendChild(frameBtn);

    const toggleGrid = document.createElement('div');
    toggleGrid.className = 'mini-grid';
    toggleGrid.style.marginTop = '6px';
    const orthoBtn = this.btn('Ortho', () => {
      this.vp.setProjection(!this.vp.isOrtho);
      this.refreshLeftState();
    });
    orthoBtn.dataset.role = 'ortho';
    const gridBtn = this.btn('Grid', () => {
      this.vp.grid.visible = !this.vp.grid.visible;
      this.vp.needsRender = true;
      this.refreshLeftState();
    });
    gridBtn.dataset.role = 'grid';
    const axesBtn = this.btn('Axes', () => {
      this.vp.axes.visible = !this.vp.axes.visible;
      this.vp.needsRender = true;
      this.refreshLeftState();
    });
    axesBtn.dataset.role = 'axes';
    const skelBtn = this.btn('Bones', () => {
      this.session.setSkeletonVisible(!this.vp.skeletonHelper);
      this.refreshLeftState();
    });
    skelBtn.dataset.role = 'bones';
    toggleGrid.append(orthoBtn, gridBtn, axesBtn, skelBtn);

    const lightSel = document.createElement('select');
    lightSel.style.width = '100%';
    lightSel.style.marginTop = '6px';
    lightSel.setAttribute('aria-label', 'Lighting preset');
    (
      [
        ['studio', 'Light: Studio Neutral'],
        ['rim', 'Light: Sculpt Rim'],
        ['warm', 'Light: Warm Portrait'],
        ['clay', 'Light: Clay Inspection']
      ] as Array<[LightingPresetId, string]>
    ).forEach(([id, label]) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = label;
      lightSel.appendChild(opt);
    });
    lightSel.value = this.vp.getLightingPreset();
    lightSel.addEventListener('change', () => {
      this.vp.setLightingPreset(lightSel.value as LightingPresetId);
      if (lightSel.value === 'clay' && this.session.root) {
        this.vp.applyClayPreview(true, this.session.root);
      }
    });

    viewSec.append(viewGrid, toggleGrid, lightSel);
    this.leftRailEl.append(modeSec, brushSec, symSec, paramSec, viewSec);
    this.refreshLeftState();
  }

  private refreshLeftState(): void {
    this.modeSculptBtn.setAttribute('aria-pressed', String(this.tool.mode === 'sculpt'));
    this.modeXformBtn.setAttribute('aria-pressed', String(this.tool.mode === 'transform'));

    this.leftRailEl.querySelectorAll<HTMLButtonElement>('[data-brush]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.brush === this.tool.settings.tool && this.tool.mode === 'sculpt'));
    });
    (['x', 'y', 'z'] as const).forEach((ax) => {
      const btn = this.leftRailEl.querySelector<HTMLButtonElement>(`[data-sym="${ax}"]`);
      btn?.setAttribute('aria-pressed', String(this.tool.settings.symmetry[ax]));
    });
    this.leftRailEl
      .querySelector('[data-role="invert"]')
      ?.setAttribute('aria-pressed', String(this.tool.settings.invertLatch));
    this.leftRailEl
      .querySelector('[data-role="ortho"]')
      ?.setAttribute('aria-pressed', String(this.vp.isOrtho));
    this.leftRailEl
      .querySelector('[data-role="grid"]')
      ?.setAttribute('aria-pressed', String(this.vp.grid.visible));
    this.leftRailEl
      .querySelector('[data-role="axes"]')
      ?.setAttribute('aria-pressed', String(this.vp.axes.visible));
    this.leftRailEl
      .querySelector('[data-role="bones"]')
      ?.setAttribute('aria-pressed', String(!!this.vp.skeletonHelper));
  }

  private syncDrawerClasses(): void {
    this.leftRailEl.classList.toggle('open', this.leftOpen);
    this.rightInspectorEl.classList.toggle('open', this.rightOpen);
  }

  refresh(): void {
    const st = this.session.getStatus();
    this.topStatusEl.className = `status-pill ${st.isRigged ? '' : 'static'}`;
    this.topStatusEl.innerHTML = `<span class="dot"></span>${
      st.isRigged
        ? `Rigged · ${st.boneCount} bones · ${st.morphCount} morphs · ${st.clipCount} clips`
        : `Static Mesh · ${st.totalTriangles} tris`
    }`;

    this.undoBtn.disabled = !this.session.history.canUndo;
    this.undoBtn.title = this.session.history.canUndo ? `Undo ${this.session.history.peekLabel()}` : 'Nothing to undo';
    this.redoBtn.disabled = !this.session.history.canRedo;
    this.redoBtn.title = this.session.history.canRedo ? `Redo ${this.session.history.peekRedoLabel()}` : 'Nothing to redo';
    this.beforeAfterBtn.setAttribute('aria-pressed', String(st.beforeAfterOriginal));

    this.refreshLeftState();
    this.renderHud();
    this.renderBanner();
    this.renderInspectorTab();
  }

  private renderHud(): void {
    const st = this.session.getStatus();
    const dispMm = (st.maxSculptDisplacement * 1000).toFixed(1);
    const penNote = this.tool.pen.seen
      ? ` · Pen ${this.tool.pen.last ? `${Math.round(this.tool.pen.last.pressure * 100)}%` : 'Ready'}`
      : '';

    this.hudOverlayEl.innerHTML = `
      <div class="hud-chip">
        <strong>${this.escape(st.title)}</strong>
        <span>${st.totalVertices.toLocaleString()} verts · ${st.totalTriangles.toLocaleString()} tris · Δ ${dispMm} mm (${st.modifiedVertices} edited)${penNote}</span>
      </div>
      <div class="hud-chip">
        <span>${st.beforeAfterOriginal ? '<strong style="color:var(--amber)">ORIGINAL SOURCE</strong>' : '<strong>SCULPTED</strong>'} · ${this.escape(st.skeletonFamily)}</span>
      </div>
    `;
  }

  private renderBanner(): void {
    if (this.vp.contextLost) {
      this.bannerEl.style.display = 'flex';
      this.bannerEl.className = 'viewport-banner warn';
      this.bannerEl.innerHTML = `<span>WebGL context lost — all sculpt deltas, morphs, and recipe state remain preserved in memory.</span>`;
      return;
    }

    if (this.session.pendingRecipeAwaitingRelink) {
      const pending = this.session.pendingRecipeAwaitingRelink;
      this.bannerEl.style.display = 'flex';
      this.bannerEl.className = 'viewport-banner warn';
      this.bannerEl.innerHTML = `<span>Recipe "${this.escape(pending.title)}" requires local source GLB: <code>${this.escape(pending.source.fileName)}</code></span>`;
      const relinkBtn = this.btn('Relink Source GLB', () => this.relinkInput.click(), 'primary');
      const dismissBtn = this.btn('Dismiss', () => {
        this.session.pendingRecipeAwaitingRelink = null;
        this.renderBanner();
      });
      this.bannerEl.append(relinkBtn, dismissBtn);
      return;
    }

    if (this.toast) {
      this.bannerEl.style.display = 'flex';
      this.bannerEl.className = `viewport-banner ${this.toast.tone}`;
      this.bannerEl.textContent = this.toast.msg;
      return;
    }

    this.bannerEl.style.display = 'none';
  }

  private renderInspectorTab(): void {
    this.animScrubInput = null;
    this.animScrubLabel = null;
    this.inspectorBodyEl.innerHTML = '';
    if (this.activeTab === 'shape') this.renderShapeTab();
    else if (this.activeTab === 'materials') this.renderMaterialsTab();
    else if (this.activeTab === 'rig') this.renderRigTab();
    else if (this.activeTab === 'assemble') this.renderAssembleTab();
    else this.renderCatalogTab();
  }

  private syncAnimTimelineDom(): void {
    if (!this.animScrubInput || !this.animScrubLabel) return;
    const t = this.session.currentTime;
    this.animScrubInput.value = String(t);
    this.animScrubLabel.textContent = t.toFixed(2);
  }

  private renderShapeTab(): void {
    const st = this.session.getStatus();

    // Sculpt Telemetry Card
    const sculptCard = document.createElement('div');
    sculptCard.className = 'card';
    sculptCard.innerHTML = `
      <div class="card-title">
        <span>Rig-Safe Sculpt Layer</span>
        <span class="badge ${st.isRigged ? 'ok' : 'warn'}">${st.isRigged ? 'Topology Locked' : 'Static'}</span>
      </div>
      <div class="stat-grid">
        <div class="stat-box"><div class="k">Modified Verts</div><div class="v">${st.modifiedVertices}</div></div>
        <div class="stat-box"><div class="k">Max Delta</div><div class="v">${(st.maxSculptDisplacement * 1000).toFixed(2)} mm</div></div>
      </div>
      <div style="margin-top:8px;font-size:11px;color:var(--text-secondary)">
        Sculpts vertex positions non-destructively against the imported base mesh while keeping JOINTS, WEIGHTS, UVs, and Morph Targets intact.
      </div>
    `;
    const resetRow = document.createElement('div');
    resetRow.style.marginTop = '8px';
    resetRow.style.display = 'flex';
    resetRow.style.gap = '6px';
    const resetSculptBtn = this.btn('Reset Sculpt Deltas', () => this.session.resetAllSculptDeltas());
    resetSculptBtn.disabled = st.modifiedVertices === 0;
    resetRow.appendChild(resetSculptBtn);
    sculptCard.appendChild(resetRow);
    this.inspectorBodyEl.appendChild(sculptCard);

    // Morph Targets / Body & Face Sliders
    const morphCard = document.createElement('div');
    morphCard.className = 'card';
    const header = document.createElement('div');
    header.className = 'card-title';
    header.innerHTML = `<span>Shape Sliders (Morph Targets)</span>`;
    const resetMorphsBtn = this.btn('Reset All', () => this.session.resetAllMorphs());
    resetMorphsBtn.disabled = this.session.morphs.every((m) => Math.abs(m.value) < 1e-4);
    header.appendChild(resetMorphsBtn);
    morphCard.appendChild(header);

    if (this.session.morphs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-note';
      empty.textContent =
        'This model contains 0 morph targets (shape keys). Use the Sculpt brushes on the left rail to customize proportions.';
      morphCard.appendChild(empty);
    } else {
      for (const m of this.session.morphs) {
        const row = this.slider(
          `${m.name.replace(/_/g, ' ')} (${m.category})`,
          0,
          1,
          0.01,
          m.value,
          (v) => this.session.setMorphWeight(m.name, v, false),
          (v) => this.session.setMorphWeight(m.name, v, true)
        );
        row.querySelector('input')!.dataset.morph = m.name;
        morphCard.appendChild(row);
      }
    }
    this.inspectorBodyEl.appendChild(morphCard);

    if (st.warnings.length > 0) {
      const warnCard = document.createElement('div');
      warnCard.className = 'card';
      warnCard.innerHTML = `<div class="card-title"><span>Import Notes</span></div>`;
      for (const w of st.warnings) {
        const p = document.createElement('div');
        p.className = 'empty-note';
        p.style.marginBottom = '4px';
        p.textContent = w;
        warnCard.appendChild(p);
      }
      this.inspectorBodyEl.appendChild(warnCard);
    }
  }

  private renderMaterialsTab(): void {
    if (this.session.materials.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-note';
      empty.textContent = 'No editable MeshStandardMaterial slots detected on this asset.';
      this.inspectorBodyEl.appendChild(empty);
      return;
    }

    for (const slot of this.session.materials) {
      const card = document.createElement('div');
      card.className = 'card';
      const title = document.createElement('div');
      title.className = 'card-title';
      title.innerHTML = `<span>${this.escape(slot.name)}</span>`;
      const resetBtn = this.btn('Reset', () => this.session.resetMaterial(slot.key));
      title.appendChild(resetBtn);
      card.appendChild(title);

      const colorWrap = document.createElement('div');
      colorWrap.style.display = 'flex';
      colorWrap.style.alignItems = 'center';
      colorWrap.style.justifyContent = 'space-between';
      colorWrap.style.marginBottom = '8px';
      colorWrap.innerHTML = `<span style="font-size:12px;color:var(--text-secondary)">Base Color Tint</span>`;
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = `#${slot.material.color.getHexString()}`;
      colorInput.addEventListener('change', () => {
        this.session.updateMaterial(slot.key, { colorHex: colorInput.value }, true);
      });
      colorWrap.appendChild(colorInput);
      card.appendChild(colorWrap);

      card.appendChild(
        this.slider(
          'Roughness',
          0,
          1,
          0.02,
          slot.material.roughness,
          (v) => this.session.updateMaterial(slot.key, { roughness: v }, false),
          (v) => this.session.updateMaterial(slot.key, { roughness: v }, true)
        )
      );
      card.appendChild(
        this.slider(
          'Metalness',
          0,
          1,
          0.02,
          slot.material.metalness,
          (v) => this.session.updateMaterial(slot.key, { metalness: v }, false),
          (v) => this.session.updateMaterial(slot.key, { metalness: v }, true)
        )
      );

      this.inspectorBodyEl.appendChild(card);
    }
  }

  private renderRigTab(): void {
    const st = this.session.getStatus();
    const animCard = document.createElement('div');
    animCard.className = 'card';
    animCard.innerHTML = `
      <div class="card-title">
        <span>Animation Playback</span>
        <span class="badge ${st.clipCount > 0 ? 'ok' : 'warn'}">${st.clipCount} clips</span>
      </div>
    `;

    if (this.session.animations.length === 0) {
      const note = document.createElement('div');
      note.className = 'empty-note';
      note.textContent = st.isRigged
        ? 'Rigged skeleton detected, but this file contains 0 embedded animation clips.'
        : 'Static mesh: no skeleton or animation clips present in source file.';
      animCard.appendChild(note);
    } else {
      const sel = document.createElement('select');
      sel.style.width = '100%';
      sel.style.marginBottom = '8px';
      sel.dataset.testid = 'select-animation-clip';
      for (const clip of this.session.animations) {
        const opt = document.createElement('option');
        opt.value = clip.name;
        opt.textContent = `${clip.name} (${clip.duration.toFixed(2)}s)`;
        sel.appendChild(opt);
      }
      sel.value = this.session.activeClipName;
      sel.addEventListener('change', () => this.session.selectClip(sel.value));
      animCard.appendChild(sel);

      const controls = document.createElement('div');
      controls.style.display = 'flex';
      controls.style.gap = '6px';
      controls.style.marginBottom = '8px';

      const playBtn = this.btn(this.session.playing ? 'Pause' : 'Play', () => {
        this.session.setPlaying(!this.session.playing);
      }, 'primary');
      playBtn.dataset.testid = 'btn-anim-play';
      const bindBtn = this.btn('Bind Pose', () => this.session.resetToBindPose());
      bindBtn.dataset.testid = 'btn-bind-pose';
      controls.append(playBtn, bindBtn);
      animCard.appendChild(controls);

      const activeClip =
        this.session.animations.find((c) => c.name === this.session.activeClipName) ??
        this.session.animations[0];
      const dur = activeClip?.duration || 1;
      const scrub = this.slider(
        `Timeline (/ ${dur.toFixed(2)}s)`,
        0,
        dur,
        0.01,
        this.session.currentTime,
        (v) => this.session.scrubAnimation(v)
      );
      this.animScrubInput = scrub.querySelector('input')!;
      this.animScrubInput.dataset.testid = 'slider-anim-time';
      this.animScrubLabel = scrub.querySelector('.val')!;
      this.animScrubLabel.textContent = this.session.currentTime.toFixed(2);
      const speed = this.slider('Speed', 0.25, 2.0, 0.05, this.session.playbackSpeed, (v) => {
        this.session.playbackSpeed = v;
      });
      animCard.append(scrub, speed);
    }
    this.inspectorBodyEl.appendChild(animCard);

    // Bone Hierarchy
    const boneCard = document.createElement('div');
    boneCard.className = 'card';
    const boneTitle = document.createElement('div');
    boneTitle.className = 'card-title';
    boneTitle.innerHTML = `<span>Bone Hierarchy (${st.boneCount})</span>`;
    const toggleSkel = this.btn(this.vp.skeletonHelper ? 'Hide Bones' : 'Show Bones', () => {
      this.session.setSkeletonVisible(!this.vp.skeletonHelper);
      this.refresh();
    });
    toggleSkel.disabled = !st.isRigged;
    boneTitle.appendChild(toggleSkel);
    boneCard.appendChild(boneTitle);

    if (!this.session.primarySkeleton) {
      const note = document.createElement('div');
      note.className = 'empty-note';
      note.textContent = 'No skeleton present. Bone hierarchy inspection disabled for static meshes.';
      boneCard.appendChild(note);
    } else {
      const tree = document.createElement('div');
      tree.className = 'bone-tree';
      const bones = this.session.primarySkeleton.bones;
      const depthOf = (b: THREE.Bone): number => {
        let d = 0;
        let p = b.parent;
        while (p && (p as THREE.Bone).isBone) {
          d++;
          p = p.parent;
        }
        return d;
      };
      for (const bone of bones) {
        const d = depthOf(bone);
        const btn = document.createElement('button');
        btn.className = `bone-item ${bone.name === this.selectedBone ? 'selected' : ''}`;
        btn.style.paddingLeft = `${6 + d * 12}px`;
        btn.innerHTML = `<span>${this.escape(bone.name)}</span><span style="color:var(--text-muted)">${d}</span>`;
        btn.addEventListener('click', () => {
          this.selectedBone = bone.name;
          this.renderInspectorTab();
        });
        tree.appendChild(btn);
      }
      boneCard.appendChild(tree);
    }
    this.inspectorBodyEl.appendChild(boneCard);
  }

  private renderAssembleTab(): void {
    const bones = this.session.primarySkeleton?.bones ?? [];

    const addCard = document.createElement('div');
    addCard.className = 'card';
    addCard.innerHTML = `<div class="card-title"><span>Modular Assembly & Sockets</span></div>`;

    const modeSel = document.createElement('select');
    modeSel.style.width = '100%';
    modeSel.style.marginBottom = '6px';
    (
      [
        ['bone-attached', 'Mode: Rigid Bone Socket Attachment'],
        ['static-prop', 'Mode: Static Root Prop'],
        ['skinned-compatible', 'Mode: Skinned Compatible Clothing']
      ] as const
    ).forEach(([val, label]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      modeSel.appendChild(opt);
    });
    modeSel.value = this.attachMode;
    modeSel.addEventListener('change', () => {
      this.attachMode = modeSel.value as typeof this.attachMode;
    });

    const boneSel = document.createElement('select');
    boneSel.style.width = '100%';
    boneSel.style.marginBottom = '8px';
    if (bones.length === 0) {
      const opt = document.createElement('option');
      opt.value = 'Root';
      opt.textContent = 'Socket: Root (static mesh)';
      boneSel.appendChild(opt);
    } else {
      for (const b of bones) {
        const opt = document.createElement('option');
        opt.value = b.name;
        opt.textContent = `Socket Bone: ${b.name}`;
        boneSel.appendChild(opt);
      }
      if (!bones.some((b) => b.name === this.selectedBone)) {
        this.selectedBone = bones[0].name;
      }
      boneSel.value = this.selectedBone;
    }
    boneSel.addEventListener('change', () => {
      this.selectedBone = boneSel.value;
    });

    const importAccBtn = this.btn('Import Local Accessory / Clothing GLB', () => {
      this.accessoryInput.click();
    }, 'primary');
    importAccBtn.style.width = '100%';
    importAccBtn.style.marginBottom = '8px';

    addCard.append(modeSel, boneSel, importAccBtn);

    // Built-in procedural modular wardrobe/props
    const procTitle = document.createElement('div');
    procTitle.className = 'section-label';
    procTitle.textContent = 'Procedural Foundry Attachments';
    addCard.appendChild(procTitle);

    for (const spec of PROCEDURAL_ACCESSORIES) {
      const row = document.createElement('div');
      row.className = 'catalog-item';
      row.style.marginBottom = '6px';
      row.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
          <strong>${this.escape(spec.name)}</strong>
          <span class="badge">${spec.mode}</span>
        </div>
        <div style="font-size:11px;color:var(--text-secondary)">${this.escape(spec.description)}</div>
      `;
      const attachBtn = this.btn(`Attach (${spec.targetBone})`, () => {
        try {
          this.session.attachProcedural(spec.id);
        } catch (err) {
          this.showToast((err as Error).message, 'error');
        }
      });
      attachBtn.dataset.testid = `attach-${spec.id}`;
      row.appendChild(attachBtn);
      addCard.appendChild(row);
    }
    this.inspectorBodyEl.appendChild(addCard);

    // Active Attachments List
    const listCard = document.createElement('div');
    listCard.className = 'card';
    listCard.innerHTML = `<div class="card-title"><span>Equipped Attachments (${this.session.attachments.length})</span></div>`;
    if (this.session.attachments.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-note';
      empty.textContent = 'No modular accessories or clothing attached yet.';
      listCard.appendChild(empty);
    } else {
      for (const att of this.session.attachments) {
        const item = document.createElement('div');
        item.className = 'catalog-item';
        item.style.marginBottom = '6px';
        item.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>${this.escape(att.name)}</strong>
            <span class="badge ok">${att.targetBone}</span>
          </div>
          <div style="font-size:11px;color:var(--text-secondary)">Mode: ${att.mode}</div>
        `;
        const rowBtns = document.createElement('div');
        rowBtns.style.display = 'flex';
        rowBtns.style.gap = '4px';
        const selBtn = this.btn(
          this.session.selectedAttachmentId === att.id ? 'Selected' : 'Gizmo',
          () => {
            this.tool.mode = 'transform';
            this.session.selectAttachment(att.id);
            this.refreshLeftState();
          }
        );
        const rmBtn = this.btn('Remove', () => this.session.removeAttachment(att.id));
        rowBtns.append(selBtn, rmBtn);
        item.appendChild(rowBtns);
        listCard.appendChild(item);
      }
    }
    this.inspectorBodyEl.appendChild(listCard);
  }

  private renderCatalogTab(): void {
    const summary = getCatalogSummary();
    const st = this.session.getStatus();

    const headerCard = document.createElement('div');
    headerCard.className = 'card';
    headerCard.innerHTML = `
      <div class="card-title">
        <span>Humanoid Library Catalog</span>
        <span class="badge">${summary.totalRecords} records</span>
      </div>
      <div style="font-size:11px;color:var(--text-secondary)">
        Metadata index from <code>modern_3d_browser_game_toolkit</code>. Private model binaries are NOT hosted here; import local GLBs via file picker and associate them below.
      </div>
      ${
        st.linkedAssetId
          ? `<div style="margin-top:6px" class="badge ok">Linked ID: ${this.escape(st.linkedAssetId)} (${this.escape(st.licenseId)})</div>`
          : ''
      }
    `;
    this.inspectorBodyEl.appendChild(headerCard);

    // Search & Filters
    const filterCard = document.createElement('div');
    filterCard.className = 'card';
    const qInput = document.createElement('input');
    qInput.type = 'search';
    qInput.placeholder = 'Search 786 characters, outfits, rigs...';
    qInput.value = this.catalogQuery;
    qInput.style.width = '100%';
    qInput.style.marginBottom = '6px';
    qInput.addEventListener('input', () => {
      this.catalogQuery = qInput.value;
      this.renderCatalogResults(resultsWrap);
    });

    const srcSel = document.createElement('select');
    srcSel.style.width = '100%';
    srcSel.style.marginBottom = '6px';
    srcSel.innerHTML = `<option value="">All Sources (${summary.sourceCount})</option>`;
    for (const s of listCatalogSources()) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.name} (${s.license})`;
      srcSel.appendChild(opt);
    }
    srcSel.value = this.catalogSource;
    srcSel.addEventListener('change', () => {
      this.catalogSource = srcSel.value;
      this.renderCatalogResults(resultsWrap);
    });

    const typeSel = document.createElement('select');
    typeSel.style.width = '100%';
    typeSel.style.marginBottom = '6px';
    typeSel.innerHTML = `<option value="">All Asset Types</option>`;
    for (const t of summary.assetTypes) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      typeSel.appendChild(opt);
    }
    typeSel.value = this.catalogType;
    typeSel.addEventListener('change', () => {
      this.catalogType = typeSel.value;
      this.renderCatalogResults(resultsWrap);
    });

    const famSel = document.createElement('select');
    famSel.style.width = '100%';
    famSel.style.marginBottom = '6px';
    famSel.innerHTML = `<option value="">All Skeleton Families (${summary.familyCount})</option>`;
    for (const f of summary.families) {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f;
      famSel.appendChild(opt);
    }
    famSel.value = this.catalogFamily;
    famSel.addEventListener('change', () => {
      this.catalogFamily = famSel.value;
      this.renderCatalogResults(resultsWrap);
    });

    const animLabel = document.createElement('label');
    animLabel.style.display = 'flex';
    animLabel.style.alignItems = 'center';
    animLabel.style.gap = '6px';
    animLabel.style.fontSize = '12px';
    const animChk = document.createElement('input');
    animChk.type = 'checkbox';
    animChk.checked = this.catalogAnimatedOnly;
    animChk.addEventListener('change', () => {
      this.catalogAnimatedOnly = animChk.checked;
      this.renderCatalogResults(resultsWrap);
    });
    animLabel.append(animChk, document.createTextNode('Animated assets only'));

    filterCard.append(qInput, srcSel, typeSel, famSel, animLabel);
    this.inspectorBodyEl.appendChild(filterCard);

    const resultsWrap = document.createElement('div');
    resultsWrap.className = 'catalog-list';
    this.inspectorBodyEl.appendChild(resultsWrap);
    this.renderCatalogResults(resultsWrap);
  }

  private renderCatalogResults(container: HTMLElement): void {
    container.innerHTML = '';
    const matches = searchCatalog({
      query: this.catalogQuery,
      sourceId: this.catalogSource || undefined,
      assetType: this.catalogType || undefined,
      skeletonFamily: this.catalogFamily || undefined,
      onlyAnimated: this.catalogAnimatedOnly
    });

    const countNote = document.createElement('div');
    countNote.style.fontSize = '11px';
    countNote.style.color = 'var(--text-secondary)';
    countNote.textContent = `Showing ${Math.min(40, matches.length)} of ${matches.length} matching records`;
    container.appendChild(countNote);

    const st = this.session.getStatus();
    for (const rec of matches.slice(0, 40)) {
      const compat = assessCatalogCompatibility(st.skeletonFamily, rec);
      const isLoaded = st.linkedAssetId === rec.asset_id;
      const src = getCatalogSource(rec.source_id);

      const item = document.createElement('div');
      item.className = 'catalog-item';
      item.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
          <strong>${this.escape(rec.display_name)}</strong>
          <span class="badge ${isLoaded ? 'ok' : 'warn'}">${isLoaded ? 'LOADED' : 'METADATA ONLY'}</span>
        </div>
        <div style="font-size:11px;color:var(--text-secondary)">
          ${this.escape(rec.asset_type)} · ${this.escape(rec.skeleton_family ?? 'static')} · ${rec.joint_count ?? 0} joints · ${rec.animation_count ?? 0} clips · ${this.escape(rec.license_id)}
        </div>
        <div style="font-size:11px;color:${compat.compatible ? 'var(--ok)' : 'var(--text-muted)'}">
          ${this.escape(compat.reason)}
        </div>
      `;
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '6px';
      row.style.marginTop = '2px';

      const linkBtn = this.btn('Link to Active Model', () => {
        this.session.associateCatalogRecord(rec.asset_id);
        this.renderInspectorTab();
      });
      const pickBtn = this.btn('Import Local File', () => this.glbInput.click());
      row.append(linkBtn, pickBtn);
      if (src?.official_url) {
        const a = document.createElement('a');
        a.href = src.official_url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'Source';
        a.style.fontSize = '11px';
        a.style.color = 'var(--accent)';
        a.style.alignSelf = 'center';
        row.appendChild(a);
      }
      item.appendChild(row);
      container.appendChild(item);
    }
  }

  private async handleExportGlb(): Promise<void> {
    try {
      const { result, diff } = await this.session.exportCharacterGlb();
      const blob = new Blob([result.glb], { type: 'model/gltf-binary' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${this.session.title.replace(/[^a-z0-9_-]+/gi, '_')}_dexsculpt.glb`;
      a.click();
      URL.revokeObjectURL(url);

      this.modalKind = 'export';
      this.renderModal();
      const ok = result.validation.validGlb2 && (!diff || diff.passed);
      this.showToast(
        ok
          ? `Exported & independently verified GLB (${(result.glb.byteLength / 1024).toFixed(1)} KB)`
          : 'Export completed with validation warnings — inspect audit report',
        ok ? 'ok' : 'warn'
      );
    } catch (err) {
      this.showToast(`Export failed: ${(err as Error).message}`, 'error');
    }
  }

  private downloadRecipe(): void {
    const recipe = this.session.buildRecipe();
    const json = serializeRecipeJson(recipe);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${recipe.title.replace(/[^a-z0-9_-]+/gi, '_')}.dexsculpt.json`;
    a.click();
    URL.revokeObjectURL(url);
    this.showToast(
      recipe.source.requiresSourceRelink
        ? 'Saved non-destructive recipe (.dexsculpt.json). Original local GLB is required to reconstruct.'
        : 'Saved non-destructive recipe (.dexsculpt.json)',
      'ok'
    );
  }

  private renderModal(): void {
    this.modalRootEl.innerHTML = '';
    if (this.modalKind === 'none') return;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        this.modalKind = 'none';
        this.renderModal();
      }
    });

    const card = document.createElement('div');
    card.className = 'modal-card';

    if (this.modalKind === 'export' && this.session.lastExportResult) {
      const r = this.session.lastExportResult.validation;
      const d = this.session.lastExportDiff;
      const p0 = r.primitives.find((p) => p.hasJoints && p.morphTargetCount > 0) ?? r.primitives[0];
      card.innerHTML = `
        <div class="card-title">
          <span>GLB Export — Independent Structural Validation</span>
          <span class="badge ${r.validGlb2 && (!d || d.passed) ? 'ok' : 'danger'}">
            ${r.validGlb2 && (!d || d.passed) ? 'VERIFIED PASS' : 'CHECK WARNINGS'}
          </span>
        </div>
        <div class="stat-grid" style="margin-bottom:10px">
          <div class="stat-box"><div class="k">Binary GLB2</div><div class="v">${(r.byteLength / 1024).toFixed(1)} KB</div></div>
          <div class="stat-box"><div class="k">Vertices / Tris</div><div class="v">${r.totalVertices} / ${r.totalTriangles}</div></div>
          <div class="stat-box"><div class="k">Skins / Bones</div><div class="v">${r.skinCount} / ${r.skins[0]?.jointCount ?? 0}</div></div>
          <div class="stat-box"><div class="k">Morphs / Clips</div><div class="v">${p0?.morphTargetCount ?? 0} / ${r.animationCount}</div></div>
          <div class="stat-box"><div class="k">UVs / JOINTS / WEIGHTS</div><div class="v">${p0?.hasUV ? 'Yes' : 'No'} / ${p0?.hasJoints ? 'Yes' : 'No'} / ${p0?.hasWeights ? 'Yes' : 'No'}</div></div>
          <div class="stat-box"><div class="k">Sculpt Delta</div><div class="v">${d ? `${(d.sculptMaxPositionDelta * 1000).toFixed(2)} mm` : 'N/A'}</div></div>
        </div>
        ${
          d
            ? `<div style="font-size:12px;margin-bottom:10px;color:${d.passed ? 'var(--ok)' : 'var(--danger)'}">
                ${
                  d.passed
                    ? `All rig invariants preserved: bone hierarchy match, IBM max diff ${d.inverseBindMatricesMaxDiff.toExponential(1)}, weights max diff ${d.weightsMaxDiff.toExponential(1)}, morph deltas match, animations intact.`
                    : `Failures: ${d.failures.join('; ')}`
                }
               </div>`
            : ''
        }
      `;
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '8px';
      const reimportBtn = this.btn('Verify Re-Import in Studio', async () => {
        await this.session.verifyReimportLastExport();
        this.modalKind = 'none';
        this.renderModal();
      }, 'primary');
      reimportBtn.dataset.testid = 'btn-verify-reimport';
      const closeBtn = this.btn('Close', () => {
        this.modalKind = 'none';
        this.renderModal();
      });
      row.append(reimportBtn, closeBtn);
      card.appendChild(row);
    } else if (this.modalKind === 'tablet') {
      const pen = this.tool.pen;
      card.innerHTML = `
        <div class="card-title"><span>Tablet, S Pen & Touch Pipeline</span></div>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:10px">
          Supports Galaxy Tab S9 Ultra / Pointer Events APIs: stylus pressure, tilt widening, hover ring, barrel invert/smooth, eraser mask, palm rejection, and 2-finger pinch/pan. (Real physical S Pen hardware remains unverified until tested on device.)
        </div>
        <div class="stat-grid" style="margin-bottom:10px">
          <div class="stat-box"><div class="k">Stylus Seen</div><div class="v">${pen.seen ? 'Yes' : 'Not yet'}</div></div>
          <div class="stat-box"><div class="k">Rejected Palm Touches</div><div class="v">${pen.rejectedTouches}</div></div>
        </div>
      `;
      const qSel = document.createElement('select');
      qSel.style.width = '100%';
      qSel.style.marginBottom = '10px';
      (
        [
          ['fast', 'Render Quality: Fast (1.6 MP budget)'],
          ['balanced', 'Render Quality: Balanced (3.2 MP budget)'],
          ['sharp', 'Render Quality: Sharp (8.5 MP budget)']
        ] as const
      ).forEach(([q, label]) => {
        const opt = document.createElement('option');
        opt.value = q;
        opt.textContent = label;
        qSel.appendChild(opt);
      });
      qSel.value = this.vp.quality;
      qSel.addEventListener('change', () => this.vp.setQuality(qSel.value as any));
      card.appendChild(qSel);
      card.appendChild(
        this.btn('Close', () => {
          this.modalKind = 'none';
          this.renderModal();
        })
      );
    } else {
      card.innerHTML = `
        <div class="card-title"><span>Keyboard Shortcuts & Workflow</span></div>
        <div style="font-size:12px;color:var(--text-secondary);display:grid;grid-template-columns:120px 1fr;gap:6px 10px;margin-bottom:12px">
          <code>1 – 8, M</code><span>Select sculpt brush (Draw, Clay, Smooth, Inflate, Crease, Grab, Flatten, Pinch, Mask)</span>
          <code>Shift (hold)</code><span>Temporary Smooth brush</span>
          <code>Ctrl / Alt (hold)</code><span>Temporary Carve / Invert</span>
          <code>[ / ]</code><span>Decrease / Increase brush size</span>
          <code>X</code><span>Toggle X-axis mirror symmetry</span>
          <code>Space</code><span>Play / Pause active animation clip</span>
          <code>F / R</code><span>Frame character / Reset 3/4 view</span>
          <code>S / B</code><span>Toggle Skeleton overlay / Before-After compare</span>
          <code>Ctrl+Z / Y</code><span>Undo / Redo</span>
          <code>Esc</code><span>Cancel active stroke or close dialog</span>
        </div>
      `;
      card.appendChild(
        this.btn('Close', () => {
          this.modalKind = 'none';
          this.renderModal();
        })
      );
    }

    backdrop.appendChild(card);
    this.modalRootEl.appendChild(backdrop);
  }

  private bindGlobalShortcuts(): void {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const key = e.key.toLowerCase();

      if ((e.metaKey || e.ctrlKey) && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.session.history.redo();
        else this.session.history.undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && key === 'y') {
        e.preventDefault();
        this.session.history.redo();
        return;
      }
      if (key === 'escape') {
        if (this.modalKind !== 'none') {
          this.modalKind = 'none';
          this.renderModal();
        }
        return;
      }

      const brushMatch = BRUSHES.find((b) => b.key.toLowerCase() === key);
      if (brushMatch) {
        this.tool.mode = 'sculpt';
        this.tool.settings.tool = brushMatch.id;
        this.refreshLeftState();
        return;
      }
      if (key === '[') {
        this.tool.settings.radiusPx = Math.max(10, this.tool.settings.radiusPx - 6);
        this.buildLeftRail();
      } else if (key === ']') {
        this.tool.settings.radiusPx = Math.min(140, this.tool.settings.radiusPx + 6);
        this.buildLeftRail();
      } else if (key === 'x') {
        this.tool.settings.symmetry.x = !this.tool.settings.symmetry.x;
        this.refreshLeftState();
      } else if (key === ' ') {
        e.preventDefault();
        this.session.setPlaying(!this.session.playing);
      } else if (key === 'f' && this.session.root) {
        this.vp.frameObject(this.session.root);
      } else if (key === 'r') {
        this.vp.setViewPreset('threeQuarter');
      } else if (key === 's') {
        this.session.setSkeletonVisible(!this.vp.skeletonHelper);
        this.refreshLeftState();
      } else if (key === 'b') {
        this.session.setBeforeAfterOriginal(!this.session.beforeAfterOriginal);
      } else if (key === '?') {
        this.modalKind = this.modalKind === 'shortcuts' ? 'none' : 'shortcuts';
        this.renderModal();
      }
    });
  }

  private showToast(msg: string, tone: 'info' | 'warn' | 'error' | 'ok' = 'info'): void {
    if (this.toast?.timer) window.clearTimeout(this.toast.timer);
    this.toast = {
      msg,
      tone,
      timer: window.setTimeout(() => {
        this.toast = null;
        this.renderBanner();
      }, 4500)
    };
    this.renderBanner();
  }

  private btn(label: string, onClick: () => void, extraClass = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (extraClass) b.className = extraClass;
    b.addEventListener('click', onClick);
    return b;
  }

  private sep(): HTMLElement {
    const d = document.createElement('div');
    d.className = 'topbar-sep';
    return d;
  }

  private slider(
    label: string,
    min: number,
    max: number,
    step: number,
    initial: number,
    onInput: (v: number) => void,
    onChangeCommit?: (v: number) => void
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'control-row';
    const hdr = document.createElement('div');
    hdr.className = 'control-header';
    const lbl = document.createElement('span');
    lbl.textContent = label;
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = step >= 1 ? String(Math.round(initial)) : initial.toFixed(2);
    hdr.append(lbl, val);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(initial);
    input.addEventListener('input', () => {
      const n = Number(input.value);
      val.textContent = step >= 1 ? String(Math.round(n)) : n.toFixed(2);
      onInput(n);
    });
    if (onChangeCommit) {
      input.addEventListener('change', () => onChangeCommit(Number(input.value)));
    }
    row.append(hdr, input);
    return row;
  }

  private escape(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
