import Editor, { type OnMount } from "@monaco-editor/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type * as Y from "yjs";
import {
  CODE_SYNC_LIMITS,
  type CodeAwarenessState,
  type CodeYTextAwarenessTarget,
} from "../../code/protocol";
import {
  attachMonacoYTextBinding,
  type MonacoYTextBinding,
} from "../code/monacoYTextBinding";
import {
  createMonacoRemotePresenceRenderer,
  encodeMonacoYTextSelections,
  type MonacoRemotePresenceRenderer,
} from "../code/monacoRemotePresence";
import type { GuestCodePeerAwareness } from "../code/guestCodeProvider";
import type { NativeInputPresencePublisher } from "../code/nativeInputPresence";

type MonacoEditor = Parameters<OnMount>[0];

interface Disposable {
  dispose(): void;
}

export interface CollaborativeMonacoTextFieldProps {
  readonly yText: Y.Text;
  readonly transactionOrigin: unknown;
  readonly target: CodeYTextAwarenessTarget;
  readonly publishAwareness?: NativeInputPresencePublisher;
  readonly peers: readonly GuestCodePeerAwareness[];
  readonly modelPath: string;
  readonly ariaLabel: string;
  readonly theme: "vs" | "vs-dark";
  readonly readOnly: boolean;
  readonly language?: string;
  readonly className?: string;
}

function sameTarget(
  left: CodeAwarenessState["target"],
  right: CodeYTextAwarenessTarget,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "file" && right.kind === "file") {
    return left.entryId === right.entryId && left.field === right.field;
  }
  if (left.kind === "test" && right.kind === "test") {
    return left.testId === right.testId && left.field === right.field;
  }
  return false;
}

/**
 * A compact Monaco surface for collaborative auxiliary text fields. It stays
 * uncontrolled from React: Y.Text deltas are patched directly into the model,
 * so remote typing cannot replace the complete value or steal focus.
 */
export function CollaborativeMonacoTextField({
  yText,
  transactionOrigin,
  target,
  publishAwareness,
  peers,
  modelPath,
  ariaLabel,
  theme,
  readOnly,
  language = "plaintext",
  className,
}: CollaborativeMonacoTextFieldProps) {
  const editorRef = useRef<MonacoEditor | null>(null);
  const bindingRef = useRef<MonacoYTextBinding | null>(null);
  const rendererRef = useRef<MonacoRemotePresenceRenderer | null>(null);
  const subscriptionsRef = useRef<Disposable[]>([]);
  const awarenessOwnerRef = useRef(Symbol("eduri-monaco-field-presence"));
  const awarenessRef = useRef(publishAwareness);
  const targetRef = useRef(target);
  const readOnlyRef = useRef(readOnly);
  awarenessRef.current = publishAwareness;
  targetRef.current = target;
  readOnlyRef.current = readOnly;
  const editorOptions = useMemo(() => ({
    readOnly,
    automaticLayout: true,
    minimap: { enabled: false },
    lineNumbers: "off" as const,
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: 0,
    lineNumbersMinChars: 0,
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    renderLineHighlight: "none" as const,
    scrollBeyondLastLine: false,
    scrollbar: {
      verticalScrollbarSize: 7,
      horizontalScrollbarSize: 7,
    },
    wordWrap: "on" as const,
    multiCursorLimit: CODE_SYNC_LIMITS.maxYTextSelections,
    fontSize: 13,
    lineHeight: 19,
    padding: { top: 4, bottom: 4 },
    ariaLabel,
  }), [ariaLabel, readOnly]);

  const clearEditor = useCallback(() => {
    for (const subscription of subscriptionsRef.current) subscription.dispose();
    subscriptionsRef.current = [];
    rendererRef.current?.destroy();
    rendererRef.current = null;
    bindingRef.current?.destroy();
    bindingRef.current = null;
    editorRef.current = null;
  }, []);

  const publishSelection = useCallback(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const publish = awarenessRef.current;
    if (!editor || !model || !publish || !editor.hasTextFocus()) return;
    const selections = encodeMonacoYTextSelections(yText, model, editor);
    if (!selections) return;
    publish(awarenessOwnerRef.current, { target: targetRef.current, selections });
  }, [yText]);

  const handleMount = useCallback<OnMount>((editor) => {
    clearEditor();
    const model = editor.getModel();
    if (!model) return;
    editorRef.current = editor;
    bindingRef.current = attachMonacoYTextBinding({
      yText,
      model,
      editor,
      transactionOrigin,
    });
    rendererRef.current = createMonacoRemotePresenceRenderer({
      yText,
      model,
      editor,
    });
    subscriptionsRef.current = [
      editor.onDidChangeCursorSelection(publishSelection),
      editor.onDidFocusEditorText(publishSelection),
      editor.onDidBlurEditorText(() => {
        awarenessRef.current?.(awarenessOwnerRef.current, null);
      }),
    ];
    if (editor.hasTextFocus()) publishSelection();
  }, [clearEditor, publishSelection, transactionOrigin, yText]);

  useLayoutEffect(() => {
    rendererRef.current?.setPeers(peers
      .filter((peer) => (
        sameTarget(peer.state.target, target)
        && peer.state.selections !== undefined
      ))
      .map((peer) => ({
        participantId: peer.participant.participantId,
        displayName: peer.participant.displayName,
        color: peer.participant.color,
        selections: peer.state.selections,
      })));
  }, [peers, target]);

  useEffect(() => () => {
    awarenessRef.current?.(awarenessOwnerRef.current, null);
    clearEditor();
  }, [clearEditor]);

  return (
    <div className={className ?? "code-collaborative-field"}>
      <Editor
        path={modelPath}
        defaultValue={yText.toString()}
        language={language}
        theme={theme}
        onMount={handleMount}
        options={editorOptions}
      />
    </div>
  );
}
