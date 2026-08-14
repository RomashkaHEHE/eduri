import {
  type CSSProperties,
  type FocusEventHandler,
  type FormEventHandler,
  type KeyboardEventHandler,
  type PointerEventHandler,
  type ReactNode,
  type RefCallback,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CodeAwarenessState,
  CodeParticipantIdentity,
  CodeScalarAwarenessTarget,
  CodeScalarInputPresence,
} from "../../code/protocol/types.js";
import { CODE_SYNC_LIMITS } from "../../code/protocol/constants.js";

const PARTICIPANT_COLOR = /^#[0-9a-f]{6}$/iu;
const FALLBACK_COLOR = "#2563eb" as const;
const MAX_COLLIDING_CARET_OFFSET = 5;
const NATIVE_REMOTE_CARET_OVERLAY_STYLES = `
[data-eduri-native-remote-overlay="true"],
[data-eduri-native-remote-overlay="true"] * {
  pointer-events: none !important;
}`;

export interface NativeInputPresencePeer {
  readonly participant: CodeParticipantIdentity;
  readonly state: CodeAwarenessState;
}

export type NativeInputPresencePublisher = (
  owner: symbol,
  state: CodeAwarenessState | null,
) => void;

export interface NativeInputPresenceBinding {
  readonly ref: RefCallback<HTMLInputElement>;
  readonly onFocus: FocusEventHandler<HTMLInputElement>;
  readonly onBlur: FocusEventHandler<HTMLInputElement>;
  readonly onInput: FormEventHandler<HTMLInputElement>;
  readonly onSelect: FormEventHandler<HTMLInputElement>;
  readonly onKeyUp: KeyboardEventHandler<HTMLInputElement>;
  readonly onPointerUp: PointerEventHandler<HTMLInputElement>;
  readonly onScroll: FormEventHandler<HTMLInputElement>;
}

export interface UseNativeInputPresenceOptions {
  readonly target: CodeScalarAwarenessTarget;
  /** The controlled value, used to republish after an external value update. */
  readonly value: string;
  readonly peers: readonly NativeInputPresencePeer[];
  readonly publish: NativeInputPresencePublisher;
}

export interface UseNativeInputPresenceResult {
  readonly containerRef: RefCallback<HTMLDivElement>;
  readonly onContainerPointerMove: PointerEventHandler<HTMLDivElement>;
  readonly onContainerPointerLeave: PointerEventHandler<HTMLDivElement>;
  readonly inputProps: NativeInputPresenceBinding;
  readonly overlay: ReactNode;
}

export interface NativeInputPresenceProps
  extends UseNativeInputPresenceOptions {
  readonly children: (inputProps: NativeInputPresenceBinding) => ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
}

interface MirrorMetrics {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly borderRadius: string;
  readonly borderLeftWidth: number;
  readonly borderRightWidth: number;
  readonly borderTopWidth: number;
  readonly borderBottomWidth: number;
  readonly paddingLeft: string;
  readonly paddingRight: string;
  readonly fontFamily: string;
  readonly fontSize: string;
  readonly fontStyle: string;
  readonly fontWeight: string;
  readonly letterSpacing: string;
  readonly textAlign: CSSProperties["textAlign"];
  readonly textTransform: CSSProperties["textTransform"];
  readonly direction: CSSProperties["direction"];
  readonly scrollLeft: number;
}

function safeColor(value: string): `#${string}` {
  return PARTICIPANT_COLOR.test(value)
    ? value.toLowerCase() as `#${string}`
    : FALLBACK_COLOR;
}

function selectionBackground(color: `#${string}`): string {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return `rgba(${red}, ${green}, ${blue}, 0.22)`;
}

function readableTextColor(color: `#${string}`): "#111827" | "#ffffff" {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return red * 299 + green * 587 + blue * 114 > 155_000
    ? "#111827"
    : "#ffffff";
}

function scalarTargetsEqual(
  left: CodeScalarAwarenessTarget,
  right: CodeScalarAwarenessTarget,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "test" && right.kind === "test") {
    return left.testId === right.testId && left.field === right.field;
  }
  return left.kind === "explorer"
    && right.kind === "explorer"
    && left.entryId === right.entryId;
}

function stateHasScalarTarget(
  state: CodeAwarenessState,
): state is Extract<CodeAwarenessState, { target: CodeScalarAwarenessTarget }> {
  return state.target.kind === "explorer"
    || (
      state.target.kind === "test"
      && (state.target.field === "name" || state.target.field === "timeout")
    );
}

