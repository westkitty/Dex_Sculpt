/** Tiny DOM helpers. No framework: the studio re-renders panels from state. */

export type El = HTMLElement;

export interface ElProps {
  class?: string;
  text?: string;
  html?: string;
  title?: string;
  id?: string;
  type?: string;
  value?: string | number;
  placeholder?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  disabled?: boolean;
  hidden?: boolean;
  role?: string;
  ariaLabel?: string;
  ariaPressed?: boolean;
  ariaCurrent?: string;
  ariaSelected?: boolean;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap | string, EventListener>>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.html !== undefined) node.innerHTML = props.html;
  if (props.title) node.title = props.title;
  if (props.id) node.id = props.id;
  if (props.type) node.setAttribute('type', props.type);
  if (props.placeholder) node.setAttribute('placeholder', props.placeholder);
  if (props.role) node.setAttribute('role', props.role);
  if (props.ariaLabel) node.setAttribute('aria-label', props.ariaLabel);
  if (props.ariaPressed !== undefined) node.setAttribute('aria-pressed', String(props.ariaPressed));
  if (props.ariaSelected !== undefined) node.setAttribute('aria-selected', String(props.ariaSelected));
  if (props.ariaCurrent !== undefined) node.setAttribute('aria-current', props.ariaCurrent);
  if (props.disabled) (node as HTMLButtonElement & HTMLInputElement).disabled = true;
  if (props.hidden) node.hidden = true;
  if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) node.dataset[k] = v;
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  if (props.value !== undefined) (node as HTMLInputElement).value = String(props.value);
  if (props.min !== undefined) (node as HTMLInputElement).min = String(props.min);
  if (props.max !== undefined) (node as HTMLInputElement).max = String(props.max);
  if (props.step !== undefined) (node as HTMLInputElement).step = String(props.step);
  if (props.on) {
    for (const [key, handler] of Object.entries(props.on)) {
      if (handler) node.addEventListener(key, handler as EventListener);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function setRangeFill(input: HTMLInputElement): void {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value);
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct))}%`);
}

/** A labelled slider with live numeric readout. */
export function slider(opts: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  disabled?: boolean;
  hint?: string;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
}): HTMLElement {
  const format = opts.format ?? ((v: number) => v.toFixed(2));
  const input = el('input', {
    type: 'range',
    min: opts.min,
    max: opts.max,
    step: opts.step,
    value: opts.value,
    disabled: opts.disabled,
    on: {
      input: () => {
        const value = Number(input.value);
        readout.textContent = format(value);
        setRangeFill(input);
        opts.onChange(value);
      },
      change: () => {
        opts.onCommit?.(Number(input.value));
      },
    },
  }) as HTMLInputElement;
  const readout = el('b', { text: format(opts.value) });
  setRangeFill(input);
  return el('div', { class: 'field', title: opts.hint }, [
    el('div', { class: 'field__row' }, [el('span', { class: 'field__label', text: opts.label }), readout]),
    input,
  ]);
}

export function toggleButton(opts: {
  label: string;
  pressed: boolean;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
}): HTMLButtonElement {
  return el('button', {
    class: 'view-btn',
    text: opts.label,
    title: opts.title ?? opts.label,
    ariaPressed: opts.pressed,
    disabled: opts.disabled,
    on: { click: opts.onClick },
  }) as HTMLButtonElement;
}

export function iconButton(opts: {
  icon: string;
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  small?: boolean;
  onClick: () => void;
}): HTMLButtonElement {
  return el('button', {
    class: `icon-btn${opts.small ? ' icon-btn--sm' : ''}`,
    html: opts.icon,
    title: opts.label,
    ariaLabel: opts.label,
    ariaPressed: opts.pressed,
    disabled: opts.disabled,
    on: { click: opts.onClick },
  }) as HTMLButtonElement;
}

export function checkRow(status: 'pass' | 'fail' | 'warn', label: string, detail: string): HTMLElement {
  const symbol = status === 'pass' ? '✓' : status === 'fail' ? '✕' : '!';
  return el('div', { class: `check check--${status}` }, [
    el('span', { class: 'check__dot', text: symbol }),
    el('div', {}, [el('div', { class: 'check__label', text: label }), el('div', { class: 'check__detail', text: detail })]),
  ]);
}

export function section(title: string, children: (Node | null | undefined)[], hint?: string): HTMLElement {
  return el('div', { class: 'section' }, [
    el('div', { class: 'section__head' }, [el('div', { class: 'section__title', text: title })]),
    hint ? el('p', { class: 'section__hint', text: hint }) : null,
    ...children,
  ]);
}

export function emptyNote(title: string, body: string): HTMLElement {
  return el('div', { class: 'empty-note' }, [el('strong', { text: title }), document.createTextNode(body)]);
}
