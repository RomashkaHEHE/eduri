import * as Y from "yjs";
import {
  BUILTIN_OBJECT_KINDS,
  applyBoardUpdate,
  encodeBoardUpdate,
  getPageObjects,
  openPageDocument,
} from "../../board/core";
import { BOARD_PROTOCOL_LIMITS } from "../../board/protocol";
import { api, type GuestRoom, type GuestRoomDraft } from "../api";
import { guestDeviceId } from "../guestIdentity";
import {
  clearPendingGuestFinalization,
  isDefinitiveGuestFinalizationFailure,
  loadPendingGuestFinalization,
  savePendingGuestFinalization,
  type PendingGuestFinalization,
} from "../promotionFinalization";
import {
  AssetUploadCoordinator,
  BoardAssetOutbox,
  type AssetUploadTransport,
} from "./assetOutbox";
import { BoardAssetHttpTransport } from "./assetHttpTransport";
import type {
  LocalBoardAssetExport,
  LocalBoardAssetRepository,
} from "./localBoardAssets";
import { BoardIndexedDbStore } from "./localStore";
import {
  BoardNetworkProvider,
  type BoardNetworkProviderOptions,
  type BoardProviderStatus,
  type BoardSocket,
} from "./networkProvider";
import {
  BOARD_BROWSER_CAPABILITIES,
  createBootstrappedBoardTicketSource,
  requestHttpBoardBootstrap,
  type BoardBootstrapTicket,
  type FetchLike,
  type HttpBoardBootstrapOptions,
} from "./ticketSource";

const PROMOTION_UPDATE_ORIGIN = Object.freeze({
  type: "eduri.board.solo-promotion",
});
const DEFAULT_PROMOTION_TIMEOUT_MS = 5 * 60_000;

