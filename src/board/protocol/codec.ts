import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

import {
  BOARD_PROTOCOL_LIMITS,
  BOARD_PROTOCOL_MAGIC,
  BOARD_PROTOCOL_VERSION,
  MESSAGE_ID_BYTES,
} from "./constants.js";
import {
  BoardMessageType,
  BoardPermission,
  BoardControlCode,
  type AckFrame,
  type AuthFrame,
  type AwarenessFrame,
  type BoardFrame,
  type BoardMessageId,
  type ChunkFrame,
  type ControlFrame,
  type ReadyFrame,
  type SyncStep1Frame,
  type SyncStep2Frame,
  type UpdateFrame,
} from "./types.js";
import { BoardProtocolError, BoardProtocolErrorCode } from "./errors.js";

type Decoder = decoding.Decoder<ArrayBufferLike>;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const knownControlCodes = new Set<number>(
  Object.values(BoardControlCode).filter(
    (value): value is number => typeof value === "number",
  ),
);

const CONTROL_HAS_DOC_KEY = 1 << 0;
const CONTROL_HAS_MESSAGE_ID = 1 << 1;
const CONTROL_KNOWN_FLAGS = CONTROL_HAS_DOC_KEY | CONTROL_HAS_MESSAGE_ID;

function protocolError(
  code: BoardProtocolErrorCode,
  message: string,
  cause?: unknown,
): BoardProtocolError {
  return new BoardProtocolError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function assertSafeUint(
  value: number,
  max: number,
  field: string,
  minimum = 0,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > max
  ) {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_FIELD,
      `${field} must be an integer between ${minimum} and ${max}`,
    );
  }
}

function assertUint32(value: number, field: string): void {
  assertSafeUint(value, 0xffff_ffff, field);
}

function assertBytes(
  value: Uint8Array,
  maxLength: number,
  field: string,
  allowEmpty = false,
): void {
  if (!(value instanceof Uint8Array)) {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_FIELD,
      `${field} must be a Uint8Array`,
    );
  }
  if ((!allowEmpty && value.byteLength === 0) || value.byteLength > maxLength) {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_LENGTH,
      `${field} length must be ${allowEmpty ? "between 0" : "between 1"} and ${maxLength} bytes`,
    );
  }
}

function assertMessageId(value: BoardMessageId, field = "messageId"): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== MESSAGE_ID_BYTES) {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_LENGTH,
      `${field} must contain exactly ${MESSAGE_ID_BYTES} bytes`,
    );
  }
}

function encodeUtf8(value: string, maxBytes: number, field: string): Uint8Array {
  if (typeof value !== "string") {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_FIELD,
      `${field} must be a string`,
    );
  }
  const encoded = utf8Encoder.encode(value);
  if (encoded.byteLength === 0 || encoded.byteLength > maxBytes) {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_LENGTH,
      `${field} must contain between 1 and ${maxBytes} UTF-8 bytes`,
    );
  }
  return encoded;
}

function assertNoControlCharacters(value: string, field: string): void {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_FIELD,
      `${field} cannot contain control characters`,
    );
  }
}

function encodeDocKey(value: string): Uint8Array {
  const encoded = encodeUtf8(
    value,
    BOARD_PROTOCOL_LIMITS.maxDocumentKeyBytes,
    "docKey",
  );
  assertNoControlCharacters(value, "docKey");
  return encoded;
}

function writeVarBytes(
  encoder: encoding.Encoder,
  value: Uint8Array,
): void {
  encoding.writeVarUint(encoder, value.byteLength);
  encoding.writeUint8Array(encoder, value);
}

function writeStringBytes(
  encoder: encoding.Encoder,
  value: Uint8Array,
): void {
  writeVarBytes(encoder, value);
}

function writeHeader(
  encoder: encoding.Encoder,
  type: BoardMessageType,
): void {
  encoding.writeUint32BigEndian(encoder, BOARD_PROTOCOL_MAGIC);
  encoding.writeUint8(encoder, BOARD_PROTOCOL_VERSION);
  encoding.writeUint8(encoder, type);
}

