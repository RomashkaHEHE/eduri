import {
  Check,
  PaintBucket,
  Palette,
  Plus,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { BoardColorPicker } from "./BoardColorPicker";

export type BoardColorProperty = "stroke" | "fill";

export interface BoardColorPaletteSlot {
  readonly id: string;
  readonly color: string;
}

export interface BoardColorControlProps {
  readonly property: BoardColorProperty;
  readonly label?: string;
  readonly current?: string;
  readonly mixed?: boolean;
  readonly allowTransparent?: boolean;
  readonly paletteSlots: readonly BoardColorPaletteSlot[];
  readonly recentColors?: readonly string[];
  readonly disabled?: boolean;
  readonly showPropertyIcon?: boolean;
  readonly onApply: (color: string) => void;
  readonly onCommitColor?: (color: string) => void;
  readonly onChangePaletteSlot: (slotId: string, color: string) => void;
  readonly onAddPaletteSlot: (color: string) => string | null | void;
  readonly onDeletePaletteSlot: (slotId: string) => void;
  readonly onMovePaletteSlot: (slotId: string, targetIndex: number) => void;
  readonly onContinuousChangeStart?: () => void;
  readonly onContinuousChangeEnd?: () => void;
}

interface ParsedColor {
  readonly hex: string;
  readonly alpha: number;
  readonly css: string;
}

interface PaletteDragState {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly slotId: string;
  readonly sourceOrder: readonly string[];
  readonly sourceCenters: readonly number[];
  readonly sourceIndex: number;
  readonly startX: number;
  readonly startY: number;
  readonly startScrollLeft: number;
  currentX: number;
  currentY: number;
  targetIndex: number;
  activated: boolean;
  touchReady: boolean;
  touchScrolling: boolean;
}

interface DragPreview {
  readonly slotId: string;
  readonly offsets: Readonly<Record<string, number>>;
}

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const RGB_COLOR = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([0-9]*\.?[0-9]+)\s*)?\)$/iu;
const HEX_EDITOR_COLOR = /^#[0-9a-f]{6}$/iu;
const TRANSPARENT_COLOR = "rgba(255,255,255,0)";
const DEFAULT_COLOR = "#17212b";
const DRAG_THRESHOLD_PX = 6;
const TOUCH_HOLD_MS = 240;
const EDGE_ZONE_PX = 28;
const EDGE_SCROLL_PX_PER_SECOND = 540;
const PALETTE_MIN_COUNT = 1;
const PALETTE_MAX_COUNT = 24;
const WHEEL_LINE_PX = 32;

function channelHex(value: number): string {
  return Math.round(value).toString(16).padStart(2, "0");
}

function parseColor(value: unknown): ParsedColor | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const source = value.trim();
  const hex = HEX_COLOR.exec(source);
  if (hex) {
    const digits = hex[1].toLowerCase();
    const expanded = digits.length === 3 || digits.length === 4
      ? [...digits].map((digit) => `${digit}${digit}`).join("")
      : digits;
    const opaqueHex = `#${expanded.slice(0, 6)}`;
    const alpha = expanded.length === 8
      ? Number.parseInt(expanded.slice(6, 8), 16) / 255
      : 1;
    return {
      hex: opaqueHex,
      alpha,
      css: alpha === 1
        ? opaqueHex
        : `rgba(${Number.parseInt(expanded.slice(0, 2), 16)},${Number.parseInt(expanded.slice(2, 4), 16)},${Number.parseInt(expanded.slice(4, 6), 16)},${Number(alpha.toFixed(3))})`,
    };
  }

  const rgb = RGB_COLOR.exec(source);
  if (!rgb) return null;
  const channels = rgb.slice(1, 4).map(Number);
  const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
  if (
    channels.some((channel) => !Number.isInteger(channel) || channel > 255)
    || !Number.isFinite(alpha)
    || alpha < 0
    || alpha > 1
  ) {
    return null;
  }
  const opaqueHex = `#${channels.map(channelHex).join("")}`;
  return {
    hex: opaqueHex,
    alpha,
    css: alpha === 1
      ? opaqueHex
      : `rgba(${channels.join(",")},${Number(alpha.toFixed(3))})`,
  };
}

function canonicalEditorColor(value: string): string | null {
  return HEX_EDITOR_COLOR.test(value.trim()) ? value.trim().toLowerCase() : null;
}

