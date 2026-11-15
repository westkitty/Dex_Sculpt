/**
 * Inspector panels. Each tab is a pure render of `Studio` state; controls call
 * back into the controller so there is one source of truth for edits.
 */
import { el, clear, slider, section, emptyNote } from './dom';
import { formatBytes, formatDuration } from '../core/util';
import { recipeSummary } from '../project/recipe';
import { compatibilityNote, familyOf, sourceOf } from '../catalog/catalog';
import type { Studio } from '../app/studio';
import type { Bone } from 'three';
import type { Character, MaterialSlot, MeshRecord } from '../character/character';

export function renderInspector(studio: Studio): void {
  const host = document.getElementById('inspectorBody');
  if (!host) return;
  clear(host);
  const character = studio.character;
  if (!character) {
    host.append(
      emptyNote('No character loaded', 'Pick a bundled example, relink a catalog record, or import your own GLB.'),
      el('button', { class: 'btn btn--block', text: 'Import local GLB…', on: { click: () => (document.getElementById('fileInput') as HTMLInputElement).click() } }),
    );
    return;
  }
  switch (studio.state.tab) {
    case 'appearance':
      host.append(...appearancePanel(studio, character));
      break;
    case 'rig':
      host.append(...rigPanel(studio, character));
      break;
    case 'animate':
      host.append(...animatePanel(studio, character));
      break;
    case 'attach':
      host.append(...attachPanel(studio, character));
      break;
    case 'project':
      host.append(...projectPanel(studio, character));
      break;
  }
}

function kv(rows: [string, string][]): HTMLElement {
  const dl = el('dl', { class: 'kv' });
  for (const [key, value] of rows) {
    dl.append(el('dt', { text: key }), el('dd', { text: value }));
  }
  return dl;
}

function button(label: string, onClick: () => void, opts: { kind?: 'primary' | 'ghost' | 'danger'; disabled?: boolean; title?: string; block?: boolean } = {}): HTMLButtonElement {
  return el('button', {
    class: `btn${opts.kind === 'primary' ? ' btn--primary' : opts.kind === 'danger' ? ' btn--danger' : ' btn--ghost'}${opts.block ? ' btn--block' : ''}`,
    text: label,
    title: opts.title ?? label,
    disabled: opts.disabled,
    on: { click: onClick },
  }) as HTMLButtonElement;
}

// ------------------------------------------------------------------ appearance

function appearancePanel(studio: Studio, character: Character): Node[] {
  const nodes: Node[] = [];
  const sculptedGroups = character.meshes.reduce((acc, record) => {
    let count = 0;
    for (let g = 0; g < record.weld.groupCount; g++) {
      const rep = record.weld.groupList[record.weld.groupStart[g]];
      if (record.delta[rep * 3] !== 0 || record.delta[rep * 3 + 1] !== 0 || record.delta[rep * 3 + 2] !== 0) count++;
    }
    return acc + count;
  }, 0);
  const mask = character.maskCoverage();

  nodes.push(
    section('Sculpt state', [
      kv([
        ['Edited weld groups', sculptedGroups.toLocaleString()],
        ['Frozen (masked)', `${(mask * 100).toFixed(2)}%`],
        ['Source geometry', `${character.meshes.reduce((a, m) => a + m.vertexCount, 0).toLocaleString()} verts`],
        ['Rig', character.bones.length ? `${character.bones.length} bones · untouched` : 'none'],
      ]),
      el('div', { class: 'grid-2' }, [
        button('Reset sculpt', () => studio.resetSculpt(), { kind: 'ghost', title: 'Clear every sculpt delta and restore the imported positions (undoable)' }),
        button('Clear mask', () => studio.clearMask(), { kind: 'ghost', disabled: mask <= 0.0001, title: 'Unfreeze every vertex' }),
      ]),
      el('p', { class: 'section__hint', text: 'Sculpt deltas live beside the imported mesh. Resetting them restores the exact source positions; weights, morphs and clips are untouched.' }),
    ]),
  );

  nodes.push(morphSection(studio, character, 'Body & face shape', 'Morph target sliders drive the file\'s own shape keys. They are exported as morph targets, never baked into the base mesh.'));

  const materialNodes: Node[] = [];
  for (const record of character.meshes) {
    for (const slot of record.materialSlots) {
      materialNodes.push(materialRow(studio, slot, record));
    }
  }
  nodes.push(
    section(
      'Materials',
      materialNodes.length
        ? materialNodes
        : [emptyNote('No editable materials', 'This file has no MeshStandardMaterial slots that DEX//SCULPT can safely override.')],
      'Colour and roughness overrides are stored in the project recipe, not baked into geometry.',
    ),
  );
  return nodes;
}

