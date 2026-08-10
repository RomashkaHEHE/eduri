import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import {
  BringToFront,
  Braces,
  Check,
  ChevronRight,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Download,
  Grid3x3,
  House,
  Layers3,
  Maximize2,
  MousePointer2,
  MoreHorizontal,
  MoveDown,
  MoveUp,
  Moon,
  Redo2,
  Scissors,
  SendToBack,
  Sun,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import * as Y from "yjs";
import {
  BUILTIN_OBJECT_KINDS,
  LocalUndoController,
  addBoardObject,
  boardFragmentImageAssets,
  createBoardFragment,
  createCodeProps,
  createLatexProps,
  createTextProps,
  decodeBoardFragment,
  deleteBoardObjects,
  encodeStrokePoints,
  encodeBoardFragment,
  getBuiltInStyleContract,
  getCollaborativeText,
  getPageObjects,
  insertBoardFragment,
  isValidZRank,
  measureBoardDocument,
  newRankAfter,
  normalizeObjectZRanks,
  patchObjectStyles,
  patchObjectStylesByTarget,
  replaceCollaborativeTextRange,
  reorderObjects,
  resolveObjectStyleDefaults,
  setObjectProperty,
  stateVectorsEqual,
  transformObjects,
  compareBoardObjectZOrder,
  compareCodeUnitStrings,
  type AtomicTransform,
  type BoardCommandOrigin,
  type BoardDocumentMetrics,
  type BoardFragment,
  type BoardFragmentScope,
} from "../../board/core";
import {
  startPythonRun,
  type PythonRunHandle,
} from "../pythonRunner";
import { useOptionalTheme } from "../theme";
import { boardObjectSnapshot } from "./rendering/objectSnapshot";
import { konvaBoardRendererFactory } from "./rendering/konvaRenderer";
import type {
  BoardCamera,
  BoardContextMenuRequest,
  BoardGesturePreview,
  BoardLaserClearMode,
  BoardLaserPreview,
  BoardObjectDraft,
  BoardObjectSnapshot,
  BoardPlacementTool,
  BoardPoint,
  BoardPresence,
  BoardRenderer,
  BoardRendererFactory,
  BoardTheme,
  BoardTool,
} from "./rendering/types";
import { CollaborativeTextareaBinding } from "./collaborativeTextBinding";
import type { AssetOutboxHealth } from "./assetOutbox";
import {
  BoardStyleBar,
  type BoardFontStyleToken,
  type BoardLayerDirection,
  type BoardToggleState,
} from "./BoardStyleBar";
import {
  boardToolStyleKeys,
  defaultBoardToolStyle,
} from "./rendering/toolStyles";
import {
  TOOL_STYLE_PRESETS_STORAGE_KEY,
  loadToolStylePresets,
  persistToolStylePresets,
  type BoardToolStyles,
} from "./toolStylePresets";
import {
  changeStyleColorSlot,
  createStyleColorSlot,
  deleteStyleColorSlot,
  loadStyleColorPalette,
  moveStyleColorSlot,
  persistStyleColorPalette,
  rememberRecentStyleColor,
  type StyleColorPaletteState,
} from "./styleColorPalette";
import { isBoardObjectMutable } from "./rendering/pluginRegistry";
import {
  BoardClipboard,
  type BoardPastePayload,
} from "./boardClipboard";
import { clampBoardZoom } from "./boardZoom";
import {
  DEFAULT_FREE_DRAWING_PRESETS,
  FREE_DRAWING_PRESETS_STORAGE_KEY,
  LEGACY_FREE_DRAWING_PRESETS_STORAGE_KEY,
  createFreeDrawingPreset,
  deleteFreeDrawingPreset,
  freeDrawingPresetStyle,
  loadFreeDrawingPresets,
  moveFreeDrawingPreset,
  patchFreeDrawingPreset,
  serializeFreeDrawingPresets,
  type FreeDrawingPreset,
  type FreeDrawingPresetPatch,
} from "./freeDrawingPresets";
import {
  clampBoardConnectorCurvature,
  loadBoardConnectorCurvature,
  persistBoardConnectorCurvature,
  type BoardConnectorCurvaturePreferences,
} from "./connectorCurvature";
import { BoardToolbar } from "./BoardToolbar";
import {
  loadBoardToolbarPreferences,
  persistBoardToolbarPreferences,
  type BoardToolbarPreferences,
} from "./toolbarPreferences";

export type BoardConnectionStatus =
  | "loading-cache"
  | "connecting"
  | "synced"
  | "pending"
  | "offline"
  | "recovery-required"
  | "storage-error";

export interface BoardServerMetrics {
  readonly updateLogCount: number;
  readonly updateLogBytes: number;
  readonly idempotencyReceiptBytes?: number;
  readonly storageMetadataBytes?: number;
  readonly quotaBytes?: number;
  readonly assetCount: number;
  readonly assetBytes: number;
  readonly logicalBytes?: number;
  readonly physicalBytes?: number;
  readonly compactedAt?: string | null;
  readonly syncedAt?: string | null;
}

export interface BoardAwarenessState {
  readonly cursor?: BoardPoint | null;
  readonly selectionIds?: readonly string[];
  readonly activeTool?: BoardTool;
  readonly gesturePreview?: BoardGesturePreview | null;
  readonly laser?: BoardLaserPreview | null;
  readonly laserClearMode?: BoardLaserClearMode | null;
}

export interface BoardImageInsertion {
  readonly assetId: string;
  readonly contentHash: string | null;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalBytes: number;
}

export interface BoardSurfaceProps {
  readonly document: Y.Doc;
  readonly localOrigin: BoardCommandOrigin;
  readonly undo: LocalUndoController;
  readonly readOnly?: boolean;
  readonly status: BoardConnectionStatus;
  readonly pendingUpdates?: number;
  readonly presences?: readonly BoardPresence[];
  readonly serverMetrics?: BoardServerMetrics | null;
  readonly assetHealth?: AssetOutboxHealth | null;
  readonly assetPersistenceAtRisk?: boolean;
  readonly assetRefresh?: {
    readonly assetId: string;
    readonly revision: number;
  } | null;
  readonly resolveAssetUrl?: (
    assetId: string,
    contentHash: string | null,
  ) => string | null | Promise<string | null>;
  readonly insertImage?: (file: File) => Promise<BoardImageInsertion>;
  readonly onExportRecovery?: () => Promise<void>;
  readonly fragmentScope: BoardFragmentScope;
  readonly validateFragmentPaste?: (
    fragment: BoardFragment,
    imageAssets: ReturnType<typeof boardFragmentImageAssets>,
  ) => void | Promise<void>;
  readonly clipboard?: BoardClipboard;
  readonly onAwarenessChange?: (state: BoardAwarenessState) => void;
  readonly rendererFactory?: BoardRendererFactory;
}

interface EditingState {
  readonly objectId: string;
  readonly kind: string;
  readonly pendingText?: {
    readonly document: Y.Doc;
    readonly draft: BoardObjectDraft;
    readonly operationEpoch: number;
    readonly historyEpoch: number;
  };
}

const READ_ONLY_TOOLS = new Set<BoardTool>(["select", "hand", "pen"]);
const MAX_AWARENESS_SELECTION_IDS = 256;
const BOARD_THEME_STORAGE_KEY = "eduri-board-theme";
export const BOARD_GRID_VISIBILITY_STORAGE_KEY =
  "eduri-board-grid-visible";
const FREE_DRAWING_PRESET_PERSIST_DELAY_MS = 180;
const STYLE_SETTINGS_PERSIST_DELAY_MS = 180;
const ZOOM_STEP_FACTOR = 1.1;
const CAMERA_CENTER_EPSILON_PX = 0.5;
type BoardToolDigit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
const LETTER_TOOL_SHORTCUTS: ReadonlyArray<
  readonly [tool: BoardTool, letter: string]
> = [
  ["select", "V"],
  ["hand", "H"],
  ["pen", "P"],
  ["eraser", "E"],
  ["text", "T"],
  ["line", "L"],
  ["arrow", "A"],
  ["rectangle", "R"],
  ["ellipse", "O"],
  ["diamond", "D"],
  ["frame", "F"],
];
const NUMERIC_TOOL_SHORTCUTS: ReadonlyArray<
  readonly [tool: BoardTool, digit: BoardToolDigit]
> = [
  ["select", "1"],
  ["pen", "2"],
  ["eraser", "3"],
  ["text", "4"],
  ["line", "5"],
  ["arrow", "6"],
  ["rectangle", "7"],
  ["ellipse", "8"],
  ["diamond", "9"],
  ["frame", "0"],
];
const BOARD_TOOL_SHORTCUTS: Readonly<Record<string, BoardTool>> = {
  ...Object.fromEntries(
    LETTER_TOOL_SHORTCUTS.map(([tool, letter]) => [`Key${letter}`, tool]),
  ),
  ...Object.fromEntries(
    NUMERIC_TOOL_SHORTCUTS.flatMap(([tool, digit]) => [
      [`Digit${digit}`, tool],
      [`Numpad${digit}`, tool],
    ]),
  ),
};

function boardToolShortcut(event: KeyboardEvent): BoardTool | undefined {
  const shortcut = BOARD_TOOL_SHORTCUTS[event.code];
  if (
    shortcut
    && event.code.startsWith("Numpad")
    && !/^[0-9]$/u.test(event.key)
  ) {
    return undefined;
  }
  return shortcut;
}
function initialBoardToolStyles(): BoardToolStyles {
  if (typeof window !== "undefined") {
    try {
      return loadToolStylePresets(
        window.localStorage.getItem(TOOL_STYLE_PRESETS_STORAGE_KEY),
      );
    } catch {
      // Device presets are best-effort and never block board input.
    }
  }
  return loadToolStylePresets(null);
}

function styleValueEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "string" && typeof right === "string") {
    if (left.length > 256 || right.length > 256) return false;
    return left === right;
  }
  if (Object.is(left, right)) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  if (left.length > 32) return false;
  return left.every((entry, index) => Object.is(entry, right[index]));
}

const FONT_STYLE_TOKENS =
  ["bold", "italic"] as const satisfies readonly BoardFontStyleToken[];

function fontStyleTokens(value: unknown): ReadonlySet<BoardFontStyleToken> {
  const tokens = new Set<BoardFontStyleToken>();
  if (typeof value !== "string" || value.length > 64) return tokens;
  for (const token of value.split(/\s+/u)) {
    if (token === "bold" || token === "italic") tokens.add(token);
  }
  return tokens;
}

function fontStyleWithToken(
  value: unknown,
  token: BoardFontStyleToken,
  enabled: boolean,
): string {
  const tokens = new Set(fontStyleTokens(value));
  if (enabled) tokens.add(token);
  else tokens.delete(token);
  const ordered = FONT_STYLE_TOKENS.filter((candidate) => tokens.has(candidate));
  return ordered.length > 0 ? ordered.join(" ") : "normal";
}

function canonicalFontStyle(value: unknown): string {
  const tokens = fontStyleTokens(value);
  const ordered = FONT_STYLE_TOKENS.filter((candidate) => tokens.has(candidate));
  return ordered.length > 0 ? ordered.join(" ") : "normal";
}

function aggregateFontStyle(
  values: readonly unknown[],
): Readonly<Record<BoardFontStyleToken, BoardToggleState>> {
  return Object.fromEntries(FONT_STYLE_TOKENS.map((token) => {
    let enabledCount = 0;
    for (const value of values) {
      if (fontStyleTokens(value).has(token)) enabledCount += 1;
    }
    const state: BoardToggleState = enabledCount === 0
      ? false
      : enabledCount === values.length
        ? true
        : "mixed";
    return [token, state];
  })) as Record<BoardFontStyleToken, BoardToggleState>;
}

interface BoardRankCursor {
  readonly rank: string | null;
  readonly needsNormalization: boolean;
}

interface BoardContextMenuState extends BoardContextMenuRequest {
  readonly objectMenu: boolean;
}

interface BoardContextMenuItemBase {
  readonly id: string;
  readonly label: string;
  readonly shortcut?: string;
  readonly icon: typeof MousePointer2;
  readonly disabled?: boolean;
  readonly separatorBefore?: boolean;
}

interface BoardContextMenuActionItem extends BoardContextMenuItemBase {
  readonly checked?: boolean;
  readonly destructive?: boolean;
  onSelect(): void;
}

interface BoardContextMenuGroupItem extends BoardContextMenuItemBase {
  readonly submenu: readonly BoardContextMenuActionItem[];
}

type BoardContextMenuItem =
  | BoardContextMenuActionItem
  | BoardContextMenuGroupItem;

function isBoardContextMenuGroup(
  item: BoardContextMenuItem,
): item is BoardContextMenuGroupItem {
  return "submenu" in item;
}

function boardRankCursor(
  objects: readonly BoardObjectSnapshot[],
): BoardRankCursor {
  const rankable = objects.filter((object) =>
    object.rendering?.status !== "malformed");
  if (rankable.length === 0) {
    return { rank: null, needsNormalization: false };
  }
  const ordered = [...rankable].sort(compareBoardObjectZOrder);
  const ranks = new Set<string>();
  let needsNormalization = false;
  for (const object of ordered) {
    if (!isValidZRank(object.zRank) || ranks.has(object.zRank)) {
      needsNormalization = true;
    }
    ranks.add(object.zRank);
  }
  return {
    rank: ordered.at(-1)?.zRank ?? null,
    needsNormalization,
  };
}

