import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../db.js";
import {
  AssetServiceError,
  BoardAssetService,
  type AssetDecodeProbe,
  type AssetReadyEvent,
  type BeginAssetUploadResult,
  type DecodedAssetInfo,
} from "./assets.js";
import { installBoardAssetSchema } from "./assetsSchema.js";
import { BoardRepository, type BoardRecord } from "./repository.js";

interface Principal {
  tenantId: string;
  actorId: string;
}

interface BoardFixture {
  board: BoardRecord;
  tutorId: string;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function pngFixture(width = 4, height = 3, byteSize = 48): Uint8Array {
  const output = Buffer.alloc(Math.max(byteSize, 24));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(output);
  output.writeUInt32BE(13, 8);
  output.write("IHDR", 12, "ascii");
  output.writeUInt32BE(width, 16);
  output.writeUInt32BE(height, 20);
  for (let index = 24; index < output.byteLength; index += 1) output[index] = index & 0xff;
  return output;
}

function insertBoard(db: Database.Database, existingTutorId?: string): BoardFixture {
  const tutorId = existingTutorId ?? randomUUID();
  const studentId = randomUUID();
  const lessonId = randomUUID();
  const now = "2026-07-28T00:00:00.000Z";
  if (!existingTutorId) {
    db.prepare(`
      INSERT INTO users (
        id, role, status, display_name, login_name, login_name_normalized,
        created_at, updated_at
      ) VALUES (?, 'tutor', 'active', 'Tutor', ?, ?, ?, ?)
    `).run(tutorId, `tutor-${tutorId}`, `tutor-${tutorId}`, now, now);
  }
  db.prepare(`
    INSERT INTO users (
      id, role, status, display_name, tutor_id, created_at, updated_at
    ) VALUES (?, 'student', 'active', 'Student', ?, ?, ?)
  `).run(studentId, tutorId, now, now);
  db.prepare(`
    INSERT INTO lessons (
      id, tutor_id, student_id, title, meeting_key, scheduled_at,
      duration_minutes, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'Asset test', ?, ?, 60, 'scheduled', ?, ?)
  `).run(lessonId, tutorId, studentId, `meeting-${randomUUID()}`, now, now, now);
  const board = new BoardRepository(db).createBoardForLesson(lessonId, { engine: "v2" });
  return { board, tutorId };
}

function requireUpload(result: BeginAssetUploadResult) {
  if (result.status !== "upload") throw new Error("expected an upload session");
  return result;
}

async function uploadChunks(
  service: BoardAssetService<Principal>,
  principal: Principal,
  board: BoardRecord,
  assetId: string,
  upload: Extract<BeginAssetUploadResult, { status: "upload" }>,
  value: Uint8Array,
): Promise<void> {
  let offset = upload.nextOffset;
  while (offset < value.byteLength) {
    const chunk = value.slice(offset, Math.min(value.byteLength, offset + upload.chunkBytes));
    const result = await service.writeChunk(principal, {
      boardId: board.id,
      generation: board.generation,
      assetId,
      uploadId: upload.uploadId,
      offset,
      chunk,
      chunkSha256: sha256(chunk),
    });
    offset = result.nextOffset;
  }
}

describe("BoardAssetService", () => {
  let db: Database.Database;
  let dataDir: string;
  let privateRoot: string;
  let publicRoot: string;
  let primary: BoardFixture;
  let boardTenants: Map<string, string>;
  let events: AssetReadyEvent[];
  let operations: string[];
  let decode: AssetDecodeProbe;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-assets-"));
    privateRoot = path.join(dataDir, "private-board-assets");
    publicRoot = path.join(dataDir, "public");
    fs.mkdirSync(publicRoot);
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    installBoardAssetSchema(db);
    primary = insertBoard(db);
    boardTenants = new Map([[primary.board.id, primary.tutorId]]);
    events = [];
    operations = [];
    decode = vi.fn(async (request) => ({
      fullyDecoded: true as const,
      width: request.encodedWidth,
      height: request.encodedHeight,
      frameCount: 1,
      totalDecodedPixels: request.encodedWidth * request.encodedHeight,
    }));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function service(overrides: {
    decode?: AssetDecodeProbe;
    freeDiskBytes?: number;
    limits?: ConstructorParameters<typeof BoardAssetService<Principal>>[0]["limits"];
    now?: () => Date;
    assertPublicationActive?: () => void;
    commitActivity?: () => void;
    tenantSoftQuotaBytes?: number;
    aggregateQuota?: {
      tenantIdPrefix: string;
      softQuotaBytes: number;
    };
  } = {}) {
    return new BoardAssetService<Principal>({
      db,
      privateStorageRoot: privateRoot,
      forbiddenPublicRoots: [publicRoot],
      authorize: async (principal, request) => {
        operations.push(request.operation);
        if (boardTenants.get(request.boardId) !== principal.tenantId) {
          throw new AssetServiceError("NOT_FOUND", "board is not available");
        }
        return {
          tenantId: principal.tenantId,
          actorId: principal.actorId,
          tenantSoftQuotaBytes: overrides.tenantSoftQuotaBytes,
          aggregateQuota: overrides.aggregateQuota,
          assertPublicationActive: overrides.assertPublicationActive,
          commitActivity: overrides.commitActivity,
        };
      },
      decode: overrides.decode ?? decode,
      capacityProbe: {
        freeDiskBytes: async () => overrides.freeDiskBytes ?? 1024 ** 4,
      },
      onEvent: async (event) => {
        events.push(event);
      },
      now: overrides.now,
      limits: {
        maxChunkBytes: 16,
        defaultChunkBytes: 16,
        maxAssetBytes: 1024,
        minFreeDiskBytes: 128,
        tenantSoftQuotaBytes: 4096,
        ...overrides.limits,
      },
    });
  }

  it("rejects expired durable uploads and queues their private staging files", async () => {
    let clock = new Date("2026-07-28T00:00:00.000Z");
    const value = pngFixture();
    const assetId = randomUUID();
    const principal = {
      tenantId: primary.tutorId,
      actorId: primary.tutorId,
    };
    const assets = service({
      now: () => clock,
      limits: { uploadTtlMs: 1_000 },
    });
    const started = requireUpload(await assets.beginUpload(principal, {
      boardId: primary.board.id,
      generation: primary.board.generation,
      assetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    }));
    const upload = db.prepare(`
      SELECT staging_key FROM board_asset_uploads WHERE upload_id = ?
    `).get(started.uploadId) as { staging_key: string };
    const stagingPath = path.join(privateRoot, upload.staging_key);
    expect(fs.existsSync(stagingPath)).toBe(true);

    clock = new Date("2026-07-28T00:00:02.000Z");
    await expect(assets.cleanupExpiredUploads()).resolves.toBe(1);
    expect(fs.existsSync(stagingPath)).toBe(true);
    expect(db.prepare(`
      SELECT status, failure_code
      FROM board_asset_uploads WHERE upload_id = ?
    `).get(started.uploadId)).toEqual({
      status: "rejected",
      failure_code: "UPLOAD_EXPIRED",
    });
    expect(db.prepare(`
      SELECT storage_key FROM board_asset_gc_queue WHERE storage_key = ?
    `).get(upload.staging_key)).toEqual({ storage_key: upload.staging_key });
    await expect(assets.cleanupGarbage()).resolves.toMatchObject({ failed: 0 });
    expect(fs.existsSync(stagingPath)).toBe(false);
    await expect(assets.cleanupExpiredUploads()).resolves.toBe(0);
  });

  it("retries failed staging cleanup for completed, expired, and rejected uploads", async () => {
    let clock = new Date("2026-07-28T00:00:00.000Z");
    const principal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    const assets = service({
      now: () => clock,
      limits: { uploadTtlMs: 1_000 },
    });
    const assertRestartRetry = async (stagingKey: string): Promise<void> => {
      const stagingPath = path.join(privateRoot, ...stagingKey.split("/"));
      fs.unlinkSync(stagingPath);
      fs.mkdirSync(stagingPath);
      await expect(assets.cleanupGarbage()).resolves.toEqual({
        deleted: 0,
        failed: 1,
      });
      expect(db.prepare(`
        SELECT attempts FROM board_asset_gc_queue WHERE storage_key = ?
      `).get(stagingKey)).toEqual({ attempts: 1 });
      fs.rmSync(stagingPath, { recursive: true, force: true });
      const restarted = service({ now: () => clock });
      await expect(restarted.cleanupGarbage()).resolves.toEqual({
        deleted: 1,
        failed: 0,
      });
      expect(db.prepare(`
        SELECT storage_key FROM board_asset_gc_queue WHERE storage_key = ?
      `).get(stagingKey)).toBeUndefined();
    };

    const completedValue = pngFixture();
    const completedAssetId = randomUUID();
    const completed = requireUpload(await assets.beginUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId: completedAssetId,
      sha256: sha256(completedValue),
      byteSize: completedValue.byteLength,
      declaredMime: "image/png",
    }));
    await uploadChunks(
      assets,
      principal,
      primary.board,
      completedAssetId,
      completed,
      completedValue,
    );
    await assets.finalizeUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId: completedAssetId,
      uploadId: completed.uploadId,
    });
    const completedKey = (db.prepare(`
      SELECT staging_key FROM board_asset_uploads WHERE upload_id = ?
    `).get(completed.uploadId) as { staging_key: string }).staging_key;
    await assertRestartRetry(completedKey);