function validScalarInput(
  input: CodeScalarInputPresence | undefined,
): input is CodeScalarInputPresence {
  return input !== undefined
    && input.draft.length <= CODE_SYNC_LIMITS.maxScalarDraftLength
    && Number.isSafeInteger(input.selection.anchor)
    && Number.isSafeInteger(input.selection.head)
    && input.selection.anchor >= 0
    && input.selection.head >= 0
    && input.selection.anchor <= input.draft.length
    && input.selection.head <= input.draft.length;
}

/** Pick one stable peer so labels and overlapping selections never flicker. */
export function visibleNativeInputPresencePeer(
  peers: readonly NativeInputPresencePeer[],
  target: CodeScalarAwarenessTarget,
): NativeInputPresencePeer | null {
  return visibleNativeInputPresencePeers(peers, target)[0] ?? null;
}

/** Return every valid peer at this field in deterministic participant order. */
export function visibleNativeInputPresencePeers(
  peers: readonly NativeInputPresencePeer[],
  target: CodeScalarAwarenessTarget,
): readonly NativeInputPresencePeer[] {
  const unique = new Map<string, NativeInputPresencePeer>();
  const ordered = [...peers].sort((left, right) => {
    const participantOrder = left.participant.participantId.localeCompare(
      right.participant.participantId,
    );
    if (participantOrder !== 0) return participantOrder;
    // Duplicate IDs are not expected from the provider map, but choosing a
    // deterministic copy keeps malformed/replayed lists visually stable.
    return JSON.stringify(left).localeCompare(JSON.stringify(right));
  });
  for (const peer of ordered) {
    if (
      stateHasScalarTarget(peer.state)
      && scalarTargetsEqual(peer.state.target, target)
      && validScalarInput(peer.state.input)
      && !unique.has(peer.participant.participantId)
    ) {
      unique.set(peer.participant.participantId, peer);
    }
  }
  return [...unique.values()];
}

function nativeSelection(input: HTMLInputElement): {
  readonly anchor: number;
  readonly head: number;
} {
  let start: number | null = null;
  let end: number | null = null;
  let direction: typeof input.selectionDirection = null;
  try {
    start = input.selectionStart;
    end = input.selectionEnd;
    direction = input.selectionDirection;
  } catch {
    // Some native input types (notably number) do not expose a selection API.
  }
  const safeStart = Math.min(input.value.length, Math.max(0, start ?? input.value.length));
  const safeEnd = Math.min(input.value.length, Math.max(safeStart, end ?? safeStart));
  return direction === "backward"
    ? { anchor: safeEnd, head: safeStart }
    : { anchor: safeStart, head: safeEnd };
}

/** Build bounded awareness directly from the native input's current DOM state. */
export function nativeInputAwarenessState(
  target: CodeScalarAwarenessTarget,
  input: HTMLInputElement,
): CodeAwarenessState {
  if (input.value.length > CODE_SYNC_LIMITS.maxScalarDraftLength) {
    return { target };
  }
  return {
    target,
    input: {
      draft: input.value,
      selection: nativeSelection(input),
    },
  };
}

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function sameMetrics(left: MirrorMetrics | null, right: MirrorMetrics): boolean {
  return left !== null
    && Object.keys(right).every((key) => (
      left[key as keyof MirrorMetrics] === right[key as keyof MirrorMetrics]
    ));
}

