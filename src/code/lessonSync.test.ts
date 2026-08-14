import { describe, expect, it } from "vitest";
import { CodeProtocolError } from "./protocol/index.js";
import {
  LESSON_CODE_SYNC_NAMESPACE,
  parseLessonCodeSyncHandshakeAuth,
} from "./lessonSync.js";

describe("lesson Code sync handshake", () => {
  it("accepts one exact lesson/device identity", () => {
    expect(LESSON_CODE_SYNC_NAMESPACE).toBe("/lesson-code-sync");
    expect(parseLessonCodeSyncHandshakeAuth({
      lessonId: "1c65c8df-544b-4a10-a5a8-dffb8764787b",
      deviceId: "device_01",
    })).toEqual({
      lessonId: "1c65c8df-544b-4a10-a5a8-dffb8764787b",
      deviceId: "device_01",
    });
    expect(parseLessonCodeSyncHandshakeAuth({
      lessonId: "1c65c8df-544b-4a10-a5a8-dffb8764787b",
      deviceId: "device_01",
      profile: { displayName: "  Tutor   Name ", color: "#ABCDEF" },
    })).toEqual({
      lessonId: "1c65c8df-544b-4a10-a5a8-dffb8764787b",
      deviceId: "device_01",
      profile: { displayName: "Tutor Name", color: "#abcdef" },
    });
  });

  it.each([
    null,
    {},
    { lessonId: "1c65c8df-544b-4a10-a5a8-dffb8764787b" },
    {
      lessonId: "1c65c8df-544b-4a10-a5a8-dffb8764787b",
      deviceId: "device",
      extra: true,
    },
    { lessonId: "not-a-uuid", deviceId: "device" },
    {
      lessonId: "1c65c8df-544b-4a10-a5a8-dffb8764787b",
      deviceId: "bad device",
    },
    {
      lessonId: "1c65c8df-544b-4a10-a5a8-dffb8764787b",
      deviceId: "device",
      profile: { displayName: "Tutor\u202eAdmin", color: "#abcdef" },
    },
  ])("rejects malformed or extended auth %#", (input) => {
    expect(() => parseLessonCodeSyncHandshakeAuth(input))
      .toThrowError(CodeProtocolError);
  });
});
