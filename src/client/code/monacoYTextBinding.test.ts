import type * as Monaco from "monaco-editor";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { attachMonacoYTextBinding } from "./monacoYTextBinding";

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

class MockTextModel {
  value: string;
  setValueCalls = 0;
  applyEditsCalls = 0;
  private readonly changeListeners = new Set<
    (event: Monaco.editor.IModelContentChangedEvent) => void
  >();
  private readonly disposeListeners = new Set<() => void>();

  constructor(value: string) {
    this.value = value;
  }

  getValue = (): string => this.value;

  setValue = (value: string): void => {
    this.setValueCalls += 1;
    this.value = value;
  };

  getPositionAt = (offset: number): Monaco.IPosition => positionAt(this.value, offset);

  getOffsetAt = (position: Monaco.IPosition): number => offsetAt(this.value, position);

  onDidChangeContent = (
    listener: (event: Monaco.editor.IModelContentChangedEvent) => void,
  ): Disposable => {
    this.changeListeners.add(listener);
    return { dispose: () => this.changeListeners.delete(listener) };
  };

  onWillDispose = (listener: () => void): Disposable => {
    this.disposeListeners.add(listener);
    return { dispose: () => this.disposeListeners.delete(listener) };
  };

  applyEdits = (
    operations: readonly Monaco.editor.IIdentifiedSingleEditOperation[],
  ): Monaco.editor.IValidEditOperation[] => {
    this.applyEditsCalls += 1;
    const oldValue = this.value;
    const changes = operations.map((operation) => {
      const start = offsetAt(oldValue, {
        lineNumber: operation.range.startLineNumber,
        column: operation.range.startColumn,
      });
      const end = offsetAt(oldValue, {
        lineNumber: operation.range.endLineNumber,
        column: operation.range.endColumn,
      });
      return {
        range: operation.range,
        rangeOffset: start,
        rangeLength: end - start,
        text: operation.text ?? "",
      };
    });
    for (const change of [...changes].sort((left, right) => (
      right.rangeOffset - left.rangeOffset
    ))) {
      this.value = this.value.slice(0, change.rangeOffset)
        + change.text
        + this.value.slice(change.rangeOffset + change.rangeLength);
    }
    this.emit(changes);
    return [];
  };

  localEdit(offset: number, length: number, text: string): void {
    const start = positionAt(this.value, offset);
    const end = positionAt(this.value, offset + length);
    this.value = this.value.slice(0, offset)
      + text
      + this.value.slice(offset + length);
    this.emit([{
      range: {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
      rangeOffset: offset,
      rangeLength: length,
      text,
    }]);
  }

  dispose(): void {
    for (const listener of [...this.disposeListeners]) listener();
  }

  asModel(): Monaco.editor.ITextModel {
    return this as unknown as Monaco.editor.ITextModel;
  }

  private emit(changes: readonly Monaco.editor.IModelContentChange[]): void {
    const event = {
      changes,
      eol: "\n",
      isEolChange: false,
      isFlush: false,
      isRedoing: false,
      isUndoing: false,
      versionId: 1,
    } as Monaco.editor.IModelContentChangedEvent;
    for (const listener of [...this.changeListeners]) listener(event);
  }
}

class MockEditor {
  private model: Monaco.editor.ITextModel | null;
  private selections: Monaco.ISelection[] = [];
  readonly restoredSelections: Monaco.ISelection[][] = [];
  private readonly disposeListeners = new Set<() => void>();
  private readonly modelListeners = new Set<() => void>();

  constructor(model: Monaco.editor.ITextModel) {
    this.model = model;
  }

  getModel = (): Monaco.editor.ITextModel | null => this.model;

  getSelection = (): Monaco.Selection | null => (
    this.selections[0] as Monaco.Selection | undefined
  ) ?? null;

  getSelections = (): Monaco.Selection[] | null => (
    this.selections.map((selection) => ({ ...selection })) as Monaco.Selection[]
  );

  setSelections = (selections: readonly Monaco.ISelection[]): void => {
    this.selections = selections.map((selection) => ({ ...selection }));
    this.restoredSelections.push(this.selections.map((selection) => ({ ...selection })));
  };

