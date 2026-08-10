import { describe, expect, it } from "vitest";
import { BUILTIN_OBJECT_KINDS } from "../../../board/core";
import { buildEraserHitGeometry } from "./eraserGeometry";
import {
  compactLassoPoints,
  LassoSelectionRegion,
  selectionRectangleTouchesGeometry,
} from "./selectionGeometry";
import type { BoardObjectSnapshot, BoardPoint } from "./types";

function snapshot(
  overrides: Partial<BoardObjectSnapshot> = {},
): BoardObjectSnapshot {
  return {
    id: "object",
    kind: BUILTIN_OBJECT_KINDS.rectangle,
    version: 1,
    transform: [0, 0, 20, 20, 0],
    zRank: "a",
    parentId: null,
    style: { strokeWidth: 2 },
    props: {},
    ...overrides,
  };
}

function geometry(
  overrides: Partial<BoardObjectSnapshot>,
) {
  const result = buildEraserHitGeometry(snapshot(overrides));
  if (!result) throw new Error("Expected selection hit geometry");
  return result;
}

describe("rectangle touch selection geometry", () => {
  const bounds = { minX: 10, minY: 10, maxX: 30, maxY: 30 };

  it("matches inside, crossing, boundary, and enclosing geometry", () => {
    expect(selectionRectangleTouchesGeometry(bounds, geometry({
      transform: [15, 15, 5, 5, 0],
    }))).toBe(true);
    expect(selectionRectangleTouchesGeometry(bounds, geometry({
      kind: BUILTIN_OBJECT_KINDS.line,
      transform: [0, 20, 40, 1, 0],
      props: { start: [0, 0], end: [40, 0] },
    }))).toBe(true);
    expect(selectionRectangleTouchesGeometry(bounds, geometry({
      transform: [30, 15, 10, 10, 0],
    }))).toBe(true);
    expect(selectionRectangleTouchesGeometry(bounds, geometry({
      transform: [0, 0, 50, 50, 0],
      style: { fill: "rgba(255,255,255,0)", strokeWidth: 2 },
    }))).toBe(true);
  });

  it("rejects an object whose conservative bounds alone overlap", () => {
    expect(selectionRectangleTouchesGeometry(
      { minX: 0, minY: 0, maxX: 5, maxY: 5 },
      geometry({
        kind: BUILTIN_OBJECT_KINDS.ellipse,
        transform: [0, 0, 100, 100, 0],
        style: { strokeWidth: 1 },
      }),
    )).toBe(false);
  });

  it("treats a degenerate rectangle as an inclusive line or point", () => {
    const line = geometry({
      kind: BUILTIN_OBJECT_KINDS.line,
      transform: [0, 20, 40, 1, 0],
      props: { start: [0, 0], end: [40, 0] },
    });
    expect(selectionRectangleTouchesGeometry(
      { minX: 20, minY: 0, maxX: 20, maxY: 40 },
      line,
    )).toBe(true);
    expect(selectionRectangleTouchesGeometry(
      { minX: 20, minY: 20, maxX: 20, maxY: 20 },
      line,
    )).toBe(true);
  });
});

