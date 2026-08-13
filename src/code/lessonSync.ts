import { CodeProtocolError } from "./protocol/index.js";

export const LESSON_CODE_SYNC_NAMESPACE = "/lesson-code-sync";

export interface LessonCodeSyncHandshakeAuth {
  readonly lessonId: string;
  readonly deviceId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEVICE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export function parseLessonCodeSyncHandshakeAuth(
  value: unknown,
): LessonCodeSyncHandshakeAuth {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) {
    throw new CodeProtocolError("Lesson Code sync auth must be an object");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (
    keys.length !== 2
    || !Object.prototype.hasOwnProperty.call(input, "lessonId")
    || !Object.prototype.hasOwnProperty.call(input, "deviceId")
  ) {
    throw new CodeProtocolError("Lesson Code sync auth fields are invalid");
  }
  if (typeof input.lessonId !== "string" || !UUID_PATTERN.test(input.lessonId)) {
    throw new CodeProtocolError("Lesson Code sync lessonId is invalid");
  }
  if (typeof input.deviceId !== "string" || !DEVICE_PATTERN.test(input.deviceId)) {
    throw new CodeProtocolError("Lesson Code sync deviceId is invalid");
  }
  return { lessonId: input.lessonId, deviceId: input.deviceId };
}
