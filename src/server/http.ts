import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError, type ZodType } from "zod";
import type { AppContext, AuthContext, Role } from "./types.js";
import { csrfForSession, getAuth, safeEqual } from "./security.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: Record<string, string[]>,
  ) {
    super(message);
  }
}

export function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw validationError(result.error);
}

export function validationError(error: ZodError): HttpError {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "body";
    (details[key] ??= []).push(issue.message);
  }
  return new HttpError(400, "Некорректные данные", details);
}

export function requireAuth(...roles: Role[]): RequestHandler {
  return (_req, res, next) => {
    const auth = getAuth(res);
    if (!auth) return next(new HttpError(401, "Требуется вход"));
    if (roles.length > 0 && !roles.includes(auth.user.role)) {
      return next(new HttpError(403, "Недостаточно прав"));
    }
    next();
  };
}

export function requireCsrf(context: AppContext): RequestHandler {
  return (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const auth = getAuth(res);
    if (!auth) return next(new HttpError(401, "Требуется вход"));
    const actual = req.get("x-csrf-token") ?? "";
    const expected = csrfForSession(context.config.authLookupKey, auth.rawSessionToken);
    if (!actual || !safeEqual(actual, expected)) return next(new HttpError(403, "CSRF token is invalid"));
    next();
  };
}

export function currentAuth(res: Response): AuthContext {
  const auth = getAuth(res);
  if (!auth) throw new HttpError(401, "Требуется вход");
  return auth;
}

export function originAndCors(context: AppContext): RequestHandler {
  const allowed = new Set(context.config.appOrigins);
  return (req, res, next) => {
    const origin = req.get("origin");
    if (origin && allowed.has(origin.replace(/\/$/, ""))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, X-CSRF-Token, X-Upload-Offset, X-Asset-Chunk-Sha256, X-Chunk-Sha256",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
      res.setHeader("Vary", "Origin");
    }
    if (origin && !allowed.has(origin.replace(/\/$/, ""))) {
      return next(new HttpError(403, "Origin is not allowed"));
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  };
}

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(new HttpError(404, "Маршрут не найден"));
}

function isSqliteConstraint(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("SQLITE_CONSTRAINT");
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, ...(error.details ? { details: error.details } : {}) });
    return;
  }
  if (error instanceof ZodError) {
    const validation = validationError(error);
    res.status(validation.status).json({ error: validation.message, details: validation.details });
    return;
  }
  if (isSqliteConstraint(error)) {
    res.status(409).json({ error: "Запись с такими данными уже существует" });
    return;
  }
  if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "LIMIT_FILE_SIZE") {
    res.status(413).json({ error: "Файл превышает допустимый размер" });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "Внутренняя ошибка сервера" });
}

export function asOptionalIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new HttpError(400, "Некорректная дата");
  return date.toISOString();
}

export function pagination(req: Request, maxLimit = 100): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), maxLimit);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  return { limit, offset };
}
