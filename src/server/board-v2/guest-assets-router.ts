import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";

import { HttpError } from "../http.js";
import type {
  AppContext,
  GuestBoardAssetPrincipal,
} from "../types.js";
import { createBoardAssetOperationsRouter } from "./assets-router.js";

const SHARE_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function requireSameOrigin(context: AppContext): RequestHandler {
  const allowedOrigins = new Set(context.config.appOrigins.map((origin) => (
    origin.replace(/\/$/u, "")
  )));
  return (req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      next();
      return;
    }
    const origin = req.get("origin")?.replace(/\/$/u, "");
    if (!origin || !allowedOrigins.has(origin)) {
      next(new HttpError(403, "Guest Board assets require an allowed Origin"));
      return;
    }
    next();
  };
}

function requireActiveBoardCapability(context: AppContext): RequestHandler {
  return (req, res, next) => {
    const shareKey = req.params.shareKey;
    if (!SHARE_KEY_PATTERN.test(shareKey)) {
      res.status(404).json({
        code: "ROOM_NOT_FOUND",
        error: "Guest room was not found",
      });
      return;
    }
    const lookup = context.guestRooms.lookup(shareKey);
    if (lookup.status === "expired") {
      res.setHeader("Cache-Control", "no-store");
      res.status(410).json({
        code: "ROOM_EXPIRED",
        error: "Guest room has expired",
      });
      return;
    }
    if (lookup.status === "missing") {
      res.setHeader("Cache-Control", "no-store");
      res.status(404).json({
        code: "ROOM_NOT_FOUND",
        error: "Guest room was not found",
      });
      return;
    }
    const boardResource = lookup.room.resources.find((resource) => (
      resource.kind === "board" && resource.ordinal === 1
    ));
    if (!boardResource) {
      res.setHeader("Cache-Control", "no-store");
      res.status(404).json({
        code: "BOARD_NOT_FOUND",
        error: "Guest Board was not found",
      });
      return;
    }
    next();
  };
}

export function createGuestBoardAssetsRouter(context: AppContext): Router {
  const router = Router({ mergeParams: true });
  const service = context.boardAssets;
  if (!service) return router;

  const readLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: context.config.nodeEnv === "test" ? 10_000 : 1_200,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  const mutationLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: context.config.nodeEnv === "test" ? 10_000 : 2_500,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  router.use(requireSameOrigin(context));
  router.use(readLimiter);
  router.use(requireActiveBoardCapability(context));
  router.use(createBoardAssetOperationsRouter(context, {
    service,
    principal: (req): GuestBoardAssetPrincipal => ({
      kind: "guest-board",
      shareKey: req.params.shareKey,
    }),
    writeMiddleware: [mutationLimiter],
    includeMetrics: false,
  }));
  return router;
}
