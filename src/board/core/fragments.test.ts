import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  BOARD_FRAGMENT_FORMAT,
  BOARD_FRAGMENT_LIMITS,
  BOARD_FRAGMENT_VERSION,
  BUILTIN_OBJECT_KINDS,
  LocalUndoController,
  addBoardObject,
  applyBoardUpdate,
  boardFragmentBounds,
  boardFragmentImageAssets,
  compareBoardObjectZOrder,
  createBoardFragment,
  createLocalCommandOrigin,
  createPageDocument,
  createTextProps,
  decodeBoardFragment,
  deleteBoardObjects,
  encodeBoardFragment,
  encodeBoardStateVector,
  encodeBoardUpdate,
  getCollaborativeText,
  getPageObjects,
  insertBoardFragment,
  isValidZRank,
  openPageDocument,
  readBoardObject,
  semanticSnapshot,
  setObjectStyle,
  setObjectTransform,
  stateVectorsEqual,
  type AtomicTransform,
  type BoardFragment,
} from "./index.js";

const PAGE_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_PAGE_ID = "10000000-0000-4000-8000-000000000002";
const SCOPE = Object.freeze({
  boardId: "board_fragment_test",
  generation: 3,
  pageId: PAGE_ID,
});

const IDS = Object.freeze({
  future: "20000000-0000-4000-8000-000000000001",
  image: "20000000-0000-4000-8000-000000000002",
  text: "20000000-0000-4000-8000-000000000003",
  futureImage: "20000000-0000-4000-8000-000000000004",
  parent: "20000000-0000-4000-8000-000000000005",
  child: "20000000-0000-4000-8000-000000000006",
  externalParent: "20000000-0000-4000-8000-000000000007",
  externalChild: "20000000-0000-4000-8000-000000000008",
  existing: "30000000-0000-4000-8000-000000000001",
  target1: "30000000-0000-4000-8000-000000000002",
  target2: "30000000-0000-4000-8000-000000000003",
  target3: "30000000-0000-4000-8000-000000000004",
  target4: "30000000-0000-4000-8000-000000000005",
  target5: "30000000-0000-4000-8000-000000000006",
  firstReplica1: "40000000-0000-4000-8000-000000000001",
  firstReplica2: "40000000-0000-4000-8000-000000000002",
  secondReplica1: "50000000-0000-4000-8000-000000000001",
  secondReplica2: "50000000-0000-4000-8000-000000000002",
});

function addRectangle(
  doc: Y.Doc,
  id: string,
  zRank: string,
  transform: AtomicTransform = [0, 0, 100, 80, 0],
  parentId: string | null = null,
): void {
  addBoardObject(doc, {
    id,
    kind: BUILTIN_OBJECT_KINDS.rectangle,
    version: 1,
    transform,
    zRank,
    parentId,
    style: { stroke: "#17212b" },
  }, createLocalCommandOrigin(`seed-${id}`));
}

function orderedIds(doc: Y.Doc): string[] {
  return [...getPageObjects(doc).entries()]
    .map(([id, record]) => {
      const object = readBoardObject(record);
      return { id, zRank: object.zRank };
    })
    .sort(compareBoardObjectZOrder)
    .map((object) => object.id);
}

function replicaFrom(doc: Y.Doc): Y.Doc {
  const replica = openPageDocument(new Y.Doc());
  applyBoardUpdate(replica, encodeBoardUpdate(doc));
  return replica;
}

function sequentialFactory(ids: readonly string[]) {
  const calls: string[] = [];
  return {
    calls,
    factory(sourceId: string, index: number): string {
      calls.push(sourceId);
      return ids[index];
    },
  };
}