function PresenceCaret({
  color,
  displayName,
  collisionOffset,
  hovered,
}: {
  readonly color: `#${string}`;
  readonly displayName: string;
  readonly collisionOffset: number;
  readonly hovered: boolean;
}) {
  const caretLeft = -1
    + Math.min(collisionOffset, MAX_COLLIDING_CARET_OFFSET) * 2;
  return (
    <span
      data-eduri-native-remote-caret="true"
      data-hovered={hovered ? "true" : "false"}
      style={{
        display: "inline-block",
        height: "1em",
        pointerEvents: "none",
        position: "relative",
        verticalAlign: "text-bottom",
        width: 0,
      }}
    >
      <span
        data-eduri-native-remote-caret-line="true"
        style={{
          backgroundColor: color,
          borderRadius: 1,
          height: "1.25em",
          left: caretLeft,
          pointerEvents: "none",
          position: "absolute",
          top: "-0.15em",
          width: 2,
        }}
      />
      <span
        data-eduri-native-remote-hitbox="true"
        style={{
          display: "block",
          height: "1.65em",
          left: caretLeft - 8,
          pointerEvents: "none",
          position: "absolute",
          top: "-0.3em",
          width: 18,
          zIndex: 1,
        }}
      />
      <span
        data-eduri-native-remote-label="true"
        style={{
          backgroundColor: color,
          borderRadius: "3px 3px 3px 0",
          color: readableTextColor(color),
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 9,
          fontStyle: "normal",
          fontWeight: 600,
          left: caretLeft,
          lineHeight: "12px",
          maxWidth: 120,
          opacity: hovered ? 1 : 0,
          overflow: "hidden",
          padding: "0 3px",
          pointerEvents: "none",
          position: "absolute",
          textOverflow: "ellipsis",
          top: "-1.45em",
          transition: hovered
            ? "opacity 120ms ease"
            : "opacity 120ms ease, visibility 0s linear 120ms",
          visibility: hovered ? "visible" : "hidden",
          whiteSpace: "nowrap",
          zIndex: 2,
        }}
      >
        {displayName.slice(0, 128)}
      </span>
    </span>
  );
}

function PresenceText({
  input,
  color,
  displayName,
  collisionOffset,
  hovered,
}: {
  readonly input: CodeScalarInputPresence;
  readonly color: `#${string}`;
  readonly displayName: string;
  readonly collisionOffset: number;
  readonly hovered: boolean;
}) {
  const { draft, selection } = input;
  const selectionStart = Math.min(selection.anchor, selection.head);
  const selectionEnd = Math.max(selection.anchor, selection.head);
  const boundaries = [...new Set([
    0,
    selectionStart,
    selectionEnd,
    selection.head,
    draft.length,
  ])].sort((left, right) => left - right);
  const content: ReactNode[] = [];
  for (let index = 0; index < boundaries.length; index += 1) {
    const offset = boundaries[index]!;
    if (offset === selection.head) {
      content.push(
        <PresenceCaret
          key={`caret-${offset}`}
          color={color}
          displayName={displayName}
          collisionOffset={collisionOffset}
          hovered={hovered}
        />,
      );
    }
    const next = boundaries[index + 1];
    if (next === undefined || next <= offset) continue;
    const selected = offset >= selectionStart && next <= selectionEnd;
    content.push(
      <span
        key={`text-${offset}`}
        data-eduri-native-remote-selection={selected ? "true" : undefined}
        style={selected ? {
          backgroundColor: selectionBackground(color),
          boxShadow: `inset 0 -1px 0 ${color}`,
        } : undefined}
      >
        {draft.slice(offset, next)}
      </span>,
    );
  }
  return content;
}