interface PromotionBoardProvider {
  readonly status: BoardProviderStatus;
  subscribe(listener: (status: BoardProviderStatus) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface PromotionAssetCoordinator {
  start(): void;
  stop(): void;
  drain(): Promise<void>;
}

interface PromotionAssetTransportOptions {
  readonly shareId: string;
  readonly bootstrap: BoardBootstrapTicket;
}

export interface SoloBoardPromotionDependencies {
  readonly createDraft: () => Promise<GuestRoomDraft>;
  readonly finalizeDraft: (
    shareId: string,
    initializationToken: string,
  ) => Promise<GuestRoom>;
  readonly cancelDraft: (
    shareId: string,
    initializationToken: string,
  ) => Promise<void>;
  readonly getDeviceId: () => string;
  readonly requestBootstrap: (
    shareId: string,
    deviceId: string,
  ) => Promise<BoardBootstrapTicket>;
  readonly createStore: (
    identity: ConstructorParameters<typeof BoardIndexedDbStore>[0],
    document: Y.Doc,
  ) => BoardIndexedDbStore;
  readonly createProvider: (
    options: BoardNetworkProviderOptions,
  ) => PromotionBoardProvider;
  readonly createAssetOutbox: (
    identity: ConstructorParameters<typeof BoardAssetOutbox>[0],
  ) => BoardAssetOutbox;
  readonly createAssetTransport: (
    options: PromotionAssetTransportOptions,
  ) => AssetUploadTransport;
  readonly createAssetCoordinator: (
    outbox: BoardAssetOutbox,
    transport: AssetUploadTransport,
  ) => PromotionAssetCoordinator;
  readonly loadPendingFinalization: () => PendingGuestFinalization | null;
  readonly savePendingFinalization: (draft: GuestRoomDraft) => void;
  readonly clearPendingFinalization: (draft: GuestRoomDraft) => void;
}

export interface PromoteSoloBoardOptions {
  readonly document: Y.Doc;
  readonly sourceStore?: Pick<
    BoardIndexedDbStore,
    "flush" | "listDocumentUpdates"
  > | null;
  readonly assets?: Pick<LocalBoardAssetRepository, "exportLocalAssets"> | null;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly dependencies?: Partial<SoloBoardPromotionDependencies>;
}

function browserFetch(): FetchLike {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Fetch is unavailable");
  }
  return globalThis.fetch.bind(globalThis) as FetchLike;
}

function browserBaseUrl(): string {
  return typeof globalThis.location?.href === "string"
    ? globalThis.location.href
    : "http://localhost/";
}

function guestBootstrapOptions(
  shareId: string,
  deviceId: string,
): HttpBoardBootstrapOptions {
  return {
    endpoint: `/api/guest/rooms/${encodeURIComponent(shareId)}/board-ticket`,
    requestBody: {
      deviceId,
      minSchemaVersion: 1,
      maxSchemaVersion: 1,
      capabilities: BOARD_BROWSER_CAPABILITIES,
    },
    minSchemaVersion: 1,
    maxSchemaVersion: 1,
    capabilities: BOARD_BROWSER_CAPABILITIES,
    requireCsrf: false,
    fetch: browserFetch(),
    baseUrl: browserBaseUrl(),
  };
}

const defaultDependencies: SoloBoardPromotionDependencies = {
  createDraft: () => api.guestRooms.createDraft("board"),
  finalizeDraft: (shareId, initializationToken) => (
    api.guestRooms.finalizeDraft(shareId, initializationToken)
  ),
  cancelDraft: (shareId, initializationToken) => (
    api.guestRooms.cancelDraft(shareId, initializationToken)
  ),
  getDeviceId: guestDeviceId,
  requestBootstrap: (shareId, deviceId) =>
    requestHttpBoardBootstrap(guestBootstrapOptions(shareId, deviceId)),
  createStore: (identity, document) =>
    new BoardIndexedDbStore(identity, document),
  createProvider: (options) => new BoardNetworkProvider(options),
  createAssetOutbox: (identity) => new BoardAssetOutbox(identity),
  createAssetTransport: ({ shareId, bootstrap }) =>
    new BoardAssetHttpTransport({
      boardId: bootstrap.boardId,
      generation: bootstrap.generation,
      csrfToken: () => "",
      fetch: globalThis.fetch.bind(globalThis),
      endpoint:
        `/api/guest/rooms/${encodeURIComponent(shareId)}/board-assets`,
    }),
  createAssetCoordinator: (outbox, transport) =>
    new AssetUploadCoordinator({
      outbox,
      transport,
      retryBaseMs: 500,
      retryMaxMs: 5_000,
      idlePollMs: 250,
    }),
  loadPendingFinalization: () => loadPendingGuestFinalization("board"),
  savePendingFinalization: (draft) => {
    savePendingGuestFinalization("board", draft);
  },
  clearPendingFinalization: (draft) => {
    clearPendingGuestFinalization("board", draft);
  },
};

function abortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("Solo Board promotion was cancelled", "AbortError");
  }
  const error = new Error("Solo Board promotion was cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function promotionTimeout(timeoutMs: number): Error {
  return new Error(
    `Solo Board promotion did not become durable within ${timeoutMs} ms`,
  );
}

function referencedImageAssetIds(document: Y.Doc): ReadonlySet<string> {
  const result = new Set<string>();
  for (const record of getPageObjects(document).values()) {
    if (record.get("kind") !== BUILTIN_OBJECT_KINDS.image) continue;
    const props = record.get("props");
    if (!(props instanceof Y.Map)) continue;
    const assetId = props.get("assetId");
    if (typeof assetId === "string") result.add(assetId);
  }
  return result;
}

function assertReferencedAssetsAvailable(
  referencedAssetIds: ReadonlySet<string>,
  assets: readonly LocalBoardAssetExport[],
): void {
  const available = new Set(assets.map((asset) => asset.assetId));
  const missing = [...referencedAssetIds].filter((assetId) => (
    !available.has(assetId)
  ));
  if (missing.length > 0) {
    throw new Error(
      "Solo Board contains an image whose durable local blob is unavailable",
    );
  }
}

function assertPromotionUpdateBounded(update: Uint8Array): void {
  if (update.byteLength > BOARD_PROTOCOL_LIMITS.maxUpdateBytes) {
    throw new Error(
      "Solo Board contains an individual update larger than the sync protocol limit",
    );
  }
}

