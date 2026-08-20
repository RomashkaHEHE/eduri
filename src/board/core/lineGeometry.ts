import type { AtomicTransform } from "./schema.js";

export const MAX_BOARD_LINE_COORDINATE = 0x7fff_ffff / 64;
export const DEFAULT_BOARD_LINE_SAMPLE_ERROR = 0.25;
export const MAX_BOARD_LINE_SAMPLE_SEGMENTS = 256;
export const MAX_BOARD_LINE_POINTS = 128;

export type BoardLinePoint = readonly [x: number, y: number];

export interface BoardLineGeometry {
  readonly start: BoardLinePoint;
  readonly end: BoardLinePoint;
  readonly control?: BoardLinePoint;
  /** Ordered editable anchors. Absent on legacy straight/quadratic lines. */
  readonly points?: readonly BoardLinePoint[];
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
  if (candidate.points !== undefined) {
    if (
      !Array.isArray(candidate.points)
      || candidate.points.length < 2
      || candidate.points.length > MAX_BOARD_LINE_POINTS
    ) return null;
    const points = candidate.points.map(finiteBoundedPoint);
    if (points.some((point) => point === null)) return null;
    const validPoints = points as BoardLinePoint[];
    return {
      start: validPoints[0],
      end: validPoints[validPoints.length - 1],
      points: validPoints,
    };
  }
  const start = finiteBoundedPoint(candidate.start);
  const end = finiteBoundedPoint(candidate.end);
  if (!start || !end) return null;

  if (candidate.control === undefined) return { start, end };
  const control = finiteBoundedPoint(candidate.control);
  return control ? { start, end, control } : null;
}

export function createBoardPointLineObjectGeometry(
  points: readonly BoardLinePoint[],
  angle = 0,
): BoardLineObjectGeometry {
  if (points.length < 2 || points.length > MAX_BOARD_LINE_POINTS) {
    throw new RangeError(`Line must contain between 2 and ${MAX_BOARD_LINE_POINTS} points`);
  }
  if (!Number.isFinite(angle)) throw new RangeError("angle must be finite");
  points.forEach((point, index) => assertBoardLinePoint(point, `points[${index}]`));

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
  ) throw new RangeError("Line geometry exceeds the supported board coordinate range");

  return {
    transform: Object.freeze([
      minX,
      minY,
      Math.max(1, maxX - minX),
      Math.max(1, maxY - minY),
      angle,
    ]) as AtomicTransform,
    props: Object.freeze({
      points: points.map(([x, y]) => [x - minX, y - minY] as BoardLinePoint),
    }),
  };
}

/** Cubic Catmull-Rom path which passes through every editable anchor. */
export function boardPointLineCubicPoints(
  points: readonly BoardLinePoint[],
): readonly number[] | null {
  if (points.length < 3) return null;
  const path: number[] = [points[0][0], points[0][1]];
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[Math.max(0, index - 1)];
    const start = points[index];
    const end = points[index + 1];
    const next = points[Math.min(points.length - 1, index + 2)];
    path.push(
      start[0] + (end[0] - previous[0]) / 6,
      start[1] + (end[1] - previous[1]) / 6,
      end[0] - (next[0] - start[0]) / 6,
      end[1] - (next[1] - start[1]) / 6,
      end[0],
      end[1],
    );
  }
  return path;
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
  if (geometry.points) {
    const sampled = sampleBoardLineGeometry(geometry);
    let minX = sampled[0][0];
    let minY = sampled[0][1];
    let maxX = minX;
    let maxY = minY;
    for (const point of sampled.slice(1)) {
      minX = Math.min(minX, point[0]);
      minY = Math.min(minY, point[1]);
      maxX = Math.max(maxX, point[0]);
      maxY = Math.max(maxY, point[1]);
    }
    return { minX, minY, maxX, maxY };
  }
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
  if (geometry.points) {
    const points = geometry.points;
    if (points.length === 2) return points;
    const cubic = boardPointLineCubicPoints(points);
    if (!cubic) return points;
    const segmentBudget = Math.max(1, Math.min(
      MAX_BOARD_LINE_SAMPLE_SEGMENTS,
      Number.isFinite(maximumSegments) ? Math.floor(maximumSegments) : MAX_BOARD_LINE_SAMPLE_SEGMENTS,
    ));
    const samplesPerSegment = Math.max(2, Math.floor(segmentBudget / (points.length - 1)));
    const sampled: BoardLinePoint[] = [points[0]];
    for (let segment = 0; segment < points.length - 1; segment += 1) {
      const offset = segment * 6;
      const start: BoardLinePoint = [cubic[offset], cubic[offset + 1]];
      const first: BoardLinePoint = [cubic[offset + 2], cubic[offset + 3]];
      const second: BoardLinePoint = [cubic[offset + 4], cubic[offset + 5]];
      const end: BoardLinePoint = [cubic[offset + 6], cubic[offset + 7]];
      for (let step = 1; step <= samplesPerSegment; step += 1) {
        const progress = step / samplesPerSegment;
        const remaining = 1 - progress;
        sampled.push([
          remaining ** 3 * start[0]
            + 3 * remaining ** 2 * progress * first[0]
            + 3 * remaining * progress ** 2 * second[0]
            + progress ** 3 * end[0],
          remaining ** 3 * start[1]
            + 3 * remaining ** 2 * progress * first[1]
            + 3 * remaining * progress ** 2 * second[1]
            + progress ** 3 * end[1],
        ]);
      }
    }
    return sampled;
  }
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
