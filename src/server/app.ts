import fs from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import type Database from "better-sqlite3";
import { loadConfig, type AppConfigOverrides } from "./config.js";
import { bootstrapAdmin, cleanupExpiredSecurityRecords, migrate, openDatabase } from "./db.js";
import type {
  AppContext,
  BoardAssetPrincipal,
} from "./types.js";
import { authMiddleware, hashPassword, randomToken } from "./security.js";
import { errorHandler, notFoundHandler, originAndCors } from "./http.js";
import { createAuthRouter } from "./routes/auth.js";
import { createAuditRouter, createTutorsRouter } from "./routes/tutors.js";
import { createStudentsRouter } from "./routes/students.js";
import { createLessonsRouter } from "./routes/lessons.js";
import { createMaterialsRouter } from "./routes/materials.js";
import { createAssignmentsRouter } from "./routes/assignments.js";
import { createDashboardRouter } from "./routes/dashboard.js";
import {
  createLiveKitRoomService,
  pollGuestCallPresence,
  type LiveKitRoomService,
} from "./livekit.js";
import {
  LIVEKIT_REVOCATION_BASE_BACKOFF_MS,
  LIVEKIT_REVOCATION_BATCH_SIZE,
  processLiveKitRoomRevocations,
} from "./livekit-revocation.js";
import { BoardSyncService } from "./board-v2/sync-service.js";
import { createBoardSyncRouter } from "./board-v2/sync-router.js";
import {
  AssetServiceError,
  BoardAssetService,
  type AssetAccessOperation,
} from "./board-v2/assets.js";
import { createBoardAssetsRouter } from "./board-v2/assets-router.js";
import { createGuestBoardAssetsRouter } from "./board-v2/guest-assets-router.js";
import { decodeBoardAssetWithSharp } from "./board-v2/assetsDecode.js";
import {
  GuestRoomService,
  guestBoardAssetTenantId,
} from "./guestRooms.js";
import { createGuestRoomsRouter } from "./routes/guestRooms.js";
import { CodeSyncRepository } from "./code-sync/repository.js";
import { CodeSyncService } from "./code-sync/service.js";
import { CodeBlobService } from "./code-blobs/service.js";
import { createGuestCodeBlobsRouter } from "./code-blobs/router.js";
import {
  ClamdMalwareScanner,
  UnavailableMalwareScanner,
  type MalwareScanner,
} from "./code-blobs/malwareScanner.js";
import {
  MATERIAL_FILE_LIMITS,
  MaterialFileService,
} from "./material-files/service.js";

const FRONTEND_REVALIDATED_FILES = new Set([
  "index.html",
  "sw.js",
  "sw-assets.js",
]);

export function frontendAssetNeedsRevalidation(filePath: string): boolean {
  return FRONTEND_REVALIDATED_FILES.has(path.basename(filePath));
}

export interface CreateAppOptions {
  config?: AppConfigOverrides;
  db?: Database.Database;
  codeBlobScanner?: MalwareScanner;
  livekitRoomService?: LiveKitRoomService;
}

const GUEST_ROOM_MAINTENANCE_INTERVAL_MS = 60 * 1_000;
const MATERIAL_FILE_MAINTENANCE_INTERVAL_MS = 60 * 1_000;
const LIVEKIT_REVOCATION_MAINTENANCE_INTERVAL_MS =
  LIVEKIT_REVOCATION_BASE_BACKOFF_MS;
const LIVEKIT_REVOCATION_MAX_BATCHES_PER_RUN = 4;

