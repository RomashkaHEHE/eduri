import { Cloud, CloudOff, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  CodeBlobStore,
  codeBlobStoreName,
} from "../code/codeBlobStore";
import { GuestCodeBlobHttpClient } from "../code/guestCodeBlobHttp";
import { GuestCodeBlobStore } from "../code/guestCodeBlobStore";
import {
  GuestCodeProvider,
  guestCodeDatabaseName,
  type GuestCodeStatus,
} from "../code/guestCodeProvider";
import {
  CodeWorkspace,
  type CodeWorkspaceSessionHandle,
} from "./CodeWorkspace";

export interface GuestCodeWorkspaceProps {
  readonly shareId: string;
  readonly resourceId: string;
  readonly deviceId: string;
  readonly onTerminal?: (kind: "expired" | "not-found") => void;
}

const INITIAL_STATUS: GuestCodeStatus = {
  connection: "loading-local",
  terminalConnectionEpoch: 0,
  durability: "ready",
  documentReady: false,
  pendingUpdates: 0,
  participant: null,
  error: null,
};

export function GuestCodeWorkspace({
  shareId,
  resourceId,
  deviceId,
  onTerminal,
}: GuestCodeWorkspaceProps) {
  const [status, setStatus] = useState<GuestCodeStatus>(INITIAL_STATUS);
  const [session, setSession] = useState<CodeWorkspaceSessionHandle | null>(null);
  const onTerminalRef = useRef(onTerminal);
  onTerminalRef.current = onTerminal;

  useEffect(() => {
    let cancelled = false;
    const databaseName = guestCodeDatabaseName(resourceId);
    const provider = new GuestCodeProvider({
      shareId,
      resourceId,
      deviceId,
      databaseName,
      onTerminal: (kind) => onTerminalRef.current?.(kind),
    });
    const blobStore = new GuestCodeBlobStore(
      new CodeBlobStore(codeBlobStoreName(databaseName)),
      new GuestCodeBlobHttpClient({ shareId }),
    );
    const handle: CodeWorkspaceSessionHandle = {
      document: provider.document,
      origin: provider.origin,
      blobStore,
      flush: () => provider.flush(),
      allowBinaryUploads: true,
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
      waitUntilSynchronized: (timeoutMs) => provider.waitUntilSynchronized(timeoutMs),
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
      void Promise.allSettled([
        provider.stop(),
        blobStore.close(),
      ]);
    };
  }, [deviceId, resourceId, shareId]);

  if (!session) {
    return (
      <div className="code-workspace-gate" role="status">
        {status.error && status.connection === "error"
          ? status.error
          : <span className="spinner" />}
      </div>
    );
  }

  const collaborationReadOnly = status.durability === "at-risk"
    || status.connection === "expired"
    || status.connection === "error";
  const statusTitle = status.durability === "at-risk"
    ? "Локальное сохранение недоступно"
    : status.connection === "online"
    ? status.pendingUpdates > 0 || status.durability === "writing"
      ? "Сохраняем изменения"
      : "Изменения синхронизированы"
    : status.connection === "syncing" || status.connection === "connecting"
      ? "Подключаемся"
      : "Офлайн: изменения сохраняются на этом устройстве";

  return (
    <div className="guest-code-workspace">
      <div
        className={`guest-code-workspace__status is-${status.connection}${
          status.durability === "at-risk" ? " is-at-risk" : ""
        }`}
        title={statusTitle}
        aria-label={statusTitle}
      >
        {status.connection === "online"
          ? <Cloud size={15} />
          : status.connection === "syncing" || status.connection === "connecting"
            ? <LoaderCircle className="spin" size={15} />
            : <CloudOff size={15} />}
        {status.pendingUpdates > 0 && <span>{status.pendingUpdates}</span>}
      </div>
      {status.error && (
        <div className="guest-code-workspace__error" role="alert">
          {status.error}
        </div>
      )}
      <CodeWorkspace
        session={session}
        participantId={status.participant?.participantId ?? null}
        readOnly={collaborationReadOnly}
        terminalReadOnly={
          collaborationReadOnly || status.connection !== "online"
        }
        terminalConnectionEpoch={status.terminalConnectionEpoch}
      />
    </div>
  );
}
