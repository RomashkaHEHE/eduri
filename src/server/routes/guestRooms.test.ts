import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { TokenVerifier } from "livekit-server-sdk";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPageObjects } from "../../board/core/index.js";
import {
  BoardMessageType,
} from "../../board/protocol/index.js";
import { createApp, getAppContext } from "../app.js";
import type { BoardSyncTicketResponse } from "../board-v2/sync-service.js";
import {
  LIVEKIT_CALL_ROOM_OPTIONS,
  type LiveKitRoomService,
} from "../livekit.js";
import { GuestRoomService } from "../guestRooms.js";
import { guestRoomCreationLimit } from "./guestRooms.js";

const roots: string[] = [];

function harness(options: {
  liveKit?: boolean;
  dataDir?: string;
  liveKitRoomService?: LiveKitRoomService;
  nodeEnv?: "development" | "test";
} = {}) {
  const dataDir = options.dataDir
    ?? fs.mkdtempSync(path.join(os.tmpdir(), "eduri-guest-room-"));
  if (!roots.includes(dataDir)) roots.push(dataDir);
  const app = createApp({
    config: {
      nodeEnv: options.nodeEnv ?? "test",
      appOrigins: ["http://eduri.test"],
      dataDir,
      databasePath: path.join(dataDir, "test.sqlite"),
      uploadDir: path.join(dataDir, "uploads"),
      authLookupKey: "guest-room-test-key-at-least-32-bytes",
      adminPassword: "test-admin-password",
      ...(options.liveKit ? {
        livekitUrl: "ws://127.0.0.1:7880",
        livekitApiKey: "guest-room-test-api-key",
        livekitApiSecret: "guest-room-test-api-secret-at-least-32-bytes",
      } : {}),
    },
    livekitRoomService: options.liveKitRoomService ?? (options.liveKit ? {
      createRoom: async () => undefined,
      listRooms: async () => [],
      deleteRoom: async () => undefined,
      removeParticipant: async () => undefined,
    } : undefined),
  });
  return { app, context: getAppContext(app) };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("guest room HTTP API", () => {
  it("keeps the public creation throttle only in production", () => {
    expect(guestRoomCreationLimit("production")).toBe(5);
    expect(guestRoomCreationLimit("development")).toBe(10_000);
    expect(guestRoomCreationLimit("test")).toBe(10_000);
  });

  it("does not apply the production creation throttle during local development", async () => {
    const { app, context } = harness({ nodeEnv: "development" });
    for (let index = 0; index < 6; index += 1) {
      await request(app)
        .post("/api/guest/rooms")
        .set("Origin", "http://eduri.test")
        .send({ initialResource: "code", draft: true })
        .expect(201);
    }
    context.stopGuestRoomMaintenance?.();
    context.db.close();
  });

  it("returns a retryable response when persistent guest capacity is full", async () => {
    const { app, context } = harness();
    context.guestRooms = new GuestRoomService(
      context.db,
      Date.now,
      () => undefined,
      { maxActiveRooms: 1, maxActiveCallResources: 1 },
    );
    await request(app)
      .post("/api/guest/rooms")
      .set("Origin", "http://eduri.test")
      .send({ initialResource: "board" })
      .expect(201);
    await request(app)
      .post("/api/guest/rooms")
      .set("Origin", "http://eduri.test")
      .send({ initialResource: "code" })
      .expect(503)
      .expect("Cache-Control", "no-store")
      .expect((response) => {
        expect(response.body.code).toBe("GUEST_CAPACITY_REACHED");
        expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
        expect(Number(response.headers["retry-after"]))
          .toBeLessThanOrEqual(48 * 60 * 60);
      });
    context.stopGuestRoomMaintenance?.();
    context.db.close();
  });

  it("creates, reads, and links all three public resource kinds", async () => {
    const { app, context } = harness();
    const created = await request(app)
      .post("/api/guest/rooms")
      .set("Origin", "http://eduri.test")
      .send({ initialResource: "board" })
      .expect(201)
      .expect("Cache-Control", "no-store");
    const shareId = created.body.room.shareId as string;
    expect(created.body.room.resources).toEqual([
      expect.objectContaining({
        kind: "board",
        url: `/room/${shareId}/board`,
      }),
    ]);

    await request(app)
      .get(`/api/guest/rooms/${shareId}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.room.lastActivityAt)
          .toBe(created.body.room.lastActivityAt);
      });
    await request(app)
      .put(`/api/guest/rooms/${shareId}/resources/code`)
      .set("Origin", "http://eduri.test")
      .expect(201);
    const call = await request(app)
      .put(`/api/guest/rooms/${shareId}/resources/call`)
      .set("Origin", "http://eduri.test")
      .expect(201);
    expect(call.body.room.resources.map((resource: { kind: string }) => resource.kind))
      .toEqual(["board", "call", "code"]);
    await request(app)
      .put(`/api/guest/rooms/${shareId}/resources/call`)
      .set("Origin", "http://eduri.test")
      .expect(200)
      .expect((response) => expect(response.body.created).toBe(false));
    context.stopGuestRoomMaintenance?.();
    context.db.close();
  });

  it("finalizes or cancels a promotion draft only with its private token", async () => {
    const { app, context } = harness();
    const draft = await request(app)
      .post("/api/guest/rooms")
      .set("Origin", "http://eduri.test")
      .send({ initialResource: "board", draft: true })
      .expect(201);
    const shareId = draft.body.room.shareId as string;
    const initializationToken = draft.body.initializationToken as string;
    expect(initializationToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(draft.body.room)).not.toContain(initializationToken);

    await request(app)
      .post(`/api/guest/rooms/${shareId}/board-ticket`)
      .set("Origin", "http://eduri.test")
      .send({
        deviceId: "a".repeat(32),
        profile: { displayName: "Guest\nAdmin", color: "#abcdef" },
      })
      .expect(400);

    const ticketResponse = await request(app)
      .post(`/api/guest/rooms/${shareId}/board-ticket`)
      .set("Origin", "http://eduri.test")
      .send({
        deviceId: "a".repeat(32),
        minSchemaVersion: 1,
        maxSchemaVersion: 1,
        capabilities: 0xffff_ffff,
        profile: {
          displayName: "  Guest   Alias ",
          color: "#A1B2C3",
        },
      })
      .expect(200);
    const ticket = ticketResponse.body as BoardSyncTicketResponse;
    const boardSync = context.boardV2Sync!;
    const authenticated = boardSync.authenticate({
      type: BoardMessageType.AUTH,
      ticket: ticket.ticket,
      generation: ticket.generation,
      minSchemaVersion: 1,
      maxSchemaVersion: 1,
      capabilities: ticket.capabilities,
    });
    expect(authenticated.access.userId)
      .toMatch(/^guest_[A-Za-z0-9_-]{43}$/u);
    expect(authenticated.access).toMatchObject({
      displayName: "Guest Alias",
      color: "#a1b2c3",
    });

    const guestReplica = new Y.Doc();
    Y.applyUpdate(
      guestReplica,
      boardSync.missingUpdate(
        authenticated.access,
        ticket.defaultPageDocKey,
        Y.encodeStateVector(guestReplica),
      ),
    );
    const baseline = Y.encodeStateVector(guestReplica);
    getPageObjects(guestReplica).set(randomUUID(), new Y.Map());
    const append = boardSync.appendUpdate(
      authenticated.access,
      authenticated.access.userId,
      ticket.defaultPageDocKey,
      randomUUID(),
      Y.encodeStateAsUpdate(guestReplica, baseline),
    );
    expect(append).toMatchObject({ duplicate: false });
    expect(context.db.prepare(`
      SELECT actor_id, client_id
      FROM board_updates
      WHERE board_id = ?
    `).get(ticket.boardId)).toEqual({
      actor_id: authenticated.access.userId,
      client_id: authenticated.access.userId,
    });
    guestReplica.destroy();
    expect(context.db.prepare("SELECT count(*) AS count FROM boards").get())
      .toEqual({ count: 1 });

    await request(app)
      .delete(`/api/guest/rooms/${shareId}/initialization`)
      .set("Origin", "http://eduri.test")
      .send({ initializationToken: "x".repeat(43) })
      .expect(404);
    await request(app)
      .get(`/api/guest/rooms/${shareId}`)
      .expect(200);

    await request(app)
      .delete(`/api/guest/rooms/${shareId}/initialization`)
      .set("Origin", "http://eduri.test")
      .send({ initializationToken })
      .expect(200)
      .expect({ cancelled: true });
    await request(app)
      .get(`/api/guest/rooms/${shareId}`)
      .expect(404);
    expect(context.db.prepare("SELECT count(*) AS count FROM boards").get())
      .toEqual({ count: 0 });

    const second = await request(app)
      .post("/api/guest/rooms")
      .set("Origin", "http://eduri.test")
      .send({ initialResource: "code", draft: true })
      .expect(201);
    const secondShareId = second.body.room.shareId as string;
    const secondToken = second.body.initializationToken as string;
    await request(app)
      .post(`/api/guest/rooms/${secondShareId}/initialization/finalize`)
      .set("Origin", "http://eduri.test")
      .send({ initializationToken: secondToken })
      .expect(200);
    await request(app)
      .post(`/api/guest/rooms/${secondShareId}/initialization/finalize`)
      .set("Origin", "http://eduri.test")
      .send({ initializationToken: secondToken })
      .expect(200);
    await request(app)
      .delete(`/api/guest/rooms/${secondShareId}/initialization`)
      .set("Origin", "http://eduri.test")
      .send({ initializationToken: secondToken })
      .expect(409)
      .expect((response) => {
        expect(response.body.code).toBe("ROOM_ALREADY_INITIALIZED");
      });
    await request(app)
      .get(`/api/guest/rooms/${secondShareId}`)
      .expect(200);

    context.stopGuestRoomMaintenance?.();
    context.db.close();
  });

  it("returns a terminal response for an expired share link", async () => {
    const { app, context } = harness();
    const created = await request(app)
      .post("/api/guest/rooms")
      .set("Origin", "http://eduri.test")
      .send({ initialResource: "code" })
      .expect(201);
    const shareId = created.body.room.shareId as string;
    context.db.prepare(`
      UPDATE guest_rooms SET expires_at = ? WHERE share_key = ?
    `).run("2000-01-01T00:00:00.000Z", shareId);

    await request(app)
      .get(`/api/guest/rooms/${shareId}`)
      .expect(410)
      .expect({ code: "ROOM_EXPIRED", error: "Сеанс завершён" });
    expect(context.db.prepare("SELECT count(*) AS count FROM guest_room_resources").get())
      .toEqual({ count: 0 });
    context.stopGuestRoomMaintenance?.();
    context.db.close();
  });

  it("does not extend room activity when it only issues a call token", async () => {
    const createRoom = vi.fn(async () => undefined);
    let expectedParticipantIdentity = "";
    const updateParticipant = vi.fn(async (
      _room: string,
      identity: string,
    ) => {
      if (expectedParticipantIdentity && identity !== expectedParticipantIdentity) {
        throw { status: 404 };
      }
    });
    const { app, context } = harness({
      liveKit: true,
      liveKitRoomService: {
        createRoom,
        listRooms: async () => [],
        deleteRoom: async () => undefined,
        removeParticipant: async () => undefined,
        updateParticipant,
      },
    });
    const created = await request(app)
      .post("/api/guest/rooms")
      .set("Origin", "http://eduri.test")
      .send({ initialResource: "call" })
      .expect(201);
    const shareId = created.body.room.shareId as string;
    const baseline = {
      updatedAt: "2026-08-09T08:00:00.000Z",
      lastActivityAt: "2026-08-09T08:00:00.000Z",
      expiresAt: "2030-08-09T08:00:00.000Z",
    };
    context.db.prepare(`
      UPDATE guest_rooms
      SET updated_at = ?, last_activity_at = ?, expires_at = ?
      WHERE share_key = ?
    `).run(
      baseline.updatedAt,
      baseline.lastActivityAt,
      baseline.expiresAt,
      shareId,
    );
    context.db.prepare(`
      UPDATE guest_room_resources
      SET last_activity_at = ?
      WHERE room_id = (SELECT id FROM guest_rooms WHERE share_key = ?)
        AND kind = 'call'
    `).run(baseline.lastActivityAt, shareId);
    const call = context.db.prepare(`
      SELECT resource_key
      FROM guest_room_resources
      WHERE room_id = (SELECT id FROM guest_rooms WHERE share_key = ?)
        AND kind = 'call'
    `).get(shareId) as { resource_key: string };

    const tokenResponse = await request(app)
      .post(`/api/guest/rooms/${shareId}/call-token`)
      .set("Origin", "http://eduri.test")
      .send({
        deviceId: "c".repeat(32),
        profile: { displayName: "  Guest   Alias ", color: "#ABCDEF" },
      })
      .expect(200)
      .expect((response) => {
        expect(response.body.roomName)
          .toBe(`eduri-guest-${call.resource_key}`);
        expect(response.body.token).toEqual(expect.any(String));
      });

    const claims = await new TokenVerifier(
      "guest-room-test-api-key",
      "guest-room-test-api-secret-at-least-32-bytes",
    ).verify(tokenResponse.body.token);
    expect(claims).toMatchObject({
      sub: expect.stringMatching(/^guest:[A-Za-z0-9_-]{43}$/u),
      name: "Guest Alias",
      attributes: {
        "eduri.role": "guest",
        "eduri.color": "#abcdef",
      },
    });
    expect(claims.video).toMatchObject({
      room: `eduri-guest-${call.resource_key}`,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      canPublishSources: [
        "camera",
        "microphone",
        "screen_share",
        "screen_share_audio",
      ],
      canUpdateOwnMetadata: false,
    });
    expect(claims.video).not.toHaveProperty("roomCreate");
    expect(claims.video).not.toHaveProperty("roomAdmin");
    expectedParticipantIdentity = String(claims.sub);

    await request(app)
      .patch(`/api/guest/rooms/${shareId}/call-profile`)
      .set("Origin", "http://eduri.test")
      .send({
        deviceId: "c".repeat(32),
        profile: { displayName: "Updated guest", color: "#D33F49" },
      })
      .expect(204)
      .expect("Cache-Control", "no-store");
    expect(updateParticipant).toHaveBeenCalledWith(
      `eduri-guest-${call.resource_key}`,
      claims.sub,
      {
        name: "Updated guest",
        attributes: { "eduri.color": "#d33f49" },
      },
    );

    await request(app)
      .patch(`/api/guest/rooms/${shareId}/call-profile`)
      .set("Origin", "http://eduri.test")
      .send({
        deviceId: "d".repeat(32),
        profile: { displayName: "Spoofed guest", color: "#2563eb" },
      })
      .expect(409)
      .expect((response) => {
        expect(response.body.code).toBe("CALL_PARTICIPANT_NOT_CONNECTED");
      });
    expect(updateParticipant.mock.calls[1]?.[1]).not.toBe(claims.sub);

    await request(app)
      .patch(`/api/guest/rooms/${shareId}/call-profile`)
      .set("Origin", "http://eduri.test")
      .send({
        deviceId: "c".repeat(32),
        identity: claims.sub,
        profile: { displayName: "Injected identity", color: "#2563eb" },
      })
      .expect(400);

    expect(createRoom).toHaveBeenCalledWith({
      name: `eduri-guest-${call.resource_key}`,
      ...LIVEKIT_CALL_ROOM_OPTIONS,
    });

    const after = context.db.prepare(`
      SELECT
        room.updated_at AS updatedAt,
        room.last_activity_at AS lastActivityAt,
        room.expires_at AS expiresAt,
        resource.last_activity_at AS resourceLastActivityAt
      FROM guest_rooms room
      JOIN guest_room_resources resource ON resource.room_id = room.id
      WHERE room.share_key = ? AND resource.kind = 'call'
    `).get(shareId) as typeof baseline & { resourceLastActivityAt: string };
    expect(after).toMatchObject({
      ...baseline,
    });
    expect(Date.parse(after.resourceLastActivityAt))
      .toBeGreaterThan(Date.parse(baseline.lastActivityAt));
    context.stopGuestRoomMaintenance?.();
    context.db.close();
  });

  it("retains a bounded lease after ambiguous provisioning failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let failProvisioning = true;
    const { app, context } = harness({
      liveKit: true,
      liveKitRoomService: {
        createRoom: async () => {
          if (failProvisioning) throw new Error("simulated LiveKit outage");
        },
        listRooms: async () => [],
        deleteRoom: async () => undefined,
        removeParticipant: async () => undefined,
      },
    });
    context.guestRooms = new GuestRoomService(
      context.db,
      Date.now,
      () => undefined,
      { maxActiveRooms: 10, maxActiveCallResources: 1 },
    );
    const first = await request(app)
      .post("/api/guest/rooms")
      .set("Origin", "http://eduri.test")
      .send({ initialResource: "call" })
      .expect(201);
    const second = await request(app)
      .post("/api/guest/rooms")
      .set("Origin", "http://eduri.test")
      .send({ initialResource: "call" })
      .expect(201);

    await request(app)
      .post(`/api/guest/rooms/${first.body.room.shareId}/call-token`)
      .set("Origin", "http://eduri.test")
      .send({})
      .expect(503);
    const reservation = context.db.prepare(`
      SELECT last_activity_at
      FROM guest_room_resources
      WHERE room_id = (SELECT id FROM guest_rooms WHERE share_key = ?)
        AND kind = 'call'
    `).get(first.body.room.shareId) as { last_activity_at: string };
    expect(reservation.last_activity_at)
      .not.toBe("1970-01-01T00:00:00.000Z");

    failProvisioning = false;
    await request(app)
      .post(`/api/guest/rooms/${second.body.room.shareId}/call-token`)
      .set("Origin", "http://eduri.test")
      .send({})
      .expect(503)
      .expect((response) => {
        expect(response.body.code).toBe("GUEST_CAPACITY_REACHED");
      });
    await request(app)
      .post(`/api/guest/rooms/${first.body.room.shareId}/call-token`)
      .set("Origin", "http://eduri.test")
      .send({})
      .expect(200);
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
    context.stopGuestRoomMaintenance?.();
    context.db.close();
  });

  it("rejects public room mutations without an allowed Origin", async () => {
    const { app, context } = harness();
    await request(app)
      .post("/api/guest/rooms")
      .send({ initialResource: "board" })
      .expect(403);
    await request(app)
      .post("/api/guest/rooms")
      .set("Origin", "https://attacker.example")
      .send({ initialResource: "board" })
      .expect(403);
    expect(context.db.prepare("SELECT count(*) AS count FROM guest_rooms").get())
      .toEqual({ count: 0 });
    context.stopGuestRoomMaintenance?.();
    context.db.close();
  });

  it("polls LiveKit before startup cleanup and renews an occupied late call", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-guest-room-"));
    const seeded = harness({ dataDir });
    const room = seeded.context.guestRooms.create("call");
    seeded.context.guestRooms.activateCall(room.id, room.resources[0].id);
    const roomName = `eduri-guest-${room.resources[0].resourceKey}`;
    seeded.context.db.prepare(`
      UPDATE guest_rooms SET expires_at = ? WHERE id = ?
    `).run(new Date(Date.now() - 30_000).toISOString(), room.id);
    seeded.context.stopGuestRoomMaintenance?.();
    seeded.context.stopBoardAssetMaintenance?.();
    seeded.context.db.close();

    const listed: string[][] = [];
    const restarted = harness({
      dataDir,
      liveKitRoomService: {
        createRoom: async () => undefined,
        listRooms: async (names: string[] = []) => {
          listed.push(names);
          return [{ name: roomName, numParticipants: 1 }];
        },
        deleteRoom: async () => undefined,
        removeParticipant: async () => undefined,
      },
    });
    await restarted.context.runGuestRoomMaintenance?.();

    expect(listed).toEqual([[roomName]]);
    const renewed = restarted.context.db.prepare(`
      SELECT expires_at FROM guest_rooms WHERE id = ?
    `).get(room.id) as { expires_at: string };
    expect(Date.parse(renewed.expires_at)).toBeGreaterThan(
      Date.now() + 47 * 60 * 60 * 1000,
    );
    restarted.context.stopGuestRoomMaintenance?.();
    restarted.context.stopBoardAssetMaintenance?.();
    restarted.context.db.close();
  });

  it("polls occupied calls and deletes their stable LiveKit room on expiry", async () => {
    const { context } = harness();
    const room = context.guestRooms.create("call");
    const call = room.resources[0];
    context.guestRooms.activateCall(room.id, call.id);
    const roomName = `eduri-guest-${call.resourceKey}`;
    const listed: string[][] = [];
    const deleted: string[] = [];
    context.livekitRoomService = {
      createRoom: async () => undefined,
      listRooms: async (names: string[] = []) => {
        listed.push(names);
        return [{ name: roomName, numParticipants: 1 }];
      },
      deleteRoom: async (name) => { deleted.push(name); },
      removeParticipant: async () => undefined,
    };
    const shortExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    context.db.prepare(`
      UPDATE guest_rooms SET expires_at = ? WHERE id = ?
    `).run(shortExpiry, room.id);

    await context.runGuestRoomMaintenance?.();
    expect(listed).toEqual([[roomName]]);
    const renewed = context.db.prepare(`
      SELECT expires_at FROM guest_rooms WHERE id = ?
    `).get(room.id) as { expires_at: string };
    expect(Date.parse(renewed.expires_at)).toBeGreaterThan(
      Date.now() + 47 * 60 * 60 * 1000,
    );

    context.db.prepare(`
      UPDATE guest_rooms SET expires_at = ? WHERE id = ?
    `).run("2000-01-01T00:00:00.000Z", room.id);
    await context.runGuestRoomMaintenance?.();
    await Promise.resolve();
    expect(deleted).toEqual([roomName]);
    expect(context.db.prepare("SELECT count(*) AS count FROM guest_rooms").get())
      .toEqual({ count: 0 });
    context.stopGuestRoomMaintenance?.();
    context.db.close();
  });
});
