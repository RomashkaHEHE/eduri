import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  applyBoardUpdate,
  encodeBoardStateVector,
  encodeBoardUpdate,
  stateVectorsEqual,
} from "../../board/core/index.js";
import type {
  BoardClientPersistence,
  BoardRecoverySignal,
  PendingBoardRebaseResult,
  PendingBoardUpdate,
} from "../../board/persistence/index.js";
import {
  BOARD_PROTOCOL_LIMITS,
  BoardCapability,
  BoardControlCode,
  BoardMessageType,
  BoardPermission,
  decodeBoardFrame,
  encodeBoardFrame,
  messageIdToHex,
  type BoardFrame,
  type ReadyFrame,
} from "../../board/protocol/index.js";
import {
  BoardNetworkProvider,
  type BoardProviderTimers,
  type BoardSocket,
  type BoardSocketCloseEvent,
} from "./networkProvider.js";
import {
  MAX_BOARD_GESTURE_PREVIEW_POINTS,
  MAX_BOARD_LASER_POINTS,
  MAX_BOARD_LASER_STROKES,
} from "./rendering/types.js";

const scope = {
  boardId: "board-1",
  generation: 1,
  documentKey: "page:default",
};

interface MemoryPersistenceState {
  pending: Map<string, PendingBoardUpdate>;
  recovery: BoardRecoverySignal | null;
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class MemoryPersistence implements BoardClientPersistence {
  readonly whenReady: Promise<void>;
  readonly state: MemoryPersistenceState;
  enqueueGate: Promise<void> | null = null;
  enqueueFailures = 0;
  ackFailures = 0;
  readonly operations: string[] = [];
  readonly documentUpdates: Uint8Array[] = [];
  readonly incrementalDocumentReads: Array<{
    cursor: number;
    returnedCount: number;
    nextCursor: number;
  }> = [];
  fullDocumentReadCount = 0;
  listDocumentGate: Promise<void> | null = null;
  recoveryGate: Promise<void> | null = null;
  onListDocumentUpdates: (() => void) | null = null;
  beforeRebasePendingUpdates: (() => void | Promise<void>) | null = null;
  private readonly localChangeListeners = new Set<() => void>();

  constructor(
    state: MemoryPersistenceState = { pending: new Map(), recovery: null },
    ready: Promise<void> = Promise.resolve(),
  ) {
    this.state = state;
    this.whenReady = ready;
  }

  async enqueuePendingUpdate(update: PendingBoardUpdate): Promise<void> {
    this.operations.push(`enqueue:start:${messageIdToHex(update.messageId)}`);
    if (this.enqueueGate) await this.enqueueGate;
    if (this.enqueueFailures > 0) {
      this.enqueueFailures -= 1;
      throw new Error("simulated local quota failure");
    }
    this.state.pending.set(messageIdToHex(update.messageId), clonePending(update));
    this.operations.push(`enqueue:done:${messageIdToHex(update.messageId)}`);
  }

  async listPendingUpdates(): Promise<readonly PendingBoardUpdate[]> {
    return [...this.state.pending.values()].map(clonePending);
  }

  subscribeLocalChanges(listener: () => void): () => void {
    this.localChangeListeners.add(listener);
    return () => this.localChangeListeners.delete(listener);
  }

  emitExternalLocalChange(): void {
    for (const listener of this.localChangeListeners) listener();
  }

  async rebasePendingUpdates(
    replacements: readonly PendingBoardUpdate[],
    coveredUpdates: readonly PendingBoardUpdate[],
  ): Promise<PendingBoardRebaseResult> {
    this.operations.push(`rebase:${coveredUpdates.length}`);
    await this.beforeRebasePendingUpdates?.();
    const currentUpdates = [...this.state.pending.values()].map(clonePending);
    const currentById = new Map(
      currentUpdates.map((update) => [messageIdToHex(update.messageId), update]),
    );
    const unchanged =
      currentUpdates.length === coveredUpdates.length
      && coveredUpdates.every((expected) => {
        const current = currentById.get(messageIdToHex(expected.messageId));
        return current !== undefined && pendingUpdatesEqual(current, expected);
      });
    if (!unchanged) {
      return { committed: false, currentUpdates };
    }

    const durableOrders = coveredUpdates
      .map((update) => update.queueOrder)
      .filter((order): order is number => order !== undefined);
    const firstOrder =
      durableOrders.length > 0
      && durableOrders.length === coveredUpdates.length
      ? Math.min(...durableOrders)
      : 1;
    for (const update of coveredUpdates) {
      this.state.pending.delete(messageIdToHex(update.messageId));
    }
    for (const [index, replacement] of replacements.entries()) {
      const durableReplacement = {
        ...replacement,
        queueOrder: firstOrder + index,
      };
      this.state.pending.set(
        messageIdToHex(replacement.messageId),
        clonePending(durableReplacement),
      );
    }
    return {
      committed: true,
      currentUpdates: [...this.state.pending.values()].map(clonePending),
    };
  }

  async acknowledgePendingUpdate(
    messageId: Uint8Array,
    durableSequence: number,
  ): Promise<void> {
    this.operations.push(`ack:${durableSequence}`);
    if (this.ackFailures > 0) {
      this.ackFailures -= 1;
      throw new Error("simulated ACK persistence failure");
    }
    this.state.pending.delete(messageIdToHex(messageId));
  }

  async listDocumentUpdates(): Promise<readonly Uint8Array[]> {
    this.onListDocumentUpdates?.();
    if (this.listDocumentGate) await this.listDocumentGate;
    this.fullDocumentReadCount += 1;
    return this.documentUpdates.map((update) => update.slice());
  }

  async listDocumentUpdatesAfter(cursor: number): Promise<{
    updates: readonly Uint8Array[];
    cursor: number;
  }> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new TypeError("invalid document update cursor");
    }
    this.onListDocumentUpdates?.();
    if (this.listDocumentGate) await this.listDocumentGate;
    const nextCursor = this.documentUpdates.length;
    if (cursor > nextCursor) {
      throw new Error("document update cursor is ahead of the append log");
    }
    const updates = this.documentUpdates
      .slice(cursor)
      .map((update) => update.slice());
    this.incrementalDocumentReads.push({
      cursor,
      returnedCount: updates.length,
      nextCursor,
    });
    return { updates, cursor: nextCursor };
  }

  async getRecoverySignal(): Promise<BoardRecoverySignal | null> {
    return this.state.recovery ? cloneRecovery(this.state.recovery) : null;
  }

  async setRecoverySignal(signal: BoardRecoverySignal): Promise<void> {
    if (this.recoveryGate) await this.recoveryGate;
    this.state.recovery = cloneRecovery(signal);
  }
}

function clonePending(update: PendingBoardUpdate): PendingBoardUpdate {
  return {
    ...update,
    messageId: update.messageId.slice(),
    update: update.update.slice(),
  };
}

function pendingUpdatesEqual(
  left: PendingBoardUpdate,
  right: PendingBoardUpdate,
): boolean {
  return (
    left.generation === right.generation
    && left.documentKey === right.documentKey
    && left.createdAt === right.createdAt
    && left.queueOrder === right.queueOrder
    && left.update.byteLength === right.update.byteLength
    && left.update.every((byte, index) => byte === right.update[index])
  );
}

function cloneRecovery(signal: BoardRecoverySignal): BoardRecoverySignal {
  return {
    ...signal,
    messageId: signal.messageId?.slice(),
    payload: signal.payload?.slice(),
  };
}

class ManualTimers implements BoardProviderTimers {
  private clock = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; callback: () => void }>();

  now = (): number => this.clock;

  setTimeout = (callback: () => void, delayMs: number): unknown => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.clock + delayMs, callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  advance(milliseconds: number): void {
    const target = this.clock + milliseconds;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      this.tasks.delete(next[0]);
      this.clock = next[1].at;
      next[1].callback();
    }
    this.clock = target;
  }

  get nextDelay(): number | null {
    if (!this.tasks.size) return null;
    return Math.min(...[...this.tasks.values()].map((task) => task.at)) - this.clock;
  }
}

class FakeSocket implements BoardSocket {
  binaryType = "";
  bufferedAmount = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: BoardSocketCloseEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onClientFrame: ((frame: BoardFrame) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
  sendFailure: Error | null = null;

  send(data: Uint8Array): void {
    if (this.closed) throw new Error("socket is closed");
    if (this.sendFailure) throw this.sendFailure;
    this.sent.push(data.slice());
    this.onClientFrame?.(decodeBoardFrame(data));
  }

  open(): void {
    if (!this.closed) this.onopen?.({});
  }

  receive(frame: BoardFrame): void {
    this.onmessage?.({ data: encodeBoardFrame(frame) });
  }

  receiveRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  serverClose(code = 1006, reason = "network lost"): void {
    this.finishClose({ code, reason });
  }

  close(code?: number, reason?: string): void {
    if (
      code !== undefined
      && code !== 1000
      && (code < 3000 || code > 4999)
    ) {
      throw new DOMException("Invalid WebSocket close code", "InvalidAccessError");
    }
    this.closeCode = code;
    this.closeReason = reason;
    this.finishClose({ code, reason });
  }

  private finishClose(event: BoardSocketCloseEvent): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.(event);
  }
}

interface Harness {
  document: Y.Doc;
  store: MemoryPersistence;
  timers: ManualTimers;
  sockets: FakeSocket[];
  provider: BoardNetworkProvider;
  ticketCalls: { count: number };
}

function deterministicRandomBytes(): (length: number) => Uint8Array {
  let seed = 1;
  return (length) => {
    const result = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      result[index] = (seed + index) & 0xff;
    }
    seed += 1;
    return result;
  };
}

function createHarness(options: {
  document?: Y.Doc;
  store?: MemoryPersistence;
  timers?: ManualTimers;
} = {}): Harness {
  const document = options.document ?? new Y.Doc();
  const store = options.store ?? new MemoryPersistence();
  const timers = options.timers ?? new ManualTimers();
  const sockets: FakeSocket[] = [];
  const ticketCalls = { count: 0 };
  const provider = new BoardNetworkProvider({
    document,
    scope,
    localStore: store,
    ticketSource: async () => {
      ticketCalls.count += 1;
      return {
        ticket: `ticket-${ticketCalls.count}`,
        socketUrl: "wss://eduri.test/board-v2",
      };
    },
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    timers,
    random: () => 0.5,
    randomBytes: deterministicRandomBytes(),
    updateCoalesceMs: 0,
    awarenessIntervalMs: 40,
    ackRetryMs: 1_000,
    reconnectBaseMs: 250,
    reconnectMaxMs: 2_000,
  });
  return { document, store, timers, sockets, provider, ticketCalls };
}

function readyFrame(
  generation = scope.generation,
  awarenessClientId = 77,
): ReadyFrame {
  return {
    type: BoardMessageType.READY,
    generation,
    schemaVersion: 1,
    capabilities: BoardCapability.CHUNKING | BoardCapability.AWARENESS,
    awarenessClientId,
    permissions: BoardPermission.READ | BoardPermission.EDIT,
  };
}

function sentFrames(socket: FakeSocket): BoardFrame[] {
  return socket.sent.map((bytes) => decodeBoardFrame(bytes));
}

