import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_OBJECT_KINDS,
  LocalUndoController,
  addBoardObject,
  addManifestPage,
  applyBoardUpdate,
  createCodeProps,
  createCollaborativeText,
  createLatexProps,
  createLocalCommandOrigin,
  createManifestDocument,
  createPageDocument,
  createTextProps,
  encodeBoardStateVector,
  encodeBoardUpdate,
  getCollaborativeText,
  getManifestPages,
  getPageObjects,
  getStrokePoints,
  insertCollaborativeText,
  measureBoardDocument,
  mergeBoardUpdatesBounded,
  openPageDocument,
  readBoardObject,
  semanticHash,
  semanticSnapshot,
  setObjectStyle,
  setObjectTransform,
  setStrokePoints,
  stateVectorsEqual,
} from "./index.js";

const PAGE_ID = "10000000-0000-4000-8000-000000000001";
const BASE_OBJECT_ID = "20000000-0000-4000-8000-000000000001";
const OBJECT_A_ID = "20000000-0000-4000-8000-000000000002";
const OBJECT_B_ID = "20000000-0000-4000-8000-000000000003";
const OBJECT_C_ID = "20000000-0000-4000-8000-000000000004";

function replicaFrom(doc: Y.Doc): Y.Doc {
  const replica = openPageDocument(new Y.Doc());
  applyBoardUpdate(replica, encodeBoardUpdate(doc));
  return replica;
}

function baseObject(id = BASE_OBJECT_ID) {
  return {
    id,
    kind: BUILTIN_OBJECT_KINDS.rectangle,
    version: 1,
    transform: [0, 0, 100, 80, 0] as const,
    zRank: "a0",
    style: { stroke: "#111111" },
    props: {},
  };
}

describe("Board v2 core schema", () => {
  it("models the renderer-neutral manifest and collaborative source fields", () => {
    const manifest = createManifestDocument();
    const origin = createLocalCommandOrigin("manifest-test");
    addManifestPage(manifest, {
      id: PAGE_ID,
      name: "Основная доска",
      rank: "a0",
      background: { color: "#ffffff" },
      grid: { enabled: true, size: 20 },
    }, origin);

    const page = getManifestPages(manifest).get(PAGE_ID);
    expect(page?.get("name")).toBe("Основная доска");
    expect(page?.get("background")).toBeInstanceOf(Y.Map);
    expect(page?.get("grid")).toBeInstanceOf(Y.Map);

    const board = createPageDocument(PAGE_ID);
    const text = addBoardObject(board, {
      ...baseObject(OBJECT_A_ID),
      kind: BUILTIN_OBJECT_KINDS.text,
      props: createTextProps("plain"),
    }, origin);
    const code = addBoardObject(board, {
      ...baseObject(OBJECT_B_ID),
      kind: BUILTIN_OBJECT_KINDS.code,
      props: createCodeProps("print(1)", "python", "python-browser"),
    }, origin);
    const latex = addBoardObject(board, {
      ...baseObject(OBJECT_C_ID),
      kind: BUILTIN_OBJECT_KINDS.latex,
      props: createLatexProps("\\frac{a}{b}"),
    }, origin);

    expect(getCollaborativeText(text, "text")).toBeInstanceOf(Y.Text);
    expect(getCollaborativeText(code, "source")?.toString()).toBe("print(1)");
    expect(getCollaborativeText(latex, "source")?.toString()).toBe("\\frac{a}{b}");
    expect(measureBoardDocument(board)).toMatchObject({
      objectCount: 3,
      collaborativeTextCharacters: "plainprint(1)\\frac{a}{b}".length,
    });
  });

  it("copies completed stroke bytes at command and read boundaries", () => {
    const board = createPageDocument(PAGE_ID);
    const origin = createLocalCommandOrigin("stroke-test");
    addBoardObject(board, {
      ...baseObject(),
      kind: BUILTIN_OBJECT_KINDS.stroke,
    }, origin);
    const points = new Uint8Array([1, 2, 3, 5, 8]);
    setStrokePoints(board, BASE_OBJECT_ID, points, origin);
    points[0] = 255;

    const firstRead = getStrokePoints(getPageObjects(board).get(BASE_OBJECT_ID)!);
    expect(firstRead).toEqual(new Uint8Array([1, 2, 3, 5, 8]));
    firstRead![1] = 255;
    expect(getStrokePoints(getPageObjects(board).get(BASE_OBJECT_ID)!))
      .toEqual(new Uint8Array([1, 2, 3, 5, 8]));
  });
});

