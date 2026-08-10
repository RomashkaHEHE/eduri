import express, {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { HttpError, parseBody } from "../http.js";
import type { AppContext } from "../types.js";
import {
  CODE_BLOB_LIMITS,
  CodeBlobError,
  type CodeBlobErrorCode,
} from "./service.js";

const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const beginSchema = z.object({
  sha256: z.string().regex(SHA256_PATTERN),
  byteSize: z.number().int().positive().max(CODE_BLOB_LIMITS.maxBlobBytes),
  mimeType: z.string().trim().min(3).max(255),
}).strict();

type AsyncRoute = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void>;

function errorStatus(code: CodeBlobErrorCode): number {
  switch (code) {
    case "INVALID_ARGUMENT": return 400;
    case "ROOM_EXPIRED":
    case "UPLOAD_EXPIRED": return 410;
    case "NOT_FOUND": return 404;
    case "BLOB_TOO_LARGE":
    case "CHUNK_TOO_LARGE":
    case "QUOTA_EXCEEDED": return 413;
    case "IDENTITY_CONFLICT":
    case "OFFSET_MISMATCH":
    case "UPLOAD_INCOMPLETE":
    case "HASH_MISMATCH": return 409;
    case "MALWARE_DETECTED": return 422;
    case "DISK_PRESSURE":
    case "MALWARE_SCAN_UNAVAILABLE":
    case "STORAGE_ERROR": return 503;
    case "STORAGE_CORRUPT": return 500;
  }
}

function writeError(
  error: unknown,
  res: Response,
  next: NextFunction,
): void {
  if (error instanceof CodeBlobError) {
    res.setHeader("Cache-Control", "no-store");
    res.status(errorStatus(error.code)).json({
      code: error.code,
      error: error.message,
      retryable: error.retryable,
    });
    return;
  }
  next(error);
}

function asyncRoute(handler: AsyncRoute): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch((error) => writeError(error, res, next));
  };
}

function requireSameOrigin(context: AppContext): RequestHandler {
  const allowed = new Set(context.config.appOrigins.map((origin) => (
    origin.replace(/\/$/u, "")
  )));
  return (req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      next();
      return;
    }
    const origin = req.get("origin")?.replace(/\/$/u, "");
    if (!origin || !allowed.has(origin)) {
      next(new HttpError(403, "Guest Code blobs require an allowed Origin"));
      return;
    }
    next();
  };
}

function shareId(req: Request): string {
  const value = req.params.shareKey;
  if (!SHARE_ID_PATTERN.test(value)) {
    throw new CodeBlobError("NOT_FOUND", "Guest Code workspace was not found");
  }
  return value;
}

function hash(req: Request): string {
  const value = req.params.sha256;
  if (!SHA256_PATTERN.test(value)) {
    throw new CodeBlobError("INVALID_ARGUMENT", "Code blob hash is invalid");
  }
  return value;
}

export function createGuestCodeBlobsRouter(context: AppContext): Router {
  const router = Router({ mergeParams: true });
  const service = context.codeBlobs;
  if (!service) return router;
  const readLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: context.config.nodeEnv === "test" ? 10_000 : 1_200,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  const writeLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: context.config.nodeEnv === "test" ? 10_000 : 2_500,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });

  router.use(requireSameOrigin(context));
  router.use(readLimiter);

  router.post("/begin", writeLimiter, asyncRoute(async (req, res) => {
    const result = await service.beginUpload(
      shareId(req),
      parseBody(beginSchema, req.body),
    );
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  }));

  router.put(
    "/uploads/:uploadId/chunks",
    writeLimiter,
    express.raw({
      type: "application/octet-stream",
      limit: CODE_BLOB_LIMITS.maxChunkBytes,
    }),
    asyncRoute(async (req, res) => {
      if (!req.is("application/octet-stream") || !Buffer.isBuffer(req.body)) {
        throw new HttpError(415, "Code blob chunks require application/octet-stream");
      }
      const offset = Number(req.get("x-upload-offset"));
      const result = await service.writeChunk(shareId(req), {
        uploadId: req.params.uploadId,
        offset,
        chunk: req.body,
        chunkSha256: req.get("x-chunk-sha256") ?? "",
      });
      res.setHeader("Cache-Control", "no-store");
      res.json(result);
    }),
  );

  router.post(
    "/uploads/:uploadId/finalize",
    writeLimiter,
    asyncRoute(async (req, res) => {
      const result = await service.finalizeUpload(
        shareId(req),
        req.params.uploadId,
      );
      res.setHeader("Cache-Control", "no-store");
      res.json(result);
    }),
  );

  router.get("/:sha256/status", asyncRoute(async (req, res) => {
    const result = await service.status(shareId(req), hash(req));
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  }));

  router.get("/:sha256/content", asyncRoute(async (req, res) => {
    const download = await service.download(shareId(req), hash(req));
    for (const [name, value] of Object.entries(download.headers)) {
      res.setHeader(name, value);
    }
    download.stream.once("error", () => res.destroy());
    download.stream.pipe(res);
  }));

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (
      typeof error === "object"
      && error !== null
      && "type" in error
      && error.type === "entity.too.large"
    ) {
      res.status(413).json({
        code: "CHUNK_TOO_LARGE",
        error: "Code blob chunk exceeds the configured limit",
        retryable: false,
      });
      return;
    }
    next(error);
  });
  return router;
}
