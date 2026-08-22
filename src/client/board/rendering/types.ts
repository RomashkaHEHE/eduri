import type {
  AtomicTransform,
  BoardLineObjectGeometry,
  BoardObjectKind,
} from "../../../board/core";

export type BoardShapeKind =
  | "rectangle"
  | "ellipse"
  | "diamond"
  | "frame";

export type BoardTool =
  | "select"
  | "hand"
  | "pen"
  | "highlighter"
  | "eraser"
  | "text"
  | "line"
  | "arrow"
  | "shape"
  | "code"
  | "latex"
  | "image";

export type BoardPlacementTool = "code" | "latex" | "image";

export type BoardModifierHintAction =
  | "select-add"
  | "select-area"
  | "select-lasso"
  | "marquee-intersection"
  | "selection-area-move"
  | "pen-laser"
  | "pen-move"
  | "pen-straight"
  | "eraser-restore"
  | "rotation-snap"
  | "line-edit-points"
  | "line-delete-point";

export interface BoardPoint {
  readonly x: number;
  readonly y: number;
}

export type BoardGesturePreviewTool =
  | "pen"
  | "highlighter"
  | "line"
  | "arrow"
  | BoardShapeKind;

export interface BoardGesturePreviewStyle {
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly opacity: number;
}

export interface BoardGesturePreview {
  readonly kind: BoardGesturePreviewTool;
  readonly points: readonly BoardPoint[];
  readonly style?: BoardGesturePreviewStyle;
  readonly streamId?: string;
  readonly pointOffset?: number;
  readonly offset?: BoardPoint;
  readonly committedObjectId?: string;
}

// These cap one rolling awareness packet, not the complete remote gesture.
export const MAX_BOARD_GESTURE_PREVIEW_POINTS = 256;
export const MAX_BOARD_LASER_STROKES = 16;
export const MAX_BOARD_LASER_POINTS = 160;
export const MAX_BOARD_ACCUMULATED_PREVIEW_POINTS = 131_072;
export const MAX_BOARD_ACCUMULATED_LASER_STROKES = 1_024;

export interface BoardLaserStroke {
  readonly points: readonly BoardPoint[];
  readonly style?: BoardGesturePreviewStyle;
  readonly streamId?: string;
  readonly pointOffset?: number;
}

export interface BoardLaserPreview {
  readonly strokes: readonly BoardLaserStroke[];
  readonly sessionId?: string;
}

export type BoardLaserClearMode = "fade" | "immediate";

const MAX_GESTURE_PREVIEW_COLOR_CODE_UNITS = 64;
const MIN_GESTURE_PREVIEW_STROKE_WIDTH = 0.5;
const MAX_GESTURE_PREVIEW_STROKE_WIDTH = 96;
const MIN_GESTURE_PREVIEW_OPACITY = 0;
const MAX_GESTURE_PREVIEW_OPACITY = 1;
const GESTURE_PREVIEW_HEX_COLOR =
  /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const GESTURE_PREVIEW_RGB_COLOR =
  /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/iu;
const GESTURE_PREVIEW_RGBA_COLOR =
  /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*([0-9]*\.?[0-9]+)\s*\)$/iu;

function gesturePreviewColor(value: unknown): string | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_GESTURE_PREVIEW_COLOR_CODE_UNITS
  ) {
    return null;
  }
  if (GESTURE_PREVIEW_HEX_COLOR.test(value)) return value;

  const rgb = GESTURE_PREVIEW_RGB_COLOR.exec(value);
  if (rgb) {
    const channels = rgb.slice(1).map(Number);
    return channels.every((channel) => channel <= 255)
      ? `rgb(${channels.join(",")})`
      : null;
  }

  const rgba = GESTURE_PREVIEW_RGBA_COLOR.exec(value);
  if (rgba) {
    const channels = rgba.slice(1, 4).map(Number);
    const alpha = Number(rgba[4]);
    if (channels.every((channel) => channel <= 255) && alpha <= 1) {
      return `rgba(${channels.join(",")},${alpha})`;
    }
  }
  return null;
}

export function sanitizeBoardGesturePreviewStyle(
  value: unknown,
): BoardGesturePreviewStyle | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const stroke = gesturePreviewColor(candidate.stroke);
  if (
    stroke === null
    || typeof candidate.strokeWidth !== "number"
    || !Number.isFinite(candidate.strokeWidth)
    || typeof candidate.opacity !== "number"
    || !Number.isFinite(candidate.opacity)
  ) {
    return undefined;
  }
  return {
    stroke,
    strokeWidth: Math.max(
      MIN_GESTURE_PREVIEW_STROKE_WIDTH,
      Math.min(MAX_GESTURE_PREVIEW_STROKE_WIDTH, candidate.strokeWidth),
    ),
    opacity: Math.max(
      MIN_GESTURE_PREVIEW_OPACITY,
      Math.min(MAX_GESTURE_PREVIEW_OPACITY, candidate.opacity),
    ),
  };
}

function finiteLaserPoint(value: unknown): BoardPoint | undefined {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.x === "number"
    && Number.isFinite(candidate.x)
    && typeof candidate.y === "number"
    && Number.isFinite(candidate.y)
    ? { x: candidate.x, y: candidate.y }
    : undefined;
}

