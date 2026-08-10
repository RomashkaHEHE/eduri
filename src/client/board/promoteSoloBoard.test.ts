import "fake-indexeddb/auto";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  BUILTIN_OBJECT_KINDS,
  addBoardObject,
  createLocalCommandOrigin,
  encodeBoardUpdate,
  getPageObjects,
  openPageDocument,
} from "../../board/core";
import { ApiError, type GuestRoom } from "../api";
import {
  AssetTransportError,
  BoardAssetOutbox,
  type AssetOutboxIdentity,
  type AssetUploadTransport,
  type RemoteAssetReady,
} from "./assetOutbox";
import {
  LocalBoardAssetRepository,
  type LocalBoardAssetExport,
} from "./localBoardAssets";
import { BoardIndexedDbStore } from "./localStore";
import type {
  BoardNetworkProviderOptions,
  BoardProviderStatus,
} from "./networkProvider";
import {
  promoteSoloBoardToGuestRoom,
  type SoloBoardPromotionDependencies,
} from "./promoteSoloBoard";
import {
  BOARD_BROWSER_CAPABILITIES,
  type BoardBootstrapTicket,
} from "./ticketSource";
import { BOARD_PROTOCOL_LIMITS } from "../../board/protocol";

const stores: BoardIndexedDbStore[] = [];
const outboxes: BoardAssetOutbox[] = [];

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestBlob(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buffer) => (
    digestBytes(new Uint8Array(buffer))
  ));
}

function createOutbox(identity: AssetOutboxIdentity): BoardAssetOutbox {
  const outbox = new BoardAssetOutbox(identity, {
    digestBlob,
    digestBytes: (bytes) => Promise.resolve(digestBytes(bytes)),
    broadcastChannelFactory: () => null,
  });
  outboxes.push(outbox);
  return outbox;
}

function createStore(
  identity: ConstructorParameters<typeof BoardIndexedDbStore>[0],
  document: Y.Doc,
): BoardIndexedDbStore {
  const store = new BoardIndexedDbStore(identity, document);
  stores.push(store);
  return store;
}

function room(shareId: string): GuestRoom {
  return {
    shareId,
    createdAt: "2026-08-09T08:00:00.000Z",
    lastActivityAt: "2026-08-09T08:00:00.000Z",
    expiresAt: "2026-08-11T08:00:00.000Z",
    roomUrl: `/room/${shareId}`,
    resources: [{
      id: randomUUID(),
      kind: "board",
      ordinal: 0,
      url: `/room/${shareId}/board`,
      createdAt: "2026-08-09T08:00:00.000Z",
      lastActivityAt: "2026-08-09T08:00:00.000Z",
    }],
  };
}

function bootstrap(boardId: string, pageId: string): BoardBootstrapTicket {
  return {
    ticket: "guest-board-ticket",
    socketUrl: "ws://localhost/api/board-v2/sync",
    boardId,
    generation: 1,
    protocolVersion: 1,
    schemaVersion: 1,
    capabilities: BOARD_BROWSER_CAPABILITIES,
    permissions: 3,
    manifestDocumentKey: "manifest",
    defaultPageId: pageId,
    defaultPageDocumentKey: `page:${pageId}`,
  };
}

function initialProviderStatus(): BoardProviderStatus {
  return {
    connection: "idle",
    localDurability: "ready",
    pendingUpdateCount: 0,
    pendingUpdateBytes: 0,
    permissions: 0,
    lastDurableSequence: null,
    recovery: null,
    lastError: null,
  };
}

class ControlledProvider {
  status = initialProviderStatus();
  readonly observedUpdates: Uint8Array[] = [];

  private readonly listeners = new Set<(status: BoardProviderStatus) => void>();
  private updateTask: Promise<void> = Promise.resolve();
  private pendingUpdates = 0;
  private pendingBytes = 0;
  private updateSequence = 0;

  constructor(
    private readonly options: BoardNetworkProviderOptions,
    private readonly acknowledge: Promise<void>,
  ) {}

