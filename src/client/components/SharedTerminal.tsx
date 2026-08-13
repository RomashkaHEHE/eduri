import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
} from "react";

const MAX_TERMINAL_INPUT = 1_024;
const MAX_PENDING_CLAIM_INPUT = 4_096;
const PENDING_INPUT_ECHO_TIMEOUT_MS = 1_500;
const CONTROL_SEQUENCE = /[\u0000-\u001f\u007f]/gu;
const PARTICIPANT_COLOR = /^#[0-9a-f]{6}$/iu;
const REMOTE_CARET_HITBOX_SIZE = 18;

export interface SharedTerminalSnapshot {
  readonly generation: number;
  readonly revision: number;
  readonly transcript: string;
  readonly prompt: string;
  readonly input: string;
  readonly cursor: number;
  readonly busy: boolean;
  readonly inputOwnerParticipantId?: string | null;
  readonly inputOwnerName?: string | null;
  readonly inputOwnerColor?: string | null;
}

export interface SharedTerminalProps {
  readonly snapshot: SharedTerminalSnapshot;
  readonly localParticipantId: string | null;
  readonly claimRejectionRevision?: number;
  readonly submitRejectionRevision?: number;
  readonly readOnly: boolean;
  readonly theme: "light" | "dark";
  readonly onEditInput: (value: string, cursor: number) => void;
  readonly onSubmitLine: (value: string) => void | Promise<void>;
  readonly onInterrupt: () => void;
  readonly onEof: () => void;
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
}

function terminalText(value: string): string {
  return value.replace(/\r\n|\n|\r/gu, "\r\n");
}

function visibleInput(value: string): string {
  return value.replace(CONTROL_SEQUENCE, "").slice(0, MAX_TERMINAL_INPUT);
}

function clampCursor(value: string, cursor: number): number {
  return Math.max(0, Math.min(value.length, Math.trunc(cursor)));
}

function safeParticipantColor(value: string | null | undefined): `#${string}` {
  return value && PARTICIPANT_COLOR.test(value)
    ? value.toLowerCase() as `#${string}`
    : "#2563eb";
}

function readableParticipantColor(color: `#${string}`): "#111827" | "#ffffff" {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return red * 299 + green * 587 + blue * 114 > 155_000
    ? "#111827"
    : "#ffffff";
}

function previousGraphemeStart(value: string, cursor: number): number {
  const before = value.slice(0, cursor);
  if (!before) return 0;
  if (typeof Intl.Segmenter === "function") {
    const segments = [...new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    }).segment(before)];
    return segments.at(-1)?.index ?? Math.max(0, cursor - 1);
  }
  const points = [...before];
  return before.length - (points.at(-1)?.length ?? 1);
}

function nextGraphemeEnd(value: string, cursor: number): number {
  if (cursor >= value.length) return value.length;
  const after = value.slice(cursor);
  if (typeof Intl.Segmenter === "function") {
    const first = new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    }).segment(after)[Symbol.iterator]().next().value as
      | { readonly segment: string }
      | undefined;
    return Math.min(value.length, cursor + (first?.segment.length ?? 1));
  }
  return Math.min(value.length, cursor + ([...after][0]?.length ?? 1));
}

function terminalColumns(value: string): number {
  let columns = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (/\p{Mark}/u.test(character) || code === 0x200d || code === 0xfe0f) continue;
    columns += code >= 0x1100 && (
      code <= 0x115f
      || code === 0x2329
      || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe10 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0x1f300 && code <= 0x1faff)
    ) ? 2 : 1;
  }
  return columns;
}

function moveUp(terminal: Terminal, rows: number): void {
  if (rows > 0) terminal.write(`\x1b[${rows}A`);
}

function moveRight(terminal: Terminal, columns: number): void {
  if (columns > 0) terminal.write(`\x1b[${columns}C`);
}

function terminalWidth(terminal: Terminal): number {
  return Math.max(2, Math.trunc(terminal.cols) || 80);
}

function transcriptTrailingColumns(value: string): number {
  const trailingLine = value.slice(Math.max(
    value.lastIndexOf("\n"),
    value.lastIndexOf("\r"),
  ) + 1);
  return terminalColumns(trailingLine);
}

