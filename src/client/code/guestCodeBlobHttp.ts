import type { CodeWorkspaceBlobIdentity } from "../../code/core";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MIME_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const MAX_BLOB_BYTES = 32 * 1024 * 1024;

interface BeginUpload {
  readonly status: "upload";
  readonly uploadId: string;
  readonly nextOffset: number;
  readonly chunkBytes: number;
  readonly expiresAt: string;
}

interface ReadyUpload {
  readonly status: "ready";
  readonly blob: CodeWorkspaceBlobIdentity;
}

export interface GuestCodeBlobUploader {
  upload(
    identity: CodeWorkspaceBlobIdentity,
    blob: Blob,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface GuestCodeBlobHttpOptions {
  readonly shareId: string;
  readonly endpoint?: string;
  readonly fetch?: typeof fetch;
}

export class GuestCodeBlobHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GuestCodeBlobHttpError";
  }
}

function validateIdentity(
  identity: CodeWorkspaceBlobIdentity,
): CodeWorkspaceBlobIdentity {
  const mimeType = identity.mimeType.trim().toLowerCase();
  if (!SHA256_PATTERN.test(identity.sha256)) {
    throw new TypeError("Code blob sha256 is invalid");
  }
  if (
    !Number.isSafeInteger(identity.byteSize)
    || identity.byteSize < 1
    || identity.byteSize > MAX_BLOB_BYTES
  ) {
    throw new TypeError("Code blob byteSize is invalid");
  }
  if (mimeType.length > 255 || !MIME_PATTERN.test(mimeType)) {
    throw new TypeError("Code blob mimeType is invalid");
  }
  return { ...identity, mimeType };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseIdentity(value: unknown): CodeWorkspaceBlobIdentity {
  const input = object(value);
  if (!input) throw invalidResponse("Code blob identity is invalid");
  try {
    return validateIdentity({
      sha256: String(input.sha256 ?? ""),
      byteSize: input.byteSize as number,
      mimeType: String(input.mimeType ?? ""),
    });
  } catch {
    throw invalidResponse("Code blob identity is invalid");
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalidResponse(`${label} is invalid`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidResponse(`${label} is invalid`);
  }
  return value as number;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1) {
    throw invalidResponse(`${label} is invalid`);
  }
  return value;
}

function invalidResponse(message: string): GuestCodeBlobHttpError {
  return new GuestCodeBlobHttpError(
    "INVALID_RESPONSE",
    message,
    null,
    true,
  );
}

function sameIdentity(
  left: CodeWorkspaceBlobIdentity,
  right: CodeWorkspaceBlobIdentity,
): boolean {
  return left.sha256 === right.sha256
    && left.byteSize === right.byteSize
    && left.mimeType === right.mimeType;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new GuestCodeBlobHttpError(
      "CRYPTO_UNAVAILABLE",
      "Web Crypto SHA-256 is unavailable",
      null,
      false,
    );
  }
  const copy = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function responseError(response: Response): Promise<GuestCodeBlobHttpError> {
  let payload: Record<string, unknown> | null = null;
  try {
    payload = object(await response.json());
  } catch {
    // Proxies may return an empty or non-JSON error response.
  }
  const code = typeof payload?.code === "string"
    ? payload.code
    : typeof payload?.errorCode === "string"
      ? payload.errorCode
      : `HTTP_${response.status}`;
  const message = typeof payload?.error === "string"
    ? payload.error
    : typeof payload?.message === "string"
      ? payload.message
      : `Code blob request failed with HTTP ${response.status}`;
  const retryable = payload?.retryable === true
    || response.status === 408
    || response.status === 425
    || response.status === 429
    || response.status >= 500;
  return new GuestCodeBlobHttpError(
    code,
    message,
    response.status,
    retryable,
  );
}

export class GuestCodeBlobHttpClient implements GuestCodeBlobUploader {
  private readonly endpoint: string;
  private readonly fetch: typeof fetch;

  constructor(options: GuestCodeBlobHttpOptions) {
    if (!options.shareId) throw new TypeError("shareId is required");
    this.endpoint = (
      options.endpoint
      ?? `/api/guest/rooms/${encodeURIComponent(options.shareId)}/code-blobs`
    ).replace(/\/+$/u, "");
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async upload(
    expectedIdentity: CodeWorkspaceBlobIdentity,
    blob: Blob,
    signal?: AbortSignal,
  ): Promise<void> {
    const identity = validateIdentity(expectedIdentity);
    if (!(blob instanceof Blob) || blob.size !== identity.byteSize) {
      throw new TypeError("Code blob bytes do not match byteSize");
    }
    const blobMimeType = blob.type.trim().toLowerCase()
      || "application/octet-stream";
    if (blobMimeType !== identity.mimeType) {
      throw new TypeError("Code blob bytes do not match mimeType");
    }
    const actualHash = await sha256(new Uint8Array(await blob.arrayBuffer()));
    if (actualHash !== identity.sha256) {
      throw new GuestCodeBlobHttpError(
        "HASH_MISMATCH",
        "Code blob bytes do not match sha256",
        null,
        false,
      );
    }

    const started = await this.begin(identity, signal);
    if (started.status === "ready") {
      if (!sameIdentity(started.blob, identity)) {
        throw invalidResponse("Published Code blob identity does not match");
      }
      return;
    }
    if (
      started.nextOffset > identity.byteSize
      || started.chunkBytes > 1024 * 1024
    ) {
      throw invalidResponse("Code blob upload session is invalid");
    }

    let offset = started.nextOffset;
    while (offset < identity.byteSize) {
      const end = Math.min(identity.byteSize, offset + started.chunkBytes);
      const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      const response = await this.fetch(
        `${this.endpoint}/uploads/${encodeURIComponent(started.uploadId)}/chunks`,
        {
          method: "PUT",
          credentials: "same-origin",
          headers: {
            "content-type": "application/octet-stream",
            "x-upload-offset": String(offset),
            "x-chunk-sha256": await sha256(chunk),
          },
          body: Uint8Array.from(chunk).buffer,
          signal,
        },
      );
      const result = await this.json(response);
      const nextOffset = nonNegativeInteger(result.nextOffset, "nextOffset");
      if (nextOffset < end || nextOffset > identity.byteSize) {
        throw invalidResponse("Code blob server returned an invalid offset");
      }
      offset = nextOffset;
    }

    const response = await this.fetch(
      `${this.endpoint}/uploads/${encodeURIComponent(started.uploadId)}/finalize`,
      {
        method: "POST",
        credentials: "same-origin",
        signal,
      },
    );
    const result = await this.json(response);
    if (result.status !== "ready") {
      throw invalidResponse("Code blob finalize response is invalid");
    }
    const published = parseIdentity(result.blob);
    if (!sameIdentity(published, identity)) {
      throw invalidResponse("Published Code blob identity does not match");
    }
  }

  async status(
    expectedIdentity: CodeWorkspaceBlobIdentity,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const identity = validateIdentity(expectedIdentity);
    const response = await this.fetch(
      `${this.endpoint}/${encodeURIComponent(identity.sha256)}/status`,
      { credentials: "same-origin", signal },
    );
    if (response.status === 404) return false;
    const result = await this.json(response);
    if (result.status !== "ready") {
      throw invalidResponse("Code blob status response is invalid");
    }
    if (!sameIdentity(parseIdentity(result.blob), identity)) {
      throw invalidResponse("Code blob status identity does not match");
    }
    return true;
  }

  async download(
    expectedIdentity: CodeWorkspaceBlobIdentity,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const identity = validateIdentity(expectedIdentity);
    const response = await this.fetch(
      `${this.endpoint}/${encodeURIComponent(identity.sha256)}/content`,
      { credentials: "same-origin", signal },
    );
    if (!response.ok) throw await responseError(response);
    const mimeType = response.headers.get("x-eduri-blob-mime")
      ?.trim().toLowerCase();
    if (mimeType !== identity.mimeType) {
      throw invalidResponse("Downloaded Code blob MIME does not match");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (
      bytes.byteLength !== identity.byteSize
      || await sha256(bytes) !== identity.sha256
    ) {
      throw invalidResponse("Downloaded Code blob bytes do not match identity");
    }
    return new Blob([bytes], { type: identity.mimeType });
  }

  private async begin(
    identity: CodeWorkspaceBlobIdentity,
    signal?: AbortSignal,
  ): Promise<BeginUpload | ReadyUpload> {
    const response = await this.fetch(`${this.endpoint}/begin`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(identity),
      signal,
    });
    const result = await this.json(response);
    if (result.status === "ready") {
      return { status: "ready", blob: parseIdentity(result.blob) };
    }
    if (result.status !== "upload") {
      throw invalidResponse("Code blob begin response is invalid");
    }
    const expiresAt = nonEmptyString(result.expiresAt, "expiresAt");
    if (!Number.isFinite(Date.parse(expiresAt))) {
      throw invalidResponse("expiresAt is invalid");
    }
    return {
      status: "upload",
      uploadId: nonEmptyString(result.uploadId, "uploadId"),
      nextOffset: nonNegativeInteger(result.nextOffset, "nextOffset"),
      chunkBytes: positiveInteger(result.chunkBytes, "chunkBytes"),
      expiresAt,
    };
  }

  private async json(response: Response): Promise<Record<string, unknown>> {
    if (!response.ok) throw await responseError(response);
    try {
      const result = object(await response.json());
      if (!result) throw invalidResponse("Code blob response is not an object");
      return result;
    } catch (error) {
      if (error instanceof GuestCodeBlobHttpError) throw error;
      throw invalidResponse("Code blob response is not valid JSON");
    }
  }
}
