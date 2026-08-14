// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workspaceProps = vi.fn();
const providerStop = vi.fn(async () => undefined);
const providerStart = vi.fn(async () => undefined);
const providerFlush = vi.fn(async () => undefined);
const setAwareness = vi.fn();
const updateProfile = vi.fn();
const dispatchTerminal = vi.fn();
const statusListeners = new Set<(status: Record<string, unknown>) => void>();
const awarenessListeners = new Set<(peers: readonly unknown[]) => void>();
const terminalStateListeners = new Set<(state: unknown) => void>();
const terminalEffectListeners = new Set<(effect: unknown) => void>();
const terminalAckListeners = new Set<(ack: unknown) => void>();
const providerOptions = vi.fn();

vi.mock("../code/lessonCodeProvider", () => ({
  lessonCodeDatabaseName: (userId: string, lessonId: string) =>
    `lesson-db:${userId}:${lessonId}`,
  LessonCodeProvider: class {
    readonly document = new Y.Doc();
    readonly origin = { kind: "lesson-origin" };
    constructor(options: unknown) {
      providerOptions(options);
    }
    start = providerStart;
    stop = providerStop;
    flush = providerFlush;
    setAwareness = setAwareness;
    updateProfile = updateProfile;
    waitUntilSynchronized = vi.fn(async () => undefined);
    dispatchTerminal = dispatchTerminal;
    subscribeStatus(listener: (status: Record<string, unknown>) => void) {
      statusListeners.add(listener);
      listener({
        connection: "online",
        durability: "ready",
        documentReady: true,
        pendingUpdates: 0,
        participant: {
          participantId: "lesson-participant",
          displayName: "Lesson user",
          color: "#336699",
        },
        error: null,
      });
      return () => statusListeners.delete(listener);
    }
    subscribeAwareness(listener: (peers: readonly unknown[]) => void) {
      awarenessListeners.add(listener);
      return () => awarenessListeners.delete(listener);
    }
    subscribeTerminalState(listener: (state: unknown) => void) {
      terminalStateListeners.add(listener);
      return () => terminalStateListeners.delete(listener);
    }
    subscribeTerminalEffects(listener: (effect: unknown) => void) {
      terminalEffectListeners.add(listener);
      return () => terminalEffectListeners.delete(listener);
    }
    subscribeTerminalAcks(listener: (ack: unknown) => void) {
      terminalAckListeners.add(listener);
      return () => terminalAckListeners.delete(listener);
    }
  },
}));

vi.mock("../guestIdentity", () => ({
  guestDeviceId: () => "lesson-device-01",
}));

vi.mock("./CodeWorkspace", () => ({
  CodeWorkspace: (props: Record<string, unknown>) => {
    workspaceProps(props);
    return createElement("div", { "data-testid": "shared-code-workspace" });
  },
}));

import { LessonCodeWorkspace } from "./LessonCodeWorkspace";

