import path from "node:path";
import { isIP } from "node:net";

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  appOrigins: string[];
  dataDir: string;
  databasePath: string;
  uploadDir: string;
  boardAssetDir: string;
  boardAssetMaxBytes: number;
  boardAssetMaxChunkBytes: number;
  boardAssetTenantQuotaBytes: number;
  boardAssetMinFreeDiskBytes: number;
  boardV2ActiveDocumentCacheBytes: number;
  boardV2TenantQuotaBytes: number;
  boardV2MinFreeDiskBytes: number;
  boardV2SessionAuditIntervalMs: number;
  codeBlobClamdHost?: string;
  codeBlobClamdPort: number;
  codeBlobScanTimeoutMs: number;
  codeBlobScanMaxBytes: number;
  authLookupKey: string;
  adminLogin: string;
  adminPassword?: string;
  inviteTtlHours: number;
  sessionTtlHours: number;
  bcryptRounds: number;
  trustProxy: boolean | number | string;
  boardV2FoundationEnabled: boolean;
  livekitUrl?: string;
  livekitApiUrl?: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
}

export type AppConfigOverrides = Partial<AppConfig>;

const DEVELOPMENT_AUTH_LOOKUP_KEY = "eduri-development-lookup-key-change-me";
const PRODUCTION_AUTH_LOOKUP_KEY_PLACEHOLDERS = new Set([
  DEVELOPMENT_AUTH_LOOKUP_KEY,
  "replace-with-at-least-32-random-bytes",
]);
const PRODUCTION_SECRET_PLACEHOLDER_MARKERS = [
  "change-me",
  "changeme",
  "placeholder",
  "replace-with",
] as const;

function isProductionSecretPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return PRODUCTION_SECRET_PLACEHOLDER_MARKERS.some((marker) => (
    normalized.includes(marker)
  ));
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedInteger(
  name: string,
  value: number | string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function optionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function resolveNodeEnv(value: string | undefined): AppConfig["nodeEnv"] {
  const normalized = value?.trim() || "development";
  if (
    normalized === "development"
    || normalized === "test"
    || normalized === "production"
  ) {
    return normalized;
  }
  throw new Error(
    "NODE_ENV must be one of development, test, or production",
  );
}

function normalizeAppOrigin(
  value: string,
  nodeEnv: AppConfig["nodeEnv"],
): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("APP_ORIGIN must contain valid HTTP origins");
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error(
      "APP_ORIGIN entries must be root-only HTTP origins without credentials, path, query, or fragment",
    );
  }
  if (nodeEnv === "production" && url.protocol !== "https:") {
    throw new Error("APP_ORIGIN entries must use https:// in production");
  }
  return url.origin;
}

function resolveAuthLookupKey(
  value: string | undefined,
  nodeEnv: AppConfig["nodeEnv"],
): string {
  const configuredValue = optionalValue(value);
  if (nodeEnv !== "production") {
    return configuredValue ?? DEVELOPMENT_AUTH_LOOKUP_KEY;
  }
  if (!configuredValue) {
    throw new Error("AUTH_LOOKUP_KEY is required in production");
  }
  if (Buffer.byteLength(configuredValue) < 32) {
    throw new Error("AUTH_LOOKUP_KEY must contain at least 32 bytes in production");
  }
  if (PRODUCTION_AUTH_LOOKUP_KEY_PLACEHOLDERS.has(configuredValue.toLowerCase())) {
    throw new Error("AUTH_LOOKUP_KEY must not use a development or placeholder value in production");
  }
  return configuredValue;
}

function enabledByDefault(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== "false";
}

function resolveTrustProxy(
  value: AppConfig["trustProxy"] | undefined,
  nodeEnv: AppConfig["nodeEnv"],
): AppConfig["trustProxy"] {
  const configured = value ?? process.env.TRUST_PROXY;
  let resolved: AppConfig["trustProxy"];
  if (configured === undefined || configured === false || configured === "") {
    resolved = false;
  } else if (configured === true || configured === "true") {
    resolved = 1;
  } else if (configured === "false") {
    resolved = false;
  } else {
    resolved = configured;
  }
  if (
    nodeEnv === "production"
    && (
      typeof resolved !== "string"
      || isIP(resolved.trim()) === 0
    )
  ) {
    throw new Error(
      "TRUST_PROXY must be the exact nginx peer IP address in production",
    );
  }
  return typeof resolved === "string" ? resolved.trim() : resolved;
}

function normalizeLiveKitUrl(value: string, nodeEnv: AppConfig["nodeEnv"]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("LIVEKIT_URL must be a valid WebSocket URL");
  }
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("LIVEKIT_URL must be a valid WebSocket URL without credentials, query, or fragment");
  }
  if (nodeEnv === "production" && url.protocol !== "wss:") {
    throw new Error("LIVEKIT_URL must use wss:// in production");
  }
  return url.toString().replace(/\/$/u, "");
}

function isPrivateLiveKitApiIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false;
  const [first, second] = hostname.split(".").map(Number);
  return first === 127
    || first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function normalizeLiveKitApiUrl(
  value: string,
  nodeEnv: AppConfig["nodeEnv"],
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("LIVEKIT_API_URL must be a valid HTTP URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/"
  ) {
    throw new Error(
      "LIVEKIT_API_URL must be a root-only HTTP URL without credentials, query, or fragment",
    );
  }
  if (nodeEnv === "production" && !isPrivateLiveKitApiIpv4(url.hostname)) {
    throw new Error(
      "LIVEKIT_API_URL must use an exact loopback or RFC1918 IPv4 address in production",
    );
  }
  return url.toString().replace(/\/$/u, "");
}

export function loadConfig(overrides: AppConfigOverrides = {}): AppConfig {
  const nodeEnv = resolveNodeEnv(overrides.nodeEnv ?? process.env.NODE_ENV);
  const dataDir = path.resolve(overrides.dataDir ?? process.env.DATA_DIR ?? "./data");
  const configuredOrigins = overrides.appOrigins
    ?? (process.env.APP_ORIGIN ?? "http://127.0.0.1:5173").split(",");
  const origins = [...new Set(configuredOrigins
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => normalizeAppOrigin(origin, nodeEnv)))];
  if (origins.length === 0) {
    throw new Error("APP_ORIGIN must contain at least one allowed origin");
  }

  const authLookupKey = resolveAuthLookupKey(
    overrides.authLookupKey ?? process.env.AUTH_LOOKUP_KEY,
    nodeEnv,
  );
  const trustProxy = resolveTrustProxy(overrides.trustProxy, nodeEnv);
  const adminPassword = overrides.adminPassword ?? process.env.ADMIN_PASSWORD ?? (nodeEnv === "production" ? undefined : "change-me-admin");
  const configuredDatabasePath = overrides.databasePath ?? path.join(dataDir, "eduri.sqlite");
  const configuredLiveKitUrl = optionalValue(overrides.livekitUrl ?? process.env.LIVEKIT_URL);
  const configuredLiveKitApiUrl = optionalValue(
    overrides.livekitApiUrl ?? process.env.LIVEKIT_API_URL,
  );
  const livekitApiKey = optionalValue(overrides.livekitApiKey ?? process.env.LIVEKIT_API_KEY);
  const livekitApiSecret = optionalValue(overrides.livekitApiSecret ?? process.env.LIVEKIT_API_SECRET);
  const hasAnyLiveKitConfig = Boolean(
    configuredLiveKitUrl
    || configuredLiveKitApiUrl
    || livekitApiKey
    || livekitApiSecret,
  );
  const codeBlobClamdHost = optionalValue(
    overrides.codeBlobClamdHost ?? process.env.CODE_BLOB_CLAMD_HOST,
  );
  const codeBlobClamdPort = boundedInteger(
    "CODE_BLOB_CLAMD_PORT",
    overrides.codeBlobClamdPort ?? process.env.CODE_BLOB_CLAMD_PORT,
    3310,
    1,
    65_535,
  );
  const codeBlobScanTimeoutMs = boundedInteger(
    "CODE_BLOB_SCAN_TIMEOUT_MS",
    overrides.codeBlobScanTimeoutMs ?? process.env.CODE_BLOB_SCAN_TIMEOUT_MS,
    30_000,
    1_000,
    120_000,
  );
  const codeBlobScanMaxBytes = boundedInteger(
    "CODE_BLOB_SCAN_MAX_BYTES",
    overrides.codeBlobScanMaxBytes ?? process.env.CODE_BLOB_SCAN_MAX_BYTES,
    32 * 1024 * 1024,
    1,
    64 * 1024 * 1024,
  );

  if (nodeEnv === "production" && (
    !adminPassword
    || adminPassword.length < 12
    || !/\S/u.test(adminPassword)
  )) {
    throw new Error("ADMIN_PASSWORD must contain at least 12 characters in production");
  }
  if (
    nodeEnv === "production"
    && adminPassword
    && isProductionSecretPlaceholder(adminPassword)
  ) {
    throw new Error("ADMIN_PASSWORD must not use a placeholder value in production");
  }
  if (hasAnyLiveKitConfig && (!configuredLiveKitUrl || !livekitApiKey || !livekitApiSecret)) {
    throw new Error("LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be configured together");
  }
  if (nodeEnv === "production" && !hasAnyLiveKitConfig) {
    throw new Error("LIVEKIT_URL, LIVEKIT_API_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are required in production");
  }
  if (nodeEnv === "production" && !configuredLiveKitApiUrl) {
    throw new Error("LIVEKIT_API_URL is required in production");
  }
  if (nodeEnv === "production" && livekitApiSecret && Buffer.byteLength(livekitApiSecret) < 32) {
    throw new Error("LIVEKIT_API_SECRET must contain at least 32 bytes in production");
  }
  if (nodeEnv === "production" && (
    (livekitApiKey && isProductionSecretPlaceholder(livekitApiKey))
    || (livekitApiSecret && isProductionSecretPlaceholder(livekitApiSecret))
  )) {
    throw new Error("LIVEKIT_API_KEY and LIVEKIT_API_SECRET must not use placeholder values in production");
  }
  if (codeBlobClamdHost && (
    codeBlobClamdHost.length > 253
    || /[\s/?#]/u.test(codeBlobClamdHost)
  )) {
    throw new Error("CODE_BLOB_CLAMD_HOST must be a hostname or IP address");
  }
  if (nodeEnv === "production" && !codeBlobClamdHost) {
    throw new Error("CODE_BLOB_CLAMD_HOST is required in production");
  }
  if (nodeEnv === "production" && codeBlobScanMaxBytes < 32 * 1024 * 1024) {
    throw new Error("CODE_BLOB_SCAN_MAX_BYTES must cover the 32 MiB Code blob limit in production");
  }
  const livekitUrl = configuredLiveKitUrl ? normalizeLiveKitUrl(configuredLiveKitUrl, nodeEnv) : undefined;
  const livekitApiUrl = configuredLiveKitApiUrl
    ? normalizeLiveKitApiUrl(configuredLiveKitApiUrl, nodeEnv)
    : undefined;

  return {
    nodeEnv,
    port: overrides.port ?? positiveNumber(process.env.PORT, 3020),
    appOrigins: origins,
    dataDir,
    databasePath: configuredDatabasePath === ":memory:" ? configuredDatabasePath : path.resolve(configuredDatabasePath),
    uploadDir: path.resolve(overrides.uploadDir ?? path.join(dataDir, "uploads")),
    boardAssetDir: path.resolve(
      overrides.boardAssetDir
        ?? process.env.BOARD_ASSET_DIR
        ?? path.join(dataDir, "board-assets"),
    ),
    boardAssetMaxBytes: overrides.boardAssetMaxBytes
      ?? positiveInteger(process.env.BOARD_ASSET_MAX_BYTES, 128 * 1024 * 1024),
    boardAssetMaxChunkBytes: overrides.boardAssetMaxChunkBytes
      ?? positiveInteger(process.env.BOARD_ASSET_MAX_CHUNK_BYTES, 2 * 1024 * 1024),
    boardAssetTenantQuotaBytes: overrides.boardAssetTenantQuotaBytes
      ?? positiveInteger(process.env.BOARD_ASSET_TENANT_QUOTA_BYTES, 20 * 1024 * 1024 * 1024),
    boardAssetMinFreeDiskBytes: overrides.boardAssetMinFreeDiskBytes
      ?? positiveInteger(process.env.BOARD_ASSET_MIN_FREE_DISK_BYTES, 2 * 1024 * 1024 * 1024),
    boardV2ActiveDocumentCacheBytes:
      overrides.boardV2ActiveDocumentCacheBytes
      ?? positiveInteger(
        process.env.BOARD_V2_ACTIVE_DOCUMENT_CACHE_BYTES,
        256 * 1024 * 1024,
      ),
    boardV2TenantQuotaBytes:
      overrides.boardV2TenantQuotaBytes
      ?? positiveInteger(
        process.env.BOARD_V2_TENANT_QUOTA_BYTES,
        20 * 1024 * 1024 * 1024,
      ),
    boardV2MinFreeDiskBytes:
      overrides.boardV2MinFreeDiskBytes
      ?? positiveInteger(
        process.env.BOARD_V2_MIN_FREE_DISK_BYTES,
        2 * 1024 * 1024 * 1024,
      ),
    boardV2SessionAuditIntervalMs:
      overrides.boardV2SessionAuditIntervalMs
      ?? positiveInteger(
        process.env.BOARD_V2_SESSION_AUDIT_INTERVAL_MS,
        15_000,
      ),
    codeBlobClamdHost,
    codeBlobClamdPort,
    codeBlobScanTimeoutMs,
    codeBlobScanMaxBytes,
    authLookupKey,
    adminLogin: overrides.adminLogin ?? process.env.ADMIN_LOGIN ?? "admin",
    adminPassword,
    inviteTtlHours: overrides.inviteTtlHours ?? positiveNumber(process.env.INVITE_TTL_HOURS, 48),
    sessionTtlHours: overrides.sessionTtlHours ?? positiveNumber(process.env.SESSION_TTL_HOURS, 24 * 30),
    bcryptRounds: overrides.bcryptRounds ?? (nodeEnv === "test" ? 4 : 12),
    trustProxy,
    boardV2FoundationEnabled:
      overrides.boardV2FoundationEnabled
      ?? enabledByDefault(process.env.BOARD_V2_FOUNDATION_ENABLED),
    livekitUrl,
    livekitApiUrl,
    livekitApiKey,
    livekitApiSecret,
  };
}
