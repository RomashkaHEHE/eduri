import * as Y from "yjs";
import {
  codeWorkspaceEntries,
  codeWorkspaceMeta,
  codeWorkspaceTestCases,
  listCodeWorkspaceEntries,
  validateCodeWorkspaceDocument,
  type CodeWorkspaceBlobIdentity,
} from "../../code/core";
import { api, type GuestRoom, type GuestRoomDraft } from "../api";
import { guestDeviceId } from "../guestIdentity";
import {
  clearPendingGuestFinalization,
  isDefinitiveGuestFinalizationFailure,
  loadPendingGuestFinalization,
  savePendingGuestFinalization,
  type PendingGuestFinalization,
} from "../promotionFinalization";
import {
  CodeBlobStore,
  codeBlobIdentity,
  codeBlobStoreName,
} from "./codeBlobStore";
import {
  GuestCodeBlobHttpClient,
  type GuestCodeBlobUploader,
} from "./guestCodeBlobHttp";
import {
  GuestCodeProvider,
  guestCodeDatabaseName,
  type GuestCodeProviderOptions,
} from "./guestCodeProvider";

const DEFAULT_PROMOTION_TIMEOUT_MS = 5 * 60_000;

interface SourceCodeBlobStore {
  get(identity: CodeWorkspaceBlobIdentity): Promise<Blob | null>;
}

interface PromotionCodeBlobStore {
  readonly whenReady: Promise<boolean>;
  put(blob: Blob): Promise<CodeWorkspaceBlobIdentity>;
  close(): Promise<void>;
  clearData(): Promise<void>;
}

interface PromotionCodeProvider {
  readonly document: Y.Doc;
  readonly origin: object;
  start(): Promise<void>;
  flush(): Promise<void>;
  waitUntilSynchronized(timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
  clearLocalData(): Promise<void>;
}

export interface SoloCodePromotionSession {
  readonly document: Y.Doc;
  readonly blobStore: SourceCodeBlobStore;
  flush(): Promise<void>;
}

export interface SoloCodePromotionDependencies {
  readonly createDraft: () => Promise<GuestRoomDraft>;
  readonly finalizeDraft: (
    shareId: string,
    initializationToken: string,
  ) => Promise<GuestRoom>;
  readonly cancelDraft: (
    shareId: string,
    initializationToken: string,
  ) => Promise<void>;
  readonly getDeviceId: () => string;
  readonly createProvider: (
    options: GuestCodeProviderOptions,
  ) => PromotionCodeProvider;
  readonly createBlobStore: (name: string) => PromotionCodeBlobStore;
  readonly createBlobUploader: (shareId: string) => GuestCodeBlobUploader;
  readonly loadPendingFinalization: () => PendingGuestFinalization | null;
  readonly savePendingFinalization: (draft: GuestRoomDraft) => void;
  readonly clearPendingFinalization: (draft: GuestRoomDraft) => void;
}

export interface PromoteSoloCodeOptions {
  readonly session: SoloCodePromotionSession;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly dependencies?: Partial<SoloCodePromotionDependencies>;
}

interface VerifiedCodeBlob {
  readonly identity: CodeWorkspaceBlobIdentity;
  readonly blob: Blob;
}

const defaultDependencies: SoloCodePromotionDependencies = {
  createDraft: () => api.guestRooms.createDraft("code"),
  finalizeDraft: (shareId, initializationToken) => (
    api.guestRooms.finalizeDraft(shareId, initializationToken)
  ),
  cancelDraft: (shareId, initializationToken) => (
    api.guestRooms.cancelDraft(shareId, initializationToken)
  ),
  getDeviceId: guestDeviceId,
  createProvider: (options) => new GuestCodeProvider(options),
  createBlobStore: (name) => new CodeBlobStore(name),
  createBlobUploader: (shareId) => new GuestCodeBlobHttpClient({ shareId }),
  loadPendingFinalization: () => loadPendingGuestFinalization("code"),
  savePendingFinalization: (draft) => {
    savePendingGuestFinalization("code", draft);
  },
  clearPendingFinalization: (draft) => {
    clearPendingGuestFinalization("code", draft);
  },
};

function abortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("Solo Code promotion was cancelled", "AbortError");
  }
  const error = new Error("Solo Code promotion was cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function waitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const handleAbort = (): void => reject(abortError());
    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", handleAbort);
    });
  });
}

