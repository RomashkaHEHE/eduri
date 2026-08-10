import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  codeWorkspaceMeta,
  codeWorkspaceText,
  validateCodeWorkspaceDocument,
} from "../../code/core/index.js";
import { migrate } from "../db.js";
import {
  GUEST_ROOM_IDLE_TTL_MS,
  GuestRoomService,
} from "../guestRooms.js";
import { CodeSyncRepository } from "./repository.js";
import { installCodeSyncSchema } from "./schema.js";
import {
  CodeSyncService,
  CodeSyncServiceError,
  type AuthenticatedCodeSync,
} from "./service.js";

function applyInitialSync(
  service: CodeSyncService,
  session: AuthenticatedCodeSync,
): Y.Doc {
  const document = new Y.Doc();
  const state = service.syncStep1(session, Y.encodeStateVector(document));
  for (const update of state.updates) Y.applyUpdate(document, update);
  validateCodeWorkspaceDocument(document);
  return document;
}

function incrementalUpdate(document: Y.Doc, before: Uint8Array): Uint8Array {
  return Y.encodeStateAsUpdate(document, before);
}

describe("CodeSyncService", () => {
  let db: Database.Database;
  let now: number;
  let guestRooms: GuestRoomService;
  let repository: CodeSyncRepository;
  let service: CodeSyncService;
  let shareId: string;
  let leftSession: AuthenticatedCodeSync;
  let rightSession: AuthenticatedCodeSync;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    installCodeSyncSchema(db);
    now = Date.parse("2026-08-09T08:00:00.000Z");
    guestRooms = new GuestRoomService(db, () => now);
    repository = new CodeSyncRepository(db, () => now);
    service = new CodeSyncService(repository, guestRooms);
    shareId = guestRooms.create("code").shareKey;
    leftSession = service.authenticate({ shareId, deviceId: "left-device" });
    rightSession = service.authenticate({ shareId, deviceId: "right-device" });
  });

  afterEach(() => db.close());

  it("converges independent edits through state-vector reconnect", () => {
    const left = applyInitialSync(service, leftSession);
    const right = applyInitialSync(service, rightSession);
    try {
      const leftBefore = Y.encodeStateVector(left);
      const rightBefore = Y.encodeStateVector(right);
      codeWorkspaceText(left, "main-py")?.insert(0, "# left\n");
      codeWorkspaceText(right, "main-py")?.insert(
        codeWorkspaceText(right, "main-py")?.length ?? 0,
        "# right\n",
      );
      expect(service.appendUpdate(
        leftSession,
        "left-update",
        incrementalUpdate(left, leftBefore),
      ).status).toBe("committed");
      expect(service.appendUpdate(
        rightSession,
        "right-update",
        incrementalUpdate(right, rightBefore),
      ).status).toBe("committed");

      for (const update of service.syncStep1(
        leftSession,
        Y.encodeStateVector(left),
      ).updates) Y.applyUpdate(left, update);
      for (const update of service.syncStep1(
        rightSession,
        Y.encodeStateVector(right),
      ).updates) Y.applyUpdate(right, update);
      expect(Y.encodeStateVector(left)).toEqual(Y.encodeStateVector(right));
      expect(codeWorkspaceText(left, "main-py")?.toString())
        .toBe(codeWorkspaceText(right, "main-py")?.toString());
      expect(codeWorkspaceText(left, "main-py")?.toString())
        .toContain("# left");
      expect(codeWorkspaceText(left, "main-py")?.toString())
        .toContain("# right");
    } finally {
      left.destroy();
      right.destroy();
    }
  });

  it("converges three replicas after concurrent and delayed updates", () => {
    const left = applyInitialSync(service, leftSession);
    const right = applyInitialSync(service, rightSession);
    const thirdSession = service.authenticate({
      shareId,
      deviceId: "third-device",
    });
    const third = applyInitialSync(service, thirdSession);
    try {
      const leftBefore = Y.encodeStateVector(left);
      const rightBefore = Y.encodeStateVector(right);
      codeWorkspaceText(left, "main-py")?.insert(0, "left\n");
      codeWorkspaceText(right, "main-py")?.insert(0, "right\n");
      const leftUpdate = incrementalUpdate(left, leftBefore);
      const rightUpdate = incrementalUpdate(right, rightBefore);
      expect(service.appendUpdate(rightSession, "three-right", rightUpdate).status)
        .toBe("committed");
      expect(service.appendUpdate(leftSession, "three-left", leftUpdate).status)
        .toBe("committed");

      for (const [document, session] of [
        [left, leftSession],
        [right, rightSession],
        [third, thirdSession],
      ] as const) {
        const missing = service.syncStep1(
          session,
          Y.encodeStateVector(document),
        );
        for (const update of missing.updates) Y.applyUpdate(document, update);
      }

      const vectors = [left, right, third].map((document) => (
        Y.encodeStateVector(document)
      ));
      expect(vectors[1]).toEqual(vectors[0]);
      expect(vectors[2]).toEqual(vectors[0]);
      for (const document of [left, right, third]) {
        expect(codeWorkspaceText(document, "main-py")?.toString())
          .toContain("left");
        expect(codeWorkspaceText(document, "main-py")?.toString())
          .toContain("right");
      }
    } finally {
      left.destroy();
      right.destroy();
      third.destroy();
    }
  });

  it("persists dependent updates received in reverse order", () => {
    const client = applyInitialSync(service, leftSession);
    try {
      const initialVector = Y.encodeStateVector(client);
      codeWorkspaceText(client, "main-py")?.insert(0, "A");
      const first = incrementalUpdate(client, initialVector);
      const afterFirst = Y.encodeStateVector(client);
      codeWorkspaceText(client, "main-py")?.insert(1, "B");
      const second = incrementalUpdate(client, afterFirst);

      expect(service.appendUpdate(leftSession, "second", second))
        .toMatchObject({ status: "committed" });
      expect(service.appendUpdate(leftSession, "first", first))
        .toMatchObject({ status: "committed" });

      const reloaded = applyInitialSync(service, rightSession);
      try {
        expect(codeWorkspaceText(reloaded, "main-py")?.toString())
          .toMatch(/^AB/u);
      } finally {
        reloaded.destroy();
      }
    } finally {
      client.destroy();
    }
  });

  it("keeps receipts idempotent across restart without extending activity", () => {
    const recordActivity = vi.spyOn(guestRooms, "recordResourceMutation");
    const client = applyInitialSync(service, leftSession);
    try {
      const before = Y.encodeStateVector(client);
      codeWorkspaceText(client, "main-py")?.insert(0, "# durable\n");
      const update = incrementalUpdate(client, before);
      now += 1_000;
      const committed = service.appendUpdate(leftSession, "durable-1", update);
      expect(committed.status).toBe("committed");
      expect(recordActivity).toHaveBeenCalledTimes(1);
      const activityAfterCommit = guestRooms.lookup(shareId);
      expect(activityAfterCommit.status).toBe("active");
      if (activityAfterCommit.status !== "active") return;

      now += 5_000;
      repository = new CodeSyncRepository(db, () => now);
      service = new CodeSyncService(repository, guestRooms);
      const restartedSession = service.authenticate({
        shareId,
        deviceId: "left-device",
      });
      recordActivity.mockClear();
      expect(service.appendUpdate(restartedSession, "durable-1", update))
        .toEqual({ status: "duplicate", sequence: committed.sequence });
      expect(service.appendUpdate(restartedSession, "durable-replay", update))
        .toEqual({ status: "duplicate", sequence: committed.sequence });
      expect(recordActivity).not.toHaveBeenCalled();
      const activityAfterReplay = guestRooms.lookup(shareId);
      expect(activityAfterReplay.status).toBe("active");
      if (activityAfterReplay.status !== "active") return;
      expect(activityAfterReplay.room.lastActivityAt)
        .toBe(activityAfterCommit.room.lastActivityAt);

      const reloaded = applyInitialSync(service, restartedSession);
      try {
        expect(codeWorkspaceText(reloaded, "main-py")?.toString())
          .toContain("# durable");
      } finally {
        reloaded.destroy();
      }
    } finally {
      client.destroy();
    }
  });

  it("rolls an update back when the room expires inside its commit", () => {
    const client = applyInitialSync(service, leftSession);
    try {
      const workspaceUsageBefore = db.prepare(`
        SELECT * FROM code_storage_usage WHERE workspace_id = ?
      `).get(leftSession.workspaceId);
      const aggregateUsageBefore = db.prepare(`
        SELECT * FROM code_guest_storage_usage WHERE singleton = 1
      `).get();
      const before = Y.encodeStateVector(client);
      codeWorkspaceText(client, "main-py")?.insert(0, "# too late\n");
      const update = incrementalUpdate(client, before);
      const recordActivity = guestRooms.recordResourceMutation.bind(guestRooms);
      const activitySpy = vi.spyOn(guestRooms, "recordResourceMutation")
        .mockImplementationOnce((roomId, resourceId) => {
          now += GUEST_ROOM_IDLE_TTL_MS;
          return recordActivity(roomId, resourceId);
        });

      expect(() => service.appendUpdate(leftSession, "expired-race", update))
        .toThrowError(expect.objectContaining({ code: "EXPIRED" }));
      expect(activitySpy).toHaveBeenCalledTimes(1);
      expect(db.prepare("SELECT count(*) AS count FROM code_updates").get())
        .toEqual({ count: 0 });
      expect(db.prepare("SELECT count(*) AS count FROM code_update_receipts").get())
        .toEqual({ count: 0 });
      expect(db.prepare(`
        SELECT last_sequence, update_log_count, receipt_count
        FROM code_documents WHERE workspace_id = ?
      `).get(leftSession.workspaceId)).toEqual({
        last_sequence: 0,
        update_log_count: 0,
        receipt_count: 0,
      });
      expect(db.prepare(`
        SELECT * FROM code_storage_usage WHERE workspace_id = ?
      `).get(leftSession.workspaceId)).toEqual(workspaceUsageBefore);
      expect(db.prepare(`
        SELECT * FROM code_guest_storage_usage WHERE singleton = 1
      `).get()).toEqual(aggregateUsageBefore);
    } finally {
      client.destroy();
    }
  });

  it("rejects an idempotency key reused for different bytes", () => {
    const client = applyInitialSync(service, leftSession);
    try {
      const before = Y.encodeStateVector(client);
      codeWorkspaceText(client, "main-py")?.insert(0, "A");
      const first = incrementalUpdate(client, before);
      expect(service.appendUpdate(leftSession, "same-id", first).status)
        .toBe("committed");

      const nextBefore = Y.encodeStateVector(client);
      codeWorkspaceText(client, "main-py")?.insert(1, "B");
      const second = incrementalUpdate(client, nextBefore);
      expect(() => service.appendUpdate(leftSession, "same-id", second))
        .toThrowError(expect.objectContaining({ code: "INVALID_UPDATE" }));
    } finally {
      client.destroy();
    }
  });

  it("rejects remote updates that break workspace structure", () => {
    const client = applyInitialSync(service, leftSession);
    try {
      const before = Y.encodeStateVector(client);
      codeWorkspaceMeta(client).set("schemaVersion", 99);
      const update = incrementalUpdate(client, before);
      expect(() => service.appendUpdate(leftSession, "invalid-structure", update))
        .toThrowError(expect.objectContaining({ code: "INVALID_UPDATE" }));
      expect(db.prepare("SELECT count(*) AS count FROM code_updates").get())
        .toEqual({ count: 0 });
      expect(db.prepare("SELECT count(*) AS count FROM code_update_receipts").get())
        .toEqual({ count: 0 });
    } finally {
      client.destroy();
    }
  });

  it("reauthorizes every operation after the guest room expires", () => {
    const client = applyInitialSync(service, leftSession);
    const before = Y.encodeStateVector(client);
    codeWorkspaceText(client, "main-py")?.insert(0, "late");
    const lateUpdate = incrementalUpdate(client, before);
    client.destroy();
    now += GUEST_ROOM_IDLE_TTL_MS;
    expect(() => service.syncStep1(leftSession, Uint8Array.of(0)))
      .toThrowError(expect.objectContaining({ code: "EXPIRED" }));
    expect(() => service.appendUpdate(leftSession, "late-update", lateUpdate))
      .toThrowError(expect.objectContaining({ code: "EXPIRED" }));
    expect(() => service.authorizeAwareness(leftSession))
      .toThrowError(expect.objectContaining({ code: "EXPIRED" }));
    expect(db.prepare("SELECT count(*) AS count FROM code_workspaces").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM code_updates").get())
      .toEqual({ count: 0 });
  });

  it("stores remote source text without executing it", () => {
    const executionProbe = globalThis as typeof globalThis & {
      __eduriRemoteCodeExecuted?: boolean;
    };
    delete executionProbe.__eduriRemoteCodeExecuted;
    const client = applyInitialSync(service, leftSession);
    try {
      const before = Y.encodeStateVector(client);
      const source = "globalThis.__eduriRemoteCodeExecuted = true\n";
      const text = codeWorkspaceText(client, "main-py");
      text?.delete(0, text.length);
      text?.insert(0, source);
      expect(service.appendUpdate(
        leftSession,
        "source-only",
        incrementalUpdate(client, before),
      ).status).toBe("committed");

      const remote = applyInitialSync(service, rightSession);
      try {
        expect(codeWorkspaceText(remote, "main-py")?.toString()).toBe(source);
        expect(executionProbe.__eduriRemoteCodeExecuted).toBeUndefined();
      } finally {
        remote.destroy();
      }
    } finally {
      client.destroy();
      delete executionProbe.__eduriRemoteCodeExecuted;
    }
  });

  it("rejects non-canonical state vectors", () => {
    expect(() => service.syncStep1(leftSession, Uint8Array.of(0, 0)))
      .toThrowError(CodeSyncServiceError);
  });
});