async function captureSourceUpdates(
  document: Y.Doc,
  sourceStore: PromoteSoloBoardOptions["sourceStore"],
  signal: AbortSignal | undefined,
): Promise<readonly Uint8Array[]> {
  if (!sourceStore) {
    const update = encodeBoardUpdate(document);
    assertPromotionUpdateBounded(update);
    return [update];
  }
  await sourceStore.flush();
  throwIfAborted(signal);
  const updates = await sourceStore.listDocumentUpdates();
  throwIfAborted(signal);
  for (const update of updates) assertPromotionUpdateBounded(update);
  return updates.map((update) => update.slice());
}

function providerFailure(status: BoardProviderStatus): Error | null {
  if (status.localDurability === "at-risk") {
    return new Error(status.lastError ?? "Guest Board local durability failed");
  }
  if (status.connection === "read-only") {
    return new Error("Guest Board did not grant edit permission");
  }
  if (status.connection === "recovery-required") {
    const recovery = status.recovery;
    let serverDetail: string | null = null;
    if (recovery?.payload?.byteLength) {
      try {
        const payload = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(recovery.payload),
        ) as unknown;
        if (
          typeof payload === "object"
          && payload !== null
          && "error" in payload
          && typeof payload.error === "string"
        ) {
          serverDetail = payload.error.slice(0, 512);
        }
      } catch {
        // A malformed diagnostic payload must not hide the recovery state.
      }
    }
    const detail = recovery
      ? `${recovery.reason}${recovery.controlCode === undefined
        ? ""
        : ` (control ${recovery.controlCode})`}${serverDetail
        ? `: ${serverDetail}`
        : ""}`
      : "unknown reason";
    return new Error(
      status.lastError ?? `Guest Board requires recovery: ${detail}`,
    );
  }
  if (status.connection === "stopped") {
    return new Error("Guest Board synchronization stopped before promotion");
  }
  return null;
}

function waitForBoardDurability(
  provider: PromotionBoardProvider,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const timeout = globalThis.setTimeout(() => {
      settle(promotionTimeout(timeoutMs));
    }, timeoutMs);

    const cleanup = (): void => {
      globalThis.clearTimeout(timeout);
      unsubscribe?.();
      signal?.removeEventListener("abort", handleAbort);
    };
    const settle = (reason?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (reason) reject(reason);
      else resolve();
    };
    const handleAbort = (): void => settle(abortError());
    const handleStatus = (status: BoardProviderStatus): void => {
      const failure = providerFailure(status);
      if (failure) {
        settle(failure);
        return;
      }
      if (
        status.connection === "online"
        && status.localDurability === "ready"
        && status.pendingUpdateCount === 0
        && status.recovery === null
      ) {
        settle();
      }
    };

    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    unsubscribe = provider.subscribe(handleStatus);
    if (settled) unsubscribe();
  });
}

function waitForAssetDurability(
  outbox: BoardAssetOutbox,
  expectedAssetIds: ReadonlySet<string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let checking = false;
    let checkAgain = false;
    const timeout = globalThis.setTimeout(() => {
      settle(promotionTimeout(timeoutMs));
    }, timeoutMs);
    const poll = globalThis.setInterval(() => requestCheck(), 100);
    const unsubscribe = outbox.subscribe(() => requestCheck());

    const cleanup = (): void => {
      globalThis.clearTimeout(timeout);
      globalThis.clearInterval(poll);
      unsubscribe();
      signal?.removeEventListener("abort", handleAbort);
    };
    const settle = (reason?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (reason) reject(reason);
      else resolve();
    };
    const handleAbort = (): void => settle(abortError());
    const check = async (): Promise<void> => {
      if (settled) return;
      if (checking) {
        checkAgain = true;
        return;
      }
      checking = true;
      try {
        const records = await outbox.list();
        if (settled) return;
        const expected = records.filter((record) => (
          expectedAssetIds.has(record.assetId)
        ));
        const blocked = expected.find((record) => record.state === "blocked");
        if (blocked) {
          settle(
            new Error(
              `Guest Board asset ${blocked.assetId} failed: ${blocked.lastErrorCode ?? "unknown"}`,
            ),
          );
          return;
        }
        if (
          expected.length === expectedAssetIds.size
          && expected.every((record) => record.state === "ready")
        ) {
          settle();
        }
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      } finally {
        checking = false;
        if (checkAgain && !settled) {
          checkAgain = false;
          void check();
        }
      }
    };
    function requestCheck(): void {
      void check();
    }

    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    requestCheck();
  });
}

