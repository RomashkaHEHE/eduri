import { useEffect, useRef, useState } from "react";
import type { CollaborationProfile } from "../../shared/collaborationProfile";
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
  readonly profile: CollaborationProfile;
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
  profile,
  onTerminal,
}: GuestCodeWorkspaceProps) {
  const [status, setStatus] = useState<GuestCodeStatus>(INITIAL_STATUS);
  const [session, setSession] = useState<CodeWorkspaceSessionHandle | null>(null);
  const onTerminalRef = useRef(onTerminal);
  const profileRef = useRef(profile);
  const providerRef = useRef<GuestCodeProvider | null>(null);
  onTerminalRef.current = onTerminal;
  profileRef.current = profile;

  useEffect(() => {
    let cancelled = false;
    const databaseName = guestCodeDatabaseName(resourceId);
    const provider = new GuestCodeProvider({
      shareId,
      resourceId,
      deviceId,
      profile: profileRef.current,
      databaseName,
      onTerminal: (kind) => onTerminalRef.current?.(kind),
    });
    providerRef.current = provider;
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
      if (providerRef.current === provider) providerRef.current = null;
      unsubscribe();
      setSession(null);
      void Promise.allSettled([
        provider.stop(),
        blobStore.close(),
      ]);
    };
  }, [deviceId, resourceId, shareId]);

  useEffect(() => {
    providerRef.current?.updateProfile(profile);
  }, [profile]);

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
  return (
    <div className="guest-code-workspace">
      <CodeWorkspace
        session={session}
        participantId={status.participant?.participantId ?? null}
        readOnly={collaborationReadOnly}
        terminalReadOnly={
          collaborationReadOnly || status.connection !== "online"
        }
        terminalConnectionEpoch={status.terminalConnectionEpoch}
        syncStatus={{
          connection: status.connection,
          durability: status.durability,
          pendingUpdates: status.pendingUpdates,
          error: status.error,
          readOnly: collaborationReadOnly,
        }}
      />
    </div>
  );
}