function sameBlobIdentity(
  left: CodeWorkspaceBlobIdentity,
  right: CodeWorkspaceBlobIdentity,
): boolean {
  return left.sha256 === right.sha256
    && left.byteSize === right.byteSize
    && left.mimeType === right.mimeType;
}

async function readAndVerifySourceBlobs(
  session: SoloCodePromotionSession,
  signal: AbortSignal | undefined,
): Promise<readonly VerifiedCodeBlob[]> {
  const identities = new Map<string, CodeWorkspaceBlobIdentity>();
  for (const entry of listCodeWorkspaceEntries(session.document)) {
    if (!entry.blob) continue;
    const existing = identities.get(entry.blob.sha256);
    if (existing && !sameBlobIdentity(existing, entry.blob)) {
      throw new Error(
        "Solo Code contains conflicting identities for one binary blob",
      );
    }
    identities.set(entry.blob.sha256, { ...entry.blob });
  }

  const result: VerifiedCodeBlob[] = [];
  for (const identity of identities.values()) {
    throwIfAborted(signal);
    const blob = await waitWithAbort(session.blobStore.get(identity), signal);
    if (!blob) {
      throw new Error(
        "Solo Code contains a binary file whose local bytes are unavailable",
      );
    }
    const actualIdentity = await waitWithAbort(codeBlobIdentity(blob), signal);
    if (!sameBlobIdentity(actualIdentity, identity)) {
      throw new Error("Solo Code binary bytes do not match their identity");
    }
    result.push({ identity, blob });
  }
  return result;
}

function replaceGuestWorkspace(
  provider: PromotionCodeProvider,
  sourceUpdate: Uint8Array,
): void {
  const sourceDocument = new Y.Doc();
  try {
    Y.applyUpdate(sourceDocument, sourceUpdate);
    validateCodeWorkspaceDocument(sourceDocument);
    const sourceEntries = codeWorkspaceEntries(sourceDocument);
    const sourceMeta = codeWorkspaceMeta(sourceDocument);
    const sourceTests = codeWorkspaceTestCases(sourceDocument);

    Y.transact(provider.document, () => {
      const guestEntries = codeWorkspaceEntries(provider.document);
      const guestMeta = codeWorkspaceMeta(provider.document);
      const guestTests = codeWorkspaceTestCases(provider.document);
      guestEntries.clear();
      guestMeta.clear();
      guestTests.clear();
      for (const [key, value] of sourceMeta) guestMeta.set(key, value);
      for (const [id, entry] of sourceEntries) {
        guestEntries.set(id, entry.clone());
      }
      for (const [id, testCase] of sourceTests) {
        guestTests.set(id, testCase.clone());
      }
    }, provider.origin);
  } finally {
    sourceDocument.destroy();
  }
}

async function closeGuestResources(
  provider: PromotionCodeProvider | null,
  blobStore: PromotionCodeBlobStore | null,
  clear: boolean,
): Promise<readonly unknown[]> {
  const results = await Promise.allSettled([
    provider
      ? clear ? provider.clearLocalData() : provider.stop()
      : Promise.resolve(),
    blobStore
      ? clear ? blobStore.clearData() : blobStore.close()
      : Promise.resolve(),
  ]);
  return results.flatMap((result) => (
    result.status === "rejected" ? [result.reason] : []
  ));
}

