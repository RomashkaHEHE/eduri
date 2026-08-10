import { deleteIndexedDb, openIndexedDb } from "./indexedDbLifecycle.js";

export interface AssetOutboxIdentity {
  userId: string;
  boardId: string;
  generation: number;
}

export type AssetOutboxState = "pending" | "uploading" | "ready" | "blocked";
export type AssetOutboxSource = "local" | "remote";

export interface AssetOutboxRecord {
  assetId: string;
  revision: number;
  source: AssetOutboxSource;
  state: AssetOutboxState;
  sha256: string;
  byteSize: number;
  declaredMime: string;
  originalFileName: string | null;
  blob: Blob | null;
  uploadId: string | null;
  nextOffset: number;
  chunkBytes: number | null;
  attemptCount: number;
  nextAttemptAt: number;
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
  published: RemoteAssetReady | null;
}

export interface EnqueueLocalAssetInput {
  assetId?: string;
  blob: Blob;
  originalFileName?: string;
  declaredMime?: string;
}

export interface TrackRemoteAssetInput {
  assetId: string;
  sha256: string;
  byteSize: number;
  declaredMime: string;
}

export interface RemoteAssetReady {
  assetId: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  width: number;
  height: number;
  frameCount: number;
  totalDecodedPixels: number;
  publishedAt: string;
}

export interface RemoteAssetPending {
  status: "pending";
  assetId: string;
  sha256: string;
  byteSize: number;
}

export interface RemoteAssetRejected {
  status: "rejected";
  assetId: string;
  sha256: string;
  byteSize: number;
  errorCode: string | null;
}

export type RemoteAssetStatus =
  | ({ status: "ready" } & RemoteAssetReady)
  | RemoteAssetPending
  | RemoteAssetRejected;

export interface RemoteBeginUpload {
  status: "upload";
  uploadId: string;
  nextOffset: number;
  chunkBytes: number;
  expiresAt: string;
}

export interface RemoteBeginReady {
  status: "ready";
  asset: RemoteAssetReady;
  deduplicated: boolean;
}

export interface AssetUploadTransport {
  cancelPending?(): void;
  begin(input: {
    assetId: string;
    sha256: string;
    byteSize: number;
    declaredMime: string;
    originalFileName: string | null;
    preferredChunkBytes?: number;
  }): Promise<RemoteBeginUpload | RemoteBeginReady>;
  writeChunk(input: {
    assetId: string;
    uploadId: string;
    offset: number;
    chunk: Uint8Array;
    chunkSha256: string;
  }): Promise<{ nextOffset: number; complete: boolean; duplicate: boolean }>;
  finalize(input: { assetId: string; uploadId: string }): Promise<RemoteAssetReady>;
  status(assetId: string): Promise<RemoteAssetStatus>;
  download(assetId: string, expected: RemoteAssetReady): Promise<Blob>;
}

export type AssetTransportErrorKind = "transient" | "access" | "permanent";

export class AssetTransportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly kind: AssetTransportErrorKind,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AssetTransportError";
  }
}

export type AssetLocalErrorCode =
  | "INVALID_ARGUMENT"
  | "LOCAL_ASSET_TOO_LARGE"
  | "LOCAL_QUOTA"
  | "LOCAL_STORAGE"
  | "ASSET_ID_CONFLICT"
  | "MISSING_LOCAL_BLOB"
  | "REMOTE_INTEGRITY";

export class AssetLocalPersistenceError extends Error {
  constructor(
    public readonly code: AssetLocalErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AssetLocalPersistenceError";
  }
}

export interface AssetOutboxOptions {
  indexedDB?: IDBFactory;
  maxLocalAssetBytes?: number;
  digestBlob?: (blob: Blob) => Promise<string>;
  digestBytes?: (bytes: Uint8Array) => Promise<string>;
  idFactory?: () => string;
  now?: () => number;
  broadcastChannelFactory?: (name: string) => AssetOutboxBroadcastChannel | null;
}

export interface AssetOutboxEvent {
  assetId: string;
  state: AssetOutboxState;
  record: AssetOutboxRecord;
}

export type AssetOutboxListener = (event: AssetOutboxEvent) => void;

export interface AssetOutboxBroadcastChannel {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  close(): void;
}

export interface AssetOutboxRisk {
  assetId: string;
  source: AssetOutboxSource;
  errorCode: string;
  hasLocalRecoveryCopy: boolean;
}

