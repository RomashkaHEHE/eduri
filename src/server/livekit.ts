import { randomBytes } from "node:crypto";
import { RoomServiceClient, TrackSource } from "livekit-server-sdk";
import type { AppConfig } from "./config.js";
import type { AppContext, Role } from "./types.js";
import type { GuestRoomService } from "./guestRooms.js";
import type { CallLobbyParticipant } from "../shared/call.js";
import {
  COLLABORATION_PROFILE_COLORS,
  normalizeCollaborationColor,
  normalizeCollaborationDisplayName,
} from "../shared/collaborationProfile.js";

interface LiveKitParticipantSnapshot {
  readonly identity: string;
  readonly name: string;
  readonly attributes?: Record<string, string>;
  readonly tracks?: ReadonlyArray<{
    readonly source: TrackSource;
    readonly muted: boolean;
  }>;
}

export interface LiveKitRoomService {
  createRoom(options: {
    name: string;
    emptyTimeout?: number;
    departureTimeout?: number;
    maxParticipants?: number;
  }): Promise<unknown>;
  listRooms(names?: string[]): Promise<Array<{
    name: string;
    numParticipants?: number;
  }>>;
  deleteRoom(room: string): Promise<void>;
  removeParticipant(
    room: string,
    identity: string,
    options?: { revokeTokenTs?: bigint },
  ): Promise<void>;
  updateParticipant?(
    room: string,
    identity: string,
    options: {
      name?: string;
      attributes?: Record<string, string>;
    },
  ): Promise<unknown>;
  listParticipants?(room: string): Promise<LiveKitParticipantSnapshot[]>;
}

export class LiveKitRevocationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LiveKitRevocationError";
  }
}

const LIVEKIT_REQUEST_TIMEOUT_SECONDS = 5;
export const LIVEKIT_CALL_ROOM_OPTIONS = Object.freeze({
  emptyTimeout: 300,
  departureTimeout: 60,
  maxParticipants: 2,
});

export function lessonCallRoomName(meetingKey: string): string {
  return `eduri-${meetingKey}`;
}

export function liveKitParticipantIdentity(role: Role, userId: string): string {
  return `${role}:${userId}`;
}

