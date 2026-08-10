import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  closeSync,
  createReadStream,
  fsyncSync,
  mkdirSync,
  openSync,
  type ReadStream,
  unlinkSync,
} from "node:fs";
import {
  access,
  chmod,
  link,
  mkdir,
  open,
  stat,
  statfs,
} from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  EncodedImageError,
  inspectEncodedImage,
  type SupportedBoardAssetMime,
} from "./assetsImage.js";
export { installBoardAssetSchema } from "./assetsSchema.js";

export const DEFAULT_BOARD_ASSET_LIMITS = Object.freeze({
  maxAssetBytes: 128 * 1024 * 1024,
  maxChunkBytes: 2 * 1024 * 1024,
  defaultChunkBytes: 1024 * 1024,
  maxHeaderBytes: 1024 * 1024,
  maxWidth: 16_384,
  maxHeight: 16_384,
  maxPixelsPerFrame: 100_000_000,
  maxFrameCount: 500,
  maxTotalDecodedPixels: 250_000_000,
  tenantSoftQuotaBytes: 20 * 1024 * 1024 * 1024,
  minFreeDiskBytes: 2 * 1024 * 1024 * 1024,
  maxActiveUploadsPerTenant: 32,
  maxAssetRecordsPerTenant: 10_000,
  maxGuestAssetRecordsGlobal: 100_000,
  assetMetadataReserveBytes: 2 * 1024,
  maxConcurrentDecodes: 2,
  maxQueuedDecodes: 8,
  decodeTimeoutSeconds: 30,
  uploadTtlMs: 24 * 60 * 60 * 1000,
});
export const GUEST_BOARD_ASSET_TENANT_PREFIX = "guest-room-";
export const GUEST_BOARD_ASSET_TENANT_SOFT_QUOTA_BYTES = 512 * 1024 * 1024;
export const GUEST_BOARD_ASSET_GLOBAL_SOFT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

export interface BoardAssetLimits {
  maxAssetBytes: number;
  maxChunkBytes: number;
  defaultChunkBytes: number;
  maxHeaderBytes: number;
  maxWidth: number;
  maxHeight: number;
  maxPixelsPerFrame: number;
  maxFrameCount: number;
  maxTotalDecodedPixels: number;
  tenantSoftQuotaBytes: number;
  minFreeDiskBytes: number;
  maxActiveUploadsPerTenant: number;
  maxAssetRecordsPerTenant: number;
  maxGuestAssetRecordsGlobal: number;
  assetMetadataReserveBytes: number;
  maxConcurrentDecodes: number;
  maxQueuedDecodes: number;
  decodeTimeoutSeconds: number;
  uploadTtlMs: number;
}

export type AssetAccessOperation =
  | "begin-upload"
  | "write-chunk"
  | "finalize-upload"
  | "status"
  | "download"
  | "metrics";

export interface AssetAccessRequest {
  operation: AssetAccessOperation;
  boardId: string;
  generation: number;
  assetId?: string;
  uploadId?: string;
}

export interface AssetAuthorization {
  /** Authoritative tutor tenant. Never take this value from request data. */
  tenantId: string;
  actorId: string;
  /** Optional stricter quota for this authoritative tenant class. */
  tenantSoftQuotaBytes?: number;
  /** Optional aggregate quota shared by authoritative tenant IDs with a prefix. */
  aggregateQuota?: Readonly<{
    tenantIdPrefix: string;
    softQuotaBytes: number;
  }>;
  /** Rechecks an async publication immediately before reading mutable rows. */
  assertPublicationActive?: () => void;
  /** Runs inside a newly-created ready asset's publication transaction. */
  commitActivity?: () => void;
}

export type AssetAuthorizer<TPrincipal> = (
  principal: TPrincipal,
  request: AssetAccessRequest,
) => AssetAuthorization | Promise<AssetAuthorization>;

export interface AssetDecodeRequest {
  filePath: string;
  mimeType: SupportedBoardAssetMime;
  encodedWidth: number;
  encodedHeight: number;
  limits: Readonly<Pick<
    BoardAssetLimits,
    "maxWidth" | "maxHeight" | "maxPixelsPerFrame" | "maxFrameCount" | "maxTotalDecodedPixels" | "decodeTimeoutSeconds"
  >>;
}

export interface DecodedAssetInfo {
  /** A decoder must consume the complete image, not merely parse its header. */
  fullyDecoded: true;
  width: number;
  height: number;
  frameCount: number;
  totalDecodedPixels: number;
}

export type AssetDecodeProbe = (request: AssetDecodeRequest) => Promise<DecodedAssetInfo>;

export interface AssetCapacityProbe {
  freeDiskBytes(storageRoot: string): Promise<number>;
}

export class NodeAssetCapacityProbe implements AssetCapacityProbe {
  async freeDiskBytes(storageRoot: string): Promise<number> {
    const info = await statfs(storageRoot);
    return Number(info.bavail) * Number(info.bsize);
  }
}

export interface AssetReadyEvent {
  type: "asset-ready";
  boardId: string;
  generation: number;
  assetId: string;
  sha256: string;
  mimeType: SupportedBoardAssetMime;
  byteSize: number;
  width: number;
  height: number;
  frameCount: number;
  totalDecodedPixels: number;
  publishedAt: string;
}

export type AssetEventSink = (event: AssetReadyEvent) => void | Promise<void>;

export type AssetServiceErrorCode =
  | "INVALID_ARGUMENT"
  | "ROOM_EXPIRED"
  | "ASSET_TOO_LARGE"
  | "CHUNK_TOO_LARGE"
  | "CHUNK_HASH_MISMATCH"
  | "OFFSET_MISMATCH"
  | "UPLOAD_INCOMPLETE"
  | "UPLOAD_EXPIRED"
  | "UPLOAD_GONE"
  | "NOT_FOUND"
  | "ASSET_ID_CONFLICT"
  | "TENANT_QUOTA"
  | "DISK_PRESSURE"
  | "HASH_MISMATCH"
  | "MIME_MISMATCH"
  | "SVG_REJECTED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "MALFORMED_IMAGE"
  | "DIMENSION_LIMIT"
  | "DECODE_FAILED"
  | "STORAGE_ERROR"
  | "STORAGE_CORRUPT"
  | "RANGE_NOT_SATISFIABLE";

export class AssetServiceError extends Error {
  constructor(
    public readonly code: AssetServiceErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AssetServiceError";
  }
}

export interface BeginAssetUploadInput {
  boardId: string;
  generation: number;
  assetId: string;
  sha256: string;
  byteSize: number;
  declaredMime: string;
  originalFileName?: string;
  preferredChunkBytes?: number;
}

export type BeginAssetUploadResult =
  | {
    status: "ready";
    asset: ReadyAssetStatus;
    deduplicated: boolean;
    created: boolean;
  }
  | {
    status: "upload";
    uploadId: string;
    nextOffset: number;
    chunkBytes: number;
    expiresAt: string;
  };

export interface WriteAssetChunkInput {
  boardId: string;
  generation: number;
  assetId: string;
  uploadId: string;
  offset: number;
  chunk: Uint8Array;
  chunkSha256: string;
}

export interface WriteAssetChunkResult {
  nextOffset: number;
  complete: boolean;
  duplicate: boolean;
}

export interface AssetIdentityInput {
  boardId: string;
  generation: number;
  assetId: string;
}

export interface FinalizeAssetUploadInput extends AssetIdentityInput {
  uploadId: string;
}

export interface PendingAssetStatus {
  status: "pending";
  assetId: string;
  sha256: string;
  byteSize: number;
}

export interface RejectedAssetStatus {
  status: "rejected";
  assetId: string;
  sha256: string;
  byteSize: number;
  errorCode: string | null;
}

export interface ReadyAssetStatus {
  status: "ready";
  assetId: string;
  sha256: string;
  mimeType: SupportedBoardAssetMime;
  byteSize: number;
  width: number;
  height: number;
  frameCount: number;
  totalDecodedPixels: number;
  publishedAt: string;
}

export interface FinalizeAssetUploadResult {
  asset: ReadyAssetStatus;
  created: boolean;
}

export type AssetStatus = PendingAssetStatus | RejectedAssetStatus | ReadyAssetStatus;

export interface AssetByteRange {
  start: number;
  endInclusive: number;
  length: number;
}

