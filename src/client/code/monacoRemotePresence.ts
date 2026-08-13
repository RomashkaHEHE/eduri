import type * as Monaco from "monaco-editor";
import * as Y from "yjs";
import { CODE_SYNC_LIMITS } from "../../code/protocol/constants.js";

export interface EncodedYTextSelection {
  readonly anchor: Uint8Array;
  readonly head: Uint8Array;
}

export interface MonacoRemotePresencePeer {
  readonly participantId: string;
  readonly displayName: string;
  readonly color: string;
  readonly selections?: readonly EncodedYTextSelection[];
}

export interface MonacoRemotePresenceRendererOptions {
  readonly yText: Y.Text;
  readonly model: Monaco.editor.ITextModel;
  readonly editor: Monaco.editor.IStandaloneCodeEditor;
  readonly ownerDocument?: Document;
}

export interface MonacoRemotePresenceRenderer {
  setPeers(peers: readonly MonacoRemotePresencePeer[]): void;
  destroy(): void;
}

export interface AbsoluteYTextSelection {
  readonly anchor: number;
  readonly head: number;
}

interface DecodedSelection {
  readonly participantId: string;
  readonly displayName: string;
  readonly color: `#${string}`;
  readonly selectionIndex: number;
  readonly absolute: AbsoluteYTextSelection;
  readonly anchorPosition: Monaco.IPosition;
  readonly headPosition: Monaco.IPosition;
}

const PARTICIPANT_COLOR = /^#[0-9a-f]{6}$/iu;
const FALLBACK_COLOR = "#2563eb" as const;
const EXACT_CONTENT_WIDGET_POSITION = (
  0 as Monaco.editor.ContentWidgetPositionPreference
);
const REMOTE_CARET_HOVER_STYLES = `
@media (hover: hover) {
  [data-eduri-remote-caret-hitbox="true"] {
    pointer-events: auto !important;
  }

  [data-eduri-remote-caret-hitbox="true"]:hover
    ~ [data-eduri-remote-caret-label="true"] {
    opacity: 1 !important;
    transition-delay: 0s !important;
    visibility: visible !important;
  }

  [data-eduri-remote-caret-hitbox="true"]:hover {
    cursor: text;
  }
}`;
let nextRendererId = 1;

function safeColor(value: string): `#${string}` {
  return PARTICIPANT_COLOR.test(value)
    ? value.toLowerCase() as `#${string}`
    : FALLBACK_COLOR;
}

function readableTextColor(color: `#${string}`): "#111827" | "#ffffff" {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return red * 299 + green * 587 + blue * 114 > 155_000
    ? "#111827"
    : "#ffffff";
}

function selectionBackground(color: `#${string}`): string {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return `rgba(${red}, ${green}, ${blue}, 0.22)`;
}

function copySelections(
  selections: readonly EncodedYTextSelection[] | undefined,
): readonly EncodedYTextSelection[] | undefined {
  return selections?.slice(0, CODE_SYNC_LIMITS.maxYTextSelections).map(
    (selection) => ({
      anchor: selection.anchor.slice(),
      head: selection.head.slice(),
    }),
  );
}

/** Encode Monaco's ordered directional selections as Yjs-relative positions. */
export function encodeMonacoYTextSelections(
  yText: Y.Text,
  model: Monaco.editor.ITextModel,
  editor: Monaco.editor.IStandaloneCodeEditor,
): readonly EncodedYTextSelection[] | null {
  if (!yText.doc || editor.getModel() !== model) return null;
  const selections = editor.getSelections();
  if (!selections || selections.length === 0) return null;
  try {
    return selections
      .slice(0, CODE_SYNC_LIMITS.maxYTextSelections)
      .map((selection) => {
        const anchor = model.getOffsetAt({
          lineNumber: selection.selectionStartLineNumber,
          column: selection.selectionStartColumn,
        });
        const head = model.getOffsetAt({
          lineNumber: selection.positionLineNumber,
          column: selection.positionColumn,
        });
        return {
          anchor: Y.encodeRelativePosition(
            Y.createRelativePositionFromTypeIndex(yText, anchor),
          ),
          head: Y.encodeRelativePosition(
            Y.createRelativePositionFromTypeIndex(yText, head),
          ),
        };
      });
  } catch {
    return null;
  }
}

/**
 * Decode a wire-safe relative selection and accept it only when both endpoints
 * resolve into the exact Y.Text rendered by this editor.
 */
