import type { BoardTool } from "./rendering/types";
import {
  boardToolStyleKeys,
  defaultBoardToolStyle,
  type BoardToolStyleKey,
} from "./rendering/toolStyles";

export type BoardToolStyles = Partial<
  Record<BoardTool, Readonly<Record<string, unknown>>>
>;

export const TOOL_STYLE_PRESETS_STORAGE_KEY =
  "eduri-board-tool-styles-v1";

export const PERSISTED_TOOL_STYLE_TOOLS = [
  "text",
  "line",
  "arrow",
  "rectangle",
  "ellipse",
  "diamond",
  "frame",
] as const satisfies readonly BoardTool[];

export type PersistedToolStyleTool =
  (typeof PERSISTED_TOOL_STYLE_TOOLS)[number];

export const TOOL_STYLE_DASH_PRESETS = Object.freeze([
  Object.freeze([] as number[]),
  Object.freeze([8, 6]),
  Object.freeze([2, 5]),
] as const);

const TOOL_STYLE_PRESETS_STORAGE_VERSION = 1;
const TOOL_STYLE_PRESETS_MAX_SERIALIZED_LENGTH = 64 * 1024;
const MIN_STROKE_WIDTH = 0.5;
const MAX_STROKE_WIDTH = 96;
const MIN_OPACITY = 0.05;
const MAX_OPACITY = 1;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 256;
const MAX_COLOR_CODE_UNITS = 64;
const MAX_FONT_FAMILY_CODE_UNITS = 256;
const MAX_FONT_FAMILIES = 8;
const MAX_DASH_SEGMENTS = 8;
const MAX_DASH_SEGMENT = 256;

const HEX_COLOR_PATTERN =
  /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const RGB_COLOR_PATTERN =
  /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/iu;
const RGBA_COLOR_PATTERN =
  /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*([0-9]*\.?[0-9]+)\s*\)$/iu;
const FONT_FAMILY_PART_PATTERN =
  /^(?:[\p{L}\p{N}][\p{L}\p{N} ._-]*|"[\p{L}\p{N} ._-]+"|'[\p{L}\p{N} ._-]+')$/u;

type PersistedToolStyles = Record<
  PersistedToolStyleTool,
  Readonly<Record<string, unknown>>
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

function colorValue(value: unknown, fallback: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_COLOR_CODE_UNITS
  ) {
    return fallback;
  }
  if (HEX_COLOR_PATTERN.test(value)) return value.toLowerCase();

  const rgb = RGB_COLOR_PATTERN.exec(value);
  if (rgb) {
    const channels = rgb.slice(1).map(Number);
    if (channels.every((channel) => channel <= 255)) {
      return `rgb(${channels.join(",")})`;
    }
  }

  const rgba = RGBA_COLOR_PATTERN.exec(value);
  if (rgba) {
    const channels = rgba.slice(1, 4).map(Number);
    const alpha = Number(rgba[4]);
    if (
      channels.every((channel) => channel <= 255)
      && Number.isFinite(alpha)
      && alpha <= 1
    ) {
      return `rgba(${channels.join(",")},${alpha})`;
    }
  }
  return fallback;
}

function fontFamilyValue(value: unknown, fallback: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_FONT_FAMILY_CODE_UNITS
  ) {
    return fallback;
  }
  const families = value.split(",").map((family) => family.trim());
  if (
    families.length === 0
    || families.length > MAX_FONT_FAMILIES
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
  return ["bold", "italic"]
    .filter((token) => tokens.includes(token))
    .join(" ");
}

function dashValue(value: unknown, fallback: unknown): number[] {
  const normalize = (candidate: unknown): number[] | null => {
    if (
      !Array.isArray(candidate)
      || candidate.length > MAX_DASH_SEGMENTS
      || candidate.some((entry) =>
        typeof entry !== "number"
        || !Number.isFinite(entry)
        || entry < 0
        || entry > MAX_DASH_SEGMENT)
    ) {
      return null;
    }
    if (candidate.length > 0 && !candidate.some((entry) => entry > 0)) {
      return [];
    }
    return [...candidate];
  };
  return normalize(value) ?? normalize(fallback) ?? [];
}