export function useNativeInputPresence({
  target,
  value,
  peers,
  publish,
}: UseNativeInputPresenceOptions): UseNativeInputPresenceResult {
  const ownerRef = useRef(Symbol("eduri-native-input-presence"));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerElementRef = useRef<HTMLDivElement | null>(null);
  const focusedRef = useRef(false);
  const ownsPresenceRef = useRef(false);
  const lastPublishedRef = useRef<string | null>(null);
  const targetRef = useRef(target);
  const publishRef = useRef(publish);
  const [metrics, setMetrics] = useState<MirrorMetrics | null>(null);
  const [hoveredPeerId, setHoveredPeerId] = useState<string | null>(null);
  const lastPointerRef = useRef<{
    readonly clientX: number;
    readonly clientY: number;
    readonly pointerType: string;
  } | null>(null);
  targetRef.current = target;
  publishRef.current = publish;

  const updateMetrics = useCallback(() => {
    const input = inputRef.current;
    const container = containerElementRef.current;
    if (!input || !container) {
      setMetrics(null);
      return;
    }
    const inputRect = input.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const computed = input.ownerDocument.defaultView?.getComputedStyle(input);
    if (!computed) return;
    const next: MirrorMetrics = {
      left: inputRect.left - containerRect.left,
      top: inputRect.top - containerRect.top,
      width: inputRect.width || input.offsetWidth,
      height: inputRect.height || input.offsetHeight,
      borderRadius: computed.borderRadius,
      borderLeftWidth: pixels(computed.borderLeftWidth),
      borderRightWidth: pixels(computed.borderRightWidth),
      borderTopWidth: pixels(computed.borderTopWidth),
      borderBottomWidth: pixels(computed.borderBottomWidth),
      paddingLeft: computed.paddingLeft,
      paddingRight: computed.paddingRight,
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      fontStyle: computed.fontStyle,
      fontWeight: computed.fontWeight,
      letterSpacing: computed.letterSpacing,
      textAlign: computed.textAlign as CSSProperties["textAlign"],
      textTransform: computed.textTransform as CSSProperties["textTransform"],
      direction: computed.direction as CSSProperties["direction"],
      scrollLeft: input.scrollLeft,
    };
    setMetrics((current) => sameMetrics(current, next) ? current : next);
  }, []);

  const inputRefCallback = useCallback<RefCallback<HTMLInputElement>>((element) => {
    inputRef.current = element;
    updateMetrics();
  }, [updateMetrics]);
  const containerRef = useCallback<RefCallback<HTMLDivElement>>((element) => {
    containerElementRef.current = element;
    updateMetrics();
  }, [updateMetrics]);

  const refreshCaretHover = useCallback(() => {
    const container = containerElementRef.current;
    const pointer = lastPointerRef.current;
    const hoverQuery = container?.ownerDocument.defaultView
      ?.matchMedia?.("(hover: hover)");
    let nextPeerId: string | null = null;
    if (
      container
      && pointer
      && pointer.pointerType !== "touch"
      && hoverQuery?.matches
    ) {
      const hitboxes = [...container.querySelectorAll<HTMLElement>(
        '[data-eduri-native-remote-hitbox="true"]',
      )];
      for (let index = hitboxes.length - 1; index >= 0; index -= 1) {
        const hitbox = hitboxes[index]!;
        const bounds = hitbox.getBoundingClientRect();
        if (
          bounds.width <= 0
          || bounds.height <= 0
          || pointer.clientX < bounds.left
          || pointer.clientX > bounds.right
          || pointer.clientY < bounds.top
          || pointer.clientY > bounds.bottom
        ) continue;
        nextPeerId = hitbox.closest<HTMLElement>(
          "[data-eduri-native-remote-peer]",
        )?.dataset.eduriNativeRemotePeer ?? null;
        break;
      }
    }
    setHoveredPeerId((current) => current === nextPeerId ? current : nextPeerId);
  }, []);

  const handleContainerPointerMove = useCallback<
    PointerEventHandler<HTMLDivElement>
  >((event) => {
    lastPointerRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      pointerType: event.pointerType || "mouse",
    };
    refreshCaretHover();
  }, [refreshCaretHover]);

  const handleContainerPointerLeave = useCallback<
    PointerEventHandler<HTMLDivElement>
  >(() => {
    lastPointerRef.current = null;
    setHoveredPeerId(null);
  }, []);

  const publishCurrent = useCallback((force = false) => {
    const input = inputRef.current;
    if (!input || !focusedRef.current) return;
    const state = nativeInputAwarenessState(targetRef.current, input);
    const signature = JSON.stringify(state);
    if (!force && signature === lastPublishedRef.current) return;
    lastPublishedRef.current = signature;
    ownsPresenceRef.current = true;
    publishRef.current(ownerRef.current, state);
  }, []);

  const handleFocus = useCallback<FocusEventHandler<HTMLInputElement>>(() => {
    focusedRef.current = true;
    lastPublishedRef.current = null;
    updateMetrics();
    publishCurrent(true);
  }, [publishCurrent, updateMetrics]);

  const clearPresence = useCallback(() => {
    focusedRef.current = false;
    lastPublishedRef.current = null;
    if (!ownsPresenceRef.current) return;
    ownsPresenceRef.current = false;
    publishRef.current(ownerRef.current, null);
  }, []);

  const handleInputState = useCallback(() => {
    updateMetrics();
    publishCurrent();
  }, [publishCurrent, updateMetrics]);

  useLayoutEffect(() => {
    updateMetrics();
    publishCurrent();
  }, [publishCurrent, target, updateMetrics, value]);

  useEffect(() => {
    const input = inputRef.current;
    const ownerDocument = input?.ownerDocument;
    if (!input || !ownerDocument) return undefined;
    const selectionChange = (): void => {
      if (ownerDocument.activeElement === input) publishCurrent();
    };
    const resize = (): void => updateMetrics();
    ownerDocument.addEventListener("selectionchange", selectionChange);
    ownerDocument.defaultView?.addEventListener("resize", resize);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(resize);
    resizeObserver?.observe(input);
    return () => {
      ownerDocument.removeEventListener("selectionchange", selectionChange);
      ownerDocument.defaultView?.removeEventListener("resize", resize);
      resizeObserver?.disconnect();
    };
  }, [publishCurrent, updateMetrics]);

  useEffect(() => () => clearPresence(), [clearPresence]);

  const visiblePeers = useMemo(
    () => visibleNativeInputPresencePeers(peers, target),
    [peers, target],
  );
  useLayoutEffect(() => {
    refreshCaretHover();
  }, [metrics, refreshCaretHover, visiblePeers]);
  const overlay = visiblePeers.length > 0 && metrics
    ? (
      <span
        aria-hidden="true"
        data-eduri-native-remote-overlay="true"
        style={{
          borderRadius: metrics.borderRadius,
          height: metrics.height,
          left: metrics.left,
          overflow: "hidden",
          pointerEvents: "none",
          position: "absolute",
          top: metrics.top,
          width: metrics.width,
          zIndex: 3,
        }}
      >
        <style data-eduri-native-remote-presence-styles="true">
          {NATIVE_REMOTE_CARET_OVERLAY_STYLES}
        </style>
        {(() => {
          const collisions = new Map<string, number>();
          return visiblePeers.map((peer) => {
            const peerInput = peer.state.input!;
            const collisionKey = `${peerInput.draft}\u0000${peerInput.selection.head}`;
            const collisionOffset = collisions.get(collisionKey) ?? 0;
            collisions.set(collisionKey, collisionOffset + 1);
            return (
              <span
                key={peer.participant.participantId}
                data-eduri-native-remote-peer={peer.participant.participantId}
                style={{
                  boxSizing: "border-box",
                  color: "transparent",
                  direction: metrics.direction,
                  display: "block",
                  fontFamily: metrics.fontFamily,
                  fontSize: metrics.fontSize,
                  fontStyle: metrics.fontStyle,
                  fontWeight: metrics.fontWeight,
                  height: metrics.height
                    - metrics.borderTopWidth
                    - metrics.borderBottomWidth,
                  left: metrics.borderLeftWidth,
                  letterSpacing: metrics.letterSpacing,
                  lineHeight: `${Math.max(
                    0,
                    metrics.height - metrics.borderTopWidth - metrics.borderBottomWidth,
                  )}px`,
                  overflow: "visible",
                  paddingLeft: metrics.paddingLeft,
                  paddingRight: metrics.paddingRight,
                  position: "absolute",
                  textAlign: metrics.textAlign,
                  textTransform: metrics.textTransform,
                  top: metrics.borderTopWidth,
                  transform: `translateX(${-metrics.scrollLeft}px)`,
                  whiteSpace: "pre",
                  width: metrics.width
                    - metrics.borderLeftWidth
                    - metrics.borderRightWidth,
                }}
              >
                <PresenceText
                  input={peerInput}
                  color={safeColor(peer.participant.color)}
                  displayName={peer.participant.displayName}
                  collisionOffset={collisionOffset}
                  hovered={hoveredPeerId === peer.participant.participantId}
                />
              </span>
            );
          });
        })()}
      </span>
    )
    : null;

  return {
    containerRef,
    onContainerPointerMove: handleContainerPointerMove,
    onContainerPointerLeave: handleContainerPointerLeave,
    inputProps: {
      ref: inputRefCallback,
      onFocus: handleFocus,
      onBlur: clearPresence,
      onInput: handleInputState,
      onSelect: handleInputState,
      onKeyUp: handleInputState,
      onPointerUp: handleInputState,
      onScroll: updateMetrics,
    },
    overlay,
  };
}

/**
 * Adds scalar presence to a native input without changing its value or adding
 * cursor glyphs to the input's layout. Event props may be composed by callers.
 */
export function NativeInputPresence({
  target,
  value,
  peers,
  publish,
  children,
  className,
  style,
}: NativeInputPresenceProps) {
  const presence = useNativeInputPresence({ target, value, peers, publish });
  return (
    <div
      ref={presence.containerRef}
      className={className}
      style={{ ...style, minWidth: 0, position: "relative" }}
      onPointerMove={presence.onContainerPointerMove}
      onPointerLeave={presence.onContainerPointerLeave}
    >
      {children(presence.inputProps)}
      {presence.overlay}
    </div>
  );
}
