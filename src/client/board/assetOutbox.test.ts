import "fake-indexeddb/auto";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssetLocalPersistenceError,
  AssetTransportError,
  AssetUploadCoordinator,
  BoardAssetOutbox,
  assetOutboxDatabaseName,
  type AssetOutboxBroadcastChannel,
  type AssetOutboxIdentity,
  type AssetUploadTransport,
  type RemoteAssetReady,
} from "./assetOutbox.js";

const outboxes: BoardAssetOutbox[] = [];

function identity(generation = 1): AssetOutboxIdentity {
  return {
    userId: randomUUID(),
    boardId: randomUUID(),
    generation,
  };
}

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestBlob(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((value) => hash(new Uint8Array(value)));
}

function digestBytes(value: Uint8Array): Promise<string> {
  return Promise.resolve(hash(value));
}

function makeOutbox(
  scope: AssetOutboxIdentity,
  options: {
    now?: () => number;
    maxLocalAssetBytes?: number;
    broadcastChannelFactory?: (name: string) => AssetOutboxBroadcastChannel | null;
    indexedDB?: IDBFactory;
  } = {},
): BoardAssetOutbox {
  const outbox = new BoardAssetOutbox(scope, {
    digestBlob,
    digestBytes,
    now: options.now,
    maxLocalAssetBytes: options.maxLocalAssetBytes,
    broadcastChannelFactory: options.broadcastChannelFactory,
    indexedDB: options.indexedDB,
  });
  outboxes.push(outbox);
  return outbox;
}

function createBroadcastChannelHarness(): {
  factory: (name: string) => AssetOutboxBroadcastChannel;
  messages: unknown[];
} {
  const channels = new Map<string, Set<{
    listeners: Set<(event: MessageEvent<unknown>) => void>;
  }>>();
  const messages: unknown[] = [];
  return {
    messages,
    factory: (name) => {
      const entry = {
        listeners: new Set<(event: MessageEvent<unknown>) => void>(),
      };
      const peers = channels.get(name) ?? new Set();
      peers.add(entry);
      channels.set(name, peers);
      return {
        postMessage(message) {
          messages.push(message);
          for (const peer of peers) {
            if (peer === entry) continue;
            for (const listener of peer.listeners) {
              queueMicrotask(() => listener({ data: message } as MessageEvent<unknown>));
            }
          }
        },
        addEventListener(_type, listener) {
          entry.listeners.add(listener);
        },
        removeEventListener(_type, listener) {
          entry.listeners.delete(listener);
        },
        close() {
          peers.delete(entry);
        },
      };
    },
  };
}

function ready(assetId: string, bytes: Uint8Array): RemoteAssetReady {
  return {
    assetId,
    sha256: hash(bytes),
    byteSize: bytes.byteLength,
    mimeType: "image/png",
    width: 2,
    height: 2,
    frameCount: 1,
    totalDecodedPixels: 4,
    publishedAt: "2026-07-28T00:00:00.000Z",
  };
}

afterEach(async () => {
  for (const outbox of outboxes.splice(0)) {
    try {
      await outbox.clear();
    } catch {
      await outbox.close();
    }
  }
});

