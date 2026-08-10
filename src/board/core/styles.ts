import type { BoardObjectKind } from "./schema.js";
import { BUILTIN_OBJECT_KINDS } from "./schema.js";

export const BOARD_STYLE_PROPERTIES = Object.freeze({
  blendMode: "blendMode",
  dash: "dash",
  fill: "fill",
  fontFamily: "fontFamily",
  fontSize: "fontSize",
  fontStyle: "fontStyle",
  opacity: "opacity",
  stroke: "stroke",
  strokeWidth: "strokeWidth",
} as const);

export type BoardStyleProperty =
  (typeof BOARD_STYLE_PROPERTIES)[keyof typeof BOARD_STYLE_PROPERTIES];

export type BuiltInObjectKind =
  (typeof BUILTIN_OBJECT_KINDS)[keyof typeof BUILTIN_OBJECT_KINDS];

export type BoardStyleDefault =
  | boolean
  | number
  | string
  | null
  | readonly number[];

export interface BuiltInStyleContract {
  readonly kind: BuiltInObjectKind;
  readonly version: number;
  readonly capabilities: readonly BoardStyleProperty[];
  readonly defaults: Readonly<
    Partial<Record<BoardStyleProperty, BoardStyleDefault>>
  >;
}

const DEFAULT_STROKE = "#17212b";
const DEFAULT_FILL = "rgba(255,255,255,0)";
const DEFAULT_FONT_FAMILY = "Inter, Arial, sans-serif";

const SHAPE_CAPABILITIES = Object.freeze([
  BOARD_STYLE_PROPERTIES.stroke,
  BOARD_STYLE_PROPERTIES.strokeWidth,
  BOARD_STYLE_PROPERTIES.fill,
  BOARD_STYLE_PROPERTIES.opacity,
  BOARD_STYLE_PROPERTIES.dash,
] as const);

const LINE_CAPABILITIES = Object.freeze([
  BOARD_STYLE_PROPERTIES.stroke,
  BOARD_STYLE_PROPERTIES.strokeWidth,
  BOARD_STYLE_PROPERTIES.opacity,
  BOARD_STYLE_PROPERTIES.dash,
] as const);

function styleDefaults(
  entries: Partial<Record<BoardStyleProperty, BoardStyleDefault>>,
): BuiltInStyleContract["defaults"] {
  for (const value of Object.values(entries)) {
    if (Array.isArray(value)) Object.freeze(value);
  }
  return Object.freeze(entries);
}

function contract(
  kind: BuiltInObjectKind,
  capabilities: readonly BoardStyleProperty[],
  defaults: Partial<Record<BoardStyleProperty, BoardStyleDefault>>,
): BuiltInStyleContract {
  return Object.freeze({
    kind,
    version: 1,
    capabilities,
    defaults: styleDefaults(defaults),
  });
}

function shapeContract(kind: BuiltInObjectKind): BuiltInStyleContract {
  return contract(kind, SHAPE_CAPABILITIES, {
    stroke: DEFAULT_STROKE,
    strokeWidth: 2,
    fill: DEFAULT_FILL,
    opacity: 1,
    dash: [],
  });
}

function lineContract(kind: BuiltInObjectKind): BuiltInStyleContract {
  return contract(kind, LINE_CAPABILITIES, {
    stroke: DEFAULT_STROKE,
    strokeWidth: 2,
    opacity: 1,
    dash: [],
  });
}

export const BUILTIN_STYLE_CONTRACTS: Readonly<
  Record<BuiltInObjectKind, BuiltInStyleContract>