function writeGeneration(
  encoder: encoding.Encoder,
  generation: number,
): void {
  assertSafeUint(
    generation,
    BOARD_PROTOCOL_LIMITS.maxGeneration,
    "generation",
  );
  encoding.writeVarUint(encoder, generation);
}

function writeDocKey(encoder: encoding.Encoder, docKey: string): void {
  writeStringBytes(encoder, encodeDocKey(docKey));
}

function writeMessageId(
  encoder: encoding.Encoder,
  messageId: BoardMessageId,
): void {
  assertMessageId(messageId);
  encoding.writeUint8Array(encoder, messageId);
}

function encodeAuth(encoder: encoding.Encoder, frame: AuthFrame): void {
  writeGeneration(encoder, frame.generation);
  assertSafeUint(
    frame.minSchemaVersion,
    BOARD_PROTOCOL_LIMITS.maxSchemaVersion,
    "minSchemaVersion",
    1,
  );
  assertSafeUint(
    frame.maxSchemaVersion,
    BOARD_PROTOCOL_LIMITS.maxSchemaVersion,
    "maxSchemaVersion",
    1,
  );
  if (frame.minSchemaVersion > frame.maxSchemaVersion) {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_FIELD,
      "minSchemaVersion cannot exceed maxSchemaVersion",
    );
  }
  assertUint32(frame.capabilities, "capabilities");
  const ticket = encodeUtf8(
    frame.ticket,
    BOARD_PROTOCOL_LIMITS.maxTicketBytes,
    "ticket",
  );
  assertNoControlCharacters(frame.ticket, "ticket");

  encoding.writeVarUint(encoder, frame.minSchemaVersion);
  encoding.writeVarUint(encoder, frame.maxSchemaVersion);
  encoding.writeVarUint(encoder, frame.capabilities);
  writeStringBytes(encoder, ticket);
}

function encodeReady(encoder: encoding.Encoder, frame: ReadyFrame): void {
  writeGeneration(encoder, frame.generation);
  assertSafeUint(
    frame.schemaVersion,
    BOARD_PROTOCOL_LIMITS.maxSchemaVersion,
    "schemaVersion",
    1,
  );
  assertUint32(frame.capabilities, "capabilities");
  assertSafeUint(
    frame.awarenessClientId,
    BOARD_PROTOCOL_LIMITS.maxAwarenessClientId,
    "awarenessClientId",
  );
  assertSafeUint(frame.permissions, 0xff, "permissions");
  if ((frame.permissions & BoardPermission.READ) === 0) {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_FIELD,
      "READY permissions must include READ",
    );
  }

  encoding.writeVarUint(encoder, frame.schemaVersion);
  encoding.writeVarUint(encoder, frame.capabilities);
  encoding.writeVarUint(encoder, frame.awarenessClientId);
  encoding.writeVarUint(encoder, frame.permissions);
}

function encodeSyncStep1(
  encoder: encoding.Encoder,
  frame: SyncStep1Frame,
): void {
  writeGeneration(encoder, frame.generation);
  writeDocKey(encoder, frame.docKey);
  assertBytes(
    frame.stateVector,
    BOARD_PROTOCOL_LIMITS.maxStateVectorBytes,
    "stateVector",
  );
  writeVarBytes(encoder, frame.stateVector);
}

function encodeSyncStep2(
  encoder: encoding.Encoder,
  frame: SyncStep2Frame,
): void {
  writeGeneration(encoder, frame.generation);
  writeDocKey(encoder, frame.docKey);
  assertBytes(
    frame.update,
    BOARD_PROTOCOL_LIMITS.maxUpdateBytes,
    "update",
  );
  writeVarBytes(encoder, frame.update);
}

