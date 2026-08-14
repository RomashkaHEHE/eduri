// @vitest-environment node

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  CODE_SYNC_CAPABILITIES,
  CODE_SYNC_MESSAGE_EVENT,
  CODE_SYNC_PROTOCOL_VERSION,
  CODE_SYNC_TAGS,
  CODE_SYNC_UPDATE_ENCODING,
} from "../../code/protocol/index.js";
import {
  SHARED_TERMINAL_ACK_EVENT,
  SHARED_TERMINAL_ACTION_EVENT,
  SHARED_TERMINAL_DELTA_EVENT,
  SHARED_TERMINAL_EFFECT_EVENT,
  SHARED_TERMINAL_PROTOCOL_VERSION,
  SHARED_TERMINAL_STATE_EVENT,
} from "../../code/terminal/index.js";
import {
  codeWorkspaceText,
  initializeCodeWorkspace,
} from "../../code/core/index.js";
import {
  LessonCodeProvider,
  lessonCodeDatabaseName,
  type LessonCodeSocket,
} from "./lessonCodeProvider.js";

class FakeSocket implements LessonCodeSocket {
  connected = false;
  auth?: LessonCodeSocket["auth"];
  connectCalls = 0;
  disconnectCalls = 0;
  readonly sent: Array<{ event: string; args: unknown[] }> = [];
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: any[]): this {
    this.sent.push({ event, args });
    return this;
  }

  connect(): this {
    this.connectCalls += 1;
    this.connected = true;
    this.serverEmit("connect");
    return this;
  }

  disconnect(): this {
    this.disconnectCalls += 1;
    const connected = this.connected;
    this.connected = false;
    if (connected) this.serverEmit("disconnect");
    return this;
  }

  serverEmit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  messages(type?: string): Record<string, unknown>[] {
    return this.sent
      .filter((entry) => entry.event === CODE_SYNC_MESSAGE_EVENT)
      .map((entry) => entry.args[0] as Record<string, unknown>)
      .filter((message) => type === undefined || message.type === type);
  }

  events(event: string): unknown[][] {
    return this.sent.filter((entry) => entry.event === event)
      .map((entry) => entry.args);
  }
}

const LESSON_ID = "00000000-0000-4000-8000-000000000701";
const USER_ID = "00000000-0000-4000-8000-000000000702";
const participant = {
  participantId: "lesson-participant-1",
  displayName: "Tutor",
  color: "#336699",
};

function ready(
  socket: FakeSocket,
  capabilities?: readonly string[],
): void {
  socket.serverEmit(CODE_SYNC_MESSAGE_EVENT, {
    type: CODE_SYNC_TAGS.ready,
    protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
    workspaceId: "workspace-1",
    documentId: "document-1",
    deviceId: "device-1",
    participant,
    updateEncoding: CODE_SYNC_UPDATE_ENCODING,
    ...(capabilities === undefined ? {} : { capabilities }),
  });
}

function multiSelectionAwareness() {
  const document = new Y.Doc();
  const text = document.getText("selection-source");
  text.insert(0, "abcdef");
  const position = (index: number) => Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(text, index),
  );
  const state = {
    target: { kind: "file", entryId: "main-py", field: "text" },
    selections: [
      { anchor: position(1), head: position(3) },
      { anchor: position(5), head: position(2) },
    ],
  } as const;
  document.destroy();
  return state;
}

function initialUpdates(): Uint8Array[] {
  const document = new Y.Doc();
  const updates: Uint8Array[] = [];
  document.on("update", (update) => updates.push(update.slice()));
  initializeCodeWorkspace(document, "server");
  document.destroy();
  return updates;
}

function respondToSync(socket: FakeSocket, updates: readonly Uint8Array[]): void {
  const request = socket.messages(CODE_SYNC_TAGS.syncStep1).at(-1);
  expect(request).toBeDefined();
  updates.forEach((update, part) => socket.serverEmit(CODE_SYNC_MESSAGE_EVENT, {
    type: CODE_SYNC_TAGS.syncStep2,
    protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
    requestId: request?.requestId,
    updateEncoding: CODE_SYNC_UPDATE_ENCODING,
    update,
    stateVector: Uint8Array.of(0),
    sequence: 0,
    part,
    done: part === updates.length - 1,
  }));
}

async function eventually(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw failure;
}

function harness(databaseName: string) {
  const socket = new FakeSocket();
  let nextId = 0;
  const provider = new LessonCodeProvider({
    lessonId: LESSON_ID,
    userId: USER_ID,
    deviceId: "device-1",
    databaseName,
    socketFactory: () => socket,
    createId: () => `id-${++nextId}`,
    ackTimeoutMs: 20,
    awarenessThrottleMs: 1,
  });
  return { provider, socket };
}

