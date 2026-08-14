import type Database from "better-sqlite3";
import {
  newId,
  randomToken,
  safeEqual,
  sha256,
} from "./security.js";
import { enqueueLiveKitRoomRevocation } from "./livekit-revocation.js";

export const GUEST_ROOM_IDLE_TTL_MS = 48 * 60 * 60 * 1000;
export const GUEST_ROOM_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const GUEST_ROOM_INITIALIZATION_TTL_MS = 60 * 60 * 1000;
export const GUEST_CALL_PRESENCE_CONFIRMATION_GRACE_MS = 2 * 60 * 1000;
/**
 * A token request reserves anonymous media capacity only long enough for the
 * participant to join and for the authoritative LiveKit poll to take over.
 * Presence refreshes this timestamp every minute while the call is occupied.
 */
export const GUEST_CALL_PROVISIONAL_LEASE_MS = 15 * 60 * 1000;
const INACTIVE_GUEST_CALL_AT = "1970-01-01T00:00:00.000Z";
export const DEFAULT_GUEST_ROOM_CAPACITY_LIMITS = Object.freeze({
  maxActiveRooms: 200,
  maxActiveCallResources: 32,
});

export interface GuestRoomCapacityLimits {
  maxActiveRooms: number;
  maxActiveCallResources: number;
}

export class GuestRoomCapacityError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs = 60_000) {
    super(message);
    this.name = "GuestRoomCapacityError";
    this.retryAfterMs = Math.max(1_000, Math.ceil(retryAfterMs));
  }
}

export type GuestRoomResourceKind = "board" | "code" | "call";

export function guestCallRoomName(
  resourceKey: string,
  generation = 1,
): string {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Guest call room generation is invalid");
  }
  return `eduri-guest-${resourceKey}${generation === 1 ? "" : `-g${generation}`}`;
}

export function guestBoardAssetTenantId(roomId: string): string {
  return `guest-room-${roomId}`;
}

interface GuestRoomRow {
  id: string;
  share_key: string;
  owner_user_id: string | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  expires_at: string;
  initialization_token_hash: string | null;
  initialization_expires_at: string | null;
  initialized_at: string | null;
}

interface GuestRoomResourceRow {
  id: string;
  room_id: string;
  kind: GuestRoomResourceKind;
  ordinal: number;
  resource_key: string;
  call_room_generation: number;
  created_at: string;
  last_activity_at: string;
}

export interface GuestRoomResource {
  id: string;
  kind: GuestRoomResourceKind;
  ordinal: number;
  resourceKey: string;
  createdAt: string;
  lastActivityAt: string;
}

export interface GuestRoom {
  id: string;
  shareKey: string;
  ownerUserId: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  expiresAt: string;
  resources: readonly GuestRoomResource[];
}

export type GuestRoomLookup =
  | { status: "active"; room: GuestRoom }
  | { status: "expired" }
  | { status: "missing" };

export interface GuestCallPresenceTarget {
  roomId: string;
  resourceId: string;
  roomName: string;
}

export interface GuestCallActivation {
  roomId: string;
  resourceId: string;
  roomName: string;
  activatedAt: string;
  newlyReserved: boolean;
}

export interface GuestRoomCleanupResult {
  expiredRoomCount: number;
  liveKitRoomNames: readonly string[];
}

export interface GuestRoomCleanupOptions {
  /** Room ids from a successful LiveKit lookup that confirmed no participants. */
  confirmedEmptyCallRoomIds?: readonly string[];
}

export interface GuestRoomDraft {
  readonly room: GuestRoom;
  readonly initializationToken: string;
}

export type GuestRoomInitializationResult =
  | { status: "active"; room: GuestRoom }
  | { status: "cancelled" }
  | { status: "expired" }
  | { status: "missing" }
  | { status: "forbidden" }
  | { status: "already-finalized" };

export type GuestCallRoomsExpired = (
  roomNames: readonly string[],
) => void;

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function roomFromRows(
  row: GuestRoomRow,
  resources: readonly GuestRoomResourceRow[],
): GuestRoom {
  return {
    id: row.id,
    shareKey: row.share_key,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
    resources: resources.map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      ordinal: resource.ordinal,
      resourceKey: resource.resource_key,
      createdAt: resource.created_at,
      lastActivityAt: resource.last_activity_at,
    })),
  };
}