    const expiredValue = pngFixture(5, 3);
    const expiredAssetId = randomUUID();
    const expired = requireUpload(await assets.beginUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId: expiredAssetId,
      sha256: sha256(expiredValue),
      byteSize: expiredValue.byteLength,
      declaredMime: "image/png",
    }));
    const expiredKey = (db.prepare(`
      SELECT staging_key FROM board_asset_uploads WHERE upload_id = ?
    `).get(expired.uploadId) as { staging_key: string }).staging_key;
    clock = new Date("2026-07-28T00:00:02.000Z");
    await expect(assets.cleanupExpiredUploads()).resolves.toBe(1);
    await assertRestartRetry(expiredKey);

    const rejectedValue = Buffer.from("not-an-image");
    const rejectedAssetId = randomUUID();
    const rejected = requireUpload(await assets.beginUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId: rejectedAssetId,
      sha256: sha256(rejectedValue),
      byteSize: rejectedValue.byteLength,
      declaredMime: "image/png",
    }));
    await uploadChunks(
      assets,
      principal,
      primary.board,
      rejectedAssetId,
      rejected,
      rejectedValue,
    );
    await expect(assets.finalizeUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId: rejectedAssetId,
      uploadId: rejected.uploadId,
    })).rejects.toMatchObject({ code: expect.any(String) });
    const rejectedKey = (db.prepare(`
      SELECT staging_key FROM board_asset_uploads WHERE upload_id = ?
    `).get(rejected.uploadId) as { staging_key: string }).staging_key;
    await assertRestartRetry(rejectedKey);
  });

  it("resumes durable chunks after restart, accepts retry, then atomically publishes", async () => {
    const value = pngFixture();
    const assetId = randomUUID();
    const principal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    const firstService = service();
    const started = requireUpload(await firstService.beginUpload(principal, {
      boardId: primary.board.id,
      generation: primary.board.generation,
      assetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
      originalFileName: "diagram.png",
    }));
    const firstChunk = value.slice(0, started.chunkBytes);
    await firstService.writeChunk(principal, {
      boardId: primary.board.id,
      generation: primary.board.generation,
      assetId,
      uploadId: started.uploadId,
      offset: 0,
      chunk: firstChunk,
      chunkSha256: sha256(firstChunk),
    });

    const restartedService = service();
    const resumed = requireUpload(await restartedService.beginUpload(principal, {
      boardId: primary.board.id,
      generation: primary.board.generation,
      assetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
      originalFileName: "diagram.png",
    }));
    expect(resumed).toMatchObject({ uploadId: started.uploadId, nextOffset: firstChunk.byteLength });
    await expect(restartedService.writeChunk(principal, {
      boardId: primary.board.id,
      generation: primary.board.generation,
      assetId,
      uploadId: resumed.uploadId,
      offset: 0,
      chunk: firstChunk,
      chunkSha256: sha256(firstChunk),
    })).resolves.toMatchObject({ duplicate: true, nextOffset: firstChunk.byteLength });
    await uploadChunks(restartedService, principal, primary.board, assetId, resumed, value);

    const ready = await restartedService.finalizeUpload(principal, {
      boardId: primary.board.id,
      generation: primary.board.generation,
      assetId,
      uploadId: resumed.uploadId,
    });
    expect(ready).toMatchObject({
      created: true,
      asset: {
        status: "ready",
        assetId,
        sha256: sha256(value),
        mimeType: "image/png",
        width: 4,
        height: 3,
      },
    });
    expect(decode).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
    expect(await restartedService.getStatus(principal, {
      boardId: primary.board.id,
      generation: primary.board.generation,
      assetId,
    })).toEqual(ready.asset);

    const blob = db.prepare(`
      SELECT storage_key FROM board_asset_blobs WHERE tenant_id = ? AND sha256 = ?
    `).get(primary.tutorId, sha256(value)) as { storage_key: string };
    const blobPath = path.resolve(privateRoot, ...blob.storage_key.split("/"));
    expect(blobPath.startsWith(path.resolve(publicRoot))).toBe(false);
    expect(fs.readFileSync(blobPath)).toEqual(Buffer.from(value));
    expect(db.prepare("SELECT COUNT(*) AS count FROM board_assets").get()).toEqual({ count: 1 });
  });

  it("serializes concurrent consecutive chunks before finalizing", async () => {
    const value = pngFixture();
    const assetId = randomUUID();
    const principal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    const currentService = service();
    const upload = requireUpload(await currentService.beginUpload(principal, {
      boardId: primary.board.id,
      generation: primary.board.generation,
      assetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    }));
    const chunks = Array.from(
      { length: Math.ceil(value.byteLength / upload.chunkBytes) },
      (_, index) => value.slice(
        index * upload.chunkBytes,
        Math.min(value.byteLength, (index + 1) * upload.chunkBytes),
      ),
    );
    let offset = 0;
    const writes = chunks.map((chunk) => {
      const chunkOffset = offset;
      offset += chunk.byteLength;
      return currentService.writeChunk(principal, {
        boardId: primary.board.id,
        generation: primary.board.generation,
        assetId,
        uploadId: upload.uploadId,
        offset: chunkOffset,
        chunk,
        chunkSha256: sha256(chunk),
      });
    });
    const finalizing = currentService.finalizeUpload(principal, {
      boardId: primary.board.id,
      generation: primary.board.generation,
      assetId,
      uploadId: upload.uploadId,
    });

    const results = await Promise.all(writes);
    expect(results.map((result) => result.nextOffset)).toEqual(
      chunks.map((_, index) => (
        chunks.slice(0, index + 1)
          .reduce((total, chunk) => total + chunk.byteLength, 0)
      )),
    );
    expect(results.at(-1)).toMatchObject({
      nextOffset: value.byteLength,
      complete: true,
    });
    await expect(finalizing).resolves.toMatchObject({
      created: true,
      asset: {
        status: "ready",
        assetId,
        sha256: sha256(value),
      },
    });
    expect(decode).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);

    const blob = db.prepare(`
      SELECT storage_key FROM board_asset_blobs
      WHERE tenant_id = ? AND sha256 = ?
    `).get(primary.tutorId, sha256(value)) as { storage_key: string };
    expect(fs.readFileSync(
      path.resolve(privateRoot, ...blob.storage_key.split("/")),
    )).toEqual(Buffer.from(value));
  });

  it("marks only one concurrent finalize as a committed publication", async () => {
    const value = pngFixture();
    const assetId = randomUUID();
    const principal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    let releaseDecodes: (() => void) | undefined;
    const bothDecodesStarted = new Promise<void>((resolve) => {
      releaseDecodes = resolve;
    });
    let decodeCalls = 0;
    const concurrentDecode: AssetDecodeProbe = async (request) => {
      decodeCalls += 1;
      if (decodeCalls === 2) releaseDecodes?.();
      await bothDecodesStarted;
      return {
        fullyDecoded: true,
        width: request.encodedWidth,
        height: request.encodedHeight,
        frameCount: 1,
        totalDecodedPixels: request.encodedWidth * request.encodedHeight,
      };
    };
    const firstService = service({ decode: concurrentDecode });
    const secondService = service({ decode: concurrentDecode });
    const upload = requireUpload(await firstService.beginUpload(principal, {
      boardId: primary.board.id,
      generation: primary.board.generation,
      assetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    }));
    await uploadChunks(firstService, principal, primary.board, assetId, upload, value);
    const finalize = {
      boardId: primary.board.id,
      generation: primary.board.generation,
      assetId,
      uploadId: upload.uploadId,
    };

    const results = await Promise.all([
      firstService.finalizeUpload(principal, finalize),
      secondService.finalizeUpload(principal, finalize),
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results[0].asset).toEqual(results[1].asset);
    expect(events).toHaveLength(1);
  });

  it("replaces a crash-lost staging session from the same immutable asset identity", async () => {
    const value = pngFixture();
    const assetId = randomUUID();
    const principal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    const currentService = service();
    const first = requireUpload(await currentService.beginUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    }));
    const row = db.prepare(`
      SELECT staging_key FROM board_asset_uploads WHERE upload_id = ?
    `).get(first.uploadId) as { staging_key: string };
    fs.unlinkSync(path.resolve(privateRoot, ...row.staging_key.split("/")));

    const replacement = requireUpload(await currentService.beginUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    }));
    expect(replacement.uploadId).not.toBe(first.uploadId);
    expect(db.prepare(`
      SELECT status, failure_code FROM board_asset_uploads WHERE upload_id = ?
    `).get(first.uploadId)).toEqual({ status: "rejected", failure_code: "UPLOAD_GONE" });
  });

  it("recovers a crash-reserved missing staging file during startup maintenance", async () => {
    const value = pngFixture();
    const assetId = randomUUID();
    const principal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    const firstService = service();
    const upload = requireUpload(await firstService.beginUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    }));
    const row = db.prepare(`
      SELECT staging_key FROM board_asset_uploads WHERE upload_id = ?
    `).get(upload.uploadId) as { staging_key: string };
    const stagingPath = path.join(privateRoot, ...row.staging_key.split("/"));
    fs.unlinkSync(stagingPath);

    const restarted = service();
    await expect(restarted.cleanupExpiredUploads()).resolves.toBe(1);
    expect(db.prepare(`
      SELECT status, failure_code FROM board_asset_uploads WHERE upload_id = ?
    `).get(upload.uploadId)).toEqual({
      status: "rejected",
      failure_code: "UPLOAD_GONE",
    });
    expect(db.prepare(`
      SELECT storage_key FROM board_asset_gc_queue WHERE storage_key = ?
    `).get(row.staging_key)).toEqual({ storage_key: row.staging_key });
    await expect(restarted.cleanupGarbage()).resolves.toEqual({
      deleted: 1,
      failed: 0,
    });
    expect(db.prepare("SELECT * FROM board_asset_gc_queue").all()).toEqual([]);
  });

  it("keeps a durable intent when staging creation commits cannot finish", async () => {
    const value = pngFixture();
    const assetId = randomUUID();
    const principal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    const currentService = service();
    db.exec(`
      CREATE TRIGGER reject_staging_intent_release
      BEFORE DELETE ON board_asset_gc_queue
      WHEN OLD.storage_key LIKE 'staging/%'
      BEGIN SELECT RAISE(ABORT, 'injected intent release failure'); END;
    `);
    await expect(currentService.beginUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    })).rejects.toMatchObject({ code: "STORAGE_ERROR", retryable: true });
    expect(db.prepare(`
      SELECT upload_id FROM board_asset_uploads WHERE asset_id = ?
    `).get(assetId)).toBeUndefined();
    const intent = db.prepare(`
      SELECT storage_key FROM board_asset_gc_queue
      WHERE storage_key LIKE 'staging/%'
    `).get() as { storage_key: string };
    const stagingPath = path.join(privateRoot, ...intent.storage_key.split("/"));
    expect(fs.existsSync(stagingPath)).toBe(true);

    db.exec("DROP TRIGGER reject_staging_intent_release");
    const restarted = service();
    await expect(restarted.cleanupGarbage()).resolves.toEqual({
      deleted: 1,
      failed: 0,
    });
    expect(fs.existsSync(stagingPath)).toBe(false);
    expect(db.prepare("SELECT * FROM board_asset_gc_queue").all()).toEqual([]);
  });

  it("does not announce ready when the publication transaction fails and safely retries", async () => {
    const value = pngFixture();
    const assetId = randomUUID();
    const principal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    const currentService = service();
    const upload = requireUpload(await currentService.beginUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    }));
    await uploadChunks(currentService, principal, primary.board, assetId, upload, value);
    db.exec(`
      CREATE TRIGGER reject_asset_ready
      BEFORE UPDATE OF status ON board_assets
      WHEN NEW.status = 'ready'
      BEGIN
        SELECT RAISE(ABORT, 'injected publication failure');
      END;
    `);
    await expect(currentService.finalizeUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
      uploadId: upload.uploadId,
    })).rejects.toMatchObject({ code: "STORAGE_ERROR", retryable: true });
    expect(events).toEqual([]);
    expect(db.prepare(`
      SELECT status FROM board_assets WHERE asset_id = ?
    `).get(assetId)).toEqual({ status: "pending" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM board_asset_blobs").get()).toEqual({ count: 0 });
    const recovery = db.prepare(`
      SELECT staging_key, final_storage_key
      FROM board_asset_uploads WHERE upload_id = ?
    `).get(upload.uploadId) as {
      staging_key: string;
      final_storage_key: string;
    };
    const finalPath = path.join(
      privateRoot,
      ...recovery.final_storage_key.split("/"),
    );
    expect(fs.existsSync(finalPath)).toBe(true);
    expect(db.prepare(`
      SELECT storage_key FROM board_asset_gc_queue WHERE storage_key = ?
    `).get(recovery.final_storage_key)).toEqual({
      storage_key: recovery.final_storage_key,
    });
    await expect(currentService.cleanupGarbage()).resolves.toEqual({
      deleted: 0,
      failed: 0,
    });
    expect(fs.existsSync(finalPath)).toBe(true);

    db.exec("DROP TRIGGER reject_asset_ready");
    await expect(currentService.finalizeUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
      uploadId: upload.uploadId,
    })).resolves.toMatchObject({
      created: true,
      asset: { status: "ready" },
    });
    expect(db.prepare(`
      SELECT storage_key FROM board_asset_gc_queue WHERE storage_key = ?
    `).get(recovery.final_storage_key)).toBeUndefined();
    expect(db.prepare(`
      SELECT storage_key FROM board_asset_gc_queue WHERE storage_key = ?
    `).get(recovery.staging_key)).toEqual({ storage_key: recovery.staging_key });
    await expect(currentService.cleanupGarbage()).resolves.toMatchObject({
      failed: 0,
    });
    expect(fs.existsSync(finalPath)).toBe(true);
    await expect(currentService.finalizeUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
      uploadId: upload.uploadId,
    })).resolves.toMatchObject({
      created: false,
      asset: { status: "ready" },
    });
    expect(events).toHaveLength(1);
  });

  it("re-enqueues final recovery when garbage collection wins the pre-link race", async () => {
    const value = pngFixture();
    const assetId = randomUUID();
    const principal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    let assertionCount = 0;
    let uploadId = "";
    let stagingKey = "";
    let finalKey = "";
    let racedCleanup: Promise<{ deleted: number; failed: number }> | undefined;
    let currentService!: BoardAssetService<Principal>;
    currentService = service({
      assertPublicationActive: () => {
        assertionCount += 1;
        if (assertionCount === 1) {
          queueMicrotask(() => {
            db.prepare("DELETE FROM board_asset_uploads WHERE upload_id = ?")
              .run(uploadId);
            db.prepare(`
              UPDATE board_asset_gc_queue SET attempts = 1
              WHERE storage_key = ?
            `).run(stagingKey);
            racedCleanup = currentService.cleanupGarbage(1);
          });
          return;
        }
        throw new AssetServiceError(
          "ROOM_EXPIRED",
          "guest room expired during publication",
        );
      },
    });
    const upload = requireUpload(await currentService.beginUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    }));
    uploadId = upload.uploadId;
    await uploadChunks(currentService, principal, primary.board, assetId, upload, value);
    const recovery = db.prepare(`
      SELECT staging_key FROM board_asset_uploads WHERE upload_id = ?
    `).get(uploadId) as { staging_key: string };
    stagingKey = recovery.staging_key;
    const tenantDigest = createHash("sha256").update(primary.tutorId).digest("hex");
    finalKey = `blobs/${tenantDigest}/${sha256(value).slice(0, 2)}/${sha256(value)}`;
    const finalPath = path.join(privateRoot, ...finalKey.split("/"));

    await expect(currentService.finalizeUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
      uploadId,
    })).rejects.toMatchObject({ code: "ROOM_EXPIRED" });
    await expect(racedCleanup).resolves.toEqual({ deleted: 1, failed: 0 });
    expect(fs.existsSync(finalPath)).toBe(true);
    expect(db.prepare(`
      SELECT storage_key FROM board_asset_gc_queue WHERE storage_key = ?
    `).get(finalKey)).toEqual({ storage_key: finalKey });

    await expect(currentService.cleanupGarbage()).resolves.toEqual({
      deleted: 2,
      failed: 0,
    });
    expect(fs.existsSync(finalPath)).toBe(false);
  });

  it("restores final recovery when an EEXIST path cannot be validated", async () => {
    const value = pngFixture();
    const digest = sha256(value);
    const assetId = randomUUID();
    const principal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    const tenantDigest = createHash("sha256").update(primary.tutorId).digest("hex");
    const finalKey = `blobs/${tenantDigest}/${digest.slice(0, 2)}/${digest}`;
    const finalPath = path.join(privateRoot, ...finalKey.split("/"));
    let assertionCount = 0;
    const currentService = service({
      assertPublicationActive: () => {
        assertionCount += 1;
        if (assertionCount !== 1) return;
        queueMicrotask(() => {
          db.prepare("DELETE FROM board_asset_gc_queue WHERE storage_key = ?")
            .run(finalKey);
          fs.mkdirSync(finalPath, { recursive: true });
        });
      },
    });
    const upload = requireUpload(await currentService.beginUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
      sha256: digest,
      byteSize: value.byteLength,
      declaredMime: "image/png",
    }));
    await uploadChunks(currentService, principal, primary.board, assetId, upload, value);

    await expect(currentService.finalizeUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
      uploadId: upload.uploadId,
    })).rejects.toMatchObject({ code: "STORAGE_CORRUPT" });
    expect(db.prepare(`
      SELECT storage_key FROM board_asset_gc_queue WHERE storage_key = ?
    `).get(finalKey)).toEqual({ storage_key: finalKey });
  });

  it("removes a recovered final hardlink after its failed upload expires", async () => {
    let clock = new Date("2026-07-28T00:00:00.000Z");
    const value = pngFixture();
    const assetId = randomUUID();
    const principal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    const currentService = service({
      now: () => clock,
      limits: { uploadTtlMs: 1_000 },
    });
    const upload = requireUpload(await currentService.beginUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    }));
    await uploadChunks(currentService, principal, primary.board, assetId, upload, value);
    db.exec(`
      CREATE TRIGGER reject_expiring_asset_ready
      BEFORE UPDATE OF status ON board_assets
      WHEN NEW.status = 'ready'
      BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END;
    `);
    await expect(currentService.finalizeUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
      uploadId: upload.uploadId,
    })).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    db.exec("DROP TRIGGER reject_expiring_asset_ready");

    const recovery = db.prepare(`
      SELECT staging_key, final_storage_key
      FROM board_asset_uploads WHERE upload_id = ?
    `).get(upload.uploadId) as {
      staging_key: string;
      final_storage_key: string;
    };
    const stagingPath = path.join(privateRoot, ...recovery.staging_key.split("/"));
    const finalPath = path.join(privateRoot, ...recovery.final_storage_key.split("/"));
    expect(fs.existsSync(stagingPath)).toBe(true);
    expect(fs.existsSync(finalPath)).toBe(true);

    clock = new Date("2026-07-28T00:00:02.000Z");
    await expect(currentService.cleanupExpiredUploads()).resolves.toBe(1);
    await expect(currentService.cleanupGarbage()).resolves.toEqual({
      deleted: 2,
      failed: 0,
    });
    expect(fs.existsSync(stagingPath)).toBe(false);
    expect(fs.existsSync(finalPath)).toBe(false);
    expect(db.prepare("SELECT * FROM board_asset_gc_queue").all()).toEqual([]);
  });

  it("rolls publication back when activity expires during a slow finalize", async () => {
    const value = pngFixture();
    const assetId = randomUUID();
    const principal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    let roomActive = true;
    let markDecodeStarted!: () => void;
    let resolveDecode!: (value: DecodedAssetInfo) => void;
    const decodeStarted = new Promise<void>((resolve) => {
      markDecodeStarted = resolve;
    });
    const decoded = new Promise<DecodedAssetInfo>((resolve) => {
      resolveDecode = resolve;
    });
    const commitActivity = vi.fn(() => {
      if (!roomActive) {
        throw new AssetServiceError(
          "UPLOAD_EXPIRED",
          "guest room expired during publication",
        );
      }
    });
    const currentService = service({
      commitActivity,
      decode: async () => {
        markDecodeStarted();
        return await decoded;
      },
    });
    const upload = requireUpload(await currentService.beginUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    }));
    await uploadChunks(currentService, principal, primary.board, assetId, upload, value);

    const finalize = currentService.finalizeUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
      uploadId: upload.uploadId,
    });
    await decodeStarted;
    roomActive = false;
    resolveDecode({
      fullyDecoded: true,
      width: 4,
      height: 3,
      frameCount: 1,
      totalDecodedPixels: 12,
    });
    await expect(finalize).rejects.toMatchObject({ code: "UPLOAD_EXPIRED" });
    expect(commitActivity).toHaveBeenCalledOnce();
    expect(db.prepare(`
      SELECT status FROM board_assets WHERE asset_id = ?
    `).get(assetId)).toEqual({ status: "pending" });
    expect(db.prepare("SELECT count(*) AS count FROM board_asset_blobs").get())
      .toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT status FROM board_asset_uploads WHERE upload_id = ?
    `).get(upload.uploadId)).toEqual({ status: "active" });

    roomActive = true;
    await expect(currentService.finalizeUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
      uploadId: upload.uploadId,
    })).resolves.toMatchObject({ created: true, asset: { status: "ready" } });
    expect(commitActivity).toHaveBeenCalledTimes(2);
  });

  it("deduplicates only inside the authoritative tutor tenant", async () => {
    const sameTenant = insertBoard(db, primary.tutorId);
    const otherTenant = insertBoard(db);
    boardTenants.set(sameTenant.board.id, primary.tutorId);
    boardTenants.set(otherTenant.board.id, otherTenant.tutorId);
    const value = pngFixture();
    const originalAssetId = randomUUID();
    const primaryPrincipal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    const first = requireUpload(await service().beginUpload(primaryPrincipal, {
      boardId: primary.board.id,
      generation: 1,
      assetId: originalAssetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    }));
    const firstService = service();
    await uploadChunks(firstService, primaryPrincipal, primary.board, originalAssetId, first, value);
    await firstService.finalizeUpload(primaryPrincipal, {
      boardId: primary.board.id,
      generation: 1,
      assetId: originalAssetId,
      uploadId: first.uploadId,
    });

    events.splice(0);
    const sameTenantAssetId = randomUUID();
    const sameTenantInput = {
      boardId: sameTenant.board.id,
      generation: 1,
      assetId: sameTenantAssetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    };
    const sameTenantResults = await Promise.all([
      service().beginUpload(primaryPrincipal, sameTenantInput),
      service().beginUpload(primaryPrincipal, sameTenantInput),
    ]);
    expect(sameTenantResults.map((result) => {
      if (result.status !== "ready") throw new Error("expected a ready asset");
      return result.created;
    }).sort()).toEqual([false, true]);
    expect(events).toHaveLength(1);

    const otherTenantResult = await service().beginUpload(
      { tenantId: otherTenant.tutorId, actorId: otherTenant.tutorId },
      {
        boardId: otherTenant.board.id,
        generation: 1,
        assetId: randomUUID(),
        sha256: sha256(value),
        byteSize: value.byteLength,
        declaredMime: "image/png",
      },
    );
    expect(otherTenantResult.status).toBe("upload");
    expect((db.prepare("SELECT COUNT(*) AS count FROM board_asset_blobs").get() as { count: number }).count)
      .toBe(1);
  });

  it("caps durable asset metadata even when a same-tenant blob is deduplicated", async () => {
    const sameTenant = insertBoard(db, primary.tutorId);
    boardTenants.set(sameTenant.board.id, primary.tutorId);
    const principal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    const value = pngFixture();
    const originalAssetId = randomUUID();
    const publisher = service();
    const upload = requireUpload(await publisher.beginUpload(principal, {
      boardId: primary.board.id,
      generation: primary.board.generation,
      assetId: originalAssetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    }));
    await uploadChunks(publisher, principal, primary.board, originalAssetId, upload, value);
    await publisher.finalizeUpload(principal, {
      boardId: primary.board.id,
      generation: primary.board.generation,
      assetId: originalAssetId,
      uploadId: upload.uploadId,
    });

    const restarted = service({ limits: { maxAssetRecordsPerTenant: 1 } });
    await expect(restarted.beginUpload(principal, {
      boardId: sameTenant.board.id,
      generation: sameTenant.board.generation,
      assetId: randomUUID(),
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    })).rejects.toMatchObject({ code: "TENANT_QUOTA", retryable: false });
    await expect(restarted.beginUpload(principal, {
      boardId: primary.board.id,
      generation: primary.board.generation,
      assetId: originalAssetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    })).resolves.toMatchObject({ status: "ready", created: false });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM board_assets WHERE tenant_id = ?
    `).get(primary.tutorId)).toEqual({ count: 1 });
  });

  it("reserves free disk for deduplicated metadata before linking a new asset id", async () => {
    const sameTenant = insertBoard(db, primary.tutorId);
    boardTenants.set(sameTenant.board.id, primary.tutorId);
    const principal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    const value = pngFixture();
    const originalAssetId = randomUUID();
    const publisher = service();
    const upload = requireUpload(await publisher.beginUpload(principal, {
      boardId: primary.board.id,
      generation: primary.board.generation,
      assetId: originalAssetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    }));
    await uploadChunks(publisher, principal, primary.board, originalAssetId, upload, value);
    await publisher.finalizeUpload(principal, {
      boardId: primary.board.id,
      generation: primary.board.generation,
      assetId: originalAssetId,
      uploadId: upload.uploadId,
    });

    await expect(service({
      freeDiskBytes: 159,
      limits: { minFreeDiskBytes: 128, assetMetadataReserveBytes: 32 },
    }).beginUpload(principal, {
      boardId: sameTenant.board.id,
      generation: sameTenant.board.generation,
      assetId: randomUUID(),
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    })).rejects.toMatchObject({ code: "DISK_PRESSURE", retryable: true });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM board_assets WHERE tenant_id = ?
    `).get(primary.tutorId)).toEqual({ count: 1 });
  });

  it("rejects a concrete MIME mismatch when linking a same-tenant blob", async () => {
    const sameTenant = insertBoard(db, primary.tutorId);
    boardTenants.set(sameTenant.board.id, primary.tutorId);
    const value = pngFixture();
    const principal = {
      tenantId: primary.tutorId,
      actorId: primary.tutorId,
    };
    const currentService = service();
    const originalAssetId = randomUUID();
    const upload = requireUpload(await currentService.beginUpload(principal, {
      boardId: primary.board.id,
      generation: primary.board.generation,
      assetId: originalAssetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    }));
    await uploadChunks(
      currentService,
      principal,
      primary.board,
      originalAssetId,
      upload,
      value,
    );
    await currentService.finalizeUpload(principal, {
      boardId: primary.board.id,
      generation: primary.board.generation,
      assetId: originalAssetId,
      uploadId: upload.uploadId,
    });

    await expect(currentService.beginUpload(principal, {
      boardId: sameTenant.board.id,
      generation: sameTenant.board.generation,
      assetId: randomUUID(),
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/jpeg",
    })).rejects.toMatchObject({ code: "MIME_MISMATCH" });
    await expect(currentService.beginUpload(principal, {
      boardId: sameTenant.board.id,
      generation: sameTenant.board.generation,
      assetId: randomUUID(),
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "application/octet-stream",
    })).resolves.toMatchObject({ status: "ready", deduplicated: true });
  });

  it("bounds concurrent full decodes, their queue, and releases a slot after rejection", async () => {
    const principal = {
      tenantId: primary.tutorId,
      actorId: primary.tutorId,
    };
    let activeDecodes = 0;
    let maximumActiveDecodes = 0;
    const gates: Array<{
      resolve: () => void;
      reject: () => void;
    }> = [];
    const controlledDecode: AssetDecodeProbe = vi.fn((request) =>
      new Promise<DecodedAssetInfo>((resolve, reject) => {
        activeDecodes += 1;
        maximumActiveDecodes = Math.max(maximumActiveDecodes, activeDecodes);
        gates.push({
          resolve: () => {
            activeDecodes -= 1;
            resolve({
              fullyDecoded: true,
              width: request.encodedWidth,
              height: request.encodedHeight,
              frameCount: 1,
              totalDecodedPixels: request.encodedWidth * request.encodedHeight,
            });
          },
          reject: () => {
            activeDecodes -= 1;
            reject(new Error("injected decode failure"));
          },
        });
      }));
    const currentService = service({
      decode: controlledDecode,
      limits: { maxConcurrentDecodes: 2, maxQueuedDecodes: 1 },
    });
    const pending = [];
    for (const value of [
      pngFixture(4, 3, 48),
      pngFixture(4, 3, 49),
      pngFixture(4, 3, 50),
      pngFixture(4, 3, 51),
    ]) {
      const assetId = randomUUID();
      const upload = requireUpload(await currentService.beginUpload(principal, {
        boardId: primary.board.id,
        generation: primary.board.generation,
        assetId,
        sha256: sha256(value),
        byteSize: value.byteLength,
        declaredMime: "image/png",
      }));
      await uploadChunks(
        currentService,
        principal,
        primary.board,
        assetId,
        upload,
        value,
      );
      pending.push({ assetId, uploadId: upload.uploadId });
    }

    const finalizations = pending.map(({ assetId, uploadId }) =>
      currentService.finalizeUpload(principal, {
        boardId: primary.board.id,
        generation: primary.board.generation,
        assetId,
        uploadId,
      }));
    const settledFinalizations = Promise.allSettled(finalizations);
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(maximumActiveDecodes).toBe(2);
    gates[0]!.reject();
    await vi.waitFor(() => expect(gates).toHaveLength(3));
    expect(activeDecodes).toBe(2);
    gates[1]!.resolve();
    gates[2]!.resolve();

    const results = await settledFinalizations;
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: expect.objectContaining({ code: "DECODE_FAILED" }),
        }),
        expect.objectContaining({
          reason: expect.objectContaining({
            code: "STORAGE_ERROR",
            retryable: true,
          }),
        }),
      ]));
    expect(maximumActiveDecodes).toBe(2);
  });

  it("rejects SVG, hash mismatch, oversized dimensions, and failed full decode without publishing", async () => {
    const principal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    const cases: Array<{
      value: Uint8Array;
      expectedSha: string;
      declaredMime: string;
      expectedCode: string;
      customDecode?: AssetDecodeProbe;
    }> = [
      {
        value: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
        expectedSha: sha256(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>")),
        declaredMime: "image/svg+xml",
        expectedCode: "SVG_REJECTED",
      },
      {
        value: pngFixture(),
        expectedSha: "0".repeat(64),
        declaredMime: "image/png",
        expectedCode: "HASH_MISMATCH",
      },
      {
        value: pngFixture(),
        expectedSha: sha256(pngFixture()),
        declaredMime: "image/jpeg",
        expectedCode: "MIME_MISMATCH",
      },
      {
        value: pngFixture(100, 100),
        expectedSha: sha256(pngFixture(100, 100)),
        declaredMime: "image/png",
        expectedCode: "DIMENSION_LIMIT",
      },
      {
        value: pngFixture(),
        expectedSha: sha256(pngFixture()),
        declaredMime: "image/png",
        expectedCode: "DECODE_FAILED",
        customDecode: async () => {
          throw new Error("decoder rejected corrupt pixels");
        },
      },
    ];

    for (const item of cases) {
      const assetId = randomUUID();
      const currentService = service({
        decode: item.customDecode,
        limits: item.expectedCode === "DIMENSION_LIMIT" ? { maxPixelsPerFrame: 100 } : undefined,
      });
      const upload = requireUpload(await currentService.beginUpload(principal, {
        boardId: primary.board.id,
        generation: 1,
        assetId,
        sha256: item.expectedSha,
        byteSize: item.value.byteLength,
        declaredMime: item.declaredMime,
      }));
      await uploadChunks(currentService, principal, primary.board, assetId, upload, item.value);
      await expect(currentService.finalizeUpload(principal, {
        boardId: primary.board.id,
        generation: 1,
        assetId,
        uploadId: upload.uploadId,
      })).rejects.toMatchObject({ code: item.expectedCode });
      await expect(currentService.getStatus(principal, {
        boardId: primary.board.id,
        generation: 1,
        assetId,
      })).resolves.toMatchObject({ status: "rejected", errorCode: item.expectedCode });
    }
    expect((db.prepare("SELECT COUNT(*) AS count FROM board_asset_blobs").get() as { count: number }).count)
      .toBe(0);
  });

  it("commits deduplicated linking and guest activity atomically", async () => {
    const sameTenant = insertBoard(db, primary.tutorId);
    boardTenants.set(sameTenant.board.id, primary.tutorId);
    const value = pngFixture();
    const principal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    const originalAssetId = randomUUID();
    const publisher = service();
    const upload = requireUpload(await publisher.beginUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId: originalAssetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    }));
    await uploadChunks(publisher, principal, primary.board, originalAssetId, upload, value);
    await publisher.finalizeUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId: originalAssetId,
      uploadId: upload.uploadId,
    });

    const linkedAssetId = randomUUID();
    const input = {
      boardId: sameTenant.board.id,
      generation: 1,
      assetId: linkedAssetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    };
    await expect(service({
      commitActivity: () => {
        throw new AssetServiceError("UPLOAD_EXPIRED", "guest room expired");
      },
    }).beginUpload(principal, input)).rejects.toMatchObject({
      code: "UPLOAD_EXPIRED",
    });
    expect(db.prepare(`
      SELECT status FROM board_assets
      WHERE board_id = ? AND asset_id = ?
    `).get(sameTenant.board.id, linkedAssetId)).toBeUndefined();

    const commitActivity = vi.fn();
    const linker = service({ commitActivity });
    await expect(linker.beginUpload(principal, input)).resolves.toMatchObject({
      status: "ready",
      created: true,
      deduplicated: true,
    });
    await expect(linker.beginUpload(principal, input)).resolves.toMatchObject({
      status: "ready",
      created: false,
    });
    expect(commitActivity).toHaveBeenCalledOnce();
  });

  it("serves private immutable downloads through a bounded single range abstraction", async () => {
    const value = pngFixture();
    const assetId = randomUUID();
    const principal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    const currentService = service();
    const upload = requireUpload(await currentService.beginUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    }));
    await uploadChunks(currentService, principal, primary.board, assetId, upload, value);
    await currentService.finalizeUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
      uploadId: upload.uploadId,
    });

    const download = await currentService.openDownload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
    }, "bytes=8-15");
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(Buffer.from(chunk));
    expect(download.statusCode).toBe(206);
    expect(download.headers).toMatchObject({
      "Content-Length": "8",
      "Content-Range": `bytes 8-15/${value.byteLength}`,
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
    });
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(value.slice(8, 16)));
    await expect(currentService.openDownload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId,
    }, "bytes=999-1000")).rejects.toMatchObject({ code: "RANGE_NOT_SATISFIABLE" });
  });

  it("reports quota and free-disk pressure explicitly while retaining per-asset limits", async () => {
    const value = pngFixture();
    const principal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    await expect(service({ limits: { tenantSoftQuotaBytes: 32 } }).beginUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId: randomUUID(),
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    })).rejects.toMatchObject({ code: "TENANT_QUOTA", retryable: false });
    await expect(service({ freeDiskBytes: 160 }).beginUpload(principal, {
      boardId: primary.board.id,
      generation: 1,
      assetId: randomUUID(),
      sha256: sha256(value),
      byteSize: value.byteLength,
      declaredMime: "image/png",
    })).rejects.toMatchObject({ code: "DISK_PRESSURE", retryable: true });
  });

  it("does not let a guest authorizer widen the configured tenant quota", async () => {
    const value = pngFixture();
    const guestTenant = `guest-room-${randomUUID()}`;
    boardTenants.set(primary.board.id, guestTenant);

    await expect(service({
      limits: { tenantSoftQuotaBytes: value.byteLength - 1 },
      tenantSoftQuotaBytes: value.byteLength * 10,
    }).beginUpload(
      { tenantId: guestTenant, actorId: "guest" },
      {
        boardId: primary.board.id,
        generation: primary.board.generation,
        assetId: randomUUID(),
        sha256: sha256(value),
        byteSize: value.byteLength,
        declaredMime: "image/png",
      },
    )).rejects.toMatchObject({ code: "TENANT_QUOTA" });
  });

  it("admits concurrent tenant uploads against one atomic quota reservation", async () => {
    const value = pngFixture();
    const principal = { tenantId: primary.tutorId, actorId: primary.tutorId };
    const currentService = service({
      limits: {
        tenantSoftQuotaBytes: value.byteLength,
        maxActiveUploadsPerTenant: 8,
      },
    });
    const attempts = await Promise.allSettled([
      currentService.beginUpload(principal, {
        boardId: primary.board.id,
        generation: 1,
        assetId: randomUUID(),
        sha256: sha256(value),
        byteSize: value.byteLength,
        declaredMime: "image/png",
      }),
      currentService.beginUpload(principal, {
        boardId: primary.board.id,
        generation: 1,
        assetId: randomUUID(),
        sha256: sha256(value),
        byteSize: value.byteLength,
        declaredMime: "image/png",
      }),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled"))
      .toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected"))
      .toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({ code: "TENANT_QUOTA" }),
        }),
      ]);
    expect(db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(expected_bytes), 0) AS bytes
      FROM board_asset_uploads
      WHERE tenant_id = ? AND status = 'active'
    `).get(primary.tutorId)).toEqual({
      count: 1,
      bytes: value.byteLength,
    });
  });

  it("persists one aggregate guest quota across distinct room tenants", async () => {
    const other = insertBoard(db);
    const firstTenant = `guest-room-${randomUUID()}`;
    const secondTenant = `guest-room-${randomUUID()}`;
    boardTenants.set(primary.board.id, firstTenant);
    boardTenants.set(other.board.id, secondTenant);
    const value = pngFixture();
    const aggregateQuota = {
      tenantIdPrefix: "guest-room-",
      softQuotaBytes: value.byteLength,
    };
    const firstService = service({ aggregateQuota });
    await expect(firstService.beginUpload(
      { tenantId: firstTenant, actorId: "guest-a" },
      {
        boardId: primary.board.id,
        generation: primary.board.generation,
        assetId: randomUUID(),
        sha256: sha256(value),
        byteSize: value.byteLength,
        declaredMime: "image/png",
      },
    )).resolves.toMatchObject({ status: "upload" });

    const restarted = service({ aggregateQuota });
    await expect(restarted.beginUpload(
      { tenantId: secondTenant, actorId: "guest-b" },
      {
        boardId: other.board.id,
        generation: other.board.generation,
        assetId: randomUUID(),
        sha256: sha256(value),
        byteSize: value.byteLength,
        declaredMime: "image/png",
      },
    )).rejects.toMatchObject({
      code: "TENANT_QUOTA",
      retryable: false,
    });
  });

  it("persists a global guest metadata-record cap across distinct room tenants", async () => {
    const other = insertBoard(db);
    const firstTenant = `guest-room-${randomUUID()}`;
    const secondTenant = `guest-room-${randomUUID()}`;
    boardTenants.set(primary.board.id, firstTenant);
    boardTenants.set(other.board.id, secondTenant);
    const value = pngFixture();
    const limited = service({ limits: { maxGuestAssetRecordsGlobal: 1 } });
    await expect(limited.beginUpload(
      { tenantId: firstTenant, actorId: "guest-a" },
      {
        boardId: primary.board.id,
        generation: primary.board.generation,
        assetId: randomUUID(),
        sha256: sha256(value),
        byteSize: value.byteLength,
        declaredMime: "image/png",
      },
    )).resolves.toMatchObject({ status: "upload" });

    const restarted = service({ limits: { maxGuestAssetRecordsGlobal: 1 } });
    await expect(restarted.beginUpload(
      { tenantId: secondTenant, actorId: "guest-b" },
      {
        boardId: other.board.id,
        generation: other.board.generation,
        assetId: randomUUID(),
        sha256: sha256(value),
        byteSize: value.byteLength,
        declaredMime: "image/png",
      },
    )).rejects.toMatchObject({ code: "TENANT_QUOTA", retryable: false });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM board_assets
      WHERE tenant_id GLOB 'guest-room-*'
    `).get()).toEqual({ count: 1 });
  });

  it("atomically reserves remaining bytes against the global free-disk floor", async () => {
    const otherTenant = insertBoard(db);
    boardTenants.set(otherTenant.board.id, otherTenant.tutorId);
    const value = pngFixture();
    const currentService = service({
      freeDiskBytes: 220,
      limits: {
        tenantSoftQuotaBytes: 4096,
        minFreeDiskBytes: 128,
        assetMetadataReserveBytes: 1,
      },
    });
    const attempts = await Promise.allSettled([
      currentService.beginUpload(
        { tenantId: primary.tutorId, actorId: primary.tutorId },
        {
          boardId: primary.board.id,
          generation: 1,
          assetId: randomUUID(),
          sha256: sha256(value),
          byteSize: value.byteLength,
          declaredMime: "image/png",
        },
      ),
      currentService.beginUpload(
        { tenantId: otherTenant.tutorId, actorId: otherTenant.tutorId },
        {
          boardId: otherTenant.board.id,
          generation: 1,
          assetId: randomUUID(),
          sha256: sha256(value),
          byteSize: value.byteLength,
          declaredMime: "image/png",
        },
      ),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled"))
      .toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected"))
      .toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({ code: "DISK_PRESSURE" }),
        }),
      ]);
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM board_asset_uploads
      WHERE status = 'active'
    `).get()).toEqual({ count: 1 });
  });

  it("checks ACL on every operation and does not reveal another tenant's asset", async () => {
    const value = pngFixture();
    const assetId = randomUUID();
    const currentService = service();
    await expect(currentService.beginUpload(
      { tenantId: randomUUID(), actorId: randomUUID() },
      {
        boardId: primary.board.id,
        generation: 1,
        assetId,
        sha256: sha256(value),
        byteSize: value.byteLength,
        declaredMime: "image/png",
      },
    )).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(operations).toEqual(["begin-upload"]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM board_assets").get()).toEqual({ count: 0 });
  });

  it("refuses storage roots inside a public web directory", () => {
    expect(() => new BoardAssetService<Principal>({
      db,
      privateStorageRoot: path.join(publicRoot, "assets"),
      forbiddenPublicRoots: [publicRoot],
      authorize: async (principal) => ({ tenantId: principal.tenantId, actorId: principal.actorId }),
      decode,
    })).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
});
