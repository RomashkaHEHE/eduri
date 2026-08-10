import express, {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import {
  currentAuth,
  HttpError,
  parseBody,
  requireAuth,
  requireCsrf,
} from "../http.js";
import type { AppContext } from "../types.js";
import {
  AssetServiceError,
  type AssetServiceErrorCode,
  type BoardAssetService,
} from "./assets.js";
import { BoardSyncServiceError } from "./sync-service.js";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u);
const generation = z.coerce.number().int().positive();
const boardScopeSchema = z.object({
  boardId: id,
  generation,
}).strict();
const beginSchema = boardScopeSchema.extend({
  assetId: id,
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  byteSize: z.number().int().positive(),
  declaredMime: z.string().min(3).max(255),
  originalFileName: z.string().max(255).nullable().optional(),
  preferredChunkBytes: z.number().int().positive().optional(),
}).strict();
const finalizeSchema = boardScopeSchema;
const offsetSchema = z.coerce.number().int().nonnegative();
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

type AsyncRoute = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void>;

function asyncRoute(handler: AsyncRoute) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res, next).catch((error: unknown) => {
      writeAssetError(error, res, next);
    });
  };
}

function assetStatus(code: AssetServiceErrorCode): number {
  switch (code) {
    case "INVALID_ARGUMENT":
      return 400;
    case "ASSET_TOO_LARGE":
    case "CHUNK_TOO_LARGE":
    case "TENANT_QUOTA":
      return 413;
    case "NOT_FOUND":
      return 404;
    case "ROOM_EXPIRED":
    case "UPLOAD_EXPIRED":
    case "UPLOAD_GONE":
      return 410;
    case "ASSET_ID_CONFLICT":
    case "CHUNK_HASH_MISMATCH":
    case "OFFSET_MISMATCH":
    case "UPLOAD_INCOMPLETE":
    case "HASH_MISMATCH":
    case "MIME_MISMATCH":
      return 409;
    case "SVG_REJECTED":
    case "UNSUPPORTED_MEDIA_TYPE":
    case "MALFORMED_IMAGE":
    case "DIMENSION_LIMIT":
    case "DECODE_FAILED":
      return 422;
    case "DISK_PRESSURE":
    case "STORAGE_ERROR":
      return 503;
    case "STORAGE_CORRUPT":
      return 500;
    case "RANGE_NOT_SATISFIABLE":
      return 416;
  }
}

function writeAssetError(
  error: unknown,
  res: Response,
  next: NextFunction,
): void {
  if (error instanceof AssetServiceError) {
    const status = assetStatus(error.code);
    if (error.retryAfterMs !== undefined) {
      res.setHeader(
        "Retry-After",
        String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))),
      );
    }
    res.status(status).json({
      code: error.code,
      error: error.message,
      retryable: error.retryable,
      ...(error.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: error.retryAfterMs }),
    });
    return;
  }
  if (error instanceof BoardSyncServiceError) {
    switch (error.code) {
      case "SESSION_REVOKED":
        next(new HttpError(401, "Session is no longer active"));
        return;
      case "READ_ONLY":
        next(new HttpError(403, "Board is read-only"));
        return;
      case "BOARD_GONE":
        next(new HttpError(410, "Board no longer exists"));
        return;
      case "STORAGE_ERROR":
        next(new HttpError(503, "Board storage is unavailable"));
        return;
      default:
        // Do not disclose whether another tenant's board or generation exists.
        next(new HttpError(404, "Asset was not found"));
        return;
    }
  }
  next(error);
}

function parseScope(req: Request): { boardId: string; generation: number } {
  return parseBody(boardScopeSchema, {
    boardId: req.query.boardId,
    generation: req.query.generation,
  });
}

export interface BoardAssetOperationsRouterOptions<TPrincipal> {
  service: BoardAssetService<TPrincipal>;
  principal: (req: Request, res: Response) => TPrincipal;
  writeMiddleware?: readonly RequestHandler[];
  includeMetrics?: boolean;
}

