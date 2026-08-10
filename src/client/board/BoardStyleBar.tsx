import {
  Bold,
  Check,
  ChevronDown,
  Italic,
  Palette,
  Plus,
  Spline,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  FREE_DRAWING_OPACITY_MAX,
  FREE_DRAWING_OPACITY_MIN,
  FREE_DRAWING_OPACITY_STEP,
  FREE_DRAWING_PRESET_MAX_COUNT,
  FREE_DRAWING_PRESET_MIN_COUNT,
  FREE_DRAWING_STROKE_WIDTH_MAX,
  FREE_DRAWING_STROKE_WIDTH_MIN,
  FREE_DRAWING_STROKE_WIDTH_STEP,
  type FreeDrawingPreset,
  type FreeDrawingPresetPatch,
} from "./freeDrawingPresets";
import { BoardDashControl } from "./BoardDashControl";
import {
  BoardColorControl,
  type BoardColorPaletteSlot,
} from "./BoardColorControl";
import { BoardColorPicker } from "./BoardColorPicker";
import { DEFAULT_STYLE_COLOR_SLOTS } from "./styleColorPalette";
import {
  BOARD_CONNECTOR_CURVATURE_MAX,
  BOARD_CONNECTOR_CURVATURE_MIN,
  BOARD_CONNECTOR_CURVATURE_STEP,
  clampBoardConnectorCurvature,
} from "./connectorCurvature";

export type BoardLayerDirection = "front" | "forward" | "backward" | "back";
export type BoardFontStyleToken = "bold" | "italic";
export type BoardToggleState = boolean | "mixed";

export interface BoardFreeDrawingPalette {
  readonly presets: readonly FreeDrawingPreset[];
  readonly activePresetId: string;
  readonly onSelectPreset: (presetId: string) => void;
  readonly onChangePreset: (
    presetId: string,
    patch: FreeDrawingPresetPatch,
  ) => void;
  readonly onAddPreset: () => string | null;
  readonly onDeletePreset: (presetId: string) => void;
  readonly onMovePreset: (presetId: string, targetIndex: number) => void;
}

export interface BoardSharedColorPalette {
  readonly slots: readonly BoardColorPaletteSlot[];
  readonly recentColors: readonly string[];
  readonly onChangeSlot: (slotId: string, color: string) => void;
  readonly onAddSlot: (color: string) => string | null;
  readonly onDeleteSlot: (slotId: string) => void;
  readonly onMoveSlot: (slotId: string, targetIndex: number) => void;
  readonly onRememberColor: (color: string) => void;
}

export interface BoardStyleBarProps {
  readonly available: ReadonlySet<string>;
  readonly values: Readonly<Record<string, unknown>>;
  readonly mixed: ReadonlySet<string>;
  readonly fontStyleState: Readonly<
    Record<BoardFontStyleToken, BoardToggleState>
  >;
  readonly freeDrawingPalette?: BoardFreeDrawingPalette;
  readonly sharedColorPalette?: BoardSharedColorPalette;
  readonly allowTransparentFill?: boolean;
  readonly fillColorLabel?: string;
  readonly connectorCurvature?: {
    readonly value: number;
    readonly onChange: (value: number) => void;
  };
  readonly hideOpacity?: boolean;
  readonly showFillPropertyIcon?: boolean;
  readonly onStyleChange: (property: string, value: unknown) => void;
  readonly onFontStyleToggle: (
    token: BoardFontStyleToken,
    enabled: boolean,
  ) => void;
  readonly onContinuousChangeStart?: () => void;
  readonly onContinuousChangeEnd?: () => void;
}

const COLOR_NAMES: Readonly<Record<string, string>> = {
  "#17212b": "Графитовый",
  "#d33f49": "Красный",
  "#2563eb": "Синий",
  "#16825d": "Зелёный",
  "#d97706": "Оранжевый",
  "#7c3aed": "Фиолетовый",
  "#ffd43b": "Жёлтый",
  "rgba(255,255,255,0)": "Без заливки",
  "#ffffff": "Белый",
  "#fff3bf": "Жёлтый",
  "#dbeafe": "Голубой",
  "#dcfce7": "Светло-зелёный",
  "#ffe4e6": "Розовый",
};

const FONT_FAMILY_SUGGESTIONS = [
  { value: "Inter, Arial, sans-serif", label: "Inter" },
  { value: "Georgia, Times New Roman, serif", label: "Georgia" },
  {
    value: "Cascadia Code, Consolas, monospace",
    label: "Cascadia Code",
  },
  { value: "Arial, sans-serif", label: "Arial" },
  { value: "Verdana, sans-serif", label: "Verdana" },
  { value: "Trebuchet MS, sans-serif", label: "Trebuchet MS" },
  { value: "Times New Roman, serif", label: "Times New Roman" },
  { value: "Courier New, monospace", label: "Courier New" },
] as const;
const FONT_SIZE_SUGGESTIONS = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 96, 128, 192, 256] as const;
const GENERIC_STROKE_WIDTH_MIN = 0.5;
const GENERIC_STROKE_WIDTH_MAX = 96;
const GENERIC_STROKE_WIDTH_STEP = 0.5;
const GENERIC_OPACITY_MIN = 0.05;
const GENERIC_OPACITY_MAX = 1;
const GENERIC_OPACITY_STEP = 0.01;
const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 256;
const FONT_SIZE_STEP = 0.5;
const PALETTE_DRAG_ACTIVATION_PX = 3;
const PALETTE_TOUCH_SCROLL_SLOP_PX = 6;
const PALETTE_DRAG_EDGE_PX = 28;
const PALETTE_DRAG_SCROLL_PX_PER_SECOND = 540;
const PALETTE_TOUCH_HOLD_MS = 240;
const PALETTE_WHEEL_NOTCH_PX = 24;
const PALETTE_WHEEL_IDLE_MS = 180;
const WHEEL_DELTA_MODE_PIXEL = 0;

interface PaletteDragState {
  readonly pointerId: number;
  readonly presetId: string;
  readonly startX: number;
  readonly startY: number;
  readonly sourceOrder: readonly string[];
  readonly sourceCenters: readonly number[];
  readonly sourceIndex: number;
  readonly pointerType: string;
  readonly startScrollLeft: number;
  readonly maxScrollLeft: number;
  currentX: number;
  currentY: number;
  targetIndex: number;
  moved: boolean;
  touchReady: boolean;
  touchScrolling: boolean;
  lastFrameTime: number | null;
}

interface PaletteDragPreview {
  readonly presetId: string;
  readonly offsets: Readonly<Record<string, number>>;
}

interface PaletteWheelState {
  readonly presetId: string;
  readonly deltaDirection: -1 | 1;
  readonly residualPx: number;
  readonly lastEventAt: number;
  readonly renderedWidth: number;
  readonly optimisticWidth: number;
}

function paletteDragTargetIndex(
  drag: PaletteDragState,
  scrollLeft: number,
): number {
  const scrollDelta = scrollLeft - drag.startScrollLeft;
  const draggedCenter = drag.sourceCenters[drag.sourceIndex]
    + drag.currentX
    - drag.startX;
  return drag.sourceCenters.filter((center, index) =>
    index !== drag.sourceIndex
    && draggedCenter > center - scrollDelta).length;
}

