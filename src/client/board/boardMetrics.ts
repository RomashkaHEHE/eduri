import type { BoardServerMetrics } from "./BoardSurface";

export const BOARD_METRICS_REFRESH_MS = 30_000;

export class BoardMetricsRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "BoardMetricsRequestError";
  }
}

interface BoardMetricsResponse {
  updateLogCount: number;
  updateLogBytes: number;
  idempotencyReceiptBytes?: number;
  storageMetadataBytes?: number;
  quotaBytes?: number;
  assetCount: number;
  assetBytes: number;
  logicalBytes?: number;
  physicalBytes?: number;
  compactedAt?: string | null;
  measuredAt?: string | null;
}

function nonNegativeInteger(
  value: unknown,
  label: string,
  optional = false,
): number | undefined {
  if (optional && value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function nullableIso(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${label} must be an ISO date or null`);
  }
  return value;
}

function parseMetrics(value: unknown): BoardServerMetrics {
  if (!value || typeof value !== "object") {
    throw new TypeError("Board metrics response must be an object");
  }
  const response = value as Partial<BoardMetricsResponse>;
  return {
    updateLogCount: nonNegativeInteger(
      response.updateLogCount,
      "updateLogCount",
    )!,
    updateLogBytes: nonNegativeInteger(
      response.updateLogBytes,
      "updateLogBytes",
    )!,
    idempotencyReceiptBytes: nonNegativeInteger(
      response.idempotencyReceiptBytes,
      "idempotencyReceiptBytes",
      true,
    ),
    storageMetadataBytes: nonNegativeInteger(
      response.storageMetadataBytes,
      "storageMetadataBytes",
      true,
    ),
    quotaBytes: nonNegativeInteger(
      response.quotaBytes,
      "quotaBytes",
      true,
    ),
    assetCount: nonNegativeInteger(response.assetCount, "assetCount")!,
    assetBytes: nonNegativeInteger(response.assetBytes, "assetBytes")!,
    logicalBytes: nonNegativeInteger(
      response.logicalBytes,
      "logicalBytes",
      true,
    ),
    physicalBytes: nonNegativeInteger(
      response.physicalBytes,
      "physicalBytes",
      true,
    ),
    compactedAt: nullableIso(response.compactedAt, "compactedAt"),
    syncedAt: nullableIso(response.measuredAt, "measuredAt"),
  };
}

export async function fetchBoardServerMetrics(
  lessonId: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  baseUrl = typeof window === "undefined"
    ? "http://localhost/"
    : window.location.href,
): Promise<BoardServerMetrics> {
  const endpoint = new URL("/api/board-v2/metrics", baseUrl);
  endpoint.searchParams.set("lessonId", lessonId);
  const response = await fetchImpl(endpoint, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    let message = "Не удалось получить размер доски";
    try {
      const payload = await response.json() as { error?: unknown };
      if (typeof payload.error === "string") message = payload.error;
    } catch {
      // The status remains actionable even for a non-JSON reverse-proxy error.
    }
    throw new BoardMetricsRequestError(message, response.status);
  }
  return parseMetrics(await response.json());
}
