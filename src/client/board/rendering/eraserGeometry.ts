import RBush from "rbush";
import {
  BUILTIN_OBJECT_KINDS,
  DEFAULT_BOARD_LINE_SAMPLE_ERROR,
  type AtomicTransform,
} from "../../../board/core";
import {
  RENDERED_FRAME_LABEL_HEIGHT,
  renderedLinePolyline,
  renderedFrameLabelWidth,
  renderedStrokePoints,
  safeRendererTransform,
} from "./objectGeometry";
import type { BoardObjectSnapshot, BoardPoint } from "./types";

const GEOMETRY_EPSILON = 1e-9;
const POLYLINE_SEGMENTS_PER_CHUNK = 64;
const POLYLINE_CHUNK_INDEX_THRESHOLD = POLYLINE_SEGMENTS_PER_CHUNK * 2;
const POLYLINE_SWEEP_QUERY_LENGTH_PER_RADIUS = 8;
const POLYLINE_SWEEP_MAX_QUERY_PARTITIONS = 256;
const ELLIPSE_POINT_DISTANCE_ITERATIONS = 52;

export interface EraserSweep {
  readonly start: BoardPoint;
  readonly end: BoardPoint;
  readonly radius: number;
}

export interface EraserSpatialBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

interface PolylineEraserGeometry {
  readonly kind: "polyline";
  readonly points: readonly BoardPoint[];
  readonly radius: number;
  readonly filledPolygons: readonly (readonly BoardPoint[])[];
  readonly segmentChunks: RBush<PolylineSegmentChunk> | null;
  readonly bounds: EraserSpatialBounds;
}

interface PolygonEraserGeometry {
  readonly kind: "polygon";
  readonly points: readonly BoardPoint[];
  readonly radius: number;
  readonly bounds: EraserSpatialBounds;
}

interface EllipseEraserGeometry {
  readonly kind: "ellipse";
  readonly center: BoardPoint;
  readonly radiusX: number;
  readonly radiusY: number;
  readonly rotation: number;
  readonly radius: number;
  readonly bounds: EraserSpatialBounds;
}

export type EraserHitGeometry =
  | PolylineEraserGeometry
  | PolygonEraserGeometry
  | EllipseEraserGeometry;

export interface IndexedEraserHitGeometry {
  readonly id: string;
  readonly geometry: EraserHitGeometry;
}

export interface IndexedEraserSpatialBounds extends EraserSpatialBounds {
  readonly id: string;
}

interface EraserSpatialItem extends IndexedEraserSpatialBounds {
  readonly id: string;
  readonly object: BoardObjectSnapshot;
  geometry?: EraserHitGeometry | null;
}

interface PolylineSegmentChunk extends EraserSpatialBounds {
  readonly startSegment: number;
  readonly endSegment: number;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function rendererStrokeWidth(object: BoardObjectSnapshot, fallback = 2): number {
  return Math.max(0.5, Math.min(96, finiteNumber(object.style.strokeWidth, fallback)));
}

function objectDimensions(
  transform: AtomicTransform,
): { readonly width: number; readonly height: number } {
  return {
    width: Math.max(1, Math.abs(transform[2])),
    height: Math.max(1, Math.abs(transform[3])),
  };
}

function localToWorld(
  transform: AtomicTransform,
  point: BoardPoint,
): BoardPoint {
  const cosine = Math.cos(transform[4]);
  const sine = Math.sin(transform[4]);
  return {
    x: transform[0] + point.x * cosine - point.y * sine,
    y: transform[1] + point.x * sine + point.y * cosine,
  };
}

function localPointsToWorld(
  transform: AtomicTransform,
  points: readonly number[],
): BoardPoint[] {
  const result: BoardPoint[] = [];
  for (let index = 0; index + 1 < points.length; index += 2) {
    const point = { x: points[index], y: points[index + 1] };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    result.push(localToWorld(transform, point));
  }
  return result;
}

function localVectorToWorld(
  transform: AtomicTransform,
  vector: BoardPoint,
): BoardPoint {
  const cosine = Math.cos(transform[4]);
  const sine = Math.sin(transform[4]);
  return {
    x: vector.x * cosine - vector.y * sine,
    y: vector.x * sine + vector.y * cosine,
  };
}

function boundsFromPoints(
  points: readonly BoardPoint[],
  outset: number,
): EraserSpatialBounds | null {
  if (points.length === 0) return null;
  let minX = points[0].x;
  let minY = points[0].y;
  let maxX = minX;
  let maxY = minY;
  for (let index = 1; index < points.length; index += 1) {
    minX = Math.min(minX, points[index].x);
    minY = Math.min(minY, points[index].y);
    maxX = Math.max(maxX, points[index].x);
    maxY = Math.max(maxY, points[index].y);
  }
  return {
    minX: minX - outset,
    minY: minY - outset,
    maxX: maxX + outset,
    maxY: maxY + outset,
  };
}

function boundsFromPointRange(
  points: readonly BoardPoint[],
  startIndex: number,
  endIndex: number,
  outset: number,
): EraserSpatialBounds | null {
  if (startIndex < 0 || endIndex < startIndex || endIndex >= points.length) {
    return null;
  }
  let minX = points[startIndex].x;
  let minY = points[startIndex].y;
  let maxX = minX;
  let maxY = minY;
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    minX = Math.min(minX, points[index].x);
    minY = Math.min(minY, points[index].y);
    maxX = Math.max(maxX, points[index].x);
    maxY = Math.max(maxY, points[index].y);
  }
  return {
    minX: minX - outset,
    minY: minY - outset,
    maxX: maxX + outset,
    maxY: maxY + outset,
  };
}

