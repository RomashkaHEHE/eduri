import { Cloud, CloudOff, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  LessonCodeProvider,
  lessonCodeDatabaseName,
  type LessonCodeStatus,
} from "../code/lessonCodeProvider";
import { guestDeviceId } from "../guestIdentity";
import {
  CodeWorkspace,
  type CodeWorkspaceSessionHandle,
} from "./CodeWorkspace";
import "./CodeWorkspace.css";

interface LessonCodeWorkspaceProps {
  readonly lessonId: string;
  readonly userId: string;
  readonly readOnly?: boolean;
}

const INITIAL_STATUS: LessonCodeStatus = {
  connection: "loading-local",
  terminalConnectionEpoch: 0,
  durability: "ready",
  documentReady: false,
  pendingUpdates: 0,
  participant: null,
  error: null,
};

const TEXT_ONLY_BLOB_STORE = {
  async put(): Promise<never> {
    throw new Error("Binary files are not enabled in lesson Code workspaces");
  },
  async get(): Promise<null> {
    return null;
  },
};

export function LessonCodeWorkspace({
  lessonId,
  userId,
  readOnly = false,
}: LessonCodeWorkspaceProps) {
  const deviceId = useMemo(guestDeviceId, []);
  const [status, setStatus] = useState<LessonCodeStatus>(INITIAL_STATUS);
  const [session, setSession] = useState<CodeWorkspaceSessionHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    const databaseName = lessonCodeDatabaseName(userId, lessonId);
    const provider = new LessonCodeProvider({
      lessonId,
      userId,
      deviceId,
      databaseName,
    });
    const handle: CodeWorkspaceSessionHandle = {
      document: provider.document,
      origin: provider.origin,
      blobStore: TEXT_ONLY_BLOB_STORE,
      flush: () => provider.flush(),
      allowBinaryUploads: false,
      awareness: {
        setAwareness: (state) => provider.setAwareness(state),
        subscribeAwareness: (listener) => provider.subscribeAwareness(listener),
      },
      terminal: {
        dispatch: (action) => provider.dispatchTerminal(action),
        subscribeState: (listener) => provider.subscribeTerminalState(listener),
        subscribeEffects: (listener) => provider.subscribeTerminalEffects(listener),
        subscribeAcks: (listener) => provider.subscribeTerminalAcks(listener),
      },
      waitUntilSynchronized: (timeoutMs) => (
        provider.waitUntilSynchronized(timeoutMs)
      ),
    };
    const unsubscribe = provider.subscribeStatus((next) => {
      if (cancelled) return;
      setStatus(next);
      if (next.documentReady) setSession((current) => current ?? handle);
    });
    void provider.start().catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
      setSession(null);
      void provider.stop();
    };
  }, [deviceId, lessonId, userId]);

  if (!session) {
    return (
      <div className="code-workspace-gate" role="status">
        {status.error && status.connection === "error"
          ? status.error
          : <><LoaderCircle className="spin" size={18} /> Загружаем код урока…</>}
      </div>
    );
  }

  const online = status.connection === "online";
  return (
    <div className="lesson-code-workspace full-code-workspace">
      <div className={`code-sync-status code-sync-status--${status.connection}`}>
        {online ? <Cloud size={15} /> : <CloudOff size={15} />}
        <span>
          {online
            ? status.pendingUpdates > 0
              ? `Синхронизация: ${status.pendingUpdates}`
              : "Код синхронизирован"
            : status.connection === "offline"
              ? "Офлайн — правки сохраняются на устройстве"
              : "Подключаем совместный редактор…"}
        </span>
        {status.error && <span className="code-sync-status__error">{status.error}</span>}
      </div>
      <CodeWorkspace
        session={session}
        participantId={status.participant?.participantId ?? null}
        readOnly={readOnly}
        terminalReadOnly={readOnly || status.connection !== "online"}
        terminalConnectionEpoch={status.terminalConnectionEpoch}
      />
    </div>
  );
}
