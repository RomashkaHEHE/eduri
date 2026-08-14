import { Router } from "express";
import { createHash } from "node:crypto";
import { AccessToken, TrackSource } from "livekit-server-sdk";
import { z } from "zod";
import type { AppContext, LessonStatus } from "../types.js";
import { asOptionalIso, currentAuth, HttpError, pagination, parseBody, requireAuth, requireCsrf } from "../http.js";
import { newId, nowIso, randomToken } from "../security.js";
import { serializeLesson, serializeMaterial } from "../serializers.js";
import { writeAudit } from "../audit.js";
import {
  deleteLessonCallRoom,
  ensureLiveKitCallRoom,
  isLiveKitNotFoundError,
  lessonCallRoomName,
  liveKitParticipantIdentity,
} from "../livekit.js";
import { enqueueLessonRoomRevocation } from "../livekit-revocation.js";
import { collaborationProfileSchema } from "../collaborationProfile.js";
import {
  COLLABORATION_PROFILE_COLORS,
  normalizeCollaborationProfile,
  type CollaborationProfile,
} from "../../shared/collaborationProfile.js";

const isoDate = z.string().refine((value) => Number.isFinite(new Date(value).valueOf()), "Некорректная дата");
const createLessonSchema = z.object({
  studentId: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  scheduledAt: isoDate,
  durationMinutes: z.coerce.number().int().min(15).max(480).default(60),
});

const updateLessonSchema = z.object({
  studentId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  scheduledAt: isoDate.optional(),
  durationMinutes: z.coerce.number().int().min(15).max(480).optional(),
  status: z.enum(["scheduled", "active", "completed", "cancelled"]).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "Нет изменений" });

const CALL_TOKEN_TTL_SECONDS = 15 * 60;
const callTokenSchema = z.object({
  profile: collaborationProfileSchema.optional(),
}).strict();
const callProfileSchema = z.object({
  profile: collaborationProfileSchema,
}).strict();

function lessonCallProfile(
  userId: string,
  displayName: string,
  requested?: CollaborationProfile,
): CollaborationProfile {
  if (requested) return requested;
  const digest = createHash("sha256").update(userId).digest();
  return {
    displayName,
    color: COLLABORATION_PROFILE_COLORS[
      digest[0] % COLLABORATION_PROFILE_COLORS.length
    ],
  };
}

function lessonRow(context: AppContext, lessonId: string): Record<string, unknown> | undefined {
  return context.db.prepare(`
    SELECT l.*, s.display_name AS student_name
    FROM lessons l JOIN users s ON s.id = l.student_id
    WHERE l.id = ?
  `).get(lessonId) as Record<string, unknown> | undefined;
}

function canReadLesson(row: Record<string, unknown>, role: string, userId: string): boolean {
  return (role === "tutor" && row.tutor_id === userId) || (role === "student" && row.student_id === userId);
}

function scheduleLiveKitRevocation(context: AppContext): void {
  void context.runLiveKitRevocationMaintenance?.().catch(() => {
    // The committed outbox is authoritative; a periodic worker will retry.
    console.error("[livekit] durable lesson revocation maintenance deferred");
  });
}

interface CallAuthorizationState {
  account_active: 0 | 1;
  session_active: 0 | 1;
  lesson_active: 0 | 1;
}

