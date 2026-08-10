// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type GuestRoomDraft } from "./api";
import {
  clearPendingGuestFinalization,
  isDefinitiveGuestFinalizationFailure,
  loadPendingGuestFinalization,
  savePendingGuestFinalization,
  type GuestPromotionKind,
} from "./promotionFinalization";

const savedDrafts: Array<{
  readonly kind: GuestPromotionKind;
  readonly draft: GuestRoomDraft;
}> = [];

function draft(shareId: string, initializationToken: string): GuestRoomDraft {
  return {
    initializationToken,
    room: {
      shareId,
      createdAt: "2026-08-09T08:00:00.000Z",
      lastActivityAt: "2026-08-09T08:00:00.000Z",
      expiresAt: "2026-08-11T08:00:00.000Z",
      roomUrl: `/room/${shareId}`,
      resources: [],
    },
  };
}

function save(kind: GuestPromotionKind, value: GuestRoomDraft): void {
  savedDrafts.push({ kind, draft: value });
  savePendingGuestFinalization(kind, value);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const saved of savedDrafts.splice(0)) {
    clearPendingGuestFinalization(saved.kind, saved.draft);
  }
  window.localStorage.clear();
  loadPendingGuestFinalization("board");
  loadPendingGuestFinalization("code");
});

describe("guest promotion finalization recovery", () => {
  it("falls back to volatile state when the localStorage getter throws", () => {
    const pending = draft("getter-blocked", "getter-token");
    const storage = vi.spyOn(window, "localStorage", "get")
      .mockImplementation(() => {
        throw new DOMException("blocked");
      });

    save("board", pending);
    expect(loadPendingGuestFinalization("board")?.draft).toEqual(pending);
    expect(() => clearPendingGuestFinalization("board", pending)).not.toThrow();
    expect(loadPendingGuestFinalization("board")).toBeNull();

    storage.mockRestore();
  });

  it("keeps every storage operation exception-safe and uses its memory mirror", () => {
    const pending = draft("method-blocked", "method-token");
    savedDrafts.push({ kind: "board", draft: pending });
    const write = vi.spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("blocked");
      });
    expect(() => savePendingGuestFinalization("board", pending)).not.toThrow();
    expect(loadPendingGuestFinalization("board")?.draft).toEqual(pending);
    write.mockRestore();

    savePendingGuestFinalization("board", pending);
    const read = vi.spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("blocked");
      });
    expect(loadPendingGuestFinalization("board")?.draft).toEqual(pending);
    expect(() => clearPendingGuestFinalization("board", pending)).not.toThrow();
    read.mockRestore();

    expect(loadPendingGuestFinalization("board")?.draft).toEqual(pending);
    const remove = vi.spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {
        throw new DOMException("blocked");
      });
    expect(() => clearPendingGuestFinalization("board", pending)).not.toThrow();
    remove.mockRestore();
    expect(loadPendingGuestFinalization("board")?.draft).toEqual(pending);

    clearPendingGuestFinalization("board", pending);
    expect(loadPendingGuestFinalization("board")).toBeNull();
  });

  it("does not overwrite or clear another tab's ambiguous attempt", () => {
    const tabA = draft("tab-a-share", "tab-a-token");
    const tabB = draft("tab-b-share", "tab-b-token");
    save("code", tabA);
    save("code", tabB);

    clearPendingGuestFinalization("code", tabA);

    expect(loadPendingGuestFinalization("code")?.draft).toEqual(tabB);
    clearPendingGuestFinalization("code", tabB);
    expect(loadPendingGuestFinalization("code")).toBeNull();
  });

  it("classifies only terminal stale-draft responses as definitive", () => {
    expect(isDefinitiveGuestFinalizationFailure(
      new ApiError("Invalid initialization token", 400),
    )).toBe(true);
    expect(isDefinitiveGuestFinalizationFailure(
      new ApiError("Draft not found", 404),
    )).toBe(true);
    expect(isDefinitiveGuestFinalizationFailure(
      new ApiError("Draft expired", 410),
    )).toBe(true);
    expect(isDefinitiveGuestFinalizationFailure(
      new ApiError("Server unavailable", 503),
    )).toBe(false);
    expect(isDefinitiveGuestFinalizationFailure(
      new TypeError("Network unavailable"),
    )).toBe(false);
  });
});
