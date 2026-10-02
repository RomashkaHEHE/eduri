import * as Y from "yjs";
import type {
  BoardCommandOrigin,
  CollaborativeTextAttributes,
  LocalUndoController,
} from "../../board/core";
import {
  diffTextareaValue,
  translateTextIndex,
} from "./collaborativeTextBinding";

export interface RichTextSelection {
  readonly anchor: number;
  readonly head: number;
}

export interface RichTextSelectionStyle {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly mixed: ReadonlySet<string>;
}

export interface CollaborativeRichTextEdit {
  readonly index: number;
  readonly deleteLength: number;
  readonly insert: string;
  readonly attributes: CollaborativeTextAttributes;
}

export interface CollaborativeRichTextBindingOptions {
  readonly element: HTMLDivElement;
  readonly text: Y.Text;
  readonly localOrigin: BoardCommandOrigin;
  readonly undo: Pick<LocalUndoController, "undo" | "redo" | "commandBoundary">;
  readonly inheritedAttributes?: () => CollaborativeTextAttributes;
  applyEdit(edit: CollaborativeRichTextEdit): void;
  applyFormat(
    index: number,
    length: number,
    attributes: CollaborativeTextAttributes,
  ): void;
  onValueChange?(): void;
  onSelectionChange?(
    selection: RichTextSelection,
    style: RichTextSelectionStyle,
  ): void;
}

type TextDelta = ReadonlyArray<{
  readonly insert?: string | object;
  readonly delete?: number;
  readonly retain?: number;
  readonly attributes?: Readonly<Record<string, unknown>>;
}>;

const INLINE_ATTRIBUTE_KEYS = Object.freeze([
  "bold",
  "italic",
  "color",
  "fontFamily",
  "fontSize",
] as const);

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length, index));
}

function safeAttributes(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  if (typeof source.bold === "boolean") result.bold = source.bold;
  if (typeof source.italic === "boolean") result.italic = source.italic;
  if (typeof source.color === "string" && source.color.length <= 128) {
    result.color = source.color;
  }
  if (typeof source.fontFamily === "string" && source.fontFamily.length <= 256) {
    result.fontFamily = source.fontFamily;
  }
  if (
    typeof source.fontSize === "number"
    && Number.isFinite(source.fontSize)
    && source.fontSize > 0
    && source.fontSize <= 256
  ) {
    result.fontSize = Math.round(source.fontSize * 100) / 100;
  }
  return result;
}

function applySpanStyle(
  span: HTMLSpanElement,
  attributes: Readonly<Record<string, unknown>>,
): void {
  const safe = safeAttributes(attributes);
  if (safe.bold === true) span.style.fontWeight = "700";
  else if (safe.bold === false) span.style.fontWeight = "400";
  if (safe.italic === true) span.style.fontStyle = "italic";
  else if (safe.italic === false) span.style.fontStyle = "normal";
  if (typeof safe.color === "string") span.style.color = safe.color;
  if (typeof safe.fontFamily === "string") span.style.fontFamily = safe.fontFamily;
  if (typeof safe.fontSize === "number") span.style.fontSize = `${safe.fontSize}px`;
}

function attributesKey(attributes: Readonly<Record<string, unknown>>): string {
  const safe = safeAttributes(attributes);
  return JSON.stringify(Object.fromEntries(
    Object.keys(safe).sort().map((key) => [key, safe[key]]),
  ));
}

/** Writes Y.Text runs into a DOM layout mirror without serializing HTML. */
export function renderCollaborativeRichTextDom(
  element: HTMLElement,
  text: Y.Text,
): void {
  const fragment = element.ownerDocument.createDocumentFragment();
  for (const operation of text.toDelta()) {
    if (typeof operation.insert !== "string" || operation.insert.length === 0) continue;
    const span = element.ownerDocument.createElement("span");
    span.dataset.boardTextRun = "true";
    span.dataset.boardTextAttributes = attributesKey(operation.attributes ?? {});
    applySpanStyle(span, operation.attributes ?? {});
    span.textContent = operation.insert;
    fragment.append(span);
  }
  element.replaceChildren(fragment);
}

