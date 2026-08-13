import Konva from "konva";
import { clampBoardZoom } from "../boardZoom";
import {
  BUILTIN_OBJECT_KINDS,
  compareBoardObjectZOrder,
  createBoardLineObjectGeometry,
  type AtomicTransform,
  type BoardLinePoint,
} from "../../../board/core";
import {
  RENDERED_FRAME_LABEL_HEIGHT,
  renderedFrameLabelWidth,
  renderedLinePath,
  renderedStrokePoints,
  safeRendererTransform,
} from "./objectGeometry";
import {
  EraserHitIndex,
  eraserSweepHits,
  type EraserSweep,
} from "./eraserGeometry";
import {
  advanceEraserTrailSamples,
  appendEraserTrailSample,
  buildEraserTrailProfile,
  createEraserTrailAnimationState,
  ERASER_TRAIL_OPACITY,
  type EraserTrailAnimationState,
  type EraserTrailRenderStation,
  type EraserTrailSample,
} from "./eraserTrail";
import {
  inspectBoardObjectRendering,
  isBoardObjectInlineEditable,
  isBoardObjectMutable,
} from "./pluginRegistry";
import {
  compactLassoPoints,
  LassoSelectionRegion,
  selectionRectangleTouchesGeometry,
} from "./selectionGeometry";
import { BoardSpatialIndex, spatialItemForObject } from "./spatialIndex";
import { defaultBoardToolStyle } from "./toolStyles";
import type {
  BoardCamera,
  BoardGesturePreview,
  BoardGesturePreviewStyle,
  BoardGesturePreviewTool,
  BoardLaserPreview,
  BoardLaserStroke,
  BoardObjectDraft,
  BoardObjectSnapshot,
  BoardPlacementTool,
  BoardPoint,
  BoardPresence,
  BoardRenderer,
  BoardRendererCallbacks,
  BoardRendererFactory,
  BoardShapeKind,
  BoardTheme,
  BoardTool,
} from "./types";
import {
  MAX_BOARD_GESTURE_PREVIEW_POINTS,
  MAX_BOARD_LASER_POINTS,
  MAX_BOARD_LASER_STROKES,
  sanitizeBoardGesturePreviewStyle,
  sanitizeBoardLaserPreview,
} from "./types";

const WHEEL_ZOOM_SENSITIVITY = 0.001;
const MAX_WHEEL_ZOOM_DELTA_PX = 100;
const WHEEL_LINE_DELTA_PX = 16;
const WHEEL_DELTA_MODE_LINE = 1;
const WHEEL_DELTA_MODE_PAGE = 2;
const VIEWPORT_OVERSCAN_PX = 480;
const CURSOR_INTERPOLATION_MS = 72;
const LASER_FADE_MS = 800;
const LASER_GLOW_PX = 8;
const MAX_TRANSFORMER_NODES = 256;
export const MAX_LOCAL_SELECTION_OUTLINES = 512;
const ERASER_HIT_DIAMETER_PX = 24;
const ERASER_RADIUS_PX = ERASER_HIT_DIAMETER_PX / 2;
const ERASER_HIT_OUTLINE_OPACITY = 0.12;
const MAX_SYNTHETIC_POINTER_BATCH_SPAN_MS = 4;
const ERASER_MARKED_OPACITY_FACTOR = 0.24;
const ERASER_BROAD_PHASE_SEGMENT_PX = 64;
const MAX_ERASER_BROAD_PHASE_SEGMENTS = 128;
const MARQUEE_THRESHOLD_PX = 3;
const PLACEMENT_CLICK_TOLERANCE_PX = 8;
const LASSO_POINT_DISTANCE_PX = 1.5;
const MAX_LASSO_POINTS = 2_048;
const FREEHAND_POINT_DISTANCE_PX = 0.5;
const GROUP_SELECTION_DASH_PX = [7, 5] as const;
const TRANSFORMER_ANCHOR_SIZE_PX = 9;
const TRANSFORMER_STROKE_WIDTH_PX = 1.5;
const TRANSFORMER_PADDING_PX = 4;
const TRANSFORMER_ROTATION_SNAPS_DEGREES = [
  0,
  45,
  90,
  135,
  180,
  225,
  270,
  315,
];
// Konva compares with a strict inequality, so include exact 22.5-degree ties.
const TRANSFORMER_ROTATION_SNAP_TOLERANCE_DEGREES = 22.500001;
const TRANSFORMER_FREE_ROTATION_SNAPS: number[] = [];
const DEFAULT_STROKE = "#17212b";
const DEFAULT_ACCENT = "#315efb";
const DEFAULT_FILL = "rgba(255,255,255,0)";
const DARK_DEFAULT_STROKE = "#e7edf5";

interface BoardThemePalette {
  readonly background: string;
  readonly minorGrid: string;
  readonly majorGrid: string;
  readonly accent: string;
  readonly transformerAnchor: string;
  readonly placeholderFill: string;
  readonly placeholderStroke: string;
  readonly placeholderText: string;
  readonly surfaceFill: string;
  readonly surfaceStroke: string;
  readonly eraserTrail: string;
}

const BOARD_THEME_PALETTES: Readonly<Record<BoardTheme, BoardThemePalette>> = {
  light: {
    background: "#f8fafc",
    minorGrid: "#e8edf2",
    majorGrid: "#dce3ea",
    accent: DEFAULT_ACCENT,
    transformerAnchor: "#ffffff",
    placeholderFill: "#f4f6f8",
    placeholderStroke: "#8f9baa",
    placeholderText: "#536171",
    surfaceFill: "#ffffff",
    surfaceStroke: "#ccd5df",
    eraserTrail: "#66717f",
  },
  dark: {
    background: "#151614",
    minorGrid: "#242522",
    majorGrid: "#353632",
    accent: "#86a7e8",
    transformerAnchor: "#151614",
    placeholderFill: "#20211f",
    placeholderStroke: "#6f706b",
    placeholderText: "#c4c5c1",
    surfaceFill: "#1c1d1b",
    surfaceStroke: "#454642",
    eraserTrail: "#cbcbc7",
  },
};
// Renderer-only bounds stay well above the UI presets while capping synchronous
// Canvas2D parsing/layout. Sanitized values are never written back to the CRDT.
const MAX_RENDER_DASH_SEGMENTS = 8;
const MAX_RENDER_DASH_SEGMENT = 256;
const MAX_RENDER_FONT_SIZE = 256;
const MAX_RENDER_COLOR_CODE_UNITS = 64;
const MAX_RENDER_FONT_FAMILY_CODE_UNITS = 256;
const MAX_RENDER_FONT_FAMILIES = 8;
const MAX_RENDER_TEXT_CODE_UNITS = 4_096;
const MAX_RENDER_METADATA_CODE_UNITS = 128;

// These are soft limits for decoded surfaces retained across viewport culling.
// Visible images hold references and may temporarily exceed them; they are
// evicted as soon as they leave the viewport instead of blanking a live node.
export const MAX_DECODED_IMAGE_CACHE_ENTRIES = 32;
export const MAX_DECODED_IMAGE_CACHE_PIXELS = 24_000_000;

interface DrawingGesture {
  readonly kind: "drawing";
  readonly pointerId: number;
  readonly pointerType: string;
  readonly tool: BoardGesturePreviewTool | "text";
  readonly style: Readonly<Record<string, unknown>>;
  readonly start: BoardPoint;
  points: Array<BoardPoint & { pressure: number }>;
  previewAwarenessPoints: BoardPoint[];
  previewPoints: number[];
  preview: Konva.Shape;
  previousScreen: BoardPoint;
  strokeOffset: BoardPoint;
  straightPointActive: boolean;
  strokeMoveActive: boolean;
  readonly connectorCurvature: number;
  readonly fixedConnectorControl: BoardPoint | null;
}

interface LaserGesture {
  readonly kind: "laser";
  readonly pointerId: number;
  readonly pointerType: string;
  readonly session: LaserSession;
  readonly stroke: LocalLaserStroke;
}

interface LocalLaserStroke {
  points: BoardPoint[];
  previewPoints: number[];
  readonly style: BoardGesturePreviewStyle;
  readonly preview: Konva.Line;
}

interface LaserSession {
  readonly group: Konva.Group;
  readonly strokes: LocalLaserStroke[];
  releaseRequested: boolean;
}

interface PanGesture {
  readonly kind: "pan";
  readonly pointerId: number;
  readonly pointerType: string;
  readonly screen: BoardPoint;
  readonly camera: BoardCamera;
}

interface PlacementGesture {
  readonly kind: "placement";
  readonly pointerId: number;
  readonly pointerType: string;
  readonly tool: BoardPlacementTool;
  readonly point: BoardPoint;
  readonly startScreen: BoardPoint;
  maximumTravelPx: number;
}

interface PinchGesture {
  readonly kind: "pinch";
  readonly pointerIds: readonly [number, number];
  readonly distance: number;
  readonly center: BoardPoint;
  readonly camera: BoardCamera;
}

interface EraserGesture {
  readonly kind: "eraser";
  readonly pointerId: number;
  readonly pointerType: string;
  readonly objectIds: Set<string>;
  readonly trail: Konva.Group;
  readonly trailBody: Konva.Shape;
  readonly trailFootprint: Konva.Circle;
  readonly trailSamples: EraserTrailSample[];
  readonly trailAnimationState: EraserTrailAnimationState;
  trailAnimationFrame: number | null;
  previousScreen: BoardPoint;
  previousWorld: BoardPoint;
}

type EraserMode = "mark" | "restore";

interface SelectionGestureBase {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly startScreen: BoardPoint;
  readonly baseSelection: readonly string[];
  readonly additive: boolean;
  previousScreen: BoardPoint;
  offset: BoardPoint;
  commandMoveArmed: boolean;
  commandMoveActive: boolean;
  previewSelectionIds: string[];
  previewSelectionIdSet: Set<string>;
  membershipAnimationFrame: number | null;
}

interface MarqueeGesture extends SelectionGestureBase {
  readonly kind: "marquee";
  readonly start: BoardPoint;
  end: BoardPoint;
  touchSelection: boolean;
  readonly preview: Konva.Rect;
}

interface LassoGesture extends SelectionGestureBase {
  readonly kind: "lasso";
  points: BoardPoint[];
  previewPoints: number[];
  sampleDistancePx: number;
  readonly preview: Konva.Line;
}

type SelectionGesture = MarqueeGesture | LassoGesture;

type ActiveGesture =
  | DrawingGesture
  | LaserGesture
  | PanGesture
  | PlacementGesture
  | PinchGesture
  | EraserGesture
  | SelectionGesture;

interface CursorMotion {
  readonly from: BoardPoint;
  readonly target: BoardPoint;
  readonly startedAt: number;
}

interface RemoteLaserTrail {
  readonly strokes: BoardLaserStroke[];
  expiresAt: number;
  active: boolean;
}

interface RendererOptions {
  readOnly?: boolean;
  theme?: BoardTheme;
  gridVisible?: boolean;
  resolveAssetUrl?: (
    assetId: string,
    contentHash: string | null,
  ) => string | null | Promise<string | null>;
}

interface ViewportBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

interface SelectionObjectOutlineGeometry {
  readonly node: Konva.Group;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

interface PresenceRenderEntry {
  cursor: Konva.Group | null;
  cursorArrow: Konva.Line | null;
  cursorLabel: Konva.Label | null;
  cursorTag: Konva.Tag | null;
  cursorText: Konva.Text | null;
  gesturePreview: Konva.Shape | null;
  gestureKind: BoardGesturePreview["kind"] | null;
  gestureColor: string | null;
  gesturePoints: readonly BoardPoint[] | null;
  gestureStyle: BoardGesturePreviewStyle | null;
  laser: Konva.Group | null;
  readonly selections: Map<string, Konva.Rect>;
}

interface DecodedImageListener {
  readonly onReady: (image: HTMLImageElement) => void;
  readonly onError: () => void;
}

interface DecodedImageCacheEntry {
  readonly key: string;
  readonly assetId: string;
  readonly contentHash: string | null;
  readonly listeners: Set<DecodedImageListener>;
  state: "resolving" | "loading" | "ready" | "unavailable" | "failed";
  image: HTMLImageElement | null;
  pixels: number;
  references: number;
  lastUsed: number;
  active: boolean;
}

interface DecodedImageSource {
  acquire(
    assetId: string,
    contentHash: string | null,
    listener: DecodedImageListener,
  ): () => void;
}

function decodedImageCacheKey(assetId: string, contentHash: string | null): string {
  return JSON.stringify([assetId, contentHash]);
}

function decodedImagePixels(image: HTMLImageElement): number {
  const width = Number.isFinite(image.naturalWidth)
    ? Math.max(1, Math.floor(image.naturalWidth))
    : 1;
  const height = Number.isFinite(image.naturalHeight)
    ? Math.max(1, Math.floor(image.naturalHeight))
    : 1;
  return width > Number.MAX_SAFE_INTEGER / height
    ? Number.MAX_SAFE_INTEGER
    : width * height;
}

function releaseDecodedImage(image: HTMLImageElement): void {
  image.onload = null;
  image.onerror = null;
  image.removeAttribute("src");
}

class DecodedImageCache implements DecodedImageSource {
  private readonly entries = new Map<string, DecodedImageCacheEntry>();
  private totalPixels = 0;
  private accessClock = 0;
  private destroyed = false;

  constructor(
    private readonly resolveAssetUrl: NonNullable<RendererOptions["resolveAssetUrl"]>,
  ) {}

  acquire(
    assetId: string,
    contentHash: string | null,
    listener: DecodedImageListener,
  ): () => void {
    if (this.destroyed) return () => undefined;

    const key = decodedImageCacheKey(assetId, contentHash);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        assetId,
        contentHash,
        listeners: new Set(),
        state: "resolving",
        image: null,
        pixels: 0,
        references: 0,
        lastUsed: ++this.accessClock,
        active: true,
      };
      this.entries.set(key, entry);
      this.startLoading(entry);
    } else if (entry.state === "failed" || entry.state === "unavailable") {
      entry.state = "resolving";
      this.startLoading(entry);
    }

    entry.references += 1;
    entry.lastUsed = ++this.accessClock;
    entry.listeners.add(listener);
    if (entry.state === "ready" && entry.image) {
      this.scheduleReady(entry, listener, entry.image);
    } else if (entry.state === "failed") {
      this.scheduleError(entry, listener);
    }
    this.trim();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry!.listeners.delete(listener);
      entry!.references = Math.max(0, entry!.references - 1);
      if (
        entry!.references === 0
        && (entry!.state === "failed" || entry!.state === "unavailable")
      ) {
        this.evict(entry!);
      } else {
        this.trim();
      }
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const entry of [...this.entries.values()]) this.evict(entry);
    this.entries.clear();
    this.totalPixels = 0;
  }

  private startLoading(entry: DecodedImageCacheEntry): void {
    void Promise.resolve()
      .then(() => this.resolveAssetUrl(entry.assetId, entry.contentHash))
      .then((url) => {
        if (!entry.active || this.destroyed) return;
        if (!url) {
          entry.state = "unavailable";
          if (entry.references === 0) this.evict(entry);
          return;
        }

        const image = new Image();
        image.decoding = "async";
        entry.image = image;
        entry.state = "loading";
        image.onload = () => {
          if (!entry.active || this.destroyed || entry.image !== image) {
            releaseDecodedImage(image);
            return;
          }
          image.onload = null;
          image.onerror = null;
          entry.state = "ready";
          entry.pixels = decodedImagePixels(image);
          this.totalPixels += entry.pixels;
          for (const listener of entry.listeners) {
            this.scheduleReady(entry, listener, image);
          }
          this.trim();
        };
        image.onerror = () => {
          if (!entry.active || this.destroyed || entry.image !== image) {
            releaseDecodedImage(image);
            return;
          }
          releaseDecodedImage(image);
          entry.image = null;
          entry.state = "failed";
          for (const listener of entry.listeners) {
            this.scheduleError(entry, listener);
          }
          if (entry.references === 0) this.evict(entry);
        };
        image.src = url;
      })
      .catch(() => {
        if (!entry.active || this.destroyed) return;
        if (entry.image) releaseDecodedImage(entry.image);
        entry.image = null;
        entry.state = "failed";
        for (const listener of entry.listeners) {
          this.scheduleError(entry, listener);
        }
        if (entry.references === 0) this.evict(entry);
      });
  }

  private scheduleReady(
    entry: DecodedImageCacheEntry,
    listener: DecodedImageListener,
    image: HTMLImageElement,
  ): void {
    queueMicrotask(() => {
      if (
        !this.destroyed
        && entry.active
        && entry.state === "ready"
        && entry.image === image
        && entry.listeners.has(listener)
      ) {
        listener.onReady(image);
      }
    });
  }

  private scheduleError(
    entry: DecodedImageCacheEntry,
    listener: DecodedImageListener,
  ): void {
    queueMicrotask(() => {
      if (
        !this.destroyed
        && entry.active
        && entry.state === "failed"
        && entry.listeners.has(listener)
      ) {
        listener.onError();
      }
    });
  }

  private trim(): void {
    while (
      this.entries.size > MAX_DECODED_IMAGE_CACHE_ENTRIES
      || this.totalPixels > MAX_DECODED_IMAGE_CACHE_PIXELS
    ) {
      let candidate: DecodedImageCacheEntry | null = null;
      for (const entry of this.entries.values()) {
        if (
          entry.references === 0
          && (!candidate || entry.lastUsed < candidate.lastUsed)
        ) {
          candidate = entry;
        }
      }
      if (!candidate) return;
      this.evict(candidate);
    }
  }

  private evict(entry: DecodedImageCacheEntry): void {
    if (!entry.active) return;
    entry.active = false;
    this.entries.delete(entry.key);
    entry.listeners.clear();
    if (entry.image) releaseDecodedImage(entry.image);
    this.totalPixels = Math.max(0, this.totalPixels - entry.pixels);
    entry.image = null;
    entry.pixels = 0;
  }
}

const IMAGE_CACHE_RELEASE = Symbol("eduriImageCacheRelease");
type ImageLeaseGroup = Konva.Group & {
  [IMAGE_CACHE_RELEASE]?: () => void;
};

function releaseRenderedObjectNode(node: Konva.Group): void {
  node.destroy();
  const leasedNode = node as ImageLeaseGroup;
  const release = leasedNode[IMAGE_CACHE_RELEASE];
  delete leasedNode[IMAGE_CACHE_RELEASE];
  release?.();
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.max(minimum, Math.min(maximum, finiteNumber(value, fallback)));
}

function renderedObjectOpacity(object: BoardObjectSnapshot): number {
  return boundedNumber(object.style.opacity, 1, 0, 1);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function boundedTextValue(
  value: unknown,
  fallback: string,
  maxCodeUnits: number,
): string {
  const text = stringValue(value, fallback);
  if (text.length <= maxCodeUnits) return text;
  let end = maxCodeUnits;
  if (
    end > 0
    && text.charCodeAt(end - 1) >= 0xd800
    && text.charCodeAt(end - 1) <= 0xdbff
    && text.charCodeAt(end) >= 0xdc00
    && text.charCodeAt(end) <= 0xdfff
  ) {
    end -= 1;
  }
  return `${text.slice(0, end)}\u2026`;
}

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const RGB_COLOR_PATTERN =
  /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/iu;
const RGBA_COLOR_PATTERN =
  /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*([0-9]*\.?[0-9]+)\s*\)$/iu;

function colorValue(value: unknown, fallback: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_RENDER_COLOR_CODE_UNITS
  ) {
    return fallback;
  }
  if (HEX_COLOR_PATTERN.test(value)) return value;

  const rgb = RGB_COLOR_PATTERN.exec(value);
  if (rgb) {
    const channels = rgb.slice(1).map(Number);
    return channels.every((channel) => channel <= 255)
      ? `rgb(${channels.join(",")})`
      : fallback;
  }

  const rgba = RGBA_COLOR_PATTERN.exec(value);
  if (rgba) {
    const channels = rgba.slice(1, 4).map(Number);
    const alpha = Number(rgba[4]);
    if (channels.every((channel) => channel <= 255) && alpha <= 1) {
      return `rgba(${channels.join(",")},${alpha})`;
    }
  }
  return fallback;
}

function themePalette(theme: BoardTheme): BoardThemePalette {
  return BOARD_THEME_PALETTES[theme];
}