function combinedBounds(
  pointSets: readonly (readonly BoardPoint[])[],
  outset: number,
): EraserSpatialBounds | null {
  let bounds: EraserSpatialBounds | null = null;
  for (const pointSet of pointSets) {
    const current = boundsFromPoints(pointSet, outset);
    if (!current) continue;
    bounds = bounds
      ? {
          minX: Math.min(bounds.minX, current.minX),
          minY: Math.min(bounds.minY, current.minY),
          maxX: Math.max(bounds.maxX, current.maxX),
          maxY: Math.max(bounds.maxY, current.maxY),
        }
      : current;
  }
  return bounds;
}

function validSpatialBounds(bounds: EraserSpatialBounds): boolean {
  return Number.isFinite(bounds.minX)
    && Number.isFinite(bounds.minY)
    && Number.isFinite(bounds.maxX)
    && Number.isFinite(bounds.maxY)
    && bounds.minX <= bounds.maxX
    && bounds.minY <= bounds.maxY;
}

function spatialBoundsContain(
  outer: EraserSpatialBounds,
  inner: EraserSpatialBounds,
): boolean {
  return inner.minX >= outer.minX
    && inner.minY >= outer.minY
    && inner.maxX <= outer.maxX
    && inner.maxY <= outer.maxY;
}

function rectanglePoints(
  transform: AtomicTransform,
  width: number,
  height: number,
): BoardPoint[] {
  return [
    localToWorld(transform, { x: 0, y: 0 }),
    localToWorld(transform, { x: width, y: 0 }),
    localToWorld(transform, { x: width, y: height }),
    localToWorld(transform, { x: 0, y: height }),
  ];
}

function framePoints(
  object: BoardObjectSnapshot,
  transform: AtomicTransform,
  width: number,
  height: number,
): BoardPoint[] {
  const labelWidth = renderedFrameLabelWidth(object, width);
  return [
    localToWorld(transform, { x: 0, y: -RENDERED_FRAME_LABEL_HEIGHT }),
    localToWorld(transform, {
      x: labelWidth,
      y: -RENDERED_FRAME_LABEL_HEIGHT,
    }),
    localToWorld(transform, { x: labelWidth, y: 0 }),
    localToWorld(transform, { x: width, y: 0 }),
    localToWorld(transform, { x: width, y: height }),
    localToWorld(transform, { x: 0, y: height }),
  ];
}

