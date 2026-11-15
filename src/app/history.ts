/**
 * Bounded undo/redo.
 *
 * Entries are explicit commands rather than snapshots of the character, so a
 * stroke costs only the groups it touched. Both the entry count and the total
 * byte weight are capped; the oldest entries are dropped first, which keeps
 * memory flat during long sculpting sessions.
 */

export interface Command {
  label: string;
  /** rough memory weight; used for the byte budget */
  bytes: number;
  /** optional coalescing key: consecutive commands with the same key merge */
  key?: string;
  undo(): void;
  redo(): void;
  /** when coalescing, merge newer values into this command */
  merge?(next: Command): void;
}

const DEFAULT_LIMIT = 60;
const DEFAULT_BYTES = 48 * 1024 * 1024;

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private bytes = 0;
  private lastPushAt = 0;
  private lastKey: string | undefined;

  constructor(
    private limit = DEFAULT_LIMIT,
    private byteLimit = DEFAULT_BYTES,
    private onChange: () => void = () => {},
  ) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get size(): number {
    return this.undoStack.length;
  }

  get byteWeight(): number {
    return this.bytes;
  }

  get undoLabel(): string | null {
    return this.undoStack.length ? this.undoStack[this.undoStack.length - 1].label : null;
  }

  get redoLabel(): string | null {
    return this.redoStack.length ? this.redoStack[this.redoStack.length - 1].label : null;
  }

  push(command: Command, coalesceWindow = 600): void {
    const now = performance.now();
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      command.key &&
      top?.key === command.key &&
      top.merge &&
      (now - this.lastPushAt < coalesceWindow || this.lastKey === command.key)
    ) {
      const previousBytes = top.bytes;
      top.merge(command);
      this.bytes += Math.max(0, top.bytes - previousBytes);
      top.redo();
      this.redoStack = [];
      this.lastPushAt = now;
      this.lastKey = command.key;
      this.onChange();
      return;
    }
    this.undoStack.push(command);
    this.bytes += command.bytes;
    this.redoStack = [];
    this.lastPushAt = now;
    this.lastKey = command.key;
    this.trim();
    this.onChange();
  }

  undo(): Command | null {
    const command = this.undoStack.pop();
    if (!command) return null;
    command.undo();
    this.redoStack.push(command);
    this.lastKey = undefined;
    this.onChange();
    return command;
  }

  redo(): Command | null {
    const command = this.redoStack.pop();
    if (!command) return null;
    command.redo();
    this.undoStack.push(command);
    this.lastKey = undefined;
    this.onChange();
    return command;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.bytes = 0;
    this.lastKey = undefined;
    this.onChange();
  }

  private trim(): void {
    while (this.undoStack.length > this.limit) {
      const dropped = this.undoStack.shift();
      this.bytes -= dropped?.bytes ?? 0;
    }
    while (this.bytes > this.byteLimit && this.undoStack.length > 1) {
      const dropped = this.undoStack.shift();
      this.bytes -= dropped?.bytes ?? 0;
    }
    if (this.bytes < 0) this.bytes = 0;
  }
}