async function cleanupPromotion(
  document: Y.Doc | null,
  store: BoardIndexedDbStore | null,
  provider: PromotionBoardProvider | null,
  outbox: BoardAssetOutbox | null,
  coordinator: PromotionAssetCoordinator | null,
  clear: boolean,
): Promise<readonly unknown[]> {
  const failures: unknown[] = [];
  coordinator?.stop();
  const stopped = await Promise.allSettled([
    provider?.stop() ?? Promise.resolve(),
    coordinator?.drain() ?? Promise.resolve(),
  ]);
  failures.push(...stopped.flatMap((result) => (
    result.status === "rejected" ? [result.reason] : []
  )));

  if (clear) {
    const cleared = await Promise.allSettled([
      store?.clear() ?? Promise.resolve(),
      outbox?.clear() ?? Promise.resolve(),
    ]);
    failures.push(...cleared.flatMap((result) => (
      result.status === "rejected" ? [result.reason] : []
    )));
  } else {
    const closed = await Promise.allSettled([
      store
        ? store.flush().then(() => store.destroy())
        : Promise.resolve(),
      outbox?.close() ?? Promise.resolve(),
    ]);
    failures.push(...closed.flatMap((result) => (
      result.status === "rejected" ? [result.reason] : []
    )));
  }
  document?.destroy();
  return failures;
}

