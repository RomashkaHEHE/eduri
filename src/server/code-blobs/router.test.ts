import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp, getAppContext } from "../app.js";
import { MalwareScannerError } from "./malwareScanner.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("guest Code blob HTTP capability", () => {
  it("requires an allowed Origin and never accepts a client resource identity", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-code-blob-router-"));
    roots.push(dataDir);
    const app = createApp({
      config: {
        nodeEnv: "test",
        appOrigins: ["http://eduri.test"],
        dataDir,
        databasePath: path.join(dataDir, "test.sqlite"),
        uploadDir: path.join(dataDir, "uploads"),
        boardAssetMinFreeDiskBytes: 1,
        authLookupKey: "code-blob-router-test-key-at-least-32-bytes",
        adminPassword: "test-admin-password",
      },
    });
    const context = getAppContext(app);
    const room = context.guestRooms.create("code");
    const body = {
      sha256: "a".repeat(64),
      byteSize: 3,
      mimeType: "application/octet-stream",
    };

    await request(app)
      .post(`/api/guest/rooms/${room.shareKey}/code-blobs/begin`)
      .send(body)
      .expect(403);
    const response = await request(app)
      .post(`/api/guest/rooms/${room.shareKey}/code-blobs/begin`)
      .set("Origin", "http://eduri.test")
      .send({ ...body, roomResourceId: crypto.randomUUID() })
      .expect(400);
    expect(response.body.error).toBeTruthy();

    context.stopGuestRoomMaintenance?.();
    context.stopBoardAssetMaintenance?.();
    context.db.close();
  });

  it("serves published status and content without Origin while mutations stay protected", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-code-blob-read-router-"));
    roots.push(dataDir);
    const app = createApp({
      config: {
        nodeEnv: "test",
        appOrigins: ["http://eduri.test"],
        dataDir,
        databasePath: path.join(dataDir, "test.sqlite"),
        uploadDir: path.join(dataDir, "uploads"),
        boardAssetMinFreeDiskBytes: 1,
        authLookupKey: "code-blob-read-router-test-key-at-least-32-bytes",
        adminPassword: "test-admin-password",
      },
      codeBlobScanner: {
        id: "router-test-clean-scanner-v1",
        scan: async () => ({ status: "clean" }),
      },
    });
    const context = getAppContext(app);
    const room = context.guestRooms.create("code");
    const bytes = Buffer.from("published-code-blob");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const begun = await context.codeBlobs!.beginUpload(room.shareKey, {
      sha256,
      byteSize: bytes.byteLength,
      mimeType: "application/octet-stream",
    });
    if (begun.status !== "upload") throw new Error("test upload was unexpectedly ready");
    await context.codeBlobs!.writeChunk(room.shareKey, {
      uploadId: begun.uploadId,
      offset: 0,
      chunk: bytes,
      chunkSha256: sha256,
    });
    await context.codeBlobs!.finalizeUpload(room.shareKey, begun.uploadId);

    await request(app)
      .get(`/api/guest/rooms/${room.shareKey}/code-blobs/${sha256}/status`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          status: "ready",
          blob: { sha256, byteSize: bytes.byteLength },
        });
      });
    const downloaded = await request(app)
      .get(`/api/guest/rooms/${room.shareKey}/code-blobs/${sha256}/content`)
      .expect(200)
      .expect("Content-Type", "application/octet-stream");
    expect(Buffer.from(downloaded.body)).toEqual(bytes);

    await request(app)
      .post(`/api/guest/rooms/${room.shareKey}/code-blobs/begin`)
      .send({ sha256, byteSize: bytes.byteLength, mimeType: "application/octet-stream" })
      .expect(403);
    await request(app)
      .put(`/api/guest/rooms/${room.shareKey}/code-blobs/uploads/${begun.uploadId}/chunks`)
      .set("content-type", "application/octet-stream")
      .set("x-upload-offset", "0")
      .set("x-chunk-sha256", sha256)
      .send(bytes)
      .expect(403);
    await request(app)
      .post(`/api/guest/rooms/${room.shareKey}/code-blobs/uploads/${begun.uploadId}/finalize`)
      .expect(403);

    context.stopGuestRoomMaintenance?.();
    context.stopBoardAssetMaintenance?.();
    context.db.close();
  });

  it("advertises the Code chunk checksum header in CORS preflights", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-code-blob-cors-router-"));
    roots.push(dataDir);
    const app = createApp({
      config: {
        nodeEnv: "test",
        appOrigins: ["http://eduri.test"],
        dataDir,
        databasePath: path.join(dataDir, "test.sqlite"),
        uploadDir: path.join(dataDir, "uploads"),
        boardAssetMinFreeDiskBytes: 1,
        authLookupKey: "code-blob-cors-router-test-key-at-least-32-bytes",
        adminPassword: "test-admin-password",
      },
    });
    const context = getAppContext(app);
    const room = context.guestRooms.create("code");

    await request(app)
      .options(`/api/guest/rooms/${room.shareKey}/code-blobs/begin`)
      .set("Origin", "http://eduri.test")
      .set("Access-Control-Request-Method", "PUT")
      .set("Access-Control-Request-Headers", "x-chunk-sha256")
      .expect(204)
      .expect((response) => {
        expect(response.headers["access-control-allow-headers"])
          .toMatch(/(?:^|,\s*)X-Chunk-Sha256(?:,|$)/u);
      });

    context.stopGuestRoomMaintenance?.();
    context.stopBoardAssetMaintenance?.();
    context.db.close();
  });

  it("maps scanner outage and detection without ever exposing ready metadata", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-code-blob-scan-router-"));
    roots.push(dataDir);
    let scanState: "unavailable" | "infected" = "unavailable";
    const app = createApp({
      config: {
        nodeEnv: "test",
        appOrigins: ["http://eduri.test"],
        dataDir,
        databasePath: path.join(dataDir, "test.sqlite"),
        uploadDir: path.join(dataDir, "uploads"),
        boardAssetMinFreeDiskBytes: 1,
        authLookupKey: "code-blob-scan-router-test-key-at-least-32-bytes",
        adminPassword: "test-admin-password",
      },
      codeBlobScanner: {
        id: "router-test-scanner-v1",
        scan: async () => {
          if (scanState === "unavailable") {
            throw new MalwareScannerError("UNAVAILABLE", "test outage");
          }
          return { status: "infected", signature: "Unit.Test.Signature" };
        },
      },
    });
    const context = getAppContext(app);
    const room = context.guestRooms.create("code");
    const bytes = Buffer.from("http-malware-fixture");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const begun = await context.codeBlobs!.beginUpload(room.shareKey, {
      sha256,
      byteSize: bytes.byteLength,
      mimeType: "application/octet-stream",
    });
    if (begun.status !== "upload") throw new Error("test upload was unexpectedly ready");
    await context.codeBlobs!.writeChunk(room.shareKey, {
      uploadId: begun.uploadId,
      offset: 0,
      chunk: bytes,
      chunkSha256: sha256,
    });
    const endpoint = `/api/guest/rooms/${room.shareKey}/code-blobs/uploads/${begun.uploadId}/finalize`;

    const unavailable = await request(app)
      .post(endpoint)
      .set("Origin", "http://eduri.test")
      .expect(503);
    expect(unavailable.body).toMatchObject({
      code: "MALWARE_SCAN_UNAVAILABLE",
      retryable: true,
    });
    expect(context.db.prepare("SELECT * FROM code_blobs").all()).toEqual([]);

    scanState = "infected";
    const infected = await request(app)
      .post(endpoint)
      .set("Origin", "http://eduri.test")
      .expect(422);
    expect(infected.body).toMatchObject({
      code: "MALWARE_DETECTED",
      retryable: false,
    });
    expect(context.db.prepare("SELECT * FROM code_blobs").all()).toEqual([]);
    expect(context.db.prepare("SELECT * FROM code_blob_uploads").all()).toEqual([]);

    context.stopGuestRoomMaintenance?.();
    context.stopBoardAssetMaintenance?.();
    context.db.close();
  });
});
