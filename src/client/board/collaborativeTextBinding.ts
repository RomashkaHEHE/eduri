import * as Y from "yjs";
import type { BoardCommandOrigin, LocalUndoController } from "../../board/core";

export interface CollaborativeTextEdit {
  readonly index: number;
  readonly deleteLength: number;
  readonly insert: string;
}

export interface CollaborativeTextareaBindingOptions {
  readonly element: HTMLTextAreaElement;
  readonly text: Y.Text;
  readonly localOrigin: BoardCommandOrigin;
  readonly undo: Pick<
    LocalUndoController,
    "undo" | "redo" | "commandBoundary"
  >;
  applyEdit(edit: CollaborativeTextEdit): void;
}

interface TextSelection {
  readonly start: number;
  readonly end: number;
  readonly direction: "forward" | "backward" | "none";
}

type TextDelta = ReadonlyArray<{
  readonly insert?: string | object;
  readonly delete?: number;
  readonly retain?: number;
}>;

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length, index));
}

function readSelection(element: HTMLTextAreaElement): TextSelection {
  return {
    start: element.selectionStart ?? 0,
    end: element.selectionEnd ?? element.selectionStart ?? 0,
    direction: element.selectionDirection ?? "none",
  };
}

function writeSelection(
  element: HTMLTextAreaElement,
  selection: TextSelection,
): void {
  const length = element.value.length;
  element.setSelectionRange(
    clampIndex(selection.start, length),
    clampIndex(selection.end, length),
    selection.direction,
  );
}

function insertedLength(value: string | object): number {
  return typeof value === "string" ? value.length : 1;
}

export function translateTextIndex(
  index: number,
  delta: TextDelta,
  affinity: "left" | "right" = "right",
): number {
  let oldOffset = 0;
  let translated = index;
  for (const operation of delta) {
    if (typeof operation.retain === "number") {
      oldOffset += operation.retain;
    }
    if (operation.insert !== undefined) {
      if (
        oldOffset < index
        || (oldOffset === index && affinity === "right")
      ) {
        translated += insertedLength(operation.insert);
      }
    }
    if (typeof operation.delete === "number") {
      const deletedEnd = oldOffset + operation.delete;
      if (index > oldOffset) {
        translated -= Math.min(operation.delete, index - oldOffset);
      }
      oldOffset = deletedEnd;
    }
  }
  return Math.max(0, translated);
}

function translateSelection(
  selection: TextSelection,
  delta: TextDelta,
): TextSelection {
  return {
    start: translateTextIndex(selection.start, delta),
    end: translateTextIndex(selection.end, delta),
    direction: selection.direction,
  };
}

export function diffTextareaValue(
  previous: string,
  next: string,
): CollaborativeTextEdit {
  let prefix = 0;
  while (
    prefix < previous.length
    && prefix < next.length
    && previous[prefix] === next[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < previous.length - prefix
    && suffix < next.length - prefix
    && previous[previous.length - suffix - 1]
      === next[next.length - suffix - 1]
  ) {
    suffix += 1;
  }

  return {
    index: prefix,
    deleteLength: previous.length - prefix - suffix,
    insert: next.slice(prefix, next.length - suffix),
  };
}

function patchTextarea(
  element: HTMLTextAreaElement,
  delta: TextDelta,
): boolean {
  let cursor = 0;
  for (const operation of delta) {
    if (typeof operation.retain === "number") {
      cursor += operation.retain;
    }
    if (typeof operation.delete === "number") {
      element.setRangeText(
        "",
        cursor,
        cursor + operation.delete,
        "preserve",
      );
    }
    if (operation.insert !== undefined) {
      if (typeof operation.insert !== "string") return false;
      element.setRangeText(
        operation.insert,
        cursor,
        cursor,
        "preserve",
      );
      cursor += operation.insert.length;
    }
  }
  return true;
}

export class CollaborativeTextareaBinding {
  private readonly element: HTMLTextAreaElement;
  private readonly text: Y.Text;
  private readonly options: CollaborativeTextareaBindingOptions;
  private shadowValue: string;
  private disposed = false;
  private compositionBoundary = 0;
  private applyingInput = false;

  constructor(options: CollaborativeTextareaBindingOptions) {
    this.options = options;
    this.element = options.element;
    this.text = options.text;
    this.shadowValue = options.text.toString();

    const initialSelection = readSelection(this.element);
    this.element.value = this.shadowValue;
    writeSelection(this.element, initialSelection);

    this.text.observe(this.onTextChange);
    this.element.addEventListener("input", this.onInput);
    this.element.addEventListener("keydown", this.onKeyDown);
    this.element.addEventListener(
      "compositionstart",
      this.onCompositionStart,
    );
    this.element.addEventListener("compositionend", this.onCompositionEnd);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.compositionBoundary += 1;
    this.text.unobserve(this.onTextChange);
    this.element.removeEventListener("input", this.onInput);
    this.element.removeEventListener("keydown", this.onKeyDown);
    this.element.removeEventListener(
      "compositionstart",
      this.onCompositionStart,
    );
    this.element.removeEventListener(
      "compositionend",
      this.onCompositionEnd,
    );
  }

  private readonly onInput = (): void => {
    if (this.disposed) return;
    const next = this.element.value;
    const edit = diffTextareaValue(this.shadowValue, next);
    if (edit.deleteLength === 0 && edit.insert.length === 0) return;

    try {
      this.applyingInput = true;
      this.options.applyEdit(edit);
      this.shadowValue = this.text.toString();
      if (this.element.value !== this.shadowValue) {
        const selection = readSelection(this.element);
        this.element.value = this.shadowValue;
        writeSelection(this.element, selection);
      }
    } catch (error) {
      const selection = readSelection(this.element);
      this.shadowValue = this.text.toString();
      this.element.value = this.shadowValue;
      writeSelection(this.element, selection);
      throw error;
    } finally {
      this.applyingInput = false;
    }
  };

  private readonly onTextChange = (
    event: Y.YTextEvent,
    transaction: Y.Transaction,
  ): void => {
    if (this.disposed) return;
    const next = this.text.toString();
    if (
      transaction.origin === this.options.localOrigin
      && this.applyingInput
    ) {
      this.shadowValue = next;
      return;
    }

    const selection = readSelection(this.element);
    const delta = event.delta as TextDelta;
    const canPatch = this.element.value === this.shadowValue
      && patchTextarea(this.element, delta)
      && this.element.value === next;
    if (!canPatch) this.element.value = next;
    this.shadowValue = next;
    writeSelection(this.element, translateSelection(selection, delta));
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.code === "KeyZ") {
      event.preventDefault();
      if (event.shiftKey) this.options.undo.redo();
      else this.options.undo.undo();
    } else if (event.code === "KeyY") {
      event.preventDefault();
      this.options.undo.redo();
    }
  };

  private readonly onCompositionStart = (): void => {
    this.compositionBoundary += 1;
    this.options.undo.commandBoundary();
  };

  private readonly onCompositionEnd = (): void => {
    const boundary = ++this.compositionBoundary;
    queueMicrotask(() => {
      if (!this.disposed && boundary === this.compositionBoundary) {
        this.options.undo.commandBoundary();
      }
    });
  };
}