describe("lasso selection geometry", () => {
  it("uses inclusive even-odd containment for concave regions", () => {
    const region = new LassoSelectionRegion([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 40 },
      { x: 40, y: 40 },
      { x: 40, y: 100 },
      { x: 0, y: 100 },
    ]);

    expect(region.hasArea).toBe(true);
    expect(region.containsPoint({ x: 20, y: 70 })).toBe(true);
    expect(region.containsPoint({ x: 40, y: 70 })).toBe(true);
    expect(region.containsPoint({ x: 70, y: 70 })).toBe(false);
    expect(region.containsPoint({ x: 120, y: 20 })).toBe(false);
  });

  it("rejects conservative candidate bounds inside a concave notch", () => {
    const region = new LassoSelectionRegion([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 40 },
      { x: 40, y: 40 },
      { x: 40, y: 100 },
      { x: 0, y: 100 },
    ]);

    expect(region.touchesBounds({
      minX: 60,
      minY: 60,
      maxX: 80,
      maxY: 80,
    })).toBe(false);
    expect(region.touchesBounds({
      minX: 10,
      minY: 60,
      maxX: 20,
      maxY: 70,
    })).toBe(true);
    expect(region.touchesBounds({
      minX: 35,
      minY: 50,
      maxX: 45,
      maxY: 60,
    })).toBe(true);
    expect(region.touchesBounds({
      minX: -10,
      minY: -10,
      maxX: 110,
      maxY: 110,
    })).toBe(true);
  });

  it("matches objects inside, crossing, or containing the lasso", () => {
    const region = new LassoSelectionRegion([
      { x: 10, y: 10 },
      { x: 90, y: 10 },
      { x: 90, y: 90 },
      { x: 10, y: 90 },
    ]);

    expect(region.touchesGeometry(geometry({
      transform: [30, 30, 20, 20, 0],
    }))).toBe(true);
    expect(region.touchesGeometry(geometry({
      kind: BUILTIN_OBJECT_KINDS.line,
      transform: [0, 50, 120, 1, 0],
      props: { start: [0, 0], end: [120, 0] },
    }))).toBe(true);
    expect(region.touchesGeometry(geometry({
      transform: [0, 0, 120, 120, 0],
    }))).toBe(true);
    expect(region.touchesGeometry(geometry({
      transform: [110, 110, 20, 20, 0],
    }))).toBe(false);
  });

  it("matches the sampled path of a curve instead of its control hull", () => {
    const aroundArc = new LassoSelectionRegion([
      { x: 45, y: 45 },
      { x: 55, y: 45 },
      { x: 55, y: 55 },
      { x: 45, y: 55 },
    ]);
    const aroundEmptyControlHull = new LassoSelectionRegion([
      { x: 45, y: 15 },
      { x: 55, y: 15 },
      { x: 55, y: 25 },
      { x: 45, y: 25 },
    ]);
    const curve = geometry({
      kind: BUILTIN_OBJECT_KINDS.line,
      transform: [0, 0, 100, 100, 0],
      props: {
        start: [0, 100],
        control: [50, 0],
        end: [100, 100],
      },
    });

    expect(aroundArc.touchesGeometry(curve)).toBe(true);
    expect(aroundEmptyControlHull.touchesGeometry(curve)).toBe(false);
  });

  it("uses closed-shape selectable interiors even with transparent fill", () => {
    const region = new LassoSelectionRegion([
      { x: 45, y: 45 },
      { x: 55, y: 45 },
      { x: 55, y: 55 },
      { x: 45, y: 55 },
    ]);
    for (const kind of [
      BUILTIN_OBJECT_KINDS.rectangle,
      BUILTIN_OBJECT_KINDS.ellipse,
      BUILTIN_OBJECT_KINDS.diamond,
      BUILTIN_OBJECT_KINDS.frame,
    ]) {
      expect(region.touchesGeometry(geometry({
        kind,
        transform: [0, 0, 100, 100, 0],
        style: {
          fill: "rgba(255,255,255,0)",
          strokeWidth: 2,
        },
      }))).toBe(true);
    }
  });

  it("includes contact with the closing edge and an arrow head", () => {
    const triangle = new LassoSelectionRegion([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]);
    expect(triangle.touchesGeometry(geometry({
      kind: BUILTIN_OBJECT_KINDS.line,
      transform: [48, 50, 4, 1, 0],
      props: { start: [0, 0], end: [4, 0] },
    }))).toBe(true);

    const arrowHeadRegion = new LassoSelectionRegion([
      { x: 91, y: 2 },
      { x: 96, y: 2 },
      { x: 96, y: 5 },
      { x: 91, y: 5 },
    ]);
    expect(arrowHeadRegion.touchesGeometry(geometry({
      kind: BUILTIN_OBJECT_KINDS.arrow,
      transform: [0, 0, 100, 1, 0],
      props: { start: [0, 0], end: [100, 0] },
    }))).toBe(true);
  });

  it("rejects empty, duplicate, and collinear contours", () => {
    const fixtures: readonly (readonly BoardPoint[])[] = [
      [],
      [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }],
      [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }],
    ];
    for (const points of fixtures) {
      const region = new LassoSelectionRegion(points);
      expect(region.hasArea).toBe(false);
      expect(region.containsPoint({ x: 1, y: 1 })).toBe(false);
      expect(region.touchesGeometry(geometry({
        transform: [0, 0, 20, 20, 0],
      }))).toBe(false);
    }
  });

  it("bounds long contours without discarding an isolated sharp corner", () => {
    const points: BoardPoint[] = [
      { x: 0, y: 0 },
      { x: 1, y: 100 },
    ];
    for (let index = 2; index <= 2_048; index += 1) {
      points.push({ x: index, y: 0 });
    }

    const compacted = compactLassoPoints(points, 1_024, 1.5);

    expect(compacted.length).toBeLessThanOrEqual(1_024);
    expect(compacted[0]).toEqual(points[0]);
    expect(compacted.at(-1)).toEqual(points.at(-1));
    expect(compacted).toContainEqual({ x: 1, y: 100 });
    expect(compacted.flatMap((point) => [point.x, point.y]))
      .toHaveLength(compacted.length * 2);
  });
});
