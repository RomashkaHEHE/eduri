import { describe, expect, it } from "vitest";
import {
  MAX_BOARD_LINE_COORDINATE,
  boardLineBounds,
  boardLineCubicPoints,
  createBoardLineObjectGeometry,
  parseBoardLineGeometry,
  sampleBoardLineGeometry,
} from "./lineGeometry";

describe("Board line geometry", () => {
  it("parses legacy straight lines and optional quadratic controls", () => {
    expect(parseBoardLineGeometry({
      start: [0, 40],
      end: [100, 0],
    })).toEqual({ start: [0, 40], end: [100, 0] });
    expect(parseBoardLineGeometry({
      start: [0, 40],
      control: [50, 0],
      end: [100, 40],
    })).toEqual({
      start: [0, 40],
      control: [50, 0],
      end: [100, 40],
    });
  });

  it.each([
    null,
    [],
    { start: [0], end: [1, 1] },
    { start: [0, 0, 0], end: [1, 1] },
    { start: [0, 0], end: [1, Number.NaN] },
    { start: [0, 0], end: [1, 1], control: null },
    { start: [0, 0], end: [1, 1], control: [0, Number.POSITIVE_INFINITY] },
    { start: [0, 0], end: [MAX_BOARD_LINE_COORDINATE + 1, 1] },
  ])("rejects malformed or unbounded props %#", (props) => {
    expect(parseBoardLineGeometry(props)).toBeNull();
  });

  it("normalizes a curve into one transform while retaining its direction", () => {
    expect(createBoardLineObjectGeometry(
      [100, 80],
      [0, 80],
      [50, 0],
    )).toEqual({
      transform: [0, 0, 100, 80, 0],
      props: {
        start: [100, 80],
        end: [0, 80],
        control: [50, 0],
      },
    });
  });

  it("converts the quadratic control to an equivalent cubic path", () => {
    expect(boardLineCubicPoints({
      start: [0, 0],
      control: [30, 60],
      end: [90, 0],
    })).toEqual([
      0,
      0,
      20,
      40,
      50,
      40,
      90,
      0,
    ]);
    expect(boardLineCubicPoints({
      start: [0, 0],
      end: [90, 0],
    })).toBeNull();
  });

  it("computes exact quadratic extrema instead of the control hull", () => {
    expect(boardLineBounds({
      start: [0, 80],
      control: [50, 0],
      end: [100, 80],
    })).toEqual({
      minX: 0,
      minY: 40,
      maxX: 100,
      maxY: 80,
    });
    expect(boardLineBounds({
      start: [0, 0],
      end: [100, 80],
    })).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 80 });
  });

  it("samples curves with exact endpoints and a bounded adaptive budget", () => {
    const ordinary = sampleBoardLineGeometry({
      start: [0, 0],
      control: [50, 100],
      end: [100, 0],
    });
    expect(ordinary[0]).toEqual([0, 0]);
    expect(ordinary.at(-1)).toEqual([100, 0]);
    expect(ordinary.length).toBeGreaterThan(2);
    expect(Math.max(...ordinary.map((point) => point[1]))).toBeCloseTo(50, 0);

    const huge = sampleBoardLineGeometry({
      start: [0, 0],
      control: [0, MAX_BOARD_LINE_COORDINATE],
      end: [MAX_BOARD_LINE_COORDINATE, 0],
    });
    expect(huge).toHaveLength(257);
    expect(huge.every((point) =>
      point.every((component) => Number.isFinite(component)))).toBe(true);
  });
});