function makeEraserTrailPreview(color: string): {
  readonly root: Konva.Group;
  readonly body: Konva.Shape;
  readonly footprint: Konva.Circle;
} {
  const root = new Konva.Group({
    name: "eraser-trail",
    listening: false,
  });
  const footprint = new Konva.Circle({
    name: "eraser-trail-footprint",
    radius: ERASER_RADIUS_PX,
    stroke: color,
    strokeWidth: 1,
    opacity: ERASER_HIT_OUTLINE_OPACITY,
    visible: false,
    strokeScaleEnabled: false,
    perfectDrawEnabled: false,
    listening: false,
  });
  const body = new Konva.Shape({
    name: "eraser-trail-body",
    fill: color,
    opacity: ERASER_TRAIL_OPACITY,
    visible: false,
    perfectDrawEnabled: false,
    listening: false,
    sceneFunc: (context, shape) => {
      const stations = shape.getAttr("eraserTrailStations") as
        | readonly EraserTrailRenderStation[]
        | undefined;
      if (!stations || stations.length === 0) return;

      // One compound fill applies alpha once across the connected ribbon and
      // its round sections, producing rounded turns without overlap seams.
      context.beginPath();
      for (let index = 0; index < stations.length; index += 1) {
        const station = stations[index];
        const radius = station.diameter / 2;
        if (
          !Number.isFinite(station.x)
          || !Number.isFinite(station.y)
          || !Number.isFinite(radius)
          || radius <= 0
        ) {
          continue;
        }
        const next = stations[index + 1];
        if (next) {
          const nextRadius = next.diameter / 2;
          const dx = next.x - station.x;
          const dy = next.y - station.y;
          const segmentLength = Math.hypot(dx, dy);
          if (
            Number.isFinite(next.x)
            && Number.isFinite(next.y)
            && Number.isFinite(nextRadius)
            && nextRadius > 0
            && Number.isFinite(segmentLength)
            && segmentLength > 1e-6
          ) {
            const normalX = -dy / segmentLength;
            const normalY = dx / segmentLength;
            context.moveTo(
              station.x + normalX * radius,
              station.y + normalY * radius,
            );
            context.lineTo(
              next.x + normalX * nextRadius,
              next.y + normalY * nextRadius,
            );
            context.lineTo(
              next.x - normalX * nextRadius,
              next.y - normalY * nextRadius,
            );
            context.lineTo(
              station.x - normalX * radius,
              station.y - normalY * radius,
            );
            context.closePath();
          }
        }
        context.moveTo(station.x + radius, station.y);
        context.arc(station.x, station.y, radius, 0, Math.PI * 2);
      }
      context.fillShape(shape);
    },
  });
  root.add(body, footprint);
  return { root, body, footprint };
}

function setEraserTrailColor(gesture: EraserGesture, color: string): void {
  gesture.trailFootprint.stroke(color);
  gesture.trailBody.fill(color);
}

function adaptiveInkColor(
  value: unknown,
  fallback: string,
  theme: BoardTheme,
): string {
  const color = colorValue(value, fallback);
  return theme === "dark" && color.toLowerCase() === DEFAULT_STROKE
    ? DARK_DEFAULT_STROKE
    : color;
}

const FONT_FAMILY_PART_PATTERN =
  /^(?:[\p{L}\p{N}][\p{L}\p{N} ._-]*|"[\p{L}\p{N} ._-]+"|'[\p{L}\p{N} ._-]+')$/u;
const INLINE_TEXT_GLYPHS_NAME = "board-inline-text-glyphs";

function fontFamilyValue(value: unknown, fallback: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_RENDER_FONT_FAMILY_CODE_UNITS
  ) {
    return fallback;
  }
  const families = value.split(",").map((family) => family.trim());
  if (
    families.length === 0
    || families.length > MAX_RENDER_FONT_FAMILIES
    || families.some((family) =>
      family.length === 0 || !FONT_FAMILY_PART_PATTERN.test(family))
  ) {
    return fallback;
  }
  return families.join(", ");
}

function fontStyleValue(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length > 16) return fallback;
  if (value === "normal") return value;
  const tokens = value.trim().split(/\s+/u);
  if (
    tokens.length === 0
    || tokens.length > 2
    || new Set(tokens).size !== tokens.length
    || tokens.some((token) => token !== "bold" && token !== "italic")
  ) {
    return fallback;
  }
  return ["bold", "italic"].filter((token) => tokens.includes(token)).join(" ");
}

function dashValue(
  value: unknown,
  fallback?: readonly number[],
): number[] | undefined {
  const source = Array.isArray(value) ? value : fallback;
  if (!source) return undefined;
  const dash: number[] = [];
  const count = Math.min(source.length, MAX_RENDER_DASH_SEGMENTS);
  for (let index = 0; index < count; index += 1) {
    const segment = source[index];
    if (
      typeof segment === "number"
      && Number.isFinite(segment)
      && segment >= 0
    ) {
      dash.push(Math.min(segment, MAX_RENDER_DASH_SEGMENT));
    }
  }
  return dash.some((segment) => segment > 0) ? dash : [];
}

function fontSizeValue(
  value: unknown,
  fallback: number,
  minimum: number,
): number {
  return boundedNumber(value, fallback, minimum, MAX_RENDER_FONT_SIZE);
}

function strokeWidth(object: BoardObjectSnapshot, fallback = 2): number {
  return boundedNumber(object.style.strokeWidth, fallback, 0.5, 96);
}

function objectDimensions(transform: AtomicTransform): { width: number; height: number } {
  return {
    width: Math.max(1, Math.abs(transform[2])),
    height: Math.max(1, Math.abs(transform[3])),
  };
}

function transformedNodeOutlinePoints(
  node: Konva.Node,
  bounds: SelectionObjectOutlineGeometry["bounds"],
): number[] | null {
  if (
    !Number.isFinite(bounds.x)
    || !Number.isFinite(bounds.y)
    || !Number.isFinite(bounds.width)
    || !Number.isFinite(bounds.height)
  ) {
    return null;
  }
  // Konva batches transform-cache invalidation during dragmove. Build from the
  // live attrs so selection chrome moves in the same event, not one frame late.
  const transform = new Konva.Transform();
  transform.translate(node.x(), node.y());
  transform.rotate(Konva.getAngle(node.rotation()));
  transform.skew(node.skewX(), node.skewY());
  transform.scale(node.scaleX(), node.scaleY());
  transform.translate(-node.offsetX(), -node.offsetY());
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ];
  const points: number[] = [];
  for (const corner of corners) {
    const point = transform.point(corner);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    points.push(point.x, point.y);
  }
  return points;
}

function placeholderOrigin(transform: AtomicTransform): BoardPoint {
  return {
    x: transform[2] < 0 ? -Math.max(1, Math.abs(transform[2])) : 0,
    y: transform[3] < 0 ? -Math.max(1, Math.abs(transform[3])) : 0,
  };
}

function objectIdFromTarget(target: Konva.Node): string | null {
  let current: Konva.Node | null = target;
  while (current) {
    const objectId = current.getAttr("boardObjectId") as unknown;
    if (typeof objectId === "string") return objectId;
    current = current.getParent();
  }
  return null;
}

function pointerPressure(event: Event): number {
  if (
    typeof PointerEvent !== "undefined"
    && event instanceof PointerEvent
    && event.pressure > 0
  ) {
    return event.pressure;
  }
  return 0.5;
}

function normalizedTransform(
  start: BoardPoint,
  end: BoardPoint,
): AtomicTransform {
  return [
    Math.min(start.x, end.x),
    Math.min(start.y, end.y),
    Math.max(1, Math.abs(end.x - start.x)),
    Math.max(1, Math.abs(end.y - start.y)),
    0,
  ];
}

function connectorControlPoint(
  start: BoardPoint,
  end: BoardPoint,
  curvature: number,
): BoardPoint | null {
  if (!Number.isFinite(curvature) || Math.abs(curvature) < 0.001) return null;
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const length = Math.hypot(deltaX, deltaY);
  if (length < 0.001) return null;
  const bend = Math.max(-1, Math.min(1, curvature)) * length * 0.75;
  return {
    x: (start.x + end.x) / 2 - deltaY / length * bend,
    y: (start.y + end.y) / 2 + deltaX / length * bend,
  };
}

function connectorPreviewPoints(
  start: BoardPoint,
  end: BoardPoint,
  control: BoardPoint | null,
): number[] {
  if (!control) return [start.x, start.y, end.x, end.y];
  return [
    start.x,
    start.y,
    start.x + (control.x - start.x) * 2 / 3,
    start.y + (control.y - start.y) * 2 / 3,
    end.x + (control.x - end.x) * 2 / 3,
    end.y + (control.y - end.y) * 2 / 3,
    end.x,
    end.y,
  ];
}

function worldPoint(
  screen: BoardPoint,
  camera: BoardCamera,
): BoardPoint {
  return {
    x: (screen.x - camera.x) / camera.zoom,
    y: (screen.y - camera.y) / camera.zoom,
  };
}

function normalizedWheelZoomDelta(
  event: WheelEvent,
  viewportHeight: number,
): number {
  if (!Number.isFinite(event.deltaY)) return 0;
  const scale = event.deltaMode === WHEEL_DELTA_MODE_LINE
    ? WHEEL_LINE_DELTA_PX
    : event.deltaMode === WHEEL_DELTA_MODE_PAGE
      ? Math.max(1, viewportHeight)
      : 1;
  return Math.max(
    -MAX_WHEEL_ZOOM_DELTA_PX,
    Math.min(MAX_WHEEL_ZOOM_DELTA_PX, event.deltaY * scale),
  );
}

function pointerTypeFromEvent(event: PointerEvent | MouseEvent): string {
  return "pointerType" in event && event.pointerType
    ? event.pointerType
    : "mouse";
}

function pointerSamples(
  event: PointerEvent | MouseEvent,
): readonly (PointerEvent | MouseEvent)[] {
  const pointerEvent = event as PointerEvent;
  if (typeof pointerEvent.getCoalescedEvents !== "function") return [event];
  try {
    const samples = pointerEvent.getCoalescedEvents();
    return samples.length > 0 ? samples : [event];
  } catch {
    return [event];
  }
}

function pointerAnimationTimes(
  sampleCount: number,
  previousAt: number,
  receivedAt: number,
): number[] {
  if (sampleCount <= 0) return [];
  const safeReceived = Number.isFinite(receivedAt) ? receivedAt : 0;
  const safePrevious = Number.isFinite(previousAt)
    ? Math.min(previousAt, safeReceived + MAX_SYNTHETIC_POINTER_BATCH_SPAN_MS)
    : safeReceived;
  if (safePrevious > safeReceived) {
    return Array.from({ length: sampleCount }, () => safePrevious);
  }
  const measuredSpan = safeReceived - safePrevious;
  const span = measuredSpan > 0 ? measuredSpan : Math.min(
    MAX_SYNTHETIC_POINTER_BATCH_SPAN_MS,
    sampleCount * 0.25,
  );
  return Array.from(
    { length: sampleCount },
    (_, index) => safePrevious + span * (index + 1) / sampleCount,
  );
}

function eraserModeFromEvent(
  event: PointerEvent | MouseEvent,
  fallbackAltKey = false,
): EraserMode {
  const altKey = typeof event.altKey === "boolean"
    ? event.altKey
    : fallbackAltKey;
  return altKey ? "restore" : "mark";
}

interface PointerScreenTransform {
  readonly left: number;
  readonly top: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

function pointerScreenTransform(element: HTMLElement): PointerScreenTransform {
  const bounds = element.getBoundingClientRect();
  return {
    left: bounds.left,
    top: bounds.top,
    scaleX: bounds.width > 0 && element.clientWidth > 0
      ? element.clientWidth / bounds.width
      : 1,
    scaleY: bounds.height > 0 && element.clientHeight > 0
      ? element.clientHeight / bounds.height
      : 1,
  };
}

function screenPointFromPointer(
  event: PointerEvent | MouseEvent,
  element: HTMLElement,
  transform = pointerScreenTransform(element),
): BoardPoint {
  return {
    x: (event.clientX - transform.left) * transform.scaleX,
    y: (event.clientY - transform.top) * transform.scaleY,
  };
}

function distance(left: BoardPoint, right: BoardPoint): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function midpoint(left: BoardPoint, right: BoardPoint): BoardPoint {
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
}

function flattenedPoints(points: readonly BoardPoint[]): number[] {
  const flattened = new Array<number>(points.length * 2);
  for (let index = 0; index < points.length; index += 1) {
    flattened[index * 2] = points[index].x;
    flattened[index * 2 + 1] = points[index].y;
  }
  return flattened;
}

function isFinitePoint(point: BoardPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function isGesturePreviewTool(
  tool: BoardTool | BoardGesturePreviewTool,
): tool is BoardGesturePreviewTool {
  return tool === "pen"
    || tool === "highlighter"
    || tool === "line"
    || tool === "arrow"
    || tool === "rectangle"
    || tool === "ellipse"
    || tool === "diamond"
    || tool === "frame";
}

function isPlacementTool(tool: BoardTool): tool is BoardPlacementTool {
  return tool === "code" || tool === "latex" || tool === "image";
}

function isSelectionGesture(
  gesture: ActiveGesture | null,
): gesture is SelectionGesture {
  return gesture?.kind === "marquee" || gesture?.kind === "lasso";
}

function commandModifierHeld(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">,
): boolean {
  return event.ctrlKey || event.metaKey;
}

function standaloneAltHeld(
  event: PointerEvent | MouseEvent | KeyboardEvent,
): boolean {
  if (!event.altKey) return false;
  if (typeof event.getModifierState !== "function") return true;
  try {
    return !event.getModifierState("AltGraph");
  } catch {
    return true;
  }
}

function appendBoundedGesturePoint(points: BoardPoint[], point: BoardPoint): void {
  const previous = points.at(-1);
  if (previous && previous.x === point.x && previous.y === point.y) return;
  points.push(point);
  if (points.length <= MAX_BOARD_GESTURE_PREVIEW_POINTS) return;

  const compacted: BoardPoint[] = [points[0]];
  for (let index = 2; index < points.length - 1; index += 2) {
    compacted.push(points[index]);
  }
  compacted.push(points[points.length - 1]);
  points.splice(0, points.length, ...compacted);
}

function evenlySamplePoints(
  points: readonly BoardPoint[],
  limit: number,
): BoardPoint[] {
  if (points.length <= limit) return points.map((point) => ({ ...point }));
  if (limit <= 1) return [{ ...points[points.length - 1] }];
  const sampled: BoardPoint[] = [];
  for (let index = 0; index < limit; index += 1) {
    const sourceIndex = Math.round(index * (points.length - 1) / (limit - 1));
    sampled.push({ ...points[sourceIndex] });
  }
  return sampled;
}

function boundedLaserPreview(
  localStrokes: readonly LocalLaserStroke[],
): BoardLaserPreview | null {
  const strokes = localStrokes
    .filter((stroke) => stroke.points.length > 0)
    .slice(-MAX_BOARD_LASER_STROKES);
  if (strokes.length === 0) return null;

  const allocations = strokes.map((stroke) => Math.min(
    stroke.points.length,
    stroke.points.length === 1 ? 1 : 2,
  ));
  let remaining = MAX_BOARD_LASER_POINTS
    - allocations.reduce((total, allocation) => total + allocation, 0);
  while (remaining > 0) {
    let bestIndex = -1;
    let bestPressure = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < strokes.length; index += 1) {
      if (allocations[index] >= strokes[index].points.length) continue;
      const pressure = strokes[index].points.length / allocations[index];
      if (pressure > bestPressure) {
        bestIndex = index;
        bestPressure = pressure;
      }
    }
    if (bestIndex < 0) break;
    allocations[bestIndex] += 1;
    remaining -= 1;
  }

  return {
    strokes: strokes.map((stroke, index) => ({
      points: evenlySamplePoints(stroke.points, allocations[index]),
      style: stroke.style,
    })),
  };
}

function boundedGesturePoints(points: readonly BoardPoint[]): BoardPoint[] {
  const bounded: BoardPoint[] = [];
  for (const point of points) {
    if (!isFinitePoint(point)) continue;
    appendBoundedGesturePoint(bounded, { x: point.x, y: point.y });
  }
  return bounded;
}

function equalIdSets(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) {
    if (!right.has(id)) return false;
  }
  return true;
}

function viewportContains(
  outer: ViewportBounds,
  inner: ViewportBounds,
): boolean {
  return inner.minX >= outer.minX
    && inner.minY >= outer.minY
    && inner.maxX <= outer.maxX
    && inner.maxY <= outer.maxY;
}

function boundsIntersect(
  left: ViewportBounds,
  right: ViewportBounds,
): boolean {
  return left.minX <= right.maxX
    && left.maxX >= right.minX
    && left.minY <= right.maxY
    && left.maxY >= right.minY;
}

function equalPoints(
  left: readonly BoardPoint[] | null,
  right: readonly BoardPoint[],
): boolean {
  if (!left || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].x !== right[index].x || left[index].y !== right[index].y) {
      return false;
    }
  }
  return true;
}

function equalGesturePreviewStyles(
  left: BoardGesturePreviewStyle | null,
  right: BoardGesturePreviewStyle | undefined,
): boolean {
  if (!left || !right) return left === null && right === undefined;
  return left.stroke === right.stroke
    && left.strokeWidth === right.strokeWidth
    && left.opacity === right.opacity;
}

function interpolateCursor(motion: CursorMotion, time: number): BoardPoint {
  const progress = Math.max(
    0,
    Math.min(1, (time - motion.startedAt) / CURSOR_INTERPOLATION_MS),
  );
  const eased = 1 - (1 - progress) ** 3;
  return {
    x: motion.from.x + (motion.target.x - motion.from.x) * eased,
    y: motion.from.y + (motion.target.y - motion.from.y) * eased,
  };
}

function shapeDraft(
  tool: DrawingGesture["tool"],
  start: BoardPoint,
  end: BoardPoint,
  points: readonly (BoardPoint & { pressure: number })[],
  style: Readonly<Record<string, unknown>>,
  connectorCurvature = 0,
): BoardObjectDraft | null {
  if (tool === "text") {
    return {
      kind: BUILTIN_OBJECT_KINDS.text,
      transform: [start.x, start.y, 240, 52, 0],
      style,
      props: { text: "" },
    };
  }

  if (tool === "pen" || tool === "highlighter") {
    if (points.length < 2) return null;
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
    return {
      kind: BUILTIN_OBJECT_KINDS.stroke,
      transform: [
        minX,
        minY,
        Math.max(1 / 64, maxX - minX),
        Math.max(1 / 64, maxY - minY),
        0,
      ],
      style,
      props: {
        strokePoints: points.map((point) => ({
          x: point.x - minX,
          y: point.y - minY,
          pressure: point.pressure,
        })),
      },
    };
  }

  const transform = normalizedTransform(start, end);
  if (transform[2] < 3 && transform[3] < 3) return null;
  if (tool === "line" || tool === "arrow") {
    const control = connectorControlPoint(start, end, connectorCurvature);
    const geometry = createBoardLineObjectGeometry(
      [start.x, start.y] as BoardLinePoint,
      [end.x, end.y] as BoardLinePoint,
      control ? [control.x, control.y] as BoardLinePoint : undefined,
    );
    return {
      kind: tool === "arrow" ? BUILTIN_OBJECT_KINDS.arrow : BUILTIN_OBJECT_KINDS.line,
      transform: geometry.transform,
      style,
      props: geometry.props,
    };
  }
  const kind = tool === "ellipse"
    ? BUILTIN_OBJECT_KINDS.ellipse
    : tool === "diamond"
      ? BUILTIN_OBJECT_KINDS.diamond
      : tool === "frame"
        ? BUILTIN_OBJECT_KINDS.frame
        : BUILTIN_OBJECT_KINDS.rectangle;
  return {
    kind,
    transform,
    style,
    props: tool === "frame" ? { label: "Область" } : {},
  };
}