export class GuestRoomService {
  private readonly capacityLimits: GuestRoomCapacityLimits;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
    private readonly onCallRoomsExpired: GuestCallRoomsExpired = () => undefined,
    capacityLimits: Partial<GuestRoomCapacityLimits> = {},
  ) {
    this.capacityLimits = {
      ...DEFAULT_GUEST_ROOM_CAPACITY_LIMITS,
      ...capacityLimits,
    };
    for (const [name, value] of Object.entries(this.capacityLimits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`);
      }
    }
  }

  create(
    initialResource: GuestRoomResourceKind,
    ownerUserId: string | null = null,
  ): GuestRoom {
    return this.createInternal(initialResource, ownerUserId, null);
  }

  createDraft(
    initialResource: GuestRoomResourceKind,
    ownerUserId: string | null = null,
  ): GuestRoomDraft {
    const initializationToken = randomToken(32);
    return {
      room: this.createInternal(
        initialResource,
        ownerUserId,
        initializationToken,
      ),
      initializationToken,
    };
  }

  finalizeDraft(
    shareKey: string,
    initializationToken: string,
  ): GuestRoomInitializationResult {
    const lookup = this.lookup(shareKey);
    if (lookup.status !== "active") return lookup;
    const row = this.roomRow(shareKey);
    if (!row?.initialization_token_hash || !row.initialization_expires_at) {
      return { status: "forbidden" };
    }
    if (!safeEqual(
      row.initialization_token_hash,
      sha256(initializationToken),
    )) {
      return { status: "forbidden" };
    }
    if (row.initialized_at !== null) {
      return { status: "active", room: lookup.room };
    }
    if (Date.parse(row.initialization_expires_at) <= this.now()) {
      this.cleanupExpired();
      return { status: "expired" };
    }
    this.db.prepare(`
      UPDATE guest_rooms SET initialized_at = ?
      WHERE id = ? AND initialized_at IS NULL
    `).run(iso(this.now()), row.id);
    return { status: "active", room: this.requireActive(shareKey) };
  }

  cancelDraft(
    shareKey: string,
    initializationToken: string,
  ): GuestRoomInitializationResult {
    const lookup = this.lookup(shareKey);
    if (lookup.status !== "active") return lookup;
    const row = this.roomRow(shareKey);
    if (!row?.initialization_token_hash || !row.initialization_expires_at) {
      return { status: "forbidden" };
    }
    if (!safeEqual(
      row.initialization_token_hash,
      sha256(initializationToken),
    )) {
      return { status: "forbidden" };
    }
    if (row.initialized_at !== null) return { status: "already-finalized" };
    if (Date.parse(row.initialization_expires_at) <= this.now()) {
      this.cleanupExpired();
      return { status: "expired" };
    }
    const callRoomNames = (this.db.prepare(`
      SELECT resource_key, call_room_generation
      FROM guest_room_resources
      WHERE room_id = ? AND kind = 'call'
    `).all(row.id) as Array<{
      resource_key: string;
      call_room_generation: number;
    }>).map((resource) => guestCallRoomName(
      resource.resource_key,
      resource.call_room_generation,
    ));
    this.db.transaction(() => this.deleteRoomContent(row.id)).immediate();
    if (callRoomNames.length > 0) this.onCallRoomsExpired(callRoomNames);
    return { status: "cancelled" };
  }

  private createInternal(
    initialResource: GuestRoomResourceKind,
    ownerUserId: string | null,
    initializationToken: string | null,
  ): GuestRoom {
    this.cleanupExpired();
    const now = this.now();
    const timestamp = iso(now);
    const roomId = newId();
    const shareKey = randomToken(32);
    const resourceId = newId();
    const resourceKey = randomToken(24);
    this.db.transaction(() => {
      this.assertCreateCapacity(timestamp);
      this.db.prepare(`
        INSERT INTO guest_rooms (
          id, share_key, owner_user_id, created_at, updated_at,
          last_activity_at, expires_at, initialization_token_hash,
          initialization_expires_at, initialized_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        roomId,
        shareKey,
        ownerUserId,
        timestamp,
        timestamp,
        timestamp,
        iso(now + GUEST_ROOM_IDLE_TTL_MS),
        initializationToken === null ? null : sha256(initializationToken),
        initializationToken === null
          ? null
          : iso(now + GUEST_ROOM_INITIALIZATION_TTL_MS),
        initializationToken === null ? timestamp : null,
      );
      this.db.prepare(`
        INSERT INTO guest_room_resources (
          id, room_id, kind, ordinal, resource_key, created_at, last_activity_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?)
      `).run(
        resourceId,
        roomId,
        initialResource,
        resourceKey,
        timestamp,
        initialResource === "call" ? INACTIVE_GUEST_CALL_AT : timestamp,
      );
    }).immediate();
    return this.requireActive(shareKey);
  }

  lookup(shareKey: string): GuestRoomLookup {
    const now = this.now();
    this.expireOne(shareKey, now);
    const row = this.roomRow(shareKey);
    if (row) {
      const initializationExpired = row.initialization_token_hash !== null
        && row.initialized_at === null
        && row.initialization_expires_at !== null
        && Date.parse(row.initialization_expires_at) <= now;
      if (Date.parse(row.expires_at) <= now || initializationExpired) {
        return { status: "expired" };
      }
      return { status: "active", room: this.hydrate(row) };
    }
    const tombstone = this.db.prepare(`
      SELECT 1 AS present
      FROM guest_room_tombstones
      WHERE share_key_hash = ? AND purge_at > ?
    `).get(sha256(shareKey), iso(now)) as { present: 1 } | undefined;
    return tombstone ? { status: "expired" } : { status: "missing" };
  }

  ensureResource(
    shareKey: string,
    kind: GuestRoomResourceKind,
  ): { room: GuestRoom; created: boolean } | GuestRoomLookup {
    const lookup = this.lookup(shareKey);
    if (lookup.status !== "active") return lookup;
    const existing = lookup.room.resources.find((resource) => (
      resource.kind === kind && resource.ordinal === 1
    ));
    if (existing) return { room: lookup.room, created: false };

    const now = this.now();
    const timestamp = iso(now);
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO guest_room_resources (
          id, room_id, kind, ordinal, resource_key, created_at, last_activity_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?)
      `).run(
        newId(),
        lookup.room.id,
        kind,
        randomToken(24),
        timestamp,
        kind === "call" ? INACTIVE_GUEST_CALL_AT : timestamp,
      );
      this.touchById(lookup.room.id, timestamp, now);
    }).immediate();
    return { room: this.requireActive(shareKey), created: true };
  }

  /** Called inside the resource commit transaction; false must roll it back. */
  recordResourceMutation(roomId: string, resourceId: string): boolean {
    return this.recordResourceActivity(roomId, resourceId);
  }

  isResourceActive(
    roomId: string,
    resourceId: string,
    requiredKind: GuestRoomResourceKind | null = null,
  ): boolean {
    const timestamp = iso(this.now());
    return this.db.prepare(`
      SELECT 1 AS present
      FROM guest_rooms room
      JOIN guest_room_resources resource ON resource.room_id = room.id
      WHERE room.id = ? AND resource.id = ? AND room.expires_at > ?
        AND (? IS NULL OR resource.kind = ?)
        AND (
          room.initialization_token_hash IS NULL
          OR room.initialized_at IS NOT NULL
          OR room.initialization_expires_at > ?
        )
    `).get(
      roomId,
      resourceId,
      timestamp,
      requiredKind,
      requiredKind,
      timestamp,
    ) !== undefined;
  }

  /**
   * Reserves one persistent anonymous media slot immediately before the SFU
   * room is explicitly created. Merely adding a Call resource does not reserve
   * capacity or extend the room's 48-hour activity lease.
   */
  activateCall(
    roomId: string,
    resourceId: string,
  ): GuestCallActivation | null {
    const now = this.now();
    const timestamp = iso(now);
    return this.db.transaction(() => {
      const call = this.db.prepare(`
        SELECT
          resource.last_activity_at,
          resource.resource_key,
          resource.call_room_generation
        FROM guest_rooms room
        JOIN guest_room_resources resource ON resource.room_id = room.id
        WHERE room.id = ? AND resource.id = ? AND resource.kind = 'call'
          AND room.expires_at > ?
          AND (
            room.initialization_token_hash IS NULL
            OR room.initialized_at IS NOT NULL
            OR room.initialization_expires_at > ?
          )
      `).get(roomId, resourceId, timestamp, timestamp) as {
        last_activity_at: string;
        resource_key: string;
        call_room_generation: number;
      } | undefined;
      if (!call) return null;

      const newlyReserved = Date.parse(call.last_activity_at)
        <= now - GUEST_CALL_PROVISIONAL_LEASE_MS;
      if (!newlyReserved) {
        return {
          roomId,
          resourceId,
          roomName: guestCallRoomName(
            call.resource_key,
            call.call_room_generation,
          ),
          activatedAt: call.last_activity_at,
          newlyReserved: false,
        };
      }
      this.assertCallCapacity(now);
      this.db.prepare(`
        UPDATE guest_room_resources SET last_activity_at = ?
        WHERE id = ? AND room_id = ? AND kind = 'call'
      `).run(timestamp, resourceId, roomId);
      return {
        roomId,
        resourceId,
        roomName: guestCallRoomName(
          call.resource_key,
          call.call_room_generation,
        ),
        activatedAt: timestamp,
        newlyReserved: true,
      };
    }).immediate();
  }

  resolveCallRoomName(roomId: string, resourceId: string): string | null {
    const timestamp = iso(this.now());
    const call = this.db.prepare(`
      SELECT resource.resource_key, resource.call_room_generation
      FROM guest_rooms room
      JOIN guest_room_resources resource ON resource.room_id = room.id
      WHERE room.id = ? AND resource.id = ? AND resource.kind = 'call'
        AND room.expires_at > ?
        AND (
          room.initialization_token_hash IS NULL
          OR room.initialized_at IS NOT NULL
          OR room.initialization_expires_at > ?
        )
    `).get(roomId, resourceId, timestamp, timestamp) as {
      resource_key: string;
      call_room_generation: number;
    } | undefined;
    return call
      ? guestCallRoomName(call.resource_key, call.call_room_generation)
      : null;
  }

  /**
   * A successful authoritative empty-room lookup can retire provisional
   * reservations which never became occupied. The logical Call resource stays
   * in the guest room and can reserve a fresh slot on the next token request.
   */
  releaseExpiredCallActivations(
    confirmedEmptyResourceIds: readonly string[],
  ): readonly string[] {
    const resourceIds = [...new Set(confirmedEmptyResourceIds)];
    if (resourceIds.length === 0) return [];
    const now = this.now();
    const cutoff = iso(now - GUEST_CALL_PROVISIONAL_LEASE_MS);
    const placeholders = resourceIds.map(() => "?").join(", ");
    return this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT
          resource.id,
          resource.resource_key,
          resource.call_room_generation,
          resource.last_activity_at
        FROM guest_room_resources resource
        JOIN guest_rooms room ON room.id = resource.room_id
        WHERE resource.kind = 'call'
          AND resource.id IN (${placeholders})
          AND resource.last_activity_at > ?
          AND resource.last_activity_at <= ?
      `).all(
        ...resourceIds,
        INACTIVE_GUEST_CALL_AT,
        cutoff,
      ) as Array<{
        id: string;
        resource_key: string;
        call_room_generation: number;
        last_activity_at: string;
      }>;
      const release = this.db.prepare(`
        UPDATE guest_room_resources
        SET last_activity_at = ?, call_room_generation = call_room_generation + 1
        WHERE id = ? AND kind = 'call' AND last_activity_at = ?
          AND call_room_generation = ?
      `);
      const names: string[] = [];
      for (const row of rows) {
        if (release.run(
          INACTIVE_GUEST_CALL_AT,
          row.id,
          row.last_activity_at,
          row.call_room_generation,
        ).changes === 1) {
          const oldRoomName = guestCallRoomName(
            row.resource_key,
            row.call_room_generation,
          );
          enqueueLiveKitRoomRevocation(this.db, {
            roomName: oldRoomName,
          }, iso(now));
          names.push(oldRoomName);
        }
      }
      return names;
    }).immediate();
  }

  listCallPresenceTargets(): readonly GuestCallPresenceTarget[] {
    const rows = this.db.prepare(`
      SELECT
        room.id AS room_id,
        resource.id AS resource_id,
        resource.resource_key,
        resource.call_room_generation
      FROM guest_rooms room
      JOIN guest_room_resources resource ON resource.room_id = room.id
      WHERE resource.kind = 'call' AND room.expires_at > ?
        AND resource.last_activity_at > ?
        AND (
          room.initialization_expires_at IS NULL
          OR room.initialized_at IS NOT NULL
          OR room.initialization_expires_at > ?
        )
      ORDER BY room.id, resource.ordinal
    `).all(
      iso(this.now() - GUEST_CALL_PRESENCE_CONFIRMATION_GRACE_MS),
      INACTIVE_GUEST_CALL_AT,
      iso(this.now()),
    ) as Array<{
      room_id: string;
      resource_id: string;
      resource_key: string;
      call_room_generation: number;
    }>;
    return rows.map((row) => ({
      roomId: row.room_id,
      resourceId: row.resource_id,
      roomName: guestCallRoomName(
        row.resource_key,
        row.call_room_generation,
      ),
    }));
  }

  /** Records activity only after LiveKit confirms that the call is occupied. */
  recordCallPresence(roomId: string, resourceId: string): boolean {
    return this.recordResourceActivity(
      roomId,
      resourceId,
      "call",
      GUEST_CALL_PRESENCE_CONFIRMATION_GRACE_MS,
    );
  }

  cleanupExpired(
    options: GuestRoomCleanupOptions = {},
  ): GuestRoomCleanupResult {
    const now = this.now();
    const timestamp = iso(now);
    const confirmedEmptyCallRoomIds = [
      ...new Set(options.confirmedEmptyCallRoomIds ?? []),
    ];
    const confirmedEmptyClause = confirmedEmptyCallRoomIds.length === 0
      ? ""
      : `OR room.id IN (${confirmedEmptyCallRoomIds.map(() => "?").join(", ")})`;
    const expiredRows = this.db.prepare(`
      SELECT
        room.id,
        room.share_key,
        call_resource.resource_key AS call_resource_key,
        call_resource.call_room_generation AS call_room_generation
      FROM guest_rooms room
      LEFT JOIN guest_room_resources call_resource
        ON call_resource.room_id = room.id AND call_resource.kind = 'call'
      WHERE (
          room.expires_at <= ?
          AND (
            room.expires_at <= ?
            OR NOT EXISTS (
              SELECT 1
              FROM guest_room_resources call_guard
              WHERE call_guard.room_id = room.id AND call_guard.kind = 'call'
            )
            ${confirmedEmptyClause}
          )
        )
        OR (
          room.initialization_token_hash IS NOT NULL
          AND room.initialized_at IS NULL
          AND room.initialization_expires_at <= ?
        )
      ORDER BY room.id, call_resource.ordinal
    `).all(
      timestamp,
      iso(now - GUEST_CALL_PRESENCE_CONFIRMATION_GRACE_MS),
      ...confirmedEmptyCallRoomIds,
      timestamp,
    ) as Array<{
      id: string;
      share_key: string;
      call_resource_key: string | null;
      call_room_generation: number | null;
    }>;
    const expired = [...new Map(expiredRows.map((row) => [row.id, {
      id: row.id,
      share_key: row.share_key,
    }])).values()];
    const liveKitRoomNames = [...new Set(expiredRows.flatMap((row) => (
      row.call_resource_key === null
        ? []
        : [guestCallRoomName(
            row.call_resource_key,
            row.call_room_generation ?? 1,
          )]
    )))];
    this.db.transaction(() => {
      const tombstone = this.db.prepare(`
        INSERT INTO guest_room_tombstones (
          share_key_hash, expired_at, purge_at
        ) VALUES (?, ?, ?)
        ON CONFLICT(share_key_hash) DO UPDATE SET
          expired_at = excluded.expired_at,
          purge_at = excluded.purge_at
      `);
      for (const room of expired) {
        tombstone.run(
          sha256(room.share_key),
          timestamp,
          iso(now + GUEST_ROOM_TOMBSTONE_TTL_MS),
        );
        this.deleteRoomContent(room.id);
      }
      this.db.prepare("DELETE FROM guest_room_tombstones WHERE purge_at <= ?")
        .run(timestamp);
    })();
    if (liveKitRoomNames.length > 0) {
      this.onCallRoomsExpired(liveKitRoomNames);
    }
    return {
      expiredRoomCount: expired.length,
      liveKitRoomNames,
    };
  }

  private expireOne(shareKey: string, now: number): void {
    const row = this.roomRow(shareKey);
    if (!row) return;
    const initializationExpired = row.initialization_token_hash !== null
      && row.initialized_at === null
      && row.initialization_expires_at !== null
      && Date.parse(row.initialization_expires_at) <= now;
    if (Date.parse(row.expires_at) > now && !initializationExpired) return;
    this.cleanupExpired();
  }

  private roomRow(shareKey: string): GuestRoomRow | undefined {
    return this.db.prepare(`
      SELECT * FROM guest_rooms WHERE share_key = ?
    `).get(shareKey) as GuestRoomRow | undefined;
  }

  private hydrate(row: GuestRoomRow): GuestRoom {
    const resources = this.db.prepare(`
      SELECT * FROM guest_room_resources
      WHERE room_id = ? ORDER BY kind, ordinal
    `).all(row.id) as GuestRoomResourceRow[];
    return roomFromRows(row, resources);
  }

  private requireActive(shareKey: string): GuestRoom {
    const row = this.roomRow(shareKey);
    if (!row) throw new Error("New guest room could not be read");
    return this.hydrate(row);
  }

  private recordResourceActivity(
    roomId: string,
    resourceId: string,
    requiredKind: GuestRoomResourceKind | null = null,
    expiredConfirmationGraceMs = 0,
  ): boolean {
    const now = this.now();
    const timestamp = iso(now);
    return this.db.transaction(() => {
      const active = this.db.prepare(`
        SELECT room.id
        FROM guest_rooms room
        JOIN guest_room_resources resource ON resource.room_id = room.id
        WHERE room.id = ?
          AND resource.id = ?
          AND room.expires_at > ?
          AND (? IS NULL OR resource.kind = ?)
          AND (
            room.initialization_token_hash IS NULL
            OR room.initialized_at IS NOT NULL
            OR room.initialization_expires_at > ?
          )
      `).get(
        roomId,
        resourceId,
        iso(now - expiredConfirmationGraceMs),
        requiredKind,
        requiredKind,
        timestamp,
      ) as { id: string } | undefined;
      if (!active) return false;
      this.db.prepare(`
        UPDATE guest_room_resources SET last_activity_at = ? WHERE id = ?
      `).run(timestamp, resourceId);
      this.touchById(roomId, timestamp, now);
      return true;
    })();
  }

  private touchById(roomId: string, timestamp: string, now: number): void {
    this.db.prepare(`
      UPDATE guest_rooms
      SET updated_at = ?, last_activity_at = ?, expires_at = ?
      WHERE id = ?
    `).run(timestamp, timestamp, iso(now + GUEST_ROOM_IDLE_TTL_MS), roomId);
  }

  private assertCreateCapacity(timestamp: string): void {
    const activeRooms = this.db.prepare(`
      SELECT COUNT(*) AS room_count
      FROM guest_rooms room
      WHERE room.expires_at > ?
        AND (
          room.initialization_token_hash IS NULL
          OR room.initialized_at IS NOT NULL
          OR room.initialization_expires_at > ?
        )
    `).get(timestamp, timestamp) as { room_count: number };
    if (activeRooms.room_count >= this.capacityLimits.maxActiveRooms) {
      throw new GuestRoomCapacityError(
        "The global active guest-room capacity has been reached",
        this.roomCapacityRetryAfterMs(Date.parse(timestamp)),
      );
    }
  }

  private assertCallCapacity(now: number): void {
    const cutoff = iso(now - GUEST_CALL_PROVISIONAL_LEASE_MS);
    const liveRoomCutoff = iso(
      now - GUEST_CALL_PRESENCE_CONFIRMATION_GRACE_MS,
    );
    const activeCalls = this.db.prepare(`
      SELECT COUNT(*) AS call_count
      FROM guest_room_resources resource
      JOIN guest_rooms room ON room.id = resource.room_id
      WHERE resource.kind = 'call'
        AND resource.last_activity_at > ?
        AND room.expires_at > ?
        AND (
          room.initialization_token_hash IS NULL
          OR room.initialized_at IS NOT NULL
          OR room.initialization_expires_at > ?
        )
    `).get(cutoff, liveRoomCutoff, iso(now)) as { call_count: number };
    if (
      activeCalls.call_count
      >= this.capacityLimits.maxActiveCallResources
    ) {
      throw new GuestRoomCapacityError(
        "The global active guest-call capacity has been reached",
        this.callCapacityRetryAfterMs(now, cutoff),
      );
    }
  }

  private roomCapacityRetryAfterMs(now: number): number {
    const timestamp = iso(now);
    const nearest = this.db.prepare(`
      SELECT MIN(
        CASE
          WHEN room.initialization_token_hash IS NOT NULL
            AND room.initialized_at IS NULL
            AND room.initialization_expires_at IS NOT NULL
            AND room.initialization_expires_at < room.expires_at
          THEN room.initialization_expires_at
          ELSE room.expires_at
        END
      ) AS available_at
      FROM guest_rooms room
      WHERE room.expires_at > ?
        AND (
          room.initialization_token_hash IS NULL
          OR room.initialized_at IS NOT NULL
          OR room.initialization_expires_at > ?
        )
    `).get(timestamp, timestamp) as { available_at: string | null };
    return nearest.available_at === null
      ? 60_000
      : Math.max(1_000, Date.parse(nearest.available_at) - now);
  }

  private callCapacityRetryAfterMs(now: number, cutoff: string): number {
    const rows = this.db.prepare(`
      SELECT
        resource.last_activity_at,
        room.expires_at,
        room.initialized_at,
        room.initialization_expires_at
      FROM guest_room_resources resource
      JOIN guest_rooms room ON room.id = resource.room_id
      WHERE resource.kind = 'call'
        AND resource.last_activity_at > ?
        AND room.expires_at > ?
        AND (
          room.initialization_token_hash IS NULL
          OR room.initialized_at IS NOT NULL
          OR room.initialization_expires_at > ?
        )
    `).all(
      cutoff,
      iso(now - GUEST_CALL_PRESENCE_CONFIRMATION_GRACE_MS),
      iso(now),
    ) as Array<{
      last_activity_at: string;
      expires_at: string;
      initialized_at: string | null;
      initialization_expires_at: string | null;
    }>;
    const availableAt = rows.reduce((nearest, row) => {
      let rowExpiry = Math.min(
        Date.parse(row.last_activity_at) + GUEST_CALL_PROVISIONAL_LEASE_MS,
        Date.parse(row.expires_at)
          + GUEST_CALL_PRESENCE_CONFIRMATION_GRACE_MS,
      );
      if (row.initialized_at === null && row.initialization_expires_at !== null) {
        rowExpiry = Math.min(
          rowExpiry,
          Date.parse(row.initialization_expires_at),
        );
      }
      return Math.min(nearest, rowExpiry);
    }, Number.POSITIVE_INFINITY);
    return Number.isFinite(availableAt)
      ? Math.max(1_000, availableAt - now)
      : 60_000;
  }

  private deleteRoomContent(roomId: string): void {
    const callResources = this.db.prepare(`
      SELECT resource_key, call_room_generation
      FROM guest_room_resources
      WHERE room_id = ? AND kind = 'call'
    `).all(roomId) as Array<{
      resource_key: string;
      call_room_generation: number;
    }>;
    const timestamp = iso(this.now());
    for (const resource of callResources) {
      enqueueLiveKitRoomRevocation(this.db, {
        roomName: guestCallRoomName(
          resource.resource_key,
          resource.call_room_generation,
        ),
      }, timestamp);
    }
    // Deleting the room first cascades Board asset references and uploads.
    // Their DELETE triggers durably queue staging files; deleting the now-
    // unreferenced guest tenant blobs queues published files in the same
    // transaction as the tombstone/content deletion.
    this.db.prepare("DELETE FROM guest_rooms WHERE id = ?").run(roomId);
    this.db.prepare(`
      DELETE FROM board_asset_blobs WHERE tenant_id = ?
    `).run(guestBoardAssetTenantId(roomId));
  }
}