function broadBoundsForObject(
  object: BoardObjectSnapshot,
): EraserSpatialBounds | null {
  const transform = safeRendererTransform(object.transform);
  const { width, height } = objectDimensions(transform);
  let outset = 0;
  if (
    object.kind === BUILTIN_OBJECT_KINDS.line
    || object.kind === BUILTIN_OBJECT_KINDS.stroke
  ) {
    outset = rendererStrokeWidth(object) / 2;
  } else if (object.kind === BUILTIN_OBJECT_KINDS.arrow) {
    const widthValue = rendererStrokeWidth(object);
    const pointerLength = Math.max(8, widthValue * 4);
    const halfPointerWidth = Math.max(7, widthValue * 3.5) / 2;
    outset = Math.hypot(pointerLength, halfPointerWidth)
      + widthValue / 2;
  } else if (
    object.kind === BUILTIN_OBJECT_KINDS.rectangle
    || object.kind === BUILTIN_OBJECT_KINDS.ellipse
    || object.kind === BUILTIN_OBJECT_KINDS.diamond
  ) {
    outset = rendererStrokeWidth(object) / 2;
  } else if (object.kind === BUILTIN_OBJECT_KINDS.frame) {
    outset = rendererStrokeWidth(object, 1.5) / 2;
  } else if (
    object.kind === BUILTIN_OBJECT_KINDS.code
    || object.kind === BUILTIN_OBJECT_KINDS.latex
    || object.kind === BUILTIN_OBJECT_KINDS.image
  ) {
    outset = 0.5;
  }
  return boundsFromPoints(
    object.kind === BUILTIN_OBJECT_KINDS.frame
      ? framePoints(object, transform, width, height)
      : rectanglePoints(transform, width, height),
    outset,
  );
}

function arrowHeadPoints(
  points: readonly BoardPoint[],
  strokeWidth: number,
  fallbackDirection: BoardPoint,
  endingDirection?: BoardPoint,
): readonly BoardPoint[] {
  if (points.length < 2) return [];
  const tip = points[points.length - 1];
  let directionX = fallbackDirection.x;
  let directionY = fallbackDirection.y;
  if (endingDirection) {
    const length = Math.hypot(endingDirection.x, endingDirection.y);
    if (length > 0) {
      directionX = endingDirection.x / length;
      directionY = endingDirection.y / length;
    }
  } else {
    let previousIndex = points.length - 2;
    while (
      previousIndex >= 0
      && Math.hypot(
        tip.x - points[previousIndex].x,
        tip.y - points[previousIndex].y,
      ) === 0
    ) {
      previousIndex -= 1;
    }
    if (previousIndex >= 0) {
      const previous = points[previousIndex];
      const length = Math.hypot(tip.x - previous.x, tip.y - previous.y);
      directionX = (tip.x - previous.x) / length;
      directionY = (tip.y - previous.y) / length;
    }
  }
  const pointerLength = Math.max(8, strokeWidth * 4);
  const halfPointerWidth = Math.max(7, strokeWidth * 3.5) / 2;
  const base = {
    x: tip.x - directionX * pointerLength,
    y: tip.y - directionY * pointerLength,
  };
  const perpendicularX = -directionY * halfPointerWidth;
  const perpendicularY = directionX * halfPointerWidth;
  return [
    tip,
    {
      x: base.x + perpendicularX,
      y: base.y + perpendicularY,
    },
    {
      x: base.x - perpendicularX,
      y: base.y - perpendicularY,
    },
  ];
}

function polygonGeometry(
  points: readonly BoardPoint[],
  radius: number,
): PolygonEraserGeometry | null {
  const bounds = boundsFromPoints(points, radius);
  return bounds ? { kind: "polygon", points, radius, bounds } : null;
}

function polylineGeometry(
  points: readonly BoardPoint[],
  radius: number,
  filledPolygons: readonly (readonly BoardPoint[])[] = [],
): PolylineEraserGeometry | null {
  const bounds = combinedBounds([points, ...filledPolygons], radius);
  let segmentChunks: RBush<PolylineSegmentChunk> | null = null;
  if (points.length - 1 > POLYLINE_CHUNK_INDEX_THRESHOLD) {
    const chunks: PolylineSegmentChunk[] = [];
    for (
      let startSegment = 0;
      startSegment < points.length - 1;
      startSegment += POLYLINE_SEGMENTS_PER_CHUNK
    ) {
      const endSegment = Math.min(
        points.length - 1,
        startSegment + POLYLINE_SEGMENTS_PER_CHUNK,
      );
      const chunkBounds = boundsFromPointRange(
        points,
        startSegment,
        endSegment,
        radius,
      );
      if (chunkBounds) {
        chunks.push({ startSegment, endSegment, ...chunkBounds });
      }
    }
    segmentChunks = new RBush<PolylineSegmentChunk>();
    segmentChunks.load(chunks);
  }
  return bounds
    ? {
        kind: "polyline",
        points,
        radius,
        filledPolygons,
        segmentChunks,
        bounds,
      }
    : null;
}

