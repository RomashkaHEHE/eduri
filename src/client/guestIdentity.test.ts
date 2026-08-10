// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  guestDeviceId,
  resetGuestDeviceIdForTests,
} from "./guestIdentity";

describe("guestDeviceId", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetGuestDeviceIdForTests();
  });

  it("persists a browser-scoped opaque identity", () => {
    const first = guestDeviceId();
    resetGuestDeviceIdForTests();
    expect(guestDeviceId()).toBe(first);
    expect(first).toMatch(/^[A-Za-z0-9_-]{32,128}$/u);
  });

  it("falls back to memory when localStorage is unavailable", () => {
    const read = vi.spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => { throw new DOMException("blocked"); });
    const write = vi.spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => { throw new DOMException("blocked"); });
    const first = guestDeviceId();
    expect(guestDeviceId()).toBe(first);
    read.mockRestore();
    write.mockRestore();
  });
});
