import { el, clear } from './dom';

export interface ModalAction {
  label: string;
  kind?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  onClick: () => void;
}

export interface ModalOptions {
  title: string;
  subtitle?: string;
  body: Node[];
  actions: ModalAction[];
  wide?: boolean;
}

let opener: HTMLElement | null = null;

export function showModal(options: ModalOptions): void {
  const root = document.getElementById('modalRoot');
  if (!root) return;
  const previousFocus = document.activeElement as HTMLElement | null;
  clear(root);
  root.hidden = false;

  const dialog = el('div', {
    class: 'modal',
    role: 'dialog',
    attrs: { 'aria-modal': 'true', 'aria-label': options.title },
  });
  if (options.wide) dialog.style.width = 'min(920px, 100%)';

  const header = el('div', { class: 'modal__head' }, [
    el('div', {}, [
      el('div', { class: 'modal__title', text: options.title }),
      options.subtitle ? el('div', { class: 'modal__sub', text: options.subtitle }) : null,
    ]),
    el('button', {
      class: 'icon-btn',
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>',
      ariaLabel: 'Close dialog',
      on: { click: () => closeModal() },
    }),
  ]);

  const body = el('div', { class: 'modal__body' }, options.body);
  const footer = el(
    'div',
    { class: 'modal__foot' },
    options.actions.map((action) =>
      el('button', {
        class: `btn${action.kind === 'primary' ? ' btn--primary' : action.kind === 'danger' ? ' btn--danger' : ' btn--ghost'}`,
        text: action.label,
        disabled: action.disabled,
        on: { click: action.onClick },
      }),
    ),
  );
  dialog.append(header, body, footer);
  root.append(dialog);

  const first = footer.querySelector<HTMLButtonElement>('.btn--primary, .btn');
  first?.focus();
  root.onclick = (event) => {
    if (event.target === root) closeModal();
  };
  dialog.onkeydown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeModal();
    }
  };
  opener = previousFocus;
  document.addEventListener('keydown', escapeHandler, true);
}

function escapeHandler(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    closeModal();
  }
}

export function closeModal(): void {
  const root = document.getElementById('modalRoot');
  if (!root) return;
  root.hidden = true;
  clear(root);
  document.removeEventListener('keydown', escapeHandler, true);
  opener?.focus?.();
  opener = null;
}
