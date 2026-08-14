import { describe, expect, it } from "vitest";

import {
  CollaborationProfileValidationError,
  normalizeCollaborationColor,
  normalizeCollaborationDisplayName,
  normalizeCollaborationProfile,
} from "./collaborationProfile.js";

describe("collaboration profile", () => {
  it("normalizes display names and canonicalizes colors", () => {
    expect(normalizeCollaborationProfile({
      displayName: "  Ａlice\u00a0  Example  ",
      color: "#A1B2C3",
    })).toEqual({
      displayName: "Alice Example",
      color: "#a1b2c3",
    });
    expect(normalizeCollaborationColor("#000000")).toBe("#000000");
  });

  it.each([
    "Alice\nBob",
    "Alice\tBob",
    "Alice\u2028Bob",
    "Alice\u202eBob",
    "\u0000Alice",
    " ",
    "a".repeat(61),
  ])("rejects unsafe display name %#", (displayName) => {
    expect(() => normalizeCollaborationDisplayName(displayName))
      .toThrowError(CollaborationProfileValidationError);
  });

  it.each([
    "#12345",
    "#1234567",
    "123456",
    "#gg0000",
    "rgb(1, 2, 3)",
  ])("rejects non-hex color %#", (color) => {
    expect(() => normalizeCollaborationColor(color))
      .toThrowError(CollaborationProfileValidationError);
  });

  it("requires an exact plain profile object", () => {
    expect(() => normalizeCollaborationProfile({
      displayName: "Alice",
      color: "#123456",
      role: "tutor",
    })).toThrowError(CollaborationProfileValidationError);
    expect(() => normalizeCollaborationProfile(null))
      .toThrowError(CollaborationProfileValidationError);
  });
});
