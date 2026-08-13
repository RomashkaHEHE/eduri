import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createServer } from "./server.js";
import {
  PYTHON_RUNNER_WORKER_URL,
  PYTHON_TERMINAL_WORKER_URL,
  PYTHON_WORKER_CONTENT_SECURITY_POLICY,
} from "../pythonRunnerContract.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("server lifecycle", () => {
  it("enables cross-origin isolation required by interactive Python input", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-isolation-"));
    roots.push(dataDir);
    const server = createServer({
      config: {
        nodeEnv: "test",
        appOrigins: ["http://eduri.test"],
        dataDir,
        databasePath: path.join(dataDir, "test.sqlite"),
        uploadDir: path.join(dataDir, "uploads"),
        authLookupKey: "x".repeat(32),
        adminPassword: "test-admin-password",
      },
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    await request(server)
      .get("/api/health")
      .expect(200)
      .expect("Cross-Origin-Opener-Policy", "same-origin")
      .expect("Cross-Origin-Embedder-Policy", "require-corp");

    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it("attaches a fail-closed CSP to Python worker responses", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-worker-csp-"));
    roots.push(dataDir);
    const server = createServer({
      config: {
        nodeEnv: "test",
        appOrigins: ["http://eduri.test"],
        dataDir,
        databasePath: path.join(dataDir, "test.sqlite"),
        uploadDir: path.join(dataDir, "uploads"),
        authLookupKey: "worker-csp-test-key-at-least-32-bytes",
        adminPassword: "test-admin-password",
      },
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    for (const url of [PYTHON_RUNNER_WORKER_URL, PYTHON_TERMINAL_WORKER_URL]) {
      await request(server)
        .get(url)
        .expect(404)
        .expect("Content-Security-Policy", PYTHON_WORKER_CONTENT_SECURITY_POLICY);
    }
    await request(server)
      .get("/api/health")
      .expect(200)
      .expect((response) => {
        if (response.headers["content-security-policy"] !== undefined) {
          throw new Error("Ordinary response unexpectedly received worker CSP");
        }
      });

    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it("mounts the guest Code sync namespace through the production server wiring", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-code-sync-server-"));
    roots.push(dataDir);
    const server = createServer({
      config: {
        nodeEnv: "test",
        appOrigins: ["http://eduri.test"],
        dataDir,
        databasePath: path.join(dataDir, "test.sqlite"),
        uploadDir: path.join(dataDir, "uploads"),
        authLookupKey: "code-sync-wiring-test-key-at-least-32-bytes",
        adminPassword: "test-admin-password",
      },
    });

    expect(server.eduriCodeSync.name).toBe("/code-sync");
    expect(server.eduriLessonCodeSync.name).toBe("/lesson-code-sync");
    expect(server.eduriContext.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'code_updates'
    `).get()).toEqual({ name: "code_updates" });

    server.eduriBoardV2.close();
    server.eduriIo.close();
    server.eduriContext.stopGuestRoomMaintenance?.();
    server.eduriContext.stopBoardAssetMaintenance?.();
    if (server.eduriContext.db.open) server.eduriContext.db.close();
  });

  it("stops guest-room maintenance before closing its owned database", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-server-"));
    roots.push(dataDir);
    const server = createServer({
      config: {
        nodeEnv: "test",
        appOrigins: ["http://eduri.test"],
        dataDir,
        databasePath: path.join(dataDir, "test.sqlite"),
        uploadDir: path.join(dataDir, "uploads"),
        authLookupKey: "server-lifecycle-test-key-at-least-32-bytes",
        adminPassword: "test-admin-password",
      },
    });
    const originalStop = server.eduriContext.stopGuestRoomMaintenance;
    const stop = vi.fn(() => originalStop?.());
    server.eduriContext.stopGuestRoomMaintenance = stop;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });

    expect(stop).toHaveBeenCalledOnce();
    expect(server.eduriContext.db.open).toBe(false);
  });
});
