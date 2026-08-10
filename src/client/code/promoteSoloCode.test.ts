import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  addCodeTestCase,
  addCodeWorkspaceEntry,
  codeWorkspaceText,
  initializeCodeWorkspace,
  listCodeTestCases,
  listCodeWorkspaceEntries,
  replaceCodeWorkspaceText,
  type CodeWorkspaceBlobIdentity,
} from "../../code/core";
import { ApiError, type GuestRoom } from "../api";
import { codeBlobIdentity } from "./codeBlobStore";
import {
  promoteSoloCodeToGuestRoom,
  type SoloCodePromotionDependencies,
  type SoloCodePromotionSession,
} from "./promoteSoloCode";

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function room(shareId = "guest-code-share"): GuestRoom {
  return {
    shareId,
    createdAt: "2026-08-09T08:00:00.000Z",
    lastActivityAt: "2026-08-09T08:00:00.000Z",
    expiresAt: "2026-08-11T08:00:00.000Z",
    roomUrl: `/room/${shareId}`,
    resources: [{
      id: "code-resource",
      kind: "code",
      ordinal: 0,
      url: `/room/${shareId}/code`,
      createdAt: "2026-08-09T08:00:00.000Z",
      lastActivityAt: "2026-08-09T08:00:00.000Z",
    }],
  };
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

class MemoryPromotionBlobStore {
  readonly whenReady = Promise.resolve(true);
  readonly blobs = new Map<string, Blob>();
  closed = false;
  cleared = false;

  async put(blob: Blob): Promise<CodeWorkspaceBlobIdentity> {
    const identity = await codeBlobIdentity(blob);
    this.blobs.set(identity.sha256, blob);
    return identity;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async clearData(): Promise<void> {
    this.cleared = true;
    this.blobs.clear();
  }
}

class ControlledPromotionProvider {
  readonly document = new Y.Doc();
  readonly origin = Object.freeze({ type: "test-code-promotion" });
  readonly start = vi.fn(async () => undefined);
  readonly flush = vi.fn(async () => undefined);
  readonly stop = vi.fn(async () => undefined);
  readonly clearLocalData = vi.fn(async () => undefined);
  syncCalls = 0;
  private readonly finalAck: Promise<void>;

  constructor(finalAck: Promise<void> = Promise.resolve()) {
    this.finalAck = finalAck;
    initializeCodeWorkspace(this.document, "server-seed");
    replaceCodeWorkspaceText(
      this.document,
      "main-py",
      "print(\"server default\")\n",
      "server-seed",
    );
  }

  async waitUntilSynchronized(_timeoutMs?: number): Promise<void> {
    this.syncCalls += 1;
    if (this.syncCalls === 2) await this.finalAck;
  }
}

function sourceWorkspace(bytes: Uint8Array): {
  readonly session: SoloCodePromotionSession;
  readonly identity: CodeWorkspaceBlobIdentity;
  readonly blob: Blob;
  readonly flush: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
} {
  const document = new Y.Doc();
  initializeCodeWorkspace(document, "solo-seed");
  replaceCodeWorkspaceText(
    document,
    "main-py",
    "print(\"solo answer\")\n",
    "solo",
  );
  const folderId = addCodeWorkspaceEntry(document, {
    id: "solutions",
    kind: "folder",
    name: "solutions",
    rank: "b0",
  }, "solo");
  addCodeWorkspaceEntry(document, {
    id: "solver-py",
    kind: "file",
    parentId: folderId,
    name: "solver.py",
    text: "def solve():\n    return 42\n",
    rank: "b1",
  }, "solo");
  const identity: CodeWorkspaceBlobIdentity = {
    sha256: hash(bytes),
    byteSize: bytes.byteLength,
    mimeType: "application/octet-stream",
  };
  addCodeWorkspaceEntry(document, {
    id: "dataset-a",
    kind: "file",
    name: "dataset-a.bin",
    blob: identity,
    rank: "c0",
  }, "solo");
  addCodeWorkspaceEntry(document, {
    id: "dataset-b",
    kind: "file",
    name: "dataset-b.bin",
    blob: identity,
    rank: "c1",
  }, "solo");
  addCodeTestCase(document, {
    id: "hidden-shape",
    name: "Границы",
    stdin: "40 2\n",
    expectedOutput: "42\n",
  }, "solo");
  const blob = new Blob([Uint8Array.from(bytes).buffer], {
    type: identity.mimeType,
  });
  const flush = vi.fn(async () => undefined);
  const get = vi.fn(async (requested: CodeWorkspaceBlobIdentity) => (
    requested.sha256 === identity.sha256 ? blob : null
  ));
  return {
    session: { document, blobStore: { get }, flush },
    identity,
    blob,
    flush,
    get,
  };
}

describe("promoteSoloCodeToGuestRoom", () => {
  it("atomically replaces the server default and waits for blob publication and Code ACK", async () => {
    const source = sourceWorkspace(Uint8Array.of(4, 8, 15, 16, 23, 42));
    const sourceBefore = Y.encodeStateAsUpdate(source.session.document);
    const uploadGate = deferred();
    const ackGate = deferred();
    const provider = new ControlledPromotionProvider(ackGate.promise);
    const blobStore = new MemoryPromotionBlobStore();
    const uploaded: Array<{
      readonly identity: CodeWorkspaceBlobIdentity;
      readonly blob: Blob;
    }> = [];
    const createdRoom = room();
    const finalizeDraft = vi.fn(async () => createdRoom);
    const cancelDraft = vi.fn(async () => undefined);
    const dependencies: Partial<SoloCodePromotionDependencies> = {
      createDraft: vi.fn(async () => ({
        room: createdRoom,
        initializationToken: "code-draft-token",
      })),
      finalizeDraft,
      cancelDraft,
      getDeviceId: () => "device-12345678901234567890123456789012",
      createProvider: (options) => {
        expect(options).toMatchObject({
          shareId: createdRoom.shareId,
          resourceId: "code-resource",
          databaseName: "eduri-code-room-v1:code-resource",
        });
        return provider;
      },
      createBlobStore: (name) => {
        expect(name).toBe(
          "eduri-code-room-v1:code-resource:content-blobs:v1",
        );
        return blobStore;
      },
      createBlobUploader: (shareId) => {
        expect(shareId).toBe(createdRoom.shareId);
        return {
          upload: async (identity, blob) => {
            uploaded.push({ identity, blob });
            await uploadGate.promise;
          },
        };
      },
    };

    let completed = false;
    const promotion = promoteSoloCodeToGuestRoom({
      session: source.session,
      dependencies,
      timeoutMs: 2_000,
    }).then((result) => {
      completed = true;
      return result;
    });

    await expect.poll(() => uploaded.length).toBe(1);
    expect(source.flush).toHaveBeenCalledOnce();
    expect(source.get).toHaveBeenCalledOnce();
    expect(provider.syncCalls).toBe(1);
    expect(codeWorkspaceText(provider.document, "main-py")?.toString())
      .toBe("print(\"server default\")\n");
    expect(completed).toBe(false);
    expect(finalizeDraft).not.toHaveBeenCalled();

    uploadGate.resolve();
    await expect.poll(() => provider.syncCalls).toBe(2);
    expect(completed).toBe(false);
    expect(codeWorkspaceText(provider.document, "main-py")?.toString())
      .toBe("print(\"solo answer\")\n");
    expect(listCodeWorkspaceEntries(provider.document)).toEqual(
      listCodeWorkspaceEntries(source.session.document),
    );
    expect(listCodeTestCases(provider.document)).toEqual(
      listCodeTestCases(source.session.document),
    );
    expect(provider.flush).toHaveBeenCalledOnce();
    expect(finalizeDraft).not.toHaveBeenCalled();
    const copiedBlob = blobStore.blobs.get(source.identity.sha256);
    expect(copiedBlob).toBeDefined();
    expect(new Uint8Array(await copiedBlob!.arrayBuffer())).toEqual(
      new Uint8Array(await source.blob.arrayBuffer()),
    );

    ackGate.resolve();
    await expect(promotion).resolves.toEqual(createdRoom);
    expect(finalizeDraft).toHaveBeenCalledWith(
      createdRoom.shareId,
      "code-draft-token",
    );
    expect(cancelDraft).not.toHaveBeenCalled();
    expect(uploaded[0]?.identity).toEqual(source.identity);
    expect(provider.stop).toHaveBeenCalledOnce();
    expect(provider.clearLocalData).not.toHaveBeenCalled();
    expect(blobStore.closed).toBe(true);
    expect(Y.encodeStateAsUpdate(source.session.document)).toEqual(sourceBefore);
  });

  it("preserves guest state and resumes an ambiguous finalization", async () => {
    const source = sourceWorkspace(Uint8Array.of(2, 7, 1, 8));
    const createdRoom = room("ambiguous-code-share");
    const draft = {
      room: createdRoom,
      initializationToken: "ambiguous-code-token",
    };
    const provider = new ControlledPromotionProvider();
    const blobStore = new MemoryPromotionBlobStore();
    const cancelDraft = vi.fn(async () => undefined);
    const savePendingFinalization = vi.fn();
    const clearPendingFinalization = vi.fn();
    const finalizeDraft = vi.fn(async () => {
      throw new TypeError("response connection was lost");
    });

    await expect(promoteSoloCodeToGuestRoom({
      session: source.session,
      dependencies: {
        createDraft: async () => draft,
        finalizeDraft,
        cancelDraft,
        createProvider: () => provider,
        createBlobStore: () => blobStore,
        createBlobUploader: () => ({ upload: async () => undefined }),
        savePendingFinalization,
        clearPendingFinalization,
      },
    })).rejects.toThrow("response connection was lost");

    expect(savePendingFinalization).toHaveBeenCalledWith(draft);
    expect(clearPendingFinalization).not.toHaveBeenCalled();
    expect(cancelDraft).not.toHaveBeenCalled();
    expect(provider.stop).toHaveBeenCalledOnce();
    expect(provider.clearLocalData).not.toHaveBeenCalled();
    expect(blobStore.closed).toBe(true);
    expect(blobStore.cleared).toBe(false);

    const recovered = await promoteSoloCodeToGuestRoom({
      session: source.session,
      dependencies: {
        loadPendingFinalization: () => ({
          version: 1,
          kind: "code",
          draft,
          preparedAt: "2026-08-09T08:00:00.000Z",
        }),
        finalizeDraft: async (shareId, initializationToken) => {
          expect(shareId).toBe(createdRoom.shareId);
          expect(initializationToken).toBe(draft.initializationToken);
          return createdRoom;
        },
        clearPendingFinalization,
        createDraft: vi.fn(async () => draft),
      },
    });
    expect(recovered).toEqual(createdRoom);
    expect(clearPendingFinalization).toHaveBeenCalledOnce();
    expect(source.flush).toHaveBeenCalledOnce();
  });

  it.each([404, 410])(
    "discards a terminal Code recovery response (%s) and creates a fresh draft",
    async (status) => {
      const source = sourceWorkspace(Uint8Array.of(3, 1, 4, 1, 5));
      const staleDraft = {
        room: room(`stale-code-${status}`),
        initializationToken: `stale-code-token-${status}`,
      };
      const freshDraft = {
        room: room(`fresh-code-${status}`),
        initializationToken: `fresh-code-token-${status}`,
      };
      const provider = new ControlledPromotionProvider();
      const blobStore = new MemoryPromotionBlobStore();
      const createDraft = vi.fn(async () => freshDraft);
      const savePendingFinalization = vi.fn();
      const clearPendingFinalization = vi.fn();
      const finalizeDraft = vi.fn(async (shareId: string) => {
        if (shareId === staleDraft.room.shareId) {
          throw new ApiError("Stored Code draft is stale", status);
        }
        return freshDraft.room;
      });

      await expect(promoteSoloCodeToGuestRoom({
        session: source.session,
        dependencies: {
          loadPendingFinalization: () => ({
            version: 1,
            kind: "code",
            draft: staleDraft,
            preparedAt: "2026-08-09T08:00:00.000Z",
          }),
          createDraft,
          finalizeDraft,
          cancelDraft: async () => undefined,
          createProvider: () => provider,
          createBlobStore: () => blobStore,
          createBlobUploader: () => ({ upload: async () => undefined }),
          savePendingFinalization,
          clearPendingFinalization,
        },
      })).resolves.toEqual(freshDraft.room);

      expect(createDraft).toHaveBeenCalledOnce();
      expect(finalizeDraft).toHaveBeenNthCalledWith(
        1,
        staleDraft.room.shareId,
        staleDraft.initializationToken,
      );
      expect(finalizeDraft).toHaveBeenNthCalledWith(
        2,
        freshDraft.room.shareId,
        freshDraft.initializationToken,
      );
      expect(clearPendingFinalization).toHaveBeenNthCalledWith(1, staleDraft);
      expect(clearPendingFinalization).toHaveBeenNthCalledWith(2, freshDraft);
    },
  );

  it("keeps Code recovery when abort arrives during post-finalize cleanup", async () => {
    const source = sourceWorkspace(Uint8Array.of(2, 6, 5, 3));
    const createdDraft = {
      room: room("aborted-after-finalize-code"),
      initializationToken: "aborted-after-finalize-code-token",
    };
    const provider = new ControlledPromotionProvider();
    const blobStore = new MemoryPromotionBlobStore();
    const cleanupStarted = deferred();
    const releaseCleanup = deferred();
    const controller = new AbortController();
    const savePendingFinalization = vi.fn();
    const clearPendingFinalization = vi.fn();
    provider.stop.mockImplementation(async () => {
      cleanupStarted.resolve();
      await releaseCleanup.promise;
    });

    const promotion = promoteSoloCodeToGuestRoom({
      session: source.session,
      signal: controller.signal,
      dependencies: {
        createDraft: async () => createdDraft,
        finalizeDraft: async () => createdDraft.room,
        cancelDraft: vi.fn(async () => undefined),
        createProvider: () => provider,
        createBlobStore: () => blobStore,
        createBlobUploader: () => ({ upload: async () => undefined }),
        savePendingFinalization,
        clearPendingFinalization,
      },
    });

    await cleanupStarted.promise;
    controller.abort();
    releaseCleanup.resolve();

    await expect(promotion).rejects.toMatchObject({ name: "AbortError" });
    expect(savePendingFinalization).toHaveBeenCalledWith(createdDraft);
    expect(clearPendingFinalization).not.toHaveBeenCalled();
    expect(provider.clearLocalData).not.toHaveBeenCalled();
    expect(blobStore.cleared).toBe(false);
  });

  it("clears partial guest databases after publication fails and leaves solo intact", async () => {
    const source = sourceWorkspace(Uint8Array.of(9, 7, 5, 3, 1));
    const sourceBefore = Y.encodeStateAsUpdate(source.session.document);
    const provider = new ControlledPromotionProvider();
    const blobStore = new MemoryPromotionBlobStore();
    const failedRoom = room("failed-code-share");
    const finalizeDraft = vi.fn(async () => failedRoom);
    const cancelDraft = vi.fn(async () => undefined);

    await expect(promoteSoloCodeToGuestRoom({
      session: source.session,
      timeoutMs: 2_000,
      dependencies: {
        createDraft: async () => ({
          room: failedRoom,
          initializationToken: "failed-code-token",
        }),
        finalizeDraft,
        cancelDraft,
        createProvider: () => provider,
        createBlobStore: () => blobStore,
        createBlobUploader: () => ({
          upload: async () => {
            throw new Error("blob quota rejected");
          },
        }),
      },
    })).rejects.toThrow("blob quota rejected");

    expect(provider.clearLocalData).toHaveBeenCalledOnce();
    expect(provider.stop).not.toHaveBeenCalled();
    expect(blobStore.cleared).toBe(true);
    expect(blobStore.blobs.size).toBe(0);
    expect(finalizeDraft).not.toHaveBeenCalled();
    expect(cancelDraft).toHaveBeenCalledWith(
      failedRoom.shareId,
      "failed-code-token",
    );
    expect(Y.encodeStateAsUpdate(source.session.document)).toEqual(sourceBefore);
    expect(source.get).toHaveBeenCalledOnce();
  });

  it("verifies every referenced binary before creating a room", async () => {
    const source = sourceWorkspace(Uint8Array.of(1, 2, 3));
    const createDraft = vi.fn(async () => ({
      room: room(),
      initializationToken: "unused-token",
    }));
    const missingSession: SoloCodePromotionSession = {
      ...source.session,
      blobStore: { get: async () => null },
    };

    await expect(promoteSoloCodeToGuestRoom({
      session: missingSession,
      dependencies: { createDraft },
    })).rejects.toThrow("local bytes are unavailable");
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("cancels a draft when promotion is aborted while creation is in flight", async () => {
    const source = sourceWorkspace(Uint8Array.of(6, 2, 6));
    const createdRoom = room("aborted-draft-share");
    let releaseDraft!: () => void;
    const draftGate = new Promise<void>((resolve) => {
      releaseDraft = resolve;
    });
    let markDraftStarted!: () => void;
    const draftStarted = new Promise<void>((resolve) => {
      markDraftStarted = resolve;
    });
    const cancelDraft = vi.fn(async () => undefined);
    const controller = new AbortController();
    const promotion = promoteSoloCodeToGuestRoom({
      session: source.session,
      signal: controller.signal,
      dependencies: {
        createDraft: async () => {
          markDraftStarted();
          await draftGate;
          return {
            room: createdRoom,
            initializationToken: "aborted-draft-token",
          };
        },
        cancelDraft,
      },
    });

    await draftStarted;
    controller.abort();
    releaseDraft();
    await expect(promotion).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelDraft).toHaveBeenCalledWith(
      createdRoom.shareId,
      "aborted-draft-token",
    );
  });
});