export interface AssetOutboxHealth {
  pendingLocalCount: number;
  pendingRemoteCount: number;
  readyCount: number;
  blocked: readonly AssetOutboxRisk[];
}

export interface AssetStorageEstimate {
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
}

export interface AssetUploadCoordinatorOptions {
  outbox: BoardAssetOutbox;
  transport: AssetUploadTransport;
  retryBaseMs?: number;
  retryMaxMs?: number;
  idlePollMs?: number;
  preferredChunkBytes?: number;
  random?: () => number;
  now?: () => number;
  onlineTarget?: Pick<Window, "addEventListener" | "removeEventListener">;
}

export interface AssetSyncPassResult {
  attempted: number;
  completed: number;
  deferred: number;
  blocked: number;
}

const DATABASE_VERSION = 1;
const ASSET_STORE = "assets";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const NAMESPACE_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DEFAULT_MAX_LOCAL_ASSET_BYTES = 128 * 1024 * 1024;
const ASSET_CHANGE_MESSAGE = "asset-record-changed";

interface AssetChangeMessage {
  type: typeof ASSET_CHANGE_MESSAGE;
  assetId: string;
  revision: number;
}

function validateNamespacePart(value: string, label: string): string {
  if (typeof value !== "string" || !NAMESPACE_PATTERN.test(value)) {
    throw new AssetLocalPersistenceError("INVALID_ARGUMENT", `${label} contains unsupported characters`);
  }
  return value;
}

function validateAssetId(value: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new AssetLocalPersistenceError("INVALID_ARGUMENT", "assetId must be a 1-128 character opaque ID");
  }
  return value;
}

function validateSha256(value: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new AssetLocalPersistenceError("INVALID_ARGUMENT", "sha256 must be lowercase hexadecimal");
  }
  return value;
}

function validatePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AssetLocalPersistenceError("INVALID_ARGUMENT", `${label} must be a positive safe integer`);
  }
  return value;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function classifyPersistenceError(error: unknown): AssetLocalPersistenceError {
  if (error instanceof AssetLocalPersistenceError) return error;
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return new AssetLocalPersistenceError(
      "LOCAL_QUOTA",
      "local storage quota is exhausted; the asset remains only in the current caller's memory",
      error,
    );
  }
  return new AssetLocalPersistenceError(
    "LOCAL_STORAGE",
    `could not durably persist asset: ${error instanceof Error ? error.message : String(error)}`,
    error,
  );
}

async function defaultDigestBytes(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new AssetLocalPersistenceError("LOCAL_STORAGE", "Web Crypto SHA-256 is unavailable");
  }
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input.buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function defaultDigestBlob(blob: Blob): Promise<string> {
  return defaultDigestBytes(new Uint8Array(await blob.arrayBuffer()));
}

function cloneRecord(record: AssetOutboxRecord): AssetOutboxRecord {
  return {
    ...record,
    published: record.published ? { ...record.published } : null,
  };
}

export function assetOutboxDatabaseName(identity: AssetOutboxIdentity): string {
  validatePositiveInteger(identity.generation, "generation");
  return [
    "eduri-board-v2-assets",
    validateNamespacePart(identity.userId, "userId"),
    validateNamespacePart(identity.boardId, "boardId"),
    String(identity.generation),
  ].join(":");
}

export async function requestAssetStoragePersistence(): Promise<"granted" | "denied" | "unsupported"> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return "unsupported";
  return await navigator.storage.persist() ? "granted" : "denied";
}

export async function estimateAssetStorage(): Promise<AssetStorageEstimate> {
  if (typeof navigator === "undefined" || !navigator.storage) {
    return { usage: null, quota: null, persisted: null };
  }
  const [estimate, persisted] = await Promise.all([
    navigator.storage.estimate?.() ?? Promise.resolve({}),
    navigator.storage.persisted?.() ?? Promise.resolve(false),
  ]);
  return {
    usage: typeof estimate.usage === "number" ? estimate.usage : null,
    quota: typeof estimate.quota === "number" ? estimate.quota : null,
    persisted,
  };
}

export class BoardAssetOutbox {
  readonly name: string;
  readonly maxLocalAssetBytes: number;

