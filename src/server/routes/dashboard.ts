import { Router } from "express";
import type { AppContext } from "../types.js";
import { currentAuth, requireAuth, requireCsrf } from "../http.js";
import { nowIso } from "../security.js";
import { serializeAssignment, serializeLesson, serializeMaterial, serializeStudent } from "../serializers.js";

export function createDashboardRouter(context: AppContext): Router {
  const router = Router();
  router.use(requireAuth(), requireCsrf(context));

  router.get("/", (_req, res) => {
    const auth = currentAuth(res).user;
    if (auth.role === "admin") {
      const counts = context.db.prepare(`
        SELECT
          SUM(CASE WHEN role = 'tutor' THEN 1 ELSE 0 END) AS tutors,
          SUM(CASE WHEN role = 'tutor' AND status = 'active' THEN 1 ELSE 0 END) AS active_tutors,
          SUM(CASE WHEN role = 'student' THEN 1 ELSE 0 END) AS students,
          SUM(CASE WHEN role = 'student' AND status = 'active' THEN 1 ELSE 0 END) AS active_students
        FROM users
      `).get() as Record<string, number | null>;
      const recentAudit = context.db.prepare(`
        SELECT a.id, a.action, a.target_type, a.target_id, a.created_at, u.display_name AS actor_name
        FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        ORDER BY a.created_at DESC LIMIT 10
      `).all() as Array<Record<string, unknown>>;
      res.json({
        dashboard: {
          tutorCount: Number(counts.tutors ?? 0),
          activeTutorCount: Number(counts.active_tutors ?? 0),
          studentCount: Number(counts.students ?? 0),
          activeStudentCount: Number(counts.active_students ?? 0),
          recentAudit: recentAudit.map((row) => ({
            id: row.id,
            action: row.action,
            targetType: row.target_type,
            targetId: row.target_id,
            actorName: row.actor_name ?? null,
            createdAt: row.created_at,
          })),
        },
      });
      return;
    }

    if (auth.role === "tutor") {
      const now = nowIso();
      const horizon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const counts = context.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM users WHERE tutor_id = ? AND role = 'student' AND status = 'active') AS students,
          (SELECT COUNT(*) FROM assignments WHERE tutor_id = ? AND status = 'submitted') AS pending_reviews,
          (SELECT COUNT(*) FROM lessons WHERE tutor_id = ? AND status = 'scheduled' AND scheduled_at >= ?) AS upcoming_lessons
      `).get(auth.id, auth.id, auth.id, now) as Record<string, number>;
      const lessons = context.db.prepare(`
        SELECT l.*, s.display_name AS student_name FROM lessons l JOIN users s ON s.id = l.student_id
        WHERE l.tutor_id = ? AND l.status IN ('scheduled', 'active') AND l.scheduled_at < ?
        ORDER BY l.scheduled_at ASC LIMIT 20
      `).all(auth.id, horizon) as Array<Record<string, unknown>>;
      const reviews = context.db.prepare(`
        SELECT a.*, s.display_name AS student_name,
          (SELECT json_group_array(am.material_id) FROM assignment_materials am WHERE am.assignment_id = a.id) AS material_ids_json
        FROM assignments a JOIN users s ON s.id = a.student_id
        WHERE a.tutor_id = ? AND a.status = 'submitted'
        ORDER BY a.submitted_at ASC LIMIT 10
      `).all(auth.id) as Array<Record<string, unknown>>;
      const students = context.db.prepare(`
        SELECT u.*,
          (SELECT MIN(l.scheduled_at) FROM lessons l WHERE l.student_id = u.id AND l.status = 'scheduled' AND l.scheduled_at >= ?) AS next_lesson_at,
          (SELECT MAX(COALESCE(l.ended_at, l.scheduled_at)) FROM lessons l WHERE l.student_id = u.id AND l.status = 'completed') AS last_lesson_at,
          (SELECT COUNT(*) FROM assignments a WHERE a.student_id = u.id AND a.status IN ('assigned', 'submitted', 'returned')) AS pending_assignments
        FROM users u WHERE u.tutor_id = ? AND u.role = 'student'
        ORDER BY u.updated_at DESC LIMIT 8
      `).all(now, auth.id) as Array<Record<string, unknown>>;
      res.json({
        dashboard: {
          studentCount: Number(counts.students ?? 0),
          pendingReviewCount: Number(counts.pending_reviews ?? 0),
          upcomingLessonCount: Number(counts.upcoming_lessons ?? 0),
          todayLessons: lessons.map((row) => serializeLesson(row, false, true)),
          pendingReviews: reviews.map(serializeAssignment),
          recentStudents: students.map(serializeStudent),
        },
      });
      return;
    }

    const nextLesson = context.db.prepare(`
      SELECT l.*, s.display_name AS student_name FROM lessons l JOIN users s ON s.id = l.student_id
      WHERE l.student_id = ? AND l.status IN ('scheduled', 'active') AND l.scheduled_at >= ?
      ORDER BY l.scheduled_at ASC LIMIT 1
    `).get(auth.id, nowIso()) as Record<string, unknown> | undefined;
    const assignments = context.db.prepare(`
      SELECT a.*, s.display_name AS student_name,
        (SELECT json_group_array(am.material_id) FROM assignment_materials am WHERE am.assignment_id = a.id) AS material_ids_json
      FROM assignments a JOIN users s ON s.id = a.student_id
      WHERE a.student_id = ? AND a.status IN ('assigned', 'returned')
      ORDER BY CASE WHEN a.due_at IS NULL THEN 1 ELSE 0 END, a.due_at ASC, a.created_at DESC LIMIT 10
    `).all(auth.id) as Array<Record<string, unknown>>;
    const materials = context.db.prepare(`
      SELECT m.*,
        json_array(?) AS student_ids_json,
        ma.status AS progress_status,
        ma.lesson_id AS progress_lesson_id,
        ma.updated_at AS progress_updated_at
      FROM material_access ma JOIN materials m ON m.id = ma.material_id
      WHERE ma.student_id = ? ORDER BY ma.updated_at DESC LIMIT 8
    `).all(auth.id, auth.id) as Array<Record<string, unknown>>;
    res.json({
      dashboard: {
        nextLesson: nextLesson ? serializeLesson(nextLesson, false, false) : null,
        activeAssignments: assignments.map(serializeAssignment),
        recentMaterials: materials.map(serializeMaterial),
      },
    });
  });

  return router;
}