describe("CodeSyncService restart durability", () => {
  it("reconstructs committed updates after closing and reopening SQLite", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-code-restart-"));
    const databasePath = path.join(tempRoot, "code.sqlite");
    let first: Database.Database | undefined;
    let reopened: Database.Database | undefined;
    try {
      first = new Database(databasePath);
      first.pragma("foreign_keys = ON");
      migrate(first);
      installCodeSyncSchema(first);
      const firstRooms = new GuestRoomService(first);
      const restartShareId = firstRooms.create("code").shareKey;
      const firstService = new CodeSyncService(
        new CodeSyncRepository(first),
        firstRooms,
      );
      const firstSession = firstService.authenticate({
        shareId: restartShareId,
        deviceId: "restart-writer",
      });
      const document = applyInitialSync(firstService, firstSession);
      const before = Y.encodeStateVector(document);
      codeWorkspaceText(document, "main-py")?.insert(0, "# survives reopen\n");
      expect(firstService.appendUpdate(
        firstSession,
        "restart-update",
        incrementalUpdate(document, before),
      ).status).toBe("committed");
      document.destroy();
      first.close();
      first = undefined;

      reopened = new Database(databasePath);
      reopened.pragma("foreign_keys = ON");
      migrate(reopened);
      const reopenedRooms = new GuestRoomService(reopened);
      const reopenedService = new CodeSyncService(
        new CodeSyncRepository(reopened),
        reopenedRooms,
      );
      const reopenedSession = reopenedService.authenticate({
        shareId: restartShareId,
        deviceId: "restart-reader",
      });
      const restored = applyInitialSync(reopenedService, reopenedSession);
      try {
        expect(codeWorkspaceText(restored, "main-py")?.toString())
          .toContain("# survives reopen");
      } finally {
        restored.destroy();
      }
    } finally {
      if (first?.open) first.close();
      if (reopened?.open) reopened.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