function encodeUpdate(encoder: encoding.Encoder, frame: UpdateFrame): void {
  writeGeneration(encoder, frame.generation);
  writeDocKey(encoder, frame.docKey);
  writeMessageId(encoder, frame.messageId);
  assertBytes(
    frame.update,
    BOARD_PROTOCOL_LIMITS.maxUpdateBytes,
    "update",
  );
  writeVarBytes(encoder, frame.update);
}

function encodeAck(encoder: encoding.Encoder, frame: AckFrame): void {
  writeGeneration(encoder, frame.generation);
  writeDocKey(encoder, frame.docKey);
  writeMessageId(encoder, frame.messageId);
  assertSafeUint(
    frame.durableSequence,
    BOARD_PROTOCOL_LIMITS.maxSequence,
    "durableSequence",
    1,
  );
  encoding.writeVarUint(encoder, frame.durableSequence);
}

function encodeAwareness(
  encoder: encoding.Encoder,
  frame: AwarenessFrame,
): void {
  writeGeneration(encoder, frame.generation);
  writeDocKey(encoder, frame.docKey);
  assertSafeUint(
    frame.awarenessClientId,
    BOARD_PROTOCOL_LIMITS.maxAwarenessClientId,
    "awarenessClientId",
  );
  assertBytes(
    frame.update,
    BOARD_PROTOCOL_LIMITS.maxAwarenessBytes,
    "awareness update",
  );
  encoding.writeVarUint(encoder, frame.awarenessClientId);
  writeVarBytes(encoder, frame.update);
}

function encodeControl(
  encoder: encoding.Encoder,
  frame: ControlFrame,
): void {
  writeGeneration(encoder, frame.generation);
  if (!knownControlCodes.has(frame.code)) {
    throw protocolError(
      BoardProtocolErrorCode.UNSUPPORTED_MESSAGE,
      `Unsupported CONTROL code ${String(frame.code)}`,
    );
  }
  assertBytes(
    frame.payload,
    BOARD_PROTOCOL_LIMITS.maxControlPayloadBytes,
    "control payload",
    true,
  );

  let flags = 0;
  if (frame.docKey !== undefined) {
    flags |= CONTROL_HAS_DOC_KEY;
  }
  if (frame.messageId !== undefined) {
    flags |= CONTROL_HAS_MESSAGE_ID;
  }

  encoding.writeVarUint(encoder, frame.code);
  encoding.writeUint8(encoder, flags);
  if (frame.docKey !== undefined) {
    writeDocKey(encoder, frame.docKey);
  }
  if (frame.messageId !== undefined) {
    writeMessageId(encoder, frame.messageId);
  }
  writeVarBytes(encoder, frame.payload);
}

function assertChunk(frame: ChunkFrame): void {
  assertMessageId(frame.messageId);
  if (
    frame.innerType !== BoardMessageType.SYNC_STEP2 &&
    frame.innerType !== BoardMessageType.UPDATE
  ) {
    throw protocolError(
      BoardProtocolErrorCode.UNSUPPORTED_MESSAGE,
      "CHUNK may contain only SYNC_STEP2 or UPDATE frames",
    );
  }
  assertSafeUint(
    frame.chunkCount,
    BOARD_PROTOCOL_LIMITS.maxChunkCount,
    "chunkCount",
    2,
  );
  assertSafeUint(
    frame.chunkIndex,
    frame.chunkCount - 1,
    "chunkIndex",
  );
  assertSafeUint(
    frame.totalLength,
    BOARD_PROTOCOL_LIMITS.maxReassembledBytes,
    "totalLength",
    1,
  );
  assertBytes(
    frame.payload,
    BOARD_PROTOCOL_LIMITS.maxChunkPayloadBytes,
    "chunk payload",
  );

  if (frame.totalLength <= frame.payload.byteLength) {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_LENGTH,
      "A CHUNK totalLength must be larger than an individual payload",
    );
  }
  const minimumChunks = Math.ceil(
    frame.totalLength / BOARD_PROTOCOL_LIMITS.maxChunkPayloadBytes,
  );
  if (frame.chunkCount < minimumChunks || frame.chunkCount > frame.totalLength) {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_LENGTH,
      "chunkCount cannot represent totalLength with bounded non-empty chunks",
    );
  }
}