function drawingStyle(
  tool: DrawingGesture["tool"],
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const defaults = defaultBoardToolStyle(tool);
  const merged = { ...defaults, ...overrides };
  const fallbackStroke = tool === "highlighter"
    ? "#ffd43b"
    : tool === "frame"
      ? "#8492a6"
      : DEFAULT_STROKE;
  const fallbackWidth = tool === "highlighter" ? 18 : tool === "pen" ? 2.5 : tool === "frame" ? 1.5 : 2;
  const sanitized: Record<string, unknown> = {
    ...merged,
    stroke: colorValue(merged.stroke, fallbackStroke),
    fill: colorValue(merged.fill, DEFAULT_FILL),
    strokeWidth: boundedNumber(merged.strokeWidth, fallbackWidth, 0.5, 96),
    opacity: boundedNumber(
      merged.opacity,
      tool === "highlighter" ? 0.38 : 1,
      0,
      1,
    ),
    dash: dashValue(merged.dash, []) ?? [],
  };
  if (Object.prototype.hasOwnProperty.call(merged, "fontSize")) {
    sanitized.fontSize = fontSizeValue(
      merged.fontSize,
      finiteNumber(defaults.fontSize, 20),
      8,
    );
  }
  if (Object.prototype.hasOwnProperty.call(merged, "fontFamily")) {
    sanitized.fontFamily = fontFamilyValue(
      merged.fontFamily,
      stringValue(defaults.fontFamily, "Inter, Arial, sans-serif"),
    );
  }
  if (Object.prototype.hasOwnProperty.call(merged, "fontStyle")) {
    sanitized.fontStyle = fontStyleValue(
      merged.fontStyle,
      stringValue(defaults.fontStyle, "normal"),
    );
  }
  return sanitized;
}

function laserStyle(
  overrides: Readonly<Record<string, unknown>>,
): BoardGesturePreviewStyle {
  const style = drawingStyle("pen", overrides);
  return sanitizeBoardGesturePreviewStyle(style) ?? {
    stroke: DEFAULT_STROKE,
    strokeWidth: 2.5,
    opacity: 1,
  };
}

function applyLaserStrokeAppearance(
  line: Konva.Line,
  style: BoardGesturePreviewStyle,
  theme: BoardTheme,
  zoom: number,
): void {
  const stroke = adaptiveInkColor(style.stroke, DEFAULT_STROKE, theme);
  line.setAttrs({
    stroke,
    strokeWidth: style.strokeWidth,
    opacity: style.opacity,
    shadowColor: stroke,
    shadowBlur: LASER_GLOW_PX / zoom,
    shadowOpacity: Math.min(0.8, 0.3 + style.opacity * 0.5),
  });
}

function makeLaserStrokePreview(
  start: BoardPoint,
  style: BoardGesturePreviewStyle,
  theme: BoardTheme,
  zoom: number,
): Konva.Line {
  const line = new Konva.Line({
    points: [start.x, start.y, start.x, start.y],
    lineCap: "round",
    lineJoin: "round",
    listening: false,
    perfectDrawEnabled: false,
  });
  applyLaserStrokeAppearance(line, style, theme, zoom);
  return line;
}

function makeDrawingPreview(
  tool: DrawingGesture["tool"],
  start: BoardPoint,
  style: Readonly<Record<string, unknown>> = drawingStyle(tool),
  theme: BoardTheme = "light",
): Konva.Shape {
  const stroke = adaptiveInkColor(style.stroke, DEFAULT_STROKE, theme);
  const fill = colorValue(style.fill, DEFAULT_FILL);
  const width = boundedNumber(style.strokeWidth, 2, 0.5, 96);
  const opacity = boundedNumber(style.opacity, 1, 0, 1);
  const dash = dashValue(style.dash);
  if (tool === "pen" || tool === "highlighter") {
    return new Konva.Line({
      points: [start.x, start.y],
      stroke,
      strokeWidth: width,
      opacity,
      dash,
      lineCap: "round",
      lineJoin: "round",
      listening: false,
      globalCompositeOperation: style.blendMode === "multiply" ? "multiply" : "source-over",
    });
  }
  if (tool === "ellipse") {
    return new Konva.Ellipse({
      x: start.x,
      y: start.y,
      radiusX: 1,
      radiusY: 1,
      stroke,
      fill,
      strokeWidth: width,
      opacity,
      dash,
      listening: false,
    });
  }
  if (tool === "diamond") {
    return new Konva.Line({
      points: [start.x, start.y],
      closed: true,
      stroke,
      fill,
      strokeWidth: width,
      opacity,
      dash,
      listening: false,
    });
  }
  if (tool === "line" || tool === "arrow") {
    const config = {
      points: [start.x, start.y, start.x, start.y],
      stroke,
      fill: stroke,
      strokeWidth: width,
      opacity,
      dash,
      pointerLength: 10,
      pointerWidth: 9,
      listening: false,
    };
    return tool === "arrow" ? new Konva.Arrow(config) : new Konva.Line(config);
  }
  return new Konva.Rect({
    x: start.x,
    y: start.y,
    width: 1,
    height: 1,
    stroke,
    fill,
    strokeWidth: width,
    opacity,
    dash,
    listening: false,
  });
}

function updateDrawingPreview(gesture: DrawingGesture, end: BoardPoint): void {
  const { preview, start, tool } = gesture;
  if (tool === "pen" || tool === "highlighter") {
    (preview as Konva.Line).setAttrs({
      points: gesture.previewPoints,
      x: gesture.strokeOffset.x,
      y: gesture.strokeOffset.y,
    });
    return;
  }
  if (tool === "line" || tool === "arrow") {
    const control = gesture.fixedConnectorControl
      ?? connectorControlPoint(start, end, gesture.connectorCurvature);
    (preview as Konva.Line).setAttrs({
      points: connectorPreviewPoints(start, end, control),
      bezier: control !== null,
    });
    return;
  }
  const transform = normalizedTransform(start, end);
  if (tool === "ellipse") {
    const ellipse = preview as Konva.Ellipse;
    ellipse.position({ x: transform[0] + transform[2] / 2, y: transform[1] + transform[3] / 2 });
    ellipse.radius({ x: transform[2] / 2, y: transform[3] / 2 });
    return;
  }
  if (tool === "diamond") {
    (preview as Konva.Line).points([
      transform[0] + transform[2] / 2, transform[1],
      transform[0] + transform[2], transform[1] + transform[3] / 2,
      transform[0] + transform[2] / 2, transform[1] + transform[3],
      transform[0], transform[1] + transform[3] / 2,
    ]);
    return;
  }
  (preview as Konva.Rect).setAttrs({
    x: transform[0],
    y: transform[1],
    width: transform[2],
    height: transform[3],
  });
}

export function renderGesturePreviewNode(
  gesture: BoardGesturePreview,
  color = DEFAULT_ACCENT,
  theme: BoardTheme = "light",
): Konva.Shape | null {
  if (!isGesturePreviewTool(gesture.kind)) return null;
  const points = boundedGesturePoints(gesture.points);
  if (points.length === 0) return null;
  if (
    gesture.kind !== "pen"
    && gesture.kind !== "highlighter"
    && points.length < 2
  ) {
    return null;
  }

  const start = points[0];
  const end = points.at(-1) ?? start;
  const boundedStyle = sanitizeBoardGesturePreviewStyle(gesture.style);
  const style = drawingStyle(
    gesture.kind,
    boundedStyle ? { ...boundedStyle } : undefined,
  );
  const preview = makeDrawingPreview(gesture.kind, start, style, theme);
  const drawing: DrawingGesture = {
    kind: "drawing",
    pointerId: -1,
    pointerType: "remote",
    tool: gesture.kind,
    style,
    start,
    points: points.map((point) => ({ ...point, pressure: 0.5 })),
    previewAwarenessPoints: points,
    previewPoints: flattenedPoints(points),
    preview,
    previousScreen: { x: 0, y: 0 },
    strokeOffset: { x: 0, y: 0 },
    straightPointActive: false,
    strokeMoveActive: false,
    connectorCurvature: 0,
    fixedConnectorControl: (
      (gesture.kind === "line" || gesture.kind === "arrow")
      && points.length === 3
    ) ? points[1] : null,
  };
  updateDrawingPreview(drawing, end);
  if (!boundedStyle && gesture.kind !== "highlighter") {
    preview.stroke(colorValue(color, DEFAULT_ACCENT));
    if (preview instanceof Konva.Arrow) {
      preview.fill(colorValue(color, DEFAULT_ACCENT));
    }
  }
  if (!boundedStyle) {
    preview.opacity(gesture.kind === "highlighter" ? 0.38 : 0.76);
  }
  preview.listening(false);
  return preview;
}

export function renderObjectNode(
  object: BoardObjectSnapshot,
  resolveAssetUrl: RendererOptions["resolveAssetUrl"],
  invalidate: () => void,
  decodedImages?: DecodedImageSource,
  theme: BoardTheme = "light",
): Konva.Group {
  const palette = themePalette(theme);
  const transform = safeRendererTransform(object.transform);
  const [x, y, , , rotation] = transform;
  const { width, height } = objectDimensions(transform);
  const group = new Konva.Group({
    x,
    y,
    rotation: rotation * 180 / Math.PI,
    boardObjectId: object.id,
    name: "board-object",
  });
  const rendering = inspectBoardObjectRendering(object);
  group.setAttr("boardObjectRendering", rendering.status);
  if (rendering.status !== "supported") {
    const origin = placeholderOrigin(transform);
    group.add(new Konva.Rect({
      x: origin.x,
      y: origin.y,
      width,
      height,
      fill: palette.placeholderFill,
      stroke: palette.placeholderStroke,
      strokeWidth: 1,
      dash: [5, 4],
      cornerRadius: 3,
    }));
    group.add(new Konva.Text({
      x: origin.x + 10,
      y: origin.y + 10,
      width: Math.max(1, width - 20),
      height: Math.max(1, height - 20),
      text: boundedTextValue(
        rendering.status === "malformed"
          ? "Invalid board object"
          : rendering.status === "unsupported-version"
            ? `${boundedTextValue(object.kind, "", MAX_RENDER_METADATA_CODE_UNITS)} v${object.version}`
            : object.kind,
        "Unsupported board object",
        MAX_RENDER_METADATA_CODE_UNITS,
      ),
      fill: palette.placeholderText,
      fontSize: 12,
      align: "center",
      verticalAlign: "middle",
      ellipsis: true,
    }));
    return group;
  }

  const stroke = adaptiveInkColor(object.style.stroke, DEFAULT_STROKE, theme);
  const fill = colorValue(object.style.fill, DEFAULT_FILL);
  const opacity = renderedObjectOpacity(object);
  const dash = dashValue(object.style.dash);
  const shared = {
    stroke,
    strokeWidth: strokeWidth(object),
    fill,
    dash,
    lineJoin: "round" as const,
    perfectDrawEnabled: false,
  };
  group.opacity(opacity);

  if (object.kind === BUILTIN_OBJECT_KINDS.rectangle) {
    group.add(new Konva.Rect({ width, height, ...shared }));
  } else if (object.kind === BUILTIN_OBJECT_KINDS.ellipse) {
    group.add(new Konva.Ellipse({
      x: width / 2,
      y: height / 2,
      radiusX: width / 2,
      radiusY: height / 2,
      ...shared,
    }));
  } else if (object.kind === BUILTIN_OBJECT_KINDS.diamond) {
    group.add(new Konva.Line({
      points: [width / 2, 0, width, height / 2, width / 2, height, 0, height / 2],
      closed: true,
      ...shared,
    }));
  } else if (object.kind === BUILTIN_OBJECT_KINDS.line || object.kind === BUILTIN_OBJECT_KINDS.arrow) {
    const path = renderedLinePath(object);
    const points = path?.points ?? [];
    const bezier = path?.bezier ?? false;
    group.add(object.kind === BUILTIN_OBJECT_KINDS.arrow
      ? new Konva.Arrow({
          points,
          bezier,
          stroke,
          fill: stroke,
          strokeWidth: strokeWidth(object),
          pointerLength: Math.max(8, strokeWidth(object) * 4),
           pointerWidth: Math.max(7, strokeWidth(object) * 3.5),
          dash,
          lineCap: "round",
          lineJoin: "round",
          perfectDrawEnabled: false,
        })
      : new Konva.Line({
          points,
          bezier,
          stroke,
          strokeWidth: strokeWidth(object),
          dash,
          lineCap: "round",
          perfectDrawEnabled: false,
        }));
  } else if (object.kind === BUILTIN_OBJECT_KINDS.stroke) {
    const points = renderedStrokePoints(object) ?? [];
    group.add(new Konva.Line({
      points,
      stroke,
      strokeWidth: strokeWidth(object),
      dash,
      lineCap: "round",
      lineJoin: "round",
      globalCompositeOperation: object.style.blendMode === "multiply" ? "multiply" : "source-over",
      hitStrokeWidth: Math.max(12, strokeWidth(object) + 8),
      perfectDrawEnabled: false,
    }));
  } else if (object.kind === BUILTIN_OBJECT_KINDS.text) {
    group.add(new Konva.Text({
      name: INLINE_TEXT_GLYPHS_NAME,
      width,
      height,
      text: boundedTextValue(object.props.text, "", MAX_RENDER_TEXT_CODE_UNITS),
      fill: adaptiveInkColor(object.style.fill, DEFAULT_STROKE, theme),
      fontSize: fontSizeValue(object.style.fontSize, 20, 8),
      fontFamily: fontFamilyValue(
        object.style.fontFamily,
        "Inter, Arial, sans-serif",
      ),
      fontStyle: fontStyleValue(object.style.fontStyle, "normal"),
      lineHeight: 1.25,
      wrap: "word",
      padding: 2,
      verticalAlign: "middle",
    }));
  } else if (object.kind === BUILTIN_OBJECT_KINDS.frame) {
    group.add(new Konva.Rect({
      width,
      height,
      stroke,
      strokeWidth: strokeWidth(object, 1.5),
      fill,
      dash: dash ?? [8, 6],
      lineJoin: "round",
      cornerRadius: 2,
    }));
    const label = new Konva.Label({
      x: 0,
      y: -RENDERED_FRAME_LABEL_HEIGHT,
    });
    const labelText = boundedTextValue(
      object.props.label,
      "Область",
      MAX_RENDER_METADATA_CODE_UNITS,
    );
    label.add(
      new Konva.Tag({ fill: palette.surfaceFill, opacity: 0.94, cornerRadius: 3 }),
      new Konva.Text({
        text: labelText,
        width: renderedFrameLabelWidth(object, width),
        fontSize: 13,
        fontStyle: "bold",
        fill: palette.placeholderText,
        padding: 5,
        wrap: "none",
        ellipsis: true,
      }),
    );
    group.add(label);
  } else if (object.kind === BUILTIN_OBJECT_KINDS.code) {
    group.add(new Konva.Rect({
      width,
      height,
      fill: "#151a20",
      stroke: "#323a45",
      strokeWidth: 1,
      cornerRadius: 5,
      shadowColor: "#0a0d10",
      shadowOpacity: 0.16,
      shadowBlur: 10,
      shadowOffsetY: 3,
    }));
    group.add(new Konva.Text({
      x: 12,
      y: 10,
      width: width - 24,
      text: boundedTextValue(
        boundedTextValue(
          object.props.language,
          "plaintext",
          MAX_RENDER_METADATA_CODE_UNITS,
        ).toUpperCase(),
        "PLAINTEXT",
        MAX_RENDER_METADATA_CODE_UNITS,
      ),
      fontSize: 10,
      fontStyle: "bold",
      fill: "#8fa1b7",
    }));
    group.add(new Konva.Text({
      x: 12,
      y: 31,
      width: width - 24,
      height: height - 42,
      text: boundedTextValue(object.props.source, "", MAX_RENDER_TEXT_CODE_UNITS),
      fontSize: fontSizeValue(object.style.fontSize, 14, 10),
      fontFamily: "JetBrains Mono, Consolas, monospace",
      lineHeight: 1.35,
      fill: "#eef4fb",
      wrap: "none",
      ellipsis: true,
    }));
  } else if (object.kind === BUILTIN_OBJECT_KINDS.latex) {
    group.add(new Konva.Rect({
      width,
      height,
      fill: palette.surfaceFill,
      stroke: palette.surfaceStroke,
      strokeWidth: 1,
      cornerRadius: 4,
    }));
    group.add(new Konva.Text({
      x: 10,
      y: 10,
      width: width - 20,
      height: height - 20,
      text: boundedTextValue(object.props.source, "", MAX_RENDER_TEXT_CODE_UNITS),
      fontFamily: "Cambria Math, Times New Roman, serif",
      fontSize: fontSizeValue(object.style.fontSize, 22, 12),
      fontStyle: fontStyleValue(object.style.fontStyle, "normal"),
      fill: adaptiveInkColor(object.style.fill, DEFAULT_STROKE, theme),
      verticalAlign: "middle",
      align: "center",
    }));
  } else if (object.kind === BUILTIN_OBJECT_KINDS.image) {
    const placeholder = new Konva.Group();
    placeholder.add(new Konva.Rect({
      width,
      height,
      fill: palette.placeholderFill,
      stroke: palette.placeholderStroke,
      strokeWidth: 1,
      dash: [6, 4],
      cornerRadius: 3,
    }));
    const placeholderText = new Konva.Text({
      width,
      height,
      text: "Изображение синхронизируется",
      fill: palette.placeholderText,
      fontSize: 13,
      align: "center",
      verticalAlign: "middle",
    });
    placeholder.add(placeholderText);
    group.add(placeholder);

    const assetId = stringValue(object.props.assetId, "");
    const contentHash = typeof object.props.contentHash === "string" ? object.props.contentHash : null;
    if (assetId && resolveAssetUrl) {
      const showImage = (image: HTMLImageElement) => {
        if (!group.getStage()) return;
        const node = new Konva.Image({ image, width, height });
        placeholder.destroy();
        group.add(node);
        node.moveToBottom();
        invalidate();
      };
      const showError = () => {
        if (!group.getStage()) return;
        placeholderText.text("Image unavailable");
        invalidate();
      };
      if (decodedImages) {
        const release = decodedImages.acquire(assetId, contentHash, {
          onReady: showImage,
          onError: showError,
        });
        (group as ImageLeaseGroup)[IMAGE_CACHE_RELEASE] = release;
      } else {
        void Promise.resolve(resolveAssetUrl(assetId, contentHash)).then((url) => {
          if (!url || !group.getStage()) return;
          const image = new Image();
          image.decoding = "async";
          image.onload = () => {
            if (!group.getStage()) return;
            showImage(image);
          };
          image.onerror = showError;
          image.src = url;
        }).catch(showError);
      }
    }
  }

  group.setAttr("boardObjectId", object.id);
  return group;
}

export class KonvaBoardRenderer implements BoardRenderer {
  readonly element: HTMLDivElement;

