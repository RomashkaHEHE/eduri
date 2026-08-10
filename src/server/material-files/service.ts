import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  lstatSync,
  statSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import { statfs } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  MalwareScannerError,
  type MalwareScanner,
} from "../code-blobs/malwareScanner.js";

export const MATERIAL_FILE_LIMITS = Object.freeze({
  maxFileBytes: 25 * 1024 * 1024,
  tutorQuotaBytes: 2 * 1024 * 1024 * 1024,
  globalQuotaBytes: 20 * 1024 * 1024 * 1024,
  maxActiveUploadsPerTutor: 4,
  maxActiveUploadsGlobal: 32,
  rateWindowMs: 10 * 60 * 1000,
  tutorWriteBytesPerWindow: 100 * 1024 * 1024,
  globalWriteBytesPerWindow: 1024 * 1024 * 1024,
  tutorMaterialRows: 10_000,
  globalMaterialRows: 100_000,
  tutorMaterialTextBytes: 256 * 1024 * 1024,
  globalMaterialTextBytes: 2 * 1024 * 1024 * 1024,
  tutorMaterialWritesPerWindow: 240,
  globalMaterialWritesPerWindow: 2_400,
  tutorMaterialTextWriteBytesPerWindow: 20 * 1024 * 1024,
  globalMaterialTextWriteBytesPerWindow: 200 * 1024 * 1024,
  maxConcurrentScans: 4,
  maxQueuedScans: 64,
  uploadTtlMs: 30 * 60 * 1000,
  minFreeDiskBytes: 512 * 1024 * 1024,
});

export type MaterialFileErrorCode =
  | "INVALID_UPLOAD"
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "DISK_PRESSURE"
  | "MALWARE_DETECTED"
  | "MALWARE_SCAN_UNAVAILABLE"
  | "STORAGE_CORRUPT"
  | "STORAGE_ERROR";

export class MaterialFileError extends Error {
  constructor(
    readonly code: MaterialFileErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MaterialFileError";
  }
}

export interface MaterialFileLimits {
  maxFileBytes: number;
  tutorQuotaBytes: number;
  globalQuotaBytes: number;
  maxActiveUploadsPerTutor: number;
  maxActiveUploadsGlobal: number;
  rateWindowMs: number;
  tutorWriteBytesPerWindow: number;
  globalWriteBytesPerWindow: number;
  tutorMaterialRows: number;
  globalMaterialRows: number;
  tutorMaterialTextBytes: number;
  globalMaterialTextBytes: number;
  tutorMaterialWritesPerWindow: number;
  globalMaterialWritesPerWindow: number;
  tutorMaterialTextWriteBytesPerWindow: number;
  globalMaterialTextWriteBytesPerWindow: number;
  maxConcurrentScans: number;
  maxQueuedScans: number;
  uploadTtlMs: number;
  minFreeDiskBytes: number;
}

export interface MaterialUploadReservation {
  uploadId: string;
  tutorId: string;
  quarantineKey: string;
  quarantinePath: string;
}

export interface PreparedMaterialFile {
  uploadId: string;
  tutorId: string;
  storageKey: string;
  byteSize: number;
  sha256: string;
  scanProvider: string;
  scannedAt: string;
}

export interface MaterialWritePlan {
  tutorId: string;
  materialId: string;
  nextTextBytes: number;
  replacingMaterialId?: string;
}

export interface MaterialFileRow {
  id: string;
  kind: string;
  storage_key: string | null;
  file_size: number | null;
  file_sha256: string | null;
  scan_provider: string | null;
  scanned_at: string | null;
}

interface ReservationRow {
  upload_id: string;
  tutor_id: string;
  reserved_bytes: number;
  quarantine_key: string;
  final_key: string | null;
  created_at: string;
  expires_at: string;
}

export interface MaterialFileServiceOptions {
  db: Database.Database;
  scanner: MalwareScanner;
  storageRoot: string;
  forbiddenPublicRoots?: readonly string[];
  limits?: Partial<MaterialFileLimits>;
  now?: () => number;
  diskFreeBytes?: (storageRoot: string) => Promise<number>;
  unlinkFileSync?: (filePath: string) => void;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safePath(root: string, storageKey: string): string {
  if (
    !storageKey
    || path.isAbsolute(storageKey)
    || storageKey.includes("\\")
    || storageKey.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new MaterialFileError("STORAGE_CORRUPT", "Material file storage key is invalid");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...storageKey.split("/"));
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new MaterialFileError("STORAGE_CORRUPT", "Material file path escaped private storage");
  }
  return resolved;
}