function encodeChunk(encoder: encoding.Encoder, frame: ChunkFrame): void {
  assertChunk(frame);
  writeMessageId(encoder, frame.messageId);
  encoding.writeUint8(encoder, frame.innerType);
  encoding.writeVarUint(encoder, frame.chunkIndex);
  encoding.writeVarUint(encoder, frame.chunkCount);
  encoding.writeVarUint(encoder, frame.totalLength);
  writeVarBytes(encoder, frame.payload);
}

/**
 * Encodes exactly one Board v2 frame.
 */
export function encodeBoardFrame(frame: BoardFrame): Uint8Array {
  const encoder = encoding.createEncoder();
  writeHeader(encoder, frame.type);

  switch (frame.type) {
    case BoardMessageType.AUTH:
      encodeAuth(encoder, frame);
      break;
    case BoardMessageType.READY:
      encodeReady(encoder, frame);
      break;
    case BoardMessageType.SYNC_STEP1:
      encodeSyncStep1(encoder, frame);
      break;
    case BoardMessageType.SYNC_STEP2:
      encodeSyncStep2(encoder, frame);
      break;
    case BoardMessageType.UPDATE:
      encodeUpdate(encoder, frame);
      break;
    case BoardMessageType.ACK:
      encodeAck(encoder, frame);
      break;
    case BoardMessageType.AWARENESS:
      encodeAwareness(encoder, frame);
      break;
    case BoardMessageType.CONTROL:
      encodeControl(encoder, frame);
      break;
    case BoardMessageType.CHUNK:
      encodeChunk(encoder, frame);
      break;
    default: {
      const unsupported: never = frame;
      throw protocolError(
        BoardProtocolErrorCode.UNSUPPORTED_MESSAGE,
        `Unsupported frame ${String(unsupported)}`,
      );
    }
  }

  const result = encoding.toUint8Array(encoder);
  if (result.byteLength > BOARD_PROTOCOL_LIMITS.maxEncodedFrameBytes) {
    throw protocolError(
      BoardProtocolErrorCode.FRAME_TOO_LARGE,
      `Encoded frame exceeds ${BOARD_PROTOCOL_LIMITS.maxEncodedFrameBytes} bytes`,
    );
  }
  return result;
}

function ensureRemaining(
  decoder: Decoder,
  length: number,
  field: string,
): void {
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    decoder.pos + length > decoder.arr.byteLength
  ) {
    throw protocolError(
      BoardProtocolErrorCode.TRUNCATED,
      `Frame ended while reading ${field}`,
    );
  }
}

function readUint8(decoder: Decoder, field: string): number {
  ensureRemaining(decoder, 1, field);
  return decoding.readUint8(decoder);
}

function readUint32BigEndian(decoder: Decoder, field: string): number {
  ensureRemaining(decoder, 4, field);
  return decoding.readUint32BigEndian(decoder);
}

function varUintEncodedLength(value: number): number {
  let remaining = value;
  let length = 1;
  while (remaining >= 128) {
    remaining = Math.floor(remaining / 128);
    length += 1;
  }
  return length;
}

function readVarUint(
  decoder: Decoder,
  max: number,
  field: string,
  minimum = 0,
): number {
  const start = decoder.pos;
  let value: number;
  try {
    value = decoding.readVarUint(decoder);
  } catch (error) {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_VARUINT,
      `Invalid variable-length integer for ${field}`,
      error,
    );
  }
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > max
  ) {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_FIELD,
      `${field} must be an integer between ${minimum} and ${max}`,
    );
  }
  if (decoder.pos - start !== varUintEncodedLength(value)) {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_VARUINT,
      `${field} uses a non-canonical variable-length integer`,
    );
  }
  return value;
}

