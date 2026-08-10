import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../db.js";
import {
  GUEST_ROOM_IDLE_TTL_MS,
  GuestRoomService,
} from "../guestRooms.js";
import {
  CODE_BLOB_LIMITS,
  CodeBlobError,
  CodeBlobService,
} from "./service.js";
import {
  MalwareScannerError,
  type MalwareScanResult,
  type MalwareScanner,
} from "./malwareScanner.js";

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function streamBytes(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("guest Code blob service", () => {
  let db: Database.Database;
  let root: string;
  let now: number;
  let rooms: GuestRoomService;
  let service: CodeBlobService;
  let scan: ReturnType<typeof vi.fn<(request: Parameters<MalwareScanner["scan"]>[0]) => Promise<MalwareScanResult>>>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-code-blobs-"));
    now = Date.parse("2026-08-09T08:00:00.000Z");
    rooms = new GuestRoomService(db, () => now);
    scan = vi.fn(async () => ({ status: "clean" } as const));
    service = new CodeBlobService({
      db,
      guestRooms: rooms,
      scanner: { id: "test-clean-scanner-v1", scan },
      storageRoot: root,
      now: () => now,
      minFreeDiskBytes: 0,
    });
  });

  afterEach(() => {
    if (db.open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("publishes a resumable hash-verified blob and accepts exact chunk retries", async () => {
    const room = rooms.create("code");
    const bytes = Buffer.from("binary\0fixture", "utf8");
    const sha256 = digest(bytes);
    const activityBefore = room.lastActivityAt;
    now += 5_000;
    const begun = await service.beginUpload(room.shareKey, {
      sha256,
      byteSize: bytes.byteLength,
      mimeType: "application/octet-stream",
    });
    expect(begun.status).toBe("upload");
    if (begun.status !== "upload") return;
    expect(rooms.lookup(room.shareKey)).toMatchObject({
      status: "active",
      room: { lastActivityAt: activityBefore },
    });

    const chunkSha256 = digest(bytes);
    const first = await service.writeChunk(room.shareKey, {
      uploadId: begun.uploadId,
      offset: 0,
      chunk: bytes,
      chunkSha256,
    });
    expect(first).toEqual({
      nextOffset: bytes.byteLength,
      complete: true,
      duplicate: false,
    });
    await expect(service.writeChunk(room.shareKey, {
      uploadId: begun.uploadId,
      offset: 0,
      chunk: bytes,
      chunkSha256,
    })).resolves.toMatchObject({ duplicate: true });
    expect(rooms.lookup(room.shareKey)).toMatchObject({
      status: "active",
      room: { lastActivityAt: activityBefore },
    });

    now += 5_000;
    scan.mockImplementationOnce(async (request) => {
      expect(request).toMatchObject({ byteSize: bytes.byteLength, sha256 });
      expect(db.prepare("SELECT * FROM code_blobs").all()).toEqual([]);
      return { status: "clean" };
    });
    await expect(service.finalizeUpload(room.shareKey, begun.uploadId))
      .resolves.toEqual({
        status: "ready",
        blob: {
          sha256,
          byteSize: bytes.byteLength,
          mimeType: "application/octet-stream",
        },
      });
    const afterFinalize = rooms.lookup(room.shareKey);
    expect(afterFinalize.status).toBe("active");
    if (afterFinalize.status !== "active") return;
    expect(afterFinalize.room.lastActivityAt).not.toBe(activityBefore);

    now += 5_000;
    const download = await service.download(room.shareKey, sha256);
    expect(download.headers).toMatchObject({
      "Content-Type": "application/octet-stream",
      "X-Eduri-Blob-Mime": "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    await expect(streamBytes(download.stream)).resolves.toEqual(bytes);
    expect((rooms.lookup(room.shareKey) as { room: { lastActivityAt: string } }).room.lastActivityAt)
      .toBe(afterFinalize.room.lastActivityAt);

    await expect(service.beginUpload(room.shareKey, {
      sha256,
      byteSize: bytes.byteLength,
      mimeType: "application/octet-stream",
    })).resolves.toMatchObject({ status: "ready" });
    expect((rooms.lookup(room.shareKey) as { room: { lastActivityAt: string } }).room.lastActivityAt)
      .toBe(afterFinalize.room.lastActivityAt);
  });

  it("rolls publication back when the room expires during a slow malware scan", async () => {
    const room = rooms.create("code");
    const bytes = Buffer.from("slow-scan-expiry");
    const sha256 = digest(bytes);
    const begun = await service.beginUpload(room.shareKey, {
      sha256,
      byteSize: bytes.byteLength,
      mimeType: "application/octet-stream",
    });
    if (begun.status !== "upload") return;
    await service.writeChunk(room.shareKey, {
      uploadId: begun.uploadId,
      offset: 0,
      chunk: bytes,
      chunkSha256: sha256,
    });
    const upload = db.prepare(`
      SELECT staging_key FROM code_blob_uploads WHERE upload_id = ?
    `).get(begun.uploadId) as { staging_key: string };
    db.prepare("UPDATE guest_rooms SET expires_at = ? WHERE id = ?").run(
      new Date(now + 1_000).toISOString(),
      room.id,
    );
    let markScanStarted!: () => void;
    let resolveScan!: (result: MalwareScanResult) => void;
    const scanStarted = new Promise<void>((resolve) => {
      markScanStarted = resolve;
    });
    const scanResult = new Promise<MalwareScanResult>((resolve) => {
      resolveScan = resolve;
    });
    scan.mockImplementationOnce(async () => {
      markScanStarted();
      return await scanResult;
    });
    const recordActivity = vi.spyOn(rooms, "recordResourceMutation");

    const finalize = service.finalizeUpload(room.shareKey, begun.uploadId);
    await scanStarted;
    now += 2_000;
    expect(rooms.cleanupExpired().expiredRoomCount).toBe(1);
    resolveScan({ status: "clean" });
    await expect(finalize).rejects.toMatchObject({ code: "ROOM_EXPIRED" });

    expect(recordActivity).not.toHaveBeenCalled();
    expect(db.prepare("SELECT * FROM code_blobs").all()).toEqual([]);
    expect(db.prepare(`
      SELECT upload_id FROM code_blob_uploads WHERE upload_id = ?
    `).get(begun.uploadId)).toBeUndefined();
    const storageKey = `blobs/${room.resources[0].id}/${sha256}`;
    const finalPath = path.join(root, ...storageKey.split("/"));
    expect(fs.existsSync(finalPath)).toBe(false);
    expect(db.prepare(`
      SELECT storage_key FROM code_blob_gc_queue ORDER BY storage_key
    `).all()).toEqual([
      { storage_key: storageKey },
      { storage_key: upload.staging_key },
    ].sort((left, right) => left.storage_key.localeCompare(right.storage_key)));

    await expect(service.cleanupGarbage()).resolves.toEqual({ deleted: 2, failed: 0 });
    expect(fs.existsSync(finalPath)).toBe(false);
    expect(db.prepare("SELECT * FROM code_blob_gc_queue").all()).toEqual([]);
  });

  it("serializes concurrent consecutive chunks before finalizing", async () => {
    const room = rooms.create("code");
    const chunks = [
      Buffer.from("first-concurrent-chunk"),
      Buffer.from("second-concurrent-chunk"),
      Buffer.from("third-concurrent-chunk"),
    ];
    const bytes = Buffer.concat(chunks);
    const sha256 = digest(bytes);
    const begun = await service.beginUpload(room.shareKey, {
      sha256,
      byteSize: bytes.byteLength,
      mimeType: "application/octet-stream",
    });
    if (begun.status !== "upload") return;

    let offset = 0;
    const writes = chunks.map((chunk) => {
      const chunkOffset = offset;
      offset += chunk.byteLength;
      return service.writeChunk(room.shareKey, {
        uploadId: begun.uploadId,
        offset: chunkOffset,
        chunk,
        chunkSha256: digest(chunk),
      });
    });
    const finalizing = service.finalizeUpload(room.shareKey, begun.uploadId);

    await expect(Promise.all(writes)).resolves.toEqual([
      expect.objectContaining({ nextOffset: chunks[0].byteLength }),
      expect.objectContaining({
        nextOffset: chunks[0].byteLength + chunks[1].byteLength,
      }),
      expect.objectContaining({ nextOffset: bytes.byteLength, complete: true }),
    ]);
    await expect(finalizing).resolves.toMatchObject({
      status: "ready",
      blob: { sha256, byteSize: bytes.byteLength },
    });
    expect(scan).toHaveBeenCalledOnce();

    const download = await service.download(room.shareKey, sha256);
    await expect(streamBytes(download.stream)).resolves.toEqual(bytes);
  });

  it("does not apply a conflicting chunk queued after malware scanning starts", async () => {
    const room = rooms.create("code");
    const bytes = Buffer.from("winner-bytes");
    const conflicting = Buffer.from("loser--bytes");
    const sha256 = digest(bytes);
    const begun = await service.beginUpload(room.shareKey, {
      sha256,
      byteSize: bytes.byteLength,
      mimeType: "application/octet-stream",
    });
    if (begun.status !== "upload") return;
    await service.writeChunk(room.shareKey, {
      uploadId: begun.uploadId,
      offset: 0,
      chunk: bytes,
      chunkSha256: sha256,
    });

    let scanStarted!: () => void;
    const scanning = new Promise<void>((resolve) => {
      scanStarted = resolve;
    });
    let finishScan!: (result: MalwareScanResult) => void;
    scan.mockImplementationOnce(async () => {
      scanStarted();
      return await new Promise<MalwareScanResult>((resolve) => {
        finishScan = resolve;
      });
    });

    const finalizing = service.finalizeUpload(room.shareKey, begun.uploadId);
    await scanning;
    const delayedConflict = service.writeChunk(room.shareKey, {
      uploadId: begun.uploadId,
      offset: 0,
      chunk: conflicting,
      chunkSha256: digest(conflicting),
    });
    finishScan({ status: "clean" });

    await expect(finalizing).resolves.toMatchObject({ status: "ready" });
    await expect(delayedConflict).rejects.toMatchObject({ code: "NOT_FOUND" });
    const download = await service.download(room.shareKey, sha256);
    await expect(streamBytes(download.stream)).resolves.toEqual(bytes);
  });

  it("atomically bounds concurrent upload count and resource reservations", async () => {
    const countRoom = rooms.create("code");
    const countAttempts = await Promise.allSettled(
      Array.from({ length: CODE_BLOB_LIMITS.maxActiveUploads + 1 }, (_, index) => (
        service.beginUpload(countRoom.shareKey, {
          sha256: (index + 1).toString(16).padStart(64, "0"),
          byteSize: 1,
          mimeType: "application/octet-stream",
        })
      )),
    );
    expect(countAttempts.filter((result) => result.status === "fulfilled"))
      .toHaveLength(CODE_BLOB_LIMITS.maxActiveUploads);
    expect(countAttempts.filter((result) => result.status === "rejected"))
      .toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({ code: "QUOTA_EXCEEDED" }),
        }),
      ]);
    expect(db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes
      FROM code_blob_uploads
      WHERE room_resource_id = ?
    `).get(countRoom.resources[0].id)).toEqual({
      count: CODE_BLOB_LIMITS.maxActiveUploads,
      bytes: CODE_BLOB_LIMITS.maxActiveUploads,
    });

    const quotaRoom = rooms.create("code");
    const published = Buffer.of(0x2a);
    const publishedHash = digest(published);
    const seed = await service.beginUpload(quotaRoom.shareKey, {
      sha256: publishedHash,
      byteSize: published.byteLength,
      mimeType: "application/octet-stream",
    });
    if (seed.status !== "upload") return;
    await service.writeChunk(quotaRoom.shareKey, {
      uploadId: seed.uploadId,
      offset: 0,
      chunk: published,
      chunkSha256: publishedHash,
    });
    await service.finalizeUpload(quotaRoom.shareKey, seed.uploadId);

    const quotaAttempts = await Promise.allSettled(
      Array.from({ length: CODE_BLOB_LIMITS.maxActiveUploads }, (_, index) => (
        service.beginUpload(quotaRoom.shareKey, {
          sha256: (index + 1_000).toString(16).padStart(64, "0"),
          byteSize: CODE_BLOB_LIMITS.maxBlobBytes,
          mimeType: "application/octet-stream",
        })
      )),
    );
    expect(quotaAttempts.filter((result) => result.status === "fulfilled"))
      .toHaveLength(CODE_BLOB_LIMITS.maxActiveUploads - 1);
    expect(quotaAttempts.filter((result) => result.status === "rejected"))
      .toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({ code: "QUOTA_EXCEEDED" }),
        }),
      ]);
    const quotaUsage = db.prepare(`
      SELECT
        (SELECT COALESCE(SUM(byte_size), 0) FROM code_blobs
         WHERE room_resource_id = ?) AS ready_bytes,
        (SELECT COALESCE(SUM(byte_size), 0) FROM code_blob_uploads
         WHERE room_resource_id = ?) AS reserved_bytes,
        (SELECT COUNT(*) FROM code_blob_uploads
         WHERE room_resource_id = ?) AS upload_count
    `).get(
      quotaRoom.resources[0].id,
      quotaRoom.resources[0].id,
      quotaRoom.resources[0].id,
    ) as {
      ready_bytes: number;
      reserved_bytes: number;
      upload_count: number;
    };
    expect(quotaUsage.upload_count).toBeLessThanOrEqual(
      CODE_BLOB_LIMITS.maxActiveUploads,
    );
    expect(quotaUsage.ready_bytes + quotaUsage.reserved_bytes)
      .toBeLessThanOrEqual(CODE_BLOB_LIMITS.maxResourceBytes);
    expect(quotaUsage).toEqual({
      ready_bytes: published.byteLength,
      reserved_bytes:
        (CODE_BLOB_LIMITS.maxActiveUploads - 1)
        * CODE_BLOB_LIMITS.maxBlobBytes,
      upload_count: CODE_BLOB_LIMITS.maxActiveUploads - 1,
    });
  });

  it("persists one aggregate byte quota across distinct guest Code resources", async () => {
    const roomsAtQuota = Array.from({ length: 4 }, () => rooms.create("code"));
    for (const [roomIndex, room] of roomsAtQuota.entries()) {
      const attempts = await Promise.all(
        Array.from({ length: CODE_BLOB_LIMITS.maxActiveUploads }, (_, index) => (
          service.beginUpload(room.shareKey, {
            sha256: (roomIndex * 1_000 + index + 1).toString(16).padStart(64, "0"),
            byteSize: CODE_BLOB_LIMITS.maxBlobBytes,
            mimeType: "application/octet-stream",
          })
        )),
      );
      expect(attempts).toHaveLength(CODE_BLOB_LIMITS.maxActiveUploads);
      expect(attempts.every((result) => result.status === "upload")).toBe(true);
    }
    expect(db.prepare(`
      SELECT COALESCE(SUM(byte_size), 0) AS reserved_bytes
      FROM code_blob_uploads
    `).get()).toEqual({ reserved_bytes: CODE_BLOB_LIMITS.maxGlobalBytes });

    const restarted = new CodeBlobService({
      db,
      guestRooms: rooms,
      scanner: { id: "test-clean-scanner-v1", scan },
      storageRoot: root,
      now: () => now,
      minFreeDiskBytes: 0,
    });
    const nextRoom = rooms.create("code");
    await expect(restarted.beginUpload(nextRoom.shareKey, {
      sha256: "f".repeat(64),
      byteSize: 1,
      mimeType: "application/octet-stream",
    })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", retryable: false });
  });

  it("caps durable metadata rows independently of blob byte size", async () => {
    const room = rooms.create("code");
    const resourceId = room.resources[0].id;
    const insert = db.prepare(`
      INSERT INTO code_blobs (
        room_resource_id, sha256, byte_size, mime_type, storage_key,
        created_at, scan_provider, scanned_at
      ) VALUES (?, ?, 1, 'application/octet-stream', ?, ?, 'seed-scan', ?)
    `);
    const timestamp = new Date(now).toISOString();
    db.transaction(() => {
      for (let index = 1; index <= CODE_BLOB_LIMITS.maxResourceRecords; index += 1) {
        const hash = index.toString(16).padStart(64, "0");
        insert.run(resourceId, hash, `blobs/${resourceId}/${hash}`, timestamp, timestamp);
      }
    }).immediate();

    const restarted = new CodeBlobService({
      db,
      guestRooms: rooms,
      scanner: { id: "test-clean-scanner-v1", scan },
      storageRoot: root,
      now: () => now,
      minFreeDiskBytes: 0,
    });
    await expect(restarted.beginUpload(room.shareKey, {
      sha256: "f".repeat(64),
      byteSize: 1,
      mimeType: "application/octet-stream",
    })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", retryable: false });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM code_blobs WHERE room_resource_id = ?
    `).get(resourceId)).toEqual({ count: CODE_BLOB_LIMITS.maxResourceRecords });
  });

  it("never publishes a blob rejected by malware scanning", async () => {
    const room = rooms.create("code");
    const bytes = Buffer.from("malware-fixture");
    const sha256 = digest(bytes);
    const begun = await service.beginUpload(room.shareKey, {
      sha256,
      byteSize: bytes.byteLength,
      mimeType: "application/octet-stream",
    });
    if (begun.status !== "upload") return;
    await service.writeChunk(room.shareKey, {
      uploadId: begun.uploadId,
      offset: 0,
      chunk: bytes,
      chunkSha256: sha256,
    });
    scan.mockResolvedValueOnce({
      status: "infected",
      signature: "Unit.Test.Signature",
    });

    await expect(service.finalizeUpload(room.shareKey, begun.uploadId))
      .rejects.toMatchObject({ code: "MALWARE_DETECTED", retryable: false });
    expect(db.prepare("SELECT * FROM code_blobs").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM code_blob_uploads").all()).toEqual([]);
    await expect(service.status(room.shareKey, sha256)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(fs.readdirSync(root, { recursive: true })
      .filter((entry) => String(entry).endsWith(".part"))).toEqual([]);
  });

  it("fails closed on scanner outage and permits a later exact finalize retry", async () => {
    const room = rooms.create("code");
    const bytes = Buffer.from("retry-after-scanner-outage");
    const sha256 = digest(bytes);
    const begun = await service.beginUpload(room.shareKey, {
      sha256,
      byteSize: bytes.byteLength,
      mimeType: "application/octet-stream",
    });
    if (begun.status !== "upload") return;
    await service.writeChunk(room.shareKey, {
      uploadId: begun.uploadId,
      offset: 0,
      chunk: bytes,
      chunkSha256: sha256,
    });
    scan.mockRejectedValueOnce(new MalwareScannerError(
      "UNAVAILABLE",
      "test scanner is offline",
    ));

    await expect(service.finalizeUpload(room.shareKey, begun.uploadId))
      .rejects.toMatchObject({
        code: "MALWARE_SCAN_UNAVAILABLE",
        retryable: true,
      });
    expect(db.prepare("SELECT * FROM code_blobs").all()).toEqual([]);
    expect(db.prepare("SELECT upload_id FROM code_blob_uploads").all())
      .toEqual([{ upload_id: begun.uploadId }]);

    await expect(service.finalizeUpload(room.shareKey, begun.uploadId))
      .resolves.toMatchObject({ status: "ready" });
  });

  it("shares one malware decision across concurrent finalize retries", async () => {
    const room = rooms.create("code");
    const bytes = Buffer.from("concurrent-finalize");
    const sha256 = digest(bytes);
    const begun = await service.beginUpload(room.shareKey, {
      sha256,
      byteSize: bytes.byteLength,
      mimeType: "application/octet-stream",
    });
    if (begun.status !== "upload") return;
    await service.writeChunk(room.shareKey, {
      uploadId: begun.uploadId,
      offset: 0,
      chunk: bytes,
      chunkSha256: sha256,
    });
    let finishScan!: (result: MalwareScanResult) => void;
    scan.mockImplementationOnce(async () => await new Promise<MalwareScanResult>((resolve) => {
      finishScan = resolve;
    }));

    const first = service.finalizeUpload(room.shareKey, begun.uploadId);
    const second = service.finalizeUpload(room.shareKey, begun.uploadId);
    await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
    finishScan({ status: "clean" });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "ready" }),
      expect.objectContaining({ status: "ready" }),
    ]);
    expect(scan).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT COUNT(*) AS count FROM code_blobs").get())
      .toEqual({ count: 1 });
  });

  it("bounds global malware finalization concurrency and rejects an overflowing queue", async () => {
    const room = rooms.create("code");
    const uploads: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const bytes = Buffer.from(`bounded-finalization-${index}`);
      const sha256 = digest(bytes);
      const begun = await service.beginUpload(room.shareKey, {
        sha256,
        byteSize: bytes.byteLength,
        mimeType: "application/octet-stream",
      });
      expect(begun.status).toBe("upload");
      if (begun.status !== "upload") return;
      await service.writeChunk(room.shareKey, {
        uploadId: begun.uploadId,
        offset: 0,
        chunk: bytes,
        chunkSha256: sha256,
      });
      uploads.push(begun.uploadId);
    }

    let releaseScans!: () => void;
    const scanGate = new Promise<void>((resolve) => {
      releaseScans = resolve;
    });
    let activeScans = 0;
    let maximumActiveScans = 0;
    scan.mockImplementation(async () => {
      activeScans += 1;
      maximumActiveScans = Math.max(maximumActiveScans, activeScans);
      try {
        await scanGate;
        return { status: "clean" } as const;
      } finally {
        activeScans -= 1;
      }
    });

    const accepted = uploads.slice(0, 10).map((uploadId) => (
      service.finalizeUpload(room.shareKey, uploadId)
    ));
    const overflow = expect(service.finalizeUpload(room.shareKey, uploads[10]!))
      .rejects.toMatchObject({
        code: "STORAGE_ERROR",
        retryable: true,
        message: "Code blob finalization queue is saturated",
      });

    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
    await overflow;
    expect(maximumActiveScans).toBe(CODE_BLOB_LIMITS.maxConcurrentFinalizations);
    releaseScans();
    await expect(Promise.all(accepted)).resolves.toHaveLength(10);
    expect(scan).toHaveBeenCalledTimes(10);
    expect(maximumActiveScans).toBe(CODE_BLOB_LIMITS.maxConcurrentFinalizations);
  });

  it("scans and attests a pre-v14 blob before exposing its dedup status", async () => {
    db.close();
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, { targetVersion: 11 });
    const roomId = randomUUID();
    const resourceId = randomUUID();
    const shareKey = "l".repeat(43);
    const bytes = Buffer.from("legacy-unverified-blob");
    const sha256 = digest(bytes);
    db.prepare(`
      INSERT INTO guest_rooms (
        id, share_key, created_at, updated_at, last_activity_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      roomId,
      shareKey,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      new Date(now + GUEST_ROOM_IDLE_TTL_MS).toISOString(),
    );
    db.prepare(`
      INSERT INTO guest_room_resources (
        id, room_id, kind, ordinal, resource_key, created_at, last_activity_at
      ) VALUES (?, ?, 'code', 1, ?, ?, ?)
    `).run(
      resourceId,
      roomId,
      "r".repeat(32),
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    );
    const storageKey = `blobs/${resourceId}/${sha256}`;
    const storedPath = path.join(root, ...storageKey.split("/"));
    fs.mkdirSync(path.dirname(storedPath), { recursive: true });
    fs.writeFileSync(storedPath, bytes);
    db.prepare(`
      INSERT INTO code_blobs (
        room_resource_id, sha256, byte_size, mime_type, storage_key, created_at
      ) VALUES (?, ?, ?, 'application/octet-stream', ?, ?)
    `).run(resourceId, sha256, bytes.byteLength, storageKey, new Date(now).toISOString());
    migrate(db);
    rooms = new GuestRoomService(db, () => now);
    let finishScan!: (result: MalwareScanResult) => void;
    scan = vi.fn(async () => await new Promise<MalwareScanResult>((resolve) => {
      finishScan = resolve;
    }));
    service = new CodeBlobService({
      db,
      guestRooms: rooms,
      scanner: { id: "test-clean-scanner-v1", scan },
      storageRoot: root,
      now: () => now,
      minFreeDiskBytes: 0,
    });

    const status = service.status(shareKey, sha256);
    const dedup = service.beginUpload(shareKey, {
      sha256,
      byteSize: bytes.byteLength,
      mimeType: "application/octet-stream",
    });
    await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
    finishScan({ status: "clean" });
    await expect(Promise.all([status, dedup])).resolves.toEqual([
      expect.objectContaining({ status: "ready" }),
      expect.objectContaining({ status: "ready" }),
    ]);
    expect(scan).toHaveBeenCalledOnce();
    expect(db.prepare(`
      SELECT scan_provider, scanned_at FROM code_blobs
      WHERE room_resource_id = ? AND sha256 = ?
    `).get(resourceId, sha256)).toEqual({
      scan_provider: "test-clean-scanner-v1",
      scanned_at: new Date(now).toISOString(),
    });
    await expect(service.beginUpload(shareKey, {
      sha256,
      byteSize: bytes.byteLength,
      mimeType: "application/octet-stream",
    })).resolves.toMatchObject({ status: "ready" });
    expect(scan).toHaveBeenCalledOnce();
  });

  it("isolates blobs by the server-derived Code resource capability", async () => {
    const left = rooms.create("code");
    const right = rooms.create("code");
    const bytes = Buffer.from("private-room-data");
    const sha256 = digest(bytes);
    const begun = await service.beginUpload(left.shareKey, {
      sha256,
      byteSize: bytes.byteLength,
      mimeType: "application/octet-stream",
    });
    if (begun.status !== "upload") return;
    await service.writeChunk(left.shareKey, {
      uploadId: begun.uploadId,
      offset: 0,
      chunk: bytes,
      chunkSha256: sha256,
    });
    await service.finalizeUpload(left.shareKey, begun.uploadId);

    await expect(service.status(right.shareKey, sha256)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(service.download(right.shareKey, sha256)).rejects
      .toBeInstanceOf(CodeBlobError);
  });

  it("durably queues and physically removes published files after room expiry", async () => {
    const room = rooms.create("code");
    const bytes = Buffer.from("expiring-data");
    const sha256 = digest(bytes);
    const begun = await service.beginUpload(room.shareKey, {
      sha256,
      byteSize: bytes.byteLength,
      mimeType: "application/octet-stream",
    });
    if (begun.status !== "upload") return;
    await service.writeChunk(room.shareKey, {
      uploadId: begun.uploadId,
      offset: 0,
      chunk: bytes,
      chunkSha256: sha256,
    });
    await service.finalizeUpload(room.shareKey, begun.uploadId);
    await service.cleanupGarbage();
    const stored = db.prepare(`
      SELECT storage_key FROM code_blobs WHERE sha256 = ?
    `).get(sha256) as { storage_key: string };
    const filePath = path.join(root, ...stored.storage_key.split("/"));
    expect(fs.existsSync(filePath)).toBe(true);

    now += GUEST_ROOM_IDLE_TTL_MS + 1;
    expect(rooms.cleanupExpired().expiredRoomCount).toBe(1);
    expect(db.prepare("SELECT * FROM code_blobs").all()).toEqual([]);
    expect(db.prepare("SELECT storage_key FROM code_blob_gc_queue").all())
      .toContainEqual({ storage_key: stored.storage_key });
    expect(fs.existsSync(filePath)).toBe(true);

    await expect(service.cleanupGarbage()).resolves.toMatchObject({
      deleted: expect.any(Number),
      failed: 0,
    });
    expect(fs.existsSync(filePath)).toBe(false);
    expect(db.prepare("SELECT * FROM code_blob_gc_queue").all()).toEqual([]);
  });

  it("cleans a crash-reserved upload whose staging file is missing after restart", async () => {
    const room = rooms.create("code");
    const bytes = Buffer.from("missing-staging-restart");
    const begun = await service.beginUpload(room.shareKey, {
      sha256: digest(bytes),
      byteSize: bytes.byteLength,
      mimeType: "application/octet-stream",
    });
    if (begun.status !== "upload") return;
    const upload = db.prepare(`
      SELECT staging_key FROM code_blob_uploads WHERE upload_id = ?
    `).get(begun.uploadId) as { staging_key: string };
    const stagingPath = path.join(root, ...upload.staging_key.split("/"));
    fs.unlinkSync(stagingPath);

    const restarted = new CodeBlobService({
      db,
      guestRooms: rooms,
      scanner: { id: "test-clean-scanner-v1", scan },
      storageRoot: root,
      now: () => now,
      minFreeDiskBytes: 0,
    });
    await expect(restarted.cleanupExpiredUploads()).resolves.toBe(1);
    expect(db.prepare(`
      SELECT upload_id FROM code_blob_uploads WHERE upload_id = ?
    `).get(begun.uploadId)).toBeUndefined();
    expect(db.prepare("SELECT * FROM code_blob_gc_queue").all()).toEqual([]);
    expect(fs.existsSync(stagingPath)).toBe(false);
  });

  it("never leaves an untracked part when staging reservation commit fails", async () => {
    const room = rooms.create("code");
    const bytes = Buffer.from("tracked-staging-intent");
    db.exec(`
      CREATE TRIGGER reject_code_staging_intent_release
      BEFORE DELETE ON code_blob_gc_queue
      WHEN OLD.storage_key LIKE 'staging/%'
      BEGIN SELECT RAISE(ABORT, 'injected intent release failure'); END;
    `);
    await expect(service.beginUpload(room.shareKey, {
      sha256: digest(bytes),
      byteSize: bytes.byteLength,
      mimeType: "application/octet-stream",
    })).rejects.toMatchObject({ code: "STORAGE_ERROR", retryable: true });
    expect(db.prepare("SELECT * FROM code_blob_uploads").all()).toEqual([]);
    const intent = db.prepare(`
      SELECT storage_key FROM code_blob_gc_queue
      WHERE storage_key LIKE 'staging/%'
    `).get() as { storage_key: string };
    const stagingPath = path.join(root, ...intent.storage_key.split("/"));
    expect(fs.existsSync(stagingPath)).toBe(true);

    db.exec("DROP TRIGGER reject_code_staging_intent_release");
    const restarted = new CodeBlobService({
      db,
      guestRooms: rooms,
      scanner: { id: "test-clean-scanner-v1", scan },
      storageRoot: root,
      now: () => now,
      minFreeDiskBytes: 0,
    });
    await expect(restarted.cleanupGarbage()).resolves.toEqual({
      deleted: 1,
      failed: 0,
    });
    expect(fs.existsSync(stagingPath)).toBe(false);
    expect(db.prepare("SELECT * FROM code_blob_gc_queue").all()).toEqual([]);
  });

  it("keeps a queued final copy until its active upload publishes it", async () => {
    const room = rooms.create("code");
    const bytes = Buffer.from("gc-finalize-arbitration");
    const sha256 = digest(bytes);
    const begun = await service.beginUpload(room.shareKey, {
      sha256,
      byteSize: bytes.byteLength,
      mimeType: "application/octet-stream",
    });
    if (begun.status !== "upload") return;
    await service.writeChunk(room.shareKey, {
      uploadId: begun.uploadId,
      offset: 0,
      chunk: bytes,
      chunkSha256: sha256,
    });

    const upload = db.prepare(`
      SELECT staging_key FROM code_blob_uploads WHERE upload_id = ?
    `).get(begun.uploadId) as { staging_key: string };
    const storageKey = `blobs/${room.resources[0].id}/${sha256}`;
    const stagingPath = path.join(root, ...upload.staging_key.split("/"));
    const finalPath = path.join(root, ...storageKey.split("/"));
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.linkSync(stagingPath, finalPath);
    db.prepare(`
      INSERT INTO code_blob_gc_queue (storage_key, enqueued_at)
      VALUES (?, ?)
    `).run(storageKey, new Date(now - 1_000).toISOString());

    await expect(service.cleanupGarbage(1)).resolves.toEqual({
      deleted: 0,
      failed: 0,
    });
    expect(fs.existsSync(finalPath)).toBe(true);
    expect(db.prepare(`
      SELECT attempts FROM code_blob_gc_queue WHERE storage_key = ?
    `).get(storageKey)).toEqual({ attempts: 1 });

    await expect(service.finalizeUpload(room.shareKey, begun.uploadId))
      .resolves.toMatchObject({ status: "ready" });
    expect(db.prepare(`
      SELECT storage_key FROM code_blob_gc_queue WHERE storage_key = ?
    `).get(storageKey)).toBeUndefined();
    const download = await service.download(room.shareKey, sha256);
    await expect(streamBytes(download.stream)).resolves.toEqual(bytes);
  });

  it("recovers the final copy after a database publish failure", async () => {
    const room = rooms.create("code");
    const bytes = Buffer.from("publish-recovery-copy");
    const sha256 = digest(bytes);
    const begun = await service.beginUpload(room.shareKey, {
      sha256,
      byteSize: bytes.byteLength,
      mimeType: "application/octet-stream",
    });
    if (begun.status !== "upload") return;
    await service.writeChunk(room.shareKey, {
      uploadId: begun.uploadId,
      offset: 0,
      chunk: bytes,
      chunkSha256: sha256,
    });
    const upload = db.prepare(`
      SELECT staging_key FROM code_blob_uploads WHERE upload_id = ?
    `).get(begun.uploadId) as { staging_key: string };
    const storageKey = `blobs/${room.resources[0].id}/${sha256}`;
    const stagingPath = path.join(root, ...upload.staging_key.split("/"));
    const finalPath = path.join(root, ...storageKey.split("/"));
    db.exec(`
      CREATE TRIGGER reject_test_code_blob_publish
      BEFORE INSERT ON code_blobs
      BEGIN SELECT RAISE(ABORT, 'test publish failure'); END;
    `);

    await expect(service.finalizeUpload(room.shareKey, begun.uploadId))
      .rejects.toMatchObject({ code: "STORAGE_ERROR", retryable: true });
    expect(fs.existsSync(stagingPath)).toBe(true);
    expect(fs.existsSync(finalPath)).toBe(true);
    expect(db.prepare(`
      SELECT storage_key FROM code_blob_gc_queue WHERE storage_key = ?
    `).get(storageKey)).toEqual({ storage_key: storageKey });

    fs.unlinkSync(stagingPath);
    await expect(service.beginUpload(room.shareKey, {
      sha256,
      byteSize: bytes.byteLength,
      mimeType: "application/octet-stream",
    })).resolves.toMatchObject({
      status: "upload",
      uploadId: begun.uploadId,
      nextOffset: bytes.byteLength,
    });
    await expect(service.cleanupGarbage(1)).resolves.toEqual({
      deleted: 0,
      failed: 0,
    });
    expect(fs.existsSync(finalPath)).toBe(true);

    db.exec("DROP TRIGGER reject_test_code_blob_publish");
    await expect(service.finalizeUpload(room.shareKey, begun.uploadId))
      .resolves.toMatchObject({ status: "ready" });
    const download = await service.download(room.shareKey, sha256);
    await expect(streamBytes(download.stream)).resolves.toEqual(bytes);
  });

  it("does not let a persistent garbage failure starve newer entries", async () => {
    const blockedKey = "../permanent-gc-failure";
    const removableKey = "blobs/removable-orphan";
    const removablePath = path.join(root, ...removableKey.split("/"));
    fs.mkdirSync(path.dirname(removablePath), { recursive: true });
    fs.writeFileSync(removablePath, "orphan");
    db.prepare(`
      INSERT INTO code_blob_gc_queue (storage_key, enqueued_at)
      VALUES (?, ?), (?, ?)
    `).run(
      blockedKey,
      new Date(now - 2_000).toISOString(),
      removableKey,
      new Date(now - 1_000).toISOString(),
    );

    await expect(service.cleanupGarbage(1)).resolves.toEqual({
      deleted: 0,
      failed: 1,
    });
    await expect(service.cleanupGarbage(1)).resolves.toEqual({
      deleted: 1,
      failed: 0,
    });
    expect(fs.existsSync(removablePath)).toBe(false);
    expect(db.prepare(`
      SELECT attempts FROM code_blob_gc_queue WHERE storage_key = ?
    `).get(blockedKey)).toEqual({ attempts: 1 });
  });

  it("coalesces overlapping garbage passes for the same queue entry", async () => {
    const storageKey = "blobs/overlapping-gc-orphan";
    const filePath = path.join(root, ...storageKey.split("/"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "orphan");
    db.prepare(`
      INSERT INTO code_blob_gc_queue (storage_key, enqueued_at)
      VALUES (?, ?)
    `).run(storageKey, new Date(now).toISOString());

    const [first, second] = await Promise.all([
      service.cleanupGarbage(1),
      service.cleanupGarbage(1),
    ]);
    expect(first.deleted + second.deleted).toBe(1);
    expect(first.failed + second.failed).toBe(0);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(db.prepare("SELECT * FROM code_blob_gc_queue").all()).toEqual([]);
  });
});