function morphSection(studio: Studio, character: Character, title: string, hint: string): HTMLElement {
  const rows: Node[] = [];
  for (const record of character.meshes) {
    if (!record.morphTargets.length) continue;
    rows.push(el('div', { class: 'rail__group-label', text: record.name }));
    for (const target of record.morphTargets) {
      const current = character.getMorphWeight(record, target.name);
      const control = slider({
        label: target.name,
        value: current,
        min: 0,
        max: Math.max(1, Math.ceil(current)),
        step: 0.01,
        format: (v) => v.toFixed(2),
        onChange: (value) => studio.setMorphWeight(record, target.name, value, false),
        onCommit: (value) => studio.setMorphWeight(record, target.name, value, true),
      });
      (control.querySelector('input') as HTMLInputElement).dataset.morph = `${record.id}:${target.name}`;
      const reset = el('button', {
        class: 'icon-btn icon-btn--sm',
        html: '↺',
        title: `Reset ${target.name}`,
        ariaLabel: `Reset ${target.name}`,
        on: { click: () => studio.resetMorph(record, target.name) },
      });
      rows.push(el('div', { class: 'inline' }, [control, reset]));
    }
  }
  if (!rows.length) {
    rows.push(
      emptyNote(
        'No morph targets',
        character.countStats().bones
          ? 'This character has no shape keys. Body and face shape controls are therefore unavailable — every control that would need one is disabled rather than faked.'
          : 'This unrigged mesh has no morph targets, so there is nothing to slide.',
      ),
    );
  }
  return section(title, rows, hint);
}

function materialRow(studio: Studio, slot: MaterialSlot, record: MeshRecord): HTMLElement {
  const swatch = el('input', { type: 'color', value: slot.colorHex, title: `Base colour of ${slot.name}` }) as HTMLInputElement;
  swatch.dataset.material = `${slot.name}:color`;
  swatch.addEventListener('input', () => studio.setMaterial(slot, { colorHex: swatch.value }, false));
  swatch.addEventListener('change', () => studio.setMaterial(slot, { colorHex: swatch.value }, true));

  const roughness = slider({
    label: 'Roughness',
    value: slot.roughness,
    min: 0.05,
    max: 1,
    step: 0.01,
    onChange: (value) => studio.setMaterial(slot, { roughness: value }, false),
    onCommit: (value) => studio.setMaterial(slot, { roughness: value }, true),
  });
  (roughness.querySelector('input') as HTMLInputElement).dataset.material = `${slot.name}:roughness`;

  const metalness = slider({
    label: 'Metalness',
    value: slot.metalness,
    min: 0,
    max: 1,
    step: 0.01,
    onChange: (value) => studio.setMaterial(slot, { metalness: value }, false),
    onCommit: (value) => studio.setMaterial(slot, { metalness: value }, true),
  });
  (metalness.querySelector('input') as HTMLInputElement).dataset.material = `${slot.name}:metalness`;

  return el('div', { class: 'section' }, [
    el('div', { class: 'section__head' }, [
      el('div', { class: 'section__title', text: `${record.name} · ${slot.name}` }),
      el('span', { class: 'badge', text: slot.overridden ? 'overridden' : 'base' }),
    ]),
    el('div', { class: 'swatch-row' }, [
      swatch,
      el('span', { class: 'field__meta', text: slot.colorHex }),
      button('Reset', () => studio.resetMaterial(slot), { kind: 'ghost', disabled: !slot.overridden }),
    ]),
    roughness,
    metalness,
  ]);
}

// ------------------------------------------------------------------------- rig

