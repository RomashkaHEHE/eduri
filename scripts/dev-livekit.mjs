import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, platform } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const LIVEKIT_DEV_VERSION = "1.13.4";
export const LIVEKIT_DEV_API_KEY = "devkey";
export const LIVEKIT_DEV_API_SECRET = "eduri-local-livekit-development-secret";
const RELEASE_BASE_URL = `https://github.com/livekit/livekit/releases/download/v${LIVEKIT_DEV_VERSION}`;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_ROOT = path.join(PROJECT_ROOT, ".cache", "livekit", `v${LIVEKIT_DEV_VERSION}`);
const CONFIG_PATH = path.join(PROJECT_ROOT, "ops", "livekit", "livekit.dev.yaml");

const RELEASE_ASSETS = Object.freeze({
  "linux:x64": Object.freeze({
    name: `livekit_${LIVEKIT_DEV_VERSION}_linux_amd64.tar.gz`,
    sha256: "5352e0a92685e45dfd98d8e7cbafd0e1c91d3502fd417079162e1a3f18d17",
    executable: "livekit-server",
  }),
  "linux:arm64": Object.freeze({
    name: `livekit_${LIVEKIT_DEV_VERSION}_linux_arm64.tar.gz`,
    sha256: "691d34c0d0095a3d5c6dfb9d7e9353a0600a3423d498136037001626d281ad64",
    executable: "livekit-server",
  }),
  "linux:arm": Object.freeze({
    name: `livekit_${LIVEKIT_DEV_VERSION}_linux_armv7.tar.gz`,
    sha256: "a81b785b3951780f4f7e3fd62c02cefac827c40a4763513834e5ebff7b9d8a39",
    executable: "livekit-server",
  }),
  "win32:x64": Object.freeze({
    name: `livekit_${LIVEKIT_DEV_VERSION}_windows_amd64.zip`,
    sha256: "a326e025de516e93dfb3719bcd28e5a4ac16f21bcf1ef562499403ca98cc65fe",
    executable: "livekit-server.exe",
  }),
  "win32:arm64": Object.freeze({
    name: `livekit_${LIVEKIT_DEV_VERSION}_windows_arm64.zip`,
    sha256: "fa9e4174915f8635ee98124459b42630b063ef5680ee054a0cc10209bc60df17",
    executable: "livekit-server.exe",
  }),
});

export function liveKitReleaseAsset(
  runtimePlatform = platform(),
  runtimeArch = arch(),
) {
  const asset = RELEASE_ASSETS[`${runtimePlatform}:${runtimeArch}`];
  if (!asset) {
    throw new Error(
      `Local LiveKit is not bundled for ${runtimePlatform}/${runtimeArch}. `
      + "Set LIVEKIT_DEV_BINARY to a compatible livekit-server executable.",
    );
  }
  return asset;
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`LiveKit download failed with HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function extractArchive(archivePath, destination) {
  await mkdir(destination, { recursive: true });
  await new Promise((resolve, reject) => {
    const extractor = spawn("tar", ["-xf", archivePath, "-C", destination], {
      stdio: "inherit",
      windowsHide: true,
    });
    extractor.once("error", reject);
    extractor.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`LiveKit extraction failed (${signal ?? `exit ${code}`})`));
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

export async function ensureLiveKitDevBinary(options = {}) {
  const override = options.override ?? process.env.LIVEKIT_DEV_BINARY;
  if (override) {
    const resolved = path.resolve(override);
    if (!await exists(resolved)) {
      throw new Error(`LIVEKIT_DEV_BINARY does not exist: ${resolved}`);
    }
    return resolved;
  }

  const asset = liveKitReleaseAsset(options.platform, options.arch);
  const executablePath = path.join(CACHE_ROOT, asset.executable);
  const markerPath = path.join(CACHE_ROOT, `${asset.executable}.release-sha256`);
  if (
    await exists(executablePath)
    && await exists(markerPath)
    && (await readFile(markerPath, "utf8")).trim() === asset.sha256
  ) {
    return executablePath;
  }

  await mkdir(CACHE_ROOT, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}`;
  const archivePath = path.join(CACHE_ROOT, `${asset.name}.${nonce}.download`);
  const extractionPath = path.join(CACHE_ROOT, `extract-${nonce}`);
  try {
    console.log(`[livekit] Downloading pinned local server v${LIVEKIT_DEV_VERSION}...`);
    await download(`${RELEASE_BASE_URL}/${asset.name}`, archivePath);
    const digest = sha256Hex(await readFile(archivePath));
    if (digest !== asset.sha256) {
      throw new Error(`LiveKit archive checksum mismatch: expected ${asset.sha256}, received ${digest}`);
    }
    await extractArchive(archivePath, extractionPath);
    const extractedExecutable = path.join(extractionPath, asset.executable);
    if (!await exists(extractedExecutable)) {
      throw new Error(`LiveKit archive does not contain ${asset.executable}`);
    }
    await rm(executablePath, { force: true });
    await rename(extractedExecutable, executablePath);
    if (platform() !== "win32") await chmod(executablePath, 0o755);
    await writeFile(markerPath, `${asset.sha256}\n`, "utf8");
    return executablePath;
  } finally {
    await rm(archivePath, { force: true });
    await rm(extractionPath, { recursive: true, force: true });
  }
}

export async function runLiveKitDevServer() {
  const executable = await ensureLiveKitDevBinary();
  console.log("[livekit] Starting local media server on ws://127.0.0.1:7880");
  const child = spawn(executable, ["--config", CONFIG_PATH], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      LIVEKIT_KEYS: `${LIVEKIT_DEV_API_KEY}: ${LIVEKIT_DEV_API_SECRET}`,
    },
    stdio: "inherit",
    windowsHide: true,
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void terminateChild(child);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (stopping) resolve();
      else reject(new Error(`Local LiveKit stopped unexpectedly (${signal ?? `exit ${code}`})`));
    });
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  runLiveKitDevServer().catch((error) => {
    console.error(`[livekit] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
