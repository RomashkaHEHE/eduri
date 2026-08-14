import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { createHash, createHmac, randomUUID } from "node:crypto";
import rateLimit from "express-rate-limit";
import { AccessToken, TrackSource } from "livekit-server-sdk";
import { z } from "zod";
import { getAuth } from "../security.js";
import { HttpError, parseBody } from "../http.js";
import type { AppContext } from "../types.js";
import { collaborationProfileSchema } from "../collaborationProfile.js";
import {
  COLLABORATION_PROFILE_COLORS,
  normalizeCollaborationProfile,
  type CollaborationProfile,
} from "../../shared/collaborationProfile.js";
import type {
  GuestRoom,
  GuestRoomLookup,
  GuestRoomResourceKind,
} from "../guestRooms.js";
import { GuestRoomCapacityError } from "../guestRooms.js";
import {
  deleteGuestCallRoomsBestEffort,
  ensureLiveKitCallRoom,
  isLiveKitNotFoundError,
} from "../livekit.js";
import {
  BOARD_PROTOCOL_LIMITS,
} from "../../board/protocol/index.js";
import {
  BOARD_SYNC_SERVER_CAPABILITIES,
  BoardSyncServiceError,
} from "../board-v2/sync-service.js";

const resourceKindSchema = z.enum(["board", "code", "call"]);
const createRoomSchema = z.object({
  initialResource: resourceKindSchema,
  draft: z.boolean().default(false),
}).strict();
const initializationSchema = z.object({
  initializationToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict();
const callTokenSchema = z.object({
  deviceId: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u).optional(),
  profile: collaborationProfileSchema.optional(),
}).strict();
const callProfileSchema = z.object({
  deviceId: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u),
  profile: collaborationProfileSchema,
}).strict();
const boardTicketSchema = z.object({
  deviceId: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u),
  minSchemaVersion: z.number().int().min(1)
    .max(BOARD_PROTOCOL_LIMITS.maxSchemaVersion).default(1),
  maxSchemaVersion: z.number().int().min(1)
    .max(BOARD_PROTOCOL_LIMITS.maxSchemaVersion).default(1),
  capabilities: z.number().int().min(0).max(0xffff_ffff)
    .default(BOARD_SYNC_SERVER_CAPABILITIES),
  profile: collaborationProfileSchema.optional(),
}).strict().refine(
  (value) => value.minSchemaVersion <= value.maxSchemaVersion,
  { path: ["minSchemaVersion"], message: "Invalid schema version range" },
);
const SHARE_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CALL_TOKEN_TTL_SECONDS = 15 * 60;

function guestCallIdentity(
  context: AppContext,
  shareKey: string,
  deviceId?: string,
): { identity: string; fallbackProfile: CollaborationProfile } {
  const connectionId = randomUUID();
  const digest = deviceId
    ? createHmac("sha256", context.config.authLookupKey)
        .update("eduri-guest-call-actor\0")
        .update(shareKey)
        .update("\0")
        .update(deviceId)
        .digest()
    : createHash("sha256").update(connectionId).digest();
  return {
    identity: `guest:${deviceId ? digest.toString("base64url") : connectionId}`,
    fallbackProfile: {
      displayName: `Гость ${digest.toString("hex").slice(0, 4).toUpperCase()}`,
      color: COLLABORATION_PROFILE_COLORS[
        digest[0] % COLLABORATION_PROFILE_COLORS.length
      ],
    },
  };
}

export function guestRoomCreationLimit(
  nodeEnv: AppContext["config"]["nodeEnv"],
): number {
  return nodeEnv === "production" ? 5 : 10_000;
}

function resourcePath(shareKey: string, kind: GuestRoomResourceKind): string {
  return `/room/${shareKey}/${kind}`;
}

function serializeRoom(room: GuestRoom): object {
  return {
    shareId: room.shareKey,
    createdAt: room.createdAt,
    lastActivityAt: room.lastActivityAt,
    expiresAt: room.expiresAt,
    roomUrl: `/room/${room.shareKey}`,
    resources: room.resources.map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      ordinal: resource.ordinal,
      url: resourcePath(room.shareKey, resource.kind),
      createdAt: resource.createdAt,
      lastActivityAt: resource.lastActivityAt,
    })),
  };
}