function patchContentEditableRange(
  element: HTMLDivElement,
  index: number,
  deleteLength: number,
  insert: string,
  attributes: Readonly<Record<string, unknown>>,
): boolean {
  try {
    const start = contentEditableDomPoint(element, index);
    const end = contentEditableDomPoint(element, index + deleteLength);
    const key = attributesKey(attributes);
    if (
      deleteLength === 0
      && insert
      && start.node.nodeType === Node.TEXT_NODE
      && start.node.parentElement?.dataset.boardTextAttributes === key
    ) {
      (start.node as Text).insertData(start.offset, insert);
      writeContentEditableSelection(element, {
        anchor: index + insert.length,
        head: index + insert.length,
      });
      return true;
    }
    const range = element.ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    range.deleteContents();
    if (insert) {
      const span = element.ownerDocument.createElement("span");
      span.dataset.boardTextRun = "true";
      span.dataset.boardTextAttributes = key;
      applySpanStyle(span, attributes);
      span.textContent = insert;
      range.insertNode(span);
    }
    for (const run of element.querySelectorAll<HTMLElement>(
      '[data-board-text-run="true"]',
    )) {
      if ((run.textContent ?? "").length === 0) run.remove();
    }
    writeContentEditableSelection(element, {
      anchor: index + insert.length,
      head: index + insert.length,
    });
    return true;
  } catch {
    return false;
  }
}

function textNodes(root: Node): Text[] {
  const document = root.ownerDocument;
  if (!document) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const result: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    result.push(node as Text);
  }
  return result;
}

function pointOffset(root: Node, node: Node, offset: number): number | null {
  if (node !== root && !root.contains(node)) return null;
  let total = 0;
  for (const textNode of textNodes(root)) {
    if (textNode === node) return total + clampIndex(offset, textNode.data.length);
    if (textNode.parentNode === node) {
      const childIndex = [...node.childNodes].indexOf(textNode);
      if (offset <= childIndex) return total;
    }
    total += textNode.data.length;
  }
  if (node === root || root.contains(node)) return total;
  return null;
}

export function contentEditableDomPoint(
  root: HTMLElement,
  requestedOffset: number,
): { readonly node: Node; readonly offset: number } {
  const nodes = textNodes(root);
  const totalLength = nodes.reduce((sum, node) => sum + node.data.length, 0);
  let remaining = clampIndex(requestedOffset, totalLength);
  for (const node of nodes) {
    if (remaining <= node.data.length) return { node, offset: remaining };
    remaining -= node.data.length;
  }
  return { node: root, offset: root.childNodes.length };
}

export function readContentEditableSelection(
  element: HTMLElement,
): RichTextSelection | null {
  const selection = element.ownerDocument.getSelection();
  if (!selection || !selection.anchorNode || !selection.focusNode) return null;
  const anchor = pointOffset(element, selection.anchorNode, selection.anchorOffset);
  const head = pointOffset(element, selection.focusNode, selection.focusOffset);
  return anchor === null || head === null ? null : { anchor, head };
}

export function writeContentEditableSelection(
  element: HTMLElement,
  selection: RichTextSelection,
): void {
  const nativeSelection = element.ownerDocument.getSelection();
  if (!nativeSelection) return;
  const anchor = contentEditableDomPoint(element, selection.anchor);
  const head = contentEditableDomPoint(element, selection.head);
  nativeSelection.removeAllRanges();
  if (typeof nativeSelection.setBaseAndExtent === "function") {
    nativeSelection.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
    return;
  }
  const range = element.ownerDocument.createRange();
  range.setStart(anchor.node, anchor.offset);
  range.setEnd(head.node, head.offset);
  nativeSelection.addRange(range);
}

function attributesAt(text: Y.Text, index: number): Record<string, unknown> {
  if (text.length === 0) return {};
  const target = clampIndex(index <= 0 ? 0 : index - 1, text.length - 1);
  let offset = 0;
  for (const operation of text.toDelta()) {
    const length = typeof operation.insert === "string" ? operation.insert.length : 1;
    if (target < offset + length) return safeAttributes(operation.attributes);
    offset += length;
  }
  return {};
}

function selectionStyle(
  text: Y.Text,
  selection: RichTextSelection,
  pending: Readonly<Record<string, unknown>>,
): RichTextSelectionStyle {
  const start = Math.min(selection.anchor, selection.head);
  const end = Math.max(selection.anchor, selection.head);
  if (start === end) {
    return { attributes: { ...attributesAt(text, start), ...pending }, mixed: new Set() };
  }
  const values = new Map<string, unknown>();
  const mixed = new Set<string>();
  let offset = 0;
  for (const operation of text.toDelta()) {
    const length = typeof operation.insert === "string" ? operation.insert.length : 1;
    const operationStart = offset;
    const operationEnd = offset + length;
    offset = operationEnd;
    if (operationEnd <= start || operationStart >= end) continue;
    const attributes = safeAttributes(operation.attributes);
    for (const key of INLINE_ATTRIBUTE_KEYS) {
      const value = attributes[key] ?? null;
      if (!values.has(key)) values.set(key, value);
      else if (!Object.is(values.get(key), value)) mixed.add(key);
    }
  }
  return {
    attributes: Object.fromEntries(
      [...values].filter(([key]) => !mixed.has(key)).map(([key, value]) => [key, value]),
    ),
    mixed,
  };
}

