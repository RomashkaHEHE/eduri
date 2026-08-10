import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_OBJECT_KINDS,
  BUILTIN_STYLE_CONTRACTS,
  LocalUndoController,
  Z_ORDER_NORMALIZATION_ORIGIN,
  addBoardObject,
  applyBoardUpdate,
  compareBoardObjectZOrder,
  compareCodeUnitStrings,
  createLocalCommandOrigin,
  createPageDocument,
  encodeBoardStateVector,
  encodeBoardUpdate,
  generateZRankBetween,
  generateZRanksBetween,
  getBuiltInStyleContract,
  getPageObjects,
  isValidZRank,
  newRankAfter,
  openPageDocument,
  patchObjectStyles,
  patchObjectStylesByTarget,
  readBoardObject,
  reorderObjects,
  resolveObjectStyleDefaults,
  semanticSnapshot,
  setObjectStyle,
  setObjectTransform,
  stateVectorsEqual,
  supportsObjectStyle,
} from "./index.js";
import type {
  AtomicTransform,
  ZOrderDirection,
} from "./index.js";

const PAGE_ID = "10000000-0000-4000-8000-000000000001";
const IDS = [
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  "20000000-0000-4000-8000-000000000003",
  "20000000-0000-4000-8000-000000000004",
  "20000000-0000-4000-8000-000000000005",
] as const;
const MALFORMED_MAP_ID = "20000000-0000-4000-8000-000000000098";
const MALFORMED_PRIMITIVE_ID = "20000000-0000-4000-8000-000000000099";

function objectInput(id: string, zRank: string) {
  return {
    id,
    kind: BUILTIN_OBJECT_KINDS.rectangle,
    version: 1,
    transform: [0, 0, 100, 80, 0] as const,
    zRank,
    style: {
      stroke: "#111111",
      fill: "#ffffff",
    },
    props: {},
  };
}

function createOrderedPage(ranks = generateZRanksBetween(null, null, IDS.length)): Y.Doc {
  const doc = createPageDocument(PAGE_ID);
  const origin = createLocalCommandOrigin("seed");
  for (let index = 0; index < IDS.length; index += 1) {
    addBoardObject(doc, objectInput(IDS[index], ranks[index]), origin);
  }
  return doc;
}

function orderedIds(doc: Y.Doc): string[] {
  return [...getPageObjects(doc).entries()]
    .map(([id, record]) => ({
      id,
      zRank: record instanceof Y.Map && typeof record.get("zRank") === "string"
        ? record.get("zRank") as string
        : id,
    }))
    .sort(compareBoardObjectZOrder)
    .map((object) => object.id);
}

function replicaFrom(source: Y.Doc): Y.Doc {
  const replica = openPageDocument(new Y.Doc());
  applyBoardUpdate(replica, encodeBoardUpdate(source));
  return replica;
}

