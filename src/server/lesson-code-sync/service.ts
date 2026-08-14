import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  CodeParticipantIdentity,
} from "../../code/protocol/index.js";
import {
  COLLABORATION_PROFILE_COLORS,
  type CollaborationProfile,
} from "../../shared/collaborationProfile.js";
import type { AuthContext } from "../types.js";
import {
  CodeSyncRepository,
  CodeSyncRepositoryError,
  type AppendCodeUpdateResult,
  type CodeDocumentSync,
} from "../code-sync/repository.js";
import { validateCodeStateVector } from "../code-sync/service.js";

export interface LessonCodeHandshakeAuth {
  readonly lessonId: string;
  readonly deviceId: string;
  readonly profile?: CollaborationProfile;
}

export interface AuthenticatedLessonCodeSync {
  readonly lessonId: string;
  readonly deviceId: string;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly userId: string;
  readonly sessionHash: string;
  participant: CodeParticipantIdentity;
}

export type LessonCodeAccess = "read-write" | "read-only";

export class LessonCodeSyncServiceError extends Error {
  constructor(
    public readonly code:
      | "UNAUTHORIZED"
      | "NOT_FOUND"
      | "READ_ONLY"
      | "INVALID_UPDATE"
      | "STORAGE_ERROR",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LessonCodeSyncServiceError";
  }
}

function failRepository(error: unknown): never {
  if (error instanceof CodeSyncRepositoryError) {
    if (error.code === "NOT_FOUND") {
      throw new LessonCodeSyncServiceError("NOT_FOUND", error.message, {
        cause: error,
      });
    }
    if (
      error.code === "INVALID_ARGUMENT"
      || error.code === "INVALID_UPDATE"
      || error.code === "IDEMPOTENCY_CONFLICT"
    ) {
      throw new LessonCodeSyncServiceError("INVALID_UPDATE", error.message, {
        cause: error,
      });
    }
    throw new LessonCodeSyncServiceError("STORAGE_ERROR", error.message, {
      cause: error,
    });
  }
  throw new LessonCodeSyncServiceError(
    "STORAGE_ERROR",
    "Lesson Code sync storage failed",
    { cause: error },
  );
}

function participant(
  auth: AuthContext,
  requestedProfile?: CollaborationProfile,
): CodeParticipantIdentity {
  const participantId = randomUUID();
  const colorIndex = createHash("sha256")
    .update(auth.user.id)
    .digest()[0] % COLLABORATION_PROFILE_COLORS.length;
  const profile = requestedProfile ?? {
    displayName: auth.user.displayName,
    color: COLLABORATION_PROFILE_COLORS[colorIndex],
  };
  return {
    participantId,
    displayName: profile.displayName,
    color: profile.color,
  };
}

interface AccessRow {
  status: string;
}

export class LessonCodeSyncService {
  constructor(
    private readonly db: Database.Database,
    private readonly repository: CodeSyncRepository,
  ) {}

  authenticate(
    auth: AuthContext,
    handshake: LessonCodeHandshakeAuth,
  ): AuthenticatedLessonCodeSync {
    this.resolveAccess(
      auth.user.id,
      auth.sessionHash,
      handshake.lessonId,
    );
    let workspace;
    try {
      workspace = this.repository.ensureLessonWorkspace(handshake.lessonId);
    } catch (error) {
      failRepository(error);
    }
    return {
      lessonId: handshake.lessonId,
      deviceId: handshake.deviceId,
      workspaceId: workspace.id,
      documentId: workspace.documentId,
      userId: auth.user.id,
      sessionHash: auth.sessionHash,
      participant: participant(auth, handshake.profile),
    };
  }

  reauthorize(session: AuthenticatedLessonCodeSync): LessonCodeAccess {
    const row = this.resolveAccess(
      session.userId,
      session.sessionHash,
      session.lessonId,
    );
    const workspace = this.repository.workspaceForLesson(session.lessonId);
    if (
      !workspace
      || workspace.id !== session.workspaceId
      || workspace.documentId !== session.documentId
    ) {
      throw new LessonCodeSyncServiceError(
        "NOT_FOUND",
        "Lesson Code workspace was not found",
      );
    }
    return row.status === "scheduled" || row.status === "active"
      ? "read-write"
      : "read-only";
  }

  updateProfile(
    session: AuthenticatedLessonCodeSync,
    profile: CollaborationProfile,
  ): CodeParticipantIdentity {
    this.reauthorize(session);
    session.participant = {
      participantId: session.participant.participantId,
      displayName: profile.displayName,
      color: profile.color,
    };
    return session.participant;
  }

  requireMutable(session: AuthenticatedLessonCodeSync): void {
    if (this.reauthorize(session) !== "read-write") {
      throw new LessonCodeSyncServiceError(
        "READ_ONLY",
        "Lesson Code workspace is read-only",
      );
    }
  }

  syncStep1(
    session: AuthenticatedLessonCodeSync,
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
    session: AuthenticatedLessonCodeSync,
    updateId: string,
    update: Uint8Array,
  ): AppendCodeUpdateResult {
    this.requireMutable(session);
    try {
      return this.repository.appendUpdate({
        workspaceId: session.workspaceId,
        deviceId: session.deviceId,
        updateId,
        update,
      });
    } catch (error) {
      failRepository(error);
    }
  }

  authorizeAwareness(session: AuthenticatedLessonCodeSync): void {
    this.reauthorize(session);
  }

  private resolveAccess(
    userId: string,
    sessionHash: string,
    lessonId: string,
  ): AccessRow {
    const row = this.db.prepare(`
      SELECT lesson.status
      FROM lessons lesson
      JOIN users actor ON actor.id = ? AND actor.status = 'active'
      JOIN sessions session
        ON session.session_hash = ?
        AND session.user_id = actor.id
        AND session.expires_at > ?
      WHERE lesson.id = ?
        AND actor.role IN ('tutor', 'student')
        AND (
          (actor.role = 'tutor' AND lesson.tutor_id = actor.id)
          OR (actor.role = 'student' AND lesson.student_id = actor.id)
        )
    `).get(
      userId,
      sessionHash,
      new Date().toISOString(),
      lessonId,
    ) as AccessRow | undefined;
    if (!row) {
      throw new LessonCodeSyncServiceError(
        "UNAUTHORIZED",
        "Lesson Code access was revoked",
      );
    }
    return row;
  }
}
