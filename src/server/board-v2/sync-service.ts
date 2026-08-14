import { createHash, createHmac, randomUUID } from "node:crypto";

import * as decoding from "lib0/decoding";
import * as Y from "yjs";

import {
  BOARD_CORE_SCHEMA_VERSION,
  compareCodeUnitStrings,
  createManifestDocument,
  createManifestPageRecord,
  createPageDocument,
  getManifestPages,
} from "../../board/core/index.js";
import {
  BOARD_PROTOCOL_LIMITS,
  BOARD_PROTOCOL_VERSION,
  BoardCapability,
  BoardMessageType,
  BoardPermission,
  type AuthFrame,
} from "../../board/protocol/index.js";
import {
  COLLABORATION_PROFILE_COLORS,
  type CollaborationProfile,
} from "../../shared/collaborationProfile.js";
import { nowIso, safeEqual } from "../security.js";
import type { AppContext, AuthContext, Role } from "../types.js";
import {
  BoardRepository,
  BoardRepositoryError,
  type AppendBoardUpdateResult,
  type BoardMetrics,
  type BoardRecord,
  validateBoardDocumentKey,
} from "./repository.js";
import {
  BoardCompactionCoordinator,
  type BoardCompactionCoordinatorOptions,
} from "./compaction.js";
import {
  BoardDocumentSchemaError,
  applyAndValidateBoardUpdate,
  createBoardDocumentValidationShadow,
} from "./document-schema.js";
import {
  BOARD_SYNC_TICKET_TTL_MS,
  BoardSyncTicketError,
  BoardSyncTicketStore,
  type IssuedBoardSyncTicket,
  type BoardSyncTicketScope,
} from "./sync-ticket.js";

export const BOARD_SYNC_WEBSOCKET_PATH = "/api/board-v2/sync";
export const BOARD_SYNC_TICKET_PATH = "/api/board-v2/sync-ticket";

export const BOARD_SYNC_SERVER_CAPABILITIES =
  BoardCapability.CHUNKING
  | BoardCapability.AWARENESS
  | BoardCapability.PAGE_SHARDING
  | BoardCapability.PROFILE_UPDATE;

const MANIFEST_DOCUMENT_KEY = "manifest";
const DEFAULT_PAGE_NAME = "Страница 1";
const DEFAULT_PAGE_RANK = "a0";
const MAX_CACHED_DOCUMENTS = 64;
const DOCUMENT_MEMORY_ESTIMATE_MULTIPLIER = 8;
const GUEST_BOARD_USER_ID_PREFIX = "guest_";

export type BoardSyncServiceErrorCode =
  | "NOT_FOUND"
  | "BOARD_NOT_V2"
  | "BOARD_GONE"
  | "PROTOCOL_MISMATCH"
  | "SCHEMA_MISMATCH"
  | "SESSION_REVOKED"
  | "ACCESS_REVOKED"
  | "READ_ONLY"
  | "INVALID_TICKET"
  | "INVALID_UPDATE"
  | "RATE_LIMITED"
  | "NO_NEW_INFORMATION"
  | "CAUSAL_GAP"
  | "CORRUPT_DOCUMENT"
  | "TENANT_QUOTA"
  | "DISK_PRESSURE"
  | "STORAGE_ERROR";

export class BoardSyncServiceError extends Error {
  constructor(
    public readonly code: BoardSyncServiceErrorCode,
    message: string,
    options?: ErrorOptions,
    public readonly retryAfterMs?: number,
  ) {
    super(message, options);
    this.name = "BoardSyncServiceError";
  }
}

export interface BoardSyncTicketRequest {
  lessonId: string;
  minSchemaVersion: number;
  maxSchemaVersion: number;
  capabilities: number;
  profile?: CollaborationProfile;
}

export interface GuestBoardSyncTicketRequest {
  shareKey: string;
  deviceId: string;
  minSchemaVersion: number;
  maxSchemaVersion: number;
  capabilities: number;
  profile?: CollaborationProfile;
}

export interface BoardSyncTicketResponse {
  ticket: string;
  expiresAt: string;
  boardId: string;
  generation: number;
  protocolVersion: number;
  schemaVersion: number;
  capabilities: number;
  permissions: number;
  manifestDocKey: string;
  defaultPageId: string;
  defaultPageDocKey: string;
  docKeys: {
    manifest: string;
    defaultPage: string;
  };
  websocketPath: string;
}

export interface BoardSyncAccess {
  boardId: string;
  lessonId: string;
  roomResourceId: string | null;
  generation: number;
  protocolVersion: number;
  schemaVersion: number;
  lifecycle: "active" | "tombstoned";
  lessonStatus: "scheduled" | "active" | "completed" | "cancelled";
  permissions: number;
  userId: string;
  sessionHash: string;
  displayName: string;
  color: `#${string}`;
  role: Exclude<Role, "admin"> | "guest";
}

export interface AuthenticatedBoardSync {
  access: BoardSyncAccess;
  capabilities: number;
}

export interface BoardSyncConnectionIdentity {
  boardId: string;
  generation: number;
  userId: string;
  sessionHash: string;
  profile?: CollaborationProfile;
}

export interface AuthorizedBoardMetrics {
  board: BoardRecord;
  metrics: BoardMetrics;
}

