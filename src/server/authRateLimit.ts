import crypto from "node:crypto";
import { isIP } from "node:net";
import type Database from "better-sqlite3";
import type { Request, RequestHandler, Response } from "express";

export type AuthRateLimitScope =
  | "login_ip"
  | "login_account"
  | "activation_ip"
  | "activation_token";

export interface AuthRateLimitPolicy {
  limit: number;
  windowMs: number;
}

export interface AuthRateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterMs: number;
}

export const AUTH_RATE_LIMIT_POLICIES = Object.freeze({
  loginIp: Object.freeze({ limit: 30, windowMs: 15 * 60 * 1_000 }),
  loginAccount: Object.freeze({ limit: 15, windowMs: 15 * 60 * 1_000 }),
  activationIp: Object.freeze({ limit: 30, windowMs: 15 * 60 * 1_000 }),
  activationToken: Object.freeze({ limit: 10, windowMs: 15 * 60 * 1_000 }),
} satisfies Record<string, AuthRateLimitPolicy>);

export const AUTH_RATE_LIMIT_MAX_BUCKETS = 50_000;
const AUTH_RATE_LIMIT_CLEANUP_BATCH = 512;
const AUTH_RATE_LIMIT_RETENTION_WINDOWS = 2;
const AUTH_RATE_LIMIT_MAX_COUNT = 1_000_000;

interface AuthRateLimitRow {
  window_started_at: number;
  attempt_count: number;
  expires_at: number;
}