  private readonly indexedDB: IDBFactory;
  private readonly digestBlob: (blob: Blob) => Promise<string>;
  readonly digestBytes: (bytes: Uint8Array) => Promise<string>;
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private readonly listeners = new Set<AssetOutboxListener>();
  private readonly broadcastChannel: AssetOutboxBroadcastChannel | null;
  private readonly observedRevisions = new Map<string, number>();
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(
    readonly identity: AssetOutboxIdentity,
    options: AssetOutboxOptions = {},
  ) {
    this.name = assetOutboxDatabaseName(identity);
    this.indexedDB = options.indexedDB ?? globalThis.indexedDB;
    if (!this.indexedDB) {
      throw new AssetLocalPersistenceError("LOCAL_STORAGE", "IndexedDB is unavailable");
    }
    this.maxLocalAssetBytes = validatePositiveInteger(
      options.maxLocalAssetBytes ?? DEFAULT_MAX_LOCAL_ASSET_BYTES,
      "maxLocalAssetBytes",
    );
    this.digestBlob = options.digestBlob ?? defaultDigestBlob;
    this.digestBytes = options.digestBytes ?? defaultDigestBytes;
    this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.now = options.now ?? (() => Date.now());
    const channelFactory = options.broadcastChannelFactory
      ?? (
        typeof globalThis.BroadcastChannel === "function"
          ? (name: string) => new globalThis.BroadcastChannel(name)
          : null
      );
    let channel: AssetOutboxBroadcastChannel | null = null;
    try {
      channel = channelFactory?.(`${this.name}:changes`) ?? null;
      channel?.addEventListener("message", this.handleBroadcastMessage);
    } catch {
      // Cross-tab hints are an optimization; IndexedDB remains authoritative.
      channel = null;
    }
    this.broadcastChannel = channel;
  }

  async whenReady(): Promise<void> {
    await this.database();
  }