export async function promoteSoloBoardToGuestRoom({
  document: sourceDocument,
  sourceStore,
  assets: sourceAssets,
  signal,
  timeoutMs = DEFAULT_PROMOTION_TIMEOUT_MS,
  dependencies: dependencyOverrides,
}: PromoteSoloBoardOptions): Promise<GuestRoom> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("timeoutMs must be a positive safe integer");
  }
  throwIfAborted(signal);

  const dependencies: SoloBoardPromotionDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };
  const attemptedFinalizations = new Set<string>();
  let pendingFinalization = dependencies.loadPendingFinalization();
  while (pendingFinalization) {
    const attemptIdentity = [
      pendingFinalization.draft.room.shareId,
      pendingFinalization.draft.initializationToken,
    ].join("\u0000");
    if (attemptedFinalizations.has(attemptIdentity)) break;
    attemptedFinalizations.add(attemptIdentity);
    try {
      const recoveredRoom = await dependencies.finalizeDraft(
        pendingFinalization.draft.room.shareId,
        pendingFinalization.draft.initializationToken,
      );
      throwIfAborted(signal);
      dependencies.clearPendingFinalization(pendingFinalization.draft);
      return recoveredRoom;
    } catch (error) {
      if (!isDefinitiveGuestFinalizationFailure(error)) throw error;
      dependencies.clearPendingFinalization(pendingFinalization.draft);
      throwIfAborted(signal);
      pendingFinalization = dependencies.loadPendingFinalization();
    }
  }
  const sourceUpdates = await captureSourceUpdates(
    sourceDocument,
    sourceStore,
    signal,
  );
  const referencedAssetIds = referencedImageAssetIds(sourceDocument);
  const exportedAssets = sourceAssets
    ? await sourceAssets.exportLocalAssets()
    : [];
  throwIfAborted(signal);
  assertReferencedAssetsAvailable(referencedAssetIds, exportedAssets);

  let guestDocument: Y.Doc | null = null;
  let store: BoardIndexedDbStore | null = null;
  let provider: PromotionBoardProvider | null = null;
  let outbox: BoardAssetOutbox | null = null;
  let coordinator: PromotionAssetCoordinator | null = null;
  let draft: GuestRoomDraft | null = null;
  let finalized = false;
  let finalizationPrepared = false;
  try {
    draft = await dependencies.createDraft();
    throwIfAborted(signal);
    const room = draft.room;
    const deviceId = dependencies.getDeviceId();
    const bootstrap = await dependencies.requestBootstrap(
      room.shareId,
      deviceId,
    );
    throwIfAborted(signal);

    guestDocument = openPageDocument(new Y.Doc());
    const localIdentity = {
      userId: `guest-device:${deviceId}`,
      boardId: bootstrap.boardId,
      generation: bootstrap.generation,
    };
    store = dependencies.createStore({
      ...localIdentity,
      documentKey: bootstrap.defaultPageDocumentKey,
    }, guestDocument);
    outbox = dependencies.createAssetOutbox(localIdentity);
    await Promise.all([store.whenReady, outbox.whenReady()]);
    throwIfAborted(signal);

    const bootstrapOptions = guestBootstrapOptions(room.shareId, deviceId);
    const scope = {
      boardId: bootstrap.boardId,
      generation: bootstrap.generation,
      documentKey: bootstrap.defaultPageDocumentKey,
    };
    provider = dependencies.createProvider({
      document: guestDocument,
      scope,
      localStore: store,
      ticketSource: createBootstrappedBoardTicketSource(
        bootstrapOptions,
        scope,
        bootstrap,
      ),
      socketFactory: (url: string, subprotocol: string) =>
        new WebSocket(url, subprotocol) as unknown as BoardSocket,
      minSchemaVersion: bootstrap.schemaVersion,
      maxSchemaVersion: bootstrap.schemaVersion,
      capabilities: bootstrap.capabilities,
    });
    await provider.start();
    throwIfAborted(signal);

    for (const update of sourceUpdates) {
      throwIfAborted(signal);
      applyBoardUpdate(guestDocument, update, PROMOTION_UPDATE_ORIGIN);
    }
    await store.flush();
    for (const asset of exportedAssets) {
      throwIfAborted(signal);
      const copied = await outbox.enqueueLocal({
        assetId: asset.assetId,
        blob: asset.blob,
        declaredMime: asset.declaredMime,
        originalFileName: asset.originalFileName ?? undefined,
      });
      if (
        copied.sha256 !== asset.sha256
        || copied.byteSize !== asset.byteSize
      ) {
        throw new Error(
          `Guest Board asset ${asset.assetId} changed during promotion`,
        );
      }
    }

    const transport = dependencies.createAssetTransport({
      shareId: room.shareId,
      bootstrap,
    });
    coordinator = dependencies.createAssetCoordinator(outbox, transport);
    coordinator.start();
    await Promise.all([
      waitForBoardDurability(provider, timeoutMs, signal),
      waitForAssetDurability(
        outbox,
        new Set(exportedAssets.map((asset) => asset.assetId)),
        timeoutMs,
        signal,
      ),
    ]);
    coordinator.stop();
    await coordinator.drain();
    throwIfAborted(signal);
    dependencies.savePendingFinalization(draft);
    finalizationPrepared = true;
    const finalizedRoom = await dependencies.finalizeDraft(
      room.shareId,
      draft.initializationToken,
    );
    finalized = true;
    const cleanupFailures = await cleanupPromotion(
      guestDocument,
      store,
      provider,
      outbox,
      coordinator,
      false,
    );
    guestDocument = null;
    store = null;
    provider = null;
    outbox = null;
    coordinator = null;
    if (cleanupFailures.length > 0) {
      console.error(
        "Guest Board promotion could not close its local resources",
        cleanupFailures,
      );
    }
    throwIfAborted(signal);
    dependencies.clearPendingFinalization(draft);
    return finalizedRoom;
  } catch (error) {
    const preserveGuestState = finalizationPrepared || finalized;
    if (draft && !preserveGuestState) {
      await dependencies.cancelDraft(
        draft.room.shareId,
        draft.initializationToken,
      ).catch(() => undefined);
    }
    await cleanupPromotion(
      guestDocument,
      store,
      provider,
      outbox,
      coordinator,
      !preserveGuestState,
    );
    throw error;
  }
}
