import { Router, type NextFunction, type Response } from "express";
import { z } from "zod";

import { BOARD_PROTOCOL_LIMITS } from "../../board/protocol/index.js";
import {
  currentAuth,
  HttpError,
  parseBody,
  requireAuth,
  requireCsrf,
} from "../http.js";
import type { AppContext } from "../types.js";
import {
  BOARD_SYNC_SERVER_CAPABILITIES,
  BoardSyncServiceError,
} from "./sync-service.js";

const ticketRequestSchema = z.object({
  lessonId: z.string().uuid(),
  minSchemaVersion: z.number().int().min(1)
    .max(BOARD_PROTOCOL_LIMITS.maxSchemaVersion)
    .default(1),
  maxSchemaVersion: z.number().int().min(1)
    .max(BOARD_PROTOCOL_LIMITS.maxSchemaVersion)
    .default(1),
  capabilities: z.number().int().min(0).max(0xffff_ffff)
    .default(BOARD_SYNC_SERVER_CAPABILITIES),
}).strict().refine(
  (request) => request.minSchemaVersion <= request.maxSchemaVersion,
  {
    message: "Minimum schema version must not exceed maximum",
    path: ["minSchemaVersion"],
  },
);

const metricsQuerySchema = z.object({
  lessonId: z.string().uuid(),
}).strict();

interface BoardSyncHttpError {
  readonly status: number;
  readonly message: string;
}

function toHttpError(error: BoardSyncServiceError): BoardSyncHttpError {
  switch (error.code) {
    case "NOT_FOUND":
      return { status: 404, message: "Lesson was not found" };
    case "BOARD_GONE":
      return { status: 410, message: "Board no longer exists" };
    case "BOARD_NOT_V2":
      return { status: 409, message: error.message };
    case "PROTOCOL_MISMATCH":
      return { status: 426, message: error.message };
    case "SCHEMA_MISMATCH":
      return { status: 422, message: error.message };
    case "SESSION_REVOKED":
      return { status: 401, message: "Session is no longer active" };
    case "ACCESS_REVOKED":
      return { status: 403, message: "Board access was revoked" };
    case "RATE_LIMITED":
      return { status: 429, message: "Too many active Board sync tickets" };
    default:
      return { status: 500, message: "Board sync bootstrap failed" };
  }
}

function sendBoardSyncError(
  res: Response,
  error: BoardSyncServiceError,
): void {
  const mapped = toHttpError(error);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  if (error.retryAfterMs !== undefined) {
    res.setHeader(
      "Retry-After",
      String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))),
    );
  }
  res.status(mapped.status).json({
    code: error.code,
    error: mapped.message,
    ...(error.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: error.retryAfterMs }),
  });
}

function unavailableWhenDisabled(
  context: AppContext,
  res: Response,
  next: NextFunction,
  lessonId: string,
): void {
  const user = currentAuth(res).user;
  const lesson = context.db.prepare(`
    SELECT lesson.id
    FROM lessons lesson
    WHERE lesson.id = ?
      AND (
        (? = 'tutor' AND lesson.tutor_id = ?)
        OR (? = 'student' AND lesson.student_id = ?)
      )
  `).get(
    lessonId,
    user.role,
    user.id,
    user.role,
    user.id,
  ) as { id: string } | undefined;
  if (!lesson) {
    next(new HttpError(404, "Lesson was not found"));
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.status(503).json({
    code: "BOARD_V2_DISABLED",
    error: "Board is temporarily unavailable",
  });
}

export function createBoardSyncRouter(context: AppContext): Router {
  const router = Router();
  router.get(
    "/metrics",
    requireAuth("tutor", "student"),
    async (req, res, next) => {
      try {
        const parsed = parseBody(metricsQuerySchema, req.query);
        const service = context.boardV2Sync;
        if (!service) {
          unavailableWhenDisabled(context, res, next, parsed.lessonId);
          return;
        }
        const auth = currentAuth(res);
        const { board, metrics } = service.getAuthorizedMetrics(
          auth,
          parsed.lessonId,
        );
        const assetMetrics = context.boardAssets
          ? await context.boardAssets.getBoardMetrics(auth, {
              boardId: board.id,
              generation: board.generation,
            })
          : {
              assetCount: 0,
              logicalBytes: 0,
              readyCount: 0,
              readyBytes: 0,
              physicalBlobCount: 0,
              physicalBlobBytes: 0,
              pendingCount: 0,
            };
        const compactedAt = metrics.documents
          .map((document) => document.compactedAt)
          .filter((value): value is string => value !== null)
          .sort()
          .at(-1) ?? null;
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Pragma", "no-cache");
        res.json({
          boardId: board.id,
          generation: board.generation,
          documentCount: metrics.documentCount,
          snapshotBytes: metrics.snapshotBytes,
          stateVectorBytes: metrics.stateVectorBytes,
          updateLogCount: metrics.updateLogCount,
          updateLogBytes: metrics.updateLogBytes,
          idempotencyReceiptCount: metrics.idempotencyReceiptCount,
          idempotencyReceiptBytes: metrics.idempotencyReceiptBytes,
          storageMetadataBytes: metrics.storageMetadataBytes,
          quotaBytes: metrics.quotaBytes,
          assetCount: assetMetrics.assetCount,
          assetBytes: assetMetrics.logicalBytes,
          readyAssetCount: assetMetrics.readyCount,
          readyAssetBytes: assetMetrics.readyBytes,
          pendingAssetCount: assetMetrics.pendingCount,
          physicalAssetCount: assetMetrics.physicalBlobCount,
          physicalAssetBytes: assetMetrics.physicalBlobBytes,
          logicalBytes: metrics.totalBytes + assetMetrics.logicalBytes,
          physicalBytes: metrics.totalBytes + assetMetrics.physicalBlobBytes,
          compactedAt,
          measuredAt: new Date().toISOString(),
        });
      } catch (error) {
        if (error instanceof BoardSyncServiceError) {
          sendBoardSyncError(res, error);
          return;
        }
        next(error);
      }
    },
  );
  router.post(
    "/sync-ticket",
    requireAuth("tutor", "student"),
    requireCsrf(context),
    (req, res, next) => {
      try {
        const parsed = parseBody(ticketRequestSchema, req.body);
        const service = context.boardV2Sync;
        if (!service) {
          unavailableWhenDisabled(context, res, next, parsed.lessonId);
          return;
        }
        const ticket = service.issueTicket(currentAuth(res), {
          lessonId: parsed.lessonId,
          minSchemaVersion: parsed.minSchemaVersion ?? 1,
          maxSchemaVersion: parsed.maxSchemaVersion ?? 1,
          capabilities:
            parsed.capabilities ?? BOARD_SYNC_SERVER_CAPABILITIES,
        });
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Pragma", "no-cache");
        res.json(ticket);
      } catch (error) {
        if (error instanceof BoardSyncServiceError) {
          sendBoardSyncError(res, error);
          return;
        }
        next(error);
      }
    },
  );
  return router;
}