export async function promoteSoloCodeToGuestRoom({
  session,
  signal,
  timeoutMs = DEFAULT_PROMOTION_TIMEOUT_MS,
  dependencies: dependencyOverrides,
}: PromoteSoloCodeOptions): Promise<GuestRoom> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("timeoutMs must be a positive safe integer");
  }
  throwIfAborted(signal);

  const dependencies: SoloCodePromotionDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };
  const attemptedFinalizations = new Set<string>();
  let pendingFinalization = dependencies.loadPendingFinalization();
  while (pendingFinalization) {
    const attemptIdentity = [
      pendingFinalization.draft.room.shareId,
      pendingFinalization.draft.initializationToken,
    ].join("\u0000");
    if (attemptedFinalizations.has(attemptIdentity)) break;
    attemptedFinalizations.add(attemptIdentity);
    try {
      const recoveredRoom = await dependencies.finalizeDraft(
        pendingFinalization.draft.room.shareId,
        pendingFinalization.draft.initializationToken,
      );
      throwIfAborted(signal);
      dependencies.clearPendingFinalization(pendingFinalization.draft);
      return recoveredRoom;
    } catch (error) {
      if (!isDefinitiveGuestFinalizationFailure(error)) throw error;
      dependencies.clearPendingFinalization(pendingFinalization.draft);
      throwIfAborted(signal);
      pendingFinalization = dependencies.loadPendingFinalization();
    }
  }

  await waitWithAbort(session.flush(), signal);
  throwIfAborted(signal);
  validateCodeWorkspaceDocument(session.document);
  const sourceUpdate = Y.encodeStateAsUpdate(session.document);
  const sourceBlobs = await readAndVerifySourceBlobs(session, signal);
  throwIfAborted(signal);

  let provider: PromotionCodeProvider | null = null;
  let guestBlobStore: PromotionCodeBlobStore | null = null;
  let draft: GuestRoomDraft | null = null;
  let finalized = false;
  let finalizationPrepared = false;
  try {
    draft = await dependencies.createDraft();
    throwIfAborted(signal);
    const room = draft.room;
    const resource = room.resources.find((candidate) => (
      candidate.kind === "code"
    ));
    if (!resource) {
      throw new Error("Guest room did not create a Code resource");
    }

    const databaseName = guestCodeDatabaseName(resource.id);
    provider = dependencies.createProvider({
      shareId: room.shareId,
      resourceId: resource.id,
      deviceId: dependencies.getDeviceId(),
      databaseName,
    });
    await waitWithAbort(provider.start(), signal);
    await waitWithAbort(provider.waitUntilSynchronized(timeoutMs), signal);
    throwIfAborted(signal);

    guestBlobStore = dependencies.createBlobStore(
      codeBlobStoreName(databaseName),
    );
    const persistentBlobStorage = await waitWithAbort(
      guestBlobStore.whenReady,
      signal,
    );
    if (!persistentBlobStorage) {
      throw new Error("Guest Code binary storage is not durable");
    }

    const uploader = dependencies.createBlobUploader(room.shareId);
    for (const sourceBlob of sourceBlobs) {
      throwIfAborted(signal);
      const copiedIdentity = await waitWithAbort(
        guestBlobStore.put(sourceBlob.blob),
        signal,
      );
      if (!sameBlobIdentity(copiedIdentity, sourceBlob.identity)) {
        throw new Error("Guest Code binary changed during local promotion");
      }
      await uploader.upload(sourceBlob.identity, sourceBlob.blob, signal);
    }

    throwIfAborted(signal);
    replaceGuestWorkspace(provider, sourceUpdate);
    validateCodeWorkspaceDocument(provider.document);
    await waitWithAbort(provider.flush(), signal);
    await waitWithAbort(provider.waitUntilSynchronized(timeoutMs), signal);
    throwIfAborted(signal);

    dependencies.savePendingFinalization(draft);
    finalizationPrepared = true;
    const finalizedRoom = await dependencies.finalizeDraft(
      room.shareId,
      draft.initializationToken,
    );
    finalized = true;

    const closeFailures = await closeGuestResources(
      provider,
      guestBlobStore,
      false,
    );
    provider = null;
    guestBlobStore = null;
    if (closeFailures.length > 0) {
      console.error(
        "Guest Code promotion could not close its local resources",
        closeFailures,
      );
    }
    throwIfAborted(signal);
    dependencies.clearPendingFinalization(draft);
    return finalizedRoom;
  } catch (error) {
    const preserveGuestState = finalizationPrepared || finalized;
    if (draft && !preserveGuestState) {
      await dependencies.cancelDraft(
        draft.room.shareId,
        draft.initializationToken,
      ).catch(() => undefined);
    }
    const cleanupFailures = await closeGuestResources(
      provider,
      guestBlobStore,
      !preserveGuestState,
    );
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "Solo Code promotion failed and cleanup was incomplete",
      );
    }
    throw error;
  }
}
