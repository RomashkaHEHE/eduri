import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { asOptionalIso, currentAuth, HttpError, pagination, parseBody, requireAuth, requireCsrf } from "../http.js";
import { newId, nowIso } from "../security.js";
import { serializeAssignment } from "../serializers.js";
import { writeAudit } from "../audit.js";

const isoDate = z.string().refine((value) => Number.isFinite(new Date(value).valueOf()), "Некорректная дата");
const createAssignmentSchema = z.object({
  studentId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(100_000).default(""),
  dueAt: isoDate.nullable().optional(),
  materialIds: z.array(z.string().uuid()).max(100).optional().default([]),
});

const updateAssignmentSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(100_000).optional(),
  dueAt: isoDate.nullable().optional(),
  materialIds: z.array(z.string().uuid()).max(100).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "Нет изменений" });

function assignmentRow(context: AppContext, id: string): Record<string, unknown> | undefined {
  return context.db.prepare(`
    SELECT a.*, s.display_name AS student_name,
      (SELECT json_group_array(am.material_id) FROM assignment_materials am WHERE am.assignment_id = a.id) AS material_ids_json
    FROM assignments a JOIN users s ON s.id = a.student_id
    WHERE a.id = ?
  `).get(id) as Record<string, unknown> | undefined;
}

function canReadAssignment(row: Record<string, unknown>, role: string, userId: string): boolean {
  return (role === "tutor" && row.tutor_id === userId) || (role === "student" && row.student_id === userId);
}

function assertStudent(context: AppContext, tutorId: string, studentId: string): void {
  const row = context.db.prepare(`
    SELECT 1 FROM users WHERE id = ? AND tutor_id = ? AND role = 'student' AND status != 'suspended'
  `).get(studentId, tutorId);
  if (!row) throw new HttpError(404, "Ученик не найден");
}

function assertMaterials(context: AppContext, tutorId: string, materialIds: string[]): string[] {
  const ids = [...new Set(materialIds)];
  if (ids.length === 0) return ids;
  const placeholders = ids.map(() => "?").join(",");
  const count = (context.db.prepare(`
    SELECT COUNT(*) AS count FROM materials WHERE tutor_id = ? AND id IN (${placeholders})
  `).get(tutorId, ...ids) as { count: number }).count;
  if (count !== ids.length) throw new HttpError(404, "Один или несколько материалов не найдены");
  return ids;
}

function replaceMaterials(context: AppContext, assignmentId: string, studentId: string, materialIds: string[]): void {
  context.db.prepare("DELETE FROM assignment_materials WHERE assignment_id = ?").run(assignmentId);
  const link = context.db.prepare(`
    INSERT INTO assignment_materials (assignment_id, material_id, position) VALUES (?, ?, ?)
  `);
  const access = context.db.prepare(`
    INSERT INTO material_access (material_id, student_id, granted_at, status, updated_at)
    VALUES (?, ?, ?, 'assigned', ?)
    ON CONFLICT(material_id, student_id) DO NOTHING
  `);
  const now = nowIso();
  materialIds.forEach((materialId, position) => {
    link.run(assignmentId, materialId, position);
    access.run(materialId, studentId, now, now);
  });
}

