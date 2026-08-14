import {
  COLLABORATION_PROFILE_DISPLAY_NAME_MAX_BYTES,
  normalizeCollaborationProfile,
  type CollaborationProfile,
} from "../../shared/collaborationProfile.js";

export const BOARD_PROFILE_CONTROL_VERSION = 1;
export const BOARD_PROFILE_COLOR_BYTES = 7;
export const BOARD_PROFILE_ERROR_MAX_BYTES = 512;
export const BOARD_PROFILE_UPDATE_PAYLOAD_MAX_BYTES =
  1 + 2 + COLLABORATION_PROFILE_DISPLAY_NAME_MAX_BYTES
  + BOARD_PROFILE_COLOR_BYTES;
export const BOARD_PROFILE_UPDATED_PAYLOAD_MAX_BYTES = Math.max(
  1 + 1 + 2 + COLLABORATION_PROFILE_DISPLAY_NAME_MAX_BYTES
    + BOARD_PROFILE_COLOR_BYTES,
  1 + 1 + 2 + BOARD_PROFILE_ERROR_MAX_BYTES,
);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export class BoardProfileControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardProfileControlError";
  }
}

export type BoardProfileUpdatedPayload =
  | {
      readonly accepted: true;
      readonly profile: CollaborationProfile;
    }
  | {
      readonly accepted: false;
      readonly error: string;
    };

function encodeBoundedText(
  value: string,
  maximumBytes: number,
  field: string,
): Uint8Array {
  if (typeof value !== "string") {
    throw new BoardProfileControlError(`${field} must be text`);
  }
  const bytes = textEncoder.encode(value);
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new BoardProfileControlError(
      `${field} must contain between 1 and ${maximumBytes} UTF-8 bytes`,
    );
  }
  return bytes;
}

function writeUint16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value >>> 8;
  target[offset + 1] = value & 0xff;
}

function readUint16(source: Uint8Array, offset: number): number {
  if (offset + 2 > source.byteLength) {
    throw new BoardProfileControlError("Profile control payload is truncated");
  }
  return source[offset] * 0x100 + source[offset + 1];
}

function decodeText(
  source: Uint8Array,
  offset: number,
  byteLength: number,
  maximumBytes: number,
  field: string,
): string {
  if (byteLength < 1 || byteLength > maximumBytes) {
    throw new BoardProfileControlError(`${field} length is invalid`);
  }
  if (offset + byteLength > source.byteLength) {
    throw new BoardProfileControlError("Profile control payload is truncated");
  }
  try {
    return textDecoder.decode(source.subarray(offset, offset + byteLength));
  } catch {
    throw new BoardProfileControlError(`${field} is not valid UTF-8`);
  }
}

function assertPayload(
  payload: Uint8Array,
  maximumBytes: number,
): void {
  if (!(payload instanceof Uint8Array)) {
    throw new BoardProfileControlError("Profile control payload must be bytes");
  }
  if (payload.byteLength === 0 || payload.byteLength > maximumBytes) {
    throw new BoardProfileControlError("Profile control payload size is invalid");
  }
  if (payload[0] !== BOARD_PROFILE_CONTROL_VERSION) {
    throw new BoardProfileControlError("Profile control version is unsupported");
  }
}

function encodeProfileBody(profile: CollaborationProfile): Uint8Array {
  const normalized = normalizeCollaborationProfile(profile);
  const displayName = encodeBoundedText(
    normalized.displayName,
    COLLABORATION_PROFILE_DISPLAY_NAME_MAX_BYTES,
    "Display name",
  );
  const color = encodeBoundedText(
    normalized.color,
    BOARD_PROFILE_COLOR_BYTES,
    "Profile color",
  );
  if (color.byteLength !== BOARD_PROFILE_COLOR_BYTES) {
    throw new BoardProfileControlError("Profile color length is invalid");
  }
  const result = new Uint8Array(2 + displayName.byteLength + color.byteLength);
  writeUint16(result, 0, displayName.byteLength);
  result.set(displayName, 2);
  result.set(color, 2 + displayName.byteLength);
  return result;
}