export function buildEraserHitGeometry(
  object: BoardObjectSnapshot,
): EraserHitGeometry | null {
  const transform = safeRendererTransform(object.transform);
  const { width, height } = objectDimensions(transform);

  if (
    object.kind === BUILTIN_OBJECT_KINDS.line
    || object.kind === BUILTIN_OBJECT_KINDS.arrow
  ) {
    const localPath = renderedLinePolyline(object);
    if (!localPath) return null;
    const points = localPointsToWorld(transform, localPath.points);
    const widthValue = rendererStrokeWidth(object);
    const arrowHead = object.kind === BUILTIN_OBJECT_KINDS.arrow
      ? arrowHeadPoints(points, widthValue, {
          x: Math.cos(transform[4]),
          y: Math.sin(transform[4]),
        }, localVectorToWorld(transform, localPath.endTangent))
      : [];
    return polylineGeometry(
      points,
      widthValue / 2
        + (localPath.bezier ? DEFAULT_BOARD_LINE_SAMPLE_ERROR : 0),
      arrowHead.length > 0 ? [arrowHead] : [],
    );
  }

  if (object.kind === BUILTIN_OBJECT_KINDS.stroke) {
    const localPoints = renderedStrokePoints(object);
    if (!localPoints) return null;
    return polylineGeometry(
      localPointsToWorld(transform, localPoints),
      rendererStrokeWidth(object) / 2,
    );
  }

  if (object.kind === BUILTIN_OBJECT_KINDS.ellipse) {
    const center = localToWorld(transform, { x: width / 2, y: height / 2 });
    const radiusX = width / 2;
    const radiusY = height / 2;
    const cosine = Math.cos(transform[4]);
    const sine = Math.sin(transform[4]);
    const extentX = Math.hypot(radiusX * cosine, radiusY * sine);
    const extentY = Math.hypot(radiusX * sine, radiusY * cosine);
    const radius = rendererStrokeWidth(object) / 2;
    return {
      kind: "ellipse",
      center,
      radiusX,
      radiusY,
      rotation: transform[4],
      radius,
      bounds: {
        minX: center.x - extentX - radius,
        minY: center.y - extentY - radius,
        maxX: center.x + extentX + radius,
        maxY: center.y + extentY + radius,
      },
    };
  }

  if (object.kind === BUILTIN_OBJECT_KINDS.diamond) {
    return polygonGeometry([
      localToWorld(transform, { x: width / 2, y: 0 }),
      localToWorld(transform, { x: width, y: height / 2 }),
      localToWorld(transform, { x: width / 2, y: height }),
      localToWorld(transform, { x: 0, y: height / 2 }),
    ], rendererStrokeWidth(object) / 2);
  }

  if (object.kind === BUILTIN_OBJECT_KINDS.frame) {
    return polygonGeometry(
      framePoints(object, transform, width, height),
      rendererStrokeWidth(object, 1.5) / 2,
    );
  }

  const rectangle = rectanglePoints(transform, width, height);
  const outlineRadius = object.kind === BUILTIN_OBJECT_KINDS.rectangle
    ? rendererStrokeWidth(object) / 2
    : object.kind === BUILTIN_OBJECT_KINDS.code
        || object.kind === BUILTIN_OBJECT_KINDS.latex
        || object.kind === BUILTIN_OBJECT_KINDS.image
        ? 0.5
        : 0;
  return polygonGeometry(rectangle, outlineRadius);
}

export function eraserSweepBounds(sweep: EraserSweep): EraserSpatialBounds {
  const radius = Math.max(0, finiteNumber(sweep.radius, 0));
  return {
    minX: Math.min(sweep.start.x, sweep.end.x) - radius,
    minY: Math.min(sweep.start.y, sweep.end.y) - radius,
    maxX: Math.max(sweep.start.x, sweep.end.x) + radius,
    maxY: Math.max(sweep.start.y, sweep.end.y) + radius,
  };
}

function cross(
  first: BoardPoint,
  second: BoardPoint,
  third: BoardPoint,
): number {
  return (second.x - first.x) * (third.y - first.y)
    - (second.y - first.y) * (third.x - first.x);
}