interface ActorRow {
  id: string;
  role: Role;
  status: "pending" | "active" | "suspended";
  display_name: string;
  session_hash: string;
}

interface LessonAccessRow {
  id: string;
  tutor_id: string;
  student_id: string;
  status: "scheduled" | "active" | "completed" | "cancelled";
}

interface BoardAccessRow {
  id: string;
  lesson_id: string | null;
  room_resource_id: string | null;
  engine: "legacy" | "v2";
  lifecycle: "active" | "tombstoned";
  generation: number;
  protocol_version: number;
  schema_version: number;
  lesson_status: "scheduled" | "active" | "completed" | "cancelled";
  tutor_id: string;
  student_id: string;
}

interface GuestBoardAccessRow {
  id: string;
  room_resource_id: string;
  engine: "legacy" | "v2";
  lifecycle: "active" | "tombstoned";
  generation: number;
  protocol_version: number;
  schema_version: number;
  room_id: string;
  share_key: string;
  expires_at: string;
}

interface CachedDocument {
  doc: Y.Doc;
  validationDoc: Y.Doc;
  lastUsed: number;
  estimatedBytes: number;
}

function fail(
  code: BoardSyncServiceErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new BoardSyncServiceError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function estimatedDocumentMemoryBytes(serializedBytes: number): number {
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(1, serializedBytes * DOCUMENT_MEMORY_ESTIMATE_MULTIPLIER),
  );
}

function permissionsForLesson(
  status: LessonAccessRow["status"],
): number {
  return BoardPermission.READ
    | (status === "scheduled" || status === "active"
      ? BoardPermission.EDIT
      : 0);
}

function defaultCollaborationProfile(
  stableId: string,
  displayName: string,
): CollaborationProfile {
  const digest = createHash("sha256").update(stableId).digest();
  return {
    displayName,
    color: COLLABORATION_PROFILE_COLORS[
      digest[0] % COLLABORATION_PROFILE_COLORS.length
    ],
  };
}

function withCollaborationProfile(
  access: BoardSyncAccess,
  profile?: CollaborationProfile,
): BoardSyncAccess {
  return profile ? { ...access, ...profile } : access;
}

function guestBoardIdentity(
  signingKey: string,
  shareKey: string,
  deviceId: string,
): { userId: string; sessionHash: string; displayName: string } {
  const actorDigest = createHmac("sha256", signingKey)
    .update("eduri-guest-board-actor\0")
    .update(shareKey)
    .update("\0")
    .update(deviceId)
    .digest("base64url");
  const userId = `${GUEST_BOARD_USER_ID_PREFIX}${actorDigest}`;
  const sessionHash = guestBoardSessionHash(signingKey, shareKey, userId);
  return {
    userId,
    sessionHash,
    displayName: `Гость ${actorDigest.slice(0, 4)}`,
  };
}

