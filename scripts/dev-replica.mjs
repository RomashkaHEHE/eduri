import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { platform } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STARTUP_TIMEOUT_MS = 120_000;

export function replicaPort(value = process.env.PORT) {
  if (value === undefined || value.trim() === "") return 5173;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid replica PORT: ${value}`);
  }
  return port;
}

export function replicaEnvironment(environment = process.env) {
  const port = replicaPort(environment.PORT);
  return {
    ...environment,
    NODE_ENV: "development",
    EDURI_SERVE_FRONTEND: "true",
    PORT: String(port),
    APP_ORIGIN: environment.APP_ORIGIN?.trim()
      || `http://127.0.0.1:${port}`,
  };
}

export async function assertTcpPortAvailable(port, label) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (error) => {
      reject(new Error(
        `${label} cannot start because 127.0.0.1:${port} is already in use`,
        { cause: error },
      ));
    });
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      probe.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (platform() === "win32") {
    await new Promise((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/t", "/f"],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("error", resolve);
      killer.once("exit", resolve);
    });
    return;
  }
  child.kill("SIGTERM");
}

async function waitForEndpoint(url, child, label) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label} stopped before it became ready`);
    }
    try {
      await fetch(url, { signal: AbortSignal.timeout(1_000) });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`${label} did not become ready within ${STARTUP_TIMEOUT_MS} ms`);
}

export async function runDevelopmentReplica() {
  const environment = replicaEnvironment();
  const port = Number(environment.PORT);
  const children = new Set();
  let stopping = false;
  let exitCode = 0;

  const stop = async (requestedExitCode = exitCode) => {
    if (stopping) return;
    stopping = true;
    exitCode = requestedExitCode;
    await Promise.all([...children].map(terminateChild));
  };

  const startChild = (label, target, childEnvironment = process.env) => {
    const child = spawn(process.execPath, [target], {
      cwd: PROJECT_ROOT,
      env: childEnvironment,
      stdio: "inherit",
      windowsHide: true,
    });
    children.add(child);
    child.once("exit", (code, signal) => {
      children.delete(child);
      if (stopping) return;
      console.error(
        `[replica] ${label} stopped unexpectedly (${signal ?? `exit ${code}`})`,
      );
      void stop(code && code > 0 ? code : 1).then(() => process.exit(exitCode));
    });
    return child;
  };

  const onSignal = () => {
    void stop().then(() => process.exit(exitCode));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await assertTcpPortAvailable(port, "Eduri server");
    await assertTcpPortAvailable(7880, "LiveKit");
    const liveKit = startChild(
      "LiveKit",
      path.join(PROJECT_ROOT, "scripts", "dev-livekit.mjs"),
    );
    await waitForEndpoint("http://127.0.0.1:7880", liveKit, "LiveKit");

    const app = startChild(
      "Eduri server",
      path.join(PROJECT_ROOT, "dist-server", "index.js"),
      environment,
    );
    const appUrl = `http://127.0.0.1:${port}`;
    await waitForEndpoint(`${appUrl}/api/health`, app, "Eduri server");
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (app.exitCode !== null || app.signalCode !== null) {
      throw new Error("Eduri server stopped during its readiness check");
    }
    console.log(`[replica] Full realtime service is ready at ${appUrl}`);
    console.log("[replica] Open the room in separate browser profiles to test multiple users.");
  } catch (error) {
    console.error(
      `[replica] ${error instanceof Error ? error.message : String(error)}`,
    );
    await stop(1);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  void runDevelopmentReplica();
}