describe("LessonCodeProvider", () => {
  it("updates the live profile without reconnecting or replacing collaboration", async () => {
    const { provider, socket } = harness(
      `lesson-code-profile-${crypto.randomUUID()}`,
    );
    const document = provider.document;
    try {
      await provider.start();
      ready(socket);
      const terminalEpoch = provider.getStatus().terminalConnectionEpoch;
      provider.updateProfile({ displayName: "Tutor", color: "#16825d" });

      expect(socket.auth).toEqual({
        lessonId: LESSON_ID,
        deviceId: "device-1",
        profile: { displayName: "Tutor", color: "#16825d" },
      });
      expect(socket.messages(CODE_SYNC_TAGS.profileUpdate).at(-1)).toEqual({
        type: CODE_SYNC_TAGS.profileUpdate,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        profile: { displayName: "Tutor", color: "#16825d" },
      });
      expect(socket.connectCalls).toBe(1);
      expect(socket.disconnectCalls).toBe(0);
      expect(provider.document).toBe(document);
      expect(provider.getStatus().terminalConnectionEpoch).toBe(terminalEpoch);

      socket.serverEmit(CODE_SYNC_MESSAGE_EVENT, {
        type: CODE_SYNC_TAGS.profileUpdated,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        participant: {
          participantId: participant.participantId,
          displayName: "Tutor",
          color: "#16825d",
        },
      });
      expect(provider.getStatus().participant).toEqual({
        participantId: participant.participantId,
        displayName: "Tutor",
        color: "#16825d",
      });

      const updateCount = socket.messages(CODE_SYNC_TAGS.profileUpdate).length;
      provider.updateProfile({ displayName: "Tutor", color: "#16825d" });
      expect(socket.messages(CODE_SYNC_TAGS.profileUpdate)).toHaveLength(updateCount);
      expect(socket.connectCalls).toBe(1);
      expect(socket.disconnectCalls).toBe(0);
    } finally {
      await provider.stop();
    }
  });

  it("scopes local storage by account and lesson", () => {
    expect(lessonCodeDatabaseName(USER_ID, LESSON_ID))
      .toBe(`eduri-code-lesson-v1:${USER_ID}:${LESSON_ID}`);
    expect(() => lessonCodeDatabaseName("bad", LESSON_ID)).toThrow();
  });

  it("advertises multi-selection capability first and sends plural awareness to a capable server", async () => {
    const { provider, socket } = harness(
      `lesson-code-capable-awareness-${crypto.randomUUID()}`,
    );
    try {
      await provider.start();
      const awareness = multiSelectionAwareness();
      provider.setAwareness(awareness);
      const messageCount = socket.messages().length;

      ready(socket, [CODE_SYNC_CAPABILITIES.multiSelectionAwareness]);

      const messages = socket.messages().slice(messageCount);
      expect(messages.map((message) => message.type)).toEqual([
        CODE_SYNC_TAGS.capabilities,
        CODE_SYNC_TAGS.syncStep1,
        CODE_SYNC_TAGS.awareness,
      ]);
      expect(messages[0]).toEqual({
        type: CODE_SYNC_TAGS.capabilities,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        capabilities: [CODE_SYNC_CAPABILITIES.multiSelectionAwareness],
      });
      expect(messages[2]?.state).toEqual(awareness);
      expect(messages[2]?.state).not.toHaveProperty("selection");
    } finally {
      await provider.clearLocalData();
    }
  });

  it("omits capabilities and sends only the primary legacy selection to an old server", async () => {
    const { provider, socket } = harness(
      `lesson-code-legacy-awareness-${crypto.randomUUID()}`,
    );
    try {
      await provider.start();
      const awareness = multiSelectionAwareness();
      provider.setAwareness(awareness);
      const messageCount = socket.messages().length;

      ready(socket);

      const messages = socket.messages().slice(messageCount);
      expect(messages.map((message) => message.type)).toEqual([
        CODE_SYNC_TAGS.syncStep1,
        CODE_SYNC_TAGS.awareness,
      ]);
      expect(socket.messages(CODE_SYNC_TAGS.capabilities)).toHaveLength(0);
      expect(messages[1]?.state).toEqual({
        target: awareness.target,
        selection: awareness.selections[0],
      });
      expect(messages[1]?.state).not.toHaveProperty("selections");
    } finally {
      await provider.clearLocalData();
    }
  });

  it("durably replays an offline edit with its stable update ID after reload", async () => {
    const databaseName = `lesson-code-reload-${crypto.randomUUID()}`;
    const first = harness(databaseName);
    await first.provider.start();
    ready(first.socket);
    respondToSync(first.socket, initialUpdates());
    await eventually(() => expect(first.provider.getStatus().connection).toBe("online"));
    codeWorkspaceText(first.provider.document, "main-py")?.insert(0, "# offline\n");
    await eventually(() => {
      expect(first.socket.messages(CODE_SYNC_TAGS.update)).toHaveLength(1);
    });
    const updateId = first.socket.messages(CODE_SYNC_TAGS.update)[0]?.updateId;
    await first.provider.stop();

    const second = harness(databaseName);
    try {
      await second.provider.start();
      expect(codeWorkspaceText(second.provider.document, "main-py")?.toString())
        .toContain("# offline");
      ready(second.socket);
      respondToSync(second.socket, [Uint8Array.of(0, 0)]);
      await eventually(() => {
        expect(second.socket.messages(CODE_SYNC_TAGS.update)).toHaveLength(1);
      });
      const replay = second.socket.messages(CODE_SYNC_TAGS.update)[0]!;
      expect(replay.updateId).toBe(updateId);
      second.socket.serverEmit(CODE_SYNC_MESSAGE_EVENT, {
        type: CODE_SYNC_TAGS.updateAck,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        requestId: replay.requestId,
        updateId: replay.updateId,
        status: "duplicate",
        sequence: 1,
      });
      await second.provider.waitUntilSynchronized();
      expect(second.provider.getStatus().pendingUpdates).toBe(0);
    } finally {
      await second.provider.clearLocalData();
    }
  });

  it("preserves rejected read-only outbox data and forwards terminal state/effects", async () => {
    const { provider, socket } = harness(
      `lesson-code-readonly-${crypto.randomUUID()}`,
    );
    try {
      await provider.start();
      ready(socket);
      respondToSync(socket, initialUpdates());
      await eventually(() => expect(provider.getStatus().connection).toBe("online"));

      const states: unknown[] = [];
      const effects: unknown[] = [];
      const acks: unknown[] = [];
      provider.subscribeTerminalState((value) => states.push(value));
      provider.subscribeTerminalEffects((value) => effects.push(value));
      provider.subscribeTerminalAcks((value) => acks.push(value));
      provider.dispatchTerminal({ type: "sync", actionId: "terminal-sync" });
      expect(socket.events(SHARED_TERMINAL_ACTION_EVENT).at(-1)?.[0])
        .toMatchObject({ protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION });

      const state = {
        protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
        generation: 1,
        seq: 1,
        mode: "shell",
        prompt: "$ ",
        transcript: "ready\n",
        input: { value: "", cursor: 0, owner: null },
        host: null,
        activeRun: null,
        inputRequestId: null,
        lastTest: null,
      } as const;
      socket.serverEmit(SHARED_TERMINAL_STATE_EVENT, state);
      socket.serverEmit(SHARED_TERMINAL_DELTA_EVENT, {
        protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
        generation: 1,
        baseSeq: 1,
        seq: 2,
        operations: [{ type: "transcript-append", trimStart: 0, value: "ok\n" }],
      });
      socket.serverEmit(SHARED_TERMINAL_ACK_EVENT, {
        protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
        actionId: "terminal-sync",
        generation: 1,
        seq: 2,
        status: "applied",
        error: null,
      });
      socket.serverEmit(SHARED_TERMINAL_EFFECT_EVENT, {
        protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
        type: "start-run",
        runId: "run-1",
        entryId: "main-py",
        entrypoint: "main.py",
        testId: null,
      });
      expect(states.at(-1)).toMatchObject({ seq: 2, transcript: "ready\nok\n" });
      expect(acks).toHaveLength(1);
      expect(effects).toHaveLength(1);

      codeWorkspaceText(provider.document, "main-py")?.insert(0, "# rejected\n");
      await eventually(() => {
        expect(socket.messages(CODE_SYNC_TAGS.update)).toHaveLength(1);
      });
      const update = socket.messages(CODE_SYNC_TAGS.update)[0]!;
      socket.serverEmit(CODE_SYNC_MESSAGE_EVENT, {
        type: CODE_SYNC_TAGS.control,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        code: "invalid-update",
        message: "Lesson Code workspace is read-only",
        terminal: false,
        requestId: update.requestId,
      });
      expect(provider.getStatus()).toMatchObject({
        durability: "at-risk",
        pendingUpdates: 1,
        error: "Lesson Code workspace is read-only",
      });
    } finally {
      await provider.clearLocalData();
    }
  });
});
