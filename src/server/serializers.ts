import type { AuthUser, StoredUserRow } from "./types.js";
import { toAuthUser } from "./security.js";

export function serializeUser(row: StoredUserRow): AuthUser {
  return toAuthUser(row);
}

export function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function serializeStudent(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    displayName: row.display_name,
    loginName: row.login_name,
    status: row.status,
    note: row.note ?? "",
    nextLessonAt: row.next_lesson_at ?? null,
    lastLessonAt: row.last_lesson_at ?? null,
    pendingAssignments: Number(row.pending_assignments ?? 0),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at ?? null,
  };
}

export function serializeTutor(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    displayName: row.display_name,
    loginName: row.login_name,
    status: row.status,
    studentCount: Number(row.student_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? null,
  };
}

export function serializeLesson(row: Record<string, unknown>, includeState = false, includeNotes = true): Record<string, unknown> {
  const lesson: Record<string, unknown> = {
    id: row.id,
    title: row.title,
    tutorId: row.tutor_id,
    studentId: row.student_id,
    studentName: row.student_name,
    scheduledAt: row.scheduled_at,
    durationMinutes: row.duration_minutes,
    status: row.status,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includeNotes) lesson.notes = row.notes ?? "";
  if (includeState) {
    lesson.boardState = parseJson(row.board_state as string | null, {});
    lesson.codeState = parseJson(row.code_state as string | null, {});
    lesson.boardRevision = row.board_revision;
    lesson.codeRevision = row.code_revision;
  }
  return lesson;
}

export function serializeMaterial(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    tutorId: row.tutor_id,
    title: row.title,
    kind: row.kind,
    body: row.body ?? undefined,
    url: row.url ?? undefined,
    tags: parseJson(row.tags_json as string | null, []),
    fileName: row.original_file_name ?? undefined,
    mimeType: row.mime_type ?? undefined,
    fileSize: row.file_size ?? undefined,
    studentIds: parseJson(row.student_ids_json as string | null, []),
    progressStatus: row.progress_status ?? undefined,
    progressLessonId: row.progress_lesson_id ?? undefined,
    progressUpdatedAt: row.progress_updated_at ?? undefined,
    position: row.position ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeAssignment(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    tutorId: row.tutor_id,
    studentId: row.student_id,
    studentName: row.student_name,
    title: row.title,
    description: row.description,
    dueAt: row.due_at ?? null,
    status: row.status,
    answer: row.answer ?? null,
    feedback: row.feedback ?? null,
    materialIds: parseJson(row.material_ids_json as string | null, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at ?? null,
    reviewedAt: row.reviewed_at ?? null,
  };
}