describe("Board v2 fragments", () => {
  it("round-trips collaborative and future data, scope, bounds, and image identities", () => {
    const source = createPageDocument(PAGE_ID);
    const origin = createLocalCommandOrigin("fragment-source");
    const nestedArray = new Y.Array<unknown>();
    const nestedText = new Y.Text("nested");
    nestedArray.insert(0, [
      7,
      new Uint8Array([9, 8, 7]),
      nestedText,
    ]);
    const nestedMap = new Y.Map<unknown>();
    nestedMap.set("array", nestedArray);
    const xmlText = new Y.XmlText();
    xmlText.insert(0, "future xml");
    nestedMap.set("xml", xmlText);
    const xmlHook = new Y.XmlHook("future-hook");
    xmlHook.set("source", new Y.Text("hook text"));
    nestedMap.set("hook", xmlHook);

    addBoardObject(source, {
      id: IDS.future,
      kind: "future-lab/vector-magic",
      version: 99,
      transform: [0, 5, 10, 20, 0],
      zRank: "a0",
      style: {
        futureStyle: new Uint8Array([1, 3, 3, 7]),
      },
      props: {
        opaquePayload: new Uint8Array([0, 127, 128, 255]),
        nested: nestedMap,
      },
    }, origin);
    addBoardObject(source, {
      id: IDS.image,
      kind: BUILTIN_OBJECT_KINDS.image,
      version: 1,
      transform: [20, 10, 30, 40, 0],
      zRank: "a1",
      style: { opacity: 0.75 },
      props: {
        assetId: "asset_local_1",
        contentHash: "a".repeat(64),
        mimeType: "image/png",
        originalBytes: 1234,
        pixelWidth: 30,
        pixelHeight: 40,
      },
    }, origin);
    const textRecord = addBoardObject(source, {
      id: IDS.text,
      kind: BUILTIN_OBJECT_KINDS.text,
      version: 1,
      transform: [5, 60, 100, 30, 0],
      zRank: "a2",
      style: {
        fill: "#123456",
        fontStyle: "bold italic",
      },
      props: createTextProps("rich text"),
    }, origin);
    getCollaborativeText(textRecord, "text")?.format(0, 4, {
      emphasis: true,
    });
    addBoardObject(source, {
      id: IDS.futureImage,
      kind: BUILTIN_OBJECT_KINDS.image,
      version: 2,
      transform: [-10, -5, 5, 5, 0],
      zRank: "a3",
      props: {
        assetId: "future_asset",
        contentHash: "b".repeat(64),
        mimeType: "image/webp",
        originalBytes: 400,
      },
    }, origin);

    const fragment = createBoardFragment(
      source,
      [IDS.futureImage, IDS.text, IDS.image, IDS.future],
      { scope: SCOPE },
    );
    expect(fragment).toMatchObject({
      format: BOARD_FRAGMENT_FORMAT,
      version: BOARD_FRAGMENT_VERSION,
      scope: SCOPE,
      objectIds: [
        IDS.future,
        IDS.image,
        IDS.text,
        IDS.futureImage,
      ],
    });

    const encoded = encodeBoardFragment(fragment);
    const decoded = decodeBoardFragment(encoded);
    encoded.fill(0);
    expect(encodeBoardFragment(decoded).byteLength).toBeGreaterThan(0);
    expect(boardFragmentBounds(decoded)).toEqual({
      minX: -10,
      minY: -5,
      maxX: 105,
      maxY: 90,
      width: 115,
      height: 95,
      centerX: 47.5,
      centerY: 42.5,
    });
    expect(boardFragmentImageAssets(decoded)).toEqual({
      identities: [{
        objectId: IDS.image,
        assetId: "asset_local_1",
        contentHash: "a".repeat(64),
        mimeType: "image/png",
        originalBytes: 1234,
      }],
      unresolved: [{
        objectId: IDS.futureImage,
        version: 2,
        reason: "unsupported-version",
      }],
    });

    const target = createPageDocument(OTHER_PAGE_ID);
    const ids = [
      IDS.target1,
      IDS.target2,
      IDS.target3,
      IDS.target4,
    ];
    const factory = sequentialFactory(ids);
    expect(insertBoardFragment(
      target,
      decoded,
      createLocalCommandOrigin("fragment-target"),
      {
        idFactory: factory.factory,
        anchor: { x: 500, y: 400 },
      },
    )).toEqual(ids);
    expect(factory.calls).toEqual(decoded.objectIds);

    const future = readBoardObject(
      getPageObjects(target).get(IDS.target1)!,
    );
    expect(future.kind).toBe("future-lab/vector-magic");
    expect(future.version).toBe(99);
    expect(future.transform).toEqual([452.5, 362.5, 10, 20, 0]);
    expect(future.style.get("futureStyle"))
      .toEqual(new Uint8Array([1, 3, 3, 7]));
    expect(future.props.get("opaquePayload"))
      .toEqual(new Uint8Array([0, 127, 128, 255]));
    const pastedNested = future.props.get("nested");
    expect(pastedNested).toBeInstanceOf(Y.Map);
    const pastedArray = (pastedNested as Y.Map<unknown>).get("array");
    expect(pastedArray).toBeInstanceOf(Y.Array);
    expect((pastedArray as Y.Array<unknown>).get(1))
      .toEqual(new Uint8Array([9, 8, 7]));
    expect((pastedArray as Y.Array<unknown>).get(2)).toBeInstanceOf(Y.Text);
    expect(((pastedNested as Y.Map<unknown>).get("xml") as Y.XmlText).toString())
      .toBe("future xml");
    const pastedHook = (pastedNested as Y.Map<unknown>).get("hook");
    expect(pastedHook).toBeInstanceOf(Y.XmlHook);
    expect((pastedHook as Y.XmlHook).get("source")).toBeInstanceOf(Y.Text);
    expect(((pastedHook as Y.XmlHook).get("source") as Y.Text).toString())
      .toBe("hook text");

    const pastedText = readBoardObject(
      getPageObjects(target).get(IDS.target3)!,
    );
    const collaborativeText = getCollaborativeText(
      getPageObjects(target).get(IDS.target3)!,
      "text",
    );
    expect(collaborativeText).toBeInstanceOf(Y.Text);
    expect(collaborativeText?.toDelta()).toEqual(
      getCollaborativeText(textRecord, "text")?.toDelta(),
    );
    expect(pastedText.style.get("fill")).toBe("#123456");
    expect(pastedText.style.get("fontStyle")).toBe("bold italic");
  });

  it("rejects malformed, oversized, and non-fresh input before target mutation", () => {
    const source = createPageDocument(PAGE_ID);
    addRectangle(source, IDS.future, "a0");
    const fragment = createBoardFragment(source, [IDS.future], {
      scope: SCOPE,
    });
    const encoded = encodeBoardFragment(fragment);
    expect(() => decodeBoardFragment(encoded.slice(0, -1)))
      .toThrow(/truncated/u);
    expect(() => decodeBoardFragment(
      Uint8Array.from([...encoded, 0]),
    )).toThrow(/trailing/u);
    const badMagic = encoded.slice();
    badMagic[0] ^= 0xff;
    expect(() => decodeBoardFragment(badMagic)).toThrow(/magic/u);

    const magic = new TextEncoder().encode("EDURI_BOARD_FRAGMENT_V1\n");
    const oversizedHeader = new Uint8Array(magic.byteLength + 4);
    oversizedHeader.set(magic);
    new DataView(oversizedHeader.buffer).setUint32(
      magic.byteLength,
      BOARD_FRAGMENT_LIMITS.maxHeaderBytes + 1,
      true,
    );
    expect(() => decodeBoardFragment(oversizedHeader))
      .toThrow(/header/u);

    const target = createPageDocument(OTHER_PAGE_ID);
    addRectangle(target, IDS.existing, "a0");
    addRectangle(target, IDS.target5, "a0");
    const before = semanticSnapshot(target);
    const ranksBefore = [...getPageObjects(target).values()]
      .map((record) => record.get("zRank"));

    expect(() => insertBoardFragment(
      target,
      fragment,
      createLocalCommandOrigin("invalid-id"),
      { idFactory: (sourceId) => sourceId },
    )).toThrow(/non-fresh/u);
    expect(semanticSnapshot(target)).toEqual(before);
    expect([...getPageObjects(target).values()].map((record) =>
      record.get("zRank"))).toEqual(ranksBefore);

    const oversizedFragment: BoardFragment = {
      ...fragment,
      documentUpdate: new Uint8Array(
        BOARD_FRAGMENT_LIMITS.maxDocumentUpdateBytes + 1,
      ),
    };
    expect(() => insertBoardFragment(
      target,
      oversizedFragment,
      createLocalCommandOrigin("oversized"),
      { idFactory: () => IDS.target1 },
    )).toThrow(/per-operation/u);
    expect(semanticSnapshot(target)).toEqual(before);

    const tooManyIds = Array.from(
      { length: BOARD_FRAGMENT_LIMITS.maxObjectCount + 1 },
      (_, index) =>
        `60000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    );
    expect(() => insertBoardFragment(
      target,
      { ...fragment, objectIds: tooManyIds },
      createLocalCommandOrigin("too-many"),
      { idFactory: () => IDS.target1 },
    )).toThrow(/object count/u);
    expect(semanticSnapshot(target)).toEqual(before);
  });

  it("remaps included parents, detaches external parents, and inserts one ordered update", () => {
    const source = createPageDocument(PAGE_ID);
    addRectangle(source, IDS.externalParent, "a0");
    addRectangle(source, IDS.parent, "a1", [10, 20, 200, 120, 0]);
    addRectangle(
      source,
      IDS.child,
      "a2",
      [30, 40, 40, 30, 0],
      IDS.parent,
    );
    addRectangle(
      source,
      IDS.externalChild,
      "a3",
      [70, 80, 50, 40, 0],
      IDS.externalParent,
    );
    const fragment = createBoardFragment(
      source,
      [IDS.externalChild, IDS.child, IDS.parent],
      { scope: SCOPE },
    );
    const target = createPageDocument(OTHER_PAGE_ID);
    addRectangle(target, IDS.existing, "a0");
    const insertedIds = [IDS.target1, IDS.target2, IDS.target3];
    const updates: Uint8Array[] = [];
    target.on("update", (update: Uint8Array) => updates.push(update.slice()));

    expect(insertBoardFragment(
      target,
      fragment,
      createLocalCommandOrigin("ordered-paste"),
      {
        idFactory: (_sourceId, index) => insertedIds[index],
        translation: { x: 10, y: -5 },
      },
    )).toEqual(insertedIds);

    expect(updates).toHaveLength(1);
    expect(updates[0].byteLength)
      .toBeLessThanOrEqual(BOARD_FRAGMENT_LIMITS.maxDocumentUpdateBytes);
    expect(orderedIds(target)).toEqual([
      IDS.existing,
      ...insertedIds,
    ]);
    const parent = readBoardObject(
      getPageObjects(target).get(IDS.target1)!,
    );
    const child = readBoardObject(
      getPageObjects(target).get(IDS.target2)!,
    );
    const detached = readBoardObject(
      getPageObjects(target).get(IDS.target3)!,
    );
    expect(parent.transform).toEqual([20, 15, 200, 120, 0]);
    expect(child.parentId).toBe(IDS.target1);
    expect(detached.parentId).toBeNull();
    const ranks = [parent, child, detached].map((object) => object.zRank);
    expect(ranks.every(isValidZRank)).toBe(true);
    expect(new Set(ranks).size).toBe(3);
  });

  it("inserts and deletes multiple objects as single local undo items", () => {
    const fragmentSource = createPageDocument(PAGE_ID);
    addRectangle(fragmentSource, IDS.future, "a0");
    addRectangle(fragmentSource, IDS.image, "a1");
    const fragment = createBoardFragment(
      fragmentSource,
      [IDS.future, IDS.image],
      { scope: SCOPE },
    );

    const target = createPageDocument(OTHER_PAGE_ID);
    addRectangle(target, IDS.existing, "a0");
    const localOrigin = createLocalCommandOrigin("fragment-undo");
    const undo = new LocalUndoController(target, localOrigin);
    insertBoardFragment(target, fragment, localOrigin, {
      idFactory: (_sourceId, index) =>
        [IDS.target1, IDS.target2][index],
    });

    expect(undo.undo()).toBe(true);
    expect(undo.canUndo).toBe(false);
    expect(getPageObjects(target).has(IDS.target1)).toBe(false);
    expect(getPageObjects(target).has(IDS.target2)).toBe(false);

    expect(undo.redo()).toBe(true);
    expect(getPageObjects(target).has(IDS.target1)).toBe(true);
    expect(getPageObjects(target).has(IDS.target2)).toBe(true);
    undo.clear();
    expect(() => deleteBoardObjects(
      target,
      [IDS.target1, IDS.target5],
      localOrigin,
    )).toThrow(/does not exist/u);
    expect(getPageObjects(target).has(IDS.target1)).toBe(true);

    const updates: Uint8Array[] = [];
    target.on("update", (update: Uint8Array) => updates.push(update.slice()));
    expect(deleteBoardObjects(
      target,
      [IDS.target1, IDS.target2, IDS.target1],
      localOrigin,
    )).toBe(true);
    expect(updates).toHaveLength(1);
    expect(undo.undo()).toBe(true);
    expect(undo.canUndo).toBe(false);
    expect(getPageObjects(target).has(IDS.target1)).toBe(true);
    expect(getPageObjects(target).has(IDS.target2)).toBe(true);
    expect(deleteBoardObjects(target, [], localOrigin)).toBe(false);
    undo.dispose();
  });

  it("undoes a paste without reverting independent remote target edits", () => {
    const fragmentSource = createPageDocument(PAGE_ID);
    addRectangle(fragmentSource, IDS.future, "a0");
    const fragment = createBoardFragment(
      fragmentSource,
      [IDS.future],
      { scope: SCOPE },
    );
    const seed = createPageDocument(OTHER_PAGE_ID);
    addRectangle(seed, IDS.existing, "a0");
    const baseVector = encodeBoardStateVector(seed);
    const local = replicaFrom(seed);
    const remote = replicaFrom(seed);
    const localOrigin = createLocalCommandOrigin("local-paste");
    const undo = new LocalUndoController(local, localOrigin);

    insertBoardFragment(local, fragment, localOrigin, {
      idFactory: () => IDS.target1,
    });
    applyBoardUpdate(remote, encodeBoardUpdate(local, baseVector));
    const pastedVector = encodeBoardStateVector(local);
    const remoteOrigin = createLocalCommandOrigin("remote-after-paste");
    const remoteTransform: AtomicTransform = [70, 90, 140, 100, 0.25];
    setObjectStyle(remote, IDS.existing, "fill", "#0088cc", remoteOrigin);
    setObjectTransform(
      remote,
      IDS.existing,
      remoteTransform,
      remoteOrigin,
    );
    applyBoardUpdate(local, encodeBoardUpdate(remote, pastedVector));

    expect(undo.undo()).toBe(true);
    expect(undo.canUndo).toBe(false);
    expect(getPageObjects(local).has(IDS.target1)).toBe(false);
    const existing = readBoardObject(
      getPageObjects(local).get(IDS.existing)!,
    );
    expect(existing.style.get("fill")).toBe("#0088cc");
    expect(existing.transform).toEqual(remoteTransform);
    undo.dispose();
  });

  it("converges after simultaneous pastes and reordered duplicate delivery", () => {
    const fragmentSource = createPageDocument(PAGE_ID);
    addRectangle(fragmentSource, IDS.future, "a0");
    addRectangle(fragmentSource, IDS.image, "a1");
    const fragment = createBoardFragment(
      fragmentSource,
      [IDS.image, IDS.future],
      { scope: SCOPE },
    );
    const seed = createPageDocument(OTHER_PAGE_ID);
    addRectangle(seed, IDS.existing, "a0");
    const baseVector = encodeBoardStateVector(seed);
    const first = replicaFrom(seed);
    const second = replicaFrom(seed);
    const third = replicaFrom(seed);

    insertBoardFragment(
      first,
      fragment,
      createLocalCommandOrigin("paste-first"),
      {
        idFactory: (_sourceId, index) =>
          [IDS.firstReplica1, IDS.firstReplica2][index],
      },
    );
    insertBoardFragment(
      second,
      fragment,
      createLocalCommandOrigin("paste-second"),
      {
        idFactory: (_sourceId, index) =>
          [IDS.secondReplica1, IDS.secondReplica2][index],
      },
    );
    const firstUpdate = encodeBoardUpdate(first, baseVector);
    const secondUpdate = encodeBoardUpdate(second, baseVector);

    for (const update of [secondUpdate, secondUpdate, firstUpdate]) {
      applyBoardUpdate(first, update);
    }
    for (const update of [firstUpdate, secondUpdate, firstUpdate]) {
      applyBoardUpdate(second, update);
    }
    for (const update of [
      secondUpdate,
      firstUpdate,
      secondUpdate,
      firstUpdate,
    ]) {
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
});
