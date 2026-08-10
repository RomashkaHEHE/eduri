import { Router } from "express";
import { z } from "zod";
import type { AppContext, StoredUserRow } from "../types.js";
import { currentAuth, HttpError, pagination, parseBody, requireAuth, requireCsrf } from "../http.js";
import { createInvite } from "../invites.js";
import {
  completeUserAccessRevocation,
  disconnectUserRealtime,
  newId,
  normalizeLogin,
  nowIso,
  persistUserAccessRevocation,
} from "../security.js";
import { serializeStudent } from "../serializers.js";
import { writeAudit } from "../audit.js";
import {
  LiveKitRevocationError,
  revokeUserLiveKitAccessBeforeDeletion,
} from "../livekit.js";

const createStudentSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  loginName: z.string().trim().min(1).max(100).optional(),
  note: z.string().trim().max(2000).optional().default(""),
});

const updateStudentSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  loginName: z.string().trim().min(1).max(100).optional(),
  note: z.string().trim().max(2000).optional(),
  status: z.enum(["pending", "active", "suspended"]).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "Нет изменений" });

function studentSummaryQuery(where: string): string {
  return `
    SELECT u.*,
      (SELECT MIN(l.scheduled_at) FROM lessons l
        WHERE l.student_id = u.id AND l.status = 'scheduled' AND l.scheduled_at >= ?) AS next_lesson_at,
      (SELECT MAX(COALESCE(l.ended_at, l.scheduled_at)) FROM lessons l
        WHERE l.student_id = u.id AND l.status = 'completed') AS last_lesson_at,
      (SELECT COUNT(*) FROM assignments a
        WHERE a.student_id = u.id AND a.status IN ('assigned', 'submitted', 'returned')) AS pending_assignments
    FROM users u WHERE u.role = 'student' AND ${where}
  `;
}

function ownedStudent(context: AppContext, tutorId: string, studentId: string): StoredUserRow | undefined {
  return context.db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student' AND tutor_id = ?")
    .get(studentId, tutorId) as StoredUserRow | undefined;
}

function studentSummary(context: AppContext, tutorId: string, studentId: string): Record<string, unknown> | undefined {
  return context.db.prepare(studentSummaryQuery("u.id = ? AND u.tutor_id = ?"))
    .get(nowIso(), studentId, tutorId) as Record<string, unknown> | undefined;
}

