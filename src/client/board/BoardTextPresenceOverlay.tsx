import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import * as Y from "yjs";
import {
  BUILTIN_OBJECT_KINDS,
  boardTextLayoutMode,
  getCollaborativeText,
  type BoardObjectRecord,
} from "../../board/core";
import { boardObjectSnapshot } from "./rendering/objectSnapshot";
import type {
  BoardCamera,
  BoardPresence,
  BoardTheme,
} from "./rendering/types";
import {
  contentEditableDomPoint,
  renderCollaborativeRichTextDom,
} from "./collaborativeRichTextBinding";
import { boardTextEditorStyle } from "./textLayout";

interface PresenceRect {
  readonly key: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly clientLeft: number;
  readonly clientTop: number;
  readonly clientRight: number;
  readonly clientBottom: number;
  readonly color: string;
  readonly caret: boolean;
  readonly label?: string;
}

const PARTICIPANT_COLOR = /^#[0-9a-f]{6}$/iu;

function safeColor(color: string): string {
  return PARTICIPANT_COLOR.test(color) ? color.toLowerCase() : "#2563eb";
}

function readableTextColor(color: string): "#111827" | "#ffffff" {
  const normalized = safeColor(color);
  const red = Number.parseInt(normalized.slice(1, 3), 16);
  const green = Number.parseInt(normalized.slice(3, 5), 16);
  const blue = Number.parseInt(normalized.slice(5, 7), 16);
  return red * 299 + green * 587 + blue * 114 > 155_000
    ? "#111827"
    : "#ffffff";
}

function selectionColor(color: string): string {
  const normalized = safeColor(color);
  const red = Number.parseInt(normalized.slice(1, 3), 16);
  const green = Number.parseInt(normalized.slice(3, 5), 16);
  const blue = Number.parseInt(normalized.slice(5, 7), 16);
  return `rgba(${red}, ${green}, ${blue}, 0.22)`;
}

function absoluteSelection(
  document: Y.Doc,
  text: Y.Text,
  presence: BoardPresence,
): { readonly anchor: number; readonly head: number } | null {
  const selection = presence.textSelection;
  if (!selection) return null;
  try {
    const anchor = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(Uint8Array.from(selection.anchor)),
      document,
    );
    const head = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(Uint8Array.from(selection.head)),
      document,
    );
    if (
      !anchor
      || !head
      || anchor.type !== text
      || head.type !== text
      || !Number.isSafeInteger(anchor.index)
      || !Number.isSafeInteger(head.index)
      || anchor.index < 0
      || head.index < 0
      || anchor.index > text.length
      || head.index > text.length
    ) return null;
    return { anchor: anchor.index, head: head.index };
  } catch {
    return null;
  }
}

function caretClientRect(range: Range, editor: HTMLElement): DOMRect | null {
  const direct = range.getBoundingClientRect();
  if (direct.height > 0) return direct;
  const selection = range.cloneRange();
  const point = range.startOffset;
  if (range.startContainer.nodeType === Node.TEXT_NODE && point > 0) {
    selection.setStart(range.startContainer, point - 1);
    const previous = selection.getBoundingClientRect();
    if (previous.height > 0) {
      return new DOMRect(previous.right, previous.top, 0, previous.height);
    }
  }
  const editorRect = editor.getBoundingClientRect();
  const fontSize = Number.parseFloat(getComputedStyle(editor).fontSize) || 20;
  return editorRect.height > 0
    ? new DOMRect(editorRect.left + 2, editorRect.top + 2, 0, fontSize * 1.25)
    : null;
}