export function createBoardAssetOperationsRouter<TPrincipal>(
  context: AppContext,
  options: BoardAssetOperationsRouterOptions<TPrincipal>,
): Router {
  const router = Router({ mergeParams: true });
  const service = options.service;
  const writeMiddleware = options.writeMiddleware ?? [];

  router.post(
    "/begin",
    ...writeMiddleware,
    asyncRoute(async (req, res) => {
      const input = parseBody(beginSchema, req.body);
      const result = await service.beginUpload(options.principal(req, res), {
        ...input,
        originalFileName: input.originalFileName ?? undefined,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json(result);
    }),
  );

  router.put(
    "/:assetId/uploads/:uploadId/chunks",
    ...writeMiddleware,
    express.raw({
      type: "application/octet-stream",
      limit: context.config.boardAssetMaxChunkBytes,
    }),
    asyncRoute(async (req, res) => {
      if (!req.is("application/octet-stream") || !Buffer.isBuffer(req.body)) {
        throw new HttpError(
          415,
          "Asset chunks require application/octet-stream",
        );
      }
      if (req.body.byteLength < 1) {
        throw new HttpError(400, "Asset chunk cannot be empty");
      }
      const scope = parseScope(req);
      const chunkSha256 = req.get("x-asset-chunk-sha256") ?? "";
      if (!SHA256_PATTERN.test(chunkSha256)) {
        throw new HttpError(400, "x-asset-chunk-sha256 is invalid");
      }
      const offset = parseBody(offsetSchema, req.get("x-upload-offset"));
      const result = await service.writeChunk(options.principal(req, res), {
        ...scope,
        assetId: parseBody(id, req.params.assetId),
        uploadId: parseBody(id, req.params.uploadId),
        offset,
        chunk: req.body,
        chunkSha256,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json(result);
    }),
  );

  router.post(
    "/:assetId/uploads/:uploadId/finalize",
    ...writeMiddleware,
    asyncRoute(async (req, res) => {
      const scope = parseBody(finalizeSchema, req.body);
      const result = await service.finalizeUpload(options.principal(req, res), {
        ...scope,
        assetId: parseBody(id, req.params.assetId),
        uploadId: parseBody(id, req.params.uploadId),
      });
      res.setHeader("Cache-Control", "no-store");
      res.json(result.asset);
    }),
  );

  if (options.includeMetrics !== false) {
    router.get(
      "/metrics",
      asyncRoute(async (req, res) => {
        const result = await service.getBoardMetrics(
          options.principal(req, res),
          parseScope(req),
        );
        res.setHeader("Cache-Control", "no-store");
        res.json(result);
      }),
    );
  }

  router.get(
    "/:assetId/status",
    asyncRoute(async (req, res) => {
      const result = await service.getStatus(options.principal(req, res), {
        ...parseScope(req),
        assetId: parseBody(id, req.params.assetId),
      });
      res.setHeader("Cache-Control", "no-store");
      res.json(result);
    }),
  );

  router.get(
    "/:assetId/content",
    asyncRoute(async (req, res) => {
      const download = await service.openDownload(
        options.principal(req, res),
        {
          ...parseScope(req),
          assetId: parseBody(id, req.params.assetId),
        },
        req.get("range"),
      );
      res.status(download.statusCode);
      for (const [name, value] of Object.entries(download.headers)) {
        res.setHeader(name, value);
      }
      download.stream.once("error", () => res.destroy());
      download.stream.pipe(res);
    }),
  );

  router.use((
    error: unknown,
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (
      typeof error === "object"
      && error !== null
      && "type" in error
      && error.type === "entity.too.large"
    ) {
      res.status(413).json({
        code: "CHUNK_TOO_LARGE",
        error: "Asset chunk exceeds the configured limit",
        retryable: false,
      });
      return;
    }
    next(error);
  });

  return router;
}

export function createBoardAssetsRouter(context: AppContext): Router {
  const router = Router();
  const service = context.boardAssets;
  if (!service) return router;
  const mutationLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: context.config.nodeEnv === "test" ? 10_000 : 600,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (_req, res) => currentAuth(res).user.id,
  });
  router.use(requireAuth("tutor", "student"));
  router.use(createBoardAssetOperationsRouter(context, {
    service,
    principal: (_req, res) => currentAuth(res),
    writeMiddleware: [requireCsrf(context), mutationLimiter],
    includeMetrics: true,
  }));
  return router;
}