function rangeValue(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function compactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function stepFreeDrawingStrokeWidth(
  current: number,
  direction: -1 | 1,
): number {
  const next = Math.round(
    (current + direction * FREE_DRAWING_STROKE_WIDTH_STEP)
    / FREE_DRAWING_STROKE_WIDTH_STEP,
  ) * FREE_DRAWING_STROKE_WIDTH_STEP;
  return Math.max(
    FREE_DRAWING_STROKE_WIDTH_MIN,
    Math.min(FREE_DRAWING_STROKE_WIDTH_MAX, next),
  );
}

function freeDrawingPresetLabel(
  preset: FreeDrawingPreset,
  index: number,
): string {
  const color = COLOR_NAMES[preset.stroke] ?? preset.stroke.toUpperCase();
  return [
    `Перо ${index + 1}`,
    color,
    `толщина ${compactNumber(preset.strokeWidth)}`,
    `непрозрачность ${Math.round(preset.opacity * 100)}%`,
  ].join(", ");
}

function BoardFontFamilyControl({
  value,
  mixed,
  onCommit,
}: {
  readonly value: unknown;
  readonly mixed: boolean;
  readonly onCommit: (value: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef({ value: "", timestamp: 0 });
  const displayedValue = !mixed && typeof value === "string" ? value : "";
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();
  const knownFamily = FONT_FAMILY_SUGGESTIONS.find(
    (option) => option.value === displayedValue,
  );

  const selectedIndex = FONT_FAMILY_SUGGESTIONS.findIndex(
    (option) => option.value === displayedValue,
  );
  const triggerLabel = mixed
    ? "Смешанный"
    : knownFamily?.label ?? "Выберите шрифт";
  const previewFont = !mixed ? knownFamily?.value : undefined;

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    typeaheadRef.current = { value: "", timestamp: 0 };
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const openMenu = useCallback((initialIndex?: number) => {
    setActiveIndex(initialIndex
      ?? (selectedIndex >= 0 ? selectedIndex : 0));
    setOpen(true);
  }, [selectedIndex]);

  const chooseOption = useCallback((index: number) => {
    const option = FONT_FAMILY_SUGGESTIONS[index];
    if (!option) return;
    closeMenu(true);
    if (option.value !== displayedValue) onCommit(option.value);
  }, [
    closeMenu,
    displayedValue,
    onCommit,
  ]);

  useEffect(() => {
    if (!open) return;
    const pointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node
        && (
          rootRef.current?.contains(event.target)
          || listboxRef.current?.contains(event.target)
        )
      ) {
        return;
      }
      closeMenu(false);
    };
    const focusIn = (event: FocusEvent) => {
      if (
        event.target instanceof Node
        && (
          rootRef.current?.contains(event.target)
          || listboxRef.current?.contains(event.target)
        )
      ) {
        return;
      }
      closeMenu(false);
    };
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("focusin", focusIn, true);
    return () => {
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("focusin", focusIn, true);
    };
  }, [closeMenu, open]);

  useLayoutEffect(() => {
    if (!open) return;
    const positionListbox = () => {
      const trigger = triggerRef.current;
      const listbox = listboxRef.current;
      if (!trigger || !listbox) return;
      const margin = 8;
      const gap = 6;
      const triggerRect = trigger.getBoundingClientRect();
      const measuredBoardRect = rootRef.current
        ?.closest<HTMLElement>(".board-v2")
        ?.getBoundingClientRect();
      const boardRect = measuredBoardRect
        && measuredBoardRect.width >= 32
        && measuredBoardRect.height >= 32
          ? measuredBoardRect
          : null;
      const boundaryLeft = Math.max(margin, boardRect?.left ?? margin);
      const boundaryRight = Math.min(
        window.innerWidth - margin,
        boardRect?.right ?? window.innerWidth - margin,
      );
      const boundaryTop = Math.max(margin, boardRect?.top ?? margin);
      const boundaryBottom = Math.min(
        window.innerHeight - margin,
        boardRect?.bottom ?? window.innerHeight - margin,
      );
      const width = Math.min(
        224,
        Math.max(0, boundaryRight - boundaryLeft),
      );
      const measuredHeight = listbox.scrollHeight || listbox.offsetHeight;
      const below = Math.max(0, boundaryBottom - triggerRect.bottom - gap);
      const above = Math.max(0, triggerRect.top - boundaryTop - gap);
      const placeBelow = below >= Math.min(measuredHeight, 220)
        || below >= above;
      const availableHeight = Math.max(72, placeBelow ? below : above);
      const left = Math.max(
        boundaryLeft,
        Math.min(boundaryRight - width, triggerRect.left),
      );
      const top = placeBelow
        ? triggerRect.bottom + gap
        : Math.max(boundaryTop, triggerRect.top - gap - Math.min(
          measuredHeight,
          availableHeight,
        ));
      listbox.style.left = `${Math.round(left)}px`;
      listbox.style.top = `${Math.round(top)}px`;
      listbox.style.width = `${Math.floor(width)}px`;
      listbox.style.maxHeight = `${Math.floor(availableHeight)}px`;
    };
    positionListbox();
    window.addEventListener("resize", positionListbox);
    window.addEventListener("scroll", positionListbox, true);
    return () => {
      window.removeEventListener("resize", positionListbox);
      window.removeEventListener("scroll", positionListbox, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    document.getElementById(`${listboxId}-option-${activeIndex}`)
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeIndex, listboxId, open]);

  return (
      <div ref={rootRef} className="board-font-family-control">
        <button
          ref={triggerRef}
          type="button"
          role="combobox"
          className="board-stylebar__font-family board-font-family-control__trigger"
          aria-label="Шрифт"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-activedescendant={open
            ? `${listboxId}-option-${activeIndex}`
            : undefined}
          title={mixed
            ? "Шрифт: смешанные значения"
            : knownFamily?.label ?? "Выберите шрифт из списка"}
          onClick={() => {
            if (open) closeMenu(false);
            else openMenu();
          }}
          onKeyDown={(event) => {
            const optionCount = FONT_FAMILY_SUGGESTIONS.length;
            if (!open) {
              if (
                event.key !== "ArrowDown"
                && event.key !== "ArrowUp"
                && event.key !== "Home"
                && event.key !== "End"
              ) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Home") openMenu(0);
              else if (event.key === "End") openMenu(optionCount - 1);
              else openMenu();
              return;
            }

            if (event.key === "Escape" || event.key === "Tab") {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
              }
              closeMenu(event.key === "Escape");
              return;
            }
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              chooseOption(activeIndex);
              return;
            }
            if (
              event.key === "ArrowDown"
              || event.key === "ArrowUp"
              || event.key === "Home"
              || event.key === "End"
            ) {
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Home") setActiveIndex(0);
              else if (event.key === "End") setActiveIndex(optionCount - 1);
              else setActiveIndex((current) => Math.max(
                0,
                Math.min(
                  optionCount - 1,
                  current + (event.key === "ArrowDown" ? 1 : -1),
                ),
              ));
              return;
            }
            if (
              event.key.length === 1
              && !event.altKey
              && !event.ctrlKey
              && !event.metaKey
            ) {
              const now = performance.now();
              const previous = typeaheadRef.current;
              const key = event.key.toLocaleLowerCase();
              const withinBurst = now - previous.timestamp <= 650;
              const repeatedSingleKey = withinBurst
                && previous.value.length > 0
                && [...previous.value].every((character) => character === key);
              const query = withinBurst && !repeatedSingleKey
                ? `${previous.value}${key}`
                : key;
              typeaheadRef.current = { value: query, timestamp: now };
              const labels = FONT_FAMILY_SUGGESTIONS.map(
                (option) => option.label,
              );
              const match = Array.from(
                { length: optionCount },
                (_, offset) => (activeIndex + 1 + offset) % optionCount,
              ).find((index) => labels[index].toLocaleLowerCase().startsWith(
                query,
              ));
              if (match !== undefined) {
                event.preventDefault();
                event.stopPropagation();
                setActiveIndex(match);
              }
            }
          }}
        >
          <span
            className="board-font-family-control__current"
            style={previewFont ? { fontFamily: previewFont } : undefined}
          >
            {triggerLabel}
          </span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
        {open && createPortal((
          <div
            ref={listboxRef}
            id={listboxId}
            className="board-font-family-menu"
            role="listbox"
            aria-label="Выбор шрифта"
          >
            {FONT_FAMILY_SUGGESTIONS.map((option, index) => (
              <button
                key={option.value}
                id={`${listboxId}-option-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                className={index === activeIndex ? "is-active" : undefined}
                aria-selected={!mixed && option.value === displayedValue}
                data-font-family={option.value}
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => setActiveIndex(index)}
                onClick={() => chooseOption(index)}
              >
                <span className="board-font-family-menu__check">
                  {!mixed && option.value === displayedValue && (
                    <Check size={14} aria-hidden="true" />
                  )}
                </span>
                <span
                  className="board-font-family-menu__label"
                  style={{ fontFamily: option.value }}
                >
                  {option.label}
                </span>
              </button>
            ))}
          </div>
        ), rootRef.current?.closest(".board-v2") ?? document.body)}
      </div>
  );
}

export function BoardStyleBar({
  available,
  values,
  mixed,
  fontStyleState,
  freeDrawingPalette,
  sharedColorPalette,
  allowTransparentFill = true,
  fillColorLabel = "Цвет заливки",
  connectorCurvature,
  hideOpacity = false,
  showFillPropertyIcon = true,
  onStyleChange,
  onFontStyleToggle,
  onContinuousChangeStart,
  onContinuousChangeEnd,
}: BoardStyleBarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const paletteToggleRef = useRef<HTMLButtonElement>(null);
  const presetButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const paletteDragRef = useRef<PaletteDragState | null>(null);
  const paletteDragFrameRef = useRef<number | null>(null);
  const paletteDropCommitFrameRef = useRef<number | null>(null);
  const paletteTouchHoldTimerRef = useRef<number | null>(null);
  const paletteWheelRef = useRef<PaletteWheelState | null>(null);
  const freeDrawingPaletteRef = useRef(freeDrawingPalette);
  const suppressedPresetClickRef = useRef<string | null>(null);
  const fontSizeInputRef = useRef<HTMLInputElement>(null);
  const fontSizeWheelTimerRef = useRef<number | null>(null);
  const fontSizeFocusedRef = useRef(false);
  const cancelledPalettePointerRef = useRef<{
    readonly pointerId: number;
    readonly presetId: string;
  } | null>(null);
  const [openPresetId, setOpenPresetId] = useState<string | null>(null);
  const [paletteEditing, setPaletteEditing] = useState(false);
  const [dragPreview, setDragPreview] = useState<PaletteDragPreview | null>(
    null,
  );
  const [draggingPresetId, setDraggingPresetId] = useState<string | null>(null);
  const [paletteDropCommitGuard, setPaletteDropCommitGuard] = useState(false);
  const [paletteAnnouncement, setPaletteAnnouncement] = useState("");
  const popupId = useId();
  const fontSizeSuggestionsId = useId();
  const colorSlots = sharedColorPalette?.slots ?? DEFAULT_STYLE_COLOR_SLOTS;
  const recentColors = sharedColorPalette?.recentColors ?? [];
  const opacity = rangeValue(
    values.opacity,
    1,
    GENERIC_OPACITY_MIN,
    GENERIC_OPACITY_MAX,
  );
  const strokeWidth = rangeValue(
    values.strokeWidth,
    2,
    GENERIC_STROKE_WIDTH_MIN,
    GENERIC_STROKE_WIDTH_MAX,
  );
  const fontSize = mixed.has("fontSize")
    ? ""
    : String(rangeValue(values.fontSize, 20, FONT_SIZE_MIN, FONT_SIZE_MAX));
  const openPreset = freeDrawingPalette?.presets.find(
    (preset) => preset.id === openPresetId,
  );
  const displayedPresets = freeDrawingPalette?.presets ?? [];

  useLayoutEffect(() => {
    freeDrawingPaletteRef.current = freeDrawingPalette;
    if (!freeDrawingPalette) paletteWheelRef.current = null;
  }, [freeDrawingPalette]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const hasFiniteDelta =
        Number.isFinite(event.deltaY) && event.deltaY !== 0
        || Number.isFinite(event.deltaX) && event.deltaX !== 0;
      const verticalDominant = Number.isFinite(event.deltaY)
        && event.deltaY !== 0
        && Math.abs(event.deltaY) > Math.abs(event.deltaX);
      const browserPinch = (event.ctrlKey || event.metaKey) && hasFiniteDelta;
      if (
        paletteDragRef.current
        && (verticalDominant || browserPinch)
      ) {
        event.preventDefault();
        event.stopPropagation();
        paletteWheelRef.current = null;
        return;
      }
      const button = target.closest<HTMLButtonElement>(
        ".board-stylebar__pen-preset",
      );
      if (!button || !strip.contains(button)) return;
      if (browserPinch) {
        event.preventDefault();
        event.stopPropagation();
        paletteWheelRef.current = null;
        return;
      }
      if (!verticalDominant) return;

      event.preventDefault();
      event.stopPropagation();

      const presetId = button.closest<HTMLElement>(
        "[data-pen-preset-id]",
      )?.dataset.penPresetId;
      const palette = freeDrawingPaletteRef.current;
      const preset = palette?.presets.find((entry) => entry.id === presetId);
      if (!palette || !preset) return;

      const now = performance.now();
      const deltaDirection: -1 | 1 = event.deltaY < 0 ? -1 : 1;
      const previous = paletteWheelRef.current;
      const sameBurst = previous?.presetId === preset.id
        && now - previous.lastEventAt <= PALETTE_WHEEL_IDLE_MS;
      const currentWidth = sameBurst
        && (
          preset.strokeWidth === previous.renderedWidth
          || preset.strokeWidth === previous.optimisticWidth
        )
        ? previous.optimisticWidth
        : preset.strokeWidth;
      let residualPx = sameBurst
        && previous.deltaDirection === deltaDirection
        ? previous.residualPx
        : 0;
      let advances = true;
      if (event.deltaMode === WHEEL_DELTA_MODE_PIXEL) {
        residualPx += Math.min(
          Math.abs(event.deltaY),
          PALETTE_WHEEL_NOTCH_PX,
        );
        advances = residualPx >= PALETTE_WHEEL_NOTCH_PX;
        if (advances) residualPx -= PALETTE_WHEEL_NOTCH_PX;
      } else {
        residualPx = 0;
      }

      const nextWidth = advances
        ? stepFreeDrawingStrokeWidth(
            currentWidth,
            deltaDirection < 0 ? 1 : -1,
          )
        : currentWidth;
      paletteWheelRef.current = {
        presetId: preset.id,
        deltaDirection,
        residualPx,
        lastEventAt: now,
        renderedWidth: preset.strokeWidth,
        optimisticWidth: nextWidth,
      };
      if (!advances || nextWidth === currentWidth) return;
      palette.onChangePreset(preset.id, { strokeWidth: nextWidth });
    };

    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      strip.removeEventListener("wheel", onWheel);
      paletteWheelRef.current = null;
    };
  }, []);

  useEffect(() => () => {
    if (fontSizeWheelTimerRef.current !== null) {
      window.clearTimeout(fontSizeWheelTimerRef.current);
      fontSizeWheelTimerRef.current = null;
      onContinuousChangeEnd?.();
    }
  }, [onContinuousChangeEnd]);

  useEffect(() => {
    const input = fontSizeInputRef.current;
    if (!input) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const current = mixed.has("fontSize")
        ? 20
        : Number(fontSize) || 20;
      const direction = event.deltaY < 0 ? 1 : -1;
      const multiplier = event.shiftKey ? 10 : 1;
      const next = Math.max(
        FONT_SIZE_MIN,
        Math.min(
          FONT_SIZE_MAX,
          current + direction * FONT_SIZE_STEP * multiplier,
        ),
      );
      if (next === current) return;
      onContinuousChangeStart?.();
      onStyleChange("fontSize", next);
      if (fontSizeFocusedRef.current) return;
      if (fontSizeWheelTimerRef.current !== null) {
        window.clearTimeout(fontSizeWheelTimerRef.current);
      }
      fontSizeWheelTimerRef.current = window.setTimeout(() => {
        fontSizeWheelTimerRef.current = null;
        onContinuousChangeEnd?.();
      }, 180);
    };
    input.addEventListener("wheel", onWheel, { passive: false });
    return () => input.removeEventListener("wheel", onWheel);
  }, [
    available,
    fontSize,
    mixed,
    onContinuousChangeEnd,
    onContinuousChangeStart,
    onStyleChange,
  ]);

  const cancelPaletteDrag = useCallback((suppressClick = false) => {
    if (paletteDragFrameRef.current !== null) {
      window.cancelAnimationFrame(paletteDragFrameRef.current);
      paletteDragFrameRef.current = null;
    }
    if (paletteTouchHoldTimerRef.current !== null) {
      window.clearTimeout(paletteTouchHoldTimerRef.current);
      paletteTouchHoldTimerRef.current = null;
    }
    const drag = paletteDragRef.current;
    paletteDragRef.current = null;
    if (suppressClick && drag) {
      suppressedPresetClickRef.current = drag.presetId;
      cancelledPalettePointerRef.current = {
        pointerId: drag.pointerId,
        presetId: drag.presetId,
      };
    }
    if (drag) {
      const button = presetButtonsRef.current.get(drag.presetId);
      try {
        if (button?.hasPointerCapture(drag.pointerId)) {
          button.releasePointerCapture(drag.pointerId);
        }
      } catch {
        // Pointer capture may already have been released by the browser.
      }
    }
    setDragPreview(null);
    setDraggingPresetId(null);
  }, []);

  const cancelPaletteDropCommitGuard = useCallback(() => {
    if (paletteDropCommitFrameRef.current !== null) {
      window.cancelAnimationFrame(paletteDropCommitFrameRef.current);
      paletteDropCommitFrameRef.current = null;
    }
    setPaletteDropCommitGuard(false);
  }, []);

  const beginPaletteDropCommitGuard = useCallback(() => {
    if (paletteDropCommitFrameRef.current !== null) {
      window.cancelAnimationFrame(paletteDropCommitFrameRef.current);
    }
    setPaletteDropCommitGuard(true);
    paletteDropCommitFrameRef.current = window.requestAnimationFrame(() => {
      paletteDropCommitFrameRef.current = window.requestAnimationFrame(() => {
        paletteDropCommitFrameRef.current = null;
        setPaletteDropCommitGuard(false);
      });
    });
  }, []);

  const updatePaletteDragPreview = useCallback((
    frameTime: number,
    advanceEdgeScroll = true,
  ) => {
    paletteDragFrameRef.current = null;
    const drag = paletteDragRef.current;
    if (!drag || drag.touchScrolling || !drag.touchReady) return;
    if (
      !drag.moved
      && Math.hypot(
        drag.currentX - drag.startX,
        drag.currentY - drag.startY,
      ) < PALETTE_DRAG_ACTIVATION_PX
    ) {
      return;
    }
    if (!drag.moved) {
      drag.moved = true;
      setDraggingPresetId(drag.presetId);
    }

    const strip = stripRef.current;
    let shouldContinueEdgeScroll = false;
    if (strip) {
      const stableScrollLeft = Math.max(
        0,
        Math.min(drag.maxScrollLeft, strip.scrollLeft),
      );
      if (strip.scrollLeft !== stableScrollLeft) {
        strip.scrollLeft = stableScrollLeft;
      }
      const stripRect = strip.getBoundingClientRect();
      const elapsedMs = drag.lastFrameTime === null
        ? 1000 / 60
        : Math.max(0, Math.min(32, frameTime - drag.lastFrameTime));
      drag.lastFrameTime = frameTime;
      const scrollStep = PALETTE_DRAG_SCROLL_PX_PER_SECOND
        * elapsedMs
        / 1000;
      const previousScroll = strip.scrollLeft;
      const currentTargetIndex = paletteDragTargetIndex(drag, previousScroll);
      const finalTargetIndex = drag.sourceOrder.length - 1;
      let nextScroll = previousScroll;
      let edgeDirection: -1 | 0 | 1 = 0;
      if (
        advanceEdgeScroll
        && currentTargetIndex > 0
        && drag.currentX < stripRect.left + PALETTE_DRAG_EDGE_PX
      ) {
        nextScroll = Math.max(0, previousScroll - scrollStep);
        edgeDirection = -1;
      } else if (
        advanceEdgeScroll
        && currentTargetIndex < finalTargetIndex
        && drag.currentX > stripRect.right - PALETTE_DRAG_EDGE_PX
      ) {
        nextScroll = Math.min(
          drag.maxScrollLeft,
          previousScroll + scrollStep,
        );
        edgeDirection = 1;
      }
      if (nextScroll !== previousScroll) {
        strip.scrollLeft = nextScroll;
        const nextTargetIndex = paletteDragTargetIndex(drag, nextScroll);
        shouldContinueEdgeScroll = edgeDirection < 0
          ? nextScroll > 0 && nextTargetIndex > 0
          : edgeDirection > 0
            && nextScroll < drag.maxScrollLeft
            && nextTargetIndex < finalTargetIndex;
      }
    }

    const scrollDelta = (strip?.scrollLeft ?? drag.startScrollLeft)
      - drag.startScrollLeft;
    const pointerDelta = drag.currentX - drag.startX;
    const targetIndex = paletteDragTargetIndex(
      drag,
      strip?.scrollLeft ?? drag.startScrollLeft,
    );
    drag.targetIndex = targetIndex;

    const offsets: Record<string, number> = {
      [drag.presetId]: pointerDelta + scrollDelta,
    };
    if (targetIndex > drag.sourceIndex) {
      for (let index = drag.sourceIndex + 1; index <= targetIndex; index += 1) {
        offsets[drag.sourceOrder[index]] =
          drag.sourceCenters[index - 1] - drag.sourceCenters[index];
      }
    } else if (targetIndex < drag.sourceIndex) {
      for (let index = targetIndex; index < drag.sourceIndex; index += 1) {
        offsets[drag.sourceOrder[index]] =
          drag.sourceCenters[index + 1] - drag.sourceCenters[index];
      }
    }
    setDragPreview({ presetId: drag.presetId, offsets });
    if (
      shouldContinueEdgeScroll
      && paletteDragFrameRef.current === null
    ) {
      paletteDragFrameRef.current = window.requestAnimationFrame(
        updatePaletteDragPreview,
      );
    }
  }, []);

  const schedulePaletteDragPreview = useCallback(() => {
    if (paletteDragFrameRef.current !== null) return;
    paletteDragFrameRef.current = window.requestAnimationFrame(
      updatePaletteDragPreview,
    );
  }, [updatePaletteDragPreview]);

  const finishPaletteDrag = useCallback((
    commit: boolean,
    finalPoint?: Readonly<{ x: number; y: number }>,
  ) => {
    const pendingDrag = paletteDragRef.current;
    if (commit && pendingDrag && finalPoint) {
      pendingDrag.currentX = finalPoint.x;
      pendingDrag.currentY = finalPoint.y;
      if (paletteDragFrameRef.current !== null) {
        window.cancelAnimationFrame(paletteDragFrameRef.current);
        paletteDragFrameRef.current = null;
      }
      updatePaletteDragPreview(performance.now(), false);
    }
    const drag = paletteDragRef.current;
    const wasTouchScroll = Boolean(commit && drag?.touchScrolling);
    const activated = Boolean(commit && drag?.moved);
    const shouldCommit = Boolean(
      activated
      && drag
      && drag.targetIndex !== drag.sourceIndex,
    );
    const presetId = drag?.presetId ?? null;
    const targetIndex = drag?.targetIndex ?? -1;
    if (shouldCommit) beginPaletteDropCommitGuard();
    cancelPaletteDrag();
    if (wasTouchScroll && presetId) {
      suppressedPresetClickRef.current = presetId;
      window.setTimeout(() => {
        if (suppressedPresetClickRef.current === presetId) {
          suppressedPresetClickRef.current = null;
        }
      }, 0);
      return;
    }
    if (activated && presetId) {
      suppressedPresetClickRef.current = presetId;
      window.setTimeout(() => {
        if (suppressedPresetClickRef.current === presetId) {
          suppressedPresetClickRef.current = null;
        }
      }, 0);
    }
    if (
      shouldCommit
      && presetId
      && freeDrawingPalette
    ) {
      freeDrawingPalette.onMovePreset(presetId, targetIndex);
      setPaletteAnnouncement(
        `Перо перемещено на позицию ${targetIndex + 1}`,
      );
    }
  }, [
    cancelPaletteDrag,
    beginPaletteDropCommitGuard,
    freeDrawingPalette,
    updatePaletteDragPreview,
  ]);

  const updatePaletteDragFromPointer = useCallback((
    event: Readonly<{
      pointerId: number;
      clientX: number;
      clientY: number;
      preventDefault: () => void;
    }>,
  ) => {
    const drag = paletteDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.currentX = event.clientX;
    drag.currentY = event.clientY;
    if (drag.pointerType === "touch" && !drag.touchReady) {
      const deltaX = drag.currentX - drag.startX;
      const deltaY = drag.currentY - drag.startY;
      if (
        !drag.touchScrolling
        && Math.hypot(deltaX, deltaY) >= PALETTE_TOUCH_SCROLL_SLOP_PX
      ) {
        drag.touchScrolling = true;
        if (paletteTouchHoldTimerRef.current !== null) {
          window.clearTimeout(paletteTouchHoldTimerRef.current);
          paletteTouchHoldTimerRef.current = null;
        }
      }
      if (drag.touchScrolling) {
        const strip = stripRef.current;
        if (strip) {
          const maximumScroll = Math.max(
            0,
            strip.scrollWidth - strip.clientWidth,
          );
          strip.scrollLeft = Math.max(
            0,
            Math.min(maximumScroll, drag.startScrollLeft - deltaX),
          );
        }
        event.preventDefault();
      }
      return;
    }
    if (
      drag.moved
      || Math.hypot(
        drag.currentX - drag.startX,
        drag.currentY - drag.startY,
      ) >= PALETTE_DRAG_ACTIVATION_PX
    ) {
      event.preventDefault();
    }
    schedulePaletteDragPreview();
  }, [schedulePaletteDragPreview]);

  const releaseCancelledPalettePointer = useCallback((
    pointerId: number,
    mayProduceClick: boolean,
  ): boolean => {
    const cancelled = cancelledPalettePointerRef.current;
    if (!cancelled || cancelled.pointerId !== pointerId) return false;
    cancelledPalettePointerRef.current = null;
    if (!mayProduceClick) {
      if (suppressedPresetClickRef.current === cancelled.presetId) {
        suppressedPresetClickRef.current = null;
      }
      return true;
    }
    window.setTimeout(() => {
      if (suppressedPresetClickRef.current === cancelled.presetId) {
        suppressedPresetClickRef.current = null;
      }
    }, 0);
    return true;
  }, []);

  useEffect(() => {
    if (!paletteEditing) return;
    const pointerMove = (event: PointerEvent) => {
      updatePaletteDragFromPointer(event);
    };
    const pointerUp = (event: PointerEvent) => {
      if (releaseCancelledPalettePointer(event.pointerId, true)) return;
      if (paletteDragRef.current?.pointerId !== event.pointerId) return;
      finishPaletteDrag(true, {
        x: event.clientX,
        y: event.clientY,
      });
    };
    const pointerCancel = (event: PointerEvent) => {
      if (releaseCancelledPalettePointer(event.pointerId, false)) return;
      if (paletteDragRef.current?.pointerId === event.pointerId) {
        finishPaletteDrag(false);
      }
    };
    window.addEventListener("pointermove", pointerMove, {
      capture: true,
      passive: false,
    });
    window.addEventListener("pointerup", pointerUp, true);
    window.addEventListener("pointercancel", pointerCancel, true);
    return () => {
      window.removeEventListener("pointermove", pointerMove, true);
      window.removeEventListener("pointerup", pointerUp, true);
      window.removeEventListener("pointercancel", pointerCancel, true);
    };
  }, [
    finishPaletteDrag,
    paletteEditing,
    releaseCancelledPalettePointer,
    updatePaletteDragFromPointer,
  ]);

  useEffect(() => {
    if (
      openPresetId
      && (
        !freeDrawingPalette
        || !freeDrawingPalette.presets.some(
          (preset) => preset.id === openPresetId,
        )
        || (
          !paletteEditing
          && freeDrawingPalette.activePresetId !== openPresetId
        )
      )
    ) {
      setOpenPresetId(null);
    }
  }, [freeDrawingPalette, openPresetId, paletteEditing]);

  useEffect(() => {
    if (!openPresetId) return;
    const pointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && root.contains(event.target)) {
        return;
      }
      setOpenPresetId(null);
    };
    document.addEventListener("pointerdown", pointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", pointerDown, true);
    };
  }, [openPresetId]);

  useEffect(() => {
    if (!openPresetId && !paletteEditing && !draggingPresetId) return;
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (popoverRef.current?.querySelector(
        '.board-color-picker[data-formats-open="true"]',
      )) return;
      event.preventDefault();
      event.stopPropagation();
      if (paletteDragRef.current) {
        cancelPaletteDrag(true);
        return;
      }
      if (openPresetId) {
        setOpenPresetId(null);
        presetButtonsRef.current.get(openPresetId)?.focus();
        return;
      }
      if (paletteEditing) {
        setPaletteEditing(false);
        paletteToggleRef.current?.focus();
      }
    };
    document.addEventListener("keydown", keyDown, true);
    return () => document.removeEventListener("keydown", keyDown, true);
  }, [
    cancelPaletteDrag,
    draggingPresetId,
    openPresetId,
    paletteEditing,
  ]);

  useEffect(() => {
    const blur = () => {
      cancelPaletteDrag();
      cancelPaletteDropCommitGuard();
      cancelledPalettePointerRef.current = null;
      suppressedPresetClickRef.current = null;
    };
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("blur", blur);
      if (paletteDragFrameRef.current !== null) {
        window.cancelAnimationFrame(paletteDragFrameRef.current);
        paletteDragFrameRef.current = null;
      }
      if (paletteTouchHoldTimerRef.current !== null) {
        window.clearTimeout(paletteTouchHoldTimerRef.current);
        paletteTouchHoldTimerRef.current = null;
      }
      if (paletteDropCommitFrameRef.current !== null) {
        window.cancelAnimationFrame(paletteDropCommitFrameRef.current);
        paletteDropCommitFrameRef.current = null;
      }
      paletteDragRef.current = null;
      cancelledPalettePointerRef.current = null;
      suppressedPresetClickRef.current = null;
    };
  }, [cancelPaletteDrag, cancelPaletteDropCommitGuard]);

  useEffect(() => {
    if (freeDrawingPalette) return;
    cancelPaletteDrag();
    cancelPaletteDropCommitGuard();
    setOpenPresetId(null);
    setPaletteEditing(false);
  }, [
    cancelPaletteDrag,
    cancelPaletteDropCommitGuard,
    freeDrawingPalette,
  ]);

  useLayoutEffect(() => {
    if (!openPresetId) return;
    const root = rootRef.current;
    const popover = popoverRef.current;
    if (!root || !popover) return;
    const board = root.closest<HTMLElement>(".board-v2");
    const updateAvailableHeight = () => {
      const rootRect = root.getBoundingClientRect();
      const boundaryBottom = board?.getBoundingClientRect().bottom
        ?? window.innerHeight;
      const available = Math.max(
        0,
        Math.floor(boundaryBottom - rootRect.bottom - 7),
      );
      popover.style.setProperty(
        "--board-pen-popover-max-height",
        `${available}px`,
      );
    };
    updateAvailableHeight();
    window.addEventListener("resize", updateAvailableHeight);
    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(updateAvailableHeight)
      : null;
    if (resizeObserver) {
      resizeObserver.observe(root);
      if (board) resizeObserver.observe(board);
    }
    return () => {
      window.removeEventListener("resize", updateAvailableHeight);
      resizeObserver?.disconnect();
    };
  }, [openPresetId]);

  return (
    <div
      ref={rootRef}
      className={`board-v2__stylebar${paletteEditing ? " board-v2__stylebar--palette-editing" : ""}${paletteDropCommitGuard ? " board-v2__stylebar--palette-drop-commit" : ""}`}
    >
      <div
        ref={stripRef}
        className="board-stylebar__strip"
        role="toolbar"
        aria-label="Оформление"
      >
      {available.has("stroke") && freeDrawingPalette && (
        <div
          className="board-stylebar__group board-stylebar__colors board-stylebar__free-drawing"
          role="group"
          aria-label="Параметры рисования"
        >
          <button
            ref={paletteToggleRef}
            type="button"
            className="board-stylebar__palette-toggle"
            aria-label={
              paletteEditing
                ? "Завершить настройку палитры"
                : "Настроить палитру рисования"
            }
            title={
              paletteEditing
                ? "Завершить настройку палитры"
                : "Настроить палитру"
            }
            aria-pressed={paletteEditing}
            onClick={() => {
              cancelPaletteDropCommitGuard();
              cancelPaletteDrag();
              setOpenPresetId(null);
              setPaletteEditing((current) => !current);
              setPaletteAnnouncement("");
            }}
          >
            <Palette size={16} aria-hidden="true" />
          </button>

          {displayedPresets.map((preset, index) => {
            const selected =
              freeDrawingPalette.activePresetId === preset.id;
            const expanded = openPresetId === preset.id;
            const adaptiveInk = preset.stroke === "#17212b";
            const label = freeDrawingPresetLabel(preset, index);
            const dragging = draggingPresetId === preset.id;
            const dragOffset = dragPreview?.offsets[preset.id];
            return (
              <div
                key={preset.id}
                className={`board-stylebar__pen-slot${dragging ? " is-dragging" : dragOffset !== undefined ? " is-displaced" : ""}`}
                data-pen-preset-id={preset.id}
                style={dragOffset === undefined
                  ? undefined
                  : {
                    "--board-palette-drag-x": `${dragOffset}px`,
                  } as CSSProperties}
              >
                <button
                  ref={(element) => {
                    if (element) {
                      presetButtonsRef.current.set(preset.id, element);
                    } else {
                      presetButtonsRef.current.delete(preset.id);
                    }
                  }}
                  type="button"
                  className={`board-stylebar__swatch board-stylebar__pen-preset${adaptiveInk ? " is-adaptive-ink" : ""}`}
                  style={{
                    "--board-swatch": preset.stroke,
                    "--board-pen-radius": `${preset.strokeWidth}px`,
                    "--board-swatch-opacity": String(preset.opacity),
                  } as CSSProperties}
                  aria-label={label}
                  title={label}
                  aria-pressed={selected}
                  aria-haspopup={paletteEditing || selected
                    ? "dialog"
                    : undefined}
                  aria-expanded={expanded}
                  aria-controls={expanded ? popupId : undefined}
                  aria-keyshortcuts={paletteEditing
                    ? "Alt+ArrowLeft Alt+ArrowRight"
                    : undefined}
                  onPointerDown={(event) => {
                    if (event.button === 0 && event.isPrimary !== false) {
                      event.currentTarget.dataset.pointerFocus = "true";
                    }
                    if (
                      !paletteEditing
                      || event.button !== 0
                      || event.isPrimary === false
                    ) {
                      return;
                    }
                    const ownedDrag = paletteDragRef.current;
                    if (
                      ownedDrag
                      && ownedDrag.pointerId !== event.pointerId
                    ) {
                      return;
                    }
                    cancelledPalettePointerRef.current = null;
                    suppressedPresetClickRef.current = null;
                    paletteWheelRef.current = null;
                    cancelPaletteDropCommitGuard();
                    cancelPaletteDrag();
                    const sourceOrder = freeDrawingPalette.presets.map(
                      (entry) => entry.id,
                    );
                    const sourceIndex = sourceOrder.indexOf(preset.id);
                    const measuredCenters = sourceOrder.map((presetId) => {
                      const rect = presetButtonsRef.current
                        .get(presetId)
                        ?.getBoundingClientRect();
                      return rect ? rect.left + rect.width / 2 : null;
                    });
                    const sourceCenter = measuredCenters[sourceIndex]
                      ?? event.clientX;
                    const measuredStep = measuredCenters
                      .slice(1)
                      .map((center, index) => center !== null
                        && measuredCenters[index] !== null
                        ? center - measuredCenters[index]!
                        : null)
                      .find((step): step is number =>
                        step !== null && Number.isFinite(step) && step > 0)
                      ?? 36;
                    const measuredGeometryIsUsable = measuredCenters.every(
                      (center, index) => center !== null
                        && (
                          index === 0
                          || center > (measuredCenters[index - 1] ?? center)
                        ),
                    );
                    const sourceCenters = measuredCenters.map((center, index) =>
                      measuredGeometryIsUsable && center !== null
                        ? center
                        : sourceCenter + (index - sourceIndex) * measuredStep);
                    const pointerType = event.pointerType || "mouse";
                    const strip = stripRef.current;
                    paletteDragRef.current = {
                      pointerId: event.pointerId,
                      presetId: preset.id,
                      startX: event.clientX,
                      startY: event.clientY,
                      currentX: event.clientX,
                      currentY: event.clientY,
                      pointerType,
                      startScrollLeft: strip?.scrollLeft ?? 0,
                      maxScrollLeft: strip
                        ? Math.max(0, strip.scrollWidth - strip.clientWidth)
                        : 0,
                      sourceOrder,
                      sourceCenters,
                      sourceIndex,
                      targetIndex: sourceIndex,
                      moved: false,
                      touchReady: pointerType !== "touch",
                      touchScrolling: false,
                      lastFrameTime: null,
                    };
                    if (pointerType === "touch") {
                      const pointerId = event.pointerId;
                      paletteTouchHoldTimerRef.current = window.setTimeout(
                        () => {
                          paletteTouchHoldTimerRef.current = null;
                          const drag = paletteDragRef.current;
                          if (
                            drag?.pointerId === pointerId
                            && !drag.touchScrolling
                          ) {
                            drag.touchReady = true;
                          }
                        },
                        PALETTE_TOUCH_HOLD_MS,
                      );
                    }
                    try {
                      event.currentTarget.setPointerCapture(event.pointerId);
                    } catch {
                      // Window-level cancellation still protects the gesture.
                    }
                  }}
                  onPointerMove={(event) => {
                    updatePaletteDragFromPointer(event);
                  }}
                  onPointerUp={(event) => {
                    if (
                      paletteDragRef.current?.pointerId === event.pointerId
                    ) {
                      finishPaletteDrag(true, {
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }
                  }}
                  onPointerCancel={(event) => {
                    if (
                      paletteDragRef.current?.pointerId === event.pointerId
                    ) {
                      finishPaletteDrag(false);
                    }
                  }}
                  onLostPointerCapture={(event) => {
                    if (
                      paletteDragRef.current?.pointerId === event.pointerId
                    ) {
                      cancelPaletteDrag(true);
                    }
                  }}
                  onKeyDown={(event) => {
                    delete event.currentTarget.dataset.pointerFocus;
                    if (
                      !paletteEditing
                      || !event.altKey
                      || event.ctrlKey
                      || event.metaKey
                      || event.shiftKey
                      || (
                        event.key !== "ArrowLeft"
                        && event.key !== "ArrowRight"
                      )
                    ) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    const currentIndex = freeDrawingPalette.presets.findIndex(
                      (entry) => entry.id === preset.id,
                    );
                    const targetIndex = event.key === "ArrowLeft"
                      ? currentIndex - 1
                      : currentIndex + 1;
                    if (
                      currentIndex < 0
                      || targetIndex < 0
                      || targetIndex >= freeDrawingPalette.presets.length
                    ) {
                      return;
                    }
                    freeDrawingPalette.onMovePreset(
                      preset.id,
                      targetIndex,
                    );
                    setPaletteAnnouncement(
                      `Перо перемещено на позицию ${targetIndex + 1}`,
                    );
                  }}
                  onBlur={(event) => {
                    delete event.currentTarget.dataset.pointerFocus;
                  }}
                  onClick={() => {
                    if (suppressedPresetClickRef.current === preset.id) {
                      suppressedPresetClickRef.current = null;
                      cancelledPalettePointerRef.current = null;
                      return;
                    }
                    if (paletteEditing) {
                      setOpenPresetId(preset.id);
                      return;
                    }
                    if (!selected) {
                      setOpenPresetId(null);
                      freeDrawingPalette.onSelectPreset(preset.id);
                      return;
                    }
                    setOpenPresetId((current) =>
                      current === preset.id ? null : preset.id);
                  }}
                >
                  <span className="board-stylebar__pen-well" aria-hidden="true">
                    <span className="board-stylebar__pen-dot" />
                  </span>
                </button>

                {paletteEditing && (
                  <button
                    type="button"
                    className="board-stylebar__pen-delete"
                    aria-label={`Удалить перо ${index + 1}`}
                    title="Удалить"
                    disabled={
                      freeDrawingPalette.presets.length
                      <= FREE_DRAWING_PRESET_MIN_COUNT
                    }
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (
                        freeDrawingPalette.presets.length
                        <= FREE_DRAWING_PRESET_MIN_COUNT
                      ) {
                        return;
                      }
                      const nextFocusId =
                        displayedPresets[index + 1]?.id
                        ?? displayedPresets[index - 1]?.id
                        ?? null;
                      setOpenPresetId((current) =>
                        current === preset.id ? null : current);
                      freeDrawingPalette.onDeletePreset(preset.id);
                      setPaletteAnnouncement(`Перо ${index + 1} удалено`);
                      window.requestAnimationFrame(() => {
                        if (nextFocusId) {
                          presetButtonsRef.current.get(nextFocusId)?.focus();
                        } else {
                          paletteToggleRef.current?.focus();
                        }
                      });
                    }}
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          })}

          <span className="sr-only" aria-live="polite">
            {paletteAnnouncement}
          </span>
        </div>
      )}

      {available.has("stroke") && !freeDrawingPalette && (
        <BoardColorControl
          property="stroke"
          current={typeof values.stroke === "string" ? values.stroke : undefined}
          mixed={mixed.has("stroke")}
          allowTransparent={false}
          paletteSlots={colorSlots}
          recentColors={recentColors}
          onApply={(color) => onStyleChange("stroke", color)}
          onCommitColor={(color) =>
            sharedColorPalette?.onRememberColor(color)}
          onChangePaletteSlot={(slotId, color) =>
            sharedColorPalette?.onChangeSlot(slotId, color)}
          onAddPaletteSlot={(color) =>
            sharedColorPalette?.onAddSlot(color) ?? null}
          onDeletePaletteSlot={(slotId) =>
            sharedColorPalette?.onDeleteSlot(slotId)}
          onMovePaletteSlot={(slotId, targetIndex) =>
            sharedColorPalette?.onMoveSlot(slotId, targetIndex)}
          onContinuousChangeStart={onContinuousChangeStart}
          onContinuousChangeEnd={onContinuousChangeEnd}
        />
      )}

      {available.has("fill") && (
        <BoardColorControl
          property="fill"
          label={fillColorLabel}
          showPropertyIcon={showFillPropertyIcon}
          current={typeof values.fill === "string" ? values.fill : undefined}
          mixed={mixed.has("fill")}
          allowTransparent={allowTransparentFill}
          paletteSlots={colorSlots}
          recentColors={recentColors}
          onApply={(color) => onStyleChange("fill", color)}
          onCommitColor={(color) =>
            sharedColorPalette?.onRememberColor(color)}
          onChangePaletteSlot={(slotId, color) =>
            sharedColorPalette?.onChangeSlot(slotId, color)}
          onAddPaletteSlot={(color) =>
            sharedColorPalette?.onAddSlot(color) ?? null}
          onDeletePaletteSlot={(slotId) =>
            sharedColorPalette?.onDeleteSlot(slotId)}
          onMovePaletteSlot={(slotId, targetIndex) =>
            sharedColorPalette?.onMoveSlot(slotId, targetIndex)}
          onContinuousChangeStart={onContinuousChangeStart}
          onContinuousChangeEnd={onContinuousChangeEnd}
        />
      )}

      {available.has("strokeWidth") && !freeDrawingPalette && (
        <div className={`board-stylebar__group board-stylebar__range${mixed.has("strokeWidth") ? " is-mixed" : ""}`}>
          <input
            type="range"
            min={GENERIC_STROKE_WIDTH_MIN}
            max={GENERIC_STROKE_WIDTH_MAX}
            step={GENERIC_STROKE_WIDTH_STEP}
            value={strokeWidth}
            aria-label="Толщина линии"
            aria-valuetext={
              mixed.has("strokeWidth")
                ? `Смешанная, ${compactNumber(strokeWidth)}`
                : compactNumber(strokeWidth)
            }
            title={mixed.has("strokeWidth")
              ? "Толщина: смешанные значения"
              : `Толщина ${compactNumber(strokeWidth)}`}
            onPointerDown={onContinuousChangeStart}
            onPointerUp={onContinuousChangeEnd}
            onPointerCancel={onContinuousChangeEnd}
            onFocus={onContinuousChangeStart}
            onBlur={onContinuousChangeEnd}
            onChange={(event) =>
              onStyleChange("strokeWidth", Number(event.currentTarget.value))}
          />
          <input
            className="board-stylebar__exact-number"
            type="number"
            min={GENERIC_STROKE_WIDTH_MIN}
            max={GENERIC_STROKE_WIDTH_MAX}
            step={GENERIC_STROKE_WIDTH_STEP}
            value={mixed.has("strokeWidth") ? "" : strokeWidth}
            placeholder="—"
            aria-label="Точная толщина линии"
            title="Точная толщина линии"
            onFocus={onContinuousChangeStart}
            onBlur={onContinuousChangeEnd}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              if (Number.isFinite(next) && event.currentTarget.value !== "") {
                onStyleChange(
                  "strokeWidth",
                  Math.max(
                    GENERIC_STROKE_WIDTH_MIN,
                    Math.min(GENERIC_STROKE_WIDTH_MAX, next),
                  ),
                );
              }
            }}
          />
        </div>
      )}

      {available.has("dash") && (
        <BoardDashControl
          value={values.dash ?? []}
          mixed={mixed.has("dash")}
          onChange={(value) => onStyleChange("dash", value)}
        />
      )}

      {connectorCurvature && (
        <div className="board-stylebar__group board-stylebar__range board-stylebar__curvature">
          <button
            type="button"
            className="board-stylebar__curvature-reset"
            aria-label="Сделать линию прямой"
            title="Сделать линию прямой"
            disabled={connectorCurvature.value === 0}
            onClick={() => connectorCurvature.onChange(0)}
          >
            <Spline size={15} strokeWidth={1.8} />
          </button>
          <input
            type="range"
            min={BOARD_CONNECTOR_CURVATURE_MIN}
            max={BOARD_CONNECTOR_CURVATURE_MAX}
            step={BOARD_CONNECTOR_CURVATURE_STEP}
            value={connectorCurvature.value}
            aria-label="Кривизна линии"
            aria-valuetext={connectorCurvature.value === 0
              ? "Прямая"
              : `${connectorCurvature.value > 0 ? "Вправо" : "Влево"} ${Math.round(Math.abs(connectorCurvature.value) * 100)}%`}
            title="Кривизна линии"
            onPointerDown={onContinuousChangeStart}
            onPointerUp={onContinuousChangeEnd}
            onPointerCancel={onContinuousChangeEnd}
            onFocus={onContinuousChangeStart}
            onBlur={onContinuousChangeEnd}
            onChange={(event) => connectorCurvature.onChange(
              clampBoardConnectorCurvature(Number(event.currentTarget.value)),
            )}
          />
          <label className="board-stylebar__percent-input">
            <input
              className="board-stylebar__exact-number"
              type="number"
              min={BOARD_CONNECTOR_CURVATURE_MIN * 100}
              max={BOARD_CONNECTOR_CURVATURE_MAX * 100}
              step={BOARD_CONNECTOR_CURVATURE_STEP * 100}
              value={Math.round(connectorCurvature.value * 100)}
              aria-label="Точная кривизна в процентах"
              title="Точная кривизна"
              onFocus={onContinuousChangeStart}
              onBlur={onContinuousChangeEnd}
              onChange={(event) => {
                if (event.currentTarget.value === "") return;
                connectorCurvature.onChange(clampBoardConnectorCurvature(
                  Number(event.currentTarget.value) / 100,
                ));
              }}
            />
            <span aria-hidden="true">%</span>
          </label>
        </div>
      )}

      {available.has("opacity") && !freeDrawingPalette && !hideOpacity && (
        <div className={`board-stylebar__group board-stylebar__range${mixed.has("opacity") ? " is-mixed" : ""}`}>
          <input
            type="range"
            min={GENERIC_OPACITY_MIN}
            max={GENERIC_OPACITY_MAX}
            step={GENERIC_OPACITY_STEP}
            value={opacity}
            aria-label="Прозрачность"
            aria-valuetext={mixed.has("opacity")
              ? `Смешанная, ${Math.round(opacity * 100)}%`
              : `${Math.round(opacity * 100)}%`}
            title={mixed.has("opacity")
              ? "Непрозрачность: смешанные значения"
              : `Непрозрачность ${Math.round(opacity * 100)}%`}
            onPointerDown={onContinuousChangeStart}
            onPointerUp={onContinuousChangeEnd}
            onPointerCancel={onContinuousChangeEnd}
            onFocus={onContinuousChangeStart}
            onBlur={onContinuousChangeEnd}
            onChange={(event) => onStyleChange("opacity", Number(event.currentTarget.value))}
          />
          <label className="board-stylebar__percent-input">
            <input
              className="board-stylebar__exact-number"
              type="number"
              min={Math.round(GENERIC_OPACITY_MIN * 100)}
              max={Math.round(GENERIC_OPACITY_MAX * 100)}
              step="1"
              value={mixed.has("opacity") ? "" : Math.round(opacity * 100)}
              placeholder="—"
              aria-label="Точная непрозрачность в процентах"
              title="Точная непрозрачность"
              onFocus={onContinuousChangeStart}
              onBlur={onContinuousChangeEnd}
              onChange={(event) => {
                const next = Number(event.currentTarget.value);
                if (Number.isFinite(next) && event.currentTarget.value !== "") {
                  onStyleChange(
                    "opacity",
                    Math.max(5, Math.min(100, next)) / 100,
                  );
                }
              }}
            />
            <span aria-hidden="true">%</span>
          </label>
        </div>
      )}

      {available.has("fontSize") && (
        <input
          ref={fontSizeInputRef}
          className="board-stylebar__font-size"
          type="number"
          list={fontSizeSuggestionsId}
          aria-label="Размер текста"
          title="Размер текста"
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={FONT_SIZE_STEP}
          value={fontSize}
          placeholder="—"
          onFocus={() => {
            fontSizeFocusedRef.current = true;
            if (fontSizeWheelTimerRef.current !== null) {
              window.clearTimeout(fontSizeWheelTimerRef.current);
              fontSizeWheelTimerRef.current = null;
            }
            onContinuousChangeStart?.();
          }}
          onBlur={() => {
            fontSizeFocusedRef.current = false;
            if (fontSizeWheelTimerRef.current !== null) {
              window.clearTimeout(fontSizeWheelTimerRef.current);
              fontSizeWheelTimerRef.current = null;
            }
            onContinuousChangeEnd?.();
          }}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            if (Number.isFinite(next) && event.currentTarget.value !== "") {
              onStyleChange(
                "fontSize",
                Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, next)),
              );
            }
          }}
        />
      )}
      {available.has("fontSize") && (
        <datalist id={fontSizeSuggestionsId}>
          {FONT_SIZE_SUGGESTIONS.map((size) => (
            <option key={size} value={size} />
          ))}
        </datalist>
      )}

      {available.has("fontFamily") && (
        <BoardFontFamilyControl
          value={values.fontFamily}
          mixed={mixed.has("fontFamily")}
          onCommit={(value) => onStyleChange("fontFamily", value)}
        />
      )}

      {available.has("fontStyle") && (
        <div className="board-stylebar__group board-stylebar__segments" role="group" aria-label="Начертание">
          <button
            type="button"
            aria-label="Полужирный"
            title="Полужирный"
            aria-pressed={fontStyleState.bold}
            onClick={() => onFontStyleToggle("bold", fontStyleState.bold !== true)}
          >
            <Bold size={15} />
          </button>
          <button
            type="button"
            aria-label="Курсив"
            title="Курсив"
            aria-pressed={fontStyleState.italic}
            onClick={() =>
              onFontStyleToggle("italic", fontStyleState.italic !== true)}
          >
            <Italic size={15} />
          </button>
        </div>
      )}

      </div>

      {freeDrawingPalette && paletteEditing && (
        <button
          type="button"
          className="board-stylebar__pen-add"
          aria-label="Добавить перо"
          title="Добавить перо"
          disabled={
            freeDrawingPalette.presets.length
            >= FREE_DRAWING_PRESET_MAX_COUNT
          }
          onClick={() => {
            const presetId = freeDrawingPalette.onAddPreset();
            if (!presetId) return;
            setOpenPresetId(presetId);
            setPaletteAnnouncement(
              `Добавлено перо ${freeDrawingPalette.presets.length + 1}`,
            );
          }}
        >
          <Plus size={15} aria-hidden="true" />
        </button>
      )}

      {freeDrawingPalette && openPreset && (
        <div
          ref={popoverRef}
          id={popupId}
          className="board-stylebar__pen-popover"
          role="dialog"
          aria-label="Настройка пера"
        >
          <header>
            <strong>Перо</strong>
            <button
              type="button"
              aria-label="Закрыть настройки пера"
              title="Закрыть"
              onClick={() => {
                setOpenPresetId(null);
                presetButtonsRef.current.get(openPreset.id)?.focus();
              }}
            >
              <X size={15} />
            </button>
          </header>

          <BoardColorPicker
            value={openPreset.stroke}
            label="Цвет пера"
            onPreview={(color) => freeDrawingPalette.onChangePreset(
              openPreset.id,
              { stroke: color },
            )}
            alpha={{
              value: openPreset.opacity,
              min: FREE_DRAWING_OPACITY_MIN,
              max: FREE_DRAWING_OPACITY_MAX,
              step: FREE_DRAWING_OPACITY_STEP,
              onPreview: (opacity: number) =>
                freeDrawingPalette.onChangePreset(
                  openPreset.id,
                  { opacity },
                ),
            }}
          />

          <label>
            <span>Толщина</span>
            <input
              type="range"
              min={FREE_DRAWING_STROKE_WIDTH_MIN}
              max={FREE_DRAWING_STROKE_WIDTH_MAX}
              step={FREE_DRAWING_STROKE_WIDTH_STEP}
              value={openPreset.strokeWidth}
              aria-label="Толщина линии рисования"
              title={`Толщина ${compactNumber(openPreset.strokeWidth)}`}
              onChange={(event) =>
                freeDrawingPalette.onChangePreset(openPreset.id, {
                  strokeWidth: Number(event.currentTarget.value),
                })}
            />
            <output>{compactNumber(openPreset.strokeWidth)} px</output>
          </label>

        </div>
      )}
    </div>
  );
}