function rigPanel(studio: Studio, character: Character): Node[] {
  if (!character.bones.length) {
    return [
      emptyNote(
        'No skeleton in this file',
        'Skinning, bone inspection and animation are unavailable because the imported GLB contains no skin. Sculpting and export still work, and the export preserves that fact.',
      ),
    ];
  }
  const nodes: Node[] = [];
  const family = character.meta.skeletonFamily ?? null;
  const catalogFamily = familyOf(studio.catalog, family);
  nodes.push(
    section('Skeleton', [
      kv([
        ['Bones', `${character.bones.length}`],
        ['Skin joints', `${character.skeleton?.bones.length ?? 0}`],
        ['Inverse bind matrices', `${character.skeleton?.boneInverses.length ?? 0}`],
        ['Skeleton family', family ?? 'not declared'],
        ['Max weight-sum error', character.meshes.some((m) => m.skinned) ? maxWeightError(character).toFixed(6) : 'n/a'],
        ['Skin source', character.meta.catalogId ?? character.meta.fileName ?? 'generated fixture'],
      ]),
      el('p', { class: 'section__hint', text: compatibilityNote(studio.catalog, family) }),
      catalogFamily?.authoringConvention
        ? el('p', { class: 'section__hint', text: `Authoring convention: ${catalogFamily.authoringConvention}` })
        : null,
      el('div', { class: 'grid-2' }, [
        button('Bind pose', () => studio.resetBindPose(), { title: 'Drop out of the clip and restore the imported bind pose' }),
        button('Skeleton overlay', () => studio.toggleSkeleton(), { title: 'Toggle the bone overlay in the viewport' }),
      ]),
    ]),
  );

  const selected = character.bones.find((b) => b.name === studio.state.selectedBone) ?? null;
  const boneRows: Node[] = [];
  const depthOf = (bone: Bone): number => {
    let depth = 0;
    let parent = bone.parent;
    while (parent && character.bones.includes(parent as Bone)) {
      depth++;
      parent = parent.parent;
    }
    return Math.min(depth, 8);
  };
  const sorted = character.bones;
  for (const bone of sorted) {
    const isSelected = selected === bone;
    boneRows.push(
      el('button', {
        class: 'tree-item',
        ariaSelected: isSelected,
        attrs: { style: `padding-left:${8 + depthOf(bone) * 12}px` },
        title: `${bone.name} · ${bone.children.length} child bone(s)`,
        on: { click: () => studio.selectBone(bone.name) },
      }, [
        el('span', { class: 'tree-caret', text: isSelected ? '▾' : '▸' }),
        el('span', { text: bone.name }),
        el('span', { class: 'field__meta', text: `${bone.children.length}` }),
      ]),
    );
  }
  nodes.push(section('Bone tree', boneRows, 'Click a bone to highlight it in the viewport. Editing never renames or reparents bones.'));

  if (selected) {
    nodes.push(
      section('Selected bone', [
        kv([
          ['Name', selected.name],
          ['Parent', selected.parent?.name ?? 'scene root'],
          ['Children', `${selected.children.filter((c) => character.bones.includes(c as Bone)).length}`],
          ['Local position', formatVec(selected.position)],
          ['Local rotation', formatQuat(selected.quaternion)],
          ['Skin joint index', `${character.skeleton?.bones.indexOf(selected) ?? -1}`],
        ]),
      ]),
    );
  }
  return nodes;
}

function maxWeightError(character: Character): number {
  let max = 0;
  for (const record of character.meshes) {
    if (!record.skinned) continue;
    max = Math.max(max, record.weightSumMaxError);
  }
  return max;
}

function formatVec(v: { x: number; y: number; z: number }): string {
  return `${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}`;
}

function formatQuat(q: { x: number; y: number; z: number; w: number }): string {
  return `${q.x.toFixed(3)}, ${q.y.toFixed(3)}, ${q.z.toFixed(3)}, ${q.w.toFixed(3)}`;
}

// --------------------------------------------------------------------- animate