function pointOnSegment(
  point: BoardPoint,
  start: BoardPoint,
  end: BoardPoint,
): boolean {
  if (Math.abs(cross(start, end, point)) > GEOMETRY_EPSILON) return false;
  return point.x >= Math.min(start.x, end.x) - GEOMETRY_EPSILON
    && point.x <= Math.max(start.x, end.x) + GEOMETRY_EPSILON
    && point.y >= Math.min(start.y, end.y) - GEOMETRY_EPSILON
    && point.y <= Math.max(start.y, end.y) + GEOMETRY_EPSILON;
}

function segmentsIntersect(
  firstStart: BoardPoint,
  firstEnd: BoardPoint,
  secondStart: BoardPoint,
  secondEnd: BoardPoint,
): boolean {
  const firstSideStart = cross(firstStart, firstEnd, secondStart);
  const firstSideEnd = cross(firstStart, firstEnd, secondEnd);
  const secondSideStart = cross(secondStart, secondEnd, firstStart);
  const secondSideEnd = cross(secondStart, secondEnd, firstEnd);
  if (
    ((firstSideStart > GEOMETRY_EPSILON && firstSideEnd < -GEOMETRY_EPSILON)
      || (firstSideStart < -GEOMETRY_EPSILON && firstSideEnd > GEOMETRY_EPSILON))
    && ((secondSideStart > GEOMETRY_EPSILON && secondSideEnd < -GEOMETRY_EPSILON)
      || (secondSideStart < -GEOMETRY_EPSILON && secondSideEnd > GEOMETRY_EPSILON))
  ) {
    return true;
  }
  return pointOnSegment(secondStart, firstStart, firstEnd)
    || pointOnSegment(secondEnd, firstStart, firstEnd)
    || pointOnSegment(firstStart, secondStart, secondEnd)
    || pointOnSegment(firstEnd, secondStart, secondEnd);
}

function pointSegmentDistanceSquared(
  point: BoardPoint,
  start: BoardPoint,
  end: BoardPoint,
): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared <= GEOMETRY_EPSILON) {
    return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  }
  const progress = Math.max(0, Math.min(
    1,
    ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY)
      / lengthSquared,
  ));
  const closestX = start.x + deltaX * progress;
  const closestY = start.y + deltaY * progress;
  return (point.x - closestX) ** 2 + (point.y - closestY) ** 2;
}

export function segmentDistanceSquared(
  firstStart: BoardPoint,
  firstEnd: BoardPoint,
  secondStart: BoardPoint,
  secondEnd: BoardPoint,
): number {
  if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) return 0;
  return Math.min(
    pointSegmentDistanceSquared(firstStart, secondStart, secondEnd),
    pointSegmentDistanceSquared(firstEnd, secondStart, secondEnd),
    pointSegmentDistanceSquared(secondStart, firstStart, firstEnd),
    pointSegmentDistanceSquared(secondEnd, firstStart, firstEnd),
  );
}

function pointInPolygon(
  point: BoardPoint,
  polygon: readonly BoardPoint[],
): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (
    let currentIndex = 0, previousIndex = polygon.length - 1;
    currentIndex < polygon.length;
    previousIndex = currentIndex, currentIndex += 1
  ) {
    const current = polygon[currentIndex];
    const previous = polygon[previousIndex];
    if (pointOnSegment(point, previous, current)) return true;
    const crossesRay = (current.y > point.y) !== (previous.y > point.y)
      && point.x < (
        (previous.x - current.x) * (point.y - current.y)
          / (previous.y - current.y)
        + current.x
      );
    if (crossesRay) inside = !inside;
  }
  return inside;
}

function sweepHitsPolygon(
  sweep: EraserSweep,
  polygon: readonly BoardPoint[],
  radius: number,
): boolean {
  if (polygon.length === 0) return false;
  if (polygon.length === 1) {
    return pointSegmentDistanceSquared(
      polygon[0],
      sweep.start,
      sweep.end,
    ) <= radius * radius;
  }
  if (pointInPolygon(sweep.start, polygon) || pointInPolygon(sweep.end, polygon)) {
    return true;
  }
  const radiusSquared = radius * radius;
  const edgeCount = polygon.length === 2 ? 1 : polygon.length;
  for (let index = 0; index < edgeCount; index += 1) {
    const nextIndex = polygon.length === 2 ? 1 : (index + 1) % polygon.length;
    if (
      segmentDistanceSquared(
        sweep.start,
        sweep.end,
        polygon[index],
        polygon[nextIndex],
      ) <= radiusSquared
    ) {
      return true;
    }
  }
  return false;
}

