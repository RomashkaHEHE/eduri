import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp, getAppContext } from "../app.js";
import {
  MalwareScannerError,
  type MalwareScanResult,
  type MalwareScanner,
} from "../code-blobs/malwareScanner.js";
import {
  csrfForSession,
  randomToken,
  sessionCookieName,
  sha256,
} from "../security.js";
import type { AppContext } from "../types.js";
import { MaterialFileService } from "./service.js";

const AUTH_KEY = "material-routes-auth-key-at-least-32-bytes";
const FUTURE = "2036-08-09T08:00:00.000Z";

interface Harness {
  app: ReturnType<typeof createApp>;
  context: AppContext;
  root: string;
  auth: { cookie: string; csrf: string };
}

const harnesses: Harness[] = [];

function scanner(result: MalwareScanResult | Error): MalwareScanner {
  return {
    id: "material-route-scanner-v1",
    scan: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function createHarness(malwareScanner: MalwareScanner): Harness {
  const root = mkdtempSync(path.join(os.tmpdir(), "eduri-material-routes-"));
  const app = createApp({
    config: {
      nodeEnv: "test",
      appOrigins: ["http://eduri.test"],
      dataDir: root,
      databasePath: path.join(root, "materials.sqlite"),
      uploadDir: path.join(root, "private-materials"),
      authLookupKey: AUTH_KEY,
      adminLogin: "material-admin",
      adminPassword: "material-admin-password",
      bcryptRounds: 4,
    },
    codeBlobScanner: malwareScanner,
  });
  const context = getAppContext(app);
  context.stopMaterialFileMaintenance?.();
  context.stopGuestRoomMaintenance?.();
  context.stopBoardAssetMaintenance?.();
  const tutorId = randomToken(16);
  const now = new Date().toISOString();
  context.db.prepare(`
    INSERT INTO users (
      id, role, status, display_name, login_name, login_name_normalized,
      password_hash, created_at, updated_at
    ) VALUES (?, 'tutor', 'active', 'Material tutor', ?, ?,
      'test-password-hash', ?, ?)
  `).run(tutorId, tutorId, tutorId, now, now);
  const token = randomToken();
  context.db.prepare(`
    INSERT INTO sessions (
      session_hash, user_id, expires_at, created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(sha256(token), tutorId, FUTURE, now, now);
  const harness = {
    app,
    context,
    root,
    auth: {
      cookie: `${sessionCookieName(context)}=${token}`,
      csrf: csrfForSession(AUTH_KEY, token),
    },
  };
  harnesses.push(harness);
  return harness;
}

function postMaterial(harness: Harness) {
  return request(harness.app)
    .post("/api/materials")
    .set("Cookie", harness.auth.cookie)
    .set("x-csrf-token", harness.auth.csrf);
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    if (harness.context.db.open) harness.context.db.close();
    rmSync(harness.root, { recursive: true, force: true });
  }
});

describe("material file route security", () => {
  it("publishes and serves only a clean file with a complete scan attestation", async () => {
    const harness = createHarness(scanner({ status: "clean" }));
    const contents = Buffer.from("clean route upload");
    const response = await postMaterial(harness)
      .field("title", "Clean upload")
      .field("kind", "file")
      .attach("file", contents, {
        filename: "clean.bin",
        contentType: "application/octet-stream",
      })
      .expect(201);
    const materialId = response.body.material.id as string;
    const stored = harness.context.db.prepare(`
      SELECT storage_key, file_size, file_sha256, scan_provider, scanned_at
      FROM materials WHERE id = ?
    `).get(materialId) as {
      storage_key: string;
      file_size: number;
      file_sha256: string;
      scan_provider: string;
      scanned_at: string;
    };
    expect(stored).toMatchObject({
      file_size: contents.byteLength,
      file_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      scan_provider: "material-route-scanner-v1",
      scanned_at: expect.any(String),
    });
    expect(existsSync(path.join(harness.context.materialFiles.storageRoot, stored.storage_key)))
      .toBe(true);
    expect(readdirSync(harness.context.materialFiles.quarantineRoot)).toEqual([]);

    const downloaded = await request(harness.app)
      .get(`/api/materials/${materialId}/file`)
      .set("Cookie", harness.auth.cookie)
      .expect(200)
      .expect("Cache-Control", "private, no-store")
      .expect("X-Content-Type-Options", "nosniff");
    expect(Buffer.from(downloaded.body)).toEqual(contents);
  });

  it.each([
    {
      label: "infected",
      scanner: scanner({ status: "infected", signature: "route-malware" }),
      status: 422,
    },
    {
      label: "unavailable",
      scanner: scanner(new MalwareScannerError("UNAVAILABLE", "scanner offline")),
      status: 503,
    },
  ])("does not publish a file when scanning is $label", async (fixture) => {
    const harness = createHarness(fixture.scanner);
    await postMaterial(harness)
      .field("title", "Rejected upload")
      .field("kind", "file")
      .attach("file", Buffer.from("reject me"), {
        filename: "rejected.bin",
        contentType: "application/octet-stream",
      })
      .expect(fixture.status);

    expect(harness.context.db.prepare("SELECT COUNT(*) AS count FROM materials").get())
      .toEqual({ count: 0 });
    expect(harness.context.db.prepare(`
      SELECT COUNT(*) AS count FROM material_upload_reservations
    `).get()).toEqual({ count: 0 });
    expect(harness.context.db.prepare(`
      SELECT COUNT(*) AS count FROM material_file_gc_queue
    `).get()).toEqual({ count: 0 });
    expect(readdirSync(harness.context.materialFiles.quarantineRoot)).toEqual([]);
    expect(readdirSync(harness.context.materialFiles.filesRoot)).toEqual([]);
  });

  it("returns explicit limits before fileless material spam is inserted", async () => {
    const clean = scanner({ status: "clean" });
    const quota = createHarness(clean);
    quota.context.materialFiles = new MaterialFileService({
      db: quota.context.db,
      scanner: clean,
      storageRoot: quota.context.config.uploadDir,
      limits: {
        tutorMaterialRows: 1,
        globalMaterialRows: 10,
        minFreeDiskBytes: 1,
      },
      diskFreeBytes: async () => 1_000_000,
    });
    await postMaterial(quota)
      .field("title", "First note")
      .field("kind", "note")
      .field("body", "Allowed")
      .expect(201);
    await postMaterial(quota)
      .field("title", "Second note")
      .field("kind", "note")
      .field("body", "Blocked")
      .expect(413);
    expect(quota.context.db.prepare("SELECT COUNT(*) AS count FROM materials").get())
      .toEqual({ count: 1 });

    const rate = createHarness(clean);
    rate.context.materialFiles = new MaterialFileService({
      db: rate.context.db,
      scanner: clean,
      storageRoot: rate.context.config.uploadDir,
      limits: {
        tutorMaterialWritesPerWindow: 1,
        globalMaterialWritesPerWindow: 10,
        minFreeDiskBytes: 1,
      },
      diskFreeBytes: async () => 1_000_000,
    });
    await postMaterial(rate)
      .field("title", "First rate note")
      .field("kind", "note")
      .field("body", "Allowed")
      .expect(201);
    await postMaterial(rate)
      .field("title", "Second rate note")
      .field("kind", "note")
      .field("body", "Blocked")
      .expect(429);
    expect(rate.context.db.prepare("SELECT COUNT(*) AS count FROM materials").get())
      .toEqual({ count: 1 });
  });
});
