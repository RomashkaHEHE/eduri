import type { Server as HttpServer } from "node:http";
import { parse as parseCookie } from "cookie";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import type { AppContext, AuthContext } from "./types.js";
import { nowIso, readAuthFromToken, sessionCookieName } from "./security.js";
import { parseJson, serializeMaterial } from "./serializers.js";
import {
  SocketAdmissionController,
  attachSocketWireIngress,
  getOrCreateSocketIngressGuard,
  type SocketTrafficLimits,
} from "./socketAbuse.js";

type Ack = (response: Record<string, unknown>) => void;

export interface RealtimeOptions {
  readonly lessonCodeEventsPerMinute?: number;
  readonly lessonCodeBytesPerMinute?: number;
  readonly maxLessonCodeRateScopes?: number;
  readonly lessonCodeRateScopeIdleMs?: number;
  readonly socketIngressEventsPerUserPerMinute?: number;
  readonly socketIngressBytesPerUserPerMinute?: number;
  readonly socketIngressEventsPerIpPerMinute?: number;
  readonly socketIngressBytesPerIpPerMinute?: number;
  readonly socketIngressEventsGlobalPerMinute?: number;
  readonly socketIngressBytesGlobalPerMinute?: number;
  readonly maxSocketIngressIpScopes?: number;
  readonly maxSocketIngressPrincipalScopes?: number;
  readonly socketIngressScopeIdleMs?: number;
  readonly maxConnections?: number;
  readonly maxConnectionsPerIp?: number;
  readonly connectionAttemptsPerMinute?: number;
  readonly connectionAttemptsPerIpPerMinute?: number;
  readonly maxAdmissionIpScopes?: number;
  readonly admissionScopeIdleMs?: number;
  readonly admissionReservationTtlMs?: number;
  readonly now?: () => number;
}

interface LessonCodeRateScope {
  windowStartedAt: number;
  events: number;
  bytes: number;
  lastSeenAt: number;
}

interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

class AggregateLessonCodeRateScopes {
  private readonly scopes = new Map<string, LessonCodeRateScope>();
  private nextSweepAt: number;

  constructor(
    private readonly maximumEvents: number,
    private readonly maximumBytes: number,
    private readonly maximumScopes: number,
    private readonly idleMs: number,
    private readonly now: () => number,
  ) {
    this.nextSweepAt = now() + 60_000;
  }

  consume(scopeId: string, bytes: number): RateLimitDecision {
    const now = this.now();
    const scope = this.scope(scopeId, now);
    if (!scope) return { allowed: false, retryAfterMs: 60_000 };
    if (now < scope.windowStartedAt || now - scope.windowStartedAt >= 60_000) {
      scope.windowStartedAt = now;
      scope.events = 0;
      scope.bytes = 0;
    }
    scope.lastSeenAt = now;
    const allowed = scope.events < this.maximumEvents
      && bytes <= this.maximumBytes - scope.bytes;
    // Rejected frames still used transport and parsing resources. Keep both
    // counters saturated instead of making either dimension free after the
    // other one reaches its boundary.
    scope.events = Math.min(this.maximumEvents, scope.events + 1);
    scope.bytes = Math.min(this.maximumBytes, scope.bytes + bytes);
    return {
      allowed,
      retryAfterMs: Math.max(1, scope.windowStartedAt + 60_000 - now),
    };
  }

  private scope(scopeId: string, now: number): LessonCodeRateScope | undefined {
    this.sweep(now, false);
    const current = this.scopes.get(scopeId);
    if (current) return current;
    if (this.scopes.size >= this.maximumScopes) {
      this.sweep(now, true);
      if (this.scopes.size >= this.maximumScopes) return undefined;
    }
    const created: LessonCodeRateScope = {
      windowStartedAt: now,
      events: 0,
      bytes: 0,
      lastSeenAt: now,
    };
    this.scopes.set(scopeId, created);
    return created;
  }

  private sweep(now: number, force: boolean): void {
    if (!force && now < this.nextSweepAt) return;
    for (const [scopeId, scope] of this.scopes) {
      if (now < scope.lastSeenAt || now - scope.lastSeenAt >= this.idleMs) {
        this.scopes.delete(scopeId);
      }
    }
    this.nextSweepAt = now + 60_000;
  }
}