  subscribe(listener: AssetOutboxListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async enqueueLocal(input: EnqueueLocalAssetInput): Promise<AssetOutboxRecord> {
    if (!(input.blob instanceof Blob) || input.blob.size < 1) {
      throw new AssetLocalPersistenceError("INVALID_ARGUMENT", "blob must be a non-empty Blob");
    }
    if (input.blob.size > this.maxLocalAssetBytes) {
      throw new AssetLocalPersistenceError(
        "LOCAL_ASSET_TOO_LARGE",
        `asset is ${input.blob.size} bytes; the per-asset limit is ${this.maxLocalAssetBytes}`,
      );
    }
    const assetId = validateAssetId(input.assetId ?? this.idFactory());
    const sha256 = validateSha256(await this.digestBlob(input.blob));
    const declaredMime = (input.declaredMime ?? input.blob.type ?? "").trim().toLowerCase();
    const fileName = input.originalFileName?.normalize("NFC").trim().slice(0, 240) || null;
    const now = this.now();
    try {
      const stored = await this.mutate(assetId, (existing) => {
        if (existing) {
          if (existing.sha256 !== sha256 || existing.byteSize !== input.blob.size) {
            throw new AssetLocalPersistenceError(
              "ASSET_ID_CONFLICT",
              "assetId is already bound to different local bytes",
            );
          }
          if (existing.blob) return existing;
          return {
            ...existing,
            source: "local",
            state: existing.state === "ready" ? "ready" : "pending",
            blob: input.blob,
            declaredMime,
            originalFileName: fileName,
            nextAttemptAt: now,
            updatedAt: now,
          };
        }
        return {
          assetId,
          revision: 1,
          source: "local",
          state: "pending",
          sha256,
          byteSize: input.blob.size,
          declaredMime,
          originalFileName: fileName,
          blob: input.blob,
          uploadId: null,
          nextOffset: 0,
          chunkBytes: null,
          attemptCount: 0,
          nextAttemptAt: now,
          lastErrorCode: null,
          createdAt: now,
          updatedAt: now,
          published: null,
        };
      });
      this.emit(stored);
      return stored;
    } catch (error) {
      throw classifyPersistenceError(error);
    }
  }

  async trackRemote(input: TrackRemoteAssetInput): Promise<AssetOutboxRecord> {
    const assetId = validateAssetId(input.assetId);
    const sha256 = validateSha256(input.sha256);
    const byteSize = validatePositiveInteger(input.byteSize, "byteSize");
    const now = this.now();
    const stored = await this.mutate(assetId, (existing) => {
      if (existing) {
        if (existing.sha256 !== sha256 || existing.byteSize !== byteSize) {
          throw new AssetLocalPersistenceError(
            "ASSET_ID_CONFLICT",
            "remote asset identity conflicts with the local record",
          );
        }
        return existing;
      }
      return {
        assetId,
        revision: 1,
        source: "remote",
        state: "pending",
        sha256,
        byteSize,
        declaredMime: input.declaredMime,
        originalFileName: null,
        blob: null,
        uploadId: null,
        nextOffset: 0,
        chunkBytes: null,
        attemptCount: 0,
        nextAttemptAt: now,
        lastErrorCode: null,
        createdAt: now,
        updatedAt: now,
        published: null,
      };
    });
    this.emit(stored);
    return stored;
  }

  async get(assetId: string): Promise<AssetOutboxRecord | null> {
    const database = await this.database();
    const transaction = database.transaction(ASSET_STORE, "readonly");
    const record = await requestResult(
      transaction.objectStore(ASSET_STORE).get(validateAssetId(assetId)) as IDBRequest<AssetOutboxRecord | undefined>,
    );
    await transactionDone(transaction);
    return record ? cloneRecord(record) : null;
  }

  async list(): Promise<AssetOutboxRecord[]> {
    const database = await this.database();
    const transaction = database.transaction(ASSET_STORE, "readonly");
    const records = await requestResult(
      transaction.objectStore(ASSET_STORE).getAll() as IDBRequest<AssetOutboxRecord[]>,
    );
    await transactionDone(transaction);
    return records.map(cloneRecord);
  }

  async health(): Promise<AssetOutboxHealth> {
    const records = await this.list();
    return {
      pendingLocalCount: records.filter((record) =>
        record.source === "local"
        && (record.state === "pending" || record.state === "uploading"))
        .length,
      pendingRemoteCount: records.filter((record) =>
        record.source === "remote"
        && record.blob === null
        && record.state !== "blocked")
        .length,
      readyCount: records.filter((record) => record.state === "ready").length,
      blocked: records
        .filter((record) => record.state === "blocked")
        .map((record) => ({
          assetId: record.assetId,
          source: record.source,
          errorCode: record.lastErrorCode ?? "ASSET_SYNC_FAILED",
          hasLocalRecoveryCopy: record.blob !== null,
        })),
    };
  }

  async listDue(now = this.now()): Promise<AssetOutboxRecord[]> {
    return (await this.list())
      .filter((record) =>
        record.source === "local"
        && record.blob !== null
        && (record.state === "pending" || record.state === "uploading")
        && record.nextAttemptAt <= now)
      .sort((left, right) => left.nextAttemptAt - right.nextAttemptAt || left.createdAt - right.createdAt);
  }

  async listRemotePending(): Promise<AssetOutboxRecord[]> {
    return (await this.list()).filter((record) =>
      record.source === "remote"
      && record.blob === null
      && (
        record.state === "pending"
        || record.state === "ready"
        || (
          record.state === "blocked"
          && record.lastErrorCode === "NOT_FOUND"
        )
      ));
  }

  async setUploadSession(
    assetId: string,
    session: { uploadId: string; nextOffset: number; chunkBytes: number },
  ): Promise<AssetOutboxRecord> {
    const updated = await this.mutateRequired(assetId, (record) => {
      if (record.state === "ready") return record;
      const uploadId = validateAssetId(session.uploadId);
      if (
        record.state === "uploading"
        && record.uploadId
        && record.uploadId !== uploadId
      ) {
        return record;
      }
      return {
        ...record,
        state: "uploading",
        uploadId,
        nextOffset: this.validateOffset(session.nextOffset, record.byteSize),
        chunkBytes: validatePositiveInteger(session.chunkBytes, "chunkBytes"),
        attemptCount: 0,
        lastErrorCode: null,
        updatedAt: this.now(),
      };
    });
    this.emit(updated);
    return updated;
  }

  async acknowledgeOffset(assetId: string, uploadId: string, nextOffset: number): Promise<AssetOutboxRecord> {
    const updated = await this.mutateRequired(assetId, (record) => {
      if (record.state === "ready") return record;
      if (record.uploadId !== uploadId) {
        throw new AssetLocalPersistenceError("ASSET_ID_CONFLICT", "upload session changed");
      }
      const offset = this.validateOffset(nextOffset, record.byteSize);
      if (offset < record.nextOffset) {
        throw new AssetLocalPersistenceError("ASSET_ID_CONFLICT", "server upload offset regressed");
      }
      return {
        ...record,
        state: "uploading",
        nextOffset: offset,
        updatedAt: this.now(),
      };
    });
    this.emit(updated);
    return updated;
  }

  async resetUpload(assetId: string, errorCode: string, nextAttemptAt: number): Promise<AssetOutboxRecord> {
    const updated = await this.mutateRequired(assetId, (record) =>
      record.state === "ready"
        ? record
        : {
            ...record,
            state: "pending",
            uploadId: null,
            nextOffset: 0,
            chunkBytes: null,
            attemptCount: record.attemptCount + 1,
            nextAttemptAt,
            lastErrorCode: errorCode,
            updatedAt: this.now(),
          });
    this.emit(updated);
    return updated;
  }

  async recordTransientFailure(
    assetId: string,
    errorCode: string,
    nextAttemptAt: number,
  ): Promise<AssetOutboxRecord> {
    const updated = await this.mutateRequired(assetId, (record) =>
      record.state === "ready"
        ? record
        : {
            ...record,
            attemptCount: record.attemptCount + 1,
            nextAttemptAt,
            lastErrorCode: errorCode,
            updatedAt: this.now(),
          });
    this.emit(updated);
    return updated;
  }

  async markBlocked(assetId: string, errorCode: string): Promise<AssetOutboxRecord> {
    const updated = await this.mutateRequired(assetId, (record) =>
      record.state === "ready"
        ? record
        : {
            ...record,
            state: "blocked",
            lastErrorCode: errorCode,
            updatedAt: this.now(),
          });
    this.emit(updated);
    return updated;
  }

  async markReady(assetId: string, ready: RemoteAssetReady): Promise<AssetOutboxRecord> {
    const updated = await this.mutateRequired(assetId, (record) => {
      this.assertReadyIdentity(record, ready);
      if (record.source === "remote" && !record.blob) {
        throw new AssetLocalPersistenceError(
          "MISSING_LOCAL_BLOB",
          "remote asset bytes must be durable before the asset becomes ready",
        );
      }
      return {
        ...record,
        state: "ready",
        uploadId: null,
        nextOffset: record.byteSize,
        chunkBytes: null,
        attemptCount: 0,
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
        lastErrorCode: null,
        published: { ...ready },
        updatedAt: this.now(),
      };
    });
    this.emit(updated);
    return updated;
  }

  async cacheRemoteReady(
    assetId: string,
    ready: RemoteAssetReady,
    blob: Blob,
  ): Promise<AssetOutboxRecord> {
    if (!(blob instanceof Blob) || blob.size < 1) {
      throw new AssetLocalPersistenceError(
        "REMOTE_INTEGRITY",
        "downloaded remote asset is empty",
      );
    }
    const digest = validateSha256(await this.digestBlob(blob));
    const updated = await this.mutateRequired(assetId, (record) => {
      this.assertReadyIdentity(record, ready);
      if (
        blob.size !== record.byteSize
        || digest !== record.sha256
        || (
          blob.type
          && blob.type.trim().toLowerCase() !== ready.mimeType
        )
      ) {
        throw new AssetLocalPersistenceError(
          "REMOTE_INTEGRITY",
          "downloaded remote asset does not match its immutable identity",
        );
      }
      return {
        ...record,
        source: "remote",
        state: "ready",
        blob,
        uploadId: null,
        nextOffset: record.byteSize,
        chunkBytes: null,
        attemptCount: 0,
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
        lastErrorCode: null,
        published: { ...ready },
        updatedAt: this.now(),
      };
    });
    this.emit(updated);
    return updated;
  }

  async close(): Promise<void> {
    this.broadcastChannel?.removeEventListener("message", this.handleBroadcastMessage);
    this.broadcastChannel?.close();
    const databasePromise = this.databasePromise;
    this.databasePromise = null;
    if (!databasePromise) return;
    try {
      const database = await databasePromise;
      database.close();
    } catch {
      // A failed open has no live connection; the cached rejection is cleared.
    }
  }

  async clear(): Promise<void> {
    await this.close();
    await deleteIndexedDb(
      this.indexedDB,
      this.name,
      "could not delete asset outbox",
    );
  }

  private async database(): Promise<IDBDatabase> {
    if (!this.databasePromise) {
      let opening!: Promise<IDBDatabase>;
      opening = openIndexedDb({
        factory: this.indexedDB,
        name: this.name,
        version: DATABASE_VERSION,
        errorMessage: "could not open asset outbox",
        upgrade: (database) => {
          if (!database.objectStoreNames.contains(ASSET_STORE)) {
            const store = database.createObjectStore(ASSET_STORE, { keyPath: "assetId" });
            store.createIndex("state", "state");
            store.createIndex("source", "source");
            store.createIndex("nextAttemptAt", "nextAttemptAt");
          }
        },
        onVersionChange: () => {
          if (this.databasePromise === opening) {
            this.databasePromise = null;
          }
        },
      });
      this.databasePromise = opening;
      void opening.catch(() => {
        if (this.databasePromise === opening) {
          this.databasePromise = null;
        }
      });
    }
    return this.databasePromise;
  }

  private async mutate(
    assetId: string,
    mutate: (record: AssetOutboxRecord | null) => AssetOutboxRecord,
  ): Promise<AssetOutboxRecord> {
    const database = await this.database();
    const transaction = database.transaction(ASSET_STORE, "readwrite");
    const store = transaction.objectStore(ASSET_STORE);
    try {
      const existing = await requestResult(
        store.get(assetId) as IDBRequest<AssetOutboxRecord | undefined>,
      );
      const candidate = mutate(existing ?? null);
      const updated = {
        ...candidate,
        revision: (existing?.revision ?? 0) + 1,
      };
      await requestResult(store.put(updated));
      await transactionDone(transaction);
      return cloneRecord(updated);
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted itself.
      }
      throw error;
    }
  }

