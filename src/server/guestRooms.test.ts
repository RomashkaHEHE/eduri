import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "./db.js";
import {
  GUEST_CALL_PRESENCE_CONFIRMATION_GRACE_MS,
  GUEST_CALL_PROVISIONAL_LEASE_MS,
  GUEST_ROOM_IDLE_TTL_MS,
  GUEST_ROOM_INITIALIZATION_TTL_MS,
  GUEST_ROOM_TOMBSTONE_TTL_MS,
  GuestRoomCapacityError,
  GuestRoomService,
  guestCallRoomName,
} from "./guestRooms.js";
import { pollGuestCallPresence } from "./livekit.js";
import { processLiveKitRoomRevocations } from "./livekit-revocation.js";

describe("GuestRoomService", () => {
  let db: Database.Database;
  let now: number;
  let service: GuestRoomService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    now = Date.parse("2026-08-09T08:00:00.000Z");
    service = new GuestRoomService(db, () => now);
  });

  afterEach(() => db.close());

  it("creates one public resource and does not count room reads as activity", () => {
    const created = service.create("board");
    expect(created.shareKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.resources.map((resource) => resource.kind)).toEqual(["board"]);
    expect(Date.parse(created.expiresAt) - now).toBe(GUEST_ROOM_IDLE_TTL_MS);

    now += 12 * 60 * 60 * 1000;
    const lookup = service.lookup(created.shareKey);
    expect(lookup.status).toBe("active");
    if (lookup.status !== "active") return;
    expect(lookup.room.lastActivityAt).toBe(created.lastActivityAt);
    expect(lookup.room.expiresAt).toBe(created.expiresAt);
  });

  it("persists global room and call admission caps across service instances", () => {
    service = new GuestRoomService(
      db,
      () => now,
      () => undefined,
      { maxActiveRooms: 2, maxActiveCallResources: 1 },
    );
    const callRoom = service.create("call");
    const boardRoom = service.create("board");
    const callResource = callRoom.resources[0];
    expect(service.activateCall(callRoom.id, callResource.id)).toMatchObject({
      newlyReserved: true,
    });

    expect(() => service.create("code")).toThrow(GuestRoomCapacityError);
    const linked = service.ensureResource(boardRoom.shareKey, "call");
    expect("created" in linked && linked.created).toBe(true);
    if (!("created" in linked)) return;
    const secondCall = linked.room.resources.find((resource) => (
      resource.kind === "call"
    ))!;
    expect(() => service.activateCall(boardRoom.id, secondCall.id))
      .toThrow(/guest-call capacity/iu);

    const restarted = new GuestRoomService(
      db,
      () => now,
      () => undefined,
      { maxActiveRooms: 2, maxActiveCallResources: 1 },
    );
    expect(() => restarted.create("board")).toThrow(/guest-room capacity/iu);
    expect(() => restarted.activateCall(boardRoom.id, secondCall.id))
      .toThrow(/guest-call capacity/iu);

    now += GUEST_CALL_PROVISIONAL_LEASE_MS + 1;
    expect(restarted.activateCall(boardRoom.id, secondCall.id)).toMatchObject({
      newlyReserved: true,
    });

    now += GUEST_ROOM_IDLE_TTL_MS + 1;
    restarted.cleanupExpired({
      confirmedEmptyCallRoomIds: [callRoom.id],
    });
    expect(() => restarted.create("call")).not.toThrow();
  });

  it("does not let seven independent room creations hold call capacity", () => {
    service = new GuestRoomService(
      db,
      () => now,
      () => undefined,
      { maxActiveRooms: 10, maxActiveCallResources: 1 },
    );
    const rooms = Array.from({ length: 7 }, () => service.create("call"));
    expect(rooms).toHaveLength(7);
    expect(rooms.every((room) => (
      room.resources[0].lastActivityAt === "1970-01-01T00:00:00.000Z"
    ))).toBe(true);

    expect(service.activateCall(
      rooms[0].id,
      rooms[0].resources[0].id,
    )).toMatchObject({ newlyReserved: true });
    let capacityError: unknown;
    try {
      service.activateCall(rooms[1].id, rooms[1].resources[0].id);
    } catch (error) {
      capacityError = error;
    }
    expect(capacityError).toBeInstanceOf(GuestRoomCapacityError);
    expect((capacityError as GuestRoomCapacityError).retryAfterMs)
      .toBe(GUEST_CALL_PROVISIONAL_LEASE_MS);

    const restarted = new GuestRoomService(
      db,
      () => now,
      () => undefined,
      { maxActiveRooms: 10, maxActiveCallResources: 1 },
    );
    expect(() => restarted.activateCall(
      rooms[1].id,
      rooms[1].resources[0].id,
    )).toThrow(GuestRoomCapacityError);

    now += GUEST_CALL_PROVISIONAL_LEASE_MS;
    expect(restarted.releaseExpiredCallActivations([
      rooms[0].resources[0].id,
    ])).toEqual([
      guestCallRoomName(rooms[0].resources[0].resourceKey),
    ]);
    expect(restarted.activateCall(
      rooms[1].id,
      rooms[1].resources[0].id,
    )).toMatchObject({ newlyReserved: true });
  });

  it("does not let repeated token activations extend a provisional lease", () => {
    service = new GuestRoomService(
      db,
      () => now,
      () => undefined,
      { maxActiveRooms: 3, maxActiveCallResources: 1 },
    );
    const first = service.create("call");
    const second = service.create("call");
    const activatedAt = new Date(now).toISOString();
    expect(service.activateCall(first.id, first.resources[0].id)).toEqual({
      roomId: first.id,
      resourceId: first.resources[0].id,
      roomName: guestCallRoomName(first.resources[0].resourceKey),
      activatedAt,
      newlyReserved: true,
    });

    now += GUEST_CALL_PROVISIONAL_LEASE_MS - 1_000;
    expect(service.activateCall(first.id, first.resources[0].id)).toEqual({
      roomId: first.id,
      resourceId: first.resources[0].id,
      roomName: guestCallRoomName(first.resources[0].resourceKey),
      activatedAt,
      newlyReserved: false,
    });
    expect(() => service.activateCall(second.id, second.resources[0].id))
      .toThrow(GuestRoomCapacityError);

    now += 1_001;
    expect(service.activateCall(second.id, second.resources[0].id)).toMatchObject({
      newlyReserved: true,
    });
  });

  it("queues and rotates an abandoned provisional room before releasing capacity", async () => {
    const room = service.create("call");
    const call = room.resources[0];
    const firstActivation = service.activateCall(room.id, call.id);
    expect(firstActivation).not.toBeNull();
    const oldRoomName = firstActivation!.roomName;
    now += GUEST_CALL_PROVISIONAL_LEASE_MS;

    await expect(pollGuestCallPresence(service, {
      createRoom: async () => undefined,
      listRooms: async () => [],
      deleteRoom: async () => undefined,
      removeParticipant: async () => undefined,
    })).resolves.toBe(0);

    expect(db.prepare(`
      SELECT room_name FROM livekit_room_revocation_outbox
    `).get()).toEqual({ room_name: oldRoomName });
    const nextActivation = service.activateCall(room.id, call.id);
    expect(nextActivation).not.toBeNull();
    expect(nextActivation!.newlyReserved).toBe(true);
    expect(nextActivation!.roomName).not.toBe(oldRoomName);

    const deleted: string[] = [];
    await processLiveKitRoomRevocations(db, {
      deleteRoom: async (roomName) => {
        deleted.push(roomName);
      },
    }, { now });
    expect(deleted).toEqual([oldRoomName]);
    expect(nextActivation!.roomName).not.toBe(deleted[0]);
  });

  it("finalizes a promotion draft idempotently and cannot cancel it afterward", () => {
    const draft = service.createDraft("code");
    expect(draft.initializationToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(service.finalizeDraft(
      draft.room.shareKey,
      "x".repeat(43),
    )).toEqual({ status: "forbidden" });

    const finalized = service.finalizeDraft(
      draft.room.shareKey,
      draft.initializationToken,
    );
    expect(finalized).toMatchObject({
      status: "active",
      room: { shareKey: draft.room.shareKey },
    });
    expect(service.finalizeDraft(
      draft.room.shareKey,
      draft.initializationToken,
    )).toMatchObject({ status: "active" });
    expect(service.cancelDraft(
      draft.room.shareKey,
      draft.initializationToken,
    )).toEqual({ status: "already-finalized" });
    expect(service.lookup(draft.room.shareKey).status).toBe("active");
  });

  it("cancels an unfinished promotion and cascades all resource rows", () => {
    const draft = service.createDraft("board");
    const added = service.ensureResource(draft.room.shareKey, "code");
    expect("created" in added && added.created).toBe(true);

    expect(service.cancelDraft(
      draft.room.shareKey,
      draft.initializationToken,
    )).toEqual({ status: "cancelled" });
    expect(service.lookup(draft.room.shareKey)).toEqual({ status: "missing" });
    expect(db.prepare("SELECT count(*) AS count FROM guest_rooms").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM guest_room_resources").get())
      .toEqual({ count: 0 });
  });

  it("expires an unfinished promotion lease long before the room idle TTL", () => {
    const draft = service.createDraft("board");
    now += GUEST_ROOM_INITIALIZATION_TTL_MS;

    expect(service.lookup(draft.room.shareKey)).toEqual({ status: "expired" });
    expect(db.prepare("SELECT count(*) AS count FROM guest_rooms").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM guest_room_tombstones").get())
      .toEqual({ count: 1 });
  });

  it("adds at most one guest resource of each kind and only a new one extends expiry", () => {
    const created = service.create("board");
    now += 60_000;
    const added = service.ensureResource(created.shareKey, "code");
    expect("created" in added && added.created).toBe(true);
    if (!("created" in added)) return;
    expect(added.room.resources.map((resource) => resource.kind)).toEqual([
      "board",
      "code",
    ]);
    expect(Date.parse(added.room.expiresAt)).toBe(now + GUEST_ROOM_IDLE_TTL_MS);

    const expiresAt = added.room.expiresAt;
    now += 60_000;
    const duplicate = service.ensureResource(created.shareKey, "code");
    expect("created" in duplicate && duplicate.created).toBe(false);
    if (!("created" in duplicate)) return;
    expect(duplicate.room.expiresAt).toBe(expiresAt);
  });

  it("extends activity only after a known durable resource mutation", () => {
    const room = service.create("code");
    const resource = room.resources[0];
    now += 5_000;
    expect(service.recordResourceMutation(room.id, "missing")).toBe(false);
    expect(service.recordResourceMutation(room.id, resource.id)).toBe(true);
    const lookup = service.lookup(room.shareKey);
    expect(lookup.status).toBe("active");
    if (lookup.status !== "active") return;
    expect(lookup.room.lastActivityAt).toBe(new Date(now).toISOString());
    expect(lookup.room.resources[0].lastActivityAt)
      .toBe(new Date(now).toISOString());
  });

  it("does not renew an expired promotion draft from a resource commit", () => {
    const draft = service.createDraft("board");
    const resource = draft.room.resources[0];
    now += GUEST_ROOM_INITIALIZATION_TTL_MS;

    expect(service.recordResourceMutation(draft.room.id, resource.id)).toBe(false);
    expect(db.prepare(`
      SELECT last_activity_at, expires_at FROM guest_rooms WHERE id = ?
    `).get(draft.room.id)).toEqual({
      last_activity_at: draft.room.lastActivityAt,
      expires_at: draft.room.expiresAt,
    });
    expect(service.lookup(draft.room.shareKey)).toEqual({ status: "expired" });
  });

  it("extends call activity only from authoritative occupied-room presence", async () => {
    const room = service.create("call");
    const call = room.resources[0];
    expect(service.activateCall(room.id, call.id)).not.toBeNull();
    const roomName = guestCallRoomName(call.resourceKey);
    const listed: string[][] = [];
    let participants = 2;
    const liveKit = {
      createRoom: async () => undefined,
      listRooms: async (names: string[] = []) => {
        listed.push(names);
        return [{ name: roomName, numParticipants: participants }];
      },
      deleteRoom: async () => undefined,
      removeParticipant: async () => undefined,
    };

    now += 60_000;
    await expect(pollGuestCallPresence(service, liveKit)).resolves.toBe(1);
    expect(listed).toEqual([[roomName]]);
    const occupied = service.lookup(room.shareKey);
    expect(occupied.status).toBe("active");
    if (occupied.status !== "active") return;
    expect(occupied.room.lastActivityAt).toBe(new Date(now).toISOString());
    const occupiedExpiry = occupied.room.expiresAt;

    participants = 0;
    now += 60_000;
    await expect(pollGuestCallPresence(service, liveKit)).resolves.toBe(0);
    const empty = service.lookup(room.shareKey);
    expect(empty.status).toBe("active");
    if (empty.status !== "active") return;
    expect(empty.room.expiresAt).toBe(occupiedExpiry);
  });

  it("accepts an occupied LiveKit confirmation just after the stored call expiry", async () => {
    const room = service.create("call");
    const call = room.resources[0];
    expect(service.activateCall(room.id, call.id)).not.toBeNull();
    const roomName = guestCallRoomName(call.resourceKey);
    now += GUEST_ROOM_IDLE_TTL_MS + 30_000;

    await expect(pollGuestCallPresence(service, {
      createRoom: async () => undefined,
      listRooms: async () => [{ name: roomName, numParticipants: 1 }],
      deleteRoom: async () => undefined,
      removeParticipant: async () => undefined,
    })).resolves.toBe(1);

    const renewed = service.lookup(room.shareKey);
    expect(renewed.status).toBe("active");
    if (renewed.status !== "active") return;
    expect(renewed.room.lastActivityAt).toBe(new Date(now).toISOString());
    expect(Date.parse(renewed.room.expiresAt)).toBe(now + GUEST_ROOM_IDLE_TTL_MS);
  });

  it("keeps an expired call while an in-flight presence lookup can still renew it", async () => {
    const room = service.create("call");
    const call = room.resources[0];
    expect(service.activateCall(room.id, call.id)).not.toBeNull();
    const roomName = guestCallRoomName(call.resourceKey);
    let resolveRooms!: (rooms: Array<{
      name: string;
      numParticipants: number;
    }>) => void;
    const rooms = new Promise<Array<{
      name: string;
      numParticipants: number;
    }>>((resolve) => {
      resolveRooms = resolve;
    });

    now += GUEST_ROOM_IDLE_TTL_MS - 1_000;
    const poll = pollGuestCallPresence(service, {
      createRoom: async () => undefined,
      listRooms: async () => rooms,
      deleteRoom: async () => undefined,
      removeParticipant: async () => undefined,
    });
    await Promise.resolve();

    now += 31_000;
    expect(service.lookup(room.shareKey)).toEqual({ status: "expired" });
    expect(db.prepare("SELECT count(*) AS count FROM guest_rooms").get())
      .toEqual({ count: 1 });

    resolveRooms([{ name: roomName, numParticipants: 1 }]);
    await expect(poll).resolves.toBe(1);
    const renewed = service.lookup(room.shareKey);
    expect(renewed.status).toBe("active");
    if (renewed.status !== "active") return;
    expect(Date.parse(renewed.room.expiresAt)).toBe(now + GUEST_ROOM_IDLE_TTL_MS);
  });

  it("deletes an expired call immediately after LiveKit confirms it is empty", async () => {
    const room = service.create("call");
    expect(service.activateCall(room.id, room.resources[0].id)).not.toBeNull();
    now += GUEST_ROOM_IDLE_TTL_MS + 30_000;

    await expect(pollGuestCallPresence(service, {
      createRoom: async () => undefined,
      listRooms: async () => [],
      deleteRoom: async () => undefined,
      removeParticipant: async () => undefined,
    })).resolves.toBe(0);

    expect(db.prepare("SELECT count(*) AS count FROM guest_rooms").get())
      .toEqual({ count: 0 });
    expect(service.lookup(room.shareKey)).toEqual({ status: "expired" });
  });

  it("retains an unconfirmed expired call only until the hard grace boundary", async () => {
    const room = service.create("call");
    now += GUEST_ROOM_IDLE_TTL_MS + 30_000;

    await expect(pollGuestCallPresence(service, undefined)).resolves.toBe(0);
    expect(service.cleanupExpired()).toEqual({
      expiredRoomCount: 0,
      liveKitRoomNames: [],
    });
    expect(service.lookup(room.shareKey)).toEqual({ status: "expired" });
    expect(db.prepare("SELECT count(*) AS count FROM guest_rooms").get())
      .toEqual({ count: 1 });

    now += GUEST_CALL_PRESENCE_CONFIRMATION_GRACE_MS - 30_000;
    expect(service.cleanupExpired()).toEqual({
      expiredRoomCount: 1,
      liveKitRoomNames: [guestCallRoomName(room.resources[0].resourceKey)],
    });
    expect(db.prepare("SELECT count(*) AS count FROM guest_rooms").get())
      .toEqual({ count: 0 });
  });

  it("reports stable LiveKit room names after expired content is committed", () => {
    const expiredCallRooms: string[][] = [];
    service = new GuestRoomService(
      db,
      () => now,
      (roomNames) => expiredCallRooms.push([...roomNames]),
    );
    const room = service.create("call");
    const roomName = guestCallRoomName(room.resources[0].resourceKey);

    now += GUEST_ROOM_IDLE_TTL_MS
      + GUEST_CALL_PRESENCE_CONFIRMATION_GRACE_MS;
    expect(service.cleanupExpired()).toEqual({
      expiredRoomCount: 1,
      liveKitRoomNames: [roomName],
    });
    expect(expiredCallRooms).toEqual([[roomName]]);
    expect(service.lookup(room.shareKey)).toEqual({ status: "expired" });
  });

  it("deletes expired room content but retains a bounded hashed tombstone", () => {
    const room = service.create("call");
    now += GUEST_ROOM_IDLE_TTL_MS
      + GUEST_CALL_PRESENCE_CONFIRMATION_GRACE_MS;
    expect(service.lookup(room.shareKey)).toEqual({ status: "expired" });
    expect(db.prepare("SELECT count(*) AS count FROM guest_rooms").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM guest_room_resources").get())
      .toEqual({ count: 0 });
    const tombstone = db.prepare(`
      SELECT share_key_hash FROM guest_room_tombstones
    `).get() as { share_key_hash: string };
    expect(tombstone.share_key_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(tombstone.share_key_hash).not.toContain(room.shareKey);

    now += GUEST_ROOM_TOMBSTONE_TTL_MS;
    service.cleanupExpired();
    expect(service.lookup(room.shareKey)).toEqual({ status: "missing" });
  });
});
