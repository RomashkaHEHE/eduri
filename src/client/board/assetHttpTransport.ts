import {
  AssetTransportError,
  type AssetUploadTransport,
  type RemoteAssetReady,
  type RemoteAssetStatus,
} from "./assetOutbox.js";

export interface BoardAssetHttpTransportOptions {
  boardId: string;
  generation: number;
  csrfToken: () => string;
  endpoint?: string;
  fetch?: typeof fetch;
}

interface ErrorPayload {
  code?: unknown;
  error?: unknown;
  retryable?: unknown;
  retryAfterMs?: unknown;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MIME_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;

function validateId(value: string, label: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function validateGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("generation must be a positive safe integer");
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AssetTransportError(
      "INVALID_RESPONSE",
      `${label} is invalid`,
      "transient",
    );
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new AssetTransportError(
      "INVALID_RESPONSE",
      `${label} is invalid`,
      "transient",
    );
  }
  return value;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AssetTransportError(
      "INVALID_RESPONSE",
      `${label} is invalid`,
      "transient",
    );
  }
  return value;
}

function parseReady(value: unknown): RemoteAssetReady {
  if (!value || typeof value !== "object") {
    throw new AssetTransportError(
      "INVALID_RESPONSE",
      "asset response is invalid",
      "transient",
    );
  }
  const record = value as Record<string, unknown>;
  const assetId = stringField(record.assetId, "assetId");
  const sha256 = stringField(record.sha256, "sha256");
  const mimeType = stringField(record.mimeType, "mimeType");
  const publishedAt = stringField(record.publishedAt, "publishedAt");
  if (
    !ID_PATTERN.test(assetId)
    || !SHA256_PATTERN.test(sha256)
    || !MIME_PATTERN.test(mimeType)
    || !Number.isFinite(Date.parse(publishedAt))
  ) {
    throw new AssetTransportError(
      "INVALID_RESPONSE",
      "asset response fields are invalid",
      "transient",
    );
  }
  return {
    assetId,
    sha256,
    mimeType,
    byteSize: positiveInteger(record.byteSize, "byteSize"),
    width: positiveInteger(record.width, "width"),
    height: positiveInteger(record.height, "height"),
    frameCount: positiveInteger(record.frameCount, "frameCount"),
    totalDecodedPixels: positiveInteger(
      record.totalDecodedPixels,
      "totalDecodedPixels",
    ),
    publishedAt,
  };
}

