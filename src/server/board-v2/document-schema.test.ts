import * as Y from "yjs";
import { describe, expect, it } from "vitest";

import {
  BUILTIN_OBJECT_KINDS,
  addBoardObject,
  createLocalCommandOrigin,
  createPageDocument,
  getPageObjects,
  openPageDocument,
} from "../../board/core/index.js";
import {
  BoardDocumentSchemaError,
  applyAndValidateBoardUpdate,
  createBoardDocumentValidationShadow,
} from "./document-schema.js";

const PAGE_ID = "00000000-0000-4000-8000-000000000701";
const PAGE_KEY = `page:${PAGE_ID}`;
const OBJECT_ID = "00000000-0000-4000-8000-000000000702";

function replicaFrom(source: Y.Doc): Y.Doc {
  const replica = openPageDocument(new Y.Doc());
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(source));
  return replica;
}

function captureUpdate(doc: Y.Doc, mutate: () => void): Uint8Array {
  let captured: Uint8Array | undefined;
  const listener = (update: Uint8Array) => {
    captured = update;
  };
  doc.on("update", listener);
  mutate();
  doc.off("update", listener);
  if (!captured) throw new Error("Mutation did not emit a Yjs update");
  return captured;
}

describe("Board document schema validation", () => {
  it("accepts map-backed unknown objects without interpreting plugin payloads", () => {
    const source = createPageDocument(PAGE_ID);
    const shadow = createBoardDocumentValidationShadow(source, PAGE_KEY);
    const replica = replicaFrom(source);
    const baseline = Y.encodeStateVector(source);
    addBoardObject(replica, {
      id: OBJECT_ID,
      kind: "future-lab/vector-magic",
      version: 999,
      transform: [1, 2, 3, 4, 5],
      zRank: "future",
      props: {
        opaque: new Uint8Array([1, 3, 3, 7]),
      },
    }, createLocalCommandOrigin("future-plugin"));

    expect(applyAndValidateBoardUpdate(
      shadow,
      PAGE_KEY,
      Y.encodeStateAsUpdate(replica, baseline),
    )).toBe(true);

    shadow.destroy();
    replica.destroy();
    source.destroy();
  });

  it("rejects unresolved updates, then accepts them after their predecessor", () => {
    const source = createPageDocument(PAGE_ID);
    let shadow = createBoardDocumentValidationShadow(source, PAGE_KEY);
    const replica = replicaFrom(source);
    const first = captureUpdate(replica, () => {
      getPageObjects(replica).set(
        "00000000-0000-4000-8000-000000000703",
        new Y.Map(),
      );
    });
    const second = captureUpdate(replica, () => {
      getPageObjects(replica).set(
        "00000000-0000-4000-8000-000000000704",
        new Y.Map(),
      );
    });

    expect(() => applyAndValidateBoardUpdate(shadow, PAGE_KEY, second))
      .toThrowError(expect.objectContaining({
        code: "CAUSAL_GAP",
      }));
    shadow.destroy();
    shadow = createBoardDocumentValidationShadow(source, PAGE_KEY);
    expect(applyAndValidateBoardUpdate(shadow, PAGE_KEY, first)).toBe(true);
    expect(applyAndValidateBoardUpdate(shadow, PAGE_KEY, second)).toBe(true);
    expect(getPageObjects(shadow).size).toBe(2);
    expect(applyAndValidateBoardUpdate(shadow, PAGE_KEY, second)).toBe(false);

    shadow.destroy();
    replica.destroy();
    source.destroy();
  });

  it("rejects a delete set whose target has not arrived yet", () => {
    const source = createPageDocument(PAGE_ID);
    let shadow = createBoardDocumentValidationShadow(source, PAGE_KEY);
    const replica = replicaFrom(source);
    const objectId = "00000000-0000-4000-8000-000000000705";
    const create = captureUpdate(replica, () => {
      getPageObjects(replica).set(objectId, new Y.Map());
    });
    const remove = captureUpdate(replica, () => {
      getPageObjects(replica).delete(objectId);
    });

    expect(() => applyAndValidateBoardUpdate(shadow, PAGE_KEY, remove))
      .toThrowError(expect.objectContaining({
        code: "CAUSAL_GAP",
      }));
    shadow.destroy();
    shadow = createBoardDocumentValidationShadow(source, PAGE_KEY);
    expect(applyAndValidateBoardUpdate(shadow, PAGE_KEY, create)).toBe(true);
    expect(applyAndValidateBoardUpdate(shadow, PAGE_KEY, remove)).toBe(true);
    expect(applyAndValidateBoardUpdate(shadow, PAGE_KEY, remove)).toBe(false);

    shadow.destroy();
    replica.destroy();
    source.destroy();
  });

  it("rejects a valid Yjs update that replaces an object record with a primitive", () => {
    const source = createPageDocument(PAGE_ID);
    const shadow = createBoardDocumentValidationShadow(source, PAGE_KEY);
    const replica = replicaFrom(source);
    const baseline = Y.encodeStateVector(source);
    (getPageObjects(replica) as Y.Map<unknown>).set(OBJECT_ID, 42);
    const poison = Y.encodeStateAsUpdate(replica, baseline);

    expect(() => Y.decodeUpdate(poison)).not.toThrow();
    expect(() => applyAndValidateBoardUpdate(shadow, PAGE_KEY, poison))
      .toThrowError(BoardDocumentSchemaError);
    expect(getPageObjects(source).has(OBJECT_ID)).toBe(false);

    shadow.destroy();
    replica.destroy();
    source.destroy();
  });
});