export function getAppContext(app: Express): AppContext {
  return app.locals.eduri as AppContext;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const config = loadConfig(options.config);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const db = options.db ?? openDatabase(config);
  if (options.db) {
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    migrate(db);
  }
  let context: AppContext;
  const guestRooms = new GuestRoomService(
    db,
    Date.now,
    (roomNames) => {
      if (roomNames.length === 0) return;
      void context.runLiveKitRevocationMaintenance?.().catch(() => {
        console.error("[livekit] durable guest revocation maintenance deferred");
      });
    },
  );
  const codeBlobScanner = options.codeBlobScanner ?? (
    config.codeBlobClamdHost
      ? new ClamdMalwareScanner({
        host: config.codeBlobClamdHost,
        port: config.codeBlobClamdPort,
        timeoutMs: config.codeBlobScanTimeoutMs,
        maxBytes: config.codeBlobScanMaxBytes,
      })
      : new UnavailableMalwareScanner(
        "Code blob malware scanning is not configured",
      )
  );
  const codeBlobs = new CodeBlobService({
    db,
    guestRooms,
    scanner: codeBlobScanner,
    storageRoot: path.join(config.dataDir, "code-blobs"),
    forbiddenPublicRoots: [path.resolve("public"), path.resolve("dist")],
    minFreeDiskBytes: config.boardAssetMinFreeDiskBytes,
  });
  const materialFiles = new MaterialFileService({
    db,
    scanner: codeBlobScanner,
    storageRoot: config.uploadDir,
    forbiddenPublicRoots: [path.resolve("public"), path.resolve("dist")],
    limits: {
      minFreeDiskBytes: Math.max(
        MATERIAL_FILE_LIMITS.minFreeDiskBytes,
        config.boardAssetMinFreeDiskBytes,
      ),
    },
  });
  context = {
    config,
    db,
    ownsDatabase: !options.db,
    dummyPasswordHash: hashPassword(randomToken(), config.bcryptRounds),
    livekitRoomService: options.livekitRoomService
      ?? createLiveKitRoomService(config),
    guestRooms,
    codeSync: new CodeSyncService(
      new CodeSyncRepository(db),
      guestRooms,
    ),
    codeBlobs,
    materialFiles,
  };
  void materialFiles.recoverInterruptedUploads().then((result) => {
    if (result.failed > 0) {
      console.error("[materials] interrupted upload cleanup incomplete", result);
    }
  }).catch((error) => {
    console.error("[materials] interrupted upload recovery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  const runMaterialFileMaintenance = (): void => {
    void materialFiles.cleanupExpiredUploads().then(() => (
      materialFiles.cleanupGarbage()
    )).then((result) => {
      if (result.failed > 0) {
        console.error("[materials] file cleanup incomplete", result);
      }
    }).catch((error) => {
      console.error("[materials] file maintenance failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  const materialFileMaintenanceTimer = setInterval(
    runMaterialFileMaintenance,
    MATERIAL_FILE_MAINTENANCE_INTERVAL_MS,
  );
  materialFileMaintenanceTimer.unref();
  context.stopMaterialFileMaintenance = () => {
    clearInterval(materialFileMaintenanceTimer);
    context.stopMaterialFileMaintenance = undefined;
  };
  const cleanupGuestRooms = (): void => {
    try {
      context.guestRooms.cleanupExpired();
      void context.codeBlobs?.cleanupGarbage().then((result) => {
        if (result.failed > 0) {
          console.error("[code-blobs] garbage cleanup incomplete", result);
        }
      }).catch((error) => {
        console.error("[code-blobs] garbage cleanup failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      void context.boardAssets?.cleanupGarbage().then((result) => {
        if (result.failed > 0) {
          console.error("[board-v2] asset garbage cleanup incomplete", result);
        }
      }).catch((error) => {
        console.error("[board-v2] asset garbage cleanup failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      console.error("[guest-rooms] cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  let guestRoomMaintenanceRun: Promise<void> | undefined;
  let liveKitRevocationRun: Promise<void> | undefined;
  let liveKitRevocationRequested = 0;
  let liveKitRevocationCompleted = 0;
  let guestRoomMaintenanceStopped = false;
  const startLiveKitRevocationWorker = (): void => {
    if (guestRoomMaintenanceStopped || liveKitRevocationRun) return;
    liveKitRevocationRun = (async () => {
      while (
        !guestRoomMaintenanceStopped
        && liveKitRevocationCompleted < liveKitRevocationRequested
      ) {
        const requestedGeneration = liveKitRevocationRequested;
        for (
          let batch = 0;
          batch < LIVEKIT_REVOCATION_MAX_BATCHES_PER_RUN;
          batch += 1
        ) {
          const result = await processLiveKitRoomRevocations(
            context.db,
            context.livekitRoomService,
          );
          if (result.selected < LIVEKIT_REVOCATION_BATCH_SIZE) break;
        }
        liveKitRevocationCompleted = requestedGeneration;
      }
    })().finally(() => {
      liveKitRevocationRun = undefined;
    });
  };
  const runLiveKitRevocationMaintenance = async (): Promise<void> => {
    if (guestRoomMaintenanceStopped) return;
    const requestedGeneration = ++liveKitRevocationRequested;
    while (
      !guestRoomMaintenanceStopped
      && liveKitRevocationCompleted < requestedGeneration
    ) {
      startLiveKitRevocationWorker();
      const activeRun = liveKitRevocationRun;
      if (!activeRun) return;
      await activeRun;
    }
  };
  context.runLiveKitRevocationMaintenance = runLiveKitRevocationMaintenance;
  const runGuestRoomMaintenance = (): Promise<void> => {
    if (guestRoomMaintenanceStopped) return Promise.resolve();
    if (guestRoomMaintenanceRun) return guestRoomMaintenanceRun;
      guestRoomMaintenanceRun = (async () => {
      try {
        await pollGuestCallPresence(
          context.guestRooms,
          context.livekitRoomService,
        );
        if (!guestRoomMaintenanceStopped) cleanupGuestRooms();
        if (!guestRoomMaintenanceStopped) {
          void runLiveKitRevocationMaintenance().catch(() => {
            console.error("[livekit] durable revocation maintenance deferred");
          });
        }
        if (!guestRoomMaintenanceStopped) {
          await context.codeBlobs?.cleanupExpiredUploads();
        }
      } catch (error) {
        console.error("[guest-rooms] maintenance failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        guestRoomMaintenanceRun = undefined;
      }
    })();
    return guestRoomMaintenanceRun;
  };
  context.runGuestRoomMaintenance = runGuestRoomMaintenance;
  const guestRoomCleanupTimer = setInterval(
    () => void runGuestRoomMaintenance(),
    GUEST_ROOM_MAINTENANCE_INTERVAL_MS,
  );
  guestRoomCleanupTimer.unref();
  const liveKitRevocationTimer = setInterval(
    () => void runLiveKitRevocationMaintenance().catch(() => {
      console.error("[livekit] durable revocation maintenance deferred");
    }),
    LIVEKIT_REVOCATION_MAINTENANCE_INTERVAL_MS,
  );
  liveKitRevocationTimer.unref();
  queueMicrotask(() => {
    void runLiveKitRevocationMaintenance().catch(() => {
      console.error("[livekit] durable revocation maintenance deferred");
    });
    void runGuestRoomMaintenance();
  });
  context.stopGuestRoomMaintenance = () => {
    guestRoomMaintenanceStopped = true;
    clearInterval(guestRoomCleanupTimer);
    clearInterval(liveKitRevocationTimer);
    context.runGuestRoomMaintenance = undefined;
    context.runLiveKitRevocationMaintenance = undefined;
    context.stopGuestRoomMaintenance = undefined;
  };
  if (config.boardV2FoundationEnabled) {
    context.boardV2Sync = new BoardSyncService(context);
    const writableAssetOperations = new Set<AssetAccessOperation>([
      "begin-upload",
      "write-chunk",
      "finalize-upload",
    ]);
    context.boardAssets = new BoardAssetService<BoardAssetPrincipal>({
      db,
      privateStorageRoot: config.boardAssetDir,
      forbiddenPublicRoots: [
        path.resolve("public"),
        path.resolve("dist"),
      ],
      limits: {
        maxAssetBytes: config.boardAssetMaxBytes,
        maxChunkBytes: config.boardAssetMaxChunkBytes,
        defaultChunkBytes: Math.min(
          config.boardAssetMaxChunkBytes,
          1024 * 1024,
        ),
        tenantSoftQuotaBytes: config.boardAssetTenantQuotaBytes,
        minFreeDiskBytes: config.boardAssetMinFreeDiskBytes,
      },
      decode: decodeBoardAssetWithSharp,
      authorize: (principal, request) => {
        if ("kind" in principal) {
          const lookup = context.guestRooms.lookup(principal.shareKey);
          if (lookup.status !== "active") {
            throw new AssetServiceError(
              "NOT_FOUND",
              "guest board asset capability is no longer active",
            );
          }
          const resource = lookup.room.resources.find((candidate) => (
            candidate.kind === "board" && candidate.ordinal === 1
          ));
          if (!resource) {
            throw new AssetServiceError(
              "NOT_FOUND",
              "guest board asset capability does not contain a board",
            );
          }
          const board = db.prepare(`
            SELECT board.id
            FROM boards board
            WHERE board.id = ?
              AND board.generation = ?
              AND board.room_resource_id = ?
              AND board.engine = 'v2'
              AND board.lifecycle = 'active'
          `).get(
            request.boardId,
            request.generation,
            resource.id,
          ) as { id: string } | undefined;
          if (!board) {
            throw new AssetServiceError(
              "NOT_FOUND",
              "guest board asset scope is unavailable",
            );
          }
          const assertPublicationActive = (): void => {
            if (!context.guestRooms.isResourceActive(
              lookup.room.id,
              resource.id,
              "board",
            )) {
              throw new AssetServiceError(
                "ROOM_EXPIRED",
                "guest room expired while publishing a Board asset",
              );
            }
          };
          return {
            tenantId: guestBoardAssetTenantId(lookup.room.id),
            actorId: `guest-board-${resource.id}`,
            assertPublicationActive,
            commitActivity: () => {
              if (!context.guestRooms.recordResourceMutation(
                lookup.room.id,
                resource.id,
              )) {
                throw new AssetServiceError(
                  "ROOM_EXPIRED",
                  "guest room expired while publishing a Board asset",
                );
              }
            },
          };
        }
        const access = context.boardV2Sync!.reauthorize(
          {
            boardId: request.boardId,
            generation: request.generation,
            userId: principal.user.id,
            sessionHash: principal.sessionHash,
          },
          writableAssetOperations.has(request.operation),
        );
        const tenant = db.prepare(`
          SELECT lesson.tutor_id
          FROM boards board
          JOIN lessons lesson ON lesson.id = board.lesson_id
          WHERE board.id = ?
            AND board.generation = ?
            AND lesson.id = ?
        `).get(
          access.boardId,
          access.generation,
          access.lessonId,
        ) as { tutor_id: string } | undefined;
        if (!tenant) {
          throw new AssetServiceError(
            "NOT_FOUND",
            "board asset tenant is unavailable",
          );
        }
        return {
          tenantId: tenant.tutor_id,
          actorId: access.userId,
        };
      },
      onEvent: (event) => context.emitBoardAssetReady?.(event),
    });
    const cleanupAssets = (): void => {
      void Promise.all([
        context.boardAssets!.cleanupExpiredUploads(),
        context.boardAssets!.cleanupGarbage(),
      ]).then(([, garbage]) => {
        if (garbage.failed > 0) {
          console.error("[board-v2] asset garbage cleanup incomplete", garbage);
        }
      }).catch((error) => {
        console.error("[board-v2] asset cleanup failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };
    cleanupAssets();
    const assetCleanupTimer = setInterval(
      cleanupAssets,
      15 * 60 * 1000,
    );
    assetCleanupTimer.unref();
    context.stopBoardAssetMaintenance = () => {
      clearInterval(assetCleanupTimer);
      context.stopBoardAssetMaintenance = undefined;
    };
  }
  bootstrapAdmin(context);
  cleanupExpiredSecurityRecords(context);

  const app = express();
  app.locals.eduri = context;
  app.set("trust proxy", config.trustProxy);
  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: { policy: "require-corp" },
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "same-origin" },
  }));
  app.use(originAndCors(context));
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false, limit: "256kb" }));
  app.use(cookieParser());
  app.use(authMiddleware(context));

  app.get("/api/health", (_req, res) => {
    const database = db.prepare("SELECT 1 AS ok").get() as { ok: number };
    res.json({ status: database.ok === 1 ? "ok" : "degraded", time: new Date().toISOString() });
  });
  app.use("/api/auth", createAuthRouter(context));
  app.use(
    "/api/guest/rooms/:shareKey/code-blobs",
    createGuestCodeBlobsRouter(context),
  );
  if (context.boardAssets) {
    app.use(
      "/api/guest/rooms/:shareKey/board-assets",
      createGuestBoardAssetsRouter(context),
    );
  }
  app.use("/api/guest/rooms", createGuestRoomsRouter(context));
  app.use("/api/tutors", createTutorsRouter(context));
  app.use("/api/students", createStudentsRouter(context));
  app.use("/api/lessons", createLessonsRouter(context));
  app.use("/api/materials", createMaterialsRouter(context));
  app.use("/api/assignments", createAssignmentsRouter(context));
  app.use("/api/dashboard", createDashboardRouter(context));
  app.use("/api/audit", createAuditRouter(context));
  if (context.boardAssets) {
    app.use("/api/board-v2/assets", createBoardAssetsRouter(context));
  }
  app.use("/api/board-v2", createBoardSyncRouter(context));

  const frontendDir = path.resolve("dist");
  if (config.nodeEnv === "production" && fs.existsSync(frontendDir)) {
    app.use(express.static(frontendDir, {
      index: false,
      maxAge: "1h",
      setHeaders: (res, filePath) => {
        if (frontendAssetNeedsRevalidation(filePath)) {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }));
    app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => res.sendFile(path.join(frontendDir, "index.html")));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