export interface AssetDownload {
  statusCode: 200 | 206;
  headers: Readonly<Record<string, string>>;
  range: AssetByteRange;
  stream: ReadStream;
}

export interface BoardAssetMetrics {
  assetCount: number;
  logicalBytes: number;
  readyCount: number;
  readyBytes: number;
  physicalBlobCount: number;
  physicalBlobBytes: number;
  pendingCount: number;
}

export interface AssetServiceOptions<TPrincipal> {
  db: Database.Database;
  privateStorageRoot: string;
  authorize: AssetAuthorizer<TPrincipal>;
  decode: AssetDecodeProbe;
  limits?: Partial<BoardAssetLimits>;
  capacityProbe?: AssetCapacityProbe;
  onEvent?: AssetEventSink;
  forbiddenPublicRoots?: string[];
  now?: () => Date;
}

interface AssetRow {
  board_id: string;
  generation: number;
  asset_id: string;
  tenant_id: string;
  status: "pending" | "ready" | "rejected";
  expected_sha256: string;
  blob_sha256: string | null;
  byte_size: number;
  declared_mime: string;
  detected_mime: SupportedBoardAssetMime | null;
  original_file_name: string | null;
  width: number | null;
  height: number | null;
  frame_count: number | null;
  decoded_pixels: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  last_error_code: string | null;
}

interface CommittedAssetResult {
  asset: AssetRow;
  created: boolean;
}

interface BlobRow {
  tenant_id: string;
  sha256: string;
  storage_key: string;
  mime_type: SupportedBoardAssetMime;
  byte_size: number;
  width: number;
  height: number;
  frame_count: number;
  decoded_pixels: number;
  created_at: string;
}

interface UploadRow {
  upload_id: string;
  board_id: string;
  generation: number;
  asset_id: string;
  tenant_id: string;
  expected_sha256: string;
  expected_bytes: number;
  chunk_bytes: number;
  next_offset: number;
  staging_key: string;
  final_storage_key: string | null;
  status: "active" | "completed" | "rejected";
  failure_code: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  completed_at: string | null;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;

function invalid(message: string): never {
  throw new AssetServiceError("INVALID_ARGUMENT", message);
}

function validateId(value: string, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    invalid(`${label} must be a 1-128 character opaque ID`);
  }
  return value;
}

function validateGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) invalid("generation must be a positive safe integer");
  return value;
}

function validatePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) invalid(`${label} must be a positive safe integer`);
  return value;
}

function validateNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${label} must be a non-negative safe integer`);
  return value;
}

function validateSha256(value: string, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalid(`${label} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

function normalizeMime(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "application/octet-stream") return normalized;
  if (!MIME_PATTERN.test(normalized)) invalid("declaredMime is malformed");
  return normalized;
}

function normalizeFileName(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  if (!normalized) return null;
  return normalized.slice(0, 240);
}

function normalizeLimits(overrides: Partial<BoardAssetLimits> = {}): BoardAssetLimits {
  const limits = { ...DEFAULT_BOARD_ASSET_LIMITS, ...overrides };
  for (const [label, value] of Object.entries(limits)) validatePositiveInteger(value, label);
  if (limits.defaultChunkBytes > limits.maxChunkBytes) {
    invalid("defaultChunkBytes must not exceed maxChunkBytes");
  }
  return limits;
}

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly capacity: number,
    private readonly maximumQueued: number,
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.capacity) {
      this.active += 1;
      return;
    }
    if (this.waiters.length >= this.maximumQueued) {
      throw new AssetServiceError(
        "STORAGE_ERROR",
        "asset finalize queue is saturated",
        true,
        30_000,
      );
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeStoragePath(root: string, storageKey: string): string {
  const absolute = path.resolve(root, ...storageKey.split("/"));
  if (!isWithin(absolute, root)) throw new AssetServiceError("STORAGE_CORRUPT", "unsafe storage key");
  return absolute;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readPrefix(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    const output = Buffer.alloc(Math.min(info.size, maxBytes));
    const result = await handle.read(output, 0, output.byteLength, 0);
    return output.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryChain(root: string, leaf: string): Promise<void> {
  if (process.platform === "win32") return;
  let current = path.resolve(leaf);
  const resolvedRoot = path.resolve(root);
  while (isWithin(current, resolvedRoot)) {
    await syncDirectory(current);
    if (current === resolvedRoot) break;
    current = path.dirname(current);
  }
}

function syncDirectoryChainSync(root: string, leaf: string): void {
  if (process.platform === "win32") return;
  let current = path.resolve(leaf);
  const resolvedRoot = path.resolve(root);
  while (isWithin(current, resolvedRoot)) {
    const descriptor = openSync(current, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (current === resolvedRoot) break;
    current = path.dirname(current);
  }
}

function toStatus(row: AssetRow): AssetStatus {
  if (row.status === "ready") {
    return {
      status: "ready",
      assetId: row.asset_id,
      sha256: row.blob_sha256!,
      mimeType: row.detected_mime!,
      byteSize: row.byte_size,
      width: row.width!,
      height: row.height!,
      frameCount: row.frame_count!,
      totalDecodedPixels: row.decoded_pixels!,
      publishedAt: row.published_at!,
    };
  }
  if (row.status === "rejected") {
    return {
      status: "rejected",
      assetId: row.asset_id,
      sha256: row.expected_sha256,
      byteSize: row.byte_size,
      errorCode: row.last_error_code,
    };
  }
  return {
    status: "pending",
    assetId: row.asset_id,
    sha256: row.expected_sha256,
    byteSize: row.byte_size,
  };
}

export function parseAssetByteRange(rangeHeader: string | undefined, totalBytes: number): AssetByteRange {
  validatePositiveInteger(totalBytes, "totalBytes");
  if (!rangeHeader) return { start: 0, endInclusive: totalBytes - 1, length: totalBytes };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader.trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    throw new AssetServiceError("RANGE_NOT_SATISFIABLE", "only one bytes range is supported");
  }
  let start: number;
  let endInclusive: number;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) {
      throw new AssetServiceError("RANGE_NOT_SATISFIABLE", "invalid suffix byte range");
    }
    const length = Math.min(suffixLength, totalBytes);
    start = totalBytes - length;
    endInclusive = totalBytes - 1;
  } else {
    start = Number(match[1]);
    endInclusive = match[2] === "" ? totalBytes - 1 : Number(match[2]);
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(endInclusive)
      || start < 0
      || start >= totalBytes
      || endInclusive < start
    ) {
      throw new AssetServiceError("RANGE_NOT_SATISFIABLE", "byte range is outside the asset");
    }
    endInclusive = Math.min(endInclusive, totalBytes - 1);
  }
  return { start, endInclusive, length: endInclusive - start + 1 };
}

export class BoardAssetService<TPrincipal> {
  readonly limits: BoardAssetLimits;
  readonly privateStorageRoot: string;

  private readonly db: Database.Database;
  private readonly authorize: AssetAuthorizer<TPrincipal>;
  private readonly decode: AssetDecodeProbe;
  private readonly capacityProbe: AssetCapacityProbe;
  private readonly onEvent?: AssetEventSink;
  private readonly now: () => Date;
  private readonly finalizeSemaphore: AsyncSemaphore;
  private readonly activeUploadOperations = new Map<string, Promise<unknown>>();

  constructor(options: AssetServiceOptions<TPrincipal>) {
    this.db = options.db;
    this.authorize = options.authorize;
    this.decode = options.decode;
    this.capacityProbe = options.capacityProbe ?? new NodeAssetCapacityProbe();
    this.onEvent = options.onEvent;
    this.now = options.now ?? (() => new Date());
    this.limits = normalizeLimits(options.limits);
    this.finalizeSemaphore = new AsyncSemaphore(
      this.limits.maxConcurrentDecodes,
      this.limits.maxQueuedDecodes,
    );
    this.privateStorageRoot = path.resolve(options.privateStorageRoot);
    for (const publicRoot of options.forbiddenPublicRoots ?? []) {
      if (isWithin(this.privateStorageRoot, publicRoot)) {
        invalid("privateStorageRoot must be outside every public web root");
      }
    }
    mkdirSync(this.privateStorageRoot, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(this.privateStorageRoot, "staging"), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(this.privateStorageRoot, "blobs"), { recursive: true, mode: 0o700 });
    this.db.pragma("foreign_keys = ON");
  }

