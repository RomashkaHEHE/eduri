import type { BoardShapeKind, BoardTool } from "./types";

export type BoardToolStyleTarget = BoardTool | BoardShapeKind;

export type BoardToolStyleKey =
  | "stroke"
  | "fill"
  | "strokeWidth"
  | "opacity"
  | "dash"
  | "fontSize"
  | "fontFamily"
  | "fontStyle";

const SHAPE_STYLE_KEYS: readonly BoardToolStyleKey[] = [
  "stroke",
  "fill",
  "strokeWidth",
  "opacity",
  "dash",
];
const LINE_STYLE_KEYS: readonly BoardToolStyleKey[] = [
  "stroke",
  "strokeWidth",
  "opacity",
  "dash",
];
const STROKE_STYLE_KEYS: readonly BoardToolStyleKey[] = [
  "stroke",
  "strokeWidth",
  "opacity",
];
const TEXT_STYLE_KEYS: readonly BoardToolStyleKey[] = [
  "fill",
  "opacity",
  "fontSize",
  "fontFamily",
  "fontStyle",
];

const STYLE_KEYS: Partial<Record<
  BoardToolStyleTarget,
  readonly BoardToolStyleKey[]
>> = {
  pen: STROKE_STYLE_KEYS,
  highlighter: STROKE_STYLE_KEYS,
  text: TEXT_STYLE_KEYS,
  line: LINE_STYLE_KEYS,
  arrow: LINE_STYLE_KEYS,
  rectangle: SHAPE_STYLE_KEYS,
  ellipse: SHAPE_STYLE_KEYS,
  diamond: SHAPE_STYLE_KEYS,
  frame: SHAPE_STYLE_KEYS,
};

const DEFAULTS: Partial<Record<
  BoardToolStyleTarget,
  Readonly<Record<string, unknown>>
>> = {
  pen: {
    stroke: "#17212b",
    strokeWidth: 2.5,
    opacity: 1,
  },
  highlighter: {
    stroke: "#ffd43b",
    strokeWidth: 18,
    opacity: 0.38,
    blendMode: "multiply",
  },
  text: {
    fill: "#17212b",
    fontSize: 20,
    fontFamily: "Inter, Arial, sans-serif",
    fontStyle: "normal",
    opacity: 1,
  },
  line: {
    stroke: "#17212b",
    strokeWidth: 2,
    opacity: 1,
    dash: [],
  },
  arrow: {
    stroke: "#17212b",
    strokeWidth: 2,
    opacity: 1,
    dash: [],
  },
  rectangle: {
    stroke: "#17212b",
    fill: "rgba(255,255,255,0)",
    strokeWidth: 2,
    opacity: 1,
    dash: [],
  },
  ellipse: {
    stroke: "#17212b",
    fill: "rgba(255,255,255,0)",
    strokeWidth: 2,
    opacity: 1,
    dash: [],
  },
  diamond: {
    stroke: "#17212b",
    fill: "rgba(255,255,255,0)",
    strokeWidth: 2,
    opacity: 1,
    dash: [],
  },
  frame: {
    stroke: "#8492a6",
    fill: "rgba(255,255,255,0)",
    strokeWidth: 1.5,
    opacity: 1,
    dash: [8, 6],
  },
};

export function boardToolStyleKeys(
  tool: BoardToolStyleTarget,
): readonly BoardToolStyleKey[] {
  return STYLE_KEYS[tool] ?? [];
}

export function defaultBoardToolStyle(
  tool: BoardToolStyleTarget,
): Readonly<Record<string, unknown>> {
  return { ...(DEFAULTS[tool] ?? {}) };
}