function readBytes(
  decoder: Decoder,
  length: number,
  field: string,
): Uint8Array {
  ensureRemaining(decoder, length, field);
  return decoding.readUint8Array(decoder, length);
}

function readVarBytes(
  decoder: Decoder,
  maxLength: number,
  field: string,
  allowEmpty = false,
): Uint8Array {
  const length = readVarUint(
    decoder,
    maxLength,
    `${field} length`,
    allowEmpty ? 0 : 1,
  );
  return readBytes(decoder, length, field);
}

function readUtf8(
  decoder: Decoder,
  maxBytes: number,
  field: string,
): string {
  const bytes = readVarBytes(decoder, maxBytes, field);
  try {
    return utf8Decoder.decode(bytes);
  } catch (error) {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_UTF8,
      `${field} is not valid UTF-8`,
      error,
    );
  }
}

function readDocKey(decoder: Decoder): string {
  const docKey = readUtf8(
    decoder,
    BOARD_PROTOCOL_LIMITS.maxDocumentKeyBytes,
    "docKey",
  );
  assertNoControlCharacters(docKey, "docKey");
  return docKey;
}

function readGeneration(decoder: Decoder): number {
  return readVarUint(
    decoder,
    BOARD_PROTOCOL_LIMITS.maxGeneration,
    "generation",
  );
}

function readMessageId(
  decoder: Decoder,
  field = "messageId",
): BoardMessageId {
  return readBytes(decoder, MESSAGE_ID_BYTES, field);
}

function decodeAuth(decoder: Decoder): AuthFrame {
  const generation = readGeneration(decoder);
  const minSchemaVersion = readVarUint(
    decoder,
    BOARD_PROTOCOL_LIMITS.maxSchemaVersion,
    "minSchemaVersion",
    1,
  );
  const maxSchemaVersion = readVarUint(
    decoder,
    BOARD_PROTOCOL_LIMITS.maxSchemaVersion,
    "maxSchemaVersion",
    1,
  );
  if (minSchemaVersion > maxSchemaVersion) {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_FIELD,
      "minSchemaVersion cannot exceed maxSchemaVersion",
    );
  }
  const capabilities = readVarUint(
    decoder,
    0xffff_ffff,
    "capabilities",
  );
  const ticket = readUtf8(
    decoder,
    BOARD_PROTOCOL_LIMITS.maxTicketBytes,
    "ticket",
  );
  assertNoControlCharacters(ticket, "ticket");
  return {
    type: BoardMessageType.AUTH,
    ticket,
    generation,
    minSchemaVersion,
    maxSchemaVersion,
    capabilities,
  };
}

function decodeReady(decoder: Decoder): ReadyFrame {
  const generation = readGeneration(decoder);
  const schemaVersion = readVarUint(
    decoder,
    BOARD_PROTOCOL_LIMITS.maxSchemaVersion,
    "schemaVersion",
    1,
  );
  const capabilities = readVarUint(
    decoder,
    0xffff_ffff,
    "capabilities",
  );
  const awarenessClientId = readVarUint(
    decoder,
    BOARD_PROTOCOL_LIMITS.maxAwarenessClientId,
    "awarenessClientId",
  );
  const permissions = readVarUint(decoder, 0xff, "permissions");
  if ((permissions & BoardPermission.READ) === 0) {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_FIELD,
      "READY permissions must include READ",
    );
  }
  return {
    type: BoardMessageType.READY,
    generation,
    schemaVersion,
    capabilities,
    awarenessClientId,
    permissions,
  };
}

function decodeSyncStep1(decoder: Decoder): SyncStep1Frame {
  return {
    type: BoardMessageType.SYNC_STEP1,
    generation: readGeneration(decoder),
    docKey: readDocKey(decoder),
    stateVector: readVarBytes(
      decoder,
      BOARD_PROTOCOL_LIMITS.maxStateVectorBytes,
      "stateVector",
    ),
  };
}