  async beginUpload(principal: TPrincipal, input: BeginAssetUploadInput): Promise<BeginAssetUploadResult> {
    const identity = this.validateIdentity(input);
    const sha256 = validateSha256(input.sha256, "sha256");
    const byteSize = validatePositiveInteger(input.byteSize, "byteSize");
    if (byteSize > this.limits.maxAssetBytes) {
      throw new AssetServiceError(
        "ASSET_TOO_LARGE",
        `asset is ${byteSize} bytes; the per-asset limit is ${this.limits.maxAssetBytes}`,
      );
    }
    const declaredMime = normalizeMime(input.declaredMime);
    const originalFileName = normalizeFileName(input.originalFileName);
    const requestedChunkBytes = input.preferredChunkBytes === undefined
      ? this.limits.defaultChunkBytes
      : validatePositiveInteger(input.preferredChunkBytes, "preferredChunkBytes");
    const chunkBytes = Math.min(requestedChunkBytes, this.limits.maxChunkBytes);
    const authorization = await this.authorize(principal, {
      operation: "begin-upload",
      ...identity,
    });
    const tenantId = validateId(authorization.tenantId, "authorized tenantId");
    const actorId = validateId(authorization.actorId, "authorized actorId");

    const existing = this.findAsset(identity);
    if (existing) {
      this.assertAssetIdentity(existing, tenantId, sha256, byteSize, declaredMime);
      if (existing.status === "ready") {
        await this.assertPublishedBlobAvailable(existing);
        return {
          status: "ready",
          asset: toStatus(existing) as ReadyAssetStatus,
          deduplicated: true,
          created: false,
        };
      }
      const active = this.findActiveUpload(identity);
      if (active) {
        if (active.expires_at > this.now().toISOString()) {
          const stagingPath = safeStoragePath(this.privateStorageRoot, active.staging_key);
          if (await fileExists(stagingPath)) {
            return {
              status: "upload",
              uploadId: active.upload_id,
              nextOffset: active.next_offset,
              chunkBytes: active.chunk_bytes,
              expiresAt: active.expires_at,
            };
          }
          this.rejectUploadRows(active, "UPLOAD_GONE");
        } else {
          this.rejectUploadRows(active, "UPLOAD_EXPIRED");
        }
      }
    }

    const blob = this.findBlob(tenantId, sha256);
    if (blob) {
      if (blob.byte_size !== byteSize) {
        throw new AssetServiceError("HASH_MISMATCH", "published blob size does not match this upload");
      }
      if (
        declaredMime
        && declaredMime !== "application/octet-stream"
        && declaredMime !== blob.mime_type
      ) {
        throw new AssetServiceError(
          "MIME_MISMATCH",
          `declared MIME ${declaredMime} does not match ${blob.mime_type}`,
        );
      }
      await this.assertBlobFileAvailable(blob);
      const observedFreeBytes = await this.readFreeDiskBytes();
      const committed = this.linkExistingBlob(identity, {
        tenantId,
        actorId,
        sha256,
        byteSize,
        declaredMime,
        originalFileName,
        blob,
        observedFreeBytes,
        assertPublicationActive: authorization.assertPublicationActive,
        commitActivity: authorization.commitActivity,
      });
      if (committed.created) await this.emitReady(committed.asset);
      return {
        status: "ready",
        asset: toStatus(committed.asset) as ReadyAssetStatus,
        deduplicated: true,
        created: committed.created,
      };
    }

    const observedFreeBytes = await this.readFreeDiskBytes();

    const uploadId = randomUUID();
    const tenantDigest = createHash("sha256").update(tenantId).digest("hex");
    const stagingKey = `staging/${tenantDigest}/${uploadId}.part`;
    const stagingPath = safeStoragePath(this.privateStorageRoot, stagingKey);
    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.limits.uploadTtlMs).toISOString();
    try {
      this.db.transaction(() => {
        this.db.prepare(`
          INSERT OR IGNORE INTO board_asset_gc_queue (storage_key, enqueued_at)
          VALUES (?, ?)
        `).run(stagingKey, nowIso);
      }).immediate();
    } catch (error) {
      throw new AssetServiceError(
        "STORAGE_ERROR",
        `could not persist upload staging intent: ${
          error instanceof Error ? error.message : String(error)
        }`,
        true,
      );
    }

