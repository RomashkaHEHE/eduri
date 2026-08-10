import { Copy } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

export interface BoardColorPickerAlphaControl {
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly onPreview: (alpha: number) => void;
  readonly onCommit?: (alpha: number) => void;
}

export interface BoardColorPickerProps {
  readonly value: string;
  readonly label: string;
  readonly onPreview: (color: string) => void;
  readonly onCommit?: (color: string) => void;
  readonly onGestureStart?: () => void;
  readonly onGestureEnd?: () => void;
  readonly alpha?: BoardColorPickerAlphaControl;
}

interface HsvColor {
  readonly hue: number;
  readonly saturation: number;
  readonly value: number;
}

interface HsvaColor extends HsvColor {
  readonly alpha: number;
}

interface AlphaBounds {
  readonly minimum: number;
  readonly maximum: number;
  readonly step: number;
}

type PickerAxis = "saturation" | "brightness" | "hue" | "alpha";
type FormatKind = "rgb" | "hsv" | "hex";

type GestureOwner =
  | { readonly kind: "sv"; readonly pointerId: number }
  | { readonly kind: "rail"; readonly axis: "hue" | "alpha"; readonly pointerId: number }
  | { readonly kind: "keyboard"; readonly axis: PickerAxis }
  | { readonly kind: "discrete"; readonly axis: PickerAxis | "format" };

interface GestureBaseline {
  readonly color: string;
  readonly alpha: number;
}

interface FormatDrafts {
  readonly rgb: string;
  readonly hsv: string;
  readonly hex: string;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;
const HEX_WITH_ALPHA = /^#([0-9a-f]{6})([0-9a-f]{2})$/iu;
const RGB_FORMAT = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([0-9]*\.?[0-9]+%?))?\s*\)$/iu;
const HSV_FORMAT = /^hsva?\(\s*(-?[0-9]*\.?[0-9]+)\s*,\s*([0-9]*\.?[0-9]+)%?\s*,\s*([0-9]*\.?[0-9]+)%?(?:\s*,\s*([0-9]*\.?[0-9]+%?))?\s*\)$/iu;
const RANGE_GESTURE_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
const DEFAULT_COLOR = "#17212b";
const ACHROMATIC_EPSILON = 0.001;

function isRangeGestureKey(key: string): boolean {
  return RANGE_GESTURE_KEYS.has(key);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.000_001;
}

function sameHsva(left: HsvaColor, right: HsvaColor): boolean {
  return closeEnough(left.hue, right.hue)
    && closeEnough(left.saturation, right.saturation)
    && closeEnough(left.value, right.value)
    && closeEnough(left.alpha, right.alpha);
}

function canonicalHex(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return HEX_COLOR.test(normalized) ? normalized : null;
}

function normalizeHue(value: number): number {
  const normalized = ((value % 360) + 360) % 360;
  return normalized === 360 ? 0 : normalized;
}

