import { describe, expect, it } from "vitest";
import { BUILTIN_OBJECT_KINDS } from "../../../board/core";
import { BoardSpatialIndex, spatialItemForObject } from "./spatialIndex";
import type { BoardObjectSnapshot } from "./types";

function object(id: string, transform: readonly [number, number, number, number, number]): BoardObjectSnapshot {
  return {
    id,
    kind: "eduri/rectangle",
    version: 1,
    transform,
    zRank: id,
    parentId: null,
    style: {},
    props: {},
  };
}

describe("BoardSpatialIndex", () => {
  it("updates and searches visible logical bounds", () => {
    const index = new BoardSpatialIndex();
    index.set(object("a", [0, 0, 100, 100, 0]));
    index.set(object("b", [1_000, 1_000, 40, 40, 0]));

    expect(index.search({ minX: -10, minY: -10, maxX: 120, maxY: 120 })).toEqual(["a"]);
    index.set(object("a", [2_000, 2_000, 50, 50, 0]));
    expect(index.search({ minX: -10, minY: -10, maxX: 120, maxY: 120 })).toEqual([]);
    expect(index.size).toBe(2);
  });

  it("accounts for rotation and returns aggregate bounds", () => {
    const index = new BoardSpatialIndex();
    index.replace([
      object("a", [10, 10, 100, 40, Math.PI / 2]),
      object("b", [-20, -30, 5, 5, 0]),
    ]);

    const bounds = index.allBounds();
    expect(bounds).not.toBeNull();
    expect(bounds!.minX).toBeLessThanOrEqual(-30);
    expect(bounds!.maxY).toBeGreaterThanOrEqual(110);
  });

  it("indexes negative dimensions after rotation around the object origin", () => {
    const index = new BoardSpatialIndex();
    index.set(object("negative", [10, 20, -4, 2, Math.PI / 2]));

    expect(index.allBounds()).toEqual({
      minX: 8,
      minY: 16,
      maxX: 10,
      maxY: 20,
    });
    expect(index.search({ minX: 8, minY: 16, maxX: 10, maxY: 20 })).toEqual(["negative"]);
  });

  it("uses the same one-unit minimum geometry as the renderer after rotation", () => {
    const index = new BoardSpatialIndex();
    index.set(object("thin", [10, 20, 0.25, 0.5, Math.PI / 2]));

    expect(index.allBounds()).toEqual({
      minX: 9,
      minY: 20,
      maxX: 10,
      maxY: 21,
    });
  });

  it("uses exact rotated quadratic extrema for curved line bounds", () => {
    const curve: BoardObjectSnapshot = {
      ...object("curve", [10, 20, 100, 80, Math.PI / 2]),
      kind: BUILTIN_OBJECT_KINDS.line,
      props: {
        start: [0, 80],
        control: [50, 0],
        end: [100, 80],
      },
    };

    const bounds = spatialItemForObject(curve);
    expect(bounds).toMatchObject({
      id: "curve",
      minX: -70,
      maxX: -30,
      maxY: 120,
    });
    expect(bounds.minY).toBeCloseTo(20);
  });

  it("replaces and queries a 50,000 object board without argument spreading", () => {
    const index = new BoardSpatialIndex();
    const objects = Array.from({ length: 50_000 }, (_, position) =>
      object(`object-${position}`, [position * 12, position % 17, 8, 8, 0]));

    index.replace(objects);

    expect(index.size).toBe(50_000);
    expect(index.allBounds()).toEqual({
      minX: 0,
      minY: 0,
      maxX: 599_996,
      maxY: 24,
    });
    expect(new Set(index.search({
      minX: 12_000,
      minY: -1,
      maxX: 12_128,
      maxY: 25,
    }))).toEqual(new Set(Array.from({ length: 11 }, (_, offset) => `object-${1_000 + offset}`)));
  });
});