  private readonly callbacks: BoardRendererCallbacks;
  private readonly options: RendererOptions;
  private readonly stage: Konva.Stage;
  private readonly gridLayer = new Konva.Layer({ listening: false });
  private readonly objectLayer = new Konva.Layer();
  private readonly previewLayer = new Konva.Layer();
  private readonly presenceLayer = new Konva.Layer({ listening: false });
  private readonly objectWorld = new Konva.Group();
  private readonly interactionScreen = new Konva.Group({ listening: false });
  private readonly previewWorld = new Konva.Group();
  private readonly presenceWorld = new Konva.Group();
  private readonly selectionOutline: Konva.Rect;
  private readonly selectionObjectOutlineWorld =
    new Konva.Group({ listening: false });
  private readonly selectionObjectOutlines = new Map<string, Konva.Line>();
  private readonly selectionObjectOutlineGeometry =
    new Map<string, SelectionObjectOutlineGeometry>();
  private readonly transformer: Konva.Transformer;
  private readonly spatial = new BoardSpatialIndex();
  private readonly eraserHits = new EraserHitIndex();
  private readonly objects = new Map<string, BoardObjectSnapshot>();
  private readonly nodes = new Map<string, Konva.Group>();
  private readonly visibleIds = new Set<string>();
  private readonly cursorMotions = new Map<number, CursorMotion>();
  private readonly remoteLaserTrails = new Map<number, RemoteLaserTrail>();
  private readonly presenceRenderEntries = new Map<number, PresenceRenderEntry>();
  private readonly touchPointers = new Map<number, BoardPoint>();
  private readonly pressedPointerIds = new Set<number>();
  private readonly capturedPointerTargets = new Map<number, Element>();
  private readonly resizeObserver: ResizeObserver;
  private readonly keyDown: (event: KeyboardEvent) => void;
  private readonly keyUp: (event: KeyboardEvent) => void;
  private readonly windowBlur: () => void;
  private readonly visibilityChange: () => void;
  private readonly legacyMouseMove = (event: MouseEvent): void => {
    const pointerId = this.activeMousePointerId;
    const button = this.activeMouseButton;
    if (pointerId === null || button === null) return;
    const buttonMask = button === 0 ? 1 : 4;
    if ((event.buttons & buttonMask) === 0) {
      this.handlePointerUp(event, pointerId, false);
      return;
    }
    this.handlePointerMove(event, pointerId, "mouse", true);
  };
  private readonly legacyMouseUp = (event: MouseEvent): void => {
    const pointerId = this.activeMousePointerId;
    if (pointerId === null || event.button !== this.activeMouseButton) return;
    this.handlePointerUp(event, pointerId, false);
  };
  private readonly decodedImages: DecodedImageCache | null;
  private currentTool: BoardTool = "select";
  private currentShapeKind: BoardShapeKind = "rectangle";
  private currentCreationStyle: Readonly<Record<string, unknown>> = {};
  private currentConnectorCurvature = 0;
  private currentCamera: BoardCamera = { x: 0, y: 0, zoom: 1 };
  private currentTheme: BoardTheme;
  private gridVisible: boolean;
  private inlineEditingObjectId: string | null = null;
  private selectedIds: string[] = [];
  private selectedIdSet = new Set<string>();
  private selectedIndexById = new Map<string, number>();
  private presences: readonly BoardPresence[] = [];
  private readOnly: boolean;
  private spacePressed = false;
  private laserModifierPressed = false;
  private penLaserPresentationActive = false;
  private activeGesture: ActiveGesture | null = null;
  private laserSession: LaserSession | null = null;
  private dragStart = new Map<string, BoardPoint>();
  private dragVisibleIds: string[] = [];
  private dragSelectionOutlineStart: BoardPoint | null = null;
  private orderDirty = true;
  private visibleReorderScheduled = false;
  private selectionNotificationScheduled = false;
  private viewportQueryBounds: ViewportBounds | null = null;
  private presenceExpiryTimer: number | null = null;
  private presenceAnimationFrame: number | null = null;
  private activeMousePointerId: number | null = null;
  private activeMouseButton: number | null = null;
  private lastMouseInputScreen: BoardPoint | null = null;
  private cancellingInteraction = false;
  private destroyed = false;
  private readonly lostPointerCapture = (event: PointerEvent): void => {
    this.capturedPointerTargets.delete(event.pointerId);
    this.pressedPointerIds.delete(event.pointerId);
    this.touchPointers.delete(event.pointerId);
    if (this.activeMousePointerId === event.pointerId) {
      this.clearActiveMousePointer();
    }
    if (this.gestureOwnsPointer(event.pointerId)) {
      this.cancelActiveGesture();
    }
  };

  constructor(
    element: HTMLDivElement,
    callbacks: BoardRendererCallbacks,
    options: RendererOptions = {},
  ) {
    this.element = element;
    this.callbacks = callbacks;
    this.options = options;
    this.currentTheme = options.theme ?? "light";
    this.gridVisible = options.gridVisible ?? true;
    this.decodedImages = options.resolveAssetUrl
      ? new DecodedImageCache(options.resolveAssetUrl)
      : null;
    this.readOnly = options.readOnly ?? false;
    this.stage = new Konva.Stage({
      container: element,
      width: Math.max(1, element.clientWidth),
      height: Math.max(1, element.clientHeight),
    });
    const gridShape = new Konva.Shape({
      listening: false,
      sceneFunc: (context) => {
        const width = this.stage.width();
        const height = this.stage.height();
        const { x, y, zoom } = this.currentCamera;
        const palette = themePalette(this.currentTheme);
        const logicalMinor = zoom < 0.3 ? 100 : 20;
        const minor = logicalMinor * zoom;
        const major = minor * 5;
        context.save();
        context.fillStyle = palette.background;
        context.fillRect(0, 0, width, height);
        if (!this.gridVisible) {
          context.restore();
          return;
        }
        const draw = (spacing: number, color: string, lineWidth: number) => {
          context.beginPath();
          const offsetX = ((x % spacing) + spacing) % spacing;
          const offsetY = ((y % spacing) + spacing) % spacing;
          for (let lineX = offsetX; lineX <= width; lineX += spacing) {
            context.moveTo(Math.round(lineX) + 0.5, 0);
            context.lineTo(Math.round(lineX) + 0.5, height);
          }
          for (let lineY = offsetY; lineY <= height; lineY += spacing) {
            context.moveTo(0, Math.round(lineY) + 0.5);
            context.lineTo(width, Math.round(lineY) + 0.5);
          }
          context.strokeStyle = color;
          context.lineWidth = lineWidth;
          context.stroke();
        };
        if (minor >= 8) draw(minor, palette.minorGrid, 1);
        if (major >= 20) draw(major, palette.majorGrid, 1);
        context.restore();
      },
    });
    this.gridLayer.add(gridShape);
    this.objectLayer.add(this.objectWorld);
    this.previewLayer.add(this.interactionScreen, this.previewWorld);
    this.presenceLayer.add(this.presenceWorld);
    this.selectionOutline = new Konva.Rect({
      listening: false,
      visible: false,
      perfectDrawEnabled: false,
    });
    const palette = themePalette(this.currentTheme);
    this.transformer = new Konva.Transformer({
      rotateEnabled: true,
      borderStroke: palette.accent,
      borderStrokeWidth: TRANSFORMER_STROKE_WIDTH_PX,
      anchorFill: palette.transformerAnchor,
      anchorStroke: palette.accent,
      anchorStrokeWidth: TRANSFORMER_STROKE_WIDTH_PX,
      anchorSize: TRANSFORMER_ANCHOR_SIZE_PX,
      anchorCornerRadius: 2,
      padding: TRANSFORMER_PADDING_PX,
      rotationSnapTolerance: TRANSFORMER_ROTATION_SNAP_TOLERANCE_DEGREES,
      flipEnabled: false,
      ignoreStroke: true,
      boundBoxFunc: (oldBox, newBox) =>
        Math.abs(newBox.width) < 4 || Math.abs(newBox.height) < 4 ? oldBox : newBox,
    });
    this.transformer.anchorDragBoundFunc((_oldPosition, newPosition, event) => {
      if (this.transformer.getActiveAnchor() === "rotater") {
        this.transformer.rotationSnaps(event.shiftKey
          ? TRANSFORMER_ROTATION_SNAPS_DEGREES
          : TRANSFORMER_FREE_ROTATION_SNAPS);
      }
      return newPosition;
    });
    this.previewWorld.add(
      this.selectionOutline,
      this.selectionObjectOutlineWorld,
      this.transformer,
    );
    this.transformer.on("transformstart.eduri", () => {
      this.callbacks.onTransformStart();
    });
    this.transformer.on("transform.eduriSelection", () => {
      this.updateSelectionObjectOutlines(this.selectionChromeVisible());
      this.previewLayer.batchDraw();
    });
    this.transformer.on("transformend.eduri", () => {
      this.transformer.rotationSnaps(TRANSFORMER_FREE_ROTATION_SNAPS);
      if (this.cancellingInteraction) return;
      const transforms = new Map<string, AtomicTransform>();
      for (const node of this.transformer.nodes()) {
        const id = node.getAttr("boardObjectId") as string;
        const object = this.objects.get(id);
        if (!object || !isBoardObjectMutable(object)) continue;
        const width = Math.max(4, Math.abs(object.transform[2] * node.scaleX()));
        const height = Math.max(4, Math.abs(object.transform[3] * node.scaleY()));
        node.scale({ x: 1, y: 1 });
        transforms.set(id, [
          node.x(),
          node.y(),
          width,
          height,
          node.rotation() * Math.PI / 180,
        ]);
      }
      if (transforms.size) this.callbacks.onTransformObjects(transforms);
    });
    this.stage.add(this.gridLayer, this.objectLayer, this.previewLayer, this.presenceLayer);

    this.stage.on("pointerdown", (event) => this.onPointerDown(event));
    this.stage.on("pointermove", (event) => this.onPointerMove(event));
    this.stage.on("pointerup pointercancel", (event) => this.onPointerUp(event));
    this.stage.on("contextmenu", (event) => this.onContextMenu(event));
    this.stage.on("pointerleave", () => this.callbacks.onCursorChange(null));
    this.element.addEventListener(
      "lostpointercapture",
      this.lostPointerCapture,
      true,
    );
    this.stage.on("dblclick dbltap", (event) => {
      if (this.readOnly) return;
      const objectId = objectIdFromTarget(event.target);
      const object = objectId ? this.objects.get(objectId) : undefined;
      if (object && isBoardObjectInlineEditable(object)) {
        this.callbacks.onEditObject(object.id);
      }
    });
    this.stage.on("wheel", (event) => this.onWheel(event));

    this.keyDown = (event) => {
      const commandKey = event.key === "Control" || event.key === "Meta";
      const laserModifierKey = event.key === "Alt";
      if (
        laserModifierKey
        && standaloneAltHeld(event)
        && (
          this.activeGesture !== null
          || (
            this.hasKeyboardContext()
            && !this.isTextEditingElement(event.target)
            && !this.isTextEditingElement(document.activeElement)
          )
        )
      ) {
        this.setLaserModifierPressed(true);
      }
      if (
        event.key === "Shift"
        && this.activeGesture?.kind === "marquee"
        && !this.activeGesture.touchSelection
      ) {
        this.activeGesture.touchSelection = true;
        this.scheduleSelectionGestureMembership(this.activeGesture);
      }
      if (
        commandKey
        && this.activeGesture?.kind === "drawing"
        && (
          this.activeGesture.tool === "pen"
          || this.activeGesture.tool === "highlighter"
        )
      ) {
        this.activeGesture.strokeMoveActive = true;
        this.updateCursor();
      }
      if (
        (event.key === "Control" || event.key === "Meta")
        && isSelectionGesture(this.activeGesture)
        && this.activeGesture.commandMoveArmed
      ) {
        this.activeGesture.commandMoveActive = true;
        this.updateCursor();
      }
      if (
        event.code === "Space"
        && this.hasKeyboardContext()
        && !this.isEditingElement(event.target)
        && !this.isEditingElement(document.activeElement)
      ) {
        this.spacePressed = true;
        this.updateCursor();
        event.preventDefault();
      }
    };
    this.keyUp = (event) => {
      const commandKey = event.key === "Control" || event.key === "Meta";
      if (event.key === "Alt") {
        this.setLaserModifierPressed(standaloneAltHeld(event));
      }
      if (
        event.key === "Shift"
        && this.activeGesture?.kind === "marquee"
        && this.activeGesture.touchSelection
        && !event.shiftKey
      ) {
        this.activeGesture.touchSelection = false;
        this.scheduleSelectionGestureMembership(this.activeGesture);
      }
      if (
        commandKey
        && this.activeGesture?.kind === "drawing"
        && this.activeGesture.strokeMoveActive
        && !event.ctrlKey
        && !event.metaKey
      ) {
        this.activeGesture.strokeMoveActive = false;
        this.updateCursor();
      }
      if (
        commandKey
        && isSelectionGesture(this.activeGesture)
        && !event.ctrlKey
        && !event.metaKey
      ) {
        this.activeGesture.commandMoveArmed = true;
        this.activeGesture.commandMoveActive = false;
        this.updateCursor();
      }
      if (event.code === "Space") {
        this.spacePressed = false;
        this.updateCursor();
      }
    };
    this.windowBlur = () => {
      this.cancelInteraction();
      this.setLaserModifierPressed(false);
    };
    this.visibilityChange = () => {
      if (document.visibilityState === "hidden") {
        this.cancelInteraction();
        this.setLaserModifierPressed(false);
      }
    };
    window.addEventListener("keydown", this.keyDown, { passive: false });
    window.addEventListener("keyup", this.keyUp);
    window.addEventListener("mousemove", this.legacyMouseMove, {
      capture: true,
      passive: false,
    });
    window.addEventListener("mouseup", this.legacyMouseUp, true);
    window.addEventListener("blur", this.windowBlur);
    document.addEventListener("visibilitychange", this.visibilityChange);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(element);
    this.setCamera({ x: this.stage.width() / 2, y: this.stage.height() / 2, zoom: 1 });
    this.updateCursor();
  }

  get camera(): BoardCamera {
    return this.currentCamera;
  }

  get selection(): readonly string[] {
    return this.selectedIds;
  }

  setTool(tool: BoardTool): void {
    if (this.currentTool === tool) return;
    this.cancelActiveGesture();
    this.clearLaserSession(false);
    this.currentTool = tool;
    this.previewLayer.batchDraw();
    this.updatePenLaserPresentation();
    this.updateCursor();
    this.updateDraggable();
    this.updateTransformer();
  }

  setShapeKind(kind: BoardShapeKind): void {
    this.currentShapeKind = kind;
  }

  setCreationStyle(style: Readonly<Record<string, unknown>>): void {
    this.currentCreationStyle = { ...style };
  }

  setConnectorCurvature(curvature: number): void {
    this.currentConnectorCurvature = Number.isFinite(curvature)
      ? Math.max(-1, Math.min(1, curvature))
      : 0;
  }

  setReadOnly(readOnly: boolean): void {
    if (this.readOnly === readOnly) return;
    this.readOnly = readOnly;
    if (readOnly) {
      this.cancelActiveGesture();
      this.clearLaserSession(false);
    }
    this.updatePenLaserPresentation();
    this.updateDraggable();
    this.updateTransformer();
  }

  setTheme(theme: BoardTheme): void {
    if (theme === this.currentTheme) return;
    this.currentTheme = theme;
    const palette = themePalette(theme);
    if (this.activeGesture?.kind === "eraser") {
      setEraserTrailColor(this.activeGesture, palette.eraserTrail);
    }
    this.refreshLocalLaserAppearance();
    this.transformer.setAttrs({
      borderStroke: palette.accent,
      anchorFill: palette.transformerAnchor,
      anchorStroke: palette.accent,
    });
    for (const node of this.nodes.values()) releaseRenderedObjectNode(node);
    this.nodes.clear();
    this.visibleIds.clear();
    this.viewportQueryBounds = null;
    this.orderDirty = true;
    this.drawGrid();
    this.refreshViewport(true);
    this.applyActiveEraserPreview();
    if (isSelectionGesture(this.activeGesture)) {
      this.updateTransformer();
      this.scheduleSelectionGestureMembership(this.activeGesture);
    }
    this.syncPresenceScene();
    this.renderPresence();
    this.previewLayer.batchDraw();
  }

  setGridVisible(visible: boolean): void {
    if (this.gridVisible === visible) return;
    this.gridVisible = visible;
    this.drawGrid();
  }

  setObjects(objects: readonly BoardObjectSnapshot[]): void {
    this.objects.clear();
    for (const object of objects) this.objects.set(object.id, object);
    if (
      this.inlineEditingObjectId
      && this.objects.get(this.inlineEditingObjectId)?.kind !== BUILTIN_OBJECT_KINDS.text
    ) {
      this.inlineEditingObjectId = null;
    }
    if (this.activeGesture?.kind === "eraser") {
      for (const id of this.activeGesture.objectIds) {
        const object = this.objects.get(id);
        if (!object || !isBoardObjectMutable(object)) {
          this.activeGesture.objectIds.delete(id);
        }
      }
    }
    this.clearUnsafeSelection();
    this.spatial.replace(objects);
    this.eraserHits.replace(objects.filter(isBoardObjectMutable));
    for (const node of this.nodes.values()) releaseRenderedObjectNode(node);
    this.nodes.clear();
    this.visibleIds.clear();
    this.viewportQueryBounds = null;
    this.orderDirty = true;
    this.refreshViewport(true);
    this.applyActiveEraserPreview();
    if (isSelectionGesture(this.activeGesture)) {
      // Bulk reconciliation can replace membership and renderer nodes while
      // the pointer is stationary. Refresh current chrome, then recalculate.
      this.updateTransformer();
      this.scheduleSelectionGestureMembership(this.activeGesture);
    }
    if (this.presences.length > 0) {
      this.syncPresenceScene();
      this.renderPresence();
    }
  }

  setObject(object: BoardObjectSnapshot): void {
    const previous = this.objects.get(object.id);
    const currentNode = this.nodes.get(object.id);
    const replacementIndex = currentNode?.zIndex();
    const wasVisible = this.visibleIds.has(object.id);
    this.objects.set(object.id, object);
    if (
      this.inlineEditingObjectId === object.id
      && object.kind !== BUILTIN_OBJECT_KINDS.text
    ) {
      this.inlineEditingObjectId = null;
    }
    const selectionChanged = this.selectedIdSet.has(object.id)
      && !isBoardObjectMutable(object)
      ? this.removeSelectedId(object.id)
      : false;
    if (selectionChanged) this.scheduleSelectionNotification();
    this.spatial.set(object);
    const mutable = isBoardObjectMutable(object);
    if (mutable) {
      this.eraserHits.set(object);
    } else {
      this.eraserHits.delete(object.id);
      if (this.activeGesture?.kind === "eraser") {
        this.activeGesture.objectIds.delete(object.id);
      }
    }
    if (currentNode) releaseRenderedObjectNode(currentNode);
    this.nodes.delete(object.id);
    const shouldBeVisible = this.viewportQueryBounds
      ? boundsIntersect(spatialItemForObject(object), this.viewportQueryBounds)
      : true;
    if (shouldBeVisible) {
      const node = this.materializeObjectNode(object);
      this.nodes.set(object.id, node);
      this.objectWorld.add(node);
      this.visibleIds.add(object.id);
      if (
        previous
        && previous.zRank === object.zRank
        && replacementIndex !== undefined
      ) {
        node.zIndex(Math.min(
          replacementIndex,
          this.objectWorld.getChildren().length - 1,
        ));
      } else {
        this.orderDirty = true;
        this.scheduleVisibleReorder();
      }
      node.draggable(this.nodeShouldBeDraggable(object.id, object));
      if (
        this.activeGesture?.kind === "eraser"
        && this.activeGesture.objectIds.has(object.id)
      ) this.applyEraserObjectPreview(object.id, true);
    } else {
      this.visibleIds.delete(object.id);
    }
    const visibilityChanged = wasVisible !== shouldBeVisible;
    if (
      visibilityChanged
      || this.selectedIdSet.has(object.id)
      || selectionChanged
      || (
        isSelectionGesture(this.activeGesture)
        && this.activeGesture.previewSelectionIdSet.has(object.id)
      )
    ) {
      this.updateTransformer();
    }
    if (wasVisible || shouldBeVisible) this.objectLayer.batchDraw();
    if (this.presences.some((presence) => presence.selectionIds.includes(object.id))) {
      this.syncPresenceScene();
      this.renderPresence();
    }
    if (isSelectionGesture(this.activeGesture)) {
      this.scheduleSelectionGestureMembership(this.activeGesture);
    }
  }

  deleteObject(id: string): void {
    if (this.activeGesture?.kind === "eraser") {
      this.activeGesture.objectIds.delete(id);
    }
    this.objects.delete(id);
    if (this.inlineEditingObjectId === id) this.inlineEditingObjectId = null;
    this.spatial.delete(id);
    this.eraserHits.delete(id);
    const node = this.nodes.get(id);
    if (node) releaseRenderedObjectNode(node);
    this.nodes.delete(id);
    this.visibleIds.delete(id);
    const presenceChanged = this.presences.some((presence) => presence.selectionIds.includes(id));
    if (this.removeSelectedId(id)) this.scheduleSelectionNotification();
    this.updateTransformer();
    this.objectLayer.batchDraw();
    if (presenceChanged) {
      this.syncPresenceScene();
      this.renderPresence();
    }
    if (isSelectionGesture(this.activeGesture)) {
      this.scheduleSelectionGestureMembership(this.activeGesture);
    }
  }

  setPresence(presences: readonly BoardPresence[]): void {
    this.updatePresenceMotion(presences);
    this.presences = presences;
    this.syncPresenceScene();
    this.renderPresence();
  }

  setSelection(ids: readonly string[]): void {
    const selectedIds = [...new Set(ids)].filter((id) => {
      const object = this.objects.get(id);
      return object !== undefined && isBoardObjectMutable(object);
    });
    if (
      selectedIds.length === this.selectedIds.length
      && selectedIds.every((id, index) => id === this.selectedIds[index])
    ) {
      return;
    }
    this.selectedIds = selectedIds;
    this.selectedIdSet = new Set(selectedIds);
    this.selectedIndexById = new Map(
      selectedIds.map((id, index) => [id, index]),
    );
    this.updateDraggable();
    this.updateTransformer();
  }

