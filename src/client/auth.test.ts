// @vitest-environment jsdom

import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "../shared/types";
import { ApiError, api } from "./api";
import { AuthProvider, useAuth } from "./auth";
import {
  clearBoardCatalogForTests,
  clearBoardDataForUser,
  getBoardCatalogEntry,
  putBoardCatalogEntry,
  registerBoardNamespace,
} from "./board/catalog";

const CACHED_USER_KEY = "eduri.last-authenticated-user";
const USER: CurrentUser = {
  id: "user-a",
  displayName: "Offline tutor",
  role: "tutor",
  status: "active",
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let auth: ReturnType<typeof useAuth> | null = null;

function AuthProbe() {
  auth = useAuth();
  return null;
}

async function mountAuthProvider(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(AuthProvider, null, createElement(AuthProbe)));
  });
  await act(async () => {
    await vi.waitFor(() => expect(auth?.loading).toBe(false));
  });
}

function createDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("records");
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error ?? new Error("test database could not be opened"));
  });
}

async function databaseNames(): Promise<string[]> {
  return (await indexedDB.databases())
    .map((database) => database.name)
    .filter((name): name is string => typeof name === "string");
}

beforeEach(() => {
  auth = null;
  localStorage.clear();
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
  await clearBoardDataForUser(USER.id).catch(() => undefined);
  await clearBoardCatalogForTests();
});

describe("offline authentication bootstrap", () => {
  it("uses the last authenticated user when the session check cannot reach the server", async () => {
    localStorage.setItem(CACHED_USER_KEY, JSON.stringify(USER));
    vi.spyOn(api.auth, "me").mockRejectedValue(new TypeError("network unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await mountAuthProvider();

    expect(auth?.user).toEqual(USER);
    expect(localStorage.getItem(CACHED_USER_KEY)).toBe(JSON.stringify(USER));
  });

  it("does not use the cached user after an authoritative 401 response", async () => {
    localStorage.setItem(CACHED_USER_KEY, JSON.stringify(USER));
    vi.spyOn(api.auth, "me").mockRejectedValue(new ApiError("Unauthorized", 401));

    await mountAuthProvider();

    expect(auth?.user).toBeNull();
    expect(localStorage.getItem(CACHED_USER_KEY)).toBeNull();
  });

  it("clears the catalog and registered document/update/asset outboxes on logout", async () => {
    const databaseNamesForUser = [
      "eduri-board-v2:user-a:board-a:1:page:page-a",
      "eduri-board-v2:user-a:board-a:1:page:page-a:outbox",
      "eduri-board-v2-assets:user-a:board-a:1",
    ];
    await putBoardCatalogEntry({
      userId: USER.id,
      lessonId: "lesson-a",
      boardId: "board-a",
      generation: 1,
      schemaVersion: 1,
      capabilities: 19,
      permissions: 3,
      manifestDocumentKey: "manifest",
      pageId: "page-a",
      pageDocumentKey: "page:page-a",
    });
    for (const name of databaseNamesForUser) {
      await createDatabase(name);
      await registerBoardNamespace(
        { userId: USER.id, boardId: "board-a", generation: 1 },
        name,
      );
    }
    vi.spyOn(api.auth, "me").mockResolvedValue(USER);
    vi.spyOn(api.auth, "logout").mockResolvedValue();
    await mountAuthProvider();

    await act(async () => {
      await auth?.logout();
    });

    expect(auth?.user).toBeNull();
    expect(localStorage.getItem(CACHED_USER_KEY)).toBeNull();
    expect(await getBoardCatalogEntry(USER.id, "lesson-a")).toBeNull();
    const remaining = await databaseNames();
    for (const name of databaseNamesForUser) expect(remaining).not.toContain(name);
  });
});