function animatePanel(studio: Studio, character: Character): Node[] {
  const nodes: Node[] = [];
  if (!character.clips.length) {
    nodes.push(
      emptyNote(
        'No animation clips',
        character.bones.length
          ? 'The skeleton imported correctly but the file contains no AnimationClips. Rig inspection still works; playback controls stay disabled rather than simulating motion.'
          : 'There is no skeleton, so there is nothing to animate.',
      ),
    );
    nodes.push(morphSection(studio, character, 'Morph inspection', 'Shape keys can still be exercised on a static mesh.'));
    return nodes;
  }

  const clipRows: Node[] = character.clips.map((clip) => {
    const active = character.activeClip === clip.name;
    return el('button', {
      class: 'list-item',
      ariaSelected: active,
      dataset: { clip: clip.name },
      title: `Play ${clip.name}`,
      on: { click: () => studio.playClip(clip.name) },
    }, [
      el('span', { text: `${active ? '▶ ' : ''}${clip.name}` }),
      el('span', { class: 'list-item__mono', text: `${formatDuration(clip.duration)} · ${clip.tracks.length} tracks` }),
    ]);
  });
  nodes.push(section('Clips', clipRows, 'Every clip is preserved verbatim by the exporter; sculpting never touches track data.'));

  const duration = character.clips.find((c) => c.name === character.activeClip)?.duration ?? character.clips[0].duration;
  const playing = studio.state.playing;
  const transport = el('div', { class: 'transport' }, [
    button(playing ? 'Pause' : 'Play', () => studio.togglePlayback(), { kind: 'primary', title: 'Play or pause the active clip (Space)' }),
    button('Bind pose', () => studio.resetBindPose(), { title: 'Stop playback and restore the imported bind pose' }),
  ]);
  const playhead = el('input', {
    type: 'range',
    id: 'timelineScrub',
    min: 0,
    max: duration,
    step: 0.01,
    value: studio.state.time,
    ariaLabel: 'Scrub the animation clip',
  }) as HTMLInputElement;
  playhead.addEventListener('input', () => studio.setClipTime(Number(playhead.value)));
  const fill = el('span', { id: 'timelineFill' });
  fill.style.width = `${Math.min(100, (studio.state.time / duration) * 100)}%`;
  const timeLabel = el('span', { id: 'timelineTime', class: 'field__meta', text: `${studio.state.time.toFixed(2)} / ${duration.toFixed(2)}s` });
  const timeline = el('div', { class: 'timeline' }, [
    el('div', { class: 'timeline__bar' }, [fill]),
    playhead,
    el('div', { class: 'timeline__ticks' }, [timeLabel]),
  ]);
  const speed = slider({
    label: 'Speed',
    value: studio.state.speed,
    min: 0.1,
    max: 2,
    step: 0.05,
    format: (v) => `${v.toFixed(2)}×`,
    onChange: (value) => studio.setSpeed(value),
  });
  (speed.querySelector('input') as HTMLInputElement).dataset.setting = 'speed';
  nodes.push(section('Playback', [transport, timeline, speed], `Active clip: ${character.activeClip ?? 'none (bind pose)'}`));

  const probe = studio.state.probe;
  nodes.push(
    section(
      'Deformation probe',
      [
        button('Run probe on edited mesh', () => studio.runDeformationProbe(), { kind: 'primary', title: 'Compare a vertex in bind pose and mid-clip, using the preserved skin weights' }),
        probe
          ? kv([
              ['Vertex', `${probe.mesh} #${probe.vertex}`],
              ['Bind pose', `${probe.bind.map((v) => v.toFixed(3)).join(', ')}`],
              ['At ' + probe.time.toFixed(2) + 's', `${probe.posed.map((v) => v.toFixed(3)).join(', ')}`],
              ['Movement', `${(probe.moved * 1000).toFixed(1)} mm`],
              ['Verdict', probe.moved > 0.004 ? 'skin still deforms the mesh' : 'no deformation measured — investigate'],
            ])
          : el('p', { class: 'section__hint', text: 'Runs in the editor: takes a vertex from the largest skinned mesh, samples it in bind pose, then samples the same vertex mid-clip. Uses the file\'s own skin weights.' }),
      ],
    ),
  );

  nodes.push(morphSection(studio, character, 'Morph inspection', 'Verify that shape keys still move the geometry after sculpting.'));
  return nodes;
}

// ---------------------------------------------------------------------- attach