function liveKitApiOrigin(livekitUrl: string): string {
  const url = new URL(livekitUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

export function createLiveKitRoomService(config: AppConfig): LiveKitRoomService | undefined {
  const {
    livekitUrl,
    livekitApiUrl,
    livekitApiKey,
    livekitApiSecret,
  } = config;
  if (!livekitUrl || !livekitApiKey || !livekitApiSecret) return undefined;

  // Production supplies a private management origin. The public WebSocket URL
  // remains only a browser signaling endpoint and never carries management RPCs.
  return new RoomServiceClient(
    livekitApiUrl ?? liveKitApiOrigin(livekitUrl),
    livekitApiKey,
    livekitApiSecret,
    { requestTimeout: LIVEKIT_REQUEST_TIMEOUT_SECONDS, failover: false },
  );
}

/**
 * LiveKit auto-creation is disabled. Every joinable room must therefore cross
 * an application authorization boundary before it exists in the SFU.
 */
export async function ensureLiveKitCallRoom(
  service: LiveKitRoomService,
  roomName: string,
): Promise<void> {
  await service.createRoom({
    name: roomName,
    ...LIVEKIT_CALL_ROOM_OPTIONS,
  });
}

export function isLiveKitNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 404 || candidate.code === "not_found";
}

function lobbyParticipantName(participant: LiveKitParticipantSnapshot): string {
  try {
    return normalizeCollaborationDisplayName(participant.name);
  } catch {
    return "Участник";
  }
}

function lobbyParticipantColor(participant: LiveKitParticipantSnapshot): `#${string}` {
  try {
    return normalizeCollaborationColor(participant.attributes?.["eduri.color"]);
  } catch {
    return COLLABORATION_PROFILE_COLORS[0];
  }
}

export async function listCallLobbyParticipants(
  service: LiveKitRoomService | undefined,
  roomName: string,
): Promise<CallLobbyParticipant[]> {
  if (!service?.listParticipants) return [];
  let participants: LiveKitParticipantSnapshot[];
  try {
    participants = await service.listParticipants(roomName);
  } catch (error) {
    if (isLiveKitNotFoundError(error)) return [];
    throw error;
  }
  return participants.map((participant) => {
    const active = (source: TrackSource) => participant.tracks?.some((track) => (
      track.source === source && !track.muted
    )) ?? false;
    return {
      identity: participant.identity,
      displayName: lobbyParticipantName(participant),
      color: lobbyParticipantColor(participant),
      microphoneEnabled: active(TrackSource.MICROPHONE),
      cameraEnabled: active(TrackSource.CAMERA),
      screenShareEnabled: active(TrackSource.SCREEN_SHARE),
    };
  });
}

function logLiveKitFailure(
  action: string,
  error: unknown,
  details: { roomName?: string; identity?: string } = {},
): void {
  if (isLiveKitNotFoundError(error)) return;
  console.error(`[livekit] ${action} failed`, {
    ...details,
    error: error instanceof Error ? error.message : String(error),
  });
}

export async function deleteLessonCallRoom(context: AppContext, roomName: string): Promise<void> {
  try {
    await context.livekitRoomService?.deleteRoom(roomName);
  } catch (error) {
    logLiveKitFailure("room deletion", error, { roomName });
  }
}

export async function deleteGuestCallRoomsBestEffort(
  service: LiveKitRoomService | undefined,
  roomNames: readonly string[],
): Promise<void> {
  if (!service) return;
  await Promise.all([...new Set(roomNames)].map(async (roomName) => {
    try {
      await service.deleteRoom(roomName);
    } catch (error) {
      logLiveKitFailure("guest room deletion", error, { roomName });
    }
  }));
}

export async function pollGuestCallPresence(
  guestRooms: GuestRoomService,
  service: LiveKitRoomService | undefined,
): Promise<number> {
  if (!service) return 0;
  const targets = guestRooms.listCallPresenceTargets();
  if (targets.length === 0) return 0;

  let rooms: Awaited<ReturnType<LiveKitRoomService["listRooms"]>>;
  try {
    rooms = await service.listRooms([
      ...new Set(targets.map((target) => target.roomName)),
    ]);
  } catch (error) {
    logLiveKitFailure("guest room presence lookup", error);
    return 0;
  }
  const occupiedRoomNames = new Set(rooms
    .filter((room) => (room.numParticipants ?? 0) > 0)
    .map((room) => room.name));
  const occupiedRoomIds = new Set(targets
    .filter((target) => occupiedRoomNames.has(target.roomName))
    .map((target) => target.roomId));
  let touched = 0;
  for (const target of targets) {
    if (
      occupiedRoomNames.has(target.roomName)
      && guestRooms.recordCallPresence(target.roomId, target.resourceId)
    ) {
      touched += 1;
    }
  }
  const releasedRoomNames = guestRooms.releaseExpiredCallActivations(
    targets
      .filter((target) => !occupiedRoomNames.has(target.roomName))
      .map((target) => target.resourceId),
  );
  // releaseExpiredCallActivations durably queues each old room and rotates the
  // room generation in one transaction. The app worker performs DeleteRoom;
  // issuing an untracked duplicate here could race a later activation.
  void releasedRoomNames;
  guestRooms.cleanupExpired({
    confirmedEmptyCallRoomIds: targets
      .filter((target) => !occupiedRoomIds.has(target.roomId))
      .map((target) => target.roomId),
  });
  return touched;
}

function nextMeetingKey(): string {
  return randomBytes(24).toString("base64url");
}

export async function revokeUserLiveKitAccessBeforeDeletion(
  context: AppContext,
  userId: string,
): Promise<void> {
  const user = context.db.prepare("SELECT role FROM users WHERE id = ?")
    .get(userId) as { role: Role } | undefined;
  if (!user) return;
  const targets = context.db.prepare(`
    SELECT id, meeting_key
    FROM lessons
    WHERE status IN ('scheduled', 'active')
      AND (tutor_id = ? OR student_id = ?)
  `).all(userId, userId) as Array<{ id: string; meeting_key: string }>;
  if (targets.length === 0) return;
  const service = context.livekitRoomService;
  if (!service) {
    if (!context.config.livekitUrl) return;
    throw new LiveKitRevocationError(
      "LiveKit is configured but its room service is unavailable",
    );
  }

  const identity = liveKitParticipantIdentity(user.role, userId);
  const failures: unknown[] = [];
  for (const target of targets) {
    const roomName = lessonCallRoomName(target.meeting_key);
    try {
      await service.removeParticipant(roomName, identity, {
        revokeTokenTs: BigInt(Math.floor(Date.now() / 1_000) + 1),
      });
    } catch (error) {
      if (!isLiveKitNotFoundError(error)) failures.push(error);
    }
    try {
      await service.deleteRoom(roomName);
    } catch (error) {
      if (!isLiveKitNotFoundError(error)) failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new LiveKitRevocationError(
      "LiveKit lesson rooms could not be revoked before account deletion",
      { cause: new AggregateError(failures) },
    );
  }

  // Only forget an old room name after every management revocation succeeded.
  // If the following account cascade aborts or an administrator concurrently
  // reactivates the user, an old unexpired join JWT still points at a name the
  // application can no longer provision.
  const rotate = context.db.prepare(`
    UPDATE lessons SET meeting_key = ?, updated_at = ?
    WHERE id = ? AND meeting_key = ? AND status IN ('scheduled', 'active')
  `);
  const timestamp = new Date().toISOString();
  const rotations: Array<{
    id: string;
    oldMeetingKey: string;
    newMeetingKey: string;
  }> = [];
  context.db.transaction(() => {
    for (const target of targets) {
      const newMeetingKey = nextMeetingKey();
      if (rotate.run(
        newMeetingKey,
        timestamp,
        target.id,
        target.meeting_key,
      ).changes === 1) {
        rotations.push({
          id: target.id,
          oldMeetingKey: target.meeting_key,
          newMeetingKey,
        });
      }
    }
  }).immediate();

  // A counterpart token request can have passed its first authorization check
  // just before suspension and recreate the old room after the first delete.
  // Rotation makes its post-provision check fail; this second delete closes the
  // remaining create/delete race. If it fails, restore the old durable target
  // so an exact retry does not forget which SFU room still needs revocation.
  const postRotationFailures: unknown[] = [];
  for (const target of targets) {
    try {
      await service.deleteRoom(lessonCallRoomName(target.meeting_key));
    } catch (error) {
      if (!isLiveKitNotFoundError(error)) postRotationFailures.push(error);
    }
  }
  if (postRotationFailures.length > 0) {
    const restore = context.db.prepare(`
      UPDATE lessons SET meeting_key = ?, updated_at = ?
      WHERE id = ? AND meeting_key = ? AND status IN ('scheduled', 'active')
    `);
    const restoredAt = new Date().toISOString();
    context.db.transaction(() => {
      for (const rotation of rotations) {
        restore.run(
          rotation.oldMeetingKey,
          restoredAt,
          rotation.id,
          rotation.newMeetingKey,
        );
      }
    }).immediate();
    throw new LiveKitRevocationError(
      "LiveKit lesson rooms could not be rechecked after account revocation",
      { cause: new AggregateError(postRotationFailures) },
    );
  }
}