function appendTrailingColumns(current: number, value: string): number {
  if (value.includes("\n") || value.includes("\r")) {
    return transcriptTrailingColumns(value);
  }
  return current + terminalColumns(value);
}

function inputLayout(
  terminal: Terminal,
  snapshot: SharedTerminalSnapshot,
  transcriptColumns = transcriptTrailingColumns(snapshot.transcript),
): {
  readonly anchor: number;
  readonly cursor: number;
  readonly end: number;
  readonly columns: number;
} {
  const columns = terminalWidth(terminal);
  const anchor = transcriptColumns % columns;
  return {
    anchor,
    cursor: anchor
      + terminalColumns(snapshot.prompt)
      + terminalColumns(snapshot.input.slice(0, snapshot.cursor)),
    end: anchor
      + terminalColumns(snapshot.prompt)
      + terminalColumns(snapshot.input),
    columns,
  };
}

function placeCursorAfterInput(
  terminal: Terminal,
  snapshot: SharedTerminalSnapshot,
  transcriptColumns?: number,
): void {
  const layout = inputLayout(terminal, snapshot, transcriptColumns);
  if (layout.cursor === layout.end) return;
  moveUp(
    terminal,
    Math.floor(layout.end / layout.columns)
      - Math.floor(layout.cursor / layout.columns),
  );
  terminal.write("\r");
  moveRight(terminal, layout.cursor % layout.columns);
}

function clearRenderedInput(
  terminal: Terminal,
  snapshot: SharedTerminalSnapshot,
  transcriptColumns?: number,
): void {
  if (!snapshot.prompt && !snapshot.input) return;
  const layout = inputLayout(terminal, snapshot, transcriptColumns);
  const cursorRow = Math.floor(layout.cursor / layout.columns);
  const endRow = Math.floor(layout.end / layout.columns);
  moveUp(terminal, cursorRow);
  terminal.write("\r");
  moveRight(terminal, layout.anchor % layout.columns);
  terminal.write("\x1b[K");
  for (let row = 1; row <= endRow; row += 1) {
    terminal.write("\x1b[1B\r\x1b[2K");
  }
  moveUp(terminal, endRow);
  terminal.write("\r");
  moveRight(terminal, layout.anchor % layout.columns);
}

function renderInput(
  terminal: Terminal,
  snapshot: SharedTerminalSnapshot,
  transcriptColumns?: number,
): void {
  terminal.write(`${snapshot.prompt}${snapshot.input}`);
  placeCursorAfterInput(terminal, snapshot, transcriptColumns);
}

function replaceInputAtAnchor(
  terminal: Terminal,
  previous: SharedTerminalSnapshot,
  next: SharedTerminalSnapshot,
  transcriptColumns?: number,
): void {
  clearRenderedInput(terminal, previous, transcriptColumns);
  renderInput(terminal, next, transcriptColumns);
}

function suffixPrefixOverlap(previous: string, next: string): number {
  const maximum = Math.min(previous.length, next.length);
  if (maximum === 0) return 0;
  const candidate = `${next.slice(0, maximum)}\u0000${previous.slice(-maximum)}`;
  const prefix = new Uint32Array(candidate.length);
  for (let index = 1; index < candidate.length; index += 1) {
    let length = prefix[index - 1] ?? 0;
    while (length > 0 && candidate[index] !== candidate[length]) {
      length = prefix[length - 1] ?? 0;
    }
    if (candidate[index] === candidate[length]) length += 1;
    prefix[index] = length;
  }
  return Math.min(prefix.at(-1) ?? 0, maximum);
}

/**
 * xterm-backed shared command line. The input is rendered on the terminal's
 * active row, never in a detached HTML input. Application-generated ANSI is
 * limited to erasing/repositioning that row; program output arrives as text.
 */