function callAuthorizationState(
  context: AppContext,
  input: {
    userId: string;
    role: string;
    sessionHash: string;
    lessonId: string;
    meetingKey: string;
  },
): CallAuthorizationState {
  return context.db.prepare(`
    SELECT
      EXISTS (
        SELECT 1 FROM users
        WHERE id = ? AND role = ? AND status = 'active'
      ) AS account_active,
      EXISTS (
        SELECT 1 FROM sessions
        WHERE session_hash = ? AND user_id = ? AND expires_at > ?
      ) AS session_active,
      EXISTS (
        SELECT 1
        FROM lessons lesson
        JOIN users tutor
          ON tutor.id = lesson.tutor_id
          AND tutor.role = 'tutor'
          AND tutor.status = 'active'
        JOIN users student
          ON student.id = lesson.student_id
          AND student.role = 'student'
          AND student.status = 'active'
        WHERE lesson.id = ? AND lesson.meeting_key = ?
          AND lesson.status IN ('scheduled', 'active')
          AND ((? = 'tutor' AND lesson.tutor_id = ?)
            OR (? = 'student' AND lesson.student_id = ?))
      ) AS lesson_active
  `).get(
    input.userId,
    input.role,
    input.sessionHash,
    input.userId,
    nowIso(),
    input.lessonId,
    input.meetingKey,
    input.role,
    input.userId,
    input.role,
    input.userId,
  ) as CallAuthorizationState;
}

function ownedStudentName(context: AppContext, tutorId: string, studentId: string): string | undefined {
  const row = context.db.prepare(`
    SELECT display_name FROM users WHERE id = ? AND tutor_id = ? AND role = 'student' AND status != 'suspended'
  `).get(studentId, tutorId) as { display_name: string } | undefined;
  return row?.display_name;
}

function lessonMaterials(
  context: AppContext,
  lessonId: string,
  studentId: string,
  requireStudentAccess = false,
): Array<Record<string, unknown>> {
  const rows = context.db.prepare(`
    SELECT m.*, lm.position,
      (SELECT json_group_array(ma2.student_id) FROM material_access ma2 WHERE ma2.material_id = m.id) AS student_ids_json,
      ma.status AS progress_status, ma.lesson_id AS progress_lesson_id, ma.updated_at AS progress_updated_at
    FROM lesson_materials lm
    JOIN materials m ON m.id = lm.material_id
    LEFT JOIN material_access ma ON ma.material_id = m.id AND ma.student_id = ?
    WHERE lm.lesson_id = ? AND (? = 0 OR ma.material_id IS NOT NULL)
    ORDER BY lm.position ASC, lm.added_at ASC
  `).all(studentId, lessonId, requireStudentAccess ? 1 : 0) as Array<Record<string, unknown>>;
  return rows.map(serializeMaterial);
}

function serializeLessonDetail(context: AppContext, row: Record<string, unknown>, includeNotes: boolean): Record<string, unknown> {
  const materials = lessonMaterials(context, row.id as string, row.student_id as string, !includeNotes);
  if (!includeNotes) materials.forEach((material) => delete material.studentIds);
  return {
    ...serializeLesson(row, true, includeNotes),
    materials,
  };
}

