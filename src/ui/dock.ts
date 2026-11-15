/** Sculpt tool dock (only mounted in sculpt mode). */
import { el, clear, slider } from './dom';
import { icons } from './icons';
import { BRUSHES, type BrushId } from '../sculpt/engine';
import type { Studio } from '../app/studio';

const ICONS: Record<BrushId, string> = {
  clay: icons.clay,
  draw: icons.draw,
  smooth: icons.smooth,
  inflate: icons.inflate,
  crease: icons.crease,
  grab: icons.grab,
  mask: icons.mask,
};

const HINTS: Record<BrushId, string> = {
  clay: 'Flat-topped build-up',
  draw: 'Raise along normals',
  smooth: 'Relax seams',
  inflate: 'Add volume',
  crease: 'Pinch and cut',
  grab: 'Drag a region',
  mask: 'Freeze painted area',
};

export function renderToolDock(studio: Studio): void {
  const dock = document.getElementById('toolDock');
  if (!dock) return;
  clear(dock);
  const state = studio.state;
  const character = studio.character;

  const tools = el(
    'div',
    { class: 'dock__tools', role: 'group', ariaLabel: 'Sculpt brushes' },
    BRUSHES.map((brush) =>
      el('button', {
        class: 'tool-btn',
        title: `${brush.label} (${brush.key}) — ${brush.hint}`,
        ariaPressed: state.tool === brush.id,
        dataset: { tool: brush.id },
        disabled: !character,
      }, [
        el('span', { html: ICONS[brush.id] }),
        el('span', { text: brush.label }),
        el('span', { class: 'tool-key', text: brush.key }),
      ]),
    ),
  );

  const radius = slider({
    label: 'Radius',
    value: state.radiusPx,
    min: 6,
    max: 260,
    step: 1,
    format: (v) => `${Math.round(v)} px`,
    disabled: !character,
    onChange: (value) => {
      state.radiusPx = value;
    },
    onCommit: () => studio.updateCursorFromLastHit(),
  });
  (radius.querySelector('input') as HTMLInputElement).dataset.setting = 'radius';

  const strength = slider({
    label: 'Strength',
    value: state.strength,
    min: 0.05,
    max: 1,
    step: 0.01,
    format: (v) => v.toFixed(2),
    disabled: !character,
    onChange: (value) => {
      state.strength = value;
    },
  });
  (strength.querySelector('input') as HTMLInputElement).dataset.setting = 'strength';

  const sliders = el('div', { class: 'dock__sliders' }, [radius, strength]);

  const toggle = (opts: { key: string; label: string; pressed: boolean; title: string; disabled?: boolean }) =>
    el('button', {
      class: 'view-btn',
      text: opts.label,
      title: opts.title,
      ariaPressed: opts.pressed,
      disabled: opts.disabled,
      dataset: { toggle: opts.key },
    });

  const toggles = el('div', { class: 'dock__toggles' }, [
    toggle({ key: 'symmetry', label: 'Mirror X', pressed: state.symmetryX, title: 'Mirror strokes across the character X axis (X)' }),
    toggle({ key: 'pressure', label: 'Pressure', pressed: state.usePressure, title: 'Use pen pressure to modulate strength' }),
    toggle({ key: 'maskview', label: 'Mask view', pressed: state.showMask, title: 'Show the freeze mask as points' }),
    toggle({
      key: 'finger',
      label: 'Finger sculpts',
      pressed: state.fingerSculpts,
      title: 'Off: fingers orbit, pan and zoom (pen or mouse sculpts). On: a single finger sculpts when no pen is present.',
    }),
  ]);

  const hint = el('div', { class: 'dock__hint', text: HINTS[state.tool] });
  const sep = () => el('div', { class: 'dock__sep' });
  dock.append(tools, sep(), sliders, sep(), toggles, hint);
}
