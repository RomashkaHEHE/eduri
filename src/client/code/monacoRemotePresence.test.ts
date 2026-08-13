// @vitest-environment jsdom

import type * as Monaco from "monaco-editor";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CODE_SYNC_LIMITS } from "../../code/protocol/constants.js";
import {
  createMonacoRemotePresenceRenderer,
  decodeExactYTextSelection,
  encodeMonacoYTextSelections,
  type EncodedYTextSelection,
} from "./monacoRemotePresence";

type Disposable = { dispose(): void };

function positionAt(value: string, requestedOffset: number): Monaco.IPosition {
  const offset = Math.max(0, Math.min(requestedOffset, value.length));
  const before = value.slice(0, offset);
  const lines = before.split("\n");
  return {
    lineNumber: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

function offsetAt(value: string, position: Monaco.IPosition): number {
  const lines = value.split("\n");
  const lineNumber = Math.max(1, Math.min(position.lineNumber, lines.length));
  let offset = 0;
  for (let index = 0; index < lineNumber - 1; index += 1) {
    offset += lines[index]!.length + 1;
  }
  return Math.min(
    offset + Math.max(0, position.column - 1),
    offset + lines[lineNumber - 1]!.length,
  );
}

class MockPresenceModel {
  private readonly changeListeners = new Set<() => void>();
  private readonly disposeListeners = new Set<() => void>();

  constructor(public value: string) {}

  getPositionAt = (offset: number): Monaco.IPosition => positionAt(this.value, offset);

  getOffsetAt = (position: Monaco.IPosition): number => offsetAt(this.value, position);

  setValue(value: string): void {
    this.value = value;
    for (const listener of this.changeListeners) listener();
  }

  onDidChangeContent = (listener: () => void): Disposable => {
    this.changeListeners.add(listener);
    return { dispose: () => this.changeListeners.delete(listener) };
  };

  onWillDispose = (listener: () => void): Disposable => {
    this.disposeListeners.add(listener);
    return { dispose: () => this.disposeListeners.delete(listener) };
  };

  asModel(): Monaco.editor.ITextModel {
    return this as unknown as Monaco.editor.ITextModel;
  }
}

class MockPresenceEditor {
  readonly root = document.createElement("div");
  readonly addedWidgets: Monaco.editor.IContentWidget[] = [];
  readonly removedWidgets: Monaco.editor.IContentWidget[] = [];
  readonly layoutWidgets: Monaco.editor.IContentWidget[] = [];
  readonly decorationSets: Monaco.editor.IModelDeltaDecoration[][] = [];
  decorationClearCalls = 0;
  selections: Monaco.ISelection[] | null = null;
  private readonly disposeListeners = new Set<() => void>();
  private readonly modelListeners = new Set<() => void>();

  constructor(private model: Monaco.editor.ITextModel | null) {}

  getModel = (): Monaco.editor.ITextModel | null => this.model;

  getDomNode = (): HTMLElement => this.root;

  getSelection = (): Monaco.Selection | null => (
    this.selections?.[0] as Monaco.Selection | undefined
  ) ?? null;

  getSelections = (): Monaco.Selection[] | null => (
    this.selections
      ? this.selections.map((selection) => ({ ...selection })) as Monaco.Selection[]
      : null
  );

  createDecorationsCollection = (): Monaco.editor.IEditorDecorationsCollection => ({
    set: (decorations: readonly Monaco.editor.IModelDeltaDecoration[]) => {
      this.decorationSets.push([...decorations]);
    },
    append: () => undefined,
    clear: () => {
      this.decorationClearCalls += 1;
    },
    getRange: () => null,
    getRanges: () => [],
    has: () => false,
    length: 0,
    onDidChange: () => ({ dispose() {} }),
  } as unknown as Monaco.editor.IEditorDecorationsCollection);

  addContentWidget = (widget: Monaco.editor.IContentWidget): void => {
    this.addedWidgets.push(widget);
    this.root.append(widget.getDomNode());
  };

  removeContentWidget = (widget: Monaco.editor.IContentWidget): void => {
    this.removedWidgets.push(widget);
    widget.getDomNode().remove();
  };

  layoutContentWidget = (widget: Monaco.editor.IContentWidget): void => {
    this.layoutWidgets.push(widget);
  };

  onDidDispose = (listener: () => void): Disposable => {
    this.disposeListeners.add(listener);
    return { dispose: () => this.disposeListeners.delete(listener) };
  };

  onDidChangeModel = (listener: () => void): Disposable => {
    this.modelListeners.add(listener);
    return { dispose: () => this.modelListeners.delete(listener) };
  };

  asEditor(): Monaco.editor.IStandaloneCodeEditor {
    return this as unknown as Monaco.editor.IStandaloneCodeEditor;
  }
}

function encodedSelection(
  yText: Y.Text,
  anchor: number,
  head: number,
): EncodedYTextSelection {
  return {
    anchor: Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(yText, anchor),
    ),
    head: Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(yText, head),
    ),
  };
}