function decodeSyncStep2(decoder: Decoder): SyncStep2Frame {
  return {
    type: BoardMessageType.SYNC_STEP2,
    generation: readGeneration(decoder),
    docKey: readDocKey(decoder),
    update: readVarBytes(
      decoder,
      BOARD_PROTOCOL_LIMITS.maxUpdateBytes,
      "update",
    ),
  };
}

function decodeUpdate(decoder: Decoder): UpdateFrame {
  return {
    type: BoardMessageType.UPDATE,
    generation: readGeneration(decoder),
    docKey: readDocKey(decoder),
    messageId: readMessageId(decoder),
    update: readVarBytes(
      decoder,
      BOARD_PROTOCOL_LIMITS.maxUpdateBytes,
      "update",
    ),
  };
}

function decodeAck(decoder: Decoder): AckFrame {
  return {
    type: BoardMessageType.ACK,
    generation: readGeneration(decoder),
    docKey: readDocKey(decoder),
    messageId: readMessageId(decoder),
    durableSequence: readVarUint(
      decoder,
      BOARD_PROTOCOL_LIMITS.maxSequence,
      "durableSequence",
      1,
    ),
  };
}

function decodeAwareness(decoder: Decoder): AwarenessFrame {
  return {
    type: BoardMessageType.AWARENESS,
    generation: readGeneration(decoder),
    docKey: readDocKey(decoder),
    awarenessClientId: readVarUint(
      decoder,
      BOARD_PROTOCOL_LIMITS.maxAwarenessClientId,
      "awarenessClientId",
    ),
    update: readVarBytes(
      decoder,
      BOARD_PROTOCOL_LIMITS.maxAwarenessBytes,
      "awareness update",
    ),
  };
}

function decodeControl(decoder: Decoder): ControlFrame {
  const generation = readGeneration(decoder);
  const code = readVarUint(decoder, 0xff, "CONTROL code");
  if (!knownControlCodes.has(code)) {
    throw protocolError(
      BoardProtocolErrorCode.UNSUPPORTED_MESSAGE,
      `Unsupported CONTROL code ${code}`,
    );
  }
  const flags = readUint8(decoder, "CONTROL flags");
  if ((flags & ~CONTROL_KNOWN_FLAGS) !== 0) {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_FIELD,
      `CONTROL contains unknown flags 0x${flags.toString(16)}`,
    );
  }

  const docKey =
    (flags & CONTROL_HAS_DOC_KEY) !== 0 ? readDocKey(decoder) : undefined;
  const messageId =
    (flags & CONTROL_HAS_MESSAGE_ID) !== 0
      ? readMessageId(decoder)
      : undefined;
  const payload = readVarBytes(
    decoder,
    BOARD_PROTOCOL_LIMITS.maxControlPayloadBytes,
    "control payload",
    true,
  );
  return {
    type: BoardMessageType.CONTROL,
    generation,
    code: code as BoardControlCode,
    ...(docKey === undefined ? {} : { docKey }),
    ...(messageId === undefined ? {} : { messageId }),
    payload,
  };
}

function decodeChunk(decoder: Decoder): ChunkFrame {
  const messageId = readMessageId(decoder);
  const innerType = readUint8(decoder, "CHUNK innerType");
  const frame: ChunkFrame = {
    type: BoardMessageType.CHUNK,
    messageId,
    innerType:
      innerType as BoardMessageType.SYNC_STEP2 | BoardMessageType.UPDATE,
    chunkIndex: readVarUint(
      decoder,
      BOARD_PROTOCOL_LIMITS.maxChunkCount - 1,
      "chunkIndex",
    ),
    chunkCount: readVarUint(
      decoder,
      BOARD_PROTOCOL_LIMITS.maxChunkCount,
      "chunkCount",
      2,
    ),
    totalLength: readVarUint(
      decoder,
      BOARD_PROTOCOL_LIMITS.maxReassembledBytes,
      "totalLength",
      1,
    ),
    payload: readVarBytes(
      decoder,
      BOARD_PROTOCOL_LIMITS.maxChunkPayloadBytes,
      "chunk payload",
    ),
  };
  assertChunk(frame);
  return frame;
}