export function createStudentsRouter(context: AppContext): Router {
  const router = Router();
  router.use(requireAuth("tutor"), requireCsrf(context));

  router.get("/", (req, res) => {
    const auth = currentAuth(res);
    const { limit, offset } = pagination(req);
    const search = typeof req.query.search === "string" ? `%${normalizeLogin(req.query.search)}%` : "%";
    const status = typeof req.query.status === "string" && ["pending", "active", "suspended"].includes(req.query.status)
      ? req.query.status
      : null;
    const rows = context.db.prepare(`
      ${studentSummaryQuery("u.tutor_id = ? AND (? IS NULL OR u.status = ?) AND (lower(u.display_name) LIKE ? OR u.login_name_normalized LIKE ?)")}
      ORDER BY u.display_name COLLATE NOCASE LIMIT ? OFFSET ?
    `).all(nowIso(), auth.user.id, status, status, search, search, limit, offset) as Array<Record<string, unknown>>;
    const total = (context.db.prepare(`
      SELECT COUNT(*) AS count FROM users WHERE role = 'student' AND tutor_id = ? AND (? IS NULL OR status = ?)
    `).get(auth.user.id, status, status) as { count: number }).count;
    res.json({ students: rows.map(serializeStudent), total });
  });

  router.post("/", (req, res, next) => {
    try {
      const body = parseBody(createStudentSchema, req.body);
      const tutor = currentAuth(res).user;
      const id = newId();
      const now = nowIso();
      const loginName = body.loginName ?? body.displayName;
      const transaction = context.db.transaction(() => {
        context.db.prepare(`
          INSERT INTO users (
            id, role, status, display_name, login_name, login_name_normalized,
            tutor_id, note, created_at, updated_at
          ) VALUES (?, 'student', 'pending', ?, ?, ?, ?, ?, ?, ?)
        `).run(id, body.displayName, loginName, normalizeLogin(loginName), tutor.id, body.note, now, now);
        return createInvite(context, id, "student_activation", tutor.id);
      });
      const invite = transaction();
      writeAudit(context, req, res, "student.created", "user", id);
      res.status(201).json({ student: serializeStudent(studentSummary(context, tutor.id, id)!), invite });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", (req, res, next) => {
    const tutor = currentAuth(res).user;
    const student = studentSummary(context, tutor.id, req.params.id);
    if (!student) return next(new HttpError(404, "Ученик не найден"));
    res.json({ student: serializeStudent(student) });
  });

  router.patch("/:id", (req, res, next) => {
    try {
      const body = parseBody(updateStudentSchema, req.body);
      const tutor = currentAuth(res).user;
      const student = ownedStudent(context, tutor.id, req.params.id);
      if (!student) throw new HttpError(404, "Ученик не найден");
      if (body.loginName && student.credential_lookup && normalizeLogin(body.loginName) !== student.login_name_normalized) {
        throw new HttpError(409, "Для смены имени входа создайте новое приглашение и сбросьте кодовое слово");
      }
      if (body.status === "active" && !student.password_hash) {
        throw new HttpError(409, "Ученик еще не активировал приглашение");
      }
      const loginName = body.loginName ?? student.login_name ?? student.display_name;
      const status = body.status ?? student.status;
      const timestamp = nowIso();
      context.db.transaction(() => {
        context.db.prepare(`
          UPDATE users SET display_name = ?, login_name = ?, login_name_normalized = ?, note = ?, status = ?, updated_at = ?
          WHERE id = ? AND tutor_id = ?
        `).run(
          body.displayName ?? student.display_name,
          loginName,
          normalizeLogin(loginName),
          body.note ?? student.note,
          status,
          timestamp,
          student.id,
          tutor.id,
        );
        if (status !== "active") {
          persistUserAccessRevocation(context, student.id, { timestamp });
        }
        writeAudit(context, req, res, "student.updated", "user", student.id, { status });
      }).immediate();
      if (status !== "active") {
        completeUserAccessRevocation(context, student.id);
      }
      res.json({ student: serializeStudent(studentSummary(context, tutor.id, student.id)!) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/invite", (req, res, next) => {
    try {
      const tutor = currentAuth(res).user;
      const student = ownedStudent(context, tutor.id, req.params.id);
      if (!student || student.status === "suspended") throw new HttpError(404, "Ученик не найден");
      const purpose = student.password_hash ? "password_reset" : "student_activation";
      const timestamp = nowIso();
      const invite = context.db.transaction(() => {
        if (purpose === "password_reset") {
          context.db.prepare(`
            UPDATE users SET status = 'pending', password_hash = NULL, credential_lookup = NULL, updated_at = ?
            WHERE id = ? AND tutor_id = ?
          `).run(timestamp, student.id, tutor.id);
          persistUserAccessRevocation(context, student.id, { timestamp });
        }
        const created = createInvite(context, student.id, purpose, tutor.id);
        writeAudit(context, req, res, "student.invite_created", "user", student.id, { purpose });
        return created;
      }).immediate();
      if (purpose === "password_reset") {
        completeUserAccessRevocation(context, student.id);
      }
      res.status(201).json({ invite });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      const tutor = currentAuth(res).user;
      const student = ownedStudent(context, tutor.id, req.params.id);
      if (!student) throw new HttpError(404, "Ученик не найден");
      context.db.transaction(() => {
        const timestamp = nowIso();
        const suspended = context.db.prepare(`
          UPDATE users SET status = 'suspended', updated_at = ?
          WHERE id = ? AND role = 'student' AND tutor_id = ?
        `).run(timestamp, student.id, tutor.id);
        if (suspended.changes !== 1) throw new HttpError(409, "Ученик изменился во время удаления");
        persistUserAccessRevocation(context, student.id, {
          rotateLessonRooms: false,
          timestamp,
        });
      }).immediate();
      disconnectUserRealtime(context, student.id);
      await revokeUserLiveKitAccessBeforeDeletion(context, student.id);
      context.db.transaction(() => {
        writeAudit(context, req, res, "student.deleted", "user", student.id, { displayName: student.display_name });
        const deleted = context.db.prepare(`
          DELETE FROM users
          WHERE id = ? AND role = 'student' AND tutor_id = ? AND status = 'suspended'
        `).run(student.id, tutor.id);
        if (deleted.changes !== 1) throw new HttpError(409, "Ученик изменился во время удаления");
      }).immediate();
      res.sendStatus(204);
    } catch (error) {
      next(error instanceof LiveKitRevocationError
        ? new HttpError(503, "Не удалось завершить активный звонок ученика")
        : error);
    }
  });

  return router;
}
