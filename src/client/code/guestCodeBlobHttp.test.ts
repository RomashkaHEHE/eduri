import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CodeWorkspaceBlobIdentity } from "../../code/core";
import {
  GuestCodeBlobHttpClient,
  GuestCodeBlobHttpError,
} from "./guestCodeBlobHttp";

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function identity(bytes: Uint8Array): CodeWorkspaceBlobIdentity {
  return {
    sha256: hash(bytes),
    byteSize: bytes.byteLength,
    mimeType: "application/octet-stream",
  };
}

function blob(bytes: Uint8Array): Blob {
  return new Blob([Uint8Array.from(bytes).buffer], {
    type: "application/octet-stream",
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GuestCodeBlobHttpClient", () => {
  it("uploads resumable chunks with byte offsets and verified chunk hashes", async () => {
    const bytes = Uint8Array.of(1, 2, 3, 4, 5, 6, 7);
    const expected = identity(bytes);
    const chunks: Array<{ offset: number; bytes: Uint8Array; hash: string }> = [];
    const fetchMock = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/begin")) {
        expect(init?.method).toBe("POST");
        expect(init?.credentials).toBe("same-origin");
        expect(JSON.parse(String(init?.body))).toEqual(expected);
        return json({
          status: "upload",
          uploadId: "upload-1",
          nextOffset: 1,
          chunkBytes: 3,
          expiresAt: "2026-08-09T09:00:00.000Z",
        });
      }
      if (url.endsWith("/uploads/upload-1/chunks")) {
        const headers = new Headers(init?.headers);
        const offset = Number(headers.get("x-upload-offset"));
        const body = new Uint8Array(init?.body as ArrayBuffer);
        chunks.push({
          offset,
          bytes: body,
          hash: headers.get("x-chunk-sha256") ?? "",
        });
        return json({ nextOffset: offset + body.byteLength });
      }
      if (url.endsWith("/uploads/upload-1/finalize")) {
        expect(init?.method).toBe("POST");
        return json({ status: "ready", blob: expected });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const client = new GuestCodeBlobHttpClient({
      shareId: "share/id",
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.upload(expected, blob(bytes))).resolves.toBeUndefined();
    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.offset)).toEqual([1, 4]);
    expect(chunks.map((chunk) => [...chunk.bytes])).toEqual([
      [2, 3, 4],
      [5, 6, 7],
    ]);
    expect(chunks.map((chunk) => chunk.hash)).toEqual(
      chunks.map((chunk) => hash(chunk.bytes)),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/api/guest/rooms/share%2Fid/code-blobs/begin",
    );
  });

  it("rejects a full-content hash mismatch before starting a request", async () => {
    const bytes = Uint8Array.of(9, 8, 7);
    const fetchMock = vi.fn<typeof fetch>();
    const client = new GuestCodeBlobHttpClient({
      shareId: "share",
      fetch: fetchMock,
    });

    await expect(client.upload({
      ...identity(bytes),
      sha256: "0".repeat(64),
    }, blob(bytes))).rejects.toMatchObject({
      name: "GuestCodeBlobHttpError",
      code: "HASH_MISMATCH",
      retryable: false,
    });
    await expect(client.upload(
      identity(bytes),
      new Blob([Uint8Array.from(bytes).buffer], { type: "text/plain" }),
    )).rejects.toThrow("mimeType");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verifies status identity and downloaded bytes", async () => {
    const bytes = Uint8Array.of(11, 22, 33, 44);
    const expected = identity(bytes);
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/status")) {
        return json({ status: "ready", blob: expected });
      }
      if (url.endsWith("/content")) {
        return new Response(Uint8Array.from(bytes).buffer, {
          headers: { "x-eduri-blob-mime": expected.mimeType },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const client = new GuestCodeBlobHttpClient({
      shareId: "share",
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.status(expected)).resolves.toBe(true);
    const downloaded = await client.download(expected);
    expect(downloaded.type).toBe(expected.mimeType);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
  });

  it("rejects invalid server offsets and corrupt downloads", async () => {
    const bytes = Uint8Array.of(3, 1, 4, 1);
    const expected = identity(bytes);
    const invalidOffset = new GuestCodeBlobHttpClient({
      shareId: "share",
      fetch: vi.fn(async (input: RequestInfo | URL): Promise<Response> => (
        String(input).endsWith("/begin")
          ? json({
              status: "upload",
              uploadId: "upload-2",
              nextOffset: 0,
              chunkBytes: 2,
              expiresAt: "2026-08-09T09:00:00.000Z",
            })
          : json({ nextOffset: 1 })
      )) as typeof fetch,
    });
    await expect(invalidOffset.upload(expected, blob(bytes))).rejects
      .toMatchObject({ code: "INVALID_RESPONSE", retryable: true });

    const corruptDownload = new GuestCodeBlobHttpClient({
      shareId: "share",
      fetch: vi.fn(async () => new Response(
        Uint8Array.from([3, 1, 4, 2]).buffer,
        { headers: { "x-eduri-blob-mime": expected.mimeType } },
      )) as typeof fetch,
    });
    await expect(corruptDownload.download(expected)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("preserves server error codes, status, and retryability", async () => {
    const bytes = Uint8Array.of(5, 5, 5);
    const client = new GuestCodeBlobHttpClient({
      shareId: "share",
      fetch: vi.fn(async () => json({
        code: "RATE_LIMITED",
        error: "Try later",
        retryable: true,
      }, 429)) as typeof fetch,
    });

    const operation = client.upload(identity(bytes), blob(bytes));
    await expect(operation).rejects.toBeInstanceOf(GuestCodeBlobHttpError);
    await expect(operation).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: "Try later",
      status: 429,
      retryable: true,
    });
  });
});
