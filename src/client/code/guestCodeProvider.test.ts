// @vitest-environment node

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  CODE_SYNC_MESSAGE_EVENT,
  CODE_SYNC_PROTOCOL_VERSION,
  CODE_SYNC_TAGS,
  CODE_SYNC_UPDATE_ENCODING,
} from "../../code/protocol/index.js";
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
    this.connected = true;
    this.serverEmit("connect");
    return this;
  }

  disconnect(): this {
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
}

const participant = {
  participantId: "guest-participant-1",
  displayName: "Гость 1",
  color: "#336699",
};

function ready(socket: FakeSocket): void {
  socket.serverEmit(CODE_SYNC_MESSAGE_EVENT, {
    type: CODE_SYNC_TAGS.ready,
    protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
    workspaceId: "workspace-1",
    documentId: "document-1",
    deviceId: "device-1",
    participant,
    updateEncoding: CODE_SYNC_UPDATE_ENCODING,
  });
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
          cursor: { entryId: "main-py", offset: 2 },
          terminal: {
            kind: "host",
            runId: "remote-run",
            requestId: "remote-request",
          },
        },
      });
      expect(peers).toEqual([expect.objectContaining({
        participant: expect.objectContaining({ participantId: "server-peer" }),
        state: expect.objectContaining({
          terminal: {
            kind: "host",
            runId: "remote-run",
            requestId: "remote-request",
          },
        }),
      })]);

      provider.setAwareness({
        terminal: {
          kind: "input",
          runId: "remote-run",
          requestId: "remote-request",
          submissionId: "submission-1",
          value: "Ada",
        },
      });
      await eventually(() => {
        expect(socket.messages(CODE_SYNC_TAGS.awareness).at(-1)?.state).toEqual({
          terminal: {
            kind: "input",
            runId: "remote-run",
            requestId: "remote-request",
            submissionId: "submission-1",
            value: "Ada",
          },
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
});
