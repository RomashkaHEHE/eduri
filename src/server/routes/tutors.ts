import { Router } from "express";
import { z } from "zod";
import type { AppContext, StoredUserRow } from "../types.js";
import { currentAuth, HttpError, pagination, parseBody, requireAuth, requireCsrf } from "../http.js";
import {
  completeUserAccessRevocation,
  disconnectUserRealtime,
  hashPassword,
  newId,
  normalizeLogin,
  nowIso,
  persistUserAccessRevocation,
} from "../security.js";
import { createInvite } from "../invites.js";
import { serializeTutor } from "../serializers.js";
import { writeAudit } from "../audit.js";
import {
  LiveKitRevocationError,
  revokeUserLiveKitAccessBeforeDeletion,
} from "../livekit.js";

const createTutorSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  loginName: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(256).refine((value) => /\S/u.test(value), "Пароль не может состоять из пробелов").optional(),
});

const updateTutorSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  loginName: z.string().trim().min(1).max(100).optional(),
  status: z.enum(["pending", "active", "suspended"]).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "Нет изменений" });

function tutorById(context: AppContext, id: string): Record<string, unknown> | undefined {
  return context.db.prepare(`
    SELECT u.*, COUNT(s.id) AS student_count
    FROM users u LEFT JOIN users s ON s.tutor_id = u.id AND s.role = 'student'
    WHERE u.id = ? AND u.role = 'tutor'
    GROUP BY u.id
  `).get(id) as Record<string, unknown> | undefined;
}