function rgbToHsv(color: string): HsvColor {
  const red = Number.parseInt(color.slice(1, 3), 16) / 255;
  const green = Number.parseInt(color.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(color.slice(5, 7), 16) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta > 0) {
    if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  return {
    hue: normalizeHue(hue),
    saturation: maximum === 0 ? 0 : delta / maximum,
    value: maximum,
  };
}

function channelHex(value: number): string {
  return Math.round(clamp(value, 0, 255)).toString(16).padStart(2, "0");
}

function hsvToRgb({ hue, saturation, value }: HsvColor): readonly [number, number, number] {
  const normalizedHue = normalizeHue(hue);
  const chroma = value * saturation;
  const segment = normalizedHue / 60;
  const x = chroma * (1 - Math.abs((segment % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;
  if (segment < 1) [red, green] = [chroma, x];
  else if (segment < 2) [red, green] = [x, chroma];
  else if (segment < 3) [green, blue] = [chroma, x];
  else if (segment < 4) [green, blue] = [x, chroma];
  else if (segment < 5) [red, blue] = [x, chroma];
  else [red, blue] = [chroma, x];
  const match = value - chroma;
  return [
    Math.round(clamp((red + match) * 255, 0, 255)),
    Math.round(clamp((green + match) * 255, 0, 255)),
    Math.round(clamp((blue + match) * 255, 0, 255)),
  ];
}

function hsvToHex(color: HsvColor): string {
  const [red, green, blue] = hsvToRgb(color);
  return `#${channelHex(red)}${channelHex(green)}${channelHex(blue)}`;
}

function hsvaFromHex(color: string, alpha: number, fallbackHue = 0): HsvaColor {
  const parsed = rgbToHsv(color);
  return {
    ...parsed,
    hue: parsed.saturation > ACHROMATIC_EPSILON ? parsed.hue : fallbackHue,
    alpha,
  };
}

function normalizeAlphaBounds(alpha: BoardColorPickerAlphaControl | undefined): AlphaBounds {
  const requestedMinimum = Number.isFinite(alpha?.min)
    ? clamp(alpha?.min ?? 0, 0, 1)
    : 0;
  const requestedMaximum = Number.isFinite(alpha?.max)
    ? clamp(alpha?.max ?? 1, 0, 1)
    : 1;
  const minimum = Math.min(requestedMinimum, requestedMaximum);
  const maximum = Math.max(requestedMinimum, requestedMaximum);
  const requestedStep = alpha?.step;
  const step = typeof requestedStep === "number"
    && Number.isFinite(requestedStep)
    && requestedStep > 0
    ? requestedStep
    : 0.01;
  return { minimum, maximum, step };
}

function decimalPrecision(value: number): number {
  const source = Math.abs(value).toString().toLowerCase();
  const [coefficient, exponentSource] = source.split("e");
  const exponent = exponentSource ? Number(exponentSource) : 0;
  const fractionLength = coefficient.split(".")[1]?.length ?? 0;
  return Math.max(0, fractionLength - exponent);
}

function normalizeAlpha(value: number | undefined, bounds: AlphaBounds): number {
  const bounded = clamp(
    typeof value === "number" && Number.isFinite(value) ? value : bounds.maximum,
    bounds.minimum,
    bounds.maximum,
  );
  const stepIndex = Math.round((bounded - bounds.minimum) / bounds.step);
  const snapped = clamp(
    bounds.minimum + stepIndex * bounds.step,
    bounds.minimum,
    bounds.maximum,
  );
  const precision = Math.min(
    12,
    Math.max(
      decimalPrecision(bounds.minimum),
      decimalPrecision(bounds.maximum),
      decimalPrecision(bounds.step),
    ),
  );
  return Number(snapped.toFixed(precision));
}

function hueGradient(saturation: number, value: number): string {
  return `linear-gradient(90deg, ${[0, 60, 120, 180, 240, 300, 360]
    .map((hue, index) => `${hsvToHex({ hue, saturation, value })} ${(index / 6) * 100}%`)
    .join(", ")})`;
}

function compactNumber(value: number, precision = 3): string {
  return Number(value.toFixed(precision)).toString();
}

function formatDrafts(color: HsvaColor, alphaEnabled: boolean): FormatDrafts {
  const hex = hsvToHex(color);
  const [red, green, blue] = hsvToRgb(color);
  const hue = compactNumber(normalizeHue(color.hue), 2);
  const saturation = compactNumber(color.saturation * 100, 2);
  const brightness = compactNumber(color.value * 100, 2);
  const alpha = compactNumber(color.alpha, 3);
  return alphaEnabled
    ? {
        rgb: `rgba(${red}, ${green}, ${blue}, ${alpha})`,
        hsv: `hsva(${hue}, ${saturation}%, ${brightness}%, ${alpha})`,
        hex: `${hex}${channelHex(color.alpha * 255)}`.toUpperCase(),
      }
    : {
        rgb: `rgb(${red}, ${green}, ${blue})`,
        hsv: `hsv(${hue}, ${saturation}%, ${brightness}%)`,
        hex: hex.toUpperCase(),
      };
}

function parseAlphaComponent(value: string): number | null {
  const percent = value.endsWith("%");
  const parsed = Number(percent ? value.slice(0, -1) : value);
  if (!Number.isFinite(parsed)) return null;
  const alpha = percent ? parsed / 100 : parsed;
  return alpha >= 0 && alpha <= 1 ? alpha : null;
}

function parseFormatDraft(
  kind: FormatKind,
  source: string,
  current: HsvaColor,
  alphaEnabled: boolean,
  alphaBounds: AlphaBounds,
): HsvaColor | null {
  const value = source.trim();
  if (kind === "hex") {
    if (alphaEnabled) {
      const match = HEX_WITH_ALPHA.exec(value);
      if (!match) return null;
      const color = `#${match[1].toLowerCase()}`;
      const parsedAlpha = Number.parseInt(match[2], 16) / 255;
      return hsvaFromHex(
        color,
        normalizeAlpha(parsedAlpha, alphaBounds),
        current.hue,
      );
    }
    const color = canonicalHex(value);
    return color ? hsvaFromHex(color, current.alpha, current.hue) : null;
  }

  if (kind === "rgb") {
    const match = RGB_FORMAT.exec(value);
    const expectsAlpha = /^rgba\(/iu.test(value);
    if (!match || expectsAlpha !== alphaEnabled || Boolean(match[4]) !== alphaEnabled) {
      return null;
    }
    const channels = match.slice(1, 4).map(Number);
    if (channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
      return null;
    }
    const parsedAlpha = alphaEnabled ? parseAlphaComponent(match[4]) : current.alpha;
    if (parsedAlpha === null) return null;
    const color = `#${channels.map(channelHex).join("")}`;
    return hsvaFromHex(
      color,
      normalizeAlpha(parsedAlpha, alphaBounds),
      current.hue,
    );
  }

  const match = HSV_FORMAT.exec(value);
  const expectsAlpha = /^hsva\(/iu.test(value);
  if (!match || expectsAlpha !== alphaEnabled || Boolean(match[4]) !== alphaEnabled) {
    return null;
  }
  const hue = Number(match[1]);
  const saturation = Number(match[2]);
  const brightness = Number(match[3]);
  const parsedAlpha = alphaEnabled ? parseAlphaComponent(match[4]) : current.alpha;
  if (
    !Number.isFinite(hue)
    || hue < 0
    || hue > 360
    || !Number.isFinite(saturation)
    || saturation < 0
    || saturation > 100
    || !Number.isFinite(brightness)
    || brightness < 0
    || brightness > 100
    || parsedAlpha === null
  ) {
    return null;
  }
  return {
    hue: normalizeHue(hue),
    saturation: saturation / 100,
    value: brightness / 100,
    alpha: normalizeAlpha(parsedAlpha, alphaBounds),
  };
}

interface BoardColorFormatsProps {
  readonly id: string;
  readonly color: HsvaColor;
  readonly alphaEnabled: boolean;
  readonly alphaBounds: AlphaBounds;
  readonly focusFirstInput: boolean;
  readonly onApply: (color: HsvaColor) => void;
  readonly onClose: () => void;
}

function BoardColorFormats({
  id,
  color,
  alphaEnabled,
  alphaBounds,
  focusFirstInput,
  onApply,
  onClose,
}: BoardColorFormatsProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const firstInputRef = useRef<HTMLInputElement | null>(null);
  const formatted = useMemo(
    () => formatDrafts(color, alphaEnabled),
    [alphaEnabled, color],
  );
  const [drafts, setDrafts] = useState<FormatDrafts>(formatted);
  const [dirty, setDirty] = useState<Record<FormatKind, boolean>>({
    rgb: false,
    hsv: false,
    hex: false,
  });
  const [invalid, setInvalid] = useState<Record<FormatKind, boolean>>({
    rgb: false,
    hsv: false,
    hex: false,
  });
  const [copyStatus, setCopyStatus] = useState<{
    readonly kind: "success" | "error";
    readonly message: string;
  } | null>(null);

  useLayoutEffect(() => {
    if (focusFirstInput) firstInputRef.current?.focus({ preventScroll: true });
  }, [focusFirstInput]);

  useEffect(() => {
    setDrafts(formatted);
    setDirty({ rgb: false, hsv: false, hex: false });
    setInvalid({ rgb: false, hsv: false, hex: false });
    setCopyStatus(null);
  }, [formatted]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) {
        return;
      }
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && rootRef.current?.contains(focused)) {
        focused.blur();
      }
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);

  const apply = (kind: FormatKind): boolean => {
    const parsed = parseFormatDraft(
      kind,
      drafts[kind],
      color,
      alphaEnabled,
      alphaBounds,
    );
    if (!parsed) {
      setInvalid((current) => ({ ...current, [kind]: true }));
      return false;
    }
    setDirty((current) => ({ ...current, [kind]: false }));
    setInvalid((current) => ({ ...current, [kind]: false }));
    onApply(parsed);
    return true;
  };

  const labels: Readonly<Record<FormatKind, string>> = alphaEnabled
    ? { rgb: "RGBA", hsv: "HSVA", hex: "HEX" }
    : { rgb: "RGB", hsv: "HSV", hex: "HEX" };

  return (
    <div
      id={id}
      ref={rootRef}
      className="board-color-picker__formats"
      role="dialog"
      aria-label="Форматы цвета"
      onContextMenu={(event) => event.stopPropagation()}
    >
      {(["rgb", "hsv", "hex"] as const).map((kind) => (
        <label key={kind} className="board-color-picker__format-row">
          <span>{labels[kind]}</span>
          <input
            ref={kind === "rgb" ? firstInputRef : undefined}
            className="board-color-picker__format-input"
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            value={drafts[kind]}
            aria-label={`Цвет в формате ${labels[kind]}`}
            aria-invalid={invalid[kind]}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setDrafts((current) => ({ ...current, [kind]: next }));
              setDirty((current) => ({ ...current, [kind]: true }));
              setInvalid((current) => ({ ...current, [kind]: false }));
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              event.stopPropagation();
              if (dirty[kind] && apply(kind)) event.currentTarget.select();
            }}
            onBlur={() => {
              if (dirty[kind]) apply(kind);
            }}
          />
          <button
            type="button"
            className="board-color-picker__format-copy"
            aria-label={`Скопировать ${labels[kind]}`}
            title={`Скопировать ${labels[kind]}`}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              const clipboard = navigator.clipboard;
              if (!clipboard?.writeText) {
                setCopyStatus({
                  kind: "error",
                  message: "Буфер обмена недоступен",
                });
                return;
              }
              void clipboard.writeText(formatted[kind]).then(
                () => setCopyStatus({
                  kind: "success",
                  message: `${labels[kind]} скопирован`,
                }),
                () => setCopyStatus({
                  kind: "error",
                  message: "Не удалось скопировать цвет",
                }),
              );
            }}
          >
            <Copy size={13} aria-hidden="true" />
          </button>
        </label>
      ))}
      {copyStatus && (
        <span
          className={copyStatus.kind === "success"
            ? "board-color-picker__format-status"
            : "board-color-picker__format-error"}
          role={copyStatus.kind === "success" ? "status" : "alert"}
        >
          {copyStatus.message}
        </span>
      )}
    </div>
  );
}

