import type {
  AtomicTransform,
  BoardLineGeometry,
  BoardLinePoint,
} from "../../../board/core";
import {
  boardLineCubicPoints,
  boardPointLineCubicPoints,
  decodeStrokePoints,
  parseBoardLineGeometry,
  sampleBoardLineGeometry,
} from "../../../board/core";
import type { BoardObjectSnapshot, BoardPoint } from "./types";

const SAFE_PLACEHOLDER_TRANSFORM =
  Object.freeze([0, 0, 180, 96, 0]) as AtomicTransform;
export const RENDERED_FRAME_LABEL_HEIGHT = 24;
const MAX_RENDERED_FRAME_LABEL_CODE_UNITS = 128;

export function safeRendererTransform(value: unknown): AtomicTransform {
  if (
    Array.isArray(value)
    && value.length === 5
    && value.every((component) =>
      typeof component === "number" && Number.isFinite(component))
  ) {
    return value as unknown as AtomicTransform;
  }
  return SAFE_PLACEHOLDER_TRANSFORM;
}

function scaleAxis(
  value: number,
  minimum: number,
  maximum: number,
  targetSize: number,
): number {
  const intrinsicSize = maximum - minimum;
  if (intrinsicSize <= Number.EPSILON) return 0;
  return (value - minimum) / intrinsicSize * targetSize;
}

export function scaleIntrinsicPoints(
  points: readonly BoardPoint[],
  transform: AtomicTransform,
): number[] {
  if (points.length === 0) return [];

  let minX = points[0].x;
  let minY = points[0].y;
  let maxX = minX;
  let maxY = minY;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }

  const targetWidth = Math.max(1, Math.abs(transform[2]));
  const targetHeight = Math.max(1, Math.abs(transform[3]));
  const scaled = new Array<number>(points.length * 2);
  for (let index = 0; index < points.length; index += 1) {
    scaled[index * 2] = scaleAxis(points[index].x, minX, maxX, targetWidth);
    scaled[index * 2 + 1] = scaleAxis(points[index].y, minY, maxY, targetHeight);
  }
  return scaled;
}

export interface RenderedLinePath {
  readonly points: number[];
  readonly bezier: boolean;
  readonly endTangent: BoardPoint;
}

export function renderedLineGeometry(
  object: BoardObjectSnapshot,
): BoardLineGeometry | null {
  const geometry = parseBoardLineGeometry(object.props);
  if (!geometry) return null;
  const intrinsicPoints = geometry.points
    ?? (geometry.control
      ? [geometry.start, geometry.control, geometry.end]
      : [geometry.start, geometry.end]);
  const scaled = scaleIntrinsicPoints(
    intrinsicPoints.map(([x, y]) => ({ x, y })),
    object.transform,
  );
  if (
    scaled.length !== intrinsicPoints.length * 2
    || scaled.some((component) => !Number.isFinite(component))
  ) {
    return null;
  }
  const pointAt = (index: number): BoardLinePoint =>
    [scaled[index * 2], scaled[index * 2 + 1]];
  if (geometry.points) {
    const points = geometry.points.map((_point, index) => pointAt(index));
    return {
      start: points[0],
      end: points[points.length - 1],
      points,
    };
  }
  return geometry.control
    ? { start: pointAt(0), control: pointAt(1), end: pointAt(2) }
    : { start: pointAt(0), end: pointAt(1) };
}

function flattenedLinePoints(points: readonly BoardLinePoint[]): number[] {
  const flattened = new Array<number>(points.length * 2);
  for (let index = 0; index < points.length; index += 1) {
    flattened[index * 2] = points[index][0];
    flattened[index * 2 + 1] = points[index][1];
  }
  return flattened;
}

export function renderedLinePath(
  object: BoardObjectSnapshot,
): RenderedLinePath | null {
  const geometry = renderedLineGeometry(object);
  if (!geometry) return null;
  if (geometry.points) {
    const cubic = boardPointLineCubicPoints(geometry.points);
    if (!cubic) {
      return {
        points: flattenedLinePoints(geometry.points),
        bezier: false,
        endTangent: {
          x: geometry.end[0] - geometry.start[0],
          y: geometry.end[1] - geometry.start[1],
        },
      };
    }
    return {
      points: [...cubic],
      bezier: true,
      endTangent: {
        x: cubic[cubic.length - 2] - cubic[cubic.length - 4],
        y: cubic[cubic.length - 1] - cubic[cubic.length - 3],
      },
    };
  }
  const cubic = boardLineCubicPoints(geometry);
  if (!cubic) {
    return {
      points: flattenedLinePoints([geometry.start, geometry.end]),
      bezier: false,
      endTangent: {
        x: geometry.end[0] - geometry.start[0],
        y: geometry.end[1] - geometry.start[1],
      },
    };
  }
  return {
    points: [...cubic],
    bezier: true,
    endTangent: {
      x: cubic[6] - cubic[4],
      y: cubic[7] - cubic[5],
    },
  };
}

export function renderedLinePolyline(
  object: BoardObjectSnapshot,
): RenderedLinePath | null {
  const geometry = renderedLineGeometry(object);
  if (!geometry) return null;
  const points = sampleBoardLineGeometry(geometry);
  const cubic = boardLineCubicPoints(geometry);
  return {
    points: flattenedLinePoints(points),
    bezier: Boolean(cubic),
    endTangent: cubic
      ? { x: cubic[6] - cubic[4], y: cubic[7] - cubic[5] }
      : {
          x: geometry.end[0] - geometry.start[0],
          y: geometry.end[1] - geometry.start[1],
        },
  };
}

export function renderedLinePoints(object: BoardObjectSnapshot): number[] | null {
  return renderedLinePath(object)?.points ?? null;
}

export function renderedStrokePoints(object: BoardObjectSnapshot): number[] | null {
  const packed = object.props.points;
  if (!(packed instanceof Uint8Array)) return null;
  try {
    const points = decodeStrokePoints(packed);
    return points.length > 0 ? scaleIntrinsicPoints(points, object.transform) : null;
  } catch {
    return null;
  }
}

export function renderedFrameLabelWidth(
  object: BoardObjectSnapshot,
  frameWidth: number,
): number {
  const codeUnits = typeof object.props.label === "string"
    ? Math.min(object.props.label.length, MAX_RENDERED_FRAME_LABEL_CODE_UNITS)
    : 7;
  return Math.min(
    Math.max(1, frameWidth),
    Math.max(44, codeUnits * 8 + 10),
  );
}