const LESSON_ID = "00000000-0000-4000-8000-000000000601";
const USER_ID = "00000000-0000-4000-8000-000000000602";
const PROFILE = { displayName: "Lesson user", color: "#2563eb" as const };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  workspaceProps.mockReset();
  providerOptions.mockReset();
  providerStart.mockClear();
  providerStop.mockClear();
  providerFlush.mockClear();
  setAwareness.mockClear();
  updateProfile.mockClear();
  dispatchTerminal.mockClear();
  statusListeners.clear();
  awarenessListeners.clear();
  terminalStateListeners.clear();
  terminalEffectListeners.clear();
  terminalAckListeners.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("LessonCodeWorkspace adapter", () => {
  it("mounts the shared CRDT workspace with the authenticated lesson identity", async () => {
    await act(async () => {
      root.render(createElement(LessonCodeWorkspace, {
        lessonId: LESSON_ID,
        userId: USER_ID,
        profile: PROFILE,
      }));
    });

    expect(providerOptions).toHaveBeenCalledWith({
      lessonId: LESSON_ID,
      userId: USER_ID,
      deviceId: "lesson-device-01",
      profile: PROFILE,
      databaseName: `lesson-db:${USER_ID}:${LESSON_ID}`,
    });
    expect(providerStart).toHaveBeenCalledOnce();
    expect(workspaceProps).toHaveBeenLastCalledWith(expect.objectContaining({
      participantId: "lesson-participant",
      readOnly: false,
      terminalReadOnly: false,
      session: expect.objectContaining({
        allowBinaryUploads: false,
        awareness: expect.any(Object),
        terminal: expect.any(Object),
        waitUntilSynchronized: expect.any(Function),
      }),
    }));
    expect(workspaceProps).toHaveBeenLastCalledWith(expect.objectContaining({
      syncStatus: {
        connection: "online",
        durability: "ready",
        pendingUpdates: 0,
        error: null,
        readOnly: false,
      },
    }));
  });

  it("keeps local-first editing enabled while the shared terminal is offline", async () => {
    await act(async () => {
      root.render(createElement(LessonCodeWorkspace, {
        lessonId: LESSON_ID,
        userId: USER_ID,
        profile: PROFILE,
      }));
    });

    await act(async () => {
      for (const listener of statusListeners) listener({
        connection: "offline",
        durability: "ready",
        documentReady: true,
        pendingUpdates: 1,
        participant: {
          participantId: "lesson-participant",
          displayName: "Lesson user",
          color: "#336699",
        },
        error: null,
      });
    });

    expect(workspaceProps).toHaveBeenLastCalledWith(expect.objectContaining({
      participantId: "lesson-participant",
      readOnly: false,
      terminalReadOnly: true,
      syncStatus: expect.objectContaining({
        connection: "offline",
        pendingUpdates: 1,
        readOnly: false,
      }),
    }));
  });

  it("makes the editor read-only when local persistence is at risk", async () => {
    await act(async () => {
      root.render(createElement(LessonCodeWorkspace, {
        lessonId: LESSON_ID,
        userId: USER_ID,
        profile: PROFILE,
      }));
    });

    await act(async () => {
      for (const listener of statusListeners) listener({
        connection: "online",
        durability: "at-risk",
        documentReady: true,
        pendingUpdates: 2,
        participant: {
          participantId: "lesson-participant",
          displayName: "Lesson user",
          color: "#336699",
        },
        error: "IndexedDB недоступен",
      });
    });

    expect(workspaceProps).toHaveBeenLastCalledWith(expect.objectContaining({
      readOnly: true,
      terminalReadOnly: true,
      syncStatus: expect.objectContaining({
        durability: "at-risk",
        pendingUpdates: 2,
        error: "IndexedDB недоступен",
        readOnly: true,
      }),
    }));
  });

  it("passes read-only state without replacing the collaborative session", async () => {
    await act(async () => {
      root.render(createElement(LessonCodeWorkspace, {
        lessonId: LESSON_ID,
        userId: USER_ID,
        profile: PROFILE,
        readOnly: false,
      }));
    });
    const firstSession = workspaceProps.mock.lastCall?.[0].session;
    await act(async () => {
      root.render(createElement(LessonCodeWorkspace, {
        lessonId: LESSON_ID,
        userId: USER_ID,
        profile: PROFILE,
        readOnly: true,
      }));
    });
    expect(workspaceProps).toHaveBeenLastCalledWith(expect.objectContaining({
      readOnly: true,
      session: firstSession,
    }));
    expect(providerOptions).toHaveBeenCalledOnce();
  });

  it("stops sync on unmount", async () => {
    await act(async () => {
      root.render(createElement(LessonCodeWorkspace, {
        lessonId: LESSON_ID,
        userId: USER_ID,
        profile: PROFILE,
      }));
    });
    await act(async () => root.unmount());
    expect(providerStop).toHaveBeenCalledOnce();
    root = createRoot(container);
  });
});