export function sanitizeBoardLaserPreview(
  value: unknown,
): BoardLaserPreview | undefined {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || !("strokes" in value)
    || !Array.isArray(value.strokes)
  ) {
    return undefined;
  }

  const strokes: BoardLaserStroke[] = [];
  let remainingPoints = MAX_BOARD_LASER_POINTS;
  for (
    let index = value.strokes.length - 1;
    index >= 0
      && strokes.length < MAX_BOARD_LASER_STROKES
      && remainingPoints > 0;
    index -= 1
  ) {
    const rawStroke = value.strokes[index];
    if (
      rawStroke === null
      || typeof rawStroke !== "object"
      || Array.isArray(rawStroke)
      || !("points" in rawStroke)
      || !Array.isArray(rawStroke.points)
    ) {
      continue;
    }

    const points: BoardPoint[] = [];
    for (
      let pointIndex = rawStroke.points.length - 1;
      pointIndex >= 0 && points.length < remainingPoints;
      pointIndex -= 1
    ) {
      const point = finiteLaserPoint(rawStroke.points[pointIndex]);
      if (point) points.unshift(point);
    }
    if (points.length === 0) continue;

    const style = "style" in rawStroke
      ? sanitizeBoardGesturePreviewStyle(rawStroke.style)
      : undefined;
    strokes.unshift({
      points,
      ...(style ? { style } : {}),
      ...(typeof rawStroke.streamId === "string" && rawStroke.streamId.length <= 96
        ? { streamId: rawStroke.streamId }
        : {}),
      ...(Number.isSafeInteger(rawStroke.pointOffset) && rawStroke.pointOffset >= 0
        ? { pointOffset: rawStroke.pointOffset as number }
        : {}),
    });
    remainingPoints -= points.length;
  }
  const valueRecord = value as Record<string, unknown>;
  return strokes.length > 0
    ? {
        strokes,
        ...(typeof valueRecord.sessionId === "string" && valueRecord.sessionId.length <= 96
          ? { sessionId: valueRecord.sessionId }
          : {}),
      }
    : undefined;
}

export interface BoardCamera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export type BoardTheme = "light" | "dark";

export type BoardObjectRenderStatus =
  | "supported"
  | "unknown-kind"
  | "unsupported-version"
  | "malformed";

export interface BoardObjectRenderingEnvelope {
  readonly status: BoardObjectRenderStatus;
  readonly detail?: string;
}

export interface BoardObjectSnapshot {
  readonly id: string;
  readonly kind: BoardObjectKind;
  readonly version: number;
  readonly transform: AtomicTransform;
  readonly zRank: string;
  readonly parentId: string | null;
  readonly style: Readonly<Record<string, unknown>>;
  readonly props: Readonly<Record<string, unknown>>;
  readonly rendering?: BoardObjectRenderingEnvelope;
}

export interface BoardPresence {
  readonly clientId: number;
  readonly userId: string;
  readonly displayName: string;
  readonly color: string;
  readonly cursor?: BoardPoint;
  readonly viewport?: BoardCamera;
  readonly selectionIds: readonly string[];
  readonly activeTool?: BoardTool;
  readonly gesturePreview?: BoardGesturePreview;
  readonly laser?: BoardLaserPreview;
  readonly laserClearMode?: BoardLaserClearMode;
}

export interface BoardObjectDraft {
  readonly kind: BoardObjectKind;
  readonly transform: AtomicTransform;
  readonly style?: Readonly<Record<string, unknown>>;
  readonly props?: Readonly<Record<string, unknown>>;
}

export interface BoardContextMenuRequest {
  readonly screen: BoardPoint;
  readonly world: BoardPoint;
  readonly objectId: string | null;
}

export interface BoardRendererCallbacks {
  onCameraChange(camera: BoardCamera): void;
  onCursorChange(point: BoardPoint | null): void;
  onSelectionChange(ids: readonly string[]): void;
  onContextMenu(request: BoardContextMenuRequest): void;
  onCreateObject(draft: BoardObjectDraft): string | null | void;
  onPlaceTool(tool: BoardPlacementTool, point: BoardPoint): void;
  onDeleteObjects(ids: readonly string[]): void;
  onTransformStart(): void;
  onTransformCancel(): void;
  onTransformObjects(transforms: ReadonlyMap<string, AtomicTransform>): void;
  onEditLineGeometry?(id: string, geometry: BoardLineObjectGeometry): void;
  onEditObject(id: string): void;
  onLaserChange(
    preview: BoardLaserPreview | null,
    clearMode?: BoardLaserClearMode,
  ): void;
  onPenLaserModeChange?(active: boolean): void;
  onGesturePreviewChange?(preview: BoardGesturePreview | null): void;
  onModifierHintsChange?(actions: readonly BoardModifierHintAction[]): void;
}

export interface BoardRenderer {
  readonly element: HTMLDivElement;
  readonly camera: BoardCamera;
  readonly selection: readonly string[];
  setTool(tool: BoardTool): void;
  setShapeKind(kind: BoardShapeKind): void;
  setCreationStyle(style: Readonly<Record<string, unknown>>): void;
  setReadOnly(readOnly: boolean): void;
  setObjects(objects: readonly BoardObjectSnapshot[]): void;
  setObject(object: BoardObjectSnapshot): void;
  deleteObject(id: string): void;
  setPresence(presence: readonly BoardPresence[]): void;
  setSelection(ids: readonly string[]): void;
  setInlineEditingObject(id: string | null): void;
  enterLinePointEditing?(): boolean;
  deleteSelectedLinePoint?(): boolean;
  exitLinePointEditing?(): boolean;
  setTheme(theme: BoardTheme): void;
  setGridVisible(visible: boolean): void;
  setCamera(camera: BoardCamera): void;
  fitToContent(): void;
  cancelInteraction(): void;
  resize(): void;
  destroy(): void;
}

export interface BoardRendererFactory {
  create(
    element: HTMLDivElement,
    callbacks: BoardRendererCallbacks,
    options?: {
      readOnly?: boolean;
      theme?: BoardTheme;
      gridVisible?: boolean;
      resolveAssetUrl?: (
        assetId: string,
        contentHash: string | null,
      ) => string | null | Promise<string | null>;
    },
  ): BoardRenderer;
}