afterEach(() => {
  document.head.querySelectorAll("style[data-eduri-monaco-remote-presence]")
    .forEach((element) => element.remove());
});

describe("Monaco remote presence", () => {
  it("renders a stable zero-width caret widget and a per-peer selection", () => {
    const yDocument = new Y.Doc();
    const yText = yDocument.getText("source");
    yText.insert(0, "hello");
    const model = new MockPresenceModel("hello");
    const editor = new MockPresenceEditor(model.asModel());
    const renderer = createMonacoRemotePresenceRenderer({
      yText,
      model: model.asModel(),
      editor: editor.asEditor(),
    });
    const selection = encodedSelection(yText, 1, 4);
    const peer = {
      participantId: "participant-a",
      displayName: "Alice",
      color: "#123456",
      selections: [selection],
    };

    renderer.setPeers([peer]);

    expect(editor.addedWidgets).toHaveLength(1);
    const widget = editor.addedWidgets[0]!;
    const widgetNode = widget.getDomNode();
    const caretLine = widgetNode.querySelector<HTMLElement>(
      '[data-eduri-remote-caret-line="true"]',
    );
    expect(widgetNode.style.width).toBe("0px");
    expect(widgetNode.textContent).toBe("Alice");
    expect(widgetNode.textContent).not.toContain("|");
    expect(caretLine).not.toBeNull();
    expect(caretLine?.style.display).not.toBe("none");
    expect(caretLine?.style.visibility).not.toBe("hidden");
    expect(caretLine?.style.opacity).not.toBe("0");
    expect(caretLine?.style.width).toBe("2px");
    expect(widget.getPosition()?.position).toEqual({ lineNumber: 1, column: 5 });
    expect(editor.decorationSets).toHaveLength(1);
    expect(editor.decorationSets[0]).toHaveLength(1);
    const decoration = editor.decorationSets[0]![0]!;
    expect(decoration.range).toMatchObject({
      startLineNumber: 1,
      startColumn: 2,
      endLineNumber: 1,
      endColumn: 5,
    });
    expect(decoration.options.before).toBeUndefined();
    expect(decoration.options.after).toBeUndefined();
    expect(document.head.querySelector(
      "style[data-eduri-monaco-remote-presence]",
    )?.textContent).toContain("rgba(18, 52, 86, 0.22)");

    renderer.setPeers([{
      ...peer,
      selections: [{
        anchor: selection.anchor.slice(),
        head: selection.head.slice(),
      }],
    }]);
    expect(editor.addedWidgets).toHaveLength(1);
    expect(editor.decorationSets).toHaveLength(1);
    expect(editor.layoutWidgets).toHaveLength(1);

    renderer.setPeers([{
      ...peer,
      selections: [encodedSelection(yText, 2, 5)],
    }]);
    expect(editor.addedWidgets).toHaveLength(1);
    expect(editor.addedWidgets[0]).toBe(widget);
    expect(editor.decorationSets).toHaveLength(2);
    expect(widget.getDomNode()).toBe(widgetNode);
    expect(widget.getDomNode().style.width).toBe("0px");
    expect(widget.getDomNode().querySelector(
      '[data-eduri-remote-caret-hitbox="true"]',
    )).not.toBeNull();
    expect(widget.getPosition()?.position).toEqual({ lineNumber: 1, column: 6 });

    renderer.destroy();
    yDocument.destroy();
  });

  it("reveals only the hovered caret label and hides it again without unsafe markup", () => {
    const yDocument = new Y.Doc();
    const yText = yDocument.getText("source");
    yText.insert(0, "hello");
    const model = new MockPresenceModel("hello");
    const editor = new MockPresenceEditor(model.asModel());
    const renderer = createMonacoRemotePresenceRenderer({
      yText,
      model: model.asModel(),
      editor: editor.asEditor(),
    });

    renderer.setPeers([
      {
        participantId: "participant-a",
        displayName: "Alice",
        color: "#123456",
        selections: [encodedSelection(yText, 1, 1)],
      },
      {
        participantId: "participant-b",
        displayName: '<img src=x onerror="alert(1)">',
        color: "#abcdef",
        selections: [encodedSelection(yText, 3, 3)],
      },
    ]);

    expect(editor.addedWidgets).toHaveLength(2);
    const [aliceWidget, hostileWidget] = editor.addedWidgets.map(
      (widget) => widget.getDomNode(),
    );
    const aliceHitbox = aliceWidget?.querySelector<HTMLElement>(
      '[data-eduri-remote-caret-hitbox="true"]',
    );
    const hostileHitbox = hostileWidget?.querySelector<HTMLElement>(
      '[data-eduri-remote-caret-hitbox="true"]',
    );
    const aliceLabel = aliceWidget?.querySelector<HTMLElement>(
      '[data-eduri-remote-caret-label="true"]',
    );
    const hostileLabel = hostileWidget?.querySelector<HTMLElement>(
      '[data-eduri-remote-caret-label="true"]',
    );

    expect(aliceHitbox).not.toBeNull();
    expect(hostileHitbox).not.toBeNull();
    expect(aliceHitbox?.style.width).toBe("18px");
    expect(hostileHitbox?.style.width).toBe("18px");
    expect(aliceHitbox?.style.pointerEvents).toBe("none");
    expect(hostileHitbox?.style.pointerEvents).toBe("none");
    expect(aliceHitbox?.parentElement).toBe(aliceWidget);
    expect(hostileHitbox?.parentElement).toBe(hostileWidget);

    expect(aliceLabel?.textContent).toBe("Alice");
    expect(hostileLabel?.textContent).toBe('<img src=x onerror="alert(1)">');
    expect(hostileWidget?.querySelector("img")).toBeNull();
    expect(hostileWidget?.querySelector("[onerror]")).toBeNull();
    for (const label of [aliceLabel, hostileLabel]) {
      expect(label?.style.opacity).toBe("0");
      expect(label?.style.visibility).toBe("hidden");
      expect(label?.style.pointerEvents).toBe("none");
    }
    expect(aliceWidget?.style.width).toBe("0px");
    expect(hostileWidget?.style.width).toBe("0px");
    expect(editor.root.textContent).not.toContain("|");

    const hoverStyles = document.head.querySelector(
      "style[data-eduri-monaco-remote-presence]",
    )?.textContent ?? "";
    expect(hoverStyles).toMatch(/@media\s*\(hover:\s*hover\)/u);
    expect(hoverStyles).toMatch(
      /\[data-eduri-remote-caret-hitbox(?:=["']?true["']?)?\]:hover\s*[+~]\s*\[data-eduri-remote-caret-label(?:=["']?true["']?)?\]/u,
    );
    expect(hoverStyles).toMatch(/pointer-events:\s*auto/u);
    expect(hoverStyles).toMatch(/opacity:\s*1/u);
    expect(hoverStyles).toMatch(/visibility:\s*visible/u);

    // The generic sibling selector can reveal only the label in the hovered
    // widget. With no persistent JS state, leaving restores these inline
    // hidden defaults automatically.
    expect(aliceHitbox?.parentElement?.querySelectorAll(
      '[data-eduri-remote-caret-label="true"]',
    )).toHaveLength(1);
    expect(hostileHitbox?.parentElement?.querySelectorAll(
      '[data-eduri-remote-caret-label="true"]',
    )).toHaveLength(1);
    expect(aliceLabel?.style.opacity).toBe("0");
    expect(hostileLabel?.style.opacity).toBe("0");

    renderer.destroy();
    expect(aliceWidget?.isConnected).toBe(false);
    expect(hostileWidget?.isConnected).toBe(false);
    expect(document.head.querySelector(
      "style[data-eduri-monaco-remote-presence]",
    )).toBeNull();
    yDocument.destroy();
  });

  it("renders finite forward and backward whole-line selections with directional carets", () => {
    const yDocument = new Y.Doc();
    const yText = yDocument.getText("source");
    const value = "print('one')\nprint('two')\n";
    yText.insert(0, value);
    const nextLine = value.indexOf("\n") + 1;
    const model = new MockPresenceModel(value);
    const editor = new MockPresenceEditor(model.asModel());
    const renderer = createMonacoRemotePresenceRenderer({
      yText,
      model: model.asModel(),
      editor: editor.asEditor(),
    });

    renderer.setPeers([{
      participantId: "participant-a",
      displayName: "Alice",
      color: "#123456",
      selections: [
        encodedSelection(yText, 0, nextLine),
        encodedSelection(yText, nextLine, 0),
      ],
    }]);

    expect(editor.addedWidgets).toHaveLength(2);
    expect(editor.addedWidgets.map((widget) => widget.getPosition()?.position))
      .toEqual([
        { lineNumber: 2, column: 1 },
        { lineNumber: 1, column: 1 },
      ]);
    expect(editor.decorationSets.at(-1)).toHaveLength(2);
    for (const decoration of editor.decorationSets.at(-1) ?? []) {
      expect(decoration.range).toMatchObject({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 2,
        endColumn: 1,
      });
      expect(decoration.options.inlineClassName).toMatch(
        /^eduri-monaco-remote-selection-/u,
      );
      expect(decoration.options.inlineClassNameAffectsLetterSpacing).toBe(false);
      expect(decoration.options.className).toBeUndefined();
      expect(decoration.options.shouldFillLineOnLineBreak).toBeUndefined();
      expect(decoration.options.isWholeLine).not.toBe(true);
    }

    renderer.destroy();
    yDocument.destroy();
  });

  it("keeps overlapping indexed carets distinct and removes only departed indexes", () => {
    const yDocument = new Y.Doc();
    const yText = yDocument.getText("source");
    yText.insert(0, "hello");
    const model = new MockPresenceModel("hello");
    const editor = new MockPresenceEditor(model.asModel());
    const renderer = createMonacoRemotePresenceRenderer({
      yText,
      model: model.asModel(),
      editor: editor.asEditor(),
    });
    const overlap = encodedSelection(yText, 2, 2);

    renderer.setPeers([{
      participantId: "participant-a",
      displayName: "Alice",
      color: "#123456",
      selections: [overlap, overlap],
    }]);

    expect(editor.addedWidgets).toHaveLength(2);
    expect(new Set(editor.addedWidgets.map((widget) => widget.getId())).size).toBe(2);
    expect(editor.addedWidgets.map((widget) => widget.getPosition()?.position))
      .toEqual([
        { lineNumber: 1, column: 3 },
        { lineNumber: 1, column: 3 },
      ]);
    const originalWidgets = [...editor.addedWidgets];
    const layoutCount = editor.layoutWidgets.length;

    renderer.setPeers([{
      participantId: "participant-a",
      displayName: "Alice",
      color: "#123456",
      selections: [
        { anchor: overlap.anchor.slice(), head: overlap.head.slice() },
        { anchor: overlap.anchor.slice(), head: overlap.head.slice() },
      ],
    }]);
    expect(editor.addedWidgets).toEqual(originalWidgets);
    expect(editor.layoutWidgets).toHaveLength(layoutCount);

    renderer.setPeers([{
      participantId: "participant-a",
      displayName: "Alice",
      color: "#123456",
      selections: [overlap],
    }]);
    expect(editor.addedWidgets).toEqual(originalWidgets);
    expect(editor.removedWidgets).toEqual([originalWidgets[1]]);
    expect(originalWidgets[0]?.getDomNode().parentElement).toBe(editor.root);
    expect(originalWidgets[1]?.getDomNode().parentElement).toBeNull();

    renderer.destroy();
    yDocument.destroy();
  });

  it("repositions an unchanged caret offset when Monaco line geometry changes", () => {
    const yDocument = new Y.Doc();
    const yText = yDocument.getText("source");
    yText.insert(0, "abc");
    const model = new MockPresenceModel("abc");
    const editor = new MockPresenceEditor(model.asModel());
    const renderer = createMonacoRemotePresenceRenderer({
      yText,
      model: model.asModel(),
      editor: editor.asEditor(),
    });

    renderer.setPeers([{
      participantId: "participant-a",
      displayName: "Alice",
      color: "#123456",
      selections: [encodedSelection(yText, 2, 2)],
    }]);

    const widget = editor.addedWidgets[0]!;
    expect(widget.getPosition()?.position).toEqual({ lineNumber: 1, column: 3 });
    const layoutCount = editor.layoutWidgets.length;

    model.setValue("a\nc");

    expect(editor.addedWidgets).toEqual([widget]);
    expect(widget.getPosition()?.position).toEqual({ lineNumber: 2, column: 1 });
    expect(editor.layoutWidgets).toHaveLength(layoutCount + 1);

    renderer.destroy();
    yDocument.destroy();
  });

  it("renders valid sibling selections while ignoring invalid relative positions", () => {
    const yDocument = new Y.Doc();
    const yText = yDocument.getText("source");
    const otherText = yDocument.getText("other");
    yText.insert(0, "hello");
    otherText.insert(0, "other");
    const model = new MockPresenceModel("hello");
    const editor = new MockPresenceEditor(model.asModel());
    const renderer = createMonacoRemotePresenceRenderer({
      yText,
      model: model.asModel(),
      editor: editor.asEditor(),
    });

    renderer.setPeers([{
      participantId: "participant-a",
      displayName: "Alice",
      color: "#123456",
      selections: [
        encodedSelection(otherText, 1, 3),
        { anchor: Uint8Array.of(255), head: Uint8Array.of(255) },
        encodedSelection(yText, 1, 4),
      ],
    }]);

    expect(editor.addedWidgets).toHaveLength(1);
    expect(editor.addedWidgets[0]?.getPosition()?.position)
      .toEqual({ lineNumber: 1, column: 5 });
    expect(editor.decorationSets.at(-1)).toHaveLength(1);

    renderer.destroy();
    yDocument.destroy();
  });

  it("decodes only positions belonging to the exact bound Y.Text", () => {
    const yDocument = new Y.Doc();
    const yText = yDocument.getText("source");
    const otherText = yDocument.getText("other");
    yText.insert(0, "main");
    otherText.insert(0, "other");

    expect(decodeExactYTextSelection(
      yText,
      encodedSelection(otherText, 1, 3),
    )).toBeNull();
    expect(decodeExactYTextSelection(yText, {
      anchor: Uint8Array.of(255),
      head: Uint8Array.of(255),
    })).toBeNull();

    const relative = encodedSelection(yText, 2, 2);
    yText.insert(0, "X");
    expect(decodeExactYTextSelection(yText, relative)).toEqual({
      anchor: 3,
      head: 3,
    });
    yDocument.destroy();
  });

  it("encodes ordered Monaco selections, preserves direction, and caps the payload", () => {
    const yDocument = new Y.Doc();
    const yText = yDocument.getText("source");
    yText.insert(0, "hello");
    const model = new MockPresenceModel("hello");
    const editor = new MockPresenceEditor(model.asModel());
    editor.selections = Array.from(
      { length: CODE_SYNC_LIMITS.maxYTextSelections + 1 },
      (_, index) => ({
        selectionStartLineNumber: 1,
        selectionStartColumn: index === 0 ? 5 : (index % 5) + 1,
        positionLineNumber: 1,
        positionColumn: index === 0 ? 2 : ((index + 2) % 5) + 1,
      }),
    );

    const encoded = encodeMonacoYTextSelections(
      yText,
      model.asModel(),
      editor.asEditor(),
    );
    expect(encoded).not.toBeNull();
    expect(encoded).toHaveLength(CODE_SYNC_LIMITS.maxYTextSelections);
    expect(decodeExactYTextSelection(yText, encoded![0]!)).toEqual({
      anchor: 4,
      head: 1,
    });
    expect(decodeExactYTextSelection(yText, encoded![1]!)).toEqual({
      anchor: 1,
      head: 3,
    });
    yDocument.destroy();
  });

  it("removes departed peers and performs idempotent complete cleanup", () => {
    const yDocument = new Y.Doc();
    const yText = yDocument.getText("source");
    yText.insert(0, "hello");
    const model = new MockPresenceModel("hello");
    const editor = new MockPresenceEditor(model.asModel());
    const renderer = createMonacoRemotePresenceRenderer({
      yText,
      model: model.asModel(),
      editor: editor.asEditor(),
    });
    const first = {
      participantId: "one",
      displayName: "One",
      color: "#ff0000",
      selections: [encodedSelection(yText, 1, 1)],
    };
    const second = {
      participantId: "two",
      displayName: "Two",
      color: "#00ff00",
      selections: [encodedSelection(yText, 2, 4)],
    };

    renderer.setPeers([first, second]);
    expect(editor.addedWidgets).toHaveLength(2);
    renderer.setPeers([first]);
    expect(editor.removedWidgets).toHaveLength(1);
    renderer.destroy();
    renderer.destroy();
    expect(editor.removedWidgets).toHaveLength(2);
    expect(editor.decorationClearCalls).toBe(1);
    expect(document.head.querySelector(
      "style[data-eduri-monaco-remote-presence]",
    )).toBeNull();

    const setCount = editor.decorationSets.length;
    renderer.setPeers([second]);
    yText.insert(0, "ignored");
    expect(editor.decorationSets).toHaveLength(setCount);
    yDocument.destroy();
  });
});