function retryAfterHeader(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function errorKind(
  status: number,
  code: string,
  retryable: boolean,
): "transient" | "access" | "permanent" {
  if (status === 401 || status === 403 || status === 404) return "access";
  if (code === "UPLOAD_EXPIRED" || code === "UPLOAD_GONE") {
    return "transient";
  }
  if (
    retryable
    || status === 408
    || status === 425
    || status === 429
    || status >= 500
  ) {
    return "transient";
  }
  return "permanent";
}

async function responseError(response: Response): Promise<AssetTransportError> {
  let payload: ErrorPayload = {};
  try {
    if (response.headers.get("content-type")?.includes("application/json")) {
      payload = await response.json() as ErrorPayload;
    }
  } catch {
    // The status code remains authoritative when an intermediary returned
    // malformed JSON.
  }
  const code = typeof payload.code === "string"
    ? payload.code
    : `HTTP_${response.status}`;
  const message = typeof payload.error === "string"
    ? payload.error
    : `asset request failed with HTTP ${response.status}`;
  const retryable = payload.retryable === true;
  const retryAfterMs =
    typeof payload.retryAfterMs === "number"
    && Number.isSafeInteger(payload.retryAfterMs)
    && payload.retryAfterMs >= 0
      ? payload.retryAfterMs
      : retryAfterHeader(response);
  return new AssetTransportError(
    code,
    message,
    errorKind(response.status, code, retryable),
    retryAfterMs,
  );
}

function scopeQuery(boardId: string, generation: number): string {
  const query = new URLSearchParams({
    boardId,
    generation: String(generation),
  });
  return query.toString();
}

export function boardAssetContentUrl(
  scope: { boardId: string; generation: number },
  assetId: string,
  endpoint = "/api/board-v2/assets",
): string {
  const boardId = validateId(scope.boardId, "boardId");
  const generation = validateGeneration(scope.generation);
  return `${endpoint}/${encodeURIComponent(validateId(assetId, "assetId"))}`
    + `/content?${scopeQuery(boardId, generation)}`;
}

export function parseAssetReadyControlPayload(
  payload: Uint8Array,
): RemoteAssetReady {
  try {
    return parseReady(JSON.parse(new TextDecoder().decode(payload)));
  } catch (error) {
    if (error instanceof AssetTransportError) throw error;
    throw new AssetTransportError(
      "INVALID_RESPONSE",
      "ASSET_READY payload is invalid",
      "transient",
    );
  }
}

export class BoardAssetHttpTransport implements AssetUploadTransport {
  private readonly boardId: string;
  private readonly generation: number;
  private readonly csrfToken: () => string;
  private readonly endpoint: string;
  private readonly fetch: typeof fetch;
  private readonly controllers = new Set<AbortController>();

  constructor(options: BoardAssetHttpTransportOptions) {
    this.boardId = validateId(options.boardId, "boardId");
    this.generation = validateGeneration(options.generation);
    this.csrfToken = options.csrfToken;
    this.endpoint = (options.endpoint ?? "/api/board-v2/assets")
      .replace(/\/+$/u, "");
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  cancelPending(): void {
    for (const controller of this.controllers) controller.abort();
  }

  async begin(
    input: Parameters<AssetUploadTransport["begin"]>[0],
  ): ReturnType<AssetUploadTransport["begin"]> {
    const result = await this.requestJson<unknown>(
      `${this.endpoint}/begin`,
      {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify({
          boardId: this.boardId,
          generation: this.generation,
          ...input,
        }),
      },
    );
    if (!result || typeof result !== "object") {
      throw new AssetTransportError(
        "INVALID_RESPONSE",
        "begin response is invalid",
        "transient",
      );
    }
    const record = result as Record<string, unknown>;
    if (record.status === "ready") {
      const asset = parseReady(record.asset);
      if (
        asset.assetId !== input.assetId
        || asset.sha256 !== input.sha256
        || asset.byteSize !== input.byteSize
      ) {
        throw new AssetTransportError(
          "INVALID_RESPONSE",
          "deduplicated asset identity does not match the request",
          "transient",
        );
      }
      return {
        status: "ready",
        asset,
        deduplicated: record.deduplicated === true,
      };
    }
    if (record.status !== "upload") {
      throw new AssetTransportError(
        "INVALID_RESPONSE",
        "begin response status is invalid",
        "transient",
      );
    }
    const nextOffset = nonNegativeInteger(record.nextOffset, "nextOffset");
    const expiresAt = stringField(record.expiresAt, "expiresAt");
    if (
      nextOffset > input.byteSize
      || !Number.isFinite(Date.parse(expiresAt))
    ) {
      throw new AssetTransportError(
        "INVALID_RESPONSE",
        "begin response upload state is invalid",
        "transient",
      );
    }
    return {
      status: "upload",
      uploadId: validateId(
        stringField(record.uploadId, "uploadId"),
        "uploadId",
      ),
      nextOffset,
      chunkBytes: positiveInteger(record.chunkBytes, "chunkBytes"),
      expiresAt,
    };
  }

  async writeChunk(
    input: Parameters<AssetUploadTransport["writeChunk"]>[0],
  ): ReturnType<AssetUploadTransport["writeChunk"]> {
    const query = scopeQuery(this.boardId, this.generation);
    const result = await this.requestJson<Record<string, unknown>>(
      `${this.endpoint}/${encodeURIComponent(validateId(input.assetId, "assetId"))}`
        + `/uploads/${encodeURIComponent(validateId(input.uploadId, "uploadId"))}`
        + `/chunks?${query}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-csrf-token": this.csrfToken(),
          "x-upload-offset": String(input.offset),
          "x-asset-chunk-sha256": input.chunkSha256,
        },
        body: Uint8Array.from(input.chunk).buffer,
      },
    );
    return {
      nextOffset: nonNegativeInteger(result.nextOffset, "nextOffset"),
      complete: result.complete === true,
      duplicate: result.duplicate === true,
    };
  }

  async finalize(
    input: Parameters<AssetUploadTransport["finalize"]>[0],
  ): ReturnType<AssetUploadTransport["finalize"]> {
    const result = await this.requestJson<unknown>(
      `${this.endpoint}/${encodeURIComponent(validateId(input.assetId, "assetId"))}`
        + `/uploads/${encodeURIComponent(validateId(input.uploadId, "uploadId"))}`
        + "/finalize",
      {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify({
          boardId: this.boardId,
          generation: this.generation,
        }),
      },
    );
    return parseReady(result);
  }

  async status(assetId: string): Promise<RemoteAssetStatus> {
    const requestedAssetId = validateId(assetId, "assetId");
    const result = await this.requestJson<unknown>(
      `${this.endpoint}/${encodeURIComponent(requestedAssetId)}`
        + `/status?${scopeQuery(this.boardId, this.generation)}`,
    );
    if (!result || typeof result !== "object") {
      throw new AssetTransportError(
        "INVALID_RESPONSE",
        "status response is invalid",
        "transient",
      );
    }
    const record = result as Record<string, unknown>;
    if (record.status === "ready") {
      const ready = parseReady(record);
      if (ready.assetId !== requestedAssetId) {
        throw new AssetTransportError(
          "INVALID_RESPONSE",
          "status response assetId does not match the request",
          "transient",
        );
      }
      return { status: "ready", ...ready };
    }
    const responseAssetId = validateId(
      stringField(record.assetId, "assetId"),
      "assetId",
    );
    const responseSha256 = stringField(record.sha256, "sha256");
    if (
      responseAssetId !== requestedAssetId
      || !SHA256_PATTERN.test(responseSha256)
    ) {
      throw new AssetTransportError(
        "INVALID_RESPONSE",
        "status response identity does not match the request",
        "transient",
      );
    }
    const common = {
      assetId: responseAssetId,
      sha256: responseSha256,
      byteSize: positiveInteger(record.byteSize, "byteSize"),
    };
    if (record.status === "pending") return { status: "pending", ...common };
    if (record.status === "rejected") {
      return {
        status: "rejected",
        ...common,
        errorCode:
          record.errorCode === null || typeof record.errorCode === "string"
            ? record.errorCode
            : null,
      };
    }
    throw new AssetTransportError(
      "INVALID_RESPONSE",
      "status response status is invalid",
      "transient",
    );
  }

  async download(
    assetId: string,
    expected: RemoteAssetReady,
  ): Promise<Blob> {
    const validatedAssetId = validateId(assetId, "assetId");
    if (expected.assetId !== validatedAssetId) {
      throw new AssetTransportError(
        "INVALID_RESPONSE",
        "download identity does not match the requested asset",
        "transient",
      );
    }
    return this.requestResponse(
      boardAssetContentUrl(
        { boardId: this.boardId, generation: this.generation },
        validatedAssetId,
        this.endpoint,
      ),
      {},
      async (response) => {
        const rawContentType = response.headers.get("content-type") ?? "";
        const contentType = rawContentType.split(";", 1)[0].trim().toLowerCase();
        const rawLength = response.headers.get("content-length");
        const contentLength = rawLength === null ? null : Number(rawLength);
        if (
          contentType !== expected.mimeType
          || (
            contentLength !== null
            && (
              !Number.isSafeInteger(contentLength)
              || contentLength !== expected.byteSize
            )
          )
        ) {
          throw new AssetTransportError(
            "INVALID_RESPONSE",
            "asset content headers do not match published metadata",
            "transient",
          );
        }
        let blob: Blob;
        try {
          blob = await response.blob();
        } catch (error) {
          throw new AssetTransportError(
            "NETWORK_ERROR",
            error instanceof Error
              ? error.message
              : "asset content download failed",
            "transient",
          );
        }
        if (blob.size !== expected.byteSize) {
          throw new AssetTransportError(
            "INVALID_RESPONSE",
            "asset content length does not match published metadata",
            "transient",
          );
        }
        return blob;
      },
    );
  }

  private jsonHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-csrf-token": this.csrfToken(),
    };
  }

  private async requestJson<T>(
    url: string,
    init: RequestInit = {},
  ): Promise<T> {
    return this.requestResponse(url, init, async (response) => {
      try {
        return await response.json() as T;
      } catch {
        throw new AssetTransportError(
          "INVALID_RESPONSE",
          "asset server returned invalid JSON",
          "transient",
        );
      }
    });
  }

  private async requestResponse<T>(
    url: string,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      let response: Response;
      try {
        response = await this.fetch(url, {
          credentials: "include",
          ...init,
          signal: controller.signal,
        });
      } catch (error) {
        throw new AssetTransportError(
          "NETWORK_ERROR",
          error instanceof Error ? error.message : "asset request failed",
          "transient",
        );
      }
      if (!response.ok) throw await responseError(response);
      return await consume(response);
    } finally {
      this.controllers.delete(controller);
    }
  }
}
