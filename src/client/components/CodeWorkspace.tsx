import Editor, { type OnMount } from "@monaco-editor/react";
import {
  FileDigit,
  FilePlus2,
  FolderPlus,
  Play,
  Plus,
  Square,
  TestTube2,
  Trash2,
  Upload,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import * as Y from "yjs";
import {
  CODE_TEST_TIMEOUT_MAX_MS,
  CODE_TEST_TIMEOUT_MIN_MS,
  addCodeTestCase,
  addCodeWorkspaceEntry,
  codeWorkspaceEntries,
  codeWorkspaceText,
  codeWorkspaceTestCases,
  compareCodeTestOutput,
  initializeCodeWorkspace,
  listCodeWorkspaceEntries,
  listCodeTestCases,
  moveCodeWorkspaceEntries,
  removeCodeWorkspaceEntries,
  removeCodeTestCase,
  renameCodeWorkspaceEntry,
  updateCodeTestCase,
  workspaceFilePaths,
  type CodeWorkspaceEntrySnapshot,
  type CodeTestCaseSnapshot,
} from "../../code/core";
import type {
  CodeAwarenessState,
  GuestCodePeerAwareness,
} from "../code/guestCodeProvider";
import {
  CODE_SYNC_LIMITS,
  type CodeAwarenessTarget,
} from "../../code/protocol";
import {
  SharedTerminalStateMachine,
  SHARED_TERMINAL_LIMITS,
  toSharedTerminalClientEffect,
  type SharedTerminalAction,
  type SharedTerminalAck,
  type SharedTerminalActor,
  type SharedTerminalClientEffect,
  type SharedTerminalState,
} from "../../code/terminal";
import { BoardDocumentIndexedDbStore } from "../board/documentStore";
import {
  CodeBlobStore,
  codeBlobStoreName,
} from "../code/codeBlobStore";
import {
  applyPythonWorkspaceDelta,
  capturePythonWorkspaceRunBaseline,
  type PythonWorkspaceBlobStore,
} from "../code/pythonWorkspaceDelta";
import {
  startPythonRun,
  type PythonRunHandle,
} from "../pythonRunner";
import {
  PYTHON_TERMINAL_OUTPUT_TRUNCATION_MARKER,
  startPythonTerminal,
  type PythonTerminalHandle,
} from "../pythonTerminal";
import {
  attachMonacoYTextBinding,
  type MonacoYTextBinding,
} from "../code/monacoYTextBinding";
import {
  createMonacoRemotePresenceRenderer,
  encodeMonacoYTextSelections,
  type MonacoRemotePresenceRenderer,
} from "../code/monacoRemotePresence";
import {
  NativeInputPresence,
  type NativeInputPresencePublisher,
} from "../code/nativeInputPresence";
import {
  DEFAULT_CODE_WORKSPACE_LAYOUT,
  clampConsoleHeight,
  clampExplorerHeight,
  clampExplorerWidth,
  clampTestsHeight,
  clampTestsWidth,
  loadCodeWorkspaceLayout,
  persistCodeWorkspaceLayout,
  type CodeWorkspaceLayout,
} from "../code/codeWorkspaceLayout";
import { useOptionalTheme } from "../theme";
import { CodeExplorer } from "./CodeExplorer";
import {
  CodeSyncIndicator,
  type CodeSyncIndicatorProps,
} from "./CodeSyncIndicator";
import { CollaborativeMonacoTextField } from "./CollaborativeMonacoTextField";
import { SharedTerminal } from "./SharedTerminal";
import "./CodeWorkspace.css";

export type CodeWorkspaceBlobStore = PythonWorkspaceBlobStore;

export interface CodeWorkspaceAwarenessBridge {
  setAwareness(state: CodeAwarenessState | null): void;
  subscribeAwareness(
    listener: (peers: readonly GuestCodePeerAwareness[]) => void,
  ): () => void;
}

export interface CodeWorkspaceTerminalBridge {
  readonly participantId?: string;
  dispatch(action: SharedTerminalAction): void;
  subscribeState(listener: (state: SharedTerminalState) => void): () => void;
  subscribeEffects(
    listener: (effect: SharedTerminalClientEffect) => void,
  ): () => void;
  subscribeAcks?(listener: (ack: SharedTerminalAck) => void): () => void;
}

type WithoutActionId<T> = T extends unknown ? Omit<T, "actionId"> : never;
type SharedTerminalActionDraft = WithoutActionId<SharedTerminalAction>;

export interface CodeWorkspaceSessionHandle {
  readonly document: Y.Doc;
  readonly origin: object;
  readonly blobStore: CodeWorkspaceBlobStore;
  readonly flush: () => Promise<void>;
  readonly allowBinaryUploads?: boolean;
  readonly awareness?: CodeWorkspaceAwarenessBridge;
  readonly terminal?: CodeWorkspaceTerminalBridge;
  readonly waitUntilSynchronized?: (timeoutMs?: number) => Promise<void>;
}

interface CodeWorkspaceProps {
  persistenceName?: string;
  session?: CodeWorkspaceSessionHandle;
  onSessionReady?: (session: CodeWorkspaceSessionHandle | null) => void;
  participantId?: string | null;
  readOnly?: boolean;
  terminalReadOnly?: boolean;
  syncStatus?: CodeSyncIndicatorProps;
  /** Monotonic provider socket lifecycle token used to invalidate stale runs. */
  terminalConnectionEpoch?: number;
}

type MonacoEditorInstance = Parameters<OnMount>[0];
type MonacoApi = Parameters<OnMount>[1];

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
// Keep sustained tiny-write traffic below the shared transport's ingress budget
// even while two idempotent retries are awaiting delayed acknowledgements.
const HOST_OUTPUT_FLUSH_DELAY_MS = 80;
const CODE_LAYOUT_DIVIDER_SIZE = 8;
const CODE_LAYOUT_COMPACT_WIDTH = 620;
const CODE_LAYOUT_STACK_TESTS_WIDTH = 700;
const CODE_LAYOUT_STACKED_TESTS_MIN_HEIGHT = 190;
const CODE_LAYOUT_STACKED_TERMINAL_MIN_HEIGHT = 150;
const CODE_LAYOUT_STACKED_CONSOLE_MIN_HEIGHT =
  CODE_LAYOUT_STACKED_TESTS_MIN_HEIGHT
  + CODE_LAYOUT_DIVIDER_SIZE
  + CODE_LAYOUT_STACKED_TERMINAL_MIN_HEIGHT;

type CodeWorkspaceSplit = "explorer" | "console" | "tests";
type CodeWorkspaceSplitOrientation = "horizontal" | "vertical";

interface ResolvedCodeWorkspaceLayout {
  readonly layout: CodeWorkspaceLayout;
  readonly compact: boolean;
  readonly testsStacked: boolean;
  readonly workspaceWidth: number;
  readonly workspaceHeight: number;
  readonly consoleWidth: number;
  readonly consoleHeight: number;
  readonly testsOpen: boolean;
}

interface CodeWorkspaceSplitDescriptor {
  readonly orientation: CodeWorkspaceSplitOrientation;
  readonly value: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly defaultValue: number;
  readonly decreaseKey: "ArrowLeft" | "ArrowDown" | "ArrowUp";
  readonly increaseKey: "ArrowDown" | "ArrowRight" | "ArrowUp";
}

interface ActiveCodeWorkspaceResize {
  readonly pointerId: number;
  readonly split: CodeWorkspaceSplit;
  finish(persist: boolean, event?: PointerEvent): void;
}

function measuredSize(
  element: HTMLElement,
  axis: "height" | "width",
  fallback: number,
): number {
  const rectValue = element.getBoundingClientRect()[axis];
  const clientValue = axis === "width" ? element.clientWidth : element.clientHeight;
  const value = rectValue || clientValue || fallback;
  return Math.max(1, Math.round(value));
}

function resolveCodeWorkspaceLayout(
  root: HTMLElement,
  requested: CodeWorkspaceLayout,
  testsOpen: boolean,
): ResolvedCodeWorkspaceLayout {
  const workspaceWidth = measuredSize(root, "width", 1_280);
  const workspaceHeight = measuredSize(root, "height", 720);
  const compact = workspaceWidth <= CODE_LAYOUT_COMPACT_WIDTH;
  const compactExplorerRemainingSize = 220
    + CODE_LAYOUT_DIVIDER_SIZE
    + (testsOpen ? CODE_LAYOUT_STACKED_CONSOLE_MIN_HEIGHT : 180);
  const explorerWidth = clampExplorerWidth(
    requested.explorerWidth,
    workspaceWidth,
  );
  const explorerHeight = clampExplorerHeight(
    requested.explorerHeight,
    workspaceHeight,
    compact ? {
      minimumRemainingSize: compactExplorerRemainingSize,
      dividerSize: CODE_LAYOUT_DIVIDER_SIZE,
    } : undefined,
  );
  const consoleAvailableHeight = compact
    ? Math.max(0, workspaceHeight - explorerHeight - CODE_LAYOUT_DIVIDER_SIZE)
    : workspaceHeight;
  const consoleWidth = consoleWidthAtExplorerSplit(
    workspaceWidth,
    explorerWidth,
    compact,
  );
  const testsStacked = consoleWidth < CODE_LAYOUT_STACK_TESTS_WIDTH;
  const consoleHeight = clampConsoleHeight(
    requested.consoleHeight,
    consoleAvailableHeight,
    {
      minimumSize: testsOpen && testsStacked
        ? CODE_LAYOUT_STACKED_CONSOLE_MIN_HEIGHT
        : 180,
      ...(compact ? {
        minimumRemainingSize: 220,
        dividerSize: CODE_LAYOUT_DIVIDER_SIZE,
      } : {}),
    },
  );
  const testsWidth = clampTestsWidth(requested.testsWidth, consoleWidth);
  const testsHeight = clampTestsHeight(
    requested.testsHeight,
    consoleHeight,
    testsStacked ? {
      minimumSize: CODE_LAYOUT_STACKED_TESTS_MIN_HEIGHT,
      minimumRemainingSize: CODE_LAYOUT_STACKED_TERMINAL_MIN_HEIGHT,
      dividerSize: CODE_LAYOUT_DIVIDER_SIZE,
    } : undefined,
  );
  return {
    layout: {
      version: 1,
      explorerWidth,
      explorerHeight,
      consoleHeight,
      testsWidth,
      testsHeight,
    },
    compact,
    testsStacked,
    workspaceWidth,
    workspaceHeight,
    consoleWidth,
    consoleHeight,
    testsOpen,
  };
}

function consoleWidthAtExplorerSplit(
  workspaceWidth: number,
  explorerWidth: number,
  compact: boolean,
): number {
  return compact
    ? workspaceWidth
    : Math.max(
        0,
        workspaceWidth - explorerWidth - CODE_LAYOUT_DIVIDER_SIZE,
      );
}

function codeWorkspaceSplitDescriptor(
  resolved: ResolvedCodeWorkspaceLayout,
  split: CodeWorkspaceSplit,
): CodeWorkspaceSplitDescriptor {
  const { layout } = resolved;
  if (split === "explorer") {
    if (resolved.compact) {
      const constraints = {
        minimumRemainingSize: 220
          + CODE_LAYOUT_DIVIDER_SIZE
          + (resolved.testsOpen
            ? CODE_LAYOUT_STACKED_CONSOLE_MIN_HEIGHT
            : 180),
        dividerSize: CODE_LAYOUT_DIVIDER_SIZE,
      };
      return {
        orientation: "horizontal",
        value: layout.explorerHeight,
        minimum: clampExplorerHeight(0, resolved.workspaceHeight, constraints),
        maximum: clampExplorerHeight(
          Number.MAX_SAFE_INTEGER,
          resolved.workspaceHeight,
          constraints,
        ),
        defaultValue: DEFAULT_CODE_WORKSPACE_LAYOUT.explorerHeight,
        decreaseKey: "ArrowUp",
        increaseKey: "ArrowDown",
      };
    }
    return {
      orientation: "vertical",
      value: layout.explorerWidth,
      minimum: clampExplorerWidth(0, resolved.workspaceWidth),
      maximum: clampExplorerWidth(
        Number.MAX_SAFE_INTEGER,
        resolved.workspaceWidth,
      ),
      defaultValue: DEFAULT_CODE_WORKSPACE_LAYOUT.explorerWidth,
      decreaseKey: "ArrowLeft",
      increaseKey: "ArrowRight",
    };
  }
  if (split === "console") {
    const availableHeight = resolved.compact
      ? Math.max(
          0,
          resolved.workspaceHeight
            - layout.explorerHeight
            - (2 * CODE_LAYOUT_DIVIDER_SIZE),
        )
      : resolved.workspaceHeight;
    const constraints = {
      minimumSize: resolved.testsOpen && resolved.testsStacked
        ? CODE_LAYOUT_STACKED_CONSOLE_MIN_HEIGHT
        : 180,
      ...(resolved.compact ? {
        minimumRemainingSize: 220,
        dividerSize: CODE_LAYOUT_DIVIDER_SIZE,
      } : {}),
    };
    return {
      orientation: "horizontal",
      value: layout.consoleHeight,
      minimum: clampConsoleHeight(0, availableHeight, constraints),
      maximum: clampConsoleHeight(
        Number.MAX_SAFE_INTEGER,
        availableHeight,
        constraints,
      ),
      defaultValue: DEFAULT_CODE_WORKSPACE_LAYOUT.consoleHeight,
      decreaseKey: "ArrowDown",
      increaseKey: "ArrowUp",
    };
  }
  if (resolved.testsStacked) {
    const constraints = {
      minimumSize: CODE_LAYOUT_STACKED_TESTS_MIN_HEIGHT,
      minimumRemainingSize: CODE_LAYOUT_STACKED_TERMINAL_MIN_HEIGHT,
      dividerSize: CODE_LAYOUT_DIVIDER_SIZE,
    };
    return {
      orientation: "horizontal",
      value: layout.testsHeight,
      minimum: clampTestsHeight(0, resolved.consoleHeight, constraints),
      maximum: clampTestsHeight(
        Number.MAX_SAFE_INTEGER,
        resolved.consoleHeight,
        constraints,
      ),
      defaultValue: DEFAULT_CODE_WORKSPACE_LAYOUT.testsHeight,
      decreaseKey: "ArrowUp",
      increaseKey: "ArrowDown",
    };
  }
  return {
    orientation: "vertical",
    value: layout.testsWidth,
    minimum: clampTestsWidth(0, resolved.consoleWidth),
    maximum: clampTestsWidth(
      Number.MAX_SAFE_INTEGER,
      resolved.consoleWidth,
    ),
    defaultValue: DEFAULT_CODE_WORKSPACE_LAYOUT.testsWidth,
    decreaseKey: "ArrowLeft",
    increaseKey: "ArrowRight",
  };
}

function withCodeWorkspaceSplitValue(
  layout: CodeWorkspaceLayout,
  resolved: ResolvedCodeWorkspaceLayout,
  split: CodeWorkspaceSplit,
  value: number,
): CodeWorkspaceLayout {
  if (split === "explorer") {
    return resolved.compact
      ? { ...layout, explorerHeight: value }
      : { ...layout, explorerWidth: value };
  }
  if (split === "console") return { ...layout, consoleHeight: value };
  return resolved.testsStacked
    ? { ...layout, testsHeight: value }
    : { ...layout, testsWidth: value };
}

interface PendingHostOutput {
  runId: string;
  value: string;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
}

function utf8Text(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function nextAvailableName(
  entries: readonly CodeWorkspaceEntrySnapshot[],
  parentId: string | null,
  preferred: string,
): string {
  const dot = preferred.lastIndexOf(".");
  const stem = dot > 0 ? preferred.slice(0, dot) : preferred;
  const suffix = dot > 0 ? preferred.slice(dot) : "";
  const used = new Set(entries
    .filter((entry) => entry.parentId === parentId)
    .map((entry) => entry.name.toLocaleLowerCase("en-US")));
  if (!used.has(preferred.toLocaleLowerCase("en-US"))) return preferred;
  for (let index = 2; index <= 999; index += 1) {
    const candidate = `${stem}-${index}${suffix}`;
    if (!used.has(candidate.toLocaleLowerCase("en-US"))) return candidate;
  }
  return `${stem}-${crypto.randomUUID().slice(0, 8)}${suffix}`;
}

function runExplorerHistoryCommand<T>(
  undoManager: Y.UndoManager | null,
  command: () => T,
): T {
  undoManager?.stopCapturing();
  try {
    return command();
  } finally {
    undoManager?.stopCapturing();
  }
}

function sameAwarenessTarget(
  left: CodeAwarenessTarget,
  right: CodeAwarenessTarget,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "file" && right.kind === "file") {
    return left.entryId === right.entryId && left.field === right.field;
  }
  if (left.kind === "test" && right.kind === "test") {
    return left.testId === right.testId && left.field === right.field;
  }
  if (left.kind === "terminal" && right.kind === "terminal") {
    return left.field === right.field;
  }
  return left.kind === "explorer"
    && right.kind === "explorer"
    && left.entryId === right.entryId
    && left.field === right.field;
}

function peersAtTarget(
  peers: readonly GuestCodePeerAwareness[],
  target: CodeAwarenessTarget,
): readonly GuestCodePeerAwareness[] {
  return peers.filter((peer) => sameAwarenessTarget(peer.state.target, target));
}

function createLocalTerminalBridge(): CodeWorkspaceTerminalBridge {
  const machine = new SharedTerminalStateMachine();
  const actor: SharedTerminalActor = {
    socketId: `local-${crypto.randomUUID()}`,
    participantId: `local-${crypto.randomUUID()}`,
    displayName: "Вы",
    color: "#2459d6",
  };
  const stateListeners = new Set<(state: SharedTerminalState) => void>();
  const effectListeners = new Set<
    (effect: SharedTerminalClientEffect) => void
  >();
  return {
    participantId: actor.participantId,
    dispatch(action) {
      const result = machine.dispatch(actor, action);
      if (result.changed || action.type === "sync") {
        for (const listener of stateListeners) listener(result.state);
      }
      if (result.effect) {
        const effect = toSharedTerminalClientEffect(result.effect);
        for (const listener of effectListeners) listener(effect);
      }
    },
    subscribeState(listener) {
      stateListeners.add(listener);
      listener(machine.snapshot());
      return () => stateListeners.delete(listener);
    },
    subscribeEffects(listener) {
      effectListeners.add(listener);
      return () => effectListeners.delete(listener);
    },
  };
}

export function CodeWorkspace({
  persistenceName,
  session: suppliedSession,
  onSessionReady,
  participantId = null,
  readOnly = false,
  terminalReadOnly: terminalReadOnlyProp,
  terminalConnectionEpoch = 0,
  syncStatus,
}: CodeWorkspaceProps) {
  const testFieldIdPrefix = useId();
  const workspaceControlIdPrefix = useId();
  const explorerPanelId = `${workspaceControlIdPrefix}-explorer`;
  const editorPanelId = `${workspaceControlIdPrefix}-editor`;
  const consolePanelId = `${workspaceControlIdPrefix}-console`;
  const testsPanelId = `${workspaceControlIdPrefix}-tests`;
  const terminalPanelId = `${workspaceControlIdPrefix}-terminal`;
  const terminalReadOnly = terminalReadOnlyProp ?? readOnly;
  const theme = useOptionalTheme()?.theme ?? "light";
  const editorTheme = theme === "dark" ? "vs-dark" : "vs";
  const [session, setSession] = useState<CodeWorkspaceSessionHandle | null>(null);
  const [entries, setEntries] = useState<readonly CodeWorkspaceEntrySnapshot[]>([]);
  const [tests, setTests] = useState<readonly CodeTestCaseSnapshot[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTestId, setActiveTestId] = useState<string | null>(null);
  const [testNameDraft, setTestNameDraft] = useState("");
  const [testTimeoutDraft, setTestTimeoutDraft] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [terminalState, setTerminalState] = useState<SharedTerminalState | null>(null);
  const [runRequestPending, setRunRequestPending] = useState(false);
  const [terminalClaimRejectionRevision, setTerminalClaimRejectionRevision]
    = useState(0);
  const [terminalSubmitRejectionRevision, setTerminalSubmitRejectionRevision]
    = useState(0);
  const [testsOpen, setTestsOpen] = useState(false);
  const [testState, setTestState] = useState<"idle" | "passed" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [initialWorkspaceLayout] = useState(loadCodeWorkspaceLayout);
  const [resolvedWorkspaceLayout, setResolvedWorkspaceLayout] = useState<
    ResolvedCodeWorkspaceLayout
  >({
    layout: initialWorkspaceLayout,
    compact: false,
    testsStacked: false,
    workspaceWidth: 1_280,
    workspaceHeight: 720,
    consoleWidth: 1_052,
    consoleHeight: initialWorkspaceLayout.consoleHeight,
    testsOpen: false,
  });
  const mainEditorOptions = useMemo(() => ({
    readOnly,
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 14,
    lineHeight: 22,
    tabSize: 4,
    insertSpaces: true,
    multiCursorLimit: CODE_SYNC_LIMITS.maxYTextSelections,
    scrollBeyondLastLine: false,
    padding: { top: 12 },
    ariaLabel: `Редактор ${entries.find((entry) => entry.id === activeId)?.name ?? "кода"}`,
  }), [activeId, entries, readOnly]);
  const pythonTerminalRef = useRef<PythonTerminalHandle | null>(null);
  const pythonTerminalTokenRef = useRef<symbol | null>(null);
  const pythonTerminalBaselineRef = useRef<Awaited<ReturnType<
    typeof capturePythonWorkspaceRunBaseline
  >> | null>(null);
  const testRunRef = useRef<PythonRunHandle | null>(null);
  const executingSharedRunIdRef = useRef<string | null>(null);
  const pythonInterruptRunIdRef = useRef<string | null>(null);
  const terminalExecutionEpochRef = useRef(0);
  const terminalStateRef = useRef<SharedTerminalState | null>(null);
  const terminalClaimActionIdRef = useRef<string | null>(null);
  const terminalInputActionIdsRef = useRef(new Set<string>());
  const terminalSubmitActionIdsRef = useRef(new Set<string>());
  const runRequestPendingRef = useRef(false);
  const runRequestActionIdRef = useRef<string | null>(null);
  const runRequestBaseStateRef = useRef<Pick<
    SharedTerminalState,
    "generation" | "seq"
  > | null>(null);
  const pendingHostOutputRef = useRef<PendingHostOutput | null>(null);
  const workspaceRootRef = useRef<HTMLDivElement | null>(null);
  const explorerSeparatorRef = useRef<HTMLDivElement | null>(null);
  const consoleSeparatorRef = useRef<HTMLDivElement | null>(null);
  const testsSeparatorRef = useRef<HTMLDivElement | null>(null);
  const storedWorkspaceLayoutRef = useRef(initialWorkspaceLayout);
  const resolvedWorkspaceLayoutRef = useRef(resolvedWorkspaceLayout);
  const activeWorkspaceResizeRef = useRef<ActiveCodeWorkspaceResize | null>(null);
  const testsOpenRef = useRef(testsOpen);
  const mountedRef = useRef(false);
  const sessionRef = useRef<CodeWorkspaceSessionHandle | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const activeTestIdRef = useRef<string | null>(null);
  const activeTestDraftIdRef = useRef<string | null>(null);
  const onSessionReadyRef = useRef(onSessionReady);
  const readOnlyRef = useRef(readOnly);
  const terminalReadOnlyRef = useRef(terminalReadOnly);
  const observedTerminalReadOnlyRef = useRef(terminalReadOnly);
  const observedTerminalConnectionEpochRef = useRef(terminalConnectionEpoch);
  const editorRef = useRef<MonacoEditorInstance | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const editorThemeRef = useRef(editorTheme);
  const editorBindingRef = useRef<MonacoYTextBinding | null>(null);
  const editorPresenceRendererRef = useRef<MonacoRemotePresenceRenderer | null>(null);
  const editorSubscriptionsRef = useRef<readonly { dispose(): void }[]>([]);
  const undoManagerRef = useRef<Y.UndoManager | null>(null);
  const folderUploadInputRef = useRef<HTMLInputElement | null>(null);
  const editorAwarenessRef = useRef<CodeAwarenessState | null>(null);
  const awarenessOwnerRef = useRef<symbol | null>(null);
  const mainEditorAwarenessOwnerRef = useRef(Symbol("eduri-main-editor-presence"));
  const terminalAwarenessOwnerRef = useRef(Symbol("eduri-terminal-presence"));
  const remotePeersRef = useRef<readonly GuestCodePeerAwareness[]>([]);
  const [remotePeers, setRemotePeers] = useState<
    readonly GuestCodePeerAwareness[]
  >([]);

  onSessionReadyRef.current = onSessionReady;
  readOnlyRef.current = readOnly;
  terminalReadOnlyRef.current = terminalReadOnly;
  terminalStateRef.current = terminalState;
  sessionRef.current = session;
  activeIdRef.current = activeId;
  activeTestIdRef.current = activeTestId;
  editorThemeRef.current = editorTheme;
  remotePeersRef.current = remotePeers;
  testsOpenRef.current = testsOpen;

  const applyWorkspaceLayout = useCallback((
    requested: CodeWorkspaceLayout,
    render: boolean,
  ): ResolvedCodeWorkspaceLayout | null => {
    const root = workspaceRootRef.current;
    if (!root) return null;
    const resolved = resolveCodeWorkspaceLayout(
      root,
      requested,
      testsOpenRef.current,
    );
    resolvedWorkspaceLayoutRef.current = resolved;
    root.style.setProperty(
      "--code-explorer-width",
      `${resolved.layout.explorerWidth}px`,
    );
    root.style.setProperty(
      "--code-explorer-height",
      `${resolved.layout.explorerHeight}px`,
    );
    root.style.setProperty(
      "--code-console-height",
      `${resolved.layout.consoleHeight}px`,
    );
    root.style.setProperty(
      "--code-tests-width",
      `${resolved.layout.testsWidth}px`,
    );
    root.style.setProperty(
      "--code-tests-height",
      `${resolved.layout.testsHeight}px`,
    );
    root.dataset.codeLayout = resolved.compact ? "compact" : "wide";
    root.dataset.codeTestsLayout = resolved.testsStacked ? "stacked" : "side";

    const updateSeparator = (
      separator: HTMLDivElement | null,
      split: CodeWorkspaceSplit,
    ) => {
      if (!separator) return;
      const descriptor = codeWorkspaceSplitDescriptor(resolved, split);
      separator.setAttribute("aria-orientation", descriptor.orientation);
      separator.setAttribute("aria-valuemin", String(descriptor.minimum));
      separator.setAttribute("aria-valuemax", String(descriptor.maximum));
      separator.setAttribute("aria-valuenow", String(descriptor.value));
      separator.setAttribute("aria-valuetext", `${descriptor.value} пикселей`);
    };
    updateSeparator(explorerSeparatorRef.current, "explorer");
    updateSeparator(consoleSeparatorRef.current, "console");
    updateSeparator(testsSeparatorRef.current, "tests");
    if (render) setResolvedWorkspaceLayout(resolved);
    return resolved;
  }, []);

  const commitWorkspaceSplit = useCallback((
    split: CodeWorkspaceSplit,
    rawValue: number,
    render: boolean,
  ): ResolvedCodeWorkspaceLayout | null => {
    const currentResolved = resolvedWorkspaceLayoutRef.current;
    const descriptor = codeWorkspaceSplitDescriptor(currentResolved, split);
    const value = Math.max(
      descriptor.minimum,
      Math.min(descriptor.maximum, Math.round(rawValue)),
    );
    const requested = withCodeWorkspaceSplitValue(
      storedWorkspaceLayoutRef.current,
      currentResolved,
      split,
      value,
    );
    const resolved = applyWorkspaceLayout(requested, render);
    if (!resolved) return null;
    const appliedValue = codeWorkspaceSplitDescriptor(resolved, split).value;
    storedWorkspaceLayoutRef.current = withCodeWorkspaceSplitValue(
      requested,
      resolved,
      split,
      appliedValue,
    );
    return resolved;
  }, [applyWorkspaceLayout]);

  const startWorkspaceResize = useCallback((
    split: CodeWorkspaceSplit,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (!event.isPrimary || event.button !== 0) return;
    activeWorkspaceResizeRef.current?.finish(false);
    const root = workspaceRootRef.current;
    if (!root) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    const separator = event.currentTarget;
    const initialLayout = { ...storedWorkspaceLayoutRef.current };
    const ownerWindow = root.ownerDocument.defaultView ?? window;
    const documentElement = root.ownerDocument.documentElement;
    const previousCursor = documentElement.style.cursor;
    const previousUserSelect = documentElement.style.userSelect;
    const descriptor = codeWorkspaceSplitDescriptor(
      resolvedWorkspaceLayoutRef.current,
      split,
    );
    const initialPointerPosition = descriptor.orientation === "vertical"
      ? event.clientX
      : event.clientY;
    const pointerDirection = split === "console" ? -1 : 1;
    const cursor = descriptor.orientation === "vertical" ? "col-resize" : "row-resize";
    root.dataset.codeResizing = split;
    documentElement.style.cursor = cursor;
    documentElement.style.userSelect = "none";
    try {
      separator.setPointerCapture(pointerId);
    } catch {
      // Window listeners below retain the drag when capture is unavailable.
    }

    let finished = false;
    const applyPointer = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      const pointerPosition = descriptor.orientation === "vertical"
        ? pointerEvent.clientX
        : pointerEvent.clientY;
      const value = descriptor.value
        + (pointerDirection * (pointerPosition - initialPointerPosition));
      pointerEvent.preventDefault();
      commitWorkspaceSplit(split, value, true);
    };
    const cleanup = () => {
      ownerWindow.removeEventListener("pointermove", onPointerMove);
      ownerWindow.removeEventListener("pointerup", onPointerUp);
      ownerWindow.removeEventListener("pointercancel", onPointerCancel);
      ownerWindow.removeEventListener("blur", onWindowBlur);
      separator.removeEventListener("lostpointercapture", onLostPointerCapture);
      delete root.dataset.codeResizing;
      documentElement.style.cursor = previousCursor;
      documentElement.style.userSelect = previousUserSelect;
      try {
        if (separator.hasPointerCapture(pointerId)) {
          separator.releasePointerCapture(pointerId);
        }
      } catch {
        // Capture may already have been released by the browser.
      }
    };
    const finish = (persist: boolean, pointerEvent?: PointerEvent) => {
      if (finished) return;
      finished = true;
      if (pointerEvent) applyPointer(pointerEvent);
      if (!persist) {
        storedWorkspaceLayoutRef.current = initialLayout;
        applyWorkspaceLayout(initialLayout, true);
      } else {
        applyWorkspaceLayout(storedWorkspaceLayoutRef.current, true);
        persistCodeWorkspaceLayout(storedWorkspaceLayoutRef.current);
      }
      activeWorkspaceResizeRef.current = null;
      cleanup();
    };
    const onPointerMove = (pointerEvent: PointerEvent) => applyPointer(pointerEvent);
    const onPointerUp = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId === pointerId) finish(true, pointerEvent);
    };
    const onPointerCancel = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId === pointerId) finish(false);
    };
    const onLostPointerCapture = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId === pointerId) finish(false);
    };
    const onWindowBlur = () => finish(false);
    activeWorkspaceResizeRef.current = { pointerId, split, finish };
    ownerWindow.addEventListener("pointermove", onPointerMove, { passive: false });
    ownerWindow.addEventListener("pointerup", onPointerUp);
    ownerWindow.addEventListener("pointercancel", onPointerCancel);
    ownerWindow.addEventListener("blur", onWindowBlur);
    separator.addEventListener("lostpointercapture", onLostPointerCapture);
  }, [applyWorkspaceLayout, commitWorkspaceSplit]);

  const handleWorkspaceSeparatorKeyDown = useCallback((
    split: CodeWorkspaceSplit,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const descriptor = codeWorkspaceSplitDescriptor(
      resolvedWorkspaceLayoutRef.current,
      split,
    );
    const step = event.shiftKey ? 40 : 10;
    let value: number | null = null;
    if (event.key === descriptor.decreaseKey) value = descriptor.value - step;
    else if (event.key === descriptor.increaseKey) value = descriptor.value + step;
    else if (event.key === "Home") value = descriptor.minimum;
    else if (event.key === "End") value = descriptor.maximum;
    else if (event.key === "Enter" || event.key === " ") {
      value = descriptor.defaultValue;
    }
    if (value === null) return;
    event.preventDefault();
    event.stopPropagation();
    commitWorkspaceSplit(split, value, true);
    persistCodeWorkspaceLayout(storedWorkspaceLayoutRef.current);
  }, [commitWorkspaceSplit]);

  const resetWorkspaceSplit = useCallback((split: CodeWorkspaceSplit) => {
    const descriptor = codeWorkspaceSplitDescriptor(
      resolvedWorkspaceLayoutRef.current,
      split,
    );
    commitWorkspaceSplit(split, descriptor.defaultValue, true);
    persistCodeWorkspaceLayout(storedWorkspaceLayoutRef.current);
  }, [commitWorkspaceSplit]);

  useLayoutEffect(() => {
    const root = workspaceRootRef.current;
    if (!root || !session) return undefined;
    applyWorkspaceLayout(storedWorkspaceLayoutRef.current, true);
    const resize = () => {
      activeWorkspaceResizeRef.current?.finish(false);
      applyWorkspaceLayout(storedWorkspaceLayoutRef.current, true);
    };
    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(resize)
      : null;
    observer?.observe(root);
    const ownerWindow = root.ownerDocument.defaultView ?? window;
    if (!observer) ownerWindow.addEventListener("resize", resize);
    return () => {
      observer?.disconnect();
      if (!observer) ownerWindow.removeEventListener("resize", resize);
      activeWorkspaceResizeRef.current?.finish(false);
    };
  }, [applyWorkspaceLayout, session]);

  useLayoutEffect(() => {
    if (!session) return;
    applyWorkspaceLayout(storedWorkspaceLayoutRef.current, true);
  }, [applyWorkspaceLayout, session, testsOpen]);

  useLayoutEffect(() => {
    monacoRef.current?.editor.setTheme(editorTheme);
  }, [editorTheme]);

  const publishAwareness = useCallback(() => {
    const bridge = sessionRef.current?.awareness;
    if (!bridge) return;
    bridge.setAwareness(editorAwarenessRef.current);
  }, []);

  const publishOwnedAwareness = useCallback<NativeInputPresencePublisher>((
    owner,
    state,
  ) => {
    if (state) {
      awarenessOwnerRef.current = owner;
      editorAwarenessRef.current = state;
      publishAwareness();
      return;
    }
    if (awarenessOwnerRef.current !== owner) return;
    awarenessOwnerRef.current = null;
    editorAwarenessRef.current = null;
    publishAwareness();
  }, [publishAwareness]);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    let ownedDocument: Y.Doc | null = null;
    let ownedStore: BoardDocumentIndexedDbStore | null = null;
    let ownedBlobStore: CodeBlobStore | null = null;
    let activeHandle: CodeWorkspaceSessionHandle | null = null;
    let removeDocumentObservers: (() => void) | null = null;
    const refreshEntries = () => {
      const document = activeHandle?.document;
      if (!document) return;
      const next = listCodeWorkspaceEntries(document);
      setEntries(next);
      setActiveId((current) => {
        if (current && next.some((entry) => entry.id === current)) return current;
        return next.find((entry) => entry.id === "main-py" && entry.kind === "file")?.id
          ?? next.find((entry) => entry.kind === "file")?.id
          ?? null;
      });
    };
    const refreshTests = () => {
      const document = activeHandle?.document;
      if (!document) return;
      const nextTests = listCodeTestCases(document);
      setTests(nextTests);
    };
    let activated = false;
    const activate = (
      handle: CodeWorkspaceSessionHandle,
      storageAvailable: boolean,
    ) => {
      if (activated || cancelled) return;
      activated = true;
      activeHandle = handle;
      initializeCodeWorkspace(handle.document, handle.origin);
      if (!suppliedSession && listCodeTestCases(handle.document).length === 0) {
        addCodeTestCase(handle.document, {
          id: "sample-1",
          name: "Тест 1",
        }, handle.origin);
      }
      undoManagerRef.current?.destroy();
      undoManagerRef.current = new Y.UndoManager([
        codeWorkspaceEntries(handle.document),
        codeWorkspaceTestCases(handle.document),
      ], {
        trackedOrigins: new Set([handle.origin]),
        captureTimeout: 450,
      });
      const entriesRoot = codeWorkspaceEntries(handle.document);
      const testsRoot = codeWorkspaceTestCases(handle.document);
      const onEntriesChanged: Parameters<typeof entriesRoot.observeDeep>[0]
        = (events) => {
          for (const event of events) {
            const [entryId, property, ...rest] = event.path;
            if (
              typeof entryId !== "string"
              || !(event.target instanceof Y.Text)
              || rest.length !== 0
              || property !== "text"
            ) {
              refreshEntries();
              return;
            }
            const entry = entriesRoot.get(entryId);
            if (!entry || entry.get("text") !== event.target) {
              refreshEntries();
              return;
            }
          }
          // Monaco's Y.Text binding owns live file contents. Refreshing the
          // React snapshot here would rerender the entire workspace for every
          // remote character even though no snapshot consumer needs the text.
        };
      const onTestsChanged: Parameters<typeof testsRoot.observeDeep>[0]
        = (events) => {
          for (const event of events) {
            const [testId, property, ...rest] = event.path;
            if (
              typeof testId !== "string"
              || !(event.target instanceof Y.Text)
              || rest.length !== 0
              || (property !== "stdin" && property !== "expectedOutput")
            ) {
              refreshTests();
              return;
            }
            const test = testsRoot.get(testId);
            if (!test || test.get(property) !== event.target) {
              refreshTests();
              return;
            }
          }
          // The focused stdin/expected-output editors are also bound directly
          // to Y.Text. Test metadata and structure still take the refresh path.
        };
      entriesRoot.observeDeep(onEntriesChanged);
      testsRoot.observeDeep(onTestsChanged);
      removeDocumentObservers = () => {
        entriesRoot.unobserveDeep(onEntriesChanged);
        testsRoot.unobserveDeep(onTestsChanged);
      };
      refreshEntries();
      refreshTests();
      sessionRef.current = handle;
      setSession(handle);
      onSessionReadyRef.current?.(handle);
      if (!storageAvailable) {
        setError(
          "Локальное хранилище недоступно. Код работает в памяти и исчезнет после закрытия страницы.",
        );
      }
    };

    if (suppliedSession) {
      activate(suppliedSession, true);
    } else if (persistenceName) {
      const document = new Y.Doc();
      const origin = Object.freeze({ type: "eduri.code.local-command" });
      const store = new BoardDocumentIndexedDbStore(persistenceName, document);
      const blobStore = new CodeBlobStore(codeBlobStoreName(persistenceName));
      ownedDocument = document;
      ownedStore = store;
      ownedBlobStore = blobStore;
      const handle: CodeWorkspaceSessionHandle = {
        document,
        origin,
        blobStore,
        flush: () => store.flush(),
        allowBinaryUploads: true,
        terminal: createLocalTerminalBridge(),
        waitUntilSynchronized: async () => store.flush(),
      };
      void store.whenReady.then(() => {
        activate(handle, true);
      }).catch((reason) => {
        console.error("Code workspace storage could not be opened", reason);
        activate(handle, false);
      });
      void blobStore.whenReady.then((persistent) => {
        if (!persistent && !cancelled) {
          setError(
            "Хранилище файлов недоступно. Бинарные файлы сохранятся только до закрытия страницы.",
          );
        }
      });
    } else {
      setError("Code workspace session is unavailable");
    }

    return () => {
      mountedRef.current = false;
      cancelled = true;
      removeDocumentObservers?.();
      removeDocumentObservers = null;
      pythonTerminalRef.current?.close();
      pythonTerminalRef.current = null;
      pythonTerminalTokenRef.current = null;
      testRunRef.current?.cancel();
      testRunRef.current = null;
      pythonTerminalBaselineRef.current = null;
      executingSharedRunIdRef.current = null;
      pythonInterruptRunIdRef.current = null;
      terminalClaimActionIdRef.current = null;
      terminalInputActionIdsRef.current.clear();
      terminalSubmitActionIdsRef.current.clear();
      const pendingHostOutput = pendingHostOutputRef.current;
      if (pendingHostOutput?.timer != null) {
        globalThis.clearTimeout(pendingHostOutput.timer);
      }
      pendingHostOutputRef.current = null;
      sessionRef.current?.awareness?.setAwareness(null);
      editorAwarenessRef.current = null;
      awarenessOwnerRef.current = null;
      undoManagerRef.current?.destroy();
      undoManagerRef.current = null;
      sessionRef.current = null;
      setSession(null);
      onSessionReadyRef.current?.(null);
      if (ownedBlobStore) void ownedBlobStore.close().catch(() => undefined);
      if (ownedStore && ownedDocument) {
        void ownedStore.flush().catch(() => undefined).finally(() => {
          void ownedStore?.destroy().catch(() => undefined).finally(() => {
            ownedDocument?.destroy();
          });
        });
      }
    };
  }, [persistenceName, suppliedSession]);

  useEffect(() => {
    if (!session?.awareness) {
      setRemotePeers([]);
      return;
    }
    return session.awareness.subscribeAwareness(setRemotePeers);
  }, [session]);

  const dispatchTerminal = useCallback((
    action: SharedTerminalActionDraft,
    actionId = crypto.randomUUID(),
  ): string | null => {
    if (terminalReadOnlyRef.current) return null;
    const terminal = sessionRef.current?.terminal;
    if (!terminal) return null;
    terminal.dispatch({
      ...action,
      actionId,
    } as SharedTerminalAction);
    return actionId;
  }, []);

  useLayoutEffect(() => {
    // A connection transition invalidates every in-flight browser execution.
    // In particular, an old Worker must never publish a filesystem delta after
    // a quick offline -> online transition made terminalReadOnly false again.
    const connectionChanged = observedTerminalConnectionEpochRef.current
      !== terminalConnectionEpoch;
    const becameReadOnly = terminalReadOnly
      && !observedTerminalReadOnlyRef.current;
    observedTerminalConnectionEpochRef.current = terminalConnectionEpoch;
    observedTerminalReadOnlyRef.current = terminalReadOnly;
    if (!connectionChanged && !becameReadOnly) return;
    terminalExecutionEpochRef.current += 1;
    publishOwnedAwareness(terminalAwarenessOwnerRef.current, null);
    testRunRef.current?.cancel();
    testRunRef.current = null;
    pythonTerminalRef.current?.close();
    pythonTerminalRef.current = null;
    pythonTerminalTokenRef.current = null;
    pythonTerminalBaselineRef.current = null;
    executingSharedRunIdRef.current = null;
    pythonInterruptRunIdRef.current = null;
    const pendingHostOutput = pendingHostOutputRef.current;
    if (pendingHostOutput?.timer !== null && pendingHostOutput?.timer !== undefined) {
      globalThis.clearTimeout(pendingHostOutput.timer);
    }
    pendingHostOutputRef.current = null;
    terminalClaimActionIdRef.current = null;
    terminalInputActionIdsRef.current.clear();
    terminalSubmitActionIdsRef.current.clear();
    runRequestActionIdRef.current = null;
    runRequestBaseStateRef.current = null;
    runRequestPendingRef.current = false;
    setRunRequestPending(false);
  }, [publishOwnedAwareness, terminalConnectionEpoch, terminalReadOnly]);

  useEffect(() => {
    if (!session?.terminal) {
      setTerminalState(null);
      return;
    }
    const unsubscribe = session.terminal.subscribeState((state) => {
      if (!mountedRef.current) return;
      terminalStateRef.current = state;
      setTerminalState(state);
      const completedTest = state.lastTest
        ? listCodeTestCases(session.document)
          .find((test) => test.id === state.lastTest?.testId)
        : null;
      setTestState(
        completedTest
        && completedTest.entryId === activeIdRef.current
        && completedTest.id === activeTestIdRef.current
          ? state.lastTest!.status
          : "idle",
      );
      const runBase = runRequestBaseStateRef.current;
      if (
        runRequestActionIdRef.current
        && (
          !runBase
          || state.generation > runBase.generation
          || (
            state.generation === runBase.generation
            && state.seq > runBase.seq
          )
        )
      ) {
        runRequestActionIdRef.current = null;
        runRequestBaseStateRef.current = null;
        runRequestPendingRef.current = false;
        setRunRequestPending(false);
      }
    });
    session.terminal.dispatch({
      type: "sync",
      actionId: crypto.randomUUID(),
    });
    return unsubscribe;
  }, [session]);

  useEffect(() => {
    if (!session?.terminal?.subscribeAcks) return undefined;
    return session.terminal.subscribeAcks((ack) => {
      const wasClaim = ack.actionId === terminalClaimActionIdRef.current;
      if (wasClaim) terminalClaimActionIdRef.current = null;
      const wasInput = terminalInputActionIdsRef.current.delete(ack.actionId);
      const wasSubmit = terminalSubmitActionIdsRef.current.delete(ack.actionId);
      const wasRun = ack.actionId === runRequestActionIdRef.current;
      if ((wasClaim || wasInput) && ack.status === "rejected") {
        setTerminalClaimRejectionRevision((current) => current + 1);
      }
      if (wasSubmit && ack.status === "rejected") {
        setTerminalSubmitRejectionRevision((current) => current + 1);
      }
      if (wasRun && ack.status === "rejected") {
        runRequestActionIdRef.current = null;
        runRequestBaseStateRef.current = null;
        runRequestPendingRef.current = false;
        setRunRequestPending(false);
      }
    });
  }, [session]);

  useEffect(() => {
    if (
      participantId
      && terminalState?.input.owner?.participantId === participantId
    ) {
      terminalClaimActionIdRef.current = null;
    }
  }, [participantId, terminalState?.input.owner?.participantId]);

  const flushHostOutput = useCallback(() => {
    const pending = pendingHostOutputRef.current;
    if (!pending) return;
    pendingHostOutputRef.current = null;
    if (pending.timer !== null) globalThis.clearTimeout(pending.timer);
    if (!pending.value) return;
    dispatchTerminal({
      type: "host-output",
      runId: pending.runId,
      chunk: pending.value,
    });
  }, [dispatchTerminal]);

  const reportHostOutput = useCallback((runId: string, chunk: string) => {
    if (!chunk) return;
    let cursor = 0;
    const bounded = chunk.slice(0, SHARED_TERMINAL_LIMITS.maxTranscriptCodeUnits);
    while (cursor < bounded.length) {
      let pending = pendingHostOutputRef.current;
      if (pending && pending.runId !== runId) {
        flushHostOutput();
        pending = null;
      }
      if (!pending) {
        pending = { runId, value: "", timer: null };
        pendingHostOutputRef.current = pending;
      }
      const capacity = SHARED_TERMINAL_LIMITS.maxOutputChunkCodeUnits
        - pending.value.length;
      pending.value += bounded.slice(cursor, cursor + capacity);
      cursor += capacity;
      if (pending.value.length === SHARED_TERMINAL_LIMITS.maxOutputChunkCodeUnits) {
        flushHostOutput();
        continue;
      }
      if (pending.timer === null) {
        pending.timer = globalThis.setTimeout(
          flushHostOutput,
          HOST_OUTPUT_FLUSH_DELAY_MS,
        );
      }
    }
  }, [flushHostOutput]);

  const refreshPythonBaseline = useCallback(async (
    handle: CodeWorkspaceSessionHandle,
  ) => {
    pythonTerminalBaselineRef.current = await capturePythonWorkspaceRunBaseline(
      handle.document,
      handle.blobStore,
    );
    return pythonTerminalBaselineRef.current;
  }, []);

  const ensurePythonTerminal = useCallback(async (
    handle: CodeWorkspaceSessionHandle,
    forceFresh = false,
    executionEpoch = terminalExecutionEpochRef.current,
  ): Promise<PythonTerminalHandle> => {
    const current = pythonTerminalRef.current;
    if (
      !forceFresh
      && current
      && current.mode() !== "closed"
      && terminalExecutionEpochRef.current === executionEpoch
    ) return current;
    if (current) current.close();
    pythonTerminalRef.current = null;
    pythonTerminalTokenRef.current = null;
    pythonInterruptRunIdRef.current = null;
    await handle.waitUntilSynchronized?.();
    if (
      terminalExecutionEpochRef.current !== executionEpoch
      || sessionRef.current !== handle
      || readOnlyRef.current
      || terminalReadOnlyRef.current
    ) throw new Error("Выполнение остановлено");
    const baseline = await refreshPythonBaseline(handle);
    if (
      terminalExecutionEpochRef.current !== executionEpoch
      || sessionRef.current !== handle
      || readOnlyRef.current
      || terminalReadOnlyRef.current
    ) throw new Error("Выполнение остановлено");
    const runtimeToken = Symbol("eduri-python-terminal-runtime");
    const terminal = startPythonTerminal({
      files: baseline.runnerFiles,
      directories: baseline.runnerDirectories,
    }, {
      onOutput: ({ chunk }) => {
        if (
          pythonTerminalTokenRef.current !== runtimeToken
          || terminalExecutionEpochRef.current !== executionEpoch
        ) return;
        const runId = executingSharedRunIdRef.current;
        if (runId && pythonInterruptRunIdRef.current !== runId) {
          reportHostOutput(runId, chunk);
        }
      },
      onInputRequest: ({ requestId }) => {
        if (
          pythonTerminalTokenRef.current !== runtimeToken
          || terminalExecutionEpochRef.current !== executionEpoch
        ) return;
        const runId = executingSharedRunIdRef.current;
        if (runId && pythonInterruptRunIdRef.current !== runId) {
          flushHostOutput();
          dispatchTerminal({
            type: "host-input-request",
            runId,
            requestId,
          });
        }
      },
    });
    pythonTerminalRef.current = terminal;
    pythonTerminalTokenRef.current = runtimeToken;
    const ready = await terminal.ready;
    if (
      ready.status !== "ready"
      || pythonTerminalTokenRef.current !== runtimeToken
      || terminalExecutionEpochRef.current !== executionEpoch
    ) {
      terminal.close();
      if (pythonTerminalRef.current === terminal) pythonTerminalRef.current = null;
      if (pythonTerminalTokenRef.current === runtimeToken) {
        pythonTerminalTokenRef.current = null;
      }
      throw new Error(ready.status === "ready" ? "Выполнение остановлено" : ready.message);
    }
    return terminal;
  }, [dispatchTerminal, flushHostOutput, refreshPythonBaseline, reportHostOutput]);

  const applyTerminalWorkspaceDelta = useCallback(async (
    handle: CodeWorkspaceSessionHandle,
    result: Awaited<ReturnType<PythonTerminalHandle["executeEntrypoint"]>>,
    runId: string,
    executionEpoch: number,
  ) => {
    const canApply = () => mountedRef.current
      && sessionRef.current === handle
      && executingSharedRunIdRef.current === runId
      && terminalExecutionEpochRef.current === executionEpoch
      && !readOnlyRef.current
      && !terminalReadOnlyRef.current;
    if (!canApply()) throw new Error("Выполнение больше не является активным");
    const baseline = pythonTerminalBaselineRef.current;
    if (!baseline || !result.workspaceDelta) return;
    if (handle.allowBinaryUploads === false) {
      for (const change of result.workspaceDelta.changes) {
        if (change.kind !== "write") continue;
        try {
          const text = new TextDecoder("utf-8", { fatal: true })
            .decode(change.bytes);
          if (text.includes("\0")) throw new Error("binary NUL");
        } catch {
          throw new Error(
            "Бинарные изменения из терминала недоступны в редакторе урока",
          );
        }
      }
    }
    const applied = await applyPythonWorkspaceDelta({
      document: handle.document,
      origin: handle.origin,
      blobStore: handle.blobStore,
      baseline,
      delta: result.workspaceDelta,
      canApply,
    });
    if (!canApply()) throw new Error("Выполнение больше не является активным");
    if (applied.conflicts.length > 0) {
      setError("Некоторые изменения файлов из терминала не применены: файлы уже изменились у другого участника.");
    }
    if (!applied.aborted) await refreshPythonBaseline(handle);
  }, [refreshPythonBaseline]);

  const synchronizeTerminalWorkspace = useCallback(async (
    handle: CodeWorkspaceSessionHandle,
  ) => {
    await handle.flush();
    await handle.waitUntilSynchronized?.();
  }, []);

  const reportTerminalTruncation = useCallback((
    runId: string,
    result: Awaited<ReturnType<PythonTerminalHandle["executeEntrypoint"]>>,
  ) => {
    if (
      result.truncated
      && !result.output.endsWith(PYTHON_TERMINAL_OUTPUT_TRUNCATION_MARKER)
    ) {
      reportHostOutput(runId, PYTHON_TERMINAL_OUTPUT_TRUNCATION_MARKER);
    }
  }, [reportHostOutput]);

  const executeSharedTerminalEffect = useCallback(async (
    effect: SharedTerminalClientEffect,
  ) => {
    const handle = sessionRef.current;
    if (!handle || readOnlyRef.current || terminalReadOnlyRef.current) return;
    const executionEpoch = terminalExecutionEpochRef.current;
    if (effect.type === "interrupt") {
      const runtime = pythonTerminalRef.current;
      if (effect.pythonMode) {
        if (!runtime || runtime.mode() !== "repl") {
          dispatchTerminal({
            type: "host-failed",
            runId: effect.runId,
            message: "Python REPL больше не доступен",
          });
          return;
        }
        pythonInterruptRunIdRef.current = effect.runId;
        if (executingSharedRunIdRef.current === effect.runId) {
          runtime.interrupt();
          return;
        }
        executingSharedRunIdRef.current = effect.runId;
        try {
          const result = await runtime.interruptRepl();
          if (
            terminalExecutionEpochRef.current !== executionEpoch
            || executingSharedRunIdRef.current !== effect.runId
            || sessionRef.current !== handle
            || terminalReadOnlyRef.current
            || readOnlyRef.current
          ) throw new Error("Выполнение остановлено");
          if (result.status !== "ok" || result.mode !== "repl") {
            throw new Error("Не удалось прервать команду Python");
          }
          dispatchTerminal({
            type: "host-ready",
            runId: effect.runId,
            nextMode: "python",
            prompt: ">>> ",
          });
        } catch (reason) {
          dispatchTerminal({
            type: "host-failed",
            runId: effect.runId,
            message: reason instanceof Error
              ? reason.message
              : "Не удалось прервать команду Python",
          });
        } finally {
          if (executingSharedRunIdRef.current === effect.runId) {
            executingSharedRunIdRef.current = null;
          }
          if (pythonInterruptRunIdRef.current === effect.runId) {
            pythonInterruptRunIdRef.current = null;
          }
        }
        return;
      }
      if (executingSharedRunIdRef.current !== effect.runId) return;
      executingSharedRunIdRef.current = null;
      pythonInterruptRunIdRef.current = null;
      testRunRef.current?.cancel();
      if (runtime?.mode() === "starting") runtime.close();
      else runtime?.interrupt();
      return;
    }
    if (effect.type === "eof") {
      const runtime = pythonTerminalRef.current;
      if (!runtime) return;
      if (executingSharedRunIdRef.current === effect.runId) {
        runtime.sendEof();
      } else if (runtime.mode() === "repl") {
        executingSharedRunIdRef.current = effect.runId;
        try {
          const result = await runtime.exitRepl();
          reportTerminalTruncation(effect.runId, result);
          flushHostOutput();
          if (result.status !== "ok" || result.mode !== "shell") {
            throw new Error("Не удалось закрыть Python");
          }
          if (
            executingSharedRunIdRef.current !== effect.runId
            || readOnlyRef.current
            || terminalReadOnlyRef.current
            || sessionRef.current !== handle
          ) {
            throw new Error("Выполнение больше не является активным");
          }
          await applyTerminalWorkspaceDelta(
            handle,
            result,
            effect.runId,
            executionEpoch,
          );
          await synchronizeTerminalWorkspace(handle);
          if (
            executingSharedRunIdRef.current !== effect.runId
            || terminalExecutionEpochRef.current !== executionEpoch
            || terminalReadOnlyRef.current
            || readOnlyRef.current
            || sessionRef.current !== handle
          ) throw new Error("Выполнение больше не является активным");
          runtime.close();
          if (pythonTerminalRef.current === runtime) {
            pythonTerminalRef.current = null;
            pythonTerminalTokenRef.current = null;
          }
          dispatchTerminal({
            type: "host-ready",
            runId: effect.runId,
            nextMode: "shell",
          });
        } catch (reason) {
          flushHostOutput();
          runtime.close();
          if (pythonTerminalRef.current === runtime) {
            pythonTerminalRef.current = null;
            pythonTerminalTokenRef.current = null;
          }
          dispatchTerminal({
            type: "host-failed",
            runId: effect.runId,
            message: reason instanceof Error ? reason.message : "Не удалось закрыть Python",
          });
        } finally {
          if (executingSharedRunIdRef.current === effect.runId) {
            executingSharedRunIdRef.current = null;
          }
        }
      }
      return;
    }
    if (effect.type === "submit-input") {
      pythonTerminalRef.current?.submitInput(effect.value);
      return;
    }
    if (effect.type !== "start-run" && effect.type !== "execute-line") return;

    const runId = effect.runId;
    executingSharedRunIdRef.current = runId;
    const requireActiveRun = () => {
      if (
        executingSharedRunIdRef.current !== runId
        || readOnlyRef.current
        || terminalReadOnlyRef.current
        || sessionRef.current !== handle
        || terminalExecutionEpochRef.current !== executionEpoch
      ) {
        throw new Error("Выполнение остановлено");
      }
    };
    try {
      await handle.waitUntilSynchronized?.();
      requireActiveRun();
      if (effect.type === "start-run" && effect.testId) {
        const baseline = await capturePythonWorkspaceRunBaseline(
          handle.document,
          handle.blobStore,
        );
        const test = listCodeTestCases(handle.document)
          .find((candidate) => candidate.id === effect.testId);
        if (!test) throw new Error("Автотест больше не существует");
        if (test.entryId !== effect.entryId) {
          throw new Error("Автотест относится к другому Python-файлу");
        }
        requireActiveRun();
        const execution = startPythonRun({
          kind: "workspace",
          files: baseline.runnerFiles,
          directories: baseline.runnerDirectories,
          entrypoint: effect.entrypoint,
          stdin: test.stdin,
        }, { timeoutMs: test.timeoutMs });
        testRunRef.current = execution;
        const result = await execution.result;
        testRunRef.current = null;
        requireActiveRun();
        if (result.output) reportHostOutput(runId, result.output);
        flushHostOutput();
        if (result.status === "cancelled") throw new Error("Выполнение остановлено");
        const passed = result.status === "ok"
          && compareCodeTestOutput(result.output, test.expectedOutput);
        dispatchTerminal({
          type: "host-ready",
          runId,
          nextMode: "shell",
          testResult: { testId: test.id, status: passed ? "passed" : "failed" },
        });
        return;
      }

      let runtime: PythonTerminalHandle;
      let result;
      if (effect.type === "start-run") {
        runtime = await ensurePythonTerminal(handle, true, executionEpoch);
        requireActiveRun();
        result = await runtime.executeEntrypoint(effect.entrypoint);
      } else if (effect.pythonMode) {
        runtime = await ensurePythonTerminal(handle, false, executionEpoch);
        requireActiveRun();
        const command = effect.line.trim();
        result = /^(?:exit\(\)|quit\(\)|exit|quit)$/u.test(command)
          ? await runtime.exitRepl()
          : await runtime.submitReplLine(effect.line);
      } else {
        const line = effect.line.trim();
        if (!line) {
          flushHostOutput();
          dispatchTerminal({ type: "host-ready", runId, nextMode: "shell" });
          return;
        }
        if (line === "help") {
          reportHostOutput(runId,
            "Команды: py [файл], python [файл], clear/cls, ls/dir, pwd, cat/type <файл>, help\n");
          flushHostOutput();
          dispatchTerminal({ type: "host-ready", runId, nextMode: "shell" });
          return;
        }
        if (line === "pwd") {
          reportHostOutput(runId, "/workspace\n");
          flushHostOutput();
          dispatchTerminal({ type: "host-ready", runId, nextMode: "shell" });
          return;
        }
        if (/^(?:ls|dir)$/iu.test(line)) {
          const paths = [...workspaceFilePaths(handle.document).values()];
          reportHostOutput(runId, `${paths.join("\n")}\n`);
          flushHostOutput();
          dispatchTerminal({ type: "host-ready", runId, nextMode: "shell" });
          return;
        }
        const displayMatch = /^(?:cat|type)\s+(.+)$/iu.exec(line);
        if (displayMatch) {
          const requested = displayMatch[1]!.trim().replace(/^(["'])(.*)\1$/u, "$2");
          const paths = workspaceFilePaths(handle.document);
          const entryId = [...paths].find(([, path]) => path === requested)?.[0];
          const entry = entryId
            ? listCodeWorkspaceEntries(handle.document)
              .find((candidate) => candidate.id === entryId)
            : null;
          if (!entry || entry.kind !== "file" || entry.contentKind !== "text") {
            reportHostOutput(runId, `Файл не найден: ${requested}\n`);
          } else {
            reportHostOutput(runId, `${entry.text ?? ""}${entry.text?.endsWith("\n") ? "" : "\n"}`);
          }
          flushHostOutput();
          dispatchTerminal({ type: "host-ready", runId, nextMode: "shell" });
          return;
        }
        if (/^(?:py|python|python3)$/iu.test(line)) {
          runtime = await ensurePythonTerminal(handle, true, executionEpoch);
          requireActiveRun();
          result = await runtime.startRepl();
        } else {
          const executeMatch = /^(?:py|python|python3)\s+(.+)$/iu.exec(line);
          if (!executeMatch) {
            reportHostOutput(runId, `Неизвестная команда: ${line}\n`);
            flushHostOutput();
            dispatchTerminal({ type: "host-ready", runId, nextMode: "shell" });
            return;
          }
          const entrypoint = executeMatch[1]!.trim().replace(/^(["'])(.*)\1$/u, "$2");
          runtime = await ensurePythonTerminal(handle, true, executionEpoch);
          requireActiveRun();
          result = await runtime.executeEntrypoint(entrypoint);
        }
      }

      // A REPL keeps one intentional Python process. Its cumulative filesystem
      // delta is applied once when leaving the REPL; shell script workers are
      // fresh per command, so their base always matches the synchronized doc.
      requireActiveRun();
      if (
        pythonInterruptRunIdRef.current === runId
        && runtime.mode() === "repl"
      ) {
        result = await runtime.interruptRepl();
        requireActiveRun();
        pythonInterruptRunIdRef.current = null;
      }
      reportTerminalTruncation(runId, result);
      flushHostOutput();
      if ([
        "worker-error",
        "protocol-error",
        "timeout",
        "cancelled",
        "interrupted",
      ].includes(result.status)) {
        runtime.close();
        if (pythonTerminalRef.current === runtime) {
          pythonTerminalRef.current = null;
          pythonTerminalTokenRef.current = null;
        }
        throw new Error(result.status === "timeout"
          ? "Время выполнения истекло"
          : "Выполнение остановлено");
      }
      if (result.mode !== "repl") {
        if (
          executingSharedRunIdRef.current !== runId
          || readOnlyRef.current
          || terminalReadOnlyRef.current
          || sessionRef.current !== handle
        ) {
          runtime.close();
          if (pythonTerminalRef.current === runtime) {
            pythonTerminalRef.current = null;
            pythonTerminalTokenRef.current = null;
          }
          throw new Error("Выполнение больше не является активным");
        }
        await applyTerminalWorkspaceDelta(handle, result, runId, executionEpoch);
        await synchronizeTerminalWorkspace(handle);
        requireActiveRun();
        runtime.close();
        if (pythonTerminalRef.current === runtime) {
          pythonTerminalRef.current = null;
          pythonTerminalTokenRef.current = null;
        }
      }
      dispatchTerminal({
        type: "host-ready",
        runId,
        nextMode: result.mode === "repl" ? "python" : "shell",
        ...(result.prompt ? { prompt: result.prompt } : {}),
      });
    } catch (reason) {
      flushHostOutput();
      dispatchTerminal({
        type: "host-failed",
        runId,
        message: reason instanceof Error ? reason.message : "Ошибка выполнения",
      });
    } finally {
      if (executingSharedRunIdRef.current === runId) {
        executingSharedRunIdRef.current = null;
      }
      if (pythonInterruptRunIdRef.current === runId) {
        pythonInterruptRunIdRef.current = null;
      }
    }
  }, [
    applyTerminalWorkspaceDelta,
    dispatchTerminal,
    ensurePythonTerminal,
    flushHostOutput,
    reportTerminalTruncation,
    reportHostOutput,
    synchronizeTerminalWorkspace,
  ]);

  useEffect(() => {
    if (!session?.terminal) return;
    return session.terminal.subscribeEffects((effect) => {
      void executeSharedTerminalEffect(effect);
    });
  }, [executeSharedTerminalEffect, session]);

  const destroyMainEditorBinding = useCallback(() => {
    editorPresenceRendererRef.current?.destroy();
    editorPresenceRendererRef.current = null;
    editorBindingRef.current?.destroy();
    editorBindingRef.current = null;
  }, []);

  const publishMainEditorAwareness = useCallback(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const handle = sessionRef.current;
    const entryId = activeIdRef.current;
    if (!editor || !model || !handle || !entryId || !editor.hasTextFocus()) {
      publishOwnedAwareness(mainEditorAwarenessOwnerRef.current, null);
      return;
    }
    const text = codeWorkspaceText(handle.document, entryId);
    if (!text || editorBindingRef.current?.yText !== text) return;
    const selections = encodeMonacoYTextSelections(text, model, editor);
    if (!selections) return;
    publishOwnedAwareness(mainEditorAwarenessOwnerRef.current, {
      target: { kind: "file", entryId, field: "text" },
      selections,
    });
  }, [publishOwnedAwareness]);

  const bindMainEditor = useCallback(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const handle = sessionRef.current;
    const entryId = activeIdRef.current;
    destroyMainEditorBinding();
    if (!editor || !model || !handle || !entryId) {
      publishOwnedAwareness(mainEditorAwarenessOwnerRef.current, null);
      return;
    }
    const text = codeWorkspaceText(handle.document, entryId);
    if (!text) {
      publishOwnedAwareness(mainEditorAwarenessOwnerRef.current, null);
      return;
    }
    editorBindingRef.current = attachMonacoYTextBinding({
      yText: text,
      model,
      editor,
      transactionOrigin: handle.origin,
    });
    editorPresenceRendererRef.current = createMonacoRemotePresenceRenderer({
      yText: text,
      model,
      editor,
    });
    const target = { kind: "file", entryId, field: "text" } as const;
    editorPresenceRendererRef.current.setPeers(peersAtTarget(
      remotePeersRef.current,
      target,
    ).map((peer) => ({
      participantId: peer.participant.participantId,
      displayName: peer.participant.displayName,
      color: peer.participant.color,
      selections: peer.state.selections,
    })));
    publishMainEditorAwareness();
  }, [
    destroyMainEditorBinding,
    publishMainEditorAwareness,
    publishOwnedAwareness,
  ]);

  const handleEditorMount = useCallback<OnMount>((editor, monaco) => {
    for (const subscription of editorSubscriptionsRef.current) {
      subscription.dispose();
    }
    editorSubscriptionsRef.current = [];
    destroyMainEditorBinding();
    editorRef.current = editor;
    monacoRef.current = monaco;
    monaco.editor.setTheme(editorThemeRef.current);
    editorSubscriptionsRef.current = [
      editor.onDidChangeCursorSelection(publishMainEditorAwareness),
      editor.onDidFocusEditorText(publishMainEditorAwareness),
      editor.onDidBlurEditorText(() => {
        publishOwnedAwareness(mainEditorAwarenessOwnerRef.current, null);
      }),
      editor.onDidChangeModel(() => queueMicrotask(bindMainEditor)),
    ];
    bindMainEditor();
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ,
      () => {
        if (!readOnlyRef.current) undoManagerRef.current?.undo();
      },
    );
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ,
      () => {
        if (!readOnlyRef.current) undoManagerRef.current?.redo();
      },
    );
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY,
      () => {
        if (!readOnlyRef.current) undoManagerRef.current?.redo();
      },
    );
  }, [
    bindMainEditor,
    destroyMainEditorBinding,
    publishOwnedAwareness,
    publishMainEditorAwareness,
  ]);

  useEffect(() => () => {
    for (const subscription of editorSubscriptionsRef.current) {
      subscription.dispose();
    }
    editorSubscriptionsRef.current = [];
    destroyMainEditorBinding();
    editorRef.current = null;
    monacoRef.current = null;
    publishOwnedAwareness(mainEditorAwarenessOwnerRef.current, null);
  }, [destroyMainEditorBinding, publishOwnedAwareness]);

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => bindMainEditor());
    return () => cancelAnimationFrame(frame);
  }, [activeId, bindMainEditor, session]);

  useLayoutEffect(() => {
    if (!activeId) {
      editorPresenceRendererRef.current?.setPeers([]);
      return;
    }
    const target = { kind: "file", entryId: activeId, field: "text" } as const;
    editorPresenceRendererRef.current?.setPeers(peersAtTarget(
      remotePeers,
      target,
    ).map((peer) => ({
      participantId: peer.participant.participantId,
      displayName: peer.participant.displayName,
      color: peer.participant.color,
      selections: peer.state.selections,
    })));
  }, [activeId, remotePeers]);

  const active = entries.find((entry) => entry.id === activeId) ?? null;
  const activeSupportsTests = Boolean(
    active?.kind === "file"
    && active.contentKind === "text"
    && /\.py$/iu.test(active.name),
  );
  const activeFileTests = useMemo(() => (
    activeSupportsTests && active
      ? tests.filter((test) => test.entryId === active.id)
      : []
  ), [active, activeSupportsTests, tests]);
  const activeTest = activeFileTests
    .find((test) => test.id === activeTestId) ?? null;
  const activeTestMap = activeTest && session
    ? codeWorkspaceTestCases(session.document).get(activeTest.id) ?? null
    : null;
  const activeTestStdin = activeTestMap?.get("stdin");
  const activeTestExpectedOutput = activeTestMap?.get("expectedOutput");

  useEffect(() => {
    setActiveTestId((current) => (
      current && activeFileTests.some((test) => test.id === current)
        ? current
        : activeFileTests[0]?.id ?? null
    ));
  }, [activeFileTests]);

  useEffect(() => {
    const lastTest = terminalStateRef.current?.lastTest;
    const completedTest = lastTest
      ? tests.find((test) => test.id === lastTest.testId)
      : null;
    setTestState(
      completedTest
      && completedTest.entryId === activeId
      && completedTest.id === activeTestId
        ? lastTest!.status
        : "idle",
    );
  }, [activeId, activeTestId, tests]);

  useLayoutEffect(() => {
    if (!activeTest) {
      activeTestDraftIdRef.current = null;
      setTestNameDraft("");
      setTestTimeoutDraft("");
      return;
    }
    if (activeTestDraftIdRef.current !== activeTest.id) {
      activeTestDraftIdRef.current = activeTest.id;
      setTestNameDraft(activeTest.name);
      setTestTimeoutDraft(String(activeTest.timeoutMs));
      return;
    }
    const activeTestField = document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.codeTestField
      : undefined;
    if (activeTestField !== `${activeTest.id}:name`) {
      setTestNameDraft(activeTest.name);
    }
    if (activeTestField !== `${activeTest.id}:timeout`) {
      setTestTimeoutDraft(String(activeTest.timeoutMs));
    }
  }, [activeTest]);

  const createEntry = useCallback((
    kind: "file" | "folder",
    parentId: string | null,
  ) => {
    if (!session || readOnly) return;
    setError(null);
    try {
      const name = nextAvailableName(
        entries,
        parentId,
        kind === "file" ? "untitled.py" : "folder",
      );
      const id = runExplorerHistoryCommand(undoManagerRef.current, () => (
        addCodeWorkspaceEntry(session.document, {
          kind,
          parentId,
          name,
        }, session.origin)
      ));
      if (kind === "file") setActiveId(id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось создать элемент");
    }
  }, [entries, readOnly, session]);

  const uploadFiles = useCallback(async (
    files: FileList | null,
    parentId: string | null,
  ) => {
    if (!session || !files || readOnly) return;
    setError(null);
    for (const file of [...files]) {
      try {
        if (file.size > MAX_UPLOAD_BYTES) {
          throw new Error(`Файл ${file.name} превышает 32 МБ`);
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const text = utf8Text(bytes);
        const currentEntries = listCodeWorkspaceEntries(session.document);
        const name = nextAvailableName(
          currentEntries,
          parentId,
          file.name,
        );
        if (text === null && session.allowBinaryUploads === false) {
          throw new Error(
            "Бинарные файлы пока недоступны в общей комнате",
          );
        }
        const blob = text === null
          ? await session.blobStore.put(file)
          : undefined;
        if (readOnlyRef.current || sessionRef.current !== session) {
          throw new Error("Редактирование приостановлено");
        }
        const id = runExplorerHistoryCommand(undoManagerRef.current, () => (
          addCodeWorkspaceEntry(session.document, {
            kind: "file",
            parentId,
            name,
            ...(blob ? { blob } : { text: text! }),
          }, session.origin)
        ));
        setActiveId(id);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Не удалось добавить файл");
        break;
      }
    }
  }, [readOnly, session]);

  const deleteEntry = useCallback((selectedEntries: readonly CodeWorkspaceEntrySnapshot[]) => {
    if (!session || readOnly || selectedEntries.length === 0) return;
    try {
      const removedIds = runExplorerHistoryCommand(undoManagerRef.current, () => (
        removeCodeWorkspaceEntries(
          session.document,
          selectedEntries.map((entry) => entry.id),
          session.origin,
        )
      ));
      if (activeIdRef.current && removedIds.includes(activeIdRef.current)) {
        const remaining = listCodeWorkspaceEntries(session.document);
        setActiveId(
          remaining.find((entry) => entry.id === "main-py" && entry.kind === "file")?.id
            ?? remaining.find((entry) => entry.kind === "file")?.id
            ?? null,
        );
      }
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось удалить");
    }
  }, [readOnly, session]);

  const duplicateEntry = useCallback((entry: CodeWorkspaceEntrySnapshot) => {
    if (!session || readOnly || entry.kind !== "file") return;
    try {
      const currentEntries = listCodeWorkspaceEntries(session.document);
      const current = currentEntries.find((candidate) => candidate.id === entry.id);
      if (!current || current.kind !== "file") return;
      const name = nextAvailableName(
        currentEntries,
        current.parentId,
        current.name,
      );
      const id = runExplorerHistoryCommand(undoManagerRef.current, () => (
        addCodeWorkspaceEntry(session.document, {
          kind: "file",
          parentId: current.parentId,
          name,
          ...(current.contentKind === "blob" && current.blob
            ? { blob: current.blob }
            : { text: current.text ?? "" }),
        }, session.origin)
      ));
      setActiveId(id);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось дублировать файл");
    }
  }, [readOnly, session]);

  const moveEntry = useCallback((entryIds: readonly string[], parentId: string | null) => {
    if (!session || readOnly || entryIds.length === 0) return;
    try {
      runExplorerHistoryCommand(undoManagerRef.current, () => {
        moveCodeWorkspaceEntries(
          session.document,
          entryIds,
          parentId,
          session.origin,
        );
      });
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось переместить");
    }
  }, [readOnly, session]);

  useEffect(() => {
    if (!readOnly) return;
    testRunRef.current?.cancel();
    const runtime = pythonTerminalRef.current;
    runtime?.interrupt();
    runtime?.close();
    pythonTerminalRef.current = null;
    pythonTerminalTokenRef.current = null;
    pythonInterruptRunIdRef.current = null;
  }, [readOnly]);

  const beginRename = useCallback((entry: CodeWorkspaceEntrySnapshot) => {
    if (readOnly) return;
    setRenamingId(entry.id);
    setRenameValue(entry.name);
  }, [readOnly]);

  const commitRename = useCallback(() => {
    if (!session || !renamingId || readOnly) return;
    try {
      runExplorerHistoryCommand(undoManagerRef.current, () => {
        renameCodeWorkspaceEntry(
          session.document,
          renamingId,
          renameValue,
          session.origin,
        );
      });
      setRenamingId(null);
      setRenameValue("");
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось переименовать");
    }
  }, [readOnly, renameValue, renamingId, session]);

  const undoExplorer = useCallback(() => {
    if (readOnly) return;
    const undoManager = undoManagerRef.current;
    undoManager?.stopCapturing();
    undoManager?.undo();
    setError(null);
  }, [readOnly]);

  const redoExplorer = useCallback(() => {
    if (readOnly) return;
    const undoManager = undoManagerRef.current;
    undoManager?.stopCapturing();
    undoManager?.redo();
    setError(null);
  }, [readOnly]);

  const createTest = useCallback(() => {
    if (!session || readOnly || !activeSupportsTests || !active) return;
    try {
      const id = addCodeTestCase(session.document, {
        entryId: active.id,
        name: `Тест ${activeFileTests.length + 1}`,
      }, session.origin);
      setActiveTestId(id);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось создать тест");
    }
  }, [active, activeFileTests.length, activeSupportsTests, readOnly, session]);

  const patchTest = useCallback((
    testId: string,
    patch: Parameters<typeof updateCodeTestCase>[2],
  ) => {
    if (!session || readOnly) return;
    try {
      updateCodeTestCase(session.document, testId, patch, session.origin);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось изменить тест");
    }
  }, [readOnly, session]);

  const terminalRunning = terminalState !== null && terminalState.mode !== "shell";

  const startSharedRun = useCallback(async (asTest: boolean) => {
    if (
      runRequestPendingRef.current
      ||
      !session
      || !active
      || active.kind !== "file"
      || active.contentKind !== "text"
      || readOnly
      || terminalReadOnly
      || terminalRunning
      || (asTest && (
        !activeSupportsTests
        || !activeTest
        || activeTest.entryId !== active.id
      ))
    ) return;
    const requestedEntryId = active.id;
    const requestedTestId = asTest ? activeTest?.id ?? null : null;
    let dispatched = false;
    runRequestPendingRef.current = true;
    setRunRequestPending(true);
    try {
      setError(null);
      setTestState("idle");
      await session.waitUntilSynchronized?.();
      if (
        sessionRef.current !== session
        || activeIdRef.current !== requestedEntryId
        || (asTest && activeTestIdRef.current !== requestedTestId)
        || readOnlyRef.current
        || terminalReadOnlyRef.current
      ) return;
      const currentTerminal = terminalStateRef.current;
      if (currentTerminal && currentTerminal.mode !== "shell") return;
      const entrypoint = workspaceFilePaths(session.document).get(requestedEntryId);
      if (!entrypoint) throw new Error("Python entry point is unavailable");
      const actionId = crypto.randomUUID();
      runRequestActionIdRef.current = actionId;
      const terminalBase = terminalStateRef.current;
      runRequestBaseStateRef.current = terminalBase ? {
        generation: terminalBase.generation,
        seq: terminalBase.seq,
      } : null;
      const sentActionId = dispatchTerminal({
        type: "start-run",
        entryId: requestedEntryId,
        entrypoint,
        ...(requestedTestId ? { testId: requestedTestId } : {}),
      }, actionId);
      if (!sentActionId) {
        runRequestActionIdRef.current = null;
        runRequestBaseStateRef.current = null;
        throw new Error("Терминал недоступен");
      }
      dispatched = true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось запустить код");
    } finally {
      if (!dispatched) {
        runRequestActionIdRef.current = null;
        runRequestBaseStateRef.current = null;
        runRequestPendingRef.current = false;
        if (mountedRef.current) setRunRequestPending(false);
      }
    }
  }, [
    active,
    activeSupportsTests,
    activeTest,
    dispatchTerminal,
    readOnly,
    session,
    terminalReadOnly,
    terminalRunning,
  ]);

  const stopSharedRun = useCallback(() => {
    dispatchTerminal({ type: terminalState?.mode === "python" ? "eof" : "interrupt" });
  }, [dispatchTerminal, terminalState?.mode]);

  const handleWorkspaceKeyDownCapture = useCallback((
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (
      event.key !== "F9"
      || event.ctrlKey
      || event.metaKey
      || event.altKey
      || event.shiftKey
    ) return;
    event.preventDefault();
    event.stopPropagation();
    const currentTerminal = terminalStateRef.current;
    if (
      event.repeat
      || runRequestPendingRef.current
      || (currentTerminal !== null && currentTerminal.mode !== "shell")
    ) return;
    void startSharedRun(false);
  }, [startSharedRun]);

  const activeTestNameTarget = activeTest
    ? { kind: "test", testId: activeTest.id, field: "name" } as const
    : null;
  const activeTestTimeoutTarget = activeTest
    ? { kind: "test", testId: activeTest.id, field: "timeout" } as const
    : null;
  const explorerSplit = codeWorkspaceSplitDescriptor(
    resolvedWorkspaceLayout,
    "explorer",
  );
  const consoleSplit = codeWorkspaceSplitDescriptor(
    resolvedWorkspaceLayout,
    "console",
  );
  const testsSplit = codeWorkspaceSplitDescriptor(
    resolvedWorkspaceLayout,
    "tests",
  );

  if (!session) {
    return (
      <div className="code-workspace-gate" role="status">
        {error ?? <span className="spinner" />}
      </div>
    );
  }

  return (
    <div
      ref={workspaceRootRef}
      className="full-code-workspace"
      data-code-theme={theme}
      data-code-layout={resolvedWorkspaceLayout.compact ? "compact" : "wide"}
      onKeyDownCapture={handleWorkspaceKeyDownCapture}
      data-code-tests-layout={
        resolvedWorkspaceLayout.testsStacked ? "stacked" : "side"
      }
    >
      <CodeExplorer
        id={explorerPanelId}
        entries={entries}
        activeId={activeId}
        readOnly={readOnly}
        renamingId={renamingId}
        renameValue={renameValue}
        onActivate={setActiveId}
        onBeginRename={beginRename}
        onRenameValueChange={setRenameValue}
        onCommitRename={commitRename}
        awarenessPeers={remotePeers}
        publishAwareness={publishOwnedAwareness}
        onCancelRename={() => {
          setRenamingId(null);
          setRenameValue("");
        }}
        onCreate={createEntry}
        onUpload={(files, parentId) => void uploadFiles(files, parentId)}
        onDuplicate={duplicateEntry}
        onDelete={deleteEntry}
        onMove={moveEntry}
        onUndo={undoExplorer}
        onRedo={redoExplorer}
      />

      <div
        ref={explorerSeparatorRef}
        className="code-workspace__separator code-workspace__separator--explorer"
        data-code-split="explorer"
        role="separator"
        tabIndex={0}
        aria-label="Изменить размер проводника"
        aria-controls={`${explorerPanelId} ${editorPanelId}`}
        aria-orientation={explorerSplit.orientation}
        aria-valuemin={explorerSplit.minimum}
        aria-valuemax={explorerSplit.maximum}
        aria-valuenow={explorerSplit.value}
        aria-valuetext={`${explorerSplit.value} пикселей`}
        onPointerDown={(event) => startWorkspaceResize("explorer", event)}
        onKeyDown={(event) => handleWorkspaceSeparatorKeyDown("explorer", event)}
        onDoubleClick={(event) => {
          event.preventDefault();
          resetWorkspaceSplit("explorer");
        }}
      />

      <section id={editorPanelId} className="code-main">
        <header className="code-main__toolbar">
          <strong>{active?.name ?? "Python"}</strong>
          <div>
            <button
              type="button"
              className={`code-tests-toggle${testsOpen ? " is-active" : ""}`}
              aria-label={testsOpen ? "Скрыть тесты" : "Показать тесты"}
              title={activeSupportsTests
                ? (testsOpen ? "Скрыть тесты" : "Показать тесты")
                : "Автотесты доступны для Python-файлов"}
              aria-expanded={testsOpen}
              aria-controls={testsPanelId}
              disabled={!activeSupportsTests && !testsOpen}
              onClick={() => setTestsOpen((current) => !current)}
            >
              <TestTube2 size={15} />
              <span>Тесты</span>
              <span className="code-tests-toggle__count">{activeFileTests.length}</span>
            </button>
            <button
              type="button"
              className="code-run-command"
              aria-label={terminalRunning ? "Остановить выполнение" : "Запустить код"}
              aria-keyshortcuts={terminalRunning ? undefined : "F9"}
              disabled={
                readOnly
                || terminalReadOnly
                || runRequestPending
                || active?.kind !== "file"
                || active.contentKind !== "text"
              }
              onClick={() => {
                if (terminalRunning) stopSharedRun();
                else void startSharedRun(false);
              }}
            >
              {terminalRunning ? <Square size={15} /> : <Play size={16} />}
              {terminalRunning ? "Stop" : "F9"}
            </button>
            {syncStatus && <CodeSyncIndicator {...syncStatus} />}
          </div>
        </header>
        <div className="code-main__editor">
          {active?.kind === "file" && active.contentKind !== "blob" ? (
            <Editor
              path={active.id}
              onMount={handleEditorMount}
              language={active.name.endsWith(".py") ? "python" : "plaintext"}
              defaultValue={active.text ?? ""}
              theme={editorTheme}
              options={mainEditorOptions}
            />
          ) : active?.kind === "file" && active.blob ? (
            <div className="code-binary-preview">
              <FileDigit size={28} />
              <strong>{active.name}</strong>
              <span>{active.blob.mimeType}</span>
              <span>{active.blob.byteSize.toLocaleString("ru-RU")} байт</span>
            </div>
          ) : active?.kind === "folder" ? (
            <div
              className="code-folder-actions"
              role="group"
              aria-label={`Действия папки ${active.name}`}
            >
              <button
                type="button"
                disabled={readOnly}
                onClick={() => folderUploadInputRef.current?.click()}
              >
                <Upload size={17} />
                <span>Прикрепить файл</span>
              </button>
              <button
                type="button"
                disabled={readOnly}
                onClick={() => createEntry("file", active.id)}
              >
                <FilePlus2 size={17} />
                <span>Создать файл</span>
              </button>
              <button
                type="button"
                disabled={readOnly}
                onClick={() => createEntry("folder", active.id)}
              >
                <FolderPlus size={17} />
                <span>Создать папку</span>
              </button>
              <input
                ref={folderUploadInputRef}
                className="sr-only"
                type="file"
                multiple
                disabled={readOnly}
                aria-label={`Файлы для папки ${active.name}`}
                onChange={(event) => {
                  void uploadFiles(event.currentTarget.files, active.id);
                  event.currentTarget.value = "";
                }}
              />
            </div>
          ) : <div />}
        </div>
        {error && <div className="code-workspace-error" role="alert">{error}</div>}
      </section>

      <div
        ref={consoleSeparatorRef}
        className="code-workspace__separator code-workspace__separator--console"
        data-code-split="console"
        role="separator"
        tabIndex={0}
        aria-label="Изменить высоту терминала"
        aria-controls={`${editorPanelId} ${consolePanelId}`}
        aria-orientation={consoleSplit.orientation}
        aria-valuemin={consoleSplit.minimum}
        aria-valuemax={consoleSplit.maximum}
        aria-valuenow={consoleSplit.value}
        aria-valuetext={`${consoleSplit.value} пикселей`}
        onPointerDown={(event) => startWorkspaceResize("console", event)}
        onKeyDown={(event) => handleWorkspaceSeparatorKeyDown("console", event)}
        onDoubleClick={(event) => {
          event.preventDefault();
          resetWorkspaceSplit("console");
        }}
      />

      <section
        id={consolePanelId}
        className={`code-console${testsOpen ? " is-tests-open" : ""}`}
      >
        {testsOpen && (
        <div id={testsPanelId} className="code-console__inputs">
          {!activeSupportsTests ? (
            <div className="code-tests-empty">
              Выберите Python-файл, чтобы открыть его автотесты
            </div>
          ) : activeFileTests.length === 0 ? (
            <div className="code-tests-empty">
              <button
                type="button"
                disabled={readOnly}
                onClick={createTest}
              >
                <Plus size={15} /> Создать тест
              </button>
            </div>
          ) : (
            <>
          <div className="code-tests__tabs" role="tablist" aria-label="Тесты">
            {activeFileTests.map((test) => (
              <button
                key={test.id}
                type="button"
                role="tab"
                aria-selected={test.id === activeTestId}
                className={test.id === activeTestId ? "is-active" : ""}
                onClick={() => {
                  if (document.activeElement instanceof HTMLElement) {
                    document.activeElement.blur();
                  }
                  setActiveTestId(test.id);
                }}
              >
                <TestTube2 size={13} />
                <span>{test.name}</span>
              </button>
            ))}
            <button
              type="button"
              aria-label="Добавить тест"
              title="Добавить тест"
              onClick={createTest}
              disabled={readOnly}
            ><Plus size={14} /></button>
          </div>
          {activeTest && (
            <div className="code-test__meta" key={activeTest.id}>
              {activeTestNameTarget && (
                <div className="code-test__field code-test__field--title">
                  <label htmlFor={`${testFieldIdPrefix}-test-title`}>Title:</label>
                  <NativeInputPresence
                    className="code-presence-field"
                    target={activeTestNameTarget}
                    value={testNameDraft}
                    peers={remotePeers}
                    publish={publishOwnedAwareness}
                  >
                    {(presence) => (
                      <input
                        {...presence}
                        id={`${testFieldIdPrefix}-test-title`}
                        data-code-test-field={`${activeTest.id}:name`}
                        aria-label="Название теста"
                        value={testNameDraft}
                        readOnly={readOnly}
                        onChange={(event) => setTestNameDraft(event.target.value)}
                        onBlur={(event) => {
                          presence.onBlur(event);
                          if (activeTestIdRef.current !== activeTest.id) return;
                          if (event.target.value.trim()) {
                            patchTest(activeTest.id, { name: event.target.value });
                          } else {
                            setTestNameDraft(activeTest.name);
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                    )}
                  </NativeInputPresence>
                </div>
              )}
              {activeTestTimeoutTarget && (
                <div className="code-test__field code-test__field--timeout">
                  <label htmlFor={`${testFieldIdPrefix}-test-timeout`}>Timeout:</label>
                  <NativeInputPresence
                    className="code-presence-field"
                    target={activeTestTimeoutTarget}
                    value={testTimeoutDraft}
                    peers={remotePeers}
                    publish={publishOwnedAwareness}
                  >
                    {(presence) => (
                      <input
                        {...presence}
                        id={`${testFieldIdPrefix}-test-timeout`}
                        data-code-test-field={`${activeTest.id}:timeout`}
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={String(CODE_TEST_TIMEOUT_MAX_MS).length}
                        aria-label="Лимит теста, мс"
                        title="Лимит теста, мс"
                        value={testTimeoutDraft}
                        readOnly={readOnly}
                        onChange={(event) => {
                          if (/^\d*$/u.test(event.target.value)) {
                            setTestTimeoutDraft(event.target.value);
                          }
                        }}
                        onBlur={(event) => {
                          presence.onBlur(event);
                          if (activeTestIdRef.current !== activeTest.id) return;
                          const timeoutMs = Number(event.currentTarget.value);
                          if (
                            event.currentTarget.value !== ""
                            && Number.isSafeInteger(timeoutMs)
                            && timeoutMs >= CODE_TEST_TIMEOUT_MIN_MS
                            && timeoutMs <= CODE_TEST_TIMEOUT_MAX_MS
                          ) {
                            patchTest(activeTest.id, {
                              timeoutMs,
                            });
                          } else {
                            setTestTimeoutDraft(String(activeTest.timeoutMs));
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                    )}
                  </NativeInputPresence>
                </div>
              )}
              <button
                type="button"
                aria-label="Удалить тест"
                title="Удалить тест"
                disabled={readOnly}
                onClick={() => removeCodeTestCase(
                  session.document,
                  activeTest.id,
                  session.origin,
                )}
              ><Trash2 size={14} /></button>
            </div>
          )}
          <label>
            <span>Ввод</span>
            {activeTest && activeTestStdin instanceof Y.Text ? (
              <CollaborativeMonacoTextField
                key={`${activeTest.id}:stdin`}
                yText={activeTestStdin}
                transactionOrigin={session.origin}
                target={{
                  kind: "test",
                  testId: activeTest.id,
                  field: "stdin",
                }}
                publishAwareness={publishOwnedAwareness}
                peers={remotePeers}
                modelPath={`eduri-test://${session.document.guid}/${activeTest.id}/stdin.txt`}
                ariaLabel={`Ввод теста ${activeTest.name}`}
                theme={editorTheme}
                readOnly={readOnly}
              />
            ) : <div className="code-collaborative-field" />}
          </label>
          <label>
            <span>Ожидаемый вывод</span>
            {activeTest && activeTestExpectedOutput instanceof Y.Text ? (
              <CollaborativeMonacoTextField
                key={`${activeTest.id}:expectedOutput`}
                yText={activeTestExpectedOutput}
                transactionOrigin={session.origin}
                target={{
                  kind: "test",
                  testId: activeTest.id,
                  field: "expectedOutput",
                }}
                publishAwareness={publishOwnedAwareness}
                peers={remotePeers}
                modelPath={`eduri-test://${session.document.guid}/${activeTest.id}/expected.txt`}
                ariaLabel={`Ожидаемый вывод теста ${activeTest.name}`}
                theme={editorTheme}
                readOnly={readOnly}
              />
            ) : <div className="code-collaborative-field" />}
          </label>
          <button type="button" disabled={readOnly || terminalReadOnly || terminalRunning || runRequestPending || !activeSupportsTests || !activeTest} onClick={() => void startSharedRun(true)}>
            <Play size={15} /> Проверить
          </button>
            </>
          )}
        </div>
        )}
        {testsOpen && (
          <div
            ref={testsSeparatorRef}
            className="code-workspace__separator code-workspace__separator--tests"
            data-code-split="tests"
            role="separator"
            tabIndex={0}
            aria-label="Изменить размер панели автотестов"
            aria-controls={`${testsPanelId} ${terminalPanelId}`}
            aria-orientation={testsSplit.orientation}
            aria-valuemin={testsSplit.minimum}
            aria-valuemax={testsSplit.maximum}
            aria-valuenow={testsSplit.value}
            aria-valuetext={`${testsSplit.value} пикселей`}
            onPointerDown={(event) => startWorkspaceResize("tests", event)}
            onKeyDown={(event) => handleWorkspaceSeparatorKeyDown("tests", event)}
            onDoubleClick={(event) => {
              event.preventDefault();
              resetWorkspaceSplit("tests");
            }}
          />
        )}
        <div id={terminalPanelId} className="code-console__output">
          <header>
            <strong>Терминал</strong>
            <div>
              {terminalState?.mode === "program-input" && (
                <span className="code-console__waiting">
                  Ожидается ввод программы
                </span>
              )}
              {testState !== "idle" && (
                <span className={`is-${testState}`}>
                  {testState === "passed" ? "Тест пройден" : "Ответ отличается"}
                </span>
              )}
            </div>
          </header>
          {terminalState ? (
            <SharedTerminal
              snapshot={{
                generation: terminalState.generation,
                revision: terminalState.seq,
                transcript: terminalState.transcript,
                prompt: terminalState.prompt,
                input: terminalState.input.value,
                cursor: terminalState.input.cursor,
                busy: terminalState.mode === "busy",
                inputOwnerParticipantId: terminalState.input.owner?.participantId,
                inputOwnerName: terminalState.input.owner?.displayName,
                inputOwnerColor: terminalState.input.owner?.color,
              }}
              localParticipantId={
                participantId ?? session.terminal?.participantId ?? null
              }
              claimRejectionRevision={terminalClaimRejectionRevision}
              submitRejectionRevision={terminalSubmitRejectionRevision}
              readOnly={terminalReadOnly}
              theme={theme}
              onEditInput={(value, cursor) => {
                const actionId = dispatchTerminal({
                  type: "edit-input",
                  value,
                  cursor,
                });
                if (actionId) terminalInputActionIdsRef.current.add(actionId);
              }}
              onSubmitLine={async (value) => {
                try {
                  await session.waitUntilSynchronized?.();
                  const actionId = dispatchTerminal({ type: "submit-line", value });
                  if (!actionId) throw new Error("Терминал недоступен");
                  terminalSubmitActionIdsRef.current.add(actionId);
                } catch (reason) {
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : "Терминал недоступен",
                  );
                  throw reason;
                }
              }}
              onInterrupt={() => dispatchTerminal({ type: "interrupt" })}
              onEof={() => dispatchTerminal({ type: "eof" })}
              onFocus={() => {
                if (terminalReadOnly) return;
                terminalClaimActionIdRef.current = dispatchTerminal({
                  type: "claim",
                });
                publishOwnedAwareness(terminalAwarenessOwnerRef.current, {
                  target: {
                  kind: "terminal",
                  field: "input",
                  },
                });
              }}
              onBlur={() => {
                terminalClaimActionIdRef.current = null;
                if (!terminalReadOnly) dispatchTerminal({ type: "release" });
                publishOwnedAwareness(terminalAwarenessOwnerRef.current, null);
              }}
            />
          ) : (
            <div className="code-shared-terminal code-shared-terminal--loading" role="status">
              Подключаем общий терминал…
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