> = Object.freeze({
  [BUILTIN_OBJECT_KINDS.arrow]: lineContract(BUILTIN_OBJECT_KINDS.arrow),
  [BUILTIN_OBJECT_KINDS.code]: contract(
    BUILTIN_OBJECT_KINDS.code,
    Object.freeze([
      BOARD_STYLE_PROPERTIES.fontSize,
      BOARD_STYLE_PROPERTIES.opacity,
    ]),
    {
      fontSize: 14,
      opacity: 1,
    },
  ),
  [BUILTIN_OBJECT_KINDS.diamond]: shapeContract(BUILTIN_OBJECT_KINDS.diamond),
  [BUILTIN_OBJECT_KINDS.ellipse]: shapeContract(BUILTIN_OBJECT_KINDS.ellipse),
  [BUILTIN_OBJECT_KINDS.frame]: contract(
    BUILTIN_OBJECT_KINDS.frame,
    SHAPE_CAPABILITIES,
    {
      stroke: "#8492a6",
      strokeWidth: 1.5,
      fill: DEFAULT_FILL,
      opacity: 1,
      dash: [8, 6],
    },
  ),
  [BUILTIN_OBJECT_KINDS.image]: contract(
    BUILTIN_OBJECT_KINDS.image,
    Object.freeze([BOARD_STYLE_PROPERTIES.opacity]),
    { opacity: 1 },
  ),
  [BUILTIN_OBJECT_KINDS.latex]: contract(
    BUILTIN_OBJECT_KINDS.latex,
    Object.freeze([
      BOARD_STYLE_PROPERTIES.fill,
      BOARD_STYLE_PROPERTIES.fontSize,
      BOARD_STYLE_PROPERTIES.fontStyle,
      BOARD_STYLE_PROPERTIES.opacity,
    ]),
    {
      fill: DEFAULT_STROKE,
      fontSize: 22,
      fontStyle: "normal",
      opacity: 1,
    },
  ),
  [BUILTIN_OBJECT_KINDS.line]: lineContract(BUILTIN_OBJECT_KINDS.line),
  [BUILTIN_OBJECT_KINDS.rectangle]: shapeContract(
    BUILTIN_OBJECT_KINDS.rectangle,
  ),
  [BUILTIN_OBJECT_KINDS.stroke]: contract(
    BUILTIN_OBJECT_KINDS.stroke,
    Object.freeze([
      BOARD_STYLE_PROPERTIES.stroke,
      BOARD_STYLE_PROPERTIES.strokeWidth,
      BOARD_STYLE_PROPERTIES.opacity,
      BOARD_STYLE_PROPERTIES.dash,
      BOARD_STYLE_PROPERTIES.blendMode,
    ]),
    {
      stroke: DEFAULT_STROKE,
      strokeWidth: 2.5,
      opacity: 1,
      dash: [],
      blendMode: "source-over",
    },
  ),
  [BUILTIN_OBJECT_KINDS.text]: contract(
    BUILTIN_OBJECT_KINDS.text,
    Object.freeze([
      BOARD_STYLE_PROPERTIES.fill,
      BOARD_STYLE_PROPERTIES.fontSize,
      BOARD_STYLE_PROPERTIES.fontFamily,
      BOARD_STYLE_PROPERTIES.fontStyle,
      BOARD_STYLE_PROPERTIES.opacity,
    ]),
    {
      fill: DEFAULT_STROKE,
      fontSize: 20,
      fontFamily: DEFAULT_FONT_FAMILY,
      fontStyle: "normal",
      opacity: 1,
    },
  ),
});

export function getBuiltInStyleContract(
  kind: BoardObjectKind,
  version: number,
): BuiltInStyleContract | undefined {
  if (version !== 1) return undefined;
  return BUILTIN_STYLE_CONTRACTS[kind as BuiltInObjectKind];
}

export function supportsObjectStyle(
  kind: BoardObjectKind,
  version: number,
  property: string,
): property is BoardStyleProperty {
  return getBuiltInStyleContract(kind, version)?.capabilities
    .includes(property as BoardStyleProperty) === true;
}

export function resolveObjectStyleDefaults(
  kind: BoardObjectKind,
  version: number,
  style: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...(getBuiltInStyleContract(kind, version)?.defaults ?? {}),
    ...style,
  });
}