export function decodeExactYTextSelection(
  yText: Y.Text,
  selection: EncodedYTextSelection,
): AbsoluteYTextSelection | null {
  const document = yText.doc;
  if (!document) return null;
  try {
    const anchor = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(selection.anchor),
      document,
    );
    const head = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(selection.head),
      document,
    );
    if (
      !anchor
      || !head
      || anchor.type !== yText
      || head.type !== yText
      || !Number.isSafeInteger(anchor.index)
      || !Number.isSafeInteger(head.index)
      || anchor.index < 0
      || head.index < 0
      || anchor.index > yText.length
      || head.index > yText.length
    ) return null;
    return { anchor: anchor.index, head: head.index };
  } catch {
    return null;
  }
}

class RemoteCaretWidget implements Monaco.editor.IContentWidget {
  readonly allowEditorOverflow = true;
  readonly suppressMouseDown = true;
  private readonly root: HTMLSpanElement;
  private readonly caret: HTMLSpanElement;
  private readonly hitbox: HTMLSpanElement;
  private readonly label: HTMLSpanElement;
  private position: Monaco.IPosition | null = null;

  constructor(
    private readonly id: string,
    ownerDocument: Document,
  ) {
    this.root = ownerDocument.createElement("span");
    this.root.dataset.eduriRemoteCaret = "true";
    this.root.setAttribute("aria-hidden", "true");
    Object.assign(this.root.style, {
      display: "block",
      width: "0",
      height: "0",
      overflow: "visible",
      pointerEvents: "none",
      position: "relative",
      zIndex: "30",
    });

    this.caret = ownerDocument.createElement("span");
    this.caret.dataset.eduriRemoteCaretLine = "true";
    Object.assign(this.caret.style, {
      borderRadius: "1px",
      display: "block",
      height: "1.35em",
      left: "-1px",
      pointerEvents: "none",
      position: "absolute",
      top: "-0.15em",
      width: "2px",
    });

    this.hitbox = ownerDocument.createElement("span");
    this.hitbox.dataset.eduriRemoteCaretHitbox = "true";
    Object.assign(this.hitbox.style, {
      display: "block",
      height: "1.65em",
      left: "-9px",
      pointerEvents: "none",
      position: "absolute",
      top: "-0.3em",
      width: "18px",
      zIndex: "1",
    });

    this.label = ownerDocument.createElement("span");
    this.label.dataset.eduriRemoteCaretLabel = "true";
    Object.assign(this.label.style, {
      borderRadius: "4px 4px 4px 0",
      display: "block",
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: "11px",
      fontWeight: "600",
      left: "-1px",
      lineHeight: "16px",
      maxWidth: "180px",
      opacity: "0",
      overflow: "hidden",
      padding: "1px 5px",
      pointerEvents: "none",
      position: "absolute",
      textOverflow: "ellipsis",
      top: "-22px",
      transition: "opacity 120ms ease, visibility 0s linear 120ms",
      visibility: "hidden",
      whiteSpace: "nowrap",
      zIndex: "2",
    });
    this.root.append(this.caret, this.hitbox, this.label);
  }

  getId(): string {
    return this.id;
  }

  getDomNode(): HTMLElement {
    return this.root;
  }

  getPosition(): Monaco.editor.IContentWidgetPosition | null {
    return this.position
      ? { position: this.position, preference: [EXACT_CONTENT_WIDGET_POSITION] }
      : null;
  }

  update(
    position: Monaco.IPosition,
    displayName: string,
    color: `#${string}`,
  ): void {
    this.position = { ...position };
    this.caret.style.backgroundColor = color;
    this.label.style.backgroundColor = color;
    this.label.style.color = readableTextColor(color);
    this.label.textContent = displayName.slice(0, 128);
  }
}

/**
 * Renders remote selections and overlay carets without injecting characters
 * into Monaco's text layout. Widgets remain stable for each participant.
 */
