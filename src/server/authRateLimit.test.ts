import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthRateLimitStore,
  authRateLimitSubjectHash,
} from "./authRateLimit.js";
import {
  MIN_STUDENT_SECRET_LENGTH,
  newStudentSecretIssue,
} from "./credentialPolicy.js";
import { migrate } from "./db.js";

const LOOKUP_KEY = "auth-rate-limit-test-key-at-least-32-bytes";
const TEST_POLICY = { limit: 2, windowMs: 1_000 } as const;

const databases = new Set<Database.Database>();
const temporaryDirectories = new Set<string>();

function openDatabase(filename = ":memory:"): Database.Database {
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  if (filename !== ":memory:") db.pragma("journal_mode = WAL");
  migrate(db);
  databases.add(db);
  return db;
}

afterEach(() => {
  for (const db of databases) {
    if (db.open) db.close();
  }
  databases.clear();
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe("durable authentication rate limits", () => {
  it("shares one fixed window across SQLite connections without storing raw subjects", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-auth-rate-"));
    temporaryDirectories.add(directory);
    const filename = path.join(directory, "auth-rate.sqlite");
    const firstDb = openDatabase(filename);
    const secondDb = openDatabase(filename);
    let now = 10_000;
    const first = new AuthRateLimitStore(firstDb, LOOKUP_KEY, { now: () => now });
    const second = new AuthRateLimitStore(secondDb, LOOKUP_KEY, { now: () => now });

    expect(first.consume("login_account", "staff\0private-login", TEST_POLICY))
      .toMatchObject({ allowed: true, remaining: 1 });
    expect(second.consume("login_account", "staff\0private-login", TEST_POLICY))
      .toMatchObject({ allowed: true, remaining: 0 });
    expect(first.consume("login_account", "staff\0private-login", TEST_POLICY))
      .toMatchObject({ allowed: false, remaining: 0, retryAfterMs: 1_000 });

    const stored = firstDb.prepare(`
      SELECT scope, subject_hash, attempt_count
      FROM auth_rate_limit_buckets
    `).all() as Array<Record<string, unknown>>;
    expect(stored).toEqual([{
      scope: "login_account",
      subject_hash: authRateLimitSubjectHash(
        LOOKUP_KEY,
        "login_account",
        "staff\0private-login",
      ),
      attempt_count: 3,
    }]);
    expect(JSON.stringify(stored)).not.toContain("private-login");

    now += 900;
    expect(second.consume("login_account", "staff\0private-login", TEST_POLICY))
      .toMatchObject({ allowed: false, retryAfterMs: 100 });
    now += 100;
    expect(first.consume("login_account", "staff\0private-login", TEST_POLICY))
      .toMatchObject({ allowed: true, remaining: 1 });
  });

  it("caps durable bucket cardinality and releases expired capacity", () => {
    const db = openDatabase();
    let now = 1_000;
    const store = new AuthRateLimitStore(db, LOOKUP_KEY, {
      now: () => now,
      maxBuckets: 2,
      cleanupBatch: 2,
    });

    expect(store.consume("login_ip", "192.0.2.1", TEST_POLICY).allowed).toBe(true);
    expect(store.consume("login_ip", "192.0.2.2", TEST_POLICY).allowed).toBe(true);
    expect(store.consume("login_ip", "192.0.2.3", TEST_POLICY))
      .toMatchObject({ allowed: false, retryAfterMs: TEST_POLICY.windowMs });
    expect((db.prepare(`
      SELECT COUNT(*) AS count FROM auth_rate_limit_buckets
    `).get() as { count: number }).count).toBe(2);

    now += TEST_POLICY.windowMs * 2 + 1;
    expect(store.consume("login_ip", "192.0.2.3", TEST_POLICY).allowed).toBe(true);
    expect((db.prepare(`
      SELECT COUNT(*) AS count FROM auth_rate_limit_buckets
    `).get() as { count: number }).count).toBe(1);
  });

  it("adds the limiter only in migration v18", () => {
    const db = new Database(":memory:");
    databases.add(db);
    db.pragma("foreign_keys = ON");
    migrate(db, { targetVersion: 17 });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'auth_rate_limit_buckets'
    `).get()).toBeUndefined();

    migrate(db, { targetVersion: 18 });

    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'auth_rate_limit_buckets'
    `).get()).toEqual({ name: "auth_rate_limit_buckets" });
    expect(db.prepare(`
      SELECT MAX(version) AS version FROM schema_migrations
    `).get()).toEqual({ version: 18 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("new student secret policy", () => {
  it("rejects short, common, numeric, repeated, and login-derived secrets", () => {
    expect(MIN_STUDENT_SECRET_LENGTH).toBe(10);
    expect(newStudentSecretIssue("short")).not.toBeNull();
    expect(newStudentSecretIssue("password123")).not.toBeNull();
    expect(newStudentSecretIssue("password123456")).not.toBeNull();
    expect(newStudentSecretIssue("123456789012")).not.toBeNull();
    expect(newStudentSecretIssue("aaaaaaaaaaaa")).not.toBeNull();
    expect(newStudentSecretIssue("  Маша Петрова  ", "маша-петрова"))
      .not.toBeNull();
  });

  it("accepts a human-readable non-common phrase", () => {
    expect(newStudentSecretIssue("Лиловый кит 47", "Мария")).toBeNull();
  });
});