describe("BoardAssetOutbox", () => {
  it("uses a user, board, and generation scoped database name", () => {
    const scope = {
      userId: "018f7791-d659-7811-a418-b6226ee77be1",
      boardId: "018f7791-d659-7811-a418-b6226ee77be2",
      generation: 3,
    };
    expect(assetOutboxDatabaseName(scope)).toBe(
      "eduri-board-v2-assets:018f7791-d659-7811-a418-b6226ee77be1:"
      + "018f7791-d659-7811-a418-b6226ee77be2:3",
    );
    expect(() => assetOutboxDatabaseName({ ...scope, generation: 0 }))
      .toThrow("generation must be a positive safe integer");
  });

  it("retries a terminal IndexedDB open instead of caching its rejection", async () => {
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const firstRequest = {
      result: {
        close: firstClose,
        onversionchange: null,
      } as unknown as IDBDatabase,
      error: null as DOMException | null,
      transaction: null,
      onupgradeneeded: null as IDBOpenDBRequest["onupgradeneeded"],
      onsuccess: null as IDBOpenDBRequest["onsuccess"],
      onerror: null as IDBOpenDBRequest["onerror"],
      onblocked: null as IDBOpenDBRequest["onblocked"],
    };
    const secondRequest = {
      ...firstRequest,
      result: {
        close: secondClose,
        onversionchange: null,
      } as unknown as IDBDatabase,
    };
    const open = vi.fn()
      .mockReturnValueOnce(firstRequest as unknown as IDBOpenDBRequest)
      .mockReturnValueOnce(secondRequest as unknown as IDBOpenDBRequest);
    const outbox = makeOutbox(identity(), {
      indexedDB: { open } as unknown as IDBFactory,
      broadcastChannelFactory: () => null,
    });
    const firstReady = outbox.whenReady();
    firstRequest.error = new DOMException("terminal", "UnknownError");
    firstRequest.onerror?.call(
      firstRequest as unknown as IDBOpenDBRequest,
      new Event("error"),
    );
    await expect(firstReady).rejects.toBe(firstRequest.error);
    await expect(outbox.close()).resolves.toBeUndefined();

    const secondReady = outbox.whenReady();
    expect(open).toHaveBeenCalledTimes(2);
    secondRequest.onsuccess?.call(
      secondRequest as unknown as IDBOpenDBRequest,
      new Event("success"),
    );
    await expect(secondReady).resolves.toBeUndefined();

    firstRequest.onsuccess?.call(
      firstRequest as unknown as IDBOpenDBRequest,
      new Event("success"),
    );
    expect(firstClose).toHaveBeenCalledTimes(1);
    await outbox.close();
    expect(secondClose).toHaveBeenCalledTimes(1);
    outboxes.splice(outboxes.indexOf(outbox), 1);
  });

  it("durably stores the original blob and upload state across reloads", async () => {
    const scope = identity();
    const bytes = Uint8Array.of(1, 2, 3, 4, 5);
    const assetId = randomUUID();
    const first = makeOutbox(scope);
    const queued = await first.enqueueLocal({
      assetId,
      blob: new Blob([bytes], { type: "image/png" }),
      originalFileName: "plot.png",
    });
    expect(queued).toMatchObject({
      assetId,
      state: "pending",
      sha256: hash(bytes),
      byteSize: bytes.byteLength,
    });
    await first.setUploadSession(assetId, {
      uploadId: randomUUID(),
      nextOffset: 3,
      chunkBytes: 3,
    });
    await first.close();
    outboxes.splice(outboxes.indexOf(first), 1);

    const reloaded = makeOutbox(scope);
    const stored = await reloaded.get(assetId);
    expect(stored).toMatchObject({ state: "uploading", nextOffset: 3 });
    expect(new Uint8Array(await stored!.blob!.arrayBuffer())).toEqual(bytes);

    await reloaded.markReady(assetId, ready(assetId, bytes));
    const published = await reloaded.get(assetId);
    expect(published?.state).toBe("ready");
    expect(new Uint8Array(await published!.blob!.arrayBuffer())).toEqual(bytes);
  });

  it("surfaces local persistence failure without mutating or discarding the caller blob", async () => {
    const source = new Blob([Uint8Array.of(1, 2, 3)], { type: "image/png" });
    const outbox = makeOutbox(identity());
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new DOMException("quota exhausted", "QuotaExceededError");
    });
    await expect(outbox.enqueueLocal({ blob: source })).rejects.toMatchObject({
      code: "LOCAL_QUOTA",
    });
    expect(source.size).toBe(3);
    expect(await outbox.list()).toEqual([]);
    put.mockRestore();
  });

  it("enforces a per-asset limit without imposing an aggregate outbox cap", async () => {
    const outbox = makeOutbox(identity(), { maxLocalAssetBytes: 4 });
    await outbox.enqueueLocal({ blob: new Blob([Uint8Array.of(1, 2, 3, 4)]) });
    await outbox.enqueueLocal({ blob: new Blob([Uint8Array.of(5, 6, 7, 8)]) });
    expect(await outbox.list()).toHaveLength(2);
    await expect(outbox.enqueueLocal({ blob: new Blob([new Uint8Array(5)]) }))
      .rejects.toMatchObject({ code: "LOCAL_ASSET_TOO_LARGE" });
  });

  it("never lets stale work from another tab downgrade a ready asset", async () => {
    const scope = identity();
    const bytes = Uint8Array.of(1, 3, 5, 7);
    const assetId = randomUUID();
    const uploadId = randomUUID();
    const first = makeOutbox(scope);
    const second = makeOutbox(scope);
    await first.enqueueLocal({
      assetId,
      blob: new Blob([bytes], { type: "image/png" }),
    });
    await second.setUploadSession(assetId, {
      uploadId,
      nextOffset: 0,
      chunkBytes: bytes.byteLength,
    });
    await first.markReady(assetId, ready(assetId, bytes));

    await second.setUploadSession(assetId, {
      uploadId: randomUUID(),
      nextOffset: 0,
      chunkBytes: 1,
    });
    await second.acknowledgeOffset(assetId, uploadId, bytes.byteLength);
    await second.resetUpload(assetId, "UPLOAD_GONE", 10);
    await second.recordTransientFailure(assetId, "NETWORK_ERROR", 20);
    await second.markBlocked(assetId, "BOARD_GONE");

    expect(await first.get(assetId)).toMatchObject({
      state: "ready",
      uploadId: null,
      nextOffset: bytes.byteLength,
      lastErrorCode: null,
      published: { sha256: hash(bytes) },
    });
  });

  it("notifies another tab after rereading the authoritative IndexedDB record", async () => {
    const scope = identity();
    const bytes = Uint8Array.of(8, 6, 7, 5);
    const assetId = randomUUID();
    const channels = createBroadcastChannelHarness();
    const first = makeOutbox(scope, {
      broadcastChannelFactory: channels.factory,
    });
    const second = makeOutbox(scope, {
      broadcastChannelFactory: channels.factory,
    });
    await first.trackRemote({
      assetId,
      sha256: hash(bytes),
      byteSize: bytes.byteLength,
      declaredMime: "image/png",
    });
    const events: RemoteAssetReady[] = [];
    second.subscribe((event) => {
      if (event.state === "ready" && event.record.published) {
        events.push(event.record.published);
      }
    });

    await first.cacheRemoteReady(
      assetId,
      ready(assetId, bytes),
      new Blob([bytes], { type: "image/png" }),
    );

    await vi.waitFor(() => expect(events).toHaveLength(1));
    const stored = await second.get(assetId);
    expect(stored).toMatchObject({
      state: "ready",
      published: { sha256: hash(bytes) },
    });
    expect(new Uint8Array(await stored!.blob!.arrayBuffer())).toEqual(bytes);
    expect(channels.messages.at(-1)).toEqual({
      type: "asset-record-changed",
      assetId,
      revision: expect.any(Number),
    });
  });

  it("reports permanent sync risks without losing local recovery bytes", async () => {
    const outbox = makeOutbox(identity());
    const localId = randomUUID();
    const remoteId = randomUUID();
    const bytes = Uint8Array.of(2, 4, 6);
    await outbox.enqueueLocal({
      assetId: localId,
      blob: new Blob([bytes], { type: "image/png" }),
    });
    await outbox.trackRemote({
      assetId: remoteId,
      sha256: hash(bytes),
      byteSize: bytes.byteLength,
      declaredMime: "image/png",
    });
    await outbox.markBlocked(localId, "TENANT_QUOTA");
    await outbox.markBlocked(remoteId, "DECODE_FAILED");

    const health = await outbox.health();
    expect(health).toMatchObject({
      pendingLocalCount: 0,
      pendingRemoteCount: 0,
      readyCount: 0,
    });
    expect(health.blocked).toEqual(expect.arrayContaining([
        {
          assetId: localId,
          source: "local",
          errorCode: "TENANT_QUOTA",
          hasLocalRecoveryCopy: true,
        },
        {
          assetId: remoteId,
          source: "remote",
          errorCode: "DECODE_FAILED",
          hasLocalRecoveryCopy: false,
        },
      ]));
  });
});