  setOffsets(model: MockTextModel, anchor: number, head: number): void {
    const anchorPosition = model.getPositionAt(anchor);
    const headPosition = model.getPositionAt(head);
    this.selections = [{
      selectionStartLineNumber: anchorPosition.lineNumber,
      selectionStartColumn: anchorPosition.column,
      positionLineNumber: headPosition.lineNumber,
      positionColumn: headPosition.column,
    }];
  }

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

function offsets(
  model: MockTextModel,
  selection: Monaco.ISelection,
): readonly [number, number] {
  return [
    model.getOffsetAt({
      lineNumber: selection.selectionStartLineNumber,
      column: selection.selectionStartColumn,
    }),
    model.getOffsetAt({
      lineNumber: selection.positionLineNumber,
      column: selection.positionColumn,
    }),
  ];
}

describe("Monaco Y.Text binding", () => {
  it("uses one initial setValue and granular edits in both directions", () => {
    const document = new Y.Doc();
    const yText = document.getText("source");
    yText.insert(0, "alpha");
    const model = new MockTextModel("stale");
    const editor = new MockEditor(model.asModel());
    const origin = Object.freeze({ type: "local-test" });
    const binding = attachMonacoYTextBinding({
      yText,
      model: model.asModel(),
      editor: editor.asEditor(),
      transactionOrigin: origin,
    });

    expect(model.value).toBe("alpha");
    expect(model.setValueCalls).toBe(1);
    model.localEdit(5, 0, "!");
    expect(yText.toString()).toBe("alpha!");

    document.transact(() => {
      yText.delete(1, 2);
      yText.insert(1, "XYZ");
    }, Object.freeze({ type: "remote-test" }));
    expect(model.value).toBe("aXYZha!");
    expect(model.applyEditsCalls).toBe(1);
    expect(model.setValueCalls).toBe(1);

    binding.destroy();
    document.destroy();
  });

  it("tags Monaco changes with the origin tracked by local-only undo", () => {
    const document = new Y.Doc();
    const yText = document.getText("source");
    yText.insert(0, "abc");
    const origin = Object.freeze({ type: "local-test" });
    const undoManager = new Y.UndoManager(yText, {
      trackedOrigins: new Set([origin]),
      captureTimeout: 0,
    });
    const model = new MockTextModel("abc");
    const editor = new MockEditor(model.asModel());
    const binding = attachMonacoYTextBinding({
      yText,
      model: model.asModel(),
      editor: editor.asEditor(),
      transactionOrigin: origin,
    });

    model.localEdit(3, 0, "d");
    expect(yText.toString()).toBe("abcd");
    expect(binding.transactionOrigin).toBe(origin);
    undoManager.undo();
    expect(yText.toString()).toBe("abc");
    expect(model.value).toBe("abc");
    undoManager.redo();
    expect(yText.toString()).toBe("abcd");
    expect(model.value).toBe("abcd");

    binding.destroy();
    undoManager.destroy();
    document.destroy();
  });

  it("preserves the directional editor selection across a remote insertion", () => {
    const document = new Y.Doc();
    const yText = document.getText("source");
    yText.insert(0, "hello world");
    const model = new MockTextModel(yText.toString());
    const editor = new MockEditor(model.asModel());
    editor.setOffsets(model, 11, 6);
    const binding = attachMonacoYTextBinding({
      yText,
      model: model.asModel(),
      editor: editor.asEditor(),
    });

    document.transact(() => yText.insert(0, "say "), { remote: true });

    expect(model.value).toBe("say hello world");
    const restored = editor.restoredSelections.at(-1)?.[0];
    expect(restored).toBeDefined();
    expect(offsets(model, restored!)).toEqual([15, 10]);

    binding.destroy();
    document.destroy();
  });

  it("detaches every observer and listener on destroy", () => {
    const document = new Y.Doc();
    const yText = document.getText("source");
    yText.insert(0, "one");
    const model = new MockTextModel("one");
    const editor = new MockEditor(model.asModel());
    const binding = attachMonacoYTextBinding({
      yText,
      model: model.asModel(),
      editor: editor.asEditor(),
    });

    binding.destroy();
    binding.destroy();
    model.localEdit(3, 0, " local");
    expect(yText.toString()).toBe("one");
    yText.insert(0, "remote ");
    expect(model.value).toBe("one local");
    expect(model.applyEditsCalls).toBe(0);

    document.destroy();
  });

  it("rejects a model which is not mounted in the supplied editor", () => {
    const document = new Y.Doc();
    const yText = document.getText("source");
    const mounted = new MockTextModel("");
    const other = new MockTextModel("");
    const editor = new MockEditor(mounted.asModel());

    expect(() => attachMonacoYTextBinding({
      yText,
      model: other.asModel(),
      editor: editor.asEditor(),
    })).toThrow("must own the bound text model");
    document.destroy();
  });

  it("rejects embedded text before binding and detaches on a later embed", () => {
    const poisoned = new Y.Doc();
    const poisonedText = poisoned.getText("source");
    poisonedText.insertEmbed(0, { unsafe: true });
    const poisonedModel = new MockTextModel("");
    const poisonedEditor = new MockEditor(poisonedModel.asModel());
    expect(() => attachMonacoYTextBinding({
      yText: poisonedText,
      model: poisonedModel.asModel(),
      editor: poisonedEditor.asEditor(),
    })).toThrow("plain collaborative text");

    const document = new Y.Doc();
    const yText = document.getText("source");
    yText.insert(0, "safe");
    const model = new MockTextModel("safe");
    const editor = new MockEditor(model.asModel());
    attachMonacoYTextBinding({
      yText,
      model: model.asModel(),
      editor: editor.asEditor(),
    });
    expect(() => yText.insertEmbed(4, { unsafe: true })).not.toThrow();
    expect(model.value).toBe("safe");
    yText.insert(0, "ignored");
    expect(model.value).toBe("safe");
    poisoned.destroy();
    document.destroy();
  });
});