export function createMonacoRemotePresenceRenderer(
  options: MonacoRemotePresenceRendererOptions,
): MonacoRemotePresenceRenderer {
  const { yText, model, editor } = options;
  if (!yText.doc) throw new TypeError("Cannot render presence for a detached Y.Text");
  if (editor.getModel() !== model) {
    throw new TypeError("Monaco editor must own the presence text model");
  }
  const ownerDocument = options.ownerDocument
    ?? editor.getDomNode()?.ownerDocument
    ?? globalThis.document;
  if (!ownerDocument) throw new TypeError("Remote presence requires a document");

  const rendererId = nextRendererId;
  nextRendererId += 1;
  const decorations = editor.createDecorationsCollection();
  const style = ownerDocument.createElement("style");
  style.dataset.eduriMonacoRemotePresence = String(rendererId);
  ownerDocument.head.append(style);
  const widgets = new Map<string, {
    readonly token: string;
    readonly widget: RemoteCaretWidget;
  }>();
  let nextPeerToken = 1;
  let peers: readonly MonacoRemotePresencePeer[] = [];
  let lastSignature: string | null = null;
  let destroyed = false;

  const render = (): void => {
    if (destroyed) return;
    const unique = new Map<string, MonacoRemotePresencePeer>();
    for (const peer of peers) {
      if (!peer.participantId || unique.has(peer.participantId)) continue;
      unique.set(peer.participantId, peer);
    }
    const decoded: DecodedSelection[] = [];
    for (const peer of [...unique.values()].sort((left, right) => (
      left.participantId.localeCompare(right.participantId)
    ))) {
      for (const [selectionIndex, selection] of (
        peer.selections ?? []
      ).slice(0, CODE_SYNC_LIMITS.maxYTextSelections).entries()) {
        const absolute = decodeExactYTextSelection(yText, selection);
        if (!absolute) continue;
        decoded.push({
          participantId: peer.participantId,
          displayName: peer.displayName,
          color: safeColor(peer.color),
          selectionIndex,
          absolute,
          anchorPosition: model.getPositionAt(absolute.anchor),
          headPosition: model.getPositionAt(absolute.head),
        });
      }
    }
    const signature = JSON.stringify(decoded.map((selection) => [
      selection.participantId,
      selection.displayName,
      selection.color,
      selection.selectionIndex,
      selection.absolute.anchor,
      selection.absolute.head,
      selection.anchorPosition.lineNumber,
      selection.anchorPosition.column,
      selection.headPosition.lineNumber,
      selection.headPosition.column,
    ]));
    if (signature === lastSignature) return;
    lastSignature = signature;

    const activeWidgetKeys = new Set(decoded.map((selection) => (
      `${selection.participantId}:${selection.selectionIndex}`
    )));
    for (const [widgetKey, record] of widgets) {
      if (activeWidgetKeys.has(widgetKey)) continue;
      editor.removeContentWidget(record.widget);
      widgets.delete(widgetKey);
    }

    const modelDecorations: Monaco.editor.IModelDeltaDecoration[] = [];
    const rules: string[] = [];
    for (const selection of decoded) {
      const widgetKey = `${selection.participantId}:${selection.selectionIndex}`;
      let record = widgets.get(widgetKey);
      if (!record) {
        const token = `r${rendererId}-p${nextPeerToken}`;
        nextPeerToken += 1;
        const widget = new RemoteCaretWidget(
          `eduri.monaco.remote-caret.${token}`,
          ownerDocument,
        );
        record = { token, widget };
        widgets.set(widgetKey, record);
        editor.addContentWidget(widget);
      }
      record.widget.update(
        selection.headPosition,
        selection.displayName,
        selection.color,
      );
      editor.layoutContentWidget(record.widget);

      const className = `eduri-monaco-remote-selection-${record.token}`;
      rules.push(
        `.${className}{background-color:${selectionBackground(selection.color)}`
        + `!important;box-shadow:inset 0 -1px 0 ${selection.color};}`,
      );
      if (selection.absolute.anchor === selection.absolute.head) continue;
      const startOffset = Math.min(
        selection.absolute.anchor,
        selection.absolute.head,
      );
      const endOffset = Math.max(
        selection.absolute.anchor,
        selection.absolute.head,
      );
      const start = selection.absolute.anchor === startOffset
        ? selection.anchorPosition
        : selection.headPosition;
      const end = selection.absolute.anchor === endOffset
        ? selection.anchorPosition
        : selection.headPosition;
      modelDecorations.push({
        range: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        },
        options: {
          inlineClassName: className,
          inlineClassNameAffectsLetterSpacing: false,
          hoverMessage: { value: selection.displayName.slice(0, 128) },
          zIndex: 20,
        },
      });
    }
    style.textContent = [REMOTE_CARET_HOVER_STYLES, ...rules].join("\n");
    decorations.set(modelDecorations);
  };

  const onText = (): void => render();
  const modelChangeSubscription = model.onDidChangeContent(render);
  yText.observe(onText);

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    yText.unobserve(onText);
    modelChangeSubscription.dispose();
    modelDisposeSubscription.dispose();
    editorDisposeSubscription.dispose();
    editorModelSubscription.dispose();
    decorations.clear();
    for (const record of widgets.values()) {
      editor.removeContentWidget(record.widget);
    }
    widgets.clear();
    style.remove();
    peers = [];
    lastSignature = null;
  }

  const modelDisposeSubscription = model.onWillDispose(destroy);
  const editorDisposeSubscription = editor.onDidDispose(destroy);
  const editorModelSubscription = editor.onDidChangeModel(() => {
    if (editor.getModel() !== model) destroy();
  });

  return {
    setPeers(nextPeers) {
      if (destroyed) return;
      peers = nextPeers.map((peer) => ({
        participantId: peer.participantId,
        displayName: peer.displayName,
        color: peer.color,
        selections: copySelections(peer.selections),
      }));
      render();
    },
    destroy,
  };
}