describe("AssetUploadCoordinator", () => {
  it("continues an interrupted upload from its durable acknowledged offset after reload", async () => {
    let clock = 1_000;
    const scope = identity();
    const bytes = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9);
    const assetId = randomUUID();
    const uploadId = randomUUID();
    const offsets: number[] = [];
    let failed = false;
    const transport: AssetUploadTransport = {
      begin: async () => ({
        status: "upload",
        uploadId,
        nextOffset: 0,
        chunkBytes: 4,
        expiresAt: "2026-07-29T00:00:00.000Z",
      }),
      writeChunk: async (input) => {
        offsets.push(input.offset);
        if (input.offset === 4 && !failed) {
          failed = true;
          throw new AssetTransportError("NETWORK_ERROR", "offline", "transient");
        }
        return {
          nextOffset: input.offset + input.chunk.byteLength,
          complete: input.offset + input.chunk.byteLength === bytes.byteLength,
          duplicate: false,
        };
      },
      finalize: async () => ready(assetId, bytes),
      status: async () => ({ status: "pending", assetId, sha256: hash(bytes), byteSize: bytes.byteLength }),
      download: async () => new Blob([bytes], { type: "image/png" }),
    };

    const first = makeOutbox(scope, { now: () => clock });
    await first.enqueueLocal({ assetId, blob: new Blob([bytes], { type: "image/png" }) });
    const firstCoordinator = new AssetUploadCoordinator({
      outbox: first,
      transport,
      retryBaseMs: 100,
      random: () => 0.5,
      now: () => clock,
    });
    await expect(firstCoordinator.syncDueOnce(clock)).resolves.toMatchObject({
      attempted: 1,
      deferred: 1,
    });
    expect(await first.get(assetId)).toMatchObject({
      uploadId,
      nextOffset: 4,
      state: "uploading",
      attemptCount: 1,
    });
    await first.close();
    outboxes.splice(outboxes.indexOf(first), 1);

    clock = 2_000;
    const reloaded = makeOutbox(scope, { now: () => clock });
    const secondCoordinator = new AssetUploadCoordinator({
      outbox: reloaded,
      transport,
      retryBaseMs: 100,
      random: () => 0.5,
      now: () => clock,
    });
    await expect(secondCoordinator.syncDueOnce(clock)).resolves.toMatchObject({
      attempted: 1,
      completed: 1,
    });
    expect(await reloaded.get(assetId)).toMatchObject({
      state: "ready",
      nextOffset: bytes.byteLength,
      uploadId: null,
    });
    expect(offsets).toEqual([0, 4, 4, 8]);
    expect(new Uint8Array(await (await reloaded.get(assetId))!.blob!.arrayBuffer())).toEqual(bytes);
  });

  it("automatically retries a transient failure without a manual retry action", async () => {
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const assetId = randomUUID();
    const outbox = makeOutbox(identity());
    await outbox.enqueueLocal({ assetId, blob: new Blob([bytes]) });
    let beginCalls = 0;
    const transport: AssetUploadTransport = {
      begin: async () => {
        beginCalls += 1;
        if (beginCalls === 1) {
          throw new AssetTransportError("NETWORK_ERROR", "temporary", "transient");
        }
        return {
          status: "upload",
          uploadId: randomUUID(),
          nextOffset: 0,
          chunkBytes: 4,
          expiresAt: "2026-07-29T00:00:00.000Z",
        };
      },
      writeChunk: async (input) => ({
        nextOffset: input.offset + input.chunk.byteLength,
        complete: true,
        duplicate: false,
      }),
      finalize: async () => ready(assetId, bytes),
      status: async () => ({ status: "pending", assetId, sha256: hash(bytes), byteSize: bytes.byteLength }),
      download: async () => new Blob([bytes], { type: "image/png" }),
    };
    const coordinator = new AssetUploadCoordinator({
      outbox,
      transport,
      retryBaseMs: 1,
      retryMaxMs: 2,
      idlePollMs: 2,
      random: () => 0.5,
    });
    coordinator.start();
    try {
      await vi.waitFor(async () => {
        expect((await outbox.get(assetId))?.state).toBe("ready");
      }, { timeout: 1_000, interval: 5 });
    } finally {
      coordinator.stop();
    }
    expect(beginCalls).toBeGreaterThanOrEqual(2);
  });

  it("stops scheduling work and drains an active upload before storage closes", async () => {
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const assetId = randomUUID();
    const outbox = makeOutbox(identity());
    await outbox.enqueueLocal({ assetId, blob: new Blob([bytes]) });
    let releaseChunk!: () => void;
    const chunkGate = new Promise<void>((resolve) => {
      releaseChunk = resolve;
    });
    let chunkStarted = false;
    const transport: AssetUploadTransport = {
      begin: async () => ({
        status: "upload",
        uploadId: randomUUID(),
        nextOffset: 0,
        chunkBytes: bytes.byteLength,
        expiresAt: "2026-07-29T00:00:00.000Z",
      }),
      writeChunk: async (input) => {
        chunkStarted = true;
        await chunkGate;
        return {
          nextOffset: input.offset + input.chunk.byteLength,
          complete: true,
          duplicate: false,
        };
      },
      finalize: async () => ready(assetId, bytes),
      status: async () => ({
        status: "pending",
        assetId,
        sha256: hash(bytes),
        byteSize: bytes.byteLength,
      }),
      download: async () => new Blob([bytes], { type: "image/png" }),
    };
    const coordinator = new AssetUploadCoordinator({ outbox, transport });
    const pass = coordinator.syncDueOnce();
    await vi.waitFor(() => expect(chunkStarted).toBe(true));

    let drained = false;
    const stopping = coordinator.stopAndDrain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    releaseChunk();
    await expect(pass).resolves.toMatchObject({ completed: 1 });
    await stopping;
    expect(drained).toBe(true);
    expect((await outbox.get(assetId))?.state).toBe("ready");
  });

  it("discards only a lost server session while retaining bytes for automatic re-upload", async () => {
    let clock = 1_000;
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const assetId = randomUUID();
    const outbox = makeOutbox(identity(), { now: () => clock });
    await outbox.enqueueLocal({ assetId, blob: new Blob([bytes]) });
    await outbox.setUploadSession(assetId, {
      uploadId: randomUUID(),
      nextOffset: 2,
      chunkBytes: 2,
    });
    const transport: AssetUploadTransport = {
      begin: async () => {
        throw new Error("not reached on the first pass");
      },
      writeChunk: async () => {
        throw new AssetTransportError("UPLOAD_GONE", "server staging was lost", "transient");
      },
      finalize: async () => {
        throw new Error("unexpected");
      },
      status: async () => {
        throw new Error("unexpected");
      },
      download: async () => {
        throw new Error("unexpected");
      },
    };
    const coordinator = new AssetUploadCoordinator({
      outbox,
      transport,
      retryBaseMs: 10,
      random: () => 0.5,
      now: () => clock,
    });
    await expect(coordinator.syncDueOnce(clock)).resolves.toMatchObject({ deferred: 1 });
    const reset = await outbox.get(assetId);
    expect(reset).toMatchObject({
      state: "pending",
      uploadId: null,
      nextOffset: 0,
      lastErrorCode: "UPLOAD_GONE",
    });
    expect(new Uint8Array(await reset!.blob!.arrayBuffer())).toEqual(bytes);
    clock += 100;
    expect((await outbox.listDue(clock)).map((record) => record.assetId)).toEqual([assetId]);
  });

  it("retains local bytes as a recovery copy when access is revoked", async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const assetId = randomUUID();
    const outbox = makeOutbox(identity());
    await outbox.enqueueLocal({ assetId, blob: new Blob([bytes]) });
    const transport: AssetUploadTransport = {
      begin: async () => {
        throw new AssetTransportError("BOARD_GONE", "revoked", "access");
      },
      writeChunk: async () => {
        throw new Error("unexpected");
      },
      finalize: async () => {
        throw new Error("unexpected");
      },
      status: async () => {
        throw new Error("unexpected");
      },
      download: async () => {
        throw new Error("unexpected");
      },
    };
    const coordinator = new AssetUploadCoordinator({ outbox, transport });
    await expect(coordinator.syncDueOnce()).resolves.toMatchObject({ blocked: 1 });
    const stored = await outbox.get(assetId);
    expect(stored).toMatchObject({ state: "blocked", lastErrorCode: "BOARD_GONE" });
    expect(new Uint8Array(await stored!.blob!.arrayBuffer())).toEqual(bytes);
  });

  it("repairs a stable remote placeholder through status and ready events", async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const assetId = randomUUID();
    const outbox = makeOutbox(identity());
    await outbox.trackRemote({
      assetId,
      sha256: hash(bytes),
      byteSize: bytes.byteLength,
      declaredMime: "image/png",
    });
    const events: string[] = [];
    outbox.subscribe((event) => events.push(event.state));
    const transport: AssetUploadTransport = {
      begin: async () => {
        throw new Error("unexpected");
      },
      writeChunk: async () => {
        throw new Error("unexpected");
      },
      finalize: async () => {
        throw new Error("unexpected");
      },
      status: async () => ({ status: "ready", ...ready(assetId, bytes) }),
      download: async () => new Blob([bytes], { type: "image/png" }),
    };
    const coordinator = new AssetUploadCoordinator({ outbox, transport });
    await coordinator.repairRemotePlaceholders();
    expect(await outbox.get(assetId)).toMatchObject({
      source: "remote",
      state: "ready",
      published: { width: 2, height: 2 },
    });
    expect(new Uint8Array(
      await (await outbox.get(assetId))!.blob!.arrayBuffer(),
    )).toEqual(bytes);
    expect(events).toContain("ready");

    const secondId = randomUUID();
    await coordinator.handleAssetReady(ready(secondId, bytes));
    expect(await outbox.get(secondId)).toMatchObject({
      source: "remote",
      state: "ready",
      blob: expect.any(Blob),
    });
  });

  it("keeps a pre-upload 404 repairable and downloads it after publication", async () => {
    const bytes = Uint8Array.of(9, 8, 7);
    const assetId = randomUUID();
    const outbox = makeOutbox(identity());
    await outbox.trackRemote({
      assetId,
      sha256: hash(bytes),
      byteSize: bytes.byteLength,
      declaredMime: "image/png",
    });
    let statusCalls = 0;
    const transport: AssetUploadTransport = {
      begin: async () => {
        throw new Error("unexpected");
      },
      writeChunk: async () => {
        throw new Error("unexpected");
      },
      finalize: async () => {
        throw new Error("unexpected");
      },
      status: async () => {
        statusCalls += 1;
        if (statusCalls === 1) {
          throw new AssetTransportError(
            "NOT_FOUND",
            "upload has not begun",
            "access",
          );
        }
        return { status: "ready", ...ready(assetId, bytes) };
      },
      download: async () => new Blob([bytes], { type: "image/png" }),
    };
    const coordinator = new AssetUploadCoordinator({ outbox, transport });

    await coordinator.repairRemotePlaceholders();
    expect(await outbox.get(assetId)).toMatchObject({
      state: "pending",
      lastErrorCode: null,
    });
    await coordinator.repairRemotePlaceholders();
    expect(await outbox.get(assetId)).toMatchObject({
      state: "ready",
      blob: expect.any(Blob),
    });
  });

  it("keeps a repaired remote asset durable across an outbox reload", async () => {
    const scope = identity();
    const bytes = Uint8Array.of(3, 1, 4, 1, 5);
    const assetId = randomUUID();
    const first = makeOutbox(scope);
    await first.trackRemote({
      assetId,
      sha256: hash(bytes),
      byteSize: bytes.byteLength,
      declaredMime: "image/png",
    });
    const transport: AssetUploadTransport = {
      begin: async () => {
        throw new Error("unexpected");
      },
      writeChunk: async () => {
        throw new Error("unexpected");
      },
      finalize: async () => {
        throw new Error("unexpected");
      },
      status: async () => ({ status: "ready", ...ready(assetId, bytes) }),
      download: async () => new Blob([bytes], { type: "image/png" }),
    };
    await new AssetUploadCoordinator({
      outbox: first,
      transport,
    }).repairRemotePlaceholders();
    await first.close();
    outboxes.splice(outboxes.indexOf(first), 1);

    const reloaded = makeOutbox(scope);
    const stored = await reloaded.get(assetId);
    expect(stored).toMatchObject({
      source: "remote",
      state: "ready",
      published: { sha256: hash(bytes) },
    });
    expect(new Uint8Array(await stored!.blob!.arrayBuffer())).toEqual(bytes);
  });

  it("retries a remote download automatically after an offline failure", async () => {
    const bytes = Uint8Array.of(4, 5, 6);
    const assetId = randomUUID();
    const outbox = makeOutbox(identity());
    await outbox.trackRemote({
      assetId,
      sha256: hash(bytes),
      byteSize: bytes.byteLength,
      declaredMime: "image/png",
    });
    let downloads = 0;
    const transport: AssetUploadTransport = {
      begin: async () => {
        throw new Error("unexpected");
      },
      writeChunk: async () => {
        throw new Error("unexpected");
      },
      finalize: async () => {
        throw new Error("unexpected");
      },
      status: async () => ({ status: "ready", ...ready(assetId, bytes) }),
      download: async () => {
        downloads += 1;
        if (downloads === 1) {
          throw new AssetTransportError(
            "NETWORK_ERROR",
            "offline",
            "transient",
          );
        }
        return new Blob([bytes], { type: "image/png" });
      },
    };
    const coordinator = new AssetUploadCoordinator({
      outbox,
      transport,
      idlePollMs: 2,
    });
    coordinator.start();
    try {
      await vi.waitFor(async () => {
        expect((await outbox.get(assetId))?.state).toBe("ready");
      }, { timeout: 1_000, interval: 5 });
    } finally {
      await coordinator.stopAndDrain();
    }
    expect(downloads).toBeGreaterThanOrEqual(2);
    expect(new Uint8Array(
      await (await outbox.get(assetId))!.blob!.arrayBuffer(),
    )).toEqual(bytes);
  });

  it("marks a reused asset ID conflict and keeps the original durable record", async () => {
    const outbox = makeOutbox(identity());
    const assetId = randomUUID();
    await outbox.enqueueLocal({ assetId, blob: new Blob([Uint8Array.of(1)]) });
    await expect(outbox.enqueueLocal({ assetId, blob: new Blob([Uint8Array.of(2)]) }))
      .rejects.toBeInstanceOf(AssetLocalPersistenceError);
    expect(await outbox.get(assetId)).toMatchObject({ byteSize: 1, state: "pending" });
  });
});
