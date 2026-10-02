import type { CSSProperties } from "react";
import type {
  BoardCamera,
  BoardObjectSnapshot,
  BoardTheme,
} from "./rendering/types";

export const BOARD_TEXT_LINE_HEIGHT = 1.25;
export const BOARD_TEXT_PADDING_PX = 2;
export const BOARD_TEXT_MIN_AUTO_WIDTH = 16;
export const BOARD_TEXT_FONT_SIZE_MIN = 0.01;
export const BOARD_TEXT_FONT_SIZE_MAX = 256;

export function canonicalBoardFontStyle(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) return "normal";
  const tokens = new Set(value.split(/\s+/u));
  const ordered = ["bold", "italic"].filter((token) => tokens.has(token));
  return ordered.length > 0 ? ordered.join(" ") : "normal";
}

/** Exact DOM geometry used by both the live editor and presence mirrors. */
export function boardTextEditorStyle(
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
    ? Math.min(
        BOARD_TEXT_FONT_SIZE_MAX,
        Math.max(BOARD_TEXT_FONT_SIZE_MIN, object.style.fontSize),
      ) * zoom
    : 20 * zoom;
  const fontFamily = typeof object.style.fontFamily === "string"
    && object.style.fontFamily.length <= 256
    ? object.style.fontFamily
    : "Inter, Arial, sans-serif";
  const fontStyle = canonicalBoardFontStyle(object.style.fontStyle);

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
    lineHeight: BOARD_TEXT_LINE_HEIGHT,
    opacity: typeof object.style.opacity === "number"
      && Number.isFinite(object.style.opacity)
      ? Math.max(0, Math.min(1, object.style.opacity))
      : 1,
    textAlign: object.props.textAlign === "center" || object.props.textAlign === "right"
      ? object.props.textAlign
      : "left",
    transform: `rotate(${Number.isFinite(rotation) ? rotation : 0}rad)`,
  };
}