export function BoardColorPicker({
  value,
  label,
  onPreview,
  onCommit,
  onGestureStart,
  onGestureEnd,
  alpha,
}: BoardColorPickerProps) {
  const canonicalValue = canonicalHex(value) ?? DEFAULT_COLOR;
  const alphaEnabled = alpha !== undefined;
  const alphaBounds = useMemo(
    () => normalizeAlphaBounds(alpha),
    [alpha?.max, alpha?.min, alpha?.step],
  );
  const externalAlpha = normalizeAlpha(alpha?.value, alphaBounds);
  const initialHsvaRef = useRef<HsvaColor | null>(null);
  if (!initialHsvaRef.current) {
    initialHsvaRef.current = hsvaFromHex(
      canonicalValue,
      alphaEnabled ? externalAlpha : 1,
    );
  }
  const [displayedHsva, setDisplayedHsva] = useState(initialHsvaRef.current);
  const [gestureActive, setGestureActive] = useState(false);
  const [formatsOpen, setFormatsOpen] = useState(false);
  const hsvaRef = useRef(displayedHsva);
  const gestureOwnerRef = useRef<GestureOwner | null>(null);
  const gestureBaselineRef = useRef<GestureBaseline | null>(null);
  const pendingPreviewRef = useRef<HsvaColor | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const svWindowFallbackCleanupRef = useRef<(() => void) | null>(null);
  const railWindowFallbackCleanupRef = useRef<(() => void) | null>(null);
  const previewRef = useRef<HTMLButtonElement | null>(null);
  const restorePreviewFocusRef = useRef(false);
  const formatsOpenedByKeyboardRef = useRef(false);
  const lastEmittedColorRef = useRef(canonicalValue);
  const lastEmittedAlphaRef = useRef(externalAlpha);
  const svHelpId = useId();
  const formatsId = useId();
  const callbacksRef = useRef({
    onPreview,
    onCommit,
    onGestureStart,
    onGestureEnd,
    alpha,
  });
  callbacksRef.current = {
    onPreview,
    onCommit,
    onGestureStart,
    onGestureEnd,
    alpha,
  };

  const emitPreview = useCallback((next: HsvaColor) => {
    const color = hsvToHex(next);
    if (color !== lastEmittedColorRef.current) {
      lastEmittedColorRef.current = color;
      callbacksRef.current.onPreview(color);
    }
    const alphaCallbacks = callbacksRef.current.alpha;
    if (
      alphaCallbacks
      && !closeEnough(next.alpha, lastEmittedAlphaRef.current)
    ) {
      lastEmittedAlphaRef.current = next.alpha;
      alphaCallbacks.onPreview(next.alpha);
    }
  }, []);

  const applyPendingPreview = useCallback(() => {
    const pending = pendingPreviewRef.current;
    pendingPreviewRef.current = null;
    if (!pending) return;
    setDisplayedHsva((current) => sameHsva(current, pending) ? current : pending);
    emitPreview(pending);
  }, [emitPreview]);

  const flushPreview = useCallback(() => {
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    applyPendingPreview();
  }, [applyPendingPreview]);

  const queuePreview = useCallback((next: HsvaColor) => {
    const normalized = {
      hue: normalizeHue(next.hue),
      saturation: clamp(next.saturation, 0, 1),
      value: clamp(next.value, 0, 1),
      alpha: normalizeAlpha(next.alpha, alphaBounds),
    };
    hsvaRef.current = normalized;
    pendingPreviewRef.current = normalized;
    if (previewFrameRef.current !== null) return;
    previewFrameRef.current = window.requestAnimationFrame(() => {
      previewFrameRef.current = null;
      applyPendingPreview();
    });
  }, [alphaBounds, applyPendingPreview]);

  const beginGesture = useCallback((owner: GestureOwner): boolean => {
    if (gestureOwnerRef.current) return false;
    gestureOwnerRef.current = owner;
    const current = hsvaRef.current;
    gestureBaselineRef.current = {
      color: hsvToHex(current),
      alpha: current.alpha,
    };
    setGestureActive(true);
    callbacksRef.current.onGestureStart?.();
    return true;
  }, []);

  const finishGesture = useCallback((commit: boolean) => {
    if (!gestureOwnerRef.current) return;
    flushPreview();
    const baseline = gestureBaselineRef.current;
    const current = hsvaRef.current;
    gestureOwnerRef.current = null;
    gestureBaselineRef.current = null;
    setGestureActive(false);
    if (commit && baseline) {
      const color = hsvToHex(current);
      if (color !== baseline.color) callbacksRef.current.onCommit?.(color);
      const alphaCallbacks = callbacksRef.current.alpha;
      if (alphaCallbacks && !closeEnough(current.alpha, baseline.alpha)) {
        alphaCallbacks.onCommit?.(current.alpha);
      }
    }
    callbacksRef.current.onGestureEnd?.();
  }, [flushPreview]);

  const clearSvWindowFallback = useCallback(() => {
    const cleanup = svWindowFallbackCleanupRef.current;
    svWindowFallbackCleanupRef.current = null;
    cleanup?.();
  }, []);

  const ownsSvPointer = useCallback((pointerId: number): boolean => {
    const owner = gestureOwnerRef.current;
    return owner?.kind === "sv" && owner.pointerId === pointerId;
  }, []);

  const colorFromSvPointer = useCallback((
    event: Readonly<{ clientX: number; clientY: number }>,
    element: HTMLElement,
  ): HsvaColor => {
    const rect = element.getBoundingClientRect();
    const current = hsvaRef.current;
    return {
      ...current,
      saturation: rect.width > 0
        ? clamp((event.clientX - rect.left) / rect.width, 0, 1)
        : current.saturation,
      value: rect.height > 0
        ? 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1)
        : current.value,
    };
  }, []);

  const finishSvPointer = useCallback((
    pointerId: number,
    commit: boolean,
    event?: Readonly<{ clientX: number; clientY: number }>,
    element?: HTMLElement,
  ) => {
    if (!ownsSvPointer(pointerId)) return;
    if (commit && event && element) {
      queuePreview(colorFromSvPointer(event, element));
    }
    clearSvWindowFallback();
    finishGesture(commit);
  }, [clearSvWindowFallback, colorFromSvPointer, finishGesture, ownsSvPointer, queuePreview]);

  const installSvWindowFallback = useCallback((
    element: HTMLDivElement,
    pointerId: number,
  ) => {
    if (!ownsSvPointer(pointerId)) return;
    clearSvWindowFallback();
    const originatedInsidePlane = (event: PointerEvent): boolean => (
      event.target instanceof Node && element.contains(event.target)
    );
    const onPointerMove = (event: PointerEvent) => {
      if (
        event.pointerId !== pointerId
        || !ownsSvPointer(pointerId)
        || originatedInsidePlane(event)
      ) return;
      event.preventDefault();
      queuePreview(colorFromSvPointer(event, element));
    };
    const onPointerUp = (event: PointerEvent) => {
      if (
        event.pointerId !== pointerId
        || !ownsSvPointer(pointerId)
        || originatedInsidePlane(event)
      ) return;
      event.preventDefault();
      finishSvPointer(pointerId, true, event, element);
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerId !== pointerId || !ownsSvPointer(pointerId)) return;
      finishSvPointer(pointerId, false);
    };
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp, { passive: false });
    window.addEventListener("pointercancel", onPointerCancel);
    svWindowFallbackCleanupRef.current = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [clearSvWindowFallback, colorFromSvPointer, finishSvPointer, ownsSvPointer, queuePreview]);

  const beginKeyboardGesture = useCallback((
    axis: PickerAxis,
    event: ReactKeyboardEvent<HTMLElement>,
  ): boolean => {
    if (!isRangeGestureKey(event.key)) return false;
    event.stopPropagation();
    const owner = gestureOwnerRef.current;
    if (owner?.kind === "keyboard" && owner.axis === axis) return true;
    return beginGesture({ kind: "keyboard", axis });
  }, [beginGesture]);

  const finishKeyboardGesture = useCallback((
    axis: PickerAxis,
    commit: boolean,
    event?: ReactKeyboardEvent<HTMLElement>,
  ) => {
    if (event) {
      if (!isRangeGestureKey(event.key)) return;
      event.stopPropagation();
    }
    const owner = gestureOwnerRef.current;
    if (owner?.kind !== "keyboard" || owner.axis !== axis) return;
    finishGesture(commit);
  }, [finishGesture]);

  const changeAxisByKeyboard = useCallback((
    axis: "saturation" | "brightness",
    event: ReactKeyboardEvent<HTMLInputElement>,
  ) => {
    if (!beginKeyboardGesture(axis, event)) return;
    event.preventDefault();
    const current = hsvaRef.current;
    const value = axis === "saturation" ? current.saturation : current.value;
    const arrowStep = event.shiftKey ? 0.1 : 0.01;
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? 1
        : event.key === "PageDown"
          ? clamp(value - 0.1, 0, 1)
          : event.key === "PageUp"
            ? clamp(value + 0.1, 0, 1)
            : event.key === "ArrowLeft" || event.key === "ArrowDown"
              ? clamp(value - arrowStep, 0, 1)
              : clamp(value + arrowStep, 0, 1);
    queuePreview({
      ...current,
      [axis === "brightness" ? "value" : "saturation"]: next,
    });
  }, [beginKeyboardGesture, queuePreview]);

  const changeAxisDiscretely = useCallback((
    axis: "saturation" | "brightness",
    next: number,
  ) => {
    const owner = gestureOwnerRef.current;
    const current = hsvaRef.current;
    if (owner?.kind === "keyboard" && owner.axis === axis) {
      queuePreview({
        ...current,
        [axis === "brightness" ? "value" : "saturation"]: clamp(next, 0, 1),
      });
      return;
    }
    if (!beginGesture({ kind: "discrete", axis })) return;
    queuePreview({
      ...current,
      [axis === "brightness" ? "value" : "saturation"]: clamp(next, 0, 1),
    });
    finishGesture(true);
  }, [beginGesture, finishGesture, queuePreview]);

  const changeRail = useCallback((axis: "hue" | "alpha", value: number) => {
    const owner = gestureOwnerRef.current;
    const owned = owner?.kind === "rail" && owner.axis === axis
      || owner?.kind === "keyboard" && owner.axis === axis;
    if (!owned && !beginGesture({ kind: "discrete", axis })) return;
    const current = hsvaRef.current;
    queuePreview(axis === "hue"
      ? { ...current, hue: normalizeHue(value) }
      : {
          ...current,
          alpha: normalizeAlpha(value, alphaBounds),
        });
    if (!owned) finishGesture(true);
  }, [alphaBounds, beginGesture, finishGesture, queuePreview]);

  const clearRailWindowFallback = useCallback(() => {
    const cleanup = railWindowFallbackCleanupRef.current;
    railWindowFallbackCleanupRef.current = null;
    cleanup?.();
  }, []);

  const ownsRailPointer = useCallback((
    axis: "hue" | "alpha",
    pointerId: number,
  ): boolean => {
    const owner = gestureOwnerRef.current;
    return owner?.kind === "rail"
      && owner.axis === axis
      && owner.pointerId === pointerId;
  }, []);

  const finishRailPointer = useCallback((
    axis: "hue" | "alpha",
    pointerId: number,
    commit: boolean,
  ) => {
    if (!ownsRailPointer(axis, pointerId)) return;
    clearRailWindowFallback();
    finishGesture(commit);
  }, [clearRailWindowFallback, finishGesture, ownsRailPointer]);

  const railValueFromPointer = useCallback((
    axis: "hue" | "alpha",
    event: Readonly<{ clientX: number }>,
    element: HTMLInputElement,
  ): number => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0) {
      return axis === "hue" ? hsvaRef.current.hue : hsvaRef.current.alpha;
    }
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    if (axis === "hue") return Math.round(ratio * 359);
    return normalizeAlpha(
      alphaBounds.maximum
        - ratio * (alphaBounds.maximum - alphaBounds.minimum),
      alphaBounds,
    );
  }, [alphaBounds]);

  const installRailWindowFallback = useCallback((
    element: HTMLInputElement,
    axis: "hue" | "alpha",
    pointerId: number,
  ) => {
    if (!ownsRailPointer(axis, pointerId)) return;
    clearRailWindowFallback();
    const originatedInsideRail = (event: PointerEvent): boolean => (
      event.target instanceof Node && element.contains(event.target)
    );
    const updateFromPointer = (event: PointerEvent) => {
      changeRail(axis, railValueFromPointer(axis, event, element));
    };
    const onPointerMove = (event: PointerEvent) => {
      if (
        event.pointerId !== pointerId
        || !ownsRailPointer(axis, pointerId)
        || originatedInsideRail(event)
      ) return;
      event.preventDefault();
      updateFromPointer(event);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (
        event.pointerId !== pointerId
        || !ownsRailPointer(axis, pointerId)
        || originatedInsideRail(event)
      ) return;
      event.preventDefault();
      updateFromPointer(event);
      finishRailPointer(axis, pointerId, true);
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerId !== pointerId || !ownsRailPointer(axis, pointerId)) return;
      finishRailPointer(axis, pointerId, false);
    };
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp, { passive: false });
    window.addEventListener("pointercancel", onPointerCancel);
    railWindowFallbackCleanupRef.current = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [changeRail, clearRailWindowFallback, finishRailPointer, ownsRailPointer, railValueFromPointer]);

  const beginRailPointer = useCallback((
    axis: "hue" | "alpha",
    event: ReactPointerEvent<HTMLInputElement>,
  ) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    if (!beginGesture({ kind: "rail", axis, pointerId: event.pointerId })) {
      event.preventDefault();
      return;
    }
    let captured = false;
    try {
      if (typeof event.currentTarget.setPointerCapture === "function") {
        event.currentTarget.setPointerCapture(event.pointerId);
        captured = typeof event.currentTarget.hasPointerCapture === "function"
          && event.currentTarget.hasPointerCapture(event.pointerId);
      }
    } catch {
      captured = false;
    }
    if (!captured) {
      installRailWindowFallback(event.currentTarget, axis, event.pointerId);
    }
  }, [beginGesture, installRailWindowFallback]);

  const cancelAxisGesture = useCallback((axis: "hue" | "alpha") => {
    const owner = gestureOwnerRef.current;
    if (
      owner?.kind === "keyboard" && owner.axis === axis
      || owner?.kind === "rail" && owner.axis === axis
    ) {
      clearRailWindowFallback();
      finishGesture(false);
    }
  }, [clearRailWindowFallback, finishGesture]);

  const applyFormat = useCallback((next: HsvaColor) => {
    if (!beginGesture({ kind: "discrete", axis: "format" })) return;
    queuePreview(next);
    finishGesture(true);
  }, [beginGesture, finishGesture, queuePreview]);

  useEffect(() => {
    if (gestureActive) return;
    const current = hsvaRef.current;
    let next = current;
    if (canonicalValue !== lastEmittedColorRef.current) {
      next = hsvaFromHex(canonicalValue, current.alpha, current.hue);
      lastEmittedColorRef.current = canonicalValue;
    }
    if (alphaEnabled) {
      if (!closeEnough(externalAlpha, lastEmittedAlphaRef.current)) {
        next = { ...next, alpha: externalAlpha };
        lastEmittedAlphaRef.current = externalAlpha;
      }
    } else if (!closeEnough(next.alpha, 1)) {
      next = { ...next, alpha: 1 };
      lastEmittedAlphaRef.current = 1;
    }
    if (!sameHsva(current, next)) {
      hsvaRef.current = next;
      setDisplayedHsva(next);
    }
  }, [alphaEnabled, canonicalValue, externalAlpha, gestureActive]);

  useEffect(() => () => {
    clearSvWindowFallback();
    clearRailWindowFallback();
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    pendingPreviewRef.current = null;
    if (gestureOwnerRef.current) {
      gestureOwnerRef.current = null;
      gestureBaselineRef.current = null;
      callbacksRef.current.onGestureEnd?.();
    }
  }, [clearRailWindowFallback, clearSvWindowFallback]);

  useEffect(() => {
    const onBlur = () => {
      restorePreviewFocusRef.current = false;
      if (gestureOwnerRef.current) {
        clearSvWindowFallback();
        clearRailWindowFallback();
        finishGesture(false);
      }
      formatsOpenedByKeyboardRef.current = false;
      setFormatsOpen(false);
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [clearRailWindowFallback, clearSvWindowFallback, finishGesture]);

  const displayedColor = hsvToHex(displayedHsva);
  const pickerStyle = {
    "--board-picker-hue": String(displayedHsva.hue),
    "--board-picker-saturation": `${displayedHsva.saturation * 100}%`,
    "--board-picker-value": `${(1 - displayedHsva.value) * 100}%`,
    "--board-picker-color": displayedColor,
    "--board-picker-alpha": String(displayedHsva.alpha),
    "--board-picker-hue-gradient": hueGradient(
      displayedHsva.saturation,
      displayedHsva.value,
    ),
  } as CSSProperties;
  const hueRailValue = clamp(Math.round(displayedHsva.hue), 0, 359);
  const openFormats = useCallback((focusFirstInput: boolean) => {
    restorePreviewFocusRef.current = false;
    formatsOpenedByKeyboardRef.current = focusFirstInput;
    setFormatsOpen(true);
  }, []);
  const closeFormats = useCallback((restorePreviewFocus = false) => {
    restorePreviewFocusRef.current = restorePreviewFocus;
    formatsOpenedByKeyboardRef.current = false;
    setFormatsOpen(false);
  }, []);

  useLayoutEffect(() => {
    if (formatsOpen || !restorePreviewFocusRef.current) return;
    restorePreviewFocusRef.current = false;
    const preview = previewRef.current;
    const active = document.activeElement;
    if (
      preview
      && (active === null || active === document.body || active === preview)
    ) {
      preview.focus({ preventScroll: true });
    }
  }, [formatsOpen]);

  return (
    <div
      className="board-color-picker"
      style={pickerStyle}
      aria-label={label}
      data-formats-open={formatsOpen ? "true" : undefined}
      onKeyDown={(event) => {
        if (!formatsOpen || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        closeFormats(true);
      }}
    >
      <div
        className="board-color-picker__sv"
        role="group"
        aria-label="Насыщенность и яркость"
        aria-describedby={svHelpId}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.isPrimary === false) return;
          if (!beginGesture({ kind: "sv", pointerId: event.pointerId })) return;
          event.preventDefault();
          let captured = false;
          try {
            if (typeof event.currentTarget.setPointerCapture === "function") {
              event.currentTarget.setPointerCapture(event.pointerId);
              captured = typeof event.currentTarget.hasPointerCapture === "function"
                && event.currentTarget.hasPointerCapture(event.pointerId);
            }
          } catch {
            captured = false;
          }
          if (!captured) installSvWindowFallback(event.currentTarget, event.pointerId);
          queuePreview(colorFromSvPointer(event, event.currentTarget));
        }}
        onPointerMove={(event) => {
          if (!ownsSvPointer(event.pointerId)) return;
          event.preventDefault();
          queuePreview(colorFromSvPointer(event, event.currentTarget));
        }}
        onPointerUp={(event) => {
          finishSvPointer(event.pointerId, true, event, event.currentTarget);
        }}
        onPointerCancel={(event) => finishSvPointer(event.pointerId, false)}
        onLostPointerCapture={(event) => {
          if (ownsSvPointer(event.pointerId)) {
            installSvWindowFallback(event.currentTarget, event.pointerId);
          }
        }}
      >
        <input
          className="board-color-picker__axis"
          type="range"
          min="0"
          max="100"
          step="1"
          value={Math.round(displayedHsva.saturation * 100)}
          aria-label="Насыщенность"
          aria-valuetext={`${Math.round(displayedHsva.saturation * 100)}%`}
          aria-describedby={svHelpId}
          onKeyDown={(event) => changeAxisByKeyboard("saturation", event)}
          onKeyUp={(event) => finishKeyboardGesture("saturation", true, event)}
          onBlur={() => finishKeyboardGesture("saturation", false)}
          onChange={(event) => {
            changeAxisDiscretely("saturation", Number(event.currentTarget.value) / 100);
          }}
        />
        <input
          className="board-color-picker__axis"
          type="range"
          min="0"
          max="100"
          step="1"
          value={Math.round(displayedHsva.value * 100)}
          aria-label="Яркость"
          aria-valuetext={`${Math.round(displayedHsva.value * 100)}%`}
          aria-describedby={svHelpId}
          onKeyDown={(event) => changeAxisByKeyboard("brightness", event)}
          onKeyUp={(event) => finishKeyboardGesture("brightness", true, event)}
          onBlur={() => finishKeyboardGesture("brightness", false)}
          onChange={(event) => {
            changeAxisDiscretely("brightness", Number(event.currentTarget.value) / 100);
          }}
        />
        <span className="board-color-picker__sv-handle" aria-hidden="true" />
        <span id={svHelpId} className="board-color-picker__axis-help">
          На каждой оси стрелки влево и вниз уменьшают значение, а вправо и
          вверх увеличивают. Shift увеличивает шаг с 1% до 10%; Home, End,
          Page Up и Page Down переходят к границам или меняют значение на 10%.
        </span>
      </div>

      <div className="board-color-picker__hue-row">
        <button
          ref={previewRef}
          type="button"
          className="board-color-picker__preview"
          aria-label="Форматы выбранного цвета"
          aria-haspopup="dialog"
          aria-expanded={formatsOpen}
          aria-controls={formatsOpen ? formatsId : undefined}
          title="Форматы цвета"
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openFormats(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            openFormats(true);
          }}
        >
          <span aria-hidden="true" />
        </button>

        <div className="board-color-picker__rails">
          <input
            className="board-color-picker__rail board-color-picker__hue"
            type="range"
            min="0"
            max="359"
            step="1"
            value={hueRailValue}
            aria-label="Оттенок"
            aria-valuetext={`${hueRailValue}°`}
            onPointerDown={(event) => beginRailPointer("hue", event)}
            onPointerUp={(event) => finishRailPointer("hue", event.pointerId, true)}
            onPointerCancel={(event) => finishRailPointer("hue", event.pointerId, false)}
            onLostPointerCapture={(event) => {
              if (ownsRailPointer("hue", event.pointerId)) {
                installRailWindowFallback(event.currentTarget, "hue", event.pointerId);
              }
            }}
            onKeyDown={(event) => beginKeyboardGesture("hue", event)}
            onKeyUp={(event) => finishKeyboardGesture("hue", true, event)}
            onBlur={() => cancelAxisGesture("hue")}
            onChange={(event) => changeRail("hue", Number(event.currentTarget.value))}
          />

          {alphaEnabled && (
            <input
              className="board-color-picker__rail board-color-picker__alpha"
              type="range"
              min={alphaBounds.minimum}
              max={alphaBounds.maximum}
              step={alphaBounds.step}
              value={displayedHsva.alpha}
              dir="rtl"
              aria-label="Непрозрачность"
              aria-valuetext={`${Math.round(displayedHsva.alpha * 100)}%`}
              onPointerDown={(event) => beginRailPointer("alpha", event)}
              onPointerUp={(event) => finishRailPointer("alpha", event.pointerId, true)}
              onPointerCancel={(event) => finishRailPointer("alpha", event.pointerId, false)}
              onLostPointerCapture={(event) => {
                if (ownsRailPointer("alpha", event.pointerId)) {
                  installRailWindowFallback(event.currentTarget, "alpha", event.pointerId);
                }
              }}
              onKeyDown={(event) => beginKeyboardGesture("alpha", event)}
              onKeyUp={(event) => finishKeyboardGesture("alpha", true, event)}
              onBlur={() => cancelAxisGesture("alpha")}
              onChange={(event) => changeRail("alpha", Number(event.currentTarget.value))}
            />
          )}
        </div>
      </div>

      {formatsOpen && (
        <BoardColorFormats
          id={formatsId}
          color={displayedHsva}
          alphaEnabled={alphaEnabled}
          alphaBounds={alphaBounds}
          focusFirstInput={formatsOpenedByKeyboardRef.current}
          onApply={applyFormat}
          onClose={closeFormats}
        />
      )}
    </div>
  );
}