function sentLogicalFrames(socket: FakeSocket): BoardFrame[] {
  const result: BoardFrame[] = [];
  const chunks = new Map<string, {
    innerType: BoardMessageType.SYNC_STEP2 | BoardMessageType.UPDATE;
    totalLength: number;
    parts: Array<Uint8Array | undefined>;
  }>();
  for (const frame of sentFrames(socket)) {
    if (frame.type !== BoardMessageType.CHUNK) {
      result.push(frame);
      continue;
    }
    const key = messageIdToHex(frame.messageId);
    const assembly = chunks.get(key) ?? {
      innerType: frame.innerType,
      totalLength: frame.totalLength,
      parts: new Array<Uint8Array | undefined>(frame.chunkCount).fill(undefined),
    };
    expect(assembly.innerType).toBe(frame.innerType);
    expect(assembly.totalLength).toBe(frame.totalLength);
    expect(assembly.parts).toHaveLength(frame.chunkCount);
    assembly.parts[frame.chunkIndex] = frame.payload;
    chunks.set(key, assembly);
    if (assembly.parts.some((part) => part === undefined)) continue;

    const encoded = new Uint8Array(assembly.totalLength);
    let offset = 0;
    for (const part of assembly.parts as Uint8Array[]) {
      encoded.set(part, offset);
      offset += part.byteLength;
    }
    const logical = decodeBoardFrame(encoded);
    expect(logical.type).toBe(assembly.innerType);
    result.push(logical);
    chunks.delete(key);
  }
  return result;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function bringOnline(
  harness: Harness,
  awarenessClientId = 77,
): Promise<FakeSocket> {
  await harness.provider.start();
  await settle();
  const socket = harness.sockets[0];
  expect(socket).toBeDefined();
  socket.open();
  expect(sentFrames(socket)[0]).toMatchObject({
    type: BoardMessageType.AUTH,
    ticket: "ticket-1",
    generation: scope.generation,
  });
  socket.receive(readyFrame(scope.generation, awarenessClientId));
  harness.timers.advance(0);
  await settle();
  return socket;
}

function validUpdate(key: string, value: string): Uint8Array {
  const document = new Y.Doc();
  document.getMap("content").set(key, value);
  return Y.encodeStateAsUpdate(document);
}

function durablePendingUpdate(
  index: number,
  update = validUpdate(`pending-${index}`, String(index)),
): PendingBoardUpdate {
  return {
    messageId: new Uint8Array(16).fill(100 + index),
    generation: scope.generation,
    documentKey: scope.documentKey,
    update,
    createdAt: index + 1,
    queueOrder: index + 1,
  };
}

describe("BoardNetworkProvider local-first lifecycle", () => {
  it("does not create a network connection before local IndexedDB readiness", async () => {
    const ready = new Deferred<void>();
    const harness = createHarness({
      store: new MemoryPersistence(
        { pending: new Map(), recovery: null },
        ready.promise,
      ),
    });
    const starting = harness.provider.start();
    await settle();
    expect(harness.sockets).toHaveLength(0);
    expect(harness.provider.status.connection).toBe("loading-local");

    ready.resolve();
    await starting;
    await settle();
    expect(harness.sockets).toHaveLength(1);
    expect(harness.provider.status.connection).toBe("connecting");
    await harness.provider.stop();
  });

  it("uses a browser-valid private close code for an invalid protocol frame", async () => {
    const harness = createHarness();
    const socket = await bringOnline(harness);

    socket.receiveRaw(new Uint8Array([255]));

    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(4002);
    expect(socket.closeReason).toBe("Invalid Board protocol frame");
    await harness.provider.stop();
  });

  it("uses a browser-valid private close code after a send failure", async () => {
    const harness = createHarness();
    const socket = await bringOnline(harness);
    socket.sendFailure = new Error("simulated send failure");

    harness.document.getMap("content").set("send-failure", true);
    harness.timers.advance(0);
    await settle();

    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(4011);
    expect(socket.closeReason).toBe("Board WebSocket send failed");
    await harness.provider.stop();
  });

  it("applies edits immediately but sends only after the outbox commit", async () => {
    const harness = createHarness();
    const socket = await bringOnline(harness);
    const gate = new Deferred<void>();
    harness.store.enqueueGate = gate.promise;
    const baseline = sentFrames(socket).length;

    harness.document.getMap("content").set("answer", 42);
    expect(harness.document.getMap("content").get("answer")).toBe(42);
    expect(sentFrames(socket).slice(baseline)
      .some((frame) => frame.type === BoardMessageType.UPDATE)).toBe(false);

    harness.timers.advance(0);
    await settle();
    expect(harness.store.operations[0]).toMatch(/^enqueue:start:/u);
    harness.provider.setPresence({ cursor: { x: 12, y: 34 } });
    harness.timers.advance(40);
    await settle();
    const beforeCommit = sentFrames(socket).slice(baseline);
    expect(beforeCommit.some(
      (frame) => frame.type === BoardMessageType.AWARENESS,
    )).toBe(true);
    expect(beforeCommit.some(
      (frame) => frame.type === BoardMessageType.UPDATE,
    )).toBe(false);

    gate.resolve();
    await settle();
    const update = sentFrames(socket).slice(baseline)
      .find((frame) => frame.type === BoardMessageType.UPDATE);
    expect(update).toMatchObject({
      type: BoardMessageType.UPDATE,
      generation: scope.generation,
      docKey: scope.documentKey,
    });
    expect(harness.store.operations[1]).toMatch(/^enqueue:done:/u);
    await harness.provider.stop();
  });

  it("bounds a coalesced backlog into causal durable UPDATE frames", async () => {
    const harness = createHarness();
    const socket = await bringOnline(harness);
    const individualUpdates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => individualUpdates.push(update.slice());
    harness.document.on("update", collect);
    const content = harness.document.getMap<unknown>("content");
    for (let index = 0; index < 17; index += 1) {
      content.set(
        `coalesced-blob-${index}`,
        new Uint8Array(1024 * 1024).fill(index + 1),
      );
    }
    harness.document.off("update", collect);
    expect(individualUpdates).toHaveLength(17);
    expect(individualUpdates.every(
      (update) => update.byteLength <= BOARD_PROTOCOL_LIMITS.maxUpdateBytes,
    )).toBe(true);
    expect(Y.mergeUpdates(individualUpdates).byteLength).toBeGreaterThan(
      BOARD_PROTOCOL_LIMITS.maxUpdateBytes,
    );

    harness.timers.advance(0);
    await settle();

    const pending = [...harness.store.state.pending.values()]
      .sort((left, right) => (left.queueOrder ?? 0) - (right.queueOrder ?? 0));
    expect(pending.length).toBeGreaterThan(1);
    expect(pending.every(
      (update) => update.update.byteLength <= BOARD_PROTOCOL_LIMITS.maxUpdateBytes,
    )).toBe(true);
    const pendingIds = new Set(
      pending.map((update) => messageIdToHex(update.messageId)),
    );
    for (const [index, pendingUpdate] of pending.entries()) {
      if (index > 0) {
        harness.timers.advance(10);
        await settle();
      }
      const outbound = sentLogicalFrames(socket).find(
        (frame) =>
          frame.type === BoardMessageType.UPDATE
          && messageIdToHex(frame.messageId)
            === messageIdToHex(pendingUpdate.messageId),
      );
      expect(outbound?.type).toBe(BoardMessageType.UPDATE);
      socket.receive({
        type: BoardMessageType.ACK,
        generation: scope.generation,
        docKey: scope.documentKey,
        messageId: pendingUpdate.messageId,
        durableSequence: index + 1,
      });
      await settle();
    }
    const outbound = sentLogicalFrames(socket).filter(
      (frame): frame is Extract<BoardFrame, {
        type: BoardMessageType.UPDATE;
      }> =>
        frame.type === BoardMessageType.UPDATE
        && pendingIds.has(messageIdToHex(frame.messageId)),
    );
    expect(new Set(
      outbound.map((frame) => messageIdToHex(frame.messageId)),
    )).toEqual(pendingIds);
    expect(outbound.every(
      (frame) => frame.update.byteLength <= BOARD_PROTOCOL_LIMITS.maxUpdateBytes,
    )).toBe(true);

    const replica = new Y.Doc();
    for (const update of pending) {
      applyBoardUpdate(replica, update.update);
      expect(replica.store.pendingStructs).toBeNull();
      expect(replica.store.pendingDs).toBeNull();
    }
    expect(stateVectorsEqual(
      encodeBoardStateVector(replica),
      encodeBoardStateVector(harness.document),
    )).toBe(true);
    expect(harness.provider.status.recovery).toBeNull();
    expect(socket.closed).toBe(false);

    replica.destroy();
    await harness.provider.stop();
  });

  it("paces a durable backlog and bounds the in-flight update window", async () => {
    const updates = Array.from(
      { length: 20 },
      (_, index) => durablePendingUpdate(index),
    );
    const store = new MemoryPersistence({
      pending: new Map(
        updates.map((update) => [messageIdToHex(update.messageId), update]),
      ),
      recovery: null,
    });
    const harness = createHarness({ store });
    const socket = await bringOnline(harness);
    const outbound = () => sentLogicalFrames(socket).filter(
      (frame): frame is Extract<BoardFrame, {
        type: BoardMessageType.UPDATE;
      }> => frame.type === BoardMessageType.UPDATE,
    );

    expect(outbound()).toHaveLength(1);
    expect(messageIdToHex(outbound()[0].messageId)).toBe(
      messageIdToHex(updates[0].messageId),
    );

    socket.bufferedAmount = 4 * 1024 * 1024 + 1;
    harness.timers.advance(10);
    expect(outbound()).toHaveLength(1);
    socket.bufferedAmount = 0;
    harness.timers.advance(24);
    expect(outbound()).toHaveLength(1);
    harness.timers.advance(1);
    expect(outbound()).toHaveLength(2);

    harness.timers.advance(9);
    expect(outbound()).toHaveLength(2);
    harness.timers.advance(1);
    expect(outbound()).toHaveLength(3);
    harness.timers.advance(130);
    expect(outbound()).toHaveLength(16);
    expect(
      outbound().reduce((sum, frame) => sum + frame.update.byteLength, 0),
    ).toBeLessThanOrEqual(BOARD_PROTOCOL_LIMITS.maxUpdateBytes);

    harness.timers.advance(10);
    expect(outbound()).toHaveLength(16);
    socket.receive({
      type: BoardMessageType.ACK,
      generation: scope.generation,
      docKey: scope.documentKey,
      messageId: updates[0].messageId,
      durableSequence: 1,
    });
    await settle();
    expect(outbound()).toHaveLength(17);
    expect(messageIdToHex(outbound()[16].messageId)).toBe(
      messageIdToHex(updates[16].messageId),
    );
    await harness.provider.stop();
  });

  it("holds the next durable update when the byte window is full", async () => {
    const valueBytes =
      Math.floor(BOARD_PROTOCOL_LIMITS.maxUpdateBytes / 2) + 1024;
    const largeUpdates = [0, 1].map((index) => {
      const document = new Y.Doc();
      document.getMap<unknown>("content").set(
        `large-${index}`,
        new Uint8Array(valueBytes).fill(index + 1),
      );
      const update = durablePendingUpdate(
        120 + index,
        Y.encodeStateAsUpdate(document),
      );
      document.destroy();
      return update;
    });
    expect(largeUpdates.every(
      (update) =>
        update.update.byteLength <= BOARD_PROTOCOL_LIMITS.maxUpdateBytes,
    )).toBe(true);
    expect(
      largeUpdates.reduce((sum, update) => sum + update.update.byteLength, 0),
    ).toBeGreaterThan(BOARD_PROTOCOL_LIMITS.maxUpdateBytes);

    const store = new MemoryPersistence({
      pending: new Map(
        largeUpdates.map((update) => [
          messageIdToHex(update.messageId),
          update,
        ]),
      ),
      recovery: null,
    });
    const harness = createHarness({ store });
    const socket = await bringOnline(harness);
    const outbound = () => sentLogicalFrames(socket).filter(
      (frame): frame is Extract<BoardFrame, {
        type: BoardMessageType.UPDATE;
      }> => frame.type === BoardMessageType.UPDATE,
    );
    expect(outbound()).toHaveLength(1);

    harness.timers.advance(10);
    expect(outbound()).toHaveLength(1);
    socket.receive({
      type: BoardMessageType.ACK,
      generation: scope.generation,
      docKey: scope.documentKey,
      messageId: largeUpdates[0].messageId,
      durableSequence: 1,
    });
    await settle();
    expect(outbound()).toHaveLength(2);
    await harness.provider.stop();
  });

  it("automatically retries local persistence failure without sending volatile work", async () => {
    const harness = createHarness();
    const socket = await bringOnline(harness);
    harness.store.enqueueFailures = 1;
    const baseline = sentFrames(socket).length;
    harness.document.getMap("content").set("offline", "kept");
    harness.timers.advance(0);
    await settle();

    expect(harness.provider.status.localDurability).toBe("at-risk");
    expect(sentFrames(socket).slice(baseline)
      .some((frame) => frame.type === BoardMessageType.UPDATE)).toBe(false);
    expect(harness.timers.nextDelay).toBe(250);

    harness.timers.advance(250);
    await settle();
    expect(harness.provider.status.localDurability).toBe("ready");
    expect(sentFrames(socket).slice(baseline)
      .some((frame) => frame.type === BoardMessageType.UPDATE)).toBe(true);
    await harness.provider.stop();
  });
});

describe("BoardNetworkProvider ACK and reconnect semantics", () => {
  it("replays the same durable message ID after restart until ACK is persisted", async () => {
    const shared: MemoryPersistenceState = { pending: new Map(), recovery: null };
    const first = createHarness({ store: new MemoryPersistence(shared) });
    const firstSocket = await bringOnline(first);
    first.document.getMap("content").set("restart", "survives");
    first.timers.advance(0);
    await settle();
    const firstUpdate = sentFrames(firstSocket)
      .find((frame) => frame.type === BoardMessageType.UPDATE);
    expect(firstUpdate?.type).toBe(BoardMessageType.UPDATE);
    const originalId = firstUpdate?.type === BoardMessageType.UPDATE
      ? messageIdToHex(firstUpdate.messageId)
      : "";
    expect(shared.pending.has(originalId)).toBe(true);
    await first.provider.stop();

    const second = createHarness({ store: new MemoryPersistence(shared) });
    const secondSocket = await bringOnline(second);
    expect(second.document.getMap("content").get("restart")).toBe("survives");
    const framesBeforeAck = sentFrames(secondSocket);
    const replayIndex = framesBeforeAck.findIndex(
      (frame) => frame.type === BoardMessageType.UPDATE,
    );
    expect(replayIndex).toBeGreaterThan(0);
    expect(framesBeforeAck.some(
      (frame) => frame.type === BoardMessageType.SYNC_STEP1,
    )).toBe(false);
    const replayed = framesBeforeAck[replayIndex];
    expect(replayed?.type).toBe(BoardMessageType.UPDATE);
    if (replayed?.type !== BoardMessageType.UPDATE) throw new Error("Expected replay");
    expect(messageIdToHex(replayed.messageId)).toBe(originalId);

    secondSocket.receive({
      type: BoardMessageType.ACK,
      generation: scope.generation,
      docKey: scope.documentKey,
      messageId: replayed.messageId,
      durableSequence: 12,
    });
    await settle();
    expect(shared.pending.size).toBe(0);
    expect(second.provider.status).toMatchObject({
      pendingUpdateCount: 0,
      lastDurableSequence: 12,
    });
    const framesAfterAck = sentFrames(secondSocket);
    const syncIndexes = framesAfterAck
      .map((frame, index) => frame.type === BoardMessageType.SYNC_STEP1 ? index : -1)
      .filter((index) => index >= 0);
    expect(syncIndexes).toHaveLength(1);
    expect(syncIndexes[0]).toBeGreaterThan(replayIndex);
    await second.provider.stop();
  });

  it("adopts and sends an external durable outbox update after a change hint", async () => {
    const harness = createHarness();
    const socket = await bringOnline(harness);
    const externalUpdate: PendingBoardUpdate = {
      messageId: new Uint8Array(16).fill(31),
      generation: scope.generation,
      documentKey: scope.documentKey,
      update: validUpdate("external-tab", "already durable"),
      createdAt: 10,
      queueOrder: 1,
    };
    harness.store.state.pending.set(
      messageIdToHex(externalUpdate.messageId),
      clonePending(externalUpdate),
    );
    const baseline = sentFrames(socket).length;

    harness.store.emitExternalLocalChange();
    await settle();

    expect(harness.document.getMap("content").get("external-tab")).toBe(
      "already durable",
    );
    expect(harness.provider.status.pendingUpdateCount).toBe(1);
    const sent = sentFrames(socket).slice(baseline).find(
      (frame) =>
        frame.type === BoardMessageType.UPDATE
        && messageIdToHex(frame.messageId)
          === messageIdToHex(externalUpdate.messageId),
    );
    expect(sent?.type).toBe(BoardMessageType.UPDATE);
    await harness.provider.stop();
  });

  it("reconciles only document history appended after its cross-tab cursor", async () => {
    const store = new MemoryPersistence();
    store.documentUpdates.push(
      validUpdate("existing-history-a", "A"),
      validUpdate("existing-history-b", "B"),
    );
    const harness = createHarness({ store });

    await harness.provider.start();
    await settle();

    expect(harness.document.getMap("content").toJSON()).toEqual({
      "existing-history-a": "A",
      "existing-history-b": "B",
    });
    expect(store.incrementalDocumentReads).toEqual([{
      cursor: 0,
      returnedCount: 2,
      nextCursor: 2,
    }]);
    expect(store.fullDocumentReadCount).toBe(0);

    store.documentUpdates.push(validUpdate("new-history", "C"));
    store.emitExternalLocalChange();
    await settle();

    expect(harness.document.getMap("content").get("new-history")).toBe("C");
    expect(store.incrementalDocumentReads).toEqual([
      { cursor: 0, returnedCount: 2, nextCursor: 2 },
      { cursor: 2, returnedCount: 1, nextCursor: 3 },
    ]);
    expect(store.fullDocumentReadCount).toBe(0);
    await harness.provider.stop();
  });

  it("falls back to full history for persistence adapters without cursors", async () => {
    const store = new MemoryPersistence();
    store.documentUpdates.push(validUpdate("legacy-adapter-a", "A"));
    Object.defineProperty(store, "listDocumentUpdatesAfter", {
      configurable: true,
      value: undefined,
    });
    const harness = createHarness({ store });

    await harness.provider.start();
    await settle();
    expect(harness.document.getMap("content").get("legacy-adapter-a")).toBe("A");
    expect(store.fullDocumentReadCount).toBe(1);

    store.documentUpdates.push(validUpdate("legacy-adapter-b", "B"));
    store.emitExternalLocalChange();
    await settle();
    expect(harness.document.getMap("content").get("legacy-adapter-b")).toBe("B");
    expect(store.fullDocumentReadCount).toBe(2);
    await harness.provider.stop();
  });

  it("rereads the shared outbox after reconnect READY without a change hint", async () => {
    const harness = createHarness();
    const firstSocket = await bringOnline(harness);
    firstSocket.serverClose();
    const externalUpdate: PendingBoardUpdate = {
      messageId: new Uint8Array(16).fill(32),
      generation: scope.generation,
      documentKey: scope.documentKey,
      update: validUpdate("reconnect-tab", "found on READY"),
      createdAt: 11,
      queueOrder: 1,
    };
    harness.store.state.pending.set(
      messageIdToHex(externalUpdate.messageId),
      clonePending(externalUpdate),
    );

    harness.timers.advance(250);
    await settle();
    const secondSocket = harness.sockets[1];
    expect(secondSocket).toBeDefined();
    secondSocket.open();
    secondSocket.receive(readyFrame());
    harness.timers.advance(0);
    await settle();

    expect(harness.document.getMap("content").get("reconnect-tab")).toBe(
      "found on READY",
    );
    const sent = sentFrames(secondSocket).find(
      (frame) =>
        frame.type === BoardMessageType.UPDATE
        && messageIdToHex(frame.messageId)
          === messageIdToHex(externalUpdate.messageId),
    );
    expect(sent?.type).toBe(BoardMessageType.UPDATE);
    await harness.provider.stop();
  });

  it("queues one history resync until the current handshake completes", async () => {
    const harness = createHarness();
    await harness.provider.start();
    await settle();
    const socket = harness.sockets[0];
    expect(socket).toBeDefined();
    const clientOrder: BoardMessageType[] = [];
    const server = new Y.Doc();
    let serverPhase: "idle" | "processing" | "awaiting-client" = "idle";
    let overlappingSyncs = 0;
    let invalidSyncResponses = 0;
    socket.onClientFrame = (frame) => {
      if (frame.type === BoardMessageType.SYNC_STEP1) {
        clientOrder.push(frame.type);
        if (serverPhase === "processing") overlappingSyncs += 1;
        serverPhase = "processing";
      } else if (frame.type === BoardMessageType.SYNC_STEP2) {
        clientOrder.push(frame.type);
        if (serverPhase !== "awaiting-client") invalidSyncResponses += 1;
        applyBoardUpdate(server, frame.update);
        serverPhase = "idle";
      }
    };
    socket.open();
    socket.receive(readyFrame());
    harness.timers.advance(0);
    await settle();
    expect(clientOrder).toEqual([BoardMessageType.SYNC_STEP1]);

    harness.store.documentUpdates.push(
      validUpdate("history-only-tab", "durable before outbox"),
    );
    harness.store.emitExternalLocalChange();
    await settle();
    harness.store.documentUpdates.push(
      validUpdate("second-history-only-tab", "also durable"),
    );
    harness.store.emitExternalLocalChange();
    await settle();

    expect(harness.document.getMap("content").get("history-only-tab")).toBe(
      "durable before outbox",
    );
    expect(harness.document.getMap("content").get("second-history-only-tab")).toBe(
      "also durable",
    );
    expect(harness.store.state.pending.size).toBe(0);
    expect(clientOrder).toEqual([BoardMessageType.SYNC_STEP1]);
    expect(overlappingSyncs).toBe(0);

    serverPhase = "awaiting-client";
    socket.receive({
      type: BoardMessageType.SYNC_STEP1,
      generation: scope.generation,
      docKey: scope.documentKey,
      stateVector: encodeBoardStateVector(server),
    });
    await settle();

    expect(clientOrder).toEqual([
      BoardMessageType.SYNC_STEP1,
      BoardMessageType.SYNC_STEP2,
      BoardMessageType.SYNC_STEP1,
    ]);
    expect(overlappingSyncs).toBe(0);
    expect(invalidSyncResponses).toBe(0);
    expect(server.getMap("content").get("history-only-tab")).toBe(
      "durable before outbox",
    );
    expect(server.getMap("content").get("second-history-only-tab")).toBe(
      "also durable",
    );
    await settle();
    expect(clientOrder.filter(
      (type) => type === BoardMessageType.SYNC_STEP1,
    )).toHaveLength(2);
    server.destroy();
    expect(harness.provider.status.recovery).toBeNull();
    expect(socket.closed).toBe(false);
    await harness.provider.stop();
  });

  it("materializes an oversized IndexedDB-only diff as bounded durable updates", async () => {
    const document = new Y.Doc();
    const documentUpdates: Uint8Array[] = [];
    document.on("update", (update: Uint8Array) => {
      documentUpdates.push(update.slice());
    });
    const content = document.getMap<unknown>("content");
    for (let index = 0; index < 17; index += 1) {
      content.set(
        `history-only-blob-${index}`,
        new Uint8Array(1024 * 1024).fill(index + 1),
      );
    }
    expect(documentUpdates).toHaveLength(17);
    expect(Y.mergeUpdates(documentUpdates).byteLength).toBeGreaterThan(
      BOARD_PROTOCOL_LIMITS.maxUpdateBytes,
    );
    const store = new MemoryPersistence();
    store.documentUpdates.push(...documentUpdates);
    const harness = createHarness({ document, store });
    const socket = await bringOnline(harness);
    const initialSync = sentFrames(socket).find(
      (frame) => frame.type === BoardMessageType.SYNC_STEP1,
    );
    expect(initialSync?.type).toBe(BoardMessageType.SYNC_STEP1);
    if (initialSync?.type !== BoardMessageType.SYNC_STEP1) {
      throw new Error("Expected the initial state-vector sync");
    }
    expect(Y.decodeStateVector(initialSync.stateVector).size).toBeGreaterThan(0);

    const server = new Y.Doc();
    socket.receive({
      type: BoardMessageType.SYNC_STEP1,
      generation: scope.generation,
      docKey: scope.documentKey,
      stateVector: encodeBoardStateVector(server),
    });
    await settle();
    const replayRequest = [...sentFrames(socket)].reverse().find(
      (frame) => frame.type === BoardMessageType.SYNC_STEP1,
    );
    expect(replayRequest?.type).toBe(BoardMessageType.SYNC_STEP1);
    if (replayRequest?.type !== BoardMessageType.SYNC_STEP1) {
      throw new Error("Expected a full durable server replay request");
    }
    expect(Y.decodeStateVector(replayRequest.stateVector).size).toBe(0);
    expect(harness.provider.status.recovery).toBeNull();

    socket.receive({
      type: BoardMessageType.SYNC_STEP1,
      generation: scope.generation,
      docKey: scope.documentKey,
      stateVector: encodeBoardStateVector(server),
    });
    await settle();

    const replacements = [...store.state.pending.values()]
      .sort((left, right) => (left.queueOrder ?? 0) - (right.queueOrder ?? 0));
    expect(replacements.length).toBeGreaterThan(1);
    expect(replacements.every(
      (update) => update.update.byteLength <= BOARD_PROTOCOL_LIMITS.maxUpdateBytes,
    )).toBe(true);
    expect(store.operations).toContain("rebase:0");
    for (const replacement of replacements) {
      applyBoardUpdate(server, replacement.update);
      expect(server.store.pendingStructs).toBeNull();
      expect(server.store.pendingDs).toBeNull();
    }
    expect(stateVectorsEqual(
      encodeBoardStateVector(server),
      encodeBoardStateVector(document),
    )).toBe(true);

    const beforeAck = sentFrames(socket).length;
    for (const [index, replacement] of replacements.entries()) {
      socket.receive({
        type: BoardMessageType.ACK,
        generation: scope.generation,
        docKey: scope.documentKey,
        messageId: replacement.messageId,
        durableSequence: index + 1,
      });
      await settle();
    }
    expect(store.state.pending.size).toBe(0);
    expect(sentFrames(socket).slice(beforeAck).some(
      (frame) =>
        frame.type === BoardMessageType.SYNC_STEP1
        && stateVectorsEqual(
          frame.stateVector,
          encodeBoardStateVector(document),
        ),
    )).toBe(true);
    expect(harness.provider.status.recovery).toBeNull();
    expect(socket.closed).toBe(false);
    server.destroy();
    await harness.provider.stop();
  });

  it("discards a blocked sync response when its socket disconnects", async () => {
    const harness = createHarness();
    const firstSocket = await bringOnline(harness);
    const gate = new Deferred<void>();
    harness.store.enqueueGate = gate.promise;

    harness.document.getMap("content").set("reconnect", "durable first");
    harness.timers.advance(0);
    await settle();
    expect(harness.store.operations[0]).toMatch(/^enqueue:start:/u);

    const emptyServer = new Y.Doc();
    firstSocket.receive({
      type: BoardMessageType.SYNC_STEP1,
      generation: scope.generation,
      docKey: scope.documentKey,
      stateVector: encodeBoardStateVector(emptyServer),
    });
    await settle();
    firstSocket.serverClose();

    harness.timers.advance(250);
    await settle();
    expect(harness.sockets).toHaveLength(2);
    const secondSocket = harness.sockets[1];
    secondSocket.open();
    secondSocket.receive(readyFrame());
    harness.timers.advance(0);
    await settle();
    expect(sentFrames(secondSocket).some(
      (frame) =>
        frame.type === BoardMessageType.UPDATE ||
        frame.type === BoardMessageType.SYNC_STEP1 ||
        frame.type === BoardMessageType.SYNC_STEP2,
    )).toBe(false);

    gate.resolve();
    await settle();
    const beforeAck = sentFrames(secondSocket);
    const replayed = beforeAck.find(
      (frame) => frame.type === BoardMessageType.UPDATE,
    );
    expect(replayed?.type).toBe(BoardMessageType.UPDATE);
    expect(beforeAck.some(
      (frame) =>
        frame.type === BoardMessageType.SYNC_STEP1 ||
        frame.type === BoardMessageType.SYNC_STEP2,
    )).toBe(false);
    if (replayed?.type !== BoardMessageType.UPDATE) {
      throw new Error("Expected the durable UPDATE on the replacement socket");
    }

    secondSocket.receive({
      type: BoardMessageType.ACK,
      generation: scope.generation,
      docKey: scope.documentKey,
      messageId: replayed.messageId,
      durableSequence: 21,
    });
    await settle();
    const afterAck = sentFrames(secondSocket);
    expect(afterAck.filter(
      (frame) => frame.type === BoardMessageType.SYNC_STEP1,
    )).toHaveLength(1);
    expect(afterAck.some(
      (frame) => frame.type === BoardMessageType.SYNC_STEP2,
    )).toBe(false);
    expect(secondSocket.closed).toBe(false);

    emptyServer.destroy();
    await harness.provider.stop();
  });

  it("uses exponential reconnect backoff and obtains a fresh ticket", async () => {
    const harness = createHarness();
    const firstSocket = await bringOnline(harness);
    firstSocket.serverClose();
    expect(harness.provider.status.connection).toBe("offline");
    expect(harness.timers.nextDelay).toBe(250);

    harness.timers.advance(249);
    await settle();
    expect(harness.sockets).toHaveLength(1);
    harness.timers.advance(1);
    await settle();
    expect(harness.sockets).toHaveLength(2);
    expect(harness.ticketCalls.count).toBe(2);

    harness.sockets[1].serverClose();
    expect(harness.timers.nextDelay).toBe(500);
    harness.timers.advance(500);
    await settle();
    expect(harness.sockets).toHaveLength(3);
    expect(harness.ticketCalls.count).toBe(3);
    await harness.provider.stop();
  });

  it("retains and retries an outbox update after retryable storage pressure", async () => {
    const harness = createHarness();
    const socket = await bringOnline(harness);
    harness.document.getMap("content").set("quota", "still local");
    harness.timers.advance(0);
    await settle();
    const update = sentFrames(socket)
      .find((frame) => frame.type === BoardMessageType.UPDATE);
    if (update?.type !== BoardMessageType.UPDATE) {
      throw new Error("Expected UPDATE");
    }
    const messageId = messageIdToHex(update.messageId);

    socket.receive({
      type: BoardMessageType.CONTROL,
      generation: scope.generation,
      code: BoardControlCode.STORAGE_ERROR,
      docKey: scope.documentKey,
      messageId: update.messageId,
      payload: new TextEncoder().encode(JSON.stringify({
        reason: "TENANT_QUOTA",
        retryable: true,
        retryAfterMs: 60_000,
      })),
    });
    await settle();
    expect(harness.store.state.pending.has(messageId)).toBe(true);
    expect(harness.provider.status.recovery).toBeNull();

    const baseline = sentFrames(socket).length;
    harness.timers.advance(59_999);
    await settle();
    expect(sentFrames(socket).slice(baseline).some(
      (frame) => frame.type === BoardMessageType.UPDATE,
    )).toBe(false);
    harness.timers.advance(1);
    await settle();
    const retried = sentFrames(socket).slice(baseline)
      .find((frame) => frame.type === BoardMessageType.UPDATE);
    expect(retried?.type).toBe(BoardMessageType.UPDATE);
    if (retried?.type !== BoardMessageType.UPDATE) {
      throw new Error("Expected retried UPDATE");
    }
    expect(messageIdToHex(retried.messageId)).toBe(messageId);
    await harness.provider.stop();
  });

  it("does not reconnect before a retryable server not-before expires", async () => {
    const harness = createHarness();
    const socket = await bringOnline(harness);
    socket.receive({
      type: BoardMessageType.CONTROL,
      generation: scope.generation,
      code: BoardControlCode.STORAGE_ERROR,
      payload: new TextEncoder().encode(JSON.stringify({
        reason: "DISK_PRESSURE",
        retryable: true,
        retryAfterMs: 60_000,
      })),
    });
    socket.serverClose();

    expect(harness.provider.status.connection).toBe("offline");
    expect(harness.timers.nextDelay).toBe(60_000);
    harness.timers.advance(59_999);
    await settle();
    expect(harness.sockets).toHaveLength(1);
    expect(harness.ticketCalls.count).toBe(1);

    harness.timers.advance(1);
    await settle();
    expect(harness.sockets).toHaveLength(2);
    expect(harness.ticketCalls.count).toBe(2);
    await harness.provider.stop();
  });

  it("uses the ordinary ACK retry delay for an invalid retry hint", async () => {
    const harness = createHarness();
    const socket = await bringOnline(harness);
    harness.document.getMap("content").set("invalid-hint", "still durable");
    harness.timers.advance(0);
    await settle();
    const update = sentFrames(socket).find(
      (frame) => frame.type === BoardMessageType.UPDATE,
    );
    if (update?.type !== BoardMessageType.UPDATE) {
      throw new Error("Expected UPDATE");
    }

    socket.receive({
      type: BoardMessageType.CONTROL,
      generation: scope.generation,
      code: BoardControlCode.STORAGE_ERROR,
      docKey: scope.documentKey,
      messageId: update.messageId,
      payload: new TextEncoder().encode(JSON.stringify({
        reason: "TENANT_QUOTA",
        retryable: true,
        retryAfterMs: 60_000.5,
      })),
    });
    const baseline = sentFrames(socket).length;
    harness.timers.advance(999);
    await settle();
    expect(sentFrames(socket).slice(baseline).some(
      (frame) => frame.type === BoardMessageType.UPDATE,
    )).toBe(false);

    harness.timers.advance(1);
    await settle();
    const retried = sentFrames(socket).slice(baseline).find(
      (frame) =>
        frame.type === BoardMessageType.UPDATE
        && messageIdToHex(frame.messageId) === messageIdToHex(update.messageId),
    );
    expect(retried?.type).toBe(BoardMessageType.UPDATE);
    await harness.provider.stop();
  });

  it("removes a proven semantic duplicate through durable shadow replay", async () => {
    const harness = createHarness();
    const socket = await bringOnline(harness);
    harness.document.getMap("content").set("duplicate", "already remote");
    harness.timers.advance(0);
    await settle();
    const update = sentFrames(socket).find(
      (frame) => frame.type === BoardMessageType.UPDATE,
    );
    expect(update?.type).toBe(BoardMessageType.UPDATE);
    if (update?.type !== BoardMessageType.UPDATE) {
      throw new Error("Expected durable UPDATE");
    }
    harness.store.documentUpdates.push(update.update.slice());
    const server = new Y.Doc();
    applyBoardUpdate(server, update.update);

    socket.receive({
      type: BoardMessageType.CONTROL,
      generation: scope.generation,
      code: BoardControlCode.RESYNC_REQUIRED,
      messageId: update.messageId,
      payload: new TextEncoder().encode(JSON.stringify({
        reason: "NO_NEW_INFORMATION",
        retryable: true,
      })),
    });
    await settle();
    const replayRequest = [...sentFrames(socket)].reverse().find(
      (frame) => frame.type === BoardMessageType.SYNC_STEP1,
    );
    expect(replayRequest?.type).toBe(BoardMessageType.SYNC_STEP1);
    if (replayRequest?.type !== BoardMessageType.SYNC_STEP1) {
      throw new Error("Expected a full durable replay request");
    }
    expect(Y.decodeStateVector(replayRequest.stateVector).size).toBe(0);

    socket.receive({
      type: BoardMessageType.SYNC_STEP2,
      generation: scope.generation,
      docKey: scope.documentKey,
      update: encodeBoardUpdate(server),
    });
    socket.receive({
      type: BoardMessageType.SYNC_STEP1,
      generation: scope.generation,
      docKey: scope.documentKey,
      stateVector: encodeBoardStateVector(server),
    });
    await settle();

    expect(harness.store.operations).toContain("rebase:1");
    expect(harness.store.state.pending.size).toBe(0);
    expect(harness.provider.status.pendingUpdateCount).toBe(0);
    expect(harness.provider.status.recovery).toBeNull();
    expect(socket.closed).toBe(false);
    server.destroy();
    await harness.provider.stop();
  });

  it("retries a causal-gap update as soon as an earlier update is ACKed", async () => {
    const harness = createHarness();
    const socket = await bringOnline(harness);
    harness.document.getMap("content").set("first", 1);
    harness.timers.advance(0);
    await settle();
    harness.document.getMap("content").set("second", 2);
    harness.timers.advance(0);
    await settle();
    harness.timers.advance(10);
    await settle();
    const updates = sentFrames(socket).filter(
      (frame): frame is Extract<BoardFrame, {
        type: BoardMessageType.UPDATE;
      }> => frame.type === BoardMessageType.UPDATE,
    );
    expect(updates).toHaveLength(2);
    const [first, second] = updates;

    socket.receive({
      type: BoardMessageType.CONTROL,
      generation: scope.generation,
      code: BoardControlCode.RESYNC_REQUIRED,
      messageId: second.messageId,
      payload: new TextEncoder().encode(JSON.stringify({
        reason: "CAUSAL_GAP",
        retryable: true,
      })),
    });
    await settle();
    const baseline = sentFrames(socket).length;
    socket.receive({
      type: BoardMessageType.ACK,
      generation: scope.generation,
      docKey: scope.documentKey,
      messageId: first.messageId,
      durableSequence: 1,
    });
    await settle();
    harness.timers.advance(10);
    await settle();

    const retried = sentFrames(socket).slice(baseline).find(
      (frame) =>
        frame.type === BoardMessageType.UPDATE
        && messageIdToHex(frame.messageId) === messageIdToHex(second.messageId),
    );
    expect(retried?.type).toBe(BoardMessageType.UPDATE);
    expect(harness.provider.status.recovery).toBeNull();
    expect(socket.closed).toBe(false);
    await harness.provider.stop();
  });

  it("rebases an IndexedDB-only predecessor into a restart-safe outbox update", async () => {
    const document = new Y.Doc();
    const localUpdates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => localUpdates.push(update.slice());
    document.on("update", collect);
    const text = document.getText("content");
    text.insert(0, "A");
    text.insert(1, "B");
    document.off("update", collect);
    const successor = localUpdates[1];
    expect(successor).toBeDefined();

    const originalMessageId = new Uint8Array(16).fill(90);
    const store = new MemoryPersistence({
      pending: new Map([[
        messageIdToHex(originalMessageId),
        {
          messageId: originalMessageId,
          generation: scope.generation,
          documentKey: scope.documentKey,
          update: successor,
          createdAt: 10,
          queueOrder: 1,
        },
      ]]),
      recovery: null,
    });
    store.documentUpdates.push(...localUpdates.map((update) => update.slice()));
    const harness = createHarness({ document, store });
    const socket = await bringOnline(harness);
    const original = sentFrames(socket).find(
      (frame) => frame.type === BoardMessageType.UPDATE,
    );
    expect(original?.type).toBe(BoardMessageType.UPDATE);

    socket.receive({
      type: BoardMessageType.CONTROL,
      generation: scope.generation,
      code: BoardControlCode.RESYNC_REQUIRED,
      messageId: originalMessageId,
      payload: new TextEncoder().encode(JSON.stringify({
        reason: "CAUSAL_GAP",
        retryable: true,
      })),
    });
    await settle();
    const recoverySync = [...sentFrames(socket)].reverse().find(
      (frame) => frame.type === BoardMessageType.SYNC_STEP1,
    );
    expect(recoverySync?.type).toBe(BoardMessageType.SYNC_STEP1);
    if (recoverySync?.type !== BoardMessageType.SYNC_STEP1) {
      throw new Error("Expected a full-state causal recovery request");
    }
    expect(Y.decodeStateVector(recoverySync.stateVector).size).toBe(0);

    const server = new Y.Doc();
    socket.receive({
      type: BoardMessageType.SYNC_STEP1,
      generation: scope.generation,
      docKey: scope.documentKey,
      stateVector: encodeBoardStateVector(server),
    });
    await settle();

    const pending = [...store.state.pending.values()];
    expect(pending).toHaveLength(1);
    expect(messageIdToHex(pending[0].messageId)).not.toBe(
      messageIdToHex(originalMessageId),
    );
    applyBoardUpdate(server, pending[0].update);
    expect(server.getText("content").toString()).toBe("AB");
    expect(store.operations).toContain("rebase:1");

    socket.receive({
      type: BoardMessageType.ACK,
      generation: scope.generation,
      docKey: scope.documentKey,
      messageId: pending[0].messageId,
      durableSequence: 1,
    });
    await settle();
    expect(store.state.pending.size).toBe(0);
    expect(harness.provider.status.pendingUpdateCount).toBe(0);
    expect(sentFrames(socket).some(
      (frame) =>
        frame.type === BoardMessageType.SYNC_STEP1
        && Y.decodeStateVector(frame.stateVector).size > 0,
    )).toBe(true);
    expect(harness.provider.status.recovery).toBeNull();
    expect(socket.closed).toBe(false);
    await harness.provider.stop();
  });

  it("drops stale in-memory pending rows after losing the outbox rebase CAS", async () => {
    const document = new Y.Doc();
    const localUpdates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => localUpdates.push(update.slice());
    document.on("update", collect);
    const text = document.getText("content");
    text.insert(0, "A");
    text.insert(1, "B");
    document.off("update", collect);
    const successor = localUpdates[1];
    expect(successor).toBeDefined();

    const staleMessageId = new Uint8Array(16).fill(91);
    const store = new MemoryPersistence({
      pending: new Map([[
        messageIdToHex(staleMessageId),
        {
          messageId: staleMessageId,
          generation: scope.generation,
          documentKey: scope.documentKey,
          update: successor,
          createdAt: 10,
          queueOrder: 1,
        },
      ]]),
      recovery: null,
    });
    store.documentUpdates.push(...localUpdates.map((update) => update.slice()));
    store.beforeRebasePendingUpdates = () => {
      store.state.pending.clear();
    };
    const harness = createHarness({ document, store });
    const socket = await bringOnline(harness);
    const stale = sentFrames(socket).find(
      (frame) =>
        frame.type === BoardMessageType.UPDATE
        && messageIdToHex(frame.messageId) === messageIdToHex(staleMessageId),
    );
    expect(stale?.type).toBe(BoardMessageType.UPDATE);

    socket.receive({
      type: BoardMessageType.CONTROL,
      generation: scope.generation,
      code: BoardControlCode.RESYNC_REQUIRED,
      messageId: staleMessageId,
      payload: new TextEncoder().encode(JSON.stringify({
        reason: "CAUSAL_GAP",
        retryable: true,
      })),
    });
    await settle();
    const recoverySync = [...sentFrames(socket)].reverse().find(
      (frame) => frame.type === BoardMessageType.SYNC_STEP1,
    );
    expect(recoverySync?.type).toBe(BoardMessageType.SYNC_STEP1);
    const baseline = sentFrames(socket).length;

    const server = new Y.Doc();
    socket.receive({
      type: BoardMessageType.SYNC_STEP1,
      generation: scope.generation,
      docKey: scope.documentKey,
      stateVector: encodeBoardStateVector(server),
    });
    await settle();

    expect(store.operations).toContain("rebase:1");
    expect(store.state.pending.size).toBe(0);
    expect(harness.provider.status.pendingUpdateCount).toBe(0);
    expect(harness.provider.status.recovery).toBeNull();
    expect(sentFrames(socket).slice(baseline).some(
      (frame) => frame.type === BoardMessageType.UPDATE,
    )).toBe(false);
    harness.timers.advance(1_000);
    await settle();
    expect(sentFrames(socket).slice(baseline).some(
      (frame) => frame.type === BoardMessageType.UPDATE,
    )).toBe(false);

    server.destroy();
    await harness.provider.stop();
  });

  it("includes unresolved delete-set dependencies in a causal rebase", async () => {
    const document = new Y.Doc();
    const localUpdates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => localUpdates.push(update.slice());
    document.on("update", collect);
    const text = document.getText("content");
    text.insert(0, "temporary");
    text.delete(0, text.length);
    document.off("update", collect);
    const deletion = localUpdates[1];
    expect(deletion).toBeDefined();

    const messageId = new Uint8Array(16).fill(91);
    const store = new MemoryPersistence({
      pending: new Map([[
        messageIdToHex(messageId),
        {
          messageId,
          generation: scope.generation,
          documentKey: scope.documentKey,
          update: deletion,
          createdAt: 20,
          queueOrder: 1,
        },
      ]]),
      recovery: null,
    });
    store.documentUpdates.push(...localUpdates.map((update) => update.slice()));
    const harness = createHarness({ document, store });
    const socket = await bringOnline(harness);
    socket.receive({
      type: BoardMessageType.CONTROL,
      generation: scope.generation,
      code: BoardControlCode.RESYNC_REQUIRED,
      messageId,
      payload: new TextEncoder().encode(JSON.stringify({
        reason: "CAUSAL_GAP",
        retryable: true,
      })),
    });
    await settle();

    const server = new Y.Doc();
    socket.receive({
      type: BoardMessageType.SYNC_STEP1,
      generation: scope.generation,
      docKey: scope.documentKey,
      stateVector: encodeBoardStateVector(server),
    });
    await settle();
    const [replacement] = [...store.state.pending.values()];
    expect(replacement).toBeDefined();
    const decoded = Y.decodeUpdate(replacement.update);
    expect(decoded.structs.length).toBeGreaterThan(0);
    expect(decoded.ds.clients.size).toBeGreaterThan(0);
    applyBoardUpdate(server, replacement.update);
    expect(server.getText("content").toString()).toBe("");
    expect(stateVectorsEqual(
      encodeBoardStateVector(server),
      encodeBoardStateVector(document),
    )).toBe(true);
    await harness.provider.stop();
  });

  it("adopts durable history written by another tab during causal repair", async () => {
    const document = new Y.Doc();
    const localUpdates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => localUpdates.push(update.slice());
    document.on("update", collect);
    const text = document.getText("content");
    text.insert(0, "A");
    text.insert(1, "B");
    document.off("update", collect);
    const otherTab = new Y.Doc();
    otherTab.getMap("other-tab").set("value", "durable");
    const otherTabUpdate = encodeBoardUpdate(otherTab);
    const successorMessageId = new Uint8Array(16).fill(93);
    const otherTabMessageId = new Uint8Array(16).fill(94);
    const pending = new Map<string, PendingBoardUpdate>([
      [
        messageIdToHex(successorMessageId),
        {
          messageId: successorMessageId,
          generation: scope.generation,
          documentKey: scope.documentKey,
          update: localUpdates[1],
          createdAt: 40,
          queueOrder: 1,
        },
      ],
      [
        messageIdToHex(otherTabMessageId),
        {
          messageId: otherTabMessageId,
          generation: scope.generation,
          documentKey: scope.documentKey,
          update: otherTabUpdate,
          createdAt: 41,
          queueOrder: 2,
        },
      ],
    ]);
    const store = new MemoryPersistence({ pending, recovery: null });
    store.documentUpdates.push(
      ...localUpdates.map((update) => update.slice()),
      otherTabUpdate.slice(),
    );
    const harness = createHarness({ document, store });
    const socket = await bringOnline(harness);
    socket.receive({
      type: BoardMessageType.CONTROL,
      generation: scope.generation,
      code: BoardControlCode.RESYNC_REQUIRED,
      messageId: successorMessageId,
      payload: new TextEncoder().encode(JSON.stringify({
        reason: "CAUSAL_GAP",
        retryable: true,
      })),
    });
    await settle();
    socket.receive({
      type: BoardMessageType.SYNC_STEP1,
      generation: scope.generation,
      docKey: scope.documentKey,
      stateVector: encodeBoardStateVector(new Y.Doc()),
    });
    await settle();

    expect(document.getMap("other-tab").get("value")).toBe("durable");
    expect(store.fullDocumentReadCount).toBeGreaterThan(0);
    expect(harness.provider.status.recovery).toBeNull();
    expect(socket.closed).toBe(false);
    await harness.provider.stop();
  });

  it("rebases a large offline backlog into bounded causal updates", async () => {
    const document = new Y.Doc();
    const documentUpdates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => documentUpdates.push(update.slice());
    document.on("update", collect);
    const content = document.getMap<unknown>("content");
    content.set("predecessor", "A");
    for (let index = 0; index < 17; index += 1) {
      content.set(
        `blob-${index}`,
        new Uint8Array(1024 * 1024).fill(index + 1),
      );
    }
    document.off("update", collect);
    expect(documentUpdates).toHaveLength(18);
    expect(Y.mergeUpdates(documentUpdates).byteLength).toBeGreaterThan(
      BOARD_PROTOCOL_LIMITS.maxUpdateBytes,
    );

    const pending = new Map<string, PendingBoardUpdate>();
    for (const [index, update] of documentUpdates.slice(1).entries()) {
      const messageId = new Uint8Array(16).fill(100 + index);
      pending.set(messageIdToHex(messageId), {
        messageId,
        generation: scope.generation,
        documentKey: scope.documentKey,
        update,
        createdAt: 100 + index,
        queueOrder: index + 1,
      });
    }
    const store = new MemoryPersistence({ pending, recovery: null });
    store.documentUpdates.push(
      ...documentUpdates.map((update) => update.slice()),
    );
    const harness = createHarness({ document, store });
    const socket = await bringOnline(harness);
    const rejectedMessageId = new Uint8Array(16).fill(100);
    socket.receive({
      type: BoardMessageType.CONTROL,
      generation: scope.generation,
      code: BoardControlCode.RESYNC_REQUIRED,
      messageId: rejectedMessageId,
      payload: new TextEncoder().encode(JSON.stringify({
        reason: "CAUSAL_GAP",
        retryable: true,
      })),
    });
    await settle();

    const server = new Y.Doc();
    socket.receive({
      type: BoardMessageType.SYNC_STEP1,
      generation: scope.generation,
      docKey: scope.documentKey,
      stateVector: encodeBoardStateVector(server),
    });
    await settle();

    const replacements = [...store.state.pending.values()]
      .sort((left, right) => (left.queueOrder ?? 0) - (right.queueOrder ?? 0));
    expect(replacements.length).toBeGreaterThan(1);
    expect(replacements.every(
      (update) =>
        update.update.byteLength <= BOARD_PROTOCOL_LIMITS.maxUpdateBytes,
    )).toBe(true);
    expect(replacements.map((update) => update.queueOrder)).toEqual(
      replacements.map((_, index) => index + 1),
    );
    for (const replacement of replacements) {
      applyBoardUpdate(server, replacement.update);
      expect(server.store.pendingStructs).toBeNull();
      expect(server.store.pendingDs).toBeNull();
    }
    expect(stateVectorsEqual(
      encodeBoardStateVector(server),
      encodeBoardStateVector(document),
    )).toBe(true);
    expect(Y.equalDeleteSets(
      Y.createDeleteSetFromStructStore(server.store),
      Y.createDeleteSetFromStructStore(document.store),
    )).toBe(true);
    expect(harness.provider.status.recovery).toBeNull();
    expect(socket.closed).toBe(false);
    await harness.provider.stop();
  });

  it("resumes replay on a new socket when causal preparation is disconnected", async () => {
    const document = new Y.Doc();
    const localUpdates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => localUpdates.push(update.slice());
    document.on("update", collect);
    const text = document.getText("content");
    text.insert(0, "A");
    text.insert(1, "B");
    document.off("update", collect);
    const messageId = new Uint8Array(16).fill(92);
    const store = new MemoryPersistence({
      pending: new Map([[
        messageIdToHex(messageId),
        {
          messageId,
          generation: scope.generation,
          documentKey: scope.documentKey,
          update: localUpdates[1],
          createdAt: 30,
          queueOrder: 1,
        },
      ]]),
      recovery: null,
    });
    store.documentUpdates.push(...localUpdates.map((update) => update.slice()));
    const harness = createHarness({ document, store });
    const firstSocket = await bringOnline(harness);
    firstSocket.receive({
      type: BoardMessageType.CONTROL,
      generation: scope.generation,
      code: BoardControlCode.RESYNC_REQUIRED,
      messageId,
      payload: new TextEncoder().encode(JSON.stringify({
        reason: "CAUSAL_GAP",
        retryable: true,
      })),
    });
    await settle();

    const persistenceGate = new Deferred<void>();
    store.enqueueGate = persistenceGate.promise;
    document.getMap("more").set("after-repair-start", true);
    harness.timers.advance(0);
    await settle();
    firstSocket.receive({
      type: BoardMessageType.SYNC_STEP1,
      generation: scope.generation,
      docKey: scope.documentKey,
      stateVector: encodeBoardStateVector(new Y.Doc()),
    });
    await settle();
    firstSocket.serverClose();

    harness.timers.advance(250);
    await settle();
    const secondSocket = harness.sockets[1];
    expect(secondSocket).toBeDefined();
    secondSocket.open();
    secondSocket.receive(readyFrame());
    await settle();
    expect(sentFrames(secondSocket).filter(
      (frame) => frame.type === BoardMessageType.UPDATE,
    )).toHaveLength(0);

    persistenceGate.resolve();
    await settle();
    expect(sentFrames(secondSocket).some(
      (frame) => frame.type === BoardMessageType.UPDATE,
    )).toBe(true);
    expect(harness.provider.status.connection).toBe("online");
    expect(harness.provider.status.recovery).toBeNull();
    await harness.provider.stop();
  });

  it("abandons a prepared rebase when a local edit occurs during its snapshot", async () => {
    const document = new Y.Doc();
    const localUpdates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => localUpdates.push(update.slice());
    document.on("update", collect);
    const text = document.getText("content");
    text.insert(0, "A");
    text.insert(1, "B");
    document.off("update", collect);
    const messageId = new Uint8Array(16).fill(95);
    const store = new MemoryPersistence({
      pending: new Map([[
        messageIdToHex(messageId),
        {
          messageId,
          generation: scope.generation,
          documentKey: scope.documentKey,
          update: localUpdates[1],
          createdAt: 50,
          queueOrder: 1,
        },
      ]]),
      recovery: null,
    });
    store.documentUpdates.push(...localUpdates.map((update) => update.slice()));
    const harness = createHarness({ document, store });
    const socket = await bringOnline(harness);
    socket.receive({
      type: BoardMessageType.CONTROL,
      generation: scope.generation,
      code: BoardControlCode.RESYNC_REQUIRED,
      messageId,
      payload: new TextEncoder().encode(JSON.stringify({
        reason: "CAUSAL_GAP",
        retryable: true,
      })),
    });
    await settle();

    const snapshotGate = new Deferred<void>();
    const snapshotStarted = new Deferred<void>();
    store.listDocumentGate = snapshotGate.promise;
    store.onListDocumentUpdates = () => snapshotStarted.resolve();
    socket.receive({
      type: BoardMessageType.SYNC_STEP1,
      generation: scope.generation,
      docKey: scope.documentKey,
      stateVector: encodeBoardStateVector(new Y.Doc()),
    });
    await snapshotStarted.promise;
    document.getMap("late").set("value", "C");
    harness.timers.advance(0);
    await settle();
    snapshotGate.resolve();
    await settle();

    expect(store.operations.some((operation) => operation.startsWith("rebase:"))).toBe(false);
    expect(store.state.pending.has(messageIdToHex(messageId))).toBe(true);
    expect(harness.provider.status.recovery).toBeNull();
    expect(socket.closed).toBe(false);
    await harness.provider.stop();
  });
});

describe("BoardNetworkProvider CRDT sync and awareness", () => {
  it("keeps READY presence dirty until the authoritative reread starts sync", async () => {
    const store = new MemoryPersistence();
    const documentRead = new Deferred<void>();
    store.listDocumentGate = documentRead.promise;
    const harness = createHarness({ store });

    await harness.provider.start();
    await settle();

    const socket = harness.sockets[0];
    socket.open();
    socket.receive(readyFrame());
    harness.provider.setPresence({ cursor: { x: 12, y: 34 } });
    harness.timers.advance(0);
    await settle();

    expect(sentFrames(socket).map((frame) => frame.type)).toEqual([
      BoardMessageType.AUTH,
    ]);

    documentRead.resolve();
    await settle();
    await settle();
    expect(harness.timers.nextDelay).toBe(0);
    harness.timers.advance(0);
    await settle();

    const order = sentFrames(socket).map((frame) => frame.type);
    expect(order).toEqual([
      BoardMessageType.AUTH,
      BoardMessageType.SYNC_STEP1,
      BoardMessageType.AWARENESS,
    ]);
    expect(socket.closed).toBe(false);
    await harness.provider.stop();
  });

  it("resets the document sync gate for a reconnecting WebSocket", async () => {
    const harness = createHarness();
    const firstSocket = await bringOnline(harness);
    const documentRead = new Deferred<void>();
    harness.store.listDocumentGate = documentRead.promise;

    firstSocket.serverClose();
    harness.timers.advance(250);
    await settle();
    const secondSocket = harness.sockets[1];
    expect(secondSocket).toBeDefined();
    secondSocket.open();
    secondSocket.receive(readyFrame(scope.generation, 78));
    harness.provider.setPresence({ cursor: { x: 56, y: 78 } });
    harness.timers.advance(0);
    await settle();

    expect(sentFrames(secondSocket).map((frame) => frame.type)).toEqual([
      BoardMessageType.AUTH,
    ]);

    documentRead.resolve();
    await settle();
    await settle();
    expect(harness.timers.nextDelay).toBe(0);
    harness.timers.advance(0);
    await settle();

    expect(sentFrames(secondSocket).map((frame) => frame.type)).toEqual([
      BoardMessageType.AUTH,
      BoardMessageType.SYNC_STEP1,
      BoardMessageType.AWARENESS,
    ]);
    expect(secondSocket.closed).toBe(false);
    await harness.provider.stop();
  });

  it("waits for an offline outbox ACK before syncing and publishing presence", async () => {
    const pending = durablePendingUpdate(0);
    const store = new MemoryPersistence({
      pending: new Map([[messageIdToHex(pending.messageId), pending]]),
      recovery: null,
    });
    const harness = createHarness({ store });

    await harness.provider.start();
    await settle();
    harness.provider.setPresence({ activeTool: "selection" });

    const socket = harness.sockets[0];
    socket.open();
    socket.receive(readyFrame());
    harness.timers.advance(0);
    await settle();
    await settle();

    const beforeAck = sentFrames(socket);
    expect(beforeAck.map((frame) => frame.type)).toEqual([
      BoardMessageType.AUTH,
      BoardMessageType.UPDATE,
    ]);
    const update = beforeAck[1];
    if (update.type !== BoardMessageType.UPDATE) {
      throw new Error("Expected the offline outbox update");
    }

    socket.receive({
      type: BoardMessageType.ACK,
      generation: scope.generation,
      docKey: scope.documentKey,
      messageId: update.messageId,
      durableSequence: 1,
    });
    await settle();
    await settle();
    expect(harness.timers.nextDelay).toBe(0);
    harness.timers.advance(0);
    await settle();

    expect(sentFrames(socket).map((frame) => frame.type)).toEqual([
      BoardMessageType.AUTH,
      BoardMessageType.UPDATE,
      BoardMessageType.SYNC_STEP1,
      BoardMessageType.AWARENESS,
    ]);
    expect(store.state.pending.size).toBe(0);
    expect(socket.closed).toBe(false);
    await harness.provider.stop();
  });

  it("converges offline edits through state-vector diffs despite duplicate frames", async () => {
    const client = new Y.Doc();
    const server = new Y.Doc();
    const harness = createHarness({ document: client });
    const socket = await bringOnline(harness);

    client.getMap("content").set("client", "offline edit");
    harness.timers.advance(0);
    await settle();
    server.getMap("content").set("server", "remote edit");
    const remoteUpdate = encodeBoardUpdate(server);
    const remoteFrame: BoardFrame = {
      type: BoardMessageType.SYNC_STEP2,
      generation: scope.generation,
      docKey: scope.documentKey,
      update: remoteUpdate,
    };
    socket.receive(remoteFrame);
    socket.receive(remoteFrame);
    expect(client.getMap("content").get("server")).toBe("remote edit");

    const baseline = sentFrames(socket).length;
    socket.receive({
      type: BoardMessageType.SYNC_STEP1,
      generation: scope.generation,
      docKey: scope.documentKey,
      stateVector: encodeBoardStateVector(server),
    });
    await settle();
    const response = sentFrames(socket).slice(baseline)
      .find((frame) => frame.type === BoardMessageType.SYNC_STEP2);
    expect(response?.type).toBe(BoardMessageType.SYNC_STEP2);
    if (response?.type !== BoardMessageType.SYNC_STEP2) {
      throw new Error("Expected SYNC_STEP2");
    }
    applyBoardUpdate(server, response.update);
    applyBoardUpdate(server, response.update);

    expect(server.getMap("content").toJSON()).toEqual({
      client: "offline edit",
      server: "remote edit",
    });
    expect(stateVectorsEqual(
      encodeBoardStateVector(client),
      encodeBoardStateVector(server),
    )).toBe(true);
    await harness.provider.stop();
  });

  it("waits for every inbound CHUNK before applying a logical sync update", async () => {
    const harness = createHarness();
    const socket = await bringOnline(harness);
    const logical = encodeBoardFrame({
      type: BoardMessageType.SYNC_STEP2,
      generation: scope.generation,
      docKey: scope.documentKey,
      update: validUpdate("chunked", "complete"),
    });
    const splitAt = Math.floor(logical.byteLength / 2);
    const reassemblyId = Uint8Array.from({ length: 16 }, (_, index) => index);

    socket.receive({
      type: BoardMessageType.CHUNK,
      messageId: reassemblyId,
      innerType: BoardMessageType.SYNC_STEP2,
      chunkIndex: 0,
      chunkCount: 2,
      totalLength: logical.byteLength,
      payload: logical.subarray(0, splitAt),
    });
    expect(harness.document.getMap("content").get("chunked")).toBeUndefined();
    expect(socket.closed).toBe(false);

    socket.receive({
      type: BoardMessageType.CHUNK,
      messageId: reassemblyId,
      innerType: BoardMessageType.SYNC_STEP2,
      chunkIndex: 1,
      chunkCount: 2,
      totalLength: logical.byteLength,
      payload: logical.subarray(splitAt),
    });
    expect(harness.document.getMap("content").get("chunked")).toBe("complete");
    expect(socket.closed).toBe(false);
    await harness.provider.stop();
  });

  it("coalesces cursor updates at 25 Hz and sends unchanged selection only once", async () => {
    const harness = createHarness();
    const socket = await bringOnline(harness);
    harness.timers.advance(0);
    await settle();
    const baseline = sentFrames(socket).length;

    harness.provider.setPresence({ cursor: { x: 1, y: 1 } });
    harness.provider.setPresence({ cursor: { x: 2, y: 2 } });
    harness.provider.setPresence({ cursor: { x: 3, y: 3 } });
    harness.timers.advance(39);
    expect(sentFrames(socket).slice(baseline)
      .filter((frame) => frame.type === BoardMessageType.AWARENESS)).toHaveLength(0);
    harness.timers.advance(1);
    await settle();
    expect(sentFrames(socket).slice(baseline)
      .filter((frame) => frame.type === BoardMessageType.AWARENESS)).toHaveLength(1);

    harness.provider.setSelection(["b", "a", "a"]);
    harness.provider.setSelection(["a", "b"]);
    harness.timers.advance(40);
    await settle();
    const awarenessFrames = sentFrames(socket).slice(baseline)
      .filter((frame) => frame.type === BoardMessageType.AWARENESS);
    expect(awarenessFrames).toHaveLength(2);
    expect(awarenessFrames[1]).toMatchObject({
      type: BoardMessageType.AWARENESS,
      awarenessClientId: 77,
    });

    const oversizedSelection = Array.from(
      { length: 300 },
      (_, index) => `object-${index.toString().padStart(3, "0")}`,
    );
    harness.provider.setSelection(oversizedSelection);
    harness.provider.setSelection(oversizedSelection.slice(0, 256));
    harness.timers.advance(40);
    await settle();
    expect(sentFrames(socket).slice(baseline)
      .filter((frame) => frame.type === BoardMessageType.AWARENESS))
      .toHaveLength(3);
    await harness.provider.stop();
  });

  it("transfers, validates, and clears segmented laser awareness", async () => {
    const sender = createHarness();
    const receiver = createHarness();
    const senderSocket = await bringOnline(sender, 77);
    const receiverSocket = await bringOnline(receiver, 78);
    sender.timers.advance(0);
    receiver.timers.advance(0);
    await settle();
    const baseline = sentFrames(senderSocket).length;
    const points = Array.from({ length: MAX_BOARD_LASER_POINTS }, (_, index) => ({
      x: index,
      y: index * 2,
    }));
    const splitPoint = Math.floor(points.length / 2);
    const strokes = [
      {
        points: points.slice(0, splitPoint),
        style: {
          stroke: "rgb(10, 20, 30)",
          strokeWidth: Number.MAX_VALUE,
          opacity: -2,
        },
      },
      {
        points: points.slice(splitPoint),
        style: {
          stroke: "#d33f49",
          strokeWidth: 7.5,
          opacity: 0,
        },
      },
    ];

    expect(() => sender.provider.setPresence({
      gesturePreview: {
        kind: "laser",
        strokes: [{
          points: [
            ...points,
            { x: MAX_BOARD_LASER_POINTS, y: MAX_BOARD_LASER_POINTS * 2 },
          ],
          style: strokes[0].style,
        }],
      },
    })).toThrow(`limited to ${MAX_BOARD_LASER_POINTS} total points`);
    expect(() => sender.provider.setPresence({
      gesturePreview: {
        kind: "laser",
        strokes: Array.from(
          { length: MAX_BOARD_LASER_STROKES + 1 },
          (_, index) => ({
            points: [{ x: index, y: index }],
            style: strokes[1].style,
          }),
        ),
      },
    })).toThrow(/limited to 16 strokes/u);
    expect(() => sender.provider.setPresence({
      gesturePreview: {
        kind: "laser",
        strokes: [{
          points: points.slice(0, 2),
          style: {
            stroke: "url(javascript:alert(1))",
            strokeWidth: 3,
            opacity: 1,
          },
        }],
      },
    })).toThrow(/laser stroke 0 style is invalid/u);

    sender.provider.setPresence({
      laserPointer: points.at(-1),
      laserClearMode: null,
      gesturePreview: { kind: "laser", strokes },
    });
    sender.timers.advance(40);
    await settle();
    const previewFrame = sentFrames(senderSocket).slice(baseline)
      .filter((frame) => frame.type === BoardMessageType.AWARENESS)
      .at(-1);
    expect(previewFrame?.type).toBe(BoardMessageType.AWARENESS);
    if (previewFrame?.type !== BoardMessageType.AWARENESS) {
      throw new Error("Expected laser AWARENESS frame");
    }
    receiverSocket.receive(previewFrame);
    expect(receiver.provider.awareness.getStates().get(77)).toMatchObject({
      laserPointer: points.at(-1),
      laserClearMode: null,
      gesturePreview: {
        kind: "laser",
        strokes: [
          {
            points: points.slice(0, splitPoint),
            style: {
              stroke: "rgb(10,20,30)",
              strokeWidth: 96,
              opacity: 0,
            },
          },
          strokes[1],
        ],
      },
    });

    sender.provider.setPresence({
      laserPointer: null,
      laserClearMode: "immediate",
      gesturePreview: null,
    });
    sender.timers.advance(40);
    await settle();
    const clearFrame = sentFrames(senderSocket).slice(baseline)
      .filter((frame) => frame.type === BoardMessageType.AWARENESS)
      .at(-1);
    expect(clearFrame?.type).toBe(BoardMessageType.AWARENESS);
    if (clearFrame?.type !== BoardMessageType.AWARENESS) {
      throw new Error("Expected clearing AWARENESS frame");
    }
    receiverSocket.receive(clearFrame);
    expect(receiver.provider.awareness.getStates().get(77)).toMatchObject({
      laserPointer: null,
      laserClearMode: "immediate",
      gesturePreview: null,
    });

    expect(() => sender.provider.setPresence({
      laserClearMode: "later" as "fade",
    })).toThrow(/laserClearMode must be fade, immediate, or null/u);

    await sender.provider.stop();
    await receiver.provider.stop();
  });

  it("bounds and transfers drawing preview style while preserving legacy payloads", async () => {
    const sender = createHarness();
    const receiver = createHarness();
    const senderSocket = await bringOnline(sender, 77);
    const receiverSocket = await bringOnline(receiver, 78);
    sender.timers.advance(0);
    receiver.timers.advance(0);
    await settle();
    const baseline = sentFrames(senderSocket).length;
    const points = [{ x: 1, y: 2 }, { x: 30, y: 40 }];
    const maximumPoints = Array.from(
      { length: MAX_BOARD_GESTURE_PREVIEW_POINTS },
      (_, index) => ({ x: index, y: index * 2 }),
    );

    expect(() => sender.provider.setPresence({
      gesturePreview: { kind: "pen", points: maximumPoints },
    })).not.toThrow();
    expect(() => sender.provider.setPresence({
      gesturePreview: {
        kind: "pen",
        points: [...maximumPoints, { x: 256, y: 512 }],
      },
    })).toThrow(
      `limited to ${MAX_BOARD_GESTURE_PREVIEW_POINTS} points`,
    );

    expect(() => sender.provider.setPresence({
      gesturePreview: {
        kind: "pen",
        points,
        style: {
          stroke: "url(javascript:alert(1))",
          strokeWidth: 3,
          opacity: 1,
        },
      },
    })).toThrow(/style is invalid/u);

    sender.provider.setPresence({
      gesturePreview: {
        kind: "pen",
        points,
        style: {
          stroke: "rgb(10, 20, 30)",
          strokeWidth: Number.MAX_VALUE,
          opacity: -2,
        },
      },
    });
    sender.timers.advance(40);
    await settle();
    const styledFrame = sentFrames(senderSocket).slice(baseline)
      .filter((frame) => frame.type === BoardMessageType.AWARENESS)
      .at(-1);
    expect(styledFrame?.type).toBe(BoardMessageType.AWARENESS);
    if (styledFrame?.type !== BoardMessageType.AWARENESS) {
      throw new Error("Expected styled drawing AWARENESS frame");
    }
    receiverSocket.receive(styledFrame);
    expect(receiver.provider.awareness.getStates().get(77)).toMatchObject({
      gesturePreview: {
        kind: "pen",
        points,
        style: {
          stroke: "rgb(10,20,30)",
          strokeWidth: 96,
          opacity: 0,
        },
      },
    });

    sender.provider.setPresence({
      gesturePreview: { kind: "pen", points },
    });
    sender.timers.advance(40);
    await settle();
    const legacyFrame = sentFrames(senderSocket).slice(baseline)
      .filter((frame) => frame.type === BoardMessageType.AWARENESS)
      .at(-1);
    expect(legacyFrame?.type).toBe(BoardMessageType.AWARENESS);
    if (legacyFrame?.type !== BoardMessageType.AWARENESS) {
      throw new Error("Expected legacy drawing AWARENESS frame");
    }
    receiverSocket.receive(legacyFrame);
    const legacyPreview = receiver.provider.awareness.getStates().get(77)
      ?.gesturePreview as Record<string, unknown> | undefined;
    expect(legacyPreview).toMatchObject({ kind: "pen", points });
    expect(legacyPreview).not.toHaveProperty("style");

    await sender.provider.stop();
    await receiver.provider.stop();
  });
});

describe("BoardNetworkProvider recovery isolation", () => {
  it("keeps adopting durable cross-tab work after a recovery marker", async () => {
    const harness = createHarness();
    const socket = await bringOnline(harness);
    const beforeRecovery = validUpdate("before-recovery", "durable");
    const pendingBeforeRecovery = durablePendingUpdate(
      240,
      validUpdate("pending-before-recovery", "durable"),
    );
    const recovery: BoardRecoverySignal = {
      reason: "permission-revoked",
      generation: scope.generation,
      documentKey: scope.documentKey,
      occurredAt: 123,
      controlCode: BoardControlCode.PERMISSION_CHANGED,
      payload: new Uint8Array([7, 8]),
    };
    harness.store.documentUpdates.push(beforeRecovery);
    harness.store.state.pending.set(
      messageIdToHex(pendingBeforeRecovery.messageId),
      pendingBeforeRecovery,
    );
    await harness.store.setRecoverySignal(recovery);
    harness.store.emitExternalLocalChange();
    await settle();

    expect(harness.provider.status.connection).toBe("recovery-required");
    expect(harness.provider.status.recovery).toEqual(recovery);
    expect(harness.provider.status.pendingUpdateCount).toBe(1);
    expect(harness.document.getMap("content").toJSON()).toMatchObject({
      "before-recovery": "durable",
      "pending-before-recovery": "durable",
    });
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(4008);
    expect(socket.closeReason).toBe("Board recovery fork required");

    const afterRecovery = validUpdate("after-recovery", "durable");
    const pendingAfterRecovery = durablePendingUpdate(
      241,
      validUpdate("pending-after-recovery", "durable"),
    );
    harness.store.documentUpdates.push(afterRecovery);
    harness.store.state.pending.set(
      messageIdToHex(pendingAfterRecovery.messageId),
      pendingAfterRecovery,
    );
    harness.store.emitExternalLocalChange();
    await settle();

    expect(harness.provider.status.connection).toBe("recovery-required");
    expect(harness.provider.status.pendingUpdateCount).toBe(2);
    expect(harness.document.getMap("content").toJSON()).toMatchObject({
      "after-recovery": "durable",
      "pending-after-recovery": "durable",
    });
    await harness.provider.stop();
  });

  it("does not answer server sync while a recovery-marker reread is blocked", async () => {
    const harness = createHarness();
    const socket = await bringOnline(harness);
    harness.document.getMap("content").set("local", "not for stale sync");
    harness.timers.advance(0);
    await settle();

    const reconciliationGate = new Deferred<void>();
    const reconciliationStarted = new Deferred<void>();
    harness.store.listDocumentGate = reconciliationGate.promise;
    harness.store.onListDocumentUpdates = () => reconciliationStarted.resolve();
    harness.store.state.recovery = {
      reason: "permission-revoked",
      generation: scope.generation,
      documentKey: scope.documentKey,
      occurredAt: 456,
    };
    harness.store.emitExternalLocalChange();
    await reconciliationStarted.promise;

    const baseline = sentFrames(socket).length;
    socket.receive({
      type: BoardMessageType.SYNC_STEP1,
      generation: scope.generation,
      docKey: scope.documentKey,
      stateVector: encodeBoardStateVector(new Y.Doc()),
    });
    await settle();
    expect(sentFrames(socket).slice(baseline).some(
      (frame) => frame.type === BoardMessageType.SYNC_STEP2,
    )).toBe(false);

    harness.store.listDocumentGate = null;
    reconciliationGate.resolve();
    await settle();
    expect(harness.provider.status.connection).toBe("recovery-required");
    expect(sentFrames(socket).slice(baseline).some(
      (frame) => frame.type === BoardMessageType.SYNC_STEP2,
    )).toBe(false);
    await harness.provider.stop();
  });

  it("waits for durable recovery persistence before stop completes", async () => {
    const harness = createHarness();
    await harness.provider.start();
    await settle();
    const socket = harness.sockets[0];
    socket.open();
    const recoveryGate = new Deferred<void>();
    harness.store.recoveryGate = recoveryGate.promise;
    socket.receive(readyFrame(scope.generation + 1));
    await settle();

    let stopped = false;
    const stop = harness.provider.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    expect(harness.store.state.recovery).toBeNull();

    recoveryGate.resolve();
    await stop;
    expect(stopped).toBe(true);
    expect(harness.store.state.recovery?.reason).toBe("generation-mismatch");
  });

  it("adopts a newer authoritative recovery marker while already isolated", async () => {
    const harness = createHarness();
    await bringOnline(harness);
    const first: BoardRecoverySignal = {
      reason: "permission-revoked",
      generation: scope.generation,
      documentKey: scope.documentKey,
      occurredAt: 100,
    };
    const second: BoardRecoverySignal = {
      reason: "lifecycle-revoked",
      generation: scope.generation,
      documentKey: scope.documentKey,
      occurredAt: 200,
      payload: new Uint8Array([9]),
    };
    harness.store.state.recovery = first;
    harness.store.emitExternalLocalChange();
    await settle();
    expect(harness.provider.status.recovery).toEqual(first);

    harness.store.state.recovery = second;
    harness.store.emitExternalLocalChange();
    await settle();
    expect(harness.provider.status.recovery).toEqual(second);
    await harness.provider.stop();
  });

  it("isolates an invalid-scope local marker instead of reconnecting forever", async () => {
    const store = new MemoryPersistence({
      pending: new Map(),
      recovery: {
        reason: "generation-mismatch",
        generation: scope.generation + 1,
        documentKey: scope.documentKey,
        occurredAt: 300,
      },
    });
    const harness = createHarness({ store });
    await harness.provider.start();
    await settle();

    expect(harness.provider.status.connection).toBe("recovery-required");
    expect(harness.provider.status.localDurability).toBe("at-risk");
    expect(harness.provider.status.lastError).toMatch(/another scope/u);
    expect(harness.sockets).toHaveLength(0);
    expect(harness.timers.nextDelay).toBeNull();
    await harness.provider.stop();
  });

  it("stops on generation mismatch, persists recovery, and retains pending updates", async () => {
    const shared: MemoryPersistenceState = {
      pending: new Map(),
      recovery: null,
    };
    const pending: PendingBoardUpdate = {
      messageId: new Uint8Array(16).fill(5),
      generation: scope.generation,
      documentKey: scope.documentKey,
      update: validUpdate("pending", "local"),
      createdAt: 1,
    };
    shared.pending.set(messageIdToHex(pending.messageId), pending);
    const harness = createHarness({ store: new MemoryPersistence(shared) });
    await harness.provider.start();
    await settle();
    const socket = harness.sockets[0];
    socket.open();
    socket.receive(readyFrame(2));
    await settle();

    expect(harness.provider.status.connection).toBe("recovery-required");
    expect(harness.provider.status.recovery?.reason).toBe("generation-mismatch");
    expect(shared.recovery?.reason).toBe("generation-mismatch");
    expect(shared.pending.size).toBe(1);
    expect(socket.closed).toBe(true);

    const restarted = createHarness({ store: new MemoryPersistence(shared) });
    await restarted.provider.start();
    await settle();
    expect(restarted.provider.status.connection).toBe("recovery-required");
    expect(restarted.sockets).toHaveLength(0);
    await harness.provider.stop();
    await restarted.provider.stop();
  });

  it("turns a rejected durable update into a local recovery signal without ACK deletion", async () => {
    const harness = createHarness();
    const socket = await bringOnline(harness);
    harness.document.getMap("content").set("rejected", "still local");
    harness.timers.advance(0);
    await settle();
    const update = sentFrames(socket)
      .find((frame) => frame.type === BoardMessageType.UPDATE);
    if (update?.type !== BoardMessageType.UPDATE) throw new Error("Expected UPDATE");

    socket.receive({
      type: BoardMessageType.CONTROL,
      generation: scope.generation,
      code: BoardControlCode.UPDATE_REJECTED,
      docKey: scope.documentKey,
      messageId: update.messageId,
      payload: new TextEncoder().encode("permission"),
    });
    await settle();
    expect(harness.provider.status.recovery?.reason).toBe("update-rejected");
    expect(harness.store.state.pending.has(messageIdToHex(update.messageId))).toBe(true);
    expect(harness.store.state.recovery?.messageId).toEqual(update.messageId);
    await harness.provider.stop();
  });

  it("adopts a cross-tab outbox rebase instead of entering false recovery", async () => {
    const harness = createHarness();
    const socket = await bringOnline(harness);
    harness.document.getMap("content").set("shared-tab", "durable");
    harness.timers.advance(0);
    await settle();
    const stale = sentFrames(socket)
      .find((frame) => frame.type === BoardMessageType.UPDATE);
    if (stale?.type !== BoardMessageType.UPDATE) throw new Error("Expected UPDATE");
    const staleStored = harness.store.state.pending.get(
      messageIdToHex(stale.messageId),
    );
    if (!staleStored) throw new Error("Expected a durable stale update");

    const replacement = {
      ...staleStored,
      messageId: new Uint8Array(16).fill(201),
      update: encodeBoardUpdate(harness.document),
    };
    harness.store.state.pending.delete(messageIdToHex(stale.messageId));
    harness.store.state.pending.set(
      messageIdToHex(replacement.messageId),
      clonePending(replacement),
    );
    const baseline = sentFrames(socket).length;

    socket.receive({
      type: BoardMessageType.CONTROL,
      generation: scope.generation,
      code: BoardControlCode.UPDATE_REJECTED,
      docKey: scope.documentKey,
      messageId: stale.messageId,
      payload: new TextEncoder().encode(JSON.stringify({
        reason: "INVALID_UPDATE",
      })),
    });
    await settle();
    harness.timers.advance(10);
    await settle();

    expect(harness.provider.status.recovery).toBeNull();
    expect(harness.provider.status.pendingUpdateCount).toBe(1);
    const adopted = sentFrames(socket).slice(baseline).find(
      (frame) =>
        frame.type === BoardMessageType.UPDATE
        && messageIdToHex(frame.messageId)
          === messageIdToHex(replacement.messageId),
    );
    expect(adopted?.type).toBe(BoardMessageType.UPDATE);
    await harness.provider.stop();
  });
});
