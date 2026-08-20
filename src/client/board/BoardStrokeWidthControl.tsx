import { useMemo, type CSSProperties } from "react";

const COMMON_STROKE_WIDTHS = Object.freeze([
  0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48,
  64, 80, 96,
]);

function compactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function clampWidth(value: number, min: number, max: number, step: number): number {
  const clamped = Math.max(min, Math.min(max, value));
  return Math.round(clamped / step) * step;
}

export interface BoardStrokeWidthControlProps {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly mixed?: boolean;
  readonly label?: string;
  readonly className?: string;
  readonly onChange: (value: number) => void;
  readonly onContinuousChangeStart?: () => void;
  readonly onContinuousChangeEnd?: () => void;
}

export function BoardStrokeWidthControl({
  value,
  min,
  max,
  step = 0.5,
  mixed = false,
  label = "Толщина линии",
  className = "",
  onChange,
  onContinuousChangeStart,
  onContinuousChangeEnd,
}: BoardStrokeWidthControlProps) {
  const normalized = clampWidth(value, min, max, step);
  const stops = useMemo(() => {
    const values = COMMON_STROKE_WIDTHS.filter((entry) => entry >= min && entry <= max);
    values.push(min, max, normalized);
    return [...new Set(values)].sort((left, right) => left - right);
  }, [max, min, normalized]);
  const stopIndex = Math.max(0, stops.indexOf(normalized));
  const progress = stops.length <= 1 ? 0 : stopIndex / (stops.length - 1) * 100;
  const previewSize = Math.max(2, Math.min(18, 2 + Math.sqrt(normalized / max) * 16));
  const style = {
    "--board-stroke-width-progress": `${progress}%`,
    "--board-stroke-preview-size": `${previewSize}px`,
  } as CSSProperties;

  return (
    <div
      className={`board-stroke-width${mixed ? " is-mixed" : ""}${className ? ` ${className}` : ""}`}
      style={style}
    >
      <span className="board-stroke-width__preview" aria-hidden="true">
        <span />
      </span>
      <input
        className="board-stroke-width__slider"
        type="range"
        min={0}
        max={Math.max(0, stops.length - 1)}
        step={1}
        value={stopIndex}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={normalized}
        aria-valuetext={mixed
          ? `Смешанная толщина, ${compactNumber(normalized)} px`
          : `${compactNumber(normalized)} px`}
        title={mixed
          ? "Толщина: смешанные значения"
          : `Толщина ${compactNumber(normalized)} px`}
        onPointerDown={onContinuousChangeStart}
        onPointerUp={onContinuousChangeEnd}
        onPointerCancel={onContinuousChangeEnd}
        onFocus={onContinuousChangeStart}
        onBlur={onContinuousChangeEnd}
        onChange={(event) => {
          const next = stops[Number(event.currentTarget.value)];
          if (next !== undefined) onChange(next);
        }}
      />
      <label className="board-stroke-width__exact">
        <span className="sr-only">Точная толщина линии</span>
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={mixed ? "" : normalized}
          placeholder="—"
          aria-label={`Точная ${label.toLowerCase()}`}
          onFocus={onContinuousChangeStart}
          onBlur={onContinuousChangeEnd}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            if (event.currentTarget.value !== "" && Number.isFinite(next)) {
              onChange(clampWidth(next, min, max, step));
            }
          }}
        />
        <span aria-hidden="true">px</span>
      </label>
    </div>
  );
}
