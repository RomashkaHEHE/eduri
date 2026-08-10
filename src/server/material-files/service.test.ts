import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MalwareScannerError,
  type MalwareScanRequest,
  type MalwareScanResult,
  type MalwareScanner,
} from "../code-blobs/malwareScanner.js";
import { migrate } from "../db.js";
import {
  MaterialFileError,
  MaterialFileService,
  type MaterialFileLimits,
  type MaterialFileRow,
  type PreparedMaterialFile,
} from "./service.js";

const NOW_MS = Date.parse("2026-08-09T08:00:00.000Z");
const NOW = new Date(NOW_MS).toISOString();

interface Fixture {
  db: Database.Database;
  dbPath: string;
  root: string;
  tutorId: string;
  service: MaterialFileService;
}

const roots: string[] = [];
const databases = new Set<Database.Database>();

function scanner(
  result: MalwareScanResult | Error = { status: "clean" },
): { scanner: MalwareScanner; scan: ReturnType<typeof vi.fn> } {
  const scan = vi.fn(async (_request: MalwareScanRequest): Promise<MalwareScanResult> => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { scanner: { id: "test-scanner-v1", scan }, scan };
}

function createFixture(options: {
  scanner?: MalwareScanner;
  limits?: Partial<MaterialFileLimits>;
  diskFreeBytes?: () => Promise<number>;
  unlinkFileSync?: (filePath: string) => void;
  fileDatabase?: boolean;
} = {}): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "eduri-material-service-"));
  roots.push(root);
  const dbPath = options.fileDatabase ? path.join(root, "materials.sqlite") : ":memory:";
  const db = new Database(dbPath);
  databases.add(db);
  db.pragma("foreign_keys = ON");
  migrate(db);
  const tutorId = randomUUID();
  db.prepare(`
    INSERT INTO users (
      id, role, status, display_name, created_at, updated_at
    ) VALUES (?, 'tutor', 'active', 'Material tutor', ?, ?)
  `).run(tutorId, NOW, NOW);
  const clean = scanner();
  const service = new MaterialFileService({
    db,
    scanner: options.scanner ?? clean.scanner,
    storageRoot: path.join(root, "private-materials"),
    limits: {
      maxFileBytes: 16,
      tutorQuotaBytes: 128,
      globalQuotaBytes: 256,
      maxActiveUploadsPerTutor: 4,
      maxActiveUploadsGlobal: 8,
      rateWindowMs: 60_000,
      tutorWriteBytesPerWindow: 128,
      globalWriteBytesPerWindow: 256,
      uploadTtlMs: 60_000,
      minFreeDiskBytes: 32,
      ...options.limits,
    },
    now: () => NOW_MS,
    diskFreeBytes: options.diskFreeBytes ?? (async () => 1_000_000),
    unlinkFileSync: options.unlinkFileSync,
  });
  return { db, dbPath, root, tutorId, service };
}

function closeDatabase(db: Database.Database): void {
  if (db.open) db.close();
  databases.delete(db);
}

function persistPrepared(
  db: Database.Database,
  tutorId: string,
  prepared: PreparedMaterialFile,
  materialId = randomUUID(),
): string {
  db.prepare(`
    INSERT INTO materials (
      id, tutor_id, title, kind, storage_key, original_file_name,
      mime_type, file_size, created_at, updated_at,
      file_sha256, scan_provider, scanned_at
    ) VALUES (?, ?, 'Prepared file', 'file', ?, 'prepared.bin',
      'application/octet-stream', ?, ?, ?, ?, ?, ?)
  `).run(
    materialId,
    tutorId,
    prepared.storageKey,
    prepared.byteSize,
    NOW,
    NOW,
    prepared.sha256,
    prepared.scanProvider,
    prepared.scannedAt,
  );
  return materialId;
}

function materialRow(db: Database.Database, materialId: string): MaterialFileRow {
  return db.prepare(`
    SELECT id, kind, storage_key, file_size,
      file_sha256, scan_provider, scanned_at
    FROM materials WHERE id = ?
  `).get(materialId) as MaterialFileRow;
}