function attachPanel(studio: Studio, character: Character): Node[] {
  const nodes: Node[] = [];
  const input = el('input', { id: 'attachmentInput', type: 'file', hidden: true }) as HTMLInputElement;
  input.accept = '.glb,model/gltf-binary';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void studio.addAttachmentFile(file);
    input.value = '';
  });

  nodes.push(
    section(
      'Modular assembly',
      [
        el('p', { class: 'section__hint', text: 'Bone-attached props are rigid: the accessory follows a single joint and keeps its own transform. Skinned clothing is accepted only when its joints all exist on this skeleton. Morph-compatible parts must share the host morph dictionary.' }),
        button('Attach accessory GLB…', () => input.click(), { kind: 'primary', block: true, title: 'Inspect a rigid prop and bind it to the selected bone' }),
        button('Check clearance', () => {
          const first = character.attachments[0];
          if (first) studio.runClearanceCheck(first.id);
        }, { block: true, disabled: !character.attachments.length, title: 'Measure accessory vertices against the host surface' }),
        input,
        studio.attachmentCompat
          ? kv([
              ['Mode', studio.attachmentCompat.mode],
              ['Skinned', studio.attachmentCompat.skinned ? 'yes' : 'no'],
              ['Joints', `${studio.attachmentCompat.jointCount}`],
              ['Meshes', `${studio.attachmentCompat.meshCount}`],
              ['Vertices', `${studio.attachmentCompat.vertexCount}`],
            ])
          : null,
        studio.clearance
          ? el('p', {
              class: `banner banner--${studio.clearance.verdict === 'clipping' ? 'fail' : studio.clearance.verdict === 'touching' ? 'warn' : 'ok'}`,
              text: `${studio.clearance.verdict}: ${studio.clearance.detail}`,
            })
          : null,
      ],
    ),
  );

  const list: Node[] = [];
  for (const attachment of character.attachments) {
    const pos = attachment.root.position;
    const num = (axis: 'x' | 'y' | 'z') => {
      const control = el('input', { type: 'number', step: 0.01, value: Number(pos[axis].toFixed(3)), ariaLabel: `${axis} offset` }) as HTMLInputElement;
      control.dataset.attachPos = `${attachment.id}:${axis}`;
      control.addEventListener('change', () => {
        const next: [number, number, number] = [pos.x, pos.y, pos.z];
        next[axis === 'x' ? 0 : axis === 'y' ? 1 : 2] = Number(control.value);
        studio.updateAttachment(attachment.id, { position: next });
      });
      return control;
    };
    const scale = slider({
      label: 'Scale',
      value: attachment.root.scale.x,
      min: 0.2,
      max: 3,
      step: 0.01,
      onChange: (value) => studio.updateAttachment(attachment.id, { scale: [value, value, value] }),
    });
    (scale.querySelector('input') as HTMLInputElement).dataset.attachScale = attachment.id;
    list.push(
      el('div', { class: 'section' }, [
        el('div', { class: 'section__head' }, [
          el('div', { class: 'section__title', text: attachment.name }),
          el('span', { class: 'badge badge--accent', text: attachment.boneName }),
        ]),
        el('div', { class: 'grid-3' }, [num('x'), num('y'), num('z')]),
        scale,
        el('div', { class: 'grid-2' }, [
          button('Measure', () => studio.runClearanceCheck(attachment.id), { kind: 'ghost' }),
          button('Remove', () => studio.removeAttachment(attachment.id), { kind: 'danger' }),
        ]),
      ]),
    );
  }
  nodes.push(
    section(
      'Attached props',
      list.length ? list : [emptyNote('No accessories attached', 'Import a prop GLB (for example the Foundry Visor example) and bind it to a bone.')],
    ),
  );

  const family = character.meta.skeletonFamily ?? null;
  nodes.push(
    section('Compatibility', [
      el('p', { class: 'section__hint', text: compatibilityNote(studio.catalog, family) }),
      el('p', {
        class: 'section__hint',
        text: 'Retargeting between families is out of scope for v0.1. Loading a clip from a different skeleton family is blocked rather than silently re-parented.',
      }),
    ]),
  );
  return nodes;
}

// --------------------------------------------------------------------- project

