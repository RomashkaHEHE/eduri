import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  BoardControlCode,
  BoardMessageType,
  BoardPermission,
  decodeBoardFrame,
  encodeBoardFrame,
  messageIdFromHex,
  type BoardFrame,
} from "./index";
import protocolV1Fixtures from "./fixtures/v1.json";

const messageId = messageIdFromHex("00112233445566778899aabbccddeeff");

const goldenFixtures: ReadonlyArray<{
  readonly name: string;
  readonly frame: BoardFrame;
  readonly hex: string;
}> = [
  {
    name: "AUTH",
    frame: {
      type: BoardMessageType.AUTH,
      ticket: "ticket.ABC",
      generation: 7,
      minSchemaVersion: 1,
      maxSchemaVersion: 3,
      capabilities: 31,
    },
    hex: "4544423201010701031f0a7469636b65742e414243",
  },
  {
    name: "READY",
    frame: {
      type: BoardMessageType.READY,
      generation: 7,
      schemaVersion: 2,
      capabilities: 3,
      awarenessClientId: 1_193_046,
      permissions: BoardPermission.READ | BoardPermission.EDIT,
    },
    hex: "454442320102070203d6e84803",
  },
  {
    name: "SYNC_STEP1",
    frame: {
      type: BoardMessageType.SYNC_STEP1,
      generation: 7,
      docKey: "manifest",
      stateVector: new Uint8Array([0, 1, 127, 128, 255]),
    },
    hex: "45444232010307086d616e69666573740500017f80ff",
  },
  {
    name: "SYNC_STEP2",
    frame: {
      type: BoardMessageType.SYNC_STEP2,
      generation: 7,
      docKey: "page:abc",
      update: new Uint8Array([1, 2, 3, 4]),
    },
    hex: "4544423201040708706167653a6162630401020304",
  },
  {
    name: "UPDATE",
    frame: {
      type: BoardMessageType.UPDATE,
      generation: 7,
      docKey: "page:abc",
      messageId,
      update: new Uint8Array([9, 8, 7]),
    },
    hex:
      "4544423201050708706167653a616263" +
      "00112233445566778899aabbccddeeff03090807",
  },
  {
    name: "ACK",
    frame: {
      type: BoardMessageType.ACK,
      generation: 7,
      docKey: "page:abc",
      messageId,
      durableSequence: 300,
    },
    hex:
      "4544423201060708706167653a616263" +
      "00112233445566778899aabbccddeeffac02",
  },
  {
    name: "AWARENESS",
    frame: {
      type: BoardMessageType.AWARENESS,
      generation: 7,
      docKey: "page:abc",
      awarenessClientId: 42,
      update: new Uint8Array([1, 0, 42]),
    },
    hex: "4544423201070708706167653a6162632a0301002a",
  },
  {
    name: "CONTROL",
    frame: {
      type: BoardMessageType.CONTROL,
      generation: 7,
      code: BoardControlCode.UPDATE_REJECTED,
      docKey: "page:abc",
      messageId,
      payload: new TextEncoder().encode("permission"),
    },
    hex:
      "45444232010807040308706167653a616263" +
      "00112233445566778899aabbccddeeff0a7065726d697373696f6e",
  },
  {
    name: "CHUNK",
    frame: {
      type: BoardMessageType.CHUNK,
      messageId,
      innerType: BoardMessageType.UPDATE,
      chunkIndex: 1,
      chunkCount: 2,
      totalLength: 10,
      payload: new Uint8Array([0xaa, 0xbb, 0xcc]),
    },
    hex:
      "45444232010900112233445566778899aabbccddeeff" +
      "0501020a03aabbcc",
  },
  {
    name: "YJS_SYNC_STEP1",
    frame: {
      type: BoardMessageType.SYNC_STEP1,
      generation: 7,
      docKey: "manifest",
      stateVector: new Uint8Array([1, 42, 1]),
    },
    hex: "45444232010307086d616e696665737403012a01",
  },
  {
    name: "YJS_SYNC_STEP2",
    frame: {
      type: BoardMessageType.SYNC_STEP2,
      generation: 7,
      docKey: "page:fixture",
      update: fromHex(
        "01012a002801076669787475726506616e73776572017d2a00",
      ),
    },
    hex:
      "454442320104070c706167653a6669787475726519" +
      "01012a002801076669787475726506616e73776572017d2a00",
  },
];

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

describe("Board v2 protocol golden fixtures", () => {
  it("keeps the machine-readable fixture complete and byte-identical", () => {
    expect(protocolV1Fixtures.protocolVersion).toBe(1);
    expect(protocolV1Fixtures.binaryConventions).toEqual({
      magicHex: "45444232",
      magicEndian: "big",
      varUint: "unsigned-base128-little-endian-groups-canonical",
      lengthPrefix: "canonical-varuint-byte-length",
      text: "utf-8",
    });
    expect(protocolV1Fixtures.frames).toEqual(
      goldenFixtures.map(({ name, frame, hex }) => ({
        name,
        type: frame.type,
        hex,
      })),
    );
  });

  it("contains a standard Yjs update-v1 fixture for native Yrs clients", () => {
    const { crdt } = protocolV1Fixtures;
    expect(crdt.updateEncoding).toBe("yjs-update-v1");
    expect(crdt.stateVectorEncoding).toBe("yjs-state-vector-v1");
    expect(crdt.verifiedWith).toMatchObject({
      implementation: "ywasm",
      decodedStateVectorHex: crdt.stateVectorHex,
      reencodedUpdateHex: crdt.fullUpdateHex,
    });

    const document = new Y.Doc();
    Y.applyUpdate(document, fromHex(crdt.fullUpdateHex));

    expect(document.getMap(crdt.expectedRoot).get(crdt.expectedKey))
      .toBe(crdt.expectedNumber);
    expect(toHex(Y.encodeStateVector(document))).toBe(crdt.stateVectorHex);
    expect(toHex(Y.encodeStateAsUpdate(document))).toBe(crdt.fullUpdateHex);
    document.destroy();
  });

  for (const fixture of goldenFixtures) {
    it(`${fixture.name} has stable bytes and round-trips`, () => {
      const encoded = encodeBoardFrame(fixture.frame);
      expect(toHex(encoded)).toBe(fixture.hex);
      expect(decodeBoardFrame(encoded)).toEqual(fixture.frame);

      const decodedGolden = decodeBoardFrame(fromHex(fixture.hex));
      expect(decodedGolden).toEqual(fixture.frame);
      expect(toHex(encodeBoardFrame(decodedGolden))).toBe(fixture.hex);
    });
  }
});
