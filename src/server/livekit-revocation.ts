import type Database from "better-sqlite3";

export const LIVEKIT_REVOCATION_BATCH_SIZE = 16;
export const LIVEKIT_REVOCATION_MAX_ATTEMPTS = 30;
export const LIVEKIT_REVOCATION_BASE_BACKOFF_MS = 5_000;
export const LIVEKIT_REVOCATION_MAX_BACKOFF_MS = 15 * 60 * 1_000;
export const LIVEKIT_REVOCATION_ROW_CONCURRENCY = 4;

export interface LiveKitRevocationTarget {
  roomName: string;
}

export interface LiveKitRevocationClient {
  deleteRoom(room: string): Promise<void>;
}

interface StoredRevocation {
  room_name: string;
  generation: number;
  attempts: number;
}

export interface LiveKitRevocationRunResult {
  selected: number;
  acknowledged: number;
  deferred: number;
}

function normalizedRoomName(target: LiveKitRevocationTarget): string {
  const roomName = target.roomName.trim();
  if (roomName.length < 1 || roomName.length > 255) {
    throw new Error("LiveKit revocation room name is invalid");
  }
  return roomName;
}

export function enqueueLiveKitRoomRevocation(
  db: Database.Database,
  target: LiveKitRevocationTarget,
  timestamp = new Date().toISOString(),
): void {
  const roomName = normalizedRoomName(target);
  db.prepare(`
    INSERT INTO livekit_room_revocation_outbox (
      room_name, generation, enqueued_at, next_attempt_at,
      attempts, last_error_code
    ) VALUES (?, 1, ?, ?, 0, NULL)
    ON CONFLICT(room_name) DO UPDATE SET
      generation = livekit_room_revocation_outbox.generation + 1,
      enqueued_at = excluded.enqueued_at,
      next_attempt_at = excluded.next_attempt_at,
      attempts = 0,
      last_error_code = NULL
  `).run(
    roomName,
    timestamp,
    timestamp,
  );
}

export function enqueueLessonRoomRevocation(
  db: Database.Database,
  input: {
    meetingKey: string;
  },
  timestamp = new Date().toISOString(),
): void {
  enqueueLiveKitRoomRevocation(db, {
    roomName: `eduri-${input.meetingKey}`,
  }, timestamp);
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 404 || candidate.code === "not_found";
}

function retryDelayMs(attempts: number): number {
  return Math.min(
    LIVEKIT_REVOCATION_MAX_BACKOFF_MS,
    LIVEKIT_REVOCATION_BASE_BACKOFF_MS
      * (2 ** Math.min(20, Math.max(0, attempts))),
  );
}

export async function processLiveKitRoomRevocations(
  db: Database.Database,
  service: LiveKitRevocationClient | undefined,
  options: {
    now?: number;
    limit?: number;
    clock?: () => number;
  } = {},
): Promise<LiveKitRevocationRunResult> {
  if (!service) return { selected: 0, acknowledged: 0, deferred: 0 };
  const selectedAt = options.now ?? Date.now();
  const clock = options.clock
    ?? (options.now === undefined ? Date.now : () => selectedAt);
  const timestamp = new Date(selectedAt).toISOString();
  const requestedLimit = options.limit ?? LIVEKIT_REVOCATION_BATCH_SIZE;
  const limit = Math.max(
    1,
    Math.min(
      LIVEKIT_REVOCATION_BATCH_SIZE,
      Number.isFinite(requestedLimit)
        ? Math.trunc(requestedLimit)
        : LIVEKIT_REVOCATION_BATCH_SIZE,
    ),
  );
  const rows = db.prepare(`
    SELECT room_name, generation, attempts
    FROM livekit_room_revocation_outbox
    WHERE next_attempt_at <= ?
    ORDER BY next_attempt_at, enqueued_at, room_name
    LIMIT ?
  `).all(timestamp, limit) as StoredRevocation[];

  const processRow = async (row: StoredRevocation): Promise<{
    acknowledged: number;
    deferred: number;
  }> => {
    let deleted = false;
    try {
      await service.deleteRoom(row.room_name);
      deleted = true;
    } catch (error) {
      deleted = isNotFound(error);
    }
    if (deleted) {
      const result = db.prepare(`
        DELETE FROM livekit_room_revocation_outbox
        WHERE room_name = ? AND generation = ?
      `).run(row.room_name, row.generation);
      return {
        acknowledged: result.changes === 1 ? 1 : 0,
        deferred: 0,
      };
    }

    const attempts = Math.min(
      LIVEKIT_REVOCATION_MAX_ATTEMPTS,
      row.attempts + 1,
    );
    const nextAttemptAt = new Date(
      clock() + retryDelayMs(row.attempts),
    ).toISOString();
    const result = db.prepare(`
      UPDATE livekit_room_revocation_outbox
      SET attempts = ?, next_attempt_at = ?, last_error_code = 'room_delete_failed'
      WHERE room_name = ? AND generation = ?
    `).run(attempts, nextAttemptAt, row.room_name, row.generation);
    return {
      acknowledged: 0,
      deferred: result.changes === 1 ? 1 : 0,
    };
  };

  const outcomes: Array<{ acknowledged: number; deferred: number }> = [];
  let cursor = 0;
  const workerCount = Math.min(
    LIVEKIT_REVOCATION_ROW_CONCURRENCY,
    rows.length,
  );
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor];
      cursor += 1;
      outcomes.push(await processRow(row));
    }
  }));
  let acknowledged = 0;
  let deferred = 0;
  for (const outcome of outcomes) {
    acknowledged += outcome.acknowledged;
    deferred += outcome.deferred;
  }
  return { selected: rows.length, acknowledged, deferred };
}
