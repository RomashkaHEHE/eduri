import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  BoardSyncServiceError,
  validateBoardStateVector,
} from "./sync-service.js";

function encodeStateVector(
  pairs: ReadonlyArray<readonly [client: number, clock: number]>,
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, pairs.length);
  for (const [client, clock] of pairs) {
    encoding.writeVarUint(encoder, client);
    encoding.writeVarUint(encoder, clock);
  }
  return encoding.toUint8Array(encoder);
}

describe("Board state-vector validation", () => {
  it("accepts standard Yjs/Yrs pairs regardless of client ordering", () => {
    const ascending = encodeStateVector([[7, 11], [42, 3]]);
    const descending = encodeStateVector([[42, 3], [7, 11]]);

    expect(Y.decodeStateVector(ascending)).toEqual(
      new Map([[7, 11], [42, 3]]),
    );
    expect(() => validateBoardStateVector(ascending)).not.toThrow();
    expect(() => validateBoardStateVector(descending)).not.toThrow();
  });

  it("rejects ambiguous or malformed state-vector encodings", () => {
    const duplicateClient = encodeStateVector([[7, 1], [7, 2]]);
    const trailingData = Uint8Array.from([
      ...encodeStateVector([[7, 1]]),
      0,
    ]);

    for (const invalid of [
      new Uint8Array(),
      Uint8Array.of(2, 7, 1),
      duplicateClient,
      trailingData,
    ]) {
      expect(() => validateBoardStateVector(invalid)).toThrowError(
        expect.objectContaining<Partial<BoardSyncServiceError>>({
          code: "INVALID_UPDATE",
        }),
      );
    }
  });
});