  setInlineEditingObject(id: string | null): void {
    const nextId = id && this.objects.get(id)?.kind === BUILTIN_OBJECT_KINDS.text
      ? id
      : null;
    if (this.inlineEditingObjectId === nextId) return;
    const previousId = this.inlineEditingObjectId;
    this.inlineEditingObjectId = nextId;
    if (previousId) {
      const previous = this.nodes.get(previousId);
      if (previous) this.applyInlineEditingPresentation(previous, previousId);
    }
    if (nextId) {
      const next = this.nodes.get(nextId);
      if (next) this.applyInlineEditingPresentation(next, nextId);
    }
    this.updateDraggable();
    this.updateTransformer();
    this.objectLayer.batchDraw();
  }

  setCamera(camera: BoardCamera): void {
    const previousZoom = this.currentCamera.zoom;
    const zoom = clampBoardZoom(camera.zoom);
    if (
      zoom !== previousZoom
      && this.activeGesture?.kind === "eraser"
    ) {
      this.cancelActiveGesture();
    }
    if (
      camera.x === this.currentCamera.x
      && camera.y === this.currentCamera.y
      && zoom === previousZoom
    ) {
      return;
    }
    this.currentCamera = { x: camera.x, y: camera.y, zoom };
    for (const world of [this.objectWorld, this.previewWorld, this.presenceWorld]) {
      world.position({ x: camera.x, y: camera.y });
      world.scale({ x: zoom, y: zoom });
    }
    this.drawGrid();
    this.refreshViewport();
    if (zoom !== previousZoom) {
      this.refreshLocalLaserAppearance();
      this.updateTransformer();
      if (isSelectionGesture(this.activeGesture)) {
        this.scheduleSelectionGestureMembership(this.activeGesture);
      }
      this.syncPresenceScene();
      this.renderPresence();
    }
    this.callbacks.onCameraChange(this.currentCamera);
  }

  fitToContent(): void {
    const bounds = this.spatial.allBounds();
    if (!bounds) {
      this.setCamera({ x: this.stage.width() / 2, y: this.stage.height() / 2, zoom: 1 });
      return;
    }
    const padding = 64;
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const zoom = clampBoardZoom(Math.min(
      (this.stage.width() - padding * 2) / width,
      (this.stage.height() - padding * 2) / height,
    ));
    this.setCamera({
      x: this.stage.width() / 2 - (bounds.minX + width / 2) * zoom,
      y: this.stage.height() / 2 - (bounds.minY + height / 2) * zoom,
      zoom,
    });
  }

  resize(): void {
    if (this.destroyed) return;
    const width = Math.max(1, this.element.clientWidth);
    const height = Math.max(1, this.element.clientHeight);
    if (this.stage.width() === width && this.stage.height() === height) return;
    this.stage.size({ width, height });
    this.drawGrid();
    this.refreshViewport();
  }

  private cancelNodeInteraction(): boolean {
    const active = this.transformer.isTransforming()
      || this.dragStart.size > 0
      || [...this.nodes.values()].some((node) => node.isDragging());
    if (!active) return false;

    const wasCancelling = this.cancellingInteraction;
    this.cancellingInteraction = true;
    try {
      if (this.transformer.isTransforming()) this.transformer.stopTransform();
      for (const node of this.nodes.values()) {
        if (node.isDragging()) node.stopDrag();
      }
      this.dragStart.clear();
      this.dragVisibleIds = [];
      this.dragSelectionOutlineStart = null;
      this.transformer.nodes([]);
      for (const node of this.nodes.values()) releaseRenderedObjectNode(node);
      this.nodes.clear();
      this.visibleIds.clear();
      this.viewportQueryBounds = null;
      this.orderDirty = true;
      this.refreshViewport(true);
    } finally {
      this.cancellingInteraction = wasCancelling;
    }
    this.callbacks.onTransformCancel();
    return true;
  }

  cancelInteraction(): void {
    if (this.destroyed || this.cancellingInteraction) return;
    this.clearActiveMousePointer();
    this.cancellingInteraction = true;
    try {
      this.cancelActiveGesture();
      this.clearLaserSession(false);
      this.cancelNodeInteraction();
      for (const pointerId of [...this.capturedPointerTargets.keys()]) {
        this.releasePointer(pointerId);
      }
      this.touchPointers.clear();
      this.pressedPointerIds.clear();
      this.dragStart.clear();
      this.dragVisibleIds = [];
      this.dragSelectionOutlineStart = null;
    } finally {
      this.cancellingInteraction = false;
    }
    this.resetSpaceHand();
    this.updateCursor();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.cancelActiveGesture();
    this.clearLaserSession(false);
    this.setLaserModifierPressed(false);
    this.destroyed = true;
    this.resizeObserver.disconnect();
    if (this.presenceExpiryTimer !== null) window.clearTimeout(this.presenceExpiryTimer);
    this.presenceExpiryTimer = null;
    if (this.presenceAnimationFrame !== null) cancelAnimationFrame(this.presenceAnimationFrame);
    this.presenceAnimationFrame = null;
    window.removeEventListener("keydown", this.keyDown);
    window.removeEventListener("keyup", this.keyUp);
    window.removeEventListener("mousemove", this.legacyMouseMove, true);
    window.removeEventListener("mouseup", this.legacyMouseUp, true);
    window.removeEventListener("blur", this.windowBlur);
    document.removeEventListener("visibilitychange", this.visibilityChange);
    this.element.removeEventListener(
      "lostpointercapture",
      this.lostPointerCapture,
      true,
    );
    for (const node of this.nodes.values()) releaseRenderedObjectNode(node);
    this.nodes.clear();
    this.selectionObjectOutlines.clear();
    this.selectionObjectOutlineGeometry.clear();
    this.presenceRenderEntries.clear();
    this.viewportQueryBounds = null;
    this.stage.destroy();
    this.decodedImages?.destroy();
  }

  private resetSpaceHand(): void {
    if (!this.spacePressed) return;
    this.spacePressed = false;
    this.updateCursor();
  }

  private setLaserModifierPressed(pressed: boolean): void {
    if (this.laserModifierPressed === pressed) {
      this.updatePenLaserPresentation();
      return;
    }
    this.laserModifierPressed = pressed;
    if (!pressed) {
      if (this.activeGesture?.kind === "laser") {
        this.activeGesture.session.releaseRequested = true;
      } else {
        this.clearLaserSession(true);
      }
    }
    this.updatePenLaserPresentation();
  }

  private updatePenLaserPresentation(): void {
    const active = this.currentTool === "pen" && (
      this.activeGesture?.kind === "laser"
      || (this.activeGesture === null && this.laserModifierPressed)
    );
    if (active === this.penLaserPresentationActive) return;
    this.penLaserPresentationActive = active;
    this.callbacks.onPenLaserModeChange?.(active);
  }

  private laserPreview(session: LaserSession): BoardLaserPreview | null {
    return boundedLaserPreview(session.strokes);
  }

  private emitLaserSession(session: LaserSession): void {
    this.callbacks.onLaserChange(this.laserPreview(session));
  }

  private clearLaserSession(animate: boolean): void {
    const session = this.laserSession;
    if (!session) return;
    this.laserSession = null;
    this.callbacks.onLaserChange(null, animate ? "fade" : "immediate");
    if (animate && !this.destroyed) {
      session.group.to({
        opacity: 0,
        duration: LASER_FADE_MS / 1_000,
        onFinish: () => session.group.destroy(),
      });
    } else {
      session.group.destroy();
    }
    this.updatePenLaserPresentation();
    this.previewLayer.batchDraw();
  }

  private refreshLocalLaserAppearance(): void {
    if (!this.laserSession) return;
    for (const stroke of this.laserSession.strokes) {
      applyLaserStrokeAppearance(
        stroke.preview,
        stroke.style,
        this.currentTheme,
        this.currentCamera.zoom,
      );
    }
  }

  private clearActiveMousePointer(): void {
    this.activeMousePointerId = null;
    this.activeMouseButton = null;
    this.lastMouseInputScreen = null;
  }

  private isEditingElement(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    const interactive = target.closest(
      "input, textarea, button, select, [contenteditable], [role=menu]",
    );
    return Boolean(
      interactive
      && (
        !interactive.hasAttribute("contenteditable")
        || interactive.getAttribute("contenteditable") !== "false"
      ),
    );
  }

  private isTextEditingElement(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    const editable = target.closest(
      "input, textarea, select, [contenteditable]",
    );
    return Boolean(
      editable
      && (
        !editable.hasAttribute("contenteditable")
        || editable.getAttribute("contenteditable") !== "false"
      ),
    );
  }

  private hasKeyboardContext(): boolean {
    const root = this.element.closest(".board-v2") ?? this.element;
    const activeElement = document.activeElement;
    return activeElement instanceof Element && root.contains(activeElement);
  }

  private screenPointer(): BoardPoint | null {
    const point = this.stage.getPointerPosition();
    return point ? { x: point.x, y: point.y } : null;
  }

  private updateCursor(): void {
    const movingStroke = this.activeGesture?.kind === "drawing"
      && this.activeGesture.strokeMoveActive;
    const movingSelection = isSelectionGesture(this.activeGesture)
      && this.activeGesture.commandMoveActive;
    const cursor = this.spacePressed
      || this.currentTool === "hand"
      || movingStroke
      || movingSelection
      ? (
          this.activeGesture?.kind === "pan" || movingStroke || movingSelection
            ? "grabbing"
            : "grab"
        )
      : this.currentTool === "select"
        ? "default"
        : this.currentTool === "text"
          ? "text"
          : this.currentTool === "eraser"
            ? "cell"
            : "crosshair";
    this.element.style.cursor = cursor;
  }

  private capturePointer(event: PointerEvent): void {
    const target = event.target;
    if (!(target instanceof Element) || typeof target.setPointerCapture !== "function") return;
    try {
      target.setPointerCapture(event.pointerId);
      this.capturedPointerTargets.set(event.pointerId, target);
    } catch {
      // Pointer capture is best-effort; window-level pointer delivery varies by browser.
    }
  }

  private releasePointer(pointerId: number): void {
    const target = this.capturedPointerTargets.get(pointerId);
    this.capturedPointerTargets.delete(pointerId);
    if (!target || typeof target.releasePointerCapture !== "function") return;
    try {
      if (
        typeof target.hasPointerCapture !== "function"
        || target.hasPointerCapture(pointerId)
      ) {
        target.releasePointerCapture(pointerId);
      }
    } catch {
      // The browser may have implicitly released capture before pointerup is handled.
    }
  }

  private gesturePointerIds(gesture: ActiveGesture): readonly number[] {
    return gesture.kind === "pinch" ? gesture.pointerIds : [gesture.pointerId];
  }

  private gestureOwnsPointer(pointerId: number): boolean {
    return this.activeGesture !== null
      && this.gesturePointerIds(this.activeGesture).includes(pointerId);
  }

  private startPinch(): boolean {
    const pointers = [...this.touchPointers.entries()].slice(0, 2);
    if (pointers.length !== 2) return false;
    if (
      this.activeGesture
      && this.activeGesture.kind !== "pinch"
      && !this.touchPointers.has(this.activeGesture.pointerId)
    ) {
      return false;
    }
    if (this.activeGesture?.kind === "pinch") return true;

    this.cancelActiveGesture(false);
    this.cancelNodeInteraction();
    const [[firstId, first], [secondId, second]] = pointers;
    this.activeGesture = {
      kind: "pinch",
      pointerIds: [firstId, secondId],
      distance: Math.max(1, distance(first, second)),
      center: midpoint(first, second),
      camera: this.currentCamera,
    };
    this.updateDraggable();
    this.updateCursor();
    return true;
  }

  private onContextMenu(
    event: Konva.KonvaEventObject<PointerEvent>,
  ): void {
    const nativeEvent = event.evt;
    nativeEvent.preventDefault();
    const screen = screenPointFromPointer(nativeEvent, this.element);
    const target = event.target as Konva.Node;
    const targetIsTransformer = target === this.transformer
      || this.transformer.isAncestorOf(target);
    const objectId = objectIdFromTarget(target)
      ?? (targetIsTransformer ? this.selectedIds[0] ?? null : null);
    const request = {
      screen,
      world: worldPoint(screen, this.currentCamera),
      objectId,
    };
    this.cancelInteraction();
    this.callbacks.onContextMenu(request);
  }

  private suspendSelectionDragging(): void {
    for (const node of this.nodes.values()) {
      if (node.draggable()) node.draggable(false);
    }
    this.transformer.listening(false);
  }

  private startSelectionGesture(
    nativeEvent: PointerEvent,
    pointerType: string,
    point: BoardPoint,
    screen: BoardPoint,
    mode: "marquee" | "lasso",
    additive: boolean,
    commandHeldAtStart: boolean,
  ): void {
    const palette = themePalette(this.currentTheme);
    const common = {
      stroke: palette.accent,
      strokeWidth: 1.25 / this.currentCamera.zoom,
      fill: this.currentTheme === "dark"
        ? "rgba(132,162,255,0.14)"
        : "rgba(49,94,251,0.08)",
      dash: [5 / this.currentCamera.zoom, 4 / this.currentCamera.zoom],
      listening: false,
    };
    const base = {
      pointerId: nativeEvent.pointerId,
      pointerType,
      startScreen: screen,
      baseSelection: [...this.selectedIds],
      additive,
      previousScreen: screen,
      offset: { x: 0, y: 0 },
      commandMoveArmed: !commandHeldAtStart,
      commandMoveActive: false,
      previewSelectionIds: additive ? [...this.selectedIds] : [],
      previewSelectionIdSet: new Set(additive ? this.selectedIds : []),
      membershipAnimationFrame: null,
    };
    if (mode === "lasso") {
      const preview = new Konva.Line({
        ...common,
        points: [point.x, point.y],
        closed: true,
        fillRule: "evenodd",
        lineCap: "round",
        lineJoin: "round",
      });
      this.previewWorld.add(preview);
      this.activeGesture = {
        ...base,
        kind: "lasso",
        points: [point],
        previewPoints: [point.x, point.y],
        sampleDistancePx: LASSO_POINT_DISTANCE_PX,
        preview,
      };
    } else {
      const preview = new Konva.Rect({
        ...common,
        x: point.x,
        y: point.y,
        width: 1,
        height: 1,
      });
      this.previewWorld.add(preview);
      this.activeGesture = {
        ...base,
        kind: "marquee",
        start: point,
        end: point,
        touchSelection: nativeEvent.shiftKey,
        preview,
      };
    }
    this.suspendSelectionDragging();
    this.updateTransformer();
    this.capturePointer(nativeEvent);
    nativeEvent.preventDefault();
    this.previewLayer.batchDraw();
  }

  private startLaserGesture(
    nativeEvent: PointerEvent,
    pointerType: string,
    point: BoardPoint,
  ): void {
    if (this.laserSession?.releaseRequested) {
      this.clearLaserSession(true);
    }
    let session = this.laserSession;
    if (!session) {
      session = {
        group: new Konva.Group({ listening: false }),
        strokes: [],
        releaseRequested: false,
      };
      this.previewWorld.add(session.group);
      this.laserSession = session;
    }

    const style = laserStyle(this.currentCreationStyle);
    const preview = makeLaserStrokePreview(
      point,
      style,
      this.currentTheme,
      this.currentCamera.zoom,
    );
    const stroke: LocalLaserStroke = {
      points: [{ ...point }],
      previewPoints: [point.x, point.y],
      style,
      preview,
    };
    session.strokes.push(stroke);
    session.group.add(preview);
    this.activeGesture = {
      kind: "laser",
      pointerId: nativeEvent.pointerId,
      pointerType,
      session,
      stroke,
    };
    this.capturePointer(nativeEvent);
    nativeEvent.preventDefault();
    this.emitLaserSession(session);
    this.updatePenLaserPresentation();
    this.updateCursor();
    this.previewLayer.batchDraw();
  }

  private onPointerDown(event: Konva.KonvaEventObject<PointerEvent>): void {
    const nativeEvent = event.evt;
    if (nativeEvent.button !== 0 && nativeEvent.button !== 1) return;
    this.pressedPointerIds.add(nativeEvent.pointerId);
    const screen = screenPointFromPointer(nativeEvent, this.element);
    const pointerType = pointerTypeFromEvent(nativeEvent);
    if (pointerType === "mouse") {
      this.activeMousePointerId = nativeEvent.pointerId;
      this.activeMouseButton = nativeEvent.button;
      this.lastMouseInputScreen = screen;
    }
    if (pointerType === "touch") {
      this.touchPointers.set(nativeEvent.pointerId, screen);
      this.capturePointer(nativeEvent);
      if (this.touchPointers.size >= 2) {
        if (this.startPinch()) nativeEvent.preventDefault();
        return;
      }
    }
    if (this.activeGesture) return;

    const commandHeldAtStart = commandModifierHeld(nativeEvent);
    const laserHeldAtStart = standaloneAltHeld(nativeEvent);
    this.setLaserModifierPressed(laserHeldAtStart);
    const point = worldPoint(screen, this.currentCamera);
    const target = event.target as Konva.Node;
    const targetIsTransformer = target === this.transformer
      || this.transformer.isAncestorOf(target);
    const objectId = objectIdFromTarget(target);
    const panRequested = this.spacePressed || this.currentTool === "hand" || nativeEvent.button === 1;
    if (panRequested) {
      nativeEvent.preventDefault();
      this.activeGesture = {
        kind: "pan",
        pointerId: nativeEvent.pointerId,
        pointerType,
        screen,
        camera: this.currentCamera,
      };
      this.updateDraggable();
      this.capturePointer(nativeEvent);
      this.updateCursor();
      return;
    }

    if (this.currentTool === "select") {
      const lassoRequested = standaloneAltHeld(nativeEvent);
      const forceCanvasSelection = commandHeldAtStart || lassoRequested;
      const additiveSelection = nativeEvent.shiftKey;
      if (targetIsTransformer && !forceCanvasSelection) return;
      if (forceCanvasSelection || !objectId) {
        this.cancelNodeInteraction();
        this.startSelectionGesture(
          nativeEvent,
          pointerType,
          point,
          screen,
          lassoRequested ? "lasso" : "marquee",
          additiveSelection,
          commandHeldAtStart,
        );
        return;
      }
      const object = this.objects.get(objectId);
      if (!object || !isBoardObjectMutable(object)) {
        if (!additiveSelection) this.changeSelection([]);
        return;
      }
      if (additiveSelection) {
        this.changeSelection(this.selectedIdSet.has(objectId)
          ? this.selectedIds.filter((id) => id !== objectId)
          : [...this.selectedIds, objectId]);
      } else if (!this.selectedIdSet.has(objectId)) {
        this.changeSelection([objectId]);
      }
      return;
    }

    if (
      this.readOnly
      && !(this.currentTool === "pen" && laserHeldAtStart)
    ) return;
    if (this.currentTool === "hand") return;
    if (this.currentTool === "eraser") {
      const trailPreview = makeEraserTrailPreview(
        themePalette(this.currentTheme).eraserTrail,
      );
      const trailSamples: EraserTrailSample[] = [];
      const animationTime = performance.now();
      const trailAnimationState = createEraserTrailAnimationState(animationTime);
      appendEraserTrailSample(
        trailSamples,
        screen,
        animationTime,
        trailAnimationState,
      );
      const gesture: EraserGesture = {
        kind: "eraser",
        pointerId: nativeEvent.pointerId,
        pointerType,
        objectIds: new Set(),
        trail: trailPreview.root,
        trailBody: trailPreview.body,
        trailFootprint: trailPreview.footprint,
        trailSamples,
        trailAnimationState,
        trailAnimationFrame: null,
        previousScreen: screen,
        previousWorld: point,
      };
      this.interactionScreen.add(gesture.trail);
      this.activeGesture = gesture;
      this.syncEraserTrail(gesture, animationTime);
      this.capturePointer(nativeEvent);
      nativeEvent.preventDefault();
      if (
        this.updateEraserMarks(
          gesture,
          screen,
          eraserModeFromEvent(nativeEvent),
        )
      ) {
        this.objectLayer.batchDraw();
      }
      this.previewLayer.batchDraw();
      return;
    }
    if (this.currentTool === "pen" && laserHeldAtStart) {
      this.startLaserGesture(nativeEvent, pointerType, point);
      return;
    }

    if (isPlacementTool(this.currentTool)) {
      this.activeGesture = {
        kind: "placement",
        pointerId: nativeEvent.pointerId,
        pointerType,
        tool: this.currentTool,
        point,
        startScreen: screen,
        maximumTravelPx: 0,
      };
      this.capturePointer(nativeEvent);
      nativeEvent.preventDefault();
      return;
    }

    const drawingTool = this.currentTool === "shape"
      ? this.currentShapeKind
      : this.currentTool;
    const style = drawingStyle(drawingTool, this.currentCreationStyle);
    const preview = makeDrawingPreview(
      drawingTool,
      point,
      style,
      this.currentTheme,
    );
    this.previewWorld.add(preview);
    this.activeGesture = {
      kind: "drawing",
      pointerId: nativeEvent.pointerId,
      pointerType,
      tool: drawingTool,
      style,
      start: point,
      points: [{ ...point, pressure: pointerPressure(nativeEvent) }],
      previewAwarenessPoints: [point],
      previewPoints: [point.x, point.y],
      preview,
      previousScreen: screen,
      strokeOffset: { x: 0, y: 0 },
      straightPointActive: false,
      strokeMoveActive: false,
      connectorCurvature: this.currentConnectorCurvature,
      fixedConnectorControl: null,
    };
    this.capturePointer(nativeEvent);
    nativeEvent.preventDefault();
    this.emitDrawingGesturePreview(this.activeGesture, point);
    this.previewLayer.batchDraw();
  }

