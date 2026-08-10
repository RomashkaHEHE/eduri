import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearBoardCatalogForTests,
  clearBoardDataForUser,
  getBoardCatalogEntry,
  putBoardCatalogEntry,
  registerBoardNamespace,
} from "./catalog";

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("records");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("test database could not be opened"));
  });
}

async function databaseNames(): Promise<string[]> {
  return (await indexedDB.databases())
    .map((database) => database.name)
    .filter((name): name is string => typeof name === "string");
}

afterEach(async () => {
  await clearBoardCatalogForTests();
});

describe("Board v2 local catalog", () => {
  it("keeps lesson bootstrap data scoped to the authenticated user", async () => {
    await putBoardCatalogEntry({
      userId: "user-a",
      lessonId: "lesson-a",
      boardId: "board-a",
      generation: 2,
      schemaVersion: 1,
      capabilities: 19,
      permissions: 3,
      manifestDocumentKey: "manifest",
      pageId: "10000000-0000-4000-8000-000000000001",
      pageDocumentKey: "page:10000000-0000-4000-8000-000000000001",
    });

    expect((await getBoardCatalogEntry("user-a", "lesson-a"))?.generation).toBe(2);
    expect(await getBoardCatalogEntry("user-b", "lesson-a")).toBeNull();
  });

  it("removes only one user's catalog and registered document databases", async () => {
    for (const userId of ["user-a", "user-b"]) {
      await putBoardCatalogEntry({
        userId,
        lessonId: "lesson-a",
        boardId: `board-${userId}`,
        generation: 1,
        schemaVersion: 1,
        capabilities: 19,
        permissions: 3,
        manifestDocumentKey: "manifest",
        pageId: "10000000-0000-4000-8000-000000000001",
        pageDocumentKey: "page:10000000-0000-4000-8000-000000000001",
      });
      await registerBoardNamespace(
        { userId, boardId: `board-${userId}`, generation: 1 },
        `namespace-${userId}`,
      );
    }

    await clearBoardDataForUser("user-a");
    expect(await getBoardCatalogEntry("user-a", "lesson-a")).toBeNull();
    expect(await getBoardCatalogEntry("user-b", "lesson-a")).not.toBeNull();
  });

  it("deletes every registered document and outbox database only for the logged-out user", async () => {
    const userADatabases = [
      "eduri-board-v2:user-a:board-a:1:manifest",
      "eduri-board-v2:user-a:board-a:1:page:page-a",
      "eduri-board-v2:user-a:board-a:1:page:page-a:outbox",
      "eduri-board-v2-assets:user-a:board-a:1",
    ];
    const userBDatabase = "eduri-board-v2-assets:user-b:board-b:1";

    for (const name of [...userADatabases, userBDatabase]) {
      const database = await openDatabase(name);
      database.close();
      await registerBoardNamespace(
        {
          userId: name.includes("user-a") ? "user-a" : "user-b",
          boardId: name.includes("user-a") ? "board-a" : "board-b",
          generation: 1,
        },
        name,
      );
    }

    await clearBoardDataForUser("user-a");

    const remaining = await databaseNames();
    for (const name of userADatabases) expect(remaining).not.toContain(name);
    expect(remaining).toContain(userBDatabase);

    await clearBoardDataForUser("user-b");
  });

  it("waits for a blocked deletion and forgets the namespace after success", async () => {
    const name = "eduri-board-v2-assets:user-a:board-a:1";
    const database = await openDatabase(name);
    await registerBoardNamespace(
      { userId: "user-a", boardId: "board-a", generation: 1 },
      name,
    );

    const clearing = clearBoardDataForUser("user-a");
    let settled = false;
    void clearing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(await databaseNames()).toContain(name);

    database.close();
    await expect(clearing).resolves.toBeUndefined();
    expect(await databaseNames()).not.toContain(name);
  });
});
