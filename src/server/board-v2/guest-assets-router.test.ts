import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BOARD_SYNC_SERVER_CAPABILITIES,
} from "./sync-service.js";
import type { AssetDecodeProbe, DecodedAssetInfo } from "./assets.js";
import { createApp, getAppContext } from "../app.js";
import type { AppContext } from "../types.js";

const ORIGIN = "http://eduri.test";

interface Harness {
  app: ReturnType<typeof createApp>;
  context: AppContext;
  dataDir: string;
}

interface GuestBoardFixture {
  shareKey: string;
  roomId: string;
  resourceId: string;
  boardId: string;
  generation: number;
}

const harnesses: Harness[] = [];

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function harness(): Harness {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eduri-guest-board-assets-"),
  );
  const app = createApp({
    config: {
      nodeEnv: "test",
      appOrigins: [ORIGIN],
      dataDir,
      databasePath: path.join(dataDir, "test.sqlite"),
      uploadDir: path.join(dataDir, "uploads"),
      boardAssetDir: path.join(dataDir, "private-board-assets"),
      boardAssetMaxBytes: 1024 * 1024,
      boardAssetMaxChunkBytes: 1024,
      boardAssetTenantQuotaBytes: 16 * 1024 * 1024,
      boardAssetMinFreeDiskBytes: 1,
      authLookupKey: "guest-board-assets-test-key-at-least-32-bytes",
      adminPassword: "guest-board-assets-admin-password",
      boardV2FoundationEnabled: true,
    },
  });
  const created = { app, context: getAppContext(app), dataDir };
  harnesses.push(created);
  return created;
}

function createGuestBoard(context: AppContext): GuestBoardFixture {
  const room = context.guestRooms.create("board");
  const resource = room.resources.find((candidate) => candidate.kind === "board")!;
  const ticket = context.boardV2Sync!.issueGuestTicket({
    shareKey: room.shareKey,
    deviceId: randomUUID().replaceAll("-", ""),
    minSchemaVersion: 1,
    maxSchemaVersion: 1,
    capabilities: BOARD_SYNC_SERVER_CAPABILITIES,
  });
  return {
    shareKey: room.shareKey,
    roomId: room.id,
    resourceId: resource.id,
    boardId: ticket.boardId,
    generation: ticket.generation,
  };
}

function basePath(fixture: GuestBoardFixture): string {
  return `/api/guest/rooms/${fixture.shareKey}/board-assets`;
}

function beginBody(
  fixture: GuestBoardFixture,
  value: Uint8Array,
  assetId = randomUUID(),
) {
  return {
    boardId: fixture.boardId,
    generation: fixture.generation,
    assetId,
    sha256: hash(value),
    byteSize: value.byteLength,
    declaredMime: "image/png",
    originalFileName: "guest-plot.png",
  };
}

afterEach(() => {
  for (const current of harnesses.splice(0)) {
    current.context.stopGuestRoomMaintenance?.();
    current.context.stopBoardAssetMaintenance?.();
    if (current.context.db.open) current.context.db.close();
    fs.rmSync(current.dataDir, { recursive: true, force: true });
  }
});