function persistNote(
  db: Database.Database,
  tutorId: string,
  materialId: string,
  title: string,
  body: string,
): void {
  db.prepare(`
    INSERT INTO materials (
      id, tutor_id, title, kind, body, tags_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'note', ?, '[]', ?, ?)
  `).run(materialId, tutorId, title, body, NOW, NOW);
}

function persistLegacyFile(
  fixture: Fixture,
  contents: string,
): MaterialFileRow {
  const materialId = randomUUID();
  const storageKey = `files/${materialId}`;
  writeFileSync(path.join(fixture.service.storageRoot, storageKey), contents);
  fixture.db.prepare(`
    INSERT INTO materials (
      id, tutor_id, title, kind, storage_key, original_file_name,
      mime_type, file_size, created_at, updated_at
    ) VALUES (?, ?, 'Legacy', 'file', ?, 'legacy.bin',
      'application/octet-stream', ?, ?, ?)
  `).run(
    materialId,
    fixture.tutorId,
    storageKey,
    Buffer.byteLength(contents),
    NOW,
    NOW,
  );
  return materialRow(fixture.db, materialId);
}

afterEach(() => {
  for (const db of databases) {
    if (db.open) db.close();
  }
  databases.clear();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("MaterialFileService", () => {
  it("publishes only a clean attested file after the database commit", async () => {
    const clean = scanner();
    const fixture = createFixture({ scanner: clean.scanner });
    const reservation = await fixture.service.beginUpload(fixture.tutorId);
    writeFileSync(reservation.quarantinePath, "clean");

    const prepared = await fixture.service.prepareUpload(reservation, 5);
    expect(clean.scan).toHaveBeenCalledWith(expect.objectContaining({
      filePath: reservation.quarantinePath,
      byteSize: 5,
      sha256: prepared.sha256,
    }));
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM materials").get())
      .toEqual({ count: 0 });
    expect(existsSync(reservation.quarantinePath)).toBe(false);
    expect(existsSync(path.join(fixture.service.storageRoot, prepared.storageKey))).toBe(true);

    const materialId = fixture.service.commitPrepared(prepared, (file) => (
      persistPrepared(fixture.db, fixture.tutorId, file)
    ));
    expect(materialRow(fixture.db, materialId)).toMatchObject({
      file_sha256: prepared.sha256,
      scan_provider: "test-scanner-v1",
      scanned_at: NOW,
    });
    expect(fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM material_upload_reservations
    `).get()).toEqual({ count: 0 });
    expect(fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM material_file_gc_queue
    `).get()).toEqual({ count: 0 });

    await expect(fixture.service.ensureScanned(materialRow(fixture.db, materialId)))
      .resolves.toBe(path.join(fixture.service.storageRoot, prepared.storageKey));
    expect(clean.scan).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "infected",
      result: { status: "infected", signature: "Eicar-Test-Signature" } as MalwareScanResult,
      code: "MALWARE_DETECTED",
    },
    {
      label: "unavailable",
      result: new MalwareScannerError("UNAVAILABLE", "scanner offline"),
      code: "MALWARE_SCAN_UNAVAILABLE",
    },
  ])("fails closed when malware scanning is $label", async ({ result, code }) => {
    const scan = scanner(result);
    const fixture = createFixture({ scanner: scan.scanner });
    const reservation = await fixture.service.beginUpload(fixture.tutorId);
    writeFileSync(reservation.quarantinePath, "unsafe");

    await expect(fixture.service.prepareUpload(reservation, 6)).rejects.toMatchObject({
      name: "MaterialFileError",
      code,
    });
    await fixture.service.abortUpload(reservation.uploadId, 6);

    expect(existsSync(reservation.quarantinePath)).toBe(false);
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM materials").get())
      .toEqual({ count: 0 });
    expect(fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM material_upload_reservations
    `).get()).toEqual({ count: 0 });
    expect(fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM material_file_gc_queue
    `).get()).toEqual({ count: 0 });
  });

  it("accounts attempted bytes durably and enforces tutor write rate", async () => {
    const fixture = createFixture({
      limits: {
        maxFileBytes: 10,
        tutorWriteBytesPerWindow: 13,
        globalWriteBytesPerWindow: 100,
      },
    });
    const first = await fixture.service.beginUpload(fixture.tutorId);
    writeFileSync(first.quarantinePath, "abc");
    await fixture.service.abortUpload(first.uploadId, 3);

    const second = await fixture.service.beginUpload(fixture.tutorId);
    await expect(fixture.service.beginUpload(fixture.tutorId)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
    expect(fixture.db.prepare(`
      SELECT SUM(byte_size) AS bytes FROM material_upload_rate_events
      WHERE tutor_id = ?
    `).get(fixture.tutorId)).toEqual({ bytes: 13 });
    await fixture.service.abortUpload(second.uploadId);
  });

  it("rejects fileless material row, text, and write spam before publication", () => {
    const fixture = createFixture({
      limits: {
        tutorMaterialRows: 1,
        globalMaterialRows: 10,
        tutorMaterialTextBytes: 20,
        globalMaterialTextBytes: 100,
        tutorMaterialWritesPerWindow: 10,
        globalMaterialWritesPerWindow: 20,
        tutorMaterialTextWriteBytesPerWindow: 100,
        globalMaterialTextWriteBytesPerWindow: 200,
      },
    });
    const firstId = randomUUID();
    const firstBytes = Buffer.byteLength("onebody[]");
    fixture.service.commitMaterialWrite({
      tutorId: fixture.tutorId,
      materialId: firstId,
      nextTextBytes: firstBytes,
    }, () => persistNote(fixture.db, fixture.tutorId, firstId, "one", "body"));

    const blockedId = randomUUID();
    expect(() => fixture.service.commitMaterialWrite({
      tutorId: fixture.tutorId,
      materialId: blockedId,
      nextTextBytes: Buffer.byteLength("twobody[]"),
    }, () => persistNote(fixture.db, fixture.tutorId, blockedId, "two", "body")))
      .toThrow(expect.objectContaining({ code: "QUOTA_EXCEEDED" }));
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM materials").get())
      .toEqual({ count: 1 });
    expect(fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM material_upload_rate_events
    `).get()).toEqual({ count: 1 });

    const rate = createFixture({
      limits: {
        tutorMaterialRows: 10,
        globalMaterialRows: 20,
        tutorMaterialWritesPerWindow: 1,
        globalMaterialWritesPerWindow: 10,
      },
    });
    const rateFirstId = randomUUID();
    rate.service.commitMaterialWrite({
      tutorId: rate.tutorId,
      materialId: rateFirstId,
      nextTextBytes: firstBytes,
    }, () => persistNote(rate.db, rate.tutorId, rateFirstId, "one", "body"));
    const rateBlockedId = randomUUID();
    expect(() => rate.service.commitMaterialWrite({
      tutorId: rate.tutorId,
      materialId: rateBlockedId,
      nextTextBytes: firstBytes,
    }, () => persistNote(rate.db, rate.tutorId, rateBlockedId, "one", "body")))
      .toThrow(expect.objectContaining({ code: "RATE_LIMITED", retryable: true }));
    expect(rate.db.prepare("SELECT 1 FROM materials WHERE id = ?").get(rateBlockedId))
      .toBeUndefined();
  });

  it("rolls back material write accounting when persistence fails", () => {
    const fixture = createFixture();
    expect(() => fixture.service.commitMaterialWrite({
      tutorId: fixture.tutorId,
      materialId: randomUUID(),
      nextTextBytes: 4,
    }, () => { throw new Error("simulated database mutation failure"); }))
      .toThrow(/simulated database mutation failure/u);
    expect(fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM material_upload_rate_events
    `).get()).toEqual({ count: 0 });
  });

  it("serializes reservations against tutor quota and the free-disk floor", async () => {
    const quota = createFixture({
      limits: { maxFileBytes: 10, tutorQuotaBytes: 19 },
    });
    const concurrent = await Promise.allSettled([
      quota.service.beginUpload(quota.tutorId),
      quota.service.beginUpload(quota.tutorId),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "QUOTA_EXCEEDED" }),
      }),
    ]);

    const disk = createFixture({
      limits: { maxFileBytes: 10, minFreeDiskBytes: 10 },
      diskFreeBytes: async () => 25,
    });
    await disk.service.beginUpload(disk.tutorId);
    await expect(disk.service.beginUpload(disk.tutorId)).rejects.toMatchObject({
      code: "DISK_PRESSURE",
      retryable: true,
    });
  });

  it("recovers a scanned but uncommitted upload after a process restart", async () => {
    const fixture = createFixture({ fileDatabase: true });
    const reservation = await fixture.service.beginUpload(fixture.tutorId);
    writeFileSync(reservation.quarantinePath, "restart");
    const prepared = await fixture.service.prepareUpload(reservation, 7);
    const finalPath = path.join(fixture.service.storageRoot, prepared.storageKey);
    expect(existsSync(finalPath)).toBe(true);
    closeDatabase(fixture.db);

    const restartedDb = new Database(fixture.dbPath);
    databases.add(restartedDb);
    restartedDb.pragma("foreign_keys = ON");
    migrate(restartedDb);
    const clean = scanner();
    const restarted = new MaterialFileService({
      db: restartedDb,
      scanner: clean.scanner,
      storageRoot: fixture.service.storageRoot,
      limits: fixture.service.limits,
      now: () => NOW_MS,
      diskFreeBytes: async () => 1_000_000,
    });

    await expect(restarted.recoverInterruptedUploads()).resolves.toMatchObject({
      abandoned: 1,
      failed: 0,
    });
    expect(existsSync(finalPath)).toBe(false);
    expect(restartedDb.prepare(`
      SELECT COUNT(*) AS count FROM material_upload_reservations
    `).get()).toEqual({ count: 0 });
    expect(restartedDb.prepare(`
      SELECT COUNT(*) AS count FROM material_file_gc_queue
    `).get()).toEqual({ count: 0 });
  });

  it("persists failed file deletion and retries it successfully after restart", async () => {
    const fixture = createFixture({
      fileDatabase: true,
      unlinkFileSync: () => { throw new Error("simulated filesystem outage"); },
    });
    const storageKey = "files/orphan";
    const filePath = path.join(fixture.service.storageRoot, storageKey);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "orphan");
    fixture.service.enqueueGarbage(storageKey);

    await expect(fixture.service.cleanupGarbage()).resolves.toEqual({
      deleted: 0,
      failed: 1,
    });
    expect(fixture.db.prepare(`
      SELECT attempts, last_error FROM material_file_gc_queue WHERE storage_key = ?
    `).get(storageKey)).toMatchObject({
      attempts: 1,
      last_error: "simulated filesystem outage",
    });
    closeDatabase(fixture.db);

    const restartedDb = new Database(fixture.dbPath);
    databases.add(restartedDb);
    restartedDb.pragma("foreign_keys = ON");
    migrate(restartedDb);
    const restarted = new MaterialFileService({
      db: restartedDb,
      scanner: scanner().scanner,
      storageRoot: fixture.service.storageRoot,
      limits: fixture.service.limits,
      now: () => NOW_MS,
      diskFreeBytes: async () => 1_000_000,
    });
    await expect(restarted.cleanupGarbage()).resolves.toEqual({
      deleted: 1,
      failed: 0,
    });
    expect(existsSync(filePath)).toBe(false);
    expect(restartedDb.prepare(`
      SELECT COUNT(*) AS count FROM material_file_gc_queue
    `).get()).toEqual({ count: 0 });
  });

  it("scans legacy files on first read and deletes malware without serving it", async () => {
    const fixture = createFixture();
    const storageKey = "files/legacy";
    const filePath = path.join(fixture.service.storageRoot, storageKey);
    writeFileSync(filePath, "legacy");
    const materialId = randomUUID();
    fixture.db.prepare(`
      INSERT INTO materials (
        id, tutor_id, title, kind, storage_key, original_file_name,
        mime_type, file_size, created_at, updated_at
      ) VALUES (?, ?, 'Legacy', 'file', ?, 'legacy.bin',
        'application/octet-stream', 6, ?, ?)
    `).run(materialId, fixture.tutorId, storageKey, NOW, NOW);

    const infected = scanner({ status: "infected", signature: "legacy-malware" });
    const failClosed = new MaterialFileService({
      db: fixture.db,
      scanner: infected.scanner,
      storageRoot: fixture.service.storageRoot,
      limits: fixture.service.limits,
      now: () => NOW_MS,
      diskFreeBytes: async () => 1_000_000,
    });
    await expect(failClosed.ensureScanned(materialRow(fixture.db, materialId)))
      .rejects.toMatchObject({ code: "MALWARE_DETECTED" });
    expect(fixture.db.prepare("SELECT 1 FROM materials WHERE id = ?").get(materialId))
      .toBeUndefined();
    expect(existsSync(filePath)).toBe(false);
  });

  it("deduplicates concurrent first-read scans for the same legacy file", async () => {
    let releaseScan!: (result: MalwareScanResult) => void;
    const scan = vi.fn(async (): Promise<MalwareScanResult> => (
      await new Promise<MalwareScanResult>((resolve) => { releaseScan = resolve; })
    ));
    const fixture = createFixture({
      scanner: { id: "blocking-scanner-v1", scan },
    });
    const row = persistLegacyFile(fixture, "dedupe");

    const first = fixture.service.ensureScanned(row);
    const second = fixture.service.ensureScanned(row);
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    releaseScan({ status: "clean" });

    await expect(Promise.all([first, second])).resolves.toEqual([
      path.join(fixture.service.storageRoot, row.storage_key!),
      path.join(fixture.service.storageRoot, row.storage_key!),
    ]);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(materialRow(fixture.db, row.id).scan_provider).toBe("blocking-scanner-v1");
  });

  it("bounds scanner concurrency and rejects an overflowing scan queue", async () => {
    const releases: Array<(result: MalwareScanResult) => void> = [];
    let active = 0;
    let maximumActive = 0;
    const scan = vi.fn(async (): Promise<MalwareScanResult> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        return await new Promise<MalwareScanResult>((resolve) => releases.push(resolve));
      } finally {
        active -= 1;
      }
    });
    const fixture = createFixture({
      scanner: { id: "bounded-scanner-v1", scan },
      limits: { maxConcurrentScans: 2, maxQueuedScans: 1 },
    });
    const rows = ["a", "b", "c", "d"].map((value) => persistLegacyFile(fixture, value));

    const accepted = rows.slice(0, 3).map((row) => fixture.service.ensureScanned(row));
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
    await expect(fixture.service.ensureScanned(rows[3])).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
    releases.shift()!({ status: "clean" });
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(3));
    for (const release of releases.splice(0)) release({ status: "clean" });
    await expect(Promise.all(accepted)).resolves.toHaveLength(3);
    expect(maximumActive).toBe(2);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlink substituted for a quarantined upload",
    async () => {
      const fixture = createFixture();
      const reservation = await fixture.service.beginUpload(fixture.tutorId);
      const target = path.join(fixture.root, "outside.bin");
      writeFileSync(target, "outside");
      symlinkSync(target, reservation.quarantinePath);

      await expect(fixture.service.prepareUpload(reservation, 7)).rejects
        .toBeInstanceOf(MaterialFileError);
      await fixture.service.abortUpload(reservation.uploadId);
      expect(existsSync(target)).toBe(true);
    },
  );
});
