import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_OBJECT_KINDS,
  encodeStrokePoints,
} from "../../../board/core";
import {
  EraserHitIndex,
  buildEraserHitGeometry,
  eraserSweepHits,
  segmentDistanceSquared,
} from "./eraserGeometry";
import type { BoardObjectSnapshot } from "./types";

function snapshot(
  overrides: Partial<BoardObjectSnapshot> = {},
): BoardObjectSnapshot {
  return {
    id: "object",
    kind: BUILTIN_OBJECT_KINDS.line,
    version: 1,
    transform: [0, 0, 100, 100, 0],
    zRank: "a",
    parentId: null,
    style: { strokeWidth: 2 },
    props: { start: [0, 0], end: [100, 100] },
    ...overrides,
  };
}

describe("eraser geometry", () => {
  it("computes continuous segment distance for crossings and degenerate points", () => {
    expect(segmentDistanceSquared(
      { x: 0, y: 5 },
      { x: 10, y: 5 },
      { x: 5, y: 0 },
      { x: 5, y: 10 },
    )).toBe(0);
    expect(segmentDistanceSquared(
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      { x: 3, y: 4 },
    )).toBe(25);
    expect(segmentDistanceSquared(
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 3 },
      { x: 10, y: 3 },
    )).toBe(9);
  });

  it("hits a subpixel line across the entire sweep and rejects a parallel miss", () => {
    const geometry = buildEraserHitGeometry(snapshot({
      transform: [40, 0, 1, 100, 0],
      style: { strokeWidth: 0.5 },
      props: { start: [0, 0], end: [0, 100] },
    }));
    expect(geometry).not.toBeNull();
    expect(eraserSweepHits(geometry!, {
      start: { x: -2_000, y: 50 },
      end: { x: 2_000, y: 50 },
      radius: 12,
    })).toBe(true);
    expect(eraserSweepHits(geometry!, {
      start: { x: 52.3, y: 0 },
      end: { x: 52.3, y: 100 },
      radius: 12,
    })).toBe(false);
    expect(eraserSweepHits(geometry!, {
      start: { x: 52.25, y: 0 },
      end: { x: 52.25, y: 100 },
      radius: 12,
    })).toBe(true);
  });

  it("uses rotated persisted stroke points rather than an object AABB", () => {
    const stroke = snapshot({
      kind: BUILTIN_OBJECT_KINDS.stroke,
      transform: [100, 50, 100, 100, Math.PI / 2],
      props: {
        points: encodeStrokePoints([
          { x: 0, y: 0, pressure: 0.5 },
          { x: 100, y: 100, pressure: 0.5 },
        ]),
      },
    });
    const geometry = buildEraserHitGeometry(stroke);
    expect(geometry).not.toBeNull();
    expect(eraserSweepHits(geometry!, {
      start: { x: 45, y: 95 },
      end: { x: 55, y: 105 },
      radius: 2,
    })).toBe(true);
    expect(eraserSweepHits(geometry!, {
      start: { x: 10, y: 55 },
      end: { x: 30, y: 55 },
      radius: 2,
    })).toBe(false);
  });

  it("does not erase a diagonal line from a broad-phase-only overlap", () => {
    const geometry = buildEraserHitGeometry(snapshot());
    expect(geometry).not.toBeNull();
    expect(eraserSweepHits(geometry!, {
      start: { x: 78, y: 10 },
      end: { x: 100, y: 10 },
      radius: 2,
    })).toBe(false);
  });

  it("includes the filled arrow head in exact hit geometry", () => {
    const geometry = buildEraserHitGeometry(snapshot({
      kind: BUILTIN_OBJECT_KINDS.arrow,
      transform: [0, 0, 100, 1, 0],
      props: { start: [0, 0], end: [100, 0] },
    }));
    expect(geometry).not.toBeNull();
    expect(eraserSweepHits(geometry!, {
      start: { x: 93, y: 3 },
      end: { x: 93, y: 3 },
      radius: 0.25,
    })).toBe(true);
    expect(eraserSweepHits(geometry!, {
      start: { x: 93, y: 6 },
      end: { x: 93, y: 6 },
      radius: 0.25,
    })).toBe(false);
  });

  it("samples quadratic curves for continuous hits and keeps the arrow tangent", () => {
    const line = buildEraserHitGeometry(snapshot({
      transform: [0, 0, 100, 100, 0],
      props: {
        start: [0, 100],
        control: [50, 0],
        end: [100, 100],
      },
    }));
    expect(line?.kind).toBe("polyline");
    expect(eraserSweepHits(line!, {
      start: { x: 50, y: 45 },
      end: { x: 50, y: 55 },
      radius: 0,
    })).toBe(true);
    expect(eraserSweepHits(line!, {
      start: { x: 45, y: 20 },
      end: { x: 55, y: 20 },
      radius: 1,
    })).toBe(false);

    const arrow = buildEraserHitGeometry(snapshot({
      kind: BUILTIN_OBJECT_KINDS.arrow,
      transform: [0, 0, 100, 100, 0],
      props: {
        start: [0, 100],
        control: [50, 0],
        end: [100, 100],
      },
    }));
    expect(arrow?.kind).toBe("polyline");
    if (!arrow || arrow.kind !== "polyline") {
      throw new Error("Expected sampled arrow geometry");
    }
    const head = arrow.filledPolygons[0];
    expect(head[0]).toEqual({ x: 100, y: 100 });
    expect(head[1].x).toBeCloseTo(93.292, 2);
    expect(head[1].y).toBeCloseTo(94.411, 2);
    expect(head[2].x).toBeCloseTo(99.553, 2);
    expect(head[2].y).toBeCloseTo(91.28, 2);
  });

  it("matches Konva's rotated head for a zero-length arrow", () => {
    const arrow = snapshot({
      kind: BUILTIN_OBJECT_KINDS.arrow,
      transform: [100, 50, 100, 100, Math.PI / 2],
      props: { start: [0, 0], end: [0, 0] },
    });
    const geometry = buildEraserHitGeometry(arrow);
    expect(geometry).not.toBeNull();
    expect(eraserSweepHits(geometry!, {
      start: { x: 100, y: 44 },
      end: { x: 100, y: 44 },
      radius: 0.1,
    })).toBe(true);
    expect(eraserSweepHits(geometry!, {
      start: { x: 94, y: 44 },
      end: { x: 94, y: 44 },
      radius: 0.1,
    })).toBe(false);

    const shallowRotationArrow = {
      ...arrow,
      transform: [100, 50, 100, 100, 0.1] as BoardObjectSnapshot["transform"],
    };
    const index = new EraserHitIndex();
    index.replace([shallowRotationArrow]);
    const cornerSweep = {
      start: { x: 91.7, y: 52.68 },
      end: { x: 91.7, y: 52.68 },
      radius: 0.1,
    };
    const candidates = index.search(cornerSweep);
    expect(candidates).toHaveLength(1);
    expect(eraserSweepHits(candidates[0].geometry, cornerSweep)).toBe(true);
  });

  it("indexes long strokes by bounded segment chunks", () => {
    const points = Array.from({ length: 10_000 }, (_, index) => ({
      x: index,
      y: index % 2,
      pressure: 0.5,
    }));
    const geometry = buildEraserHitGeometry(snapshot({
      kind: BUILTIN_OBJECT_KINDS.stroke,
      transform: [0, 0, 9_999, 1, 0],
      props: { points: encodeStrokePoints(points) },
    }));
    expect(geometry?.kind).toBe("polyline");
    if (!geometry || geometry.kind !== "polyline") {
      throw new Error("Expected polyline eraser geometry");
    }
    expect(geometry.segmentChunks).not.toBeNull();
    expect(eraserSweepHits(geometry, {
      start: { x: 5_000, y: -5 },
      end: { x: 5_000, y: 5 },
      radius: 2,
    })).toBe(true);
    expect(eraserSweepHits(geometry, {
      start: { x: 5_000, y: 20 },
      end: { x: 5_010, y: 20 },
      radius: 2,
    })).toBe(false);
  });

  it("does not scan a long stroke's full diagonal AABB for a parallel miss", () => {
    const pointCount = 20_000;
    const points = Array.from({ length: pointCount }, (_, index) => ({
      x: index,
      y: index,
      pressure: 0.5,
    }));
    const geometry = buildEraserHitGeometry(snapshot({
      kind: BUILTIN_OBJECT_KINDS.stroke,
      transform: [0, 500, pointCount - 1, pointCount - 1, 0],
      props: { points: encodeStrokePoints(points) },
    }));
    expect(geometry?.kind).toBe("polyline");
    if (
      !geometry
      || geometry.kind !== "polyline"
      || !geometry.segmentChunks
    ) {
      throw new Error("Expected indexed polyline eraser geometry");
    }

    const originalSearch = geometry.segmentChunks.search.bind(
      geometry.segmentChunks,
    );
    let returnedChunkCount = 0;
    vi.spyOn(geometry.segmentChunks, "search").mockImplementation((bounds) => {
      const chunks = originalSearch(bounds);
      returnedChunkCount += chunks.length;
      return chunks;
    });

    expect(eraserSweepHits(geometry, {
      start: { x: 0, y: 0 },
      end: { x: pointCount - 1, y: pointCount - 1 },
      radius: 2,
    })).toBe(false);
    expect(returnedChunkCount).toBeLessThan(8);
  });

  it("hits a frame label and excludes empty space beside the bounded label", () => {
    const geometry = buildEraserHitGeometry(snapshot({
      kind: BUILTIN_OBJECT_KINDS.frame,
      transform: [0, 100, 200, 100, 0],
      props: { label: "Frame" },
    }));
    expect(geometry).not.toBeNull();
    expect(eraserSweepHits(geometry!, {
      start: { x: 20, y: 80 },
      end: { x: 20, y: 80 },
      radius: 1,
    })).toBe(true);
    expect(eraserSweepHits(geometry!, {
      start: { x: 190, y: 80 },
      end: { x: 190, y: 80 },
      radius: 1,
    })).toBe(false);
  });

  it("keeps large-ellipse tangency precise without global polygon slack", () => {
    const geometry = buildEraserHitGeometry(snapshot({
      kind: BUILTIN_OBJECT_KINDS.ellipse,
      transform: [0, 0, 32_000, 32_000, 0],
      style: { strokeWidth: 0.5 },
      props: {},
    }));
    expect(geometry).not.toBeNull();
    expect(eraserSweepHits(geometry!, {
      start: { x: 16_000, y: -1.75 },
      end: { x: 16_000, y: -1.75 },
      radius: 1.5,
    })).toBe(true);
    expect(eraserSweepHits(geometry!, {
      start: { x: 16_000, y: -1.76 },
      end: { x: 16_000, y: -1.76 },
      radius: 1.5,
    })).toBe(false);
  });

  it("keeps swept tangency precise for an extremely eccentric ellipse", () => {
    const geometry = buildEraserHitGeometry(snapshot({
      kind: BUILTIN_OBJECT_KINDS.ellipse,
      transform: [0, 0, 20_000_000, 1, 0],
      style: { strokeWidth: 0.5 },
      props: {},
    }));
    expect(geometry).not.toBeNull();
    expect(eraserSweepHits(geometry!, {
      start: { x: 9_000_000, y: -1.75 },
      end: { x: 11_000_000, y: -1.75 },
      radius: 1.5,
    })).toBe(true);
    expect(eraserSweepHits(geometry!, {
      start: { x: 9_000_000, y: -1.76 },
      end: { x: 11_000_000, y: -1.76 },
      radius: 1.5,
    })).toBe(false);
    expect(eraserSweepHits(geometry!, {
      start: { x: 10_000_000, y: -1.75 },
      end: { x: 10_000_000, y: -1.75 },
      radius: 1.5,
    })).toBe(true);
  });

  it("indexes broad bounds but decodes and tests only nearby exact candidates", () => {
    const index = new EraserHitIndex();
    index.replace([
      snapshot({ id: "near" }),
      snapshot({
        id: "far",
        transform: [10_000, 10_000, 100, 100, 0],
      }),
    ]);
    expect(index.size).toBe(2);
    const candidates = index.search({
      start: { x: 0, y: 50 },
      end: { x: 100, y: 50 },
      radius: 12,
    });
    expect(candidates.map(({ id }) => id)).toEqual(["near"]);
    expect(eraserSweepHits(candidates[0].geometry, {
      start: { x: 0, y: 50 },
      end: { x: 100, y: 50 },
      radius: 12,
    })).toBe(true);
  });

  it("applies a lasso broad-phase filter before decoding exact geometry", () => {
    let pointReads = 0;
    const lazyProps = Object.defineProperty({}, "points", {
      enumerable: true,
      get() {
        pointReads += 1;
        return [];
      },
    });
    const index = new EraserHitIndex();
    index.replace([
      snapshot({
        id: "concave-notch-stroke",
        kind: BUILTIN_OBJECT_KINDS.stroke,
        transform: [0, 0, 100, 100, 0],
        props: lazyProps,
      }),
    ]);

    expect(index.searchBounds({
      minX: 0,
      minY: 0,
      maxX: 100,
      maxY: 100,
    }, () => false)).toEqual([]);
    expect(pointReads).toBe(0);
  });

  it("queries exact inclusive containment for selection regions", () => {
    const index = new EraserHitIndex();
    index.replace([
      snapshot({
        id: "wide-outline",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [0, 0, 100, 100, 0],
        style: { strokeWidth: 10 },
        props: {},
      }),
      snapshot({
        id: "boundary-equal",
        kind: BUILTIN_OBJECT_KINDS.text,
        transform: [0, 0, 100, 100, 0],
        props: { text: "contained" },
      }),
    ]);

    expect(index.searchContained({
      minX: 0,
      minY: 0,
      maxX: 100,
      maxY: 100,
    })).toEqual(["boundary-equal"]);
    expect(new Set(index.searchContained({
      minX: -5,
      minY: -5,
      maxX: 105,
      maxY: 105,
    }))).toEqual(new Set(["wide-outline", "boundary-equal"]));
    expect(index.searchBounds({
      minX: 10_000,
      minY: 10_000,
      maxX: 10_010,
      maxY: 10_010,
    })).toEqual([]);
  });

  it("uses sampled curve geometry at a containment boundary", () => {
    const index = new EraserHitIndex();
    index.replace([snapshot({
      id: "curve",
      transform: [0, 0, 100, 72, 0],
      props: {
        start: [0, 72],
        control: [50, 0],
        end: [100, 72],
      },
    })]);

    expect(index.searchContained({
      minX: -2,
      minY: 34.75,
      maxX: 102,
      maxY: 74,
    })).toEqual(["curve"]);
    expect(index.searchContained({
      minX: -2,
      minY: 37.5,
      maxX: 102,
      maxY: 74,
    })).toEqual([]);
  });
});