describe("Board v2 built-in style contracts", () => {
  it("publishes immutable versioned capabilities and renderer-neutral defaults", () => {
    expect(Object.keys(BUILTIN_STYLE_CONTRACTS).sort()).toEqual(
      Object.values(BUILTIN_OBJECT_KINDS).sort(),
    );
    const text = getBuiltInStyleContract(BUILTIN_OBJECT_KINDS.text, 1);
    expect(text).toMatchObject({
      kind: BUILTIN_OBJECT_KINDS.text,
      version: 1,
      defaults: {
        fill: "#17212b",
        fontSize: 20,
        fontFamily: "Inter, Arial, sans-serif",
        fontStyle: "normal",
        opacity: 1,
      },
    });
    expect(text?.capabilities).toEqual([
      "fill",
      "fontSize",
      "fontFamily",
      "fontStyle",
      "opacity",
    ]);
    expect(Object.isFrozen(text)).toBe(true);
    expect(Object.isFrozen(text?.defaults)).toBe(true);
    expect(getBuiltInStyleContract(BUILTIN_OBJECT_KINDS.text, 2)).toBeUndefined();
    expect(getBuiltInStyleContract("future/style-object", 1)).toBeUndefined();
    expect(supportsObjectStyle(BUILTIN_OBJECT_KINDS.stroke, 1, "blendMode"))
      .toBe(true);
    expect(supportsObjectStyle(BUILTIN_OBJECT_KINDS.image, 1, "stroke"))
      .toBe(false);
    expect(resolveObjectStyleDefaults(
      BUILTIN_OBJECT_KINDS.rectangle,
      1,
      { fill: "#abcdef" },
    )).toMatchObject({
      stroke: "#17212b",
      strokeWidth: 2,
      fill: "#abcdef",
      opacity: 1,
      dash: [],
    });
  });

  it("sets and deletes styles on multiple objects in one atomic command", () => {
    const doc = createOrderedPage();
    const origin = createLocalCommandOrigin("style-batch");
    const updates: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => updates.push(update.slice()));

    expect(patchObjectStyles(
      doc,
      [IDS[0], IDS[1], IDS[0]],
      {
        set: { fill: "#22aa77", opacity: 0.6, dash: [4, 2] },
        delete: ["stroke", "stroke"],
      },
      origin,
    )).toBe(true);

    expect(updates).toHaveLength(1);
    for (const id of [IDS[0], IDS[1]]) {
      const style = readBoardObject(getPageObjects(doc).get(id)!).style;
      expect(style.get("fill")).toBe("#22aa77");
      expect(style.get("opacity")).toBe(0.6);
      expect(style.get("dash")).toEqual([4, 2]);
      expect(style.has("stroke")).toBe(false);
    }
    expect(readBoardObject(getPageObjects(doc).get(IDS[2])!).style.get("stroke"))
      .toBe("#111111");
  });

  it("validates the complete style patch before changing any object", () => {
    const doc = createOrderedPage();
    const before = encodeBoardStateVector(doc);
    expect(() => patchObjectStyles(
      doc,
      [IDS[0], "20000000-0000-4000-8000-000000000099"],
      { set: { fill: "#ff0000" } },
      createLocalCommandOrigin("invalid-style-batch"),
    )).toThrow(/does not exist/u);
    expect(stateVectorsEqual(before, encodeBoardStateVector(doc))).toBe(true);

    expect(() => patchObjectStyles(
      doc,
      [IDS[0]],
      { set: { fill: "#ff0000" }, delete: ["fill"] },
      createLocalCommandOrigin("ambiguous-style-batch"),
    )).toThrow(/cannot be set and deleted/u);
    expect(readBoardObject(getPageObjects(doc).get(IDS[0])!).style.get("fill"))
      .toBe("#ffffff");
  });

  it("applies distinct per-target style patches as one update and undo item", () => {
    const doc = createOrderedPage();
    const origin = createLocalCommandOrigin("style-by-target");
    const undo = new LocalUndoController(doc, origin);
    const updates: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => updates.push(update.slice()));

    expect(patchObjectStylesByTarget(
      doc,
      [
        {
          objectId: IDS[0],
          patch: {
            set: { fontStyle: "bold", fill: "#ee3344" },
            delete: ["stroke"],
          },
        },
        {
          objectId: IDS[1],
          patch: { set: { fontStyle: "italic", fill: "#3355ee" } },
        },
      ],
      origin,
    )).toBe(true);
    expect(updates).toHaveLength(1);
    expect(readBoardObject(getPageObjects(doc).get(IDS[0])!).style.toJSON())
      .toMatchObject({ fontStyle: "bold", fill: "#ee3344" });
    expect(readBoardObject(getPageObjects(doc).get(IDS[0])!).style.has("stroke"))
      .toBe(false);
    expect(readBoardObject(getPageObjects(doc).get(IDS[1])!).style.toJSON())
      .toMatchObject({ fontStyle: "italic", fill: "#3355ee" });

    expect(undo.undo()).toBe(true);
    expect(undo.canUndo).toBe(false);
    for (const id of [IDS[0], IDS[1]]) {
      const style = readBoardObject(getPageObjects(doc).get(id)!).style;
      expect(style.has("fontStyle")).toBe(false);
      expect(style.get("fill")).toBe("#ffffff");
      expect(style.get("stroke")).toBe("#111111");
    }
    undo.dispose();
  });

  it("fully validates per-target patches before mutating the document", () => {
    const doc = createOrderedPage();
    const origin = createLocalCommandOrigin("invalid-style-by-target");
    const missingId = "20000000-0000-4000-8000-000000000097";
    const before = encodeBoardStateVector(doc);

    expect(() => patchObjectStylesByTarget(
      doc,
      [
        { objectId: IDS[0], patch: { set: { fill: "#ff0000" } } },
        { objectId: missingId, patch: { set: { fill: "#00ff00" } } },
      ],
      origin,
    )).toThrow(/does not exist/u);
    expect(stateVectorsEqual(before, encodeBoardStateVector(doc))).toBe(true);

    expect(() => patchObjectStylesByTarget(
      doc,
      [
        { objectId: IDS[0], patch: { set: { fill: "#ff0000" } } },
        { objectId: IDS[0], patch: { set: { fill: "#00ff00" } } },
      ],
      origin,
    )).toThrow(/Duplicate style patch target/u);
    expect(stateVectorsEqual(before, encodeBoardStateVector(doc))).toBe(true);

    expect(() => patchObjectStylesByTarget(
      doc,
      [
        { objectId: IDS[0], patch: { set: { fill: "#ff0000" } } },
        {
          objectId: IDS[1],
          patch: { set: { fontStyle: "bold" }, delete: ["fontStyle"] },
        },
      ],
      origin,
    )).toThrow(/cannot be set and deleted/u);
    expect(stateVectorsEqual(before, encodeBoardStateVector(doc))).toBe(true);
    expect(readBoardObject(getPageObjects(doc).get(IDS[0])!).style.get("fill"))
      .toBe("#ffffff");
  });

  it("rejects collaborative style values at every command boundary", () => {
    const doc = createOrderedPage();
    const origin = createLocalCommandOrigin("invalid-collaborative-style");
    const before = encodeBoardStateVector(doc);

    expect(() => setObjectStyle(
      doc,
      IDS[0],
      "fontStyle",
      new Y.Text(),
      origin,
    )).toThrow(/must not contain collaborative types/u);
    expect(stateVectorsEqual(before, encodeBoardStateVector(doc))).toBe(true);

    expect(() => patchObjectStylesByTarget(
      doc,
      [{
        objectId: IDS[0],
        patch: {
          set: {
            typography: {
              tokens: [{ value: "bold" }, { value: new Y.Map<unknown>() }],
            },
          },
        },
      }],
      origin,
    )).toThrow(/must not contain collaborative types/u);
    expect(stateVectorsEqual(before, encodeBoardStateVector(doc))).toBe(true);
  });

  it("preserves remote independent changes when undoing per-target styles", () => {
    const seed = createOrderedPage();
    const baseVector = encodeBoardStateVector(seed);
    const local = replicaFrom(seed);
    const remote = replicaFrom(seed);
    const localOrigin = createLocalCommandOrigin("local-target-styles");
    const undo = new LocalUndoController(local, localOrigin);

    expect(patchObjectStylesByTarget(
      local,
      [
        { objectId: IDS[0], patch: { set: { fontStyle: "bold" } } },
        { objectId: IDS[1], patch: { set: { fontStyle: "italic" } } },
      ],
      localOrigin,
    )).toBe(true);
    applyBoardUpdate(remote, encodeBoardUpdate(local, baseVector));
    const localVector = encodeBoardStateVector(local);

    const remoteOrigin = createLocalCommandOrigin("remote-target-style-edit");
    const remoteTransform: AtomicTransform = [20, 35, 160, 90, 0.2];
    setObjectStyle(remote, IDS[0], "fill", "#00aa88", remoteOrigin);
    setObjectTransform(remote, IDS[1], remoteTransform, remoteOrigin);
    applyBoardUpdate(local, encodeBoardUpdate(remote, localVector));

    expect(undo.undo()).toBe(true);
    expect(undo.canUndo).toBe(false);
    const first = readBoardObject(getPageObjects(local).get(IDS[0])!);
    const second = readBoardObject(getPageObjects(local).get(IDS[1])!);
    expect(first.style.has("fontStyle")).toBe(false);
    expect(second.style.has("fontStyle")).toBe(false);
    expect(first.style.get("fill")).toBe("#00aa88");
    expect(second.transform).toEqual(remoteTransform);
    undo.dispose();
  });
});