function colorLabel(value: ParsedColor | null): string {
  if (!value) return "не задан";
  if (value.alpha === 0) return "без цвета";
  return value.alpha === 1
    ? value.hex.toUpperCase()
    : `${value.hex.toUpperCase()}, ${Math.round(value.alpha * 100)}%`;
}

function uniqueValidSlots(
  slots: readonly BoardColorPaletteSlot[],
): readonly BoardColorPaletteSlot[] {
  const ids = new Set<string>();
  const result: BoardColorPaletteSlot[] = [];
  for (const slot of slots) {
    const parsed = parseColor(slot.color);
    if (!slot.id || ids.has(slot.id) || !parsed || parsed.alpha !== 1) continue;
    ids.add(slot.id);
    result.push({ id: slot.id, color: parsed.hex });
  }
  return result;
}

function uniqueRecentColors(
  colors: readonly string[],
  palette: readonly BoardColorPaletteSlot[],
): readonly string[] {
  const seen = new Set(palette.map((slot) => slot.color));
  const result: string[] = [];
  for (const color of colors) {
    const parsed = parseColor(color);
    if (!parsed || parsed.alpha !== 1 || seen.has(parsed.hex)) continue;
    seen.add(parsed.hex);
    result.push(parsed.hex);
    if (result.length === 8) break;
  }
  return result;
}

function pointerDistance(drag: PaletteDragState): number {
  return Math.hypot(drag.currentX - drag.startX, drag.currentY - drag.startY);
}

function horizontalWheelDelta(
  event: WheelEvent,
  scrollContainer: HTMLElement,
): number | null {
  if (
    !Number.isFinite(event.deltaX)
    || !Number.isFinite(event.deltaY)
  ) {
    return null;
  }
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
    ? event.deltaX
    : event.deltaY;
  if (delta === 0) return null;
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return delta * WHEEL_LINE_PX;
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return delta * scrollContainer.clientWidth;
  }
  return delta;
}

