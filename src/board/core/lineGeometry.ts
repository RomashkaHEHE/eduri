import type { AtomicTransform } from "./schema.js";

export const MAX_BOARD_LINE_COORDINATE = 0x7fff_ffff / 64;
export const DEFAULT_BOARD_LINE_SAMPLE_ERROR = 0.25;
export const MAX_BOARD_LINE_SAMPLE_SEGMENTS = 256;

export type BoardLinePoint = readonly [x: number, y: number];

export interface BoardLineGeometry {
  readonly start: BoardLinePoint;
  readonly end: BoardLinePoint;
  readonly control?: BoardLinePoint;
}

export interface BoardLineObjectGeometry {
  readonly transform: AtomicTransform;
  readonly props: Readonly<Record<string, unknown>>;
}

export interface BoardLineBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function finiteBoundedPoint(value: unknown): BoardLinePoint | null {
  if (
    !Array.isArray(value)
    || value.length !== 2
    || typeof value[0] !== "number"
    || !Number.isFinite(value[0])
    || Math.abs(value[0]) > MAX_BOARD_LINE_COORDINATE
    || typeof value[1] !== "number"
    || !Number.isFinite(value[1])
    || Math.abs(value[1]) > MAX_BOARD_LINE_COORDINATE
  ) {
    return null;
  }
  return value as unknown as BoardLinePoint;
}

export function parseBoardLineGeometry(
  props: unknown,
): BoardLineGeometry | null {
  if (props === null || typeof props !== "object" || Array.isArray(props)) {
    return null;
  }
  const candidate = props as Readonly<Record<string, unknown>>;
  const start = finiteBoundedPoint(candidate.start);
  const end = finiteBoundedPoint(candidate.end);
  if (!start || !end) return null;

  if (candidate.control === undefined) return { start, end };
  const control = finiteBoundedPoint(candidate.control);
  return control ? { start, end, control } : null;
}

function assertBoardLinePoint(value: BoardLinePoint, label: string): void {
  if (!finiteBoundedPoint(value)) {
    throw new RangeError(
      `${label} must contain exactly two finite, supported board coordinates`,
    );
  }
}

export function createBoardLineObjectGeometry(
  start: BoardLinePoint,
  end: BoardLinePoint,
  control?: BoardLinePoint,
): BoardLineObjectGeometry {
  assertBoardLinePoint(start, "start");
  assertBoardLinePoint(end, "end");
  if (control) assertBoardLinePoint(control, "control");

  const points = control ? [start, control, end] : [start, end];
  let minX = points[0][0];
  let minY = points[0][1];
  let maxX = minX;
  let maxY = minY;
  for (let index = 1; index < points.length; index += 1) {
    minX = Math.min(minX, points[index][0]);
    minY = Math.min(minY, points[index][1]);
    maxX = Math.max(maxX, points[index][0]);
    maxY = Math.max(maxY, points[index][1]);
  }
  if (
    maxX - minX > MAX_BOARD_LINE_COORDINATE
    || maxY - minY > MAX_BOARD_LINE_COORDINATE
  ) {
    throw new RangeError("Line geometry exceeds the supported board coordinate range");
  }

  const localPoint = (point: BoardLinePoint): BoardLinePoint =>
    [point[0] - minX, point[1] - minY];
  const props: Record<string, unknown> = {
    start: localPoint(start),
    end: localPoint(end),
  };
  if (control) props.control = localPoint(control);

  return {
    transform: Object.freeze([
      minX,
      minY,
      Math.max(1, maxX - minX),
      Math.max(1, maxY - minY),
      0,
    ]) as AtomicTransform,
    props: Object.freeze(props),
  };
}

export function boardLineCubicPoints(
  geometry: BoardLineGeometry,
): readonly [
  startX: number,
  startY: number,
  firstControlX: number,
  firstControlY: number,
  secondControlX: number,
  secondControlY: number,
  endX: number,
  endY: number,
] | null {
  const { start, control, end } = geometry;
  if (!control) return null;
  return [
    start[0],
    start[1],
    start[0] + (control[0] - start[0]) * 2 / 3,
    start[1] + (control[1] - start[1]) * 2 / 3,
    end[0] + (control[0] - end[0]) * 2 / 3,
    end[1] + (control[1] - end[1]) * 2 / 3,
    end[0],
    end[1],
  ];
}

function quadraticCoordinate(
  start: number,
  control: number,
  end: number,
  progress: number,
): number {
  const remaining = 1 - progress;
  return remaining * remaining * start
    + 2 * remaining * progress * control
    + progress * progress * end;
}

export function boardLineBounds(
  geometry: BoardLineGeometry,
): BoardLineBounds {
  const { start, control, end } = geometry;
  let minX = Math.min(start[0], end[0]);
  let minY = Math.min(start[1], end[1]);
  let maxX = Math.max(start[0], end[0]);
  let maxY = Math.max(start[1], end[1]);
  if (!control) return { minX, minY, maxX, maxY };

  const xDivisor = start[0] - 2 * control[0] + end[0];
  if (xDivisor !== 0) {
    const progress = (start[0] - control[0]) / xDivisor;
    if (progress > 0 && progress < 1) {
      const x = quadraticCoordinate(start[0], control[0], end[0], progress);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
  }
  const yDivisor = start[1] - 2 * control[1] + end[1];
  if (yDivisor !== 0) {
    const progress = (start[1] - control[1]) / yDivisor;
    if (progress > 0 && progress < 1) {
      const y = quadraticCoordinate(start[1], control[1], end[1], progress);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, minY, maxX, maxY };
}

export function sampleBoardLineGeometry(
  geometry: BoardLineGeometry,
  maximumError = DEFAULT_BOARD_LINE_SAMPLE_ERROR,
  maximumSegments = MAX_BOARD_LINE_SAMPLE_SEGMENTS,
): readonly BoardLinePoint[] {
  const { start, control, end } = geometry;
  if (!control) return [start, end];

  const boundedError = Number.isFinite(maximumError) && maximumError > 0
    ? maximumError
    : DEFAULT_BOARD_LINE_SAMPLE_ERROR;
  const boundedMaximumSegments = Number.isFinite(maximumSegments)
    ? Math.max(1, Math.min(
        MAX_BOARD_LINE_SAMPLE_SEGMENTS,
        Math.floor(maximumSegments),
      ))
    : MAX_BOARD_LINE_SAMPLE_SEGMENTS;
  const secondDifference = Math.hypot(
    start[0] - 2 * control[0] + end[0],
    start[1] - 2 * control[1] + end[1],
  );
  const segmentCount = Math.max(1, Math.min(
    boundedMaximumSegments,
    Math.ceil(Math.sqrt(secondDifference / (4 * boundedError))),
  ));
  const points = new Array<BoardLinePoint>(segmentCount + 1);
  points[0] = start;
  for (let index = 1; index < segmentCount; index += 1) {
    const progress = index / segmentCount;
    const remaining = 1 - progress;
    points[index] = [
      quadraticCoordinate(start[0], control[0], end[0], progress),
      quadraticCoordinate(start[1], control[1], end[1], progress),
    ];
  }
  points[segmentCount] = end;
  return points;
}