function polylineSegmentRangeHits(
  sweep: EraserSweep,
  points: readonly BoardPoint[],
  radius: number,
  startSegment: number,
  endSegment: number,
): boolean {
  const radiusSquared = radius * radius;
  for (let segment = startSegment; segment < endSegment; segment += 1) {
    if (
      segmentDistanceSquared(
        sweep.start,
        sweep.end,
        points[segment],
        points[segment + 1],
      ) <= radiusSquared
    ) {
      return true;
    }
  }
  return false;
}

function segmentIntersectsExpandedBounds(
  start: BoardPoint,
  end: BoardPoint,
  bounds: EraserSpatialBounds,
  outset: number,
): boolean {
  const minX = bounds.minX - outset;
  const minY = bounds.minY - outset;
  const maxX = bounds.maxX + outset;
  const maxY = bounds.maxY + outset;
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  let enteringProgress = 0;
  let leavingProgress = 1;

  const clipsAxis = (
    coordinate: number,
    delta: number,
    minimum: number,
    maximum: number,
  ): boolean => {
    if (Math.abs(delta) <= GEOMETRY_EPSILON) {
      return coordinate >= minimum - GEOMETRY_EPSILON
        && coordinate <= maximum + GEOMETRY_EPSILON;
    }
    let firstProgress = (minimum - coordinate) / delta;
    let secondProgress = (maximum - coordinate) / delta;
    if (firstProgress > secondProgress) {
      [firstProgress, secondProgress] = [secondProgress, firstProgress];
    }
    enteringProgress = Math.max(enteringProgress, firstProgress);
    leavingProgress = Math.min(leavingProgress, secondProgress);
    return enteringProgress <= leavingProgress + GEOMETRY_EPSILON;
  };

  return clipsAxis(start.x, deltaX, minX, maxX)
    && clipsAxis(start.y, deltaY, minY, maxY);
}

function polylineSweepQueryPartitionCount(sweep: EraserSweep): number {
  const length = Math.hypot(
    sweep.end.x - sweep.start.x,
    sweep.end.y - sweep.start.y,
  );
  const preferredLength = Math.max(
    1,
    sweep.radius * POLYLINE_SWEEP_QUERY_LENGTH_PER_RADIUS,
  );
  const unboundedCount = Math.ceil(length / preferredLength);
  return Math.max(
    1,
    Math.min(
      POLYLINE_SWEEP_MAX_QUERY_PARTITIONS,
      Number.isFinite(unboundedCount)
        ? unboundedCount
        : POLYLINE_SWEEP_MAX_QUERY_PARTITIONS,
    ),
  );
}

function pointAlongSweep(sweep: EraserSweep, progress: number): BoardPoint {
  return {
    x: sweep.start.x * (1 - progress) + sweep.end.x * progress,
    y: sweep.start.y * (1 - progress) + sweep.end.y * progress,
  };
}

