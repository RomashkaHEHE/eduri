import RBush from "rbush";
import {
  eraserSweepHits,
  type EraserHitGeometry,
  type EraserSpatialBounds,
} from "./eraserGeometry";
import type { BoardPoint } from "./types";

const GEOMETRY_EPSILON = 1e-9;

interface LassoEdge extends EraserSpatialBounds {
  readonly start: BoardPoint;
  readonly end: BoardPoint;
}

function finitePoint(point: BoardPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function samePoint(left: BoardPoint, right: BoardPoint): boolean {
  return left.x === right.x && left.y === right.y;
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
  if (Math.abs(cross(start, end, point)) > GEOMETRY_EPSILON) {
    return false;
  }
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

function edgeForPoints(start: BoardPoint, end: BoardPoint): LassoEdge {
  return {
    start,
    end,
    minX: Math.min(start.x, end.x),
    minY: Math.min(start.y, end.y),
    maxX: Math.max(start.x, end.x),
    maxY: Math.max(start.y, end.y),
  };
}

function representativePoints(
  geometry: EraserHitGeometry,
): readonly BoardPoint[] {
  if (geometry.kind === "ellipse") return [geometry.center];
  if (geometry.kind === "polygon") {
    return geometry.points.length > 0 ? [geometry.points[0]] : [];
  }
  const points: BoardPoint[] = [];
  if (geometry.points.length > 0) points.push(geometry.points[0]);
  for (const polygon of geometry.filledPolygons) {
    if (polygon.length > 0) points.push(polygon[0]);
  }
  return points;
}

function pointInsideBounds(
  point: BoardPoint,
  bounds: EraserSpatialBounds,
): boolean {
  return point.x >= bounds.minX - GEOMETRY_EPSILON
    && point.x <= bounds.maxX + GEOMETRY_EPSILON
    && point.y >= bounds.minY - GEOMETRY_EPSILON
    && point.y <= bounds.maxY + GEOMETRY_EPSILON;
}

export function selectionRectangleTouchesGeometry(
  bounds: EraserSpatialBounds,
  geometry: EraserHitGeometry,
): boolean {
  if (
    !Number.isFinite(bounds.minX)
    || !Number.isFinite(bounds.minY)
    || !Number.isFinite(bounds.maxX)
    || !Number.isFinite(bounds.maxY)
    || bounds.minX > bounds.maxX
    || bounds.minY > bounds.maxY
    || geometry.bounds.maxX < bounds.minX
    || geometry.bounds.minX > bounds.maxX
    || geometry.bounds.maxY < bounds.minY
    || geometry.bounds.minY > bounds.maxY
  ) {
    return false;
  }
  if (representativePoints(geometry).some((point) =>
    pointInsideBounds(point, bounds))) {
    return true;
  }

  const topLeft = { x: bounds.minX, y: bounds.minY };
  const topRight = { x: bounds.maxX, y: bounds.minY };
  const bottomRight = { x: bounds.maxX, y: bounds.maxY };
  const bottomLeft = { x: bounds.minX, y: bounds.maxY };
  return eraserSweepHits(geometry, {
    start: topLeft,
    end: topRight,
    radius: 0,
  }) || eraserSweepHits(geometry, {
    start: topRight,
    end: bottomRight,
    radius: 0,
  }) || eraserSweepHits(geometry, {
    start: bottomRight,
    end: bottomLeft,
    radius: 0,
  }) || eraserSweepHits(geometry, {
    start: bottomLeft,
    end: topLeft,
    radius: 0,
  });
}

export function selectionBoundsFromPoints(
  points: readonly BoardPoint[],
): EraserSpatialBounds | null {
  const first = points.find(finitePoint);
  if (!first) return null;
  let minX = first.x;
  let minY = first.y;
  let maxX = first.x;
  let maxY = first.y;
  for (const point of points) {
    if (!finitePoint(point)) continue;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}

function simplifyOpenPolyline(
  points: readonly BoardPoint[],
  tolerance: number,
): BoardPoint[] {
  if (points.length <= 2) return [...points];
  const retained = new Uint8Array(points.length);
  retained[0] = 1;
  retained[points.length - 1] = 1;
  const stack: number[] = [0, points.length - 1];
  const toleranceSquared = tolerance * tolerance;

  while (stack.length > 0) {
    const endIndex = stack.pop()!;
    const startIndex = stack.pop()!;
    const middleIndex = (startIndex + endIndex) / 2;
    let furthestIndex = -1;
    let furthestDistanceSquared = toleranceSquared;
    let furthestMiddleOffset = Number.POSITIVE_INFINITY;
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distanceSquared = pointSegmentDistanceSquared(
        points[index],
        points[startIndex],
        points[endIndex],
      );
      const middleOffset = Math.abs(index - middleIndex);
      if (
        distanceSquared > furthestDistanceSquared + GEOMETRY_EPSILON
        || (
          distanceSquared > toleranceSquared
          && Math.abs(distanceSquared - furthestDistanceSquared)
            <= GEOMETRY_EPSILON
          && middleOffset < furthestMiddleOffset
        )
      ) {
        furthestDistanceSquared = distanceSquared;
        furthestIndex = index;
        furthestMiddleOffset = middleOffset;
      }
    }
    if (furthestIndex < 0) continue;
    retained[furthestIndex] = 1;
    stack.push(startIndex, furthestIndex, furthestIndex, endIndex);
  }

  return points.filter((_point, index) => retained[index] === 1);
}

export function compactLassoPoints(
  points: readonly BoardPoint[],
  maximumPoints: number,
  initialTolerance: number,
): BoardPoint[] {
  const finitePoints = points.filter(finitePoint);
  const target = Math.max(2, Math.floor(maximumPoints));
  if (finitePoints.length <= target) return [...finitePoints];

  const bounds = selectionBoundsFromPoints(finitePoints);
  const diagonal = bounds
    ? Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
    : 0;
  let tolerance = Math.max(
    Number.EPSILON,
    Number.isFinite(initialTolerance) ? initialTolerance : 0,
  );
  let compacted = simplifyOpenPolyline(finitePoints, tolerance);
  while (compacted.length > target) {
    tolerance = Math.min(
      Math.max(tolerance * 2, Number.EPSILON),
      Math.max(diagonal, Number.EPSILON),
    );
    compacted = simplifyOpenPolyline(finitePoints, tolerance);
    if (tolerance >= diagonal) break;
  }
  return compacted.length <= target
    ? compacted
    : [finitePoints[0], finitePoints[finitePoints.length - 1]];
}

export class LassoSelectionRegion {
  readonly points: readonly BoardPoint[];
  readonly bounds: EraserSpatialBounds | null;
  readonly hasArea: boolean;
  private readonly edges = new RBush<LassoEdge>();

  constructor(points: readonly BoardPoint[]) {
    const normalized: BoardPoint[] = [];
    for (const point of points) {
      if (!finitePoint(point)) continue;
      if (!normalized.at(-1) || !samePoint(normalized.at(-1)!, point)) {
        normalized.push({ x: point.x, y: point.y });
      }
    }
    if (
      normalized.length > 1
      && samePoint(normalized[0], normalized[normalized.length - 1])
    ) {
      normalized.pop();
    }
    this.points = normalized;
    this.bounds = selectionBoundsFromPoints(normalized);
    this.hasArea = this.findNonCollinearTriple();

    const edges: LassoEdge[] = [];
    if (normalized.length > 1) {
      for (let index = 0; index < normalized.length; index += 1) {
        const next = (index + 1) % normalized.length;
        edges.push(edgeForPoints(normalized[index], normalized[next]));
      }
    }
    this.edges.load(edges);
  }

  containsPoint(point: BoardPoint): boolean {
    if (!finitePoint(point) || !this.bounds || !this.hasArea) return false;
    if (
      point.x < this.bounds.minX - GEOMETRY_EPSILON
      || point.x > this.bounds.maxX + GEOMETRY_EPSILON
      || point.y < this.bounds.minY - GEOMETRY_EPSILON
      || point.y > this.bounds.maxY + GEOMETRY_EPSILON
    ) {
      return false;
    }

    const touching = this.edges.search({
      minX: point.x - GEOMETRY_EPSILON,
      minY: point.y - GEOMETRY_EPSILON,
      maxX: point.x + GEOMETRY_EPSILON,
      maxY: point.y + GEOMETRY_EPSILON,
    });
    if (touching.some((edge) =>
      pointOnSegment(point, edge.start, edge.end))) {
      return true;
    }

    let inside = false;
    for (const edge of this.edges.search({
      minX: point.x,
      minY: point.y,
      maxX: this.bounds.maxX,
      maxY: point.y,
    })) {
      const crossesRay = (edge.start.y > point.y) !== (edge.end.y > point.y);
      if (!crossesRay) continue;
      const intersectionX = (
        (edge.end.x - edge.start.x) * (point.y - edge.start.y)
          / (edge.end.y - edge.start.y)
        + edge.start.x
      );
      if (point.x < intersectionX) inside = !inside;
    }
    return inside;
  }

  touchesBounds(bounds: EraserSpatialBounds): boolean {
    if (
      !this.bounds
      || !this.hasArea
      || !Number.isFinite(bounds.minX)
      || !Number.isFinite(bounds.minY)
      || !Number.isFinite(bounds.maxX)
      || !Number.isFinite(bounds.maxY)
      || bounds.minX > bounds.maxX
      || bounds.minY > bounds.maxY
      || bounds.maxX < this.bounds.minX
      || bounds.minX > this.bounds.maxX
      || bounds.maxY < this.bounds.minY
      || bounds.minY > this.bounds.maxY
    ) {
      return false;
    }
    const corners = [
      { x: bounds.minX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.maxY },
      { x: bounds.minX, y: bounds.maxY },
    ];
    if (corners.some((corner) => this.containsPoint(corner))) return true;
    if (this.points.some((point) =>
      point.x >= bounds.minX - GEOMETRY_EPSILON
      && point.x <= bounds.maxX + GEOMETRY_EPSILON
      && point.y >= bounds.minY - GEOMETRY_EPSILON
      && point.y <= bounds.maxY + GEOMETRY_EPSILON)) {
      return true;
    }
    const rectangleEdges = corners.map((corner, index) => ({
      start: corner,
      end: corners[(index + 1) % corners.length],
    }));
    return this.edges.search(bounds).some((lassoEdge) =>
      rectangleEdges.some((rectangleEdge) =>
        segmentsIntersect(
          lassoEdge.start,
          lassoEdge.end,
          rectangleEdge.start,
          rectangleEdge.end,
        )));
  }

  touchesGeometry(geometry: EraserHitGeometry): boolean {
    if (!this.bounds || !this.hasArea) return false;
    if (representativePoints(geometry).some((point) =>
      this.containsPoint(point))) {
      return true;
    }
    for (const edge of this.edges.search(geometry.bounds)) {
      if (eraserSweepHits(geometry, {
        start: edge.start,
        end: edge.end,
        radius: 0,
      })) {
        return true;
      }
    }
    return false;
  }

  private findNonCollinearTriple(): boolean {
    if (this.points.length < 3) return false;
    const first = this.points[0];
    let secondIndex = 1;
    while (
      secondIndex < this.points.length
      && samePoint(first, this.points[secondIndex])
    ) {
      secondIndex += 1;
    }
    if (secondIndex >= this.points.length) return false;
    const second = this.points[secondIndex];
    for (let index = secondIndex + 1; index < this.points.length; index += 1) {
      if (Math.abs(cross(first, second, this.points[index])) > GEOMETRY_EPSILON) {
        return true;
      }
    }
    return false;
  }
}