export function createAssignmentsRouter(context: AppContext): Router {
  const router = Router();
  router.use(requireAuth("tutor", "student"), requireCsrf(context));

  router.get("/", (req, res) => {
    const auth = currentAuth(res).user;
    const { limit, offset } = pagination(req, 200);
    const status = typeof req.query.status === "string" && ["assigned", "submitted", "reviewed", "returned"].includes(req.query.status)
      ? req.query.status
      : null;
    const studentId = typeof req.query.studentId === "string" ? req.query.studentId : null;
    const rows = context.db.prepare(`
      SELECT a.*, s.display_name AS student_name,
        (SELECT json_group_array(am.material_id) FROM assignment_materials am WHERE am.assignment_id = a.id) AS material_ids_json
      FROM assignments a JOIN users s ON s.id = a.student_id
      WHERE ((? = 'tutor' AND a.tutor_id = ?) OR (? = 'student' AND a.student_id = ?))
        AND (? IS NULL OR a.status = ?)
        AND (? IS NULL OR a.student_id = ?)
      ORDER BY a.created_at DESC LIMIT ? OFFSET ?
    `).all(auth.role, auth.id, auth.role, auth.id, status, status, studentId, studentId, limit, offset) as Array<Record<string, unknown>>;
    res.json({ assignments: rows.map(serializeAssignment) });
  });

  router.post("/", requireAuth("tutor"), (req, res, next) => {
    try {
      const body = parseBody(createAssignmentSchema, req.body);
      const tutor = currentAuth(res).user;
      assertStudent(context, tutor.id, body.studentId);
      const materialIds = assertMaterials(context, tutor.id, body.materialIds ?? []);
      const id = newId();
      const now = nowIso();
      const transaction = context.db.transaction(() => {
        context.db.prepare(`
          INSERT INTO assignments (
            id, tutor_id, student_id, title, description, due_at, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'assigned', ?, ?)
        `).run(
          id, tutor.id, body.studentId, body.title, body.description,
          body.dueAt ? new Date(body.dueAt).toISOString() : null, now, now,
        );
        replaceMaterials(context, id, body.studentId, materialIds);
      });
      transaction();
      writeAudit(context, req, res, "assignment.created", "assignment", id, { studentId: body.studentId });
      res.status(201).json({ assignment: serializeAssignment(assignmentRow(context, id)!) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", (req, res, next) => {
    const auth = currentAuth(res).user;
    const assignment = assignmentRow(context, req.params.id);
    if (!assignment || !canReadAssignment(assignment, auth.role, auth.id)) return next(new HttpError(404, "Задание не найдено"));
    res.json({ assignment: serializeAssignment(assignment) });
  });

  router.patch("/:id", requireAuth("tutor"), (req, res, next) => {
    try {
      const body = parseBody(updateAssignmentSchema, req.body);
      const tutor = currentAuth(res).user;
      const existing = assignmentRow(context, req.params.id);
      if (!existing || existing.tutor_id !== tutor.id) throw new HttpError(404, "Задание не найдено");
      const materialIds = body.materialIds ? assertMaterials(context, tutor.id, body.materialIds) : undefined;
      const dueAt = body.dueAt === undefined ? existing.due_at : (body.dueAt ? new Date(body.dueAt).toISOString() : null);
      const transaction = context.db.transaction(() => {
        context.db.prepare(`
          UPDATE assignments SET title = ?, description = ?, due_at = ?, updated_at = ?
          WHERE id = ? AND tutor_id = ?
        `).run(
          body.title ?? existing.title,
          body.description ?? existing.description,
          dueAt,
          nowIso(),
          existing.id,
          tutor.id,
        );
        if (materialIds) replaceMaterials(context, existing.id as string, existing.student_id as string, materialIds);
      });
      transaction();
      writeAudit(context, req, res, "assignment.updated", "assignment", existing.id as string);
      res.json({ assignment: serializeAssignment(assignmentRow(context, existing.id as string)!) });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/:id/answer", requireAuth("student"), (req, res, next) => {
    try {
      const { answer } = parseBody(z.object({ answer: z.string().max(100_000) }), req.body);
      const student = currentAuth(res).user;
      const result = context.db.prepare(`
        UPDATE assignments SET answer = ?, updated_at = ?
        WHERE id = ? AND student_id = ? AND status IN ('assigned', 'returned')
      `).run(answer, nowIso(), req.params.id, student.id);
      if (result.changes === 0) throw new HttpError(409, "Ответ нельзя изменить в текущем статусе");
      res.json({ assignment: serializeAssignment(assignmentRow(context, req.params.id)!) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/submit", requireAuth("student"), (req, res, next) => {
    try {
      const { answer } = parseBody(z.object({ answer: z.string().trim().min(1).max(100_000).optional() }), req.body);
      const student = currentAuth(res).user;
      const existing = assignmentRow(context, req.params.id);
      if (!existing || existing.student_id !== student.id) throw new HttpError(404, "Задание не найдено");
      const finalAnswer = answer ?? (existing.answer as string | null);
      if (!finalAnswer?.trim()) throw new HttpError(400, "Добавьте ответ перед отправкой");
      const now = nowIso();
      const result = context.db.prepare(`
        UPDATE assignments SET answer = ?, status = 'submitted', submitted_at = ?, reviewed_at = NULL, updated_at = ?
        WHERE id = ? AND student_id = ? AND status IN ('assigned', 'returned')
      `).run(finalAnswer, now, now, existing.id, student.id);
      if (result.changes === 0) throw new HttpError(409, "Задание уже отправлено или проверено");
      writeAudit(context, req, res, "assignment.submitted", "assignment", existing.id as string);
      res.json({ assignment: serializeAssignment(assignmentRow(context, existing.id as string)!) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/review", requireAuth("tutor"), (req, res, next) => {
    try {
      const body = parseBody(z.object({
        status: z.enum(["reviewed", "returned"]),
        feedback: z.string().max(50_000).default(""),
      }), req.body);
      const feedback = body.feedback ?? "";
      if (body.status === "returned" && !feedback.trim()) throw new HttpError(400, "Добавьте комментарий при возврате");
      const tutor = currentAuth(res).user;
      const existing = assignmentRow(context, req.params.id);
      if (!existing || existing.tutor_id !== tutor.id) throw new HttpError(404, "Задание не найдено");
      if (existing.status !== "submitted") throw new HttpError(409, "На проверку можно взять только сданное задание");
      const now = nowIso();
      context.db.prepare(`
        UPDATE assignments SET status = ?, feedback = ?, reviewed_at = ?, updated_at = ?
        WHERE id = ? AND tutor_id = ?
      `).run(body.status, feedback, now, now, existing.id, tutor.id);
      writeAudit(context, req, res, "assignment.reviewed", "assignment", existing.id as string, { status: body.status });
      res.json({ assignment: serializeAssignment(assignmentRow(context, existing.id as string)!) });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id", requireAuth("tutor"), (req, res, next) => {
    try {
      const tutor = currentAuth(res).user;
      const existing = assignmentRow(context, req.params.id);
      if (!existing || existing.tutor_id !== tutor.id) throw new HttpError(404, "Задание не найдено");
      writeAudit(context, req, res, "assignment.deleted", "assignment", req.params.id, { studentId: existing.student_id });
      context.db.prepare("DELETE FROM assignments WHERE id = ? AND tutor_id = ?").run(req.params.id, tutor.id);
      res.sendStatus(204);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