    let concurrentReady: AssetRow | undefined;
    let concurrentUpload: UploadRow | undefined;
    try {
      this.db.transaction(() => {
        const current = this.findAsset(identity);
        if (current) {
          this.assertAssetIdentity(current, tenantId, sha256, byteSize, declaredMime);
          if (current.status === "ready") {
            concurrentReady = current;
            this.db.prepare("DELETE FROM board_asset_gc_queue WHERE storage_key = ?")
              .run(stagingKey);
            return;
          }
          concurrentUpload = this.findActiveUpload(identity);
          if (concurrentUpload) {
            this.db.prepare("DELETE FROM board_asset_gc_queue WHERE storage_key = ?")
              .run(stagingKey);
            return;
          }
        }
        this.assertCapacityForNewUpload(
          tenantId,
          byteSize,
          observedFreeBytes,
          authorization,
          !current,
        );
        if (current) {
          this.db.prepare(`
            UPDATE board_assets
            SET status = 'pending', updated_at = ?, last_error_code = NULL
            WHERE board_id = ? AND generation = ? AND asset_id = ?
          `).run(nowIso, identity.boardId, identity.generation, identity.assetId);
        } else {
          this.db.prepare(`
            INSERT INTO board_assets (
              board_id, generation, asset_id, tenant_id, status, expected_sha256,
              byte_size, declared_mime, original_file_name, created_by,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
          `).run(
            identity.boardId,
            identity.generation,
            identity.assetId,
            tenantId,
            sha256,
            byteSize,
            declaredMime,
            originalFileName,
            actorId,
            nowIso,
            nowIso,
          );
        }
        this.db.prepare(`
          INSERT INTO board_asset_uploads (
            upload_id, board_id, generation, asset_id, tenant_id, expected_sha256,
            expected_bytes, chunk_bytes, next_offset, staging_key, status,
            created_at, updated_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?, ?, ?)
        `).run(
          uploadId,
          identity.boardId,
          identity.generation,
          identity.assetId,
          tenantId,
          sha256,
          byteSize,
          chunkBytes,
          stagingKey,
          nowIso,
          nowIso,
          expiresAt,
        );
        try {
          mkdirSync(path.dirname(stagingPath), { recursive: true, mode: 0o700 });
          const descriptor = openSync(stagingPath, "wx", 0o600);
          try {
            fsyncSync(descriptor);
          } finally {
            closeSync(descriptor);
          }
          syncDirectoryChainSync(
            path.join(this.privateStorageRoot, "staging"),
            path.dirname(stagingPath),
          );
        } catch (error) {
          throw new AssetServiceError(
            "STORAGE_ERROR",
            `could not create private upload staging file: ${
              error instanceof Error ? error.message : String(error)
            }`,
            true,
          );
        }
        this.db.prepare("DELETE FROM board_asset_gc_queue WHERE storage_key = ?")
          .run(stagingKey);
      }).immediate();
    } catch (error) {
      const winner = this.findActiveUpload(identity);
      if (winner) {
        const winnerPath = safeStoragePath(this.privateStorageRoot, winner.staging_key);
        if (!await fileExists(winnerPath)) {
          this.rejectUploadRows(winner, "UPLOAD_GONE");
        } else {
          return {
            status: "upload",
            uploadId: winner.upload_id,
            nextOffset: winner.next_offset,
            chunkBytes: winner.chunk_bytes,
            expiresAt: winner.expires_at,
          };
        }
      }
      if (error instanceof AssetServiceError) throw error;
      throw new AssetServiceError(
        "STORAGE_ERROR",
        `could not persist upload session: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    if (concurrentReady) {
      await this.assertPublishedBlobAvailable(concurrentReady);
      return {
        status: "ready",
        asset: toStatus(concurrentReady) as ReadyAssetStatus,
        deduplicated: true,
        created: false,
      };
    }
    if (concurrentUpload) {
      const concurrentPath = safeStoragePath(
        this.privateStorageRoot,
        concurrentUpload.staging_key,
      );
      if (!await fileExists(concurrentPath)) {
        this.rejectUploadRows(concurrentUpload, "UPLOAD_GONE");
        return await this.beginUpload(principal, input);
      }
      return {
        status: "upload",
        uploadId: concurrentUpload.upload_id,
        nextOffset: concurrentUpload.next_offset,
        chunkBytes: concurrentUpload.chunk_bytes,
        expiresAt: concurrentUpload.expires_at,
      };
    }
    return { status: "upload", uploadId, nextOffset: 0, chunkBytes, expiresAt };
  }

  async writeChunk(principal: TPrincipal, input: WriteAssetChunkInput): Promise<WriteAssetChunkResult> {
    return await this.withUploadOperation(
      input.uploadId,
      () => this.writeChunkOnce(principal, input),
    );
  }

  private async writeChunkOnce(
    principal: TPrincipal,
    input: WriteAssetChunkInput,
  ): Promise<WriteAssetChunkResult> {
    const identity = this.validateIdentity(input);
    const uploadId = validateId(input.uploadId, "uploadId");
    const offset = validateNonNegativeInteger(input.offset, "offset");
    const chunkSha256 = validateSha256(input.chunkSha256, "chunkSha256");
    if (!(input.chunk instanceof Uint8Array) || input.chunk.byteLength === 0) {
      invalid("chunk must be a non-empty Uint8Array");
    }
    if (input.chunk.byteLength > this.limits.maxChunkBytes) {
      throw new AssetServiceError(
        "CHUNK_TOO_LARGE",
        `chunk is ${input.chunk.byteLength} bytes; the limit is ${this.limits.maxChunkBytes}`,
      );
    }
    if (hashBytes(input.chunk) !== chunkSha256) {
      throw new AssetServiceError("CHUNK_HASH_MISMATCH", "chunk does not match chunkSha256");
    }
    const authorization = await this.authorize(principal, {
      operation: "write-chunk",
      ...identity,
      uploadId,
    });
    const tenantId = validateId(authorization.tenantId, "authorized tenantId");
    const upload = this.requireUpload(identity, uploadId, tenantId);
    await this.assertActiveUpload(upload);
    if (input.chunk.byteLength > upload.chunk_bytes) {
      throw new AssetServiceError("CHUNK_TOO_LARGE", "chunk exceeds the negotiated upload chunk size");
    }
    const endOffset = offset + input.chunk.byteLength;
    if (!Number.isSafeInteger(endOffset) || endOffset > upload.expected_bytes) {
      throw new AssetServiceError("OFFSET_MISMATCH", "chunk exceeds the declared asset size");
    }
    const stagingPath = safeStoragePath(this.privateStorageRoot, upload.staging_key);
    if (!await fileExists(stagingPath)) {
      this.rejectUploadRows(upload, "UPLOAD_GONE");
      throw new AssetServiceError("UPLOAD_GONE", "upload staging file is missing", true);
    }

    if (offset < upload.next_offset) {
      if (endOffset > upload.next_offset) {
        throw new AssetServiceError(
          "OFFSET_MISMATCH",
          `chunk overlaps acknowledged data; expected offset ${upload.next_offset}`,
        );
      }
      const existing = await this.readFileRange(stagingPath, offset, input.chunk.byteLength);
      if (!Buffer.from(input.chunk).equals(existing)) {
        throw new AssetServiceError("CHUNK_HASH_MISMATCH", "retried chunk differs from durable bytes");
      }
      return {
        nextOffset: upload.next_offset,
        complete: upload.next_offset === upload.expected_bytes,
        duplicate: true,
      };
    }
    if (offset !== upload.next_offset) {
      throw new AssetServiceError(
        "OFFSET_MISMATCH",
        `expected chunk offset ${upload.next_offset}, received ${offset}`,
      );
    }

    try {
      const handle = await open(stagingPath, "r+");
      try {
        let written = 0;
        const bytes = Buffer.from(input.chunk);
        while (written < bytes.byteLength) {
          const result = await handle.write(bytes, written, bytes.byteLength - written, offset + written);
          if (result.bytesWritten < 1) throw new Error("zero-byte file write");
          written += result.bytesWritten;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        this.rejectUploadRows(upload, "UPLOAD_GONE");
        throw new AssetServiceError("UPLOAD_GONE", "upload staging file is missing", true);
      }
      throw new AssetServiceError(
        "STORAGE_ERROR",
        `could not durably store asset chunk: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }

    const now = this.now();
    const nextExpiry = new Date(now.getTime() + this.limits.uploadTtlMs).toISOString();
    let updateChanges: number;
    try {
      updateChanges = this.db.prepare(`
        UPDATE board_asset_uploads
        SET next_offset = ?, updated_at = ?, expires_at = ?
        WHERE upload_id = ? AND board_id = ? AND generation = ? AND asset_id = ?
          AND tenant_id = ? AND status = 'active' AND next_offset = ?
      `).run(
        endOffset,
        now.toISOString(),
        nextExpiry,
        uploadId,
        identity.boardId,
        identity.generation,
        identity.assetId,
        tenantId,
        offset,
      ).changes;
    } catch (error) {
      throw new AssetServiceError(
        "STORAGE_ERROR",
        `could not persist durable chunk offset: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    if (updateChanges !== 1) {
      const current = this.requireUpload(identity, uploadId, tenantId);
      if (current.next_offset >= endOffset) {
        const existing = await this.readFileRange(stagingPath, offset, input.chunk.byteLength);
        if (Buffer.from(input.chunk).equals(existing)) {
          return {
            nextOffset: current.next_offset,
            complete: current.next_offset === current.expected_bytes,
            duplicate: true,
          };
        }
      }
      throw new AssetServiceError("OFFSET_MISMATCH", `upload now expects offset ${current.next_offset}`);
    }
    return {
      nextOffset: endOffset,
      complete: endOffset === upload.expected_bytes,
      duplicate: false,
    };
  }

  async finalizeUpload(
    principal: TPrincipal,
    input: FinalizeAssetUploadInput,
  ): Promise<FinalizeAssetUploadResult> {
    return await this.withUploadOperation(
      input.uploadId,
      () => this.finalizeUploadOnce(principal, input),
    );
  }

  private async finalizeUploadOnce(
    principal: TPrincipal,
    input: FinalizeAssetUploadInput,
  ): Promise<FinalizeAssetUploadResult> {
    const identity = this.validateIdentity(input);
    const uploadId = validateId(input.uploadId, "uploadId");
    const authorization = await this.authorize(principal, {
      operation: "finalize-upload",
      ...identity,
      uploadId,
    });
    const tenantId = validateId(authorization.tenantId, "authorized tenantId");
    const upload = this.requireUpload(identity, uploadId, tenantId);
    const asset = this.requireAsset(identity, tenantId);
    if (upload.status === "completed" && asset.status === "ready") {
      await this.assertPublishedBlobAvailable(asset);
      return {
        asset: toStatus(asset) as ReadyAssetStatus,
        created: false,
      };
    }
    await this.assertActiveUpload(upload);
    if (upload.next_offset !== upload.expected_bytes) {
      throw new AssetServiceError(
        "UPLOAD_INCOMPLETE",
        `upload has ${upload.next_offset} of ${upload.expected_bytes} bytes`,
        true,
      );
    }
    const stagingPath = safeStoragePath(this.privateStorageRoot, upload.staging_key);
    if (!await fileExists(stagingPath)) {
      this.rejectUploadRows(upload, "UPLOAD_GONE");
      throw new AssetServiceError("UPLOAD_GONE", "upload staging file is missing", true);
    }

    let encoded: ReturnType<typeof inspectEncodedImage>;
    let decoded: DecodedAssetInfo;
    try {
      ({ encoded, decoded } = await this.finalizeSemaphore.run(async () => {
        const fileInfo = await stat(stagingPath);
        if (fileInfo.size !== upload.expected_bytes) {
          return await this.rejectFinalize(
            upload,
            "STORAGE_CORRUPT",
            "staged file size differs from acknowledged upload size",
          );
        }
        const actualSha256 = await sha256File(stagingPath);
        if (actualSha256 !== upload.expected_sha256) {
          return await this.rejectFinalize(
            upload,
            "HASH_MISMATCH",
            "uploaded asset hash does not match",
          );
        }
        const header = await readPrefix(stagingPath, this.limits.maxHeaderBytes);
        const inspected = inspectEncodedImage(header);
        if (
          asset.declared_mime
          && asset.declared_mime !== "application/octet-stream"
          && asset.declared_mime !== inspected.mimeType
        ) {
          return await this.rejectFinalize(
            upload,
            "MIME_MISMATCH",
            `declared MIME ${asset.declared_mime} does not match ${inspected.mimeType}`,
          );
        }
        this.assertEncodedDimensions(inspected.width, inspected.height);
        const fullyDecoded = await this.decode({
          filePath: stagingPath,
          mimeType: inspected.mimeType,
          encodedWidth: inspected.width,
          encodedHeight: inspected.height,
          limits: this.limits,
        });
        this.assertDecodedImage(inspected, fullyDecoded);
        return { encoded: inspected, decoded: fullyDecoded };
      }));
    } catch (error) {
      if (error instanceof AssetServiceError) {
        if (error.code === "DIMENSION_LIMIT" || error.code === "DECODE_FAILED") {
          return await this.rejectFinalize(upload, error.code, error.message);
        }
        throw error;
      }
      if (error instanceof EncodedImageError) {
        return await this.rejectFinalize(upload, error.code, error.message);
      }
      return await this.rejectFinalize(
        upload,
        "DECODE_FAILED",
        `asset could not be fully decoded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await this.assertFreeDiskFloor();
    const tenantDigest = createHash("sha256").update(tenantId).digest("hex");
    const storageKey = `blobs/${tenantDigest}/${upload.expected_sha256.slice(0, 2)}/${upload.expected_sha256}`;
    const finalPath = safeStoragePath(this.privateStorageRoot, storageKey);
    try {
      this.db.transaction(() => {
        authorization.assertPublicationActive?.();
        const currentUpload = this.requireUpload(identity, uploadId, tenantId);
        if (
          currentUpload.final_storage_key !== null
          && currentUpload.final_storage_key !== storageKey
        ) {
          throw new AssetServiceError(
            "STORAGE_CORRUPT",
            "upload final storage key conflicts with its content identity",
          );
        }
        if (currentUpload.final_storage_key === null) {
          this.db.prepare(`
            UPDATE board_asset_uploads SET final_storage_key = ?
            WHERE upload_id = ? AND status = 'active' AND final_storage_key IS NULL
          `).run(storageKey, uploadId);
        }
        this.db.prepare(`
          INSERT OR IGNORE INTO board_asset_gc_queue (storage_key, enqueued_at)
          VALUES (?, ?)
        `).run(storageKey, this.now().toISOString());
      }).immediate();
    } catch (error) {
      if (error instanceof AssetServiceError) throw error;
      throw new AssetServiceError(
        "STORAGE_ERROR",
        `could not persist final asset recovery intent: ${
          error instanceof Error ? error.message : String(error)
        }`,
        true,
      );
    }
    try {
      await mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
      try {
        await link(stagingPath, finalPath);
        await chmod(finalPath, 0o600);
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== "EEXIST") throw error;
        const existing = await stat(finalPath);
        if (
          existing.size !== upload.expected_bytes
          || await sha256File(finalPath) !== upload.expected_sha256
        ) {
          throw new AssetServiceError(
            "STORAGE_CORRUPT",
            "content-addressed path contains different bytes",
          );
        }
      }
    } catch (error) {
      this.restoreFinalRecoveryIntent(storageKey);
      if (error instanceof AssetServiceError) throw error;
      throw new AssetServiceError(
        "STORAGE_ERROR",
        `could not publish asset blob: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    try {
      const publishedHandle = await open(finalPath, "r+");
      try {
        await publishedHandle.sync();
      } finally {
        await publishedHandle.close();
      }
      await syncDirectoryChain(path.join(this.privateStorageRoot, "blobs"), path.dirname(finalPath));
    } catch (error) {
      this.restoreFinalRecoveryIntent(storageKey);
      throw new AssetServiceError(
        "STORAGE_ERROR",
        `could not make published asset durable: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }

    let committed: CommittedAssetResult;
    try {
      committed = this.db.transaction(() => {
        const nowIso = this.now().toISOString();
        authorization.assertPublicationActive?.();
        const currentUpload = this.requireUpload(identity, uploadId, tenantId);
        if (currentUpload.final_storage_key !== storageKey) {
          throw new AssetServiceError(
            "STORAGE_CORRUPT",
            "upload final recovery intent is missing",
          );
        }
        this.db.prepare(`
        INSERT INTO board_asset_blobs (
          tenant_id, sha256, storage_key, mime_type, byte_size, width, height,
          frame_count, decoded_pixels, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, sha256) DO NOTHING
        `).run(
          tenantId,
          upload.expected_sha256,
          storageKey,
          encoded.mimeType,
          upload.expected_bytes,
          decoded.width,
          decoded.height,
          decoded.frameCount,
          decoded.totalDecodedPixels,
          nowIso,
        );
        const blob = this.findBlob(tenantId, upload.expected_sha256);
        if (
          !blob
          || blob.storage_key !== storageKey
          || blob.mime_type !== encoded.mimeType
          || blob.byte_size !== upload.expected_bytes
          || blob.width !== decoded.width
          || blob.height !== decoded.height
          || blob.frame_count !== decoded.frameCount
          || blob.decoded_pixels !== decoded.totalDecodedPixels
        ) {
          throw new AssetServiceError("STORAGE_CORRUPT", "immutable blob metadata conflicts with upload");
        }
        const assetUpdate = this.db.prepare(`
        UPDATE board_assets
        SET status = 'ready', blob_sha256 = ?, detected_mime = ?,
            width = ?, height = ?, frame_count = ?, decoded_pixels = ?,
            updated_at = ?, published_at = ?, last_error_code = NULL
        WHERE board_id = ? AND generation = ? AND asset_id = ? AND tenant_id = ?
          AND status IN ('pending', 'rejected')
        `).run(
          upload.expected_sha256,
          encoded.mimeType,
          decoded.width,
          decoded.height,
          decoded.frameCount,
          decoded.totalDecodedPixels,
          nowIso,
          nowIso,
          identity.boardId,
          identity.generation,
          identity.assetId,
          tenantId,
        );
        const uploadUpdate = this.db.prepare(`
        UPDATE board_asset_uploads
        SET status = 'completed', updated_at = ?, completed_at = ?, failure_code = NULL
        WHERE upload_id = ? AND status = 'active'
        `).run(nowIso, nowIso, uploadId);
        if (
          assetUpdate.changes !== uploadUpdate.changes
          || (assetUpdate.changes !== 0 && assetUpdate.changes !== 1)
        ) {
          throw new AssetServiceError(
            "STORAGE_CORRUPT",
            "asset and upload publication state changed inconsistently",
          );
        }
        if (assetUpdate.changes === 1) authorization.commitActivity?.();
        const published = this.requireAsset(identity, tenantId);
        if (published.status !== "ready") {
          throw new AssetServiceError(
            "STORAGE_CORRUPT",
            "asset publication did not produce a ready asset",
          );
        }
        this.db.prepare("DELETE FROM board_asset_gc_queue WHERE storage_key = ?")
          .run(storageKey);
        return {
          asset: published,
          created: assetUpdate.changes === 1,
        };
      }).immediate();
    } catch (error) {
      this.restoreFinalRecoveryIntent(storageKey);
      if (error instanceof AssetServiceError) throw error;
      throw new AssetServiceError(
        "STORAGE_ERROR",
        `could not commit asset publication: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    if (committed.created) await this.emitReady(committed.asset);
    return {
      asset: toStatus(committed.asset) as ReadyAssetStatus,
      created: committed.created,
    };
  }

  async getStatus(principal: TPrincipal, input: AssetIdentityInput): Promise<AssetStatus> {
    const identity = this.validateIdentity(input);
    const authorization = await this.authorize(principal, {
      operation: "status",
      ...identity,
    });
    const tenantId = validateId(authorization.tenantId, "authorized tenantId");
    const asset = this.requireAsset(identity, tenantId);
    if (asset.status === "ready") await this.assertPublishedBlobAvailable(asset);
    return toStatus(asset);
  }

  async openDownload(
    principal: TPrincipal,
    input: AssetIdentityInput,
    rangeHeader?: string,
  ): Promise<AssetDownload> {
    const identity = this.validateIdentity(input);
    const authorization = await this.authorize(principal, {
      operation: "download",
      ...identity,
    });
    const tenantId = validateId(authorization.tenantId, "authorized tenantId");
    const asset = this.requireAsset(identity, tenantId);
    if (asset.status !== "ready" || !asset.blob_sha256) {
      throw new AssetServiceError("NOT_FOUND", "asset is not published");
    }
    const blob = this.findBlob(tenantId, asset.blob_sha256);
    if (!blob) throw new AssetServiceError("STORAGE_CORRUPT", "published blob metadata is missing");
    const filePath = await this.assertBlobFileAvailable(blob);
    const range = parseAssetByteRange(rangeHeader, blob.byte_size);
    const partial = range.start !== 0 || range.endInclusive !== blob.byte_size - 1;
    const headers: Record<string, string> = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Length": String(range.length),
      "Content-Type": blob.mime_type,
      "ETag": `"sha256-${blob.sha256}"`,
      "X-Content-Type-Options": "nosniff",
    };
    if (partial) headers["Content-Range"] = `bytes ${range.start}-${range.endInclusive}/${blob.byte_size}`;
    return {
      statusCode: partial ? 206 : 200,
      headers,
      range,
      stream: createReadStream(filePath, {
        start: range.start,
        end: range.endInclusive,
      }),
    };
  }

  async getBoardMetrics(
    principal: TPrincipal,
    input: Omit<AssetIdentityInput, "assetId">,
  ): Promise<BoardAssetMetrics> {
    const boardId = validateId(input.boardId, "boardId");
    const generation = validateGeneration(input.generation);
    const authorization = await this.authorize(principal, {
      operation: "metrics",
      boardId,
      generation,
    });
    const tenantId = validateId(authorization.tenantId, "authorized tenantId");
    const logical = this.db.prepare(`
      SELECT
        COUNT(*) AS asset_count,
        COALESCE(SUM(byte_size), 0) AS logical_bytes,
        COALESCE(SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END), 0) AS ready_count,
        COALESCE(SUM(CASE WHEN status = 'ready' THEN byte_size ELSE 0 END), 0) AS ready_bytes,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_count
      FROM board_assets
      WHERE board_id = ? AND generation = ? AND tenant_id = ?
    `).get(boardId, generation, tenantId) as {
      asset_count: number;
      logical_bytes: number;
      ready_count: number;
      ready_bytes: number;
      pending_count: number;
    };
    const physical = this.db.prepare(`
      SELECT COUNT(*) AS blob_count, COALESCE(SUM(byte_size), 0) AS blob_bytes
      FROM (
        SELECT DISTINCT b.sha256, b.byte_size
        FROM board_assets a
        JOIN board_asset_blobs b
          ON b.tenant_id = a.tenant_id AND b.sha256 = a.blob_sha256
        WHERE a.board_id = ? AND a.generation = ? AND a.tenant_id = ?
      )
    `).get(boardId, generation, tenantId) as { blob_count: number; blob_bytes: number };
    return {
      assetCount: logical.asset_count,
      logicalBytes: logical.logical_bytes,
      readyCount: logical.ready_count,
      readyBytes: logical.ready_bytes,
      physicalBlobCount: physical.blob_count,
      physicalBlobBytes: physical.blob_bytes,
      pendingCount: logical.pending_count,
    };
  }

  /**
   * Maintenance hook for a timer/startup job. It has no principal because it
   * can only reject already-expired sessions and remove their private staging
   * files; it cannot read or publish an asset.
   */
  async cleanupExpiredUploads(at = this.now()): Promise<number> {
    const candidates = this.db.prepare(`
      SELECT * FROM board_asset_uploads
      WHERE status = 'active'
      ORDER BY expires_at
    `).all() as UploadRow[];
    let removed = 0;
    await Promise.all(candidates.map((candidate) => this.withUploadOperation(
      candidate.upload_id,
      async () => {
        const current = this.db.prepare(`
          SELECT * FROM board_asset_uploads
          WHERE upload_id = ? AND status = 'active'
        `).get(candidate.upload_id) as UploadRow | undefined;
        if (!current) return;
        const failureCode = current.expires_at <= at.toISOString()
          ? "UPLOAD_EXPIRED"
          : await fileExists(safeStoragePath(
              this.privateStorageRoot,
              current.staging_key,
            ))
            ? undefined
            : "UPLOAD_GONE";
        if (!failureCode) return;
        this.rejectUploadRows(current, failureCode);
        removed += 1;
      },
    )));
    return removed;
  }

  async cleanupGarbage(
    limit = 100,
  ): Promise<{ deleted: number; failed: number }> {
    const rows = this.db.prepare(`
      SELECT storage_key, attempts FROM board_asset_gc_queue
      ORDER BY attempts, enqueued_at, storage_key LIMIT ?
    `).all(Math.max(1, Math.min(1_000, limit))) as Array<{
      storage_key: string;
      attempts: number;
    }>;
    let deleted = 0;
    let failed = 0;
    for (const row of rows) {
      let outcome: "deleted" | "failed" | undefined;
      this.db.transaction(() => {
        const queued = this.db.prepare(`
          SELECT attempts FROM board_asset_gc_queue WHERE storage_key = ?
        `).get(row.storage_key) as { attempts: number } | undefined;
        if (!queued || queued.attempts !== row.attempts) return;

        const reference = this.db.prepare(`
          SELECT CASE
            WHEN EXISTS (
              SELECT 1 FROM board_asset_blobs WHERE storage_key = ?
            ) THEN 'published'
            WHEN EXISTS (
              SELECT 1 FROM board_asset_uploads
              WHERE status = 'active' AND staging_key = ?
            ) THEN 'active-staging'
            WHEN EXISTS (
              SELECT 1 FROM board_asset_uploads
              WHERE status = 'active' AND final_storage_key = ?
            ) THEN 'recovery'
          END AS kind
        `).get(
          row.storage_key,
          row.storage_key,
          row.storage_key,
        ) as {
          kind: "published" | "active-staging" | "recovery" | null;
        };
        if (
          reference.kind === "published"
          || reference.kind === "active-staging"
        ) {
          this.db.prepare(`
            DELETE FROM board_asset_gc_queue WHERE storage_key = ?
          `).run(row.storage_key);
          return;
        }
        if (reference.kind === "recovery") {
          this.db.prepare(`
            UPDATE board_asset_gc_queue
            SET attempts = attempts + 1, last_error = NULL
            WHERE storage_key = ?
          `).run(row.storage_key);
          return;
        }

        try {
          try {
            unlinkSync(safeStoragePath(this.privateStorageRoot, row.storage_key));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          this.db.prepare(`
            DELETE FROM board_asset_gc_queue WHERE storage_key = ?
          `).run(row.storage_key);
          outcome = "deleted";
        } catch (error) {
          this.db.prepare(`
            UPDATE board_asset_gc_queue
            SET attempts = attempts + 1, last_error = ?
            WHERE storage_key = ?
          `).run(
            error instanceof Error ? error.message.slice(0, 500) : "unlink failed",
            row.storage_key,
          );
          outcome = "failed";
        }
      }).immediate();
      if (outcome === "deleted") deleted += 1;
      if (outcome === "failed") failed += 1;
    }
    return { deleted, failed };
  }

  private validateIdentity(input: AssetIdentityInput): AssetIdentityInput {
    return {
      boardId: validateId(input.boardId, "boardId"),
      generation: validateGeneration(input.generation),
      assetId: validateId(input.assetId, "assetId"),
    };
  }

  private findAsset(input: AssetIdentityInput): AssetRow | undefined {
    return this.db.prepare(`
      SELECT * FROM board_assets
      WHERE board_id = ? AND generation = ? AND asset_id = ?
    `).get(input.boardId, input.generation, input.assetId) as AssetRow | undefined;
  }

  private requireAsset(input: AssetIdentityInput, tenantId: string): AssetRow {
    const row = this.findAsset(input);
    if (!row || row.tenant_id !== tenantId) throw new AssetServiceError("NOT_FOUND", "asset does not exist");
    return row;
  }

  private findBlob(tenantId: string, sha256: string): BlobRow | undefined {
    return this.db.prepare(`
      SELECT * FROM board_asset_blobs WHERE tenant_id = ? AND sha256 = ?
    `).get(tenantId, sha256) as BlobRow | undefined;
  }

  private findActiveUpload(input: AssetIdentityInput): UploadRow | undefined {
    return this.db.prepare(`
      SELECT * FROM board_asset_uploads
      WHERE board_id = ? AND generation = ? AND asset_id = ? AND status = 'active'
    `).get(input.boardId, input.generation, input.assetId) as UploadRow | undefined;
  }

  private requireUpload(input: AssetIdentityInput, uploadId: string, tenantId: string): UploadRow {
    const row = this.db.prepare(`
      SELECT * FROM board_asset_uploads
      WHERE upload_id = ? AND board_id = ? AND generation = ? AND asset_id = ?
    `).get(uploadId, input.boardId, input.generation, input.assetId) as UploadRow | undefined;
    if (!row || row.tenant_id !== tenantId) throw new AssetServiceError("NOT_FOUND", "upload does not exist");
    return row;
  }

  private restoreFinalRecoveryIntent(storageKey: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO board_asset_gc_queue (storage_key, enqueued_at)
      VALUES (?, ?)
    `).run(storageKey, this.now().toISOString());
  }

  private assertAssetIdentity(
    row: AssetRow,
    tenantId: string,
    sha256: string,
    byteSize: number,
    declaredMime: string,
  ): void {
    if (
      row.tenant_id !== tenantId
      || row.expected_sha256 !== sha256
      || row.byte_size !== byteSize
      || row.declared_mime !== declaredMime
    ) {
      throw new AssetServiceError(
        "ASSET_ID_CONFLICT",
        "assetId is already bound to different immutable asset data",
      );
    }
  }

  private async assertActiveUpload(upload: UploadRow): Promise<void> {
    if (upload.status !== "active") {
      throw new AssetServiceError("NOT_FOUND", "upload is no longer active");
    }
    if (upload.expires_at <= this.now().toISOString()) {
      this.rejectUploadRows(upload, "UPLOAD_EXPIRED");
      throw new AssetServiceError("UPLOAD_EXPIRED", "upload session expired", true);
    }
  }

  private rejectUploadRows(upload: UploadRow, code: string): void {
    const now = this.now().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE board_asset_uploads
        SET status = 'rejected', failure_code = ?, updated_at = ?
        WHERE upload_id = ? AND status = 'active'
      `).run(code, now, upload.upload_id);
      this.db.prepare(`
        UPDATE board_assets
        SET status = 'rejected', last_error_code = ?, updated_at = ?
        WHERE board_id = ? AND generation = ? AND asset_id = ? AND status != 'ready'
      `).run(code, now, upload.board_id, upload.generation, upload.asset_id);
    }).immediate();
  }

  private async rejectFinalize(
    upload: UploadRow,
    code: AssetServiceErrorCode,
    message: string,
  ): Promise<never> {
    this.rejectUploadRows(upload, code);
    throw new AssetServiceError(code, message);
  }

  private assertCapacityForNewUpload(
    tenantId: string,
    requestedBytes: number,
    observedFreeBytes: number,
    authorization: AssetAuthorization,
    creatingAssetRecord: boolean,
  ): void {
    this.assertAssetRecordCapacity(tenantId, creatingAssetRecord);
    const active = this.db.prepare(`
      SELECT COUNT(*) AS upload_count, COALESCE(SUM(expected_bytes), 0) AS reserved_bytes
      FROM board_asset_uploads
      WHERE tenant_id = ? AND status = 'active'
    `).get(tenantId) as { upload_count: number; reserved_bytes: number };
    if (active.upload_count >= this.limits.maxActiveUploadsPerTenant) {
      throw new AssetServiceError("TENANT_QUOTA", "too many active asset uploads for this tenant");
    }
    const published = this.db.prepare(`
      SELECT COALESCE(SUM(byte_size), 0) AS published_bytes
      FROM board_asset_blobs WHERE tenant_id = ?
    `).get(tenantId) as { published_bytes: number };
    const guestTenant = tenantId.startsWith(GUEST_BOARD_ASSET_TENANT_PREFIX);
    const authorizedTenantQuota = authorization.tenantSoftQuotaBytes;
    if (
      authorizedTenantQuota !== undefined
      && (!Number.isSafeInteger(authorizedTenantQuota) || authorizedTenantQuota < 1)
    ) {
      throw new AssetServiceError(
        "STORAGE_ERROR",
        "asset authorizer returned an invalid tenant quota",
      );
    }
    const tenantSoftQuotaBytes = guestTenant
      ? Math.min(
          this.limits.tenantSoftQuotaBytes,
          GUEST_BOARD_ASSET_TENANT_SOFT_QUOTA_BYTES,
          authorizedTenantQuota ?? Number.MAX_SAFE_INTEGER,
        )
      : authorizedTenantQuota ?? this.limits.tenantSoftQuotaBytes;
    if (
      published.published_bytes + active.reserved_bytes + requestedBytes
      > tenantSoftQuotaBytes
    ) {
      throw new AssetServiceError("TENANT_QUOTA", "asset storage soft quota would be exceeded");
    }
    const aggregateQuotas: Array<{
      tenantIdPrefix: string;
      softQuotaBytes: number;
    }> = guestTenant
      ? [{
          tenantIdPrefix: GUEST_BOARD_ASSET_TENANT_PREFIX,
          softQuotaBytes: GUEST_BOARD_ASSET_GLOBAL_SOFT_QUOTA_BYTES,
        }]
      : [];
    if (authorization.aggregateQuota) {
      const requestedAggregateQuota = authorization.aggregateQuota;
      const samePrefix = aggregateQuotas.find((quota) => (
        quota.tenantIdPrefix === requestedAggregateQuota.tenantIdPrefix
      ));
      if (samePrefix) {
        samePrefix.softQuotaBytes = Math.min(
          samePrefix.softQuotaBytes,
          requestedAggregateQuota.softQuotaBytes,
        );
      } else {
        aggregateQuotas.push({ ...requestedAggregateQuota });
      }
    }
    for (const aggregateQuota of aggregateQuotas) {
      const { tenantIdPrefix, softQuotaBytes } = aggregateQuota;
      if (
        !/^[A-Za-z0-9_-]{1,64}$/u.test(tenantIdPrefix)
        || !Number.isSafeInteger(softQuotaBytes)
        || softQuotaBytes < 1
      ) {
        throw new AssetServiceError(
          "STORAGE_ERROR",
          "asset authorizer returned an invalid aggregate quota",
        );
      }
      const aggregatePattern = `${tenantIdPrefix}*`;
      const aggregate = this.db.prepare(`
        SELECT
          (
            SELECT COALESCE(SUM(byte_size), 0)
            FROM board_asset_blobs
            WHERE tenant_id GLOB ?
          ) + (
            SELECT COALESCE(SUM(expected_bytes), 0)
            FROM board_asset_uploads
            WHERE tenant_id GLOB ? AND status = 'active'
          ) AS used_bytes
      `).get(aggregatePattern, aggregatePattern) as { used_bytes: number };
      if (aggregate.used_bytes > softQuotaBytes - requestedBytes) {
        throw new AssetServiceError(
          "TENANT_QUOTA",
          "aggregate asset storage soft quota would be exceeded",
        );
      }
    }
    this.assertGlobalDiskCapacity(
      observedFreeBytes,
      requestedBytes,
      creatingAssetRecord ? this.limits.assetMetadataReserveBytes : 0,
    );
  }

  private assertAssetRecordCapacity(tenantId: string, creatingAssetRecord: boolean): void {
    if (!creatingAssetRecord) return;
    const tenant = this.db.prepare(`
      SELECT COUNT(*) AS asset_count
      FROM board_assets
      WHERE tenant_id = ?
    `).get(tenantId) as { asset_count: number };
    if (tenant.asset_count >= this.limits.maxAssetRecordsPerTenant) {
      throw new AssetServiceError(
        "TENANT_QUOTA",
        "asset metadata record quota would be exceeded",
      );
    }
    if (!tenantId.startsWith(GUEST_BOARD_ASSET_TENANT_PREFIX)) return;
    const guest = this.db.prepare(`
      SELECT COUNT(*) AS asset_count
      FROM board_assets
      WHERE tenant_id GLOB ?
    `).get(`${GUEST_BOARD_ASSET_TENANT_PREFIX}*`) as { asset_count: number };
    if (guest.asset_count >= this.limits.maxGuestAssetRecordsGlobal) {
      throw new AssetServiceError(
        "TENANT_QUOTA",
        "aggregate guest asset metadata quota would be exceeded",
      );
    }
  }

  private assertGlobalDiskCapacity(
    observedFreeBytes: number,
    requestedBytes: number,
    metadataReserveBytes: number,
  ): void {
    const global = this.db.prepare(`
      SELECT COALESCE(SUM(expected_bytes - next_offset), 0) AS remaining_bytes
      FROM board_asset_uploads
      WHERE status = 'active'
    `).get() as { remaining_bytes: number };
    if (
      observedFreeBytes
        - global.remaining_bytes
        - requestedBytes
        - metadataReserveBytes
      < this.limits.minFreeDiskBytes
    ) {
      throw new AssetServiceError(
        "DISK_PRESSURE",
        "server free-disk floor would be crossed by this asset mutation",
        true,
        60_000,
      );
    }
  }

  private async withUploadOperation<T>(
    uploadId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.activeUploadOperations.get(uploadId)
      ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.activeUploadOperations.set(uploadId, current);
    try {
      return await current;
    } finally {
      if (this.activeUploadOperations.get(uploadId) === current) {
        this.activeUploadOperations.delete(uploadId);
      }
    }
  }

  private async assertFreeDiskFloor(): Promise<void> {
    const freeBytes = await this.readFreeDiskBytes();
    if (freeBytes < this.limits.minFreeDiskBytes) {
      throw new AssetServiceError(
        "DISK_PRESSURE",
        "server is below the asset free-disk floor",
        true,
        60_000,
      );
    }
  }

  private async readFreeDiskBytes(): Promise<number> {
    let freeBytes: number;
    try {
      freeBytes = await this.capacityProbe.freeDiskBytes(this.privateStorageRoot);
    } catch (error) {
      throw new AssetServiceError(
        "STORAGE_ERROR",
        `could not inspect asset storage capacity: ${
          error instanceof Error ? error.message : String(error)
        }`,
        true,
        30_000,
      );
    }
    if (!Number.isFinite(freeBytes) || freeBytes < 0) {
      throw new AssetServiceError(
        "STORAGE_ERROR",
        "asset storage capacity probe returned an invalid value",
        true,
        30_000,
      );
    }
    return freeBytes;
  }

  private assertEncodedDimensions(width: number, height: number): void {
    const pixels = width * height;
    if (
      width > this.limits.maxWidth
      || height > this.limits.maxHeight
      || !Number.isSafeInteger(pixels)
      || pixels > this.limits.maxPixelsPerFrame
    ) {
      throw new AssetServiceError("DIMENSION_LIMIT", "encoded image dimensions exceed safety limits");
    }
  }

  private assertDecodedImage(
    encoded: { width: number; height: number },
    decoded: DecodedAssetInfo,
  ): void {
    if (
      decoded.fullyDecoded !== true
      || decoded.width !== encoded.width
      || decoded.height !== encoded.height
      || !Number.isSafeInteger(decoded.frameCount)
      || decoded.frameCount < 1
      || decoded.frameCount > this.limits.maxFrameCount
      || !Number.isSafeInteger(decoded.totalDecodedPixels)
      || decoded.totalDecodedPixels < decoded.width * decoded.height
      || decoded.totalDecodedPixels > this.limits.maxTotalDecodedPixels
    ) {
      throw new AssetServiceError(
        "DECODE_FAILED",
        "full decode metadata is inconsistent or exceeds safety limits",
      );
    }
  }

  private linkExistingBlob(
    identity: AssetIdentityInput,
    input: {
      tenantId: string;
      actorId: string;
      sha256: string;
      byteSize: number;
      declaredMime: string;
      originalFileName: string | null;
      blob: BlobRow;
      observedFreeBytes: number;
      assertPublicationActive?: () => void;
      commitActivity?: () => void;
    },
  ): CommittedAssetResult {
    return this.db.transaction(() => {
      input.assertPublicationActive?.();
      const now = this.now().toISOString();
      const existing = this.findAsset(identity);
      this.assertAssetRecordCapacity(input.tenantId, !existing);
      this.assertGlobalDiskCapacity(
        input.observedFreeBytes,
        0,
        existing ? 0 : this.limits.assetMetadataReserveBytes,
      );
      if (!existing) {
        this.db.prepare(`
          INSERT INTO board_assets (
            board_id, generation, asset_id, tenant_id, status, expected_sha256,
            blob_sha256, byte_size, declared_mime, detected_mime,
            original_file_name, width, height, frame_count, decoded_pixels,
            created_by, created_at, updated_at, published_at
          ) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          identity.boardId,
          identity.generation,
          identity.assetId,
          input.tenantId,
          input.sha256,
          input.sha256,
          input.byteSize,
          input.declaredMime,
          input.blob.mime_type,
          input.originalFileName,
          input.blob.width,
          input.blob.height,
          input.blob.frame_count,
          input.blob.decoded_pixels,
          input.actorId,
          now,
          now,
          now,
        );
      } else {
        this.assertAssetIdentity(
          existing,
          input.tenantId,
          input.sha256,
          input.byteSize,
          input.declaredMime,
        );
        if (existing.status === "ready") {
          return { asset: existing, created: false };
        }
        const update = this.db.prepare(`
          UPDATE board_assets
          SET status = 'ready', blob_sha256 = ?, detected_mime = ?,
              width = ?, height = ?, frame_count = ?, decoded_pixels = ?,
              updated_at = ?, published_at = ?, last_error_code = NULL
          WHERE board_id = ? AND generation = ? AND asset_id = ?
            AND status IN ('pending', 'rejected')
        `).run(
          input.sha256,
          input.blob.mime_type,
          input.blob.width,
          input.blob.height,
          input.blob.frame_count,
          input.blob.decoded_pixels,
          now,
          now,
          identity.boardId,
          identity.generation,
          identity.assetId,
        );
        const ready = this.requireAsset(identity, input.tenantId);
        if (ready.status !== "ready") {
          throw new AssetServiceError(
            "STORAGE_CORRUPT",
            "deduplicated asset link did not produce a ready asset",
          );
        }
        if (update.changes === 1) input.commitActivity?.();
        return { asset: ready, created: update.changes === 1 };
      }
      input.commitActivity?.();
      return {
        asset: this.requireAsset(identity, input.tenantId),
        created: true,
      };
    }).immediate();
  }

  private async assertPublishedBlobAvailable(asset: AssetRow): Promise<void> {
    if (!asset.blob_sha256) throw new AssetServiceError("STORAGE_CORRUPT", "ready asset has no blob");
    const blob = this.findBlob(asset.tenant_id, asset.blob_sha256);
    if (!blob) throw new AssetServiceError("STORAGE_CORRUPT", "ready asset blob metadata is missing");
    await this.assertBlobFileAvailable(blob);
  }

  private async assertBlobFileAvailable(blob: BlobRow): Promise<string> {
    const filePath = safeStoragePath(this.privateStorageRoot, blob.storage_key);
    if (!await fileExists(filePath)) {
      throw new AssetServiceError("STORAGE_CORRUPT", "published private blob file is missing");
    }
    const info = await stat(filePath);
    if (!info.isFile() || info.size !== blob.byte_size) {
      throw new AssetServiceError("STORAGE_CORRUPT", "published private blob file has invalid size");
    }
    return filePath;
  }

  private async readFileRange(filePath: string, offset: number, length: number): Promise<Buffer> {
    const handle = await open(filePath, "r");
    try {
      const output = Buffer.alloc(length);
      const result = await handle.read(output, 0, length, offset);
      if (result.bytesRead !== length) {
        throw new AssetServiceError("STORAGE_CORRUPT", "staged upload is shorter than acknowledged");
      }
      return output;
    } finally {
      await handle.close();
    }
  }

  private async emitReady(asset: AssetRow): Promise<void> {
    if (!this.onEvent || asset.status !== "ready") return;
    try {
      await this.onEvent({
        type: "asset-ready",
        boardId: asset.board_id,
        generation: asset.generation,
        assetId: asset.asset_id,
        sha256: asset.blob_sha256!,
        mimeType: asset.detected_mime!,
        byteSize: asset.byte_size,
        width: asset.width!,
        height: asset.height!,
        frameCount: asset.frame_count!,
        totalDecodedPixels: asset.decoded_pixels!,
        publishedAt: asset.published_at!,
      });
    } catch {
      // Publication is already durable. Peers can repair through getStatus.
    }
  }
}
