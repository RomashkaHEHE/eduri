import { MoreHorizontal, X } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export const BOARD_DASH_PRESETS = [
  { value: [] as number[], label: "Сплошная", className: "is-solid" },
  { value: [8, 6], label: "Штриховая", className: "is-dashed" },
  { value: [2, 5], label: "Пунктирная", className: "is-dotted" },
] as const;

const MAX_DASH_SEGMENTS = 8;
const MAX_DASH_SEGMENT = 256;

export function boardDashValueEquals(
  value: unknown,
  expected: readonly number[],
): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) =>
      typeof entry === "number"
      && Number.isFinite(entry)
      && entry === expected[index]);
}

export function parseBoardDashPattern(value: string): number[] | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "solid") return [];
  const parts = trimmed.split(/[\s,;]+/u).filter(Boolean);
  if (parts.length === 0 || parts.length > MAX_DASH_SEGMENTS) return null;
  const segments = parts.map(Number);
  if (segments.some((segment) =>
    !Number.isFinite(segment)
    || segment < 0
    || segment > MAX_DASH_SEGMENT)) {
    return null;
  }
  return segments.some((segment) => segment > 0) ? segments : [];
}

function formatDashPattern(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((entry): entry is number =>
      typeof entry === "number" && Number.isFinite(entry))
    .slice(0, MAX_DASH_SEGMENTS)
    .join(", ");
}

export interface BoardDashControlProps {
  readonly value: unknown;
  readonly mixed: boolean;
  readonly onChange: (value: readonly number[]) => void;
}

export function BoardDashControl({
  value,
  mixed,
  onChange,
}: BoardDashControlProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => mixed ? "" : formatDashPattern(value));
  const [invalid, setInvalid] = useState(false);
  const popupId = useId();
  const isCustom = !mixed && !BOARD_DASH_PRESETS.some((preset) =>
    boardDashValueEquals(value, preset.value));

  useEffect(() => {
    if (!open) {
      setDraft(mixed ? "" : formatDashPattern(value));
      setInvalid(false);
    }
  }, [mixed, open, value]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
    const pointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node
        && (
          rootRef.current?.contains(event.target)
          || popoverRef.current?.contains(event.target)
        )
      ) {
        return;
      }
      setOpen(false);
    };
    const focusIn = (event: FocusEvent) => {
      if (
        event.target instanceof Node
        && (
          rootRef.current?.contains(event.target)
          || popoverRef.current?.contains(event.target)
        )
      ) {
        return;
      }
      setOpen(false);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("focusin", focusIn, true);
    document.addEventListener("keydown", keyDown, true);
    return () => {
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("focusin", focusIn, true);
      document.removeEventListener("keydown", keyDown, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const positionPopover = () => {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;
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
      const popoverRect = popover.getBoundingClientRect();
      const width = Math.min(306, Math.max(0, boundaryRight - boundaryLeft));
      popover.style.width = `${Math.floor(width)}px`;
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
      const placeBelow = below >= Math.min(popoverRect.height, 190)
        || below >= above;
      const top = placeBelow
        ? triggerRect.bottom + gap
        : Math.max(boundaryTop, triggerRect.top - gap - popoverRect.height);
      popover.style.left = `${Math.round(left)}px`;
      popover.style.top = `${Math.round(top)}px`;
      popover.style.maxHeight = `${Math.floor(Math.max(
        110,
        placeBelow ? below : above,
      ))}px`;
    };
    positionPopover();
    window.addEventListener("resize", positionPopover);
    window.addEventListener("scroll", positionPopover, true);
    return () => {
      window.removeEventListener("resize", positionPopover);
      window.removeEventListener("scroll", positionPopover, true);
    };
  }, [open]);

  const commit = () => {
    const parsed = parseBoardDashPattern(draft);
    if (parsed === null) {
      setInvalid(true);
      return false;
    }
    setInvalid(false);
    onChange(parsed);
    setDraft(formatDashPattern(parsed));
    return true;
  };

  return (
    <div
      ref={rootRef}
      className="board-stylebar__group board-stylebar__segments board-dash-control"
      role="group"
      aria-label="Тип линии"
    >
      {BOARD_DASH_PRESETS.map((preset) => (
        <button
          key={preset.label}
          type="button"
          aria-label={preset.label}
          title={preset.label}
          aria-pressed={!mixed && boardDashValueEquals(value, preset.value)}
          onClick={() => {
            setOpen(false);
            onChange(preset.value);
          }}
        >
          <span className={preset.className} />
        </button>
      ))}
      <button
        ref={triggerRef}
        type="button"
        className="board-dash-control__trigger"
        aria-label="Свой рисунок штриха"
        title="Свой рисунок штриха"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        aria-pressed={open || isCustom}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal size={15} aria-hidden="true" />
      </button>
      {open && createPortal((
        <div
          ref={popoverRef}
          id={popupId}
          className="board-style-popover board-dash-control__popover"
          role="dialog"
          aria-label="Свой рисунок штриха"
        >
          <header>
            <div>
              <strong>Рисунок штриха</strong>
              <small>До 8 отрезков по 0–256 px</small>
            </div>
            <button
              type="button"
              aria-label="Закрыть настройку штриха"
              title="Закрыть"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus({ preventScroll: true });
              }}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </header>
          <label>
            <span>Чередование</span>
            <input
              ref={inputRef}
              type="text"
              inputMode="decimal"
              value={draft}
              placeholder={mixed ? "Смешанное" : "Например: 12, 4, 2, 4"}
              aria-label="Длины штрихов и промежутков"
              aria-invalid={invalid}
              aria-describedby={`${popupId}-hint`}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                setInvalid(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (commit()) {
                    setOpen(false);
                    triggerRef.current?.focus({ preventScroll: true });
                  }
                }
              }}
            />
          </label>
          <div
            className="board-dash-control__preview"
            aria-hidden="true"
          >
            <svg viewBox="0 0 220 16" preserveAspectRatio="none">
              <line
                x1="2"
                y1="8"
                x2="218"
                y2="8"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray={parseBoardDashPattern(draft)?.join(" ")}
              />
            </svg>
          </div>
          <p id={`${popupId}-hint`}>
            Числа чередуют длину линии и пробела. Пустое поле — сплошная линия.
          </p>
          <footer>
            <button type="button" onClick={() => {
              setDraft("");
              setInvalid(false);
              onChange([]);
            }}>Сплошная</button>
            <button type="button" className="is-primary" onClick={() => {
              if (commit()) {
                setOpen(false);
                triggerRef.current?.focus({ preventScroll: true });
              }
            }}>Применить</button>
          </footer>
        </div>
      ), rootRef.current?.closest(".board-v2") ?? document.body)}
    </div>
  );
}
