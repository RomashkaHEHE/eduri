import Editor, { type OnMount } from "@monaco-editor/react";
import {
  FileDigit,
  FilePlus2,
  FolderPlus,
  CornerDownLeft,
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
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import * as Y from "yjs";
import {
  CODE_TEST_TIMEOUT_MAX_MS,
  CODE_TEST_TIMEOUT_MIN_MS,
  CodeWorkspaceError,
  addCodeTestCase,
  addCodeWorkspaceEntry,
  codeWorkspaceEntries,
  codeWorkspaceTestCases,
  compareCodeTestOutput,
  initializeCodeWorkspace,
  listCodeWorkspaceEntries,
  listCodeTestCases,
  moveCodeWorkspaceEntry,
  removeCodeWorkspaceEntry,
  removeCodeTestCase,
  renameCodeWorkspaceEntry,
  replaceCodeWorkspaceText,
  updateCodeTestCase,
  type CodeWorkspaceEntrySnapshot,
  type CodeTestCaseSnapshot,
} from "../../code/core";
import type {
  CodeAwarenessState,
  GuestCodePeerAwareness,
} from "../code/guestCodeProvider";
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
import { useOptionalTheme } from "../theme";
import { CodeExplorer } from "./CodeExplorer";
import "./CodeWorkspace.css";

export type CodeWorkspaceBlobStore = PythonWorkspaceBlobStore;

export interface CodeWorkspaceAwarenessBridge {
  setAwareness(state: CodeAwarenessState | null): void;
  subscribeAwareness(
    listener: (peers: readonly GuestCodePeerAwareness[]) => void,
  ): () => void;
}

export interface CodeWorkspaceSessionHandle {
  readonly document: Y.Doc;
  readonly origin: object;
  readonly blobStore: CodeWorkspaceBlobStore;
  readonly flush: () => Promise<void>;
  readonly allowBinaryUploads?: boolean;
  readonly awareness?: CodeWorkspaceAwarenessBridge;
}

interface CodeWorkspaceProps {
  persistenceName?: string;
  session?: CodeWorkspaceSessionHandle;
  onSessionReady?: (session: CodeWorkspaceSessionHandle | null) => void;
  readOnly?: boolean;
}

type MonacoEditorInstance = Parameters<OnMount>[0];
type MonacoApi = Parameters<OnMount>[1];
type MonacoDecorations = ReturnType<
  MonacoEditorInstance["createDecorationsCollection"]
>;
type MonacoDecoration = Parameters<MonacoDecorations["set"]>[0][number];

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const MAX_SHARED_TERMINAL_INPUT_CHARS = 1_024;

interface LocalTerminalRequest {
  readonly runId: string;
  readonly requestId: string;
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

function editorAwareness(
  editor: MonacoEditorInstance,
  entryId: string | null,
): CodeAwarenessState | null {
  if (!entryId) return null;
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position) return null;
  const offset = model.getOffsetAt(position);
  const selection = editor.getSelection();
  if (!selection) return { cursor: { entryId, offset } };
  const anchor = model.getOffsetAt({
    lineNumber: selection.selectionStartLineNumber,
    column: selection.selectionStartColumn,
  });
  const head = model.getOffsetAt({
    lineNumber: selection.positionLineNumber,
    column: selection.positionColumn,
  });
  return {
    cursor: { entryId, offset },
    selection: { entryId, anchor, head },
  };
}

export function CodeWorkspace({
  persistenceName,
  session: suppliedSession,
  onSessionReady,
  readOnly = false,
}: CodeWorkspaceProps) {
  const theme = useOptionalTheme()?.theme ?? "light";
  const editorTheme = theme === "dark" ? "vs-dark" : "vs";
  const [session, setSession] = useState<CodeWorkspaceSessionHandle | null>(null);
  const [entries, setEntries] = useState<readonly CodeWorkspaceEntrySnapshot[]>([]);
  const [tests, setTests] = useState<readonly CodeTestCaseSnapshot[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTestId, setActiveTestId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState("Результат выполнения появится здесь.");
  const [terminalInput, setTerminalInput] = useState("");
  const [localTerminalRequest, setLocalTerminalRequest]
    = useState<LocalTerminalRequest | null>(null);
  const [testsOpen, setTestsOpen] = useState(false);
  const [testState, setTestState] = useState<"idle" | "passed" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const activeRunRef = useRef<PythonRunHandle | null>(null);
  const runTokenRef = useRef<object | null>(null);
  const mountedRef = useRef(false);
  const sessionRef = useRef<CodeWorkspaceSessionHandle | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const onSessionReadyRef = useRef(onSessionReady);
  const readOnlyRef = useRef(readOnly);
  const editorRef = useRef<MonacoEditorInstance | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const editorThemeRef = useRef(editorTheme);
  const decorationsRef = useRef<MonacoDecorations | null>(null);
  const cursorSubscriptionRef = useRef<{ dispose(): void } | null>(null);
  const undoManagerRef = useRef<Y.UndoManager | null>(null);
  const outputRef = useRef(output);
  const localTerminalRequestRef = useRef<LocalTerminalRequest | null>(null);
  const terminalInputRef = useRef<HTMLInputElement | null>(null);
  const folderUploadInputRef = useRef<HTMLInputElement | null>(null);
  const terminalAwarenessClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorAwarenessRef = useRef<CodeAwarenessState | null>(null);
  const terminalAwarenessRef = useRef<CodeAwarenessState["terminal"] | null>(null);
  const seenTerminalSubmissionsRef = useRef(new Set<string>());
  const observedRemoteTerminalRequestRef = useRef<LocalTerminalRequest | null>(null);
  const [remotePeers, setRemotePeers] = useState<
    readonly GuestCodePeerAwareness[]
  >([]);

  onSessionReadyRef.current = onSessionReady;
  readOnlyRef.current = readOnly;
  sessionRef.current = session;
  activeIdRef.current = activeId;
  editorThemeRef.current = editorTheme;

  useLayoutEffect(() => {
    monacoRef.current?.editor.setTheme(editorTheme);
  }, [editorTheme]);

  const replaceOutput = useCallback((value: string) => {
    outputRef.current = value;
    setOutput(value);
  }, []);

  const appendOutput = useCallback((value: string) => {
    if (!value) return;
    outputRef.current += value;
    setOutput(outputRef.current);
  }, []);

  const updateLocalTerminalRequest = useCallback((
    request: LocalTerminalRequest | null,
  ) => {
    localTerminalRequestRef.current = request;
    setLocalTerminalRequest(request);
  }, []);

  const publishAwareness = useCallback(() => {
    const bridge = sessionRef.current?.awareness;
    if (!bridge) return;
    const editor = editorAwarenessRef.current;
    const terminal = terminalAwarenessRef.current;
    bridge.setAwareness(editor || terminal
      ? {
          ...(editor?.cursor ? { cursor: editor.cursor } : {}),
          ...(editor?.selection ? { selection: editor.selection } : {}),
          ...(terminal ? { terminal } : {}),
        }
      : null);
  }, []);

  const clearTerminalRequest = useCallback(() => {
    updateLocalTerminalRequest(null);
    terminalAwarenessRef.current = null;
    publishAwareness();
  }, [publishAwareness, updateLocalTerminalRequest]);

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
      setActiveId((current) => (
        current && next.some((entry) => entry.id === current)
          ? current
          : next.find((entry) => entry.kind === "file")?.id ?? null
      ));
    };
    const refreshTests = () => {
      const document = activeHandle?.document;
      if (!document) return;
      const nextTests = listCodeTestCases(document);
      setTests(nextTests);
      setActiveTestId((current) => (
        current && nextTests.some((test) => test.id === current)
          ? current
          : nextTests[0]?.id ?? null
      ));
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
          const textValues = new Map<string, string>();
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
            textValues.set(entryId, event.target.toString());
          }
          if (textValues.size === 0) return;
          setEntries((current) => {
            if ([...textValues.keys()].some((id) => (
              !current.some((entry) => entry.id === id)
            ))) {
              return listCodeWorkspaceEntries(handle.document);
            }
            let changed = false;
            const next = current.map((entry) => {
              const text = textValues.get(entry.id);
              if (text === undefined || entry.text === text) return entry;
              changed = true;
              return { ...entry, text };
            });
            return changed ? next : current;
          });
        };
      const onTestsChanged: Parameters<typeof testsRoot.observeDeep>[0]
        = (events) => {
          const textValues = new Map<
            string,
            Partial<Pick<CodeTestCaseSnapshot, "stdin" | "expectedOutput">>
          >();
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
            textValues.set(testId, {
              ...textValues.get(testId),
              [property]: event.target.toString(),
            });
          }
          if (textValues.size === 0) return;
          setTests((current) => {
            if ([...textValues.keys()].some((id) => (
              !current.some((test) => test.id === id)
            ))) {
              return listCodeTestCases(handle.document);
            }
            let changed = false;
            const next = current.map((test) => {
              const patch = textValues.get(test.id);
              if (!patch) return test;
              if (
                (patch.stdin === undefined || patch.stdin === test.stdin)
                && (
                  patch.expectedOutput === undefined
                  || patch.expectedOutput === test.expectedOutput
                )
              ) return test;
              changed = true;
              return { ...test, ...patch };
            });
            return changed ? next : current;
          });
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
      activeRunRef.current?.cancel();
      activeRunRef.current = null;
      runTokenRef.current = null;
      localTerminalRequestRef.current = null;
      terminalAwarenessRef.current = null;
      editorAwarenessRef.current = null;
      if (terminalAwarenessClearTimerRef.current !== null) {
        clearTimeout(terminalAwarenessClearTimerRef.current);
        terminalAwarenessClearTimerRef.current = null;
      }
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

  useEffect(() => {
    const request = localTerminalRequest;
    const execution = activeRunRef.current;
    if (!request || !execution || execution.runId !== request.runId) return;
    for (const peer of remotePeers) {
      const terminal = peer.state.terminal;
      if (
        terminal?.kind !== "input"
        || terminal.runId !== request.runId
        || terminal.requestId !== request.requestId
      ) continue;
      const key = `${peer.participant.participantId}:${terminal.submissionId}`;
      if (seenTerminalSubmissionsRef.current.has(key)) continue;
      seenTerminalSubmissionsRef.current.add(key);
      if (execution.submitInput(terminal.value)) {
        appendOutput(`${terminal.value}\n`);
        clearTerminalRequest();
        setTerminalInput("");
        break;
      }
    }
  }, [appendOutput, clearTerminalRequest, localTerminalRequest, remotePeers]);

  useEffect(() => {
    if (running || localTerminalRequest) return;
    const remoteHost = remotePeers.find((peer) => (
      peer.state.terminal?.kind === "host"
    ));
    const hostTerminal = remoteHost?.state.terminal;
    if (hostTerminal?.kind === "host") {
      const previous = observedRemoteTerminalRequestRef.current;
      observedRemoteTerminalRequestRef.current = {
        runId: hostTerminal.runId,
        requestId: hostTerminal.requestId,
      };
      if (previous?.runId !== hostTerminal.runId) {
        seenTerminalSubmissionsRef.current.clear();
        replaceOutput("");
        setTerminalInput("");
      }
    }
    const request = hostTerminal?.kind === "host"
      ? hostTerminal
      : observedRemoteTerminalRequestRef.current;
    if (!request) return;
    for (const peer of remotePeers) {
      const terminal = peer.state.terminal;
      if (
        terminal?.kind !== "input"
        || terminal.runId !== request.runId
        || terminal.requestId !== request.requestId
      ) continue;
      const key = `${peer.participant.participantId}:${terminal.submissionId}`;
      if (seenTerminalSubmissionsRef.current.has(key)) continue;
      seenTerminalSubmissionsRef.current.add(key);
      appendOutput(`${terminal.value}\n`);
      setTerminalInput("");
    }
  }, [appendOutput, localTerminalRequest, remotePeers, replaceOutput, running]);

  useEffect(() => {
    if (!localTerminalRequest) return;
    terminalInputRef.current?.focus({ preventScroll: true });
  }, [localTerminalRequest]);

  const handleEditorMount = useCallback<OnMount>((editor, monaco) => {
    cursorSubscriptionRef.current?.dispose();
    decorationsRef.current?.clear();
    editorRef.current = editor;
    monacoRef.current = monaco;
    monaco.editor.setTheme(editorThemeRef.current);
    decorationsRef.current = editor.createDecorationsCollection();
    cursorSubscriptionRef.current = editor.onDidChangeCursorSelection(() => {
      editorAwarenessRef.current = editorAwareness(
        editor,
        activeIdRef.current,
      );
      publishAwareness();
    });
    editorAwarenessRef.current = editorAwareness(
      editor,
      activeIdRef.current,
    );
    publishAwareness();
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
  }, [publishAwareness]);

  useEffect(() => () => {
    cursorSubscriptionRef.current?.dispose();
    cursorSubscriptionRef.current = null;
    decorationsRef.current?.clear();
    decorationsRef.current = null;
    editorRef.current = null;
    monacoRef.current = null;
    editorAwarenessRef.current = null;
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editorAwarenessRef.current = editorAwareness(editor, activeId);
    publishAwareness();
  }, [activeId, publishAwareness, session]);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const collection = decorationsRef.current;
    const model = editor?.getModel();
    if (!editor || !monaco || !collection || !model || !activeId) {
      collection?.clear();
      return;
    }
    const decorations: MonacoDecoration[] = [];
    for (const peer of remotePeers) {
      const hoverMessage = { value: peer.participant.displayName };
      const selection = peer.state.selection;
      if (
        selection?.entryId === activeId
        && selection.anchor !== selection.head
      ) {
        const anchor = model.getPositionAt(selection.anchor);
        const head = model.getPositionAt(selection.head);
        decorations.push({
          range: new monaco.Range(
            anchor.lineNumber,
            anchor.column,
            head.lineNumber,
            head.column,
          ),
          options: {
            className: "code-remote-selection",
            hoverMessage,
            overviewRuler: {
              color: peer.participant.color,
              position: monaco.editor.OverviewRulerLane.Center,
            },
          },
        });
      }
      const cursor = peer.state.cursor;
      if (cursor?.entryId === activeId) {
        const position = model.getPositionAt(cursor.offset);
        decorations.push({
          range: new monaco.Range(
            position.lineNumber,
            position.column,
            position.lineNumber,
            position.column,
          ),
          options: {
            hoverMessage,
            before: {
              content: "|",
              inlineClassName: "code-remote-cursor",
            },
            overviewRuler: {
              color: peer.participant.color,
              position: monaco.editor.OverviewRulerLane.Center,
            },
          },
        });
      }
    }
    collection.set(decorations);
  }, [activeId, remotePeers]);

  const active = entries.find((entry) => entry.id === activeId) ?? null;
  const activeTest = tests.find((test) => test.id === activeTestId) ?? null;

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

  const deleteEntry = useCallback((entry: CodeWorkspaceEntrySnapshot) => {
    if (!session || readOnly || entry.id === "main-py") return;
    try {
      runExplorerHistoryCommand(undoManagerRef.current, () => {
        removeCodeWorkspaceEntry(session.document, entry.id, session.origin);
      });
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

  const moveEntry = useCallback((entryId: string, parentId: string | null) => {
    if (!session || readOnly) return;
    try {
      runExplorerHistoryCommand(undoManagerRef.current, () => {
        moveCodeWorkspaceEntry(
          session.document,
          entryId,
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
    activeRunRef.current?.cancel();
    activeRunRef.current = null;
    runTokenRef.current = null;
    setRunning(false);
    clearTerminalRequest();
  }, [clearTerminalRequest, readOnly]);

  const changeCode = useCallback((value: string | undefined) => {
    if (!session || !active || active.kind !== "file" || readOnly) return;
    try {
      replaceCodeWorkspaceText(
        session.document,
        active.id,
        value ?? "",
        session.origin,
      );
    } catch (reason) {
      if (reason instanceof CodeWorkspaceError) setError(reason.message);
    }
  }, [active, readOnly, session]);

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
    if (!session || readOnly) return;
    try {
      const id = addCodeTestCase(session.document, {
        name: `Тест ${tests.length + 1}`,
      }, session.origin);
      setActiveTestId(id);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось создать тест");
    }
  }, [readOnly, session, tests.length]);

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

  const run = useCallback(async (asTest = false) => {
    if (
      !session
      || !active
      || active.kind !== "file"
      || active.contentKind !== "text"
      || running
      || readOnly
    ) return;
    const runToken = Object.freeze({});
    runTokenRef.current = runToken;
    setRunning(true);
    setError(null);
    setTestState("idle");
    seenTerminalSubmissionsRef.current.clear();
    clearTerminalRequest();
    setTerminalInput("");
    replaceOutput("");
    let streamedProgramOutput = "";
    try {
      const baseline = await capturePythonWorkspaceRunBaseline(
        session.document,
        session.blobStore,
      );
      if (
        runTokenRef.current !== runToken
        || !mountedRef.current
        || readOnlyRef.current
        || sessionRef.current !== session
      ) return;
      const entrypoint = baseline.files.find((file) => (
        file.entry.id === active.id
      ))?.path;
      if (!entrypoint) throw new Error("Python entry point is unavailable");
      const test = asTest ? activeTest : null;
      const payload = {
        kind: "workspace",
        files: baseline.runnerFiles,
        directories: baseline.runnerDirectories,
        entrypoint,
        stdin: test?.stdin ?? null,
      } as const;
      const execution = test
        ? startPythonRun(payload, { timeoutMs: test.timeoutMs })
        : startPythonRun(payload, {
            onOutput: (chunk) => {
              if (
                runTokenRef.current !== runToken
                || !mountedRef.current
                || sessionRef.current !== session
              ) return;
              streamedProgramOutput += chunk;
              appendOutput(chunk);
            },
            onInputRequest: (request) => {
              if (
                runTokenRef.current !== runToken
                || !mountedRef.current
                || readOnlyRef.current
                || sessionRef.current !== session
              ) return;
              const next = {
                runId: request.runId,
                requestId: request.requestId,
              };
              updateLocalTerminalRequest(next);
              terminalAwarenessRef.current = { kind: "host", ...next };
              publishAwareness();
            },
          });
      activeRunRef.current = execution;
      const result = await execution.result;
      if (result.status === "cancelled" || !mountedRef.current) return;
      if (asTest || streamedProgramOutput.length === 0) {
        replaceOutput(result.output);
      } else if (result.output.startsWith(streamedProgramOutput)) {
        appendOutput(result.output.slice(streamedProgramOutput.length));
      } else if (result.output) {
        appendOutput(`${outputRef.current.endsWith("\n") ? "" : "\n"}${result.output}`);
      }
      if (!asTest && result.workspaceDelta) {
        const applied = await applyPythonWorkspaceDelta({
          document: session.document,
          origin: session.origin,
          blobStore: session.blobStore,
          baseline,
          delta: result.workspaceDelta,
          canApply: () => (
            mountedRef.current
            && !readOnlyRef.current
            && sessionRef.current === session
            && activeRunRef.current === execution
            && runTokenRef.current === runToken
          ),
        });
        if (!applied.aborted && applied.conflicts.length > 0) {
          const conflictPaths = applied.conflicts.slice(0, 5)
            .map((conflict) => conflict.path)
            .join(", ");
          const remaining = applied.conflicts.length - 5;
          setError(
            `Изменения файлов после запуска применены частично. Не применено: ${conflictPaths}${remaining > 0 ? ` и ещё ${remaining}` : ""}.`,
          );
        }
      }
      if (asTest) {
        const matches = test
          ? compareCodeTestOutput(
              result.output,
              test.expectedOutput,
            )
          : false;
        setTestState(
          result.status === "ok" && matches
            ? "passed"
            : "failed",
        );
      }
      if (activeRunRef.current === execution) activeRunRef.current = null;
    } catch (reason) {
      if (mountedRef.current) {
        setError(reason instanceof Error ? reason.message : "Не удалось запустить код");
      }
    } finally {
      if (runTokenRef.current === runToken) {
        runTokenRef.current = null;
        activeRunRef.current = null;
        clearTerminalRequest();
        if (mountedRef.current) setRunning(false);
      }
    }
  }, [
    active,
    activeTest,
    appendOutput,
    clearTerminalRequest,
    publishAwareness,
    readOnly,
    replaceOutput,
    running,
    session,
    updateLocalTerminalRequest,
  ]);

  const remoteTerminalHost = !running
    ? remotePeers.find((peer) => peer.state.terminal?.kind === "host") ?? null
    : null;
  const remoteTerminalRequest = remoteTerminalHost?.state.terminal?.kind === "host"
    ? remoteTerminalHost.state.terminal
    : null;
  const terminalRequest = localTerminalRequest
    ? { ...localTerminalRequest, local: true as const, owner: "Программа" }
    : remoteTerminalRequest
      ? {
          runId: remoteTerminalRequest.runId,
          requestId: remoteTerminalRequest.requestId,
          local: false as const,
          owner: remoteTerminalHost?.participant.displayName ?? "Участник",
        }
      : null;

  const submitTerminalInput = (): void => {
    if (!terminalRequest || readOnly) return;
    const value = terminalInput.slice(0, MAX_SHARED_TERMINAL_INPUT_CHARS);
    if (terminalRequest.local) {
      const execution = activeRunRef.current;
      if (
        !execution
        || execution.runId !== terminalRequest.runId
        || !execution.submitInput(value)
      ) return;
      appendOutput(`${value}\n`);
      clearTerminalRequest();
      setTerminalInput("");
      return;
    }
    const submissionId = crypto.randomUUID();
    terminalAwarenessRef.current = {
      kind: "input",
      runId: terminalRequest.runId,
      requestId: terminalRequest.requestId,
      submissionId,
      value,
    };
    publishAwareness();
    appendOutput(`${value}\n`);
    setTerminalInput("");
    if (terminalAwarenessClearTimerRef.current !== null) {
      clearTimeout(terminalAwarenessClearTimerRef.current);
    }
    terminalAwarenessClearTimerRef.current = setTimeout(() => {
      terminalAwarenessClearTimerRef.current = null;
      const current = terminalAwarenessRef.current;
      if (current?.kind !== "input" || current.submissionId !== submissionId) return;
      terminalAwarenessRef.current = null;
      publishAwareness();
    }, 2_000);
  };

  if (!session) {
    return (
      <div className="code-workspace-gate" role="status">
        {error ?? <span className="spinner" />}
      </div>
    );
  }

  return (
    <div className="full-code-workspace" data-code-theme={theme}>
      <CodeExplorer
        entries={entries}
        activeId={activeId}
        readOnly={readOnly}
        renamingId={renamingId}
        renameValue={renameValue}
        onSelect={setActiveId}
        onBeginRename={beginRename}
        onRenameValueChange={setRenameValue}
        onCommitRename={commitRename}
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

      <section className="code-main">
        <header className="code-main__toolbar">
          <strong>{active?.name ?? "Python"}</strong>
          <div>
            <button
              type="button"
              className={`code-tests-toggle${testsOpen ? " is-active" : ""}`}
              aria-label={testsOpen ? "Скрыть тесты" : "Показать тесты"}
              title={testsOpen ? "Скрыть тесты" : "Показать тесты"}
              aria-expanded={testsOpen}
              aria-controls="code-tests-panel"
              onClick={() => setTestsOpen((current) => !current)}
            >
              <TestTube2 size={15} />
              <span>Тесты</span>
              <span className="code-tests-toggle__count">{tests.length}</span>
            </button>
            <button
              type="button"
              className="code-run-command"
              disabled={
                readOnly
                || active?.kind !== "file"
                || active.contentKind !== "text"
              }
              onClick={() => {
                if (running) {
                  runTokenRef.current = null;
                  activeRunRef.current?.cancel();
                  activeRunRef.current = null;
                  clearTerminalRequest();
                  setRunning(false);
                } else void run(false);
              }}
            >
              {running ? <Square size={15} /> : <Play size={16} />}
              {running ? "Остановить" : "Запустить"}
            </button>
          </div>
        </header>
        <div className="code-main__editor">
          {active?.kind === "file" && active.contentKind !== "blob" ? (
            <Editor
              path={active.id}
              onMount={handleEditorMount}
              language={active.name.endsWith(".py") ? "python" : "plaintext"}
              value={active.text ?? ""}
              onChange={changeCode}
              theme={editorTheme}
              options={{
                readOnly,
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: 14,
                lineHeight: 22,
                tabSize: 4,
                insertSpaces: true,
                scrollBeyondLastLine: false,
                padding: { top: 12 },
                ariaLabel: `Редактор ${active.name}`,
              }}
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

      <section className={`code-console${testsOpen ? " is-tests-open" : ""}`}>
        {testsOpen && (
        <div id="code-tests-panel" className="code-console__inputs">
          {tests.length === 0 ? (
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
            {tests.map((test) => (
              <button
                key={test.id}
                type="button"
                role="tab"
                aria-selected={test.id === activeTestId}
                className={test.id === activeTestId ? "is-active" : ""}
                onClick={() => setActiveTestId(test.id)}
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
            <div className="code-test__meta">
              <input
                key={activeTest.id}
                aria-label="Название теста"
                defaultValue={activeTest.name}
                readOnly={readOnly}
                onBlur={(event) => patchTest(activeTest.id, {
                  name: event.target.value,
                })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              <input
                key={`${activeTest.id}:${activeTest.timeoutMs}`}
                type="number"
                aria-label="Лимит теста, мс"
                title="Лимит теста, мс"
                min={CODE_TEST_TIMEOUT_MIN_MS}
                max={CODE_TEST_TIMEOUT_MAX_MS}
                step={250}
                defaultValue={activeTest.timeoutMs}
                readOnly={readOnly}
                onBlur={(event) => {
                  if (!Number.isNaN(event.currentTarget.valueAsNumber)) {
                    patchTest(activeTest.id, {
                      timeoutMs: event.currentTarget.valueAsNumber,
                    });
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
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
            <textarea
              value={activeTest?.stdin ?? ""}
              readOnly={readOnly}
              onChange={(event) => activeTest && patchTest(activeTest.id, {
                stdin: event.target.value,
              })}
            />
          </label>
          <label>
            <span>Ожидаемый вывод</span>
            <textarea
              value={activeTest?.expectedOutput ?? ""}
              readOnly={readOnly}
              onChange={(event) => activeTest && patchTest(activeTest.id, {
                expectedOutput: event.target.value,
              })}
            />
          </label>
          <button type="button" disabled={readOnly || running || !active || !activeTest} onClick={() => void run(true)}>
            <Play size={15} /> Проверить
          </button>
            </>
          )}
        </div>
        )}
        <div className={`code-console__output${terminalRequest ? " has-prompt" : ""}`}>
          <header>
            <strong>Терминал</strong>
            <div>
              {terminalRequest && (
                <span className="code-console__waiting">
                  {terminalRequest.local
                    ? "Ожидается ввод"
                    : `${terminalRequest.owner} ожидает ввод`}
                </span>
              )}
              {testState !== "idle" && (
                <span className={`is-${testState}`}>
                  {testState === "passed" ? "Тест пройден" : "Ответ отличается"}
                </span>
              )}
            </div>
          </header>
          <pre aria-label="Вывод программы">{output}</pre>
          {terminalRequest && (
          <form
            className="code-console__prompt is-waiting"
            onSubmit={(event) => {
              event.preventDefault();
              submitTerminalInput();
            }}
          >
            <span aria-hidden="true">&gt;</span>
            <input
              ref={terminalInputRef}
              type="text"
              aria-label="Ввод в терминал"
              autoComplete="off"
              spellCheck={false}
              value={terminalInput}
              maxLength={MAX_SHARED_TERMINAL_INPUT_CHARS}
              disabled={readOnly}
              onChange={(event) => setTerminalInput(event.target.value)}
            />
            <button
              type="submit"
              aria-label="Отправить ввод"
              title="Отправить ввод"
              disabled={readOnly}
            ><CornerDownLeft size={15} /></button>
          </form>
          )}
        </div>
      </section>
    </div>
  );
}