const joinSchema = z.union([
  z.string().uuid().transform((lessonId) => ({ lessonId })),
  z.object({ lessonId: z.string().uuid() }),
]);

const stateSchema = z.object({
  lessonId: z.string().uuid(),
  scene: z.unknown().optional(),
});

const codeEventSchema = z.object({
  lessonId: z.string().uuid(),
  code: z.object({
    language: z.literal("python"),
    value: z.string().max(1_000_000),
  }).strict(),
}).strict();

const materialEventSchema = z.object({
  lessonId: z.string().uuid(),
  material: z.object({ id: z.string().uuid() }).passthrough().optional(),
  materials: z.array(z.object({ id: z.string().uuid() }).passthrough()).max(50).optional(),
}).refine((value) => value.material !== undefined || value.materials !== undefined);

const noteEventSchema = z.object({
  lessonId: z.string().uuid(),
  notes: z.string().max(20_000),
});

function safeAck(ack: Ack | undefined, payload: Record<string, unknown>): void {
  if (typeof ack === "function") ack(payload);
}

function authFor(socket: Socket): AuthContext {
  return socket.data.auth as AuthContext;
}

function canAccessLesson(context: AppContext, auth: AuthContext, lessonId: string): boolean {
  if (auth.user.role === "admin") return false;
  const row = context.db.prepare(`
    SELECT 1 FROM lessons l
    JOIN users actor ON actor.id = ? AND actor.status = 'active'
    JOIN sessions session ON session.session_hash = ? AND session.user_id = actor.id AND session.expires_at > ?
    WHERE l.id = ? AND (
      (? = 'tutor' AND l.tutor_id = ?) OR
      (? = 'student' AND l.student_id = ?)
    )
  `).get(auth.user.id, auth.sessionHash, nowIso(), lessonId, auth.user.role, auth.user.id, auth.user.role, auth.user.id);
  return Boolean(row);
}

function canMutateLesson(context: AppContext, auth: AuthContext, lessonId: string): boolean {
  if (!canAccessLesson(context, auth, lessonId)) return false;
  return Boolean(context.db.prepare(`
    SELECT 1 FROM lessons WHERE id = ? AND status IN ('scheduled', 'active')
  `).get(lessonId));
}

function serializedSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null));
}

function canonicalMaterials(context: AppContext, auth: AuthContext, lessonId: string, ids: string[]): Array<Record<string, unknown>> | null {
  if (ids.length === 0) return [];
  const uniqueIds = [...new Set(ids)];
  const lesson = context.db.prepare("SELECT tutor_id, student_id FROM lessons WHERE id = ?").get(lessonId) as
    { tutor_id: string; student_id: string } | undefined;
  if (!lesson) return null;
  const placeholders = uniqueIds.map(() => "?").join(",");
  const rows = context.db.prepare(`
    SELECT m.*,
      (SELECT json_group_array(ma2.student_id) FROM material_access ma2 WHERE ma2.material_id = m.id) AS student_ids_json,
      ma.status AS progress_status, ma.lesson_id AS progress_lesson_id, ma.updated_at AS progress_updated_at
    FROM materials m
    LEFT JOIN material_access ma ON ma.material_id = m.id AND ma.student_id = ?
    WHERE m.tutor_id = ? AND m.id IN (${placeholders})
      AND (? = 'tutor' OR EXISTS (
        SELECT 1 FROM material_access own_access WHERE own_access.material_id = m.id AND own_access.student_id = ?
      ))
  `).all(lesson.student_id, lesson.tutor_id, ...uniqueIds, auth.user.role, auth.user.id) as Array<Record<string, unknown>>;
  if (rows.length !== uniqueIds.length) return null;
  const byId = new Map(rows.map((row) => {
    const material = serializeMaterial(row);
    delete material.studentIds;
    return [row.id as string, material];
  }));
  return ids.map((id) => byId.get(id)!).filter(Boolean);
}

