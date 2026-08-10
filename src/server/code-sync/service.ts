import { createHash, randomUUID } from "node:crypto";
import * as decoding from "lib0/decoding";
import type {
  CodeParticipantIdentity,
  CodeSyncHandshakeAuth,
} from "../../code/protocol/index.js";
import type { GuestRoomService } from "../guestRooms.js";
import {
  CodeSyncRepository,
  CodeSyncRepositoryError,
  type AppendCodeUpdateResult,
  type CodeDocumentSync,
} from "./repository.js";

export interface AuthenticatedCodeSync {
  readonly shareId: string;
  readonly deviceId: string;
  readonly roomId: string;
  readonly resourceId: string;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly participant: CodeParticipantIdentity;
}

const GUEST_COLORS = [
  "#2563eb",
  "#16825d",
  "#d33f49",
  "#d97706",
  "#7c3aed",
  "#0891b2",
] as const;

function createParticipantIdentity(): CodeParticipantIdentity {
  const participantId = randomUUID();
  const colorIndex = createHash("sha256")
    .update(participantId)
    .digest()[0] % GUEST_COLORS.length;
  return {
    participantId,
    displayName: `Гость ${participantId.slice(0, 4).toUpperCase()}`,
    color: GUEST_COLORS[colorIndex],
  };
}

export class CodeSyncServiceError extends Error {
  constructor(
    public readonly code:
      | "EXPIRED"
      | "NOT_FOUND"
      | "INVALID_UPDATE"
      | "STORAGE_ERROR",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodeSyncServiceError";
  }
}

function failRepository(error: unknown): never {
  if (error instanceof CodeSyncRepositoryError) {
    if (error.code === "RESOURCE_INACTIVE") {
      throw new CodeSyncServiceError("EXPIRED", error.message, {
        cause: error,
      });
    }
    if (error.code === "NOT_FOUND") {
      throw new CodeSyncServiceError("NOT_FOUND", error.message, {
        cause: error,
      });
    }
    if (
      error.code === "INVALID_ARGUMENT"
      || error.code === "INVALID_UPDATE"
      || error.code === "IDEMPOTENCY_CONFLICT"
    ) {
      throw new CodeSyncServiceError("INVALID_UPDATE", error.message, {
        cause: error,
      });
    }
    throw new CodeSyncServiceError("STORAGE_ERROR", error.message, {
      cause: error,
    });
  }
  throw new CodeSyncServiceError(
    "STORAGE_ERROR",
    "Code sync storage failed",
    { cause: error },
  );
}

export function validateCodeStateVector(stateVector: Uint8Array): void {
  try {
    const decoder = decoding.createDecoder(stateVector);
    const clientCount = decoding.readVarUint(decoder);
    if (clientCount > Math.floor((stateVector.byteLength - decoder.pos) / 2)) {
      throw new Error("invalid client count");
    }
    const clients = new Set<number>();
    for (let index = 0; index < clientCount; index += 1) {
      const client = decoding.readVarUint(decoder);
      decoding.readVarUint(decoder);
      if (clients.has(client)) throw new Error("duplicate client ID");
      clients.add(client);
    }
    if (decoding.hasContent(decoder)) throw new Error("trailing data");
  } catch (error) {
    throw new CodeSyncServiceError(
      "INVALID_UPDATE",
      "Code sync state vector is invalid",
      { cause: error },
    );
  }
}

export class CodeSyncService {
  constructor(
    private readonly repository: CodeSyncRepository,
    private readonly guestRooms: GuestRoomService,
  ) {}

  authenticate(auth: CodeSyncHandshakeAuth): AuthenticatedCodeSync {
    const access = this.resolveAccess(auth.shareId);
    let workspace;
    try {
      workspace = this.repository.ensureWorkspace(access.resourceId);
    } catch (error) {
      failRepository(error);
    }
    return {
      shareId: auth.shareId,
      deviceId: auth.deviceId,
      roomId: access.roomId,
      resourceId: access.resourceId,
      workspaceId: workspace.id,
      documentId: workspace.documentId,
      participant: createParticipantIdentity(),
    };
  }

  reauthorize(session: AuthenticatedCodeSync): void {
    const access = this.resolveAccess(session.shareId);
    if (
      access.roomId !== session.roomId
      || access.resourceId !== session.resourceId
    ) {
      throw new CodeSyncServiceError(
        "NOT_FOUND",
        "Guest Code workspace identity changed",
      );
    }
    const workspace = this.repository.workspaceForResource(access.resourceId);
    if (
      !workspace
      || workspace.id !== session.workspaceId
      || workspace.documentId !== session.documentId
    ) {
      throw new CodeSyncServiceError(
        "NOT_FOUND",
        "Guest Code workspace was not found",
      );
    }
  }

  syncStep1(
    session: AuthenticatedCodeSync,
    stateVector: Uint8Array,
  ): CodeDocumentSync {
    this.reauthorize(session);
    validateCodeStateVector(stateVector);
    try {
      return this.repository.missingUpdates(session.workspaceId, stateVector);
    } catch (error) {
      failRepository(error);
    }
  }

  appendUpdate(
    session: AuthenticatedCodeSync,
    updateId: string,
    update: Uint8Array,
  ): AppendCodeUpdateResult {
    this.reauthorize(session);
    let result: AppendCodeUpdateResult;
    try {
      result = this.repository.appendUpdate({
        workspaceId: session.workspaceId,
        deviceId: session.deviceId,
        updateId,
        update,
        commitActivity: () => this.guestRooms.recordResourceMutation(
          session.roomId,
          session.resourceId,
        ),
      });
    } catch (error) {
      failRepository(error);
    }
    return result;
  }

  authorizeAwareness(session: AuthenticatedCodeSync): void {
    this.reauthorize(session);
  }

  private resolveAccess(shareId: string): {
    readonly roomId: string;
    readonly resourceId: string;
  } {
    const lookup = this.guestRooms.lookup(shareId);
    if (lookup.status === "expired") {
      throw new CodeSyncServiceError("EXPIRED", "Guest room has expired");
    }
    if (lookup.status !== "active") {
      throw new CodeSyncServiceError("NOT_FOUND", "Guest room was not found");
    }
    const resource = lookup.room.resources.find((candidate) => (
      candidate.kind === "code" && candidate.ordinal === 1
    ));
    if (!resource) {
      throw new CodeSyncServiceError(
        "NOT_FOUND",
        "Guest room has no Code workspace",
      );
    }
    return { roomId: lookup.room.id, resourceId: resource.id };
  }
}
