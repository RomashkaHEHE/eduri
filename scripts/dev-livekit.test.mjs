import { describe, expect, it } from "vitest";
import {
  LIVEKIT_DEV_API_SECRET,
  LIVEKIT_DEV_VERSION,
  liveKitReleaseAsset,
  sha256Hex,
} from "./dev-livekit.mjs";

describe("local LiveKit launcher", () => {
  it("selects the pinned Windows binary used by local development", () => {
    expect(liveKitReleaseAsset("win32", "x64")).toEqual({
      name: `livekit_${LIVEKIT_DEV_VERSION}_windows_amd64.zip`,
      sha256: "a326e025de516e93dfb3719bcd28e5a4ac16f21bcf1ef562499403ca98cc65fe",
      executable: "livekit-server.exe",
    });
  });

  it("rejects unsupported platforms instead of downloading an arbitrary asset", () => {
    expect(() => liveKitReleaseAsset("darwin", "x64"))
      .toThrow(/LIVEKIT_DEV_BINARY/u);
  });

  it("computes the release archive digest deterministically", () => {
    expect(sha256Hex(Buffer.from("eduri-livekit", "utf8")))
      .toBe("23a331d79fcbe4001c008bcf3d2ef52f71f15270d0083d64ad348d1de1715b96");
  });

  it("uses a development secret accepted by current LiveKit", () => {
    expect(Buffer.byteLength(LIVEKIT_DEV_API_SECRET)).toBeGreaterThanOrEqual(32);
  });
});
