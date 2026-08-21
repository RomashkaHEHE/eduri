import { afterEach, describe, expect, it, vi } from "vitest";
import { DEVELOPMENT_LIVEKIT_CONFIG, loadConfig } from "./config.js";

const productionOverrides = {
  nodeEnv: "production" as const,
  appOrigins: ["https://eduri.test"],
  adminPassword: "production-admin-password",
  livekitUrl: "wss://eduri.test/livekit",
  livekitApiUrl: "http://10.253.0.1:7880",
  livekitApiKey: "production-livekit-key",
  livekitApiSecret: "production-livekit-secret-at-least-32-bytes",
  codeBlobClamdHost: "127.0.0.1",
  trustProxy: "10.253.0.1",
};

describe("runtime environment and origin configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed for an unknown NODE_ENV", () => {
    vi.stubEnv("NODE_ENV", "prodution");

    expect(() => loadConfig()).toThrow(
      /NODE_ENV must be one of development, test, or production/u,
    );
  });

  it("uses the isolated local LiveKit service by default only in development", () => {
    vi.stubEnv("LIVEKIT_URL", "");
    vi.stubEnv("LIVEKIT_API_URL", "");
    vi.stubEnv("LIVEKIT_API_KEY", "");
    vi.stubEnv("LIVEKIT_API_SECRET", "");

    expect(loadConfig({ nodeEnv: "development" })).toMatchObject(
      DEVELOPMENT_LIVEKIT_CONFIG,
    );
    expect(loadConfig({ nodeEnv: "test" })).toMatchObject({
      livekitUrl: undefined,
      livekitApiUrl: undefined,
      livekitApiKey: undefined,
      livekitApiSecret: undefined,
    });
  });

  it("serves one built frontend origin only in production or explicit local replica mode", () => {
    vi.stubEnv("PORT", "");
    vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:5173");
    vi.stubEnv("EDURI_SERVE_FRONTEND", "");

    expect(loadConfig({ nodeEnv: "development" })).toMatchObject({
      port: 3020,
      serveFrontend: false,
      appOrigins: ["http://127.0.0.1:5173"],
    });

    vi.stubEnv("EDURI_SERVE_FRONTEND", "true");
    expect(loadConfig({ nodeEnv: "development" })).toMatchObject({
      port: 5173,
      serveFrontend: true,
      appOrigins: ["http://127.0.0.1:5173"],
    });

    vi.stubEnv("PORT", "5180");
    vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:5180");
    expect(loadConfig({ nodeEnv: "development" })).toMatchObject({
      port: 5180,
      serveFrontend: true,
      appOrigins: ["http://127.0.0.1:5180"],
    });
  });

  it("rejects an invalid local frontend-serving flag", () => {
    vi.stubEnv("EDURI_SERVE_FRONTEND", "sometimes");

    expect(() => loadConfig({ nodeEnv: "development" }))
      .toThrow(/EDURI_SERVE_FRONTEND must be true or false/u);
  });

  it("still rejects a partial explicit LiveKit development configuration", () => {
    expect(() => loadConfig({
      nodeEnv: "development",
      livekitUrl: "ws://127.0.0.1:7880",
      livekitApiKey: "",
    })).toThrow(/must be configured together/u);
  });

  it("normalizes and deduplicates root HTTP origins", () => {
    expect(loadConfig({
      nodeEnv: "test",
      appOrigins: [
        "https://EDURI.test:443/",
        "https://eduri.test",
        "http://127.0.0.1:5173/",
      ],
    }).appOrigins).toEqual([
      "https://eduri.test",
      "http://127.0.0.1:5173",
    ]);
  });

  it.each([
    "not-an-origin",
    "ftp://eduri.test",
    "https://user:secret@eduri.test",
    "https://eduri.test/path",
    "https://eduri.test?redirect=https://example.test",
    "https://eduri.test/#fragment",
  ])("rejects a non-root application origin: %s", (appOrigin) => {
    expect(() => loadConfig({
      nodeEnv: "test",
      appOrigins: [appOrigin],
    })).toThrow(/APP_ORIGIN/u);
  });

  it("requires HTTPS application origins in production", () => {
    expect(() => loadConfig({
      ...productionOverrides,
      authLookupKey: "a-real-random-production-lookup-key-with-32-plus-bytes",
      appOrigins: ["http://eduri.test"],
    })).toThrow(/APP_ORIGIN entries must use https/u);
  });
});

describe("Board v2 configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("enables the Board v2 foundation when the environment setting is absent", () => {
    vi.stubEnv("BOARD_V2_FOUNDATION_ENABLED", "");

    expect(loadConfig({ nodeEnv: "test" }).boardV2FoundationEnabled).toBe(true);
  });

  it("keeps an explicit false value as an emergency kill switch", () => {
    vi.stubEnv("BOARD_V2_FOUNDATION_ENABLED", "false");

    expect(loadConfig({ nodeEnv: "test" }).boardV2FoundationEnabled).toBe(false);
  });

  it("rejects an empty allowed-origin set", () => {
    expect(() => loadConfig({
      nodeEnv: "test",
      appOrigins: [],
    })).toThrow(/APP_ORIGIN must contain at least one allowed origin/u);
  });

  it("requires fail-closed Code blob malware scanning in production", () => {
    vi.stubEnv("CODE_BLOB_CLAMD_HOST", "");
    expect(() => loadConfig({
      ...productionOverrides,
      authLookupKey: "production-auth-lookup-key-at-least-32-bytes",
      codeBlobClamdHost: undefined,
    })).toThrow(/CODE_BLOB_CLAMD_HOST is required/u);
  });

  it("validates bounded clamd scan settings", () => {
    expect(() => loadConfig({
      nodeEnv: "test",
      codeBlobScanTimeoutMs: 999,
    })).toThrow(/CODE_BLOB_SCAN_TIMEOUT_MS/u);
    expect(loadConfig({
      nodeEnv: "test",
      codeBlobClamdHost: "127.0.0.1",
      codeBlobClamdPort: 3310,
      codeBlobScanTimeoutMs: 5_000,
      codeBlobScanMaxBytes: 1024,
    })).toMatchObject({
      codeBlobClamdHost: "127.0.0.1",
      codeBlobClamdPort: 3310,
      codeBlobScanTimeoutMs: 5_000,
      codeBlobScanMaxBytes: 1024,
    });
  });
});

