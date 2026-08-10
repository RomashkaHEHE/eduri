import RBush from "rbush";
import {
  BUILTIN_OBJECT_KINDS,
  boardLineBounds,
  type AtomicTransform,
  type BoardLineGeometry,
  type BoardLinePoint,
} from "../../../board/core";
import {
  renderedLineGeometry,
  safeRendererTransform,
} from "./objectGeometry";
import type { BoardObjectSnapshot } from "./types";

export interface SpatialBoardItem {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly id: string;
}

function rotatedBounds(transform: AtomicTransform): Omit<SpatialBoardItem, "id"> {
  const [x, y, width, height, rotation] = transform;
  const normalizedWidth = Math.max(Math.abs(width), 1);
  const normalizedHeight = Math.max(Math.abs(height), 1);
  const effectiveWidth = width < 0 ? -normalizedWidth : normalizedWidth;
  const effectiveHeight = height < 0 ? -normalizedHeight : normalizedHeight;
  if (rotation === 0) {
    return {
      minX: Math.min(x, x + effectiveWidth),
      minY: Math.min(y, y + effectiveHeight),
      maxX: Math.max(x, x + effectiveWidth),
      maxY: Math.max(y, y + effectiveHeight),
    };
  }

  const radians = rotation;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const widthX = effectiveWidth * cosine;
  const widthY = effectiveWidth * sine;
  const heightX = -effectiveHeight * sine;
  const heightY = effectiveHeight * cosine;
  const oppositeX = x + widthX + heightX;
  const oppositeY = y + widthY + heightY;
  return {
    minX: Math.min(x, x + widthX, x + heightX, oppositeX),
    minY: Math.min(y, y + widthY, y + heightY, oppositeY),
    maxX: Math.max(x, x + widthX, x + heightX, oppositeX),
    maxY: Math.max(y, y + widthY, y + heightY, oppositeY),
  };
}

function lineBounds(
  object: BoardObjectSnapshot,
  transform: AtomicTransform,
): Omit<SpatialBoardItem, "id"> | null {
  const geometry = renderedLineGeometry(object);
  if (!geometry) return null;
  const cosine = Math.cos(transform[4]);
  const sine = Math.sin(transform[4]);
  const worldPoint = (point: BoardLinePoint): BoardLinePoint => [
    transform[0] + point[0] * cosine - point[1] * sine,
    transform[1] + point[0] * sine + point[1] * cosine,
  ];
  const worldGeometry: BoardLineGeometry = geometry.control
    ? {
        start: worldPoint(geometry.start),
        control: worldPoint(geometry.control),
        end: worldPoint(geometry.end),
      }
    : {
        start: worldPoint(geometry.start),
        end: worldPoint(geometry.end),
      };
  const bounds = boardLineBounds(worldGeometry);
  return Number.isFinite(bounds.minX)
    && Number.isFinite(bounds.minY)
    && Number.isFinite(bounds.maxX)
    && Number.isFinite(bounds.maxY)
    ? bounds
    : null;
}

export function spatialItemForObject(object: BoardObjectSnapshot): SpatialBoardItem {
  const transform = safeRendererTransform(object.transform);
  const bounds = (
    object.kind === BUILTIN_OBJECT_KINDS.line
    || object.kind === BUILTIN_OBJECT_KINDS.arrow
  )
    ? lineBounds(object, transform) ?? rotatedBounds(transform)
    : rotatedBounds(transform);
  return { id: object.id, ...bounds };
}

export class BoardSpatialIndex {
  private readonly tree = new RBush<SpatialBoardItem>();
  private readonly items = new Map<string, SpatialBoardItem>();

  get size(): number {
    return this.items.size;
  }

  set(object: BoardObjectSnapshot): void {
    this.delete(object.id);
    const item = spatialItemForObject(object);
    this.items.set(object.id, item);
    this.tree.insert(item);
  }

  delete(id: string): void {
    const current = this.items.get(id);
    if (!current) return;
    this.tree.remove(current, (left, right) => left.id === right.id);
    this.items.delete(id);
  }

  replace(objects: readonly BoardObjectSnapshot[]): void {
    this.tree.clear();
    this.items.clear();
    const items = objects.map(spatialItemForObject);
    for (const item of items) this.items.set(item.id, item);
    this.tree.load(items);
  }

  search(bounds: Omit<SpatialBoardItem, "id">): string[] {
    return this.tree.search(bounds).map((item) => item.id);
  }

  allBounds(): Omit<SpatialBoardItem, "id"> | null {
    if (this.items.size === 0) return null;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const item of this.items.values()) {
      if (item.minX < minX) minX = item.minX;
      if (item.minY < minY) minY = item.minY;
      if (item.maxX > maxX) maxX = item.maxX;
      if (item.maxY > maxY) maxY = item.maxY;
    }
    return {
      minX,
      minY,
      maxX,
      maxY,
    };
  }
}
