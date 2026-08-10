import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { NextFunction, Request, Response } from "express";
import type { AppContext, AuthContext, AuthUser, StoredUserRow } from "./types.js";
import { enqueueLessonRoomRevocation } from "./livekit-revocation.js";

export function sessionCookieName(context: AppContext): string {
  return context.config.nodeEnv === "production" ? "__Host-eduri_session" : "eduri_session";
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function normalizeLogin(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("ru-RU");
}

export function normalizeCodeWord(value: string): string {
  return value.normalize("NFKC").trim();
}

export function studentCredentialLookup(key: string, loginName: string, codeWord: string): string {
  return crypto
    .createHmac("sha256", key)
    .update(normalizeLogin(loginName))
    .update("\0")
    .update(normalizeCodeWord(codeWord))
    .digest("hex");
}

export function csrfForSession(key: string, rawSessionToken: string): string {
  return crypto.createHmac("sha256", key).update("csrf\0").update(rawSessionToken).digest("base64url");
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function hashPassword(value: string, rounds: number): string {
  return bcrypt.hashSync(value, rounds);
}

export function verifyPassword(value: string, hash: string): Promise<boolean> {
  return bcrypt.compare(value, hash);
}

export function toAuthUser(row: StoredUserRow): AuthUser {
  return {
    id: row.id,
    role: row.role,
    status: row.status,
    displayName: row.display_name,
    ...(row.login_name ? { loginName: row.login_name } : {}),
    ...(row.role === "student" ? { tutorId: row.tutor_id } : {}),
  };
}

export function getClientIp(req: Request): string | null {
  return req.ip || req.socket.remoteAddress || null;
}

export function createSession(context: AppContext, user: StoredUserRow, req: Request): { token: string; csrfToken: string; expiresAt: string } {
  const token = randomToken();
  const sessionHash = sha256(token);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + context.config.sessionTtlHours * 60 * 60 * 1000).toISOString();
  context.db.prepare(`
    INSERT INTO sessions (session_hash, user_id, expires_at, created_at, last_seen_at, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sessionHash, user.id, expiresAt, createdAt, createdAt, getClientIp(req), req.get("user-agent") ?? null);
  context.db.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?").run(createdAt, createdAt, user.id);
  return { token, csrfToken: csrfForSession(context.config.authLookupKey, token), expiresAt };
}

export function setSessionCookie(res: Response, context: AppContext, token: string): void {
  res.cookie(sessionCookieName(context), token, {
    httpOnly: true,
    secure: context.config.nodeEnv === "production",
    sameSite: "lax",
    path: "/",
    maxAge: context.config.sessionTtlHours * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response, context: AppContext): void {
  res.clearCookie(sessionCookieName(context), {
    httpOnly: true,
    secure: context.config.nodeEnv === "production",
    sameSite: "lax",
    path: "/",
  });
}

export function readAuthFromToken(context: AppContext, rawToken: string | undefined): AuthContext | null {
  if (!rawToken || rawToken.length < 32 || rawToken.length > 256) return null;
  const row = context.db.prepare(`
    SELECT u.*, s.session_hash, s.expires_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.session_hash = ? AND s.expires_at > ? AND u.status = 'active'
  `).get(sha256(rawToken), nowIso()) as (StoredUserRow & { session_hash: string; expires_at: string }) | undefined;
  if (!row) return null;
  return { user: toAuthUser(row), sessionHash: row.session_hash, rawSessionToken: rawToken };
}

export function authMiddleware(context: AppContext) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rawToken = req.cookies?.[sessionCookieName(context)] as string | undefined;
    const auth = readAuthFromToken(context, rawToken);
    res.locals.auth = auth;
    if (auth) {
      context.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE session_hash = ? AND last_seen_at < ?")
        .run(nowIso(), auth.sessionHash, new Date(Date.now() - 5 * 60 * 1000).toISOString());
    }
    next();
  };
}

export function getAuth(res: Response): AuthContext | null {
  return (res.locals.auth as AuthContext | null | undefined) ?? null;
}

export function persistUserAccessRevocation(
  context: AppContext,
  userId: string,
  options: {
    rotateLessonRooms?: boolean;
    timestamp?: string;
  } = {},
): number {
  const timestamp = options.timestamp ?? nowIso();
  const lessons = context.db.prepare(`
    SELECT id, meeting_key
    FROM lessons
    WHERE status IN ('scheduled', 'active')
      AND (tutor_id = ? OR student_id = ?)
  `).all(userId, userId) as Array<{
    id: string;
    meeting_key: string;
  }>;

  const rotate = context.db.prepare(`
    UPDATE lessons SET meeting_key = ?, updated_at = ?
    WHERE id = ? AND meeting_key = ? AND status IN ('scheduled', 'active')
  `);
  for (const lesson of lessons) {
    enqueueLessonRoomRevocation(context.db, {
      meetingKey: lesson.meeting_key,
    }, timestamp);
    if (options.rotateLessonRooms !== false) {
      rotate.run(
        randomToken(24),
        timestamp,
        lesson.id,
        lesson.meeting_key,
      );
    }
  }
  context.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  return lessons.length;
}

export function disconnectUserRealtime(context: AppContext, userId: string): void {
  context.disconnectUserSockets?.(userId);
}

export function completeUserAccessRevocation(
  context: AppContext,
  userId: string,
): void {
  disconnectUserRealtime(context, userId);
  void context.runLiveKitRevocationMaintenance?.().catch(() => {
    // The durable outbox remains authoritative. Do not log SDK/request details;
    // the periodic worker will retry the opaque room target.
    console.error("[livekit] durable user revocation maintenance deferred", {
      userId,
    });
  });
}