describe("authentication lookup-key configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the development fallback available outside production", () => {
    vi.stubEnv("AUTH_LOOKUP_KEY", "");

    expect(loadConfig({ nodeEnv: "development" }).authLookupKey)
      .toBe("eduri-development-lookup-key-change-me");
    expect(loadConfig({ nodeEnv: "test" }).authLookupKey)
      .toBe("eduri-development-lookup-key-change-me");
  });

  it("fails closed when AUTH_LOOKUP_KEY is absent or blank in production", () => {
    vi.stubEnv("AUTH_LOOKUP_KEY", "");

    expect(() => loadConfig(productionOverrides))
      .toThrow(/AUTH_LOOKUP_KEY is required in production/u);
    expect(() => loadConfig({
      ...productionOverrides,
      authLookupKey: "   ",
    })).toThrow(/AUTH_LOOKUP_KEY is required in production/u);
  });

  it.each([
    "eduri-development-lookup-key-change-me",
    "replace-with-at-least-32-random-bytes",
  ])("rejects the known production placeholder %s", (authLookupKey) => {
    expect(() => loadConfig({
      ...productionOverrides,
      authLookupKey,
    })).toThrow(/must not use a development or placeholder value/u);
  });

  it("accepts an explicitly configured production lookup key", () => {
    expect(loadConfig({
      ...productionOverrides,
      authLookupKey: "a-real-random-production-lookup-key-with-32-plus-bytes",
    }).authLookupKey).toBe("a-real-random-production-lookup-key-with-32-plus-bytes");
  });
});

describe("production secret configuration", () => {
  const validProduction = {
    ...productionOverrides,
    authLookupKey: "a-real-random-production-lookup-key-with-32-plus-bytes",
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects the public ADMIN_PASSWORD template", () => {
    expect(() => loadConfig({
      ...validProduction,
      adminPassword: "replace-with-a-long-random-password",
    })).toThrow(/ADMIN_PASSWORD must not use a placeholder/u);
  });

  it.each([
    { livekitApiKey: "replace-with-a-random-api-key" },
    { livekitApiSecret: "replace-with-at-least-32-random-bytes" },
  ])("rejects public LiveKit credential templates", (override) => {
    expect(() => loadConfig({
      ...validProduction,
      ...override,
    })).toThrow(/LIVEKIT_API_KEY and LIVEKIT_API_SECRET must not use placeholder/u);
  });

  it("accepts explicit non-placeholder production credentials", () => {
    expect(loadConfig(validProduction)).toMatchObject({
      adminPassword: productionOverrides.adminPassword,
      livekitApiUrl: productionOverrides.livekitApiUrl,
      livekitApiKey: productionOverrides.livekitApiKey,
      livekitApiSecret: productionOverrides.livekitApiSecret,
    });
  });

  it("requires a private explicit LiveKit management origin in production", () => {
    expect(() => loadConfig({
      ...validProduction,
      livekitApiUrl: undefined,
    })).toThrow(/LIVEKIT_API_URL is required/u);

    for (const livekitApiUrl of [
      "https://eduri.test",
      "http://localhost:7880",
      "http://203.0.113.10:7880",
      "http://10.253.0.1:7880/twirp",
      "http://user:secret@10.253.0.1:7880",
    ]) {
      expect(() => loadConfig({
        ...validProduction,
        livekitApiUrl,
      }), livekitApiUrl).toThrow(/LIVEKIT_API_URL/u);
    }
  });

  it.each([
    "http://127.0.0.1:7880",
    "http://10.253.0.1:7880",
    "https://172.16.0.1:7880",
    "http://192.168.20.4:7880",
  ])("accepts an exact private LiveKit management IP: %s", (livekitApiUrl) => {
    expect(loadConfig({
      ...validProduction,
      livekitApiUrl,
    }).livekitApiUrl).toBe(livekitApiUrl);
  });
});

describe("trusted proxy configuration", () => {
  const validProduction = {
    ...productionOverrides,
    authLookupKey: "a-real-random-production-lookup-key-with-32-plus-bytes",
  };

  it.each([true, 1, "true", "loopback", "10.253.0.0/24"])(
    "rejects broad production proxy trust: %s",
    (trustProxy) => {
      expect(() => loadConfig({ ...validProduction, trustProxy }))
        .toThrow(/exact nginx peer IP address/u);
    },
  );

  it("accepts one exact production proxy peer", () => {
    expect(loadConfig({
      ...validProduction,
      trustProxy: "10.253.0.1",
    }).trustProxy).toBe("10.253.0.1");
  });
});