  private compactLassoGesture(gesture: LassoGesture): void {
    const compacted = compactLassoPoints(
      gesture.points,
      MAX_LASSO_POINTS / 2,
      gesture.sampleDistancePx / this.currentCamera.zoom,
    );
    gesture.points = compacted;
    gesture.previewPoints = flattenedPoints(compacted);
    gesture.sampleDistancePx *= 2;
  }

  private appendLassoPoint(
    gesture: LassoGesture,
    point: BoardPoint,
  ): boolean {
    const gesturePoint = {
      x: point.x - gesture.offset.x,
      y: point.y - gesture.offset.y,
    };
    const previous = gesture.points.at(-1);
    if (
      previous
      && distance(previous, gesturePoint) * this.currentCamera.zoom
        < gesture.sampleDistancePx
    ) {
      return false;
    }
    if (gesture.points.length >= MAX_LASSO_POINTS) {
      this.compactLassoGesture(gesture);
      const compactedPrevious = gesture.points.at(-1);
      if (
        compactedPrevious
        && distance(compactedPrevious, gesturePoint) * this.currentCamera.zoom
          < gesture.sampleDistancePx
      ) {
        return false;
      }
    }
    gesture.points.push(gesturePoint);
    gesture.previewPoints.push(gesturePoint.x, gesturePoint.y);
    return true;
  }

  private syncSelectionGesturePreview(gesture: SelectionGesture): void {
    if (gesture.kind === "marquee") {
      const transform = normalizedTransform(gesture.start, gesture.end);
      gesture.preview.setAttrs({
        x: transform[0] + gesture.offset.x,
        y: transform[1] + gesture.offset.y,
        width: transform[2],
        height: transform[3],
      });
      return;
    }
    gesture.preview.setAttrs({
      points: gesture.previewPoints,
      x: gesture.offset.x,
      y: gesture.offset.y,
    });
  }

  private selectionGestureMatchedIds(
    gesture: SelectionGesture,
    canonicalOrder: boolean,
  ): string[] {
    let matched: string[] = [];
    if (gesture.kind === "marquee") {
      const extentPx = distance(gesture.start, gesture.end)
        * this.currentCamera.zoom;
      if (extentPx < MARQUEE_THRESHOLD_PX) return [];
      const transform = normalizedTransform(gesture.start, gesture.end);
      const bounds = {
        minX: transform[0] + gesture.offset.x,
        minY: transform[1] + gesture.offset.y,
        maxX: transform[0] + gesture.offset.x + transform[2],
        maxY: transform[1] + gesture.offset.y + transform[3],
      };
      if (gesture.touchSelection) {
        matched = this.eraserHits.searchBounds(bounds)
          .filter(({ geometry }) =>
            selectionRectangleTouchesGeometry(bounds, geometry))
          .map(({ id }) => id);
      } else {
        matched = this.eraserHits.searchContained(bounds);
      }
    } else {
      const translated = gesture.points.map((point) => ({
        x: point.x + gesture.offset.x,
        y: point.y + gesture.offset.y,
      }));
      const region = new LassoSelectionRegion(translated);
      if (!region.bounds || !region.hasArea) return [];
      const extentPx = Math.hypot(
        region.bounds.maxX - region.bounds.minX,
        region.bounds.maxY - region.bounds.minY,
      ) * this.currentCamera.zoom;
      if (extentPx < MARQUEE_THRESHOLD_PX) return [];
      matched = this.selectionRegionMatchedIds(region);
    }

    const objects = [...new Set(matched)]
      .map((id) => this.objects.get(id))
      .filter((object): object is BoardObjectSnapshot =>
        object !== undefined && isBoardObjectMutable(object));
    if (canonicalOrder) objects.sort(compareBoardObjectZOrder);
    return objects.map((object) => object.id);
  }

  private selectionRegionMatchedIds(region: LassoSelectionRegion): string[] {
    if (!region.bounds || !region.hasArea) return [];
    return this.eraserHits.searchBounds(
      region.bounds,
      (candidate) => region.touchesBounds(candidate),
    )
      .filter(({ geometry }) => region.touchesGeometry(geometry))
      .map(({ id }) => id);
  }

  private selectionGestureResultIds(
    gesture: SelectionGesture,
    canonicalOrder: boolean,
  ): string[] {
    const matched = this.selectionGestureMatchedIds(gesture, canonicalOrder);
    if (!gesture.additive) return matched;
    const retainedBase = gesture.baseSelection.filter((id) => {
      const object = this.objects.get(id);
      return object !== undefined && isBoardObjectMutable(object);
    });
    return [...new Set([...retainedBase, ...matched])];
  }

  private syncSelectionGestureMembership(gesture: SelectionGesture): boolean {
    const ids = this.selectionGestureResultIds(gesture, false);
    if (
      ids.length === gesture.previewSelectionIds.length
      && ids.every((id) => gesture.previewSelectionIdSet.has(id))
    ) {
      return false;
    }
    gesture.previewSelectionIds = ids;
    gesture.previewSelectionIdSet = new Set(ids);
    this.updateTransformer();
    return true;
  }