describe("Board v2 CRDT convergence", () => {
  it("coalesces a large aggregate into causally ordered bounded updates", () => {
    const source = new Y.Doc();
    const updates: Uint8Array[] = [];
    source.on("update", (update: Uint8Array) => updates.push(update.slice()));
    for (let index = 0; index < 6; index += 1) {
      source.getMap("content").set(String(index), "x".repeat(700));
    }
    const maxBytes = 1_024;
    expect(updates.every((update) => update.byteLength <= maxBytes)).toBe(true);

    const bounded = mergeBoardUpdatesBounded(updates, maxBytes);
    expect(bounded.length).toBeGreaterThan(1);
    expect(bounded.every((update) => update.byteLength <= maxBytes)).toBe(true);

    const replica = new Y.Doc();
    for (const update of bounded) applyBoardUpdate(replica, update);
    expect(stateVectorsEqual(
      encodeBoardStateVector(replica),
      encodeBoardStateVector(source),
    )).toBe(true);
  });

  it("preserves one indivisible oversized update for durable recovery", () => {
    const oversized = new Uint8Array(33).fill(7);
    const [preserved] = mergeBoardUpdatesBounded([oversized], 32);
    expect(preserved).toEqual(oversized);
    expect(preserved).not.toBe(oversized);
  });

  it("compares state vectors as mappings regardless of client-pair order", () => {
    const ascendingEncoder = encoding.createEncoder();
    encoding.writeVarUint(ascendingEncoder, 2);
    encoding.writeVarUint(ascendingEncoder, 10);
    encoding.writeVarUint(ascendingEncoder, 3);
    encoding.writeVarUint(ascendingEncoder, 20);
    encoding.writeVarUint(ascendingEncoder, 7);

    const descendingEncoder = encoding.createEncoder();
    encoding.writeVarUint(descendingEncoder, 2);
    encoding.writeVarUint(descendingEncoder, 20);
    encoding.writeVarUint(descendingEncoder, 7);
    encoding.writeVarUint(descendingEncoder, 10);
    encoding.writeVarUint(descendingEncoder, 3);

    expect(stateVectorsEqual(
      encoding.toUint8Array(ascendingEncoder),
      encoding.toUint8Array(descendingEncoder),
    )).toBe(true);
  });

  it("converges three offline replicas after reordered and duplicate updates", () => {
    const seed = createPageDocument(PAGE_ID);
    const seedOrigin = createLocalCommandOrigin("seed");
    addBoardObject(seed, baseObject(), seedOrigin);
    const baseVector = encodeBoardStateVector(seed);

    const first = replicaFrom(seed);
    const second = replicaFrom(seed);
    const third = replicaFrom(seed);

    addBoardObject(first, {
      ...baseObject(OBJECT_A_ID),
      transform: [10, 20, 30, 40, 0.1],
    }, createLocalCommandOrigin("first"));
    addBoardObject(second, {
      ...baseObject(OBJECT_B_ID),
      kind: BUILTIN_OBJECT_KINDS.text,
      props: createTextProps("offline text"),
    }, createLocalCommandOrigin("second"));
    setObjectStyle(
      third,
      BASE_OBJECT_ID,
      "fill",
      "#00aa77",
      createLocalCommandOrigin("third"),
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

    const hashes = [first, second, third].map(semanticHash);
    expect(new Set(hashes).size).toBe(1);
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
    expect(getPageObjects(first).size).toBe(3);
  });

  it("merges concurrent collaborative text instead of replacing a snapshot", () => {
    const seed = createPageDocument(PAGE_ID);
    const seedOrigin = createLocalCommandOrigin("text-seed");
    addBoardObject(seed, {
      ...baseObject(),
      kind: BUILTIN_OBJECT_KINDS.code,
      props: { source: createCollaborativeText("") },
    }, seedOrigin);

    const first = replicaFrom(seed);
    const second = replicaFrom(seed);
    const baseVector = encodeBoardStateVector(seed);
    insertCollaborativeText(
      first,
      BASE_OBJECT_ID,
      "source",
      0,
      "alpha",
      createLocalCommandOrigin("text-first"),
    );
    insertCollaborativeText(
      second,
      BASE_OBJECT_ID,
      "source",
      0,
      "beta",
      createLocalCommandOrigin("text-second"),
    );

    const firstUpdate = encodeBoardUpdate(first, baseVector);
    const secondUpdate = encodeBoardUpdate(second, baseVector);
    applyBoardUpdate(first, secondUpdate);
    applyBoardUpdate(second, firstUpdate);

    const firstText = getCollaborativeText(
      getPageObjects(first).get(BASE_OBJECT_ID)!,
      "source",
    )?.toString();
    const secondText = getCollaborativeText(
      getPageObjects(second).get(BASE_OBJECT_ID)!,
      "source",
    )?.toString();
    expect(firstText).toBe(secondText);
    expect(firstText).toHaveLength("alphabeta".length);
    expect(firstText).toContain("alpha");
    expect(firstText).toContain("beta");
  });
});

describe("Board v2 local undo", () => {
  it("undoes only the local origin and preserves an independent remote edit", () => {
    const seed = createPageDocument(PAGE_ID);
    const first = replicaFrom(seed);
    const second = replicaFrom(seed);
    const localOrigin = createLocalCommandOrigin("undo-local");
    const undo = new LocalUndoController(first, localOrigin);

    addBoardObject(first, baseObject(OBJECT_A_ID), localOrigin);
    undo.commandBoundary();
    applyBoardUpdate(second, encodeBoardUpdate(first));

    addBoardObject(
      second,
      { ...baseObject(OBJECT_B_ID), zRank: "b0" },
      createLocalCommandOrigin("remote"),
    );
    applyBoardUpdate(first, encodeBoardUpdate(second, encodeBoardStateVector(first)));

    expect(getPageObjects(first).has(OBJECT_A_ID)).toBe(true);
    expect(getPageObjects(first).has(OBJECT_B_ID)).toBe(true);
    expect(undo.undo()).toBe(true);
    expect(getPageObjects(first).has(OBJECT_A_ID)).toBe(false);
    expect(getPageObjects(first).has(OBJECT_B_ID)).toBe(true);
    expect(undo.redo()).toBe(true);
    expect(getPageObjects(first).has(OBJECT_A_ID)).toBe(true);
    expect(getPageObjects(first).has(OBJECT_B_ID)).toBe(true);
    undo.dispose();
  });
});

describe("Board v2 forward compatibility", () => {
  it("preserves an unknown newer object and its opaque binary properties", () => {
    const first = createPageDocument(PAGE_ID);
    const futurePayload = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    addBoardObject(first, {
      ...baseObject(),
      kind: "future-lab/vector-magic",
      version: 99,
      props: {
        opaquePayload: futurePayload,
        futureSettings: { mode: "quantum", precision: 17 },
      },
    }, createLocalCommandOrigin("future-client"));

    const second = replicaFrom(first);
    setObjectTransform(
      second,
      BASE_OBJECT_ID,
      [300, -20, 500, 240, Math.PI / 4],
      createLocalCommandOrigin("older-client"),
    );
    applyBoardUpdate(first, encodeBoardUpdate(second, encodeBoardStateVector(first)));

    for (const doc of [first, second]) {
      const object = readBoardObject(getPageObjects(doc).get(BASE_OBJECT_ID)!);
      expect(object.kind).toBe("future-lab/vector-magic");
      expect(object.version).toBe(99);
      expect(object.props.get("opaquePayload")).toEqual(futurePayload);
      expect(object.props.get("futureSettings")).toEqual({
        mode: "quantum",
        precision: 17,
      });
    }
    expect(semanticHash(first)).toBe(semanticHash(second));
  });

  it("resolves a transform as one atomic tuple under a concurrent move", () => {
    const seed = createPageDocument(PAGE_ID);
    addBoardObject(seed, baseObject(), createLocalCommandOrigin("transform-seed"));
    const first = replicaFrom(seed);
    const second = replicaFrom(seed);
    const baseVector = encodeBoardStateVector(seed);
    const firstTransform = [10, 20, 300, 200, 0.5] as const;
    const secondTransform = [-40, 90, 120, 60, -0.25] as const;

    setObjectTransform(first, BASE_OBJECT_ID, firstTransform, createLocalCommandOrigin("move-a"));
    setObjectTransform(second, BASE_OBJECT_ID, secondTransform, createLocalCommandOrigin("move-b"));
    const firstUpdate = encodeBoardUpdate(first, baseVector);
    const secondUpdate = encodeBoardUpdate(second, baseVector);
    applyBoardUpdate(first, secondUpdate);
    applyBoardUpdate(second, firstUpdate);

    const resolvedFirst = readBoardObject(getPageObjects(first).get(BASE_OBJECT_ID)!).transform;
    const resolvedSecond = readBoardObject(getPageObjects(second).get(BASE_OBJECT_ID)!).transform;
    expect(resolvedFirst).toEqual(resolvedSecond);
    expect([
      JSON.stringify(firstTransform),
      JSON.stringify(secondTransform),
    ]).toContain(JSON.stringify(resolvedFirst));
    expect(getPageObjects(first).get(BASE_OBJECT_ID)?.get("transform")).not.toBeInstanceOf(Y.Array);
  });
});