export function createTutorsRouter(context: AppContext): Router {
  const router = Router();
  router.use(requireAuth("admin"), requireCsrf(context));

  router.get("/", (req, res) => {
    const { limit, offset } = pagination(req);
    const search = typeof req.query.search === "string" ? `%${normalizeLogin(req.query.search)}%` : "%";
    const rows = context.db.prepare(`
      SELECT u.*, COUNT(s.id) AS student_count
      FROM users u LEFT JOIN users s ON s.tutor_id = u.id AND s.role = 'student'
      WHERE u.role = 'tutor' AND (u.login_name_normalized LIKE ? OR lower(u.display_name) LIKE ?)
      GROUP BY u.id ORDER BY u.created_at DESC LIMIT ? OFFSET ?
    `).all(search, search, limit, offset) as Array<Record<string, unknown>>;
    const total = (context.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'tutor'").get() as { count: number }).count;
    res.json({ tutors: rows.map(serializeTutor), total });
  });

  router.post("/", (req, res, next) => {
    try {
      const body = parseBody(createTutorSchema, req.body);
      const actor = currentAuth(res).user;
      const id = newId();
      const now = nowIso();
      context.db.prepare(`
        INSERT INTO users (
          id, role, status, display_name, login_name, login_name_normalized,
          password_hash, created_at, updated_at
        ) VALUES (?, 'tutor', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        body.password ? "active" : "pending",
        body.displayName,
        body.loginName,
        normalizeLogin(body.loginName),
        body.password ? hashPassword(body.password, context.config.bcryptRounds) : null,
        now,
        now,
      );
      const invite = body.password ? undefined : createInvite(context, id, "tutor_activation", actor.id);
      writeAudit(context, req, res, "tutor.created", "user", id, { invited: Boolean(invite) });
      res.status(201).json({ tutor: serializeTutor(tutorById(context, id)!), ...(invite ? { invite } : {}) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", (req, res, next) => {
    const tutor = tutorById(context, req.params.id);
    if (!tutor) return next(new HttpError(404, "Репетитор не найден"));
    res.json({ tutor: serializeTutor(tutor) });
  });

  router.patch("/:id", (req, res, next) => {
    try {
      const body = parseBody(updateTutorSchema, req.body);
      const existing = context.db.prepare("SELECT * FROM users WHERE id = ? AND role = 'tutor'").get(req.params.id) as StoredUserRow | undefined;
      if (!existing) throw new HttpError(404, "Репетитор не найден");
      if (body.status === "active" && !existing.password_hash) {
        throw new HttpError(409, "Сначала задайте пароль или активируйте приглашение");
      }
      const displayName = body.displayName ?? existing.display_name;
      const loginName = body.loginName ?? existing.login_name!;
      const status = body.status ?? existing.status;
      const timestamp = nowIso();
      context.db.transaction(() => {
        context.db.prepare(`
          UPDATE users SET display_name = ?, login_name = ?, login_name_normalized = ?, status = ?, updated_at = ?
          WHERE id = ?
        `).run(displayName, loginName, normalizeLogin(loginName), status, timestamp, existing.id);
        if (status !== "active") {
          persistUserAccessRevocation(context, existing.id, { timestamp });
        }
        writeAudit(context, req, res, "tutor.updated", "user", existing.id, { status });
      }).immediate();
      if (status !== "active") {
        completeUserAccessRevocation(context, existing.id);
      }
      res.json({ tutor: serializeTutor(tutorById(context, existing.id)!) });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/:id/status", (req, res, next) => {
    try {
      const { status } = parseBody(z.object({ status: z.enum(["pending", "active", "suspended"]) }), req.body);
      const existing = context.db.prepare("SELECT * FROM users WHERE id = ? AND role = 'tutor'").get(req.params.id) as StoredUserRow | undefined;
      if (!existing) throw new HttpError(404, "Репетитор не найден");
      if (status === "active" && !existing.password_hash) throw new HttpError(409, "У аккаунта еще нет пароля");
      const timestamp = nowIso();
      context.db.transaction(() => {
        context.db.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?")
          .run(status, timestamp, existing.id);
        if (status !== "active") {
          persistUserAccessRevocation(context, existing.id, { timestamp });
        }
        writeAudit(context, req, res, "tutor.status_changed", "user", existing.id, { status });
      }).immediate();
      if (status !== "active") {
        completeUserAccessRevocation(context, existing.id);
      }
      res.json({ tutor: serializeTutor(tutorById(context, existing.id)!) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/invite", (req, res, next) => {
    try {
      const tutor = context.db.prepare("SELECT * FROM users WHERE id = ? AND role = 'tutor'").get(req.params.id) as StoredUserRow | undefined;
      if (!tutor || tutor.status === "suspended") throw new HttpError(404, "Репетитор не найден");
      const purpose = tutor.password_hash ? "password_reset" : "tutor_activation";
      const timestamp = nowIso();
      const invite = context.db.transaction(() => {
        if (purpose === "password_reset") {
          context.db.prepare("UPDATE users SET status = 'pending', password_hash = NULL, updated_at = ? WHERE id = ?")
            .run(timestamp, tutor.id);
          persistUserAccessRevocation(context, tutor.id, { timestamp });
        }
        const created = createInvite(context, tutor.id, purpose, currentAuth(res).user.id);
        writeAudit(context, req, res, "tutor.invite_created", "user", tutor.id, { purpose });
        return created;
      }).immediate();
      if (purpose === "password_reset") {
        completeUserAccessRevocation(context, tutor.id);
      }
      res.status(201).json({ invite });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/password-reset", (req, res, next) => {
    try {
      const { password } = parseBody(z.object({
        password: z.string().min(12).max(256).refine((value) => /\S/u.test(value), "Пароль не может состоять из пробелов").optional(),
      }), req.body);
      const tutor = context.db.prepare("SELECT * FROM users WHERE id = ? AND role = 'tutor'").get(req.params.id) as StoredUserRow | undefined;
      if (!tutor) throw new HttpError(404, "Репетитор не найден");
      if (!password && tutor.status === "suspended") throw new HttpError(409, "Сначала разблокируйте аккаунт");
      const timestamp = nowIso();
      const nextPasswordHash = password
        ? hashPassword(password, context.config.bcryptRounds)
        : null;
      const result = context.db.transaction(() => {
        let invite: ReturnType<typeof createInvite> | undefined;
        if (password) {
          context.db.prepare(`
            UPDATE users SET password_hash = ?, status = CASE WHEN status = 'pending' THEN 'active' ELSE status END, updated_at = ? WHERE id = ?
          `).run(nextPasswordHash, timestamp, tutor.id);
          context.db.prepare("UPDATE invites SET revoked_at = ? WHERE target_user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL")
            .run(timestamp, tutor.id);
          writeAudit(context, req, res, "tutor.password_reset", "user", tutor.id);
        } else {
          context.db.prepare("UPDATE users SET status = 'pending', password_hash = NULL, updated_at = ? WHERE id = ?")
            .run(timestamp, tutor.id);
          invite = createInvite(context, tutor.id, "password_reset", currentAuth(res).user.id);
          writeAudit(context, req, res, "tutor.password_reset_invited", "user", tutor.id);
        }
        persistUserAccessRevocation(context, tutor.id, { timestamp });
        return { invite };
      }).immediate();
      completeUserAccessRevocation(context, tutor.id);
      if (password) {
        res.json({ tutor: serializeTutor(tutorById(context, tutor.id)!) });
      } else {
        res.status(201).json({ invite: result.invite });
      }
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      const tutor = tutorById(context, req.params.id);
      if (!tutor) throw new HttpError(404, "Репетитор не найден");
      if (Number(tutor.student_count) > 0) throw new HttpError(409, "Сначала перенесите или удалите учеников репетитора");
      context.db.transaction(() => {
        const timestamp = nowIso();
        const suspended = context.db.prepare(`
          UPDATE users SET status = 'suspended', updated_at = ?
          WHERE id = ? AND role = 'tutor'
        `).run(timestamp, req.params.id);
        if (suspended.changes !== 1) {
          throw new HttpError(
            409,
            "Репетитор изменился во время удаления",
          );
        }
        persistUserAccessRevocation(context, req.params.id, {
          rotateLessonRooms: false,
          timestamp,
        });
      }).immediate();
      disconnectUserRealtime(context, req.params.id);
      await revokeUserLiveKitAccessBeforeDeletion(context, req.params.id);
      context.db.transaction(() => {
        context.materialFiles.enqueueTutorFiles(req.params.id);
        writeAudit(context, req, res, "tutor.deleted", "user", req.params.id, { loginName: tutor.login_name });
        const deleted = context.db.prepare(`
          DELETE FROM users
          WHERE id = ? AND role = 'tutor' AND status = 'suspended'
        `).run(req.params.id);
        if (deleted.changes !== 1) throw new HttpError(409, "Репетитор изменился во время удаления");
      }).immediate();
      const cleanup = await context.materialFiles.cleanupGarbage();
      if (cleanup.failed > 0) {
        console.error("[materials] tutor file cleanup deferred", {
          tutorId: req.params.id,
          failed: cleanup.failed,
        });
      }
      res.sendStatus(204);
    } catch (error) {
      next(error instanceof LiveKitRevocationError
        ? new HttpError(
            503,
            "Не удалось завершить активные звонки репетитора",
          )
        : error);
    }
  });

  return router;
}

export function createAuditRouter(context: AppContext): Router {
  const router = Router();
  router.use(requireAuth("admin"), requireCsrf(context));
  router.get("/", (req, res) => {
    const { limit, offset } = pagination(req, 200);
    const rows = context.db.prepare(`
      SELECT a.*, u.display_name AS actor_name
      FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC LIMIT ? OFFSET ?
    `).all(limit, offset) as Array<Record<string, unknown>>;
    res.json({
      events: rows.map((row) => ({
        id: row.id,
        actorId: row.actor_id,
        actorName: row.actor_name ?? null,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        metadata: JSON.parse(row.metadata_json as string),
        ipAddress: row.ip_address,
        createdAt: row.created_at,
      })),
    });
  });
  return router;
}