export function createLessonsRouter(context: AppContext): Router {
  const router = Router();
  router.use(requireAuth("tutor", "student"), requireCsrf(context));

  router.get("/", (req, res) => {
    const auth = currentAuth(res).user;
    const { limit, offset } = pagination(req, 200);
    const studentId = typeof req.query.studentId === "string" ? req.query.studentId : null;
    const status = typeof req.query.status === "string" && ["scheduled", "active", "completed", "cancelled"].includes(req.query.status)
      ? req.query.status
      : null;
    const from = typeof req.query.from === "string" ? asOptionalIso(req.query.from) : null;
    const to = typeof req.query.to === "string" ? asOptionalIso(req.query.to) : null;
    const rows = context.db.prepare(`
      SELECT l.*, s.display_name AS student_name
      FROM lessons l JOIN users s ON s.id = l.student_id
      WHERE ((? = 'tutor' AND l.tutor_id = ?) OR (? = 'student' AND l.student_id = ?))
        AND (? IS NULL OR l.student_id = ?)
        AND (? IS NULL OR l.status = ?)
        AND (? IS NULL OR l.scheduled_at >= ?)
        AND (? IS NULL OR l.scheduled_at <= ?)
      ORDER BY l.scheduled_at ASC LIMIT ? OFFSET ?
    `).all(
      auth.role, auth.id, auth.role, auth.id,
      studentId, studentId, status, status, from, from, to, to,
      limit, offset,
    ) as Array<Record<string, unknown>>;
    res.json({ lessons: rows.map((row) => serializeLesson(row, false, auth.role === "tutor")) });
  });

  router.post("/", requireAuth("tutor"), (req, res, next) => {
    try {
      const body = parseBody(createLessonSchema, req.body);
      const tutor = currentAuth(res).user;
      const studentName = ownedStudentName(context, tutor.id, body.studentId);
      if (!studentName) throw new HttpError(404, "Ученик не найден");
      const id = newId();
      const now = nowIso();
      context.db.prepare(`
        INSERT INTO lessons (
          id, tutor_id, student_id, title, meeting_key, scheduled_at, duration_minutes, status,
          board_state, code_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)
      `).run(
        id,
        tutor.id,
        body.studentId,
        body.title ?? `Занятие с ${studentName}`,
        randomToken(24),
        new Date(body.scheduledAt).toISOString(),
        body.durationMinutes,
        JSON.stringify({ elements: [], appState: {} }),
        JSON.stringify({ language: "python", value: "" }),
        now,
        now,
      );
      writeAudit(context, req, res, "lesson.created", "lesson", id, { studentId: body.studentId });
      res.status(201).json({ lesson: serializeLessonDetail(context, lessonRow(context, id)!, true) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", (req, res, next) => {
    const auth = currentAuth(res).user;
    const lesson = lessonRow(context, req.params.id);
    if (!lesson || !canReadLesson(lesson, auth.role, auth.id)) return next(new HttpError(404, "Урок не найден"));
    res.json({ lesson: serializeLessonDetail(context, lesson, auth.role === "tutor") });
  });

  router.post("/:id/call-token", async (req, res, next) => {
    try {
      const parsed = parseBody(callTokenSchema, req.body ?? {});
      const authContext = currentAuth(res);
      const auth = authContext.user;
      const lesson = lessonRow(context, req.params.id);
      if (!lesson || !canReadLesson(lesson, auth.role, auth.id)) {
        throw new HttpError(404, "Урок не найден");
      }
      if (lesson.status === "completed" || lesson.status === "cancelled") {
        throw new HttpError(409, "Звонок для этого урока недоступен");
      }

      const { livekitUrl, livekitApiKey, livekitApiSecret } = context.config;
      const liveKitRoomService = context.livekitRoomService;
      if (
        !livekitUrl
        || !livekitApiKey
        || !livekitApiSecret
        || !liveKitRoomService
      ) {
        throw new HttpError(503, "Сервис звонков временно недоступен");
      }

      const roomName = lessonCallRoomName(String(lesson.meeting_key));
      const authorizationInput = {
        userId: auth.id,
        role: auth.role,
        sessionHash: authContext.sessionHash,
        lessonId: String(lesson.id),
        meetingKey: String(lesson.meeting_key),
      };
      const initialAuthorization = callAuthorizationState(
        context,
        authorizationInput,
      );
      if (
        initialAuthorization.account_active !== 1
        || initialAuthorization.session_active !== 1
        || initialAuthorization.lesson_active !== 1
      ) {
        throw new HttpError(403, "Доступ к звонку был отозван");
      }
      try {
        await ensureLiveKitCallRoom(liveKitRoomService, roomName);
      } catch (error) {
        console.error("[livekit] lesson room provisioning failed", {
          roomName,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new HttpError(503, "Сервис звонков временно недоступен");
      }
      const authorization = callAuthorizationState(context, authorizationInput);
      if (
        authorization.account_active !== 1
        || authorization.session_active !== 1
        || authorization.lesson_active !== 1
      ) {
        if (
          authorization.account_active !== 1
          || authorization.lesson_active !== 1
        ) {
          await deleteLessonCallRoom(context, roomName);
        }
        throw new HttpError(403, "Доступ к звонку был отозван");
      }
      const profile = lessonCallProfile(
        auth.id,
        auth.displayName,
        parsed.profile ? normalizeCollaborationProfile(parsed.profile) : undefined,
      );
      const token = new AccessToken(livekitApiKey, livekitApiSecret, {
        identity: `${auth.role}:${auth.id}`,
        name: profile.displayName,
        ttl: CALL_TOKEN_TTL_SECONDS,
        attributes: {
          "eduri.role": auth.role,
          "eduri.lessonId": String(lesson.id),
          "eduri.color": profile.color,
        },
      });
      token.addGrant({
        room: roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: false,
        canPublishSources: [
          TrackSource.CAMERA,
          TrackSource.MICROPHONE,
          TrackSource.SCREEN_SHARE,
          TrackSource.SCREEN_SHARE_AUDIO,
        ],
        canUpdateOwnMetadata: false,
      });

      res.setHeader("Cache-Control", "no-store");
      res.json({
        url: livekitUrl,
        token: await token.toJwt(),
        roomName,
        expiresAt: new Date(Date.now() + CALL_TOKEN_TTL_SECONDS * 1_000).toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/:id/call-profile", async (req, res, next) => {
    try {
      const parsed = parseBody(callProfileSchema, req.body ?? {});
      const authContext = currentAuth(res);
      const auth = authContext.user;
      const lesson = lessonRow(context, req.params.id);
      if (!lesson || !canReadLesson(lesson, auth.role, auth.id)) {
        throw new HttpError(404, "Урок не найден");
      }
      if (lesson.status === "completed" || lesson.status === "cancelled") {
        throw new HttpError(409, "Звонок для этого урока недоступен");
      }
      const updateParticipant = context.livekitRoomService?.updateParticipant;
      if (!updateParticipant) {
        throw new HttpError(503, "Сервис звонков временно недоступен");
      }
      const roomName = lessonCallRoomName(String(lesson.meeting_key));
      const authorization = callAuthorizationState(context, {
        userId: auth.id,
        role: auth.role,
        sessionHash: authContext.sessionHash,
        lessonId: String(lesson.id),
        meetingKey: String(lesson.meeting_key),
      });
      if (
        authorization.account_active !== 1
        || authorization.session_active !== 1
        || authorization.lesson_active !== 1
      ) {
        throw new HttpError(403, "Доступ к звонку был отозван");
      }
      const profile = normalizeCollaborationProfile(parsed.profile);
      try {
        await updateParticipant.call(
          context.livekitRoomService,
          roomName,
          liveKitParticipantIdentity(auth.role, auth.id),
          {
            name: profile.displayName,
            attributes: { "eduri.color": profile.color },
          },
        );
      } catch (error) {
        if (isLiveKitNotFoundError(error)) {
          throw new HttpError(409, "Участник ещё не подключён к звонку");
        }
        console.error("[livekit] lesson participant profile update failed", {
          roomName,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new HttpError(503, "Сервис звонков временно недоступен");
      }
      res.setHeader("Cache-Control", "no-store");
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.patch("/:id", requireAuth("tutor"), async (req, res, next) => {
    try {
      const body = parseBody(updateLessonSchema, req.body);
      const tutor = currentAuth(res).user;
      const lesson = lessonRow(context, req.params.id);
      if (!lesson || lesson.tutor_id !== tutor.id) throw new HttpError(404, "Урок не найден");
      const studentId = body.studentId ?? (lesson.student_id as string);
      if (!ownedStudentName(context, tutor.id, studentId)) throw new HttpError(404, "Ученик не найден");
      const status = body.status ?? (lesson.status as string);
      const studentChanged = studentId !== lesson.student_id;
      const wasTerminal = lesson.status === "completed" || lesson.status === "cancelled";
      const isTerminal = status === "completed" || status === "cancelled";
      const rotateRoom = studentChanged || (!wasTerminal && isTerminal);
      const now = nowIso();
      const startedAt = status === "active" && !lesson.started_at ? now : lesson.started_at;
      const endedAt = status === "completed" && !lesson.ended_at ? now : lesson.ended_at;
      context.db.transaction(() => {
        if (rotateRoom) {
          enqueueLessonRoomRevocation(context.db, {
            meetingKey: String(lesson.meeting_key),
          }, now);
        }
        context.db.prepare(`
          UPDATE lessons SET
            student_id = ?, title = ?, scheduled_at = ?, duration_minutes = ?, status = ?,
            started_at = ?, ended_at = ?, meeting_key = ?, updated_at = ?
          WHERE id = ? AND tutor_id = ?
        `).run(
          studentId,
          body.title ?? lesson.title,
          body.scheduledAt ? new Date(body.scheduledAt).toISOString() : lesson.scheduled_at,
          body.durationMinutes ?? lesson.duration_minutes,
          status,
          startedAt,
          endedAt,
          rotateRoom ? randomToken(24) : lesson.meeting_key,
          now,
          lesson.id,
          tutor.id,
        );
        writeAudit(context, req, res, "lesson.updated", "lesson", lesson.id as string, { status });
      }).immediate();
      if (studentChanged) {
        context.removeLessonSocketMembership?.(lesson.id as string, lesson.student_id as string);
      }
      if (status !== lesson.status) {
        context.emitLessonStatus?.(lesson.id as string, status as LessonStatus);
      }
      if (rotateRoom) {
        scheduleLiveKitRevocation(context);
      }
      res.json({ lesson: serializeLessonDetail(context, lessonRow(context, lesson.id as string)!, true) });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/:id/notes", requireAuth("tutor"), (req, res, next) => {
    try {
      const { notes } = parseBody(z.object({ notes: z.string().max(20_000) }), req.body);
      const tutor = currentAuth(res).user;
      const result = context.db.prepare("UPDATE lessons SET notes = ?, updated_at = ? WHERE id = ? AND tutor_id = ?")
        .run(notes, nowIso(), req.params.id, tutor.id);
      if (result.changes === 0) throw new HttpError(404, "Урок не найден");
      writeAudit(context, req, res, "lesson.notes_updated", "lesson", req.params.id);
      res.json({ lesson: serializeLesson(lessonRow(context, req.params.id)!, false, true) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/start", requireAuth("tutor"), (req, res, next) => {
    try {
      const tutor = currentAuth(res).user;
      const now = nowIso();
      const result = context.db.prepare(`
        UPDATE lessons SET status = 'active', started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ? AND tutor_id = ? AND status IN ('scheduled', 'active')
      `).run(now, now, req.params.id, tutor.id);
      if (result.changes === 0) throw new HttpError(409, "Урок нельзя начать");
      writeAudit(context, req, res, "lesson.started", "lesson", req.params.id);
      context.emitLessonStatus?.(req.params.id, "active");
      res.json({ lesson: serializeLessonDetail(context, lessonRow(context, req.params.id)!, true) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/finish", requireAuth("tutor"), async (req, res, next) => {
    try {
      const tutor = currentAuth(res).user;
      const lesson = lessonRow(context, req.params.id);
      if (!lesson || lesson.tutor_id !== tutor.id || !["scheduled", "active", "completed"].includes(lesson.status as string)) {
        throw new HttpError(409, "Урок нельзя завершить");
      }
      const now = nowIso();
      context.db.transaction(() => {
        enqueueLessonRoomRevocation(context.db, {
          meetingKey: String(lesson.meeting_key),
        }, now);
        const updated = context.db.prepare(`
          UPDATE lessons SET status = 'completed', ended_at = COALESCE(ended_at, ?), meeting_key = ?, updated_at = ?
          WHERE id = ? AND tutor_id = ? AND status IN ('scheduled', 'active', 'completed')
        `).run(now, randomToken(24), now, req.params.id, tutor.id);
        if (updated.changes === 0) throw new HttpError(409, "Урок нельзя завершить");
        writeAudit(context, req, res, "lesson.completed", "lesson", req.params.id);
      }).immediate();
      context.emitLessonStatus?.(req.params.id, "completed");
      scheduleLiveKitRevocation(context);
      res.json({ lesson: serializeLessonDetail(context, lessonRow(context, req.params.id)!, true) });
    } catch (error) {
      next(error);
    }
  });

  router.put("/:id/materials/:materialId", requireAuth("tutor"), (req, res, next) => {
    try {
      const lessonId = String(req.params.id);
      const materialId = String(req.params.materialId);
      const { position } = parseBody(z.object({ position: z.coerce.number().int().min(0).max(10_000).optional().default(0) }), req.body ?? {});
      const tutor = currentAuth(res).user;
      const lesson = lessonRow(context, lessonId);
      if (!lesson || lesson.tutor_id !== tutor.id) throw new HttpError(404, "Урок не найден");
      const material = context.db.prepare("SELECT id FROM materials WHERE id = ? AND tutor_id = ?")
        .get(materialId, tutor.id);
      if (!material) throw new HttpError(404, "Материал не найден");
      const now = nowIso();
      const transaction = context.db.transaction(() => {
        context.db.prepare(`
          INSERT INTO lesson_materials (lesson_id, material_id, position, added_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(lesson_id, material_id) DO UPDATE SET position = excluded.position
        `).run(lessonId, materialId, position, now);
        context.db.prepare(`
          INSERT INTO material_access (material_id, student_id, granted_at, status, updated_at, lesson_id)
          VALUES (?, ?, ?, 'assigned', ?, ?)
          ON CONFLICT(material_id, student_id) DO UPDATE SET
            lesson_id = COALESCE(material_access.lesson_id, excluded.lesson_id),
            updated_at = CASE WHEN material_access.lesson_id IS NULL THEN excluded.updated_at ELSE material_access.updated_at END
        `).run(materialId, lesson.student_id, now, now, lessonId);
      });
      transaction();
      writeAudit(context, req, res, "lesson.material_attached", "lesson", lessonId, { materialId, position });
      res.json({ materials: lessonMaterials(context, lessonId, lesson.student_id as string) });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id/materials/:materialId", requireAuth("tutor"), (req, res, next) => {
    try {
      const lessonId = String(req.params.id);
      const materialId = String(req.params.materialId);
      const tutor = currentAuth(res).user;
      const lesson = lessonRow(context, lessonId);
      if (!lesson || lesson.tutor_id !== tutor.id) throw new HttpError(404, "Урок не найден");
      const result = context.db.prepare("DELETE FROM lesson_materials WHERE lesson_id = ? AND material_id = ?")
        .run(lessonId, materialId);
      if (result.changes === 0) throw new HttpError(404, "Материал не прикреплен к уроку");
      writeAudit(context, req, res, "lesson.material_detached", "lesson", lessonId, { materialId });
      res.json({ materials: lessonMaterials(context, lessonId, lesson.student_id as string) });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id", requireAuth("tutor"), async (req, res, next) => {
    try {
      const tutor = currentAuth(res).user;
      const lesson = lessonRow(context, req.params.id);
      if (!lesson || lesson.tutor_id !== tutor.id) throw new HttpError(404, "Урок не найден");
      context.db.transaction(() => {
        enqueueLessonRoomRevocation(context.db, {
          meetingKey: String(lesson.meeting_key),
        });
        writeAudit(context, req, res, "lesson.deleted", "lesson", req.params.id, { studentId: lesson.student_id });
        const deleted = context.db.prepare(
          "DELETE FROM lessons WHERE id = ? AND tutor_id = ?",
        ).run(req.params.id, tutor.id);
        if (deleted.changes !== 1) throw new HttpError(409, "Урок изменился во время удаления");
      }).immediate();
      context.removeLessonSocketMembership?.(req.params.id);
      scheduleLiveKitRevocation(context);
      res.sendStatus(204);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
