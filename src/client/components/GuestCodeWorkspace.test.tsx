// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface TestGuestCodeStatus {
  readonly connection:
    | "loading-local"
    | "offline"
    | "connecting"
    | "syncing"
    | "online"
    | "expired"
    | "error";
  readonly terminalConnectionEpoch: number;
  readonly durability: "ready" | "writing" | "at-risk";
  readonly documentReady: boolean;
  readonly pendingUpdates: number;
  readonly participant: {
    readonly participantId: string;
    readonly displayName: string;
    readonly color: string;
  } | null;
  readonly error: string | null;
}

const mocks = vi.hoisted(() => ({
  workspaceProps: vi.fn(),
  providerOptions: vi.fn(),
  providerStart: vi.fn(async () => undefined),
  providerStop: vi.fn(async () => undefined),
  providerFlush: vi.fn(async () => undefined),
  providerSetAwareness: vi.fn(),
  providerUpdateProfile: vi.fn(),
  providerDispatchTerminal: vi.fn(),
  codeBlobStoreName: vi.fn((databaseName: string) => `blobs:${databaseName}`),
  codeBlobStoreConstructor: vi.fn(),
  blobHttpConstructor: vi.fn(),
  guestBlobStoreConstructor: vi.fn(),
  guestBlobStoreClose: vi.fn(async () => undefined),
  statusListeners: new Set<(status: TestGuestCodeStatus) => void>(),
  awarenessListeners: new Set<(peers: readonly unknown[]) => void>(),
  terminalStateListeners: new Set<(state: unknown) => void>(),
  terminalEffectListeners: new Set<(effect: unknown) => void>(),
  terminalAckListeners: new Set<(ack: unknown) => void>(),
  document: { kind: "guest-document" },
  origin: { kind: "guest-origin" },
}));

const ONLINE_STATUS: TestGuestCodeStatus = {
  connection: "online",
  terminalConnectionEpoch: 3,
  durability: "ready",
  documentReady: true,
  pendingUpdates: 0,
  participant: {
    participantId: "guest-participant",
    displayName: "Guest user",
    color: "#336699",
  },
  error: null,
};

vi.mock("../code/codeBlobStore", () => ({
  codeBlobStoreName: (databaseName: string) => mocks.codeBlobStoreName(databaseName),
  CodeBlobStore: class {
    constructor(name: string) {
      mocks.codeBlobStoreConstructor(name);
    }
  },
}));

vi.mock("../code/guestCodeBlobHttp", () => ({
  GuestCodeBlobHttpClient: class {
    constructor(options: unknown) {
      mocks.blobHttpConstructor(options);
    }
  },
}));

vi.mock("../code/guestCodeBlobStore", () => ({
  GuestCodeBlobStore: class {
    constructor(localStore: unknown, uploader: unknown) {
      mocks.guestBlobStoreConstructor(localStore, uploader);
    }

    close = mocks.guestBlobStoreClose;
  },
}));

vi.mock("../code/guestCodeProvider", () => ({
  guestCodeDatabaseName: (resourceId: string) => `guest-db:${resourceId}`,
  GuestCodeProvider: class {
    readonly document = mocks.document;
    readonly origin = mocks.origin;

    constructor(options: unknown) {
      mocks.providerOptions(options);
    }

    start = mocks.providerStart;
    stop = mocks.providerStop;
    flush = mocks.providerFlush;
    setAwareness = mocks.providerSetAwareness;
    updateProfile = mocks.providerUpdateProfile;
    dispatchTerminal = mocks.providerDispatchTerminal;
    waitUntilSynchronized = vi.fn(async () => undefined);

    subscribeStatus(listener: (status: TestGuestCodeStatus) => void) {
      mocks.statusListeners.add(listener);
      listener(ONLINE_STATUS);
      return () => mocks.statusListeners.delete(listener);
    }

    subscribeAwareness(listener: (peers: readonly unknown[]) => void) {
      mocks.awarenessListeners.add(listener);
      return () => mocks.awarenessListeners.delete(listener);
    }

    subscribeTerminalState(listener: (state: unknown) => void) {
      mocks.terminalStateListeners.add(listener);
      return () => mocks.terminalStateListeners.delete(listener);
    }

    subscribeTerminalEffects(listener: (effect: unknown) => void) {
      mocks.terminalEffectListeners.add(listener);
      return () => mocks.terminalEffectListeners.delete(listener);
    }

    subscribeTerminalAcks(listener: (ack: unknown) => void) {
      mocks.terminalAckListeners.add(listener);
      return () => mocks.terminalAckListeners.delete(listener);
    }
  },
}));

