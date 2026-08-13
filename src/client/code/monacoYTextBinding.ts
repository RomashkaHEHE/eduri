import type * as Monaco from "monaco-editor";
import * as Y from "yjs";

export interface MonacoYTextBindingOptions {
  readonly yText: Y.Text;
  readonly model: Monaco.editor.ITextModel;
  readonly editor: Monaco.editor.IStandaloneCodeEditor;
  /**
   * Origin used for Monaco-authored Yjs transactions. Pass the workspace's
   * local command origin so the existing local-only UndoManager can track the
   * edits without tracking remote updates.
   */
  readonly transactionOrigin?: unknown;
}

export interface MonacoYTextBinding {
  readonly yText: Y.Text;
  readonly model: Monaco.editor.ITextModel;
  readonly editor: Monaco.editor.IStandaloneCodeEditor;
  readonly transactionOrigin: unknown;
  destroy(): void;
}

interface RelativeEditorSelection {
  readonly anchor: Y.RelativePosition;
  readonly head: Y.RelativePosition;
}

interface TextPatch {
  readonly offset: number;
  readonly deleteLength: number;
  readonly text: string;
}

type YTextDelta = ReadonlyArray<{
  readonly retain?: number;
  readonly insert?: string | object | Array<unknown>;
  readonly delete?: number;
  readonly attributes?: Record<string, unknown>;
}>;

function patchesFromDelta(delta: YTextDelta): TextPatch[] {
  const patches: TextPatch[] = [];
  let oldOffset = 0;
  let patchOffset: number | null = null;
  let deleteLength = 0;
  let text = "";

  const flush = (): void => {
    if (patchOffset === null) return;
    if (deleteLength > 0 || text.length > 0) {
      patches.push({ offset: patchOffset, deleteLength, text });
    }
    patchOffset = null;
    deleteLength = 0;
    text = "";
  };

  for (const operation of delta) {
    if (operation.retain !== undefined) {
      flush();
      oldOffset += operation.retain;
      continue;
    }
    if (operation.delete !== undefined) {
      patchOffset ??= oldOffset;
      deleteLength += operation.delete;
      oldOffset += operation.delete;
      continue;
    }
    if (operation.insert !== undefined) {
      if (typeof operation.insert !== "string") {
        throw new TypeError("Code Y.Text contains a non-text embed");
      }
      patchOffset ??= oldOffset;
      text += operation.insert;
    }
  }
  flush();
  return patches;
}

function isPlainYText(yText: Y.Text): boolean {
  return (yText.toDelta() as YTextDelta).every((operation) => (
    typeof operation.insert === "string"
    && operation.attributes === undefined
  ));
}

function captureSelections(
  yText: Y.Text,
  model: Monaco.editor.ITextModel,
  editor: Monaco.editor.IStandaloneCodeEditor,
): readonly RelativeEditorSelection[] {
  if (editor.getModel() !== model) return [];
  const selections = editor.getSelections();
  if (!selections) return [];
  return selections.map((selection) => {
    const anchorOffset = model.getOffsetAt({
      lineNumber: selection.selectionStartLineNumber,
      column: selection.selectionStartColumn,
    });
    const headOffset = model.getOffsetAt({
      lineNumber: selection.positionLineNumber,
      column: selection.positionColumn,
    });
    return {
      anchor: Y.createRelativePositionFromTypeIndex(yText, anchorOffset),
      head: Y.createRelativePositionFromTypeIndex(yText, headOffset),
    };
  });
}

function restoreSelections(
  yText: Y.Text,
  document: Y.Doc,
  model: Monaco.editor.ITextModel,
  editor: Monaco.editor.IStandaloneCodeEditor,
  selections: readonly RelativeEditorSelection[],
): void {
  if (selections.length === 0 || editor.getModel() !== model) return;
  const restored: Monaco.ISelection[] = [];
  for (const selection of selections) {
    const anchor = Y.createAbsolutePositionFromRelativePosition(
      selection.anchor,
      document,
    );
    const head = Y.createAbsolutePositionFromRelativePosition(
      selection.head,
      document,
    );
    if (!anchor || !head || anchor.type !== yText || head.type !== yText) {
      continue;
    }
    const anchorPosition = model.getPositionAt(anchor.index);
    const headPosition = model.getPositionAt(head.index);
    restored.push({
      selectionStartLineNumber: anchorPosition.lineNumber,
      selectionStartColumn: anchorPosition.column,
      positionLineNumber: headPosition.lineNumber,
      positionColumn: headPosition.column,
    });
  }
  if (restored.length > 0) editor.setSelections(restored, "yjs-remote");
}