function syncFile(filePath: string): void {
  // Windows rejects fsync on a read-only file descriptor with EPERM. Opening
  // the private upload for update gives fsync the same durability semantics on
  // every supported host without changing its contents.
  const descriptor = openSync(filePath, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(directoryPath: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(directoryPath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function hashFile(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

function checkedLimit(name: keyof MaterialFileLimits, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Material file limit ${name} must be a positive safe integer`);
  }
  return value;
}

export class MaterialFileService {
  readonly limits: Readonly<MaterialFileLimits>;
  readonly storageRoot: string;
  readonly quarantineRoot: string;
  readonly filesRoot: string;

  private readonly now: () => number;
  private readonly scanProvider: string;
  private readonly diskFreeBytes: (storageRoot: string) => Promise<number>;
  private readonly unlinkFileSync: (filePath: string) => void;
  private readonly activePreparations = new Map<string, Promise<PreparedMaterialFile>>();
  private readonly activeLegacyScans = new Map<string, Promise<string>>();
  private readonly scanWaiters: Array<() => void> = [];
  private activeScannerCalls = 0;

  constructor(private readonly options: MaterialFileServiceOptions) {
    this.now = options.now ?? Date.now;
    this.storageRoot = path.resolve(options.storageRoot);
    this.quarantineRoot = path.join(this.storageRoot, ".quarantine");
    this.filesRoot = path.join(this.storageRoot, "files");
    const configured = { ...MATERIAL_FILE_LIMITS, ...options.limits };
    this.limits = Object.freeze(Object.fromEntries(
      Object.entries(configured).map(([name, value]) => [
        name,
        checkedLimit(name as keyof MaterialFileLimits, value),
      ]),
    ) as unknown as MaterialFileLimits);
    if (this.limits.maxFileBytes > MATERIAL_FILE_LIMITS.maxFileBytes) {
      throw new Error("Material file size limit cannot exceed the database reservation bound");
    }
    this.scanProvider = options.scanner.id.trim();
    if (!this.scanProvider || this.scanProvider.length > 255) {
      throw new Error("Material malware scanner must have a bounded non-empty ID");
    }
    for (const forbidden of options.forbiddenPublicRoots ?? []) {
      if (isInside(this.storageRoot, forbidden) || isInside(forbidden, this.storageRoot)) {
        throw new Error("Material file storage must be outside public roots");
      }
    }
    this.diskFreeBytes = options.diskFreeBytes ?? (async (root) => {
      const disk = await statfs(root);
      const bytes = Number(disk.bavail) * Number(disk.bsize);
      if (!Number.isFinite(bytes) || bytes < 0) {
        throw new Error("free disk capacity was not finite");
      }
      return bytes;
    });
    this.unlinkFileSync = options.unlinkFileSync ?? unlinkSync;
    mkdirSync(this.storageRoot, { recursive: true, mode: 0o700 });
    mkdirSync(this.quarantineRoot, { recursive: true, mode: 0o700 });
    mkdirSync(this.filesRoot, { recursive: true, mode: 0o700 });
  }

  async beginUpload(tutorId: string): Promise<MaterialUploadReservation> {
    const observedFreeBytes = await this.measureFreeDisk();
    const uploadId = `f_${randomUUID()}`;
    const quarantineKey = `.quarantine/${uploadId}.part`;
    const timestamp = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + this.limits.uploadTtlMs).toISOString();
    const reservedBytes = this.limits.maxFileBytes;
    try {
      this.options.db.transaction(() => {
        const tutor = this.options.db.prepare(`
          SELECT 1 FROM users
          WHERE id = ? AND role = 'tutor' AND status = 'active'
        `).get(tutorId);
        if (!tutor) {
          throw new MaterialFileError("INVALID_UPLOAD", "Material upload tutor is unavailable");
        }
        this.deleteExpiredRateEvents();
        this.assertCapacity(tutorId, reservedBytes, observedFreeBytes);
        this.options.db.prepare(`
          INSERT INTO material_file_gc_queue (storage_key, enqueued_at)
          VALUES (?, ?)
        `).run(quarantineKey, timestamp);
        this.options.db.prepare(`
          INSERT INTO material_upload_reservations (
            upload_id, tutor_id, reserved_bytes, quarantine_key,
            created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          uploadId,
          tutorId,
          reservedBytes,
          quarantineKey,
          timestamp,
          expiresAt,
        );
        this.options.db.prepare(`
          INSERT INTO material_upload_rate_events (
            upload_id, tutor_id, byte_size, created_at
          ) VALUES (?, ?, ?, ?)
        `).run(uploadId, tutorId, reservedBytes, timestamp);
      }).immediate();
    } catch (error) {
      if (error instanceof MaterialFileError) throw error;
      throw new MaterialFileError(
        "STORAGE_ERROR",
        "Material upload reservation could not be persisted",
        true,
        { cause: error },
      );
    }
    return {
      uploadId,
      tutorId,
      quarantineKey,
      quarantinePath: safePath(this.storageRoot, quarantineKey),
    };
  }

  prepareUpload(
    reservation: MaterialUploadReservation,
    observedBytes: number,
  ): Promise<PreparedMaterialFile> {
    const active = this.activePreparations.get(reservation.uploadId);
    if (active) return active;
    const preparation = this.prepareUploadOnce(reservation, observedBytes)
      .finally(() => this.activePreparations.delete(reservation.uploadId));
    this.activePreparations.set(reservation.uploadId, preparation);
    return preparation;
  }

  private async prepareUploadOnce(
    reservation: MaterialUploadReservation,
    observedBytes: number,
  ): Promise<PreparedMaterialFile> {
    if (
      !Number.isSafeInteger(observedBytes)
      || observedBytes < 1
      || observedBytes > this.limits.maxFileBytes
    ) {
      throw new MaterialFileError("INVALID_UPLOAD", "Material file size is invalid");
    }
    const row = this.requireReservation(reservation.uploadId, reservation.tutorId);
    if (row.quarantine_key !== reservation.quarantineKey) {
      throw new MaterialFileError("STORAGE_CORRUPT", "Material upload reservation changed");
    }
    const quarantinePath = safePath(this.storageRoot, row.quarantine_key);
    const info = this.requireRegularFile(quarantinePath, observedBytes);
    if (info.size !== observedBytes) {
      throw new MaterialFileError("STORAGE_CORRUPT", "Material upload size changed");
    }
    const observedFreeBytes = await this.measureFreeDisk();
    this.options.db.transaction(() => {
      const current = this.requireReservation(reservation.uploadId, reservation.tutorId);
      this.assertAdjustedCapacity(current, observedBytes, observedFreeBytes);
      this.options.db.prepare(`
        UPDATE material_upload_reservations SET reserved_bytes = ?
        WHERE upload_id = ? AND tutor_id = ?
      `).run(observedBytes, reservation.uploadId, reservation.tutorId);
      this.options.db.prepare(`
        UPDATE material_upload_rate_events SET byte_size = ?
        WHERE upload_id = ? AND tutor_id = ?
      `).run(observedBytes, reservation.uploadId, reservation.tutorId);
    }).immediate();

    const sha256 = await hashFile(quarantinePath);
    const scannedAt = await this.scanFile(quarantinePath, observedBytes, sha256);
    const finalKey = `files/${randomBytes(24).toString("base64url")}`;
    const finalPath = safePath(this.storageRoot, finalKey);
    this.options.db.transaction(() => {
      const current = this.requireReservation(reservation.uploadId, reservation.tutorId);
      if (current.final_key !== null) {
        throw new MaterialFileError("INVALID_UPLOAD", "Material upload is already being published");
      }
      this.options.db.prepare(`
        INSERT INTO material_file_gc_queue (storage_key, enqueued_at)
        VALUES (?, ?)
      `).run(finalKey, scannedAt);
      const changed = this.options.db.prepare(`
        UPDATE material_upload_reservations SET final_key = ?
        WHERE upload_id = ? AND tutor_id = ? AND final_key IS NULL
      `).run(finalKey, reservation.uploadId, reservation.tutorId);
      if (changed.changes !== 1) {
        throw new MaterialFileError("INVALID_UPLOAD", "Material upload publication raced");
      }
    }).immediate();
    try {
      renameSync(quarantinePath, finalPath);
      syncFile(finalPath);
      syncDirectory(this.quarantineRoot);
      syncDirectory(this.filesRoot);
    } catch (error) {
      throw new MaterialFileError(
        "STORAGE_ERROR",
        "Scanned material file could not be moved into private storage",
        true,
        { cause: error },
      );
    }
    return {
      uploadId: reservation.uploadId,
      tutorId: reservation.tutorId,
      storageKey: finalKey,
      byteSize: observedBytes,
      sha256,
      scanProvider: this.scanProvider,
      scannedAt,
    };
  }

  commitPrepared<T>(
    prepared: PreparedMaterialFile,
    mutate: (file: PreparedMaterialFile) => T,
    materialWrite?: MaterialWritePlan,
  ): T {
    const finalPath = safePath(this.storageRoot, prepared.storageKey);
    this.requireRegularFile(finalPath, prepared.byteSize);
    return this.options.db.transaction(() => {
      const reservation = this.requireReservation(prepared.uploadId, prepared.tutorId);
      if (reservation.final_key !== prepared.storageKey) {
        throw new MaterialFileError("STORAGE_CORRUPT", "Prepared material file identity changed");
      }
      if (materialWrite) {
        if (materialWrite.tutorId !== prepared.tutorId) {
          throw new MaterialFileError("INVALID_UPLOAD", "Material write owner changed");
        }
        this.reserveMaterialWrite(materialWrite);
      }
      const result = mutate(prepared);
      if (materialWrite) this.verifyMaterialWrite(materialWrite);
      this.options.db.prepare(`
        DELETE FROM material_upload_reservations
        WHERE upload_id = ? AND tutor_id = ?
      `).run(prepared.uploadId, prepared.tutorId);
      this.options.db.prepare(`
        DELETE FROM material_file_gc_queue
        WHERE storage_key IN (?, ?)
      `).run(reservation.quarantine_key, prepared.storageKey);
      return result;
    }).immediate();
  }

  commitMaterialWrite<T>(plan: MaterialWritePlan, mutate: () => T): T {
    return this.options.db.transaction(() => {
      this.reserveMaterialWrite(plan);
      const result = mutate();
      this.verifyMaterialWrite(plan);
      return result;
    }).immediate();
  }

  async abortUpload(uploadId: string | undefined, observedBytes?: number): Promise<void> {
    if (!uploadId) return;
    if (
      Number.isSafeInteger(observedBytes)
      && observedBytes !== undefined
      && observedBytes >= 1
      && observedBytes <= this.limits.maxFileBytes
    ) {
      this.options.db.prepare(`
        UPDATE material_upload_rate_events SET byte_size = ?
        WHERE upload_id = ?
      `).run(observedBytes, uploadId);
    }
    this.options.db.prepare(`
      DELETE FROM material_upload_reservations WHERE upload_id = ?
    `).run(uploadId);
    await this.cleanupGarbage();
  }

  enqueueGarbage(storageKey: string, timestamp = new Date(this.now()).toISOString()): void {
    safePath(this.storageRoot, storageKey);
    this.options.db.prepare(`
      INSERT OR IGNORE INTO material_file_gc_queue (storage_key, enqueued_at)
      VALUES (?, ?)
    `).run(storageKey, timestamp);
  }

  enqueueTutorFiles(tutorId: string): number {
    const rows = this.options.db.prepare(`
      SELECT storage_key FROM materials
      WHERE tutor_id = ? AND kind = 'file' AND storage_key IS NOT NULL
    `).all(tutorId) as Array<{ storage_key: string }>;
    for (const row of rows) this.enqueueGarbage(row.storage_key);
    return rows.length;
  }

  ensureScanned(row: MaterialFileRow): Promise<string> {
    const key = `${row.id}\u0000${row.storage_key ?? ""}`;
    const active = this.activeLegacyScans.get(key);
    if (active) return active;
    const scan = this.ensureScannedOnce(row)
      .finally(() => this.activeLegacyScans.delete(key));
    this.activeLegacyScans.set(key, scan);
    return scan;
  }

  private async ensureScannedOnce(row: MaterialFileRow): Promise<string> {
    if (row.kind !== "file" || !row.storage_key || !row.file_size) {
      throw new MaterialFileError("STORAGE_CORRUPT", "Material file metadata is incomplete");
    }
    const filePath = safePath(this.storageRoot, row.storage_key);
    this.requireRegularFile(filePath, row.file_size);
    const fields = [row.file_sha256, row.scan_provider, row.scanned_at];
    const attested = fields.every((value) => typeof value === "string" && value.length > 0);
    const legacy = fields.every((value) => value === null);
    if (!attested && !legacy) {
      throw new MaterialFileError("STORAGE_CORRUPT", "Material scan attestation is incomplete");
    }
    if (attested) {
      if (!SHA256_PATTERN.test(row.file_sha256!) || row.scan_provider!.length > 255) {
        throw new MaterialFileError("STORAGE_CORRUPT", "Material scan attestation is invalid");
      }
      return filePath;
    }

    const sha256 = await hashFile(filePath);
    const scannedAt = await this.scanFile(filePath, row.file_size, sha256).catch(async (error) => {
      if (error instanceof MaterialFileError && error.code === "MALWARE_DETECTED") {
        this.options.db.transaction(() => {
          this.enqueueGarbage(row.storage_key!);
          this.options.db.prepare(`
            DELETE FROM materials WHERE id = ? AND storage_key = ?
          `).run(row.id, row.storage_key);
        }).immediate();
        await this.cleanupGarbage();
      }
      throw error;
    });
    const changed = this.options.db.prepare(`
      UPDATE materials
      SET file_sha256 = ?, scan_provider = ?, scanned_at = ?
      WHERE id = ? AND storage_key = ?
        AND file_sha256 IS NULL AND scan_provider IS NULL AND scanned_at IS NULL
    `).run(sha256, this.scanProvider, scannedAt, row.id, row.storage_key);
    if (changed.changes !== 1) {
      const current = this.options.db.prepare(`
        SELECT file_sha256, scan_provider, scanned_at, storage_key
        FROM materials WHERE id = ?
      `).get(row.id) as {
        file_sha256: string | null;
        scan_provider: string | null;
        scanned_at: string | null;
        storage_key: string | null;
      } | undefined;
      if (
        !current
        || current.storage_key !== row.storage_key
        || !current.file_sha256
        || !current.scan_provider
        || !current.scanned_at
      ) {
        throw new MaterialFileError("STORAGE_ERROR", "Material changed during malware scanning", true);
      }
    }
    return filePath;
  }

  async recoverInterruptedUploads(): Promise<{ abandoned: number; deleted: number; failed: number }> {
    const abandoned = this.options.db.transaction(() => {
      const rows = this.options.db.prepare(`
        SELECT quarantine_key, final_key FROM material_upload_reservations
      `).all() as Array<{ quarantine_key: string; final_key: string | null }>;
      for (const row of rows) {
        this.enqueueGarbage(row.quarantine_key);
        if (row.final_key) this.enqueueGarbage(row.final_key);
      }
      this.options.db.prepare("DELETE FROM material_upload_reservations").run();
      this.deleteExpiredRateEvents();
      return rows.length;
    }).immediate();
    const garbage = await this.cleanupGarbage();
    return { abandoned, ...garbage };
  }

  async cleanupExpiredUploads(): Promise<number> {
    const cutoff = new Date(this.now()).toISOString();
    const removed = this.options.db.transaction(() => {
      const rows = this.options.db.prepare(`
        SELECT quarantine_key, final_key FROM material_upload_reservations
        WHERE expires_at <= ?
      `).all(cutoff) as Array<{ quarantine_key: string; final_key: string | null }>;
      for (const row of rows) {
        this.enqueueGarbage(row.quarantine_key);
        if (row.final_key) this.enqueueGarbage(row.final_key);
      }
      this.options.db.prepare(`
        DELETE FROM material_upload_reservations WHERE expires_at <= ?
      `).run(cutoff);
      this.deleteExpiredRateEvents();
      return rows.length;
    }).immediate();
    await this.cleanupGarbage();
    return removed;
  }

  async cleanupGarbage(limit = 100): Promise<{ deleted: number; failed: number }> {
    const rows = this.options.db.prepare(`
      SELECT storage_key, attempts FROM material_file_gc_queue
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
          SELECT attempts FROM material_file_gc_queue WHERE storage_key = ?
        `).get(row.storage_key) as { attempts: number } | undefined;
        if (!queued || queued.attempts !== row.attempts) return;
        const reference = this.options.db.prepare(`
          SELECT CASE
            WHEN EXISTS (
              SELECT 1 FROM materials WHERE storage_key = ?
            ) THEN 'material'
            WHEN EXISTS (
              SELECT 1 FROM material_upload_reservations
              WHERE quarantine_key = ? OR final_key = ?
            ) THEN 'reservation'
          END AS kind
        `).get(row.storage_key, row.storage_key, row.storage_key) as {
          kind: "material" | "reservation" | null;
        };
        if (reference.kind === "material") {
          this.options.db.prepare(`
            DELETE FROM material_file_gc_queue WHERE storage_key = ?
          `).run(row.storage_key);
          return;
        }
        if (reference.kind === "reservation") return;
        try {
          try {
            this.unlinkFileSync(safePath(this.storageRoot, row.storage_key));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          this.options.db.prepare(`
            DELETE FROM material_file_gc_queue WHERE storage_key = ?
          `).run(row.storage_key);
          outcome = "deleted";
        } catch (error) {
          this.options.db.prepare(`
            UPDATE material_file_gc_queue
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

  private requireReservation(uploadId: string, tutorId: string): ReservationRow {
    const row = this.options.db.prepare(`
      SELECT * FROM material_upload_reservations
      WHERE upload_id = ? AND tutor_id = ?
    `).get(uploadId, tutorId) as ReservationRow | undefined;
    if (!row || row.expires_at <= new Date(this.now()).toISOString()) {
      throw new MaterialFileError("INVALID_UPLOAD", "Material upload reservation expired");
    }
    return row;
  }

  private requireRegularFile(filePath: string, expectedBytes: number): Stats {
    let info: Stats;
    try {
      const entry = lstatSync(filePath);
      if (entry.isSymbolicLink()) {
        throw new MaterialFileError("STORAGE_CORRUPT", "Material file must not be a symbolic link");
      }
      info = statSync(filePath) as Stats;
    } catch (error) {
      throw new MaterialFileError(
        "STORAGE_CORRUPT",
        "Material file is missing",
        false,
        { cause: error },
      );
    }
    if (!info.isFile() || info.size !== expectedBytes) {
      throw new MaterialFileError("STORAGE_CORRUPT", "Material file metadata does not match storage");
    }
    return info;
  }

  private reserveMaterialWrite(plan: MaterialWritePlan): void {
    if (
      !plan.tutorId
      || !plan.materialId
      || !Number.isSafeInteger(plan.nextTextBytes)
      || plan.nextTextBytes < 0
      || plan.nextTextBytes > MATERIAL_FILE_LIMITS.maxFileBytes
      || (plan.replacingMaterialId !== undefined && !plan.replacingMaterialId)
    ) {
      throw new MaterialFileError("INVALID_UPLOAD", "Material write accounting is invalid");
    }
    this.deleteExpiredRateEvents();
    const replaced = plan.replacingMaterialId ?? null;
    const cutoff = this.rateCutoff();
    const usage = this.options.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM materials
          WHERE tutor_id = ? AND (? IS NULL OR id != ?)) AS tutor_rows,
        (SELECT COALESCE(SUM(
          length(CAST(title AS BLOB))
          + length(CAST(COALESCE(body, '') AS BLOB))
          + length(CAST(COALESCE(url, '') AS BLOB))
          + length(CAST(tags_json AS BLOB))
          + length(CAST(COALESCE(original_file_name, '') AS BLOB))
          + length(CAST(COALESCE(mime_type, '') AS BLOB))
        ), 0) FROM materials
          WHERE tutor_id = ? AND (? IS NULL OR id != ?)) AS tutor_text,
        (SELECT COUNT(*) FROM materials
          WHERE (? IS NULL OR id != ?)) AS global_rows,
        (SELECT COALESCE(SUM(
          length(CAST(title AS BLOB))
          + length(CAST(COALESCE(body, '') AS BLOB))
          + length(CAST(COALESCE(url, '') AS BLOB))
          + length(CAST(tags_json AS BLOB))
          + length(CAST(COALESCE(original_file_name, '') AS BLOB))
          + length(CAST(COALESCE(mime_type, '') AS BLOB))
        ), 0) FROM materials
          WHERE (? IS NULL OR id != ?)) AS global_text,
        (SELECT COUNT(*) FROM material_upload_rate_events
          WHERE tutor_id = ? AND upload_id GLOB 'm_*' AND created_at >= ?) AS tutor_writes,
        (SELECT COUNT(*) FROM material_upload_rate_events
          WHERE upload_id GLOB 'm_*' AND created_at >= ?) AS global_writes,
        (SELECT COALESCE(SUM(byte_size), 0) FROM material_upload_rate_events
          WHERE tutor_id = ? AND upload_id GLOB 'm_*' AND created_at >= ?) AS tutor_write_bytes,
        (SELECT COALESCE(SUM(byte_size), 0) FROM material_upload_rate_events
          WHERE upload_id GLOB 'm_*' AND created_at >= ?) AS global_write_bytes
    `).get(
      plan.tutorId, replaced, replaced,
      plan.tutorId, replaced, replaced,
      replaced, replaced,
      replaced, replaced,
      plan.tutorId, cutoff,
      cutoff,
      plan.tutorId, cutoff,
      cutoff,
    ) as {
      tutor_rows: number;
      tutor_text: number;
      global_rows: number;
      global_text: number;
      tutor_writes: number;
      global_writes: number;
      tutor_write_bytes: number;
      global_write_bytes: number;
    };
    if (
      usage.tutor_rows + 1 > this.limits.tutorMaterialRows
      || usage.global_rows + 1 > this.limits.globalMaterialRows
      || usage.tutor_text + plan.nextTextBytes > this.limits.tutorMaterialTextBytes
      || usage.global_text + plan.nextTextBytes > this.limits.globalMaterialTextBytes
    ) {
      throw new MaterialFileError("QUOTA_EXCEEDED", "Material row or text quota would be exceeded");
    }
    if (
      usage.tutor_writes + 1 > this.limits.tutorMaterialWritesPerWindow
      || usage.global_writes + 1 > this.limits.globalMaterialWritesPerWindow
      || usage.tutor_write_bytes + plan.nextTextBytes
        > this.limits.tutorMaterialTextWriteBytesPerWindow
      || usage.global_write_bytes + plan.nextTextBytes
        > this.limits.globalMaterialTextWriteBytesPerWindow
    ) {
      throw new MaterialFileError("RATE_LIMITED", "Material write rate was exceeded", true);
    }
    this.options.db.prepare(`
      INSERT INTO material_upload_rate_events (
        upload_id, tutor_id, byte_size, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(
      `m_${randomUUID()}`,
      plan.tutorId,
      Math.max(1, plan.nextTextBytes),
      new Date(this.now()).toISOString(),
    );
  }

  private verifyMaterialWrite(plan: MaterialWritePlan): void {
    const material = this.options.db.prepare(`
      SELECT
        length(CAST(title AS BLOB))
        + length(CAST(COALESCE(body, '') AS BLOB))
        + length(CAST(COALESCE(url, '') AS BLOB))
        + length(CAST(tags_json AS BLOB))
        + length(CAST(COALESCE(original_file_name, '') AS BLOB))
        + length(CAST(COALESCE(mime_type, '') AS BLOB)) AS text_bytes
      FROM materials WHERE id = ? AND tutor_id = ?
    `).get(plan.materialId, plan.tutorId) as { text_bytes: number } | undefined;
    if (!material || material.text_bytes !== plan.nextTextBytes) {
      throw new MaterialFileError(
        "STORAGE_ERROR",
        "Material write accounting did not match the persisted row",
      );
    }
    const usage = this.options.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM materials WHERE tutor_id = ?) AS tutor_rows,
        (SELECT COALESCE(SUM(
          length(CAST(title AS BLOB))
          + length(CAST(COALESCE(body, '') AS BLOB))
          + length(CAST(COALESCE(url, '') AS BLOB))
          + length(CAST(tags_json AS BLOB))
          + length(CAST(COALESCE(original_file_name, '') AS BLOB))
          + length(CAST(COALESCE(mime_type, '') AS BLOB))
        ), 0) FROM materials WHERE tutor_id = ?) AS tutor_text,
        (SELECT COUNT(*) FROM materials) AS global_rows,
        (SELECT COALESCE(SUM(
          length(CAST(title AS BLOB))
          + length(CAST(COALESCE(body, '') AS BLOB))
          + length(CAST(COALESCE(url, '') AS BLOB))
          + length(CAST(tags_json AS BLOB))
          + length(CAST(COALESCE(original_file_name, '') AS BLOB))
          + length(CAST(COALESCE(mime_type, '') AS BLOB))
        ), 0) FROM materials) AS global_text
    `).get(plan.tutorId, plan.tutorId) as {
      tutor_rows: number;
      tutor_text: number;
      global_rows: number;
      global_text: number;
    };
    if (
      usage.tutor_rows > this.limits.tutorMaterialRows
      || usage.global_rows > this.limits.globalMaterialRows
      || usage.tutor_text > this.limits.tutorMaterialTextBytes
      || usage.global_text > this.limits.globalMaterialTextBytes
    ) {
      throw new MaterialFileError("QUOTA_EXCEEDED", "Material row or text quota was exceeded");
    }
  }

  private async scanFile(filePath: string, byteSize: number, sha256: string): Promise<string> {
    const release = await this.acquireScanSlot();
    let result;
    try {
      result = await this.options.scanner.scan({ filePath, byteSize, sha256 });
    } catch (error) {
      throw new MaterialFileError(
        "MALWARE_SCAN_UNAVAILABLE",
        "Material malware scanning did not complete successfully",
        !(error instanceof MalwareScannerError) || error.code !== "SIZE_LIMIT",
        { cause: error },
      );
    } finally {
      release();
    }
    if (result.status === "infected") {
      throw new MaterialFileError("MALWARE_DETECTED", "Material file was rejected by malware scanning");
    }
    return new Date(this.now()).toISOString();
  }

  private async acquireScanSlot(): Promise<() => void> {
    if (this.activeScannerCalls < this.limits.maxConcurrentScans) {
      this.activeScannerCalls += 1;
    } else {
      if (this.scanWaiters.length >= this.limits.maxQueuedScans) {
        throw new MaterialFileError(
          "RATE_LIMITED",
          "Material malware scan queue is full",
          true,
        );
      }
      await new Promise<void>((resolve) => this.scanWaiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.scanWaiters.shift();
      if (next) next();
      else this.activeScannerCalls -= 1;
    };
  }

  private async measureFreeDisk(): Promise<number> {
    try {
      const bytes = await this.diskFreeBytes(this.storageRoot);
      if (!Number.isFinite(bytes) || bytes < 0) throw new Error("invalid free disk capacity");
      return bytes;
    } catch (error) {
      throw new MaterialFileError(
        "STORAGE_ERROR",
        "Material storage capacity could not be measured",
        true,
        { cause: error },
      );
    }
  }

  private assertCapacity(tutorId: string, requestedBytes: number, observedFreeBytes: number): void {
    const usage = this.options.db.prepare(`
      SELECT
        (SELECT COALESCE(SUM(file_size), 0) FROM materials
          WHERE tutor_id = ? AND kind = 'file') AS tutor_ready,
        (SELECT COALESCE(SUM(reserved_bytes), 0) FROM material_upload_reservations
          WHERE tutor_id = ?) AS tutor_reserved,
        (SELECT COUNT(*) FROM material_upload_reservations
          WHERE tutor_id = ?) AS tutor_active,
        (SELECT COALESCE(SUM(file_size), 0) FROM materials
          WHERE kind = 'file') AS global_ready,
        (SELECT COALESCE(SUM(reserved_bytes), 0) FROM material_upload_reservations) AS global_reserved,
        (SELECT COUNT(*) FROM material_upload_reservations) AS global_active,
        (SELECT COALESCE(SUM(byte_size), 0) FROM material_upload_rate_events
          WHERE tutor_id = ? AND upload_id NOT GLOB 'm_*' AND created_at >= ?) AS tutor_rate,
        (SELECT COALESCE(SUM(byte_size), 0) FROM material_upload_rate_events
          WHERE upload_id NOT GLOB 'm_*' AND created_at >= ?) AS global_rate
    `).get(
      tutorId,
      tutorId,
      tutorId,
      tutorId,
      this.rateCutoff(),
      this.rateCutoff(),
    ) as {
      tutor_ready: number;
      tutor_reserved: number;
      tutor_active: number;
      global_ready: number;
      global_reserved: number;
      global_active: number;
      tutor_rate: number;
      global_rate: number;
    };
    if (
      usage.tutor_active >= this.limits.maxActiveUploadsPerTutor
      || usage.global_active >= this.limits.maxActiveUploadsGlobal
    ) {
      throw new MaterialFileError("QUOTA_EXCEEDED", "Too many active material uploads");
    }
    if (
      usage.tutor_ready + usage.tutor_reserved + requestedBytes > this.limits.tutorQuotaBytes
      || usage.global_ready + usage.global_reserved + requestedBytes > this.limits.globalQuotaBytes
    ) {
      throw new MaterialFileError("QUOTA_EXCEEDED", "Material file quota would be exceeded");
    }
    if (
      usage.tutor_rate + requestedBytes > this.limits.tutorWriteBytesPerWindow
      || usage.global_rate + requestedBytes > this.limits.globalWriteBytesPerWindow
    ) {
      throw new MaterialFileError("RATE_LIMITED", "Material upload write rate was exceeded", true);
    }
    if (
      observedFreeBytes - usage.global_reserved - requestedBytes
      < this.limits.minFreeDiskBytes
    ) {
      throw new MaterialFileError("DISK_PRESSURE", "Material storage is below its free-disk floor", true);
    }
  }

  private assertAdjustedCapacity(
    reservation: ReservationRow,
    actualBytes: number,
    observedFreeBytes: number,
  ): void {
    const usage = this.options.db.prepare(`
      SELECT
        (SELECT COALESCE(SUM(file_size), 0) FROM materials
          WHERE tutor_id = ? AND kind = 'file') AS tutor_ready,
        (SELECT COALESCE(SUM(reserved_bytes), 0) FROM material_upload_reservations
          WHERE tutor_id = ? AND upload_id != ?) AS tutor_reserved,
        (SELECT COALESCE(SUM(file_size), 0) FROM materials
          WHERE kind = 'file') AS global_ready,
        (SELECT COALESCE(SUM(reserved_bytes), 0) FROM material_upload_reservations
          WHERE upload_id != ?) AS global_reserved,
        (SELECT COALESCE(SUM(byte_size), 0) FROM material_upload_rate_events
          WHERE tutor_id = ? AND upload_id != ?
            AND upload_id NOT GLOB 'm_*' AND created_at >= ?) AS tutor_rate,
        (SELECT COALESCE(SUM(byte_size), 0) FROM material_upload_rate_events
          WHERE upload_id != ? AND upload_id NOT GLOB 'm_*' AND created_at >= ?) AS global_rate
    `).get(
      reservation.tutor_id,
      reservation.tutor_id,
      reservation.upload_id,
      reservation.upload_id,
      reservation.tutor_id,
      reservation.upload_id,
      this.rateCutoff(),
      reservation.upload_id,
      this.rateCutoff(),
    ) as {
      tutor_ready: number;
      tutor_reserved: number;
      global_ready: number;
      global_reserved: number;
      tutor_rate: number;
      global_rate: number;
    };
    if (
      usage.tutor_ready + usage.tutor_reserved + actualBytes > this.limits.tutorQuotaBytes
      || usage.global_ready + usage.global_reserved + actualBytes > this.limits.globalQuotaBytes
    ) {
      throw new MaterialFileError("QUOTA_EXCEEDED", "Material file quota would be exceeded");
    }
    if (
      usage.tutor_rate + actualBytes > this.limits.tutorWriteBytesPerWindow
      || usage.global_rate + actualBytes > this.limits.globalWriteBytesPerWindow
    ) {
      throw new MaterialFileError("RATE_LIMITED", "Material upload write rate was exceeded", true);
    }
    if (observedFreeBytes - usage.global_reserved < this.limits.minFreeDiskBytes) {
      throw new MaterialFileError("DISK_PRESSURE", "Material storage is below its free-disk floor", true);
    }
  }

  private rateCutoff(): string {
    return new Date(this.now() - this.limits.rateWindowMs).toISOString();
  }

  private deleteExpiredRateEvents(): void {
    this.options.db.prepare(`
      DELETE FROM material_upload_rate_events WHERE created_at < ?
    `).run(this.rateCutoff());
  }
}
