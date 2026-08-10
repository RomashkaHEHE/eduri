import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { AppContext, InviteRow, StoredUserRow } from "../types.js";
import {
  AUTH_RATE_LIMIT_POLICIES,
  AuthRateLimitStore,
  authIpRateLimit,
  sendAuthRateLimitResponse,
} from "../authRateLimit.js";
import {
  MAX_STUDENT_SECRET_LENGTH,
  newStudentSecretIssue,
} from "../credentialPolicy.js";
import {
  clearSessionCookie,
  completeUserAccessRevocation,
  createSession,
  csrfForSession,
  getAuth,
  hashPassword,
  newId,
  normalizeCodeWord,
  normalizeLogin,
  nowIso,
  persistUserAccessRevocation,
  setSessionCookie,
  studentCredentialLookup,
  toAuthUser,
  verifyPassword,
} from "../security.js";
import { currentAuth, HttpError, parseBody, requireAuth, requireCsrf } from "../http.js";
import { findUsableInvite } from "../invites.js";

const tokenSchema = z.string().min(32).max(256);
const normalizedLoginSchema = z.string().max(100)
  .transform(normalizeLogin)
  .refine((value) => value.length > 0, "Поле не может быть пустым");
const normalizedLoginCodeSchema = z.string().max(128)
  .transform(normalizeCodeWord)
  .refine((value) => value.length > 0, "Кодовое слово не может быть пустым");
const activationCodeSchema = z.string().max(MAX_STUDENT_SECRET_LENGTH)
  .transform(normalizeCodeWord)
  .superRefine((value, issueContext) => {
    const issue = newStudentSecretIssue(value);
    if (issue) issueContext.addIssue({ code: z.ZodIssueCode.custom, message: issue });
  });
const strongPasswordSchema = z.string().min(12).max(256).refine((value) => /\S/u.test(value), "Пароль не может состоять из пробелов");
const studentLoginSchema = z.object({
  name: normalizedLoginSchema.optional(),
  loginName: normalizedLoginSchema.optional(),
  codeWord: normalizedLoginCodeSchema,
}).refine((value) => Boolean(value.name || value.loginName), { message: "Укажите имя", path: ["name"] });

const staffLoginSchema = z.object({
  loginName: normalizedLoginSchema,
  password: z.string().min(1).max(256),
});

const activationSchema = z.object({
  token: tokenSchema,
  codeWord: activationCodeSchema.optional(),
  password: strongPasswordSchema.optional(),
});

function insertSelfAudit(context: AppContext, userId: string, action: string): void {
  context.db.prepare(`
    INSERT INTO audit_log (id, actor_id, action, target_type, target_id, metadata_json, created_at)
    VALUES (?, ?, ?, 'user', ?, '{}', ?)
  `).run(newId(), userId, action, userId, nowIso());
}

function finishLogin(
  context: AppContext,
  req: Request,
  res: Response,
  user: StoredUserRow,
  existingSession?: ReturnType<typeof createSession>,
): Response {
  const session = existingSession ?? createSession(context, user, req);
  setSessionCookie(res, context, session.token);
  res.setHeader("Cache-Control", "no-store");
  return res.json({ user: toAuthUser({ ...user, last_login_at: nowIso() }), csrfToken: session.csrfToken });
}