  private async mutateRequired(
    assetId: string,
    mutate: (record: AssetOutboxRecord) => AssetOutboxRecord,
  ): Promise<AssetOutboxRecord> {
    const validated = validateAssetId(assetId);
    return this.mutate(validated, (record) => {
      if (!record) {
        throw new AssetLocalPersistenceError("INVALID_ARGUMENT", `asset '${validated}' is not tracked`);
      }
      return mutate(record);
    });
  }

  private validateOffset(value: number, byteSize: number): number {
    if (!Number.isSafeInteger(value) || value < 0 || value > byteSize) {
      throw new AssetLocalPersistenceError("INVALID_ARGUMENT", "upload offset is outside the asset");
    }
    return value;
  }

  private assertReadyIdentity(
    record: AssetOutboxRecord,
    ready: RemoteAssetReady,
  ): void {
    if (
      ready.assetId !== record.assetId
      || ready.sha256 !== record.sha256
      || ready.byteSize !== record.byteSize
    ) {
      throw new AssetLocalPersistenceError(
        "ASSET_ID_CONFLICT",
        "ready event does not match the immutable local asset identity",
      );
    }
  }

  private readonly handleBroadcastMessage = (event: MessageEvent<unknown>): void => {
    const value = event.data;
    if (
      typeof value !== "object"
      || value === null
      || !("type" in value)
      || value.type !== ASSET_CHANGE_MESSAGE
      || !("assetId" in value)
      || typeof value.assetId !== "string"
      || !ID_PATTERN.test(value.assetId)
      || !("revision" in value)
      || typeof value.revision !== "number"
      || !Number.isSafeInteger(value.revision)
      || value.revision < 1
    ) {
      return;
    }
    void this.emitAuthoritativeRecord(value.assetId, value.revision);
  };

