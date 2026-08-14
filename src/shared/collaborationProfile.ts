export const COLLABORATION_PROFILE_DISPLAY_NAME_MAX_CHARACTERS = 60;
export const COLLABORATION_PROFILE_DISPLAY_NAME_MAX_BYTES = 240;

export const COLLABORATION_PROFILE_COLORS = Object.freeze([
  "#2563eb",
  "#16825d",
  "#d33f49",
  "#d97706",
  "#7c3aed",
  "#0891b2",
] as const);

export interface CollaborationProfile {
  readonly displayName: string;
  readonly color: `#${string}`;
}

const COLOR_PATTERN = /^#[0-9a-f]{6}$/u;
const FORBIDDEN_DISPLAY_NAME_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const textEncoder = new TextEncoder();

export class CollaborationProfileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollaborationProfileValidationError";
  }
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CollaborationProfileValidationError(
      "Collaboration profile must be an object",
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CollaborationProfileValidationError(
      "Collaboration profile must be a plain object",
    );
  }
  return value as Record<string, unknown>;
}

export function normalizeCollaborationDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new CollaborationProfileValidationError("Display name must be text");
  }
  const canonical = value.normalize("NFKC");
  if (FORBIDDEN_DISPLAY_NAME_CHARACTERS.test(canonical)) {
    throw new CollaborationProfileValidationError("Display name is invalid");
  }
  const normalized = canonical.trim().replace(/\s+/gu, " ");
  if (
    normalized.length === 0
    || [...normalized].length
      > COLLABORATION_PROFILE_DISPLAY_NAME_MAX_CHARACTERS
    || textEncoder.encode(normalized).byteLength
      > COLLABORATION_PROFILE_DISPLAY_NAME_MAX_BYTES
  ) {
    throw new CollaborationProfileValidationError("Display name is invalid");
  }
  return normalized;
}

export function normalizeCollaborationColor(value: unknown): `#${string}` {
  if (typeof value !== "string") {
    throw new CollaborationProfileValidationError("Profile color must be text");
  }
  const normalized = value.toLowerCase();
  if (!COLOR_PATTERN.test(normalized)) {
    throw new CollaborationProfileValidationError(
      "Profile color must use #rrggbb",
    );
  }
  return normalized as `#${string}`;
}

export function normalizeCollaborationProfile(
  value: unknown,
): CollaborationProfile {
  const input = plainRecord(value);
  const keys = Object.keys(input);
  if (
    keys.length !== 2
    || !Object.prototype.hasOwnProperty.call(input, "displayName")
    || !Object.prototype.hasOwnProperty.call(input, "color")
  ) {
    throw new CollaborationProfileValidationError(
      "Collaboration profile fields are invalid",
    );
  }
  return Object.freeze({
    displayName: normalizeCollaborationDisplayName(input.displayName),
    color: normalizeCollaborationColor(input.color),
  });
}