  subscribe(listener: (status: BoardProviderStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    this.status = { ...this.status, connection: "connecting" };
    this.emit();
    this.options.document.on("update", this.handleUpdate);
  }

  async stop(): Promise<void> {
    this.options.document.off("update", this.handleUpdate);
    this.status = { ...this.status, connection: "stopped" };
    this.emit();
    await this.updateTask;
  }

  private readonly handleUpdate = (update: Uint8Array): void => {
    this.observedUpdates.push(update.slice());
    this.updateSequence += 1;
    const sequence = this.updateSequence;
    const pending = {
      messageId: Uint8Array.from(
        { length: 16 },
        (_, index) => (sequence + index) % 255 + 1,
      ),
      generation: this.options.scope.generation,
      documentKey: this.options.scope.documentKey,
      update: update.slice(),
      createdAt: Date.now(),
    };
    this.pendingUpdates += 1;
    this.pendingBytes += update.byteLength;
    this.status = {
      ...this.status,
      connection: "online",
      localDurability: "writing",
      pendingUpdateCount: this.pendingUpdates,
      pendingUpdateBytes: this.pendingBytes,
      permissions: 3,
    };
    this.emit();
    const persist = async (): Promise<void> => {
      await this.options.localStore.enqueuePendingUpdate(pending);
      await this.acknowledge;
      await this.options.localStore.acknowledgePendingUpdate(
        pending.messageId,
        sequence,
      );
      this.pendingUpdates -= 1;
      this.pendingBytes -= update.byteLength;
      this.status = {
        ...this.status,
        connection: "online",
        localDurability: this.pendingUpdates === 0 ? "ready" : "writing",
        pendingUpdateCount: this.pendingUpdates,
        pendingUpdateBytes: this.pendingBytes,
        lastDurableSequence: sequence,
      };
      this.emit();
    };
    this.updateTask = this.updateTask.then(persist, persist);
  };

  private emit(): void {
    for (const listener of this.listeners) listener(this.status);
  }
}

function imageSource(asset: LocalBoardAssetExport): Y.Doc {
  const document = openPageDocument(new Y.Doc());
  addBoardObject(document, {
    id: randomUUID(),
    kind: BUILTIN_OBJECT_KINDS.text,
    version: 1,
    transform: [20, 30, 240, 52, 0],
    zRank: "a0",
    props: { text: "Solo content" },
  }, createLocalCommandOrigin(randomUUID()));
  addBoardObject(document, {
    id: randomUUID(),
    kind: BUILTIN_OBJECT_KINDS.image,
    version: 1,
    transform: [80, 100, 120, 80, 0],
    zRank: "a1",
    props: {
      assetId: asset.assetId,
      contentHash: asset.sha256,
      mimeType: asset.declaredMime,
      width: 2,
      height: 2,
      originalBytes: asset.byteSize,
    },
  }, createLocalCommandOrigin(randomUUID()));
  return document;
}

function ready(
  input: Parameters<AssetUploadTransport["begin"]>[0],
): RemoteAssetReady {
  return {
    assetId: input.assetId,
    sha256: input.sha256,
    byteSize: input.byteSize,
    mimeType: input.declaredMime,
    width: 2,
    height: 2,
    frameCount: 1,
    totalDecodedPixels: 4,
    publishedAt: "2026-08-09T08:00:01.000Z",
  };
}

afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map((store) => store.destroy()));
  await Promise.allSettled(outboxes.splice(0).map((outbox) => outbox.close()));
});