/**
 * Decodes exactly one Board v2 frame. Returned binary fields are zero-copy
 * views over `bytes`; callers that retain a field should retain the input too.
 */
export function decodeBoardFrame(bytes: Uint8Array): BoardFrame {
  if (!(bytes instanceof Uint8Array)) {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_FIELD,
      "Frame must be a Uint8Array",
    );
  }
  if (bytes.byteLength > BOARD_PROTOCOL_LIMITS.maxEncodedFrameBytes) {
    throw protocolError(
      BoardProtocolErrorCode.FRAME_TOO_LARGE,
      `Frame exceeds ${BOARD_PROTOCOL_LIMITS.maxEncodedFrameBytes} bytes`,
    );
  }

  try {
    const decoder = decoding.createDecoder(bytes);
    const magic = readUint32BigEndian(decoder, "protocol magic");
    if (magic !== BOARD_PROTOCOL_MAGIC) {
      throw protocolError(
        BoardProtocolErrorCode.INVALID_MAGIC,
        "Frame does not contain the Board v2 protocol magic",
      );
    }
    const version = readUint8(decoder, "protocol version");
    if (version !== BOARD_PROTOCOL_VERSION) {
      throw protocolError(
        BoardProtocolErrorCode.UNSUPPORTED_VERSION,
        `Unsupported Board protocol version ${version}`,
      );
    }

    const type = readUint8(decoder, "message type");
    let frame: BoardFrame;
    switch (type) {
      case BoardMessageType.AUTH:
        frame = decodeAuth(decoder);
        break;
      case BoardMessageType.READY:
        frame = decodeReady(decoder);
        break;
      case BoardMessageType.SYNC_STEP1:
        frame = decodeSyncStep1(decoder);
        break;
      case BoardMessageType.SYNC_STEP2:
        frame = decodeSyncStep2(decoder);
        break;
      case BoardMessageType.UPDATE:
        frame = decodeUpdate(decoder);
        break;
      case BoardMessageType.ACK:
        frame = decodeAck(decoder);
        break;
      case BoardMessageType.AWARENESS:
        frame = decodeAwareness(decoder);
        break;
      case BoardMessageType.CONTROL:
        frame = decodeControl(decoder);
        break;
      case BoardMessageType.CHUNK:
        frame = decodeChunk(decoder);
        break;
      default:
        throw protocolError(
          BoardProtocolErrorCode.UNSUPPORTED_MESSAGE,
          `Unsupported Board message type ${type}`,
        );
    }

    if (decoding.hasContent(decoder)) {
      throw protocolError(
        BoardProtocolErrorCode.TRAILING_DATA,
        `Frame contains ${decoder.arr.byteLength - decoder.pos} trailing bytes`,
      );
    }
    return frame;
  } catch (error) {
    if (error instanceof BoardProtocolError) {
      throw error;
    }
    throw protocolError(
      BoardProtocolErrorCode.INVALID_FIELD,
      "Malformed Board protocol frame",
      error,
    );
  }
}

export const encodeFrame = encodeBoardFrame;
export const decodeFrame = decodeBoardFrame;

export function messageIdFromHex(hex: string): BoardMessageId {
  if (!/^[0-9a-fA-F]{32}$/u.test(hex)) {
    throw protocolError(
      BoardProtocolErrorCode.INVALID_FIELD,
      "A message ID hex string must contain exactly 32 hexadecimal characters",
    );
  }
  const result = new Uint8Array(MESSAGE_ID_BYTES);
  for (let index = 0; index < MESSAGE_ID_BYTES; index += 1) {
    result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

export function messageIdToHex(messageId: BoardMessageId): string {
  assertMessageId(messageId);
  return Array.from(messageId, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
