import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_OBJECT_KINDS,
  addBoardObject,
  createCollaborativeText,
  createLocalCommandOrigin,
  createPageDocument,
  getCollaborativeText,
  getPageObjects,
  readBoardObject,
} from "../../../board/core";
import { boardObjectSnapshot } from "./objectSnapshot";

const PAGE_ID = "00000000-0000-4000-8000-000000000101";
const OBJECT_ID = "00000000-0000-4000-8000-000000000102";
const MALFORMED_ID = "00000000-0000-4000-8000-000000000103";
const VALID_NEIGHBOR_ID = "00000000-0000-4000-8000-000000000104";
const FUTURE_TEXT_ID = "00000000-0000-4000-8000-000000000105";

describe("boardObjectSnapshot", () => {
  it("preserves unknown shapes, collaborative text, and opaque binary values without aliasing", () => {
    const document = createPageDocument(PAGE_ID);
    const binary = new Uint8Array([0, 1, 127, 128, 254, 255]);
    const record = addBoardObject(document, {
      id: OBJECT_ID,
      kind: "future-lab/vector-magic",
      version: 42,
      transform: [-12, 18, 240, 90, Math.PI / 7],
      zRank: "future:1",
      props: {
        source: createCollaborativeText("\\frac{x}{y}"),
        binary,
        nested: { values: [binary] },
      },
    }, createLocalCommandOrigin("snapshot-test"));

    const snapshot = boardObjectSnapshot(record);

    expect(snapshot.kind).toBe("future-lab/vector-magic");
    expect(snapshot.version).toBe(42);
    expect(snapshot.rendering).toEqual({ status: "unknown-kind" });
    expect(snapshot.props.source).toBe("\\frac{x}{y}");
    expect(snapshot.props.binary).toEqual(binary);
    expect(snapshot.props.binary).not.toBe(binary);
    expect(snapshot.props.nested).toEqual({ values: [binary] });

    (snapshot.props.binary as Uint8Array)[0] = 99;
    expect(readBoardObject(record).props.get("binary")).toEqual(binary);
    expect(getCollaborativeText(record, "source")?.toString()).toBe("\\frac{x}{y}");
    expect(boardObjectSnapshot(record).props.binary).toEqual(binary);
  });

  it("gates a newer version of a known plugin without interpreting its properties", () => {
    const document = createPageDocument(PAGE_ID);
    const record = addBoardObject(document, {
      id: FUTURE_TEXT_ID,
      kind: BUILTIN_OBJECT_KINDS.text,
      version: 42,
      transform: [40, 50, 200, 80, 0],
      zRank: "future-text",
      props: {
        text: { futureStructuredText: true },
        opaque: new Uint8Array([4, 2]),
      },
    }, createLocalCommandOrigin("future-version-test"));
    const before = Y.encodeStateAsUpdate(document);

    const snapshot = boardObjectSnapshot(record);

    expect(snapshot.rendering).toEqual({
      status: "unsupported-version",
      detail: "Supported version is 1",
    });
    expect(snapshot.props).toEqual({
      text: { futureStructuredText: true },
      opaque: new Uint8Array([4, 2]),
    });
    expect(Y.encodeStateAsUpdate(document)).toEqual(before);
  });

  it("isolates a malformed record while valid neighboring objects keep rendering", () => {
    const document = createPageDocument(PAGE_ID);
    addBoardObject(document, {
      id: VALID_NEIGHBOR_ID,
      kind: BUILTIN_OBJECT_KINDS.rectangle,
      version: 1,
      transform: [10, 20, 120, 70, 0],
      zRank: "valid",
    }, createLocalCommandOrigin("malformed-neighbor-test"));

    const malformed = new Y.Map<unknown>();
    malformed.set("id", MALFORMED_ID);
    malformed.set("kind", BUILTIN_OBJECT_KINDS.text);
    malformed.set("version", 1);
    malformed.set("transform", "not-an-atomic-transform");
    malformed.set("zRank", "malformed");
    malformed.set("parentId", null);
    malformed.set("style", new Y.Map<unknown>());
    const props = new Y.Map<unknown>();
    props.set("text", createCollaborativeText("must stay untouched"));
    malformed.set("props", props);
    getPageObjects(document).set(MALFORMED_ID, malformed);
    const before = Y.encodeStateAsUpdate(document);

    const snapshots = [...getPageObjects(document).values()]
      .map((record) => boardObjectSnapshot(record));
    const invalidSnapshot = snapshots.find((object) => object.id === MALFORMED_ID);
    const validSnapshot = snapshots.find((object) => object.id === VALID_NEIGHBOR_ID);

    expect(invalidSnapshot?.rendering?.status).toBe("malformed");
    expect(invalidSnapshot?.transform).toEqual([0, 0, 180, 96, 0]);
    expect(invalidSnapshot?.props.text).toBe("must stay untouched");
    expect(validSnapshot?.rendering).toEqual({ status: "supported" });
    expect(Y.encodeStateAsUpdate(document)).toEqual(before);
  });

  it("turns a primitive object-map value into a stable malformed placeholder", () => {
    const primitive = 42;

    const first = boardObjectSnapshot(primitive, MALFORMED_ID);
    const second = boardObjectSnapshot(primitive, MALFORMED_ID);

    expect(first).toMatchObject({
      id: MALFORMED_ID,
      kind: "eduri/malformed",
      transform: [0, 0, 180, 96, 0],
      zRank: MALFORMED_ID,
      style: {},
      props: {},
      rendering: {
        status: "malformed",
        detail: "Board object record is not a Y.Map",
      },
    });
    expect(second).toEqual(first);
  });
});
