import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";

import {
  BOARD_PROTOCOL_LIMITS,
  BOARD_PROTOCOL_MAGIC,
  BOARD_PROTOCOL_VERSION,
  BoardControlCode,
  BoardMessageType,
  BoardPermission,
  BoardProtocolError,
  BoardProtocolErrorCode,
  decodeBoardProfileUpdatePayload,
  decodeBoardProfileUpdatedPayload,
  decodeBoardFrame,
  encodeBoardFrame,
  encodeBoardProfileUpdatePayload,
  encodeBoardProfileUpdatedPayload,
  messageIdFromHex,
  messageIdToHex,
  type BoardFrame,
} from "./index";

const messageId = messageIdFromHex("ffeeddccbbaa99887766554433221100");

function rawFrame(
  type: number,
  writeBody: (encoder: encoding.Encoder) => void,
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeUint32BigEndian(encoder, BOARD_PROTOCOL_MAGIC);
  encoding.writeUint8(encoder, BOARD_PROTOCOL_VERSION);
  encoding.writeUint8(encoder, type);
  writeBody(encoder);
  return encoding.toUint8Array(encoder);
}

function expectProtocolError(
  action: () => unknown,
  code?: BoardProtocolErrorCode,
): void {
  try {
    action();
    throw new Error("Expected a BoardProtocolError");
  } catch (error) {
    expect(error).toBeInstanceOf(BoardProtocolError);
    if (code !== undefined) {
      expect((error as BoardProtocolError).code).toBe(code);
    }
  }
}