  private async emitAuthoritativeRecord(
    assetId: string,
    advertisedRevision: number,
  ): Promise<void> {
    try {
      if ((this.observedRevisions.get(assetId) ?? 0) >= advertisedRevision) {
        return;
      }
      const record = await this.get(assetId);
      if (
        record
        && record.revision > (this.observedRevisions.get(assetId) ?? 0)
      ) {
        this.emit(record, false);
      }
    } catch {
      // A later notification or normal reload will reread the durable record.
    }
  }

  private emit(record: AssetOutboxRecord, broadcast = true): void {
    this.observedRevisions.set(record.assetId, record.revision);
    const event = { assetId: record.assetId, state: record.state, record: cloneRecord(record) };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Persistence already succeeded; another subscriber or reload repairs UI state.
      }
    }
    if (broadcast) {
      const message: AssetChangeMessage = {
        type: ASSET_CHANGE_MESSAGE,
        assetId: record.assetId,
        revision: record.revision,
      };
      try {
        this.broadcastChannel?.postMessage(message);
      } catch {
        // The durable write succeeded; polling or reload still repairs the UI.
      }
    }
  }
}

function normalizeTransportError(error: unknown): AssetTransportError {
  if (error instanceof AssetTransportError) return error;
  if (error instanceof AssetLocalPersistenceError) {
    const permanent = new Set<AssetLocalErrorCode>([
      "INVALID_ARGUMENT",
      "LOCAL_ASSET_TOO_LARGE",
      "ASSET_ID_CONFLICT",
      "MISSING_LOCAL_BLOB",
      "REMOTE_INTEGRITY",
    ]);
    return new AssetTransportError(
      error.code,
      error.message,
      permanent.has(error.code) ? "permanent" : "transient",
    );
  }
  return new AssetTransportError(
    "NETWORK_ERROR",
    error instanceof Error ? error.message : String(error),
    "transient",
  );
}

