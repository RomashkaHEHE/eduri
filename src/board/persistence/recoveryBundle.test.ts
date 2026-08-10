import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createBoardRecoveryBundle,
  createBoardRecoveryBundleParts,
  createBoardRecoveryBundlePrefix,
  parseBoardRecoveryBundle,
  restoreBoardRecoveryDocument,
} from "./recoveryBundle";

const identity = {
  boardId: "00000000-0000-4000-8000-000000000601",
  lessonId: "00000000-0000-4000-8000-000000000602",
  generation: 3,
  schemaVersion: 1,
  documentKey: "page:00000000-0000-4000-8000-000000000603",
  pageId: "00000000-0000-4000-8000-000000000603",
};

describe("Board recovery bundle", () => {
  it("keeps the version-1 binary framing byte-stable", () => {
    const document = new Y.Doc({ gc: false });
    document.clientID = 42;
    document.getMap("objects").set("value", "kept");
    const bundle = createBoardRecoveryBundle({
      identity,
      document,
      reason: "recovery-required",
      pendingUpdateCount: 1,
      createdAt: "2026-07-28T08:30:00.000Z",
    });

    expect(Buffer.from(bundle).toString("hex")).toBe(
      "45445552495f424f4152445f5245434f564552595f56310aa2010000" +
      "7b22666f726d6174223a2265647572692e626f6172642e7265636f7665727922" +
      "2c2276657273696f6e223a312c226964656e74697479223a7b22626f61726449" +
      "64223a2230303030303030302d303030302d343030302d383030302d30303030" +
      "3030303030363031222c226c6573736f6e4964223a2230303030303030302d30" +
      "3030302d343030302d383030302d303030303030303030363032222c2267656e" +
      "65726174696f6e223a332c22736368656d6156657273696f6e223a312c22646f" +
      "63756d656e744b6579223a22706167653a30303030303030302d303030302d34" +
      "3030302d383030302d303030303030303030363033222c22706167654964223a" +
      "2230303030303030302d303030302d343030302d383030302d30303030303030" +
      "3030363033227d2c22726561736f6e223a227265636f766572792d7265717569" +
      "726564222c2270656e64696e67557064617465436f756e74223a312c22637265" +
      "617465644174223a22323032362d30372d32385430383a33303a30302e303030" +
      "5a222c22646f63756d656e744279746573223a32382c22617373657473223a5b" +
      "5d7d01012a002801076f626a656374730576616c75650177046b65707400",
    );
    document.destroy();
  });

  it("round-trips the complete Yjs state and raw local assets", async () => {
    const document = new Y.Doc();
    document.getMap("objects").set("answer", 42);
    document.getText("notes").insert(0, "offline edit");
    const assetBytes = Uint8Array.of(137, 80, 78, 71, 1, 2, 3);

    const bundle = createBoardRecoveryBundle({
      identity,
      document,
      reason: "local-storage-at-risk",
      pendingUpdateCount: 2,
      createdAt: "2026-07-28T08:30:00.000Z",
      assets: [{
        assetId: "asset-local",
        sha256: "a".repeat(64),
        mimeType: "image/png",
        fileName: "graph.png",
        bytes: assetBytes,
      }],
    });
    const parsed = await parseBoardRecoveryBundle(bundle);
    const restored = restoreBoardRecoveryDocument(parsed);

    expect(parsed).toMatchObject({
      identity,
      reason: "local-storage-at-risk",
      pendingUpdateCount: 2,
      createdAt: "2026-07-28T08:30:00.000Z",
    });
    expect(parsed.assets).toHaveLength(1);
    expect(parsed.assets[0]).toMatchObject({
      assetId: "asset-local",
      sha256: "a".repeat(64),
      mimeType: "image/png",
      fileName: "graph.png",
    });
    expect(parsed.assets[0].bytes).toEqual(assetBytes);
    expect(restored.getMap("objects").get("answer")).toBe(42);
    expect(restored.getText("notes").toString()).toBe("offline edit");

    restored.destroy();
    document.destroy();
  });

  it("rejects truncation, trailing bytes and unsupported headers", async () => {
    const document = new Y.Doc();
    document.getMap("objects").set("value", "kept");
    const bundle = createBoardRecoveryBundle({
      identity,
      document,
      reason: "recovery-required",
      pendingUpdateCount: 1,
    });
    const bytes = bundle;

    expect(() => parseBoardRecoveryBundle(
      bytes.slice(0, bytes.byteLength - 1),
    )).toThrow("truncated");
    expect(() => parseBoardRecoveryBundle(
      Uint8Array.from([...bytes, 0]),
    )).toThrow("trailing data");
    const badMagic = bytes.slice();
    badMagic[0] ^= 0xff;
    expect(() => parseBoardRecoveryBundle(badMagic)).toThrow("magic");

    document.destroy();
  });

  it("builds a streamable prefix without loading asset bodies", () => {
    const document = new Y.Doc();
    document.clientID = 42;
    document.getMap("objects").set("value", "kept");
    const firstAsset = Uint8Array.of(1, 2, 3);
    const secondAsset = Uint8Array.of(4, 5);
    const createdAt = "2026-07-28T08:30:00.000Z";
    const assetMetadata = [
      {
        assetId: "asset-one",
        sha256: "b".repeat(64),
        mimeType: "image/png",
        fileName: "one.png",
        byteLength: firstAsset.byteLength,
      },
      {
        assetId: "asset-two",
        sha256: "c".repeat(64),
        mimeType: "image/webp",
        fileName: null,
        byteLength: secondAsset.byteLength,
      },
    ] as const;
    const prefix = createBoardRecoveryBundlePrefix({
      identity,
      document,
      reason: "recovery-required",
      pendingUpdateCount: 3,
      createdAt,
      assets: assetMetadata,
    });
    const parts = createBoardRecoveryBundleParts({
      identity,
      document,
      reason: "recovery-required",
      pendingUpdateCount: 3,
      createdAt,
      assets: assetMetadata,
    });
    const assembled = new Uint8Array(
      prefix.byteLength + firstAsset.byteLength + secondAsset.byteLength,
    );
    assembled.set(prefix);
    assembled.set(firstAsset, prefix.byteLength);
    assembled.set(secondAsset, prefix.byteLength + firstAsset.byteLength);

    const convenience = createBoardRecoveryBundle({
      identity,
      document,
      reason: "recovery-required",
      pendingUpdateCount: 3,
      createdAt,
      assets: [
        { ...assetMetadata[0], bytes: firstAsset },
        { ...assetMetadata[1], bytes: secondAsset },
      ],
    });

    expect(Object.isFrozen(parts)).toBe(true);
    expect(parts.reduce((bytes, part) => bytes + part.byteLength, 0))
      .toBe(prefix.byteLength);
    expect(assembled).toEqual(convenience);
    expect(parseBoardRecoveryBundle(assembled).assets.map((asset) => asset.bytes))
      .toEqual([firstAsset, secondAsset]);
    document.destroy();
  });
});