export function createAuthRouter(context: AppContext): Router {
  const router = Router();
  const rateLimits = new AuthRateLimitStore(context.db, context.config.authLookupKey);
  const loginIpLimiter = authIpRateLimit(rateLimits, "login");
  const activationIpLimiter = authIpRateLimit(rateLimits, "activation");
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/me", requireAuth(), (_req, res) => {
    const auth = currentAuth(res);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      user: auth.user,
      csrfToken: csrfForSession(context.config.authLookupKey, auth.rawSessionToken),
    });
  });

  router.post("/login/student", loginIpLimiter, async (req, res, next) => {
    try {
      const body = parseBody(studentLoginSchema, req.body);
      const loginName = body.loginName ?? body.name ?? "";
      const codeWord = body.codeWord;
      const accountSubject = `student\0${loginName}`;
      const accountLimit = rateLimits.consume(
        "login_account",
        accountSubject,
        AUTH_RATE_LIMIT_POLICIES.loginAccount,
      );
      if (!accountLimit.allowed) {
        sendAuthRateLimitResponse(res, accountLimit);
        return;
      }
      const lookup = studentCredentialLookup(context.config.authLookupKey, loginName, codeWord);
      const user = context.db.prepare(`
        SELECT * FROM users WHERE role = 'student' AND status = 'active' AND credential_lookup = ?
      `).get(lookup) as StoredUserRow | undefined;
      const validSecret = await verifyPassword(codeWord, user?.password_hash ?? context.dummyPasswordHash);
      if (!user?.password_hash || !validSecret) {
        throw new HttpError(401, "Неверное имя или кодовое слово");
      }
      const committedLogin = context.db.transaction(() => {
        const authenticatedUser = context.db.prepare(`
            SELECT * FROM users
            WHERE id = ? AND role = 'student' AND status = 'active'
              AND credential_lookup = ? AND password_hash = ?
          `).get(user.id, lookup, user.password_hash) as StoredUserRow | undefined;
        if (!authenticatedUser) {
          throw new HttpError(401, "Неверное имя или кодовое слово");
        }
        rateLimits.reset("login_account", accountSubject);
        insertSelfAudit(context, authenticatedUser.id, "auth.login");
        return {
          user: authenticatedUser,
          session: createSession(context, authenticatedUser, req),
        };
      }).immediate();
      finishLogin(
        context,
        req,
        res,
        committedLogin.user,
        committedLogin.session,
      );
    } catch (error) {
      next(error);
    }
  });

  router.post("/login/staff", loginIpLimiter, async (req, res, next) => {
    try {
      const body = parseBody(staffLoginSchema, req.body);
      const accountSubject = `staff\0${body.loginName}`;
      const accountLimit = rateLimits.consume(
        "login_account",
        accountSubject,
        AUTH_RATE_LIMIT_POLICIES.loginAccount,
      );
      if (!accountLimit.allowed) {
        sendAuthRateLimitResponse(res, accountLimit);
        return;
      }
      const user = context.db.prepare(`
        SELECT * FROM users
        WHERE role IN ('admin', 'tutor') AND status = 'active' AND login_name_normalized = ?
      `).get(body.loginName) as StoredUserRow | undefined;
      const validSecret = await verifyPassword(body.password, user?.password_hash ?? context.dummyPasswordHash);
      if (!user?.password_hash || !validSecret) {
        throw new HttpError(401, "Неверный логин или пароль");
      }
      const committedLogin = context.db.transaction(() => {
        const authenticatedUser = context.db.prepare(`
            SELECT * FROM users
            WHERE id = ? AND role IN ('admin', 'tutor') AND status = 'active'
              AND login_name_normalized = ? AND password_hash = ?
          `).get(user.id, body.loginName, user.password_hash) as StoredUserRow | undefined;
        if (!authenticatedUser) {
          throw new HttpError(401, "Неверный логин или пароль");
        }
        rateLimits.reset("login_account", accountSubject);
        insertSelfAudit(context, authenticatedUser.id, "auth.login");
        return {
          user: authenticatedUser,
          session: createSession(context, authenticatedUser, req),
        };
      }).immediate();
      finishLogin(
        context,
        req,
        res,
        committedLogin.user,
        committedLogin.session,
      );
    } catch (error) {
      next(error);
    }
  });

  router.post("/activate/preview", activationIpLimiter, (req, res, next) => {
    try {
      const { token } = parseBody(z.object({ token: tokenSchema }), req.body);
      const tokenLimit = rateLimits.consume(
        "activation_token",
        token,
        AUTH_RATE_LIMIT_POLICIES.activationToken,
      );
      if (!tokenLimit.allowed) {
        sendAuthRateLimitResponse(res, tokenLimit);
        return;
      }
      const invite = findUsableInvite(context, token);
      if (!invite) throw new HttpError(410, "Приглашение недействительно или истекло");
      const target = context.db.prepare(`
        SELECT u.*, tutor.display_name AS tutor_name
        FROM users u LEFT JOIN users tutor ON tutor.id = u.tutor_id
        WHERE u.id = ?
      `).get(invite.target_user_id) as (StoredUserRow & { tutor_name: string | null }) | undefined;
      if (!target || target.status === "suspended") throw new HttpError(410, "Приглашение недействительно или истекло");
      res.setHeader("Cache-Control", "no-store");
      res.json({
        invite: {
          displayName: target.display_name,
          loginName: target.login_name,
          role: target.role,
          tutorName: target.tutor_name,
          purpose: invite.purpose,
          expiresAt: invite.expires_at,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/activate", activationIpLimiter, (req, res, next) => {
    try {
      const body = parseBody(activationSchema, req.body);
      const tokenLimit = rateLimits.consume(
        "activation_token",
        body.token,
        AUTH_RATE_LIMIT_POLICIES.activationToken,
      );
      if (!tokenLimit.allowed) {
        sendAuthRateLimitResponse(res, tokenLimit);
        return;
      }
      const activate = context.db.transaction((): StoredUserRow => {
        const invite = findUsableInvite(context, body.token) as InviteRow | undefined;
        if (!invite) throw new HttpError(410, "Приглашение недействительно или истекло");
        const user = context.db.prepare("SELECT * FROM users WHERE id = ?").get(invite.target_user_id) as StoredUserRow | undefined;
        if (!user || user.status === "suspended") throw new HttpError(410, "Приглашение недействительно или истекло");

        const now = nowIso();
        if (user.role === "student") {
          if (!body.codeWord) throw new HttpError(400, "Задайте кодовое слово", { codeWord: ["Обязательное поле"] });
          const codeWord = body.codeWord;
          const loginName = user.login_name ?? user.display_name;
          const codeIssue = newStudentSecretIssue(codeWord, loginName);
          if (codeIssue) {
            throw new HttpError(400, "Некорректные данные", { codeWord: [codeIssue] });
          }
          const lookup = studentCredentialLookup(context.config.authLookupKey, loginName, codeWord);
          const collision = context.db.prepare("SELECT id FROM users WHERE credential_lookup = ? AND id != ?")
            .get(lookup, user.id) as { id: string } | undefined;
          if (collision) throw new HttpError(409, "Такое сочетание имени и кодового слова уже используется");
          context.db.prepare(`
            UPDATE users
            SET status = 'active', credential_lookup = ?, password_hash = ?, updated_at = ?
            WHERE id = ?
          `).run(lookup, hashPassword(codeWord, context.config.bcryptRounds), now, user.id);
        } else {
          if (!body.password) throw new HttpError(400, "Задайте пароль", { password: ["Минимум 12 символов"] });
          context.db.prepare(`
            UPDATE users SET status = 'active', password_hash = ?, updated_at = ? WHERE id = ?
          `).run(hashPassword(body.password, context.config.bcryptRounds), now, user.id);
        }
        context.db.prepare("UPDATE invites SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
          .run(now, invite.id);
        persistUserAccessRevocation(context, user.id, { timestamp: now });
        return context.db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as StoredUserRow;
      });

      const user = activate();
      completeUserAccessRevocation(context, user.id);
      rateLimits.reset("activation_token", body.token);
      insertSelfAudit(context, user.id, "auth.activated");
      finishLogin(context, req, res, user);
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", requireAuth(), requireCsrf(context), (req, res) => {
    const auth = getAuth(res);
    if (auth) {
      insertSelfAudit(context, auth.user.id, "auth.logout");
      context.db.prepare("DELETE FROM sessions WHERE session_hash = ?").run(auth.sessionHash);
      context.disconnectSessionSockets?.(auth.sessionHash);
    }
    clearSessionCookie(res, context);
    res.sendStatus(204);
  });

  router.post("/change-secret", requireAuth(), requireCsrf(context), async (req, res, next) => {
    try {
      const auth = currentAuth(res);
      const newSecretSchema = auth.user.role === "student"
        ? activationCodeSchema
        : strongPasswordSchema;
      const body = parseBody(z.object({
        currentSecret: z.string().min(1).max(256),
        newSecret: newSecretSchema,
      }), req.body);
      let user = context.db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(auth.user.id) as StoredUserRow | undefined;
      if (!user?.password_hash) throw new HttpError(401, "Текущий секрет неверен");
      const currentSecret = user.role === "student" ? normalizeCodeWord(body.currentSecret) : body.currentSecret;
      if (!(await verifyPassword(currentSecret, user.password_hash))) throw new HttpError(401, "Текущий секрет неверен");
      user = context.db.prepare(`
        SELECT u.* FROM users u
        JOIN sessions s ON s.user_id = u.id
        WHERE u.id = ? AND u.status = 'active' AND u.password_hash = ?
          AND s.session_hash = ? AND s.expires_at > ?
      `).get(user.id, user.password_hash, auth.sessionHash, nowIso()) as StoredUserRow | undefined;
      if (!user) throw new HttpError(401, "Текущий секрет неверен");

      const now = nowIso();
      let nextCredentialLookup: string | null = null;
      let nextSecret: string;
      if (user.role === "student") {
        const newSecret = normalizeCodeWord(body.newSecret);
        nextSecret = newSecret;
        const codeIssue = newStudentSecretIssue(
          newSecret,
          user.login_name ?? user.display_name,
        );
        if (codeIssue) {
          throw new HttpError(400, "Некорректные данные", { newSecret: [codeIssue] });
        }
        const lookup = studentCredentialLookup(
          context.config.authLookupKey,
          user.login_name ?? user.display_name,
          newSecret,
        );
        const collision = context.db.prepare("SELECT id FROM users WHERE credential_lookup = ? AND id != ?")
          .get(lookup, user.id) as { id: string } | undefined;
        if (collision) throw new HttpError(409, "Такое сочетание имени и кодового слова уже используется");
        nextCredentialLookup = lookup;
      } else {
        nextSecret = body.newSecret;
      }
      const nextPasswordHash = hashPassword(
        nextSecret,
        context.config.bcryptRounds,
      );
      const changed = context.db.transaction(() => {
        const update = user.role === "student"
          ? context.db.prepare(`
              UPDATE users
              SET credential_lookup = ?, password_hash = ?, updated_at = ?
              WHERE id = ? AND status = 'active' AND password_hash = ?
            `).run(
              nextCredentialLookup,
              nextPasswordHash,
              now,
              user.id,
              user.password_hash,
            )
          : context.db.prepare(`
              UPDATE users SET password_hash = ?, updated_at = ?
              WHERE id = ? AND status = 'active' AND password_hash = ?
            `).run(nextPasswordHash, now, user.id, user.password_hash);
        if (update.changes !== 1) {
          throw new HttpError(401, "Текущий секрет неверен");
        }
        context.db.prepare(`
          INSERT INTO audit_log (id, actor_id, action, target_type, target_id, metadata_json, ip_address, created_at)
          VALUES (?, ?, 'auth.secret_changed', 'user', ?, '{}', ?, ?)
        `).run(newId(), user.id, user.id, req.ip || null, now);
        persistUserAccessRevocation(context, user.id, { timestamp: now });
        const updated = context.db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as StoredUserRow;
        return {
          updated,
          session: createSession(context, updated, req),
        };
      }).immediate();
      completeUserAccessRevocation(context, user.id);
      const { updated, session } = changed;
      setSessionCookie(res, context, session.token);
      res.setHeader("Cache-Control", "no-store");
      res.json({ user: toAuthUser(updated), csrfToken: session.csrfToken });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