function normalizeStyleValue(
  property: BoardToolStyleKey,
  value: unknown,
  fallback: unknown,
): unknown {
  switch (property) {
    case "stroke":
    case "fill":
      return colorValue(value, String(fallback));
    case "strokeWidth":
      return boundedNumber(
        value,
        Number(fallback),
        MIN_STROKE_WIDTH,
        MAX_STROKE_WIDTH,
      );
    case "opacity":
      return boundedNumber(value, Number(fallback), MIN_OPACITY, MAX_OPACITY);
    case "fontSize":
      return boundedNumber(value, Number(fallback), MIN_FONT_SIZE, MAX_FONT_SIZE);
    case "fontFamily":
      return fontFamilyValue(value, String(fallback));
    case "fontStyle":
      return fontStyleValue(value, String(fallback));
    case "dash":
      return dashValue(value, fallback);
    default:
      return fallback;
  }
}

function normalizeToolStyle(
  tool: PersistedToolStyleTool,
  source: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  const defaults = defaultBoardToolStyle(tool);
  return Object.fromEntries(boardToolStyleKeys(tool).map((property) => [
    property,
    normalizeStyleValue(property, source?.[property], defaults[property]),
  ]));
}

export function defaultToolStylePresets(): PersistedToolStyles {
  return Object.fromEntries(PERSISTED_TOOL_STYLE_TOOLS.map((tool) => [
    tool,
    normalizeToolStyle(tool, defaultBoardToolStyle(tool)),
  ])) as PersistedToolStyles;
}

function normalizeToolStylePresets(styles: BoardToolStyles): PersistedToolStyles {
  return Object.fromEntries(PERSISTED_TOOL_STYLE_TOOLS.map((tool) => [
    tool,
    normalizeToolStyle(tool, styles[tool]),
  ])) as PersistedToolStyles;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length
    && actual.every((key) => expected.includes(key));
}

function parseEnvelope(serialized: string | null): PersistedToolStyles | null {
  if (
    !serialized
    || serialized.length > TOOL_STYLE_PRESETS_MAX_SERIALIZED_LENGTH
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed)
    || !hasExactKeys(parsed, ["version", "styles"])
    || parsed.version !== TOOL_STYLE_PRESETS_STORAGE_VERSION
    || !isRecord(parsed.styles)
    || !hasExactKeys(parsed.styles, PERSISTED_TOOL_STYLE_TOOLS)
  ) {
    return null;
  }

  const styles: Partial<PersistedToolStyles> = {};
  for (const tool of PERSISTED_TOOL_STYLE_TOOLS) {
    const style = parsed.styles[tool];
    const supportedProperties = boardToolStyleKeys(tool);
    if (
      !isRecord(style)
      || Object.keys(style).some((property) =>
        !supportedProperties.includes(property as BoardToolStyleKey))
    ) {
      return null;
    }
    styles[tool] = normalizeToolStyle(tool, style);
  }
  return styles as PersistedToolStyles;
}

export function loadToolStylePresets(
  serialized: string | null,
): PersistedToolStyles {
  return parseEnvelope(serialized) ?? defaultToolStylePresets();
}

export function serializeToolStylePresets(styles: BoardToolStyles): string {
  return JSON.stringify({
    version: TOOL_STYLE_PRESETS_STORAGE_VERSION,
    styles: normalizeToolStylePresets(styles),
  });
}

export function persistToolStylePresets(
  styles: BoardToolStyles,
  storage?: Pick<Storage, "setItem">,
): boolean {
  let target = storage;
  if (!target) {
    if (typeof window === "undefined") return false;
    try {
      target = window.localStorage;
    } catch {
      return false;
    }
  }
  try {
    target.setItem(
      TOOL_STYLE_PRESETS_STORAGE_KEY,
      serializeToolStylePresets(styles),
    );
    return true;
  } catch {
    return false;
  }
}
