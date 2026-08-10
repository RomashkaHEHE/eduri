import { describe, expect, it, vi } from "vitest";

import { AssetTransportError } from "./assetOutbox.js";
import {
  BoardAssetHttpTransport,
  boardAssetContentUrl,
  parseAssetReadyControlPayload,
} from "./assetHttpTransport.js";

const boardId = "018f7791-d659-7811-a418-b6226ee77be2";
const assetId = "018f7791-d659-7811-a418-b6226ee77be3";
const uploadId = "018f7791-d659-7811-a418-b6226ee77be4";
const sha256 = "a".repeat(64);

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function ready() {
  return {
    assetId,
    sha256,
    mimeType: "image/png",
    byteSize: 12,
    width: 2,
    height: 3,
    frameCount: 1,
    totalDecodedPixels: 6,
    publishedAt: "2026-07-28T00:00:00.000Z",
  };
}

describe("BoardAssetHttpTransport", () => {
  it("scopes begin requests and reads the current CSRF token per request", async () => {
    let csrf = "csrf-one";
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        status: "upload",
        uploadId,
        nextOffset: 4,
        chunkBytes: 1024,
        expiresAt: "2026-07-29T00:00:00.000Z",
      }))
      .mockResolvedValueOnce(jsonResponse({
        status: "ready",
        asset: ready(),
        deduplicated: true,
      }));
    const transport = new BoardAssetHttpTransport({
      boardId,
      generation: 3,
      csrfToken: () => csrf,
      fetch: fetchMock,
    });

    await expect(transport.begin({
      assetId,
      sha256,
      byteSize: 12,
      declaredMime: "image/png",
      originalFileName: "plot.png",
    })).resolves.toMatchObject({
      status: "upload",
      uploadId,
      nextOffset: 4,
    });
    csrf = "csrf-two";
    await expect(transport.begin({
      assetId,
      sha256,
      byteSize: 12,
      declaredMime: "image/png",
      originalFileName: null,
    })).resolves.toMatchObject({
      status: "ready",
      deduplicated: true,
    });

    const first = fetchMock.mock.calls[0];
    const second = fetchMock.mock.calls[1];
    expect(first[0]).toBe("/api/board-v2/assets/begin");
    expect(first[1]?.headers).toMatchObject({
      "content-type": "application/json",
      "x-csrf-token": "csrf-one",
    });
    expect(JSON.parse(String(first[1]?.body))).toMatchObject({
      boardId,
      generation: 3,
      assetId,
    });
    expect(second[1]?.headers).toMatchObject({
      "x-csrf-token": "csrf-two",
    });
  });

  it("sends bounded binary chunks with hash and acknowledged offset metadata", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      nextOffset: 3,
      complete: true,
      duplicate: false,
    }));
    const transport = new BoardAssetHttpTransport({
      boardId,
      generation: 2,
      csrfToken: () => "csrf",
      fetch: fetchMock,
    });
    await expect(transport.writeChunk({
      assetId,
      uploadId,
      offset: 0,
      chunk: Uint8Array.of(1, 2, 3),
      chunkSha256: sha256,
    })).resolves.toEqual({
      nextOffset: 3,
      complete: true,
      duplicate: false,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(
      `${assetId}/uploads/${uploadId}/chunks?boardId=${boardId}&generation=2`,
    );
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toMatchObject({
      "content-type": "application/octet-stream",
      "x-upload-offset": "0",
      "x-asset-chunk-sha256": sha256,
    });
    expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(
      Uint8Array.of(1, 2, 3),
    );
  });

  it("downloads private ready bytes with scoped credentials and metadata checks", async () => {
    const bytes = new Uint8Array(12).fill(7);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(bytes, {
        headers: {
          "content-length": String(bytes.byteLength),
          "content-type": "image/png",
        },
      }),
    );
    const transport = new BoardAssetHttpTransport({
      boardId,
      generation: 5,
      csrfToken: () => "csrf",
      fetch: fetchMock,
    });

    await expect(transport.download(assetId, ready())).resolves.toMatchObject({
      size: bytes.byteLength,
      type: "image/png",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/board-v2/assets/${assetId}/content?boardId=${boardId}&generation=5`,
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("parses ready controls and builds private content URLs", () => {
    const encoded = new TextEncoder().encode(JSON.stringify(ready()));
    expect(parseAssetReadyControlPayload(encoded)).toEqual(ready());
    expect(boardAssetContentUrl({ boardId, generation: 4 }, assetId)).toBe(
      `/api/board-v2/assets/${assetId}/content?boardId=${boardId}&generation=4`,
    );
    expect(() => parseAssetReadyControlPayload(Uint8Array.of(1, 2, 3)))
      .toThrow(AssetTransportError);
  });

  it.each([
    [403, { error: "revoked" }, "HTTP_403", "access"],
    [404, { code: "NOT_FOUND", error: "missing" }, "NOT_FOUND", "access"],
    [410, { code: "UPLOAD_GONE", error: "gone" }, "UPLOAD_GONE", "transient"],
    [422, { code: "DECODE_FAILED", error: "bad image" }, "DECODE_FAILED", "permanent"],
    [503, {
      code: "DISK_PRESSURE",
      error: "full",
      retryable: true,
      retryAfterMs: 12_000,
    }, "DISK_PRESSURE", "transient"],
  ])(
    "maps HTTP %s into an actionable transport error",
    async (status, payload, code, kind) => {
      const transport = new BoardAssetHttpTransport({
        boardId,
        generation: 1,
        csrfToken: () => "csrf",
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          jsonResponse(payload, status),
        ),
      });
      await expect(transport.status(assetId)).rejects.toMatchObject({
        code,
        kind,
        ...(code === "DISK_PRESSURE" ? { retryAfterMs: 12_000 } : {}),
      });
    },
  );

  it("treats fetch failures and malformed success bodies as transient", async () => {
    const offline = new BoardAssetHttpTransport({
      boardId,
      generation: 1,
      csrfToken: () => "csrf",
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")),
    });
    await expect(offline.status(assetId)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      kind: "transient",
    });

    const malformed = new BoardAssetHttpTransport({
      boardId,
      generation: 1,
      csrfToken: () => "csrf",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("not-json", { status: 200 }),
      ),
    });
    await expect(malformed.status(assetId)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      kind: "transient",
    });
  });

  it("aborts in-flight requests so session shutdown can drain", async () => {
    const fetchMock = vi.fn<typeof fetch>((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }));
    const transport = new BoardAssetHttpTransport({
      boardId,
      generation: 1,
      csrfToken: () => "csrf",
      fetch: fetchMock,
    });
    const pending = transport.status(assetId);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    transport.cancelPending();
    await expect(pending).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      kind: "transient",
    });
  });

  it("keeps a request cancellable while its response body is still streaming", async () => {
    const fetchMock = vi.fn<typeof fetch>((_input, init) =>
      Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          });
          controller.enqueue(new TextEncoder().encode('{"status":'));
        },
      }), {
        headers: { "content-type": "application/json" },
      })));
    const transport = new BoardAssetHttpTransport({
      boardId,
      generation: 1,
      csrfToken: () => "csrf",
      fetch: fetchMock,
    });

    const pending = transport.status(assetId);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    transport.cancelPending();
    await expect(pending).rejects.toMatchObject({
      kind: "transient",
    });
  });
});
