import http, { type Server as HttpServer } from "node:http";
import type { Namespace, Server as SocketServer } from "socket.io";
import { createApp, getAppContext, type CreateAppOptions } from "./app.js";
import { attachRealtime } from "./realtime.js";
import type { AppContext } from "./types.js";
import {
  attachBoardV2Sync,
  type BoardSyncTransport,
} from "./board-v2/sync-transport.js";
import { attachCodeSyncNamespace } from "./code-sync/transport.js";
import { attachLessonCodeSyncNamespace } from "./lesson-code-sync/transport.js";

export interface EduriServer extends HttpServer {
  eduriIo: SocketServer;
  eduriBoardV2: BoardSyncTransport;
  eduriCodeSync: Namespace;
  eduriLessonCodeSync: Namespace;
  eduriContext: AppContext;
}

export function createServer(options: CreateAppOptions = {}): EduriServer {
  const app = createApp(options);
  const context = getAppContext(app);
  const server = http.createServer(app) as EduriServer;
  server.eduriContext = context;
  server.eduriIo = attachRealtime(server, context);
  server.eduriCodeSync = attachCodeSyncNamespace(
    server.eduriIo,
    context.codeSync,
    {
      allowedOrigins: context.config.appOrigins,
      trustedProxy: context.config.trustProxy,
    },
  );
  server.eduriLessonCodeSync = attachLessonCodeSyncNamespace(
    server.eduriIo,
    context,
    context.lessonCodeSync,
    {
      allowedOrigins: context.config.appOrigins,
      trustedProxy: context.config.trustProxy,
    },
  );
  server.eduriBoardV2 = attachBoardV2Sync(server, context);
  server.on("close", () => {
    server.eduriBoardV2.close();
    context.stopGuestRoomMaintenance?.();
    context.stopMaterialFileMaintenance?.();
    context.stopBoardAssetMaintenance?.();
    if (context.ownsDatabase && context.db.open) context.db.close();
  });
  return server;
}

export const createEduriServer = createServer;
