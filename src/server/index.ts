import { pathToFileURL } from "node:url";
import { createServer } from "./server.js";

export { createApp, getAppContext } from "./app.js";
export { createEduriServer, createServer } from "./server.js";
export type { CreateAppOptions } from "./app.js";

export function serverListenHost(
  nodeEnv: "development" | "test" | "production",
): "127.0.0.1" | "0.0.0.0" {
  return nodeEnv === "production" ? "0.0.0.0" : "127.0.0.1";
}

function isEntrypoint(): boolean {
  return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isEntrypoint()) {
  const server = createServer();
  const port = server.eduriContext.config.port;
  const host = serverListenHost(server.eduriContext.config.nodeEnv);
  server.listen(port, host, () => {
    console.log(`Eduri server is listening on http://${host}:${port}`);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceExit = setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 15_000);
    forceExit.unref();
    server.eduriBoardV2.close();
    server.eduriIo.close(() => {
      clearTimeout(forceExit);
      if (server.listening) {
        server.close(() => process.exit(0));
      } else {
        process.exit(0);
      }
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
