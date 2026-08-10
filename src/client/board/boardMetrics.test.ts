import { describe, expect, it, vi } from "vitest";

import {
  BoardMetricsRequestError,
  fetchBoardServerMetrics,
} from "./boardMetrics";

describe("fetchBoardServerMetrics", () => {
  it("requests private metrics and maps the validated response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({
        updateLogCount: 3,
        updateLogBytes: 42,
        idempotencyReceiptBytes: 512,
        storageMetadataBytes: 4096,
        quotaBytes: 8192,
        assetCount: 2,
        assetBytes: 1024,
        logicalBytes: 2048,
        physicalBytes: 900,
        compactedAt: "2026-07-28T01:02:03.000Z",
        measuredAt: "2026-07-28T01:02:04.000Z",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    ));

    await expect(fetchBoardServerMetrics(
      "lesson 1",
      fetchImpl,
      "https://eduri.test/lesson/lesson-1",
    )).resolves.toEqual({
      updateLogCount: 3,
      updateLogBytes: 42,
      idempotencyReceiptBytes: 512,
      storageMetadataBytes: 4096,
      quotaBytes: 8192,
      assetCount: 2,
      assetBytes: 1024,
      logicalBytes: 2048,
      physicalBytes: 900,
      compactedAt: "2026-07-28T01:02:03.000Z",
      syncedAt: "2026-07-28T01:02:04.000Z",
    });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      "https://eduri.test/api/board-v2/metrics?lessonId=lesson+1",
    );
    expect(options).toMatchObject({
      method: "GET",
      credentials: "include",
    });
  });

  it("rejects malformed sizes instead of poisoning the UI", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({
        updateLogCount: -1,
        updateLogBytes: 0,
        assetCount: 0,
        assetBytes: 0,
      }),
      { status: 200 },
    ));
    await expect(
      fetchBoardServerMetrics("lesson-1", fetchImpl),
    ).rejects.toThrow(/updateLogCount/u);
  });

  it("preserves the HTTP status for lifecycle handling", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: "Board access was revoked" }),
      {
        status: 403,
        headers: { "content-type": "application/json" },
      },
    ));
    await expect(
      fetchBoardServerMetrics("lesson-1", fetchImpl),
    ).rejects.toEqual(
      new BoardMetricsRequestError("Board access was revoked", 403),
    );
  });
});