function sweepHitsPolyline(
  sweep: EraserSweep,
  geometry: PolylineEraserGeometry,
): boolean {
  const { points } = geometry;
  const radius = sweep.radius + geometry.radius;
  if (points.length === 0) return false;
  if (points.length === 1) {
    return pointSegmentDistanceSquared(
      points[0],
      sweep.start,
      sweep.end,
    ) <= radius * radius;
  }
  if (!geometry.segmentChunks) {
    return polylineSegmentRangeHits(
      sweep,
      points,
      radius,
      0,
      points.length - 1,
    );
  }

  const checkedChunks = new Set<PolylineSegmentChunk>();
  const partitionCount = polylineSweepQueryPartitionCount(sweep);
  for (let partition = 0; partition < partitionCount; partition += 1) {
    const partitionSweep: EraserSweep = {
      start: pointAlongSweep(sweep, partition / partitionCount),
      end: pointAlongSweep(sweep, (partition + 1) / partitionCount),
      radius: sweep.radius,
    };
    for (
      const chunk of geometry.segmentChunks.search(
        eraserSweepBounds(partitionSweep),
      )
    ) {
      if (checkedChunks.has(chunk)) continue;
      checkedChunks.add(chunk);
      if (
        !segmentIntersectsExpandedBounds(
          sweep.start,
          sweep.end,
          chunk,
          sweep.radius,
        )
      ) {
        continue;
      }
      if (
        polylineSegmentRangeHits(
          sweep,
          points,
          radius,
          chunk.startSegment,
          chunk.endSegment,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function ellipseLocalPoint(
  geometry: EllipseEraserGeometry,
  point: BoardPoint,
): BoardPoint {
  const deltaX = point.x - geometry.center.x;
  const deltaY = point.y - geometry.center.y;
  const cosine = Math.cos(geometry.rotation);
  const sine = Math.sin(geometry.rotation);
  return {
    x: deltaX * cosine + deltaY * sine,
    y: -deltaX * sine + deltaY * cosine,
  };
}

function segmentIntersectsEllipseInterior(
  start: BoardPoint,
  end: BoardPoint,
  radiusX: number,
  radiusY: number,
): boolean {
  const startX = start.x / radiusX;
  const startY = start.y / radiusY;
  const deltaX = (end.x - start.x) / radiusX;
  const deltaY = (end.y - start.y) / radiusY;
  const quadratic = deltaX * deltaX + deltaY * deltaY;
  const progress = quadratic === 0
    ? 0
    : Math.max(0, Math.min(
        1,
        -(startX * deltaX + startY * deltaY) / quadratic,
      ));
  return Math.hypot(
    startX + deltaX * progress,
    startY + deltaY * progress,
  ) <= 1;
}

function pointEllipseDistance(
  point: BoardPoint,
  radiusX: number,
  radiusY: number,
): number {
  let majorRadius = radiusX;
  let minorRadius = radiusY;
  let majorCoordinate = Math.abs(point.x);
  let minorCoordinate = Math.abs(point.y);
  if (radiusY > radiusX) {
    majorRadius = radiusY;
    minorRadius = radiusX;
    majorCoordinate = Math.abs(point.y);
    minorCoordinate = Math.abs(point.x);
  }
  const normalizedMajor = majorCoordinate / majorRadius;
  const normalizedMinor = minorCoordinate / minorRadius;
  if (Math.hypot(normalizedMajor, normalizedMinor) <= 1) return 0;
  if (majorCoordinate === 0) return minorCoordinate - minorRadius;
  if (minorCoordinate === 0) return majorCoordinate - majorRadius;

  const inverseKappa = (minorRadius / majorRadius) ** 2;
  const equation = (scaledLambda: number): number => {
    const majorTerm = normalizedMajor
      / (1 + scaledLambda * inverseKappa);
    const minorTerm = normalizedMinor / (1 + scaledLambda);
    return majorTerm * majorTerm + minorTerm * minorTerm - 1;
  };
  let lower = 0;
  let upper = Math.max(
    1,
    normalizedMinor - 1,
    normalizedMajor > 1 && inverseKappa > 0
      ? (normalizedMajor - 1) / inverseKappa
      : 0,
  );
  while (equation(upper) > 0 && Number.isFinite(upper)) upper *= 2;
  for (let iteration = 0; iteration < ELLIPSE_POINT_DISTANCE_ITERATIONS; iteration += 1) {
    const middle = (lower + upper) / 2;
    if (equation(middle) > 0) {
      lower = middle;
    } else {
      upper = middle;
    }
  }
  const scaledLambda = (lower + upper) / 2;
  const closestMajor = majorCoordinate
    / (1 + scaledLambda * inverseKappa);
  const closestMinor = minorCoordinate / (1 + scaledLambda);
  return Math.hypot(
    majorCoordinate - closestMajor,
    minorCoordinate - closestMinor,
  );
}

function sweepHitsEllipse(
  sweep: EraserSweep,
  geometry: EllipseEraserGeometry,
): boolean {
  const start = ellipseLocalPoint(geometry, sweep.start);
  const end = ellipseLocalPoint(geometry, sweep.end);
  if (
    segmentIntersectsEllipseInterior(
      start,
      end,
      geometry.radiusX,
      geometry.radiusY,
    )
  ) {
    return true;
  }

  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const radius = sweep.radius + geometry.radius;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared > 0) {
    const length = Math.sqrt(lengthSquared);
    const normalX = -deltaY / length;
    const normalY = deltaX / length;
    const lineOffset = normalX * start.x + normalY * start.y;
    const supportDistance = Math.hypot(
      geometry.radiusX * normalX,
      geometry.radiusY * normalY,
    );
    if (Math.abs(lineOffset) >= supportDistance && supportDistance > 0) {
      const side = lineOffset < 0 ? -1 : 1;
      const supportX = side * geometry.radiusX
        * (geometry.radiusX * normalX / supportDistance);
      const supportY = side * geometry.radiusY
        * (geometry.radiusY * normalY / supportDistance);
      const progress = (
        (supportX - start.x) * deltaX
        + (supportY - start.y) * deltaY
      ) / lengthSquared;
      if (progress >= 0 && progress <= 1) {
        return Math.abs(lineOffset) - supportDistance <= radius;
      }
    }
  }

  const startDistance = pointEllipseDistance(
    start,
    geometry.radiusX,
    geometry.radiusY,
  );
  if (startDistance <= radius) return true;
  return lengthSquared > 0
    && pointEllipseDistance(
      end,
      geometry.radiusX,
      geometry.radiusY,
    ) <= radius;
}

export function eraserSweepHits(
  geometry: EraserHitGeometry,
  sweep: EraserSweep,
): boolean {
  if (
    !Number.isFinite(sweep.start.x)
    || !Number.isFinite(sweep.start.y)
    || !Number.isFinite(sweep.end.x)
    || !Number.isFinite(sweep.end.y)
    || !Number.isFinite(sweep.radius)
    || sweep.radius < 0
  ) {
    return false;
  }
  if (geometry.kind === "polyline") {
    const radius = sweep.radius + geometry.radius;
    if (sweepHitsPolyline(sweep, geometry)) return true;
    return geometry.filledPolygons.some((polygon) =>
      sweepHitsPolygon(sweep, polygon, radius));
  }
  if (geometry.kind === "polygon") {
    return sweepHitsPolygon(
      sweep,
      geometry.points,
      sweep.radius + geometry.radius,
    );
  }
  return sweepHitsEllipse(sweep, geometry);
}

export class EraserHitIndex {
  private readonly tree = new RBush<EraserSpatialItem>();
  private readonly items = new Map<string, EraserSpatialItem>();

  get size(): number {
    return this.items.size;
  }

  replace(objects: readonly BoardObjectSnapshot[]): void {
    this.tree.clear();
    this.items.clear();
    const items: EraserSpatialItem[] = [];
    for (const object of objects) {
      const item = this.itemForObject(object);
      if (!item) continue;
      items.push(item);
      this.items.set(item.id, item);
    }
    this.tree.load(items);
  }

  set(object: BoardObjectSnapshot): void {
    this.delete(object.id);
    const item = this.itemForObject(object);
    if (!item) return;
    this.items.set(item.id, item);
    this.tree.insert(item);
  }

  delete(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    this.tree.remove(item, (left, right) => left.id === right.id);
    this.items.delete(id);
  }

  search(sweep: EraserSweep): IndexedEraserHitGeometry[] {
    return this.searchBounds(eraserSweepBounds(sweep));
  }

  searchBounds(
    bounds: EraserSpatialBounds,
    broadPhaseFilter?: (candidate: IndexedEraserSpatialBounds) => boolean,
  ): IndexedEraserHitGeometry[] {
    if (!validSpatialBounds(bounds)) return [];
    const matches: IndexedEraserHitGeometry[] = [];
    for (const item of this.tree.search(bounds)) {
      if (broadPhaseFilter && !broadPhaseFilter(item)) continue;
      const geometry = this.geometryForItem(item);
      if (geometry) matches.push({ id: item.id, geometry });
    }
    return matches;
  }

  searchContained(bounds: EraserSpatialBounds): string[] {
    if (!validSpatialBounds(bounds)) return [];
    const matches: string[] = [];
    for (const item of this.tree.search(bounds)) {
      if (spatialBoundsContain(bounds, item)) {
        matches.push(item.id);
        continue;
      }
      const geometry = this.geometryForItem(item);
      if (geometry && spatialBoundsContain(bounds, geometry.bounds)) {
        matches.push(item.id);
      }
    }
    return matches;
  }

  private geometryForItem(
    item: EraserSpatialItem,
  ): EraserHitGeometry | null {
    if (item.geometry === undefined) {
      item.geometry = buildEraserHitGeometry(item.object);
    }
    return item.geometry;
  }

  private itemForObject(object: BoardObjectSnapshot): EraserSpatialItem | null {
    const bounds = broadBoundsForObject(object);
    return bounds ? { id: object.id, object, ...bounds } : null;
  }
}
