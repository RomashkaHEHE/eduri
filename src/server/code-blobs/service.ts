import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  type ReadStream,
  unlinkSync,
} from "node:fs";
import {
  access,
  mkdir,
  open,
  stat,
  statfs,
} from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { GuestRoomService } from "../guestRooms.js";
import {
  MalwareScannerError,
  type MalwareScanner,
} from "./malwareScanner.js";

export const CODE_BLOB_LIMITS = Object.freeze({
  maxBlobBytes: 32 * 1024 * 1024,
  maxChunkBytes: 1024 * 1024,
  defaultChunkBytes: 512 * 1024,
  maxResourceBytes: 512 * 1024 * 1024,
  maxGlobalBytes: 2 * 1024 * 1024 * 1024,
  maxResourceRecords: 4_096,
  maxGlobalRecords: 100_000,
  maxActiveUploads: 16,
  maxGlobalActiveUploads: 256,
  metadataReserveBytes: 2 * 1024,
  maxConcurrentFinalizations: 2,
  maxQueuedFinalizations: 8,
  uploadTtlMs: 24 * 60 * 60 * 1000,
  minFreeDiskBytes: 512 * 1024 * 1024,
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;

interface BlobRow {
  room_resource_id: string;
  sha256: string;
  byte_size: number;
  mime_type: string;
  storage_key: string;
  created_at: string;
  scan_provider: string | null;
  scanned_at: string | null;
}

interface UploadRow {
  upload_id: string;
  room_resource_id: string;
  sha256: string;
  byte_size: number;
  mime_type: string;
  chunk_bytes: number;
  next_offset: number;
  staging_key: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

interface CodeBlobAccess {
  roomId: string;
  resourceId: string;
}

export type CodeBlobErrorCode =
  | "INVALID_ARGUMENT"
  | "ROOM_EXPIRED"
  | "NOT_FOUND"
  | "BLOB_TOO_LARGE"
  | "CHUNK_TOO_LARGE"
  | "HASH_MISMATCH"
  | "IDENTITY_CONFLICT"
  | "OFFSET_MISMATCH"
  | "UPLOAD_INCOMPLETE"
  | "UPLOAD_EXPIRED"
  | "QUOTA_EXCEEDED"
  | "DISK_PRESSURE"
  | "MALWARE_DETECTED"
  | "MALWARE_SCAN_UNAVAILABLE"
  | "STORAGE_CORRUPT"
  | "STORAGE_ERROR";

export class CodeBlobError extends Error {
  constructor(
    readonly code: CodeBlobErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodeBlobError";
  }
}

export interface CodeBlobIdentity {
  sha256: string;
  byteSize: number;
  mimeType: string;
}

export type BeginCodeBlobResult =
  | { status: "ready"; blob: CodeBlobIdentity }
  | {
    status: "upload";
    uploadId: string;
    nextOffset: number;
    chunkBytes: number;
    expiresAt: string;
  };

export interface CodeBlobDownload {
  headers: Readonly<Record<string, string>>;
  stream: ReadStream;
}

export interface FinalizedCodeBlob {
  status: "ready";
  blob: CodeBlobIdentity;
}

export interface CodeBlobServiceOptions {
  db: Database.Database;
  guestRooms: GuestRoomService;
  scanner: MalwareScanner;
  storageRoot: string;
  forbiddenPublicRoots?: readonly string[];
  now?: () => number;
  minFreeDiskBytes?: number;
}

function validateIdentity(input: CodeBlobIdentity): CodeBlobIdentity {
  const mimeType = input.mimeType.trim().toLowerCase();
  if (!SHA256_PATTERN.test(input.sha256)) {
    throw new CodeBlobError("INVALID_ARGUMENT", "Code blob hash is invalid");
  }
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1) {
    throw new CodeBlobError("INVALID_ARGUMENT", "Code blob size is invalid");
  }
  if (input.byteSize > CODE_BLOB_LIMITS.maxBlobBytes) {
    throw new CodeBlobError("BLOB_TOO_LARGE", "Code blob exceeds 32 MiB");
  }
  if (mimeType.length > 255 || !MIME_PATTERN.test(mimeType)) {
    throw new CodeBlobError("INVALID_ARGUMENT", "Code blob MIME type is invalid");
  }
  return { sha256: input.sha256, byteSize: input.byteSize, mimeType };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safePath(root: string, storageKey: string): string {
  if (
    !storageKey
    || path.isAbsolute(storageKey)
    || storageKey.includes("\\")
    || storageKey.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new CodeBlobError("STORAGE_CORRUPT", "Code blob storage key is invalid");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...storageKey.split("/"));
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new CodeBlobError("STORAGE_CORRUPT", "Code blob path escaped storage");
  }
  return resolved;
}

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
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
  const resolvedRoot = path.resolve(root);
  let current = path.resolve(leaf);
  while (isInside(current, resolvedRoot)) {
    await syncDirectory(current);
    if (current === resolvedRoot) break;
    current = path.dirname(current);
  }
}

function syncDirectoryChainSync(root: string, leaf: string): void {
  if (process.platform === "win32") return;
  const resolvedRoot = path.resolve(root);
  let current = path.resolve(leaf);
  while (isInside(current, resolvedRoot)) {
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

async function hashFile(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

function rowIdentity(row: BlobRow): CodeBlobIdentity {
  return {
    sha256: row.sha256,
    byteSize: row.byte_size,
    mimeType: row.mime_type,
  };
}

function uploadFinalStorageKey(upload: Pick<UploadRow, "room_resource_id" | "sha256">): string {
  return `blobs/${upload.room_resource_id}/${upload.sha256}`;
}

function assertFinalFileSync(
  filePath: string,
  upload: Pick<UploadRow, "byte_size" | "sha256">,
): void {
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(filePath);
  } catch (error) {
    throw new CodeBlobError(
      "STORAGE_CORRUPT",
      "Published Code blob is missing",
      false,
      { cause: error },
    );
  }
  if (
    !info.isFile()
    || info.size !== upload.byte_size
    || sha256(readFileSync(filePath)) !== upload.sha256
  ) {
    throw new CodeBlobError("STORAGE_CORRUPT", "Published Code blob is inconsistent");
  }
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
      throw new CodeBlobError(
        "STORAGE_ERROR",
        "Code blob finalization queue is saturated",
        true,
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

export class CodeBlobService {
  private readonly now: () => number;
  private readonly storageRoot: string;
  private readonly minFreeDiskBytes: number;
  private readonly scanProvider: string;
  private readonly activeFinalizations = new Map<
    string,
    Promise<FinalizedCodeBlob>
  >();
  private readonly activeLegacyScans = new Map<string, Promise<string>>();
  private readonly finalizationSemaphore = new AsyncSemaphore(
    CODE_BLOB_LIMITS.maxConcurrentFinalizations,
    CODE_BLOB_LIMITS.maxQueuedFinalizations,
  );
  private readonly activeUploadOperations = new Map<string, Promise<unknown>>();

  constructor(private readonly options: CodeBlobServiceOptions) {
    this.now = options.now ?? Date.now;
    this.storageRoot = path.resolve(options.storageRoot);
    this.minFreeDiskBytes = options.minFreeDiskBytes
      ?? CODE_BLOB_LIMITS.minFreeDiskBytes;
    this.scanProvider = options.scanner.id.trim();
    if (!this.scanProvider || this.scanProvider.length > 255) {
      throw new Error("Code blob malware scanner must have a bounded non-empty ID");
    }
    for (const forbidden of options.forbiddenPublicRoots ?? []) {
      if (isInside(this.storageRoot, forbidden) || isInside(forbidden, this.storageRoot)) {
        throw new Error("Code blob storage must be outside public roots");
      }
    }
    mkdirSync(this.storageRoot, { recursive: true, mode: 0o700 });
  }

  async beginUpload(
    shareId: string,
    input: CodeBlobIdentity,
  ): Promise<BeginCodeBlobResult> {
    const accessScope = this.authorize(shareId);
    const identity = validateIdentity(input);
    const ready = this.findBlob(accessScope.resourceId, identity.sha256);
    if (ready) {
      this.assertSameIdentity(ready, identity);
      await this.assertScannedStoredBlob(ready);
      return { status: "ready", blob: rowIdentity(ready) };
    }

    const current = this.findUpload(accessScope.resourceId, identity.sha256);
    if (current) {
      this.assertUploadIdentity(current, identity);
      const reusable = await this.prepareExistingUpload(
        accessScope.resourceId,
        identity,
        current.upload_id,
      );
      if (reusable) return this.uploadResult(reusable);
    }

    let observedFreeBytes: number;
    try {
      const disk = await statfs(this.storageRoot);
      observedFreeBytes = Number(disk.bavail) * Number(disk.bsize);
      if (!Number.isFinite(observedFreeBytes) || observedFreeBytes < 0) {
        throw new CodeBlobError(
          "STORAGE_ERROR",
          "Code blob storage capacity could not be measured",
          true,
        );
      }
    } catch (error) {
      if (error instanceof CodeBlobError) throw error;
      throw new CodeBlobError(
        "STORAGE_ERROR",
        "Code blob storage capacity could not be measured",
        true,
        { cause: error },
      );
    }

    const uploadId = randomUUID();
    const now = this.now();
    const timestamp = new Date(now).toISOString();
    const expiresAt = new Date(
      now + CODE_BLOB_LIMITS.uploadTtlMs,
    ).toISOString();
    const stagingKey = `staging/${accessScope.resourceId}/${uploadId}.part`;
    const stagingPath = safePath(this.storageRoot, stagingKey);
    try {
      this.options.db.transaction(() => {
        this.options.db.prepare(`
          INSERT OR IGNORE INTO code_blob_gc_queue (storage_key, enqueued_at)
          VALUES (?, ?)
        `).run(stagingKey, timestamp);
      }).immediate();
    } catch (error) {
      throw new CodeBlobError(
        "STORAGE_ERROR",
        "Code blob staging intent could not be persisted",
        true,
        { cause: error },
      );
    }

    let concurrentReady: BlobRow | undefined;
    let concurrentUpload: UploadRow | undefined;
    try {
      this.options.db.transaction(() => {
        concurrentReady = this.findBlob(
          accessScope.resourceId,
          identity.sha256,
        );
        if (concurrentReady) {
          this.assertSameIdentity(concurrentReady, identity);
          this.options.db.prepare("DELETE FROM code_blob_gc_queue WHERE storage_key = ?")
            .run(stagingKey);
          return;
        }

        const observedUpload = this.findUpload(
          accessScope.resourceId,
          identity.sha256,
        );
        if (observedUpload) {
          this.assertUploadIdentity(observedUpload, identity);
          concurrentUpload = observedUpload;
          this.options.db.prepare("DELETE FROM code_blob_gc_queue WHERE storage_key = ?")
            .run(stagingKey);
          return;
        }

        this.assertCapacityForNewUpload(
          accessScope.resourceId,
          identity.byteSize,
          observedFreeBytes,
        );
        this.options.db.prepare(`
          INSERT INTO code_blob_uploads (
            upload_id, room_resource_id, sha256, byte_size, mime_type,
            chunk_bytes, next_offset, staging_key, created_at, updated_at,
            expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
        `).run(
          uploadId,
          accessScope.resourceId,
          identity.sha256,
          identity.byteSize,
          identity.mimeType,
          CODE_BLOB_LIMITS.defaultChunkBytes,
          stagingKey,
          timestamp,
          timestamp,
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
          syncDirectoryChainSync(this.storageRoot, path.dirname(stagingPath));
        } catch (error) {
          throw new CodeBlobError(
            "STORAGE_ERROR",
            "Code blob staging file could not be created durably",
            true,
            { cause: error },
          );
        }
        this.options.db.prepare("DELETE FROM code_blob_gc_queue WHERE storage_key = ?")
          .run(stagingKey);
      }).immediate();
    } catch (error) {
      if (error instanceof CodeBlobError) throw error;
      throw new CodeBlobError(
        "STORAGE_ERROR",
        "Code blob upload could not be reserved",
        true,
        { cause: error },
      );
    }
    if (concurrentReady) {
      await this.assertScannedStoredBlob(concurrentReady);
      return { status: "ready", blob: rowIdentity(concurrentReady) };
    }
    if (concurrentUpload) {
      const reusable = await this.prepareExistingUpload(
        accessScope.resourceId,
        identity,
        concurrentUpload.upload_id,
      );
      if (reusable) return this.uploadResult(reusable);
      return await this.beginUpload(shareId, identity);
    }
    return {
      status: "upload",
      uploadId,
      nextOffset: 0,
      chunkBytes: CODE_BLOB_LIMITS.defaultChunkBytes,
      expiresAt,
    };
  }

  async writeChunk(
    shareId: string,
    input: {
      uploadId: string;
      offset: number;
      chunk: Uint8Array;
      chunkSha256: string;
    },
  ): Promise<{ nextOffset: number; complete: boolean; duplicate: boolean }> {
    return await this.withUploadOperation(
      input.uploadId,
      () => this.writeChunkOnce(shareId, input),
    );
  }

  private async writeChunkOnce(
    shareId: string,
    input: {
      uploadId: string;
      offset: number;
      chunk: Uint8Array;
      chunkSha256: string;
    },
  ): Promise<{ nextOffset: number; complete: boolean; duplicate: boolean }> {
    const accessScope = this.authorize(shareId);
    if (!/^[0-9a-f-]{36}$/u.test(input.uploadId)) {
      throw new CodeBlobError("INVALID_ARGUMENT", "Upload ID is invalid");
    }
    if (
      !(input.chunk instanceof Uint8Array)
      || input.chunk.byteLength < 1
      || input.chunk.byteLength > CODE_BLOB_LIMITS.maxChunkBytes
    ) {
      throw new CodeBlobError("CHUNK_TOO_LARGE", "Code blob chunk is invalid");
    }
    if (!SHA256_PATTERN.test(input.chunkSha256) || sha256(input.chunk) !== input.chunkSha256) {
      throw new CodeBlobError("HASH_MISMATCH", "Code blob chunk hash does not match");
    }
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
      throw new CodeBlobError("INVALID_ARGUMENT", "Upload offset is invalid");
    }
    const upload = this.requireUpload(input.uploadId, accessScope.resourceId);
    this.assertUploadActive(upload);
    if (input.offset > upload.next_offset || input.offset + input.chunk.byteLength > upload.byte_size) {
      throw new CodeBlobError("OFFSET_MISMATCH", "Code blob upload offset does not match");
    }
    const stagingPath = safePath(this.storageRoot, upload.staging_key);
    const info = await stat(stagingPath).catch((error) => {
      throw new CodeBlobError("STORAGE_CORRUPT", "Code blob staging file is missing", false, { cause: error });
    });
    if (!info.isFile() || info.size < upload.next_offset) {
      throw new CodeBlobError("STORAGE_CORRUPT", "Code blob staging file is inconsistent");
    }

    if (input.offset < upload.next_offset) {
      if (input.offset + input.chunk.byteLength > upload.next_offset) {
        throw new CodeBlobError("OFFSET_MISMATCH", "Code blob retry overlaps new data");
      }
      const existing = await this.readRange(stagingPath, input.offset, input.chunk.byteLength);
      if (!Buffer.from(existing).equals(Buffer.from(input.chunk))) {
        throw new CodeBlobError("OFFSET_MISMATCH", "Code blob retry bytes differ");
      }
      return {
        nextOffset: upload.next_offset,
        complete: upload.next_offset === upload.byte_size,
        duplicate: true,
      };
    }

    if (input.chunk.byteLength > upload.chunk_bytes && input.offset + input.chunk.byteLength < upload.byte_size) {
      throw new CodeBlobError("CHUNK_TOO_LARGE", "Code blob chunk exceeds negotiated size");
    }
    if (info.size > upload.next_offset) {
      const recoverable = info.size === input.offset + input.chunk.byteLength
        && Buffer.from(await this.readRange(stagingPath, input.offset, input.chunk.byteLength))
          .equals(Buffer.from(input.chunk));
      if (!recoverable) {
        throw new CodeBlobError("STORAGE_CORRUPT", "Code blob staging file has unacknowledged bytes");
      }
    } else {
      const handle = await open(stagingPath, "r+");
      try {
        const bytes = Buffer.from(input.chunk);
        let written = 0;
        while (written < bytes.byteLength) {
          const result = await handle.write(
            bytes,
            written,
            bytes.byteLength - written,
            input.offset + written,
          );
          if (result.bytesWritten < 1) {
            throw new CodeBlobError(
              "STORAGE_ERROR",
              "Code blob staging write made no progress",
              true,
            );
          }
          written += result.bytesWritten;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const nextOffset = input.offset + input.chunk.byteLength;
    const changed = this.options.db.prepare(`
      UPDATE code_blob_uploads
      SET next_offset = ?, updated_at = ?
      WHERE upload_id = ? AND room_resource_id = ? AND next_offset = ?
    `).run(
      nextOffset,
      new Date(this.now()).toISOString(),
      upload.upload_id,
      accessScope.resourceId,
      input.offset,
    );
    if (changed.changes !== 1) {
      throw new CodeBlobError("STORAGE_ERROR", "Code blob chunk acknowledgement raced", true);
    }
    return {
      nextOffset,
      complete: nextOffset === upload.byte_size,
      duplicate: info.size > upload.next_offset,
    };
  }

  async finalizeUpload(
    shareId: string,
    uploadId: string,
  ): Promise<FinalizedCodeBlob> {
    const key = `${shareId}:${uploadId}`;
    const active = this.activeFinalizations.get(key);
    if (active) return await active;
    const finalization = this.withUploadOperation(
      uploadId,
      () => this.finalizationSemaphore.run(
        () => this.finalizeUploadOnce(shareId, uploadId),
      ),
    );
    this.activeFinalizations.set(key, finalization);
    try {
      return await finalization;
    } finally {
      if (this.activeFinalizations.get(key) === finalization) {
        this.activeFinalizations.delete(key);
      }
    }
  }

  private async finalizeUploadOnce(
    shareId: string,
    uploadId: string,
  ): Promise<FinalizedCodeBlob> {
    const accessScope = this.authorize(shareId);
    const upload = this.requireUpload(uploadId, accessScope.resourceId);
    this.assertUploadActive(upload);
    if (upload.next_offset !== upload.byte_size) {
      throw new CodeBlobError("UPLOAD_INCOMPLETE", "Code blob upload is incomplete");
    }
    const stagingPath = safePath(this.storageRoot, upload.staging_key);
    const storageKey = uploadFinalStorageKey(upload);
    const finalPath = safePath(this.storageRoot, storageKey);
    await mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
    const sourcePath = await exists(stagingPath) ? stagingPath : finalPath;
    const info = await stat(sourcePath).catch((error) => {
      throw new CodeBlobError("STORAGE_CORRUPT", "Completed Code blob bytes are missing", false, { cause: error });
    });
    if (!info.isFile() || info.size !== upload.byte_size) {
      throw new CodeBlobError("STORAGE_CORRUPT", "Completed Code blob size is invalid");
    }
    if (await hashFile(sourcePath) !== upload.sha256) {
      this.options.db.transaction(() => {
        if (sourcePath === finalPath) {
          this.options.db.prepare(`
            INSERT OR IGNORE INTO code_blob_gc_queue (storage_key, enqueued_at)
            VALUES (?, ?)
          `).run(storageKey, new Date(this.now()).toISOString());
        }
        this.options.db.prepare("DELETE FROM code_blob_uploads WHERE upload_id = ?")
          .run(upload.upload_id);
      }).immediate();
      throw new CodeBlobError("HASH_MISMATCH", "Completed Code blob hash does not match");
    }
    let attestation: { scanProvider: string; scannedAt: string };
    try {
      attestation = await this.scanFile(sourcePath, {
        sha256: upload.sha256,
        byteSize: upload.byte_size,
        mimeType: upload.mime_type,
      });
    } catch (error) {
      if (error instanceof CodeBlobError && error.code === "MALWARE_DETECTED") {
        await this.rejectInfectedUpload(upload, storageKey);
      }
      throw error;
    }
    const finalPathExists = await exists(finalPath);
    if (finalPathExists) {
      const existing = await stat(finalPath);
      if (!existing.isFile() || existing.size !== upload.byte_size || await hashFile(finalPath) !== upload.sha256) {
        throw new CodeBlobError("STORAGE_CORRUPT", "Published Code blob is inconsistent");
      }
    }
    const timestamp = attestation.scannedAt;
    this.options.db.prepare(`
      INSERT OR IGNORE INTO code_blob_gc_queue (storage_key, enqueued_at)
      VALUES (?, ?)
    `).run(storageKey, timestamp);
    try {
      this.options.db.transaction(() => {
        this.assertAccessActive(accessScope);
        const currentUpload = this.requireUpload(
          upload.upload_id,
          accessScope.resourceId,
        );
        if (currentUpload.expires_at <= new Date(this.now()).toISOString()) {
          throw new CodeBlobError("UPLOAD_EXPIRED", "Code blob upload expired", true);
        }
        if (currentUpload.next_offset !== currentUpload.byte_size) {
          throw new CodeBlobError("UPLOAD_INCOMPLETE", "Code blob upload is incomplete");
        }
        if (!finalPathExists) {
          try {
            linkSync(stagingPath, finalPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            assertFinalFileSync(finalPath, upload);
          }
        } else {
          assertFinalFileSync(finalPath, upload);
        }
        syncDirectoryChainSync(this.storageRoot, path.dirname(finalPath));
        const existing = this.findBlob(accessScope.resourceId, upload.sha256);
        if (existing) {
          this.assertSameIdentity(existing, {
            sha256: upload.sha256,
            byteSize: upload.byte_size,
            mimeType: upload.mime_type,
          });
          if (existing.scan_provider === null && existing.scanned_at === null) {
            this.options.db.prepare(`
              UPDATE code_blobs
              SET scan_provider = ?, scanned_at = ?
              WHERE room_resource_id = ? AND sha256 = ?
                AND scan_provider IS NULL AND scanned_at IS NULL
            `).run(
              attestation.scanProvider,
              attestation.scannedAt,
              accessScope.resourceId,
              upload.sha256,
            );
          } else if (!existing.scan_provider || !existing.scanned_at) {
            throw new CodeBlobError(
              "STORAGE_CORRUPT",
              "Code blob malware scan attestation is incomplete",
            );
          }
        } else {
          this.options.db.prepare(`
            INSERT INTO code_blobs (
              room_resource_id, sha256, byte_size, mime_type, storage_key,
              created_at, scan_provider, scanned_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            accessScope.resourceId,
            upload.sha256,
            upload.byte_size,
            upload.mime_type,
            storageKey,
            timestamp,
            attestation.scanProvider,
            attestation.scannedAt,
          );
        }
        this.options.db.prepare("DELETE FROM code_blob_gc_queue WHERE storage_key = ?")
          .run(storageKey);
        this.touchReady(accessScope);
        this.options.db.prepare("DELETE FROM code_blob_uploads WHERE upload_id = ?")
          .run(upload.upload_id);
      }).immediate();
    } catch (error) {
      this.options.db.prepare(`
        INSERT OR IGNORE INTO code_blob_gc_queue (storage_key, enqueued_at)
        VALUES (?, ?)
      `).run(storageKey, timestamp);
      if (error instanceof CodeBlobError) throw error;
      throw new CodeBlobError("STORAGE_ERROR", "Code blob could not be published", true, { cause: error });
    }
    return {
      status: "ready",
      blob: {
        sha256: upload.sha256,
        byteSize: upload.byte_size,
        mimeType: upload.mime_type,
      },
    };
  }

  async status(shareId: string, hash: string): Promise<{ status: "ready"; blob: CodeBlobIdentity }> {
    const accessScope = this.authorize(shareId);
    if (!SHA256_PATTERN.test(hash)) {
      throw new CodeBlobError("INVALID_ARGUMENT", "Code blob hash is invalid");
    }
    const row = this.findBlob(accessScope.resourceId, hash);
    if (!row) throw new CodeBlobError("NOT_FOUND", "Code blob was not found");
    await this.assertScannedStoredBlob(row);
    return { status: "ready", blob: rowIdentity(row) };
  }

  async download(shareId: string, hash: string): Promise<CodeBlobDownload> {
    const accessScope = this.authorize(shareId);
    if (!SHA256_PATTERN.test(hash)) {
      throw new CodeBlobError("INVALID_ARGUMENT", "Code blob hash is invalid");
    }
    const row = this.findBlob(accessScope.resourceId, hash);
    if (!row) throw new CodeBlobError("NOT_FOUND", "Code blob was not found");
    const filePath = await this.assertScannedStoredBlob(row);
    return {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": "application/octet-stream",
        "Content-Length": String(row.byte_size),
        "Content-Disposition": `attachment; filename="${row.sha256}.bin"`,
        "X-Content-Type-Options": "nosniff",
        "X-Eduri-Blob-Mime": row.mime_type,
        ETag: `"sha256-${row.sha256}"`,
      },
      stream: createReadStream(filePath),
    };
  }

  async cleanupExpiredUploads(): Promise<number> {
    const cutoff = new Date(this.now()).toISOString();
    const candidates = this.options.db.prepare(`
      SELECT upload_id FROM code_blob_uploads
    `).all() as Array<{ upload_id: string }>;
    let removed = 0;
    await Promise.all(candidates.map(({ upload_id: uploadId }) => (
      this.withUploadOperation(uploadId, async () => {
        const upload = this.options.db.prepare(`
          SELECT * FROM code_blob_uploads WHERE upload_id = ?
        `).get(uploadId) as UploadRow | undefined;
        if (!upload) return;
        let broken = false;
        if (upload.expires_at > cutoff && !await exists(
          safePath(this.storageRoot, upload.staging_key),
        )) {
          const finalPath = safePath(
            this.storageRoot,
            uploadFinalStorageKey(upload),
          );
          broken = upload.next_offset !== upload.byte_size
            || !await exists(finalPath);
        }
        if (upload.expires_at > cutoff && !broken) return;
        removed += this.options.db.prepare(`
          DELETE FROM code_blob_uploads WHERE upload_id = ?
        `).run(uploadId).changes;
      })
    )));
    await this.cleanupGarbage();
    return removed;
  }

  async cleanupGarbage(limit = 100): Promise<{ deleted: number; failed: number }> {
    const rows = this.options.db.prepare(`
      SELECT storage_key, attempts FROM code_blob_gc_queue
      ORDER BY attempts, enqueued_at, storage_key LIMIT ?
    `).all(Math.max(1, Math.min(1_000, limit))) as Array<{
      storage_key: string;
      attempts: number;
    }>;
    let deleted = 0;
    let failed = 0;
    for (const row of rows) {
      let outcome: "deleted" | "failed" | undefined;
      this.options.db.transaction(() => {
        const queued = this.options.db.prepare(`
          SELECT attempts FROM code_blob_gc_queue WHERE storage_key = ?
        `).get(row.storage_key) as { attempts: number } | undefined;
        if (!queued || queued.attempts !== row.attempts) return;

        const reference = this.options.db.prepare(`
          SELECT CASE
            WHEN EXISTS (
              SELECT 1 FROM code_blobs WHERE storage_key = ?
            ) THEN 'published'
            WHEN EXISTS (
              SELECT 1 FROM code_blob_uploads WHERE staging_key = ?
            ) THEN 'staging'
            WHEN EXISTS (
              SELECT 1 FROM code_blob_uploads
              WHERE 'blobs/' || room_resource_id || '/' || sha256 = ?
            ) THEN 'recovery'
          END AS kind
        `).get(
          row.storage_key,
          row.storage_key,
          row.storage_key,
        ) as { kind: "published" | "staging" | "recovery" | null };
        if (reference.kind === "published" || reference.kind === "staging") {
          this.options.db.prepare("DELETE FROM code_blob_gc_queue WHERE storage_key = ?")
            .run(row.storage_key);
          return;
        }
        if (reference.kind === "recovery") {
          this.options.db.prepare(`
            UPDATE code_blob_gc_queue
            SET attempts = attempts + 1, last_error = NULL
            WHERE storage_key = ?
          `).run(row.storage_key);
          return;
        }

        try {
          try {
            unlinkSync(safePath(this.storageRoot, row.storage_key));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          this.options.db.prepare("DELETE FROM code_blob_gc_queue WHERE storage_key = ?")
            .run(row.storage_key);
          outcome = "deleted";
        } catch (error) {
          this.options.db.prepare(`
            UPDATE code_blob_gc_queue
            SET attempts = attempts + 1, last_error = ?
            WHERE storage_key = ?
          `).run(error instanceof Error ? error.message.slice(0, 500) : "unlink failed", row.storage_key);
          outcome = "failed";
        }
      }).immediate();
      if (outcome === "deleted") deleted += 1;
      if (outcome === "failed") failed += 1;
    }
    return { deleted, failed };
  }

  private authorize(shareId: string): CodeBlobAccess {
    const lookup = this.options.guestRooms.lookup(shareId);
    if (lookup.status === "expired") {
      throw new CodeBlobError("ROOM_EXPIRED", "Guest room has expired");
    }
    if (lookup.status !== "active") {
      throw new CodeBlobError("NOT_FOUND", "Guest Code workspace was not found");
    }
    const resource = lookup.room.resources.find((candidate) => (
      candidate.kind === "code" && candidate.ordinal === 1
    ));
    if (!resource) {
      throw new CodeBlobError("NOT_FOUND", "Guest Code workspace was not found");
    }
    return { roomId: lookup.room.id, resourceId: resource.id };
  }

  private touchReady(accessScope: CodeBlobAccess): void {
    if (!this.options.guestRooms.recordResourceMutation(
      accessScope.roomId,
      accessScope.resourceId,
    )) {
      throw new CodeBlobError("ROOM_EXPIRED", "Guest room expired while publishing a Code blob");
    }
  }

  private assertAccessActive(accessScope: CodeBlobAccess): void {
    if (!this.options.guestRooms.isResourceActive(
      accessScope.roomId,
      accessScope.resourceId,
      "code",
    )) {
      throw new CodeBlobError("ROOM_EXPIRED", "Guest room expired while publishing a Code blob");
    }
  }

  private findBlob(resourceId: string, hash: string): BlobRow | undefined {
    return this.options.db.prepare(`
      SELECT * FROM code_blobs WHERE room_resource_id = ? AND sha256 = ?
    `).get(resourceId, hash) as BlobRow | undefined;
  }

  private findUpload(resourceId: string, hash: string): UploadRow | undefined {
    return this.options.db.prepare(`
      SELECT * FROM code_blob_uploads WHERE room_resource_id = ? AND sha256 = ?
    `).get(resourceId, hash) as UploadRow | undefined;
  }

  private requireUpload(uploadId: string, resourceId: string): UploadRow {
    const row = this.options.db.prepare(`
      SELECT * FROM code_blob_uploads WHERE upload_id = ? AND room_resource_id = ?
    `).get(uploadId, resourceId) as UploadRow | undefined;
    if (!row) throw new CodeBlobError("NOT_FOUND", "Code blob upload was not found");
    return row;
  }

  private assertSameIdentity(row: BlobRow, identity: CodeBlobIdentity): void {
    if (row.byte_size !== identity.byteSize || row.mime_type !== identity.mimeType) {
      throw new CodeBlobError("IDENTITY_CONFLICT", "Code blob hash is bound to different metadata");
    }
  }

  private assertUploadIdentity(row: UploadRow, identity: CodeBlobIdentity): void {
    if (row.byte_size !== identity.byteSize || row.mime_type !== identity.mimeType) {
      throw new CodeBlobError("IDENTITY_CONFLICT", "Code blob upload metadata differs");
    }
  }

  private assertUploadActive(row: UploadRow): void {
    if (row.expires_at <= new Date(this.now()).toISOString()) {
      this.options.db.prepare("DELETE FROM code_blob_uploads WHERE upload_id = ?")
        .run(row.upload_id);
      throw new CodeBlobError("UPLOAD_EXPIRED", "Code blob upload expired", true);
    }
  }

  private async scanFile(
    filePath: string,
    identity: CodeBlobIdentity,
  ): Promise<{ scanProvider: string; scannedAt: string }> {
    let result;
    try {
      result = await this.options.scanner.scan({
        filePath,
        byteSize: identity.byteSize,
        sha256: identity.sha256,
      });
    } catch (error) {
      const retryable = !(error instanceof MalwareScannerError)
        || error.code !== "SIZE_LIMIT";
      throw new CodeBlobError(
        "MALWARE_SCAN_UNAVAILABLE",
        "Code blob malware scanning did not complete successfully",
        retryable,
        { cause: error },
      );
    }
    if (result.status === "infected") {
      throw new CodeBlobError(
        "MALWARE_DETECTED",
        "Code blob was rejected by malware scanning",
      );
    }
    return {
      scanProvider: this.scanProvider,
      scannedAt: new Date(this.now()).toISOString(),
    };
  }

  private async rejectInfectedUpload(
    upload: UploadRow,
    finalStorageKey: string,
  ): Promise<void> {
    const timestamp = new Date(this.now()).toISOString();
    this.options.db.transaction(() => {
      this.options.db.prepare(`
        DELETE FROM code_blobs
        WHERE room_resource_id = ? AND sha256 = ?
      `).run(upload.room_resource_id, upload.sha256);
      this.options.db.prepare("DELETE FROM code_blob_uploads WHERE upload_id = ?")
        .run(upload.upload_id);
      this.options.db.prepare(`
        INSERT OR IGNORE INTO code_blob_gc_queue (storage_key, enqueued_at)
        VALUES (?, ?)
      `).run(finalStorageKey, timestamp);
    }).immediate();
    await this.cleanupGarbage();
  }

  private async assertScannedStoredBlob(row: BlobRow): Promise<string> {
    if (row.scan_provider && row.scanned_at) return await this.assertStoredBlob(row);
    if (row.scan_provider !== null || row.scanned_at !== null) {
      throw new CodeBlobError(
        "STORAGE_CORRUPT",
        "Code blob malware scan attestation is incomplete",
      );
    }
    const key = `${row.room_resource_id}:${row.sha256}`;
    const active = this.activeLegacyScans.get(key);
    if (active) return await active;
    const scan = this.finalizationSemaphore.run(
      () => this.attestLegacyStoredBlob(row),
    );
    this.activeLegacyScans.set(key, scan);
    try {
      return await scan;
    } finally {
      if (this.activeLegacyScans.get(key) === scan) {
        this.activeLegacyScans.delete(key);
      }
    }
  }

  private async attestLegacyStoredBlob(staleRow: BlobRow): Promise<string> {
    const row = this.findBlob(staleRow.room_resource_id, staleRow.sha256);
    if (!row) throw new CodeBlobError("NOT_FOUND", "Code blob was removed during malware scanning");
    const filePath = await this.assertStoredBlob(row);
    if (row.scan_provider && row.scanned_at) return filePath;
    if (row.scan_provider !== null || row.scanned_at !== null) {
      throw new CodeBlobError(
        "STORAGE_CORRUPT",
        "Code blob malware scan attestation is incomplete",
      );
    }
    if (await hashFile(filePath) !== row.sha256) {
      throw new CodeBlobError(
        "STORAGE_CORRUPT",
        "Unverified Code blob hash does not match its storage identity",
      );
    }

    let attestation: { scanProvider: string; scannedAt: string };
    try {
      attestation = await this.scanFile(filePath, rowIdentity(row));
    } catch (error) {
      if (error instanceof CodeBlobError && error.code === "MALWARE_DETECTED") {
        this.options.db.prepare(`
          DELETE FROM code_blobs
          WHERE room_resource_id = ? AND sha256 = ?
        `).run(row.room_resource_id, row.sha256);
        await this.cleanupGarbage();
      }
      throw error;
    }

    const changed = this.options.db.prepare(`
      UPDATE code_blobs
      SET scan_provider = ?, scanned_at = ?
      WHERE room_resource_id = ? AND sha256 = ?
        AND scan_provider IS NULL AND scanned_at IS NULL
    `).run(
      attestation.scanProvider,
      attestation.scannedAt,
      row.room_resource_id,
      row.sha256,
    );
    if (changed.changes !== 1) {
      const current = this.findBlob(row.room_resource_id, row.sha256);
      if (!current) {
        throw new CodeBlobError("NOT_FOUND", "Code blob was removed during malware scanning");
      }
      if (!current.scan_provider || !current.scanned_at) {
        throw new CodeBlobError(
          "STORAGE_ERROR",
          "Code blob malware scan attestation raced",
          true,
        );
      }
    }
    return filePath;
  }

  private async assertStoredBlob(row: BlobRow): Promise<string> {
    const filePath = safePath(this.storageRoot, row.storage_key);
    const info = await stat(filePath).catch((error) => {
      throw new CodeBlobError("STORAGE_CORRUPT", "Code blob file is missing", false, { cause: error });
    });
    if (!info.isFile() || info.size !== row.byte_size) {
      throw new CodeBlobError("STORAGE_CORRUPT", "Code blob file size is invalid");
    }
    return filePath;
  }

  private assertCapacityForNewUpload(
    resourceId: string,
    requestedBytes: number,
    observedFreeBytes: number,
  ): void {
    const usage = this.options.db.prepare(`
      SELECT
        (SELECT COALESCE(SUM(byte_size), 0) FROM code_blobs WHERE room_resource_id = ?) AS ready_bytes,
        (SELECT COALESCE(SUM(byte_size), 0) FROM code_blob_uploads WHERE room_resource_id = ?) AS reserved_bytes,
        (SELECT COUNT(*) FROM code_blobs WHERE room_resource_id = ?) AS ready_count,
        (SELECT COUNT(*) FROM code_blob_uploads WHERE room_resource_id = ?) AS upload_count
    `).get(resourceId, resourceId, resourceId, resourceId) as {
      ready_bytes: number;
      reserved_bytes: number;
      ready_count: number;
      upload_count: number;
    };
    if (usage.upload_count >= CODE_BLOB_LIMITS.maxActiveUploads) {
      throw new CodeBlobError("QUOTA_EXCEEDED", "Too many active Code blob uploads");
    }
    if (usage.ready_bytes + usage.reserved_bytes + requestedBytes > CODE_BLOB_LIMITS.maxResourceBytes) {
      throw new CodeBlobError("QUOTA_EXCEEDED", "Guest Code blob quota would be exceeded");
    }
    if (usage.ready_count + usage.upload_count >= CODE_BLOB_LIMITS.maxResourceRecords) {
      throw new CodeBlobError("QUOTA_EXCEEDED", "Guest Code blob metadata quota would be exceeded");
    }
    const global = this.options.db.prepare(`
      SELECT
        (SELECT COALESCE(SUM(byte_size), 0) FROM code_blobs) AS ready_bytes,
        (SELECT COALESCE(SUM(byte_size), 0) FROM code_blob_uploads) AS reserved_bytes,
        (SELECT COUNT(*) FROM code_blobs) AS ready_count,
        (SELECT COUNT(*) FROM code_blob_uploads) AS upload_count,
        (SELECT COALESCE(SUM(byte_size - next_offset), 0) FROM code_blob_uploads) AS remaining_bytes
    `).get() as {
      ready_bytes: number;
      reserved_bytes: number;
      ready_count: number;
      upload_count: number;
      remaining_bytes: number;
    };
    if (global.upload_count >= CODE_BLOB_LIMITS.maxGlobalActiveUploads) {
      throw new CodeBlobError("QUOTA_EXCEEDED", "Global Code blob upload capacity has been reached");
    }
    if (
      global.ready_bytes + global.reserved_bytes
      > CODE_BLOB_LIMITS.maxGlobalBytes - requestedBytes
    ) {
      throw new CodeBlobError("QUOTA_EXCEEDED", "Global guest Code blob quota would be exceeded");
    }
    if (global.ready_count + global.upload_count >= CODE_BLOB_LIMITS.maxGlobalRecords) {
      throw new CodeBlobError("QUOTA_EXCEEDED", "Global Code blob metadata quota would be exceeded");
    }
    if (
      observedFreeBytes
        - global.remaining_bytes
        - requestedBytes
        - CODE_BLOB_LIMITS.metadataReserveBytes
      < this.minFreeDiskBytes
    ) {
      throw new CodeBlobError("DISK_PRESSURE", "Code blob storage is below its free-disk floor", true);
    }
  }

  private uploadResult(upload: UploadRow): BeginCodeBlobResult {
    return {
      status: "upload",
      uploadId: upload.upload_id,
      nextOffset: upload.next_offset,
      chunkBytes: upload.chunk_bytes,
      expiresAt: upload.expires_at,
    };
  }

  private async prepareExistingUpload(
    resourceId: string,
    identity: CodeBlobIdentity,
    uploadId: string,
  ): Promise<UploadRow | undefined> {
    return await this.withUploadOperation(uploadId, async () => {
      const upload = this.findUpload(resourceId, identity.sha256);
      if (!upload || upload.upload_id !== uploadId) return undefined;
      this.assertUploadIdentity(upload, identity);
      const stagingPath = safePath(this.storageRoot, upload.staging_key);
      let info: Awaited<ReturnType<typeof stat>> | undefined;
      try {
        info = await stat(stagingPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new CodeBlobError(
            "STORAGE_ERROR",
            "Code blob staging file could not be inspected",
            true,
            { cause: error },
          );
        }
      }

      const expired = upload.expires_at <= new Date(this.now()).toISOString();
      const inconsistent = info !== undefined && (
        !info.isFile()
        || info.size < upload.next_offset
        || info.size > upload.byte_size
      );
      if (!info && !expired && upload.next_offset === upload.byte_size) {
        const finalPath = safePath(this.storageRoot, uploadFinalStorageKey(upload));
        const finalInfo = await stat(finalPath).catch(() => undefined);
        if (
          finalInfo?.isFile()
          && finalInfo.size === upload.byte_size
          && await hashFile(finalPath) === upload.sha256
        ) {
          return upload;
        }
      }

      if (!info || expired || inconsistent) {
        this.options.db.prepare(`
          DELETE FROM code_blob_uploads
          WHERE upload_id = ? AND room_resource_id = ?
        `).run(upload.upload_id, resourceId);
        return undefined;
      }

      if (info.size > upload.next_offset) {
        const handle = await open(stagingPath, "r+");
        try {
          await handle.truncate(upload.next_offset);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      return upload;
    });
  }

  private async withUploadOperation<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.activeUploadOperations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.activeUploadOperations.set(key, current);
    try {
      return await current;
    } finally {
      if (this.activeUploadOperations.get(key) === current) {
        this.activeUploadOperations.delete(key);
      }
    }
  }

  private async readRange(filePath: string, offset: number, length: number): Promise<Uint8Array> {
    const handle = await open(filePath, "r");
    try {
      const output = Buffer.alloc(length);
      const result = await handle.read(output, 0, length, offset);
      if (result.bytesRead !== length) {
        throw new CodeBlobError("STORAGE_CORRUPT", "Code blob staging file is too short");
      }
      return output;
    } finally {
      await handle.close();
    }
  }
}