/**
 * Keeps one exact Monaco model and one exact collaborative Y.Text in sync.
 * Remote Yjs deltas are applied as granular Monaco edits, so Monaco retains
 * its model, tokenization state, and viewport instead of receiving setValue
 * for every peer keystroke.
 */
export function attachMonacoYTextBinding(
  options: MonacoYTextBindingOptions,
): MonacoYTextBinding {
  const { yText, model, editor } = options;
  const document = yText.doc;
  if (!document) throw new TypeError("Cannot bind a detached Y.Text");
  if (editor.getModel() !== model) {
    throw new TypeError("Monaco editor must own the bound text model");
  }
  if (!isPlainYText(yText)) {
    throw new TypeError("Monaco can bind only plain collaborative text");
  }

  const transactionOrigin = options.transactionOrigin
    ?? Object.freeze({ type: "eduri.monaco.local-edit" });
  let destroyed = false;
  let applyingModelChangeToYText = false;
  let applyingYTextChangeToModel = false;
  let savedSelections: readonly RelativeEditorSelection[] = [];
  let modelChangeSubscription: Monaco.IDisposable | null = null;
  let modelDisposeSubscription: Monaco.IDisposable | null = null;
  let editorDisposeSubscription: Monaco.IDisposable | null = null;
  let editorModelSubscription: Monaco.IDisposable | null = null;

  // Y.Text is authoritative at attachment time. This is the only full-model
  // replacement performed by the binding; later collaboration is granular.
  const initialValue = yText.toString();
  if (model.getValue() !== initialValue) model.setValue(initialValue);

  const beforeAllTransactions = (): void => {
    if (destroyed || applyingModelChangeToYText) return;
    savedSelections = captureSelections(yText, model, editor);
  };

  const onYText = (event: Y.YTextEvent): void => {
    if (destroyed || applyingModelChangeToYText) return;
    let patches: TextPatch[];
    try {
      patches = patchesFromDelta(event.delta);
    } catch {
      // The canonical/server validator rejects embedded or formatted Y.Text.
      // If a poisoned local document nevertheless reaches this adapter, stop
      // applying further edits instead of throwing through Yjs observers and
      // leaving a partially active binding.
      destroy();
      return;
    }
    if (patches.length > 0) {
      const edits: Monaco.editor.IIdentifiedSingleEditOperation[] = patches.map(
        (patch) => {
          const start = model.getPositionAt(patch.offset);
          const end = model.getPositionAt(patch.offset + patch.deleteLength);
          return {
            range: {
              startLineNumber: start.lineNumber,
              startColumn: start.column,
              endLineNumber: end.lineNumber,
              endColumn: end.column,
            },
            text: patch.text,
            forceMoveMarkers: false,
          };
        },
      );
      applyingYTextChangeToModel = true;
      try {
        model.applyEdits(edits, false);
      } finally {
        applyingYTextChangeToModel = false;
      }
    }
    restoreSelections(yText, document, model, editor, savedSelections);
    savedSelections = [];
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    modelChangeSubscription?.dispose();
    modelDisposeSubscription?.dispose();
    editorDisposeSubscription?.dispose();
    editorModelSubscription?.dispose();
    modelChangeSubscription = null;
    modelDisposeSubscription = null;
    editorDisposeSubscription = null;
    editorModelSubscription = null;
    yText.unobserve(onYText);
    document.off("beforeAllTransactions", beforeAllTransactions);
    savedSelections = [];
  };

  modelChangeSubscription = model.onDidChangeContent((event) => {
    if (destroyed || applyingYTextChangeToModel) return;
    const changes = [...event.changes].sort((left, right) => (
      right.rangeOffset - left.rangeOffset
      || right.rangeLength - left.rangeLength
    ));
    applyingModelChangeToYText = true;
    try {
      document.transact(() => {
        for (const change of changes) {
          if (change.rangeLength > 0) {
            yText.delete(change.rangeOffset, change.rangeLength);
          }
          if (change.text.length > 0) yText.insert(change.rangeOffset, change.text);
        }
      }, transactionOrigin);
    } finally {
      applyingModelChangeToYText = false;
    }
  });

  modelDisposeSubscription = model.onWillDispose(destroy);
  editorDisposeSubscription = editor.onDidDispose(destroy);
  editorModelSubscription = editor.onDidChangeModel(() => {
    if (editor.getModel() !== model) destroy();
  });
  document.on("beforeAllTransactions", beforeAllTransactions);
  yText.observe(onYText);

  return {
    yText,
    model,
    editor,
    transactionOrigin,
    destroy,
  };
}