function projectPanel(studio: Studio, character: Character): Node[] {
  const nodes: Node[] = [];
  const recipe = studio.lastRecipe;
  nodes.push(
    section('Source', [
      kv([
        ['File', character.meta.fileName ?? 'generated fixture'],
        ['Kind', character.meta.sourceKind],
        ['Bytes', character.meta.byteLength ? formatBytes(character.meta.byteLength) : '—'],
        ['Source hash', character.meta.fileHash ? character.meta.fileHash.slice(0, 16) + '…' : '—'],
        ['Skeleton family', character.meta.skeletonFamily ?? 'not declared'],
        ['Licence', character.meta.license ?? 'not recorded'],
        ['Provenance', character.meta.provenance ?? 'not recorded'],
      ]),
      el('p', { class: 'section__hint', text: 'Nothing here is uploaded. Projects live in IndexedDB on this device; the source model is stored alongside the recipe so reopening needs no network.' }),
    ]),
  );

  nodes.push(
    section('Save & export', [
      el('div', { class: 'grid-2' }, [
        button('Save project', () => void studio.saveProject(), { kind: 'primary', title: 'Store the recipe and source model in IndexedDB (⌘S)' }),
        button('Export GLB + verify', () => void studio.exportAndVerify(), { kind: 'primary', title: 'Export, run the structural validator, then re-import' }),
      ]),
      studio.lastExport ? exportSummary(studio) : el('p', { class: 'section__hint', text: 'Export verifies structure (19 checks) and re-imports the file with a fresh GLTFLoader (8 checks) before offering a download.' }),
    ]),
  );

  const recipeInput = el('input', { type: 'file', hidden: true }) as HTMLInputElement;
  recipeInput.accept = '.json,application/json';
  recipeInput.addEventListener('change', () => {
    const file = recipeInput.files?.[0];
    if (file) void studio.importRecipeFile(file);
    recipeInput.value = '';
  });
  nodes.push(
    section(
      'Recipe',
      [
        el('div', { class: 'grid-2' }, [
          button('Download recipe JSON', () => studio.downloadRecipe(), { title: 'Metadata + sculpt deltas + provenance, no mesh binary unless it fits the 8 MB embed limit' }),
          button('Open recipe…', () => recipeInput.click(), { kind: 'ghost', title: 'Reopen a saved recipe; the source model is embedded or relinked' }),
        ]),
        recipeInput,
        recipe
          ? kv([
              ['Schema', recipe.schema],
              ['Sculpt groups', `${recipe.stats.changedGroups}`],
              ['Recipe size', formatBytes(recipe.stats.recipeBytes)],
              ['Source embedded', recipe.source.embeddedBase64 ? 'yes' : 'no — relink on reopen'],
              ['Attachments', `${recipe.attachments.length}`],
            ])
          : el('p', { class: 'section__hint', text: 'Save once to materialise a recipe; it records the source hash, skeleton family, morph weights, material overrides, sculpt deltas, attachments, editor version and licence.' }),
        recipe ? el('p', { class: 'section__hint', text: recipeSummary(recipe) }) : null,
      ],
      'A recipe is portable and human-readable: it references the source asset by hash and stores only what you changed.',
    ),
  );

  const projectRows: Node[] = studio.projects.map((project) => {
    const when = new Date(project.updatedAt);
    return el('div', { class: 'list-item' }, [
      el('div', {}, [
        el('div', { text: project.name }),
        el('div', { class: 'field__meta', text: `${when.toLocaleString()} · ${project.sculptGroups} sculpted groups · ${project.hasSource ? 'source stored' : 'source missing'}` }),
      ]),
      el('div', { class: 'inline' }, [
        button('Open', () => void studio.openProject(project.id), { kind: 'ghost' }),
        button('Delete', () => void studio.deleteProject(project.id), { kind: 'danger' }),
      ]),
    ]);
  });
  nodes.push(
    section(
      'Projects on this device',
      [
        projectRows.length ? el('div', { class: 'list' }, projectRows) : emptyNote('No saved projects', 'Saving stores the recipe plus the source GLB in IndexedDB, so this list stays empty until you save.'),
        el('p', {
          class: 'section__hint',
          text: `Storage: ${studio.store.mode === 'indexeddb' ? 'IndexedDB' : 'memory only (this session)'}${studio.store.lastError ? ` — ${studio.store.lastError}` : ''}`,
        }),
      ],
    ),
  );

  const source = studio.catalog && character.meta.catalogId ? sourceOf(studio.catalog, character.meta.catalogId.split('/')[0]) : undefined;
  if (source) {
    nodes.push(section('Catalog provenance', [kv([
      ['Record', character.meta.catalogId ?? ''],
      ['Upstream source', source.name],
      ['Upstream licence', source.license ?? 'unknown'],
      ['Upstream access', source.access ?? 'not recorded'],
    ])], 'The catalog supplies metadata only; the binary in this project came from a file you supplied.'));
  }
  return nodes;
}

function exportSummary(studio: Studio): HTMLElement {
  const artifact = studio.lastExport!;
  const structuralPass = artifact.report.checks.filter((c) => c.status === 'pass').length;
  const reimportPass = artifact.reimport.checks.filter((c) => c.status === 'pass').length;
  return el('div', {}, [
    el('div', { class: `banner banner--${artifact.report.ok && artifact.reimport.ok ? 'ok' : 'fail'}` }, [
      el('strong', { text: artifact.report.ok && artifact.reimport.ok ? 'Last export verified' : 'Last export failed' }),
      el('span', { text: `${artifact.fileName} · ${formatBytes(artifact.bytes.byteLength)} · structural ${structuralPass}/${artifact.report.checks.length} · re-import ${reimportPass}/${artifact.reimport.checks.length}` }),
    ]),
    el('div', { class: 'grid-2' }, [
      button('View full report', () => studio.showExportReport(), { kind: 'ghost' }),
    ]),
  ]);
}
