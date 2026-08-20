import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "scripts/dev-livekit.test.mjs"],
    testTimeout: 15_000,
    pool: "forks",
    maxWorkers: 1,
  },
});
