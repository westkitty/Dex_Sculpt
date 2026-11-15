import { describe, it, expect } from 'vitest';
import { History, type Command } from '../src/app/history';

function counterCommand(state: { value: number }, next: number, label = 'step'): Command {
  const before = state.value;
  const command: Command = {
    label,
    bytes: 16,
    undo: () => {
      state.value = before;
    },
    redo: () => {
      state.value = next;
    },
  };
  return command;
}

describe('undo history', () => {
  it('undoes and redoes commands in order', () => {
    const state = { value: 0 };
    const history = new History();
    history.push(counterCommand(state, 1));
    state.value = 1;
    history.push(counterCommand(state, 2));
    state.value = 2;
    expect(history.size).toBe(2);
    expect(history.undoLabel).toBe('step');

    history.undo();
    expect(state.value).toBe(1);
    history.undo();
    expect(state.value).toBe(0);
    expect(history.canUndo).toBe(false);

    history.redo();
    expect(state.value).toBe(1);
    history.redo();
    expect(state.value).toBe(2);
    expect(history.canRedo).toBe(false);
  });

  it('clears the redo stack when a new command arrives', () => {
    const state = { value: 0 };
    const history = new History();
    history.push(counterCommand(state, 1));
    history.undo();
    expect(history.canRedo).toBe(true);
    history.push(counterCommand(state, 5));
    expect(history.canRedo).toBe(false);
  });

  it('coalesces same-key commands inside the window and keeps the original undo', () => {
    const state = { value: 0 };
    const history = new History();
    const slider = (value: number) => {
      const command: Command & { value: number } = {
        label: 'morph',
        bytes: 8,
        key: 'morph:Build_Tall',
        value,
        undo: () => {
          state.value = 0;
        },
        redo: () => {
          state.value = command.value;
        },
        merge: (next) => {
          command.value = (next as unknown as { value: number }).value;
        },
      };
      state.value = value;
      history.push(command);
    };
    slider(0.2);
    slider(0.5);
    slider(0.9);
    expect(history.size).toBe(1);
    expect(state.value).toBe(0.9);
    history.undo();
    expect(state.value).toBe(0);
    history.redo();
    expect(state.value).toBe(0.9);
  });

  it('drops the oldest entries when the count or byte budget is exceeded', () => {
    const state = { value: 0 };
    const history = new History(3, 1024 * 1024);
    for (let i = 1; i <= 6; i++) history.push(counterCommand(state, i));
    expect(history.size).toBe(3);

    const tiny = new History(50, 40);
    for (let i = 1; i <= 6; i++) tiny.push({ ...counterCommand(state, i), bytes: 16 });
    expect(tiny.size).toBeLessThanOrEqual(3);
    expect(tiny.byteWeight).toBeLessThanOrEqual(40);
  });

  it('reports labels for the buttons and never goes below zero bytes', () => {
    const state = { value: 0 };
    const history = new History();
    expect(history.undoLabel).toBeNull();
    expect(history.redoLabel).toBeNull();
    history.push(counterCommand(state, 1, 'clay stroke'));
    expect(history.undoLabel).toBe('clay stroke');
    history.undo();
    expect(history.redoLabel).toBe('clay stroke');
    history.clear();
    expect(history.size).toBe(0);
    expect(history.byteWeight).toBe(0);
  });
});