function previousCodePointLength(value: string, index: number): number {
  if (index <= 0) return 0;
  const code = value.charCodeAt(index - 1);
  return code >= 0xdc00 && code <= 0xdfff && index >= 2 ? 2 : 1;
}

function nextCodePointLength(value: string, index: number): number {
  if (index >= value.length) return 0;
  const code = value.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff && index + 1 < value.length ? 2 : 1;
}

export class CollaborativeRichTextBinding {
  private readonly element: HTMLDivElement;
  private readonly text: Y.Text;
  private readonly options: CollaborativeRichTextBindingOptions;
  private shadowValue: string;
  private disposed = false;
  private applyingInput = false;
  private composing = false;
  private pendingAttributes: Record<string, unknown> = {};
  private lastSelection: RichTextSelection;

  constructor(options: CollaborativeRichTextBindingOptions) {
    this.options = options;
    this.element = options.element;
    this.text = options.text;
    this.shadowValue = options.text.toString();
    this.lastSelection = { anchor: this.text.length, head: this.text.length };
    this.render();
    this.text.observe(this.onTextChange);
    this.element.addEventListener("beforeinput", this.onBeforeInput);
    this.element.addEventListener("input", this.onInput);
    this.element.addEventListener("keydown", this.onKeyDown);
    this.element.addEventListener("paste", this.onPaste);
    this.element.addEventListener("compositionstart", this.onCompositionStart);
    this.element.addEventListener("compositionend", this.onCompositionEnd);
    this.element.ownerDocument.addEventListener("selectionchange", this.onSelectionChange);
    queueMicrotask(this.notifySelection);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.text.unobserve(this.onTextChange);
    this.element.removeEventListener("beforeinput", this.onBeforeInput);
    this.element.removeEventListener("input", this.onInput);
    this.element.removeEventListener("keydown", this.onKeyDown);
    this.element.removeEventListener("paste", this.onPaste);
    this.element.removeEventListener("compositionstart", this.onCompositionStart);
    this.element.removeEventListener("compositionend", this.onCompositionEnd);
    this.element.ownerDocument.removeEventListener("selectionchange", this.onSelectionChange);
  }

  selection(): RichTextSelection {
    const current = readContentEditableSelection(this.element);
    if (current) this.lastSelection = current;
    return this.lastSelection;
  }

  style(): RichTextSelectionStyle {
    return selectionStyle(this.text, this.selection(), this.pendingAttributes);
  }

  focus(): void {
    this.element.focus({ preventScroll: true });
    writeContentEditableSelection(this.element, this.lastSelection);
    this.notifySelection();
  }

  format(attributes: CollaborativeTextAttributes): void {
    const safe = safeAttributes(attributes);
    for (const [key, rawValue] of Object.entries(attributes)) {
      if (rawValue === null) safe[key] = null;
    }
    const selection = this.selection();
    const start = Math.min(selection.anchor, selection.head);
    const length = Math.abs(selection.head - selection.anchor);
    if (length === 0) {
      for (const [key, value] of Object.entries(safe)) {
        if (value === null) delete this.pendingAttributes[key];
        else this.pendingAttributes[key] = value;
      }
      this.notifySelection();
      return;
    }
    this.options.applyFormat(start, length, safe);
    this.pendingAttributes = {};
    this.notifySelection();
  }

  private toggleFormat(key: "bold" | "italic"): void {
    const style = this.style();
    const inherited = safeAttributes(this.options.inheritedAttributes?.() ?? {});
    const active = style.mixed.has(key)
      ? false
      : typeof style.attributes[key] === "boolean"
        ? style.attributes[key] === true
        : inherited[key] === true;
    this.format({ [key]: !active });
  }

  private deleteInDirection(direction: "backward" | "forward"): void {
    const selection = this.selection();
    if (selection.anchor !== selection.head) {
      this.replaceSelection("");
      return;
    }
    const value = this.text.toString();
    const length = direction === "backward"
      ? previousCodePointLength(value, selection.head)
      : nextCodePointLength(value, selection.head);
    if (length === 0) return;
    const start = direction === "backward"
      ? selection.head - length
      : selection.head;
    writeContentEditableSelection(this.element, {
      anchor: start,
      head: start + length,
    });
    this.replaceSelection("");
  }

  private render(selection?: RichTextSelection): void {
    renderCollaborativeRichTextDom(this.element, this.text);
    if (selection && this.element === this.element.ownerDocument.activeElement) {
      writeContentEditableSelection(this.element, selection);
    }
  }

