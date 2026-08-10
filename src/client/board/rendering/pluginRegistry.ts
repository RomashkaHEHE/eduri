import { BUILTIN_OBJECT_KINDS } from "../../../board/core";
import { renderedLinePoints, renderedStrokePoints } from "./objectGeometry";
import type {
  BoardObjectRenderingEnvelope,
  BoardObjectSnapshot,
} from "./types";

interface BoardObjectPluginDescriptor {
  readonly kind: string;
  readonly supportedVersion: number;
  readonly inlineEditor: boolean;
  readonly validate?: (object: BoardObjectSnapshot) => boolean;
}

function hasStringProperty(object: BoardObjectSnapshot, property: string): boolean {
  return typeof object.props[property] === "string";
}

const BUILTIN_PLUGINS: readonly BoardObjectPluginDescriptor[] = [
  { kind: BUILTIN_OBJECT_KINDS.rectangle, supportedVersion: 1, inlineEditor: false },
  { kind: BUILTIN_OBJECT_KINDS.ellipse, supportedVersion: 1, inlineEditor: false },
  { kind: BUILTIN_OBJECT_KINDS.diamond, supportedVersion: 1, inlineEditor: false },
  {
    kind: BUILTIN_OBJECT_KINDS.line,
    supportedVersion: 1,
    inlineEditor: false,
    validate: (object) => renderedLinePoints(object) !== null,
  },
  {
    kind: BUILTIN_OBJECT_KINDS.arrow,
    supportedVersion: 1,
    inlineEditor: false,
    validate: (object) => renderedLinePoints(object) !== null,
  },
  {
    kind: BUILTIN_OBJECT_KINDS.stroke,
    supportedVersion: 1,
    inlineEditor: false,
    validate: (object) => renderedStrokePoints(object) !== null,
  },
  {
    kind: BUILTIN_OBJECT_KINDS.text,
    supportedVersion: 1,
    inlineEditor: true,
    validate: (object) => hasStringProperty(object, "text"),
  },
  {
    kind: BUILTIN_OBJECT_KINDS.frame,
    supportedVersion: 1,
    inlineEditor: false,
    validate: (object) =>
      object.props.label === undefined || typeof object.props.label === "string",
  },
  {
    kind: BUILTIN_OBJECT_KINDS.code,
    supportedVersion: 1,
    inlineEditor: true,
    validate: (object) => hasStringProperty(object, "source"),
  },
  {
    kind: BUILTIN_OBJECT_KINDS.latex,
    supportedVersion: 1,
    inlineEditor: true,
    validate: (object) => hasStringProperty(object, "source"),
  },
  { kind: BUILTIN_OBJECT_KINDS.image, supportedVersion: 1, inlineEditor: false },
] as const;

const PLUGINS_BY_KIND = new Map(
  BUILTIN_PLUGINS.map((plugin) => [plugin.kind, plugin] as const),
);

function malformed(detail: string): BoardObjectRenderingEnvelope {
  return { status: "malformed", detail };
}

function hasSafeRendererEnvelope(object: BoardObjectSnapshot): boolean {
  return (
    typeof object.id === "string"
    && object.id.length > 0
    && typeof object.kind === "string"
    && object.kind.length > 0
    && Number.isSafeInteger(object.version)
    && object.version >= 1
    && Array.isArray(object.transform)
    && object.transform.length === 5
    && object.transform.every((component) =>
      typeof component === "number" && Number.isFinite(component))
    && typeof object.zRank === "string"
    && object.zRank.length > 0
    && (object.parentId === null || typeof object.parentId === "string")
    && object.style !== null
    && typeof object.style === "object"
    && !Array.isArray(object.style)
    && object.props !== null
    && typeof object.props === "object"
    && !Array.isArray(object.props)
  );
}

export function inspectBoardObjectRendering(
  object: BoardObjectSnapshot,
): BoardObjectRenderingEnvelope {
  if (object.rendering?.status === "malformed") return object.rendering;
  if (!hasSafeRendererEnvelope(object)) return malformed("Invalid renderer envelope");

  const plugin = PLUGINS_BY_KIND.get(object.kind);
  if (!plugin) return { status: "unknown-kind" };
  if (object.version !== plugin.supportedVersion) {
    return {
      status: "unsupported-version",
      detail: `Supported version is ${plugin.supportedVersion}`,
    };
  }
  if (object.transform[2] <= 0 || object.transform[3] <= 0) {
    return malformed("Object dimensions must be positive");
  }
  if (plugin.validate && !plugin.validate(object)) {
    return malformed("Object properties do not match the plugin schema");
  }
  return { status: "supported" };
}

export function isBoardObjectMutable(object: BoardObjectSnapshot): boolean {
  return inspectBoardObjectRendering(object).status === "supported";
}

export function isBoardObjectInlineEditable(object: BoardObjectSnapshot): boolean {
  if (!isBoardObjectMutable(object)) return false;
  return PLUGINS_BY_KIND.get(object.kind)?.inlineEditor === true;
}
