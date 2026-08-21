import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import {
  assertTcpPortAvailable,
  replicaEnvironment,
  replicaPort,
} from "./dev-replica.mjs";

describe("local service replica launcher", () => {
  it("uses a single local origin for the built app and realtime server", () => {
    expect(replicaEnvironment({})).toEqual({
      NODE_ENV: "development",
      EDURI_SERVE_FRONTEND: "true",
      PORT: "5173",
      APP_ORIGIN: "http://127.0.0.1:5173",
    });
  });

  it("keeps explicit replica ports and allowed origins aligned", () => {
    expect(replicaEnvironment({ PORT: "5180" })).toEqual({
      PORT: "5180",
      NODE_ENV: "development",
      EDURI_SERVE_FRONTEND: "true",
      APP_ORIGIN: "http://127.0.0.1:5180",
    });
    expect(
      replicaEnvironment({ PORT: "5180", APP_ORIGIN: "http://localhost:5180" })
        .APP_ORIGIN,
    ).toBe("http://localhost:5180");
  });

  it("rejects unsafe or malformed replica ports", () => {
    for (const value of ["0", "65536", "1.5", "not-a-port"]) {
      expect(() => replicaPort(value)).toThrow(/Invalid replica PORT/u);
    }
  });

  it("fails before startup when a required loopback port is occupied", async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Test TCP server did not expose a numeric port");
    }
    try {
      await expect(assertTcpPortAvailable(address.port, "Test service"))
        .rejects.toThrow(`127.0.0.1:${address.port} is already in use`);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (
        error ? reject(error) : resolve()
      )));
    }
  });
});
