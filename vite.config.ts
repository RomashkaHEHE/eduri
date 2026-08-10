import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import {
  PYTHON_RUNNER_PUBLIC_FILE,
  PYTHON_RUNNER_WORKER_URL,
} from "./src/pythonRunnerContract.js";

const OFFLINE_PUBLIC_ASSETS = [
  {
    fileName: PYTHON_RUNNER_PUBLIC_FILE,
    url: PYTHON_RUNNER_WORKER_URL,
  },
] as const;
const BOARD_COMPACTION_WORKER =
  /^assets\/documentCompaction\.worker-[A-Za-z0-9_-]+\.js$/u;

function offlinePrecacheManifest(): Plugin {
  let projectRoot = process.cwd();
  return {
    name: "eduri-offline-precache-manifest",
    apply: "build",
    configResolved(config) {
      projectRoot = config.root;
    },
    generateBundle(_options, bundle) {
      const outputNames = Object.keys(bundle).sort();
      const compactionWorkers = outputNames.filter((fileName) =>
        BOARD_COMPACTION_WORKER.test(fileName));
      if (compactionWorkers.length !== 1) {
        this.error(
          "The Board document compaction worker must be emitted exactly once",
        );
      }
      const urls = [
        "/index.html",
        ...outputNames.map((fileName) => `/${fileName}`),
        ...OFFLINE_PUBLIC_ASSETS.map((asset) => asset.url),
      ].filter((url, index, all) => all.indexOf(url) === index);

      const digest = createHash("sha256");
      digest.update(readFileSync(resolve(projectRoot, "index.html")));
      for (const fileName of outputNames) {
        const output = bundle[fileName];
        digest.update(fileName);
        digest.update(output.type === "chunk" ? output.code : output.source);
      }
      for (const fileName of [
        ...OFFLINE_PUBLIC_ASSETS.map((asset) => asset.fileName),
        "sw.js",
      ]) {
        digest.update(fileName);
        digest.update(readFileSync(resolve(projectRoot, "public", fileName)));
      }

      const manifest = {
        version: `v3-${digest.digest("hex").slice(0, 20)}`,
        urls,
      };
      this.emitFile({
        type: "asset",
        fileName: "sw-assets.js",
        source: `self.__EDURI_PRECACHE_MANIFEST__ = Object.freeze(${JSON.stringify(manifest)});\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), offlinePrecacheManifest()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3020",
        ws: true,
      },
      "/socket.io": {
        target: "ws://127.0.0.1:3020",
        ws: true,
      },
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  build: {
    sourcemap: false,
    // The lesson-only chunk contains Board v2, Monaco, and call integrations;
    // it remains outside the dashboard cold-start path.
    chunkSizeWarningLimit: 1400,
  },
});