function decodeProfileBody(
  payload: Uint8Array,
  offset: number,
): { profile: CollaborationProfile; raw: CollaborationProfile } {
  const displayNameBytes = readUint16(payload, offset);
  const displayNameOffset = offset + 2;
  const colorOffset = displayNameOffset + displayNameBytes;
  const expectedLength = colorOffset + BOARD_PROFILE_COLOR_BYTES;
  if (payload.byteLength !== expectedLength) {
    throw new BoardProfileControlError("Profile control payload length is invalid");
  }
  const raw = {
    displayName: decodeText(
      payload,
      displayNameOffset,
      displayNameBytes,
      COLLABORATION_PROFILE_DISPLAY_NAME_MAX_BYTES,
      "Display name",
    ),
    color: decodeText(
      payload,
      colorOffset,
      BOARD_PROFILE_COLOR_BYTES,
      BOARD_PROFILE_COLOR_BYTES,
      "Profile color",
    ) as `#${string}`,
  };
  return {
    raw,
    profile: normalizeCollaborationProfile(raw),
  };
}

export function encodeBoardProfileUpdatePayload(
  profile: CollaborationProfile,
): Uint8Array {
  const body = encodeProfileBody(profile);
  const result = new Uint8Array(1 + body.byteLength);
  result[0] = BOARD_PROFILE_CONTROL_VERSION;
  result.set(body, 1);
  return result;
}

export function decodeBoardProfileUpdatePayload(
  payload: Uint8Array,
): CollaborationProfile {
  assertPayload(payload, BOARD_PROFILE_UPDATE_PAYLOAD_MAX_BYTES);
  const { raw } = decodeProfileBody(payload, 1);
  return raw;
}

export function encodeBoardProfileUpdatedPayload(
  result: BoardProfileUpdatedPayload,
): Uint8Array {
  if (result.accepted) {
    const body = encodeProfileBody(result.profile);
    const payload = new Uint8Array(2 + body.byteLength);
    payload[0] = BOARD_PROFILE_CONTROL_VERSION;
    payload[1] = 1;
    payload.set(body, 2);
    return payload;
  }

  const error = encodeBoundedText(
    result.error,
    BOARD_PROFILE_ERROR_MAX_BYTES,
    "Profile rejection",
  );
  const payload = new Uint8Array(4 + error.byteLength);
  payload[0] = BOARD_PROFILE_CONTROL_VERSION;
  payload[1] = 0;
  writeUint16(payload, 2, error.byteLength);
  payload.set(error, 4);
  return payload;
}

export function decodeBoardProfileUpdatedPayload(
  payload: Uint8Array,
): BoardProfileUpdatedPayload {
  assertPayload(payload, BOARD_PROFILE_UPDATED_PAYLOAD_MAX_BYTES);
  if (payload.byteLength < 2) {
    throw new BoardProfileControlError("Profile result payload is truncated");
  }
  if (payload[1] === 1) {
    const { profile, raw } = decodeProfileBody(payload, 2);
    if (
      profile.displayName !== raw.displayName
      || profile.color !== raw.color
    ) {
      throw new BoardProfileControlError("Accepted profile is not canonical");
    }
    return { accepted: true, profile };
  }
  if (payload[1] !== 0) {
    throw new BoardProfileControlError("Profile result status is invalid");
  }
  const errorBytes = readUint16(payload, 2);
  if (payload.byteLength !== 4 + errorBytes) {
    throw new BoardProfileControlError("Profile rejection payload length is invalid");
  }
  return {
    accepted: false,
    error: decodeText(
      payload,
      4,
      errorBytes,
      BOARD_PROFILE_ERROR_MAX_BYTES,
      "Profile rejection",
    ),
  };
}