export function attachRealtime(
  httpServer: HttpServer,
  context: AppContext,
  options: RealtimeOptions = {},
): Server {
  const now = options.now ?? (() => Date.now());
  const lessonCodeRates = new AggregateLessonCodeRateScopes(
    Math.max(1, Math.trunc(options.lessonCodeEventsPerMinute ?? 600)),
    Math.max(1, Math.trunc(options.lessonCodeBytesPerMinute ?? 64 * 1024 * 1024)),
    Math.max(1, Math.trunc(options.maxLessonCodeRateScopes ?? 10_000)),
    Math.max(60_000, options.lessonCodeRateScopeIdleMs ?? 120_000),
    now,
  );
  const admission = new SocketAdmissionController({
    maxConnections: Math.max(1, Math.trunc(options.maxConnections ?? 512)),
    maxConnectionsPerIp: Math.max(
      1,
      Math.trunc(options.maxConnectionsPerIp ?? 32),
    ),
    connectionAttemptsPerMinute: Math.max(
      1,
      Math.trunc(options.connectionAttemptsPerMinute ?? 4_000),
    ),
    connectionAttemptsPerIpPerMinute: Math.max(
      1,
      Math.trunc(options.connectionAttemptsPerIpPerMinute ?? 120),
    ),
    maxIpScopes: Math.max(1, Math.trunc(options.maxAdmissionIpScopes ?? 4_096)),
    scopeIdleMs: Math.max(60_000, options.admissionScopeIdleMs ?? 120_000),
    reservationTtlMs: Math.max(
      1_000,
      options.admissionReservationTtlMs ?? 10_000,
    ),
    trustedProxy: context.config.trustProxy,
    now,
  });
  const io = new Server(httpServer, {
    // Code update-v1 frames are bounded to 4 MiB; leave envelope headroom.
    maxHttpBufferSize: 5 * 1024 * 1024,
    cors: { origin: context.config.appOrigins, credentials: true },
    allowRequest: (request, callback) => {
      const allowed = admission.reserve(request);
      callback(allowed ? null : "Socket.IO admission limit reached", allowed);
    },
  });
  io.engine.prependListener("connection", (connection) => {
    const release = admission.activate(connection.request);
    if (!release) {
      connection.close(true);
      return;
    }
    connection.once("close", release);
  });
  const ingress = getOrCreateSocketIngressGuard(io, {
    global: {
      eventsPerMinute: Math.max(
        1,
        Math.trunc(options.socketIngressEventsGlobalPerMinute ?? 100_000),
      ),
      bytesPerMinute: Math.max(
        1,
        Math.trunc(options.socketIngressBytesGlobalPerMinute ?? 1024 * 1024 * 1024),
      ),
    },
    ip: {
      eventsPerMinute: Math.max(
        1,
        Math.trunc(options.socketIngressEventsPerIpPerMinute ?? 10_000),
      ),
      bytesPerMinute: Math.max(
        1,
        Math.trunc(options.socketIngressBytesPerIpPerMinute ?? 256 * 1024 * 1024),
      ),
    },
    maxIpScopes: Math.max(
      1,
      Math.trunc(options.maxSocketIngressIpScopes ?? 4_096),
    ),
    maxPrincipalScopes: Math.max(
      1,
      Math.trunc(options.maxSocketIngressPrincipalScopes ?? 10_000),
    ),
    scopeIdleMs: Math.max(60_000, options.socketIngressScopeIdleMs ?? 120_000),
    now,
  });
  const userIngressLimits: SocketTrafficLimits = {
    eventsPerMinute: Math.max(
      1,
      Math.trunc(options.socketIngressEventsPerUserPerMinute ?? 2_400),
    ),
    bytesPerMinute: Math.max(
      1,
      Math.trunc(options.socketIngressBytesPerUserPerMinute ?? 128 * 1024 * 1024),
    ),
  };
  const isWireIngressBlocked = attachSocketWireIngress(
    io,
    ingress,
    context.config.trustProxy,
  );
  context.disconnectUserSockets = (userId) => io.in(`auth:user:${userId}`).disconnectSockets(true);
  context.disconnectSessionSockets = (sessionHash) => io.in(`auth:session:${sessionHash}`).disconnectSockets(true);
  context.removeLessonSocketMembership = (lessonId, userId) => {
    const room = `lesson:${lessonId}`;
    for (const socket of io.sockets.sockets.values()) {
      const auth = authFor(socket);
      if (userId && auth.user.id !== userId) continue;
      const lessonIds = socket.data.lessonIds as Set<string>;
      lessonIds.delete(lessonId);
      if (socket.rooms.has(room)) void socket.leave(room);
    }
  };
  context.emitLessonStatus = (lessonId, status) => {
    io.to(`lesson:${lessonId}`).emit("lesson:status", { lessonId, status });
  };

  io.use((socket, next) => {
    if (isWireIngressBlocked(socket)) {
      next(new Error("Socket.IO ingress rate limit reached"));
      return;
    }
    const origin = socket.handshake.headers.origin;
    if (origin && !context.config.appOrigins.includes(origin.replace(/\/$/, ""))) {
      next(new Error("Origin is not allowed"));
      return;
    }
    const cookies = parseCookie(socket.handshake.headers.cookie ?? "");
    const auth = readAuthFromToken(context, cookies[sessionCookieName(context)]);
    if (!auth) {
      next(new Error("Unauthorized"));
      return;
    }
    socket.data.auth = auth;
    socket.data.lessonIds = new Set<string>();
    next();
  });

  io.on("connection", (socket) => {
    const connectedAuth = authFor(socket);
    socket.use((packet, next) => {
      const principalDecision = ingress.consumePrincipal(
        `lesson-user:${connectedAuth.user.id}`,
        userIngressLimits,
        packet,
      );
      const decision = isWireIngressBlocked(socket)
        ? {
          allowed: false,
          retryAfterMs: Math.max(60_000, principalDecision.retryAfterMs),
        }
        : principalDecision;
      if (decision.allowed) {
        next();
        return;
      }
      const ack = typeof packet.at(-1) === "function"
        ? packet.at(-1) as Ack
        : undefined;
      safeAck(ack, {
        ok: false,
        code: "RATE_LIMITED",
        error: "Слишком много realtime-данных. Подождите и повторите.",
        retryAfterMs: decision.retryAfterMs,
      });
      if (!socket.data.ingressDisconnectScheduled) {
        socket.data.ingressDisconnectScheduled = true;
        const timer = setTimeout(() => socket.disconnect(true), 0);
        timer.unref();
      }
    });
    socket.join(`auth:user:${connectedAuth.user.id}`);
    socket.join(`auth:session:${connectedAuth.sessionHash}`);
    socket.on("lesson:join", (payload: unknown, ack?: Ack) => {
      const parsed = joinSchema.safeParse(payload);
      if (!parsed.success) return safeAck(ack, { ok: false, error: "Некорректный lessonId" });
      const { lessonId } = parsed.data;
      const auth = authFor(socket);
      if (!canAccessLesson(context, auth, lessonId)) return safeAck(ack, { ok: false, error: "Доступ запрещен" });
      const lesson = context.db.prepare(`
        SELECT id, status, board_state, code_state, board_revision, code_revision
        FROM lessons WHERE id = ?
      `).get(lessonId) as Record<string, unknown>;
      socket.join(`lesson:${lessonId}`);
      (socket.data.lessonIds as Set<string>).add(lessonId);
      socket.to(`lesson:${lessonId}`).emit("lesson:presence", {
        lessonId,
        user: auth.user,
        state: "joined",
      });
      safeAck(ack, {
        ok: true,
        lesson: {
          id: lesson.id,
          status: lesson.status,
          boardState: parseJson(lesson.board_state as string, {}),
          codeState: parseJson(lesson.code_state as string, {}),
          boardRevision: lesson.board_revision,
          codeRevision: lesson.code_revision,
        },
      });
    });

    socket.on("lesson:scene", (payload: unknown, ack?: Ack) => {
      const parsed = stateSchema.safeParse(payload);
      if (!parsed.success || parsed.data.scene === undefined) return safeAck(ack, { ok: false, error: "Некорректная сцена" });
      const { lessonId } = parsed.data;
      const auth = authFor(socket);
      if (!(socket.data.lessonIds as Set<string>).has(lessonId) || !canMutateLesson(context, auth, lessonId)) {
        return safeAck(ack, { ok: false, error: "Урок доступен только для чтения" });
      }
      return safeAck(ack, {
        ok: false,
        code: "BOARD_ENGINE_MISMATCH",
        error: "Legacy scene writes are disabled; Eduri uses Board v2",
      });
    });

    socket.on("lesson:code", (payload: unknown, ack?: Ack) => {
      const parsed = codeEventSchema.safeParse(payload);
      if (!parsed.success) return safeAck(ack, { ok: false, error: "Некорректное состояние кода" });
      const { lessonId, code } = parsed.data;
      const auth = authFor(socket);
      if (!(socket.data.lessonIds as Set<string>).has(lessonId) || !canMutateLesson(context, auth, lessonId)) {
        return safeAck(ack, { ok: false, error: "Урок доступен только для чтения" });
      }
      const codeBytes = serializedSize(code);
      if (codeBytes > 1_000_000) return safeAck(ack, { ok: false, error: "Состояние кода слишком большое" });
      const rate = lessonCodeRates.consume(
        `${auth.user.id}\0${lessonId}`,
        codeBytes,
      );
      if (!rate.allowed) {
        return safeAck(ack, {
          ok: false,
          code: "RATE_LIMITED",
          error: "Слишком много изменений кода. Подождите и повторите.",
          retryAfterMs: rate.retryAfterMs,
        });
      }
      const now = nowIso();
      context.db.prepare(`
        UPDATE lessons SET code_state = ?, code_revision = code_revision + 1, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(code), now, lessonId);
      const revision = (context.db.prepare("SELECT code_revision FROM lessons WHERE id = ?").get(lessonId) as { code_revision: number }).code_revision;
      socket.to(`lesson:${lessonId}`).emit("lesson:code", { lessonId, code, revision, updatedBy: auth.user.id });
      safeAck(ack, { ok: true, revision });
    });

    socket.on("lesson:material", (payload: unknown, ack?: Ack) => {
      const parsed = materialEventSchema.safeParse(payload);
      if (!parsed.success || serializedSize(payload) > 500_000) {
        return safeAck(ack, { ok: false, error: "Некорректный материал" });
      }
      const { lessonId, material, materials } = parsed.data;
      const auth = authFor(socket);
      if (!(socket.data.lessonIds as Set<string>).has(lessonId) || !canMutateLesson(context, auth, lessonId)) {
        return safeAck(ack, { ok: false, error: "Урок доступен только для чтения" });
      }
      const references = materials ?? (material ? [material] : []);
      const canonical = canonicalMaterials(context, auth, lessonId, references.map((item) => item.id));
      if (!canonical) return safeAck(ack, { ok: false, error: "Материал недоступен" });
      socket.to(`lesson:${lessonId}`).emit("lesson:material", {
        lessonId,
        ...(material !== undefined ? { material: canonical[0] } : {}),
        ...(materials !== undefined ? { materials: canonical } : {}),
        sharedBy: auth.user.id,
      });
      safeAck(ack, { ok: true });
    });

    socket.on("lesson:note", (payload: unknown, ack?: Ack) => {
      const parsed = noteEventSchema.safeParse(payload);
      if (!parsed.success) return safeAck(ack, { ok: false, error: "Некорректная заметка" });
      const { lessonId, notes } = parsed.data;
      const auth = authFor(socket);
      if (auth.user.role !== "tutor" || !(socket.data.lessonIds as Set<string>).has(lessonId) || !canAccessLesson(context, auth, lessonId)) {
        return safeAck(ack, { ok: false, error: "Доступ запрещен" });
      }
      // Tutor notes are private. The REST endpoint persists them; the event only acknowledges local autosave intent.
      safeAck(ack, { ok: true });
    });

    socket.on("disconnecting", () => {
      const auth = authFor(socket);
      for (const lessonId of socket.data.lessonIds as Set<string>) {
        socket.to(`lesson:${lessonId}`).emit("lesson:presence", {
          lessonId,
          user: auth.user,
          state: "left",
        });
      }
    });
  });

  return io;
}