describe("Board v2 fractional z-order", () => {
  it("matches the fractional-indexing 3.2.0 golden keys", () => {
    expect(newRankAfter(null)).toBe("a0");
    expect(newRankAfter("a0")).toBe("a1");
    expect(generateZRankBetween(null, "a0")).toBe("Zz");
    expect(generateZRankBetween("a0", "a1")).toBe("a0V");
    expect(generateZRanksBetween(null, null, 5))
      .toEqual(["a0", "a1", "a2", "a3", "a4"]);
    expect(generateZRanksBetween("a0", "a1", 2))
      .toEqual(["a0G", "a0V"]);
  });

  it("uses deterministic UTF-16 code-unit order without locale collation", () => {
    expect(compareCodeUnitStrings("Zz", "a0")).toBeLessThan(0);
    expect(compareCodeUnitStrings("a0", "a00")).toBeLessThan(0);
    expect(compareCodeUnitStrings("\u{1f600}", "\uffff")).toBeLessThan(0);
    expect(compareBoardObjectZOrder(
      { id: IDS[0], zRank: "a0" },
      { id: IDS[1], zRank: "a0" },
    )).toBeLessThan(0);
  });

  it.each<{
    direction: ZOrderDirection;
    expected: readonly string[];
  }>([
    {
      direction: "front",
      expected: [IDS[0], IDS[2], IDS[4], IDS[1], IDS[3]],
    },
    {
      direction: "forward",
      expected: [IDS[0], IDS[2], IDS[1], IDS[4], IDS[3]],
    },
    {
      direction: "backward",
      expected: [IDS[1], IDS[0], IDS[3], IDS[2], IDS[4]],
    },
    {
      direction: "back",
      expected: [IDS[1], IDS[3], IDS[0], IDS[2], IDS[4]],
    },
  ])("moves a multi-selection $direction and preserves its internal order", ({
    direction,
    expected,
  }) => {
    const doc = createOrderedPage();
    const updates: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => updates.push(update.slice()));

    expect(reorderObjects(
      doc,
      [IDS[3], IDS[1], IDS[1]],
      direction,
      createLocalCommandOrigin(`z-order-${direction}`),
    )).toBe(true);
    expect(orderedIds(doc)).toEqual(expected);
    expect(orderedIds(doc).filter((id) => id === IDS[1] || id === IDS[3]))
      .toEqual([IDS[1], IDS[3]]);
    expect(updates).toHaveLength(1);
  });

  it("normalizes invalid and duplicate ranks outside local undo", () => {
    const doc = createOrderedPage(["a0", "a0", "not-a-rank!", "a3", "a4"]);
    const localOrigin = createLocalCommandOrigin("normalized-reorder");
    const undo = new LocalUndoController(doc, localOrigin);
    const origins: unknown[] = [];
    doc.on("afterTransaction", (transaction: Y.Transaction) => {
      if (transaction.changed.size > 0) origins.push(transaction.origin);
    });

    expect(reorderObjects(doc, [IDS[1]], "front", localOrigin)).toBe(true);
    expect(origins).toContain(Z_ORDER_NORMALIZATION_ORIGIN);
    expect(origins).toContain(localOrigin);
    expect(orderedIds(doc)).toEqual([
      IDS[0],
      IDS[3],
      IDS[4],
      IDS[2],
      IDS[1],
    ]);

    expect(undo.undo()).toBe(true);
    expect(undo.canUndo).toBe(false);
    expect(orderedIds(doc)).toEqual([
      IDS[0],
      IDS[1],
      IDS[3],
      IDS[4],
      IDS[2],
    ]);
    const ranks = [...getPageObjects(doc).values()]
      .map((record) => record.get("zRank"));
    expect(ranks.every(isValidZRank)).toBe(true);
    expect(new Set(ranks).size).toBe(IDS.length);
    undo.dispose();
  });

  it("skips malformed neighbors but rejects an explicitly selected malformed record", () => {
    const doc = createOrderedPage();
    const malformed = new Y.Map<unknown>();
    malformed.set("id", MALFORMED_MAP_ID);
    malformed.set("kind", BUILTIN_OBJECT_KINDS.rectangle);
    malformed.set("version", 1);
    malformed.set("transform", "not-an-atomic-transform");
    malformed.set("zRank", "a2");
    malformed.set("parentId", null);
    malformed.set("style", new Y.Map<unknown>());
    malformed.set("props", new Y.Map<unknown>());
    const values = getPageObjects(doc) as Y.Map<unknown>;
    values.set(MALFORMED_MAP_ID, malformed);
    values.set(MALFORMED_PRIMITIVE_ID, 42);

    expect(reorderObjects(
      doc,
      [IDS[0]],
      "front",
      createLocalCommandOrigin("valid-around-malformed"),
    )).toBe(true);
    expect(orderedIds(doc).filter((id) => IDS.includes(id as typeof IDS[number])))
      .toEqual([IDS[1], IDS[2], IDS[3], IDS[4], IDS[0]]);
    expect(malformed.get("transform")).toBe("not-an-atomic-transform");
    expect(malformed.get("zRank")).toBe("a2");
    expect(values.get(MALFORMED_PRIMITIVE_ID)).toBe(42);

    const beforeRejectedSelection = encodeBoardStateVector(doc);
    expect(() => reorderObjects(
      doc,
      [MALFORMED_PRIMITIVE_ID],
      "back",
      createLocalCommandOrigin("selected-malformed"),
    )).toThrow(/is malformed/u);
    expect(stateVectorsEqual(
      beforeRejectedSelection,
      encodeBoardStateVector(doc),
    )).toBe(true);
  });

  it("converges after normalization and reordered duplicate update delivery", () => {
    const seed = createOrderedPage(["a0", "a0", "invalid!", "a3", "a4"]);
    const baseVector = encodeBoardStateVector(seed);
    const first = replicaFrom(seed);
    const second = replicaFrom(seed);
    const third = replicaFrom(seed);

    reorderObjects(
      first,
      [IDS[0], IDS[2]],
      "front",
      createLocalCommandOrigin("replica-first"),
    );
    reorderObjects(
      second,
      [IDS[1]],
      "backward",
      createLocalCommandOrigin("replica-second"),
    );
    reorderObjects(
      third,
      [IDS[3]],
      "back",
      createLocalCommandOrigin("replica-third"),
    );

    const firstUpdate = encodeBoardUpdate(first, baseVector);
    const secondUpdate = encodeBoardUpdate(second, baseVector);
    const thirdUpdate = encodeBoardUpdate(third, baseVector);
    for (const update of [thirdUpdate, firstUpdate, thirdUpdate, secondUpdate]) {
      applyBoardUpdate(first, update);
    }
    for (const update of [firstUpdate, secondUpdate, firstUpdate, thirdUpdate]) {
      applyBoardUpdate(second, update);
    }
    for (const update of [secondUpdate, thirdUpdate, secondUpdate, firstUpdate]) {
      applyBoardUpdate(third, update);
    }

    expect(semanticSnapshot(first)).toEqual(semanticSnapshot(second));
    expect(semanticSnapshot(second)).toEqual(semanticSnapshot(third));
    expect(stateVectorsEqual(
      encodeBoardStateVector(first),
      encodeBoardStateVector(second),
    )).toBe(true);
    expect(stateVectorsEqual(
      encodeBoardStateVector(second),
      encodeBoardStateVector(third),
    )).toBe(true);
    expect(orderedIds(first)).toEqual(orderedIds(second));
    expect(orderedIds(second)).toEqual(orderedIds(third));
  });

  it("undoes a reorder in one step while preserving remote style and transform edits", () => {
    const seed = createOrderedPage();
    const baseVector = encodeBoardStateVector(seed);
    const local = replicaFrom(seed);
    const remote = replicaFrom(seed);
    const localOrigin = createLocalCommandOrigin("local-reorder");
    const undo = new LocalUndoController(local, localOrigin);

    expect(reorderObjects(local, [IDS[0]], "front", localOrigin)).toBe(true);
    applyBoardUpdate(remote, encodeBoardUpdate(local, baseVector));
    const reorderedVector = encodeBoardStateVector(local);

    const remoteOrigin = createLocalCommandOrigin("remote-edit");
    const remoteTransform: AtomicTransform = [40, 60, 180, 120, 0.25];
    setObjectStyle(remote, IDS[0], "fill", "#0088cc", remoteOrigin);
    setObjectTransform(remote, IDS[0], remoteTransform, remoteOrigin);
    applyBoardUpdate(local, encodeBoardUpdate(remote, reorderedVector));

    expect(undo.undo()).toBe(true);
    expect(undo.canUndo).toBe(false);
    expect(orderedIds(local)).toEqual(IDS);
    const object = readBoardObject(getPageObjects(local).get(IDS[0])!);
    expect(object.style.get("fill")).toBe("#0088cc");
    expect(object.transform).toEqual(remoteTransform);
    undo.dispose();
  });
});