export function SharedTerminal({
  snapshot,
  localParticipantId,
  claimRejectionRevision = 0,
  submitRejectionRevision = 0,
  readOnly,
  theme,
  onEditInput,
  onSubmitLine,
  onInterrupt,
  onEof,
  onFocus,
  onBlur,
}: SharedTerminalProps) {
  const [reconciliationRevision, requestRender] = useReducer(
    (value: number) => value + 1,
    0,
  );
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const terminalDataHandlerRef = useRef<(data: string) => void>(() => undefined);
  const renderedRef = useRef<SharedTerminalSnapshot | null>(null);
  const renderedTranscriptColumnsRef = useRef(
    transcriptTrailingColumns(snapshot.transcript),
  );
  const snapshotRef = useRef(snapshot);
  const serverSnapshotRef = useRef(snapshot);
  const pendingInputRef = useRef<{
    readonly generation: number;
    readonly prompt: string;
    readonly value: string;
    readonly cursor: number;
    readonly token: number;
  } | null>(null);
  const pendingInputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextPendingInputTokenRef = useRef(1);
  const focusedRef = useRef(false);
  const claimPendingRef = useRef(false);
  const pendingClaimDataRef = useRef<string[]>([]);
  const pendingClaimDataLengthRef = useRef(0);
  const submitPendingRef = useRef<{
    readonly generation: number;
    readonly revision: number;
    readonly value: string;
    readonly token: number;
  } | null>(null);
  const nextSubmitTokenRef = useRef(1);
  const handledClaimRejectionRevisionRef = useRef(claimRejectionRevision);
  const handledSubmitRejectionRevisionRef = useRef(submitRejectionRevision);
  const readOnlyRef = useRef(readOnly);
  const localParticipantIdRef = useRef(localParticipantId);
  const updateRemoteCaretRef = useRef<() => void>(() => undefined);
  const callbacksRef = useRef({
    onEditInput,
    onSubmitLine,
    onInterrupt,
    onEof,
    onFocus,
    onBlur,
  });
  serverSnapshotRef.current = snapshot;
  if (!pendingInputRef.current) snapshotRef.current = snapshot;
  readOnlyRef.current = readOnly;
  localParticipantIdRef.current = localParticipantId;
  callbacksRef.current = {
    onEditInput,
    onSubmitLine,
    onInterrupt,
    onEof,
    onFocus,
    onBlur,
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      disableStdin: readOnlyRef.current || !(
        snapshotRef.current.busy
        || (Boolean(localParticipantIdRef.current)
          && snapshotRef.current.inputOwnerParticipantId
            === localParticipantIdRef.current)
      ),
      fontFamily: '"Cascadia Code", Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5_000,
      theme: theme === "dark"
        ? {
            background: "#181918",
            foreground: "#ddddda",
            cursor: snapshotRef.current.inputOwnerColor ?? "#91b4f4",
            selectionBackground: "#414851",
          }
        : {
            background: "#f7f9fb",
            foreground: "#263442",
            cursor: snapshotRef.current.inputOwnerColor ?? "#2459d6",
            selectionBackground: "#d9e8fb",
          },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    terminalRef.current = terminal;
    const caretOverlay = host.ownerDocument.createElement("span");
    caretOverlay.dataset.eduriTerminalRemoteCaret = "true";
    caretOverlay.dataset.hovered = "false";
    caretOverlay.setAttribute("aria-hidden", "true");
    Object.assign(caretOverlay.style, {
      display: "none",
      height: "0",
      overflow: "visible",
      pointerEvents: "none",
      position: "absolute",
      width: "0",
      zIndex: "8",
    });
    const caretHitbox = host.ownerDocument.createElement("span");
    caretHitbox.dataset.eduriTerminalRemoteCaretHitbox = "true";
    Object.assign(caretHitbox.style, {
      left: "-9px",
      pointerEvents: "none",
      position: "absolute",
      width: `${REMOTE_CARET_HITBOX_SIZE}px`,
    });
    const caretLabel = host.ownerDocument.createElement("span");
    caretLabel.dataset.eduriTerminalRemoteCaretLabel = "true";
    Object.assign(caretLabel.style, {
      opacity: "0",
      pointerEvents: "none",
      position: "absolute",
      transition: "opacity 120ms ease, visibility 0s linear 120ms",
      visibility: "hidden",
    });
    caretOverlay.append(caretHitbox, caretLabel);
    host.append(caretOverlay);
    let caretBounds: {
      readonly left: number;
      readonly right: number;
      readonly top: number;
      readonly bottom: number;
    } | null = null;
    let lastPointer: {
      readonly clientX: number;
      readonly clientY: number;
      readonly pointerType: string;
    } | null = null;
    const hoverQuery = host.ownerDocument.defaultView?.matchMedia?.("(hover: hover)")
      ?? null;
    let caretHovered = false;
    const setCaretHovered = (hovered: boolean): void => {
      if (caretHovered === hovered) return;
      caretHovered = hovered;
      caretOverlay.dataset.hovered = hovered ? "true" : "false";
      caretLabel.style.opacity = hovered ? "1" : "0";
      caretLabel.style.visibility = hovered ? "visible" : "hidden";
    };
    const refreshCaretHover = (): void => {
      const hovered = Boolean(
        hoverQuery?.matches
        && lastPointer
        && lastPointer.pointerType !== "touch"
        && caretBounds
        && lastPointer.clientX >= caretBounds.left
        && lastPointer.clientX <= caretBounds.right
        && lastPointer.clientY >= caretBounds.top
        && lastPointer.clientY <= caretBounds.bottom
      );
      setCaretHovered(hovered);
    };
    const updateRemoteCaret = (): void => {
      const current = snapshotRef.current;
      const ownerName = current.inputOwnerName?.trim().slice(0, 128) ?? "";
      const isRemoteOwner = Boolean(
        current.inputOwnerParticipantId
        && current.inputOwnerParticipantId !== localParticipantIdRef.current
        && ownerName,
      );
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      const activeBuffer = terminal.buffer?.active;
      const columns = Math.trunc(terminal.cols);
      const rows = Math.trunc(terminal.rows);
      if (!isRemoteOwner || !screen || !activeBuffer || columns < 1 || rows < 1) {
        caretBounds = null;
        caretOverlay.style.display = "none";
        setCaretHovered(false);
        return;
      }
      const hostRect = host.getBoundingClientRect();
      const screenRect = screen.getBoundingClientRect();
      const row = activeBuffer.baseY + activeBuffer.cursorY
        - activeBuffer.viewportY;
      if (
        row < 0
        || row >= rows
        || screenRect.width <= 0
        || screenRect.height <= 0
      ) {
        caretBounds = null;
        caretOverlay.style.display = "none";
        setCaretHovered(false);
        return;
      }
      const cellWidth = screenRect.width / columns;
      const cellHeight = screenRect.height / rows;
      const column = Math.max(0, Math.min(columns - 1, activeBuffer.cursorX));
      const clientLeft = screenRect.left + column * cellWidth;
      const clientTop = screenRect.top + row * cellHeight;
      const hitboxHeight = Math.max(REMOTE_CARET_HITBOX_SIZE, cellHeight);
      caretBounds = {
        left: clientLeft - REMOTE_CARET_HITBOX_SIZE / 2,
        right: clientLeft + REMOTE_CARET_HITBOX_SIZE / 2,
        top: clientTop - (hitboxHeight - cellHeight) / 2,
        bottom: clientTop + cellHeight + (hitboxHeight - cellHeight) / 2,
      };
      const color = safeParticipantColor(current.inputOwnerColor);
      caretLabel.textContent = ownerName;
      caretLabel.style.backgroundColor = color;
      caretLabel.style.color = readableParticipantColor(color);
      caretLabel.style.left = column >= columns / 2 ? "1px" : "-1px";
      caretLabel.style.top = row === 0 ? `${cellHeight}px` : "-22px";
      caretLabel.style.transform = column >= columns / 2
        ? "translateX(-100%)"
        : "none";
      caretHitbox.style.height = `${hitboxHeight}px`;
      caretHitbox.style.top = `${-(hitboxHeight - cellHeight) / 2}px`;
      caretOverlay.style.display = "block";
      caretOverlay.style.left = `${clientLeft - hostRect.left}px`;
      caretOverlay.style.top = `${clientTop - hostRect.top}px`;
      refreshCaretHover();
    };
    updateRemoteCaretRef.current = updateRemoteCaret;
    const pointerMoveListener = (event: PointerEvent): void => {
      lastPointer = {
        clientX: event.clientX,
        clientY: event.clientY,
        pointerType: event.pointerType,
      };
      refreshCaretHover();
    };
    const pointerLeaveListener = (): void => {
      lastPointer = null;
      setCaretHovered(false);
    };
    const hoverChangeListener = (): void => refreshCaretHover();
    host.addEventListener("pointermove", pointerMoveListener);
    host.addEventListener("pointerleave", pointerLeaveListener);
    hoverQuery?.addEventListener?.("change", hoverChangeListener);
    const caretSubscriptions = [
      terminal.onCursorMove?.(updateRemoteCaret),
      terminal.onRender?.(updateRemoteCaret),
      terminal.onResize?.(updateRemoteCaret),
      terminal.onScroll?.(updateRemoteCaret),
      terminal.onWriteParsed?.(updateRemoteCaret),
    ];
    const initialSnapshot = snapshotRef.current;
    const initialTranscriptColumns = transcriptTrailingColumns(
      initialSnapshot.transcript,
    );
    if (initialSnapshot.transcript) {
      terminal.write(terminalText(initialSnapshot.transcript));
    }
    renderInput(terminal, initialSnapshot, initialTranscriptColumns);
    renderedRef.current = initialSnapshot;
    renderedTranscriptColumnsRef.current = initialTranscriptColumns;

    const beginSubmission = (
      current: SharedTerminalSnapshot,
      value: string,
    ): void => {
      const token = nextSubmitTokenRef.current;
      nextSubmitTokenRef.current += 1;
      submitPendingRef.current = {
        generation: current.generation,
        revision: current.revision,
        value,
        token,
      };
      terminal.options.disableStdin = true;
      try {
        const submission = callbacksRef.current.onSubmitLine(value);
        if (submission && typeof submission.then === "function") {
          void submission.catch(() => {
            if (submitPendingRef.current?.token !== token) return;
            submitPendingRef.current = null;
            requestRender();
          });
        }
      } catch {
        if (submitPendingRef.current?.token === token) {
          submitPendingRef.current = null;
          requestRender();
        }
      }
    };

    terminalDataHandlerRef.current = (data) => {
      if (readOnlyRef.current) return;
      const current = snapshotRef.current;
      if (current.busy) {
        if (data === "\u0003") callbacksRef.current.onInterrupt();
        else if (data === "\u0004") callbacksRef.current.onEof();
        return;
      }
      // Enter may need to wait for the collaborative document outbox before
      // the terminal action can be sent. Freeze this line immediately so a
      // later edit-input action cannot overtake the delayed submit and then be
      // cleared by it on the server.
      if (submitPendingRef.current) return;
      const ownsInput = Boolean(localParticipantIdRef.current)
        && current.inputOwnerParticipantId === localParticipantIdRef.current;
      if (!ownsInput) {
        if (
          claimPendingRef.current
          && current.inputOwnerParticipantId == null
          && pendingClaimDataLengthRef.current < MAX_PENDING_CLAIM_INPUT
        ) {
          const remaining = MAX_PENDING_CLAIM_INPUT
            - pendingClaimDataLengthRef.current;
          const accepted = data.slice(0, remaining);
          if (accepted) {
            pendingClaimDataRef.current.push(accepted);
            pendingClaimDataLengthRef.current += accepted.length;
          }
        }
        return;
      }
      if (data === "\r") {
        beginSubmission(current, current.input);
        return;
      }
      if (data === "\u0003") {
        callbacksRef.current.onInterrupt();
        return;
      }
      if (data === "\u0004") {
        callbacksRef.current.onEof();
        return;
      }
      if (current.busy) return;
      if (data === "\u000c") {
        beginSubmission(current, "clear");
        return;
      }
      let value = current.input;
      let cursor = clampCursor(value, current.cursor);
      if (data === "\u007f") {
        if (cursor === 0) return;
        const start = previousGraphemeStart(value, cursor);
        value = value.slice(0, start) + value.slice(cursor);
        cursor = start;
      } else if (data === "\x1b[D") {
        cursor = previousGraphemeStart(value, cursor);
      } else if (data === "\x1b[C") {
        cursor = nextGraphemeEnd(value, cursor);
      } else if (data === "\x1b[H" || data === "\x1bOH") {
        cursor = 0;
      } else if (data === "\x1b[F" || data === "\x1bOF") {
        cursor = value.length;
      } else if (data.startsWith("\x1b")) {
        return;
      } else {
        const insertion = visibleInput(data);
        if (!insertion) return;
        const available = MAX_TERMINAL_INPUT - value.length;
        if (available <= 0) return;
        const accepted = insertion.slice(0, available);
        value = value.slice(0, cursor) + accepted + value.slice(cursor);
        cursor += accepted.length;
      }
      const optimistic = { ...current, input: value, cursor };
      const token = nextPendingInputTokenRef.current;
      nextPendingInputTokenRef.current += 1;
      pendingInputRef.current = {
        generation: current.generation,
        prompt: current.prompt,
        value,
        cursor,
        token,
      };
      if (pendingInputTimerRef.current !== null) {
        globalThis.clearTimeout(pendingInputTimerRef.current);
      }
      pendingInputTimerRef.current = globalThis.setTimeout(() => {
        if (pendingInputRef.current?.token !== token) return;
        pendingInputRef.current = null;
        pendingInputTimerRef.current = null;
        snapshotRef.current = serverSnapshotRef.current;
        requestRender();
      }, PENDING_INPUT_ECHO_TIMEOUT_MS);
      snapshotRef.current = optimistic;
      replaceInputAtAnchor(
        terminal,
        current,
        optimistic,
        renderedTranscriptColumnsRef.current,
      );
      renderedRef.current = optimistic;
      callbacksRef.current.onEditInput(value, cursor);
    };
    const inputDisposable = terminal.onData((data) => {
      terminalDataHandlerRef.current(data);
    });
    const focusListener = () => {
      focusedRef.current = true;
      const current = snapshotRef.current;
      if (
        !readOnlyRef.current
        && !current.busy
        && current.inputOwnerParticipantId == null
        && localParticipantIdRef.current
      ) {
        claimPendingRef.current = true;
        pendingClaimDataRef.current = [];
        pendingClaimDataLengthRef.current = 0;
        // xterm must continue emitting keyboard events during the network RTT;
        // they are buffered above without being drawn until the lease arrives.
        terminal.options.disableStdin = false;
      }
      callbacksRef.current.onFocus?.();
    };
    const blurListener = () => {
      focusedRef.current = false;
      claimPendingRef.current = false;
      pendingClaimDataRef.current = [];
      pendingClaimDataLengthRef.current = 0;
      pendingInputRef.current = null;
      if (pendingInputTimerRef.current !== null) {
        globalThis.clearTimeout(pendingInputTimerRef.current);
        pendingInputTimerRef.current = null;
      }
      snapshotRef.current = serverSnapshotRef.current;
      callbacksRef.current.onBlur?.();
      requestRender();
    };
    host.addEventListener("focusin", focusListener);
    host.addEventListener("focusout", blurListener);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          fit.fit();
          updateRemoteCaret();
        });
    resizeObserver?.observe(host);
    updateRemoteCaret();

    return () => {
      resizeObserver?.disconnect();
      for (const subscription of caretSubscriptions) subscription?.dispose();
      hoverQuery?.removeEventListener?.("change", hoverChangeListener);
      host.removeEventListener("pointermove", pointerMoveListener);
      host.removeEventListener("pointerleave", pointerLeaveListener);
      host.removeEventListener("focusin", focusListener);
      host.removeEventListener("focusout", blurListener);
      inputDisposable.dispose();
      terminalDataHandlerRef.current = () => undefined;
      focusedRef.current = false;
      claimPendingRef.current = false;
      pendingClaimDataRef.current = [];
      pendingClaimDataLengthRef.current = 0;
      if (pendingInputTimerRef.current !== null) {
        globalThis.clearTimeout(pendingInputTimerRef.current);
        pendingInputTimerRef.current = null;
      }
      pendingInputRef.current = null;
      submitPendingRef.current = null;
      updateRemoteCaretRef.current = () => undefined;
      caretOverlay.remove();
      terminal.dispose();
      terminalRef.current = null;
      renderedRef.current = null;
      renderedTranscriptColumnsRef.current = 0;
    };
  }, []);

  useLayoutEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const previouslyRendered = renderedRef.current;
    let claimedInput: string[] | null = null;
    let requestFocusedClaim = false;
    if (
      handledClaimRejectionRevisionRef.current !== claimRejectionRevision
    ) {
      handledClaimRejectionRevisionRef.current = claimRejectionRevision;
      claimPendingRef.current = false;
      pendingClaimDataRef.current = [];
      pendingClaimDataLengthRef.current = 0;
      pendingInputRef.current = null;
      if (pendingInputTimerRef.current !== null) {
        globalThis.clearTimeout(pendingInputTimerRef.current);
        pendingInputTimerRef.current = null;
      }
      snapshotRef.current = serverSnapshotRef.current;
    }
    if (
      handledSubmitRejectionRevisionRef.current !== submitRejectionRevision
    ) {
      handledSubmitRejectionRevisionRef.current = submitRejectionRevision;
      submitPendingRef.current = null;
      snapshotRef.current = serverSnapshotRef.current;
    }
    const pendingSubmit = submitPendingRef.current;
    if (
      pendingSubmit
      && (
        readOnly
        || snapshot.generation !== pendingSubmit.generation
        || (
          snapshot.revision > pendingSubmit.revision
          && (
            snapshot.busy
            || snapshot.inputOwnerParticipantId !== localParticipantId
            || snapshot.input !== pendingSubmit.value
          )
        )
      )
    ) {
      submitPendingRef.current = null;
    }
    if (claimPendingRef.current) {
      if (
        readOnly
        || (snapshot.inputOwnerParticipantId != null
          && snapshot.inputOwnerParticipantId !== localParticipantId)
      ) {
        claimPendingRef.current = false;
        pendingClaimDataRef.current = [];
        pendingClaimDataLengthRef.current = 0;
      } else if (
        localParticipantId
        && snapshot.inputOwnerParticipantId === localParticipantId
      ) {
        claimPendingRef.current = false;
        claimedInput = pendingClaimDataRef.current;
        pendingClaimDataRef.current = [];
        pendingClaimDataLengthRef.current = 0;
      }
    }
    if (
      focusedRef.current
      && !readOnly
      && localParticipantId
      && !snapshot.busy
      && snapshot.inputOwnerParticipantId == null
      && !claimPendingRef.current
      && Boolean(
        previouslyRendered?.busy
        || previouslyRendered?.inputOwnerParticipantId != null
      )
    ) {
      // Submitting a command releases the input lease while xterm keeps DOM
      // focus. Ask for the next lease as soon as the prompt returns so the
      // following keystroke is not silently ignored until a blur/refocus.
      claimPendingRef.current = true;
      pendingClaimDataRef.current = [];
      pendingClaimDataLengthRef.current = 0;
      requestFocusedClaim = true;
    }
    let renderedSnapshot = snapshot;
    const pendingInput = pendingInputRef.current;
    if (pendingInput) {
      const stillOwnsInput = Boolean(localParticipantId)
        && snapshot.inputOwnerParticipantId === localParticipantId;
      const acknowledged = stillOwnsInput
        && snapshot.generation === pendingInput.generation
        && snapshot.input === pendingInput.value
        && snapshot.cursor === pendingInput.cursor;
      if (acknowledged) {
        pendingInputRef.current = null;
        if (pendingInputTimerRef.current !== null) {
          globalThis.clearTimeout(pendingInputTimerRef.current);
          pendingInputTimerRef.current = null;
        }
      } else if (
        stillOwnsInput
        && snapshot.generation === pendingInput.generation
        && snapshot.prompt === pendingInput.prompt
        && !snapshot.busy
      ) {
        // Socket.IO preserves action order, but React may render an earlier
        // authoritative echo after several locally typed characters. Keep the
        // latest local draft until its echo arrives so a subsequent key cannot
        // be based on stale text. A bounded timeout still resolves a rejected
        // input lease back to the server's state.
        renderedSnapshot = {
          ...snapshot,
          input: pendingInput.value,
          cursor: pendingInput.cursor,
        };
      } else {
        pendingInputRef.current = null;
        if (pendingInputTimerRef.current !== null) {
          globalThis.clearTimeout(pendingInputTimerRef.current);
          pendingInputTimerRef.current = null;
        }
      }
    }
    const ownsInput = Boolean(localParticipantId)
      && renderedSnapshot.inputOwnerParticipantId === localParticipantId;
    terminal.options.disableStdin = readOnly || Boolean(submitPendingRef.current) || !(
      ownsInput
      || snapshot.busy
      || (focusedRef.current && claimPendingRef.current)
    );
    terminal.options.theme = theme === "dark"
      ? {
          background: "#181918",
          foreground: "#ddddda",
          cursor: renderedSnapshot.inputOwnerColor ?? "#91b4f4",
          selectionBackground: "#414851",
        }
      : {
          background: "#f7f9fb",
          foreground: "#263442",
          cursor: renderedSnapshot.inputOwnerColor ?? "#2459d6",
          selectionBackground: "#d9e8fb",
        };

    const previous = renderedRef.current;
    const previousTranscriptColumns = renderedTranscriptColumnsRef.current;
    const canAppend = previous
      && previous.generation === renderedSnapshot.generation
      && renderedSnapshot.transcript.startsWith(previous.transcript);
    const overlap = previous
      && renderedSnapshot.transcript !== previous.transcript
      && !canAppend
      && previous.generation === renderedSnapshot.generation
      && renderedSnapshot.revision >= previous.revision
      ? suffixPrefixOverlap(previous.transcript, renderedSnapshot.transcript)
      : 0;
    const canAppendAfterTrim = previous
      && previous.generation === renderedSnapshot.generation
      && renderedSnapshot.revision >= previous.revision
      && overlap > 0;
    let nextTranscriptColumns = previousTranscriptColumns;
    if (!canAppend && !canAppendAfterTrim) {
      terminal.reset();
      nextTranscriptColumns = transcriptTrailingColumns(
        renderedSnapshot.transcript,
      );
      if (renderedSnapshot.transcript) {
        terminal.write(terminalText(renderedSnapshot.transcript));
      }
      renderInput(terminal, renderedSnapshot, nextTranscriptColumns);
    } else if (renderedSnapshot.transcript !== previous.transcript) {
      clearRenderedInput(terminal, previous, previousTranscriptColumns);
      const appendedAt = canAppend ? previous.transcript.length : overlap;
      const appended = renderedSnapshot.transcript.slice(appendedAt);
      nextTranscriptColumns = appendTrailingColumns(
        previousTranscriptColumns,
        appended,
      );
      terminal.write(terminalText(appended));
      renderInput(terminal, renderedSnapshot, nextTranscriptColumns);
    } else if (
      renderedSnapshot.prompt !== previous.prompt
      ||
      renderedSnapshot.input !== previous.input
      || renderedSnapshot.cursor !== previous.cursor
    ) {
      replaceInputAtAnchor(
        terminal,
        previous,
        renderedSnapshot,
        previousTranscriptColumns,
      );
    }
    renderedRef.current = renderedSnapshot;
    renderedTranscriptColumnsRef.current = nextTranscriptColumns;
    snapshotRef.current = renderedSnapshot;
    updateRemoteCaretRef.current();
    if (claimedInput) {
      for (const data of claimedInput) terminalDataHandlerRef.current(data);
    }
    if (requestFocusedClaim) callbacksRef.current.onFocus?.();
  }, [
    claimRejectionRevision,
    localParticipantId,
    readOnly,
    reconciliationRevision,
    snapshot,
    submitRejectionRevision,
    theme,
  ]);

  return (
    <div
      ref={hostRef}
      className="code-shared-terminal"
      role="textbox"
      aria-label="Общий терминал"
      aria-readonly={readOnly}
      data-busy={snapshot.busy ? "true" : "false"}
      data-input-owned={
        localParticipantId
          && snapshot.inputOwnerParticipantId === localParticipantId
          ? "true"
          : "false"
      }
    />
  );
}
