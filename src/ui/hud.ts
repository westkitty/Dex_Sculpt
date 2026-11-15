/** Viewport HUD: character stat chips and the view control cluster. */
import { el, clear } from './dom';
import { icons } from './icons';
import type { Studio } from '../app/studio';

export function renderChips(studio: Studio): void {
  const host = document.getElementById('characterChips');
  if (!host) return;
  clear(host);
  const character = studio.character;
  if (!character) return;
  const stats = character.countStats();
  const chip = (label: string, value: string, kind?: 'accent' | 'warn') =>
    el('span', { class: `stat-chip${kind ? ` stat-chip--${kind}` : ''}` }, [
      document.createTextNode(label),
      el('strong', { text: value }),
    ]);

  host.append(chip('', character.meta.fileName ?? character.meta.fixtureId ?? 'character'));
  host.append(chip('verts', stats.vertices.toLocaleString()));
  host.append(chip('tris', stats.triangles.toLocaleString()));
  if (stats.bones) host.append(chip('bones', String(stats.bones), 'accent'));
  if (stats.clips) host.append(chip('clips', String(stats.clips), 'accent'));
  if (stats.morphTargets) host.append(chip('morphs', String(stats.morphTargets), 'accent'));
  if (!stats.bones) host.append(chip('rig', 'none', 'warn'));
  if (studio.loadedCatalogAsset) {
    host.append(chip('catalog', studio.loadedCatalogAsset.name, 'accent'));
  }
  const mask = character.maskCoverage();
  if (mask > 0.001) host.append(chip('mask', `${(mask * 100).toFixed(1)}%`, 'warn'));
  if (studio.state.compare) host.append(chip('', 'show–ing source', 'warn'));
}

export function renderViewControls(studio: Studio): void {
  const host = document.getElementById('viewControls');
  if (!host) return;
  clear(host);
  const state = studio.state;
  const button = (opts: {
    view: string;
    label: string;
    title: string;
    icon?: string;
    pressed?: boolean;
    disabled?: boolean;
  }) =>
    el('button', {
      class: 'view-btn',
      title: opts.title,
      ariaLabel: opts.title,
      ariaPressed: opts.pressed,
      disabled: opts.disabled,
      dataset: { view: opts.view },
    }, [opts.icon ? el('span', { html: opts.icon }) : document.createTextNode(opts.label)]);

  const orthographic = state.projection === 'ortho';
  const row1 = el('div', { class: 'view-group' }, [
    button({ view: 'front', label: 'F', title: 'Front view (orthographic-friendly)' }),
    button({ view: 'side', label: 'S', title: 'Side view' }),
    button({ view: 'back', label: 'B', title: 'Back view' }),
    button({ view: 'top', label: 'T', title: 'Top view' }),
  ]);
  const row2 = el('div', { class: 'view-group' }, [
    button({
      view: 'projection',
      label: orthographic ? 'O' : 'P',
      title: `Switch to ${orthographic ? 'perspective' : 'orthographic'} camera (P)`,
      icon: orthographic ? icons.ortho : icons.perspective,
      pressed: orthographic,
    }),
    button({ view: 'frame', label: 'F', title: 'Frame character (F)', icon: icons.frame }),
    button({ view: 'reset', label: 'R', title: 'Reset camera (R)', icon: icons.reset }),
  ]);
  const row3 = el('div', { class: 'view-group' }, [
    button({ view: 'grid', label: 'G', title: 'Toggle grid (G)', icon: icons.grid, pressed: state.grid }),
    button({ view: 'axes', label: 'A', title: 'Toggle axes', icon: icons.layers, pressed: state.axes }),
    button({
      view: 'skeleton',
      label: 'B',
      title: 'Toggle skeleton overlay',
      icon: icons.bone,
      pressed: studio.viewport.skeletonVisible(),
      disabled: !studio.character?.bones.length,
    }),
    button({
      view: 'light',
      label: 'L',
      title: `Lighting preset: ${state.light} (click to cycle)`,
      icon: icons.camera,
    }),
  ]);
  host.append(row1, row2, row3);
}