describe("guest Board asset capability router", () => {
  it("uploads and downloads without account auth while only ready touches TTL", async () => {
    const current = harness();
    const fixture = createGuestBoard(current.context);
    const value = await sharp({
      create: {
        width: 4,
        height: 3,
        channels: 4,
        background: { r: 30, g: 90, b: 180, alpha: 1 },
      },
    }).png().toBuffer();
    const body = beginBody(fixture, value);
    const started = await request(current.app)
      .post(`${basePath(fixture)}/begin`)
      .set("Origin", ORIGIN)
      .send(body)
      .expect(200);
    expect(started.body).toMatchObject({
      status: "upload",
      nextOffset: 0,
    });
    expect(current.context.db.prepare(`
      SELECT tenant_id, created_by
      FROM board_assets
      WHERE board_id = ? AND generation = ? AND asset_id = ?
    `).get(
      fixture.boardId,
      fixture.generation,
      body.assetId,
    )).toEqual({
      tenant_id: `guest-room-${fixture.roomId}`,
      created_by: `guest-board-${fixture.resourceId}`,
    });

    await request(current.app)
      .put(
        `${basePath(fixture)}/${body.assetId}`
        + `/uploads/${started.body.uploadId}/chunks`
        + `?boardId=${fixture.boardId}&generation=${fixture.generation}`,
      )
      .set("Origin", ORIGIN)
      .set("content-type", "application/octet-stream")
      .set("x-upload-offset", "0")
      .set("x-asset-chunk-sha256", hash(value))
      .send(value)
      .expect(200)
      .expect((response) => {
        expect(response.body.complete).toBe(true);
      });

    const baselineActivity = "2026-08-01T00:00:00.000Z";
    const baselineExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    current.context.db.prepare(`
      UPDATE guest_rooms
      SET updated_at = ?, last_activity_at = ?, expires_at = ?
      WHERE id = ?
    `).run(
      baselineActivity,
      baselineActivity,
      baselineExpiry,
      fixture.roomId,
    );
    current.context.db.prepare(`
      UPDATE guest_room_resources SET last_activity_at = ? WHERE id = ?
    `).run(baselineActivity, fixture.resourceId);
    const recordResourceMutation = vi.spyOn(
      current.context.guestRooms,
      "recordResourceMutation",
    );

    await request(current.app)
      .post(
        `${basePath(fixture)}/${body.assetId}`
        + `/uploads/${started.body.uploadId}/finalize`,
      )
      .set("Origin", ORIGIN)
      .send({
        boardId: fixture.boardId,
        generation: fixture.generation,
      })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          status: "ready",
          assetId: body.assetId,
          sha256: body.sha256,
          mimeType: "image/png",
          width: 4,
          height: 3,
        });
      });
    const afterReady = current.context.db.prepare(`
      SELECT
        room.last_activity_at,
        room.expires_at,
        resource.last_activity_at AS resource_activity_at
      FROM guest_rooms room
      JOIN guest_room_resources resource ON resource.room_id = room.id
      WHERE room.id = ? AND resource.id = ?
    `).get(fixture.roomId, fixture.resourceId) as {
      last_activity_at: string;
      expires_at: string;
      resource_activity_at: string;
    };
    expect(afterReady.last_activity_at).not.toBe(baselineActivity);
    expect(afterReady.resource_activity_at).toBe(afterReady.last_activity_at);
    expect(Date.parse(afterReady.expires_at)).toBeGreaterThan(
      Date.now() + 47 * 60 * 60 * 1000,
    );
    expect(recordResourceMutation).toHaveBeenCalledTimes(1);

    await request(current.app)
      .get(
        `${basePath(fixture)}/${body.assetId}/status`
        + `?boardId=${fixture.boardId}&generation=${fixture.generation}`,
      )
      .expect(200)
      .expect((response) => {
        expect(response.body.status).toBe("ready");
      });
    const downloaded = await request(current.app)
      .get(
        `${basePath(fixture)}/${body.assetId}/content`
        + `?boardId=${fixture.boardId}&generation=${fixture.generation}`,
      )
      .expect(200)
      .expect("Cache-Control", "private, max-age=31536000, immutable");
    expect(Buffer.from(downloaded.body)).toEqual(Buffer.from(value));

    await request(current.app)
      .post(`${basePath(fixture)}/begin`)
      .send({ ...body, assetId: randomUUID() })
      .expect(403);
    await request(current.app)
      .put(
        `${basePath(fixture)}/${body.assetId}`
        + `/uploads/${started.body.uploadId}/chunks`
        + `?boardId=${fixture.boardId}&generation=${fixture.generation}`,
      )
      .set("content-type", "application/octet-stream")
      .set("x-upload-offset", "0")
      .set("x-asset-chunk-sha256", hash(value))
      .send(value)
      .expect(403);
    await request(current.app)
      .post(
        `${basePath(fixture)}/${body.assetId}`
        + `/uploads/${started.body.uploadId}/finalize`,
      )
      .send({
        boardId: fixture.boardId,
        generation: fixture.generation,
      })
      .expect(403);
    expect(current.context.db.prepare(`
      SELECT
        room.last_activity_at,
        room.expires_at,
        resource.last_activity_at AS resource_activity_at
      FROM guest_rooms room
      JOIN guest_room_resources resource ON resource.room_id = room.id
      WHERE room.id = ? AND resource.id = ?
    `).get(fixture.roomId, fixture.resourceId)).toEqual(afterReady);

    current.context.db.prepare(`
      UPDATE guest_rooms
      SET updated_at = ?, last_activity_at = ?, expires_at = ?
      WHERE id = ?
    `).run(
      baselineActivity,
      baselineActivity,
      baselineExpiry,
      fixture.roomId,
    );
    current.context.db.prepare(`
      UPDATE guest_room_resources SET last_activity_at = ? WHERE id = ?
    `).run(baselineActivity, fixture.resourceId);
    await request(current.app)
      .post(
        `${basePath(fixture)}/${body.assetId}`
        + `/uploads/${started.body.uploadId}/finalize`,
      )
      .set("Origin", ORIGIN)
      .send({
        boardId: fixture.boardId,
        generation: fixture.generation,
      })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          status: "ready",
          assetId: body.assetId,
        });
        expect(response.body.created).toBeUndefined();
      });
    expect(current.context.db.prepare(`
      SELECT last_activity_at, expires_at
      FROM guest_rooms WHERE id = ?
    `).get(fixture.roomId)).toEqual({
      last_activity_at: baselineActivity,
      expires_at: baselineExpiry,
    });
    expect(recordResourceMutation).toHaveBeenCalledTimes(1);

    await request(current.app)
      .post(`${basePath(fixture)}/begin`)
      .set("Origin", ORIGIN)
      .send(body)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          status: "ready",
          deduplicated: true,
          created: false,
        });
      });
    const readyRetry = current.context.db.prepare(`
      SELECT last_activity_at, expires_at
      FROM guest_rooms WHERE id = ?
    `).get(fixture.roomId) as {
      last_activity_at: string;
      expires_at: string;
    };
    expect(readyRetry).toEqual({
      last_activity_at: baselineActivity,
      expires_at: baselineExpiry,
    });
    expect(recordResourceMutation).toHaveBeenCalledTimes(1);
  });

  it("records one room mutation for concurrent finalize requests", async () => {
    const current = harness();
    const fixture = createGuestBoard(current.context);
    const value = await sharp({
      create: {
        width: 4,
        height: 3,
        channels: 4,
        background: { r: 110, g: 45, b: 190, alpha: 1 },
      },
    }).png().toBuffer();
    const body = beginBody(fixture, value);
    const started = await request(current.app)
      .post(`${basePath(fixture)}/begin`)
      .set("Origin", ORIGIN)
      .send(body)
      .expect(200);
    await request(current.app)
      .put(
        `${basePath(fixture)}/${body.assetId}`
        + `/uploads/${started.body.uploadId}/chunks`
        + `?boardId=${fixture.boardId}&generation=${fixture.generation}`,
      )
      .set("Origin", ORIGIN)
      .set("content-type", "application/octet-stream")
      .set("x-upload-offset", "0")
      .set("x-asset-chunk-sha256", hash(value))
      .send(value)
      .expect(200);
    const recordResourceMutation = vi.spyOn(
      current.context.guestRooms,
      "recordResourceMutation",
    );
    const finalizePath = `${basePath(fixture)}/${body.assetId}`
      + `/uploads/${started.body.uploadId}/finalize`;

    const responses = await Promise.all([
      request(current.app)
        .post(finalizePath)
        .set("Origin", ORIGIN)
        .send({ boardId: fixture.boardId, generation: fixture.generation }),
      request(current.app)
        .post(finalizePath)
        .set("Origin", ORIGIN)
        .send({ boardId: fixture.boardId, generation: fixture.generation }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses[0].body).toEqual(responses[1].body);
    expect(responses[0].body).toMatchObject({
      status: "ready",
      assetId: body.assetId,
    });
    expect(recordResourceMutation).toHaveBeenCalledTimes(1);
  });

  it("durably removes published and pending guest Board asset files after room expiry", async () => {
    const current = harness();
    const fixture = createGuestBoard(current.context);
    const publishedValue = await sharp({
      create: {
        width: 3,
        height: 2,
        channels: 4,
        background: { r: 90, g: 30, b: 150, alpha: 1 },
      },
    }).png().toBuffer();
    const publishedBody = beginBody(fixture, publishedValue);
    const publishedStarted = await request(current.app)
      .post(`${basePath(fixture)}/begin`)
      .set("Origin", ORIGIN)
      .send(publishedBody)
      .expect(200);
    await request(current.app)
      .put(
        `${basePath(fixture)}/${publishedBody.assetId}`
        + `/uploads/${publishedStarted.body.uploadId}/chunks`
        + `?boardId=${fixture.boardId}&generation=${fixture.generation}`,
      )
      .set("Origin", ORIGIN)
      .set("content-type", "application/octet-stream")
      .set("x-upload-offset", "0")
      .set("x-asset-chunk-sha256", hash(publishedValue))
      .send(publishedValue)
      .expect(200);
    await request(current.app)
      .post(
        `${basePath(fixture)}/${publishedBody.assetId}`
        + `/uploads/${publishedStarted.body.uploadId}/finalize`,
      )
      .set("Origin", ORIGIN)
      .send({
        boardId: fixture.boardId,
        generation: fixture.generation,
      })
      .expect(200);

    const pendingValue = Buffer.from("pending guest Board asset");
    const pendingBody = beginBody(fixture, pendingValue);
    const pendingStarted = await request(current.app)
      .post(`${basePath(fixture)}/begin`)
      .set("Origin", ORIGIN)
      .send(pendingBody)
      .expect(200);
    const published = current.context.db.prepare(`
      SELECT storage_key FROM board_asset_blobs
      WHERE tenant_id = ? AND sha256 = ?
    `).get(
      `guest-room-${fixture.roomId}`,
      publishedBody.sha256,
    ) as { storage_key: string };
    const pending = current.context.db.prepare(`
      SELECT staging_key FROM board_asset_uploads WHERE upload_id = ?
    `).get(pendingStarted.body.uploadId) as { staging_key: string };
    const publishedPath = path.join(
      current.dataDir,
      "private-board-assets",
      ...published.storage_key.split("/"),
    );
    const pendingPath = path.join(
      current.dataDir,
      "private-board-assets",
      ...pending.staging_key.split("/"),
    );
    expect(fs.existsSync(publishedPath)).toBe(true);
    expect(fs.existsSync(pendingPath)).toBe(true);

    current.context.db.prepare(`
      UPDATE guest_rooms SET expires_at = ? WHERE id = ?
    `).run("2000-01-01T00:00:00.000Z", fixture.roomId);
    expect(current.context.guestRooms.cleanupExpired().expiredRoomCount).toBe(1);
    expect(current.context.db.prepare(`
      SELECT count(*) AS count FROM board_asset_blobs
      WHERE tenant_id = ?
    `).get(`guest-room-${fixture.roomId}`)).toEqual({ count: 0 });
    expect(current.context.db.prepare(`
      SELECT count(*) AS count FROM board_asset_uploads
      WHERE board_id = ?
    `).get(fixture.boardId)).toEqual({ count: 0 });
    const queued = current.context.db.prepare(`
      SELECT storage_key FROM board_asset_gc_queue ORDER BY storage_key
    `).all() as Array<{ storage_key: string }>;
    expect(queued).toEqual(expect.arrayContaining([
      { storage_key: published.storage_key },
      { storage_key: pending.staging_key },
    ]));
    expect(fs.existsSync(publishedPath)).toBe(true);
    expect(fs.existsSync(pendingPath)).toBe(true);

    await expect(current.context.boardAssets!.cleanupGarbage()).resolves
      .toMatchObject({ failed: 0 });
    expect(fs.existsSync(publishedPath)).toBe(false);
    expect(fs.existsSync(pendingPath)).toBe(false);
    expect(current.context.db.prepare("SELECT * FROM board_asset_gc_queue").all())
      .toEqual([]);
    await expect(current.context.boardAssets!.cleanupGarbage()).resolves.toEqual({
      deleted: 0,
      failed: 0,
    });
  });

  it("does not allow one share capability to address another room's Board", async () => {
    const current = harness();
    const first = createGuestBoard(current.context);
    const second = createGuestBoard(current.context);
    const value = Uint8Array.of(1, 2, 3, 4);
    const body = beginBody(second, value);
    await request(current.app)
      .post(`${basePath(second)}/begin`)
      .set("Origin", ORIGIN)
      .send(body)
      .expect(200);

    await request(current.app)
      .get(
        `${basePath(first)}/${body.assetId}/status`
        + `?boardId=${second.boardId}&generation=${second.generation}`,
      )
      .set("Origin", ORIGIN)
      .expect(404);
    await request(current.app)
      .post(`${basePath(first)}/begin`)
      .set("Origin", ORIGIN)
      .send({ ...body, assetId: randomUUID() })
      .expect(404);
    expect(current.context.db.prepare(`
      SELECT count(*) AS count FROM board_assets WHERE board_id = ?
    `).get(second.boardId)).toEqual({ count: 1 });
  });

  it("rejects reads and mutations after the guest room expires", async () => {
    const current = harness();
    const fixture = createGuestBoard(current.context);
    const value = Uint8Array.of(5, 6, 7, 8);
    const body = beginBody(fixture, value);
    await request(current.app)
      .post(`${basePath(fixture)}/begin`)
      .set("Origin", ORIGIN)
      .send(body)
      .expect(200);
    current.context.db.prepare(`
      UPDATE guest_rooms SET expires_at = ? WHERE id = ?
    `).run("2000-01-01T00:00:00.000Z", fixture.roomId);

    await request(current.app)
      .get(
        `${basePath(fixture)}/${body.assetId}/status`
        + `?boardId=${fixture.boardId}&generation=${fixture.generation}`,
      )
      .set("Origin", ORIGIN)
      .expect(410)
      .expect((response) => {
        expect(response.body.code).toBe("ROOM_EXPIRED");
      });
    await request(current.app)
      .post(`${basePath(fixture)}/begin`)
      .set("Origin", ORIGIN)
      .send({ ...body, assetId: randomUUID() })
      .expect(410);
    expect(current.context.db.prepare(`
      SELECT count(*) AS count FROM boards WHERE id = ?
    `).get(fixture.boardId)).toEqual({ count: 0 });
  });

  it("returns ROOM_EXPIRED when cleanup cascades during a slow image decode", async () => {
    const current = harness();
    const fixture = createGuestBoard(current.context);
    const value = await sharp({
      create: {
        width: 4,
        height: 3,
        channels: 4,
        background: { r: 40, g: 80, b: 120, alpha: 1 },
      },
    }).png().toBuffer();
    const body = beginBody(fixture, value);
    const started = await request(current.app)
      .post(`${basePath(fixture)}/begin`)
      .set("Origin", ORIGIN)
      .send(body)
      .expect(200);
    await request(current.app)
      .put(
        `${basePath(fixture)}/${body.assetId}`
        + `/uploads/${started.body.uploadId}/chunks`
        + `?boardId=${fixture.boardId}&generation=${fixture.generation}`,
      )
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/octet-stream")
      .set("x-upload-offset", "0")
      .set("x-asset-chunk-sha256", hash(value))
      .send(value)
      .expect(200);
    const upload = current.context.db.prepare(`
      SELECT staging_key FROM board_asset_uploads WHERE upload_id = ?
    `).get(started.body.uploadId) as { staging_key: string };
    let markDecodeStarted!: () => void;
    let resolveDecode!: (value: DecodedAssetInfo) => void;
    const decodeStarted = new Promise<void>((resolve) => {
      markDecodeStarted = resolve;
    });
    const decoded = new Promise<DecodedAssetInfo>((resolve) => {
      resolveDecode = resolve;
    });
    const controlledDecode: AssetDecodeProbe = async () => {
      markDecodeStarted();
      return await decoded;
    };
    (current.context.boardAssets as unknown as { decode: AssetDecodeProbe }).decode = controlledDecode;
    const recordResourceMutation = vi.spyOn(
      current.context.guestRooms,
      "recordResourceMutation",
    );

    const finalizing = request(current.app)
      .post(
        `${basePath(fixture)}/${body.assetId}`
        + `/uploads/${started.body.uploadId}/finalize`,
      )
      .set("Origin", ORIGIN)
      .send({ boardId: fixture.boardId, generation: fixture.generation })
      .then((response) => response);
    await decodeStarted;
    current.context.db.prepare(`
      UPDATE guest_rooms SET expires_at = ? WHERE id = ?
    `).run("2000-01-01T00:00:00.000Z", fixture.roomId);
    expect(current.context.guestRooms.cleanupExpired().expiredRoomCount).toBe(1);
    resolveDecode({
      fullyDecoded: true,
      width: 4,
      height: 3,
      frameCount: 1,
      totalDecodedPixels: 12,
    });

    const finalized = await finalizing;
    expect(finalized.status).toBe(410);
    expect(finalized.body.code).toBe("ROOM_EXPIRED");
    expect(recordResourceMutation).not.toHaveBeenCalled();
    expect(current.context.db.prepare(`
      SELECT count(*) AS count FROM board_assets WHERE asset_id = ?
    `).get(body.assetId)).toEqual({ count: 0 });
    expect(current.context.db.prepare(`
      SELECT count(*) AS count FROM board_asset_blobs
    `).get()).toEqual({ count: 0 });
    expect(current.context.db.prepare(`
      SELECT storage_key FROM board_asset_gc_queue WHERE storage_key = ?
    `).get(upload.staging_key)).toEqual({ storage_key: upload.staging_key });
    await expect(current.context.boardAssets!.cleanupGarbage()).resolves.toEqual({
      deleted: 1,
      failed: 0,
    });
  });

  it("requires an allowed Origin before accepting the share capability", async () => {
    const current = harness();
    const fixture = createGuestBoard(current.context);
    const body = beginBody(fixture, Uint8Array.of(1, 2, 3));
    await request(current.app)
      .post(`${basePath(fixture)}/begin`)
      .send(body)
      .expect(403);
    await request(current.app)
      .post(`${basePath(fixture)}/begin`)
      .set("Origin", "http://attacker.test")
      .send(body)
      .expect(403);
    expect(current.context.db.prepare(`
      SELECT count(*) AS count FROM board_assets WHERE board_id = ?
    `).get(fixture.boardId)).toEqual({ count: 0 });
  });
});