  private replaceSelection(value: string): void {
    const selection = this.selection();
    const start = Math.min(selection.anchor, selection.head);
    const deleteLength = Math.abs(selection.head - selection.anchor);
    const attributes = {
      ...attributesAt(this.text, start),
      ...this.pendingAttributes,
    };
    this.applyingInput = true;
    try {
      this.options.applyEdit({ index: start, deleteLength, insert: value, attributes });
      this.shadowValue = this.text.toString();
      if (!patchContentEditableRange(
        this.element,
        start,
        deleteLength,
        value,
        attributes,
      )) {
        this.render({ anchor: start + value.length, head: start + value.length });
      }
      this.options.onValueChange?.();
      this.notifySelection();
    } finally {
      this.applyingInput = false;
    }
  }

  private readonly onBeforeInput = (event: InputEvent): void => {
    if (this.disposed || this.composing) return;
    if (event.inputType === "insertText" && event.data !== null) {
      event.preventDefault();
      this.replaceSelection(event.data);
      return;
    }
    if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
      event.preventDefault();
      this.replaceSelection("\n");
      return;
    }
    if (event.inputType === "deleteContentBackward" || event.inputType === "deleteContentForward") {
      event.preventDefault();
      this.deleteInDirection(
        event.inputType === "deleteContentBackward" ? "backward" : "forward",
      );
    }
  };

  private readonly onInput = (): void => {
    if (this.disposed || this.applyingInput) return;
    const next = this.element.textContent ?? "";
    const edit = diffTextareaValue(this.shadowValue, next);
    if (edit.deleteLength === 0 && edit.insert.length === 0) return;
    const attributes = {
      ...attributesAt(this.text, edit.index),
      ...this.pendingAttributes,
    };
    this.applyingInput = true;
    try {
      this.options.applyEdit({ ...edit, attributes });
      this.shadowValue = this.text.toString();
      const caret = edit.index + edit.insert.length;
      this.render({ anchor: caret, head: caret });
      this.options.onValueChange?.();
      this.notifySelection();
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
    if (transaction.origin === this.options.localOrigin && this.applyingInput) {
      this.shadowValue = next;
      return;
    }
    const selection = this.selection();
    const delta = event.delta as TextDelta;
    const translated = {
      anchor: translateTextIndex(selection.anchor, delta),
      head: translateTextIndex(selection.head, delta),
    };
    this.shadowValue = next;
    this.render(translated);
    this.options.onValueChange?.();
    this.notifySelection();
  };

  private readonly onPaste = (event: ClipboardEvent): void => {
    const value = event.clipboardData?.getData("text/plain");
    if (value === undefined) return;
    event.preventDefault();
    this.replaceSelection(value.replace(/\r\n?/gu, "\n"));
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.composing || event.isComposing) return;
    const command = event.ctrlKey || event.metaKey;
    if (
      !command
      && !event.altKey
      && (event.code === "Backspace" || event.code === "Delete")
    ) {
      event.preventDefault();
      this.deleteInDirection(event.code === "Backspace" ? "backward" : "forward");
      return;
    }
    if (!command || event.altKey) return;
    if (event.code === "KeyA" && !event.shiftKey) {
      event.preventDefault();
      writeContentEditableSelection(this.element, {
        anchor: 0,
        head: this.text.length,
      });
      this.notifySelection();
    } else if (event.code === "KeyB" && !event.shiftKey) {
      event.preventDefault();
      this.toggleFormat("bold");
    } else if (event.code === "KeyI" && !event.shiftKey) {
      event.preventDefault();
      this.toggleFormat("italic");
    } else if (event.code === "KeyZ") {
      event.preventDefault();
      if (event.shiftKey) this.options.undo.redo();
      else this.options.undo.undo();
    } else if (event.code === "KeyY") {
      event.preventDefault();
      this.options.undo.redo();
    }
  };

  private readonly onCompositionStart = (): void => {
    this.composing = true;
    this.options.undo.commandBoundary();
  };

  private readonly onCompositionEnd = (): void => {
    this.composing = false;
    this.onInput();
    this.options.undo.commandBoundary();
  };

  private readonly onSelectionChange = (): void => {
    if (this.element === this.element.ownerDocument.activeElement) {
      const current = readContentEditableSelection(this.element);
      if (
        current
        && (
          current.anchor !== this.lastSelection.anchor
          || current.head !== this.lastSelection.head
        )
      ) {
        this.pendingAttributes = {};
      }
      this.notifySelection();
    }
  };

  private readonly notifySelection = (): void => {
    if (this.disposed) return;
    const selection = this.selection();
    this.lastSelection = selection;
    this.options.onSelectionChange?.(
      selection,
      selectionStyle(this.text, selection, this.pendingAttributes),
    );
  };
}
