// @vitest-environment node

import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  codeWorkspaceText,
  initializeCodeWorkspace,
  validateCodeWorkspaceDocument,
} from "../../code/core/index.js";
import {
  CODE_SYNC_REMOTE_ORIGIN,
  CodeSyncIndexedDbStore,
} from "./codeSyncStore.js";

const stores: CodeSyncIndexedDbStore[] = [];

function createStore(name: string, document = new Y.Doc()): CodeSyncIndexedDbStore {
  const store = new CodeSyncIndexedDbStore(name, document);
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map((store) => store.clearData()));
});
describe("CodeSyncIndexedDbStore", () => {
  it("hydrates local updates and preserves the ACK-backed outbox across reload", async () => {
    const name = `code-sync-store-${crypto.randomUUID()}`;
    const firstDocument = new Y.Doc();
    const first = createStore(name, firstDocument);
    await first.whenReady;

    initializeCodeWorkspace(firstDocument, "local");
    codeWorkspaceText(firstDocument, "main-py")?.insert(0, "# offline\n");
    await first.flush();
    const pending = await first.listPendingUpdates();
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.map((update) => update.queueOrder)).toEqual(
      pending.map((_update, index) => index + 1),
    );
    await first.close();

    const reloadedDocument = new Y.Doc();
    const reloaded = createStore(name, reloadedDocument);
    await reloaded.whenReady;
    expect(() => validateCodeWorkspaceDocument(reloadedDocument)).not.toThrow();
    expect(codeWorkspaceText(reloadedDocument, "main-py")?.toString())
      .toContain("# offline");
    expect((await reloaded.listPendingUpdates()).map((update) => update.updateId))
      .toEqual(pending.map((update) => update.updateId));

    for (const update of pending) await reloaded.acknowledge(update.updateId);
    expect(await reloaded.listPendingUpdates()).toEqual([]);
  });

  it("persists reordered and duplicate remote updates without adding outbox rows", async () => {
    const source = new Y.Doc();
    initializeCodeWorkspace(source, "seed");
    const seed = Y.encodeStateAsUpdate(source);
    const seedVector = Y.encodeStateVector(source);
    codeWorkspaceText(source, "main-py")?.insert(0, "A");
    const firstUpdate = Y.encodeStateAsUpdate(source, seedVector);
    const firstVector = Y.encodeStateVector(source);
    codeWorkspaceText(source, "main-py")?.insert(1, "B");
    const secondUpdate = Y.encodeStateAsUpdate(source, firstVector);

    const name = `code-sync-remote-${crypto.randomUUID()}`;
    const document = new Y.Doc();
    const store = createStore(name, document);
    await store.whenReady;
    Y.applyUpdate(document, seed, CODE_SYNC_REMOTE_ORIGIN);
    Y.applyUpdate(document, secondUpdate, CODE_SYNC_REMOTE_ORIGIN);
    Y.applyUpdate(document, firstUpdate, CODE_SYNC_REMOTE_ORIGIN);
    Y.applyUpdate(document, firstUpdate, CODE_SYNC_REMOTE_ORIGIN);
    await store.flush();

    expect(codeWorkspaceText(document, "main-py")?.toString().startsWith("AB"))
      .toBe(true);
    expect(await store.listPendingUpdates()).toEqual([]);
    await store.close();

    const reloaded = new Y.Doc();
    const reloadedStore = createStore(name, reloaded);
    await reloadedStore.whenReady;
    expect(codeWorkspaceText(reloaded, "main-py")?.toString())
      .toBe(codeWorkspaceText(source, "main-py")?.toString());
  });
});