function guestBoardSessionHash(
  signingKey: string,
  shareKey: string,
  userId: string,
): string {
  return `guest:${createHmac("sha256", signingKey)
    .update("eduri-guest-board-session\0")
    .update(shareKey)
    .update("\0")
    .update(userId)
    .digest("hex")}`;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

export function validateBoardStateVector(stateVector: Uint8Array): void {
  try {
    const decoder = decoding.createDecoder(stateVector);
    const clientCount = decoding.readVarUint(decoder);
    if (clientCount > Math.floor((stateVector.byteLength - decoder.pos) / 2)) {
      fail(
        "INVALID_UPDATE",
        "SYNC_STEP1 state vector has an invalid client count",
      );
    }
    const clients = new Set<number>();
    for (let index = 0; index < clientCount; index += 1) {
      const client = decoding.readVarUint(decoder);
      decoding.readVarUint(decoder);
      if (clients.has(client)) {
        fail(
          "INVALID_UPDATE",
          "SYNC_STEP1 state vector contains a duplicate client",
        );
      }
      clients.add(client);
    }
    if (decoding.hasContent(decoder)) {
      fail("INVALID_UPDATE", "SYNC_STEP1 state vector has trailing data");
    }
  } catch (error) {
    if (error instanceof BoardSyncServiceError) throw error;
    fail("INVALID_UPDATE", "SYNC_STEP1 contains an invalid state vector", error);
  }
}

function hasUpdateContent(update: Uint8Array): boolean {
  const decoded = Y.decodeUpdate(update);
  return decoded.structs.length > 0 || decoded.ds.clients.size > 0;
}

function failRepositoryUpdate(error: unknown): never {
  if (error instanceof BoardRepositoryError) {
    if (error.code === "BOARD_GONE") {
      fail("BOARD_GONE", error.message, error);
    }
    if (error.code === "RESOURCE_INACTIVE") {
      fail("BOARD_GONE", error.message, error);
    }
    if (error.code === "GENERATION_MISMATCH") {
      fail("ACCESS_REVOKED", error.message, error);
    }
    if (
      error.code === "SIZE_LIMIT"
      || error.code === "IDEMPOTENCY_CONFLICT"
      || error.code === "INVALID_ARGUMENT"
    ) {
      fail("INVALID_UPDATE", error.message, error);
    }
    if (error.code === "TENANT_QUOTA") {
      fail("TENANT_QUOTA", error.message, error);
    }
    if (error.code === "DISK_PRESSURE") {
      fail("DISK_PRESSURE", error.message, error);
    }
    if (error.code === "STORAGE_ERROR") {
      fail("STORAGE_ERROR", error.message, error);
    }
  }
  fail("STORAGE_ERROR", "Board update could not be durably stored", error);
}

function applyPersistedDocument(
  repository: BoardRepository,
  boardId: string,
  documentKey: string,
  generation: number,
): Y.Doc {
  const loaded = repository.loadDocument({ boardId, documentKey, generation });
  const doc = new Y.Doc();
  try {
    if (loaded.document.snapshot.byteLength > 0) {
      Y.applyUpdate(doc, loaded.document.snapshot);
    }
    if (
      loaded.document.stateVector.byteLength > 0
      && !bytesEqual(
        Y.encodeStateVector(doc),
        loaded.document.stateVector,
      )
    ) {
      fail(
        "CORRUPT_DOCUMENT",
        `Stored state vector does not match snapshot for '${documentKey}'`,
      );
    }
    for (const update of loaded.updates) {
      Y.applyUpdate(doc, update.update);
    }
    return doc;
  } catch (error) {
    doc.destroy();
    if (error instanceof BoardSyncServiceError) throw error;
    fail(
      "CORRUPT_DOCUMENT",
      `Cannot reconstruct Board document '${documentKey}'`,
      error,
    );
  }
}

function readDefaultPageId(manifest: Y.Doc): string {
  const pages = [...getManifestPages(manifest).values()]
    .map((record) => {
      if (!(record instanceof Y.Map)) {
        fail("CORRUPT_DOCUMENT", "Manifest contains an invalid page record");
      }
      const id = record.get("id");
      const rank = record.get("rank");
      if (typeof id !== "string" || typeof rank !== "string") {
        fail("CORRUPT_DOCUMENT", "Manifest page record has no valid id or rank");
      }
      return { id, rank };
    })
    .sort((left, right) =>
      compareCodeUnitStrings(left.rank, right.rank)
      || compareCodeUnitStrings(left.id, right.id));
  if (pages.length === 0) {
    fail("CORRUPT_DOCUMENT", "Board manifest has no page");
  }
  return pages[0].id;
}

export class BoardSyncService {
  readonly repository: BoardRepository;
  readonly tickets: BoardSyncTicketStore;
  readonly compaction: BoardCompactionCoordinator;
  private readonly documents = new Map<string, CachedDocument>();
  private readonly maxCachedDocumentBytes: number;
  private cachedDocumentBytes = 0;

  constructor(
    private readonly context: AppContext,
    options: BoardCompactionCoordinatorOptions = {},
  ) {
    this.repository = new BoardRepository(
      context.db,
      {},
      {
        tenantSoftQuotaBytes: context.config.boardV2TenantQuotaBytes,
        minFreeDiskBytes: context.config.boardV2MinFreeDiskBytes,
        storageRoot: context.config.dataDir,
      },
    );
    this.tickets = new BoardSyncTicketStore(context.config.authLookupKey);
    this.maxCachedDocumentBytes =
      context.config.boardV2ActiveDocumentCacheBytes;
    this.compaction = new BoardCompactionCoordinator(
      this.repository,
      options,
    );
  }

  private issueBoardTicket(
    scope: BoardSyncTicketScope,
  ): IssuedBoardSyncTicket {
    try {
      return this.tickets.issue(scope);
    } catch (error) {
      if (!(error instanceof BoardSyncTicketError)) throw error;
      throw new BoardSyncServiceError(
        "RATE_LIMITED",
        error.message,
        { cause: error },
        BOARD_SYNC_TICKET_TTL_MS,
      );
    }
  }

  issueTicket(
    auth: AuthContext,
    request: BoardSyncTicketRequest,
  ): BoardSyncTicketResponse {
    if (request.minSchemaVersion > request.maxSchemaVersion) {
      fail("SCHEMA_MISMATCH", "Minimum schema version exceeds maximum");
    }
    const capabilities = request.capabilities & BOARD_SYNC_SERVER_CAPABILITIES;
    const bootstrapped = this.context.db.transaction(() => {
      const lesson = this.requireLessonAccess(
        auth.user.id,
        auth.sessionHash,
        request.lessonId,
      );
      let board = this.repository.getBoardForLesson(request.lessonId);
      const created = board === null;
      if (!board) {
        board = this.repository.createBoardForLesson(request.lessonId, {
          engine: "v2",
          protocolVersion: BOARD_PROTOCOL_VERSION,
          schemaVersion: BOARD_CORE_SCHEMA_VERSION,
        });
      }
      this.assertUsableBoard(board, request.minSchemaVersion, request.maxSchemaVersion);

      let pageId: string;
      if (created) {
        pageId = randomUUID();
        const manifest = createManifestDocument();
        getManifestPages(manifest).set(
          pageId,
          createManifestPageRecord({
            id: pageId,
            name: DEFAULT_PAGE_NAME,
            rank: DEFAULT_PAGE_RANK,
          }),
        );
        const page = createPageDocument(pageId);
        try {
          this.repository.initializeEmptyDocument({
            boardId: board.id,
            documentKey: MANIFEST_DOCUMENT_KEY,
            generation: board.generation,
            snapshot: Y.encodeStateAsUpdate(manifest),
            stateVector: Y.encodeStateVector(manifest),
          });
          this.repository.ensureDocument({
            boardId: board.id,
            documentKey: `page:${pageId}`,
            generation: board.generation,
            snapshot: Y.encodeStateAsUpdate(page),
            stateVector: Y.encodeStateVector(page),
          });
        } finally {
          manifest.destroy();
          page.destroy();
        }
      } else {
        const manifest = applyPersistedDocument(
          this.repository,
          board.id,
          MANIFEST_DOCUMENT_KEY,
          board.generation,
        );
        try {
          pageId = readDefaultPageId(manifest);
        } finally {
          manifest.destroy();
        }
        // Validate that the manifest cannot advertise a missing default page.
        this.repository.loadDocument({
          boardId: board.id,
          documentKey: `page:${pageId}`,
          generation: board.generation,
        });
      }

      return {
        board,
        lesson,
        pageId,
        created,
      };
    }).immediate();

    if (bootstrapped.created) {
      this.evictBoardDocuments(
        bootstrapped.board.id,
        bootstrapped.board.generation,
      );
    }
    const permissions = permissionsForLesson(bootstrapped.lesson.status);
    const profile = request.profile ?? defaultCollaborationProfile(
      auth.user.id,
      auth.user.displayName,
    );
    const issued = this.issueBoardTicket({
      boardId: bootstrapped.board.id,
      lessonId: bootstrapped.lesson.id,
      userId: auth.user.id,
      sessionHash: auth.sessionHash,
      generation: bootstrapped.board.generation,
      minSchemaVersion: request.minSchemaVersion,
      maxSchemaVersion: request.maxSchemaVersion,
      capabilities,
      profile,
    });
    const defaultPageDocKey = `page:${bootstrapped.pageId}`;
    return {
      ticket: issued.ticket,
      expiresAt: issued.expiresAt,
      boardId: bootstrapped.board.id,
      generation: bootstrapped.board.generation,
      protocolVersion: bootstrapped.board.protocolVersion,
      schemaVersion: bootstrapped.board.schemaVersion,
      capabilities,
      permissions,
      manifestDocKey: MANIFEST_DOCUMENT_KEY,
      defaultPageId: bootstrapped.pageId,
      defaultPageDocKey,
      docKeys: {
        manifest: MANIFEST_DOCUMENT_KEY,
        defaultPage: defaultPageDocKey,
      },
      websocketPath: BOARD_SYNC_WEBSOCKET_PATH,
    };
  }

  issueGuestTicket(
    request: GuestBoardSyncTicketRequest,
  ): BoardSyncTicketResponse {
    if (request.minSchemaVersion > request.maxSchemaVersion) {
      fail("SCHEMA_MISMATCH", "Minimum schema version exceeds maximum");
    }
    const roomLookup = this.context.guestRooms.lookup(request.shareKey);
    if (roomLookup.status === "expired") {
      fail("BOARD_GONE", "Guest room has expired");
    }
    if (roomLookup.status !== "active") {
      fail("NOT_FOUND", "Guest room was not found");
    }
    const resource = roomLookup.room.resources.find((candidate) => (
      candidate.kind === "board" && candidate.ordinal === 1
    ));
    if (!resource) fail("NOT_FOUND", "Guest room has no Board resource");

    const capabilities = request.capabilities & BOARD_SYNC_SERVER_CAPABILITIES;
    const bootstrapped = this.context.db.transaction(() => {
      let board = this.repository.getBoardForRoomResource(resource.id);
      const created = board === null;
      if (!board) {
        board = this.repository.createBoardForRoomResource(resource.id, {
          engine: "v2",
          protocolVersion: BOARD_PROTOCOL_VERSION,
          schemaVersion: BOARD_CORE_SCHEMA_VERSION,
        });
      }
      this.assertUsableBoard(
        board,
        request.minSchemaVersion,
        request.maxSchemaVersion,
      );
      let pageId: string;
      if (created) {
        pageId = randomUUID();
        const manifest = createManifestDocument();
        getManifestPages(manifest).set(
          pageId,
          createManifestPageRecord({
            id: pageId,
            name: DEFAULT_PAGE_NAME,
            rank: DEFAULT_PAGE_RANK,
          }),
        );
        const page = createPageDocument(pageId);
        try {
          this.repository.initializeEmptyDocument({
            boardId: board.id,
            documentKey: MANIFEST_DOCUMENT_KEY,
            generation: board.generation,
            snapshot: Y.encodeStateAsUpdate(manifest),
            stateVector: Y.encodeStateVector(manifest),
          });
          this.repository.ensureDocument({
            boardId: board.id,
            documentKey: `page:${pageId}`,
            generation: board.generation,
            snapshot: Y.encodeStateAsUpdate(page),
            stateVector: Y.encodeStateVector(page),
          });
        } finally {
          manifest.destroy();
          page.destroy();
        }
      } else {
        const manifest = applyPersistedDocument(
          this.repository,
          board.id,
          MANIFEST_DOCUMENT_KEY,
          board.generation,
        );
        try {
          pageId = readDefaultPageId(manifest);
        } finally {
          manifest.destroy();
        }
        this.repository.loadDocument({
          boardId: board.id,
          documentKey: `page:${pageId}`,
          generation: board.generation,
        });
      }
      return { board, pageId, created };
    }).immediate();

    if (bootstrapped.created) {
      this.evictBoardDocuments(
        bootstrapped.board.id,
        bootstrapped.board.generation,
      );
    }
    const identity = guestBoardIdentity(
      this.context.config.authLookupKey,
      request.shareKey,
      request.deviceId,
    );
    const profile = request.profile ?? defaultCollaborationProfile(
      identity.userId,
      identity.displayName,
    );
    const issued = this.issueBoardTicket({
      boardId: bootstrapped.board.id,
      lessonId: `guest-room:${roomLookup.room.id}`,
      userId: identity.userId,
      sessionHash: identity.sessionHash,
      generation: bootstrapped.board.generation,
      minSchemaVersion: request.minSchemaVersion,
      maxSchemaVersion: request.maxSchemaVersion,
      capabilities,
      profile,
    });
    const defaultPageDocKey = `page:${bootstrapped.pageId}`;
    return {
      ticket: issued.ticket,
      expiresAt: issued.expiresAt,
      boardId: bootstrapped.board.id,
      generation: bootstrapped.board.generation,
      protocolVersion: bootstrapped.board.protocolVersion,
      schemaVersion: bootstrapped.board.schemaVersion,
      capabilities,
      permissions: BoardPermission.READ | BoardPermission.EDIT,
      manifestDocKey: MANIFEST_DOCUMENT_KEY,
      defaultPageId: bootstrapped.pageId,
      defaultPageDocKey,
      docKeys: {
        manifest: MANIFEST_DOCUMENT_KEY,
        defaultPage: defaultPageDocKey,
      },
      websocketPath: BOARD_SYNC_WEBSOCKET_PATH,
    };
  }

  authenticate(frame: AuthFrame): AuthenticatedBoardSync {
    let scope: BoardSyncTicketScope;
    try {
      scope = this.tickets.consume(frame.ticket);
    } catch (error) {
      if (error instanceof BoardSyncTicketError) {
        fail("INVALID_TICKET", error.message, error);
      }
      throw error;
    }
    if (
      frame.generation !== scope.generation
      || frame.minSchemaVersion !== scope.minSchemaVersion
      || frame.maxSchemaVersion !== scope.maxSchemaVersion
      || frame.capabilities !== scope.capabilities
    ) {
      fail("INVALID_TICKET", "AUTH fields do not match the ticket scope");
    }
    const access = withCollaborationProfile(this.requireBoardAccess({
      boardId: scope.boardId,
      generation: scope.generation,
      userId: scope.userId,
      sessionHash: scope.sessionHash,
    }), scope.profile);
    if (
      access.schemaVersion < frame.minSchemaVersion
      || access.schemaVersion > frame.maxSchemaVersion
    ) {
      fail("SCHEMA_MISMATCH", "Board schema is outside the authenticated range");
    }
    return { access, capabilities: scope.capabilities };
  }

  reauthorize(
    identity: BoardSyncConnectionIdentity,
    requireEdit = false,
  ): BoardSyncAccess {
    const access = withCollaborationProfile(
      this.requireBoardAccess(identity),
      identity.profile,
    );
    if (requireEdit && (access.permissions & BoardPermission.EDIT) === 0) {
      fail("READ_ONLY", "Board is read-only");
    }
    return access;
  }

  getAuthorizedMetrics(
    auth: AuthContext,
    lessonId: string,
  ): AuthorizedBoardMetrics {
    this.requireLessonAccess(auth.user.id, auth.sessionHash, lessonId);
    const board = this.repository.getBoardForLesson(lessonId);
    if (!board) fail("NOT_FOUND", "Board was not found");
    this.assertUsableBoard(
      board,
      BOARD_CORE_SCHEMA_VERSION,
      BOARD_CORE_SCHEMA_VERSION,
    );
    return {
      board,
      metrics: this.repository.getBoardMetrics({
        boardId: board.id,
        generation: board.generation,
      }),
    };
  }

  missingUpdate(
    access: BoardSyncAccess,
    documentKey: string,
    stateVector: Uint8Array,
  ): Uint8Array {
    const updates = this.missingUpdates(access, documentKey, stateVector);
    return updates.length === 0
      ? Uint8Array.of(0, 0)
      : Y.mergeUpdates([...updates]);
  }

  missingUpdates(
    access: BoardSyncAccess,
    documentKey: string,
    stateVector: Uint8Array,
  ): readonly Uint8Array[] {
    validateBoardDocumentKey(documentKey);
    validateBoardStateVector(stateVector);
    this.getDocument(
      access.boardId,
      documentKey,
      access.generation,
    );
    try {
      const loaded = this.repository.loadDocument({
        boardId: access.boardId,
        documentKey,
        generation: access.generation,
      });
      const persisted = [
        loaded.document.snapshot,
        ...loaded.updates.map((record) => record.update),
      ];
      const updates: Uint8Array[] = [];
      for (const source of persisted) {
        if (source.byteLength === 0) continue;
        const missing = Y.diffUpdate(source, stateVector);
        if (!hasUpdateContent(missing)) continue;
        if (missing.byteLength > BOARD_PROTOCOL_LIMITS.maxUpdateBytes) {
          fail(
            "CORRUPT_DOCUMENT",
            `Persisted Board update for '${documentKey}' exceeds the sync limit`,
          );
        }
        updates.push(missing);
      }
      return updates;
    } catch (error) {
      if (error instanceof BoardSyncServiceError) throw error;
      fail("INVALID_UPDATE", "Cannot compute state-vector diffs", error);
    } finally {
      this.evictLeastRecentlyUsed();
    }
  }

  documentStateVector(
    access: BoardSyncAccess,
    documentKey: string,
  ): Uint8Array {
    validateBoardDocumentKey(documentKey);
    const doc = this.getDocument(
      access.boardId,
      documentKey,
      access.generation,
    );
    try {
      const stateVector = Y.encodeStateVector(doc);
      if (stateVector.byteLength > BOARD_PROTOCOL_LIMITS.maxStateVectorBytes) {
        fail(
          "CORRUPT_DOCUMENT",
          `Board state vector for '${documentKey}' exceeds the protocol limit`,
        );
      }
      return stateVector;
    } finally {
      this.evictLeastRecentlyUsed();
    }
  }

  appendUpdate(
    access: BoardSyncAccess,
    clientId: string,
    documentKey: string,
    messageId: string,
    update: Uint8Array,
  ): AppendBoardUpdateResult {
    validateBoardDocumentKey(documentKey);
    try {
      const receipt = this.repository.findUpdateReceipt({
        boardId: access.boardId,
        documentKey,
        generation: access.generation,
        messageId,
        actorId: access.userId,
        clientId,
        update,
      });
      if (receipt) return receipt;
    } catch (error) {
      failRepositoryUpdate(error);
    }
    try {
      // Parse before persistence. The authoritative document is not mutated yet.
      Y.decodeUpdate(update);
    } catch (error) {
      fail("INVALID_UPDATE", "UPDATE is not a valid Yjs update", error);
    }
    const doc = this.getDocument(
      access.boardId,
      documentKey,
      access.generation,
    );
    const key = this.documentIdentity(
      access.boardId,
      access.generation,
      documentKey,
    );
    const cached = this.documents.get(key);
    if (!cached || cached.doc !== doc) {
      fail("STORAGE_ERROR", "Board document cache was evicted during UPDATE");
    }
    let addsInformation = false;
    try {
      addsInformation = applyAndValidateBoardUpdate(
        cached.validationDoc,
        documentKey,
        update,
      );
    } catch (error) {
      this.resetValidationDocument(key, cached, documentKey);
      if (
        error instanceof BoardDocumentSchemaError
        && error.code === "CAUSAL_GAP"
      ) {
        fail(
          "CAUSAL_GAP",
          "UPDATE is waiting for a causal predecessor",
          error,
        );
      }
      fail(
        "INVALID_UPDATE",
        "UPDATE would violate the Board document schema",
        error,
      );
    }
    if (!addsInformation) {
      fail("NO_NEW_INFORMATION", "UPDATE adds no new Board state");
    }
    let appended: AppendBoardUpdateResult;
    try {
      appended = this.repository.appendUpdate({
        boardId: access.boardId,
        documentKey,
        generation: access.generation,
        messageId,
        actorId: access.userId,
        clientId,
        update,
        commitActivity: access.roomResourceId
          ? () => this.context.guestRooms.recordResourceMutation(
              access.lessonId.slice("guest-room:".length),
              access.roomResourceId!,
            )
          : undefined,
      });
    } catch (error) {
      this.resetValidationDocument(key, cached, documentKey);
      failRepositoryUpdate(error);
    }

    try {
      // This happens only after appendUpdate has committed.
      Y.applyUpdate(doc, update);
    } catch (error) {
      this.evictCachedDocument(key);
      fail(
        "STORAGE_ERROR",
        "Durable update could not be applied to the active document cache",
        error,
      );
    }
    if (!appended.duplicate) {
      if (cached?.doc === doc) {
        const updateEstimate =
          estimatedDocumentMemoryBytes(update.byteLength);
        const nextEstimate = Math.min(
          Number.MAX_SAFE_INTEGER,
          cached.estimatedBytes + updateEstimate,
        );
        const addedEstimate = nextEstimate - cached.estimatedBytes;
        cached.estimatedBytes = nextEstimate;
        cached.lastUsed = Date.now();
        this.cachedDocumentBytes = Math.min(
          Number.MAX_SAFE_INTEGER,
          this.cachedDocumentBytes + addedEstimate,
        );
      }
    }
    this.evictLeastRecentlyUsed();
    if (!appended.duplicate) {
      this.compaction.schedule({
        boardId: access.boardId,
        documentKey,
        generation: access.generation,
      });
    }
    return appended;
  }

  documentIdentity(
    boardId: string,
    generation: number,
    documentKey: string,
  ): string {
    return `${boardId}\0${generation}\0${documentKey}`;
  }

  close(): void {
    this.compaction.close();
    this.tickets.clear();
    for (const cached of this.documents.values()) {
      cached.doc.destroy();
      cached.validationDoc.destroy();
    }
    this.documents.clear();
    this.cachedDocumentBytes = 0;
  }

  cacheMetrics(): {
    readonly documentCount: number;
    readonly estimatedBytes: number;
    readonly maximumBytes: number;
  } {
    return {
      documentCount: this.documents.size,
      estimatedBytes: this.cachedDocumentBytes,
      maximumBytes: this.maxCachedDocumentBytes,
    };
  }

  private requireActor(userId: string, sessionHash: string): ActorRow {
    const actor = this.context.db.prepare(`
      SELECT
        actor.id, actor.role, actor.status, actor.display_name,
        session.session_hash
      FROM users actor
      JOIN sessions session
        ON session.user_id = actor.id
        AND session.session_hash = ?
        AND session.expires_at > ?
      WHERE actor.id = ? AND actor.status = 'active'
    `).get(sessionHash, nowIso(), userId) as ActorRow | undefined;
    if (!actor) fail("SESSION_REVOKED", "Session is no longer active");
    if (actor.role === "admin") {
      fail("ACCESS_REVOKED", "Administrators are not Board participants");
    }
    return actor;
  }

  private requireLessonAccess(
    userId: string,
    sessionHash: string,
    lessonId: string,
  ): LessonAccessRow {
    const actor = this.requireActor(userId, sessionHash);
    const lesson = this.context.db.prepare(`
      SELECT id, tutor_id, student_id, status
      FROM lessons
      WHERE id = ? AND (
        (? = 'tutor' AND tutor_id = ?)
        OR (? = 'student' AND student_id = ?)
      )
    `).get(
      lessonId,
      actor.role,
      actor.id,
      actor.role,
      actor.id,
    ) as LessonAccessRow | undefined;
    if (!lesson) fail("NOT_FOUND", "Lesson was not found");
    return lesson;
  }

  private requireBoardAccess(
    identity: BoardSyncConnectionIdentity,
  ): BoardSyncAccess {
    if (identity.userId.startsWith(GUEST_BOARD_USER_ID_PREFIX)) {
      return this.requireGuestBoardAccess(identity);
    }
    const actor = this.requireActor(identity.userId, identity.sessionHash);
    const row = this.context.db.prepare(`
      SELECT
        board.id,
        board.lesson_id,
        board.room_resource_id,
        board.engine,
        board.lifecycle,
        board.generation,
        board.protocol_version,
        board.schema_version,
        lesson.status AS lesson_status,
        lesson.tutor_id,
        lesson.student_id
      FROM boards board
      JOIN lessons lesson ON lesson.id = board.lesson_id
      WHERE board.id = ?
    `).get(identity.boardId) as BoardAccessRow | undefined;
    if (!row) fail("BOARD_GONE", "Board no longer exists");
    if (row.lifecycle === "tombstoned") {
      fail("BOARD_GONE", "Board is tombstoned");
    }
    if (row.engine !== "v2") {
      fail("ACCESS_REVOKED", "Board v2 is no longer enabled");
    }
    if (row.generation !== identity.generation) {
      fail("ACCESS_REVOKED", "Board generation changed");
    }
    if (row.protocol_version !== BOARD_PROTOCOL_VERSION) {
      fail("PROTOCOL_MISMATCH", "Board protocol version changed");
    }
    const isMember =
      (actor.role === "tutor" && row.tutor_id === actor.id)
      || (actor.role === "student" && row.student_id === actor.id);
    if (!isMember) fail("ACCESS_REVOKED", "Board membership was revoked");

    return {
      boardId: row.id,
      lessonId: row.lesson_id!,
      roomResourceId: null,
      generation: row.generation,
      protocolVersion: row.protocol_version,
      schemaVersion: row.schema_version,
      lifecycle: row.lifecycle,
      lessonStatus: row.lesson_status,
      permissions: permissionsForLesson(row.lesson_status),
      userId: actor.id,
      sessionHash: actor.session_hash,
      displayName: actor.display_name,
      color: defaultCollaborationProfile(actor.id, actor.display_name).color,
      role: actor.role as Exclude<Role, "admin">,
    };
  }

  private requireGuestBoardAccess(
    identity: BoardSyncConnectionIdentity,
  ): BoardSyncAccess {
    const row = this.context.db.prepare(`
      SELECT
        board.id,
        board.room_resource_id,
        board.engine,
        board.lifecycle,
        board.generation,
        board.protocol_version,
        board.schema_version,
        room.id AS room_id,
        room.share_key,
        room.expires_at
      FROM boards board
      JOIN guest_room_resources resource
        ON resource.id = board.room_resource_id AND resource.kind = 'board'
      JOIN guest_rooms room ON room.id = resource.room_id
      WHERE board.id = ?
    `).get(identity.boardId) as GuestBoardAccessRow | undefined;
    if (!row || row.lifecycle === "tombstoned") {
      fail("BOARD_GONE", "Guest Board no longer exists");
    }
    if (!this.context.guestRooms.isResourceActive(
      row.room_id,
      row.room_resource_id,
      "board",
    )) {
      this.context.guestRooms.cleanupExpired();
      fail("BOARD_GONE", "Guest room has expired");
    }
    if (row.engine !== "v2") {
      fail("ACCESS_REVOKED", "Board v2 is no longer enabled");
    }
    if (row.generation !== identity.generation) {
      fail("ACCESS_REVOKED", "Board generation changed");
    }
    if (row.protocol_version !== BOARD_PROTOCOL_VERSION) {
      fail("PROTOCOL_MISMATCH", "Board protocol version changed");
    }
    const expectedSession = guestBoardSessionHash(
      this.context.config.authLookupKey,
      row.share_key,
      identity.userId,
    );
    if (!safeEqual(expectedSession, identity.sessionHash)) {
      fail("SESSION_REVOKED", "Guest Board session is invalid");
    }
    return {
      boardId: row.id,
      lessonId: `guest-room:${row.room_id}`,
      roomResourceId: row.room_resource_id,
      generation: row.generation,
      protocolVersion: row.protocol_version,
      schemaVersion: row.schema_version,
      lifecycle: row.lifecycle,
      lessonStatus: "active",
      permissions: BoardPermission.READ | BoardPermission.EDIT,
      userId: identity.userId,
      sessionHash: identity.sessionHash,
      displayName: `Гость ${identity.userId.slice(-4)}`,
      color: defaultCollaborationProfile(identity.userId, "").color,
      role: "guest",
    };
  }

  private assertUsableBoard(
    board: BoardRecord,
    minSchemaVersion: number,
    maxSchemaVersion: number,
  ): void {
    if (board.lifecycle === "tombstoned") {
      fail("BOARD_GONE", "Board is tombstoned");
    }
    if (board.engine !== "v2") {
      fail("BOARD_NOT_V2", "Board v2 is not enabled for this lesson");
    }
    if (board.protocolVersion !== BOARD_PROTOCOL_VERSION) {
      fail("PROTOCOL_MISMATCH", "Board uses an unsupported protocol version");
    }
    if (
      board.schemaVersion < minSchemaVersion
      || board.schemaVersion > maxSchemaVersion
    ) {
      fail("SCHEMA_MISMATCH", "Board schema is outside the requested range");
    }
  }

  private getDocument(
    boardId: string,
    documentKey: string,
    generation: number,
  ): Y.Doc {
    const key = this.documentIdentity(boardId, generation, documentKey);
    const cached = this.documents.get(key);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached.doc;
    }
    let doc: Y.Doc | undefined;
    let validationDoc: Y.Doc | undefined;
    try {
      doc = applyPersistedDocument(
        this.repository,
        boardId,
        documentKey,
        generation,
      );
      validationDoc = createBoardDocumentValidationShadow(doc, documentKey);
    } catch (error) {
      doc?.destroy();
      validationDoc?.destroy();
      if (error instanceof BoardSyncServiceError) throw error;
      if (error instanceof BoardRepositoryError) {
        if (error.code === "BOARD_GONE") fail("BOARD_GONE", error.message, error);
        if (error.code === "GENERATION_MISMATCH") {
          fail("ACCESS_REVOKED", error.message, error);
        }
        if (error.code === "NOT_FOUND") fail("NOT_FOUND", error.message, error);
      }
      fail("CORRUPT_DOCUMENT", "Board document cannot be loaded", error);
    }
    const estimatedBytes = estimatedDocumentMemoryBytes(
      Y.encodeStateAsUpdate(doc).byteLength,
    );
    this.documents.set(key, {
      doc,
      validationDoc,
      lastUsed: Date.now(),
      estimatedBytes,
    });
    this.cachedDocumentBytes += estimatedBytes;
    this.evictLeastRecentlyUsed(key);
    return doc;
  }

  private evictLeastRecentlyUsed(protectedKey?: string): void {
    while (
      this.documents.size > MAX_CACHED_DOCUMENTS
      || this.cachedDocumentBytes > this.maxCachedDocumentBytes
    ) {
      let oldestKey: string | undefined;
      let oldestUse = Number.POSITIVE_INFINITY;
      for (const [key, cached] of this.documents) {
        if (key === protectedKey) continue;
        if (cached.lastUsed < oldestUse) {
          oldestKey = key;
          oldestUse = cached.lastUsed;
        }
      }
      if (!oldestKey) return;
      this.evictCachedDocument(oldestKey);
    }
  }

  private evictBoardDocuments(boardId: string, generation: number): void {
    const prefix = `${boardId}\0${generation}\0`;
    for (const key of this.documents.keys()) {
      if (!key.startsWith(prefix)) continue;
      this.evictCachedDocument(key);
    }
  }

  private resetValidationDocument(
    key: string,
    cached: CachedDocument,
    documentKey: string,
  ): void {
    try {
      const replacement = createBoardDocumentValidationShadow(
        cached.doc,
        documentKey,
      );
      cached.validationDoc.destroy();
      cached.validationDoc = replacement;
    } catch (error) {
      this.evictCachedDocument(key);
      fail(
        "CORRUPT_DOCUMENT",
        "Board validation shadow could not be restored",
        error,
      );
    }
  }

  private evictCachedDocument(key: string): void {
    const cached = this.documents.get(key);
    if (!cached) return;
    cached.doc.destroy();
    cached.validationDoc.destroy();
    this.cachedDocumentBytes = Math.max(
      0,
      this.cachedDocumentBytes - cached.estimatedBytes,
    );
    this.documents.delete(key);
  }
}