function BoardTextPresenceOverlay({
  document,
  editor,
  objectId,
  presences,
  revision,
  text,
  viewRevision,
}: {
  readonly document: Y.Doc;
  readonly editor: HTMLDivElement | null;
  readonly objectId: string;
  readonly presences: readonly BoardPresence[];
  readonly revision: number;
  readonly text: Y.Text;
  readonly viewRevision: string;
}) {
  const [rects, setRects] = useState<readonly PresenceRect[]>([]);
  const [hoveredCaret, setHoveredCaret] = useState<string | null>(null);
  const surface = editor?.closest<HTMLElement>(".board-v2") ?? null;

  useLayoutEffect(() => {
    if (!editor || !surface) {
      setRects([]);
      return;
    }
    const surfaceRect = surface.getBoundingClientRect();
    const next: PresenceRect[] = [];
    for (const presence of presences) {
      if (presence.textSelection?.objectId !== objectId) continue;
      const selection = absoluteSelection(document, text, presence);
      if (!selection) continue;
      const anchor = Math.max(0, Math.min(text.length, selection.anchor));
      const head = Math.max(0, Math.min(text.length, selection.head));
      const start = contentEditableDomPoint(editor, Math.min(anchor, head));
      const end = contentEditableDomPoint(editor, Math.max(anchor, head));
      const range = editor.ownerDocument.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      if (anchor !== head) {
        for (const [index, rect] of [...range.getClientRects()].entries()) {
          if (rect.width <= 0 || rect.height <= 0) continue;
          next.push({
            key: `${presence.clientId}-selection-${index}`,
            left: rect.left - surfaceRect.left,
            top: rect.top - surfaceRect.top,
            width: rect.width,
            height: rect.height,
            clientLeft: rect.left,
            clientTop: rect.top,
            clientRight: rect.right,
            clientBottom: rect.bottom,
            color: selectionColor(presence.color),
            caret: false,
          });
        }
      }
      const caretPoint = contentEditableDomPoint(editor, head);
      range.setStart(caretPoint.node, caretPoint.offset);
      range.collapse(true);
      const caret = caretClientRect(range, editor);
      if (caret) {
        const color = safeColor(presence.color);
        next.push({
          key: `${presence.clientId}-caret`,
          left: caret.left - surfaceRect.left,
          top: caret.top - surfaceRect.top,
          width: 2,
          height: Math.max(10, caret.height),
          clientLeft: caret.left - 9,
          clientTop: caret.top - 4,
          clientRight: caret.left + 9,
          clientBottom: caret.bottom + 4,
          color,
          caret: true,
          label: presence.displayName.slice(0, 128),
        });
      }
    }
    setRects(next);
  }, [document, editor, objectId, presences, revision, surface, text, viewRevision]);

  useEffect(() => {
    if (!surface) return;
    const hoverQuery = surface.ownerDocument.defaultView?.matchMedia?.("(hover: hover)")
      ?? null;
    const pointerMove = (event: PointerEvent) => {
      if (!hoverQuery?.matches || event.pointerType === "touch") {
        setHoveredCaret(null);
        return;
      }
      const hovered = [...rects].reverse().find((rect) => (
        rect.caret
        && event.clientX >= rect.clientLeft
        && event.clientX <= rect.clientRight
        && event.clientY >= rect.clientTop
        && event.clientY <= rect.clientBottom
      ));
      setHoveredCaret((current) => current === hovered?.key
        ? current
        : hovered?.key ?? null);
    };
    const pointerLeave = () => setHoveredCaret(null);
    surface.addEventListener("pointermove", pointerMove);
    surface.addEventListener("pointerleave", pointerLeave);
    return () => {
      surface.removeEventListener("pointermove", pointerMove);
      surface.removeEventListener("pointerleave", pointerLeave);
    };
  }, [rects, surface]);

  if (!surface || rects.length === 0) return null;
  return createPortal((
    <div className="board-v2__text-presence" aria-hidden="true">
      {rects.map((rect) => (
        <span
          key={rect.key}
          data-board-text-remote-caret={rect.caret ? "true" : undefined}
          data-board-text-remote-selection={!rect.caret ? "true" : undefined}
          className={rect.caret
            ? `board-v2__text-remote-caret${hoveredCaret === rect.key ? " is-hovered" : ""}`
            : "board-v2__text-remote-selection"}
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            backgroundColor: rect.color,
            "--remote-text-color": rect.color,
            "--remote-text-foreground": readableTextColor(rect.color),
          } as CSSProperties}
        >
          {rect.label && <span>{rect.label}</span>}
        </span>
      ))}
    </div>
  ), surface);
}

function BoardTextPresenceMirror({
  document,
  objectId,
  presences,
  revision,
  text,
  camera,
  theme,
  object,
}: {
  readonly document: Y.Doc;
  readonly objectId: string;
  readonly presences: readonly BoardPresence[];
  readonly revision: number;
  readonly text: Y.Text;
  readonly camera: BoardCamera;
  readonly theme: BoardTheme;
  readonly object: ReturnType<typeof boardObjectSnapshot>;
}) {
  const [editor, setEditor] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (editor) renderCollaborativeRichTextDom(editor, text);
  }, [editor, revision, text]);
  const autoWidth = boardTextLayoutMode(object.props.layoutMode) === "auto-width";

  return (
    <div
      className={`board-v2__text-presence-mirror${autoWidth ? " board-v2__editor--auto-width" : ""}`}
      data-board-text-presence-mirror={objectId}
      style={boardTextEditorStyle(object, camera, theme)}
    >
      <div
        ref={setEditor}
        className="board-v2__text-contenteditable board-v2__text-presence-content"
        aria-hidden="true"
      />
      <BoardTextPresenceOverlay
        document={document}
        editor={editor}
        objectId={objectId}
        presences={presences}
        revision={revision}
        text={text}
        viewRevision={`${camera.x}:${camera.y}:${camera.zoom}`}
      />
    </div>
  );
}

export function BoardTextPresenceLayer({
  document,
  objects,
  presences,
  camera,
  theme,
}: {
  readonly document: Y.Doc;
  readonly objects: Y.Map<BoardObjectRecord>;
  readonly presences: readonly BoardPresence[];
  readonly camera: BoardCamera;
  readonly theme: BoardTheme;
}) {
  const [revision, setRevision] = useState(0);
  const hasTextPresence = presences.some((presence) => presence.textSelection);
  useEffect(() => {
    if (!hasTextPresence) return;
    const changed = () => setRevision((value) => value + 1);
    objects.observeDeep(changed);
    return () => objects.unobserveDeep(changed);
  }, [hasTextPresence, objects]);

  const grouped = useMemo(() => {
    const result = new Map<string, BoardPresence[]>();
    for (const presence of presences) {
      const objectId = presence.textSelection?.objectId;
      if (!objectId) continue;
      const group = result.get(objectId) ?? [];
      group.push(presence);
      result.set(objectId, group);
    }
    return [...result].flatMap(([objectId, objectPresences]) => {
      const record = objects.get(objectId);
      if (!record) return [];
      const object = boardObjectSnapshot(record, objectId);
      if (object.kind !== BUILTIN_OBJECT_KINDS.text) return [];
      const text = getCollaborativeText(record, "text");
      return text ? [{ objectId, objectPresences, object, text }] : [];
    });
  }, [objects, presences, revision]);

  return grouped.map((entry) => (
    <BoardTextPresenceMirror
      key={entry.objectId}
      document={document}
      objectId={entry.objectId}
      presences={entry.objectPresences}
      revision={revision}
      text={entry.text}
      camera={camera}
      theme={theme}
      object={entry.object}
    />
  ));
}