export class AssetUploadCoordinator {
  private readonly outbox: BoardAssetOutbox;
  private readonly transport: AssetUploadTransport;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly idlePollMs: number;
  private readonly preferredChunkBytes?: number;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly onlineTarget?: Pick<Window, "addEventListener" | "removeEventListener">;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private processing = false;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(options: AssetUploadCoordinatorOptions) {
    this.outbox = options.outbox;
    this.transport = options.transport;
    this.retryBaseMs = validatePositiveInteger(options.retryBaseMs ?? 1_000, "retryBaseMs");
    this.retryMaxMs = validatePositiveInteger(options.retryMaxMs ?? 5 * 60_000, "retryMaxMs");
    this.idlePollMs = validatePositiveInteger(options.idlePollMs ?? 30_000, "idlePollMs");
    this.preferredChunkBytes = options.preferredChunkBytes;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => Date.now());
    this.onlineTarget = options.onlineTarget
      ?? (typeof window !== "undefined" ? window : undefined);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.onlineTarget?.addEventListener("online", this.handleOnline);
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    this.onlineTarget?.removeEventListener("online", this.handleOnline);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.transport.cancelPending?.();
  }

  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async stopAndDrain(): Promise<void> {
    this.stop();
    await this.drain();
  }

  wake(): void {
    if (!this.running) return;
    this.schedule(0);
  }

  syncDueOnce(now = this.now()): Promise<AssetSyncPassResult> {
    return this.track(this.runSyncDueOnce(now));
  }

  private async runSyncDueOnce(now: number): Promise<AssetSyncPassResult> {
    const records = await this.outbox.listDue(now);
    const result: AssetSyncPassResult = {
      attempted: records.length,
      completed: 0,
      deferred: 0,
      blocked: 0,
    };
    for (const record of records) {
      try {
        await this.syncAsset(record.assetId);
        result.completed += 1;
      } catch (error) {
        const transportError = normalizeTransportError(error);
        if (transportError.code === "UPLOAD_EXPIRED" || transportError.code === "UPLOAD_GONE") {
          const retryAt = now + this.retryDelay(record.attemptCount + 1, transportError.retryAfterMs);
          await this.outbox.resetUpload(record.assetId, transportError.code, retryAt);
          result.deferred += 1;
        } else if (transportError.kind === "transient") {
          const retryAt = now + this.retryDelay(record.attemptCount + 1, transportError.retryAfterMs);
          await this.outbox.recordTransientFailure(record.assetId, transportError.code, retryAt);
          result.deferred += 1;
        } else {
          await this.outbox.markBlocked(record.assetId, transportError.code);
          result.blocked += 1;
        }
      }
    }
    return result;
  }

  repairRemotePlaceholders(): Promise<void> {
    return this.track(this.runRepairRemotePlaceholders());
  }

  private async runRepairRemotePlaceholders(): Promise<void> {
    for (const record of await this.outbox.listRemotePending()) {
      try {
        const status = await this.transport.status(record.assetId);
        if (status.status === "ready") {
          await this.cacheRemoteReady(record, status);
        } else if (status.status === "rejected") {
          this.assertRemoteIdentity(record, status);
          await this.outbox.markBlocked(record.assetId, status.errorCode ?? "ASSET_REJECTED");
        }
      } catch (error) {
        const transportError = normalizeTransportError(error);
        if (
          transportError.code !== "NOT_FOUND"
          && transportError.kind !== "transient"
        ) {
          await this.outbox.markBlocked(record.assetId, transportError.code);
        }
        // A CRDT reference can legitimately arrive before beginUpload creates
        // the server row. Missing or transient status stays repairable.
      }
    }
  }

  handleAssetReady(event: RemoteAssetReady): Promise<void> {
    return this.track(this.runHandleAssetReady(event));
  }

  private async runHandleAssetReady(event: RemoteAssetReady): Promise<void> {
    let existing = await this.outbox.get(event.assetId);
    if (!existing) {
      await this.outbox.trackRemote({
        assetId: event.assetId,
        sha256: event.sha256,
        byteSize: event.byteSize,
        declaredMime: event.mimeType,
      });
      existing = await this.outbox.get(event.assetId);
    }
    if (!existing) {
      throw new AssetTransportError(
        "MISSING_LOCAL_RECORD",
        "remote asset could not be tracked",
        "transient",
      );
    }
    try {
      await this.cacheRemoteReady(existing, event);
    } catch (error) {
      const transportError = normalizeTransportError(error);
      if (
        transportError.code !== "NOT_FOUND"
        && transportError.kind !== "transient"
      ) {
        await this.outbox.markBlocked(event.assetId, transportError.code);
      }
    }
  }

  private assertRemoteIdentity(
    record: AssetOutboxRecord,
    remote: Pick<RemoteAssetReady, "assetId" | "sha256" | "byteSize">,
  ): void {
    if (
      remote.assetId !== record.assetId
      || remote.sha256 !== record.sha256
      || remote.byteSize !== record.byteSize
    ) {
      throw new AssetTransportError(
        "INVALID_RESPONSE",
        "remote asset status does not match the CRDT reference",
        "transient",
      );
    }
  }

  private async cacheRemoteReady(
    record: AssetOutboxRecord,
    ready: RemoteAssetReady,
  ): Promise<void> {
    this.assertRemoteIdentity(record, ready);
    if (record.blob) {
      await this.outbox.markReady(record.assetId, ready);
      return;
    }
    const blob = await this.transport.download(record.assetId, ready);
    await this.outbox.cacheRemoteReady(record.assetId, ready, blob);
  }

  private async syncAsset(assetId: string): Promise<void> {
    let record = await this.outbox.get(assetId);
    if (!record || !record.blob) {
      throw new AssetTransportError("MISSING_LOCAL_BLOB", "local asset blob is unavailable", "permanent");
    }
    if (record.state === "ready") return;
    if (!record.uploadId) {
      const started = await this.transport.begin({
        assetId: record.assetId,
        sha256: record.sha256,
        byteSize: record.byteSize,
        declaredMime: record.declaredMime,
        originalFileName: record.originalFileName,
        preferredChunkBytes: this.preferredChunkBytes,
      });
      if (started.status === "ready") {
        await this.outbox.markReady(record.assetId, started.asset);
        return;
      }
      record = await this.outbox.setUploadSession(record.assetId, started);
      if (record.state === "ready") return;
    }
    if (!record.uploadId || !record.chunkBytes || !record.blob) {
      throw new AssetTransportError("INVALID_UPLOAD_STATE", "upload session is incomplete", "permanent");
    }
    const uploadId = record.uploadId;
    const chunkBytes = record.chunkBytes;
    const blob = record.blob;
    let offset = record.nextOffset;
    while (offset < record.byteSize) {
      const end = Math.min(record.byteSize, offset + chunkBytes);
      const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      const acknowledged = await this.transport.writeChunk({
        assetId: record.assetId,
        uploadId,
        offset,
        chunk,
        chunkSha256: await this.outbox.digestBytes(chunk),
      });
      if (
        !Number.isSafeInteger(acknowledged.nextOffset)
        || acknowledged.nextOffset < end
        || acknowledged.nextOffset > record.byteSize
      ) {
        throw new AssetTransportError(
          "INVALID_SERVER_OFFSET",
          "server returned an invalid upload offset",
          "permanent",
        );
      }
      record = await this.outbox.acknowledgeOffset(
        record.assetId,
        uploadId,
        acknowledged.nextOffset,
      );
      if (record.state === "ready") return;
      offset = acknowledged.nextOffset;
    }
    const ready = await this.transport.finalize({
      assetId: record.assetId,
      uploadId,
    });
    await this.outbox.markReady(record.assetId, ready);
  }

  private retryDelay(attempt: number, serverDelay: number | undefined): number {
    const exponential = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.min(attempt - 1, 20)));
    const jittered = Math.round(exponential * (0.8 + this.random() * 0.4));
    return Math.max(jittered, serverDelay ?? 0);
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.processing) return;
    this.processing = true;
    try {
      await this.syncDueOnce();
      if (this.running) await this.repairRemotePlaceholders();
    } finally {
      this.processing = false;
      this.schedule(this.idlePollMs);
    }
  }

  private readonly handleOnline = (): void => {
    this.wake();
  };

  private track<T>(operation: Promise<T>): Promise<T> {
    this.inFlight.add(operation);
    void operation.finally(() => {
      this.inFlight.delete(operation);
    }).catch(() => undefined);
    return operation;
  }
}