vi.mock("./CodeWorkspace", () => ({
  CodeWorkspace: (props: Record<string, unknown>) => {
    mocks.workspaceProps(props);
    return createElement("div", { "data-testid": "code-workspace" });
  },
}));

import { GuestCodeWorkspace } from "./GuestCodeWorkspace";

let container: HTMLDivElement;
let root: Root;

function emitStatus(status: TestGuestCodeStatus): void {
  for (const listener of mocks.statusListeners) listener(status);
}

function lastWorkspaceProps(): Record<string, unknown> {
  const props = mocks.workspaceProps.mock.lastCall?.[0];
  if (!props) throw new Error("CodeWorkspace was not rendered");
  return props as Record<string, unknown>;
}

async function renderWorkspace(): Promise<void> {
  await act(async () => {
    root.render(createElement(GuestCodeWorkspace, {
      shareId: "share-01",
      resourceId: "resource-01",
      deviceId: "device-01",
      profile: { displayName: "Guest user", color: "#2563eb" },
    }));
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.statusListeners.clear();
  mocks.awarenessListeners.clear();
  mocks.terminalStateListeners.clear();
  mocks.terminalEffectListeners.clear();
  mocks.terminalAckListeners.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("GuestCodeWorkspace adapter", () => {
  it("passes the online synchronization status into CodeWorkspace", async () => {
    await renderWorkspace();

    expect(mocks.providerOptions).toHaveBeenCalledWith({
      shareId: "share-01",
      resourceId: "resource-01",
      deviceId: "device-01",
      profile: { displayName: "Guest user", color: "#2563eb" },
      databaseName: "guest-db:resource-01",
      onTerminal: expect.any(Function),
    });
    expect(mocks.codeBlobStoreConstructor).toHaveBeenCalledWith(
      "blobs:guest-db:resource-01",
    );
    expect(mocks.blobHttpConstructor).toHaveBeenCalledWith({
      shareId: "share-01",
    });
    expect(mocks.guestBlobStoreConstructor).toHaveBeenCalledOnce();
    expect(mocks.providerStart).toHaveBeenCalledOnce();
    expect(lastWorkspaceProps()).toEqual(expect.objectContaining({
      participantId: "guest-participant",
      readOnly: false,
      terminalReadOnly: false,
      terminalConnectionEpoch: 3,
      syncStatus: {
        connection: "online",
        durability: "ready",
        pendingUpdates: 0,
        error: null,
        readOnly: false,
      },
    }));
    expect(container.querySelector(".guest-code-workspace__status")).toBeNull();
    expect(container.querySelector(".guest-code-workspace__error")).toBeNull();
    expect(container.querySelector(".code-sync-status")).toBeNull();
  });

  it("keeps local editing writable while offline updates wait for an ACK", async () => {
    await renderWorkspace();

    await act(async () => emitStatus({
      ...ONLINE_STATUS,
      connection: "offline",
      terminalConnectionEpoch: 4,
      pendingUpdates: 7,
    }));

    expect(lastWorkspaceProps()).toEqual(expect.objectContaining({
      readOnly: false,
      terminalReadOnly: true,
      terminalConnectionEpoch: 4,
      syncStatus: {
        connection: "offline",
        durability: "ready",
        pendingUpdates: 7,
        error: null,
        readOnly: false,
      },
    }));
  });

  it("makes the workspace read-only when synchronization is at risk", async () => {
    await renderWorkspace();
    const exactError = "IndexedDB write failed: quota exceeded";

    await act(async () => emitStatus({
      ...ONLINE_STATUS,
      connection: "error",
      terminalConnectionEpoch: 5,
      durability: "at-risk",
      pendingUpdates: 2,
      error: exactError,
    }));

    expect(lastWorkspaceProps()).toEqual(expect.objectContaining({
      readOnly: true,
      terminalReadOnly: true,
      terminalConnectionEpoch: 5,
      syncStatus: {
        connection: "error",
        durability: "at-risk",
        pendingUpdates: 2,
        error: exactError,
        readOnly: true,
      },
    }));
    expect(container.querySelector(".guest-code-workspace__error")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