  private scheduleSelectionGestureMembership(gesture: SelectionGesture): void {
    if (
      gesture.membershipAnimationFrame !== null
      || this.destroyed
      || this.activeGesture !== gesture
    ) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (gesture.membershipAnimationFrame !== frame) return;
      gesture.membershipAnimationFrame = null;
      if (this.destroyed || this.activeGesture !== gesture) return;
      this.syncSelectionGestureMembership(gesture);
    });
    gesture.membershipAnimationFrame = frame;
  }

  private cancelSelectionGestureMembership(gesture: SelectionGesture): void {
    if (gesture.membershipAnimationFrame === null) return;
    cancelAnimationFrame(gesture.membershipAnimationFrame);
    gesture.membershipAnimationFrame = null;
  }

  private updateSelectionGesture(
    gesture: SelectionGesture,
    nativeEvent: PointerEvent | MouseEvent,
    screenTransform: PointerScreenTransform,
    screen: BoardPoint,
  ): boolean {
    let changed = false;
    if (
      gesture.kind === "marquee"
      && gesture.touchSelection !== nativeEvent.shiftKey
    ) {
      gesture.touchSelection = nativeEvent.shiftKey;
      changed = true;
    }
    const commandHeld = commandModifierHeld(nativeEvent);
    if (!gesture.commandMoveArmed && !commandHeld) {
      gesture.commandMoveArmed = true;
    }
    if (gesture.commandMoveArmed && commandHeld) {
      const deltaX = (
        screen.x - gesture.previousScreen.x
      ) / this.currentCamera.zoom;
      const deltaY = (
        screen.y - gesture.previousScreen.y
      ) / this.currentCamera.zoom;
      const modeChanged = !gesture.commandMoveActive;
      gesture.commandMoveActive = true;
      gesture.previousScreen = screen;
      if (modeChanged) this.updateCursor();
      if (deltaX === 0 && deltaY === 0) return changed;
      gesture.offset = {
        x: gesture.offset.x + deltaX,
        y: gesture.offset.y + deltaY,
      };
      this.syncSelectionGesturePreview(gesture);
      return true;
    }

    if (gesture.commandMoveActive) {
      gesture.commandMoveActive = false;
      this.updateCursor();
    }
    gesture.previousScreen = screen;
    if (gesture.kind === "marquee") {
      const point = worldPoint(screen, this.currentCamera);
      const next = {
        x: point.x - gesture.offset.x,
        y: point.y - gesture.offset.y,
      };
      if (next.x === gesture.end.x && next.y === gesture.end.y) return changed;
      gesture.end = next;
      this.syncSelectionGesturePreview(gesture);
      return true;
    }

    for (const sample of pointerSamples(nativeEvent)) {
      const sampledScreen = screenPointFromPointer(
        sample,
        this.element,
        screenTransform,
      );
      changed = this.appendLassoPoint(
        gesture,
        worldPoint(sampledScreen, this.currentCamera),
      ) || changed;
    }
    if (changed) this.syncSelectionGesturePreview(gesture);
    return changed;
  }

  private onPointerMove(event: Konva.KonvaEventObject<PointerEvent>): void {
    const nativeEvent = event.evt;
    this.handlePointerMove(
      nativeEvent,
      nativeEvent.pointerId,
      pointerTypeFromEvent(nativeEvent),
    );
  }

  private updateLaserGesture(
    gesture: LaserGesture,
    nativeEvent: PointerEvent | MouseEvent,
    screenTransform: PointerScreenTransform,
  ): boolean {
    let changed = false;
    for (const sample of pointerSamples(nativeEvent)) {
      const sampledScreen = screenPointFromPointer(
        sample,
        this.element,
        screenTransform,
      );
      const point = worldPoint(sampledScreen, this.currentCamera);
      const previous = gesture.stroke.points.at(-1);
      if (
        previous
        && distance(previous, point) < 2 / this.currentCamera.zoom
      ) {
        continue;
      }
      appendBoundedGesturePoint(gesture.stroke.points, point);
      changed = true;
    }
    if (!changed) return false;
    gesture.stroke.previewPoints = flattenedPoints(gesture.stroke.points);
    gesture.stroke.preview.points(gesture.stroke.previewPoints);
    this.emitLaserSession(gesture.session);
    this.previewLayer.batchDraw();
    return true;
  }

  private handlePointerMove(
    nativeEvent: PointerEvent | MouseEvent,
    pointerId: number,
    pointerType: string,
    compatibilityEvent = false,
  ): void {
    const screenTransform = pointerScreenTransform(this.element);
    const screen = screenPointFromPointer(
      nativeEvent,
      this.element,
      screenTransform,
    );
    const gesture = this.activeGesture;
    if (
      compatibilityEvent
      && pointerType === "mouse"
      && this.activeMousePointerId === pointerId
      && this.lastMouseInputScreen?.x === screen.x
      && this.lastMouseInputScreen.y === screen.y
    ) {
      return;
    }
    if (pointerType === "touch") {
      this.touchPointers.set(pointerId, screen);
    }
    const point = worldPoint(screen, this.currentCamera);
    this.callbacks.onCursorChange(point);
    if (pointerType === "mouse" && this.activeMousePointerId === pointerId) {
      this.lastMouseInputScreen = screen;
    }
    if (!gesture) return;
    if (gesture.kind === "pinch") {
      if (!gesture.pointerIds.includes(pointerId)) return;
      nativeEvent.preventDefault();
      const first = this.touchPointers.get(gesture.pointerIds[0]);
      const second = this.touchPointers.get(gesture.pointerIds[1]);
      if (!first || !second) return;
      const center = midpoint(first, second);
      const anchor = worldPoint(gesture.center, gesture.camera);
      const zoom = clampBoardZoom(
        gesture.camera.zoom * distance(first, second) / gesture.distance,
      );
      this.setCamera({
        x: center.x - anchor.x * zoom,
        y: center.y - anchor.y * zoom,
        zoom,
      });
      return;
    }
    if (gesture.pointerId !== pointerId) return;
    nativeEvent.preventDefault();
    this.setLaserModifierPressed(standaloneAltHeld(nativeEvent));

    if (gesture.kind === "pan") {
      this.setCamera({
        x: gesture.camera.x + screen.x - gesture.screen.x,
        y: gesture.camera.y + screen.y - gesture.screen.y,
        zoom: gesture.camera.zoom,
      });
      return;
    }
    if (gesture.kind === "placement") {
      gesture.maximumTravelPx = Math.max(
        gesture.maximumTravelPx,
        distance(gesture.startScreen, screen),
      );
      return;
    }
    if (gesture.kind === "laser") {
      this.updateLaserGesture(gesture, nativeEvent, screenTransform);
      return;
    }
    if (gesture.kind === "eraser") {
      let objectsChanged = false;
      let trailChanged = false;
      const animationTime = performance.now();
      const deliveredSamples = pointerSamples(nativeEvent);
      const includeCurrentEvent = deliveredSamples.at(-1) !== nativeEvent;
      const trailTimes = pointerAnimationTimes(
        deliveredSamples.length + (includeCurrentEvent ? 1 : 0),
        gesture.trailSamples.at(-1)?.at ?? animationTime,
        animationTime,
      );
      for (let index = 0; index < deliveredSamples.length; index += 1) {
        const sample = deliveredSamples[index];
        const sampleScreen = screenPointFromPointer(
          sample,
          this.element,
          screenTransform,
        );
        trailChanged = advanceEraserTrailSamples(
          gesture.trailSamples,
          gesture.trailAnimationState,
          trailTimes[index],
        ) || trailChanged;
        trailChanged = appendEraserTrailSample(
          gesture.trailSamples,
          sampleScreen,
          trailTimes[index],
          gesture.trailAnimationState,
        )
          || trailChanged;
        objectsChanged = this.updateEraserMarks(
          gesture,
          sampleScreen,
          eraserModeFromEvent(sample, Boolean(nativeEvent.altKey)),
        ) || objectsChanged;
      }
      if (includeCurrentEvent) {
        trailChanged = advanceEraserTrailSamples(
          gesture.trailSamples,
          gesture.trailAnimationState,
          trailTimes[trailTimes.length - 1],
        ) || trailChanged;
        trailChanged = appendEraserTrailSample(
          gesture.trailSamples,
          screen,
          trailTimes[trailTimes.length - 1],
          gesture.trailAnimationState,
        ) || trailChanged;
      }
      objectsChanged = this.updateEraserMarks(
        gesture,
        screen,
        eraserModeFromEvent(nativeEvent),
      ) || objectsChanged;
      if (objectsChanged) this.objectLayer.batchDraw();
      if (trailChanged) this.scheduleEraserTrailFrame(gesture);
      return;
    }
    if (isSelectionGesture(gesture)) {
      const changed = this.updateSelectionGesture(
        gesture,
        nativeEvent,
        screenTransform,
        screen,
      );
      if (changed) {
        this.scheduleSelectionGestureMembership(gesture);
        this.previewLayer.batchDraw();
      }
      return;
    }
    if (gesture.tool === "pen" || gesture.tool === "highlighter") {
      const result = this.updateFreehandGesture(
        gesture,
        nativeEvent,
        screenTransform,
        screen,
      );
      if (result === "unchanged") return;
      const end = gesture.points.at(-1) ?? point;
      updateDrawingPreview(gesture, end);
      this.emitDrawingGesturePreview(gesture, end);
      this.previewLayer.batchDraw();
      return;
    }
    updateDrawingPreview(gesture, point);
    this.emitDrawingGesturePreview(gesture, point);
    this.previewLayer.batchDraw();
  }

  private appendFreehandPoint(
    gesture: DrawingGesture,
    point: BoardPoint,
    pressure: number,
  ): boolean {
    const gesturePoint = {
      x: point.x - gesture.strokeOffset.x,
      y: point.y - gesture.strokeOffset.y,
    };
    const last = gesture.points.at(-1);
    if (
      !last
      || distance(last, gesturePoint) < FREEHAND_POINT_DISTANCE_PX / this.currentCamera.zoom
    ) {
      return false;
    }
    gesture.points.push({ ...gesturePoint, pressure });
    gesture.previewPoints.push(gesturePoint.x, gesturePoint.y);
    appendBoundedGesturePoint(
      gesture.previewAwarenessPoints,
      gesturePoint,
    );
    return true;
  }

  private updateStraightFreehandPoint(
    gesture: DrawingGesture,
    point: BoardPoint,
    pressure: number,
  ): boolean {
    const minimumDistance = FREEHAND_POINT_DISTANCE_PX / this.currentCamera.zoom;
    if (!gesture.straightPointActive) {
      if (!this.appendFreehandPoint(gesture, point, pressure)) return false;
      gesture.straightPointActive = true;
      return true;
    }

    const gesturePoint = {
      x: point.x - gesture.strokeOffset.x,
      y: point.y - gesture.strokeOffset.y,
    };
    const anchor = gesture.points.at(-2);
    const current = gesture.points.at(-1);
    if (!anchor || !current) {
      gesture.straightPointActive = false;
      return false;
    }
    if (distance(anchor, gesturePoint) < minimumDistance) {
      gesture.points.pop();
      gesture.previewPoints.splice(-2, 2);
      gesture.previewAwarenessPoints.pop();
      appendBoundedGesturePoint(gesture.previewAwarenessPoints, anchor);
      gesture.straightPointActive = false;
      return true;
    }
    if (
      current.x === gesturePoint.x
      && current.y === gesturePoint.y
      && current.pressure === pressure
    ) {
      return false;
    }

    gesture.points[gesture.points.length - 1] = {
      ...gesturePoint,
      pressure,
    };
    gesture.previewPoints[gesture.previewPoints.length - 2] = gesturePoint.x;
    gesture.previewPoints[gesture.previewPoints.length - 1] = gesturePoint.y;
    gesture.previewAwarenessPoints[
      gesture.previewAwarenessPoints.length - 1
    ] = gesturePoint;
    return true;
  }

  private updateFreehandGesture(
    gesture: DrawingGesture,
    nativeEvent: PointerEvent | MouseEvent,
    screenTransform: PointerScreenTransform,
    screen: BoardPoint,
  ): "changed" | "unchanged" {
    if (nativeEvent.ctrlKey || nativeEvent.metaKey) {
      const deltaX = (
        screen.x - gesture.previousScreen.x
      ) / this.currentCamera.zoom;
      const deltaY = (
        screen.y - gesture.previousScreen.y
      ) / this.currentCamera.zoom;
      const modeChanged = !gesture.strokeMoveActive;
      gesture.strokeMoveActive = true;
      gesture.previousScreen = screen;
      if (modeChanged) this.updateCursor();
      if (deltaX === 0 && deltaY === 0) return "unchanged";
      gesture.strokeOffset = {
        x: gesture.strokeOffset.x + deltaX,
        y: gesture.strokeOffset.y + deltaY,
      };
      return "changed";
    }

    if (gesture.strokeMoveActive) {
      gesture.strokeMoveActive = false;
      this.updateCursor();
    }
    gesture.previousScreen = screen;

    const samples = pointerSamples(nativeEvent);
    if (nativeEvent.shiftKey) {
      const sample = samples.at(-1) ?? nativeEvent;
      const sampledScreen = screenPointFromPointer(
        sample,
        this.element,
        screenTransform,
      );
      return this.updateStraightFreehandPoint(
        gesture,
        worldPoint(sampledScreen, this.currentCamera),
        pointerPressure(sample),
      )
        ? "changed"
        : "unchanged";
    }

    gesture.straightPointActive = false;
    let changed = false;
    for (const sample of samples) {
      const sampledScreen = screenPointFromPointer(
        sample,
        this.element,
        screenTransform,
      );
      changed = this.appendFreehandPoint(
        gesture,
        worldPoint(sampledScreen, this.currentCamera),
        pointerPressure(sample),
      ) || changed;
    }
    return changed ? "changed" : "unchanged";
  }

  private onPointerUp(event: Konva.KonvaEventObject<PointerEvent>): void {
    const nativeEvent = event.evt;
    this.handlePointerUp(
      nativeEvent,
      nativeEvent.pointerId,
      event.type === "pointercancel" || nativeEvent.type === "pointercancel",
    );
  }

  private handlePointerUp(
    nativeEvent: PointerEvent | MouseEvent,
    pointerId: number,
    cancelled: boolean,
  ): void {
    this.pressedPointerIds.delete(pointerId);
    const screen = screenPointFromPointer(nativeEvent, this.element);
    const pointerType = pointerTypeFromEvent(nativeEvent);
    if (
      pointerType === "mouse"
      && this.activeMousePointerId === pointerId
    ) {
      this.clearActiveMousePointer();
    }
    if (pointerType === "touch") {
      this.touchPointers.set(pointerId, screen);
    }
    const gesture = this.activeGesture;
    if (!gesture || !this.gestureOwnsPointer(pointerId)) {
      this.touchPointers.delete(pointerId);
      this.releasePointer(pointerId);
      return;
    }
    nativeEvent.preventDefault();
    if (!cancelled) {
      this.setLaserModifierPressed(standaloneAltHeld(nativeEvent));
    }
    if (cancelled || gesture.kind === "pinch") {
      this.cancelActiveGesture();
      this.touchPointers.delete(pointerId);
      return;
    }

    let point = worldPoint(screen, this.currentCamera);
    if (
      gesture.kind === "drawing"
      && (gesture.tool === "pen" || gesture.tool === "highlighter")
    ) {
      this.updateFreehandGesture(
        gesture,
        nativeEvent,
        pointerScreenTransform(this.element),
        screen,
      );
      point = worldPoint(screen, this.currentCamera);
    }
    if (gesture.kind === "laser") {
      this.updateLaserGesture(
        gesture,
        nativeEvent,
        pointerScreenTransform(this.element),
      );
    }
    if (isSelectionGesture(gesture)) {
      this.updateSelectionGesture(
        gesture,
        nativeEvent,
        pointerScreenTransform(this.element),
        screen,
      );
    }
    this.activeGesture = null;
    this.updateDraggable();
    this.updatePenLaserPresentation();
    this.releasePointer(pointerId);
    this.touchPointers.delete(pointerId);
    if (gesture.kind === "pan") {
      this.updateCursor();
      return;
    }
    if (gesture.kind === "placement") {
      const travel = Math.max(
        gesture.maximumTravelPx,
        distance(gesture.startScreen, screen),
      );
      if (travel <= PLACEMENT_CLICK_TOLERANCE_PX) {
        this.callbacks.onPlaceTool(gesture.tool, gesture.point);
      }
      this.updateCursor();
      return;
    }
    if (gesture.kind === "laser") {
      if (
        gesture.session.releaseRequested
        || !this.laserModifierPressed
      ) {
        this.clearLaserSession(true);
      } else {
        this.emitLaserSession(gesture.session);
        this.updatePenLaserPresentation();
        this.previewLayer.batchDraw();
      }
      return;
    }
    if (gesture.kind === "eraser") {
      if (distance(gesture.previousScreen, screen) > 0) {
        this.updateEraserMarks(
          gesture,
          screen,
          eraserModeFromEvent(nativeEvent),
        );
      }
      this.finishEraser(gesture);
      return;
    }
    if (isSelectionGesture(gesture)) {
      this.finishSelectionGesture(gesture);
      this.updateCursor();
      return;
    }

    gesture.preview.destroy();
    if (isGesturePreviewTool(gesture.tool)) {
      this.callbacks.onGesturePreviewChange?.(null);
    }
    const draftPoints = (
      gesture.tool === "pen"
      || gesture.tool === "highlighter"
    ) && (
      gesture.strokeOffset.x !== 0
      || gesture.strokeOffset.y !== 0
    )
      ? gesture.points.map((point) => ({
          ...point,
          x: point.x + gesture.strokeOffset.x,
          y: point.y + gesture.strokeOffset.y,
        }))
      : gesture.points;
    const draft = shapeDraft(
      gesture.tool,
      gesture.start,
      point,
      draftPoints,
      gesture.style,
      gesture.connectorCurvature,
    );
    if (draft) this.callbacks.onCreateObject(draft);
    this.updatePenLaserPresentation();
    this.updateCursor();
    this.previewLayer.batchDraw();
  }

  private onWheel(event: Konva.KonvaEventObject<WheelEvent>): void {
    event.evt.preventDefault();
    if (
      this.activeGesture
      || this.pressedPointerIds.size > 0
      || this.transformer.isTransforming()
      || this.dragStart.size > 0
    ) {
      return;
    }
    const screen = this.screenPointer();
    if (!screen) return;
    if (event.evt.ctrlKey || event.evt.metaKey) {
      const before = worldPoint(screen, this.currentCamera);
      const delta = normalizedWheelZoomDelta(event.evt, this.stage.height());
      const factor = Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY);
      const zoom = clampBoardZoom(this.currentCamera.zoom * factor);
      this.setCamera({
        x: screen.x - before.x * zoom,
        y: screen.y - before.y * zoom,
        zoom,
      });
      return;
    }
    this.setCamera({
      x: this.currentCamera.x - event.evt.deltaX,
      y: this.currentCamera.y - event.evt.deltaY,
      zoom: this.currentCamera.zoom,
    });
  }

  private emitDrawingGesturePreview(
    gesture: DrawingGesture,
    end: BoardPoint,
  ): void {
    if (!this.callbacks.onGesturePreviewChange || !isGesturePreviewTool(gesture.tool)) {
      return;
    }
    const points = gesture.tool === "pen" || gesture.tool === "highlighter"
      ? gesture.previewAwarenessPoints.map((point) => ({
          x: point.x + gesture.strokeOffset.x,
          y: point.y + gesture.strokeOffset.y,
        }))
      : gesture.tool === "line" || gesture.tool === "arrow"
        ? (() => {
            const control = gesture.fixedConnectorControl
              ?? connectorControlPoint(
                gesture.start,
                end,
                gesture.connectorCurvature,
              );
            return control
              ? [{ ...gesture.start }, control, { ...end }]
              : [{ ...gesture.start }, { ...end }];
          })()
      : [{ ...gesture.start }, { ...end }];
    const style = gesture.tool === "pen" || gesture.tool === "highlighter"
      ? sanitizeBoardGesturePreviewStyle(gesture.style)
      : undefined;
    this.callbacks.onGesturePreviewChange({
      kind: gesture.tool,
      points,
      ...(style ? { style } : {}),
    });
  }

  private syncEraserTrail(gesture: EraserGesture, animationTime: number): boolean {
    advanceEraserTrailSamples(
      gesture.trailSamples,
      gesture.trailAnimationState,
      animationTime,
    );
    const profile = buildEraserTrailProfile(
      gesture.trailSamples,
      animationTime,
    );
    const previousAutoDraw = Konva.autoDrawEnabled;
    Konva.autoDrawEnabled = false;
    try {
      gesture.trailBody.setAttrs({
        eraserTrailStations: profile.stations,
        opacity: profile.opacity,
        visible: profile.stations.length > 0,
      });
      if (profile.head) {
        const { point } = profile.head;
        gesture.trailFootprint.setAttrs({
          x: point.x,
          y: point.y,
          visible: true,
        });
      } else {
        gesture.trailBody.visible(false);
        gesture.trailFootprint.visible(false);
      }
    } finally {
      Konva.autoDrawEnabled = previousAutoDraw;
    }
    return profile.needsAnimation;
  }

  private scheduleEraserTrailFrame(gesture: EraserGesture): void {
    if (
      gesture.trailAnimationFrame !== null
      || this.destroyed
      || this.activeGesture !== gesture
    ) {
      return;
    }
    const frame = requestAnimationFrame((animationTime) => {
      if (gesture.trailAnimationFrame !== frame) return;
      gesture.trailAnimationFrame = null;
      if (this.destroyed || this.activeGesture !== gesture) return;
      const needsAnimation = this.syncEraserTrail(gesture, animationTime);
      this.previewLayer.draw();
      if (needsAnimation) this.scheduleEraserTrailFrame(gesture);
    });
    gesture.trailAnimationFrame = frame;
  }

  private updateEraserMarks(
    gesture: EraserGesture,
    end: BoardPoint,
    mode: EraserMode,
  ): boolean {
    const start = gesture.previousScreen;
    if (!isFinitePoint(start) || !isFinitePoint(end)) return false;
    const startWorld = gesture.previousWorld;
    const endWorld = worldPoint(end, this.currentCamera);
    gesture.previousScreen = end;
    gesture.previousWorld = endWorld;
    const sweep: EraserSweep = {
      start: startWorld,
      end: endWorld,
      radius: ERASER_RADIUS_PX / this.currentCamera.zoom,
    };
    if (this.eraserHits.size === 0) return false;
    const screenLength = Math.max(
      distance(start, end),
      distance(startWorld, endWorld) * this.currentCamera.zoom,
    );
    const broadPhaseSegments = Math.max(
      1,
      Math.ceil(screenLength / ERASER_BROAD_PHASE_SEGMENT_PX),
    );
    let candidates = (
      broadPhaseSegments === 1
      || broadPhaseSegments > MAX_ERASER_BROAD_PHASE_SEGMENTS
    )
      ? this.eraserHits.search(sweep)
      : [];
    if (
      broadPhaseSegments > 1
      && broadPhaseSegments <= MAX_ERASER_BROAD_PHASE_SEGMENTS
    ) {
      const uniqueCandidates = new Map<
        string,
        ReturnType<EraserHitIndex["search"]>[number]
      >();
      for (let index = 0; index < broadPhaseSegments; index += 1) {
        const startProgress = index / broadPhaseSegments;
        const endProgress = (index + 1) / broadPhaseSegments;
        const segmentSweep: EraserSweep = {
          start: {
            x: startWorld.x + (endWorld.x - startWorld.x) * startProgress,
            y: startWorld.y + (endWorld.y - startWorld.y) * startProgress,
          },
          end: {
            x: startWorld.x + (endWorld.x - startWorld.x) * endProgress,
            y: startWorld.y + (endWorld.y - startWorld.y) * endProgress,
          },
          radius: sweep.radius,
        };
        for (const candidate of this.eraserHits.search(segmentSweep)) {
          uniqueCandidates.set(candidate.id, candidate);
        }
      }
      candidates = [...uniqueCandidates.values()];
    }
    let changed = false;
    for (const { id, geometry } of candidates) {
      const marked = gesture.objectIds.has(id);
      if (
        (mode === "mark" && marked)
        || (mode === "restore" && !marked)
      ) {
        continue;
      }
      const object = this.objects.get(id);
      if (
        !object
        || !isBoardObjectMutable(object)
        || !eraserSweepHits(geometry, sweep)
      ) {
        continue;
      }
      if (mode === "mark") {
        gesture.objectIds.add(id);
        this.applyEraserObjectPreview(id, true);
      } else {
        gesture.objectIds.delete(id);
        this.applyEraserObjectPreview(id, false);
      }
      changed = true;
    }
    return changed;
  }

  private destroyEraserTrail(gesture: EraserGesture): void {
    if (gesture.trailAnimationFrame !== null) {
      cancelAnimationFrame(gesture.trailAnimationFrame);
      gesture.trailAnimationFrame = null;
    }
    gesture.trail.destroy();
    gesture.trailSamples.splice(0);
  }

  private applyEraserObjectPreview(id: string, marked: boolean): void {
    const object = this.objects.get(id);
    const node = this.nodes.get(id);
    if (!object || !node) return;
    const baseOpacity = renderedObjectOpacity(object);
    node.visible(true);
    node.opacity(marked
      ? baseOpacity * ERASER_MARKED_OPACITY_FACTOR
      : baseOpacity);
  }

  private restoreEraserObjects(gesture: EraserGesture): void {
    const ids = [...gesture.objectIds];
    for (const id of ids) this.applyEraserObjectPreview(id, false);
    gesture.objectIds.clear();
    if (ids.length > 0) this.objectLayer.batchDraw();
  }

  private applyActiveEraserPreview(): void {
    if (this.activeGesture?.kind !== "eraser") return;
    for (const id of this.activeGesture.objectIds) {
      this.applyEraserObjectPreview(id, true);
    }
    if (this.activeGesture.objectIds.size > 0) this.objectLayer.batchDraw();
  }

  private finishEraser(gesture: EraserGesture): void {
    const ids = [...gesture.objectIds].filter((id) => {
      const object = this.objects.get(id);
      return object !== undefined && isBoardObjectMutable(object);
    });
    this.destroyEraserTrail(gesture);
    this.restoreEraserObjects(gesture);
    if (ids.length > 0) this.callbacks.onDeleteObjects(ids);
    this.previewLayer.batchDraw();
  }

  private finishSelectionGesture(gesture: SelectionGesture): void {
    this.cancelSelectionGestureMembership(gesture);
    gesture.preview.destroy();
    this.changeSelection(this.selectionGestureResultIds(gesture, true));
    this.updateDraggable();
    this.previewLayer.batchDraw();
  }

  private cancelActiveGesture(releasePointers = true): void {
    const gesture = this.activeGesture;
    if (!gesture) return;
    this.activeGesture = null;
    if (gesture.kind === "drawing") {
      gesture.preview.destroy();
      if (isGesturePreviewTool(gesture.tool)) {
        this.callbacks.onGesturePreviewChange?.(null);
      }
    } else if (gesture.kind === "laser") {
      this.clearLaserSession(false);
    } else if (gesture.kind === "eraser") {
      this.destroyEraserTrail(gesture);
      this.restoreEraserObjects(gesture);
    } else if (isSelectionGesture(gesture)) {
      this.cancelSelectionGestureMembership(gesture);
      gesture.preview.destroy();
    }
    this.updateDraggable();
    if (isSelectionGesture(gesture)) this.updateTransformer();
    if (releasePointers) {
      for (const pointerId of this.gesturePointerIds(gesture)) {
        this.releasePointer(pointerId);
      }
    }
    this.updateCursor();
    this.previewLayer.batchDraw();
  }

  private changeSelection(ids: readonly string[]): void {
    this.setSelection(ids);
    this.callbacks.onSelectionChange([...this.selectedIds]);
  }

  private removeSelectedId(id: string): boolean {
    const index = this.selectedIndexById.get(id);
    if (index === undefined) return false;
    const lastIndex = this.selectedIds.length - 1;
    const lastId = this.selectedIds[lastIndex];
    if (index !== lastIndex) {
      this.selectedIds[index] = lastId;
      this.selectedIndexById.set(lastId, index);
    }
    this.selectedIds.pop();
    this.selectedIdSet.delete(id);
    this.selectedIndexById.delete(id);
    return true;
  }

  private scheduleSelectionNotification(): void {
    if (this.selectionNotificationScheduled) return;
    this.selectionNotificationScheduled = true;
    queueMicrotask(() => {
      this.selectionNotificationScheduled = false;
      if (!this.destroyed) this.callbacks.onSelectionChange([...this.selectedIds]);
    });
  }

  private clearUnsafeSelection(): void {
    const safe = this.selectedIds.filter((id) => {
      const object = this.objects.get(id);
      return object !== undefined && isBoardObjectMutable(object);
    });
    if (safe.length === this.selectedIds.length) return;
    this.selectedIds = safe;
    this.selectedIdSet = new Set(safe);
    this.selectedIndexById = new Map(safe.map((id, index) => [id, index]));
    this.scheduleSelectionNotification();
  }

  private drawGrid(): void {
    this.gridLayer.batchDraw();
  }

  private applyInlineEditingPresentation(
    node: Konva.Group,
    objectId: string,
  ): void {
    node.findOne<Konva.Text>(`.${INLINE_TEXT_GLYPHS_NAME}`)?.opacity(
      objectId === this.inlineEditingObjectId ? 0 : 1,
    );
  }

  private materializeObjectNode(object: BoardObjectSnapshot): Konva.Group {
    const node = renderObjectNode(
      object,
      this.options.resolveAssetUrl,
      () => this.objectLayer.batchDraw(),
      this.decodedImages ?? undefined,
      this.currentTheme,
    );
    this.applyInlineEditingPresentation(node, object.id);
    this.bindObjectNode(node, object.id);
    return node;
  }

  private refreshViewport(force = false): void {
    const { x, y, zoom } = this.currentCamera;
    const viewport: ViewportBounds = {
      minX: -x / zoom,
      minY: -y / zoom,
      maxX: (this.stage.width() - x) / zoom,
      maxY: (this.stage.height() - y) / zoom,
    };
    if (
      !force
      && this.viewportQueryBounds
      && viewportContains(this.viewportQueryBounds, viewport)
    ) {
      return;
    }
    const overscan = VIEWPORT_OVERSCAN_PX / zoom;
    const queryBounds: ViewportBounds = {
      minX: viewport.minX - overscan,
      minY: viewport.minY - overscan,
      maxX: viewport.maxX + overscan,
      maxY: viewport.maxY + overscan,
    };
    const visible = new Set(this.spatial.search(queryBounds));
    this.viewportQueryBounds = queryBounds;

    const membershipChanged = !equalIdSets(visible, this.visibleIds);
    let nodesChanged = false;
    for (const [id, node] of this.nodes) {
      if (!visible.has(id)) {
        releaseRenderedObjectNode(node);
        this.nodes.delete(id);
        nodesChanged = true;
      }
    }
    for (const id of visible) {
      const object = this.objects.get(id);
      if (!object) continue;
      if (!this.nodes.has(object.id)) {
        const node = this.materializeObjectNode(object);
        this.nodes.set(object.id, node);
        this.objectWorld.add(node);
        if (
          this.activeGesture?.kind === "eraser"
          && this.activeGesture.objectIds.has(object.id)
        ) this.applyEraserObjectPreview(object.id, true);
        nodesChanged = true;
      }
    }

    if (membershipChanged || this.orderDirty) {
      const ordered = [...visible]
        .map((id) => this.objects.get(id))
        .filter((object): object is BoardObjectSnapshot => Boolean(object))
        .sort(compareBoardObjectZOrder);
      for (const object of ordered) this.nodes.get(object.id)?.moveToTop();
      this.orderDirty = false;
    }

    this.visibleIds.clear();
    for (const id of visible) this.visibleIds.add(id);
    if (membershipChanged || nodesChanged) {
      this.updateDraggable();
      this.updateTransformer();
      this.objectLayer.batchDraw();
    }
    if (membershipChanged && this.presences.length > 0) {
      this.syncPresenceScene();
      this.renderPresence();
    }
  }

  private bindObjectNode(node: Konva.Group, objectId: string): void {
    node.on("dragstart", () => {
      this.callbacks.onTransformStart();
      this.dragStart.clear();
      this.dragVisibleIds = [];
      for (const id of this.selectedIds) {
        const object = this.objects.get(id);
        if (!object || !isBoardObjectMutable(object)) continue;
        const selected = this.nodes.get(id);
        if (selected) this.dragVisibleIds.push(id);
        this.dragStart.set(id, selected
          ? { x: selected.x(), y: selected.y() }
          : { x: object.transform[0], y: object.transform[1] });
      }
      if (!this.dragStart.has(objectId)) this.dragStart.set(objectId, { x: node.x(), y: node.y() });
      this.dragSelectionOutlineStart = this.selectionOutline.visible()
        ? { x: this.selectionOutline.x(), y: this.selectionOutline.y() }
        : null;
    });
    node.on("dragmove", () => {
      const anchorStart = this.dragStart.get(objectId);
      if (!anchorStart || this.dragStart.size < 2) return;
      const deltaX = node.x() - anchorStart.x;
      const deltaY = node.y() - anchorStart.y;
      for (const id of this.dragVisibleIds) {
        if (id === objectId) continue;
        const start = this.dragStart.get(id);
        if (start) this.nodes.get(id)?.position({ x: start.x + deltaX, y: start.y + deltaY });
      }
      if (this.dragSelectionOutlineStart) {
        this.selectionOutline.position({
          x: this.dragSelectionOutlineStart.x + deltaX,
          y: this.dragSelectionOutlineStart.y + deltaY,
        });
      }
      this.updateSelectionObjectOutlines(this.selectionChromeVisible());
      this.objectLayer.batchDraw();
      this.previewLayer.batchDraw();
    });
    node.on("dragend", () => {
      if (this.cancellingInteraction) {
        this.dragStart.clear();
        this.dragVisibleIds = [];
        this.dragSelectionOutlineStart = null;
        return;
      }
      const transforms = new Map<string, AtomicTransform>();
      const anchorStart = this.dragStart.get(objectId);
      const deltaX = anchorStart ? node.x() - anchorStart.x : 0;
      const deltaY = anchorStart ? node.y() - anchorStart.y : 0;
      for (const [id, start] of this.dragStart) {
        const currentNode = this.nodes.get(id);
        const object = this.objects.get(id);
        if (!object || !isBoardObjectMutable(object)) continue;
        transforms.set(id, [
          currentNode?.x() ?? start.x + deltaX,
          currentNode?.y() ?? start.y + deltaY,
          object.transform[2],
          object.transform[3],
          currentNode
            ? currentNode.rotation() * Math.PI / 180
            : object.transform[4],
        ]);
      }
      this.dragStart.clear();
      this.dragVisibleIds = [];
      this.dragSelectionOutlineStart = null;
      if (transforms.size) this.callbacks.onTransformObjects(transforms);
    });
  }

  private reorderVisibleObjects(): void {
    const ordered = [...this.visibleIds]
      .map((id) => this.objects.get(id))
      .filter((object): object is BoardObjectSnapshot => Boolean(object))
      .sort(compareBoardObjectZOrder);
    for (const object of ordered) this.nodes.get(object.id)?.moveToTop();
    this.orderDirty = false;
  }

  private scheduleVisibleReorder(): void {
    if (this.visibleReorderScheduled) return;
    this.visibleReorderScheduled = true;
    queueMicrotask(() => {
      this.visibleReorderScheduled = false;
      if (this.destroyed || !this.orderDirty) return;
      this.reorderVisibleObjects();
      this.objectLayer.batchDraw();
    });
  }

  private nodeShouldBeDraggable(
    id: string,
    object: BoardObjectSnapshot | undefined,
  ): boolean {
    return !this.readOnly
      && id !== this.inlineEditingObjectId
      && this.currentTool === "select"
      && this.activeGesture === null
      && this.selectedIdSet.has(id)
      && object !== undefined
      && isBoardObjectMutable(object);
  }

  private updateDraggable(): void {
    this.transformer.listening(this.activeGesture === null);
    for (const [id, node] of this.nodes) {
      node.draggable(this.nodeShouldBeDraggable(id, this.objects.get(id)));
    }
  }

  private updateSelectionOutline(
    visible: boolean,
    selectedIdSet: ReadonlySet<string> = this.selectedIdSet,
  ): void {
    if (!visible) {
      this.selectionOutline.visible(false);
      return;
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const [id, node] of this.nodes) {
      if (!selectedIdSet.has(id)) continue;
      const bounds = node.getClientRect({
        relativeTo: this.objectWorld,
        skipShadow: true,
      });
      if (
        !Number.isFinite(bounds.x)
        || !Number.isFinite(bounds.y)
        || !Number.isFinite(bounds.width)
        || !Number.isFinite(bounds.height)
      ) {
        continue;
      }
      minX = Math.min(minX, bounds.x);
      minY = Math.min(minY, bounds.y);
      maxX = Math.max(maxX, bounds.x + bounds.width);
      maxY = Math.max(maxY, bounds.y + bounds.height);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
      this.selectionOutline.visible(false);
      return;
    }
    const inverseZoom = 1 / this.currentCamera.zoom;
    const palette = themePalette(this.currentTheme);
    this.selectionOutline.setAttrs({
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
      stroke: palette.accent,
      strokeWidth: 1.5 * inverseZoom,
      dash: GROUP_SELECTION_DASH_PX.map(
        (segment) => segment * inverseZoom,
      ),
      visible: true,
    });
  }

  private selectionChromeVisible(
    selectedIds: readonly string[] = this.selectedIds,
  ): boolean {
    return !this.readOnly
      && this.inlineEditingObjectId === null
      && this.currentTool === "select"
      && selectedIds.length > 0;
  }

  private clearSelectionObjectOutlines(): void {
    for (const outline of this.selectionObjectOutlines.values()) {
      outline.destroy();
    }
    this.selectionObjectOutlines.clear();
    this.selectionObjectOutlineGeometry.clear();
  }

  private updateSelectionObjectOutlines(
    visible: boolean,
    selectedIds: readonly string[] = this.selectedIds,
    selectedIdSet: ReadonlySet<string> = this.selectedIdSet,
    forceIndividual = false,
  ): void {
    if (!visible || (!forceIndividual && selectedIds.length < 2)) {
      this.clearSelectionObjectOutlines();
      return;
    }

    const selectedNodes: Array<readonly [string, Konva.Group]> = [];
    for (const [id, node] of this.nodes) {
      if (!selectedIdSet.has(id)) continue;
      selectedNodes.push([id, node]);
      if (selectedNodes.length > MAX_LOCAL_SELECTION_OUTLINES) {
        this.clearSelectionObjectOutlines();
        return;
      }
    }

    const geometry = selectedNodes.flatMap(([id, node]) => {
      let cached = this.selectionObjectOutlineGeometry.get(id);
      if (!cached || cached.node !== node) {
        cached = {
          node,
          bounds: node.getClientRect({
            skipTransform: true,
            skipShadow: true,
          }),
        };
        this.selectionObjectOutlineGeometry.set(id, cached);
      }
      const points = transformedNodeOutlinePoints(node, cached.bounds);
      return points ? [{ id, points }] : [];
    });
    const desiredIds = new Set(geometry.map(({ id }) => id));
    for (const [id, outline] of this.selectionObjectOutlines) {
      if (desiredIds.has(id)) continue;
      outline.destroy();
      this.selectionObjectOutlines.delete(id);
      this.selectionObjectOutlineGeometry.delete(id);
    }

    const inverseZoom = 1 / this.currentCamera.zoom;
    const palette = themePalette(this.currentTheme);
    for (const { id, points } of geometry) {
      let outline = this.selectionObjectOutlines.get(id);
      if (!outline) {
        outline = new Konva.Line({
          closed: true,
          listening: false,
          perfectDrawEnabled: false,
          lineJoin: "round",
          name: "board-local-selection-outline",
        });
        this.selectionObjectOutlines.set(id, outline);
        this.selectionObjectOutlineWorld.add(outline);
      }
      outline.setAttrs({
        points,
        stroke: palette.accent,
        strokeWidth: 1.25 * inverseZoom,
        dash: [],
        opacity: 0.9,
      });
    }
  }

  private updateTransformer(): void {
    const liveGesture = isSelectionGesture(this.activeGesture)
      ? this.activeGesture
      : null;
    const displayedIds = liveGesture?.previewSelectionIds ?? this.selectedIds;
    const displayedIdSet = liveGesture?.previewSelectionIdSet ?? this.selectedIdSet;
    const selectionChromeVisible = this.selectionChromeVisible(displayedIds);
    const canTransformAll = (
      liveGesture === null
      &&
      selectionChromeVisible
      && displayedIds.length > 0
      && displayedIds.length <= MAX_TRANSFORMER_NODES
      && displayedIds.every((id) => this.nodes.has(id))
    );
    const nodes = canTransformAll
      ? displayedIds
          .filter((id) => {
            const object = this.objects.get(id);
            return object !== undefined && isBoardObjectMutable(object);
          })
          .map((id) => this.nodes.get(id))
          .filter((node): node is Konva.Group => Boolean(node))
      : [];
    this.transformer.borderDash(nodes.length > 1
      ? [...GROUP_SELECTION_DASH_PX]
      : []);
    this.updateSelectionOutline(
      selectionChromeVisible
        && !canTransformAll
        && (liveGesture === null || displayedIds.length > MAX_LOCAL_SELECTION_OUTLINES),
      displayedIdSet,
    );
    this.updateSelectionObjectOutlines(
      selectionChromeVisible,
      displayedIds,
      displayedIdSet,
      liveGesture !== null,
    );
    const current = this.transformer.nodes();
    if (
      current.length !== nodes.length
      || current.some((node, index) => node !== nodes[index])
    ) {
      this.transformer.nodes(nodes);
    }
    this.previewLayer.batchDraw();
  }

  private updatePresenceMotion(presences: readonly BoardPresence[]): void {
    const animationTime = performance.now();
    const wallTime = Date.now();
    const activeClientIds = new Set<number>();
    for (const presence of presences) {
      activeClientIds.add(presence.clientId);
      if (presence.cursor) {
        const previous = this.cursorMotions.get(presence.clientId);
        if (!previous) {
          this.cursorMotions.set(presence.clientId, {
            from: presence.cursor,
            target: presence.cursor,
            startedAt: animationTime - CURSOR_INTERPOLATION_MS,
          });
        } else if (
          previous.target.x !== presence.cursor.x
          || previous.target.y !== presence.cursor.y
        ) {
          const current = interpolateCursor(previous, animationTime);
          const teleported = distance(current, presence.cursor) * this.currentCamera.zoom > 600;
          this.cursorMotions.set(presence.clientId, {
            from: teleported ? presence.cursor : current,
            target: presence.cursor,
            startedAt: animationTime,
          });
        }
      } else {
        this.cursorMotions.delete(presence.clientId);
      }

      const incomingLaser = presence.laser
        ? sanitizeBoardLaserPreview(presence.laser)
        : undefined;
      const existingTrail = this.remoteLaserTrails.get(presence.clientId);
      if (incomingLaser) {
        this.remoteLaserTrails.set(presence.clientId, {
          strokes: incomingLaser.strokes.map((stroke) => ({
            points: stroke.points.map((point) => ({ ...point })),
            ...(stroke.style ? { style: { ...stroke.style } } : {}),
          })),
          expiresAt: Number.POSITIVE_INFINITY,
          active: true,
        });
      } else if (existingTrail?.active) {
        if (presence.laserClearMode === "immediate") {
          this.remoteLaserTrails.delete(presence.clientId);
        } else {
          existingTrail.active = false;
          existingTrail.expiresAt = wallTime + LASER_FADE_MS;
        }
      }
    }

    for (const clientId of this.cursorMotions.keys()) {
      if (!activeClientIds.has(clientId)) this.cursorMotions.delete(clientId);
    }
    for (const clientId of this.remoteLaserTrails.keys()) {
      if (!activeClientIds.has(clientId)) this.remoteLaserTrails.delete(clientId);
    }
  }

  private createPresenceEntry(): PresenceRenderEntry {
    return {
      cursor: null,
      cursorArrow: null,
      cursorLabel: null,
      cursorTag: null,
      cursorText: null,
      gesturePreview: null,
      gestureKind: null,
      gestureColor: null,
      gesturePoints: null,
      gestureStyle: null,
      laser: null,
      selections: new Map(),
    };
  }

  private destroyPresenceEntry(entry: PresenceRenderEntry): void {
    entry.cursor?.destroy();
    entry.gesturePreview?.destroy();
    entry.laser?.destroy();
    for (const selection of entry.selections.values()) selection.destroy();
    entry.selections.clear();
  }

  private syncPresenceCursor(
    entry: PresenceRenderEntry,
    presence: BoardPresence,
  ): void {
    if (!presence.cursor && !entry.cursor) return;
    const color = colorValue(presence.color, DEFAULT_ACCENT);
    if (!entry.cursor) {
      const cursor = new Konva.Group({ listening: false });
      const arrow = new Konva.Line({
        points: [0, 0, 0, 18, 5, 13, 10, 23, 14, 21, 9, 11, 17, 10],
        closed: true,
        strokeWidth: 1.5,
        listening: false,
        perfectDrawEnabled: false,
      });
      const label = new Konva.Label({ listening: false });
      const tag = new Konva.Tag({ cornerRadius: 3 });
      const text = new Konva.Text({
        fill: "#ffffff",
        fontSize: 11,
        fontStyle: "bold",
        padding: 4,
      });
      label.add(tag, text);
      cursor.add(arrow, label);
      this.presenceWorld.add(cursor);
      entry.cursor = cursor;
      entry.cursorArrow = arrow;
      entry.cursorLabel = label;
      entry.cursorTag = tag;
      entry.cursorText = text;
    }
    const inverseZoom = 1 / this.currentCamera.zoom;
    entry.cursorArrow!.setAttrs({
      fill: color,
      stroke: "#ffffff",
      scaleX: inverseZoom,
      scaleY: inverseZoom,
    });
    entry.cursorLabel!.setAttrs({
      x: 15 * inverseZoom,
      y: 18 * inverseZoom,
      scaleX: inverseZoom,
      scaleY: inverseZoom,
    });
    entry.cursorTag!.fill(color);
    const displayName = boundedTextValue(
      presence.displayName,
      "",
      MAX_RENDER_METADATA_CODE_UNITS,
    );
    if (entry.cursorText!.text() !== displayName) {
      entry.cursorText!.text(displayName);
    }
    entry.cursor.visible(Boolean(presence.cursor));
  }

  private syncPresenceGesture(
    entry: PresenceRenderEntry,
    presence: BoardPresence,
  ): void {
    const gesture = presence.gesturePreview;
    if (!gesture) {
      entry.gesturePreview?.destroy();
      entry.gesturePreview = null;
      entry.gestureKind = null;
      entry.gestureColor = null;
      entry.gesturePoints = null;
      entry.gestureStyle = null;
      return;
    }
    const color = colorValue(presence.color, DEFAULT_ACCENT);
    const points = boundedGesturePoints(gesture.points);
    const style = sanitizeBoardGesturePreviewStyle(gesture.style);
    if (
      entry.gesturePreview
      && entry.gestureKind === gesture.kind
      && entry.gestureColor === color
      && equalPoints(entry.gesturePoints, points)
      && equalGesturePreviewStyles(entry.gestureStyle, style)
    ) {
      return;
    }
    entry.gesturePreview?.destroy();
    entry.gesturePreview = renderGesturePreviewNode(
      { kind: gesture.kind, points, ...(style ? { style } : {}) },
      color,
      this.currentTheme,
    );
    if (entry.gesturePreview) this.presenceWorld.add(entry.gesturePreview);
    entry.gestureKind = gesture.kind;
    entry.gestureColor = color;
    entry.gesturePoints = points;
    entry.gestureStyle = style ?? null;
  }

  private syncPresenceSelections(
    entry: PresenceRenderEntry,
    presence: BoardPresence,
  ): void {
    const color = colorValue(presence.color, DEFAULT_ACCENT);
    const selected = new Set(presence.selectionIds);
    for (const [objectId, node] of entry.selections) {
      if (!selected.has(objectId) || !this.visibleIds.has(objectId)) {
        node.destroy();
        entry.selections.delete(objectId);
      }
    }
    const inverseZoom = 1 / this.currentCamera.zoom;
    for (const objectId of this.visibleIds) {
      if (!selected.has(objectId)) continue;
      const object = this.objects.get(objectId);
      if (!object) continue;
      let node = entry.selections.get(objectId);
      if (!node) {
        node = new Konva.Rect({
          listening: false,
          perfectDrawEnabled: false,
        });
        entry.selections.set(objectId, node);
        this.presenceWorld.add(node);
      }
      const [x, y, width, height, rotation] = object.transform;
      node.setAttrs({
        x,
        y,
        width: Math.abs(width),
        height: Math.abs(height),
        rotation: rotation * 180 / Math.PI,
        stroke: color,
        strokeWidth: 1.5 * inverseZoom,
        dash: [5 * inverseZoom, 4 * inverseZoom],
      });
    }
  }

  private syncPresenceLaser(
    entry: PresenceRenderEntry,
    presence: BoardPresence,
  ): void {
    const trail = this.remoteLaserTrails.get(presence.clientId);
    if (!trail || trail.strokes.length === 0) {
      entry.laser?.visible(false);
      return;
    }
    if (!entry.laser) {
      entry.laser = new Konva.Group({ listening: false });
      this.presenceWorld.add(entry.laser);
    }
    const children = entry.laser.getChildren();
    for (let index = 0; index < trail.strokes.length; index += 1) {
      const stroke = trail.strokes[index];
      const child = children[index];
      let line: Konva.Line;
      if (child instanceof Konva.Line) {
        line = child;
      } else {
        child?.destroy();
        line = new Konva.Line({
          lineCap: "round",
          lineJoin: "round",
          listening: false,
          perfectDrawEnabled: false,
        });
        entry.laser.add(line);
      }
      const points = flattenedPoints(stroke.points);
      if (points.length === 2) points.push(points[0], points[1]);
      line.points(points);
      applyLaserStrokeAppearance(
        line,
        sanitizeBoardGesturePreviewStyle(stroke.style) ?? {
          stroke: colorValue(presence.color, "#ed2e38"),
          strokeWidth: 3 / this.currentCamera.zoom,
          opacity: 1,
        },
        this.currentTheme,
        this.currentCamera.zoom,
      );
      line.visible(true);
    }
    for (let index = trail.strokes.length; index < children.length; index += 1) {
      children[index].destroy();
    }
    entry.laser.visible(true);
  }

  private syncPresenceScene(): void {
    const activeClientIds = new Set<number>();
    for (const presence of this.presences) {
      activeClientIds.add(presence.clientId);
      let entry = this.presenceRenderEntries.get(presence.clientId);
      if (!entry) {
        entry = this.createPresenceEntry();
        this.presenceRenderEntries.set(presence.clientId, entry);
      }
      this.syncPresenceGesture(entry, presence);
      this.syncPresenceCursor(entry, presence);
      this.syncPresenceSelections(entry, presence);
      this.syncPresenceLaser(entry, presence);
    }
    for (const [clientId, entry] of this.presenceRenderEntries) {
      if (activeClientIds.has(clientId)) continue;
      this.destroyPresenceEntry(entry);
      this.presenceRenderEntries.delete(clientId);
    }
  }

  private schedulePresenceAnimation(): void {
    if (this.destroyed || this.presenceAnimationFrame !== null) return;
    this.presenceAnimationFrame = requestAnimationFrame((time) => {
      this.presenceAnimationFrame = null;
      this.renderPresence(time);
    });
  }

  private renderPresence(animationTime = performance.now()): void {
    if (this.destroyed) return;
    if (this.presenceExpiryTimer !== null) window.clearTimeout(this.presenceExpiryTimer);
    this.presenceExpiryTimer = null;
    const now = Date.now();
    let nextExpiry = Number.POSITIVE_INFINITY;
    let animationPending = false;
    for (const [clientId, trail] of this.remoteLaserTrails) {
      if (!trail.active && trail.expiresAt <= now) {
        this.remoteLaserTrails.delete(clientId);
      }
    }
    for (const presence of this.presences) {
      const entry = this.presenceRenderEntries.get(presence.clientId);
      if (!entry) continue;
      const cursorMotion = this.cursorMotions.get(presence.clientId);
      const cursorPoint = cursorMotion
        ? interpolateCursor(cursorMotion, animationTime)
        : presence.cursor;
      if (
        cursorMotion
        && animationTime < cursorMotion.startedAt + CURSOR_INTERPOLATION_MS
      ) {
        animationPending = true;
      }
      if (entry.cursor) {
        entry.cursor.visible(Boolean(cursorPoint));
        if (cursorPoint) entry.cursor.position(cursorPoint);
      }
      const laser = this.remoteLaserTrails.get(presence.clientId);
      if (laser && !laser.active && laser.expiresAt > now) {
        nextExpiry = Math.min(nextExpiry, laser.expiresAt);
        animationPending = true;
      }
      if (entry.laser) {
        const visible = Boolean(
          laser
          && (laser.active || laser.expiresAt > now)
          && laser.strokes.some((stroke) => stroke.points.length > 0),
        );
        entry.laser.visible(visible);
        if (visible && laser) {
          entry.laser.opacity(laser.active
            ? 1
            : Math.max(
                0,
                Math.min(1, (laser.expiresAt - now) / LASER_FADE_MS),
              ));
        }
      }
    }
    this.presenceLayer.batchDraw();
    if (animationPending) this.schedulePresenceAnimation();
    if (Number.isFinite(nextExpiry)) {
      this.presenceExpiryTimer = window.setTimeout(() => {
        this.presenceExpiryTimer = null;
        this.renderPresence();
      }, Math.max(1, nextExpiry - Date.now() + 1));
    }
  }

}

export const konvaBoardRendererFactory: BoardRendererFactory = {
  create(element, callbacks, options) {
    return new KonvaBoardRenderer(element, callbacks, options);
  },
};