describe("LocalBoardAssetRepository export", () => {
  it("returns immutable identity metadata with a separate Blob handle", async () => {
    const identity = {
      userId: randomUUID(),
      boardId: randomUUID(),
      generation: 1,
    };
    const outbox = createOutbox(identity);
    const bytes = Uint8Array.of(4, 3, 2, 1);
    const original = new Blob([bytes], { type: "image/png" });
    const stored = await outbox.enqueueLocal({
      assetId: randomUUID(),
      blob: original,
      declaredMime: "image/png",
      originalFileName: "source.png",
    });
    const repository = new LocalBoardAssetRepository(identity, { outbox });

    const exported = await repository.exportLocalAssets();

    expect(Object.isFrozen(exported)).toBe(true);
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      assetId: stored.assetId,
      sha256: stored.sha256,
      byteSize: bytes.byteLength,
      declaredMime: "image/png",
      originalFileName: "source.png",
    });
    expect(exported[0].blob).not.toBe(original);
    expect(new Uint8Array(await exported[0].blob.arrayBuffer())).toEqual(bytes);
    await repository.close();
  });
});

describe("promoteSoloBoardToGuestRoom", () => {
  it("replays a durable multi-update history without creating an oversized frame", async () => {
    const shareId = randomUUID().replaceAll("-", "");
    const boardId = randomUUID();
    const pageId = randomUUID();
    const deviceId = randomUUID().replaceAll("-", "");
    const history: Uint8Array[] = [];
    const rawSource = new Y.Doc();
    rawSource.on("update", (update: Uint8Array) => history.push(update.slice()));
    const source = openPageDocument(rawSource);
    const payloadBytes = Math.floor(
      BOARD_PROTOCOL_LIMITS.maxUpdateBytes / 2,
    ) + 128 * 1024;
    const payloads = source.getMap<Uint8Array>("promotion-test-payloads");
    payloads.set("first", new Uint8Array(payloadBytes).fill(17));
    payloads.set("second", new Uint8Array(payloadBytes).fill(29));
    const aggregate = encodeBoardUpdate(source);

    expect(history.length).toBeGreaterThan(1);
    expect(history.every((update) => (
      update.byteLength <= BOARD_PROTOCOL_LIMITS.maxUpdateBytes
    ))).toBe(true);
    expect(aggregate.byteLength).toBeGreaterThan(
      BOARD_PROTOCOL_LIMITS.maxUpdateBytes,
    );

    const createOversizedRoom = vi.fn(async () => ({
      room: room("not-created"),
      initializationToken: "unused-board-token",
    }));
    await expect(promoteSoloBoardToGuestRoom({
      document: source,
      dependencies: { createDraft: createOversizedRoom },
    })).rejects.toThrow("sync protocol limit");
    expect(createOversizedRoom).not.toHaveBeenCalled();

    const ticket = bootstrap(boardId, pageId);
    const createdRoom = room(shareId);
    let provider: ControlledProvider | null = null;
    const sourceStore = {
      flush: vi.fn(async () => undefined),
      listDocumentUpdates: vi.fn(async () => history.map((update) => (
        update.slice()
      ))),
    };
    await expect(promoteSoloBoardToGuestRoom({
      document: source,
      sourceStore,
      dependencies: {
        createDraft: async () => ({
          room: createdRoom,
          initializationToken: "large-board-token",
        }),
        finalizeDraft: async () => createdRoom,
        cancelDraft: async () => undefined,
        getDeviceId: () => deviceId,
        requestBootstrap: async () => ticket,
        createStore,
        createProvider: (options) => {
          provider = new ControlledProvider(options, Promise.resolve());
          return provider;
        },
        createAssetOutbox: createOutbox,
      },
      timeoutMs: 4_000,
    })).resolves.toEqual(createdRoom);

    expect(sourceStore.flush).toHaveBeenCalledOnce();
    expect(sourceStore.listDocumentUpdates).toHaveBeenCalledOnce();
    const observed = provider!.observedUpdates;
    expect(observed.length).toBe(history.length);
    expect(observed.every((update) => (
      update.byteLength <= BOARD_PROTOCOL_LIMITS.maxUpdateBytes
    ))).toBe(true);
    expect(observed.reduce((total, update) => total + update.byteLength, 0))
      .toBeGreaterThan(BOARD_PROTOCOL_LIMITS.maxUpdateBytes);

    const reopenedDocument = openPageDocument(new Y.Doc());
    const reopenedStore = createStore({
      userId: `guest-device:${deviceId}`,
      boardId,
      generation: 1,
      documentKey: ticket.defaultPageDocumentKey,
    }, reopenedDocument);
    await reopenedStore.whenReady;
    const restored = reopenedDocument.getMap<Uint8Array>(
      "promotion-test-payloads",
    );
    expect(restored.get("first")?.byteLength).toBe(payloadBytes);
    expect(restored.get("second")?.byteLength).toBe(payloadBytes);
  });

  it("waits for the Board ACK and every capability-scoped asset upload", async () => {
    const shareId = randomUUID().replaceAll("-", "");
    const boardId = randomUUID();
    const pageId = randomUUID();
    const deviceId = randomUUID().replaceAll("-", "");
    const bytes = Uint8Array.of(1, 2, 3, 4, 5, 6);
    const asset: LocalBoardAssetExport = {
      assetId: randomUUID(),
      sha256: digestBytes(bytes),
      byteSize: bytes.byteLength,
      declaredMime: "image/png",
      originalFileName: "diagram.png",
      blob: new Blob([bytes], { type: "image/png" }),
    };
    const source = imageSource(asset);
    const sourceBefore = encodeBoardUpdate(source);
    let releaseAck!: () => void;
    const ack = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    let releaseUpload!: () => void;
    const upload = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const uploaded: Array<Parameters<AssetUploadTransport["begin"]>[0]> = [];
    const transport: AssetUploadTransport = {
      begin: async (input) => {
        uploaded.push(input);
        await upload;
        return {
          status: "upload",
          uploadId: randomUUID(),
          nextOffset: 0,
          chunkBytes: input.byteSize,
          expiresAt: "2026-08-09T08:05:00.000Z",
        };
      },
      writeChunk: async (input) => ({
        nextOffset: input.offset + input.chunk.byteLength,
        complete: true,
        duplicate: false,
      }),
      finalize: async ({ assetId }) => ready(
        uploaded.find((item) => item.assetId === assetId)!,
      ),
      status: async () => {
        throw new Error("not used");
      },
      download: async () => {
        throw new Error("not used");
      },
    };
    const createdRoom = room(shareId);
    const ticket = bootstrap(boardId, pageId);
    const finalizeDraft = vi.fn(async () => createdRoom);
    const cancelDraft = vi.fn(async () => undefined);
    const dependencies: Partial<SoloBoardPromotionDependencies> = {
      createDraft: async () => ({
        room: createdRoom,
        initializationToken: "board-draft-token",
      }),
      finalizeDraft,
      cancelDraft,
      getDeviceId: () => deviceId,
      requestBootstrap: async (requestedShareId, requestedDeviceId) => {
        expect(requestedShareId).toBe(shareId);
        expect(requestedDeviceId).toBe(deviceId);
        return ticket;
      },
      createStore,
      createProvider: (options) => new ControlledProvider(options, ack),
      createAssetOutbox: createOutbox,
      createAssetTransport: ({ shareId: endpointShareId, bootstrap: scope }) => {
        expect(endpointShareId).toBe(shareId);
        expect(scope).toBe(ticket);
        return transport;
      },
    };

    let completed = false;
    const promotion = promoteSoloBoardToGuestRoom({
      document: source,
      assets: { exportLocalAssets: async () => [asset] },
      dependencies,
      timeoutMs: 2_000,
    }).then((result) => {
      completed = true;
      return result;
    });

    await expect.poll(() => uploaded.length).toBe(1);
    expect(completed).toBe(false);
    expect(finalizeDraft).not.toHaveBeenCalled();
    releaseAck();
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(finalizeDraft).not.toHaveBeenCalled();
    releaseUpload();
    await expect(promotion).resolves.toEqual(createdRoom);
    expect(finalizeDraft).toHaveBeenCalledWith(
      createdRoom.shareId,
      "board-draft-token",
    );
    expect(cancelDraft).not.toHaveBeenCalled();

    expect(uploaded[0]).toMatchObject({
      assetId: asset.assetId,
      sha256: asset.sha256,
      byteSize: asset.byteSize,
      declaredMime: asset.declaredMime,
      originalFileName: asset.originalFileName,
    });
    expect(encodeBoardUpdate(source)).toEqual(sourceBefore);

    const reopenedDocument = openPageDocument(new Y.Doc());
    const reopenedStore = createStore({
      userId: `guest-device:${deviceId}`,
      boardId,
      generation: 1,
      documentKey: ticket.defaultPageDocumentKey,
    }, reopenedDocument);
    await reopenedStore.whenReady;
    expect(getPageObjects(reopenedDocument).size).toBe(2);
    expect(await reopenedStore.listPendingUpdates()).toHaveLength(0);

    const reopenedOutbox = createOutbox({
      userId: `guest-device:${deviceId}`,
      boardId,
      generation: 1,
    });
    await reopenedOutbox.whenReady();
    const copied = await reopenedOutbox.get(asset.assetId);
    expect(copied).toMatchObject({
      assetId: asset.assetId,
      sha256: asset.sha256,
      byteSize: asset.byteSize,
      state: "ready",
    });
    expect(new Uint8Array(await copied!.blob!.arrayBuffer())).toEqual(bytes);
  });

  it("preserves guest state and resumes an ambiguous finalization", async () => {
    const shareId = randomUUID().replaceAll("-", "");
    const boardId = randomUUID();
    const pageId = randomUUID();
    const deviceId = randomUUID().replaceAll("-", "");
    const createdRoom = room(shareId);
    const draft = {
      room: createdRoom,
      initializationToken: "ambiguous-board-token",
    };
    const ticket = bootstrap(boardId, pageId);
    const source = openPageDocument(new Y.Doc());
    addBoardObject(source, {
      id: randomUUID(),
      kind: BUILTIN_OBJECT_KINDS.text,
      version: 1,
      transform: [10, 12, 180, 48, 0],
      zRank: "a0",
      props: { text: "Keep me" },
    }, createLocalCommandOrigin(randomUUID()));
    const cancelDraft = vi.fn(async () => undefined);
    const savePendingFinalization = vi.fn();
    const clearPendingFinalization = vi.fn();
    const unusedTransport: AssetUploadTransport = {
      begin: async () => {
        throw new Error("not used");
      },
      writeChunk: async () => {
        throw new Error("not used");
      },
      finalize: async () => {
        throw new Error("not used");
      },
      status: async () => {
        throw new Error("not used");
      },
      download: async () => {
        throw new Error("not used");
      },
    };

    await expect(promoteSoloBoardToGuestRoom({
      document: source,
      dependencies: {
        createDraft: async () => draft,
        finalizeDraft: async () => {
          throw new TypeError("response connection was lost");
        },
        cancelDraft,
        getDeviceId: () => deviceId,
        requestBootstrap: async () => ticket,
        createStore,
        createProvider: (options) => new ControlledProvider(
          options,
          Promise.resolve(),
        ),
        createAssetOutbox: createOutbox,
        createAssetTransport: () => unusedTransport,
        savePendingFinalization,
        clearPendingFinalization,
      },
    })).rejects.toThrow("response connection was lost");

    expect(savePendingFinalization).toHaveBeenCalledWith(draft);
    expect(clearPendingFinalization).not.toHaveBeenCalled();
    expect(cancelDraft).not.toHaveBeenCalled();
    const reopenedDocument = openPageDocument(new Y.Doc());
    const reopenedStore = createStore({
      userId: `guest-device:${deviceId}`,
      boardId,
      generation: 1,
      documentKey: ticket.defaultPageDocumentKey,
    }, reopenedDocument);
    await reopenedStore.whenReady;
    expect(getPageObjects(reopenedDocument).size).toBe(1);

    const recovered = await promoteSoloBoardToGuestRoom({
      document: source,
      dependencies: {
        loadPendingFinalization: () => ({
          version: 1,
          kind: "board",
          draft,
          preparedAt: "2026-08-09T08:00:00.000Z",
        }),
        finalizeDraft: async (recoveredShareId, initializationToken) => {
          expect(recoveredShareId).toBe(createdRoom.shareId);
          expect(initializationToken).toBe(draft.initializationToken);
          return createdRoom;
        },
        clearPendingFinalization,
      },
    });
    expect(recovered).toEqual(createdRoom);
    expect(clearPendingFinalization).toHaveBeenCalledOnce();
  });

  it.each([404, 410])(
    "discards a terminal Board recovery response (%s) and creates a fresh draft",
    async (status) => {
      const source = openPageDocument(new Y.Doc());
      addBoardObject(source, {
        id: randomUUID(),
        kind: BUILTIN_OBJECT_KINDS.text,
        version: 1,
        transform: [10, 10, 160, 40, 0],
        zRank: "a0",
        props: { text: "Fresh Board recovery" },
      }, createLocalCommandOrigin(randomUUID()));
      const staleDraft = {
        room: room(`stale-board-${status}`),
        initializationToken: `stale-board-token-${status}`,
      };
      const freshDraft = {
        room: room(`fresh-board-${status}`),
        initializationToken: `fresh-board-token-${status}`,
      };
      const ticket = bootstrap(randomUUID(), randomUUID());
      const createDraft = vi.fn(async () => freshDraft);
      const savePendingFinalization = vi.fn();
      const clearPendingFinalization = vi.fn();
      const finalizeDraft = vi.fn(async (shareId: string) => {
        if (shareId === staleDraft.room.shareId) {
          throw new ApiError("Stored Board draft is stale", status);
        }
        return freshDraft.room;
      });

      await expect(promoteSoloBoardToGuestRoom({
        document: source,
        dependencies: {
          loadPendingFinalization: () => ({
            version: 1,
            kind: "board",
            draft: staleDraft,
            preparedAt: "2026-08-09T08:00:00.000Z",
          }),
          createDraft,
          finalizeDraft,
          cancelDraft: async () => undefined,
          getDeviceId: () => randomUUID().replaceAll("-", ""),
          requestBootstrap: async () => ticket,
          createStore,
          createProvider: (options) => new ControlledProvider(
            options,
            Promise.resolve(),
          ),
          createAssetOutbox: createOutbox,
          savePendingFinalization,
          clearPendingFinalization,
        },
      })).resolves.toEqual(freshDraft.room);

      expect(createDraft).toHaveBeenCalledOnce();
      expect(finalizeDraft).toHaveBeenNthCalledWith(
        1,
        staleDraft.room.shareId,
        staleDraft.initializationToken,
      );
      expect(finalizeDraft).toHaveBeenNthCalledWith(
        2,
        freshDraft.room.shareId,
        freshDraft.initializationToken,
      );
      expect(clearPendingFinalization).toHaveBeenNthCalledWith(1, staleDraft);
      expect(clearPendingFinalization).toHaveBeenNthCalledWith(2, freshDraft);
    },
  );

  it("keeps Board recovery when abort arrives during post-finalize cleanup", async () => {
    const source = openPageDocument(new Y.Doc());
    addBoardObject(source, {
      id: randomUUID(),
      kind: BUILTIN_OBJECT_KINDS.text,
      version: 1,
      transform: [10, 10, 160, 40, 0],
      zRank: "a0",
      props: { text: "Abort-safe Board recovery" },
    }, createLocalCommandOrigin(randomUUID()));
    const createdDraft = {
      room: room("aborted-after-finalize-board"),
      initializationToken: "aborted-after-finalize-board-token",
    };
    const ticket = bootstrap(randomUUID(), randomUUID());
    const cleanupStarted = deferred();
    const releaseCleanup = deferred();
    const controller = new AbortController();
    const savePendingFinalization = vi.fn();
    const clearPendingFinalization = vi.fn();

    const promotion = promoteSoloBoardToGuestRoom({
      document: source,
      signal: controller.signal,
      dependencies: {
        createDraft: async () => createdDraft,
        finalizeDraft: async () => createdDraft.room,
        cancelDraft: vi.fn(async () => undefined),
        getDeviceId: () => randomUUID().replaceAll("-", ""),
        requestBootstrap: async () => ticket,
        createStore,
        createProvider: (options) => {
          const provider = new ControlledProvider(options, Promise.resolve());
          return {
            get status() {
              return provider.status;
            },
            subscribe: provider.subscribe.bind(provider),
            start: provider.start.bind(provider),
            stop: async () => {
              cleanupStarted.resolve();
              await releaseCleanup.promise;
              await provider.stop();
            },
          };
        },
        createAssetOutbox: createOutbox,
        savePendingFinalization,
        clearPendingFinalization,
      },
    });

    await cleanupStarted.promise;
    controller.abort();
    releaseCleanup.resolve();

    await expect(promotion).rejects.toMatchObject({ name: "AbortError" });
    expect(savePendingFinalization).toHaveBeenCalledWith(createdDraft);
    expect(clearPendingFinalization).not.toHaveBeenCalled();
  });

  it("clears partial guest namespaces after a failed asset publication", async () => {
    const shareId = randomUUID().replaceAll("-", "");
    const boardId = randomUUID();
    const pageId = randomUUID();
    const deviceId = randomUUID().replaceAll("-", "");
    const bytes = Uint8Array.of(9, 8, 7);
    const asset: LocalBoardAssetExport = {
      assetId: randomUUID(),
      sha256: digestBytes(bytes),
      byteSize: bytes.byteLength,
      declaredMime: "image/png",
      originalFileName: null,
      blob: new Blob([bytes], { type: "image/png" }),
    };
    const source = imageSource(asset);
    const sourceBefore = encodeBoardUpdate(source);
    const ticket = bootstrap(boardId, pageId);
    const failedRoom = room(shareId);
    const finalizeDraft = vi.fn(async () => failedRoom);
    const cancelDraft = vi.fn(async () => undefined);
    const transport: AssetUploadTransport = {
      begin: async () => {
        throw new AssetTransportError(
          "TENANT_QUOTA",
          "guest asset quota rejected the upload",
          "permanent",
        );
      },
      writeChunk: async () => {
        throw new Error("not used");
      },
      finalize: async () => {
        throw new Error("not used");
      },
      status: async () => {
        throw new Error("not used");
      },
      download: async () => {
        throw new Error("not used");
      },
    };

    await expect(promoteSoloBoardToGuestRoom({
      document: source,
      assets: { exportLocalAssets: async () => [asset] },
      dependencies: {
        createDraft: async () => ({
          room: failedRoom,
          initializationToken: "failed-board-token",
        }),
        finalizeDraft,
        cancelDraft,
        getDeviceId: () => deviceId,
        requestBootstrap: async () => ticket,
        createStore,
        createProvider: (options) => new ControlledProvider(
          options,
          Promise.resolve(),
        ),
        createAssetOutbox: createOutbox,
        createAssetTransport: () => transport,
      },
      timeoutMs: 2_000,
    })).rejects.toThrow("TENANT_QUOTA");
    expect(finalizeDraft).not.toHaveBeenCalled();
    expect(cancelDraft).toHaveBeenCalledWith(
      failedRoom.shareId,
      "failed-board-token",
    );
    expect(encodeBoardUpdate(source)).toEqual(sourceBefore);

    const reopenedDocument = openPageDocument(new Y.Doc());
    const reopenedStore = createStore({
      userId: `guest-device:${deviceId}`,
      boardId,
      generation: 1,
      documentKey: ticket.defaultPageDocumentKey,
    }, reopenedDocument);
    await reopenedStore.whenReady;
    expect(getPageObjects(reopenedDocument).size).toBe(0);
    expect(await reopenedStore.listPendingUpdates()).toHaveLength(0);

    const reopenedOutbox = createOutbox({
      userId: `guest-device:${deviceId}`,
      boardId,
      generation: 1,
    });
    await reopenedOutbox.whenReady();
    expect(await reopenedOutbox.list()).toEqual([]);
  });
});
