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
  GuestCodeProvider,
  type CodeSyncSocket,
  type GuestCodePeerAwareness,
} from "./guestCodeProvider.js";

class FakeSocket implements CodeSyncSocket {
  connected = false;
  auth?: CodeSyncSocket["auth"];
  connectCalls = 0;
  disconnectCalls = 0;
  readonly sent: Array<{ event: string; args: unknown[] }> = [];
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): this {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
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
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) this.serverEmit("disconnect", "io client disconnect");
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
    return this.sent
      .filter((entry) => entry.event === event)
      .map((entry) => entry.args);
  }
}

const participant = {
  participantId: "guest-participant-1",
  displayName: "Гость 1",
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

function syncParts(): Uint8Array[] {
  const document = new Y.Doc();
  const updates: Uint8Array[] = [];
  document.on("update", (update) => updates.push(update.slice()));
  initializeCodeWorkspace(document, "server");
  document.destroy();
  return updates;
}

function respondToSync(
  socket: FakeSocket,
  updates: readonly Uint8Array[],
): void {
  const request = socket.messages(CODE_SYNC_TAGS.syncStep1).at(-1);
  expect(request).toBeDefined();
  updates.forEach((update, part) => {
    socket.serverEmit(CODE_SYNC_MESSAGE_EVENT, {
      type: CODE_SYNC_TAGS.syncStep2,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      requestId: request?.requestId,
      updateEncoding: CODE_SYNC_UPDATE_ENCODING,
      update,
      stateVector: Uint8Array.of(0),
      sequence: 0,
      part,
      done: part === updates.length - 1,
    });
  });
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

function createHarness(databaseName: string): {
  provider: GuestCodeProvider;
  socket: FakeSocket;
} {
  const socket = new FakeSocket();
  let nextId = 0;
  const provider = new GuestCodeProvider({
    shareId: "a".repeat(43),
    resourceId: "resource-1",
    deviceId: "device-1",
    databaseName,
    socketFactory: () => socket,
    createId: () => `id-${++nextId}`,
    ackTimeoutMs: 20,
    awarenessThrottleMs: 1,
  });
  return { provider, socket };
}

describe("GuestCodeProvider", () => {
  it("updates the live profile without reconnecting or replacing collaboration", async () => {
    const { provider, socket } = createHarness(
      `guest-code-profile-${crypto.randomUUID()}`,
    );
    const document = provider.document;
    try {
      await provider.start();
      ready(socket);
      const terminalEpoch = provider.getStatus().terminalConnectionEpoch;
      provider.updateProfile({ displayName: "Alice", color: "#2563eb" });

      expect(socket.auth).toEqual({
        shareId: "a".repeat(43),
        deviceId: "device-1",
        profile: { displayName: "Alice", color: "#2563eb" },
      });
      expect(socket.messages(CODE_SYNC_TAGS.profileUpdate).at(-1)).toEqual({
        type: CODE_SYNC_TAGS.profileUpdate,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        profile: { displayName: "Alice", color: "#2563eb" },
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
          displayName: "Alice",
          color: "#2563eb",
        },
      });
      expect(provider.getStatus().participant).toEqual({
        participantId: participant.participantId,
        displayName: "Alice",
        color: "#2563eb",
      });

      const updateCount = socket.messages(CODE_SYNC_TAGS.profileUpdate).length;
      provider.updateProfile({ displayName: "Alice", color: "#2563eb" });
      expect(socket.messages(CODE_SYNC_TAGS.profileUpdate)).toHaveLength(updateCount);
      expect(socket.connectCalls).toBe(1);
      expect(socket.disconnectCalls).toBe(0);
    } finally {
      await provider.stop();
    }
  });

  it("advertises multi-selection capability first and sends plural awareness to a capable server", async () => {
    const { provider, socket } = createHarness(
      `guest-code-capable-awareness-${crypto.randomUUID()}`,
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
    const { provider, socket } = createHarness(
      `guest-code-legacy-awareness-${crypto.randomUUID()}`,
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

  it("waits for the final sync part, replays one durable update after reconnect, and trusts server awareness identity", async () => {
    const databaseName = `guest-code-provider-${crypto.randomUUID()}`;
    const { provider, socket } = createHarness(databaseName);
    try {
      await provider.start();
      ready(socket);
      const parts = syncParts();
      expect(parts.length).toBeGreaterThan(1);

      const request = socket.messages(CODE_SYNC_TAGS.syncStep1).at(-1)!;
      socket.serverEmit(CODE_SYNC_MESSAGE_EVENT, {
        type: CODE_SYNC_TAGS.syncStep2,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        requestId: request.requestId,
        updateEncoding: CODE_SYNC_UPDATE_ENCODING,
        update: parts[0],
        stateVector: Uint8Array.of(0),
        sequence: 0,
        part: 0,
        done: false,
      });
      expect(provider.getStatus().documentReady).toBe(false);
      parts.slice(1).forEach((update, index) => {
        socket.serverEmit(CODE_SYNC_MESSAGE_EVENT, {
          type: CODE_SYNC_TAGS.syncStep2,
          protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
          requestId: request.requestId,
          updateEncoding: CODE_SYNC_UPDATE_ENCODING,
          update,
          stateVector: Uint8Array.of(0),
          sequence: 0,
          part: index + 1,
          done: index === parts.length - 2,
        });
      });
      await eventually(() => expect(provider.getStatus().connection).toBe("online"));
      const mainText = codeWorkspaceText(provider.document, "main-py")!;
      const remoteCaret = Y.encodeRelativePosition(
        Y.createRelativePositionFromTypeIndex(mainText, 2),
      );

      let peers: readonly GuestCodePeerAwareness[] = [];
      const unsubscribe = provider.subscribeAwareness((next) => {
        peers = next;
      });
      socket.serverEmit(CODE_SYNC_MESSAGE_EVENT, {
        type: CODE_SYNC_TAGS.awareness,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        participant: {
          participantId: "server-peer",
          displayName: "Гость 2",
          color: "#aa3355",
        },
        state: {
          target: { kind: "file", entryId: "main-py", field: "text" },
          selection: { anchor: remoteCaret, head: remoteCaret },
        },
      });
      expect(peers).toEqual([expect.objectContaining({
        participant: expect.objectContaining({ participantId: "server-peer" }),
        state: expect.objectContaining({
          target: { kind: "file", entryId: "main-py", field: "text" },
          selections: [{ anchor: remoteCaret, head: remoteCaret }],
        }),
      })]);

      provider.setAwareness({
        target: { kind: "terminal", field: "input" },
      });
      await eventually(() => {
        expect(socket.messages(CODE_SYNC_TAGS.awareness).at(-1)?.state).toEqual({
          target: { kind: "terminal", field: "input" },
        });
      });
      unsubscribe();

      codeWorkspaceText(provider.document, "main-py")?.insert(0, "# local\n");
      await eventually(() => {
        expect(socket.messages(CODE_SYNC_TAGS.update)).toHaveLength(1);
      });
      const firstSend = socket.messages(CODE_SYNC_TAGS.update)[0]!;

      socket.disconnect();
      socket.connect();
      ready(socket);
      respondToSync(socket, [Uint8Array.of(0, 0)]);
      await eventually(() => {
        expect(socket.messages(CODE_SYNC_TAGS.update).length).toBeGreaterThan(1);
      });
      const replay = socket.messages(CODE_SYNC_TAGS.update).at(-1)!;
      expect(replay.updateId).toBe(firstSend.updateId);

      socket.serverEmit(CODE_SYNC_MESSAGE_EVENT, {
        type: CODE_SYNC_TAGS.updateAck,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        requestId: replay.requestId,
        updateId: replay.updateId,
        status: "duplicate",
        sequence: 1,
      });
      await provider.waitUntilSynchronized();
      expect(provider.getStatus().pendingUpdates).toBe(0);
    } finally {
      await provider.clearLocalData();
    }
  });

  it("restores offline edits and their stable update IDs after a full provider reload", async () => {
    const databaseName = `guest-code-reload-${crypto.randomUUID()}`;
    const first = createHarness(databaseName);
    await first.provider.start();
    ready(first.socket);
    respondToSync(first.socket, syncParts());
    await eventually(() => expect(first.provider.getStatus().documentReady).toBe(true));
    codeWorkspaceText(first.provider.document, "main-py")?.insert(0, "# reload\n");
    await eventually(() => {
      expect(first.socket.messages(CODE_SYNC_TAGS.update)).toHaveLength(1);
    });
    const originalUpdateId = first.socket.messages(CODE_SYNC_TAGS.update)[0]?.updateId;
    await first.provider.stop();

    const second = createHarness(databaseName);
    try {
      await second.provider.start();
      expect(second.provider.getStatus().documentReady).toBe(true);
      expect(codeWorkspaceText(second.provider.document, "main-py")?.toString())
        .toContain("# reload");
      ready(second.socket);
      respondToSync(second.socket, [Uint8Array.of(0, 0)]);
      await eventually(() => {
        expect(second.socket.messages(CODE_SYNC_TAGS.update)).toHaveLength(1);
      });
      expect(second.socket.messages(CODE_SYNC_TAGS.update)[0]?.updateId)
        .toBe(originalUpdateId);
    } finally {
      await second.provider.clearLocalData();
    }
  });

  it("applies ordered terminal deltas, forwards ACK/effects, and recovers a gap", async () => {
    const databaseName = `guest-code-terminal-${crypto.randomUUID()}`;
    const { provider, socket } = createHarness(databaseName);
    try {
      await provider.start();
      ready(socket);
      respondToSync(socket, syncParts());
      await eventually(() => expect(provider.getStatus().connection).toBe("online"));

      const states: unknown[] = [];
      const effects: unknown[] = [];
      const acks: unknown[] = [];
      const unsubscribeState = provider.subscribeTerminalState((state) => {
        states.push(state);
      });
      const unsubscribeEffects = provider.subscribeTerminalEffects((effect) => {
        effects.push(effect);
      });
      const unsubscribeAcks = provider.subscribeTerminalAcks((ack) => {
        acks.push(ack);
      });

      provider.dispatchTerminal({
        type: "submit-line",
        actionId: "terminal-action-1",
        value: "py main.py",
      });
      expect(socket.events(SHARED_TERMINAL_ACTION_EVENT).at(-1)?.[0]).toEqual({
        protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
        action: {
          type: "submit-line",
          actionId: "terminal-action-1",
          value: "py main.py",
        },
      });

      const state = {
        protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
        generation: 1,
        seq: 4,
        mode: "busy",
        prompt: "/workspace $ ",
        transcript: "/workspace $ py main.py\n",
        input: { value: "", cursor: 0, owner: null },
        host: participant,
        activeRun: {
          runId: "run-1",
          entryId: "main-py",
          entrypoint: "main.py",
          testId: null,
        },
        inputRequestId: null,
        lastTest: null,
      } as const;
      socket.serverEmit(SHARED_TERMINAL_STATE_EVENT, state);
      expect(states).toEqual([state]);

      const delta = {
        protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
        generation: 1,
        baseSeq: 4,
        seq: 5,
        operations: [{
          type: "transcript-append",
          trimStart: 0,
          value: "ready\n",
        }],
      } as const;
      socket.serverEmit(SHARED_TERMINAL_DELTA_EVENT, delta);
      expect(states.at(-1)).toMatchObject({
        seq: 5,
        transcript: "/workspace $ py main.py\nready\n",
      });

      const ack = {
        protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
        actionId: "terminal-action-1",
        generation: 1,
        seq: 5,
        status: "applied",
        error: null,
      } as const;
      socket.serverEmit(SHARED_TERMINAL_ACK_EVENT, ack);
      expect(acks).toEqual([ack]);

      const effect = {
        protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
        type: "start-run",
        runId: "run-1",
        entryId: "main-py",
        entrypoint: "main.py",
        testId: null,
      } as const;
      socket.serverEmit(SHARED_TERMINAL_EFFECT_EVENT, effect);
      expect(effects).toEqual([effect]);

      socket.serverEmit(SHARED_TERMINAL_DELTA_EVENT, {
        ...delta,
        baseSeq: 7,
        seq: 8,
      });
      const recovery = socket.events(SHARED_TERMINAL_ACTION_EVENT)
        .map(([envelope]) => envelope as {
          action?: { type?: string };
        })
        .filter((envelope) => envelope.action?.type === "sync");
      expect(recovery).toHaveLength(1);
      socket.serverEmit(SHARED_TERMINAL_DELTA_EVENT, {
        ...delta,
        baseSeq: 7,
        seq: 8,
      });
      expect(socket.events(SHARED_TERMINAL_ACTION_EVENT)
        .map(([envelope]) => envelope as { action?: { type?: string } })
        .filter((envelope) => envelope.action?.type === "sync"))
        .toHaveLength(1);

      socket.serverEmit(SHARED_TERMINAL_STATE_EVENT, {
        ...state,
        protocolVersion: 999,
      });
      expect(states).toHaveLength(2);
      expect(states.at(-1)).toMatchObject({ seq: 5 });
      unsubscribeState();
      unsubscribeEffects();
      unsubscribeAcks();
    } finally {
      await provider.clearLocalData();
    }
  });

  it("accepts a fresh lower terminal generation after the room restarts", async () => {
    const databaseName = `guest-code-terminal-reconnect-${crypto.randomUUID()}`;
    const { provider, socket } = createHarness(databaseName);
    try {
      await provider.start();
      ready(socket);
      respondToSync(socket, syncParts());
      await eventually(() => expect(provider.getStatus().connection).toBe("online"));
      const states: Array<{ generation: number; seq: number }> = [];
      const unsubscribe = provider.subscribeTerminalState((state) => states.push(state));
      const terminalState = (generation: number, seq: number) => ({
        protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
        generation,
        seq,
        mode: "shell" as const,
        prompt: "$ ",
        transcript: "",
        input: { value: "", cursor: 0, owner: null },
        host: null,
        activeRun: null,
        inputRequestId: null,
        lastTest: null,
      });
      socket.serverEmit(SHARED_TERMINAL_STATE_EVENT, terminalState(2, 9));
      socket.disconnect();
      socket.connect();
      socket.serverEmit(SHARED_TERMINAL_STATE_EVENT, terminalState(1, 0));
      socket.serverEmit(SHARED_TERMINAL_DELTA_EVENT, {
        protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
        generation: 1,
        baseSeq: 0,
        seq: 1,
        operations: [{
          type: "transcript-append",
          trimStart: 0,
          value: "ready\n",
        }],
      });
      expect(states.map(({ generation, seq }) => [generation, seq]))
        .toEqual([[2, 9], [1, 0], [1, 1]]);
      unsubscribe();
    } finally {
      await provider.clearLocalData();
    }
  });
});