function sendLookupFailure(res: Response, lookup: GuestRoomLookup): void {
  res.setHeader("Cache-Control", "no-store");
  if (lookup.status === "expired") {
    res.status(410).json({
      code: "ROOM_EXPIRED",
      error: "Сеанс завершён",
    });
    return;
  }
  res.status(404).json({
    code: "ROOM_NOT_FOUND",
    error: "Сеанс не найден",
  });
}

export function createGuestRoomsRouter(context: AppContext): Router {
  const router = Router();
  const allowedOrigins = new Set(context.config.appOrigins.map((origin) => (
    origin.replace(/\/$/u, "")
  )));
  const createLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: guestRoomCreationLimit(context.config.nodeEnv),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: "Слишком много созданных сеансов" });
    },
  });
  const mutationLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: context.config.nodeEnv === "test" ? 10_000 : 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  const callTokenLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: context.config.nodeEnv === "test" ? 10_000 : 12,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });

  router.use((req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      next();
      return;
    }
    const origin = req.get("origin")?.replace(/\/$/u, "");
    if (!origin || !allowedOrigins.has(origin)) {
      next(new HttpError(403, "Guest room mutations require an allowed Origin"));
      return;
    }
    next();
  });

  router.post("/", createLimiter, (req, res, next) => {
    try {
      const parsed = parseBody(createRoomSchema, req.body);
      const ownerUserId = getAuth(res)?.user.id ?? null;
      const created = parsed.draft
        ? context.guestRooms.createDraft(parsed.initialResource, ownerUserId)
        : {
            room: context.guestRooms.create(parsed.initialResource, ownerUserId),
            initializationToken: undefined,
          };
      res.setHeader("Cache-Control", "no-store");
      res.status(201).json({
        room: serializeRoom(created.room),
        ...(created.initializationToken
          ? { initializationToken: created.initializationToken }
          : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:shareKey/initialization/finalize",
    mutationLimiter,
    (req, res, next) => {
      try {
        const shareKey = req.params.shareKey;
        if (!SHARE_KEY_PATTERN.test(shareKey)) {
          sendLookupFailure(res, { status: "missing" });
          return;
        }
        const parsed = parseBody(initializationSchema, req.body);
        const result = context.guestRooms.finalizeDraft(
          shareKey,
          parsed.initializationToken,
        );
        res.setHeader("Cache-Control", "no-store");
        if (result.status === "active") {
          res.json({ room: serializeRoom(result.room) });
          return;
        }
        if (result.status === "expired") {
          sendLookupFailure(res, { status: "expired" });
          return;
        }
        if (result.status === "missing") {
          sendLookupFailure(res, result);
          return;
        }
        res.status(404).json({
          code: "ROOM_INITIALIZATION_NOT_FOUND",
          error: "Инициализация сеанса не найдена",
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    "/:shareKey/initialization",
    mutationLimiter,
    (req, res, next) => {
      try {
        const shareKey = req.params.shareKey;
        if (!SHARE_KEY_PATTERN.test(shareKey)) {
          sendLookupFailure(res, { status: "missing" });
          return;
        }
        const parsed = parseBody(initializationSchema, req.body);
        const result = context.guestRooms.cancelDraft(
          shareKey,
          parsed.initializationToken,
        );
        res.setHeader("Cache-Control", "no-store");
        if (result.status === "cancelled") {
          res.json({ cancelled: true });
          return;
        }
        if (result.status === "expired") {
          sendLookupFailure(res, { status: "expired" });
          return;
        }
        if (result.status === "missing") {
          sendLookupFailure(res, result);
          return;
        }
        res.status(result.status === "already-finalized" ? 409 : 404).json({
          code: result.status === "already-finalized"
            ? "ROOM_ALREADY_INITIALIZED"
            : "ROOM_INITIALIZATION_NOT_FOUND",
          error: result.status === "already-finalized"
            ? "Сеанс уже запущен"
            : "Инициализация сеанса не найдена",
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/:shareKey", (req, res) => {
    const shareKey = req.params.shareKey;
    if (!SHARE_KEY_PATTERN.test(shareKey)) {
      sendLookupFailure(res, { status: "missing" });
      return;
    }
    const lookup = context.guestRooms.lookup(shareKey);
    if (lookup.status !== "active") {
      sendLookupFailure(res, lookup);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ room: serializeRoom(lookup.room) });
  });

  router.put("/:shareKey/resources/:kind", mutationLimiter, (req, res, next) => {
    try {
      const shareKey = req.params.shareKey;
      const parsedKind = resourceKindSchema.safeParse(req.params.kind);
      if (!SHARE_KEY_PATTERN.test(shareKey) || !parsedKind.success) {
        sendLookupFailure(res, { status: "missing" });
        return;
      }
      const result = context.guestRooms.ensureResource(
        shareKey,
        parsedKind.data,
      );
      if ("status" in result) {
        sendLookupFailure(res, result);
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.status(result.created ? 201 : 200).json({
        created: result.created,
        room: serializeRoom(result.room),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:shareKey/call-token", mutationLimiter, callTokenLimiter, async (req, res, next) => {
    try {
      const shareKey = req.params.shareKey;
      if (!SHARE_KEY_PATTERN.test(shareKey)) {
        sendLookupFailure(res, { status: "missing" });
        return;
      }
      const parsed = parseBody(callTokenSchema, req.body ?? {});
      const lookup = context.guestRooms.lookup(shareKey);
      if (lookup.status !== "active") {
        sendLookupFailure(res, lookup);
        return;
      }
      const call = lookup.room.resources.find((resource) => (
        resource.kind === "call" && resource.ordinal === 1
      ));
      if (!call) {
        res.status(409).json({
          code: "CALL_NOT_ENABLED",
          error: "Звонок не добавлен в эту комнату",
        });
        return;
      }
      const { livekitUrl, livekitApiKey, livekitApiSecret } = context.config;
      const liveKitRoomService = context.livekitRoomService;
      if (
        !livekitUrl
        || !livekitApiKey
        || !livekitApiSecret
        || !liveKitRoomService
      ) {
        res.status(503).json({ error: "Сервис звонков временно недоступен" });
        return;
      }
      const activation = context.guestRooms.activateCall(
        lookup.room.id,
        call.id,
      );
      if (!activation) {
        sendLookupFailure(res, context.guestRooms.lookup(shareKey));
        return;
      }
      const roomName = activation.roomName;
      try {
        await ensureLiveKitCallRoom(liveKitRoomService, roomName);
      } catch (error) {
        console.error("[livekit] guest room provisioning failed", {
          roomName,
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(503).json({ error: "Сервис звонков временно недоступен" });
        return;
      }
      if (!context.guestRooms.isResourceActive(
        lookup.room.id,
        call.id,
        "call",
      )) {
        await deleteGuestCallRoomsBestEffort(liveKitRoomService, [roomName]);
        sendLookupFailure(res, context.guestRooms.lookup(shareKey));
        return;
      }
      const resolvedIdentity = guestCallIdentity(
        context,
        shareKey,
        parsed.deviceId,
      );
      const profile = parsed.profile
        ? normalizeCollaborationProfile(parsed.profile)
        : resolvedIdentity.fallbackProfile;
      const token = new AccessToken(livekitApiKey, livekitApiSecret, {
        identity: resolvedIdentity.identity,
        name: profile.displayName,
        ttl: CALL_TOKEN_TTL_SECONDS,
        attributes: {
          "eduri.role": "guest",
          "eduri.guestRoomId": lookup.room.id,
          "eduri.resourceId": call.id,
          "eduri.color": profile.color,
        },
      });
      token.addGrant({
        room: roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: false,
        canPublishSources: [
          TrackSource.CAMERA,
          TrackSource.MICROPHONE,
          TrackSource.SCREEN_SHARE,
          TrackSource.SCREEN_SHARE_AUDIO,
        ],
        canUpdateOwnMetadata: false,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({
        url: livekitUrl,
        token: await token.toJwt(),
        roomName,
        expiresAt: new Date(
          Date.now() + CALL_TOKEN_TTL_SECONDS * 1_000,
        ).toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/:shareKey/call-profile", mutationLimiter, async (req, res, next) => {
    try {
      const shareKey = req.params.shareKey;
      if (!SHARE_KEY_PATTERN.test(shareKey)) {
        sendLookupFailure(res, { status: "missing" });
        return;
      }
      const parsed = parseBody(callProfileSchema, req.body ?? {});
      const lookup = context.guestRooms.lookup(shareKey);
      if (lookup.status !== "active") {
        sendLookupFailure(res, lookup);
        return;
      }
      const call = lookup.room.resources.find((resource) => (
        resource.kind === "call" && resource.ordinal === 1
      ));
      if (!call) {
        res.status(409).json({
          code: "CALL_NOT_ENABLED",
          error: "Звонок не добавлен в эту комнату",
        });
        return;
      }
      const updateParticipant = context.livekitRoomService?.updateParticipant;
      if (!updateParticipant) {
        res.status(503).json({
          error: "Сервис звонков временно недоступен",
        });
        return;
      }
      const roomName = context.guestRooms.resolveCallRoomName(
        lookup.room.id,
        call.id,
      );
      if (!roomName) {
        sendLookupFailure(res, context.guestRooms.lookup(shareKey));
        return;
      }
      const identity = guestCallIdentity(
        context,
        shareKey,
        parsed.deviceId,
      ).identity;
      const profile = normalizeCollaborationProfile(parsed.profile);
      try {
        await updateParticipant.call(
          context.livekitRoomService,
          roomName,
          identity,
          {
            name: profile.displayName,
            attributes: { "eduri.color": profile.color },
          },
        );
      } catch (error) {
        if (isLiveKitNotFoundError(error)) {
          res.status(409).json({
            code: "CALL_PARTICIPANT_NOT_CONNECTED",
            error: "Участник ещё не подключён к звонку",
          });
          return;
        }
        console.error("[livekit] guest participant profile update failed", {
          roomName,
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(503).json({
          error: "Сервис звонков временно недоступен",
        });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post("/:shareKey/board-ticket", mutationLimiter, (req, res, next) => {
    try {
      const shareKey = req.params.shareKey;
      if (!SHARE_KEY_PATTERN.test(shareKey)) {
        sendLookupFailure(res, { status: "missing" });
        return;
      }
      const parsed = parseBody(boardTicketSchema, req.body);
      const minSchemaVersion = parsed.minSchemaVersion ?? 1;
      const maxSchemaVersion = parsed.maxSchemaVersion ?? 1;
      const capabilities = parsed.capabilities
        ?? BOARD_SYNC_SERVER_CAPABILITIES;
      if (!context.boardV2Sync) {
        res.status(503).json({
          code: "BOARD_V2_DISABLED",
          error: "Доска временно недоступна",
        });
        return;
      }
      const ticket = context.boardV2Sync.issueGuestTicket({
        shareKey,
        deviceId: parsed.deviceId,
        minSchemaVersion,
        maxSchemaVersion,
        capabilities,
        ...(parsed.profile
          ? { profile: normalizeCollaborationProfile(parsed.profile) }
          : {}),
      });
      res.setHeader("Cache-Control", "no-store");
      res.json(ticket);
    } catch (error) {
      if (error instanceof BoardSyncServiceError) {
        const status = error.code === "BOARD_GONE"
          ? 410
          : error.code === "NOT_FOUND"
            ? 404
            : error.code === "PROTOCOL_MISMATCH"
              ? 426
              : error.code === "SCHEMA_MISMATCH"
                ? 422
                : error.code === "RATE_LIMITED"
                  ? 429
                  : 403;
        res.setHeader("Cache-Control", "no-store");
        if (error.retryAfterMs !== undefined) {
          res.setHeader(
            "Retry-After",
            String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))),
          );
        }
        res.status(status).json({
          code: error.code === "BOARD_GONE" ? "ROOM_EXPIRED" : error.code,
          error: error.code === "BOARD_GONE" ? "Сеанс завершён" : error.message,
          ...(error.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: error.retryAfterMs }),
        });
        return;
      }
      next(error);
    }
  });

  router.use((
    error: unknown,
    _req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    if (!(error instanceof GuestRoomCapacityError)) {
      next(error);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", String(Math.ceil(error.retryAfterMs / 1_000)));
    res.status(503).json({
      code: "GUEST_CAPACITY_REACHED",
      error: "Guest-room capacity is temporarily exhausted",
      retryAfterMs: error.retryAfterMs,
    });
  });

  return router;
}