describe("Board v2 protocol validation", () => {
  it("round-trips bounded profile update control payloads", () => {
    const profile = {
      displayName: "Tutor Profile",
      color: "#a1b2c3" as const,
    };
    expect(
      decodeBoardProfileUpdatePayload(
        encodeBoardProfileUpdatePayload(profile),
      ),
    ).toEqual(profile);
    expect(
      decodeBoardProfileUpdatedPayload(
        encodeBoardProfileUpdatedPayload({ accepted: true, profile }),
      ),
    ).toEqual({ accepted: true, profile });
    expect(
      decodeBoardProfileUpdatedPayload(
        encodeBoardProfileUpdatedPayload({
          accepted: false,
          error: "Profile is invalid",
        }),
      ),
    ).toEqual({ accepted: false, error: "Profile is invalid" });
  });

  it("rejects malformed and oversized profile control payloads", () => {
    expect(() => decodeBoardProfileUpdatePayload(new Uint8Array())).toThrow();
    expect(() => decodeBoardProfileUpdatePayload(
      new Uint8Array([1, 0, 1, 0xff, 0x23, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36]),
    )).toThrow();
    expect(() => encodeBoardProfileUpdatePayload({
      displayName: "x".repeat(241),
      color: "#123456",
    })).toThrow();
    expect(() => decodeBoardProfileUpdatedPayload(
      new Uint8Array([1, 2]),
    )).toThrow();
  });

  it("preserves unknown capability bits during negotiation", () => {
    const frame: BoardFrame = {
      type: BoardMessageType.AUTH,
      ticket: "opaque-ticket",
      generation: 0,
      minSchemaVersion: 1,
      maxSchemaVersion: 1,
      capabilities: 0x8000_0001,
    };

    expect(decodeBoardFrame(encodeBoardFrame(frame))).toEqual(frame);
  });

  it("round-trips CONTROL without optional correlation fields", () => {
    const frame: BoardFrame = {
      type: BoardMessageType.CONTROL,
      generation: 12,
      code: BoardControlCode.SERVER_ERROR,
      payload: new Uint8Array(),
    };

    expect(decodeBoardFrame(encodeBoardFrame(frame))).toEqual(frame);
  });

  it("rejects every truncated prefix", () => {
    const complete = encodeBoardFrame({
      type: BoardMessageType.UPDATE,
      generation: 23,
      docKey: "page:truncation",
      messageId,
      update: new Uint8Array([1, 2, 3, 4, 5, 6]),
    });

    for (let length = 0; length < complete.byteLength; length += 1) {
      expectProtocolError(() =>
        decodeBoardFrame(complete.subarray(0, length)),
      );
    }
  });

  it("rejects bad magic, unsupported versions and message types", () => {
    const ready = encodeBoardFrame({
      type: BoardMessageType.READY,
      generation: 1,
      schemaVersion: 1,
      capabilities: 0,
      awarenessClientId: 1,
      permissions: BoardPermission.READ,
    });

    const badMagic = ready.slice();
    badMagic[0] ^= 0xff;
    expectProtocolError(
      () => decodeBoardFrame(badMagic),
      BoardProtocolErrorCode.INVALID_MAGIC,
    );

    const badVersion = ready.slice();
    badVersion[4] = BOARD_PROTOCOL_VERSION + 1;
    expectProtocolError(
      () => decodeBoardFrame(badVersion),
      BoardProtocolErrorCode.UNSUPPORTED_VERSION,
    );

    const badType = ready.slice();
    badType[5] = 255;
    expectProtocolError(
      () => decodeBoardFrame(badType),
      BoardProtocolErrorCode.UNSUPPORTED_MESSAGE,
    );
  });

  it("rejects trailing bytes and non-canonical varuints", () => {
    const ready = encodeBoardFrame({
      type: BoardMessageType.READY,
      generation: 1,
      schemaVersion: 1,
      capabilities: 0,
      awarenessClientId: 1,
      permissions: BoardPermission.READ,
    });
    const withTrailingByte = new Uint8Array(ready.byteLength + 1);
    withTrailingByte.set(ready);
    expectProtocolError(
      () => decodeBoardFrame(withTrailingByte),
      BoardProtocolErrorCode.TRAILING_DATA,
    );

    const overlongGeneration = rawFrame(BoardMessageType.AUTH, (encoder) => {
      encoding.writeUint8Array(encoder, new Uint8Array([0x80, 0x00]));
      encoding.writeVarUint(encoder, 1);
      encoding.writeVarUint(encoder, 1);
      encoding.writeVarUint(encoder, 0);
      encoding.writeVarString(encoder, "ticket");
    });
    expectProtocolError(
      () => decodeBoardFrame(overlongGeneration),
      BoardProtocolErrorCode.INVALID_VARUINT,
    );
  });

  it("checks declared binary lengths before reading payloads", () => {
    const oversizedStateVector = rawFrame(
      BoardMessageType.SYNC_STEP1,
      (encoder) => {
        encoding.writeVarUint(encoder, 1);
        encoding.writeVarString(encoder, "manifest");
        encoding.writeVarUint(
          encoder,
          BOARD_PROTOCOL_LIMITS.maxStateVectorBytes + 1,
        );
      },
    );
    expectProtocolError(() => decodeBoardFrame(oversizedStateVector));

    const truncatedStateVector = rawFrame(
      BoardMessageType.SYNC_STEP1,
      (encoder) => {
        encoding.writeVarUint(encoder, 1);
        encoding.writeVarString(encoder, "manifest");
        encoding.writeVarUint(encoder, 10);
        encoding.writeUint8Array(encoder, new Uint8Array([1, 2]));
      },
    );
    expectProtocolError(
      () => decodeBoardFrame(truncatedStateVector),
      BoardProtocolErrorCode.TRUNCATED,
    );
  });

  it("rejects invalid UTF-8 and control characters in document keys", () => {
    const invalidUtf8 = rawFrame(BoardMessageType.SYNC_STEP1, (encoder) => {
      encoding.writeVarUint(encoder, 1);
      encoding.writeVarUint(encoder, 1);
      encoding.writeUint8(encoder, 0xff);
      encoding.writeVarUint8Array(encoder, new Uint8Array([0]));
    });
    expectProtocolError(
      () => decodeBoardFrame(invalidUtf8),
      BoardProtocolErrorCode.INVALID_UTF8,
    );

    expectProtocolError(() =>
      encodeBoardFrame({
        type: BoardMessageType.SYNC_STEP1,
        generation: 1,
        docKey: "page:\nunsafe",
        stateVector: new Uint8Array([0]),
      }),
    );
  });

  it("enforces chunk type, index, count and reassembled-size limits", () => {
    const validChunk = encodeBoardFrame({
      type: BoardMessageType.CHUNK,
      messageId,
      innerType: BoardMessageType.UPDATE,
      chunkIndex: 0,
      chunkCount: 2,
      totalLength: 10,
      payload: new Uint8Array([1, 2, 3]),
    });

    const badInnerType = validChunk.slice();
    badInnerType[22] = BoardMessageType.CHUNK;
    expectProtocolError(
      () => decodeBoardFrame(badInnerType),
      BoardProtocolErrorCode.UNSUPPORTED_MESSAGE,
    );

    const badIndex = validChunk.slice();
    badIndex[23] = 2;
    expectProtocolError(() => decodeBoardFrame(badIndex));

    const badCount = validChunk.slice();
    badCount[24] = 1;
    expectProtocolError(() => decodeBoardFrame(badCount));

    const excessiveCount = rawFrame(BoardMessageType.CHUNK, (encoder) => {
      encoding.writeUint8Array(encoder, messageId);
      encoding.writeUint8(encoder, BoardMessageType.UPDATE);
      encoding.writeVarUint(encoder, 0);
      encoding.writeVarUint(
        encoder,
        BOARD_PROTOCOL_LIMITS.maxChunkCount + 1,
      );
      encoding.writeVarUint(encoder, 1000);
      encoding.writeVarUint8Array(encoder, new Uint8Array([1]));
    });
    expectProtocolError(() => decodeBoardFrame(excessiveCount));
  });

  it("rejects unknown CONTROL codes and flags", () => {
    const unknownCode = rawFrame(BoardMessageType.CONTROL, (encoder) => {
      encoding.writeVarUint(encoder, 1);
      encoding.writeVarUint(encoder, 255);
      encoding.writeUint8(encoder, 0);
      encoding.writeVarUint(encoder, 0);
    });
    expectProtocolError(
      () => decodeBoardFrame(unknownCode),
      BoardProtocolErrorCode.UNSUPPORTED_MESSAGE,
    );

    const unknownFlags = rawFrame(BoardMessageType.CONTROL, (encoder) => {
      encoding.writeVarUint(encoder, 1);
      encoding.writeVarUint(encoder, BoardControlCode.SERVER_ERROR);
      encoding.writeUint8(encoder, 0x80);
      encoding.writeVarUint(encoder, 0);
    });
    expectProtocolError(
      () => decodeBoardFrame(unknownFlags),
      BoardProtocolErrorCode.INVALID_FIELD,
    );
  });

  it("rejects frames above the absolute decoder cap", () => {
    const oversized = new Uint8Array(
      BOARD_PROTOCOL_LIMITS.maxEncodedFrameBytes + 1,
    );
    expectProtocolError(
      () => decodeBoardFrame(oversized),
      BoardProtocolErrorCode.FRAME_TOO_LARGE,
    );
  });

  it("validates message ID helpers", () => {
    expect(messageIdToHex(messageId)).toBe(
      "ffeeddccbbaa99887766554433221100",
    );
    expectProtocolError(() => messageIdFromHex("not-an-id"));
    expectProtocolError(() => messageIdToHex(new Uint8Array(15)));
  });

  it("turns deterministic fuzz-ish inputs into frames or typed errors", () => {
    let state = 0x6d2b_79f5;
    const nextByte = (): number => {
      state = Math.imul(state ^ (state >>> 15), state | 1);
      state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
      return ((state ^ (state >>> 14)) >>> 0) & 0xff;
    };

    for (let iteration = 0; iteration < 750; iteration += 1) {
      const bytes = new Uint8Array(6 + (nextByte() % 96));
      for (let index = 0; index < bytes.byteLength; index += 1) {
        bytes[index] = nextByte();
      }
      bytes[0] = 0x45;
      bytes[1] = 0x44;
      bytes[2] = 0x42;
      bytes[3] = 0x32;
      bytes[4] = BOARD_PROTOCOL_VERSION;

      try {
        const decoded = decodeBoardFrame(bytes);
        expect(decodeBoardFrame(encodeBoardFrame(decoded))).toEqual(decoded);
      } catch (error) {
        expect(error).toBeInstanceOf(BoardProtocolError);
      }
    }
  });
});