export interface AuthRateLimitStoreOptions {
  now?: () => number;
  maxBuckets?: number;
  cleanupBatch?: number;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function validatePolicy(policy: AuthRateLimitPolicy): void {
  positiveInteger("auth rate limit", policy.limit);
  positiveInteger("auth rate window", policy.windowMs);
  if (policy.limit >= AUTH_RATE_LIMIT_MAX_COUNT) {
    throw new Error(`auth rate limit must be below ${AUTH_RATE_LIMIT_MAX_COUNT}`);
  }
}

export function installAuthRateLimitSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE auth_rate_limit_buckets (
      scope TEXT NOT NULL CHECK (
        scope IN (
          'login_ip', 'login_account', 'activation_ip', 'activation_token'
        )
      ),
      subject_hash TEXT NOT NULL CHECK (
        length(subject_hash) = 64
        AND subject_hash NOT GLOB '*[^0-9a-f]*'
      ),
      window_started_at INTEGER NOT NULL CHECK (window_started_at >= 0),
      attempt_count INTEGER NOT NULL CHECK (
        attempt_count BETWEEN 1 AND ${AUTH_RATE_LIMIT_MAX_COUNT}
      ),
      expires_at INTEGER NOT NULL CHECK (expires_at > window_started_at),
      updated_at INTEGER NOT NULL CHECK (updated_at >= window_started_at),
      PRIMARY KEY (scope, subject_hash)
    );
    CREATE INDEX auth_rate_limit_buckets_expiry_idx
      ON auth_rate_limit_buckets(expires_at);
  `);
}

export function authRateLimitSubjectHash(
  key: string,
  scope: AuthRateLimitScope,
  subject: string,
): string {
  return crypto
    .createHmac("sha256", key)
    .update("eduri-auth-rate-v1\0")
    .update(scope)
    .update("\0")
    .update(subject)
    .digest("hex");
}

export class AuthRateLimitStore {
  private readonly now: () => number;
  private readonly maxBuckets: number;
  private readonly cleanupBatch: number;

  constructor(
    private readonly db: Database.Database,
    private readonly key: string,
    options: AuthRateLimitStoreOptions = {},
  ) {
    if (!key) throw new Error("auth rate limit key is required");
    this.now = options.now ?? Date.now;
    this.maxBuckets = positiveInteger(
      "auth rate max buckets",
      options.maxBuckets ?? AUTH_RATE_LIMIT_MAX_BUCKETS,
    );
    if (this.maxBuckets > AUTH_RATE_LIMIT_MAX_BUCKETS) {
      throw new Error(
        `auth rate max buckets must not exceed ${AUTH_RATE_LIMIT_MAX_BUCKETS}`,
      );
    }
    this.cleanupBatch = positiveInteger(
      "auth rate cleanup batch",
      options.cleanupBatch ?? AUTH_RATE_LIMIT_CLEANUP_BATCH,
    );
  }

  consume(
    scope: AuthRateLimitScope,
    subject: string,
    policy: AuthRateLimitPolicy,
  ): AuthRateLimitResult {
    validatePolicy(policy);
    if (!subject) throw new Error("auth rate limit subject is required");
    const now = Math.trunc(this.now());
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("auth rate limit clock returned an invalid timestamp");
    }
    const subjectHash = authRateLimitSubjectHash(this.key, scope, subject);
    const consume = this.db.transaction((): AuthRateLimitResult => {
      this.cleanupExpired(now);
      const row = this.db.prepare(`
        SELECT window_started_at, attempt_count, expires_at
        FROM auth_rate_limit_buckets
        WHERE scope = ? AND subject_hash = ?
      `).get(scope, subjectHash) as AuthRateLimitRow | undefined;
      const windowEndsAt = row
        ? row.window_started_at + policy.windowMs
        : now + policy.windowMs;

      if (!row || windowEndsAt <= now) {
        if (!row && this.bucketCount() >= this.maxBuckets) {
          return this.denied(policy, policy.windowMs);
        }
        const expiresAt = now + policy.windowMs * AUTH_RATE_LIMIT_RETENTION_WINDOWS;
        this.db.prepare(`
          INSERT INTO auth_rate_limit_buckets (
            scope, subject_hash, window_started_at, attempt_count,
            expires_at, updated_at
          ) VALUES (?, ?, ?, 1, ?, ?)
          ON CONFLICT(scope, subject_hash) DO UPDATE SET
            window_started_at = excluded.window_started_at,
            attempt_count = 1,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
        `).run(scope, subjectHash, now, expiresAt, now);
        return {
          allowed: true,
          limit: policy.limit,
          remaining: policy.limit - 1,
          retryAfterMs: policy.windowMs,
        };
      }

      const nextCount = Math.min(row.attempt_count + 1, policy.limit + 1);
      this.db.prepare(`
        UPDATE auth_rate_limit_buckets
        SET attempt_count = ?, updated_at = ?
        WHERE scope = ? AND subject_hash = ?
      `).run(nextCount, now, scope, subjectHash);
      const retryAfterMs = Math.max(1, windowEndsAt - now);
      if (nextCount > policy.limit) return this.denied(policy, retryAfterMs);
      return {
        allowed: true,
        limit: policy.limit,
        remaining: policy.limit - nextCount,
        retryAfterMs,
      };
    });
    return consume.immediate();
  }

  reset(scope: AuthRateLimitScope, subject: string): void {
    if (!subject) return;
    this.db.prepare(`
      DELETE FROM auth_rate_limit_buckets
      WHERE scope = ? AND subject_hash = ?
    `).run(scope, authRateLimitSubjectHash(this.key, scope, subject));
  }

  private cleanupExpired(now: number): void {
    this.db.prepare(`
      DELETE FROM auth_rate_limit_buckets
      WHERE (scope, subject_hash) IN (
        SELECT scope, subject_hash
        FROM auth_rate_limit_buckets
        WHERE expires_at <= ?
        ORDER BY expires_at
        LIMIT ?
      )
    `).run(now, this.cleanupBatch);
  }

  private bucketCount(): number {
    return (this.db.prepare(`
      SELECT COUNT(*) AS count FROM auth_rate_limit_buckets
    `).get() as { count: number }).count;
  }

  private denied(
    policy: AuthRateLimitPolicy,
    retryAfterMs: number,
  ): AuthRateLimitResult {
    return {
      allowed: false,
      limit: policy.limit,
      remaining: 0,
      retryAfterMs,
    };
  }
}

export function authSourceIp(req: Request): string {
  const candidate = (req.ip || req.socket.remoteAddress || "unknown").trim();
  const withoutMappedPrefix = candidate.toLowerCase().startsWith("::ffff:")
    ? candidate.slice(7)
    : candidate;
  return isIP(withoutMappedPrefix) ? withoutMappedPrefix.toLowerCase() : "unknown";
}

export function sendAuthRateLimitResponse(
  res: Response,
  result: AuthRateLimitResult,
): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1_000));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", String(retryAfterSeconds));
  return res.status(429).json({
    error: "Слишком много попыток. Попробуйте позже",
  });
}

export function authIpRateLimit(
  store: AuthRateLimitStore,
  family: "login" | "activation",
): RequestHandler {
  const scope = family === "login" ? "login_ip" : "activation_ip";
  const policy = family === "login"
    ? AUTH_RATE_LIMIT_POLICIES.loginIp
    : AUTH_RATE_LIMIT_POLICIES.activationIp;
  return (req, res, next): void => {
    const result = store.consume(scope, authSourceIp(req), policy);
    if (!result.allowed) {
      sendAuthRateLimitResponse(res, result);
      return;
    }
    next();
  };
}