function humanBytes(value: number): string {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} КБ`;
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} МБ`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(value < 10 * 1024 * 1024 * 1024 ? 1 : 0)} ГБ`;
}

function metricTime(value: string | null | undefined): string {
  if (!value) return "Нет данных";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

const DEFAULT_PLACEMENT_VIEWPORT = Object.freeze({
  width: 800,
  height: 600,
});
const PLACEMENT_MARGIN_PX = 16;
const PASTE_CASCADE_PX = 24;
const CLIPBOARD_TEXT_MAX_WIDTH = 640;
const CLIPBOARD_TEXT_MAX_HEIGHT = 480;
const CLIPBOARD_TEXT_SAMPLE_CODE_UNITS = 4_096;

interface BoardInsertionTarget {
  readonly document: Y.Doc;
  readonly operationEpoch: number;
  readonly historyEpoch: number;
  readonly anchor: BoardPoint;
  readonly camera: BoardCamera;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

function boardOperationScopeKey(
  operationEpoch: number,
  historyEpoch: number,
): string {
  return `${operationEpoch}:${historyEpoch}`;
}

function anchoredVisibleTransform(
  target: BoardInsertionTarget,
  requestedWidth: number,
  requestedHeight: number,
): AtomicTransform {
  const zoom = Number.isFinite(target.camera.zoom) && target.camera.zoom > 0
    ? target.camera.zoom
    : 1;
  const viewportWidth = target.viewportWidth > 0
    ? target.viewportWidth
    : DEFAULT_PLACEMENT_VIEWPORT.width;
  const viewportHeight = target.viewportHeight > 0
    ? target.viewportHeight
    : DEFAULT_PLACEMENT_VIEWPORT.height;
  const margin = Math.min(
    PLACEMENT_MARGIN_PX,
    viewportWidth / 4,
    viewportHeight / 4,
  );
  const width = Math.max(1, Math.abs(requestedWidth));
  const height = Math.max(1, Math.abs(requestedHeight));
  const scale = Math.min(
    1,
    Math.max(1, viewportWidth - margin * 2) / (width * zoom),
    Math.max(1, viewportHeight - margin * 2) / (height * zoom),
  );
  const fittedWidth = width * scale;
  const fittedHeight = height * scale;
  return [
    target.anchor.x - fittedWidth / 2,
    target.anchor.y - fittedHeight / 2,
    fittedWidth,
    fittedHeight,
    0,
  ];
}

function clipboardTextObjectSize(
  text: string,
): { readonly width: number; readonly height: number } {
  const sample = text
    .slice(0, CLIPBOARD_TEXT_SAMPLE_CODE_UNITS)
    .replace(/\r\n?/gu, "\n");
  const lines = sample.split("\n");
  const longestLine = lines.reduce(
    (longest, line) => Math.max(longest, line.length),
    0,
  );
  const width = Math.min(
    CLIPBOARD_TEXT_MAX_WIDTH,
    Math.max(240, longestLine * 10 + 16),
  );
  const columns = Math.max(1, Math.floor((width - 8) / 10));
  let visualLines = 0;
  for (const line of lines) {
    visualLines += Math.max(1, Math.ceil(line.length / columns));
    if (visualLines >= 19) break;
  }
  if (text.length > sample.length) visualLines = 19;
  return {
    width,
    height: Math.min(
      CLIPBOARD_TEXT_MAX_HEIGHT,
      Math.max(52, visualLines * 25 + 8),
    ),
  };
}

function imageObjectDraft(
  asset: BoardImageInsertion,
  transform: AtomicTransform,
): BoardObjectDraft {
  return {
    kind: BUILTIN_OBJECT_KINDS.image,
    transform,
    props: {
      assetId: asset.assetId,
      contentHash: asset.contentHash,
      mimeType: asset.mimeType,
      pixelWidth: asset.width,
      pixelHeight: asset.height,
      originalBytes: asset.originalBytes,
    },
  };
}

function clipboardImageFile(payload: Extract<
  BoardPastePayload,
  { readonly kind: "image" }
>): File {
  if (
    typeof File !== "undefined"
    && payload.blob instanceof File
    && payload.blob.type.trim().toLowerCase() === payload.mimeType
  ) {
    return payload.blob;
  }
  const extension = payload.mimeType === "image/jpeg"
    ? "jpg"
    : payload.mimeType.slice("image/".length);
  return new File(
    [payload.blob],
    payload.fileName ?? `clipboard.${extension}`,
    {
      type: payload.mimeType,
      lastModified: Date.now(),
    },
  );
}

function editorStyle(
  object: BoardObjectSnapshot,
  camera: BoardCamera,
  viewportWidth?: number,
  viewportHeight?: number,
): CSSProperties {
  const [x, y, width, height] = object.transform;
  const requestedWidth = Math.max(220, Math.abs(width) * camera.zoom);
  const availableWidth = viewportWidth && viewportWidth > 0
    ? Math.max(1, viewportWidth - 16)
    : requestedWidth;
  const editorWidth = Math.min(requestedWidth, availableWidth);
  const requestedLeft = camera.x + x * camera.zoom;
  const left = viewportWidth && viewportWidth > 0
    ? Math.max(8, Math.min(requestedLeft, viewportWidth - editorWidth - 8))
    : requestedLeft;
  const requestedHeight = Math.max(72, Math.abs(height) * camera.zoom);
  const availableHeight = viewportHeight && viewportHeight > 0
    ? Math.max(1, viewportHeight - 16)
    : requestedHeight;
  const editorHeight = Math.min(requestedHeight, availableHeight);
  const requestedTop = camera.y + y * camera.zoom;
  const top = viewportHeight && viewportHeight > 0
    ? Math.max(8, Math.min(requestedTop, viewportHeight - editorHeight - 8))
    : Math.max(8, requestedTop);
  return {
    left,
    top,
    width: editorWidth,
    minHeight: editorHeight,
    maxHeight: availableHeight,
  };
}

function inlineTextEditorStyle(
  object: BoardObjectSnapshot,
  camera: BoardCamera,
  theme: BoardTheme,
): CSSProperties {
  const [x, y, rawWidth, rawHeight, rotation] = object.transform;
  const zoom = Number.isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : 1;
  const width = Math.max(1, Math.abs(rawWidth) * zoom);
  const height = Math.max(1, Math.abs(rawHeight) * zoom);
  const storedFill = typeof object.style.fill === "string"
    ? object.style.fill
    : "#17212b";
  const color = theme === "dark" && storedFill.toLowerCase() === "#17212b"
    ? "#e7edf5"
    : storedFill;
  const fontSize = typeof object.style.fontSize === "number"
    && Number.isFinite(object.style.fontSize)
    ? Math.max(8, object.style.fontSize) * zoom
    : 20 * zoom;
  const fontFamily = typeof object.style.fontFamily === "string"
    ? object.style.fontFamily
    : "Inter, Arial, sans-serif";
  const fontStyle = typeof object.style.fontStyle === "string"
    ? object.style.fontStyle
    : "normal";

  return {
    left: camera.x + x * zoom,
    top: camera.y + y * zoom,
    width,
    height,
    minHeight: height,
    maxHeight: height,
    color,
    fontFamily,
    fontSize,
    fontStyle: fontStyle.includes("italic") ? "italic" : "normal",
    fontWeight: fontStyle.includes("bold") ? 700 : 400,
    opacity: typeof object.style.opacity === "number" ? object.style.opacity : 1,
    transform: `rotate(${Number.isFinite(rotation) ? rotation : 0}rad)`,
  };
}

function editingText(object: BoardObjectSnapshot | null): string {
  if (!object) return "";
  return typeof object.props.text === "string"
    ? object.props.text
    : typeof object.props.source === "string"
      ? object.props.source
      : "";
}

function imageAssetId(object: BoardObjectSnapshot): string | null {
  if (object.kind !== BUILTIN_OBJECT_KINDS.image) return null;
  return typeof object.props.assetId === "string" && object.props.assetId
    ? object.props.assetId
    : null;
}

function useDocumentMetrics(
  document: Y.Doc,
  enabled: boolean,
): BoardDocumentMetrics | null {
  const [measured, setMeasured] = useState<{
    readonly document: Y.Doc;
    readonly metrics: BoardDocumentMetrics;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let timer: number | null = null;
    let disposed = false;
    const measure = () => {
      timer = null;
      const metrics = measureBoardDocument(document);
      if (!disposed) setMeasured({ document, metrics });
    };
    const schedule = (delay: number) => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(measure, delay);
    };
    const update = () => schedule(250);
    schedule(0);
    document.on("update", update);
    return () => {
      disposed = true;
      document.off("update", update);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [document, enabled]);
  return measured?.document === document ? measured.metrics : null;
}

function BoardContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  readonly x: number;
  readonly y: number;
  readonly items: readonly BoardContextMenuItem[];
  onClose(restoreFocus: boolean): void;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const submenuCloseTimerRef = useRef<number | null>(null);
  const focusSubmenuRef = useRef(false);
  const submenuElementId = useId();
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);
  const [submenuFocusRequest, requestSubmenuFocus] = useReducer(
    (value: number) => value + 1,
    0,
  );
  const activeSubmenu = items.find((item): item is BoardContextMenuGroupItem =>
    isBoardContextMenuGroup(item) && item.id === openSubmenuId) ?? null;

  const clearSubmenuCloseTimer = () => {
    if (submenuCloseTimerRef.current === null) return;
    window.clearTimeout(submenuCloseTimerRef.current);
    submenuCloseTimerRef.current = null;
  };

  const closeSubmenu = () => {
    clearSubmenuCloseTimer();
    focusSubmenuRef.current = false;
    setOpenSubmenuId(null);
  };

  const scheduleSubmenuClose = () => {
    clearSubmenuCloseTimer();
    submenuCloseTimerRef.current = window.setTimeout(() => {
      submenuCloseTimerRef.current = null;
      const focusedInsideSubmenu = document.activeElement instanceof Node
        && Boolean(submenuRef.current?.contains(document.activeElement));
      const triggerId = openSubmenuId;
      setOpenSubmenuId(null);
      if (focusedInsideSubmenu && triggerId) {
        menuRef.current?.querySelector<HTMLButtonElement>(
          `[data-context-submenu-trigger="${triggerId}"]`,
        )?.focus({ preventScroll: true });
      }
    }, 180);
  };

  const showSubmenu = (item: BoardContextMenuGroupItem, focusFirst: boolean) => {
    if (item.disabled) return;
    clearSubmenuCloseTimer();
    focusSubmenuRef.current = focusFirst;
    setOpenSubmenuId(item.id);
    if (focusFirst) requestSubmenuFocus();
  };

  const menuButtons = (menu: HTMLDivElement | null): HTMLButtonElement[] =>
    menu
      ? [...menu.querySelectorAll<HTMLButtonElement>(
        '[data-context-menu-item="true"]:not(:disabled)',
      )]
      : [];

  const moveFocus = (
    menu: HTMLDivElement | null,
    direction: 1 | -1 | "first" | "last",
  ): HTMLButtonElement | null => {
    const buttons = menuButtons(menu);
    if (buttons.length === 0) return null;
    const activeIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = direction === "first"
      ? 0
      : direction === "last"
        ? buttons.length - 1
        : activeIndex < 0
          ? direction === 1 ? 0 : buttons.length - 1
          : (activeIndex + direction + buttons.length) % buttons.length;
    const next = buttons[nextIndex] ?? null;
    next?.focus({ preventScroll: true });
    return next;
  };

  useLayoutEffect(() => {
    clearSubmenuCloseTimer();
    focusSubmenuRef.current = false;
    setOpenSubmenuId(null);
  }, [items]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const layer = layerRef.current;
    const surface = layer?.parentElement;
    if (!menu || !surface) return;
    const margin = 8;
    const place = () => {
      const left = Math.max(
        margin,
        Math.min(x, Math.max(margin, surface.clientWidth - menu.offsetWidth - margin)),
      );
      const top = Math.max(
        margin,
        Math.min(y, Math.max(margin, surface.clientHeight - menu.offsetHeight - margin)),
      );
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    };
    place();
    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(place)
      : null;
    observer?.observe(surface);
    window.addEventListener("resize", place);
    menuButtons(menu)[0]?.focus({ preventScroll: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [items, x, y]);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const surface = layer?.parentElement;
    const menu = menuRef.current;
    const submenu = submenuRef.current;
    const trigger = openSubmenuId
      ? menu?.querySelector<HTMLButtonElement>(
        `[data-context-submenu-trigger="${openSubmenuId}"]`,
      )
      : null;
    if (!layer || !surface || !menu || !submenu || !trigger) return;

    const margin = 8;
    const gap = 4;
    const place = () => {
      const surfaceRect = surface.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      const surfaceWidth = surface.clientWidth;
      const surfaceHeight = surface.clientHeight;
      const submenuWidth = submenu.offsetWidth;
      const submenuHeight = submenu.offsetHeight;
      const right = menuRect.right - surfaceRect.left + gap;
      const left = menuRect.left - surfaceRect.left - submenuWidth - gap;
      const rightFits = right + submenuWidth <= surfaceWidth - margin;
      const leftFits = left >= margin;
      const rightSpace = surfaceWidth - margin - right;
      const leftSpace = menuRect.left - surfaceRect.left - gap - margin;
      const useRight = rightFits || (!leftFits && rightSpace >= leftSpace);
      const preferredLeft = useRight ? right : left;
      const maxLeft = Math.max(margin, surfaceWidth - submenuWidth - margin);
      const preferredTop = triggerRect.top - surfaceRect.top - 5;
      const maxTop = Math.max(margin, surfaceHeight - submenuHeight - margin);

      submenu.style.left = `${Math.max(margin, Math.min(preferredLeft, maxLeft))}px`;
      submenu.style.top = `${Math.max(margin, Math.min(preferredTop, maxTop))}px`;
      submenu.dataset.side = useRight ? "right" : "left";
    };

    place();
    if (focusSubmenuRef.current) {
      focusSubmenuRef.current = false;
      menuButtons(submenu)[0]?.focus({ preventScroll: true });
    }
    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(place)
      : null;
    observer?.observe(surface);
    observer?.observe(menu);
    observer?.observe(submenu);
    menu.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      menu.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [openSubmenuId, submenuFocusRequest]);

  useEffect(() => {
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && layerRef.current?.contains(target)) return;
      onClose(false);
    };
    window.addEventListener("pointerdown", closeFromOutside, true);
    return () => window.removeEventListener("pointerdown", closeFromOutside, true);
  }, [onClose]);

  useEffect(() => () => clearSubmenuCloseTimer(), []);

  return (
    <div
      ref={layerRef}
      className="board-v2__context-menu-layer"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div
        ref={menuRef}
        className="board-v2__context-menu"
        role="menu"
        aria-label="Действия с доской"
        style={{ left: x, top: y }}
        onPointerEnter={clearSubmenuCloseTimer}
        onPointerLeave={scheduleSubmenuClose}
        onKeyDown={(event) => {
          event.stopPropagation();
          const active = document.activeElement as HTMLButtonElement | null;
          const group = active?.dataset.contextSubmenuTrigger
            ? items.find((item): item is BoardContextMenuGroupItem =>
              isBoardContextMenuGroup(item)
              && item.id === active.dataset.contextSubmenuTrigger)
            : null;
          if (event.key === "ArrowRight" && group) {
            event.preventDefault();
            showSubmenu(group, true);
          } else if (event.key === "ArrowLeft" && openSubmenuId) {
            event.preventDefault();
            closeSubmenu();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const next = moveFocus(menuRef.current, event.key === "ArrowDown" ? 1 : -1);
            if (next?.dataset.contextSubmenuTrigger !== openSubmenuId) closeSubmenu();
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            const next = moveFocus(menuRef.current, event.key === "Home" ? "first" : "last");
            if (next?.dataset.contextSubmenuTrigger !== openSubmenuId) closeSubmenu();
          } else if (event.key === "Escape" || event.key === "Tab") {
            event.preventDefault();
            onClose(true);
          }
        }}
      >
        {items.map((item) => {
          const Icon = item.icon;
          const group = isBoardContextMenuGroup(item);
          const expanded = group && openSubmenuId === item.id;
          return (
            <div key={item.id}>
              {item.separatorBefore && (
                <div className="board-v2__context-separator" role="separator" />
              )}
              <button
                type="button"
                role={!group && item.checked !== undefined
                  ? "menuitemcheckbox"
                  : "menuitem"}
                aria-checked={!group ? item.checked : undefined}
                aria-haspopup={group ? "menu" : undefined}
                aria-expanded={group ? expanded : undefined}
                aria-controls={group ? `${submenuElementId}-${item.id}` : undefined}
                className={[
                  !group && item.destructive ? "is-danger" : "",
                  expanded ? "is-submenu-open" : "",
                ].filter(Boolean).join(" ") || undefined}
                disabled={item.disabled}
                data-context-menu-item="true"
                data-context-submenu-trigger={group ? item.id : undefined}
                onPointerEnter={() => {
                  clearSubmenuCloseTimer();
                  if (group) showSubmenu(item, false);
                  else if (openSubmenuId) scheduleSubmenuClose();
                }}
                onClick={() => {
                  if (group) {
                    showSubmenu(item, true);
                    return;
                  }
                  onClose(true);
                  item.onSelect();
                }}
              >
                <Icon size={16} strokeWidth={1.8} />
                <span>{item.label}</span>
                {item.shortcut && <kbd>{item.shortcut}</kbd>}
                <span className="board-v2__context-check" aria-hidden="true">
                  {group
                    ? <ChevronRight className="board-v2__context-chevron" size={14} strokeWidth={2} />
                    : item.checked && <Check size={14} strokeWidth={2.2} />}
                </span>
              </button>
            </div>
          );
        })}
      </div>

      {activeSubmenu && (
        <div
          ref={submenuRef}
          id={`${submenuElementId}-${activeSubmenu.id}`}
          className="board-v2__context-menu board-v2__context-menu--submenu"
          role="menu"
          aria-label={activeSubmenu.label}
          style={{ left: x, top: y }}
          onPointerEnter={clearSubmenuCloseTimer}
          onPointerLeave={scheduleSubmenuClose}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveFocus(submenuRef.current, 1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveFocus(submenuRef.current, -1);
            } else if (event.key === "Home") {
              event.preventDefault();
              moveFocus(submenuRef.current, "first");
            } else if (event.key === "End") {
              event.preventDefault();
              moveFocus(submenuRef.current, "last");
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              closeSubmenu();
              menuRef.current?.querySelector<HTMLButtonElement>(
                `[data-context-submenu-trigger="${activeSubmenu.id}"]`,
              )?.focus({ preventScroll: true });
            } else if (event.key === "Escape" || event.key === "Tab") {
              event.preventDefault();
              onClose(true);
            }
          }}
        >
          {activeSubmenu.submenu.map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.id}>
                <button
                  type="button"
                  role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                  aria-checked={item.checked}
                  className={item.destructive ? "is-danger" : undefined}
                  disabled={item.disabled}
                  data-context-menu-item="true"
                  onClick={() => {
                    onClose(true);
                    item.onSelect();
                  }}
                >
                  <Icon size={16} strokeWidth={1.8} />
                  <span>{item.label}</span>
                  {item.shortcut && <kbd>{item.shortcut}</kbd>}
                  <span className="board-v2__context-check" aria-hidden="true">
                    {item.checked && <Check size={14} strokeWidth={2.2} />}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function statusText(status: BoardConnectionStatus, pendingUpdates: number): string {
  if (status === "loading-cache") return "Открываем локальную копию";
  if (status === "connecting") return "Подключение";
  if (status === "pending") {
    return pendingUpdates > 0
      ? `Отправляем изменения: ${pendingUpdates}`
      : "Отправляем изменения";
  }
  if (status === "offline") {
    return pendingUpdates > 0
      ? `Нет сети · ожидают отправки: ${pendingUpdates}`
      : "Нет сети · можно продолжать работу";
  }
  if (status === "recovery-required") return "Изменения сохранены в локальной копии";
  if (status === "storage-error") {
    return "Локальное сохранение недоступно · изменения останутся только в этой вкладке";
  }
  return "";
}

function isNativeInputTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

function nativeEventIsComposing(event: Event): boolean {
  return "isComposing" in event && event.isComposing === true;
}

function isBoardContextMenuTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest('[role="menu"]') !== null;
}

function initialBoardTheme(): BoardTheme {
  if (typeof window === "undefined") return "light";
  try {
    const stored = window.localStorage.getItem(BOARD_THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // The board remains usable when browser storage is unavailable.
  }
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
}

function initialBoardGridVisible(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(
      BOARD_GRID_VISIBILITY_STORAGE_KEY,
    ) !== "false";
  } catch {
    return true;
  }
}

interface FreeDrawingPaletteState {
  readonly presets: readonly FreeDrawingPreset[];
  readonly activePresetId: string;
}

type FreeDrawingPaletteAction =
  | { readonly type: "select"; readonly presetId: string }
  | {
    readonly type: "patch";
    readonly presetId: string;
    readonly patch: FreeDrawingPresetPatch;
  }
  | { readonly type: "add"; readonly preset: FreeDrawingPreset }
  | { readonly type: "delete"; readonly presetId: string }
  | {
    readonly type: "move";
    readonly presetId: string;
    readonly targetIndex: number;
  };

function reduceFreeDrawingPalette(
  state: FreeDrawingPaletteState,
  action: FreeDrawingPaletteAction,
): FreeDrawingPaletteState {
  switch (action.type) {
    case "select":
      return action.presetId !== state.activePresetId
        && state.presets.some((preset) => preset.id === action.presetId)
        ? { ...state, activePresetId: action.presetId }
        : state;
    case "patch": {
      let changed = false;
      const presets = state.presets.map((preset) => {
        if (preset.id !== action.presetId) return preset;
        const updated = patchFreeDrawingPreset(preset, action.patch);
        if (
          updated.stroke === preset.stroke
          && updated.strokeWidth === preset.strokeWidth
          && updated.opacity === preset.opacity
        ) {
          return preset;
        }
        changed = true;
        return updated;
      });
      return changed ? { ...state, presets } : state;
    }
    case "add":
      return state.presets.some((preset) => preset.id === action.preset.id)
        ? state
        : { ...state, presets: [...state.presets, action.preset] };
    case "delete": {
      const removedIndex = state.presets.findIndex(
        (preset) => preset.id === action.presetId,
      );
      const presets = deleteFreeDrawingPreset(
        state.presets,
        action.presetId,
      );
      if (presets === state.presets) return state;
      const activePresetId = state.activePresetId === action.presetId
        ? presets[Math.min(removedIndex, presets.length - 1)].id
        : state.activePresetId;
      return { presets, activePresetId };
    }
    case "move": {
      const presets = moveFreeDrawingPreset(
        state.presets,
        action.presetId,
        action.targetIndex,
      );
      return presets === state.presets ? state : { ...state, presets };
    }
  }
}

function initialFreeDrawingPalette(): FreeDrawingPaletteState {
  let presets = DEFAULT_FREE_DRAWING_PRESETS.map((preset) => ({ ...preset }));
  if (typeof window !== "undefined") {
    try {
      presets = loadFreeDrawingPresets(
        window.localStorage.getItem(FREE_DRAWING_PRESETS_STORAGE_KEY),
        window.localStorage.getItem(
          LEGACY_FREE_DRAWING_PRESETS_STORAGE_KEY,
        ),
      );
    } catch {
      // Device preset persistence is best-effort and never blocks drawing.
    }
  }
  return {
    presets,
    activePresetId: presets[0].id,
  };
}

function persistFreeDrawingPresets(
  presets: readonly FreeDrawingPreset[],
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      FREE_DRAWING_PRESETS_STORAGE_KEY,
      serializeFreeDrawingPresets(presets),
    );
  } catch {
    // Device preset persistence is best-effort and never blocks drawing.
  }
}

function initialStyleColorPalette(): StyleColorPaletteState {
  if (typeof window === "undefined") return loadStyleColorPalette(null);
  try {
    return loadStyleColorPalette(window.localStorage);
  } catch {
    return loadStyleColorPalette(null);
  }
}

function persistStyleColorPaletteState(
  state: StyleColorPaletteState,
): void {
  let storage: Storage | null = null;
  try {
    storage = typeof window === "undefined" ? null : window.localStorage;
  } catch {
    storage = null;
  }
  persistStyleColorPalette(storage, state);
}

function sameObjectIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function fragmentFingerprint(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${bytes.byteLength}:${(hash >>> 0).toString(16)}`;
}

function textFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length}:${(hash >>> 0).toString(16)}`;
}

export function BoardSurface({
  document,
  localOrigin,
  undo,
  readOnly = false,
  status,
  pendingUpdates = 0,
  presences = [],
  serverMetrics = null,
  assetHealth = null,
  assetPersistenceAtRisk = false,
  assetRefresh = null,
  resolveAssetUrl,
  insertImage,
  onExportRecovery,
  fragmentScope,
  validateFragmentPaste,
  clipboard,
  onAwarenessChange,
  rendererFactory = konvaBoardRendererFactory,
}: BoardSurfaceProps) {
  const surfaceRef = useRef<HTMLElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<BoardRenderer | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pendingImagePlacementRef = useRef<BoardInsertionTarget | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const editorCompositionTargetRef = useRef<HTMLTextAreaElement | null>(null);
  const defaultClipboardRef = useRef<BoardClipboard | null>(null);
  if (defaultClipboardRef.current === null) {
    defaultClipboardRef.current = new BoardClipboard();
  }
  const clipboardRef = useRef(clipboard ?? defaultClipboardRef.current);
  const awarenessFrame = useRef<number | null>(null);
  const cameraStateFrame = useRef<number | null>(null);
  const pendingCameraState = useRef<BoardCamera | null>(null);
  const renderedAssetRevisionRef = useRef(assetRefresh?.revision ?? 0);
  const assetIdByObjectRef = useRef(new Map<string, string>());
  const objectIdsByAssetRef = useRef(new Map<string, Set<string>>());
  const rankCursorRef = useRef<BoardRankCursor>({
    rank: null,
    needsNormalization: false,
  });
  const pendingLiveAwareness = useRef<BoardAwarenessState>({});
  const lastCursor = useRef<BoardPoint | null>(null);
  const activeCodeRunRef = useRef<PythonRunHandle | null>(null);
  const codeRunSequenceRef = useRef(0);
  const continuousStyleEditRef = useRef<{
    undo: LocalUndoController;
    captureTimeout: number;
  } | null>(null);
  const mountedRef = useRef(false);
  const onAwarenessChangeRef = useRef(onAwarenessChange);
  const resolveAssetUrlRef = useRef(resolveAssetUrl);
  const documentRef = useRef(document);
  const localOriginRef = useRef(localOrigin);
  const undoRef = useRef(undo);
  const readOnlyRef = useRef(readOnly);
  const fragmentScopeRef = useRef(fragmentScope);
  const validateFragmentPasteRef = useRef(validateFragmentPaste);
  const historyEpochRef = useRef(0);
  const boardOperationScopeRef = useRef({
    document,
    readOnly,
    epoch: 0,
  });
  if (
    boardOperationScopeRef.current.document !== document
    || boardOperationScopeRef.current.readOnly !== readOnly
  ) {
    boardOperationScopeRef.current = {
      document,
      readOnly,
      epoch: boardOperationScopeRef.current.epoch + 1,
    };
  }
  const pasteQueueRef = useRef<{
    readonly scopeKey: string;
    readonly tail: Promise<void>;
  }>({
    scopeKey: boardOperationScopeKey(
      boardOperationScopeRef.current.epoch,
      historyEpochRef.current,
    ),
    tail: Promise.resolve(),
  });
  const activeNudgeKeysRef = useRef(new Set<string>());
  const suppressedAltKeysRef = useRef(new Set<string>());
  const clipboardPendingByScopeRef = useRef(new Map<string, number>());
  const lastPasteRef = useRef<{
    readonly fingerprint: string;
    readonly count: number;
  } | null>(null);
  const [tool, setTool] = useState<BoardTool>("select");
  const [toolbarPreferences, setToolbarPreferences] =
    useState<BoardToolbarPreferences>(loadBoardToolbarPreferences);
  const [penLaserActive, setPenLaserActive] = useState(false);
  const appTheme = useOptionalTheme();
  const [localTheme, setLocalTheme] = useState<BoardTheme>(initialBoardTheme);
  const theme: BoardTheme = appTheme?.theme ?? localTheme;
  const [gridVisible, setGridVisible] = useState(initialBoardGridVisible);
  const [contextMenu, setContextMenu] =
    useState<BoardContextMenuState | null>(null);
  const [freeDrawingPaletteState, dispatchFreeDrawingPalette] = useReducer(
    reduceFreeDrawingPalette,
    undefined,
    initialFreeDrawingPalette,
  );
  const freeDrawingPaletteStateRef = useRef(freeDrawingPaletteState);
  const freeDrawingPresets = freeDrawingPaletteState.presets;
  const activeFreeDrawingPresetId =
    freeDrawingPaletteState.activePresetId;
  const freeDrawingPresetsRef = useRef(freeDrawingPresets);
  const freeDrawingPresetPersistTimerRef = useRef<number | null>(null);
  const [toolStyles, setToolStyles] =
    useState<BoardToolStyles>(initialBoardToolStyles);
  const toolStylesRef = useRef(toolStyles);
  const toolStylePersistTimerRef = useRef<number | null>(null);
  const [connectorCurvatures, setConnectorCurvatures] =
    useState<BoardConnectorCurvaturePreferences>(loadBoardConnectorCurvature);
  const [styleColorPalette, setStyleColorPalette] =
    useState<StyleColorPaletteState>(initialStyleColorPalette);
  const styleColorPaletteRef = useRef(styleColorPalette);
  const styleColorPalettePersistTimerRef = useRef<number | null>(null);
  const [camera, setCameraState] = useState<BoardCamera>({ x: 0, y: 0, zoom: 1 });
  const cameraRef = useRef(camera);
  const [selection, setSelection] = useState<readonly string[]>([]);
  const selectionRef = useRef(selection);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [runOutput, setRunOutput] = useState("");
  const [running, setRunning] = useState(false);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [insertError, setInsertError] = useState<string | null>(null);
  const [clipboardBusy, setClipboardBusy] = useState(false);
  const [recoveryExport, setRecoveryExport] =
    useState<"idle" | "exporting" | "error">("idle");
  const [showTransientStatus, setShowTransientStatus] = useState(false);
  const [revision, setRevision] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  const metrics = useDocumentMetrics(document, metricsOpen);
  const objects = useMemo(() => getPageObjects(document), [document]);
  const activeFreeDrawingPreset = useMemo(
    () => freeDrawingPresets.find(
      (preset) => preset.id === activeFreeDrawingPresetId,
    ) ?? freeDrawingPresets[0] ?? DEFAULT_FREE_DRAWING_PRESETS[0],
    [activeFreeDrawingPresetId, freeDrawingPresets],
  );
  const currentToolStyle = useMemo(
    () => tool === "pen"
      ? freeDrawingPresetStyle(activeFreeDrawingPreset)
      : toolStyles[tool] ?? defaultBoardToolStyle(tool),
    [activeFreeDrawingPreset, tool, toolStyles],
  );
  const currentConnectorCurvature =
    tool === "line" || tool === "arrow" ? connectorCurvatures[tool] : 0;
  const editingRef = useRef(editing);
  const promotedPendingTextRef = useRef(
    new WeakSet<NonNullable<EditingState["pendingText"]>>(),
  );
  const commitObjectDraftRef = useRef<(
    expectedDocument: Y.Doc,
    draft: BoardObjectDraft,
    editAfterCreate?: boolean,
    expectedOperationEpoch?: number,
    expectedHistoryEpoch?: number,
  ) => string | null>(() => null);

  onAwarenessChangeRef.current = onAwarenessChange;
  resolveAssetUrlRef.current = resolveAssetUrl;
  documentRef.current = document;
  localOriginRef.current = localOrigin;
  undoRef.current = undo;
  readOnlyRef.current = readOnly;
  fragmentScopeRef.current = fragmentScope;
  validateFragmentPasteRef.current = validateFragmentPaste;
  clipboardRef.current = clipboard ?? defaultClipboardRef.current;
  editingRef.current = editing;
  selectionRef.current = selection;
  freeDrawingPaletteStateRef.current = freeDrawingPaletteState;
  freeDrawingPresetsRef.current = freeDrawingPresets;
  toolStylesRef.current = toolStyles;
  styleColorPaletteRef.current = styleColorPalette;

  useEffect(() => {
    const transient =
      status === "loading-cache"
      || status === "connecting"
      || status === "pending";
    if (!transient) {
      setShowTransientStatus(false);
      return;
    }
    setShowTransientStatus(false);
    const timer = window.setTimeout(() => setShowTransientStatus(true), 900);
    return () => window.clearTimeout(timer);
  }, [status]);

  useLayoutEffect(() => {
    rendererRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (appTheme) return;
    try {
      window.localStorage.setItem(BOARD_THEME_STORAGE_KEY, theme);
    } catch {
      // Theme persistence is best-effort and never blocks the board.
    }
  }, [appTheme, theme]);

  useEffect(() => {
    const input = fileRef.current;
    if (!input) return;
    const clearPendingPlacement = () => {
      pendingImagePlacementRef.current = null;
    };
    input.addEventListener("cancel", clearPendingPlacement);
    return () => input.removeEventListener("cancel", clearPendingPlacement);
  }, []);

  useEffect(() => {
    rendererRef.current?.setGridVisible(gridVisible);
    try {
      window.localStorage.setItem(
        BOARD_GRID_VISIBILITY_STORAGE_KEY,
        String(gridVisible),
      );
    } catch {
      // Grid visibility remains available when device storage is unavailable.
    }
  }, [gridVisible]);

  useEffect(() => {
    if (freeDrawingPresetPersistTimerRef.current !== null) {
      window.clearTimeout(freeDrawingPresetPersistTimerRef.current);
    }
    freeDrawingPresetPersistTimerRef.current = window.setTimeout(() => {
      freeDrawingPresetPersistTimerRef.current = null;
      persistFreeDrawingPresets(freeDrawingPresetsRef.current);
    }, FREE_DRAWING_PRESET_PERSIST_DELAY_MS);
    return () => {
      if (freeDrawingPresetPersistTimerRef.current !== null) {
        window.clearTimeout(freeDrawingPresetPersistTimerRef.current);
        freeDrawingPresetPersistTimerRef.current = null;
      }
    };
  }, [freeDrawingPresets]);

  useEffect(() => {
    const flushFreeDrawingPresets = () => {
      if (freeDrawingPresetPersistTimerRef.current !== null) {
        window.clearTimeout(freeDrawingPresetPersistTimerRef.current);
        freeDrawingPresetPersistTimerRef.current = null;
      }
      persistFreeDrawingPresets(freeDrawingPresetsRef.current);
    };
    window.addEventListener("pagehide", flushFreeDrawingPresets);
    return () => {
      window.removeEventListener("pagehide", flushFreeDrawingPresets);
      flushFreeDrawingPresets();
    };
  }, []);

  useEffect(() => {
    if (toolStylePersistTimerRef.current !== null) {
      window.clearTimeout(toolStylePersistTimerRef.current);
    }
    toolStylePersistTimerRef.current = window.setTimeout(() => {
      toolStylePersistTimerRef.current = null;
      persistToolStylePresets(toolStylesRef.current);
    }, STYLE_SETTINGS_PERSIST_DELAY_MS);
    return () => {
      if (toolStylePersistTimerRef.current !== null) {
        window.clearTimeout(toolStylePersistTimerRef.current);
        toolStylePersistTimerRef.current = null;
      }
    };
  }, [toolStyles]);

  useEffect(() => {
    if (styleColorPalettePersistTimerRef.current !== null) {
      window.clearTimeout(styleColorPalettePersistTimerRef.current);
    }
    styleColorPalettePersistTimerRef.current = window.setTimeout(() => {
      styleColorPalettePersistTimerRef.current = null;
      persistStyleColorPaletteState(styleColorPaletteRef.current);
    }, STYLE_SETTINGS_PERSIST_DELAY_MS);
    return () => {
      if (styleColorPalettePersistTimerRef.current !== null) {
        window.clearTimeout(styleColorPalettePersistTimerRef.current);
        styleColorPalettePersistTimerRef.current = null;
      }
    };
  }, [styleColorPalette]);

  useEffect(() => {
    const flushStyleSettings = () => {
      if (toolStylePersistTimerRef.current !== null) {
        window.clearTimeout(toolStylePersistTimerRef.current);
        toolStylePersistTimerRef.current = null;
      }
      if (styleColorPalettePersistTimerRef.current !== null) {
        window.clearTimeout(styleColorPalettePersistTimerRef.current);
        styleColorPalettePersistTimerRef.current = null;
      }
      persistToolStylePresets(toolStylesRef.current);
      persistStyleColorPaletteState(styleColorPaletteRef.current);
    };
    window.addEventListener("pagehide", flushStyleSettings);
    return () => {
      window.removeEventListener("pagehide", flushStyleSettings);
      flushStyleSettings();
    };
  }, []);

  const selectedObject = useMemo(() => {
    if (!editing) return null;
    if (editing.pendingText) {
      const pendingText = editing.pendingText;
      const operationScope = boardOperationScopeRef.current;
      if (
        pendingText.document !== document
        || operationScope.document !== document
        || operationScope.readOnly !== readOnly
        || pendingText.operationEpoch !== operationScope.epoch
        || pendingText.historyEpoch !== historyEpochRef.current
      ) {
        return null;
      }
      const draft = pendingText.draft;
      return {
        id: editing.objectId,
        kind: BUILTIN_OBJECT_KINDS.text,
        version: 1,
        transform: draft.transform,
        zRank: "",
        parentId: null,
        style: draft.style ?? {},
        props: draft.props ?? { text: "" },
        rendering: { status: "supported" },
      } satisfies BoardObjectSnapshot;
    }
    const record = objects.get(editing.objectId);
    return !objects.has(editing.objectId)
      ? null
      : boardObjectSnapshot(record, editing.objectId);
  }, [document, editing, historyRevision, objects, readOnly, revision]);
  const inlineEditingObjectId = editing?.kind === BUILTIN_OBJECT_KINDS.text
    && !editing.pendingText
    ? editing.objectId
    : null;

  const selectedObjects = useMemo(() => selection
    .filter((id) => objects.has(id))
    .map((id) => boardObjectSnapshot(objects.get(id), id))
    .filter(isBoardObjectMutable), [objects, revision, selection]);

  const applyFreeDrawingPaletteAction = useCallback((
    action: FreeDrawingPaletteAction,
  ) => {
    freeDrawingPaletteStateRef.current = reduceFreeDrawingPalette(
      freeDrawingPaletteStateRef.current,
      action,
    );
    dispatchFreeDrawingPalette(action);
  }, []);

  const selectFreeDrawingPreset = useCallback((presetId: string) => {
    applyFreeDrawingPaletteAction({ type: "select", presetId });
  }, [applyFreeDrawingPaletteAction]);

  const updateFreeDrawingPreset = useCallback((
    presetId: string,
    patch: FreeDrawingPresetPatch,
  ) => {
    applyFreeDrawingPaletteAction({
      type: "patch",
      presetId,
      patch,
    });
  }, [applyFreeDrawingPaletteAction]);

  const addFreeDrawingPreset = useCallback((): string | null => {
    const state = freeDrawingPaletteStateRef.current;
    const source = state.presets.find(
      (preset) => preset.id === state.activePresetId,
    ) ?? state.presets[0];
    const preset = createFreeDrawingPreset(state.presets, source);
    if (!preset) return null;
    applyFreeDrawingPaletteAction({ type: "add", preset });
    return preset.id;
  }, [applyFreeDrawingPaletteAction]);

  const removeFreeDrawingPreset = useCallback((presetId: string) => {
    applyFreeDrawingPaletteAction({ type: "delete", presetId });
  }, [applyFreeDrawingPaletteAction]);

  const reorderFreeDrawingPreset = useCallback((
    presetId: string,
    targetIndex: number,
  ) => {
    applyFreeDrawingPaletteAction({
      type: "move",
      presetId,
      targetIndex,
    });
  }, [applyFreeDrawingPaletteAction]);

  const updateStyleColorPalette = useCallback((
    update: (state: StyleColorPaletteState) => StyleColorPaletteState,
  ) => {
    const current = styleColorPaletteRef.current;
    const next = update(current);
    if (next === current) return;
    styleColorPaletteRef.current = next;
    setStyleColorPalette(next);
  }, []);

  const addStyleColorSlot = useCallback((color: string): string | null => {
    const state = styleColorPaletteRef.current;
    const slot = createStyleColorSlot(state.slots, color);
    if (!slot) return null;
    updateStyleColorPalette((current) => {
      const slots = [...current.slots, slot];
      return {
        ...current,
        slots,
        recentColors: rememberRecentStyleColor(
          current.recentColors,
          slot.color,
          slots,
        ),
      };
    });
    return slot.id;
  }, [updateStyleColorPalette]);

  const updateStyleColorSlot = useCallback((
    slotId: string,
    color: string,
  ) => {
    updateStyleColorPalette((current) => {
      const slots = changeStyleColorSlot(current.slots, slotId, color);
      return slots === current.slots
        ? current
        : {
            ...current,
            slots,
            recentColors: rememberRecentStyleColor(
              current.recentColors,
              color,
              slots,
            ),
          };
    });
  }, [updateStyleColorPalette]);

  const removeStyleColorSlot = useCallback((slotId: string) => {
    updateStyleColorPalette((current) => {
      const slots = deleteStyleColorSlot(current.slots, slotId);
      return slots === current.slots ? current : { ...current, slots };
    });
  }, [updateStyleColorPalette]);

  const reorderStyleColorSlot = useCallback((
    slotId: string,
    targetIndex: number,
  ) => {
    updateStyleColorPalette((current) => {
      const slots = moveStyleColorSlot(current.slots, slotId, targetIndex);
      return slots === current.slots ? current : { ...current, slots };
    });
  }, [updateStyleColorPalette]);

  const rememberStyleColor = useCallback((color: string) => {
    updateStyleColorPalette((current) => {
      const recentColors = rememberRecentStyleColor(
        current.recentColors,
        color,
        current.slots,
      );
      return recentColors === current.recentColors
        ? current
        : { ...current, recentColors };
    });
  }, [updateStyleColorPalette]);

  const selectionStyle = useMemo(() => {
    const available = new Set<string>();
    const mixed = new Set<string>();
    const values: Record<string, unknown> = {};
    const targets = new Map<string, string[]>();
    const fontStyleTargets: Array<{
      readonly objectId: string;
      readonly value: unknown;
    }> = [];
    const initialized = new Set<string>();
    let allowTransparentFill = true;
    let hasTextColor = false;
    let hasShapeFill = false;
    let hasNonTextOpacity = false;

    for (const object of selectedObjects) {
      const contract = getBuiltInStyleContract(object.kind, object.version);
      if (!contract) continue;
      if (
        object.kind === BUILTIN_OBJECT_KINDS.text
        || object.kind === BUILTIN_OBJECT_KINDS.latex
      ) {
        allowTransparentFill = false;
      }
      const effective = resolveObjectStyleDefaults(
        object.kind,
        object.version,
        object.style,
      );
      if (contract.capabilities.includes("fontStyle")) {
        fontStyleTargets.push({
          objectId: object.id,
          value: effective.fontStyle,
        });
      }
      for (const property of contract.capabilities) {
        if (
          object.kind === BUILTIN_OBJECT_KINDS.stroke
          && property === "dash"
        ) {
          continue;
        }
        if (property === "fill") {
          if (
            object.kind === BUILTIN_OBJECT_KINDS.text
            || object.kind === BUILTIN_OBJECT_KINDS.latex
          ) {
            hasTextColor = true;
          } else {
            hasShapeFill = true;
          }
        }
        if (
          property === "opacity"
          && object.kind !== BUILTIN_OBJECT_KINDS.text
          && object.kind !== BUILTIN_OBJECT_KINDS.latex
        ) {
          hasNonTextOpacity = true;
        }
        available.add(property);
        const propertyTargets = targets.get(property) ?? [];
        propertyTargets.push(object.id);
        targets.set(property, propertyTargets);
        if (!initialized.has(property)) {
          initialized.add(property);
          values[property] = effective[property];
        } else if (!styleValueEqual(values[property], effective[property])) {
          mixed.add(property);
        }
      }
    }

    return {
      available,
      mixed,
      values,
      targets,
      fontStyleTargets,
      fontStyleState: aggregateFontStyle(
        fontStyleTargets.map((target) => target.value),
      ),
      allowTransparentFill,
      hasNonTextOpacity,
      showFillPropertyIcon: hasShapeFill,
      fillColorLabel: hasTextColor && hasShapeFill
        ? "Цвет текста / заливка"
        : hasTextColor
          ? "Цвет текста"
          : "Цвет заливки",
    };
  }, [selectedObjects]);

  const toolStyleAvailable = useMemo(
    () => new Set<string>(boardToolStyleKeys(tool)),
    [tool],
  );
  const hasSelection = selectedObjects.length > 0;
  const editingSelectionStyle = hasSelection && tool !== "pen";
  const styleBarVisible = !readOnly
    && editing === null
    && (editingSelectionStyle || toolStyleAvailable.size > 0);
  const styleBarAvailable = editingSelectionStyle
    ? selectionStyle.available
    : toolStyleAvailable;
  const styleBarValues = editingSelectionStyle
    ? selectionStyle.values
    : currentToolStyle;
  const styleBarMixed = editingSelectionStyle
    ? selectionStyle.mixed
    : new Set<string>();
  const styleBarFontStyleState = editingSelectionStyle
    ? selectionStyle.fontStyleState
    : aggregateFontStyle([currentToolStyle.fontStyle]);

  const applyStyleChange = useCallback((property: string, value: unknown) => {
    if (readOnlyRef.current) return;
    if (editingSelectionStyle) {
      const objectIds = selectionStyle.targets.get(property) ?? [];
      if (objectIds.length === 0) return;
      if (
        !selectionStyle.mixed.has(property)
        && styleValueEqual(selectionStyle.values[property], value)
      ) {
        return;
      }
      if (patchObjectStyles(
        document,
        objectIds,
        { set: { [property]: value } },
        localOrigin,
      ) && continuousStyleEditRef.current === null) {
        undo.commandBoundary();
      }
      return;
    }

    if (!toolStyleAvailable.has(property)) return;
    if (styleValueEqual(currentToolStyle[property], value)) return;
    if (
      tool === "pen"
      && (
        property === "stroke"
        || property === "strokeWidth"
        || property === "opacity"
      )
    ) {
      updateFreeDrawingPreset(
        activeFreeDrawingPreset.id,
        { [property]: value } as FreeDrawingPresetPatch,
      );
      return;
    }
    setToolStyles((current) => ({
      ...current,
      [tool]: {
        ...(current[tool] ?? defaultBoardToolStyle(tool)),
        [property]: value,
      },
    }));
  }, [
    currentToolStyle,
    document,
    editingSelectionStyle,
    localOrigin,
    selectionStyle,
    tool,
    toolStyleAvailable,
    undo,
    activeFreeDrawingPreset.id,
    updateFreeDrawingPreset,
  ]);

  const applyFontStyleToggle = useCallback((
    token: BoardFontStyleToken,
    enabled: boolean,
  ) => {
    if (readOnlyRef.current) return;
    if (editingSelectionStyle) {
      const targets = selectionStyle.fontStyleTargets.flatMap((target) => {
        const next = fontStyleWithToken(target.value, token, enabled);
        return next === canonicalFontStyle(target.value)
          ? []
          : [{
              objectId: target.objectId,
              patch: { set: { fontStyle: next } },
            }];
      });
      if (
        targets.length > 0
        && patchObjectStylesByTarget(document, targets, localOrigin)
      ) {
        undo.commandBoundary();
      }
      return;
    }

    if (!toolStyleAvailable.has("fontStyle")) return;
    const next = fontStyleWithToken(currentToolStyle.fontStyle, token, enabled);
    if (styleValueEqual(currentToolStyle.fontStyle, next)) return;
    setToolStyles((current) => ({
      ...current,
      [tool]: {
        ...(current[tool] ?? defaultBoardToolStyle(tool)),
        fontStyle: next,
      },
    }));
  }, [
    currentToolStyle,
    document,
    editingSelectionStyle,
    localOrigin,
    selectionStyle.fontStyleTargets,
    tool,
    toolStyleAvailable,
    undo,
  ]);

  const beginContinuousStyleChange = useCallback(() => {
    if (
      readOnlyRef.current
      || !editingSelectionStyle
      || continuousStyleEditRef.current !== null
    ) {
      return;
    }
    const captureTimeout = undo.manager.captureTimeout;
    undo.beginGesture();
    undo.manager.captureTimeout = Number.POSITIVE_INFINITY;
    continuousStyleEditRef.current = { undo, captureTimeout };
  }, [editingSelectionStyle, undo]);

  const endContinuousStyleChange = useCallback(() => {
    const activeEdit = continuousStyleEditRef.current;
    if (!activeEdit) return;
    continuousStyleEditRef.current = null;
    activeEdit.undo.manager.captureTimeout = activeEdit.captureTimeout;
    activeEdit.undo.endGesture();
  }, []);

  useEffect(() => {
    if (!styleBarVisible || !editingSelectionStyle || readOnly) {
      endContinuousStyleChange();
    }
    return endContinuousStyleChange;
  }, [
    document,
    endContinuousStyleChange,
    editingSelectionStyle,
    readOnly,
    selection,
    styleBarVisible,
    undo,
  ]);

  const changeLayer = useCallback((direction: BoardLayerDirection) => {
    if (readOnlyRef.current || selectedObjects.length === 0) return;
    const changed = reorderObjects(
      document,
      selectedObjects.map((object) => object.id),
      direction,
      localOrigin,
    );
    const snapshots = [...objects.entries()].map(([id, record]) =>
      boardObjectSnapshot(record, id));
    rankCursorRef.current = boardRankCursor(snapshots);
    if (changed) undo.commandBoundary();
  }, [document, localOrigin, objects, readOnly, selectedObjects, undo]);

  const setSurfaceSelection = useCallback((ids: readonly string[]) => {
    const next = [...new Set(ids)];
    rendererRef.current?.setSelection(next);
    setSelection(next);
    selectionRef.current = next;
    onAwarenessChangeRef.current?.({
      selectionIds: next.slice(0, MAX_AWARENESS_SELECTION_IDS),
    });
  }, []);

  const exitInlineEditingOnEscape = useCallback(() => {
    const activeEditing = editingRef.current;
    editorCompositionTargetRef.current = null;
    undoRef.current.focusBoundary();
    setEditing(null);
    if (activeEditing?.kind !== BUILTIN_OBJECT_KINDS.text) return;
    if (selectionRef.current.length > 0) setSurfaceSelection([]);
    surfaceRef.current?.focus({ preventScroll: true });
  }, [setSurfaceSelection]);

  const chooseTool = useCallback((nextTool: BoardTool) => {
    if (nextTool === "pen" && selectionRef.current.length > 0) {
      setSurfaceSelection([]);
    }
    setTool((currentTool) => (
      nextTool === "select" && currentTool === "select"
        ? "hand"
        : nextTool
    ));
  }, [setSurfaceSelection]);

  const changeToolbarPreferences = useCallback((
    preferences: BoardToolbarPreferences,
  ) => {
    setToolbarPreferences({
      order: [...preferences.order],
      visible: [...preferences.visible],
    });
  }, []);

  const changeConnectorCurvature = useCallback((value: number) => {
    if (tool !== "line" && tool !== "arrow") return;
    const normalized = clampBoardConnectorCurvature(value);
    setConnectorCurvatures((current) => current[tool] === normalized
      ? current
      : { ...current, [tool]: normalized });
  }, [tool]);

  const selectAllObjects = useCallback(() => {
    const selected = [...objects.entries()]
      .map(([id, record]) => boardObjectSnapshot(record, id))
      .filter(isBoardObjectMutable)
      .sort(compareBoardObjectZOrder)
      .map((object) => object.id);
    setSurfaceSelection(selected);
  }, [objects, setSurfaceSelection]);

  const closeContextMenu = useCallback((restoreFocus: boolean) => {
    setContextMenu(null);
    if (restoreFocus) {
      surfaceRef.current?.focus({ preventScroll: true });
    }
  }, []);

  const openContextMenu = useCallback((request: BoardContextMenuRequest) => {
    rendererRef.current?.cancelInteraction();
    activeNudgeKeysRef.current.clear();
    undoRef.current.endGesture();
    const record = request.objectId
      ? objects.get(request.objectId)
      : undefined;
    const targetObject = request.objectId && objects.has(request.objectId)
      ? boardObjectSnapshot(record, request.objectId)
      : null;
    const objectMenu = targetObject !== null
      && isBoardObjectMutable(targetObject);
    if (objectMenu && request.objectId) {
      if (!selectionRef.current.includes(request.objectId)) {
        setSurfaceSelection([request.objectId]);
      }
    } else if (selectionRef.current.length > 0) {
      setSurfaceSelection([]);
    }
    lastCursor.current = request.world;
    setMetricsOpen(false);
    const next: BoardContextMenuState = {
      ...request,
      objectId: objectMenu ? request.objectId : null,
      objectMenu,
    };
    setContextMenu(next);
  }, [objects, setSurfaceSelection]);

  const openKeyboardContextMenu = useCallback(() => {
    const renderer = rendererRef.current;
    const host = hostRef.current;
    if (!renderer || !host) return;
    const screen = {
      x: host.clientWidth / 2,
      y: host.clientHeight / 2,
    };
    const camera = renderer.camera;
    const objectId = selectionRef.current.find((id) => {
      const record = objects.get(id);
      return objects.has(id)
        && isBoardObjectMutable(boardObjectSnapshot(record, id));
    }) ?? null;
    openContextMenu({
      screen,
      world: {
        x: (screen.x - camera.x) / camera.zoom,
        y: (screen.y - camera.y) / camera.zoom,
      },
      objectId,
    });
  }, [objects, openContextMenu]);

  const zoomToViewportCenter = useCallback((requestedZoom: number) => {
    const renderer = rendererRef.current;
    const host = hostRef.current;
    if (
      !renderer
      || !host
      || !Number.isFinite(requestedZoom)
      || requestedZoom <= 0
    ) {
      return;
    }
    const current = renderer.camera;
    const center = {
      x: host.clientWidth / 2,
      y: host.clientHeight / 2,
    };
    const world = {
      x: (center.x - current.x) / current.zoom,
      y: (center.y - current.y) / current.zoom,
    };
    const zoom = clampBoardZoom(requestedZoom);
    renderer.setCamera({
      x: center.x - world.x * zoom,
      y: center.y - world.y * zoom,
      zoom,
    });
  }, []);

  const zoomAtViewportCenter = useCallback((factor: number) => {
    const currentZoom = rendererRef.current?.camera.zoom;
    if (
      !currentZoom
      || !Number.isFinite(factor)
      || factor <= 0
    ) {
      return;
    }
    zoomToViewportCenter(currentZoom * factor);
  }, [zoomToViewportCenter]);

  const homeCamera = useCallback(() => {
    const renderer = rendererRef.current;
    const host = hostRef.current;
    if (!renderer || !host) return;
    renderer.cancelInteraction();
    activeNudgeKeysRef.current.clear();
    undoRef.current.endGesture();
    const current = renderer.camera;
    const center = {
      x: host.clientWidth / 2,
      y: host.clientHeight / 2,
    };
    const isCentered = Math.abs(current.x - center.x)
        <= CAMERA_CENTER_EPSILON_PX
      && Math.abs(current.y - center.y) <= CAMERA_CENTER_EPSILON_PX;
    renderer.setCamera({
      x: center.x,
      y: center.y,
      zoom: isCentered ? 1 : current.zoom,
    });
  }, []);

  const nudgeSelection = useCallback((deltaX: number, deltaY: number) => {
    if (readOnlyRef.current || (deltaX === 0 && deltaY === 0)) return;
    const sourceDocument = documentRef.current;
    const sourceObjects = getPageObjects(sourceDocument);
    const transforms = new Map<string, AtomicTransform>();
    for (const id of selectionRef.current) {
      const record = sourceObjects.get(id);
      if (!sourceObjects.has(id)) continue;
      const object = boardObjectSnapshot(record, id);
      if (!isBoardObjectMutable(object)) continue;
      transforms.set(id, [
        object.transform[0] + deltaX,
        object.transform[1] + deltaY,
        object.transform[2],
        object.transform[3],
        object.transform[4],
      ]);
    }
    if (transforms.size > 0) {
      transformObjects(
        sourceDocument,
        transforms,
        localOriginRef.current,
      );
    }
  }, []);

  const beginClipboardOperation = useCallback((
    scopeKey = boardOperationScopeKey(
      boardOperationScopeRef.current.epoch,
      historyEpochRef.current,
    ),
  ) => {
    const pending = clipboardPendingByScopeRef.current;
    pending.set(scopeKey, (pending.get(scopeKey) ?? 0) + 1);
    if (
      boardOperationScopeKey(
        boardOperationScopeRef.current.epoch,
        historyEpochRef.current,
      ) === scopeKey
    ) {
      setClipboardBusy(true);
    }
    return scopeKey;
  }, []);

  const endClipboardOperation = useCallback((scopeKey: string) => {
    const pending = clipboardPendingByScopeRef.current;
    const next = Math.max(0, (pending.get(scopeKey) ?? 0) - 1);
    if (next === 0) pending.delete(scopeKey);
    else pending.set(scopeKey, next);
    if (
      mountedRef.current
      && boardOperationScopeKey(
        boardOperationScopeRef.current.epoch,
        historyEpochRef.current,
      ) === scopeKey
      && next === 0
    ) {
      setClipboardBusy(false);
    }
  }, []);

  const captureInsertionTarget = useCallback((
    explicitAnchor?: BoardPoint,
    expectedDocument = documentRef.current,
  ): BoardInsertionTarget => {
    const host = hostRef.current;
    const currentCamera = cameraRef.current;
    const camera = {
      x: Number.isFinite(currentCamera.x) ? currentCamera.x : 0,
      y: Number.isFinite(currentCamera.y) ? currentCamera.y : 0,
      zoom:
        Number.isFinite(currentCamera.zoom) && currentCamera.zoom > 0
          ? currentCamera.zoom
          : 1,
    };
    const viewportWidth = host && host.clientWidth > 0
      ? host.clientWidth
      : DEFAULT_PLACEMENT_VIEWPORT.width;
    const viewportHeight = host && host.clientHeight > 0
      ? host.clientHeight
      : DEFAULT_PLACEMENT_VIEWPORT.height;
    const rememberedAnchor = explicitAnchor ?? lastCursor.current;
    const anchor = rememberedAnchor
      && Number.isFinite(rememberedAnchor.x)
      && Number.isFinite(rememberedAnchor.y)
      ? { x: rememberedAnchor.x, y: rememberedAnchor.y }
      : {
          x: (viewportWidth / 2 - camera.x) / camera.zoom,
          y: (viewportHeight / 2 - camera.y) / camera.zoom,
        };
    return {
      document: expectedDocument,
      operationEpoch: boardOperationScopeRef.current.epoch,
      historyEpoch: historyEpochRef.current,
      anchor,
      camera,
      viewportWidth,
      viewportHeight,
    };
  }, []);

  const cascadedInsertionTarget = useCallback((
    target: BoardInsertionTarget,
    fingerprint: string,
  ): BoardInsertionTarget => {
    const previous = lastPasteRef.current;
    const count = previous?.fingerprint === fingerprint
      ? previous.count + 1
      : 0;
    lastPasteRef.current = { fingerprint, count };
    const zoom = Number.isFinite(target.camera.zoom) && target.camera.zoom > 0
      ? target.camera.zoom
      : 1;
    const cascade = (count * PASTE_CASCADE_PX) / zoom;
    return {
      ...target,
      anchor: {
        x: target.anchor.x + cascade,
        y: target.anchor.y + cascade,
      },
    };
  }, []);

  const persistImageObject = useCallback(async (
    file: File,
    expectedDocument: Y.Doc,
    transformFor: (asset: BoardImageInsertion) => AtomicTransform,
    expectedOperationEpoch = boardOperationScopeRef.current.epoch,
    expectedHistoryEpoch = historyEpochRef.current,
    selectAfterCreate = true,
  ): Promise<string | null> => {
    if (
      !mountedRef.current
      || readOnlyRef.current
      || documentRef.current !== expectedDocument
      || boardOperationScopeRef.current.epoch !== expectedOperationEpoch
      || historyEpochRef.current !== expectedHistoryEpoch
    ) {
      return null;
    }
    if (!insertImage) {
      throw new Error("Вставка изображений сейчас недоступна");
    }
    const asset = await insertImage(file);
    if (
      !mountedRef.current
      || readOnlyRef.current
      || documentRef.current !== expectedDocument
      || boardOperationScopeRef.current.epoch !== expectedOperationEpoch
      || historyEpochRef.current !== expectedHistoryEpoch
    ) {
      return null;
    }
    const insertedId = commitObjectDraftRef.current(
      expectedDocument,
      imageObjectDraft(asset, transformFor(asset)),
      false,
      expectedOperationEpoch,
      expectedHistoryEpoch,
    );
    if (insertedId && selectAfterCreate) setTool("select");
    return insertedId;
  }, [insertImage]);

  const captureSelectionFragment = useCallback(() => {
    const sourceDocument = documentRef.current;
    const sourceObjects = getPageObjects(sourceDocument);
    const objectIds = [...new Set(selectionRef.current)]
      .filter((id) => sourceObjects.has(id));
    if (objectIds.length === 0) return null;
    const fragment = createBoardFragment(sourceDocument, objectIds, {
      scope: fragmentScopeRef.current,
    });
    return {
      document: sourceDocument,
      operationEpoch: boardOperationScopeRef.current.epoch,
      historyEpoch: historyEpochRef.current,
      objectIds,
      stateVector: Y.encodeStateVector(sourceDocument),
      bytes: encodeBoardFragment(fragment),
    };
  }, []);

  const deleteCapturedSelection = useCallback((capture: {
    readonly document: Y.Doc;
    readonly operationEpoch: number;
    readonly historyEpoch: number;
    readonly objectIds: readonly string[];
    readonly stateVector: Uint8Array;
  }): boolean => {
    if (
      readOnlyRef.current
      || documentRef.current !== capture.document
      || boardOperationScopeRef.current.epoch !== capture.operationEpoch
      || historyEpochRef.current !== capture.historyEpoch
      || !sameObjectIds(selectionRef.current, capture.objectIds)
      || !stateVectorsEqual(
        capture.stateVector,
        Y.encodeStateVector(capture.document),
      )
    ) {
      return false;
    }
    if (!deleteBoardObjects(
      capture.document,
      capture.objectIds,
      localOriginRef.current,
    )) {
      return false;
    }
    undoRef.current.commandBoundary();
    setEditing(null);
    setSurfaceSelection([]);
    return true;
  }, [setSurfaceSelection]);

  const copySelection = useCallback(async () => {
    let capture: ReturnType<typeof captureSelectionFragment>;
    try {
      capture = captureSelectionFragment();
    } catch {
      setInsertError("Не удалось скопировать выбранные объекты");
      return;
    }
    if (!capture) return;
    setInsertError(null);
    const clipboardScopeKey = beginClipboardOperation(boardOperationScopeKey(
      capture.operationEpoch,
      capture.historyEpoch,
    ));
    try {
      const result = await clipboardRef.current.write(capture.bytes);
      if (
        !result.system
        && mountedRef.current
        && boardOperationScopeRef.current.epoch === capture.operationEpoch
        && historyEpochRef.current === capture.historyEpoch
      ) {
        setInsertError(
          "Копия доступна только в этой вкладке: системный буфер недоступен",
        );
      }
    } finally {
      endClipboardOperation(clipboardScopeKey);
    }
  }, [
    beginClipboardOperation,
    captureSelectionFragment,
    endClipboardOperation,
  ]);

  const cutSelection = useCallback(async () => {
    if (readOnlyRef.current) return;
    let capture: ReturnType<typeof captureSelectionFragment>;
    try {
      capture = captureSelectionFragment();
    } catch {
      setInsertError("Не удалось скопировать выбранные объекты");
      return;
    }
    if (!capture) return;
    setInsertError(null);
    const clipboardScopeKey = beginClipboardOperation(boardOperationScopeKey(
      capture.operationEpoch,
      capture.historyEpoch,
    ));
    try {
      const result = await clipboardRef.current.write(capture.bytes);
      if (
        !mountedRef.current
        || boardOperationScopeRef.current.epoch !== capture.operationEpoch
        || historyEpochRef.current !== capture.historyEpoch
      ) return;
      if (!result.system) {
        setInsertError(
          "Системный буфер недоступен. Объекты скопированы в эту вкладку и не удалены",
        );
        return;
      }
      if (!deleteCapturedSelection(capture)) {
        setInsertError(
          "Доска изменилась во время копирования. Объекты скопированы и не удалены",
        );
      }
    } finally {
      endClipboardOperation(clipboardScopeKey);
    }
  }, [
    beginClipboardOperation,
    captureSelectionFragment,
    deleteCapturedSelection,
    endClipboardOperation,
  ]);

  const pasteFragmentBytes = useCallback(async (
    bytes: Uint8Array,
    target: BoardInsertionTarget,
  ) => {
    if (
      readOnlyRef.current
      || documentRef.current !== target.document
      || boardOperationScopeRef.current.epoch !== target.operationEpoch
      || historyEpochRef.current !== target.historyEpoch
    ) {
      return;
    }
    const fragment = decodeBoardFragment(bytes);
    const imageAssets = boardFragmentImageAssets(fragment);
    await validateFragmentPasteRef.current?.(fragment, imageAssets);
    if (
      !mountedRef.current
      || readOnlyRef.current
      || documentRef.current !== target.document
      || boardOperationScopeRef.current.epoch !== target.operationEpoch
      || historyEpochRef.current !== target.historyEpoch
    ) {
      return;
    }

    const insertionTarget = cascadedInsertionTarget(
      target,
      `fragment:${fragmentFingerprint(bytes)}`,
    );
    const history = undoRef.current;
    history.commandBoundary();
    let insertedIds: readonly string[];
    try {
      insertedIds = insertBoardFragment(
        target.document,
        fragment,
        localOriginRef.current,
        {
          idFactory: () => crypto.randomUUID(),
          anchor: insertionTarget.anchor,
        },
      );
    } finally {
      history.commandBoundary();
    }
    if (insertedIds.length === 0) {
      throw new Error("Board fragment contains no objects");
    }
    setEditing(null);
    setSurfaceSelection(insertedIds);
    setInsertError(null);
  }, [cascadedInsertionTarget, setSurfaceSelection]);

  const pastePayload = useCallback(async (
    payload: BoardPastePayload,
    target: BoardInsertionTarget,
  ) => {
    if (
      readOnlyRef.current
      || documentRef.current !== target.document
      || boardOperationScopeRef.current.epoch !== target.operationEpoch
      || historyEpochRef.current !== target.historyEpoch
    ) {
      return;
    }
    if (payload.kind === "fragment") {
      await pasteFragmentBytes(payload.bytes, target);
      return;
    }
    if (payload.kind === "image") {
      const file = clipboardImageFile(payload);
      const insertedId = await persistImageObject(
        file,
        target.document,
        (asset) => {
          const scale = Math.min(
            1,
            720 / Math.max(asset.width, asset.height),
          );
          const insertionTarget = cascadedInsertionTarget(
            target,
            `image:${asset.contentHash ?? asset.assetId}:${asset.originalBytes}`,
          );
          return anchoredVisibleTransform(
            insertionTarget,
            Math.max(40, asset.width * scale),
            Math.max(40, asset.height * scale),
          );
        },
        target.operationEpoch,
        target.historyEpoch,
      );
      if (insertedId) setInsertError(null);
      return;
    }

    const insertionTarget = cascadedInsertionTarget(
      target,
      `text:${textFingerprint(payload.text)}`,
    );
    const size = clipboardTextObjectSize(payload.text);
    const insertedId = commitObjectDraftRef.current(
      target.document,
      {
        kind: BUILTIN_OBJECT_KINDS.text,
        transform: anchoredVisibleTransform(
          insertionTarget,
          size.width,
          size.height,
        ),
        props: { text: payload.text },
      },
      false,
      target.operationEpoch,
      target.historyEpoch,
    );
    if (insertedId) setInsertError(null);
  }, [
    cascadedInsertionTarget,
    pasteFragmentBytes,
    persistImageObject,
  ]);

  const queuePaste = useCallback((
    source:
      | BoardPastePayload
      | null
      | Promise<BoardPastePayload | null>,
    target: BoardInsertionTarget = captureInsertionTarget(),
    emptyMessage?: string,
  ) => {
    const operationEpoch = target.operationEpoch;
    const historyEpoch = target.historyEpoch;
    const scopeKey = boardOperationScopeKey(operationEpoch, historyEpoch);
    const clipboardScopeKey = beginClipboardOperation(scopeKey);
    const settledSource = Promise.resolve(source).then(
      (payload) => ({ ok: true as const, payload }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const previous = pasteQueueRef.current.scopeKey === scopeKey
      ? pasteQueueRef.current.tail
      : Promise.resolve();
    const operation = previous.then(
      async () => {
        if (
          !mountedRef.current
          || readOnlyRef.current
          || documentRef.current !== target.document
          || boardOperationScopeRef.current.epoch !== operationEpoch
          || historyEpochRef.current !== historyEpoch
        ) {
          return;
        }
        const result = await settledSource;
        if (!result.ok) throw result.error;
        if (
          !mountedRef.current
          || readOnlyRef.current
          || documentRef.current !== target.document
          || boardOperationScopeRef.current.epoch !== operationEpoch
          || historyEpochRef.current !== historyEpoch
        ) {
          return;
        }
        if (!result.payload) {
          if (emptyMessage) throw new Error(emptyMessage);
          return;
        }
        await pastePayload(result.payload, target);
      },
    );
    pasteQueueRef.current = {
      scopeKey,
      tail: operation.catch(() => undefined),
    };
    void operation.catch((error) => {
      if (
        !mountedRef.current
        || readOnlyRef.current
        || documentRef.current !== target.document
        || boardOperationScopeRef.current.epoch !== operationEpoch
        || historyEpochRef.current !== historyEpoch
      ) {
        return;
      }
      setInsertError(
        error instanceof Error
          ? error.message
          : "Не удалось вставить объекты",
      );
    }).finally(() => endClipboardOperation(clipboardScopeKey));
  }, [
    beginClipboardOperation,
    captureInsertionTarget,
    endClipboardOperation,
    pastePayload,
  ]);

  const pasteFromClipboard = useCallback((anchor?: BoardPoint) => {
    if (readOnlyRef.current) return;
    const target = captureInsertionTarget(anchor);
    queuePaste(
      clipboardRef.current.read(),
      target,
      "В системном буфере нет объектов, изображений или текста",
    );
  }, [
    captureInsertionTarget,
    queuePaste,
  ]);

  const duplicateSelection = useCallback((anchor?: BoardPoint) => {
    if (readOnlyRef.current) return;
    try {
      const capture = captureSelectionFragment();
      if (capture) {
        queuePaste(
          { kind: "fragment", bytes: capture.bytes },
          captureInsertionTarget(anchor, capture.document),
        );
      }
    } catch {
      setInsertError("Не удалось продублировать выбранные объекты");
    }
  }, [captureInsertionTarget, captureSelectionFragment, queuePaste]);

  const deleteSelection = useCallback(() => {
    if (readOnlyRef.current) return;
    const targetDocument = documentRef.current;
    const targetObjects = getPageObjects(targetDocument);
    const selectedIds = [...new Set(selectionRef.current)].filter((id) => {
      const record = targetObjects.get(id);
      return targetObjects.has(id)
        && isBoardObjectMutable(boardObjectSnapshot(record, id));
    });
    if (selectedIds.length > 0 && deleteBoardObjects(
      targetDocument,
      selectedIds,
      localOriginRef.current,
    )) {
      undoRef.current.commandBoundary();
    }
    setEditing(null);
    setSurfaceSelection([]);
  }, [setSurfaceSelection]);

  const scheduleLiveAwareness = useCallback((change: BoardAwarenessState) => {
    pendingLiveAwareness.current = {
      ...pendingLiveAwareness.current,
      ...change,
    };
    if (awarenessFrame.current !== null) return;
    awarenessFrame.current = requestAnimationFrame(() => {
      awarenessFrame.current = null;
      const pending = pendingLiveAwareness.current;
      pendingLiveAwareness.current = {};
      onAwarenessChangeRef.current?.(pending);
    });
  }, []);

  const sendCursor = useCallback((point: BoardPoint | null) => {
    lastCursor.current = point;
    scheduleLiveAwareness({ cursor: point });
  }, [scheduleLiveAwareness]);

  const scheduleCameraState = useCallback((next: BoardCamera) => {
    cameraRef.current = next;
    pendingCameraState.current = next;
    if (cameraStateFrame.current !== null) return;
    cameraStateFrame.current = requestAnimationFrame(() => {
      cameraStateFrame.current = null;
      const pending = pendingCameraState.current;
      pendingCameraState.current = null;
      if (pending) setCameraState(pending);
    });
  }, []);

  const commitObjectDraft = useCallback((
    expectedDocument: Y.Doc,
    draft: BoardObjectDraft,
    editAfterCreate = true,
    expectedOperationEpoch = boardOperationScopeRef.current.epoch,
    expectedHistoryEpoch = historyEpochRef.current,
  ): string | null => {
    if (
      !mountedRef.current
      || readOnlyRef.current
      || documentRef.current !== expectedDocument
      || boardOperationScopeRef.current.epoch !== expectedOperationEpoch
      || historyEpochRef.current !== expectedHistoryEpoch
    ) {
      return null;
    }
    const targetObjects = getPageObjects(expectedDocument);
    const origin = localOriginRef.current;
    const history = undoRef.current;
    const id = crypto.randomUUID();
    let props = draft.props ?? {};
    if (draft.kind === BUILTIN_OBJECT_KINDS.text) {
      props = createTextProps(typeof props.text === "string" ? props.text : "");
    } else if (draft.kind === BUILTIN_OBJECT_KINDS.code) {
      props = createCodeProps(
        typeof props.source === "string" ? props.source : "",
        "python",
        typeof props.runnerProfile === "string" ? props.runnerProfile : "browser",
      );
    } else if (draft.kind === BUILTIN_OBJECT_KINDS.latex) {
      props = createLatexProps(typeof props.source === "string" ? props.source : "");
    } else if (
      draft.kind === BUILTIN_OBJECT_KINDS.stroke
      && Array.isArray(props.strokePoints)
    ) {
      props = {
        ...props,
        points: encodeStrokePoints(props.strokePoints as Array<{ x: number; y: number; pressure: number }>),
      };
      const mutable = { ...props };
      delete mutable.strokePoints;
      props = mutable;
    }
    if (rankCursorRef.current.needsNormalization) {
      normalizeObjectZRanks(expectedDocument);
      const normalized = [...targetObjects.entries()].map(([objectId, record]) =>
        boardObjectSnapshot(record, objectId));
      rankCursorRef.current = boardRankCursor(normalized);
    }
    const zRank = newRankAfter(rankCursorRef.current.rank);
    rankCursorRef.current = {
      rank: zRank,
      needsNormalization: false,
    };
    history.commandBoundary();
    try {
      addBoardObject(expectedDocument, {
        id,
        kind: draft.kind,
        version: 1,
        transform: draft.transform,
        zRank,
        style: draft.style,
        props,
      }, origin);
    } finally {
      history.commandBoundary();
    }
    if (draft.kind !== BUILTIN_OBJECT_KINDS.stroke) {
      setSurfaceSelection([id]);
    } else if (selectionRef.current.length > 0) {
      setSurfaceSelection([]);
    }
    if (
      editAfterCreate
      && [BUILTIN_OBJECT_KINDS.text, BUILTIN_OBJECT_KINDS.code, BUILTIN_OBJECT_KINDS.latex].includes(
      draft.kind as typeof BUILTIN_OBJECT_KINDS.text,
      )
    ) {
      setEditing({ objectId: id, kind: draft.kind });
    } else {
      setEditing(null);
    }
    return id;
  }, [setSurfaceSelection]);
  commitObjectDraftRef.current = commitObjectDraft;

  const beginPendingText = useCallback((
    expectedDocument: Y.Doc,
    draft: BoardObjectDraft,
  ) => {
    if (
      readOnlyRef.current
      || documentRef.current !== expectedDocument
      || draft.kind !== BUILTIN_OBJECT_KINDS.text
    ) {
      return;
    }
    undoRef.current.focusBoundary();
    setSurfaceSelection([]);
    setEditing({
      objectId: crypto.randomUUID(),
      kind: BUILTIN_OBJECT_KINDS.text,
      pendingText: {
        document: expectedDocument,
        draft,
        operationEpoch: boardOperationScopeRef.current.epoch,
        historyEpoch: historyEpochRef.current,
      },
    });
  }, [setSurfaceSelection]);

  const promotePendingText = useCallback((
    pendingText: NonNullable<EditingState["pendingText"]>,
    value: string,
  ) => {
    if (
      value.trim().length === 0
      || promotedPendingTextRef.current.has(pendingText)
    ) {
      return;
    }
    promotedPendingTextRef.current.add(pendingText);
    const insertedId = commitObjectDraft(
      pendingText.document,
      {
        ...pendingText.draft,
        props: {
          ...(pendingText.draft.props ?? {}),
          text: value,
        },
      },
      true,
      pendingText.operationEpoch,
      pendingText.historyEpoch,
    );
    if (insertedId === null) setEditing(null);
  }, [commitObjectDraft]);

  const cancelCodeRun = useCallback(() => {
    codeRunSequenceRef.current += 1;
    activeCodeRunRef.current?.cancel();
    activeCodeRunRef.current = null;
  }, []);

  const placeToolAt = useCallback((
    placementTool: BoardPlacementTool,
    point: BoardPoint,
  ) => {
    if (readOnlyRef.current) return;
    const target = captureInsertionTarget(point);
    if (placementTool === "image") {
      if (!insertImage) return;
      pendingImagePlacementRef.current = target;
      fileRef.current?.click();
      return;
    }
    commitObjectDraftRef.current(
      target.document,
      placementTool === "code"
        ? {
            kind: BUILTIN_OBJECT_KINDS.code,
            transform: anchoredVisibleTransform(target, 360, 240),
            props: {
              source: "",
              language: "python",
              runnerProfile: "browser",
            },
          }
        : {
            kind: BUILTIN_OBJECT_KINDS.latex,
            transform: anchoredVisibleTransform(target, 260, 110),
            props: { source: "\\frac{a}{b}" },
          },
      true,
      target.operationEpoch,
      target.historyEpoch,
    );
  }, [captureInsertionTarget, insertImage]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = rendererFactory.create(host, {
      onCameraChange: scheduleCameraState,
      onCursorChange: (point) => sendCursor(point),
      onSelectionChange: (ids) => setSurfaceSelection(ids),
      onCreateObject: (draft) => {
        if (
          draft.kind === BUILTIN_OBJECT_KINDS.text
          && (
            typeof draft.props?.text !== "string"
            || draft.props.text.trim().length === 0
          )
        ) {
          beginPendingText(document, draft);
          return;
        }
        commitObjectDraftRef.current(document, draft);
      },
      onPlaceTool: placeToolAt,
      onDeleteObjects: (ids) => {
        if (readOnlyRef.current) return;
        const existingIds = [...new Set(ids)].filter((id) => objects.has(id));
        if (existingIds.length > 0) {
          deleteBoardObjects(document, existingIds, localOriginRef.current);
          undoRef.current.commandBoundary();
        }
      },
      onTransformStart: () => {
        if (!readOnlyRef.current) undoRef.current.beginGesture();
      },
      onTransformCancel: () => {
        undoRef.current.endGesture();
      },
      onTransformObjects: (transforms) => {
        if (!readOnlyRef.current) {
          transformObjects(document, transforms, localOriginRef.current);
        }
        undoRef.current.endGesture();
      },
      onEditObject: (id) => {
        if (readOnlyRef.current) return;
        const record = objects.get(id);
        if (!objects.has(id)) return;
        const object = boardObjectSnapshot(record, id);
        if (![BUILTIN_OBJECT_KINDS.text, BUILTIN_OBJECT_KINDS.code, BUILTIN_OBJECT_KINDS.latex].includes(
          object.kind as typeof BUILTIN_OBJECT_KINDS.text,
        )) return;
        setEditing({ objectId: id, kind: object.kind });
        setRunOutput(typeof object.props.outputSnapshot === "string" ? object.props.outputSnapshot : "");
        undoRef.current.focusBoundary();
      },
      onLaserChange: (preview, clearMode) => {
        scheduleLiveAwareness({
          laser: preview,
          laserClearMode: preview ? null : clearMode ?? "fade",
        });
      },
      onPenLaserModeChange: (active) => {
        setPenLaserActive(active);
      },
      onGesturePreviewChange: (preview) => {
        scheduleLiveAwareness({ gesturePreview: preview });
      },
      onContextMenu: openContextMenu,
    }, {
      readOnly: readOnlyRef.current,
      theme,
      gridVisible,
      resolveAssetUrl: (assetId, contentHash) =>
        resolveAssetUrlRef.current?.(assetId, contentHash) ?? null,
    });
    rendererRef.current = renderer;
    renderer.setTool(tool);
    renderer.setTheme(theme);
    renderer.setCreationStyle(currentToolStyle);
    renderer.setConnectorCurvature(currentConnectorCurvature);
    const assetIdByObject = assetIdByObjectRef.current;
    const objectIdsByAsset = objectIdsByAssetRef.current;
    assetIdByObject.clear();
    objectIdsByAsset.clear();
    const indexAssetObject = (
      objectId: string,
      object: BoardObjectSnapshot | null,
    ) => {
      const previousAssetId = assetIdByObject.get(objectId);
      if (previousAssetId) {
        const previousIds = objectIdsByAsset.get(previousAssetId);
        previousIds?.delete(objectId);
        if (previousIds?.size === 0) objectIdsByAsset.delete(previousAssetId);
        assetIdByObject.delete(objectId);
      }
      if (!object) return;
      const assetId = imageAssetId(object);
      if (!assetId) return;
      assetIdByObject.set(objectId, assetId);
      let ids = objectIdsByAsset.get(assetId);
      if (!ids) {
        ids = new Set();
        objectIdsByAsset.set(assetId, ids);
      }
      ids.add(objectId);
    };
    const initialObjects = [...objects.entries()].map(([id, record]) =>
      boardObjectSnapshot(record, id));
    rankCursorRef.current = boardRankCursor(initialObjects);
    for (const object of initialObjects) indexAssetObject(object.id, object);
    renderer.setObjects(initialObjects);

    const observer = (events: readonly Y.YEvent<Y.AbstractType<unknown>>[]) => {
      const changed = new Set<string>();
      for (const event of events) {
        if (typeof event.path[0] === "string") changed.add(event.path[0]);
        if (event.path.length === 0 && event.target === objects && event instanceof Y.YMapEvent) {
          for (const key of event.keysChanged) changed.add(key);
        }
      }
      for (const id of changed) {
        const record = objects.get(id);
        if (objects.has(id)) {
          const object = boardObjectSnapshot(record, id);
          const rankCursor = rankCursorRef.current;
          if (object.rendering?.status === "malformed") {
            // Malformed placeholders are preserved but do not participate in
            // canonical layer ordering.
          } else if (!isValidZRank(object.zRank)) {
            rankCursorRef.current = {
              ...rankCursor,
              needsNormalization: true,
            };
          } else if (
            !rankCursor.needsNormalization
            && (
              rankCursor.rank === null
              || compareCodeUnitStrings(object.zRank, rankCursor.rank) > 0
            )
          ) {
            rankCursorRef.current = {
              rank: object.zRank,
              needsNormalization: false,
            };
          }
          indexAssetObject(id, object);
          renderer.setObject(object);
        } else {
          indexAssetObject(id, null);
          renderer.deleteObject(id);
        }
      }
      const activeEditing = editingRef.current;
      if (
        activeEditing
        && !activeEditing.pendingText
        && changed.has(activeEditing.objectId)
        && !objects.has(activeEditing.objectId)
      ) {
        setEditing((current) =>
          current
          && !current.pendingText
          && current.objectId === activeEditing.objectId
            ? null
            : current);
      }
      if (
        selectionRef.current.some(
          (id) => changed.has(id) && !objects.has(id),
        )
      ) {
        setSurfaceSelection(
          selectionRef.current.filter((id) => objects.has(id)),
        );
      }
      const editingId = editingRef.current?.objectId;
      if (
        (editingId && changed.has(editingId))
        || selectionRef.current.some((id) => changed.has(id))
      ) {
        setRevision((value) => value + 1);
      }
    };
    objects.observeDeep(observer);
    return () => {
      objects.unobserveDeep(observer);
      assetIdByObject.clear();
      objectIdsByAsset.clear();
      renderer.destroy();
      if (rendererRef.current === renderer) rendererRef.current = null;
      cancelCodeRun();
    };
  }, [
    beginPendingText,
    cancelCodeRun,
    document,
    objects,
    openContextMenu,
    placeToolAt,
    rendererFactory,
    scheduleCameraState,
    scheduleLiveAwareness,
    sendCursor,
    setSurfaceSelection,
  ]);

  useLayoutEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setInlineEditingObject(inlineEditingObjectId);
    return () => renderer.setInlineEditingObject(null);
  }, [inlineEditingObjectId]);

  useEffect(() => {
    rendererRef.current?.setTool(tool);
    undo.toolBoundary();
    onAwarenessChangeRef.current?.({ activeTool: tool });
  }, [tool, undo]);

  useEffect(() => {
    editorCompositionTargetRef.current = null;
  }, [document, editing?.objectId, readOnly]);

  useEffect(() => {
    rendererRef.current?.setCreationStyle(currentToolStyle);
  }, [currentToolStyle]);

  useEffect(() => {
    rendererRef.current?.setConnectorCurvature(currentConnectorCurvature);
  }, [currentConnectorCurvature]);

  useEffect(() => {
    persistBoardConnectorCurvature(connectorCurvatures);
  }, [connectorCurvatures]);

  useEffect(() => {
    persistBoardToolbarPreferences(toolbarPreferences);
  }, [toolbarPreferences]);

  useEffect(() => {
    const currentScopeKey = boardOperationScopeKey(
      boardOperationScopeRef.current.epoch,
      historyEpochRef.current,
    );
    const pending = clipboardPendingByScopeRef.current;
    for (const scopeKey of pending.keys()) {
      if (scopeKey !== currentScopeKey) pending.delete(scopeKey);
    }
    if (pasteQueueRef.current.scopeKey !== currentScopeKey) {
      pasteQueueRef.current = {
        scopeKey: currentScopeKey,
        tail: Promise.resolve(),
      };
    }
    setClipboardBusy((pending.get(currentScopeKey) ?? 0) > 0);
  }, [document, readOnly]);

  useEffect(() => {
    rendererRef.current?.setReadOnly(readOnly);
    if (readOnly) {
      pendingImagePlacementRef.current = null;
      closeContextMenu(false);
      setEditing(null);
      cancelCodeRun();
      setRunning(false);
      if (!READ_ONLY_TOOLS.has(tool)) setTool("select");
    }
  }, [cancelCodeRun, closeContextMenu, readOnly, tool]);

  useEffect(() => {
    pendingImagePlacementRef.current = null;
    closeContextMenu(false);
    setEditing(null);
    lastCursor.current = null;
    lastPasteRef.current = null;
    rendererRef.current?.setSelection([]);
    setSelection([]);
    selectionRef.current = [];
    setRunOutput("");
    setRunning(false);
    setRecoveryExport("idle");
  }, [closeContextMenu, document]);

  useEffect(() => {
    const targetId = contextMenu?.objectId;
    if (targetId && !selection.includes(targetId)) {
      closeContextMenu(false);
    }
  }, [closeContextMenu, contextMenu?.objectId, selection]);

  useEffect(() => {
    rendererRef.current?.setPresence(presences);
  }, [presences]);

  useEffect(() => {
    if (
      !assetRefresh
      || renderedAssetRevisionRef.current >= assetRefresh.revision
    ) {
      return;
    }
    renderedAssetRevisionRef.current = assetRefresh.revision;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const objectIds = objectIdsByAssetRef.current.get(assetRefresh.assetId);
    if (!objectIds) return;
    for (const id of objectIds) {
      const record = objects.get(id);
      if (objects.has(id)) {
        renderer.setObject(boardObjectSnapshot(record, id));
      }
    }
  }, [assetRefresh, objects]);

  useEffect(() => {
    const refresh = () => setHistoryRevision((value) => value + 1);
    const invalidatePendingScope = () => {
      historyEpochRef.current += 1;
      const scopeKey = boardOperationScopeKey(
        boardOperationScopeRef.current.epoch,
        historyEpochRef.current,
      );
      pasteQueueRef.current = {
        scopeKey,
        tail: Promise.resolve(),
      };
      clipboardPendingByScopeRef.current.clear();
      if (mountedRef.current) setClipboardBusy(false);
      refresh();
    };
    undo.manager.on("stack-item-added", refresh);
    undo.manager.on("stack-item-updated", refresh);
    undo.manager.on("stack-item-popped", invalidatePendingScope);
    undo.manager.on("stack-cleared", refresh);
    return () => {
      undo.manager.off("stack-item-added", refresh);
      undo.manager.off("stack-item-updated", refresh);
      undo.manager.off("stack-item-popped", invalidatePendingScope);
      undo.manager.off("stack-cleared", refresh);
    };
  }, [undo]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelCodeRun();
      if (awarenessFrame.current !== null) cancelAnimationFrame(awarenessFrame.current);
      if (cameraStateFrame.current !== null) {
        cancelAnimationFrame(cameraStateFrame.current);
      }
    };
  }, [cancelCodeRun]);

  useEffect(() => {
    const boardHasFocus = () => {
      const surface = surfaceRef.current;
      const activeElement = globalThis.document.activeElement;
      return Boolean(surface && activeElement && surface.contains(activeElement));
    };
    const copy = (event: ClipboardEvent) => {
      if (!boardHasFocus()) return;
      if (
        isNativeInputTarget(event.target)
        || isBoardContextMenuTarget(event.target)
      ) return;
      let capture: ReturnType<typeof captureSelectionFragment>;
      try {
        capture = captureSelectionFragment();
      } catch {
        setInsertError("Не удалось скопировать выбранные объекты");
        return;
      }
      if (!capture) return;
      const written = clipboardRef.current.writeToDataTransfer(
        event.clipboardData,
        capture.bytes,
      );
      if (written) {
        event.preventDefault();
        setInsertError(null);
      }
    };

    const cut = (event: ClipboardEvent) => {
      if (!boardHasFocus()) return;
      if (
        readOnlyRef.current
        || isNativeInputTarget(event.target)
        || isBoardContextMenuTarget(event.target)
      ) return;
      let capture: ReturnType<typeof captureSelectionFragment>;
      try {
        capture = captureSelectionFragment();
      } catch {
        setInsertError("Не удалось скопировать выбранные объекты");
        return;
      }
      if (!capture) return;
      const written = clipboardRef.current.writeToDataTransfer(
        event.clipboardData,
        capture.bytes,
      );
      if (!written) {
        setInsertError(
          "Системный буфер недоступен. Объекты скопированы в эту вкладку и не удалены",
        );
        return;
      }
      event.preventDefault();
      deleteCapturedSelection(capture);
      setInsertError(null);
    };

    const paste = (event: ClipboardEvent) => {
      if (!boardHasFocus()) return;
      if (
        readOnlyRef.current
        || isNativeInputTarget(event.target)
        || isBoardContextMenuTarget(event.target)
      ) return;
      try {
        const payload = clipboardRef.current.readFromDataTransfer(
          event.clipboardData,
        );
        if (!payload) return;
        const target = captureInsertionTarget();
        event.preventDefault();
        queuePaste(payload, target);
      } catch (error) {
        event.preventDefault();
        setInsertError(
          error instanceof Error
            ? error.message
            : "Содержимое буфера повреждено или не поддерживается",
        );
      }
    };

    window.addEventListener("copy", copy);
    window.addEventListener("cut", cut);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("copy", copy);
      window.removeEventListener("cut", cut);
      window.removeEventListener("paste", paste);
    };
  }, [
    captureInsertionTarget,
    captureSelectionFragment,
    deleteCapturedSelection,
    queuePaste,
  ]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Alt") return;
      const surface = surfaceRef.current;
      const activeElement = globalThis.document.activeElement;
      if (
        !surface
        || !activeElement
        || !surface.contains(activeElement)
        || isNativeInputTarget(event.target)
        || isNativeInputTarget(activeElement)
      ) return;
      suppressedAltKeysRef.current.add(event.code);
      event.preventDefault();
    };
    const keyup = (event: KeyboardEvent) => {
      if (
        event.key !== "Alt"
        || !suppressedAltKeysRef.current.delete(event.code)
      ) return;
      event.preventDefault();
    };
    const clearSuppressedAltKeys = () => {
      suppressedAltKeysRef.current.clear();
    };
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup, true);
    window.addEventListener("blur", clearSuppressedAltKeys);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
      window.removeEventListener("blur", clearSuppressedAltKeys);
      clearSuppressedAltKeys();
    };
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const surface = surfaceRef.current;
      const activeElement = globalThis.document.activeElement;
      if (!surface || !activeElement || !surface.contains(activeElement)) return;
      if (
        isNativeInputTarget(event.target)
        || isBoardContextMenuTarget(event.target)
      ) return;
      const command = event.ctrlKey || event.metaKey;
      if (
        event.code === "ContextMenu"
        || (event.shiftKey && event.code === "F10")
      ) {
        event.preventDefault();
        openKeyboardContextMenu();
      } else if (command && event.code === "KeyA") {
        event.preventDefault();
        selectAllObjects();
      } else if (command && (event.code === "Equal" || event.code === "NumpadAdd")) {
        event.preventDefault();
        zoomAtViewportCenter(ZOOM_STEP_FACTOR);
      } else if (command && (event.code === "Minus" || event.code === "NumpadSubtract")) {
        event.preventDefault();
        zoomAtViewportCenter(1 / ZOOM_STEP_FACTOR);
      } else if (command && event.code === "Digit0") {
        event.preventDefault();
        rendererRef.current?.fitToContent();
      } else if (command && event.code === "Digit1") {
        event.preventDefault();
        zoomToViewportCenter(1);
      } else if (!readOnly && command && event.code === "KeyD") {
        event.preventDefault();
        duplicateSelection();
      } else if (!readOnly && command && event.code === "KeyZ") {
        event.preventDefault();
        activeNudgeKeysRef.current.clear();
        rendererRef.current?.cancelInteraction();
        undo.endGesture();
        if (event.shiftKey) undo.redo();
        else undo.undo();
      } else if (!readOnly && command && event.code === "KeyY") {
        event.preventDefault();
        activeNudgeKeysRef.current.clear();
        rendererRef.current?.cancelInteraction();
        undo.endGesture();
        undo.redo();
      } else if (
        !readOnly
        && command
        && selection.length > 0
        && (event.code === "BracketRight" || event.code === "BracketLeft")
      ) {
        event.preventDefault();
        if (event.code === "BracketRight") {
          changeLayer(event.shiftKey ? "front" : "forward");
        } else {
          changeLayer(event.shiftKey ? "back" : "backward");
        }
      } else if ((event.code === "Delete" || event.code === "Backspace") && !readOnly && selection.length) {
        event.preventDefault();
        deleteSelection();
      } else if (
        !readOnly
        && !command
        && !event.altKey
        && selection.length > 0
        && (
          event.code === "ArrowLeft"
          || event.code === "ArrowRight"
          || event.code === "ArrowUp"
          || event.code === "ArrowDown"
        )
      ) {
        event.preventDefault();
        if (activeNudgeKeysRef.current.size === 0) undo.beginGesture();
        activeNudgeKeysRef.current.add(event.code);
        const distance = event.shiftKey ? 10 : 1;
        nudgeSelection(
          event.code === "ArrowLeft"
            ? -distance
            : event.code === "ArrowRight"
              ? distance
              : 0,
          event.code === "ArrowUp"
            ? -distance
            : event.code === "ArrowDown"
              ? distance
              : 0,
        );
      } else if (
        !readOnly
        && !command
        && !event.altKey
        && event.code === "Enter"
        && selectionRef.current.length === 1
      ) {
        const id = selectionRef.current[0];
        const record = objects.get(id);
        if (objects.has(id)) {
          const object = boardObjectSnapshot(record, id);
          if ([
            BUILTIN_OBJECT_KINDS.text,
            BUILTIN_OBJECT_KINDS.code,
            BUILTIN_OBJECT_KINDS.latex,
          ].includes(object.kind as typeof BUILTIN_OBJECT_KINDS.text)) {
            event.preventDefault();
            setEditing({ objectId: id, kind: object.kind });
            setRunOutput(
              typeof object.props.outputSnapshot === "string"
                ? object.props.outputSnapshot
                : "",
            );
            undo.focusBoundary();
          }
        }
      } else if (event.code === "Escape") {
        event.preventDefault();
        activeNudgeKeysRef.current.clear();
        rendererRef.current?.cancelInteraction();
        undo.endGesture();
        if (editingRef.current) {
          exitInlineEditingOnEscape();
        } else if (selectionRef.current.length > 0) {
          setSurfaceSelection([]);
        } else if (tool !== "select") {
          setTool("select");
        }
      } else if (event.code === "Home") {
        event.preventDefault();
        rendererRef.current?.fitToContent();
      } else if (
        !command
        && !event.altKey
        && !event.shiftKey
        && !event.repeat
      ) {
        const shortcutTool = boardToolShortcut(event);
        if (
          shortcutTool
          && (!readOnly || READ_ONLY_TOOLS.has(shortcutTool))
        ) {
          event.preventDefault();
          chooseTool(shortcutTool);
        }
      }
    };
    const keyup = (event: KeyboardEvent) => {
      if (!activeNudgeKeysRef.current.delete(event.code)) return;
      if (activeNudgeKeysRef.current.size === 0) undo.endGesture();
    };
    const stopNudge = () => {
      if (activeNudgeKeysRef.current.size === 0) return;
      activeNudgeKeysRef.current.clear();
      undo.endGesture();
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", stopNudge);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", stopNudge);
      stopNudge();
    };
  }, [
    changeLayer,
    chooseTool,
    deleteSelection,
    duplicateSelection,
    exitInlineEditingOnEscape,
    nudgeSelection,
    objects,
    openKeyboardContextMenu,
    readOnly,
    selectAllObjects,
    selection,
    setSurfaceSelection,
    tool,
    undo,
    zoomAtViewportCenter,
    zoomToViewportCenter,
  ]);

  useEffect(() => {
    const element = editorRef.current;
    if (readOnly || !editing || !element) return;
    if (editing.pendingText) return;
    const property = editing.kind === BUILTIN_OBJECT_KINDS.text
      ? "text"
      : "source";
    const record = objects.get(editing.objectId);
    const text = record ? getCollaborativeText(record, property) : undefined;
    if (!text) return;
    const binding = new CollaborativeTextareaBinding({
      element,
      text,
      localOrigin,
      undo,
      applyEdit: ({ index, deleteLength, insert }) => {
        replaceCollaborativeTextRange(
          document,
          editing.objectId,
          property,
          index,
          deleteLength,
          insert,
          localOrigin,
        );
      },
    });
    return () => binding.dispose();
  }, [
    document,
    editing?.kind,
    editing?.objectId,
    editing?.pendingText,
    localOrigin,
    objects,
    readOnly,
    undo,
  ]);

  const runCode = async () => {
    if (
      readOnly
      || activeCodeRunRef.current
      || !editing
      || editing.kind !== BUILTIN_OBJECT_KINDS.code
    ) return;
    const runDocument = document;
    const objectId = editing.objectId;
    const record = objects.get(objectId);
    const source = record
      ? getCollaborativeText(record, "source")?.toString() ?? ""
      : "";
    const sequence = codeRunSequenceRef.current + 1;
    codeRunSequenceRef.current = sequence;
    setRunning(true);
    setRunOutput("Загружаем Python и запускаем код...");
    try {
      const execution = startPythonRun({ kind: "script", code: source });
      activeCodeRunRef.current = execution;
      const result = await execution.result;
      if (activeCodeRunRef.current === execution) activeCodeRunRef.current = null;
      const output = result.status === "cancelled" ? null : result.output;
      if (
        output === null
        || !mountedRef.current
        || codeRunSequenceRef.current !== sequence
        || readOnlyRef.current
        || documentRef.current !== runDocument
        || !objects.has(objectId)
      ) return;
      setRunOutput(output);
      setObjectProperty(runDocument, objectId, "outputSnapshot", output, localOrigin);
      undo.commandBoundary();
    } catch (error) {
      if (mountedRef.current && codeRunSequenceRef.current === sequence) {
        setRunOutput(error instanceof Error ? error.message : "Не удалось выполнить код");
      }
    } finally {
      if (mountedRef.current && codeRunSequenceRef.current === sequence) setRunning(false);
    }
  };

  const onImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    const capturedTarget = pendingImagePlacementRef.current;
    pendingImagePlacementRef.current = null;
    if (readOnly || !file || !capturedTarget) return;
    const target = capturedTarget;
    const insertionDocument = target.document;
    const insertionOperationEpoch = target.operationEpoch;
    const insertionHistoryEpoch = target.historyEpoch;
    setInsertError(null);
    try {
      await persistImageObject(
        file,
        insertionDocument,
        (asset) => {
          const scale = Math.min(
            1,
            720 / Math.max(asset.width, asset.height),
          );
          return anchoredVisibleTransform(
            target,
            Math.max(40, asset.width * scale),
            Math.max(40, asset.height * scale),
          );
        },
        insertionOperationEpoch,
        insertionHistoryEpoch,
        false,
      );
    } catch (error) {
      if (
        mountedRef.current
        && documentRef.current === insertionDocument
        && boardOperationScopeRef.current.epoch === insertionOperationEpoch
        && historyEpochRef.current === insertionHistoryEpoch
      ) {
        setInsertError(error instanceof Error ? error.message : "Не удалось сохранить изображение");
      }
    }
  };

  const localTotal = serverMetrics?.logicalBytes
    ?? (metrics
      ? metrics.compactSnapshotBytes
        + (serverMetrics?.updateLogBytes ?? 0)
        + (serverMetrics?.assetBytes ?? 0)
      : null);
  const blockedAssetCount = assetHealth?.blocked.length ?? 0;
  const recoverableAssetCount =
    assetHealth?.blocked.filter((risk) => risk.hasLocalRecoveryCopy).length ?? 0;
  const assetRiskText = assetPersistenceAtRisk
    ? "Локальное хранилище изображений недоступно"
    : blockedAssetCount > 0
      ? recoverableAssetCount > 0
        ? blockedAssetCount === 1
          ? "Изображение не синхронизировано. Исходник сохранён локально"
          : `Не синхронизированы изображения: ${blockedAssetCount}. Локальные исходники сохранены`
        : blockedAssetCount === 1
          ? "Изображение недоступно, локальной копии нет"
          : `Недоступны изображения: ${blockedAssetCount}. Локальных копий нет`
      : "";
  const recoveryAvailable = Boolean(
    onExportRecovery
    && (
      status === "recovery-required"
      || status === "storage-error"
      || assetPersistenceAtRisk
      || recoverableAssetCount > 0
    ),
  );
  const connectionWarning =
    showTransientStatus
    || (
      status !== "loading-cache"
      && status !== "connecting"
      && status !== "pending"
    )
      ? statusText(status, pendingUpdates)
      : "";
  const warningText = recoveryExport === "error"
    ? "Не удалось выгрузить локальную копию доски"
    : assetRiskText || connectionWarning;
  const warningStatus = assetRiskText || recoveryExport === "error"
    ? "storage-error"
    : status;
  const exportRecovery = async () => {
    if (!onExportRecovery || recoveryExport === "exporting") return;
    setRecoveryExport("exporting");
    try {
      await onExportRecovery();
      setRecoveryExport("idle");
    } catch {
      setRecoveryExport("error");
    }
  };

  const contextMenuItems = useMemo<readonly BoardContextMenuItem[]>(() => {
    if (!contextMenu) return [];
    if (!contextMenu.objectMenu) {
      return [
        ...(!readOnly ? [{
          id: "paste",
          label: "Вставить",
          shortcut: "Ctrl+V",
          icon: ClipboardPaste,
          disabled: clipboardBusy,
          onSelect: () => void pasteFromClipboard(contextMenu.world),
        }] : []),
        {
          id: "select-all",
          label: "Выделить всё",
          shortcut: "Ctrl+A",
          icon: MousePointer2,
          onSelect: selectAllObjects,
        },
        {
          id: "fit",
          label: "Показать всю доску",
          shortcut: "Ctrl+0",
          icon: Maximize2,
          separatorBefore: true,
          onSelect: () => rendererRef.current?.fitToContent(),
        },
        {
          id: "zoom-100",
          label: "Масштаб 100%",
          shortcut: "Ctrl+1",
          icon: ZoomIn,
          onSelect: () => zoomToViewportCenter(1),
        },
        {
          id: "grid",
          label: "Показывать сетку",
          icon: Grid3x3,
          checked: gridVisible,
          onSelect: () => setGridVisible((current) => !current),
        },
      ];
    }

    const items: BoardContextMenuItem[] = [];
    if (!readOnly) {
      items.push({
        id: "cut",
        label: "Вырезать",
        shortcut: "Ctrl+X",
        icon: Scissors,
        disabled: clipboardBusy,
        onSelect: () => void cutSelection(),
      });
    }
    items.push({
      id: "copy",
      label: "Копировать",
      shortcut: "Ctrl+C",
      icon: Copy,
      disabled: clipboardBusy,
      onSelect: () => void copySelection(),
    });
    if (!readOnly) {
      items.push(
        {
          id: "paste",
          label: "Вставить",
          shortcut: "Ctrl+V",
          icon: ClipboardPaste,
          disabled: clipboardBusy,
          onSelect: () => void pasteFromClipboard(contextMenu.world),
        },
        {
          id: "duplicate",
          label: "Дублировать",
          shortcut: "Ctrl+D",
          icon: CopyPlus,
          disabled: clipboardBusy,
          onSelect: () => duplicateSelection(contextMenu.world),
        },
        {
          id: "delete",
          label: "Удалить",
          shortcut: "Del",
          icon: Trash2,
          destructive: true,
          onSelect: deleteSelection,
        },
        {
          id: "layers",
          label: "Порядок слоёв",
          icon: Layers3,
          separatorBefore: true,
          submenu: [
            {
              id: "front",
              label: "На передний план",
              shortcut: "Ctrl+Shift+]",
              icon: BringToFront,
              onSelect: () => changeLayer("front"),
            },
            {
              id: "forward",
              label: "На слой выше",
              shortcut: "Ctrl+]",
              icon: MoveUp,
              onSelect: () => changeLayer("forward"),
            },
            {
              id: "backward",
              label: "На слой ниже",
              shortcut: "Ctrl+[",
              icon: MoveDown,
              onSelect: () => changeLayer("backward"),
            },
            {
              id: "back",
              label: "На задний план",
              shortcut: "Ctrl+Shift+[",
              icon: SendToBack,
              onSelect: () => changeLayer("back"),
            },
          ],
        },
      );
    }
    items.push({
      id: "select-all",
      label: "Выделить всё",
      shortcut: "Ctrl+A",
      icon: MousePointer2,
      separatorBefore: true,
      onSelect: selectAllObjects,
    });
    return items;
  }, [
    changeLayer,
    clipboardBusy,
    contextMenu,
    copySelection,
    cutSelection,
    deleteSelection,
    duplicateSelection,
    gridVisible,
    pasteFromClipboard,
    readOnly,
    selectAllObjects,
    zoomToViewportCenter,
  ]);

  return (
    <section
      ref={surfaceRef}
      className={`board-v2 board-v2--${theme}${styleBarVisible ? " board-v2--has-stylebar" : ""}`}
      aria-label="Совместная доска"
      tabIndex={0}
      onPointerDownCapture={(event) => {
        const target = event.target;
        if (
          target instanceof HTMLCanvasElement
          || target === hostRef.current
        ) {
          surfaceRef.current?.focus({ preventScroll: true });
        }
      }}
    >
      <div ref={hostRef} className="board-v2__canvas" />
      {contextMenu && (
        <BoardContextMenu
          x={contextMenu.screen.x}
          y={contextMenu.screen.y}
          items={contextMenuItems}
          onClose={closeContextMenu}
        />
      )}

      <BoardToolbar
        activeTool={tool}
        penLaserActive={penLaserActive}
        readOnly={readOnly}
        imageAvailable={Boolean(insertImage)}
        preferences={toolbarPreferences}
        chooseTool={chooseTool}
        changePreferences={changeToolbarPreferences}
      />

      {styleBarVisible && (
        <BoardStyleBar
          available={styleBarAvailable}
          values={styleBarValues}
          mixed={styleBarMixed}
          fontStyleState={styleBarFontStyleState}
          connectorCurvature={
            !editingSelectionStyle && (tool === "line" || tool === "arrow")
              ? {
                  value: currentConnectorCurvature,
                  onChange: changeConnectorCurvature,
                }
              : undefined
          }
          freeDrawingPalette={tool === "pen" ? {
            presets: freeDrawingPresets,
            activePresetId: activeFreeDrawingPreset.id,
            onSelectPreset: selectFreeDrawingPreset,
            onChangePreset: updateFreeDrawingPreset,
            onAddPreset: addFreeDrawingPreset,
            onDeletePreset: removeFreeDrawingPreset,
            onMovePreset: reorderFreeDrawingPreset,
          } : undefined}
          sharedColorPalette={{
            slots: styleColorPalette.slots,
            recentColors: styleColorPalette.recentColors,
            onChangeSlot: updateStyleColorSlot,
            onAddSlot: addStyleColorSlot,
            onDeleteSlot: removeStyleColorSlot,
            onMoveSlot: reorderStyleColorSlot,
            onRememberColor: rememberStyleColor,
          }}
          allowTransparentFill={
            editingSelectionStyle
              ? selectionStyle.allowTransparentFill
              : tool !== "text"
          }
          fillColorLabel={editingSelectionStyle
            ? selectionStyle.fillColorLabel
            : tool === "text" ? "Цвет текста" : "Цвет заливки"}
          hideOpacity={editingSelectionStyle
            ? !selectionStyle.hasNonTextOpacity
            : tool === "text"}
          showFillPropertyIcon={editingSelectionStyle
            ? selectionStyle.showFillPropertyIcon
            : tool !== "text"}
          onStyleChange={applyStyleChange}
          onFontStyleToggle={applyFontStyleToggle}
          onContinuousChangeStart={beginContinuousStyleChange}
          onContinuousChangeEnd={endContinuousStyleChange}
        />
      )}

      <div className="board-v2__history" role="toolbar" aria-label="История действий">
        <button type="button" aria-label="Отменить" title="Отменить" disabled={!undo.canUndo || readOnly} onClick={() => undo.undo()}><Undo2 size={18} /></button>
        <button type="button" aria-label="Повторить" title="Повторить" disabled={!undo.canRedo || readOnly} onClick={() => undo.redo()}><Redo2 size={18} /></button>
        {!readOnly && (
          <button
            type="button"
            aria-label="Вставить"
            title="Вставить"
            disabled={clipboardBusy}
            onClick={() => void pasteFromClipboard()}
          ><ClipboardPaste size={18} /></button>
        )}
        {selection.length > 0 && (
          <button
            type="button"
            aria-label="Копировать выбранное"
            title="Копировать выбранное"
            disabled={clipboardBusy}
            onClick={() => void copySelection()}
          ><Copy size={18} /></button>
        )}
        {selection.length > 0 && !readOnly && (
          <button
            type="button"
            aria-label="Вырезать выбранное"
            title="Вырезать выбранное"
            disabled={clipboardBusy}
            onClick={() => void cutSelection()}
          ><Scissors size={18} /></button>
        )}
        {selection.length > 0 && !readOnly && (
          <button
            type="button"
            aria-label="Удалить выбранное"
            title="Удалить выбранное"
            onClick={deleteSelection}
          ><Trash2 size={18} /></button>
        )}
      </div>

      <div className="board-v2__zoom" role="toolbar" aria-label="Масштаб и вид">
        <button
          type="button"
          className="board-v2__zoom-step"
          aria-label="Уменьшить масштаб"
          title="Уменьшить масштаб"
          onClick={() => zoomAtViewportCenter(1 / ZOOM_STEP_FACTOR)}
        ><ZoomOut size={17} /></button>
        <button
          type="button"
          className="board-v2__zoom-value"
          aria-label="Вернуть масштаб 100%"
          title="Вернуть масштаб 100%"
          onClick={() => zoomToViewportCenter(1)}
        >{Math.round(camera.zoom * 100)}%</button>
        <button
          type="button"
          className="board-v2__zoom-step"
          aria-label="Увеличить масштаб"
          title="Увеличить масштаб"
          onClick={() => zoomAtViewportCenter(ZOOM_STEP_FACTOR)}
        ><ZoomIn size={17} /></button>
        <button
          type="button"
          className="board-v2__home"
          aria-label="В центр доски, затем масштаб 100%"
          title="В центр доски, затем масштаб 100%"
          onClick={homeCamera}
        ><House size={17} /></button>
        <span className="board-v2__zoom-separator" />
        <button
          type="button"
          className="board-v2__theme-toggle"
          aria-label={theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему"}
          title={theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему"}
          onClick={() => {
            if (appTheme) appTheme.toggleTheme();
            else setLocalTheme((current) => current === "dark" ? "light" : "dark");
          }}
        >
          {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
        </button>
      </div>

      <div className="board-v2__participants" aria-label="Участники">
        {presences.slice(0, 4).map((presence) => (
          <span
            key={presence.clientId}
            title={presence.displayName}
            style={{ "--presence-color": presence.color } as CSSProperties}
          >{presence.displayName.trim().slice(0, 1).toLocaleUpperCase()}</span>
        ))}
      </div>

      {(warningText || insertError) && (
        <div className={`board-v2__status board-v2__status--${warningStatus}`}>
          {insertError || warningText}
          {!insertError && recoveryAvailable && (
            <button
              type="button"
              aria-label="Скачать локальную копию доски"
              title="Скачать локальную копию доски"
              disabled={recoveryExport === "exporting"}
              onClick={() => void exportRecovery()}
            >
              <Download size={14} />
            </button>
          )}
          {insertError && (
            <button type="button" aria-label="Закрыть" onClick={() => setInsertError(null)}><X size={14} /></button>
          )}
        </div>
      )}

      <div className="board-v2__metrics">
        <button
          type="button"
          aria-label="Размер доски"
          title="Размер доски"
          aria-expanded={metricsOpen}
          onClick={() => setMetricsOpen((value) => !value)}
        >
          <MoreHorizontal size={18} />
          <span>{localTotal === null ? "Размер" : humanBytes(localTotal)}</span>
        </button>
        {metricsOpen && (
          <div className="board-v2__metrics-popover">
            <header><strong>Размер доски</strong><button type="button" aria-label="Закрыть" onClick={() => setMetricsOpen(false)}><X size={15} /></button></header>
            <dl>
              <div><dt>Объекты</dt><dd>{(metrics?.objectCount ?? objects.size).toLocaleString("ru-RU")}</dd></div>
              <div><dt>Снимок CRDT</dt><dd>{metrics ? humanBytes(metrics.compactSnapshotBytes) : "Считаем..."}</dd></div>
              <div><dt>Журнал обновлений</dt><dd>{serverMetrics ? `${serverMetrics.updateLogCount} / ${humanBytes(serverMetrics.updateLogBytes)}` : "Только локально"}</dd></div>
              <div><dt>Вложения</dt><dd>{serverMetrics ? `${serverMetrics.assetCount} / ${humanBytes(serverMetrics.assetBytes)}` : "Нет"}</dd></div>
              {assetHealth && (
                <div>
                  <dt>Локальная очередь файлов</dt>
                  <dd>{assetHealth.pendingLocalCount + assetHealth.pendingRemoteCount}</dd>
                </div>
              )}
              {blockedAssetCount > 0 && (
                <div><dt>Файлы с риском</dt><dd>{blockedAssetCount}</dd></div>
              )}
              <div><dt>Всего</dt><dd>{localTotal === null ? "Считаем..." : humanBytes(localTotal)}</dd></div>
              {serverMetrics?.physicalBytes !== undefined && (
                <div><dt>На сервере</dt><dd>{humanBytes(serverMetrics.physicalBytes)}</dd></div>
              )}
              {serverMetrics && (
                <div><dt>Последнее сжатие</dt><dd>{metricTime(serverMetrics.compactedAt)}</dd></div>
              )}
              {serverMetrics?.syncedAt && (
                <div><dt>Данные на</dt><dd>{metricTime(serverMetrics.syncedAt)}</dd></div>
              )}
            </dl>
          </div>
        )}
      </div>

      {!readOnly && editing && selectedObject && (
        <div
          className={editing.kind === BUILTIN_OBJECT_KINDS.text
            ? "board-v2__editor board-v2__editor--inline-text"
            : `board-v2__editor board-v2__editor--${editing.kind === BUILTIN_OBJECT_KINDS.code ? "code" : "text"}`}
          style={editing.kind === BUILTIN_OBJECT_KINDS.text
            ? inlineTextEditorStyle(
                selectedObject,
                rendererRef.current?.camera ?? camera,
                theme,
              )
            : editorStyle(
                selectedObject,
                rendererRef.current?.camera ?? camera,
                hostRef.current?.clientWidth,
                hostRef.current?.clientHeight,
              )}
        >
          {editing.kind === BUILTIN_OBJECT_KINDS.code && (
            <div className="board-v2__editor-head">
              <span className="board-v2__code-language">Python</span>
              <button type="button" disabled={running || readOnly} onClick={() => void runCode()}><Braces size={15} />{running ? "Выполняем" : "Запустить"}</button>
            </div>
          )}
          <textarea
            ref={editorRef}
            autoFocus
            readOnly={readOnly}
            wrap={editing.kind === BUILTIN_OBJECT_KINDS.text ? "soft" : undefined}
            spellCheck={editing.kind === BUILTIN_OBJECT_KINDS.text}
            aria-label={editing.kind === BUILTIN_OBJECT_KINDS.text
              ? "Редактировать текст"
              : undefined}
            defaultValue={editingText(selectedObject)}
            onCompositionStart={(event) => {
              editorCompositionTargetRef.current = event.currentTarget;
            }}
            onInput={(event) => {
              const pendingText = editing.pendingText;
              if (
                !pendingText
                || editorCompositionTargetRef.current === event.currentTarget
                || nativeEventIsComposing(event.nativeEvent)
              ) {
                return;
              }
              promotePendingText(pendingText, event.currentTarget.value);
            }}
            onCompositionEnd={(event) => {
              editorCompositionTargetRef.current = null;
              const pendingText = editing.pendingText;
              if (!pendingText) return;
              promotePendingText(pendingText, event.currentTarget.value);
            }}
            onBlur={(event) => {
              const nextTarget = event.relatedTarget;
              if (
                nextTarget instanceof Node
                && event.currentTarget.parentElement?.contains(nextTarget)
              ) return;
              editorCompositionTargetRef.current = null;
              undo.focusBoundary();
              setEditing(null);
            }}
            onKeyDown={(event) => {
              if (
                editorCompositionTargetRef.current === event.currentTarget
                || nativeEventIsComposing(event.nativeEvent)
                || event.keyCode === 229
              ) {
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                exitInlineEditingOnEscape();
              }
              if (
                event.key === "Enter"
                && editing.kind === BUILTIN_OBJECT_KINDS.text
                && !event.shiftKey
                && !event.ctrlKey
                && !event.metaKey
                && !event.altKey
              ) {
                event.preventDefault();
                undo.focusBoundary();
                setEditing(null);
              }
            }}
          />
          {editing.kind === BUILTIN_OBJECT_KINDS.code && runOutput && <pre>{runOutput}</pre>}
        </div>
      )}

      <input
        ref={fileRef}
        className="sr-only"
        type="file"
        disabled={readOnly}
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(event) => void onImage(event)}
      />
    </section>
  );
}