export function BoardColorControl({
  property,
  label,
  current,
  mixed = false,
  allowTransparent = property === "fill",
  paletteSlots,
  recentColors = [],
  disabled = false,
  showPropertyIcon = true,
  onApply,
  onCommitColor,
  onChangePaletteSlot,
  onAddPaletteSlot,
  onDeletePaletteSlot,
  onMovePaletteSlot,
  onContinuousChangeStart,
  onContinuousChangeEnd,
}: BoardColorControlProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const paletteToggleRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const favoritesRef = useRef<HTMLDivElement>(null);
  const recentsRef = useRef<HTMLDivElement>(null);
  const slotButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const dragRef = useRef<PaletteDragState | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const touchTimerRef = useRef<number | null>(null);
  const dragLastFrameRef = useRef<number | null>(null);
  const suppressedClickRef = useRef<string | null>(null);
  const continuousActiveRef = useRef(false);
  const internalPointerRef = useRef(false);
  const internalPointerTimerRef = useRef<number | null>(null);
  const callbacksRef = useRef({
    onApply,
    onCommitColor,
    onChangePaletteSlot,
    onAddPaletteSlot,
    onDeletePaletteSlot,
    onMovePaletteSlot,
    onContinuousChangeStart,
    onContinuousChangeEnd,
  });
  callbacksRef.current = {
    onApply,
    onCommitColor,
    onChangePaletteSlot,
    onAddPaletteSlot,
    onDeletePaletteSlot,
    onMovePaletteSlot,
    onContinuousChangeStart,
    onContinuousChangeEnd,
  };

  const [open, setOpen] = useState(false);
  const [paletteEditing, setPaletteEditing] = useState(false);
  const [editingSlotId, setEditingSlotId] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [draggingSlotId, setDraggingSlotId] = useState<string | null>(null);
  const [draftHex, setDraftHex] = useState(DEFAULT_COLOR);
  const [announcement, setAnnouncement] = useState("");
  const dialogId = useId();
  const parsedCurrent = parseColor(current);
  const slots = useMemo(() => uniqueValidSlots(paletteSlots), [paletteSlots]);
  const recents = useMemo(
    () => uniqueRecentColors(recentColors, slots),
    [recentColors, slots],
  );
  const editingSlot = slots.find((slot) => slot.id === editingSlotId) ?? null;
  const editorColor = editingSlot?.color
    ?? parsedCurrent?.hex
    ?? DEFAULT_COLOR;
  const transparent = parsedCurrent?.alpha === 0;
  const propertyLabel = label
    ?? (property === "stroke" ? "Цвет линии" : "Цвет заливки");
  const PropertyIcon = property === "stroke" ? Palette : PaintBucket;

  const endContinuousChange = useCallback(() => {
    if (!continuousActiveRef.current) return;
    continuousActiveRef.current = false;
    callbacksRef.current.onContinuousChangeEnd?.();
  }, []);

  const beginContinuousChange = useCallback(() => {
    if (continuousActiveRef.current || editingSlotId) return;
    continuousActiveRef.current = true;
    callbacksRef.current.onContinuousChangeStart?.();
  }, [editingSlotId]);

  const cancelDragFrame = useCallback(() => {
    if (dragFrameRef.current !== null) {
      window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    if (touchTimerRef.current !== null) {
      window.clearTimeout(touchTimerRef.current);
      touchTimerRef.current = null;
    }
    dragLastFrameRef.current = null;
  }, []);

  const cancelDrag = useCallback((suppressClick = false) => {
    cancelDragFrame();
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && suppressClick) suppressedClickRef.current = drag.slotId;
    if (drag) {
      const button = slotButtonsRef.current.get(drag.slotId);
      try {
        if (button?.hasPointerCapture(drag.pointerId)) {
          button.releasePointerCapture(drag.pointerId);
        }
      } catch {
        // Pointer capture may already belong to the browser again.
      }
    }
    setDragPreview(null);
    setDraggingSlotId(null);
  }, [cancelDragFrame]);

  const closeDialog = useCallback((restoreFocus: boolean) => {
    endContinuousChange();
    cancelDrag(true);
    setOpen(false);
    setPaletteEditing(false);
    setEditingSlotId(null);
    setAnnouncement("");
    if (restoreFocus) {
      window.requestAnimationFrame(() => {
        triggerRef.current?.focus({ preventScroll: true });
      });
    }
  }, [cancelDrag, endContinuousChange]);

  const applyEditorColor = useCallback((
    color: string,
    remember = true,
  ) => {
    const canonical = canonicalEditorColor(color);
    if (!canonical) return false;
    if (editingSlotId) {
      callbacksRef.current.onChangePaletteSlot(editingSlotId, canonical);
      setAnnouncement(`Цвет палитры изменён на ${canonical.toUpperCase()}`);
    } else {
      callbacksRef.current.onApply(canonical);
      if (remember) callbacksRef.current.onCommitColor?.(canonical);
      setAnnouncement(`${propertyLabel}: ${canonical.toUpperCase()}`);
    }
    setDraftHex(canonical);
    return true;
  }, [editingSlotId, propertyLabel]);

  const commitEditorColor = useCallback((color: string) => {
    const canonical = canonicalEditorColor(color);
    if (!canonical) return;
    setDraftHex(canonical);
    if (!editingSlotId) {
      callbacksRef.current.onCommitColor?.(canonical);
      setAnnouncement(`${propertyLabel}: ${canonical.toUpperCase()}`);
    }
  }, [editingSlotId, propertyLabel]);

  const updateDragPreview = useCallback((frameTime: number) => {
    dragFrameRef.current = null;
    const drag = dragRef.current;
    if (!drag || drag.touchScrolling || !drag.touchReady) return;
    if (!drag.activated && pointerDistance(drag) < DRAG_THRESHOLD_PX) return;
    if (!drag.activated) {
      drag.activated = true;
      setDraggingSlotId(drag.slotId);
    }

    const strip = favoritesRef.current;
    let continueEdgeScroll = false;
    if (strip) {
      const rect = strip.getBoundingClientRect();
      const elapsed = dragLastFrameRef.current === null
        ? 1000 / 60
        : Math.max(0, Math.min(32, frameTime - dragLastFrameRef.current));
      dragLastFrameRef.current = frameTime;
      const step = EDGE_SCROLL_PX_PER_SECOND * elapsed / 1000;
      const maximum = Math.max(0, strip.scrollWidth - strip.clientWidth);
      const before = strip.scrollLeft;
      let after = before;
      if (drag.currentX < rect.left + EDGE_ZONE_PX) {
        after = Math.max(0, before - step);
      } else if (drag.currentX > rect.right - EDGE_ZONE_PX) {
        after = Math.min(maximum, before + step);
      }
      if (after !== before) {
        strip.scrollLeft = after;
        continueEdgeScroll = true;
      }
    }

    const scrollDelta = (strip?.scrollLeft ?? drag.startScrollLeft)
      - drag.startScrollLeft;
    const pointerDelta = drag.currentX - drag.startX;
    const draggedCenter = drag.sourceCenters[drag.sourceIndex] + pointerDelta;
    const targetIndex = drag.sourceCenters.filter((center, index) =>
      index !== drag.sourceIndex && draggedCenter > center - scrollDelta).length;
    drag.targetIndex = targetIndex;

    const offsets: Record<string, number> = {
      [drag.slotId]: pointerDelta + scrollDelta,
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
    setDragPreview({ slotId: drag.slotId, offsets });
    if (continueEdgeScroll && dragFrameRef.current === null) {
      dragFrameRef.current = window.requestAnimationFrame(updateDragPreview);
    }
  }, []);

  const scheduleDragPreview = useCallback(() => {
    if (dragFrameRef.current !== null) return;
    dragFrameRef.current = window.requestAnimationFrame(updateDragPreview);
  }, [updateDragPreview]);

  const updateDragFromPointer = useCallback((event: Readonly<{
    pointerId: number;
    clientX: number;
    clientY: number;
    preventDefault(): void;
  }>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.currentX = event.clientX;
    drag.currentY = event.clientY;
    if (drag.pointerType === "touch" && !drag.touchReady) {
      if (!drag.touchScrolling && pointerDistance(drag) >= DRAG_THRESHOLD_PX) {
        drag.touchScrolling = true;
        if (touchTimerRef.current !== null) {
          window.clearTimeout(touchTimerRef.current);
          touchTimerRef.current = null;
        }
      }
      if (drag.touchScrolling) {
        const strip = favoritesRef.current;
        if (strip) {
          const maximum = Math.max(0, strip.scrollWidth - strip.clientWidth);
          strip.scrollLeft = Math.max(
            0,
            Math.min(maximum, drag.startScrollLeft - (drag.currentX - drag.startX)),
          );
        }
        event.preventDefault();
      }
      return;
    }
    if (drag.activated || pointerDistance(drag) >= DRAG_THRESHOLD_PX) {
      event.preventDefault();
    }
    scheduleDragPreview();
  }, [scheduleDragPreview]);

  const finishDrag = useCallback((commit: boolean, point?: {
    readonly x: number;
    readonly y: number;
  }) => {
    const pending = dragRef.current;
    if (commit && pending && point) {
      pending.currentX = point.x;
      pending.currentY = point.y;
      cancelDragFrame();
      updateDragPreview(performance.now());
    }
    const drag = dragRef.current;
    const activated = Boolean(commit && drag?.activated);
    const touchScrolling = Boolean(commit && drag?.touchScrolling);
    const slotId = drag?.slotId ?? null;
    const sourceIndex = drag?.sourceIndex ?? -1;
    const targetIndex = drag?.targetIndex ?? -1;
    cancelDrag();
    if ((activated || touchScrolling) && slotId) {
      suppressedClickRef.current = slotId;
      window.setTimeout(() => {
        if (suppressedClickRef.current === slotId) {
          suppressedClickRef.current = null;
        }
      }, 0);
    }
    if (activated && slotId && targetIndex !== sourceIndex) {
      callbacksRef.current.onMovePaletteSlot(slotId, targetIndex);
      setAnnouncement(`Цвет перемещён на позицию ${targetIndex + 1}`);
    }
  }, [cancelDrag, cancelDragFrame, updateDragPreview]);

  const startSlotPointer = useCallback((
    event: ReactPointerEvent<HTMLButtonElement>,
    slotId: string,
  ) => {
    if (
      !paletteEditing
      || event.button !== 0
      || event.isPrimary === false
      || (dragRef.current && dragRef.current.pointerId !== event.pointerId)
    ) {
      return;
    }
    cancelDrag();
    suppressedClickRef.current = null;
    const sourceOrder = slots.map((slot) => slot.id);
    const sourceIndex = sourceOrder.indexOf(slotId);
    if (sourceIndex < 0) return;
    const measured = sourceOrder.map((id) => {
      const rect = slotButtonsRef.current.get(id)?.getBoundingClientRect();
      return rect ? rect.left + rect.width / 2 : null;
    });
    const sourceCenter = measured[sourceIndex] ?? event.clientX;
    const fallbackStep = measured.slice(1).map((center, index) =>
      center !== null && measured[index] !== null
        ? center - measured[index]!
        : null).find((value): value is number =>
      value !== null && Number.isFinite(value) && value > 0) ?? 36;
    const usable = measured.every((center, index) => center !== null && (
      index === 0 || center > (measured[index - 1] ?? center)
    ));
    const sourceCenters = measured.map((center, index) =>
      usable && center !== null
        ? center
        : sourceCenter + (index - sourceIndex) * fallbackStep);
    const pointerType = event.pointerType || "mouse";
    dragRef.current = {
      pointerId: event.pointerId,
      pointerType,
      slotId,
      sourceOrder,
      sourceCenters,
      sourceIndex,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      startScrollLeft: favoritesRef.current?.scrollLeft ?? 0,
      targetIndex: sourceIndex,
      activated: false,
      touchReady: pointerType !== "touch",
      touchScrolling: false,
    };
    if (pointerType === "touch") {
      const pointerId = event.pointerId;
      touchTimerRef.current = window.setTimeout(() => {
        touchTimerRef.current = null;
        const drag = dragRef.current;
        if (drag?.pointerId === pointerId && !drag.touchScrolling) {
          drag.touchReady = true;
        }
      }, TOUCH_HOLD_MS);
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Window-level listeners keep the gesture bounded without capture.
    }
  }, [cancelDrag, paletteEditing, slots]);

  const chooseColor = useCallback((color: string) => {
    endContinuousChange();
    callbacksRef.current.onApply(color);
    callbacksRef.current.onCommitColor?.(color);
    setDraftHex(parseColor(color)?.hex ?? DEFAULT_COLOR);
    setAnnouncement(`${propertyLabel}: ${colorLabel(parseColor(color))}`);
  }, [endContinuousChange, propertyLabel]);

  useEffect(() => {
    return () => {
      cancelDragFrame();
      dragRef.current = null;
      if (internalPointerTimerRef.current !== null) {
        window.clearTimeout(internalPointerTimerRef.current);
      }
      if (continuousActiveRef.current) {
        continuousActiveRef.current = false;
        callbacksRef.current.onContinuousChangeEnd?.();
      }
    };
  }, [cancelDragFrame]);

  useEffect(() => {
    if (!open) return;
    const scrollContainers = [favoritesRef.current, recentsRef.current]
      .filter((element): element is HTMLDivElement => element !== null);
    const onWheel = (event: WheelEvent) => {
      const scrollContainer = event.currentTarget;
      if (!(scrollContainer instanceof HTMLElement)) return;
      const delta = horizontalWheelDelta(event, scrollContainer);
      if (delta === null) return;

      if (event.ctrlKey || event.metaKey || dragRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const maximum = Math.max(
        0,
        scrollContainer.scrollWidth - scrollContainer.clientWidth,
      );
      const next = Math.max(
        0,
        Math.min(maximum, scrollContainer.scrollLeft + delta),
      );
      if (next === scrollContainer.scrollLeft) {
        event.stopPropagation();
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      scrollContainer.scrollLeft = next;
    };

    for (const scrollContainer of scrollContainers) {
      scrollContainer.addEventListener("wheel", onWheel, { passive: false });
    }
    return () => {
      for (const scrollContainer of scrollContainers) {
        scrollContainer.removeEventListener("wheel", onWheel);
      }
    };
  }, [open, paletteEditing, recents.length]);

  useEffect(() => {
    if (!open) return;
    const eventInside = (event: Event): boolean => {
      const path = typeof event.composedPath === "function"
        ? event.composedPath()
        : [];
      return Boolean(path.includes(rootRef.current as EventTarget)
        || path.includes(dialogRef.current as EventTarget)
        || (
          event.target instanceof Element
          && event.target.closest('[data-board-color-formats-popup="true"]')
        )
        || (
          event.target instanceof Node
          && (
            rootRef.current?.contains(event.target)
            || dialogRef.current?.contains(event.target)
          )
        ));
    };
    const outsidePointer = (event: PointerEvent) => {
      if (eventInside(event)) {
        internalPointerRef.current = true;
        if (internalPointerTimerRef.current !== null) {
          window.clearTimeout(internalPointerTimerRef.current);
        }
        internalPointerTimerRef.current = window.setTimeout(() => {
          internalPointerTimerRef.current = null;
          internalPointerRef.current = false;
        }, 0);
        return;
      }
      closeDialog(false);
    };
    const outsideFocus = (event: FocusEvent) => {
      if (internalPointerRef.current || eventInside(event)) return;
      closeDialog(false);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (dialogRef.current?.querySelector(
        '.board-color-picker[data-formats-open="true"]',
      )) return;
      event.preventDefault();
      event.stopPropagation();
      if (dragRef.current) {
        cancelDrag(true);
        return;
      }
      if (paletteEditing) {
        setPaletteEditing(false);
        setEditingSlotId(null);
        paletteToggleRef.current?.focus({ preventScroll: true });
        return;
      }
      closeDialog(true);
    };
    document.addEventListener("pointerdown", outsidePointer, true);
    document.addEventListener("focusin", outsideFocus, true);
    document.addEventListener("keydown", keyDown, true);
    return () => {
      document.removeEventListener("pointerdown", outsidePointer, true);
      document.removeEventListener("focusin", outsideFocus, true);
      document.removeEventListener("keydown", keyDown, true);
      internalPointerRef.current = false;
      if (internalPointerTimerRef.current !== null) {
        window.clearTimeout(internalPointerTimerRef.current);
        internalPointerTimerRef.current = null;
      }
    };
  }, [cancelDrag, closeDialog, open, paletteEditing]);

  useEffect(() => {
    if (!open || !paletteEditing) return;
    const pointerMove = (event: PointerEvent) => updateDragFromPointer(event);
    const pointerUp = (event: PointerEvent) => {
      if (dragRef.current?.pointerId !== event.pointerId) return;
      finishDrag(true, { x: event.clientX, y: event.clientY });
    };
    const pointerCancel = (event: PointerEvent) => {
      if (dragRef.current?.pointerId === event.pointerId) finishDrag(false);
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
  }, [finishDrag, open, paletteEditing, updateDragFromPointer]);

  useEffect(() => {
    const blur = () => {
      endContinuousChange();
      cancelDrag(true);
    };
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
  }, [cancelDrag, endContinuousChange]);

  useEffect(() => {
    if (editingSlotId && !slots.some((slot) => slot.id === editingSlotId)) {
      setEditingSlotId(null);
    }
  }, [editingSlotId, slots]);

  useEffect(() => {
    setDraftHex(editorColor);
  }, [editorColor]);

  useLayoutEffect(() => {
    if (!open) return;
    dialogRef.current?.focus({ preventScroll: true });
    const positionDialog = () => {
      const trigger = triggerRef.current;
      const dialog = dialogRef.current;
      if (!trigger || !dialog) return;
      const margin = 8;
      const gap = 7;
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
      const dialogRect = dialog.getBoundingClientRect();
      const width = Math.min(328, Math.max(0, boundaryRight - boundaryLeft));
      dialog.style.width = `${Math.floor(width)}px`;
      const left = Math.max(
        boundaryLeft,
        Math.min(
          boundaryRight - width,
          triggerRect.left + triggerRect.width / 2 - width / 2,
        ),
      );
      const below = Math.max(
        0,
        boundaryBottom - triggerRect.bottom - gap,
      );
      const above = Math.max(0, triggerRect.top - gap - boundaryTop);
      const placeBelow = below >= Math.min(dialogRect.height, 280)
        || below >= above;
      const maximumHeight = Math.max(120, placeBelow ? below : above);
      const top = placeBelow
        ? triggerRect.bottom + gap
        : Math.max(boundaryTop, triggerRect.top - gap - Math.min(
          dialogRect.height,
          maximumHeight,
        ));
      dialog.style.left = `${Math.round(left)}px`;
      dialog.style.top = `${Math.round(top)}px`;
      dialog.style.maxHeight = `${Math.floor(maximumHeight)}px`;
    };
    positionDialog();
    const positionOnExternalScroll = (event: Event) => {
      const dialog = dialogRef.current;
      if (event.target instanceof Node && dialog?.contains(event.target)) return;
      positionDialog();
    };
    window.addEventListener("resize", positionDialog);
    window.addEventListener("scroll", positionOnExternalScroll, true);
    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(positionDialog)
      : null;
    if (observer) {
      if (dialogRef.current) observer.observe(dialogRef.current);
      if (triggerRef.current) observer.observe(triggerRef.current);
    }
    return () => {
      window.removeEventListener("resize", positionDialog);
      window.removeEventListener("scroll", positionOnExternalScroll, true);
      observer?.disconnect();
    };
  }, [open]);

  const triggerStyle = {
    "--board-color-value": parsedCurrent?.css ?? DEFAULT_COLOR,
  } as CSSProperties;

  return (
    <div
      ref={rootRef}
      className={`board-color-control${showPropertyIcon ? "" : " board-color-control--swatch-only"}${mixed ? " is-mixed" : ""}${transparent ? " is-transparent" : ""}${parsedCurrent?.hex === DEFAULT_COLOR ? " is-adaptive-ink" : ""}`}
    >
      <button
        ref={triggerRef}
        type="button"
        className="board-color-control__trigger"
        style={triggerStyle}
        disabled={disabled}
        aria-label={`${propertyLabel}: ${mixed ? "смешанные значения" : colorLabel(parsedCurrent)}`}
        title={`${propertyLabel}: ${mixed ? "смешанные значения" : colorLabel(parsedCurrent)}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => {
          if (open) closeDialog(false);
          else setOpen(true);
        }}
      >
        <span className="board-color-control__trigger-swatch" aria-hidden="true" />
        {showPropertyIcon && <PropertyIcon size={14} aria-hidden="true" />}
      </button>

      {open && createPortal((
        <div
          ref={dialogRef}
          id={dialogId}
          className={`board-color-control__popover${paletteEditing ? " is-palette-editing" : ""}`}
          role="dialog"
          aria-label={`Настройка: ${propertyLabel.toLowerCase()}`}
          aria-modal="false"
          tabIndex={-1}
        >
          <header className="board-color-control__header">
            <strong>{propertyLabel}</strong>
            <div className="board-color-control__header-actions">
              <button
                ref={paletteToggleRef}
                type="button"
                className="board-color-control__palette-toggle"
                aria-label={paletteEditing
                  ? "Завершить настройку палитры"
                  : "Настроить палитру"}
                title={paletteEditing
                  ? "Завершить настройку палитры"
                  : "Настроить палитру"}
                aria-pressed={paletteEditing}
                onClick={() => {
                  cancelDrag(true);
                  setPaletteEditing((value) => {
                    const next = !value;
                    setEditingSlotId(next
                      ? slots.find((slot) =>
                        !mixed
                        && parsedCurrent?.alpha === 1
                        && slot.color === parsedCurrent.hex)?.id
                        ?? slots[0]?.id
                        ?? null
                      : null);
                    return next;
                  });
                }}
              >
                <Settings2 size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="board-color-control__close"
                aria-label="Закрыть настройку цвета"
                title="Закрыть"
                onClick={() => closeDialog(true)}
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>
          </header>

          {mixed && !editingSlotId && (
            <p className="board-color-control__mixed-note">
              Выбраны разные цвета. Новый цвет применится ко всем совместимым объектам.
            </p>
          )}

          <div
            ref={favoritesRef}
            className="board-color-control__favorites"
            role="group"
            aria-label="Избранные цвета"
          >
            {slots.map((slot, index) => {
              const selected = paletteEditing
                ? editingSlotId === slot.id
                : !mixed
                  && parsedCurrent?.alpha === 1
                  && parsedCurrent.hex === slot.color;
              const dragging = draggingSlotId === slot.id;
              const offset = dragPreview?.offsets[slot.id];
              return (
                <div
                  key={slot.id}
                  className={`board-color-control__slot${dragging ? " is-dragging" : offset !== undefined ? " is-displaced" : ""}`}
                  data-color-slot-id={slot.id}
                  style={offset === undefined ? undefined : {
                    "--board-color-drag-x": `${offset}px`,
                  } as CSSProperties}
                >
                  <button
                    ref={(element) => {
                      if (element) slotButtonsRef.current.set(slot.id, element);
                      else slotButtonsRef.current.delete(slot.id);
                    }}
                    type="button"
                    className={`board-color-control__favorite${slot.color === DEFAULT_COLOR ? " is-adaptive-ink" : ""}`}
                    style={{
                      "--board-color-value": slot.color,
                    } as CSSProperties}
                    aria-label={`${paletteEditing ? "Настроить" : "Выбрать"} цвет ${slot.color.toUpperCase()}, позиция ${index + 1}`}
                    title={slot.color.toUpperCase()}
                    aria-pressed={selected}
                    aria-keyshortcuts={paletteEditing
                      ? "Alt+ArrowLeft Alt+ArrowRight"
                      : undefined}
                    onPointerDown={(event) => {
                      if (event.button === 0 && event.isPrimary !== false) {
                        event.currentTarget.dataset.pointerFocus = "true";
                      }
                      startSlotPointer(event, slot.id);
                    }}
                    onPointerMove={updateDragFromPointer}
                    onPointerUp={(event) => {
                      if (dragRef.current?.pointerId === event.pointerId) {
                        finishDrag(true, { x: event.clientX, y: event.clientY });
                      }
                    }}
                    onPointerCancel={(event) => {
                      if (dragRef.current?.pointerId === event.pointerId) {
                        finishDrag(false);
                      }
                    }}
                    onLostPointerCapture={(event) => {
                      if (dragRef.current?.pointerId === event.pointerId) {
                        cancelDrag(true);
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
                        || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                      ) {
                        return;
                      }
                      event.preventDefault();
                      event.stopPropagation();
                      const targetIndex = event.key === "ArrowLeft"
                        ? index - 1
                        : index + 1;
                      if (targetIndex < 0 || targetIndex >= slots.length) return;
                      callbacksRef.current.onMovePaletteSlot(slot.id, targetIndex);
                      setAnnouncement(`Цвет перемещён на позицию ${targetIndex + 1}`);
                    }}
                    onBlur={(event) => {
                      delete event.currentTarget.dataset.pointerFocus;
                    }}
                    onClick={() => {
                      if (suppressedClickRef.current === slot.id) {
                        suppressedClickRef.current = null;
                        return;
                      }
                      if (paletteEditing) {
                        setEditingSlotId(slot.id);
                        setAnnouncement(`Редактируется цвет ${index + 1}`);
                      } else {
                        chooseColor(slot.color);
                      }
                    }}
                  >
                    <span aria-hidden="true" />
                    {selected && <Check size={12} aria-hidden="true" />}
                  </button>

                  {paletteEditing && (
                    <button
                      type="button"
                      className="board-color-control__delete"
                      aria-label={`Удалить цвет ${slot.color.toUpperCase()}`}
                      title="Удалить цвет"
                      disabled={slots.length <= PALETTE_MIN_COUNT}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (slots.length <= PALETTE_MIN_COUNT) return;
                        const nextId = slots[index + 1]?.id
                          ?? slots[index - 1]?.id
                          ?? null;
                        callbacksRef.current.onDeletePaletteSlot(slot.id);
                        if (editingSlotId === slot.id) setEditingSlotId(nextId);
                        setAnnouncement(`Цвет ${index + 1} удалён`);
                        window.requestAnimationFrame(() => {
                          if (nextId) {
                            slotButtonsRef.current.get(nextId)?.focus({
                              preventScroll: true,
                            });
                          } else {
                            paletteToggleRef.current?.focus({
                              preventScroll: true,
                            });
                          }
                        });
                      }}
                    >
                      <Trash2 size={11} aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}

            {paletteEditing && (
              <button
                type="button"
                className="board-color-control__add"
                aria-label="Добавить цвет в палитру"
                title="Добавить цвет"
                disabled={slots.length >= PALETTE_MAX_COUNT}
                onClick={() => {
                  if (slots.length >= PALETTE_MAX_COUNT) return;
                  const color = canonicalEditorColor(draftHex) ?? editorColor;
                  const createdId = callbacksRef.current.onAddPaletteSlot(color);
                  if (typeof createdId === "string" && createdId) {
                    setEditingSlotId(createdId);
                  }
                  setAnnouncement(`Цвет ${color.toUpperCase()} добавлен в палитру`);
                }}
              >
                <Plus size={14} aria-hidden="true" />
              </button>
            )}
          </div>

          {recents.length > 0 && !paletteEditing && (
            <div
              ref={recentsRef}
              className="board-color-control__recents"
              role="group"
              aria-label="Недавние цвета"
            >
              <span>Недавние</span>
              {recents.map((color) => (
                <button
                  key={color}
                  type="button"
                  className="board-color-control__recent"
                  style={{
                    "--board-color-value": color,
                  } as CSSProperties}
                  aria-label={`Выбрать недавний цвет ${color.toUpperCase()}`}
                  title={color.toUpperCase()}
                  onClick={() => chooseColor(color)}
                >
                  <span aria-hidden="true" />
                </button>
              ))}
            </div>
          )}

          {allowTransparent && !paletteEditing && (
            <button
              type="button"
              className="board-color-control__transparent"
              aria-label="Без заливки"
              aria-pressed={!mixed && transparent}
              onClick={() => chooseColor(TRANSPARENT_COLOR)}
            >
              <span aria-hidden="true" />
              Без заливки
            </button>
          )}

          <BoardColorPicker
            value={draftHex}
            label={editingSlotId
              ? "Настройка цвета палитры"
              : `Настройка: ${propertyLabel.toLowerCase()}`}
            onPreview={(color) => applyEditorColor(color, false)}
            onCommit={commitEditorColor}
            onGestureStart={beginContinuousChange}
            onGestureEnd={endContinuousChange}
          />

          <span className="sr-only" aria-live="polite">
            {announcement}
          </span>
        </div>
      ), rootRef.current?.closest(".board-v2") ?? document.body)}
    </div>
  );
}

export const BOARD_COLOR_TRANSPARENT = TRANSPARENT_COLOR;
