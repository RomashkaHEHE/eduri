// @vitest-environment jsdom

import Konva from "konva";
import * as Y from "yjs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_OBJECT_KINDS,
  MAX_BOARD_LINE_COORDINATE,
  addBoardObject,
  createLocalCommandOrigin,
  createPageDocument,
  encodeStrokePoints,
  getPageObjects,
  openPageDocument,
  transformObjects,
} from "../../../board/core";
import {
  KonvaBoardRenderer,
  MAX_DECODED_IMAGE_CACHE_ENTRIES,
  MAX_DECODED_IMAGE_CACHE_PIXELS,
  MAX_LOCAL_SELECTION_OUTLINES,
  renderGesturePreviewNode,
  renderObjectNode,
} from "./konvaRenderer";
import {
  ERASER_TRAIL_HEAD_MAX_DIAMETER_PX,
  ERASER_TRAIL_HEAD_MIN_DIAMETER_PX,
  ERASER_TRAIL_MAX_RENDER_STATIONS,
  ERASER_TRAIL_MAX_SAMPLES,
  ERASER_TRAIL_OPACITY,
  ERASER_TRAIL_RENDER_STEP_PX,
  eraserTrailRetractionDistance,
  type EraserTrailRenderStation,
} from "./eraserTrail";
import { boardObjectSnapshot } from "./objectSnapshot";
import {
  isBoardObjectInlineEditable,
  isBoardObjectMutable,
} from "./pluginRegistry";
import { spatialItemForObject } from "./spatialIndex";
import {
  MAX_BOARD_LASER_POINTS,
  MAX_BOARD_LASER_STROKES,
  type BoardLaserStroke,
  type BoardObjectSnapshot,
  type BoardPoint,
  type BoardRendererCallbacks,
  type BoardTheme,
} from "./types";

const PAGE_ID = "00000000-0000-4000-8000-000000000501";
const LINE_ID = "00000000-0000-4000-8000-000000000502";
const ARROW_ID = "00000000-0000-4000-8000-000000000503";
const STROKE_ID = "00000000-0000-4000-8000-000000000504";
const NativeImage = globalThis.Image;

class ControlledImage {
  static instances: ControlledImage[] = [];
  static autoLoad = false;
  static decodedWidth = 1;
  static decodedHeight = 1;

  decoding = "";
  complete = false;
  naturalWidth = ControlledImage.decodedWidth;
  naturalHeight = ControlledImage.decodedHeight;
  onload: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  released = false;
  private source = "";

  constructor() {
    ControlledImage.instances.push(this);
  }

  get src(): string {
    return this.source;
  }

  set src(value: string) {
    this.source = value;
    if (value && ControlledImage.autoLoad) {
      queueMicrotask(() => this.succeed());
    }
  }

  removeAttribute(name: string): void {
    if (name !== "src") return;
    this.source = "";
    this.released = true;
  }

  succeed(): void {
    if (this.complete || !this.source) return;
    this.complete = true;
    this.onload?.(new Event("load"));
  }

  fail(): void {
    if (!this.source) return;
    this.onerror?.(new Event("error"));
  }

  static install(options: {
    readonly autoLoad?: boolean;
    readonly width?: number;
    readonly height?: number;
  } = {}): void {
    ControlledImage.instances = [];
    ControlledImage.autoLoad = options.autoLoad ?? false;
    ControlledImage.decodedWidth = options.width ?? 1;
    ControlledImage.decodedHeight = options.height ?? 1;
    Object.defineProperty(globalThis, "Image", {
      configurable: true,
      writable: true,
      value: ControlledImage,
    });
  }
}

async function flushImageTasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

beforeAll(() => {
  const pixels = new Uint8ClampedArray(10 * 10 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 40;
    pixels[index + 1] = 40;
    pixels[index + 2] = 40;
    pixels[index + 3] = 255;
  }
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function getContext(
    this: HTMLCanvasElement,
  ) {
    const context = {
      canvas: this,
      font: "",
      getImageData: () => ({ data: pixels }),
      measureText: (text: string) => ({
        actualBoundingBoxAscent: 10,
        actualBoundingBoxDescent: 3,
        width: text.length * 7,
      }),
    };
    return new Proxy(context, {
      get(target, property) {
        if (property in target) return target[property as keyof typeof target];
        return () => undefined;
      },
      set(target, property, value) {
        Reflect.set(target, property, value);
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
  });
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
});

afterEach(() => {
  document.body.replaceChildren();
  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    writable: true,
    value: NativeImage,
  });
});

function snapshot(
  overrides: Partial<BoardObjectSnapshot> = {},
): BoardObjectSnapshot {
  return {
    id: "object",
    kind: BUILTIN_OBJECT_KINDS.text,
    version: 1,
    transform: [10, 20, 200, 80, 0],
    zRank: "a",
    parentId: null,
    style: {},
    props: { text: "editable" },
    ...overrides,
  };
}

function imageSnapshot(
  id: string,
  contentHash: string,
  transform: BoardObjectSnapshot["transform"] = [10, 20, 120, 80, 0],
): BoardObjectSnapshot {
  return snapshot({
    id,
    kind: BUILTIN_OBJECT_KINDS.image,
    transform,
    props: {
      assetId: `asset-${id}`,
      contentHash,
    },
  });
}

function renderedImage(group: Konva.Group | undefined): Konva.Image | undefined {
  return group?.getChildren().find((child) => child instanceof Konva.Image) as
    | Konva.Image
    | undefined;
}

function renderedPoints(object: BoardObjectSnapshot): number[] {
  const group = renderObjectNode(object, undefined, () => undefined);
  const child = group.getChildren()[0];
  const points = (child as unknown as {
    getAttr(name: string): unknown;
  }).getAttr("points");
  if (!Array.isArray(points)) throw new Error("Expected a Konva point shape");
  return points as number[];
}

interface SelectionOutlineBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function selectionOutlineBounds(node: Konva.Group): SelectionOutlineBounds {
  return node.getClientRect({
    skipTransform: true,
    skipShadow: true,
  });
}

function expectedSelectionOutlinePoints(
  node: Konva.Group,
  bounds: SelectionOutlineBounds = selectionOutlineBounds(node),
): number[] {
  const transform = new Konva.Transform();
  transform.translate(node.x(), node.y());
  transform.rotate(Konva.getAngle(node.rotation()));
  transform.skew(node.skewX(), node.skewY());
  transform.scale(node.scaleX(), node.scaleY());
  transform.translate(-node.offsetX(), -node.offsetY());
  return [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ].flatMap((corner) => {
    const point = transform.point(corner);
    return [point.x, point.y];
  });
}

interface RendererInternals {
  readonly stage: Konva.Stage;
  readonly gridLayer: Konva.Layer;
  readonly previewLayer: Konva.Layer;
  readonly nodes: Map<string, Konva.Group>;
  readonly objectWorld: Konva.Group;
  readonly interactionScreen: Konva.Group;
  readonly spatial: { search(bounds: unknown): string[] };
  readonly eraserHits: { search(sweep: unknown): unknown[] };
  readonly transformer: Konva.Transformer;
  readonly selectionOutline: Konva.Rect;
  readonly selectionObjectOutlines: Map<string, Konva.Line>;
  readonly dragVisibleIds: readonly string[];
  readonly decodedImages: {
    readonly entries: Map<string, { readonly references: number }>;
    readonly totalPixels: number;
  } | null;
  readonly presenceWorld: Konva.Group;
  readonly presenceRenderEntries: Map<number, {
    readonly cursor: Konva.Group | null;
    readonly gesturePreview: Konva.Shape | null;
    readonly laser: Konva.Group | null;
    readonly selections: Map<string, Konva.Rect>;
  }>;
  readonly remoteLaserTrails: Map<number, {
    readonly strokes: readonly BoardLaserStroke[];
    readonly expiresAt: number;
    readonly active: boolean;
  }>;
  readonly laserSession: {
    readonly group: Konva.Group;
    readonly strokes: readonly {
      readonly points: readonly BoardPoint[];
      readonly preview: Konva.Line;
    }[];
    readonly releaseRequested: boolean;
  } | null;
  readonly presenceAnimationFrame: number | null;
  readonly activeMousePointerId: number | null;
  readonly pressedPointerIds: ReadonlySet<number>;
  readonly activeGesture: {
    readonly kind: string;
    readonly preview?: Konva.Shape;
    readonly trail?: Konva.Group;
    readonly trailBody?: Konva.Shape;
    readonly trailFootprint?: Konva.Circle;
    readonly trailSamples?: readonly {
      readonly x: number;
      readonly y: number;
      readonly at: number;
      readonly smoothedSpeed: number;
    }[];
    readonly trailAnimationFrame?: number | null;
    readonly points?: readonly (BoardPoint & { readonly pressure: number })[];
    readonly tool?: string;
    readonly previewAwarenessPoints?: readonly BoardPoint[];
    readonly previewPoints?: readonly number[];
    readonly style?: Readonly<Record<string, unknown>>;
    readonly strokeOffset?: BoardPoint;
    readonly straightPointActive?: boolean;
    readonly strokeMoveActive?: boolean;
    readonly end?: BoardPoint;
    readonly offset?: BoardPoint;
    readonly commandMoveArmed?: boolean;
    readonly commandMoveActive?: boolean;
    readonly previewSelectionIds?: readonly string[];
    readonly membershipAnimationFrame?: number | null;
  } | null;
  onPointerDown(event: Konva.KonvaEventObject<PointerEvent>): void;
  onPointerMove(event: Konva.KonvaEventObject<PointerEvent>): void;
  onPointerUp(event: Konva.KonvaEventObject<PointerEvent>): void;
  onContextMenu(event: Konva.KonvaEventObject<PointerEvent>): void;
  onWheel(event: Konva.KonvaEventObject<WheelEvent>): void;
  lostPointerCapture(event: PointerEvent): void;
}

function callbackSpies(): BoardRendererCallbacks {
  return {
    onCameraChange: vi.fn(),
    onCursorChange: vi.fn(),
    onSelectionChange: vi.fn(),
    onContextMenu: vi.fn(),
    onCreateObject: vi.fn(),
    onPlaceTool: vi.fn(),
    onDeleteObjects: vi.fn(),
    onTransformStart: vi.fn(),
    onTransformCancel: vi.fn(),
    onTransformObjects: vi.fn(),
    onEditObject: vi.fn(),
    onLaserChange: vi.fn(),
    onPenLaserModeChange: vi.fn(),
    onGesturePreviewChange: vi.fn(),
  };
}

function rendererHarness(options: {
  readonly theme?: BoardTheme;
  readonly gridVisible?: boolean;
  readonly resolveAssetUrl?: (
    assetId: string,
    contentHash: string | null,
  ) => string | null | Promise<string | null>;
} = {}): {
  readonly callbacks: BoardRendererCallbacks;
  readonly renderer: KonvaBoardRenderer;
  readonly internals: RendererInternals;
  readonly root: HTMLElement;
} {
  const root = document.createElement("section");
  root.className = "board-v2";
  root.tabIndex = -1;
  const element = document.createElement("div");
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 600 },
  });
  element.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    top: 0,
    right: 800,
    bottom: 600,
    left: 0,
    toJSON: () => ({}),
  });
  root.append(element);
  document.body.append(root);
  const callbacks = callbackSpies();
  const renderer = new KonvaBoardRenderer(element, callbacks, options);
  renderer.setCamera({ x: 0, y: 0, zoom: 1 });
  return {
    callbacks,
    renderer,
    internals: renderer as unknown as RendererInternals,
    root,
  };
}

function pointerEvent(
  pointerId: number,
  x: number,
  y: number,
  overrides: Partial<PointerEvent> = {},
): PointerEvent {
  return {
    pointerId,
    pointerType: "mouse",
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    pressure: 0.5,
    preventDefault: vi.fn(),
    getCoalescedEvents: undefined,
    target: null,
    type: "pointermove",
    ...overrides,
  } as unknown as PointerEvent;
}

function animationFrameController() {
  let nextFrame = 1;
  const scheduled = new Map<number, FrameRequestCallback>();
  const request = vi.spyOn(globalThis, "requestAnimationFrame")
    .mockImplementation((callback) => {
      const frame = nextFrame;
      nextFrame += 1;
      scheduled.set(frame, callback);
      return frame;
    });
  const cancel = vi.spyOn(globalThis, "cancelAnimationFrame")
    .mockImplementation((frame) => {
      scheduled.delete(frame);
    });
  return {
    cancel,
    request,
    run(frame: number | null | undefined) {
      if (frame === null || frame === undefined) {
        throw new Error("selection membership frame was not scheduled");
      }
      const callback = scheduled.get(frame);
      if (!callback) throw new Error(`animation frame ${frame} is missing`);
      scheduled.delete(frame);
      callback(performance.now());
    },
    restore() {
      scheduled.clear();
      request.mockRestore();
      cancel.mockRestore();
    },
  };
}

function konvaPointerEvent(
  internals: RendererInternals,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  nativeEvent: PointerEvent,
  target: Konva.Node = internals.stage,
): Konva.KonvaEventObject<PointerEvent> {
  return {
    cancelBubble: false,
    currentTarget: internals.stage,
    evt: nativeEvent,
    pointerId: nativeEvent.pointerId,
    target,
    type,
  } as unknown as Konva.KonvaEventObject<PointerEvent>;
}

function retainLaserStroke(
  internals: RendererInternals,
  pointerId: number,
  start: BoardPoint,
  end: BoardPoint,
): void {
  internals.onPointerDown(konvaPointerEvent(
    internals,
    "pointerdown",
    pointerEvent(pointerId, start.x, start.y, {
      altKey: true,
      type: "pointerdown",
    }),
  ));
  internals.onPointerMove(konvaPointerEvent(
    internals,
    "pointermove",
    pointerEvent(pointerId, end.x, end.y, { altKey: true }),
  ));
  internals.onPointerUp(konvaPointerEvent(
    internals,
    "pointerup",
    pointerEvent(pointerId, end.x, end.y, {
      buttons: 0,
      altKey: true,
      type: "pointerup",
    }),
  ));
}

function beginTransformerRotation(
  internals: RendererInternals,
  center: BoardPoint,
): {
  moveTo(angleDegrees: number, shiftKey: boolean): void;
  end(shiftKey?: boolean): void;
} {
  const rotater = internals.transformer.findOne<Konva.Rect>(".rotater");
  if (!rotater) throw new Error("Expected the Transformer rotation handle");
  const start = rotater.getAbsolutePosition();
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  const startEvent = new MouseEvent("mousedown", {
    bubbles: true,
    buttons: 1,
    clientX: start.x,
    clientY: start.y,
  });
  internals.stage.setPointersPositions(startEvent);
  rotater.fire("mousedown", { evt: startEvent });

  let last = start;
  return {
    moveTo(angleDegrees, shiftKey) {
      const radians = angleDegrees * Math.PI / 180;
      last = {
        x: center.x + Math.sin(radians) * radius,
        y: center.y - Math.cos(radians) * radius,
      };
      window.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        buttons: 1,
        clientX: last.x,
        clientY: last.y,
        shiftKey,
      }));
    },
    end(shiftKey = false) {
      window.dispatchEvent(new MouseEvent("mouseup", {
        bubbles: true,
        buttons: 0,
        clientX: last.x,
        clientY: last.y,
        shiftKey,
      }));
    },
  };
}

function konvaWheelEvent(
  internals: RendererInternals,
  nativeEvent: WheelEvent,
): Konva.KonvaEventObject<WheelEvent> {
  return {
    cancelBubble: false,
    currentTarget: internals.stage,
    evt: nativeEvent,
    target: internals.stage,
    type: "wheel",
  } as unknown as Konva.KonvaEventObject<WheelEvent>;
}

function konvaContextMenuEvent(
  internals: RendererInternals,
  nativeEvent: PointerEvent,
  target: Konva.Node = internals.stage,
): Konva.KonvaEventObject<PointerEvent> {
  return {
    cancelBubble: false,
    currentTarget: internals.stage,
    evt: nativeEvent,
    pointerId: nativeEvent.pointerId,
    target,
    type: "contextmenu",
  } as unknown as Konva.KonvaEventObject<PointerEvent>;
}

function renderGrid(internals: RendererInternals): {
  readonly fillRect: ReturnType<typeof vi.fn>;
  readonly stroke: ReturnType<typeof vi.fn>;
} {
  const fillRect = vi.fn();
  const stroke = vi.fn();
  const context = new Proxy({
    fillRect,
    stroke,
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => undefined;
    },
    set(target, property, value) {
      Reflect.set(target, property, value);
      return true;
    },
  });
  const shape = internals.gridLayer.getChildren()[0] as Konva.Shape;
  shape.sceneFunc()?.(
    context as unknown as Konva.Context,
    shape,
  );
  return { fillRect, stroke };
}

function renderEraserTrail(body: Konva.Shape): {
  readonly beginPath: ReturnType<typeof vi.fn>;
  readonly moveTo: ReturnType<typeof vi.fn>;
  readonly lineTo: ReturnType<typeof vi.fn>;
  readonly closePath: ReturnType<typeof vi.fn>;
  readonly arc: ReturnType<typeof vi.fn>;
  readonly fillShape: ReturnType<typeof vi.fn>;
} {
  const beginPath = vi.fn();
  const moveTo = vi.fn();
  const lineTo = vi.fn();
  const closePath = vi.fn();
  const arc = vi.fn();
  const fillShape = vi.fn();
  const context = new Proxy({
    beginPath,
    moveTo,
    lineTo,
    closePath,
    arc,
    fillShape,
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => undefined;
    },
  });
  body.sceneFunc()?.(
    context as unknown as Konva.Context,
    body,
  );
  return { beginPath, moveTo, lineTo, closePath, arc, fillShape };
}

describe("Konva board object compatibility", () => {
  it("orders layers by the normative code-unit comparator, not host locale", () => {
    const { renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "front-lowercase",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        zRank: "a0",
        props: {},
      }),
      snapshot({
        id: "back-uppercase",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        zRank: "Zz",
        props: {},
      }),
    ]);

    expect(internals.objectWorld.getChildren().map((node) =>
      (node as { getAttr(name: string): unknown })
        .getAttr("boardObjectId"))).toEqual([
      "back-uppercase",
      "front-lowercase",
    ]);
    renderer.destroy();
  });

  it("applies the built-in style contract to actual Konva nodes", () => {
    const arrow = renderObjectNode(snapshot({
      kind: BUILTIN_OBJECT_KINDS.arrow,
      props: { start: [0, 0], end: [200, 80] },
      style: {
        stroke: "#d33f49",
        strokeWidth: 4,
        opacity: 0.4,
        dash: [8, 6],
      },
    }), undefined, () => undefined);
    const arrowNode = arrow.getChildren()[0] as Konva.Arrow;
    expect(arrow.opacity()).toBe(0.4);
    expect(arrowNode.stroke()).toBe("#d33f49");
    expect(arrowNode.strokeWidth()).toBe(4);
    expect(arrowNode.dash()).toEqual([8, 6]);

    const text = renderObjectNode(snapshot({
      style: {
        fill: "#16825d",
        fontSize: 32,
        fontStyle: "bold italic",
        opacity: 0.7,
      },
    }), undefined, () => undefined);
    const textNode = text.getChildren()[0] as Konva.Text;
    expect(text.opacity()).toBe(0.7);
    expect(textNode.fill()).toBe("#16825d");
    expect(textNode.fontSize()).toBe(32);
    expect(textNode.fontStyle()).toBe("bold italic");
    expect(textNode.name()).toBe("board-inline-text-glyphs");
    expect(textNode.padding()).toBe(2);
    expect(textNode.lineHeight()).toBe(1.25);
    expect(textNode.wrap()).toBe("word");
    expect(textNode.verticalAlign()).toBe("middle");

    const image = renderObjectNode(snapshot({
      id: "styled-image",
      kind: BUILTIN_OBJECT_KINDS.image,
      style: { opacity: 0 },
      props: { assetId: "styled-image", contentHash: "b".repeat(64) },
    }), undefined, () => undefined);
    expect(image.opacity()).toBe(0);

    const hostileOpacity = renderObjectNode(snapshot({
      id: "hostile-opacity",
      kind: BUILTIN_OBJECT_KINDS.image,
      style: { opacity: -1 },
      props: { assetId: "hostile-opacity", contentHash: "c".repeat(64) },
    }), undefined, () => undefined);
    expect(hostileOpacity.opacity()).toBe(0);
    hostileOpacity.destroy();
    image.destroy();
    text.destroy();
    arrow.destroy();
  });

  it("suppresses only the canvas glyphs while plain text is edited inline", () => {
    const { renderer, internals } = rendererHarness();
    const textObject = snapshot({
      id: "inline-text",
      style: { opacity: 0.4 },
      props: { text: "first" },
    });
    const rectangle = snapshot({
      id: "unrelated-rectangle",
      kind: BUILTIN_OBJECT_KINDS.rectangle,
      props: {},
    });
    const glyphs = () => internals.nodes.get("inline-text")
      ?.findOne<Konva.Text>(".board-inline-text-glyphs");

    renderer.setObjects([textObject, rectangle]);
    renderer.setSelection(["inline-text"]);
    renderer.setInlineEditingObject("inline-text");
    expect(glyphs()?.opacity()).toBe(0);
    expect(internals.nodes.get("inline-text")?.opacity()).toBe(0.4);
    expect(internals.nodes.get("unrelated-rectangle")?.visible()).toBe(true);
    expect(internals.transformer.nodes()).toEqual([]);

    const remoteEdit = snapshot({
      ...textObject,
      props: { text: "remote replacement" },
    });
    renderer.setObject(remoteEdit);
    expect(glyphs()?.opacity()).toBe(0);
    expect(internals.nodes.get("inline-text")?.opacity()).toBe(0.4);

    renderer.setTheme("dark");
    expect(glyphs()?.opacity()).toBe(0);
    renderer.setObjects([remoteEdit, rectangle]);
    expect(glyphs()?.opacity()).toBe(0);

    renderer.setCamera({ x: -20_000, y: 0, zoom: 1 });
    expect(internals.nodes.has("inline-text")).toBe(false);
    renderer.setCamera({ x: 0, y: 0, zoom: 1 });
    expect(glyphs()?.opacity()).toBe(0);

    renderer.setInlineEditingObject(null);
    expect(glyphs()?.opacity()).toBe(1);
    expect(internals.nodes.get("inline-text")?.opacity()).toBe(0.4);
    renderer.destroy();
  });

  it("bounds hostile style values before they reach Konva", () => {
    const hostileDash = [
      Number.POSITIVE_INFINITY,
      -1,
      Number.MAX_VALUE,
      ...Array.from({ length: 64 }, () => 32),
    ];
    const arrow = renderObjectNode(snapshot({
      kind: BUILTIN_OBJECT_KINDS.arrow,
      props: { start: [0, 0], end: [200, 80] },
      style: {
        stroke: "rgba(255,0,0,1) trailing",
        dash: hostileDash,
      },
    }), undefined, () => undefined);
    const arrowNode = arrow.getChildren()[0] as Konva.Arrow;
    expect(arrowNode.stroke()).toBe("#17212b");
    expect(arrowNode.dash().length).toBeLessThanOrEqual(8);
    expect(arrowNode.dash().every((segment) =>
      Number.isFinite(segment) && segment >= 0 && segment <= 256)).toBe(true);
    expect(hostileDash[0]).toBe(Number.POSITIVE_INFINITY);
    expect(hostileDash).toHaveLength(67);

    const text = renderObjectNode(snapshot({
      style: {
        fill: "#12345",
        fontSize: Number.MAX_VALUE,
        fontFamily: "A".repeat(10_000),
        fontStyle: "bold ".repeat(1_000),
      },
    }), undefined, () => undefined);
    const textNode = text.getChildren()[0] as Konva.Text;
    expect(textNode.fill()).toBe("#17212b");
    expect(textNode.fontSize()).toBe(256);
    expect(textNode.fontFamily()).toBe("Inter, Arial, sans-serif");
    expect(textNode.fontStyle()).toBe("normal");

    const code = renderObjectNode(snapshot({
      kind: BUILTIN_OBJECT_KINDS.code,
      props: { source: "", language: "javascript" },
      style: { fontSize: Number.MAX_VALUE },
    }), undefined, () => undefined);
    expect((code.getChildren()[2] as Konva.Text).fontSize()).toBe(256);

    const latex = renderObjectNode(snapshot({
      kind: BUILTIN_OBJECT_KINDS.latex,
      props: { source: "" },
      style: {
        fontSize: Number.MAX_VALUE,
        fontStyle: "italic; font-size: 999999px",
      },
    }), undefined, () => undefined);
    const latexText = latex.getChildren()[1] as Konva.Text;
    expect(latexText.fontSize()).toBe(256);
    expect(latexText.fontStyle()).toBe("normal");

    latex.destroy();
    code.destroy();
    text.destroy();
    arrow.destroy();
  });

  it("bounds static text previews without truncating canonical props", () => {
    const longText = "x".repeat(20_000);
    const longLanguage = "lang".repeat(1_000);
    const expectBounded = (value: string, maximum: number) => {
      expect(value.length).toBeLessThanOrEqual(maximum + 1);
      expect(value.endsWith("\u2026")).toBe(true);
    };

    const textObject = snapshot({ props: { text: longText } });
    const text = renderObjectNode(textObject, undefined, () => undefined);
    expectBounded((text.getChildren()[0] as Konva.Text).text(), 4_096);
    expect(textObject.props.text).toBe(longText);

    const codeObject = snapshot({
      kind: BUILTIN_OBJECT_KINDS.code,
      props: { source: longText, language: longLanguage },
    });
    const code = renderObjectNode(codeObject, undefined, () => undefined);
    expectBounded((code.getChildren()[1] as Konva.Text).text(), 128);
    expectBounded((code.getChildren()[2] as Konva.Text).text(), 4_096);
    expect(codeObject.props.source).toBe(longText);
    expect(codeObject.props.language).toBe(longLanguage);

    const latexObject = snapshot({
      kind: BUILTIN_OBJECT_KINDS.latex,
      props: { source: longText },
    });
    const latex = renderObjectNode(latexObject, undefined, () => undefined);
    expectBounded((latex.getChildren()[1] as Konva.Text).text(), 4_096);
    expect(latexObject.props.source).toBe(longText);

    const frameObject = snapshot({
      kind: BUILTIN_OBJECT_KINDS.frame,
      props: { label: longText },
    });
    const frame = renderObjectNode(frameObject, undefined, () => undefined);
    expectBounded((frame.getChildren()[1] as Konva.Label).getText().text(), 128);
    expect(frameObject.props.label).toBe(longText);

    frame.destroy();
    latex.destroy();
    code.destroy();
    text.destroy();
  });

  it("uses a placeholder and disables mutation for known future versions", () => {
    const future = snapshot({
      version: 2,
      props: { text: { versionTwoRuns: "different code" } },
    });

    const node = renderObjectNode(future, undefined, () => undefined);

    expect(node.getAttr("boardObjectRendering")).toBe("unsupported-version");
    expect(node.getChildren().map((child) => child.getClassName())).toEqual(["Rect", "Text"]);
    expect(isBoardObjectMutable(future)).toBe(false);
    expect(isBoardObjectInlineEditable(future)).toBe(false);
  });

  it("contains malformed objects without affecting a valid neighbor", () => {
    const malformed = snapshot({
      props: null as unknown as Readonly<Record<string, unknown>>,
      rendering: { status: "malformed", detail: "broken props" },
    });
    const valid = snapshot({ id: "valid" });

    const malformedNode = renderObjectNode(malformed, undefined, () => undefined);
    const validNode = renderObjectNode(valid, undefined, () => undefined);

    expect(malformedNode.getAttr("boardObjectRendering")).toBe("malformed");
    expect(malformedNode.getChildren().map((child) => child.getClassName())).toEqual(["Rect", "Text"]);
    expect(validNode.getAttr("boardObjectRendering")).toBe("supported");
    expect(validNode.getChildren().map((child) => child.getClassName())).toEqual(["Text"]);
  });

  it("fails malformed and unbounded optional line controls closed", () => {
    for (const props of [
      { start: [0, 0], end: [100, 100], control: [50] },
      { start: [0, 0], end: [100, 100], control: [50, 50, 50] },
      { start: [0, 0], end: [100, 100], control: [50, Number.NaN] },
      {
        start: [0, 0],
        end: [100, 100],
        control: [MAX_BOARD_LINE_COORDINATE + 1, 50],
      },
    ]) {
      const malformed = snapshot({
        kind: BUILTIN_OBJECT_KINDS.line,
        props,
      });
      expect(isBoardObjectMutable(malformed)).toBe(false);
      const node = renderObjectNode(malformed, undefined, () => undefined);
      expect(node.getAttr("boardObjectRendering")).toBe("malformed");
      expect(node.getChildren().map((child) => child.getClassName()))
        .toEqual(["Rect", "Text"]);
      node.destroy();
    }
  });

  it("switches canvas chrome and only remaps the canonical default ink in dark mode", () => {
    const { renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "default-ink",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        props: {},
      }),
      snapshot({
        id: "custom-ink",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [240, 20, 200, 80, 0],
        style: { stroke: "#d33f49" },
        props: {},
      }),
    ]);

    renderer.setTheme("dark");

    expect((internals.nodes.get("default-ink")!.getChildren()[0] as Konva.Rect).stroke())
      .toBe("#e7edf5");
    expect((internals.nodes.get("custom-ink")!.getChildren()[0] as Konva.Rect).stroke())
      .toBe("#d33f49");
    expect(internals.transformer.borderStroke()).toBe("#86a7e8");
    expect(internals.transformer.anchorFill()).toBe("#151614");

    renderer.setTheme("light");
    expect((internals.nodes.get("default-ink")!.getChildren()[0] as Konva.Rect).stroke())
      .toBe("#17212b");
    expect(internals.transformer.borderStroke()).toBe("#315efb");
    renderer.destroy();
  });
});

describe("Konva decoded image cache", () => {
  it("reuses a decoded image across viewport culling and keys entries by content hash", async () => {
    ControlledImage.install();
    const resolveAssetUrl = vi.fn((assetId: string, contentHash: string | null) =>
      `blob:${assetId}:${contentHash}`);
    const { renderer, internals } = rendererHarness({ resolveAssetUrl });
    const original = imageSnapshot("shared-image", "hash-a");

    renderer.setObjects([original]);
    await flushImageTasks();
    expect(ControlledImage.instances).toHaveLength(1);
    ControlledImage.instances[0].succeed();
    await flushImageTasks();
    expect(renderedImage(internals.nodes.get(original.id))?.image())
      .toBe(ControlledImage.instances[0]);

    renderer.setCamera({ x: -5_000, y: -5_000, zoom: 1 });
    expect(internals.nodes.has(original.id)).toBe(false);
    renderer.setCamera({ x: 0, y: 0, zoom: 1 });
    await flushImageTasks();

    expect(ControlledImage.instances).toHaveLength(1);
    expect(renderedImage(internals.nodes.get(original.id))?.image())
      .toBe(ControlledImage.instances[0]);

    const replaced = imageSnapshot("shared-image", "hash-b");
    renderer.setObject(replaced);
    await flushImageTasks();
    expect(ControlledImage.instances).toHaveLength(2);
    ControlledImage.instances[1].succeed();
    await flushImageTasks();
    expect(renderedImage(internals.nodes.get(replaced.id))?.image())
      .toBe(ControlledImage.instances[1]);
    expect(resolveAssetUrl).toHaveBeenLastCalledWith("asset-shared-image", "hash-b");

    renderer.destroy();
    expect(ControlledImage.instances.every((image) => image.released)).toBe(true);
  });

  it("retries a temporarily unavailable asset when its object is refreshed", async () => {
    ControlledImage.install();
    const resolveAssetUrl = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("blob:ready");
    const { renderer, internals } = rendererHarness({ resolveAssetUrl });
    const object = imageSnapshot("refresh-image", "same-hash");
    const sibling = {
      ...object,
      id: "refresh-image-sibling",
    };

    renderer.setObjects([object, sibling]);
    await flushImageTasks();
    expect(ControlledImage.instances).toHaveLength(0);
    expect(renderedImage(internals.nodes.get(object.id))).toBeUndefined();

    renderer.setObject(object);
    await flushImageTasks();
    expect(resolveAssetUrl).toHaveBeenCalledTimes(2);
    expect(ControlledImage.instances).toHaveLength(1);
    ControlledImage.instances[0].succeed();
    await flushImageTasks();
    expect(renderedImage(internals.nodes.get(object.id))).toBeDefined();
    expect(renderedImage(internals.nodes.get(sibling.id))).toBeDefined();
    renderer.destroy();
  });

  it("ignores stale asynchronous loads and cancels unresolved work on destroy", async () => {
    ControlledImage.install();
    const pending = new Map<string, (url: string | null) => void>();
    const resolveAssetUrl = vi.fn((_assetId: string, contentHash: string | null) =>
      new Promise<string | null>((resolve) => {
        pending.set(contentHash ?? "", resolve);
      }));
    const { renderer, internals } = rendererHarness({ resolveAssetUrl });

    renderer.setObjects([imageSnapshot("racing-image", "old")]);
    await flushImageTasks();
    renderer.setObject(imageSnapshot("racing-image", "current"));
    await flushImageTasks();

    pending.get("old")?.("blob:old");
    await flushImageTasks();
    ControlledImage.instances[0].succeed();
    await flushImageTasks();
    expect(renderedImage(internals.nodes.get("racing-image"))).toBeUndefined();

    pending.get("current")?.("blob:current");
    await flushImageTasks();
    ControlledImage.instances[1].succeed();
    await flushImageTasks();
    expect(renderedImage(internals.nodes.get("racing-image"))?.image())
      .toBe(ControlledImage.instances[1]);

    renderer.setObject(imageSnapshot("racing-image", "after-destroy"));
    await flushImageTasks();
    renderer.destroy();
    pending.get("after-destroy")?.("blob:too-late");
    await flushImageTasks();

    expect(ControlledImage.instances).toHaveLength(2);
    expect(ControlledImage.instances.every((image) => image.released)).toBe(true);
  });

  it("keeps referenced images and trims released entries by count and decoded pixels", async () => {
    ControlledImage.install({ autoLoad: true });
    const entryCount = MAX_DECODED_IMAGE_CACHE_ENTRIES + 2;
    const entryObjects = Array.from({ length: entryCount }, (_, index) =>
      imageSnapshot(`entry-${index}`, `hash-${index}`, [0, 0, 20, 20, 0]));
    const first = rendererHarness({
      resolveAssetUrl: (assetId) => `blob:${assetId}`,
    });
    first.renderer.setObjects(entryObjects);
    await flushImageTasks();

    expect(first.internals.decodedImages?.entries.size).toBe(entryCount);
    expect([...first.internals.decodedImages!.entries.values()]
      .every((entry) => entry.references === 1)).toBe(true);
    expect(ControlledImage.instances.some((image) => image.released)).toBe(false);

    first.renderer.setCamera({ x: -5_000, y: -5_000, zoom: 1 });
    expect(first.internals.decodedImages!.entries.size)
      .toBeLessThanOrEqual(MAX_DECODED_IMAGE_CACHE_ENTRIES);
    expect(ControlledImage.instances.filter((image) => image.released).length)
      .toBeGreaterThanOrEqual(2);
    first.renderer.destroy();
    expect(ControlledImage.instances.every((image) => image.released)).toBe(true);

    const decodedPixels = 4_000_000;
    ControlledImage.install({ autoLoad: true, width: 2_000, height: 2_000 });
    const pixelEntryCount = Math.floor(
      MAX_DECODED_IMAGE_CACHE_PIXELS / decodedPixels,
    ) + 1;
    const second = rendererHarness({
      resolveAssetUrl: (assetId) => `blob:${assetId}`,
    });
    second.renderer.setObjects(Array.from({ length: pixelEntryCount }, (_, index) =>
      imageSnapshot(`pixel-${index}`, `hash-${index}`, [0, 0, 20, 20, 0])));
    await flushImageTasks();

    expect(second.internals.decodedImages!.totalPixels)
      .toBeGreaterThan(MAX_DECODED_IMAGE_CACHE_PIXELS);
    second.renderer.setCamera({ x: -5_000, y: -5_000, zoom: 1 });
    expect(second.internals.decodedImages!.totalPixels)
      .toBeLessThanOrEqual(MAX_DECODED_IMAGE_CACHE_PIXELS);
    second.renderer.destroy();
    expect(ControlledImage.instances.every((image) => image.released)).toBe(true);
  });
});

describe("Konva intrinsic geometry", () => {
  it("renders quadratic line and arrow props as equivalent cubic paths", () => {
    const line = renderObjectNode(snapshot({
      kind: BUILTIN_OBJECT_KINDS.line,
      transform: [0, 0, 90, 60, 0],
      props: {
        start: [0, 0],
        control: [30, 60],
        end: [90, 0],
      },
    }), undefined, () => undefined);
    const lineNode = line.getChildren()[0] as Konva.Line;
    expect(lineNode.bezier()).toBe(true);
    expect(lineNode.points()).toEqual([0, 0, 20, 40, 50, 40, 90, 0]);

    const arrow = renderObjectNode(snapshot({
      kind: BUILTIN_OBJECT_KINDS.arrow,
      transform: [0, 0, 90, 60, 0],
      props: {
        start: [0, 0],
        control: [30, 60],
        end: [90, 0],
      },
    }), undefined, () => undefined);
    const arrowNode = arrow.getChildren()[0] as Konva.Arrow;
    expect(arrowNode.bezier()).toBe(true);
    expect(arrowNode.points()).toEqual(lineNode.points());

    const straight = renderObjectNode(snapshot({
      kind: BUILTIN_OBJECT_KINDS.line,
      transform: [0, 0, 90, 1, 0],
      props: { start: [0, 0], end: [90, 0] },
    }), undefined, () => undefined);
    expect((straight.getChildren()[0] as Konva.Line).bezier()).toBe(false);

    line.destroy();
    arrow.destroy();
    straight.destroy();
  });

  it("keeps line, arrow, and stroke transforms after a multi-object CRDT reload", () => {
    const document = createPageDocument(PAGE_ID);
    const origin = createLocalCommandOrigin("geometry-reload");
    addBoardObject(document, {
      id: LINE_ID,
      kind: BUILTIN_OBJECT_KINDS.line,
      version: 1,
      transform: [0, 0, 100, 40, 0],
      zRank: "a",
      props: { start: [0, 40], end: [100, 0] },
    }, origin);
    addBoardObject(document, {
      id: ARROW_ID,
      kind: BUILTIN_OBJECT_KINDS.arrow,
      version: 1,
      transform: [0, 0, 80, 20, 0],
      zRank: "b",
      props: { start: [80, 0], end: [0, 20] },
    }, origin);
    const packedStroke = encodeStrokePoints([
      { x: 10, y: 5, pressure: 0.5 },
      { x: 60, y: 30, pressure: 0.5 },
      { x: 110, y: 55, pressure: 0.5 },
    ]);
    addBoardObject(document, {
      id: STROKE_ID,
      kind: BUILTIN_OBJECT_KINDS.stroke,
      version: 1,
      transform: [0, 0, 100, 50, 0],
      zRank: "c",
      props: { points: packedStroke },
    }, origin);

    transformObjects(document, new Map([
      [LINE_ID, [10, 20, 300, 120, 0]],
      [ARROW_ID, [400, 60, 160, 80, 0]],
      [STROKE_ID, [-50, 200, 400, 200, 0]],
    ]), origin);

    const reloaded = openPageDocument(new Y.Doc());
    Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(document));
    const objects = getPageObjects(reloaded);
    const line = boardObjectSnapshot(objects.get(LINE_ID)!);
    const arrow = boardObjectSnapshot(objects.get(ARROW_ID)!);
    const stroke = boardObjectSnapshot(objects.get(STROKE_ID)!);

    expect(renderedPoints(line)).toEqual([0, 120, 300, 0]);
    expect(renderedPoints(arrow)).toEqual([160, 0, 0, 80]);
    expect(renderedPoints(stroke)).toEqual([0, 0, 200, 100, 400, 200]);
    expect(line.props).toEqual({ start: [0, 40], end: [100, 0] });
    expect(arrow.props).toEqual({ start: [80, 0], end: [0, 20] });
    expect(stroke.props.points).toEqual(packedStroke);

    expect(spatialItemForObject(line)).toEqual({
      id: LINE_ID,
      minX: 10,
      minY: 20,
      maxX: 310,
      maxY: 140,
    });
    expect(spatialItemForObject(arrow)).toEqual({
      id: ARROW_ID,
      minX: 400,
      minY: 60,
      maxX: 560,
      maxY: 140,
    });
    expect(spatialItemForObject(stroke)).toEqual({
      id: STROKE_ID,
      minX: -50,
      minY: 200,
      maxX: 350,
      maxY: 400,
    });
  });
});

describe("Konva viewport and large-selection budgets", () => {
  it("keeps 50k select-all virtualized and reuses the overscan query while panning", () => {
    const { renderer, internals } = rendererHarness();
    const objects = Array.from({ length: 50_000 }, (_, index) => snapshot({
      id: `object-${index}`,
      kind: BUILTIN_OBJECT_KINDS.rectangle,
      transform: [index * 80, 20, 24, 24, 0],
      zRank: `a${index.toString().padStart(6, "0")}`,
      props: {},
    }));
    renderer.setObjects(objects);
    const initialNodeCount = internals.nodes.size;
    expect(initialNodeCount).toBeLessThan(32);

    renderer.setSelection(objects.map((object) => object.id));

    expect(renderer.selection).toHaveLength(50_000);
    expect(internals.nodes.size).toBe(initialNodeCount);
    expect(internals.transformer.nodes()).toHaveLength(0);
    expect(internals.selectionOutline.visible()).toBe(true);
    expect(internals.selectionObjectOutlines.size).toBe(initialNodeCount);

    const search = vi.spyOn(internals.spatial, "search");
    search.mockClear();
    for (let step = 1; step <= 100; step += 1) {
      renderer.setCamera({ x: -step * 4, y: 0, zoom: 1 });
    }
    expect(search).not.toHaveBeenCalled();

    renderer.setCamera({ x: -600, y: 0, zoom: 1 });
    expect(search).toHaveBeenCalledTimes(1);
    expect(internals.nodes.size).toBeLessThan(40);
    renderer.destroy();
  });

  it("applies a bulk offscreen transaction without N viewport reconciliations", () => {
    const { renderer, internals } = rendererHarness();
    const search = vi.spyOn(internals.spatial, "search");
    search.mockClear();
    for (let index = 0; index < 1_000; index += 1) {
      renderer.setObject(snapshot({
        id: `bulk-${index}`,
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [20_000 + index * 40, 20_000, 20, 20, 0],
        zRank: `b${index.toString().padStart(4, "0")}`,
        props: {},
      }));
    }

    expect(search).not.toHaveBeenCalled();
    expect(internals.nodes.size).toBe(0);
    renderer.destroy();
  });

  it("coalesces selection repair during a bulk delete", async () => {
    const { callbacks, renderer } = rendererHarness();
    const objects = Array.from({ length: 10_000 }, (_, index) => snapshot({
      id: `delete-${index}`,
      kind: BUILTIN_OBJECT_KINDS.rectangle,
      transform: [index * 80, 20, 24, 24, 0],
      zRank: `c${index.toString().padStart(5, "0")}`,
      props: {},
    }));
    renderer.setObjects(objects);
    renderer.setSelection(objects.map((object) => object.id));
    vi.mocked(callbacks.onSelectionChange).mockClear();

    for (let index = 0; index < 1_000; index += 1) {
      renderer.deleteObject(`delete-${index}`);
    }
    await Promise.resolve();

    expect(renderer.selection).toHaveLength(9_000);
    expect(callbacks.onSelectionChange).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callbacks.onSelectionChange).mock.calls[0][0])
      .toHaveLength(9_000);
    renderer.destroy();
  });

  it("disables partial scale/rotate but preserves offscreen objects in a group drag", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "visible",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [20, 30, 40, 50, 0],
        props: {},
      }),
      snapshot({
        id: "offscreen",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [5_000, 1_000, 60, 70, 0.25],
        props: {},
      }),
    ]);
    renderer.setSelection(["visible", "offscreen"]);
    expect(internals.nodes.has("offscreen")).toBe(false);
    expect(internals.transformer.nodes()).toHaveLength(0);
    expect(internals.selectionOutline.visible()).toBe(true);
    expect(internals.selectionOutline.dash()).toEqual([7, 5]);
    expect([...internals.selectionObjectOutlines.keys()]).toEqual(["visible"]);

    const visible = internals.nodes.get("visible")!;
    visible.fire("dragstart");
    expect(internals.dragVisibleIds).toEqual(["visible"]);
    visible.position({ x: 55, y: 50 });
    visible.fire("dragmove");
    visible.fire("dragend");

    const transforms = vi.mocked(callbacks.onTransformObjects).mock.calls.at(-1)?.[0];
    expect(transforms?.get("visible")).toEqual([55, 50, 40, 50, 0]);
    expect(transforms?.get("offscreen")).toEqual([
      5_035,
      1_020,
      60,
      70,
      0.25,
    ]);
    renderer.destroy();
  });

  it("falls back to aggregate chrome above the visible outline budget", () => {
    const { renderer, internals } = rendererHarness();
    const objects = Array.from(
      { length: MAX_LOCAL_SELECTION_OUTLINES + 1 },
      (_, index) => snapshot({
        id: `dense-${index}`,
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [
          -280 + (index % 24) * 23,
          -220 + Math.floor(index / 24) * 20,
          12,
          10,
          0,
        ],
        zRank: `d${index.toString().padStart(4, "0")}`,
        props: {},
      }),
    );
    renderer.setObjects(objects);
    expect(internals.nodes.size).toBe(objects.length);

    renderer.setSelection(objects.map((object) => object.id));

    expect(internals.transformer.nodes()).toHaveLength(0);
    expect(internals.selectionOutline.visible()).toBe(true);
    expect(internals.selectionObjectOutlines.size).toBe(0);
    renderer.destroy();
  });
});

describe("Konva local multi-selection chrome", () => {
  function selectedRenderer(): ReturnType<typeof rendererHarness> {
    const harness = rendererHarness();
    harness.renderer.setObjects([
      snapshot({
        id: "selection-rectangle",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [20, 30, 70, 50, Math.PI / 8],
        props: {},
      }),
      snapshot({
        id: "selection-frame",
        kind: BUILTIN_OBJECT_KINDS.frame,
        transform: [150, 90, 120, 80, -Math.PI / 12],
        props: { label: "Selected frame" },
      }),
    ]);
    harness.renderer.setSelection([
      "selection-rectangle",
      "selection-frame",
    ]);
    return harness;
  }

  it("draws every selected object alongside the group transformer", () => {
    const { renderer, internals } = selectedRenderer();

    expect(
      internals.transformer.nodes().map(
        (node) => node.getAttr("boardObjectId"),
      ),
    ).toEqual(["selection-rectangle", "selection-frame"]);
    expect(internals.transformer.borderDash()).toEqual([7, 5]);
    expect(internals.selectionOutline.visible()).toBe(false);
    expect([...internals.selectionObjectOutlines.keys()]).toEqual([
      "selection-rectangle",
      "selection-frame",
    ]);

    for (const [id, outline] of internals.selectionObjectOutlines) {
      expect(outline.points()).toEqual(
        expectedSelectionOutlinePoints(internals.nodes.get(id)!),
      );
      expect(outline.closed()).toBe(true);
      expect(outline.listening()).toBe(false);
      expect(outline.stroke()).toBe("#315efb");
      expect(outline.strokeWidth()).toBe(1.25);
      expect(outline.dash()).toEqual([]);
    }
    renderer.destroy();
  });

  it("keeps individual outlines attached during live drag and transform", () => {
    const { renderer, internals } = selectedRenderer();
    const rectangle = internals.nodes.get("selection-rectangle")!;
    const frame = internals.nodes.get("selection-frame")!;
    const rectangleBounds = selectionOutlineBounds(rectangle);
    const rectangleOutlineBefore = [
      ...internals.selectionObjectOutlines.get("selection-rectangle")!.points(),
    ];
    const frameOutlineBefore = [
      ...internals.selectionObjectOutlines.get("selection-frame")!.points(),
    ];

    rectangle.fire("dragstart");
    rectangle.position({ x: 85, y: 105 });
    rectangle.fire("dragmove");
    expect(
      internals.selectionObjectOutlines.get("selection-rectangle")?.points(),
    ).toEqual(
      rectangleOutlineBefore.map(
        (coordinate, index) => coordinate + (index % 2 === 0 ? 65 : 75),
      ),
    );
    expect(
      internals.selectionObjectOutlines.get("selection-frame")?.points(),
    ).toEqual(
      frameOutlineBefore.map(
        (coordinate, index) => coordinate + (index % 2 === 0 ? 65 : 75),
      ),
    );
    rectangle.fire("dragend");

    rectangle.scale({ x: 1.4, y: 0.75 });
    rectangle.rotation(38);
    internals.transformer.fire("transform");
    expect(
      internals.selectionObjectOutlines.get("selection-rectangle")?.points(),
    ).toEqual(expectedSelectionOutlinePoints(rectangle, rectangleBounds));
    renderer.destroy();
  });

  it("keeps outline weight screen-constant and follows the theme", () => {
    const { renderer, internals } = selectedRenderer();

    renderer.setCamera({ x: 400, y: 300, zoom: 2 });
    expect(internals.transformer.borderDash()).toEqual([7, 5]);
    expect(
      internals.selectionObjectOutlines.get("selection-rectangle")
        ?.strokeWidth(),
    ).toBe(0.625);
    expect(
      internals.selectionObjectOutlines.get("selection-rectangle")?.dash(),
    ).toEqual([]);

    renderer.setTheme("dark");
    expect(
      internals.selectionObjectOutlines.get("selection-rectangle")?.stroke(),
    ).toBe("#86a7e8");
    renderer.setTheme("light");
    expect(
      internals.selectionObjectOutlines.get("selection-rectangle")?.stroke(),
    ).toBe("#315efb");
    renderer.destroy();
  });

  it("keeps Transformer handles and frame screen-constant across the complete zoom range", () => {
    const { renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "transform-controls-left",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [10, 10, 10, 10, 0],
        zRank: "a",
        props: {},
      }),
      snapshot({
        id: "transform-controls-right",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [22, 10, 10, 10, 0],
        zRank: "b",
        props: {},
      }),
    ]);
    renderer.setSelection([
      "transform-controls-left",
      "transform-controls-right",
    ]);

    const measurements = [0.02, 1, 20].map((zoom) => {
      renderer.setCamera({
        x: 400 - 21 * zoom,
        y: 300 - 15 * zoom,
        zoom,
      });
      const resizeAnchor = internals.transformer.findOne<Konva.Rect>(".top-left")!;
      const rotateAnchor = internals.transformer.findOne<Konva.Rect>(".rotater")!;
      const topCenter = internals.transformer.findOne<Konva.Rect>(".top-center")!;
      const border = internals.transformer.findOne<Konva.Shape>(".back")!;
      const anchorScale = resizeAnchor.getAbsoluteScale();
      const transformerScale = internals.transformer.getAbsoluteScale();
      const anchorCornerRadius = resizeAnchor.cornerRadius();
      if (typeof anchorCornerRadius !== "number") {
        throw new Error("Expected a uniform Transformer anchor corner radius");
      }
      return {
        zoom,
        resizeAnchorWidth: resizeAnchor.width() * anchorScale.x,
        resizeAnchorHeight: resizeAnchor.height() * anchorScale.y,
        rotateAnchorWidth: rotateAnchor.width() * rotateAnchor.getAbsoluteScale().x,
        rotateAnchorHeight: rotateAnchor.height() * rotateAnchor.getAbsoluteScale().y,
        anchorStrokeWidth: resizeAnchor.strokeWidth() * anchorScale.x,
        anchorCornerRadius: anchorCornerRadius * anchorScale.x,
        borderStrokeWidth: border.strokeWidth() * border.getAbsoluteScale().x,
        borderDash: internals.transformer.borderDash().map(
          (segment) => segment * transformerScale.x,
        ),
        padding: internals.transformer.padding() * transformerScale.x,
        renderedPaddingX:
          (resizeAnchor.offsetX() - resizeAnchor.width() / 2) * anchorScale.x,
        renderedPaddingY:
          (resizeAnchor.offsetY() - resizeAnchor.height() / 2) * anchorScale.y,
        rotateAnchorOffset:
          internals.transformer.rotateAnchorOffset() * transformerScale.y,
        rotateOffset: Math.hypot(
          rotateAnchor.getAbsolutePosition().x - topCenter.getAbsolutePosition().x,
          rotateAnchor.getAbsolutePosition().y - topCenter.getAbsolutePosition().y,
        ),
      };
    });

    expect(measurements).toEqual([0.02, 1, 20].map((zoom) => ({
      zoom,
      resizeAnchorWidth: 9,
      resizeAnchorHeight: 9,
      rotateAnchorWidth: 9,
      rotateAnchorHeight: 9,
      anchorStrokeWidth: 1.5,
      anchorCornerRadius: 2,
      borderStrokeWidth: 1.5,
      borderDash: [7, 5],
      padding: 4,
      renderedPaddingX: 4,
      renderedPaddingY: 4,
      rotateAnchorOffset: 50,
      rotateOffset: 46,
    })));
    renderer.destroy();
  });

  it("snaps rotation to 45-degree steps only while Shift is held", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObject(snapshot({
      id: "rotation-target",
      kind: BUILTIN_OBJECT_KINDS.rectangle,
      transform: [100, 100, 120, 80, 0],
      props: {},
    }));
    renderer.setSelection(["rotation-target"]);
    const target = internals.nodes.get("rotation-target")!;
    const rotation = beginTransformerRotation(internals, { x: 160, y: 140 });

    try {
      expect(callbacks.onTransformStart).toHaveBeenCalledOnce();

      rotation.moveTo(31, false);
      expect(target.rotation()).toBeCloseTo(31, 1);

      rotation.moveTo(37, true);
      expect(target.rotation()).toBeCloseTo(45, 8);

      rotation.moveTo(39, false);
      expect(target.rotation()).toBeCloseTo(39, 1);

      rotation.moveTo(68, true);
      expect(target.rotation()).toBeCloseTo(90, 8);
      expect(callbacks.onTransformObjects).not.toHaveBeenCalled();

      rotation.end(true);
      expect(callbacks.onTransformObjects).toHaveBeenCalledOnce();
      const committed = vi.mocked(callbacks.onTransformObjects).mock.calls[0][0]
        .get("rotation-target");
      expect(committed?.[2]).toBeCloseTo(120, 8);
      expect(committed?.[3]).toBeCloseTo(80, 8);
      expect(committed?.[4]).toBeCloseTo(Math.PI / 2, 8);
      expect(internals.transformer.rotationSnaps()).toEqual([]);
    } finally {
      rotation.end();
      renderer.destroy();
    }
  });

  it("applies Shift rotation snapping atomically to a multi-selection", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "rotation-left",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [100, 100, 80, 60, 0],
        zRank: "a",
        props: {},
      }),
      snapshot({
        id: "rotation-right",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [240, 100, 80, 60, 0],
        zRank: "b",
        props: {},
      }),
    ]);
    renderer.setSelection(["rotation-left", "rotation-right"]);
    const rotation = beginTransformerRotation(internals, { x: 210, y: 130 });

    try {
      rotation.moveTo(67, true);
      expect(internals.nodes.get("rotation-left")?.rotation()).toBeCloseTo(45, 8);
      expect(internals.nodes.get("rotation-right")?.rotation()).toBeCloseTo(45, 8);
      expect(callbacks.onTransformObjects).not.toHaveBeenCalled();

      rotation.end(true);
      expect(callbacks.onTransformStart).toHaveBeenCalledOnce();
      expect(callbacks.onTransformObjects).toHaveBeenCalledOnce();
      const committed = vi.mocked(callbacks.onTransformObjects).mock.calls[0][0];
      expect([...committed.keys()]).toEqual(["rotation-left", "rotation-right"]);
      expect(committed.get("rotation-left")?.[4]).toBeCloseTo(Math.PI / 4, 8);
      expect(committed.get("rotation-right")?.[4]).toBeCloseTo(Math.PI / 4, 8);
    } finally {
      rotation.end();
      renderer.destroy();
    }
  });

  it("cleans up outlines when multi-selection chrome is unavailable", () => {
    const { renderer, internals } = selectedRenderer();

    renderer.setSelection(["selection-rectangle"]);
    expect(internals.selectionObjectOutlines.size).toBe(0);
    expect(internals.transformer.borderDash()).toEqual([]);

    renderer.setSelection(["selection-rectangle", "selection-frame"]);
    renderer.setTool("pen");
    expect(internals.selectionObjectOutlines.size).toBe(0);

    renderer.setTool("select");
    expect(internals.selectionObjectOutlines.size).toBe(2);
    renderer.setReadOnly(true);
    expect(internals.selectionObjectOutlines.size).toBe(0);

    renderer.setReadOnly(false);
    expect(internals.selectionObjectOutlines.size).toBe(2);
    renderer.deleteObject("selection-frame");
    expect(internals.selectionObjectOutlines.size).toBe(0);
    renderer.destroy();
    expect(internals.selectionObjectOutlines.size).toBe(0);
  });
});

describe("Konva board view controls", () => {
  it("keeps the background painted while the grid is hidden and defaults the grid to visible", () => {
    const visible = rendererHarness();
    const visiblePaint = renderGrid(visible.internals);
    expect(visiblePaint.fillRect).toHaveBeenCalledOnce();
    expect(visiblePaint.stroke).toHaveBeenCalled();

    visible.renderer.setGridVisible(false);
    const hiddenPaint = renderGrid(visible.internals);
    expect(hiddenPaint.fillRect).toHaveBeenCalledOnce();
    expect(hiddenPaint.stroke).not.toHaveBeenCalled();
    visible.renderer.setGridVisible(true);
    expect(renderGrid(visible.internals).stroke).toHaveBeenCalled();
    visible.renderer.destroy();

    const initiallyHidden = rendererHarness({ gridVisible: false });
    const initiallyHiddenPaint = renderGrid(initiallyHidden.internals);
    expect(initiallyHiddenPaint.fillRect).toHaveBeenCalledOnce();
    expect(initiallyHiddenPaint.stroke).not.toHaveBeenCalled();
    initiallyHidden.renderer.destroy();
  });

  it("uses the shared 2%-2000% limits for direct camera and Fit content", () => {
    const { renderer } = rendererHarness();

    renderer.setCamera({ x: 30, y: 40, zoom: 0.001 });
    expect(renderer.camera).toEqual({ x: 30, y: 40, zoom: 0.02 });
    renderer.setCamera({ x: 50, y: 60, zoom: 100 });
    expect(renderer.camera).toEqual({ x: 50, y: 60, zoom: 20 });

    renderer.setObjects([
      snapshot({
        id: "tiny-fit",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [0, 0, 1, 1, 0],
      }),
    ]);
    renderer.fitToContent();
    expect(renderer.camera.zoom).toBe(20);

    renderer.setObjects([
      snapshot({
        id: "huge-fit",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [0, 0, 100_000, 100_000, 0],
      }),
    ]);
    renderer.fitToContent();
    expect(renderer.camera.zoom).toBe(0.02);
    renderer.destroy();
  });
});

describe("Konva pointer gesture input", () => {
  it("creates every concrete shape through the one stable Shape tool", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    const cases = [
      ["rectangle", BUILTIN_OBJECT_KINDS.rectangle],
      ["ellipse", BUILTIN_OBJECT_KINDS.ellipse],
      ["diamond", BUILTIN_OBJECT_KINDS.diamond],
      ["frame", BUILTIN_OBJECT_KINDS.frame],
    ] as const;
    renderer.setTool("shape");

    cases.forEach(([shapeKind, objectKind], index) => {
      const pointerId = 280 + index;
      const start = 20 + index * 30;
      renderer.setShapeKind(shapeKind);
      vi.mocked(callbacks.onCreateObject).mockClear();
      vi.mocked(callbacks.onGesturePreviewChange!).mockClear();

      internals.onPointerDown(konvaPointerEvent(
        internals,
        "pointerdown",
        pointerEvent(pointerId, start, start, { type: "pointerdown" }),
      ));
      expect(internals.activeGesture?.tool).toBe(shapeKind);
      expect(callbacks.onGesturePreviewChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: shapeKind }),
      );

      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(pointerId, start + 80, start + 50),
      ));
      internals.onPointerUp(konvaPointerEvent(
        internals,
        "pointerup",
        pointerEvent(pointerId, start + 80, start + 50, {
          buttons: 0,
          type: "pointerup",
        }),
      ));

      expect(callbacks.onCreateObject).toHaveBeenCalledOnce();
      expect(vi.mocked(callbacks.onCreateObject).mock.calls[0]?.[0].kind)
        .toBe(objectKind);
    });
    renderer.destroy();
  });

  it("snapshots the configured shape kind at pointer-down", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("shape");
    renderer.setShapeKind("ellipse");

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(284, 40, 50, { type: "pointerdown" }),
    ));
    expect(internals.activeGesture?.tool).toBe("ellipse");

    renderer.setShapeKind("diamond");
    expect(internals.activeGesture?.tool).toBe("ellipse");
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(284, 140, 120),
    ));
    expect(callbacks.onGesturePreviewChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "ellipse" }),
    );
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(284, 140, 120, { buttons: 0, type: "pointerup" }),
    ));
    expect(vi.mocked(callbacks.onCreateObject).mock.calls[0]?.[0].kind)
      .toBe(BUILTIN_OBJECT_KINDS.ellipse);

    vi.mocked(callbacks.onCreateObject).mockClear();
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(285, 60, 70, { type: "pointerdown" }),
    ));
    expect(internals.activeGesture?.tool).toBe("diamond");
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(285, 150, 130, { buttons: 0, type: "pointerup" }),
    ));
    expect(vi.mocked(callbacks.onCreateObject).mock.calls[0]?.[0].kind)
      .toBe(BUILTIN_OBJECT_KINDS.diamond);
    renderer.destroy();
  });

  it("places ordinary click tools at pointer-down world coordinates with small input drift", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setCamera({ x: 40, y: 20, zoom: 2 });
    renderer.setTool("code");

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(300, 140, 100, { type: "pointerdown" }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(300, 144, 104),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(300, 145, 105, { buttons: 0, type: "pointerup" }),
    ));

    expect(callbacks.onPlaceTool).toHaveBeenCalledOnce();
    expect(callbacks.onPlaceTool).toHaveBeenCalledWith("code", { x: 50, y: 40 });
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("does not place click tools after a drag or pointer cancellation", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("image");
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(307, 20, 20, { type: "pointerdown" }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(307, 60, 20),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(307, 60, 20, { buttons: 0, type: "pointerup" }),
    ));

    renderer.setTool("latex");
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(308, 80, 70, { type: "pointerdown", pointerType: "touch" }),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointercancel",
      pointerEvent(308, 80, 70, {
        buttons: 0,
        pointerType: "touch",
        type: "pointercancel",
      }),
    ));

    expect(callbacks.onPlaceTool).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("creates a curved connector with canonical control geometry and live preview", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("line");
    renderer.setConnectorCurvature(0.5);
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(309, 100, 100, { type: "pointerdown" }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(309, 300, 100),
    ));

    expect(callbacks.onGesturePreviewChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "line",
        points: [
          { x: 100, y: 100 },
          { x: 200, y: 175 },
          { x: 300, y: 100 },
        ],
      }),
    );
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(309, 300, 100, { buttons: 0, type: "pointerup" }),
    ));

    const draft = vi.mocked(callbacks.onCreateObject).mock.calls[0]?.[0];
    expect(draft).toMatchObject({
      kind: BUILTIN_OBJECT_KINDS.line,
      transform: [100, 100, 200, 75, 0],
      props: {
        start: [0, 0],
        control: [100, 75],
        end: [200, 0],
      },
    });
    renderer.destroy();
  });

  it("requests an object or empty-space context menu with scaled screen and world coordinates", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "context-target",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [20, 20, 80, 60, 0],
      }),
    ]);
    renderer.setCamera({ x: 40, y: 20, zoom: 2 });
    renderer.element.getBoundingClientRect = () => ({
      x: 100,
      y: 50,
      width: 400,
      height: 300,
      top: 50,
      right: 500,
      bottom: 350,
      left: 100,
      toJSON: () => ({}),
    });
    const target = internals.nodes.get("context-target")!.getChildren()[0];
    const objectEvent = pointerEvent(301, 150, 80, {
      button: 2,
      buttons: 0,
      type: "contextmenu",
    });

    internals.onContextMenu(konvaContextMenuEvent(
      internals,
      objectEvent,
      target,
    ));

    expect(objectEvent.preventDefault).toHaveBeenCalledOnce();
    expect(callbacks.onContextMenu).toHaveBeenLastCalledWith({
      screen: { x: 100, y: 60 },
      world: { x: 30, y: 20 },
      objectId: "context-target",
    });

    const emptyEvent = pointerEvent(302, 300, 200, {
      button: 2,
      buttons: 0,
      type: "contextmenu",
    });
    internals.onContextMenu(konvaContextMenuEvent(internals, emptyEvent));

    expect(emptyEvent.preventDefault).toHaveBeenCalledOnce();
    expect(callbacks.onContextMenu).toHaveBeenLastCalledWith({
      screen: { x: 400, y: 300 },
      world: { x: 180, y: 140 },
      objectId: null,
    });
    renderer.destroy();
  });

  it("cancels draft and node interactions before requesting a context menu", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("pen");
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(303, 10, 10, { type: "pointerdown" }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(303, 80, 50),
    ));

    internals.onContextMenu(konvaContextMenuEvent(
      internals,
      pointerEvent(304, 90, 60, {
        button: 2,
        buttons: 0,
        type: "contextmenu",
      }),
    ));

    expect(internals.activeGesture).toBeNull();
    expect(internals.pressedPointerIds.size).toBe(0);
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();
    expect(vi.mocked(callbacks.onGesturePreviewChange!).mock.calls.at(-1)?.[0])
      .toBeNull();

    renderer.setTool("select");
    renderer.setObjects([
      snapshot({
        id: "context-drag",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [20, 30, 40, 50, 0],
      }),
    ]);
    renderer.setSelection(["context-drag"]);
    const dragged = internals.nodes.get("context-drag")!;
    dragged.fire("dragstart");
    dragged.position({ x: 120, y: 130 });

    internals.onContextMenu(konvaContextMenuEvent(
      internals,
      pointerEvent(305, 100, 100, {
        button: 2,
        buttons: 0,
        type: "contextmenu",
      }),
    ));

    expect(callbacks.onTransformCancel).toHaveBeenCalledOnce();
    expect(callbacks.onTransformObjects).not.toHaveBeenCalled();
    expect(internals.nodes.get("context-drag")?.position())
      .toEqual({ x: 20, y: 30 });
    expect(callbacks.onContextMenu).toHaveBeenCalledTimes(2);
    renderer.destroy();
  });

  it("targets the current selection when the context menu starts on transformer chrome", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "context-first",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [20, 30, 40, 50, 0],
      }),
      snapshot({
        id: "context-second",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [100, 80, 50, 60, 0],
      }),
    ]);
    renderer.setSelection(["context-first", "context-second"]);
    const anchor = internals.transformer.findOne(".top-left");
    expect(anchor).toBeTruthy();

    internals.onContextMenu(konvaContextMenuEvent(
      internals,
      pointerEvent(306, 40, 40, {
        button: 2,
        buttons: 0,
        type: "contextmenu",
      }),
      anchor!,
    ));

    expect(callbacks.onContextMenu).toHaveBeenCalledWith(expect.objectContaining({
      objectId: "context-first",
    }));
    renderer.destroy();
  });

  it("uses the current pointer sample when synthetic input exposes an empty coalesced list", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("pen");

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(101, 10, 10, { type: "pointerdown" }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(101, 80, 60, {
        getCoalescedEvents: () => [],
      }),
    ));

    const livePreview = vi.mocked(callbacks.onGesturePreviewChange!)
      .mock.calls.at(-1)?.[0];
    expect(livePreview?.points).toEqual([
      { x: 10, y: 10 },
      { x: 80, y: 60 },
    ]);
    expect((internals.activeGesture?.preview as Konva.Line).points())
      .toEqual([10, 10, 80, 60]);
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("latches Alt held before pen pointer-down as an ephemeral laser gesture", () => {
    const { callbacks, renderer, internals, root } = rendererHarness();
    renderer.setTool("pen");
    root.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Alt",
      altKey: true,
    }));

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(180, 10, 10, {
        altKey: true,
        type: "pointerdown",
      }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(180, 45, 25, { altKey: true }),
    ));

    expect(internals.activeGesture?.kind).toBe("laser");
    expect(vi.mocked(callbacks.onLaserChange).mock.calls.at(-1)?.[0])
      .toMatchObject({
        strokes: [{
          points: [
            { x: 10, y: 10 },
            { x: 45, y: 25 },
          ],
        }],
      });
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();
    expect(callbacks.onGesturePreviewChange).not.toHaveBeenCalled();

    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(180, 45, 25, {
        buttons: 0,
        altKey: true,
        type: "pointerup",
      }),
    ));
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();
    expect(vi.mocked(callbacks.onLaserChange).mock.calls.at(-1)?.[0])
      .not.toBeNull();

    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
    expect(vi.mocked(callbacks.onLaserChange).mock.calls.at(-1)?.[0]).toBeNull();
    renderer.destroy();
  });

  it("keeps pre-held Ctrl on the unfinished-stroke movement path", () => {
    const { callbacks, renderer, internals, root } = rendererHarness();
    renderer.setTool("pen");
    root.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Control",
      ctrlKey: true,
    }));

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(192, 10, 10, {
        ctrlKey: true,
        type: "pointerdown",
      }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(192, 35, 25, { ctrlKey: true }),
    ));

    expect(internals.activeGesture?.kind).toBe("drawing");
    expect(internals.activeGesture?.strokeMoveActive).toBe(true);
    expect(internals.activeGesture?.strokeOffset).toEqual({ x: 25, y: 15 });
    expect(callbacks.onLaserChange).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(192, 60, 40),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(192, 70, 45, {
        buttons: 0,
        type: "pointerup",
      }),
    ));

    expect(callbacks.onCreateObject).toHaveBeenCalledOnce();
    expect(callbacks.onLaserChange).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("does not treat AltGraph as the Drawing laser modifier", () => {
    const { callbacks, renderer, internals, root } = rendererHarness();
    renderer.setTool("pen");
    root.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "AltGraph",
      altKey: true,
      ctrlKey: true,
    }));

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(193, 10, 10, {
        altKey: true,
        ctrlKey: true,
        getModifierState: (key: string) => key === "AltGraph",
        type: "pointerdown",
      }),
    ));

    expect(internals.activeGesture?.kind).toBe("drawing");
    expect(callbacks.onLaserChange).not.toHaveBeenCalled();
    expect(callbacks.onPenLaserModeChange).not.toHaveBeenCalled();
    renderer.cancelInteraction();
    renderer.destroy();
  });

  it("allows only the Alt-latched Drawing laser in read-only mode", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("pen");
    renderer.setReadOnly(true);

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(194, 10, 10, {
        ctrlKey: true,
        type: "pointerdown",
      }),
    ));
    expect(internals.activeGesture).toBeNull();
    expect(callbacks.onLaserChange).not.toHaveBeenCalled();
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(194, 10, 10, {
        buttons: 0,
        ctrlKey: true,
        type: "pointerup",
      }),
    ));

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(195, 20, 20, {
        altKey: true,
        type: "pointerdown",
      }),
    ));

    expect(internals.activeGesture?.kind).toBe("laser");
    expect(vi.mocked(callbacks.onLaserChange).mock.calls.at(-1)?.[0])
      .not.toBeNull();
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();
    renderer.cancelInteraction();
    renderer.destroy();
  });

  it("presents pre-held laser mode while a board button has focus", () => {
    const { callbacks, renderer, root } = rendererHarness();
    const toolbarButton = document.createElement("button");
    const textInput = document.createElement("input");
    root.append(toolbarButton, textInput);
    renderer.setTool("pen");

    toolbarButton.focus();
    toolbarButton.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      altKey: true,
      key: "Alt",
    }));
    expect(callbacks.onPenLaserModeChange).toHaveBeenLastCalledWith(true);
    toolbarButton.dispatchEvent(new KeyboardEvent("keyup", {
      bubbles: true,
      key: "Alt",
    }));
    expect(callbacks.onPenLaserModeChange).toHaveBeenLastCalledWith(false);

    vi.mocked(callbacks.onPenLaserModeChange!).mockClear();
    textInput.focus();
    textInput.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      altKey: true,
      key: "Alt",
    }));
    expect(callbacks.onPenLaserModeChange).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("keeps a long single laser stroke within the awareness point budget", () => {
    const { callbacks, renderer, internals, root } = rendererHarness();
    renderer.setTool("pen");
    root.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Alt",
      altKey: true,
    }));

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(190, 0, 10, {
        altKey: true,
        type: "pointerdown",
      }),
    ));
    for (let index = 1; index <= MAX_BOARD_LASER_POINTS + 20; index += 1) {
      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(190, index * 3, 10, { altKey: true }),
      ));
    }

    const preview = vi.mocked(callbacks.onLaserChange).mock.calls.at(-1)?.[0];
    expect(preview?.strokes).toHaveLength(1);
    expect(preview?.strokes[0].points).toHaveLength(MAX_BOARD_LASER_POINTS);
    expect(preview?.strokes[0].points[0]).toEqual({ x: 0, y: 10 });
    expect(preview?.strokes[0].points.at(-1)).toEqual({
      x: (MAX_BOARD_LASER_POINTS + 20) * 3,
      y: 10,
    });
    expect(internals.laserSession?.strokes[0].points)
      .toHaveLength(MAX_BOARD_LASER_POINTS + 21);
    expect(internals.laserSession?.strokes[0].preview.points().slice(0, 2))
      .toEqual([0, 10]);
    expect(internals.activeGesture?.kind).toBe("laser");
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();

    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(190, (MAX_BOARD_LASER_POINTS + 20) * 3, 10, {
        buttons: 0,
        altKey: true,
        type: "pointerup",
      }),
    ));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
    renderer.destroy();
  });

  it("keeps Ctrl pressed after pen pointer-down as unfinished-stroke movement", () => {
    const { callbacks, renderer, internals, root } = rendererHarness();
    renderer.setTool("pen");
    root.focus();

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(181, 10, 10, { type: "pointerdown" }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(181, 30, 10),
    ));
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Control",
      ctrlKey: true,
    }));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(181, 60, 30, { ctrlKey: true }),
    ));

    expect(internals.activeGesture?.kind).toBe("drawing");
    expect(internals.activeGesture?.strokeMoveActive).toBe(true);
    expect(internals.activeGesture?.strokeOffset).toEqual({ x: 30, y: 20 });
    expect(callbacks.onLaserChange).not.toHaveBeenCalled();

    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(181, 80, 40, {
        buttons: 0,
        ctrlKey: true,
        type: "pointerup",
      }),
    ));
    expect(callbacks.onCreateObject).toHaveBeenCalledOnce();
    expect(callbacks.onLaserChange).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    renderer.destroy();
  });

  it("keeps a laser gesture latched after Alt is released until pointer-up", () => {
    const { callbacks, renderer, internals, root } = rendererHarness();
    renderer.setTool("pen");
    root.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Alt",
      altKey: true,
    }));

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(182, 15, 20, {
        altKey: true,
        type: "pointerdown",
      }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(182, 35, 30, { altKey: true }),
    ));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(182, 70, 45),
    ));

    expect(internals.activeGesture?.kind).toBe("laser");
    expect(vi.mocked(callbacks.onLaserChange).mock.calls.at(-1)?.[0])
      .toMatchObject({
        strokes: [{
          points: [
            { x: 15, y: 20 },
            { x: 35, y: 30 },
            { x: 70, y: 45 },
          ],
        }],
      });
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();

    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(182, 80, 50, {
        buttons: 0,
        type: "pointerup",
      }),
    ));
    expect(internals.activeGesture).toBeNull();
    expect(vi.mocked(callbacks.onLaserChange).mock.calls.at(-1)?.[0]).toBeNull();
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("retains separate laser strokes while Alt is held and clears them together on key-up", () => {
    const { callbacks, renderer, internals, root } = rendererHarness();
    renderer.setTool("pen");
    root.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Alt",
      altKey: true,
    }));

    const drawLaserStroke = (
      pointerId: number,
      start: BoardPoint,
      end: BoardPoint,
    ) => {
      internals.onPointerDown(konvaPointerEvent(
        internals,
        "pointerdown",
        pointerEvent(pointerId, start.x, start.y, {
          altKey: true,
          type: "pointerdown",
        }),
      ));
      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(pointerId, end.x, end.y, { altKey: true }),
      ));
      internals.onPointerUp(konvaPointerEvent(
        internals,
        "pointerup",
        pointerEvent(pointerId, end.x, end.y, {
          buttons: 0,
          altKey: true,
          type: "pointerup",
        }),
      ));
    };

    drawLaserStroke(183, { x: 10, y: 15 }, { x: 35, y: 25 });
    expect(vi.mocked(callbacks.onLaserChange).mock.calls.at(-1)?.[0])
      .not.toBeNull();
    drawLaserStroke(184, { x: 100, y: 80 }, { x: 130, y: 95 });

    expect(vi.mocked(callbacks.onLaserChange).mock.calls.at(-1)?.[0])
      .toMatchObject({
        strokes: [
          {
            points: [
              { x: 10, y: 15 },
              { x: 35, y: 25 },
            ],
          },
          {
            points: [
              { x: 100, y: 80 },
              { x: 130, y: 95 },
            ],
          },
        ],
      });
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
    expect(vi.mocked(callbacks.onLaserChange).mock.calls.at(-1)?.[0]).toBeNull();
    renderer.destroy();
  });

  it("retains every local laser stroke while bounding only its awareness projection", () => {
    const { callbacks, renderer, internals, root } = rendererHarness();
    renderer.setTool("pen");
    root.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Alt",
      altKey: true,
    }));

    const localStrokeCount = MAX_BOARD_LASER_STROKES + 3;
    for (let index = 0; index < localStrokeCount; index += 1) {
      retainLaserStroke(
        internals,
        500 + index,
        { x: index * 10, y: 20 },
        { x: index * 10 + 5, y: 30 },
      );
    }

    expect(internals.laserSession?.strokes).toHaveLength(localStrokeCount);
    expect(internals.laserSession?.group.getChildren()).toHaveLength(localStrokeCount);
    const awareness = vi.mocked(callbacks.onLaserChange).mock.calls.at(-1)?.[0];
    expect(awareness?.strokes).toHaveLength(MAX_BOARD_LASER_STROKES);
    expect(awareness?.strokes.reduce(
      (total, stroke) => total + stroke.points.length,
      0,
    )).toBeLessThanOrEqual(MAX_BOARD_LASER_POINTS);
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
    renderer.destroy();
  });

  it("snapshots the current pen style independently for each retained laser stroke", () => {
    const { callbacks, renderer, internals, root } = rendererHarness();
    renderer.setTool("pen");
    renderer.setCreationStyle({
      stroke: "#d33f49",
      strokeWidth: 8,
      opacity: 0.45,
    });
    root.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Alt",
      altKey: true,
    }));

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(185, 20, 20, {
        altKey: true,
        type: "pointerdown",
      }),
    ));
    renderer.setCreationStyle({
      stroke: "#2563eb",
      strokeWidth: 3.5,
      opacity: 0.8,
    });
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(185, 50, 35, { altKey: true }),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(185, 50, 35, {
        buttons: 0,
        altKey: true,
        type: "pointerup",
      }),
    ));

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(186, 90, 60, {
        altKey: true,
        type: "pointerdown",
      }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(186, 120, 75, { altKey: true }),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(186, 120, 75, {
        buttons: 0,
        altKey: true,
        type: "pointerup",
      }),
    ));

    expect(vi.mocked(callbacks.onLaserChange).mock.calls.at(-1)?.[0])
      .toMatchObject({
        strokes: [
          {
            style: {
              stroke: "#d33f49",
              strokeWidth: 8,
              opacity: 0.45,
            },
          },
          {
            style: {
              stroke: "#2563eb",
              strokeWidth: 3.5,
              opacity: 0.8,
            },
          },
        ],
      });
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
    renderer.destroy();
  });

  it("clears retained laser strokes and the active stroke when pointer capture is lost", () => {
    const { callbacks, renderer, internals, root } = rendererHarness();
    const captureTarget = document.createElement("canvas");
    Object.defineProperties(captureTarget, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      releasePointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: () => true },
    });
    renderer.setTool("pen");
    root.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Alt",
      altKey: true,
    }));

    const firstDown = pointerEvent(187, 10, 10, {
      altKey: true,
      target: captureTarget,
      type: "pointerdown",
    });
    internals.onPointerDown(konvaPointerEvent(internals, "pointerdown", firstDown));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(187, 35, 20, { altKey: true }),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(187, 35, 20, {
        buttons: 0,
        altKey: true,
        target: captureTarget,
        type: "pointerup",
      }),
    ));

    const secondDown = pointerEvent(188, 70, 50, {
      altKey: true,
      target: captureTarget,
      type: "pointerdown",
    });
    internals.onPointerDown(konvaPointerEvent(internals, "pointerdown", secondDown));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(188, 100, 65, { altKey: true }),
    ));
    expect(internals.activeGesture?.kind).toBe("laser");

    internals.lostPointerCapture({ pointerId: 188 } as PointerEvent);
    expect(internals.activeGesture).toBeNull();
    expect(vi.mocked(callbacks.onLaserChange).mock.calls.at(-1)?.[0]).toBeNull();
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
    renderer.destroy();
  });

  it("cancels a retained laser session without creating a durable object", () => {
    const { callbacks, renderer, internals, root } = rendererHarness();
    renderer.setTool("pen");
    root.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Alt",
      altKey: true,
    }));
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(189, 25, 25, {
        altKey: true,
        type: "pointerdown",
      }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(189, 60, 45, { altKey: true }),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(189, 60, 45, {
        buttons: 0,
        altKey: true,
        type: "pointerup",
      }),
    ));
    expect(vi.mocked(callbacks.onLaserChange).mock.calls.at(-1)?.[0])
      .not.toBeNull();

    renderer.cancelInteraction();
    expect(internals.activeGesture).toBeNull();
    expect(vi.mocked(callbacks.onLaserChange).mock.calls.at(-1)?.[0]).toBeNull();
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
    renderer.destroy();
  });

  it("restores the Drawing presentation when an idle renderer is destroyed", () => {
    const { callbacks, renderer, root } = rendererHarness();
    renderer.setTool("pen");
    root.focus();

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Alt",
      altKey: true,
    }));
    expect(callbacks.onPenLaserModeChange).toHaveBeenLastCalledWith(true);

    renderer.destroy();
    expect(callbacks.onPenLaserModeChange).toHaveBeenLastCalledWith(false);
  });

  it("clears an active laser and its Drawing presentation on destroy", () => {
    const { callbacks, renderer, internals, root } = rendererHarness();
    renderer.setTool("pen");
    root.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Alt",
      altKey: true,
    }));
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(191, 25, 25, {
        altKey: true,
        type: "pointerdown",
      }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(191, 60, 45, { altKey: true }),
    ));

    expect(internals.activeGesture?.kind).toBe("laser");
    renderer.destroy();

    expect(callbacks.onLaserChange).toHaveBeenLastCalledWith(
      null,
      "immediate",
    );
    expect(callbacks.onPenLaserModeChange).toHaveBeenLastCalledWith(false);
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();
  });

  it("immediately clears a retained laser when the window loses focus", () => {
    const { callbacks, renderer, internals, root } = rendererHarness();
    renderer.setTool("pen");
    root.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Alt",
      altKey: true,
    }));
    retainLaserStroke(internals, 520, { x: 10, y: 10 }, { x: 50, y: 30 });

    window.dispatchEvent(new Event("blur"));

    expect(callbacks.onLaserChange).toHaveBeenLastCalledWith(null, "immediate");
    expect(callbacks.onPenLaserModeChange).toHaveBeenLastCalledWith(false);
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("immediately clears a retained laser when the document becomes hidden", () => {
    const visibilityState = vi.spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const { callbacks, renderer, internals, root } = rendererHarness();
    renderer.setTool("pen");
    root.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Alt",
      altKey: true,
    }));

    try {
      retainLaserStroke(internals, 521, { x: 10, y: 10 }, { x: 50, y: 30 });
      document.dispatchEvent(new Event("visibilitychange"));

      expect(callbacks.onLaserChange).toHaveBeenLastCalledWith(null, "immediate");
      expect(callbacks.onPenLaserModeChange).toHaveBeenLastCalledWith(false);
      expect(callbacks.onCreateObject).not.toHaveBeenCalled();
    } finally {
      renderer.destroy();
      visibilityState.mockRestore();
    }
  });

  it("immediately clears a retained laser on renderer destruction", () => {
    const { callbacks, renderer, internals, root } = rendererHarness();
    renderer.setTool("pen");
    root.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Alt",
      altKey: true,
    }));
    retainLaserStroke(internals, 522, { x: 10, y: 10 }, { x: 50, y: 30 });

    renderer.destroy();

    expect(callbacks.onLaserChange).toHaveBeenLastCalledWith(null, "immediate");
    expect(callbacks.onPenLaserModeChange).toHaveBeenLastCalledWith(false);
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();
  });

  it("supports an Alt-latched laser through compatibility mouse movement", () => {
    const { callbacks, renderer, internals, root } = rendererHarness();
    renderer.setTool("pen");
    root.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Alt",
      altKey: true,
    }));
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(190, 10, 10, {
        altKey: true,
        type: "pointerdown",
      }),
    ));

    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      buttons: 1,
      cancelable: true,
      clientX: 45,
      clientY: 30,
      altKey: true,
    }));
    window.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true,
      button: 0,
      buttons: 0,
      cancelable: true,
      clientX: 70,
      clientY: 45,
      altKey: true,
    }));

    const preview = vi.mocked(callbacks.onLaserChange).mock.calls.at(-1)?.[0];
    expect(preview).not.toBeNull();
    expect(preview?.strokes).toHaveLength(1);
    expect(preview?.strokes[0].points[0]).toEqual({ x: 10, y: 10 });
    expect(preview?.strokes[0].points.at(-1)).toEqual({ x: 70, y: 45 });
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
    expect(vi.mocked(callbacks.onLaserChange).mock.calls.at(-1)?.[0]).toBeNull();
    renderer.destroy();
  });

  it("moves the active freehand stroke with Ctrl and resumes without a bridge", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("pen");

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(201, 10, 10, { type: "pointerdown" }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(201, 30, 10),
    ));
    const previewChanges = vi.mocked(callbacks.onGesturePreviewChange!);
    const changesBeforeMove = previewChanges.mock.calls.length;
    vi.mocked(callbacks.onCameraChange).mockClear();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Control",
      ctrlKey: true,
    }));
    expect(renderer.element.style.cursor).toBe("grabbing");
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Meta",
      ctrlKey: true,
      metaKey: true,
    }));
    window.dispatchEvent(new KeyboardEvent("keyup", {
      key: "Control",
      metaKey: true,
    }));
    expect(renderer.element.style.cursor).toBe("grabbing");

    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(201, 50, 20, { metaKey: true }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(201, 70, 30, { metaKey: true, shiftKey: true }),
    ));

    expect(renderer.camera).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(callbacks.onCameraChange).not.toHaveBeenCalled();
    expect(internals.activeGesture?.strokeMoveActive).toBe(true);
    expect(internals.activeGesture?.strokeOffset).toEqual({ x: 40, y: 20 });
    expect(internals.activeGesture?.straightPointActive).toBe(false);
    expect(internals.activeGesture?.points?.map(({ x, y }) => ({ x, y })))
      .toEqual([{ x: 10, y: 10 }, { x: 30, y: 10 }]);
    expect(previewChanges).toHaveBeenCalledTimes(changesBeforeMove + 2);
    expect(previewChanges.mock.calls.at(-1)?.[0]?.points).toEqual([
      { x: 50, y: 30 },
      { x: 70, y: 30 },
    ]);
    expect((internals.activeGesture?.preview as Konva.Line).points())
      .toEqual([10, 10, 30, 10]);
    expect((internals.activeGesture?.preview as Konva.Line).position())
      .toEqual({ x: 40, y: 20 });
    expect(renderer.element.style.cursor).toBe("grabbing");
    vi.spyOn(internals.stage, "getPointerPosition").mockReturnValue({
      x: 70,
      y: 30,
    });
    internals.onWheel(konvaWheelEvent(
      internals,
      new WheelEvent("wheel", {
        cancelable: true,
        ctrlKey: true,
        deltaY: -100,
      }),
    ));
    expect(renderer.camera).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(callbacks.onCameraChange).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta" }));
    expect(renderer.element.style.cursor).toBe("crosshair");
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(201, 80, 30),
    ));
    expect(internals.activeGesture?.strokeMoveActive).toBe(false);
    expect(internals.activeGesture?.points?.map(({ x, y }) => ({ x, y })))
      .toEqual([
        { x: 10, y: 10 },
        { x: 30, y: 10 },
        { x: 40, y: 10 },
      ]);
    expect(internals.activeGesture?.previewAwarenessPoints).toEqual([
      { x: 10, y: 10 },
      { x: 30, y: 10 },
      { x: 40, y: 10 },
    ]);
    expect(internals.activeGesture?.previewPoints)
      .toEqual([10, 10, 30, 10, 40, 10]);
    expect((internals.activeGesture?.preview as Konva.Line).position())
      .toEqual({ x: 40, y: 20 });
    expect(previewChanges.mock.calls.at(-1)?.[0]?.points).toEqual([
      { x: 50, y: 30 },
      { x: 70, y: 30 },
      { x: 80, y: 30 },
    ]);
    expect(renderer.element.style.cursor).toBe("crosshair");

    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(201, 90, 40, { buttons: 0, type: "pointerup" }),
    ));

    expect(callbacks.onCreateObject).toHaveBeenCalledOnce();
    const draft = vi.mocked(callbacks.onCreateObject).mock.calls[0][0];
    const strokePoints = draft.props?.strokePoints as Array<
      BoardPoint & { readonly pressure: number }
    >;
    expect(draft.transform).toEqual([50, 30, 40, 10, 0]);
    expect(strokePoints.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 30, y: 0 },
      { x: 40, y: 10 },
    ]);
    expect(callbacks.onCameraChange).not.toHaveBeenCalled();
    expect(internals.activeGesture).toBeNull();
    renderer.destroy();
  });

  it("converts active-stroke movement from screen pixels at the current zoom", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("pen");
    renderer.setCamera({ x: 0, y: 0, zoom: 2 });
    vi.mocked(callbacks.onCameraChange).mockClear();

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(202, 20, 20, { type: "pointerdown" }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(202, 40, 20),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(202, 60, 40, { ctrlKey: true }),
    ));

    expect(renderer.camera).toEqual({ x: 0, y: 0, zoom: 2 });
    expect(callbacks.onCameraChange).not.toHaveBeenCalled();
    expect(internals.activeGesture?.points).toEqual([
      { x: 10, y: 10, pressure: 0.5 },
      { x: 20, y: 10, pressure: 0.5 },
    ]);
    expect(internals.activeGesture?.strokeOffset).toEqual({ x: 10, y: 10 });
    expect((internals.activeGesture?.preview as Konva.Line).position())
      .toEqual({ x: 10, y: 10 });
    expect(
      vi.mocked(callbacks.onGesturePreviewChange!).mock.calls.at(-1)?.[0]
        ?.points,
    ).toEqual([
      { x: 20, y: 20 },
      { x: 30, y: 20 },
    ]);

    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(202, 80, 60, {
        buttons: 0,
        ctrlKey: true,
        type: "pointerup",
      }),
    ));

    expect(callbacks.onCreateObject).toHaveBeenCalledOnce();
    const draft = vi.mocked(callbacks.onCreateObject).mock.calls[0][0];
    const strokePoints = draft.props?.strokePoints as Array<
      BoardPoint & { readonly pressure: number }
    >;
    expect(draft.transform).toEqual([30, 30, 10, 1 / 64, 0]);
    expect(strokePoints).toEqual([
      { x: 0, y: 0, pressure: 0.5 },
      { x: 10, y: 0, pressure: 0.5 },
    ]);
    expect(renderer.camera).toEqual({ x: 0, y: 0, zoom: 2 });
    expect(callbacks.onCameraChange).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("replaces a Shift-constrained endpoint and resumes free drawing in one stroke", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("pen");

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(202, 10, 10, { type: "pointerdown" }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(202, 20, 20),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(202, 50, 40, { shiftKey: true }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(202, 90, 70, {
        shiftKey: true,
        getCoalescedEvents: () => [
          pointerEvent(202, 60, 50, { pressure: 0.2 }),
          pointerEvent(202, 80, 60, { pressure: 0.8 }),
        ],
      }),
    ));

    expect(internals.activeGesture?.straightPointActive).toBe(true);
    expect(internals.activeGesture?.points).toEqual([
      { x: 10, y: 10, pressure: 0.5 },
      { x: 20, y: 20, pressure: 0.5 },
      { x: 80, y: 60, pressure: 0.5 },
    ]);
    expect(internals.activeGesture?.previewPoints)
      .toEqual([10, 10, 20, 20, 80, 60]);
    expect(internals.activeGesture?.previewAwarenessPoints).toEqual([
      { x: 10, y: 10 },
      { x: 20, y: 20 },
      { x: 80, y: 60 },
    ]);

    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(202, 90, 70),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(202, 110, 90, { shiftKey: true }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(202, 120, 100, { shiftKey: true }),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(202, 130, 110, {
        buttons: 0,
        shiftKey: true,
        type: "pointerup",
      }),
    ));

    expect(callbacks.onCreateObject).toHaveBeenCalledOnce();
    const draft = vi.mocked(callbacks.onCreateObject).mock.calls[0][0];
    const strokePoints = draft.props?.strokePoints as Array<
      BoardPoint & { readonly pressure: number }
    >;
    expect(strokePoints.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 70, y: 50 },
      { x: 80, y: 60 },
      { x: 120, y: 100 },
    ]);
    renderer.destroy();
  });

  it("lets Ctrl move a provisional Shift segment through pointer-up", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("pen");

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(203, 10, 10, { type: "pointerdown" }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(203, 30, 20),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(203, 50, 40, { shiftKey: true }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(203, 70, 60, { ctrlKey: true, shiftKey: true }),
    ));
    expect(internals.activeGesture?.straightPointActive).toBe(true);
    expect(internals.activeGesture?.strokeOffset).toEqual({ x: 20, y: 20 });
    expect(internals.activeGesture?.points?.map(({ x, y }) => ({ x, y })))
      .toEqual([
        { x: 10, y: 10 },
        { x: 30, y: 20 },
        { x: 50, y: 40 },
      ]);
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(203, 90, 80, {
        buttons: 0,
        ctrlKey: true,
        shiftKey: true,
        type: "pointerup",
      }),
    ));

    expect(renderer.camera).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(callbacks.onCreateObject).toHaveBeenCalledOnce();
    const draft = vi.mocked(callbacks.onCreateObject).mock.calls[0][0];
    const strokePoints = draft.props?.strokePoints as Array<
      BoardPoint & { readonly pressure: number }
    >;
    expect(draft.transform).toEqual([50, 50, 40, 30, 0]);
    expect(strokePoints.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 10 },
      { x: 40, y: 30 },
    ]);
    expect(renderer.element.style.cursor).toBe("crosshair");
    renderer.destroy();
  });

  it("supports freehand modifiers through legacy mouse movement and cancels atomically", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("pen");

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(204, 10, 10, { type: "pointerdown" }),
    ));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      buttons: 1,
      cancelable: true,
      clientX: 30,
      clientY: 20,
    }));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      buttons: 1,
      cancelable: true,
      clientX: 70,
      clientY: 40,
      shiftKey: true,
    }));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      buttons: 1,
      cancelable: true,
      clientX: 90,
      clientY: 50,
      shiftKey: true,
    }));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      buttons: 1,
      cancelable: true,
      clientX: 110,
      clientY: 70,
      ctrlKey: true,
    }));

    expect(renderer.camera).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(internals.activeGesture?.strokeOffset).toEqual({ x: 20, y: 20 });
    expect((internals.activeGesture?.preview as Konva.Line).position())
      .toEqual({ x: 20, y: 20 });
    expect(internals.activeGesture?.points?.map(({ x, y }) => ({ x, y })))
      .toEqual([
        { x: 10, y: 10 },
        { x: 30, y: 20 },
        { x: 90, y: 50 },
      ]);

    window.dispatchEvent(new Event("blur"));
    expect(internals.activeGesture).toBeNull();
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();
    expect(vi.mocked(callbacks.onGesturePreviewChange!).mock.calls.at(-1)?.[0])
      .toBeNull();
    renderer.destroy();
  });

  it("does not turn a Shift click into a tiny stroke", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("pen");
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(205, 40, 50, { shiftKey: true, type: "pointerdown" }),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(205, 40, 50, {
        buttons: 0,
        shiftKey: true,
        type: "pointerup",
      }),
    ));
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("continues a mouse gesture through legacy move/up events without duplicating pointer samples", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("pen");

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(102, 10, 10, { type: "pointerdown" }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(102, 50, 40),
    ));
    const cursorChanges = vi.mocked(callbacks.onCursorChange);
    const changesAfterPointerMove = cursorChanges.mock.calls.length;

    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      buttons: 1,
      cancelable: true,
      clientX: 50,
      clientY: 40,
    }));
    expect(cursorChanges).toHaveBeenCalledTimes(changesAfterPointerMove);

    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      buttons: 1,
      cancelable: true,
      clientX: 90,
      clientY: 70,
    }));
    expect(cursorChanges.mock.calls.at(-1)?.[0]).toEqual({ x: 90, y: 70 });
    const livePreview = vi.mocked(callbacks.onGesturePreviewChange!)
      .mock.calls.at(-1)?.[0];
    expect(livePreview?.points.at(-1)).toEqual({ x: 90, y: 70 });

    window.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true,
      button: 0,
      buttons: 0,
      cancelable: true,
      clientX: 100,
      clientY: 80,
    }));
    expect(callbacks.onCreateObject).toHaveBeenCalledTimes(1);
    expect(internals.activeGesture).toBeNull();
    renderer.destroy();
  });

  it("finishes a mouse gesture when a legacy move reports that its button is no longer pressed", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("pen");

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(104, 10, 10, { type: "pointerdown" }),
    ));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      buttons: 1,
      cancelable: true,
      clientX: 60,
      clientY: 40,
    }));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      buttons: 0,
      cancelable: true,
      clientX: 80,
      clientY: 60,
    }));

    expect(callbacks.onCreateObject).toHaveBeenCalledTimes(1);
    expect(internals.activeGesture).toBeNull();
    expect(internals.activeMousePointerId).toBeNull();

    window.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true,
      button: 0,
      buttons: 0,
      cancelable: true,
      clientX: 80,
      clientY: 60,
    }));
    expect(callbacks.onCreateObject).toHaveBeenCalledTimes(1);
    renderer.destroy();
  });

  it("does not finish a primary-button gesture on an unrelated legacy mouseup", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("pen");

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(105, 10, 10, { type: "pointerdown" }),
    ));
    window.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true,
      button: 2,
      buttons: 1,
      cancelable: true,
      clientX: 40,
      clientY: 30,
    }));
    expect(internals.activeGesture).not.toBeNull();
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();

    window.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true,
      button: 0,
      buttons: 0,
      cancelable: true,
      clientX: 70,
      clientY: 50,
    }));
    expect(callbacks.onCreateObject).toHaveBeenCalledTimes(1);
    renderer.destroy();
  });

  it("keeps primary coalesced motion that returns to the previous screen coordinate", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("pen");

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(106, 10, 10, { type: "pointerdown" }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(106, 10, 10, {
        getCoalescedEvents: () => [
          pointerEvent(106, 50, 40),
          pointerEvent(106, 10, 10),
        ],
      }),
    ));

    expect(vi.mocked(callbacks.onGesturePreviewChange!).mock.calls.at(-1)?.[0]?.points)
      .toEqual([
        { x: 10, y: 10 },
        { x: 50, y: 40 },
        { x: 10, y: 10 },
      ]);
    renderer.destroy();
  });

  it("cancels a synthetic mouse gesture when the window loses focus", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("pen");

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(107, 10, 10, { type: "pointerdown" }),
    ));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      buttons: 1,
      cancelable: true,
      clientX: 70,
      clientY: 50,
    }));
    window.dispatchEvent(new Event("blur"));

    expect(internals.activeGesture).toBeNull();
    expect(internals.activeMousePointerId).toBeNull();
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();
    expect(vi.mocked(callbacks.onGesturePreviewChange!).mock.calls.at(-1)?.[0])
      .toBeNull();
    renderer.destroy();
  });

  it("cancels an active gesture when the document becomes hidden", () => {
    const visibilityState = vi.spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("pen");

    try {
      internals.onPointerDown(konvaPointerEvent(
        internals,
        "pointerdown",
        pointerEvent(108, 10, 10, {
          pointerType: "pen",
          type: "pointerdown",
        }),
      ));
      document.dispatchEvent(new Event("visibilitychange"));

      expect(internals.activeGesture).toBeNull();
      expect(callbacks.onCreateObject).not.toHaveBeenCalled();
      expect(vi.mocked(callbacks.onGesturePreviewChange!).mock.calls.at(-1)?.[0])
        .toBeNull();
    } finally {
      renderer.destroy();
      visibilityState.mockRestore();
    }
  });

  it("uses legacy mouse movement for cursor awareness during a Konva-owned object drag", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "drag-cursor",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [10, 10, 40, 40, 0],
        props: {},
      }),
    ]);

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(103, 20, 20, { type: "pointerdown" }),
      internals.nodes.get("drag-cursor")!.getChildren()[0],
    ));
    expect(internals.activeGesture).toBeNull();

    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      buttons: 1,
      cancelable: true,
      clientX: 75,
      clientY: 55,
    }));
    expect(vi.mocked(callbacks.onCursorChange).mock.calls.at(-1)?.[0])
      .toEqual({ x: 75, y: 55 });

    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(103, 75, 55, {
        buttons: 0,
        type: "pointerup",
      }),
    ));
    renderer.destroy();
  });

  it("uses one creation-style snapshot for stylus preview and the committed object", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("line");
    renderer.setCreationStyle({
      stroke: "#d33f49",
      strokeWidth: 8,
      opacity: 0.6,
      dash: [8, 6],
    });

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(41, 20, 30, {
        pointerType: "pen",
        type: "pointerdown",
      }),
    ));
    expect(internals.activeGesture?.style).toMatchObject({
      stroke: "#d33f49",
      strokeWidth: 8,
      opacity: 0.6,
      dash: [8, 6],
    });
    expect(internals.activeGesture?.preview?.stroke()).toBe("#d33f49");
    expect(internals.activeGesture?.preview?.strokeWidth()).toBe(8);

    renderer.setCreationStyle({
      stroke: "#2563eb",
      strokeWidth: 2,
      opacity: 1,
      dash: [],
    });
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(41, 150, 90, { pointerType: "pen" }),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(41, 150, 90, {
        pointerType: "pen",
        type: "pointerup",
      }),
    ));

    expect(callbacks.onCreateObject).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callbacks.onCreateObject).mock.calls[0][0].style).toMatchObject({
      stroke: "#d33f49",
      strokeWidth: 8,
      opacity: 0.6,
      dash: [8, 6],
    });
    renderer.destroy();
  });

  it("commits freehand pointer input with the selected solid source-over style", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("pen");
    renderer.setCreationStyle({
      stroke: "#ffd43b",
      strokeWidth: 16,
      opacity: 0.38,
      dash: [],
      blendMode: "source-over",
    });

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(45, 20, 30, {
        pointerType: "pen",
        type: "pointerdown",
      }),
    ));
    expect(internals.activeGesture?.preview?.stroke()).toBe("#ffd43b");
    expect(internals.activeGesture?.preview?.strokeWidth()).toBe(16);
    expect(internals.activeGesture?.preview?.opacity()).toBe(0.38);
    expect(internals.activeGesture?.preview?.dash()).toEqual([]);
    expect(internals.activeGesture?.preview?.globalCompositeOperation())
      .toBe("source-over");

    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(45, 80, 70, { pointerType: "pen" }),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(45, 80, 70, {
        pointerType: "pen",
        type: "pointerup",
      }),
    ));

    expect(callbacks.onCreateObject).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callbacks.onCreateObject).mock.calls[0][0]).toMatchObject({
      kind: BUILTIN_OBJECT_KINDS.stroke,
      style: {
        stroke: "#ffd43b",
        strokeWidth: 16,
        opacity: 0.38,
        dash: [],
        blendMode: "source-over",
      },
    });
    renderer.destroy();
  });

  it("preserves zero opacity through freehand preview and commit", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("pen");
    renderer.setCreationStyle({
      stroke: "#2563eb",
      strokeWidth: 4,
      opacity: 0,
      dash: [],
      blendMode: "source-over",
    });

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(46, 20, 30, { type: "pointerdown" }),
    ));
    expect(internals.activeGesture?.style?.opacity).toBe(0);
    expect(internals.activeGesture?.preview?.opacity()).toBe(0);
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(46, 80, 70),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(46, 80, 70, { buttons: 0, type: "pointerup" }),
    ));

    expect(vi.mocked(callbacks.onCreateObject).mock.calls[0][0].style)
      .toMatchObject({ opacity: 0 });
    renderer.destroy();
  });

  it("uses the same hostile-style bounds for drawing preview and committed draft", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("line");
    renderer.setCreationStyle({
      stroke: "rgb(999,0,0)",
      strokeWidth: Number.POSITIVE_INFINITY,
      opacity: Number.POSITIVE_INFINITY,
      dash: [
        Number.POSITIVE_INFINITY,
        -10,
        Number.MAX_VALUE,
        ...Array.from({ length: 32 }, () => 12),
      ],
    });

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(51, 20, 30, { type: "pointerdown" }),
    ));
    const gestureStyle = internals.activeGesture?.style;
    expect(gestureStyle).toMatchObject({
      stroke: "#17212b",
      strokeWidth: 2,
      opacity: 1,
    });
    const gestureDash = gestureStyle?.dash as number[];
    expect(gestureDash.length).toBeLessThanOrEqual(8);
    expect(gestureDash.every((segment) =>
      Number.isFinite(segment) && segment >= 0 && segment <= 256)).toBe(true);
    expect(internals.activeGesture?.preview?.stroke()).toBe("#17212b");
    expect(internals.activeGesture?.preview?.dash()).toEqual(gestureDash);

    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(51, 150, 90),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(51, 150, 90, { type: "pointerup" }),
    ));

    expect(callbacks.onCreateObject).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callbacks.onCreateObject).mock.calls[0][0].style)
      .toEqual(gestureStyle);
    renderer.destroy();
  });

  it("owns a drawing gesture by pointerId, bounds awareness, and clears it on capture loss", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    const captureTarget = document.createElement("canvas");
    const setPointerCapture = vi.fn();
    Object.defineProperties(captureTarget, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      releasePointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: () => true },
    });
    renderer.setTool("pen");
    renderer.setCreationStyle({
      stroke: "#d33f49",
      strokeWidth: 18,
      opacity: 0.35,
    });

    const down = pointerEvent(7, 10, 10, {
      target: captureTarget,
      type: "pointerdown",
    });
    internals.onPointerDown(konvaPointerEvent(internals, "pointerdown", down));
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(internals.activeGesture?.kind).toBe("drawing");

    const changes = vi.mocked(callbacks.onGesturePreviewChange!);
    const baseline = changes.mock.calls.length;
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(8, 80, 80),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(8, 80, 80, { type: "pointerup" }),
    ));
    expect(changes).toHaveBeenCalledTimes(baseline);
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();

    const samples = Array.from({ length: 700 }, (_, index) =>
      pointerEvent(7, 11 + index, 10 + index / 4));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(7, 710, 185, {
        getCoalescedEvents: () => samples,
      }),
    ));
    const livePreview = changes.mock.calls.at(-1)?.[0];
    expect(livePreview?.kind).toBe("pen");
    expect(livePreview?.style).toEqual({
      stroke: "#d33f49",
      strokeWidth: 18,
      opacity: 0.35,
    });
    expect(livePreview?.points.length).toBeLessThanOrEqual(256);
    expect(livePreview?.points[0]).toEqual({ x: 10, y: 10 });
    expect(livePreview?.points.at(-1)).toEqual({ x: 710, y: 184.75 });

    internals.lostPointerCapture({ pointerId: 7 } as PointerEvent);
    expect(internals.activeGesture).toBeNull();
    expect(changes.mock.calls.at(-1)?.[0]).toBeNull();
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("normalizes and caps ctrl-wheel zoom while preserving the pointer anchor", () => {
    const { renderer, internals } = rendererHarness();
    vi.spyOn(internals.stage, "getPointerPosition").mockReturnValue({
      x: 200,
      y: 150,
    });
    renderer.setCamera({ x: 20, y: 10, zoom: 1 });
    const anchor = {
      x: (200 - renderer.camera.x) / renderer.camera.zoom,
      y: (150 - renderer.camera.y) / renderer.camera.zoom,
    };

    const zoomOut = new WheelEvent("wheel", {
      cancelable: true,
      ctrlKey: true,
      deltaMode: 0,
      deltaY: 100,
    });
    internals.onWheel(konvaWheelEvent(internals, zoomOut));
    expect(zoomOut.defaultPrevented).toBe(true);
    expect(renderer.camera.zoom).toBeCloseTo(Math.exp(-0.1));
    expect((200 - renderer.camera.x) / renderer.camera.zoom)
      .toBeCloseTo(anchor.x);
    expect((150 - renderer.camera.y) / renderer.camera.zoom)
      .toBeCloseTo(anchor.y);

    const zoomIn = new WheelEvent("wheel", {
      cancelable: true,
      ctrlKey: true,
      deltaMode: 0,
      deltaY: -100,
    });
    internals.onWheel(konvaWheelEvent(internals, zoomIn));
    expect(renderer.camera.zoom).toBeCloseTo(1);
    expect(renderer.camera.x).toBeCloseTo(20);
    expect(renderer.camera.y).toBeCloseTo(10);

    const lineMode = new WheelEvent("wheel", {
      cancelable: true,
      ctrlKey: true,
      deltaMode: 1,
      deltaY: 10,
    });
    internals.onWheel(konvaWheelEvent(internals, lineMode));
    expect(renderer.camera.zoom).toBeCloseTo(Math.exp(-0.1));

    renderer.setCamera({ x: 20, y: 10, zoom: 20 });
    const highLimitAnchor = {
      x: (200 - renderer.camera.x) / renderer.camera.zoom,
      y: (150 - renderer.camera.y) / renderer.camera.zoom,
    };
    internals.onWheel(konvaWheelEvent(
      internals,
      new WheelEvent("wheel", {
        cancelable: true,
        ctrlKey: true,
        deltaY: -100,
      }),
    ));
    expect(renderer.camera.zoom).toBe(20);
    expect((200 - renderer.camera.x) / renderer.camera.zoom)
      .toBeCloseTo(highLimitAnchor.x);
    expect((150 - renderer.camera.y) / renderer.camera.zoom)
      .toBeCloseTo(highLimitAnchor.y);

    renderer.setCamera({ x: 20, y: 10, zoom: 0.02 });
    const lowLimitAnchor = {
      x: (200 - renderer.camera.x) / renderer.camera.zoom,
      y: (150 - renderer.camera.y) / renderer.camera.zoom,
    };
    internals.onWheel(konvaWheelEvent(
      internals,
      new WheelEvent("wheel", {
        cancelable: true,
        ctrlKey: true,
        deltaY: 100,
      }),
    ));
    expect(renderer.camera.zoom).toBe(0.02);
    expect((200 - renderer.camera.x) / renderer.camera.zoom)
      .toBeCloseTo(lowLimitAnchor.x);
    expect((150 - renderer.camera.y) / renderer.camera.zoom)
      .toBeCloseTo(lowLimitAnchor.y);
    renderer.destroy();
  });

  it("clamps touch pinch to 2%-2000% while preserving its world anchor", () => {
    const { renderer, internals } = rendererHarness();
    const beginPinch = (firstId: number, secondId: number) => {
      internals.onPointerDown(konvaPointerEvent(
        internals,
        "pointerdown",
        pointerEvent(firstId, 100, 100, {
          pointerType: "touch",
          type: "pointerdown",
        }),
      ));
      internals.onPointerDown(konvaPointerEvent(
        internals,
        "pointerdown",
        pointerEvent(secondId, 200, 100, {
          pointerType: "touch",
          type: "pointerdown",
        }),
      ));
      expect(internals.activeGesture?.kind).toBe("pinch");
    };
    const endPinch = (firstId: number, secondId: number, secondX: number) => {
      internals.onPointerUp(konvaPointerEvent(
        internals,
        "pointerup",
        pointerEvent(firstId, 100, 100, {
          buttons: 0,
          pointerType: "touch",
          type: "pointerup",
        }),
      ));
      internals.onPointerUp(konvaPointerEvent(
        internals,
        "pointerup",
        pointerEvent(secondId, secondX, 100, {
          buttons: 0,
          pointerType: "touch",
          type: "pointerup",
        }),
      ));
    };

    beginPinch(211, 212);
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(212, 2_200, 100, { pointerType: "touch" }),
    ));
    expect(renderer.camera.zoom).toBe(20);
    expect((1_150 - renderer.camera.x) / renderer.camera.zoom)
      .toBeCloseTo(150);
    expect((100 - renderer.camera.y) / renderer.camera.zoom)
      .toBeCloseTo(100);
    endPinch(211, 212, 2_200);

    renderer.setCamera({ x: 0, y: 0, zoom: 1 });
    beginPinch(213, 214);
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(214, 101, 100, { pointerType: "touch" }),
    ));
    expect(renderer.camera.zoom).toBe(0.02);
    expect((100.5 - renderer.camera.x) / renderer.camera.zoom)
      .toBeCloseTo(150);
    expect((100 - renderer.camera.y) / renderer.camera.zoom)
      .toBeCloseTo(100);
    endPinch(213, 214, 101);
    renderer.destroy();
  });

  it("ignores wheel between stylus contact and an object drag starting", () => {
    const { renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "stylus-wheel-guard",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [20, 30, 40, 50, 0],
      }),
    ]);
    renderer.setSelection(["stylus-wheel-guard"]);
    vi.spyOn(internals.stage, "getPointerPosition").mockReturnValue({
      x: 30,
      y: 40,
    });

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(206, 30, 40, {
        pointerType: "pen",
        type: "pointerdown",
      }),
      internals.nodes.get("stylus-wheel-guard")!.getChildren()[0],
    ));
    internals.onWheel(konvaWheelEvent(
      internals,
      new WheelEvent("wheel", {
        cancelable: true,
        ctrlKey: true,
        deltaY: -100,
      }),
    ));

    expect(renderer.camera).toEqual({ x: 0, y: 0, zoom: 1 });
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(206, 30, 40, {
        buttons: 0,
        pointerType: "pen",
        type: "pointerup",
      }),
    ));
    renderer.destroy();
  });

  it("keeps one-finger drawing usable and switches two touch pointers to pinch", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("pen");
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(21, 100, 100, {
        pointerType: "touch",
        type: "pointerdown",
      }),
    ));
    expect(internals.activeGesture?.kind).toBe("drawing");

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(22, 200, 100, {
        pointerType: "touch",
        type: "pointerdown",
      }),
    ));
    expect(internals.activeGesture?.kind).toBe("pinch");
    expect(vi.mocked(callbacks.onGesturePreviewChange!).mock.calls.at(-1)?.[0]).toBeNull();

    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(22, 300, 100, { pointerType: "touch" }),
    ));
    expect(renderer.camera.zoom).toBeCloseTo(2);
    expect(renderer.camera.x).toBeCloseTo(-100);
    expect(renderer.camera.y).toBeCloseTo(-100);

    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(21, 100, 100, {
        pointerType: "touch",
        type: "pointerup",
      }),
    ));
    expect(internals.activeGesture).toBeNull();
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();

    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(22, 300, 100, {
        pointerType: "touch",
        type: "pointerup",
      }),
    ));
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(23, 20, 20, {
        pointerType: "touch",
        type: "pointerdown",
      }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(23, 60, 60, { pointerType: "touch" }),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(23, 70, 70, {
        pointerType: "touch",
        type: "pointerup",
      }),
    ));
    expect(callbacks.onCreateObject).toHaveBeenCalledTimes(1);
    renderer.destroy();
  });

  it("cancels a placement click when a second touch starts pinch zoom", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setTool("image");
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(230, 90, 80, {
        pointerType: "touch",
        type: "pointerdown",
      }),
    ));
    expect(internals.activeGesture?.kind).toBe("placement");

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(231, 190, 80, {
        pointerType: "touch",
        type: "pointerdown",
      }),
    ));
    expect(internals.activeGesture?.kind).toBe("pinch");

    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(230, 90, 80, {
        buttons: 0,
        pointerType: "touch",
        type: "pointerup",
      }),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(231, 190, 80, {
        buttons: 0,
        pointerType: "touch",
        type: "pointerup",
      }),
    ));

    expect(callbacks.onPlaceTool).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("cancels an object drag instead of committing it when pinch takes over", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "pinch-drag",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [20, 30, 40, 50, 0],
      }),
    ]);
    renderer.setSelection(["pinch-drag"]);
    const original = internals.nodes.get("pinch-drag")!;

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(24, 30, 40, {
        pointerType: "touch",
        type: "pointerdown",
      }),
      original.getChildren()[0],
    ));
    original.fire("dragstart");
    original.position({ x: 120, y: 130 });
    original.fire("dragmove");

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(25, 200, 100, {
        pointerType: "touch",
        type: "pointerdown",
      }),
    ));

    expect(internals.activeGesture?.kind).toBe("pinch");
    expect(callbacks.onTransformStart).toHaveBeenCalledOnce();
    expect(callbacks.onTransformCancel).toHaveBeenCalledOnce();
    expect(callbacks.onTransformObjects).not.toHaveBeenCalled();
    expect(internals.nodes.get("pinch-drag")?.position())
      .toEqual({ x: 20, y: 30 });
    expect(internals.nodes.get("pinch-drag")?.draggable()).toBe(false);
    expect(internals.transformer.listening()).toBe(false);

    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(25, 200, 100, {
        buttons: 0,
        pointerType: "touch",
        type: "pointerup",
      }),
    ));
    expect(internals.activeGesture).toBeNull();
    expect(internals.nodes.get("pinch-drag")?.draggable()).toBe(true);
    expect(internals.transformer.listening()).toBe(true);
    renderer.destroy();
  });

  it("selects only fully contained mutable objects with a marquee", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "inside",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [10, 10, 20, 20, 0],
        zRank: "b",
      }),
      snapshot({
        id: "boundary",
        kind: BUILTIN_OBJECT_KINDS.text,
        transform: [50, 10, 20, 20, 0],
        zRank: "a",
      }),
      snapshot({
        id: "partial",
        kind: BUILTIN_OBJECT_KINDS.text,
        transform: [60, 60, 20, 20, 0],
      }),
      snapshot({
        id: "future",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        version: 2,
        transform: [35, 35, 20, 20, 0],
      }),
      snapshot({
        id: "outside",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [200, 200, 20, 20, 0],
      }),
    ]);

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(31, 0, 0, { type: "pointerdown" }),
    ));
    expect(internals.activeGesture?.kind).toBe("marquee");
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(31, 70, 70),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(31, 70, 70, { type: "pointerup" }),
    ));

    expect(renderer.selection).toEqual(["boundary", "inside"]);
    expect(vi.mocked(callbacks.onSelectionChange).mock.calls.at(-1)?.[0])
      .toEqual(["boundary", "inside"]);

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(32, 70, 70, { type: "pointerdown" }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(32, 0, 0),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(32, 0, 0, { buttons: 0, type: "pointerup" }),
    ));
    expect(renderer.selection).toEqual(["boundary", "inside"]);
    renderer.destroy();
  });

  it("uses exact touching geometry for a Shift marquee", () => {
    const frames = animationFrameController();
    const { callbacks, renderer, internals } = rendererHarness();
    try {
      renderer.setObjects([
        snapshot({
          id: "base",
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: [200, 200, 10, 10, 0],
          zRank: "a",
        }),
        snapshot({
          id: "fully-contained",
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: [47, 17, 4, 4, 0],
          zRank: "b",
        }),
        snapshot({
          id: "partially-touched",
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: [52, 20, 20, 20, 0],
          zRank: "c",
        }),
        snapshot({
          id: "contains-marquee",
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: [0, 0, 100, 100, 0],
          zRank: "d",
        }),
        snapshot({
          id: "broad-bounds-only",
          kind: BUILTIN_OBJECT_KINDS.line,
          transform: [0, 0, 100, 100, 0],
          zRank: "e",
          props: {
            start: [0, 100],
            control: [50, 0],
            end: [100, 100],
          },
        }),
        snapshot({
          id: "outside",
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: [120, 120, 10, 10, 0],
          zRank: "f",
        }),
      ]);

      internals.onPointerDown(konvaPointerEvent(
        internals,
        "pointerdown",
        pointerEvent(737, 45, 15, { type: "pointerdown" }),
      ));
      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(737, 55, 25),
      ));
      frames.run(internals.activeGesture?.membershipAnimationFrame);
      expect(internals.activeGesture?.previewSelectionIds)
        .toEqual(["fully-contained"]);
      internals.onPointerUp(konvaPointerEvent(
        internals,
        "pointerup",
        pointerEvent(737, 55, 25, { buttons: 0, type: "pointerup" }),
      ));
      expect(renderer.selection).toEqual(["fully-contained"]);

      renderer.setSelection(["base"]);
      vi.mocked(callbacks.onSelectionChange).mockClear();
      internals.onPointerDown(konvaPointerEvent(
        internals,
        "pointerdown",
        pointerEvent(738, 45, 15, {
          shiftKey: true,
          type: "pointerdown",
        }),
      ));
      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(738, 55, 25, { shiftKey: true }),
      ));
      frames.run(internals.activeGesture?.membershipAnimationFrame);

      const previewSelection = internals.activeGesture?.previewSelectionIds ?? [];
      expect(new Set(previewSelection)).toEqual(new Set([
        "base",
        "fully-contained",
        "partially-touched",
        "contains-marquee",
      ]));
      expect(previewSelection).not.toContain("broad-bounds-only");
      expect(previewSelection).not.toContain("outside");
      expect(renderer.selection).toEqual(["base"]);
      expect(callbacks.onSelectionChange).not.toHaveBeenCalled();

      internals.onPointerUp(konvaPointerEvent(
        internals,
        "pointerup",
        pointerEvent(738, 55, 25, {
          buttons: 0,
          shiftKey: true,
          type: "pointerup",
        }),
      ));
      expect(new Set(renderer.selection)).toEqual(new Set(previewSelection));
      expect(new Set(
        vi.mocked(callbacks.onSelectionChange).mock.calls.at(-1)?.[0] ?? [],
      )).toEqual(new Set(previewSelection));
    } finally {
      renderer.destroy();
      frames.restore();
    }
  });

  it("updates live marquee matching when Shift changes without moving", () => {
    const frames = animationFrameController();
    const { callbacks, renderer, internals } = rendererHarness();
    try {
      renderer.setObjects([
        snapshot({
          id: "base",
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: [200, 200, 10, 10, 0],
          zRank: "a",
        }),
        snapshot({
          id: "contained",
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: [10, 10, 10, 10, 0],
          zRank: "b",
        }),
        snapshot({
          id: "partial",
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: [25, 25, 20, 20, 0],
          zRank: "c",
        }),
      ]);
      renderer.setSelection(["base"]);
      vi.mocked(callbacks.onSelectionChange).mockClear();

      internals.onPointerDown(konvaPointerEvent(
        internals,
        "pointerdown",
        pointerEvent(739, 0, 0, { type: "pointerdown" }),
      ));
      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(739, 30, 30),
      ));
      frames.run(internals.activeGesture?.membershipAnimationFrame);
      expect(internals.activeGesture?.previewSelectionIds).toEqual(["contained"]);

      window.dispatchEvent(new KeyboardEvent("keydown", {
        code: "ShiftLeft",
        key: "Shift",
        shiftKey: true,
      }));
      frames.run(internals.activeGesture?.membershipAnimationFrame);
      expect(new Set(internals.activeGesture?.previewSelectionIds))
        .toEqual(new Set(["contained", "partial"]));
      expect(internals.activeGesture?.previewSelectionIds).not.toContain("base");

      window.dispatchEvent(new KeyboardEvent("keyup", {
        code: "ShiftLeft",
        key: "Shift",
      }));
      frames.run(internals.activeGesture?.membershipAnimationFrame);
      expect(internals.activeGesture?.previewSelectionIds).toEqual(["contained"]);
      expect(renderer.selection).toEqual(["base"]);
      expect(callbacks.onSelectionChange).not.toHaveBeenCalled();

      const replacementPreview = [
        ...(internals.activeGesture?.previewSelectionIds ?? []),
      ];
      internals.onPointerUp(konvaPointerEvent(
        internals,
        "pointerup",
        pointerEvent(739, 30, 30, { buttons: 0, type: "pointerup" }),
      ));
      expect(renderer.selection).toEqual(replacementPreview);
      expect(callbacks.onSelectionChange).toHaveBeenLastCalledWith(
        replacementPreview,
      );

      renderer.setSelection(["base"]);
      vi.mocked(callbacks.onSelectionChange).mockClear();
      internals.onPointerDown(konvaPointerEvent(
        internals,
        "pointerdown",
        pointerEvent(740, 0, 0, {
          shiftKey: true,
          type: "pointerdown",
        }),
      ));
      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(740, 30, 30, { shiftKey: true }),
      ));
      frames.run(internals.activeGesture?.membershipAnimationFrame);
      expect(new Set(internals.activeGesture?.previewSelectionIds))
        .toEqual(new Set(["base", "contained", "partial"]));

      window.dispatchEvent(new KeyboardEvent("keyup", {
        code: "ShiftLeft",
        key: "Shift",
      }));
      frames.run(internals.activeGesture?.membershipAnimationFrame);
      expect(new Set(internals.activeGesture?.previewSelectionIds))
        .toEqual(new Set(["base", "contained"]));

      const additivePreview = [
        ...(internals.activeGesture?.previewSelectionIds ?? []),
      ];
      internals.onPointerUp(konvaPointerEvent(
        internals,
        "pointerup",
        pointerEvent(740, 30, 30, { buttons: 0, type: "pointerup" }),
      ));
      expect(new Set(renderer.selection)).toEqual(new Set(additivePreview));
      expect(new Set(
        vi.mocked(callbacks.onSelectionChange).mock.calls.at(-1)?.[0] ?? [],
      )).toEqual(new Set(additivePreview));

      renderer.setSelection([]);
      vi.mocked(callbacks.onSelectionChange).mockClear();
      internals.onPointerDown(konvaPointerEvent(
        internals,
        "pointerdown",
        pointerEvent(741, 0, 0, { type: "pointerdown" }),
      ));
      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(741, 30, 30),
      ));
      frames.run(internals.activeGesture?.membershipAnimationFrame);
      expect(internals.activeGesture?.previewSelectionIds).toEqual(["contained"]);

      window.dispatchEvent(new KeyboardEvent("keydown", {
        code: "ShiftLeft",
        key: "Shift",
        shiftKey: true,
      }));
      const pendingTouchFrame = internals.activeGesture?.membershipAnimationFrame;
      internals.onPointerUp(konvaPointerEvent(
        internals,
        "pointerup",
        pointerEvent(741, 30, 30, {
          buttons: 0,
          shiftKey: true,
          type: "pointerup",
        }),
      ));
      expect(frames.cancel).toHaveBeenCalledWith(pendingTouchFrame);
      expect(new Set(renderer.selection)).toEqual(new Set(["contained", "partial"]));
      expect(new Set(
        vi.mocked(callbacks.onSelectionChange).mock.calls.at(-1)?.[0] ?? [],
      )).toEqual(new Set(["contained", "partial"]));
      window.dispatchEvent(new KeyboardEvent("keyup", {
        code: "ShiftLeft",
        key: "Shift",
      }));
    } finally {
      renderer.destroy();
      frames.restore();
    }
  });

  it("previews marquee containment without publishing selection before release", () => {
    const frames = animationFrameController();
    const { callbacks, renderer, internals } = rendererHarness();
    try {
      renderer.setObjects([
        snapshot({
          id: "previous",
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: [200, 200, 20, 20, 0],
        }),
        snapshot({
          id: "inside",
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: [10, 10, 20, 20, 0],
          zRank: "b",
        }),
        snapshot({
          id: "boundary",
          kind: BUILTIN_OBJECT_KINDS.text,
          transform: [50, 10, 20, 20, 0],
          zRank: "a",
        }),
        snapshot({
          id: "partial",
          kind: BUILTIN_OBJECT_KINDS.text,
          transform: [60, 60, 20, 20, 0],
        }),
      ]);
      renderer.setSelection(["previous"]);
      vi.mocked(callbacks.onSelectionChange).mockClear();

      internals.onPointerDown(konvaPointerEvent(
        internals,
        "pointerdown",
        pointerEvent(731, 0, 0, { type: "pointerdown" }),
      ));
      expect(internals.activeGesture?.previewSelectionIds).toEqual([]);
      expect(internals.transformer.nodes()).toHaveLength(0);

      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(731, 70, 70),
      ));
      frames.run(internals.activeGesture?.membershipAnimationFrame);

      expect(new Set(internals.activeGesture?.previewSelectionIds))
        .toEqual(new Set(["boundary", "inside"]));
      expect([...internals.selectionObjectOutlines.keys()].sort())
        .toEqual(["boundary", "inside"]);
      expect(renderer.selection).toEqual(["previous"]);
      expect(callbacks.onSelectionChange).not.toHaveBeenCalled();

      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(731, 35, 35),
      ));
      frames.run(internals.activeGesture?.membershipAnimationFrame);
      expect(internals.activeGesture?.previewSelectionIds).toEqual(["inside"]);
      expect([...internals.selectionObjectOutlines.keys()]).toEqual(["inside"]);

      internals.onPointerUp(konvaPointerEvent(
        internals,
        "pointerup",
        pointerEvent(731, 35, 35, { buttons: 0, type: "pointerup" }),
      ));
      expect(renderer.selection).toEqual(["inside"]);
      expect(callbacks.onSelectionChange).toHaveBeenCalledOnce();
      expect(callbacks.onSelectionChange).toHaveBeenLastCalledWith(["inside"]);
      expect(internals.activeGesture).toBeNull();
      expect(internals.selectionObjectOutlines.size).toBe(0);
      expect(internals.transformer.nodes()).toEqual([internals.nodes.get("inside")]);
    } finally {
      renderer.destroy();
      frames.restore();
    }
  });

  it("previews additive lasso intersections locally and restores base chrome on cancel", () => {
    const frames = animationFrameController();
    const { callbacks, renderer, internals } = rendererHarness();
    try {
      renderer.setObjects([
        snapshot({
          id: "base",
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: [200, 200, 20, 20, 0],
        }),
        snapshot({
          id: "inside",
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: [10, 10, 10, 10, 0],
          zRank: "a",
        }),
        snapshot({
          id: "touching",
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: [28, 10, 10, 10, 0],
          zRank: "b",
        }),
      ]);
      renderer.setSelection(["base"]);
      vi.mocked(callbacks.onSelectionChange).mockClear();

      internals.onPointerDown(konvaPointerEvent(
        internals,
        "pointerdown",
        pointerEvent(732, 0, 0, {
          altKey: true,
          shiftKey: true,
          type: "pointerdown",
        }),
      ));
      expect(internals.activeGesture?.previewSelectionIds).toEqual(["base"]);
      expect([...internals.selectionObjectOutlines.keys()]).toEqual(["base"]);

      for (const [x, y] of [[30, 0], [30, 30], [0, 30]] as const) {
        internals.onPointerMove(konvaPointerEvent(
          internals,
          "pointermove",
          pointerEvent(732, x, y, { altKey: true, shiftKey: true }),
        ));
      }
      frames.run(internals.activeGesture?.membershipAnimationFrame);
      expect(internals.activeGesture?.previewSelectionIds)
        .toEqual(["base", "inside", "touching"]);
      expect(new Set(internals.selectionObjectOutlines.keys()))
        .toEqual(new Set(["base", "inside", "touching"]));
      expect(renderer.selection).toEqual(["base"]);
      expect(callbacks.onSelectionChange).not.toHaveBeenCalled();

      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(732, 0, 0, { altKey: true, shiftKey: true }),
      ));
      const pendingFrame = internals.activeGesture?.membershipAnimationFrame;
      internals.onPointerUp(konvaPointerEvent(
        internals,
        "pointercancel",
        pointerEvent(732, 0, 0, {
          altKey: true,
          buttons: 0,
          shiftKey: true,
          type: "pointercancel",
        }),
      ));

      expect(frames.cancel).toHaveBeenCalledWith(pendingFrame);
      expect(internals.activeGesture).toBeNull();
      expect(renderer.selection).toEqual(["base"]);
      expect(callbacks.onSelectionChange).not.toHaveBeenCalled();
      expect(internals.selectionObjectOutlines.size).toBe(0);
      expect(internals.transformer.nodes()).toEqual([internals.nodes.get("base")]);
    } finally {
      renderer.destroy();
      frames.restore();
    }
  });

  it("recomputes live marquee membership while Ctrl moves the unfinished area", () => {
    const frames = animationFrameController();
    const { callbacks, renderer, internals } = rendererHarness();
    try {
      renderer.setObjects([
        snapshot({
          id: "left",
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: [10, 10, 10, 10, 0],
        }),
        snapshot({
          id: "right",
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: [110, 10, 10, 10, 0],
        }),
      ]);
      vi.mocked(callbacks.onSelectionChange).mockClear();

      internals.onPointerDown(konvaPointerEvent(
        internals,
        "pointerdown",
        pointerEvent(733, 0, 0, { type: "pointerdown" }),
      ));
      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(733, 30, 30),
      ));
      frames.run(internals.activeGesture?.membershipAnimationFrame);
      expect(internals.activeGesture?.previewSelectionIds).toEqual(["left"]);

      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Control",
        ctrlKey: true,
      }));
      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(733, 130, 30, { ctrlKey: true }),
      ));
      frames.run(internals.activeGesture?.membershipAnimationFrame);
      expect(internals.activeGesture?.offset).toEqual({ x: 100, y: 0 });
      expect(internals.activeGesture?.previewSelectionIds).toEqual(["right"]);
      expect([...internals.selectionObjectOutlines.keys()]).toEqual(["right"]);
      expect(renderer.selection).toEqual([]);
      expect(callbacks.onSelectionChange).not.toHaveBeenCalled();

      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
      internals.onPointerUp(konvaPointerEvent(
        internals,
        "pointerup",
        pointerEvent(733, 130, 30, { buttons: 0, type: "pointerup" }),
      ));
      expect(renderer.selection).toEqual(["right"]);
      expect(callbacks.onSelectionChange).toHaveBeenCalledOnce();
    } finally {
      renderer.destroy();
      frames.restore();
    }
  });

  it("refreshes live selection geometry when setObject keeps the same candidate", () => {
    const frames = animationFrameController();
    const { callbacks, renderer, internals } = rendererHarness();
    try {
      renderer.setObjects([
        snapshot({
          id: "restyled-candidate",
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: [10, 10, 20, 20, 0],
        }),
      ]);
      vi.mocked(callbacks.onSelectionChange).mockClear();

      internals.onPointerDown(konvaPointerEvent(
        internals,
        "pointerdown",
        pointerEvent(734, 0, 0, { type: "pointerdown" }),
      ));
      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(734, 200, 200),
      ));
      frames.run(internals.activeGesture?.membershipAnimationFrame);

      expect(internals.activeGesture?.previewSelectionIds)
        .toEqual(["restyled-candidate"]);
      const originalNode = internals.nodes.get("restyled-candidate")!;
      const outline = internals.selectionObjectOutlines.get("restyled-candidate")!;
      const originalPoints = [...outline.points()];
      expect(originalPoints).toEqual(expectedSelectionOutlinePoints(originalNode));

      renderer.setObject(snapshot({
        id: "restyled-candidate",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [70, 60, 50, 30, Math.PI / 8],
      }));
      frames.run(internals.activeGesture?.membershipAnimationFrame);

      const replacementNode = internals.nodes.get("restyled-candidate")!;
      expect(replacementNode).not.toBe(originalNode);
      expect(internals.activeGesture?.previewSelectionIds)
        .toEqual(["restyled-candidate"]);
      expect(internals.selectionObjectOutlines.get("restyled-candidate"))
        .toBe(outline);
      expect(outline.points()).toEqual(expectedSelectionOutlinePoints(replacementNode));
      expect(outline.points()).not.toEqual(originalPoints);
      expect(renderer.selection).toEqual([]);
      expect(callbacks.onSelectionChange).not.toHaveBeenCalled();
    } finally {
      renderer.destroy();
      frames.restore();
    }
  });

  it("recomputes live membership after setObjects without pointer movement", () => {
    const frames = animationFrameController();
    const { callbacks, renderer, internals } = rendererHarness();
    try {
      renderer.setObjects([
        snapshot({
          id: "initial-candidate",
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: [10, 10, 20, 20, 0],
        }),
      ]);
      vi.mocked(callbacks.onSelectionChange).mockClear();

      internals.onPointerDown(konvaPointerEvent(
        internals,
        "pointerdown",
        pointerEvent(735, 0, 0, { type: "pointerdown" }),
      ));
      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(735, 100, 100),
      ));
      frames.run(internals.activeGesture?.membershipAnimationFrame);
      expect(internals.activeGesture?.previewSelectionIds)
        .toEqual(["initial-candidate"]);

      renderer.setObjects([
        snapshot({
          id: "initial-candidate",
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: [200, 200, 20, 20, 0],
        }),
        snapshot({
          id: "replacement-candidate",
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: [30, 30, 20, 20, 0],
        }),
      ]);
      frames.run(internals.activeGesture?.membershipAnimationFrame);

      expect(internals.activeGesture?.previewSelectionIds)
        .toEqual(["replacement-candidate"]);
      expect([...internals.selectionObjectOutlines.keys()])
        .toEqual(["replacement-candidate"]);
      expect(renderer.selection).toEqual([]);
      expect(callbacks.onSelectionChange).not.toHaveBeenCalled();
    } finally {
      renderer.destroy();
      frames.restore();
    }
  });

  it("switches live selection chrome from 512 outlines to aggregate-only at 513", () => {
    const frames = animationFrameController();
    const { callbacks, renderer, internals } = rendererHarness();
    try {
      const objects = Array.from(
        { length: MAX_LOCAL_SELECTION_OUTLINES + 1 },
        (_, index) => snapshot({
          id: `live-budget-${index}`,
          kind: BUILTIN_OBJECT_KINDS.rectangle,
          transform: index < MAX_LOCAL_SELECTION_OUTLINES
            ? [
                10 + (index % 32) * 8,
                10 + Math.floor(index / 32) * 8,
                4,
                4,
                0,
              ]
            : [10, 180, 4, 4, 0],
          zRank: `b${index.toString().padStart(4, "0")}`,
        }),
      );
      renderer.setObjects(objects);
      expect(internals.nodes.size).toBe(objects.length);
      vi.mocked(callbacks.onSelectionChange).mockClear();

      internals.onPointerDown(konvaPointerEvent(
        internals,
        "pointerdown",
        pointerEvent(736, 0, 0, { type: "pointerdown" }),
      ));
      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(736, 270, 150),
      ));
      frames.run(internals.activeGesture?.membershipAnimationFrame);

      expect(internals.activeGesture?.previewSelectionIds)
        .toHaveLength(MAX_LOCAL_SELECTION_OUTLINES);
      expect(internals.selectionObjectOutlines.size)
        .toBe(MAX_LOCAL_SELECTION_OUTLINES);
      expect(internals.selectionOutline.visible()).toBe(false);

      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(736, 270, 190),
      ));
      frames.run(internals.activeGesture?.membershipAnimationFrame);

      expect(internals.activeGesture?.previewSelectionIds)
        .toHaveLength(MAX_LOCAL_SELECTION_OUTLINES + 1);
      expect(internals.selectionObjectOutlines.size).toBe(0);
      expect(internals.selectionOutline.visible()).toBe(true);
      expect(internals.transformer.nodes()).toHaveLength(0);
      expect(renderer.selection).toEqual([]);
      expect(callbacks.onSelectionChange).not.toHaveBeenCalled();
    } finally {
      renderer.destroy();
      frames.restore();
    }
  });

  it("uses Shift click to toggle individual objects in the selection", () => {
    const { renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "first",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [10, 10, 40, 40, 0],
        props: {},
      }),
      snapshot({
        id: "second",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [80, 10, 40, 40, 0],
        props: {},
      }),
    ]);
    renderer.setSelection(["first"]);

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(61, 90, 20, {
        shiftKey: true,
        type: "pointerdown",
      }),
      internals.nodes.get("second")!.getChildren()[0],
    ));
    expect(renderer.selection).toEqual(["first", "second"]);

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(62, 20, 20, {
        shiftKey: true,
        type: "pointerdown",
      }),
      internals.nodes.get("first")!.getChildren()[0],
    ));
    expect(renderer.selection).toEqual(["second"]);
    renderer.destroy();
  });

  it("starts canvas selection through objects when Ctrl or Cmd is held", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "first",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [10, 10, 40, 40, 0],
      }),
      snapshot({
        id: "second",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [80, 10, 40, 40, 0],
      }),
    ]);
    renderer.setSelection(["first"]);
    const firstNode = internals.nodes.get("first")!;
    expect(firstNode.draggable()).toBe(true);

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(63, 20, 20, {
        ctrlKey: true,
        type: "pointerdown",
      }),
      firstNode.getChildren()[0],
    ));
    expect(internals.activeGesture?.kind).toBe("marquee");
    expect(internals.activeGesture?.commandMoveArmed).toBe(false);
    expect(internals.activeGesture?.commandMoveActive).toBe(false);
    expect(renderer.selection).toEqual(["first"]);
    expect(firstNode.draggable()).toBe(false);
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(63, 20, 20, {
        buttons: 0,
        ctrlKey: true,
        type: "pointerup",
      }),
      firstNode.getChildren()[0],
    ));
    expect(renderer.selection).toEqual([]);
    expect(callbacks.onTransformObjects).not.toHaveBeenCalled();

    renderer.setSelection(["first"]);
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(64, 90, 20, {
        metaKey: true,
        shiftKey: true,
        type: "pointerdown",
      }),
      internals.nodes.get("second")!.getChildren()[0],
    ));
    expect(internals.activeGesture?.kind).toBe("marquee");
    expect(internals.activeGesture?.commandMoveArmed).toBe(false);
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(64, 90, 20, {
        buttons: 0,
        metaKey: true,
        shiftKey: true,
        type: "pointerup",
      }),
    ));
    expect(renderer.selection).toEqual(["first"]);
    expect(internals.nodes.get("first")?.draggable()).toBe(true);
    renderer.destroy();
  });

  it("suspends Transformer input for forced area selection and restores it on cancel", () => {
    const { renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "selected",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [20, 20, 80, 60, 0],
      }),
    ]);
    renderer.setSelection(["selected"]);
    const selected = internals.nodes.get("selected")!;
    const anchor = internals.transformer.findOne(".top-left")!;

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(642, 20, 20, { type: "pointerdown" }),
      anchor,
    ));
    expect(internals.activeGesture).toBeNull();
    expect(internals.transformer.listening()).toBe(true);
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(642, 20, 20, {
        buttons: 0,
        type: "pointerup",
      }),
      anchor,
    ));

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(643, 20, 20, {
        altKey: true,
        type: "pointerdown",
      }),
      anchor,
    ));
    expect(internals.activeGesture?.kind).toBe("lasso");
    expect(internals.transformer.listening()).toBe(false);
    expect(selected.draggable()).toBe(false);

    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointercancel",
      pointerEvent(643, 20, 20, {
        altKey: true,
        buttons: 0,
        type: "pointercancel",
      }),
      anchor,
    ));
    expect(internals.activeGesture).toBeNull();
    expect(internals.transformer.listening()).toBe(true);
    expect(selected.draggable()).toBe(true);
    renderer.destroy();
  });

  it("does not treat AltGraph as the Select lasso modifier", () => {
    const { renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "clicked",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [10, 10, 40, 40, 0],
      }),
    ]);
    const target = internals.nodes.get("clicked")!.getChildren()[0];

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(644, 20, 20, {
        altKey: true,
        getModifierState: (key: string) => key === "AltGraph",
        type: "pointerdown",
      }),
      target,
    ));

    expect(internals.activeGesture).toBeNull();
    expect(renderer.selection).toEqual(["clicked"]);
    renderer.destroy();
  });

  it("treats a stationary forced-canvas click as empty at high zoom", () => {
    const { renderer, internals } = rendererHarness();
    renderer.setCamera({ x: 0, y: 0, zoom: 20 });
    renderer.setObjects([
      snapshot({
        id: "under-click",
        kind: BUILTIN_OBJECT_KINDS.text,
        transform: [0, 0, 1, 1, 0],
      }),
      snapshot({
        id: "previous",
        kind: BUILTIN_OBJECT_KINDS.text,
        transform: [20, 20, 10, 10, 0],
      }),
    ]);
    renderer.setSelection(["previous"]);

    const target = internals.nodes.get("under-click")!.getChildren()[0];
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(641, 0, 0, {
        ctrlKey: true,
        type: "pointerdown",
      }),
      target,
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(641, 0, 0, {
        buttons: 0,
        ctrlKey: true,
        type: "pointerup",
      }),
      target,
    ));

    expect(renderer.selection).toEqual([]);
    renderer.destroy();
  });

  it("moves an active marquee only after an initial Ctrl is released and pressed again", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "translated-hit",
        kind: BUILTIN_OBJECT_KINDS.text,
        transform: [40, 30, 10, 10, 0],
      }),
    ]);
    vi.mocked(callbacks.onCameraChange).mockClear();

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(65, 0, 0, {
        ctrlKey: true,
        type: "pointerdown",
      }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(65, 40, 40, { ctrlKey: true }),
    ));
    expect(internals.activeGesture?.end).toEqual({ x: 40, y: 40 });
    expect(internals.activeGesture?.offset).toEqual({ x: 0, y: 0 });
    expect(internals.activeGesture?.commandMoveArmed).toBe(false);

    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    expect(internals.activeGesture?.commandMoveArmed).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Control",
      ctrlKey: true,
    }));
    expect(internals.activeGesture?.commandMoveActive).toBe(true);
    expect(renderer.element.style.cursor).toBe("grabbing");
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(65, 60, 50, { ctrlKey: true }),
    ));
    expect(internals.activeGesture?.end).toEqual({ x: 40, y: 40 });
    expect(internals.activeGesture?.offset).toEqual({ x: 20, y: 10 });

    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(65, 80, 60),
    ));
    expect(internals.activeGesture?.end).toEqual({ x: 60, y: 50 });
    const preview = internals.activeGesture?.preview as Konva.Rect;
    expect(preview.getAttrs()).toMatchObject({
      x: 20,
      y: 10,
      width: 60,
      height: 50,
    });

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Control",
      ctrlKey: true,
    }));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(65, 90, 70, {
        buttons: 0,
        ctrlKey: true,
        type: "pointerup",
      }),
    ));
    expect(renderer.selection).toEqual(["translated-hit"]);
    expect(renderer.camera).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(callbacks.onCameraChange).not.toHaveBeenCalled();
    expect(renderer.element.style.cursor).toBe("default");
    renderer.destroy();
  });

  it("arms initial Ctrl movement from pointer modifier transitions alone", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    vi.mocked(callbacks.onCameraChange).mockClear();

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(645, 0, 0, {
        ctrlKey: true,
        type: "pointerdown",
      }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(645, 20, 20, { ctrlKey: true }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(645, 30, 30),
    ));
    expect(internals.activeGesture?.commandMoveArmed).toBe(true);
    expect(internals.activeGesture?.end).toEqual({ x: 30, y: 30 });

    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(645, 40, 50, { ctrlKey: true }),
    ));
    expect(internals.activeGesture?.end).toEqual({ x: 30, y: 30 });
    expect(internals.activeGesture?.offset).toEqual({ x: 10, y: 20 });
    expect(callbacks.onCameraChange).not.toHaveBeenCalled();
    renderer.cancelInteraction();
    renderer.destroy();
  });

  it("converts selection-area movement from screen pixels at the current zoom", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setCamera({ x: 0, y: 0, zoom: 2 });
    vi.mocked(callbacks.onCameraChange).mockClear();

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(651, 0, 0, { type: "pointerdown" }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(651, 20, 20),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(651, 40, 60, { ctrlKey: true }),
    ));

    expect(internals.activeGesture?.end).toEqual({ x: 10, y: 10 });
    expect(internals.activeGesture?.offset).toEqual({ x: 10, y: 20 });
    expect(renderer.camera).toEqual({ x: 0, y: 0, zoom: 2 });
    expect(callbacks.onCameraChange).not.toHaveBeenCalled();
    renderer.cancelInteraction();
    renderer.destroy();
  });

  it("unions Shift-lasso matches with the pointer-down selection", () => {
    const { renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "base",
        kind: BUILTIN_OBJECT_KINDS.text,
        transform: [200, 200, 10, 10, 0],
      }),
      snapshot({
        id: "lasso-hit",
        kind: BUILTIN_OBJECT_KINDS.text,
        transform: [10, 10, 10, 10, 0],
      }),
    ]);
    renderer.setSelection(["base"]);

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(652, 0, 0, {
        altKey: true,
        shiftKey: true,
        type: "pointerdown",
      }),
    ));
    for (const [x, y] of [
      [30, 0],
      [30, 30],
      [0, 30],
    ] as const) {
      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(652, x, y),
      ));
    }
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(652, 0, 0, {
        altKey: true,
        shiftKey: true,
        buttons: 0,
        type: "pointerup",
      }),
    ));
    expect(renderer.selection).toEqual(["base", "lasso-hit"]);
    renderer.destroy();
  });

  it("creates an Alt lasso through object hits and selects any touched geometry", () => {
    const { renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "under-start",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [5, 5, 10, 10, 0],
      }),
      snapshot({
        id: "inside-lower",
        kind: BUILTIN_OBJECT_KINDS.text,
        transform: [10, 60, 10, 10, 0],
      }),
      snapshot({
        id: "cross-boundary",
        kind: BUILTIN_OBJECT_KINDS.text,
        transform: [35, 55, 10, 10, 0],
      }),
      snapshot({
        id: "outside-notch",
        kind: BUILTIN_OBJECT_KINDS.text,
        transform: [60, 60, 10, 10, 0],
      }),
      snapshot({
        id: "future",
        kind: BUILTIN_OBJECT_KINDS.text,
        version: 2,
        transform: [20, 20, 10, 10, 0],
      }),
    ]);
    renderer.setSelection(["outside-notch"]);

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(66, 5, 5, {
        altKey: true,
        type: "pointerdown",
      }),
      internals.nodes.get("under-start")!.getChildren()[0],
    ));
    expect(internals.activeGesture?.kind).toBe("lasso");
    expect(renderer.selection).toEqual(["outside-notch"]);
    for (const [x, y] of [
      [100, 5],
      [100, 40],
      [40, 40],
      [40, 100],
      [5, 100],
    ] as const) {
      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(66, x, y),
      ));
    }
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(66, 5, 5, {
        altKey: true,
        buttons: 0,
        type: "pointerup",
      }),
    ));

    expect(renderer.selection).toEqual([
      "cross-boundary",
      "inside-lower",
      "under-start",
    ]);
    renderer.destroy();
  });

  it.each([
    ["touch", "marquee"],
    ["pen", "lasso"],
  ] as const)("supports %s %s selection gestures", (pointerType, mode) => {
    const { renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: `${pointerType}-selected`,
        kind: BUILTIN_OBJECT_KINDS.text,
        transform: [10, 10, 10, 10, 0],
      }),
    ]);
    const lasso = mode === "lasso";
    const modifiers = lasso
      ? { altKey: true, ctrlKey: true }
      : {};

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(646, 0, 0, {
        ...modifiers,
        pointerType,
        type: "pointerdown",
      }),
    ));
    expect(internals.activeGesture?.kind).toBe(mode);
    if (lasso) {
      expect(internals.activeGesture?.commandMoveArmed).toBe(false);
    }
    const path = lasso
      ? [[30, 0], [30, 30], [0, 30]] as const
      : [[30, 30]] as const;
    for (const [x, y] of path) {
      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(646, x, y, {
          ...modifiers,
          pointerType,
        }),
      ));
    }
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(646, lasso ? 0 : 30, lasso ? 0 : 30, {
        ...modifiers,
        buttons: 0,
        pointerType,
        type: "pointerup",
      }),
    ));

    expect(renderer.selection).toEqual([`${pointerType}-selected`]);
    renderer.destroy();
  });

  it("moves an unfinished lasso with Ctrl and resumes from its translated endpoint", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "inside-moved-lasso",
        kind: BUILTIN_OBJECT_KINDS.text,
        transform: [15, 15, 5, 5, 0],
      }),
    ]);
    vi.mocked(callbacks.onCameraChange).mockClear();

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(67, 0, 0, {
        altKey: true,
        type: "pointerdown",
      }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(67, 20, 0),
    ));
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Control",
      ctrlKey: true,
    }));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(67, 30, 10, { ctrlKey: true }),
    ));
    expect(internals.activeGesture?.offset).toEqual({ x: 10, y: 10 });
    expect((internals.activeGesture?.preview as Konva.Line).position())
      .toEqual({ x: 10, y: 10 });

    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(67, 30, 30),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(67, 10, 30),
    ));
    expect(internals.activeGesture?.previewPoints).toEqual([
      0, 0,
      20, 0,
      20, 20,
      0, 20,
    ]);
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(67, 10, 10, {
        buttons: 0,
        type: "pointerup",
      }),
    ));

    expect(renderer.selection).toEqual(["inside-moved-lasso"]);
    expect(renderer.camera).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(callbacks.onCameraChange).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("reblocks Ctrl movement for each compatibility-mouse selection gesture", () => {
    const { renderer, internals } = rendererHarness();

    const startGesture = (pointerId: number) => {
      internals.onPointerDown(konvaPointerEvent(
        internals,
        "pointerdown",
        pointerEvent(pointerId, 0, 0, {
          ctrlKey: true,
          type: "pointerdown",
        }),
      ));
      window.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        buttons: 1,
        cancelable: true,
        clientX: 40,
        clientY: 40,
        ctrlKey: true,
      }));
      expect(internals.activeGesture?.end).toEqual({ x: 40, y: 40 });
      expect(internals.activeGesture?.offset).toEqual({ x: 0, y: 0 });
    };

    startGesture(68);
    window.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true,
      button: 0,
      buttons: 0,
      cancelable: true,
      clientX: 40,
      clientY: 40,
      ctrlKey: true,
    }));
    expect(internals.activeGesture).toBeNull();

    startGesture(69);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Control",
      ctrlKey: true,
    }));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      buttons: 1,
      cancelable: true,
      clientX: 60,
      clientY: 50,
      ctrlKey: true,
    }));
    expect(internals.activeGesture?.end).toEqual({ x: 40, y: 40 });
    expect(internals.activeGesture?.offset).toEqual({ x: 20, y: 10 });
    renderer.cancelInteraction();
    expect(internals.activeGesture).toBeNull();
    renderer.destroy();
  });

  it("scopes the Space hand shortcut to the focused board and ignores controls", () => {
    const { renderer, root } = rendererHarness();
    const outsideButton = document.createElement("button");
    document.body.append(outsideButton);
    outsideButton.focus();
    const outsideSpace = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Space",
    });
    outsideButton.dispatchEvent(outsideSpace);
    expect(renderer.element.style.cursor).toBe("default");
    expect(outsideSpace.defaultPrevented).toBe(false);

    const toolbarButton = document.createElement("button");
    root.append(toolbarButton);
    toolbarButton.focus();
    toolbarButton.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Space",
    }));
    expect(renderer.element.style.cursor).toBe("default");

    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const menuItem = document.createElement("div");
    menuItem.tabIndex = 0;
    menu.append(menuItem);
    root.append(menu);
    menuItem.focus();
    const menuSpace = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Space",
    });
    menuItem.dispatchEvent(menuSpace);
    expect(renderer.element.style.cursor).toBe("default");
    expect(menuSpace.defaultPrevented).toBe(false);

    root.focus();
    const boardSpace = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Space",
    });
    root.dispatchEvent(boardSpace);
    expect(renderer.element.style.cursor).toBe("grab");
    expect(boardSpace.defaultPrevented).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(renderer.element.style.cursor).toBe("default");

    root.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Space",
    }));
    expect(renderer.element.style.cursor).toBe("grab");
    root.dispatchEvent(new KeyboardEvent("keyup", {
      bubbles: true,
      code: "Space",
    }));
    expect(renderer.element.style.cursor).toBe("default");
    renderer.destroy();
  });

  it("cancels draft and drag interactions without emitting durable changes", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "dragged",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [20, 30, 40, 50, 0],
        props: {},
      }),
    ]);
    renderer.setSelection(["dragged"]);
    const dragged = internals.nodes.get("dragged")!;
    dragged.fire("dragstart");
    dragged.position({ x: 120, y: 130 });

    renderer.cancelInteraction();

    expect(callbacks.onTransformObjects).not.toHaveBeenCalled();
    expect(callbacks.onTransformCancel).toHaveBeenCalledOnce();
    expect(internals.nodes.get("dragged")!.position()).toEqual({ x: 20, y: 30 });

    renderer.setTool("line");
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(71, 10, 10, { type: "pointerdown" }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(71, 120, 80),
    ));
    renderer.cancelInteraction();

    expect(internals.activeGesture).toBeNull();
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("marks every crossed mutable object and commits one delete callback on release", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "left",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [0, 0, 40, 40, 0],
        style: { opacity: 0.5 },
      }),
      snapshot({
        id: "right",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [60, 0, 40, 40, 0],
      }),
    ]);
    const left = internals.nodes.get("left")!;
    const right = internals.nodes.get("right")!;
    const pointHitSpy = vi.spyOn(internals.stage, "getIntersection");
    renderer.setTool("eraser");

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(41, 10, 20, { type: "pointerdown" }),
    ));
    const completedTrail = internals.activeGesture?.trail;
    expect(completedTrail?.getParent()).toBe(internals.interactionScreen);
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(41, 90, 20),
    ));
    expect(left.visible()).toBe(true);
    expect(right.visible()).toBe(true);
    expect(left.opacity()).toBeCloseTo(0.12);
    expect(right.opacity()).toBeCloseTo(0.24);
    expect(callbacks.onDeleteObjects).not.toHaveBeenCalled();
    expect(callbacks.onCreateObject).not.toHaveBeenCalled();
    expect(callbacks.onGesturePreviewChange).not.toHaveBeenCalled();
    expect(pointHitSpy).not.toHaveBeenCalled();
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(41, 90, 20, { type: "pointerup" }),
    ));
    expect(callbacks.onDeleteObjects).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callbacks.onDeleteObjects).mock.calls[0][0]).toEqual(["left", "right"]);
    expect(left.visible()).toBe(true);
    expect(right.visible()).toBe(true);
    expect(left.opacity()).toBe(0.5);
    expect(right.opacity()).toBe(1);
    expect(completedTrail?.getParent()).toBeNull();

    vi.mocked(callbacks.onDeleteObjects).mockClear();
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(42, 10, 20, { type: "pointerdown" }),
    ));
    const cancelledTrail = internals.activeGesture?.trail;
    expect(left.visible()).toBe(true);
    expect(left.opacity()).toBeCloseTo(0.12);
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointercancel",
      pointerEvent(42, 10, 20, { type: "pointercancel" }),
    ));
    expect(left.visible()).toBe(true);
    expect(left.opacity()).toBe(0.5);
    expect(callbacks.onDeleteObjects).not.toHaveBeenCalled();
    expect(internals.activeGesture).toBeNull();
    expect(cancelledTrail?.getParent()).toBeNull();

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(43, 10, 20, { type: "pointerdown" }),
    ));
    const captureLostTrail = internals.activeGesture?.trail;
    expect(left.visible()).toBe(true);
    expect(left.opacity()).toBeCloseTo(0.12);
    internals.lostPointerCapture(pointerEvent(43, 10, 20, {
      type: "lostpointercapture",
    }));
    expect(internals.activeGesture).toBeNull();
    expect(left.visible()).toBe(true);
    expect(left.opacity()).toBe(0.5);
    expect(captureLostTrail?.getParent()).toBeNull();
    expect(callbacks.onDeleteObjects).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("uses Alt to restore only pending objects without toggling unmarked ones", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "left",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [0, 0, 40, 40, 0],
      }),
      snapshot({
        id: "right",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [60, 0, 40, 40, 0],
      }),
    ]);
    const left = internals.nodes.get("left")!;
    const right = internals.nodes.get("right")!;
    renderer.setTool("eraser");

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(44, 10, 20, { type: "pointerdown" }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(44, 90, 20),
    ));
    expect(left.opacity()).toBeCloseTo(0.24);
    expect(right.opacity()).toBeCloseTo(0.24);

    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(44, 90, 20, { altKey: true }),
    ));
    expect(left.opacity()).toBeCloseTo(0.24);
    expect(right.opacity()).toBe(1);

    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(44, 90, 20, {
        altKey: false,
        type: "pointerup",
      }),
    ));
    expect(callbacks.onDeleteObjects).toHaveBeenCalledOnce();
    expect(vi.mocked(callbacks.onDeleteObjects).mock.calls[0][0])
      .toEqual(["left"]);
    expect(left.opacity()).toBe(1);
    expect(right.opacity()).toBe(1);

    vi.mocked(callbacks.onDeleteObjects).mockClear();
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(45, 90, 20, {
        altKey: true,
        type: "pointerdown",
      }),
    ));
    expect(right.opacity()).toBe(1);
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(45, 90, 20, {
        altKey: false,
        type: "pointerup",
      }),
    ));
    expect(callbacks.onDeleteObjects).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("can re-mark an Alt-restored object without compounding its preview opacity", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "restorable",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [0, 0, 40, 40, 0],
        style: { opacity: 0.5 },
      }),
    ]);
    const object = internals.nodes.get("restorable")!;
    renderer.setTool("eraser");

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(46, 20, 20, { type: "pointerdown" }),
    ));
    expect(object.opacity()).toBeCloseTo(0.12);

    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(46, 20, 20, {
        getCoalescedEvents: () => [
          pointerEvent(46, 20, 20),
          pointerEvent(46, 20, 20),
          pointerEvent(46, 20, 20),
        ],
      }),
    ));
    expect(object.opacity()).toBeCloseTo(0.12);

    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(46, 20, 20, { altKey: true }),
    ));
    expect(object.opacity()).toBe(0.5);

    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(46, 20, 20),
    ));
    expect(object.opacity()).toBeCloseTo(0.12);

    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(46, 20, 20, { altKey: true }),
    ));
    expect(object.opacity()).toBe(0.5);

    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(46, 20, 20, {
        altKey: false,
        type: "pointerup",
      }),
    ));
    expect(callbacks.onDeleteObjects).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("derives a pending preview from the latest object opacity", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "restyled",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [0, 0, 40, 40, 0],
        style: { opacity: 0.5 },
      }),
    ]);
    renderer.setTool("eraser");
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(47, 20, 20, { type: "pointerdown" }),
    ));
    expect(internals.nodes.get("restyled")?.opacity()).toBeCloseTo(0.12);

    renderer.setObject(snapshot({
      id: "restyled",
      kind: BUILTIN_OBJECT_KINDS.rectangle,
      transform: [0, 0, 40, 40, 0],
      style: { opacity: 0.8 },
    }));
    expect(internals.nodes.get("restyled")?.opacity()).toBeCloseTo(0.192);

    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(47, 20, 20, { altKey: true }),
    ));
    expect(internals.nodes.get("restyled")?.opacity()).toBe(0.8);
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(47, 20, 20, {
        altKey: false,
        type: "pointerup",
      }),
    ));
    expect(callbacks.onDeleteObjects).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("excludes remotely removed and newly unsupported objects from an erase commit", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "unsupported",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [0, 0, 40, 40, 0],
      }),
      snapshot({
        id: "removed",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [60, 0, 40, 40, 0],
      }),
      snapshot({
        id: "remaining",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [120, 0, 40, 40, 0],
      }),
    ]);
    renderer.setTool("eraser");
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(48, 10, 20, { type: "pointerdown" }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(48, 150, 20),
    ));
    expect(internals.nodes.get("unsupported")?.opacity()).toBeCloseTo(0.24);
    expect(internals.nodes.get("removed")?.opacity()).toBeCloseTo(0.24);
    expect(internals.nodes.get("remaining")?.opacity()).toBeCloseTo(0.24);

    renderer.setObject(snapshot({
      id: "unsupported",
      kind: BUILTIN_OBJECT_KINDS.rectangle,
      version: 2,
      transform: [0, 0, 40, 40, 0],
    }));
    renderer.deleteObject("removed");

    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(48, 150, 20, { type: "pointerup" }),
    ));
    expect(callbacks.onDeleteObjects).toHaveBeenCalledOnce();
    expect(vi.mocked(callbacks.onDeleteObjects).mock.calls[0][0])
      .toEqual(["remaining"]);
    expect(internals.nodes.get("remaining")?.opacity()).toBe(1);
    renderer.destroy();
  });

  it.each([
    ["tool change", (renderer: KonvaBoardRenderer) => renderer.setTool("select")],
    ["read-only transition", (renderer: KonvaBoardRenderer) => renderer.setReadOnly(true)],
    ["window blur", () => window.dispatchEvent(new Event("blur"))],
    ["renderer destruction", (renderer: KonvaBoardRenderer) => renderer.destroy()],
  ])("restores pending eraser opacity on %s", (_name, cancel) => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "cancelled",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [0, 0, 40, 40, 0],
        style: { opacity: 0.5 },
      }),
    ]);
    const object = internals.nodes.get("cancelled")!;
    renderer.setTool("eraser");
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(49, 20, 20, { type: "pointerdown" }),
    ));
    expect(object.opacity()).toBeCloseTo(0.12);

    cancel(renderer);

    expect(object.opacity()).toBe(0.5);
    expect(internals.activeGesture).toBeNull();
    expect(callbacks.onDeleteObjects).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("continuously erases a subpixel line during a sparse low-zoom move", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setCamera({ x: 0, y: 0, zoom: 0.02 });
    renderer.setObjects([
      snapshot({
        id: "crossed",
        kind: BUILTIN_OBJECT_KINDS.line,
        transform: [2_500, 1_000, 1, 3_000, 0],
        style: { strokeWidth: 0.5 },
        props: { start: [0, 0], end: [0, 3_000] },
      }),
      snapshot({
        id: "near-miss",
        kind: BUILTIN_OBJECT_KINDS.line,
        transform: [1_000, 3_200, 3_000, 1, 0],
        style: { strokeWidth: 0.5 },
        props: { start: [0, 0], end: [3_000, 0] },
      }),
    ]);
    const pointHitSpy = vi.spyOn(internals.stage, "getIntersection")
      .mockReturnValue(null);
    renderer.setTool("eraser");

    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(51, 20, 50, { type: "pointerdown" }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(51, 80, 50, {
        getCoalescedEvents: () => [],
      }),
    ));

    expect(internals.nodes.get("crossed")?.visible()).toBe(true);
    expect(internals.nodes.get("crossed")?.opacity()).toBeCloseTo(0.24);
    expect(internals.nodes.get("near-miss")?.visible()).toBe(true);
    expect(internals.nodes.get("near-miss")?.opacity()).toBe(1);
    expect(pointHitSpy).not.toHaveBeenCalled();
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(51, 80, 50, { type: "pointerup" }),
    ));
    expect(callbacks.onDeleteObjects).toHaveBeenCalledOnce();
    expect(vi.mocked(callbacks.onDeleteObjects).mock.calls[0][0])
      .toEqual(["crossed"]);
    renderer.destroy();
  });

  it("does not decode or index unsupported future objects for erasing", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "future-stroke",
        kind: BUILTIN_OBJECT_KINDS.stroke,
        version: 2,
        transform: [0, 0, 100, 100, 0],
        props: {
          points: new Uint8Array(2_000_000),
        },
      }),
    ]);

    expect(internals.eraserHits.search({
      start: { x: 0, y: 50 },
      end: { x: 100, y: 50 },
      radius: 12,
    })).toEqual([]);

    renderer.setObject(snapshot({
      id: "future-stroke",
      kind: BUILTIN_OBJECT_KINDS.line,
      version: 1,
      props: { start: [0, 0], end: [100, 100] },
    }));
    expect(internals.eraserHits.search({
      start: { x: 0, y: 50 },
      end: { x: 100, y: 50 },
      radius: 12,
    })).toHaveLength(1);
    renderer.setObject(snapshot({
      id: "future-stroke",
      kind: BUILTIN_OBJECT_KINDS.stroke,
      version: 2,
      props: {
        points: new Uint8Array(2_000_000),
      },
    }));
    expect(internals.eraserHits.search({
      start: { x: 0, y: 50 },
      end: { x: 100, y: 50 },
      radius: 12,
    })).toEqual([]);

    renderer.setTool("eraser");
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(52, 0, 50, { type: "pointerdown" }),
    ));
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(52, 100, 50),
    ));
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(52, 100, 50, { type: "pointerup" }),
    ));

    expect(callbacks.onDeleteObjects).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("keeps eraser world continuity when the camera changes mid-gesture", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "stale-camera-path",
        kind: BUILTIN_OBJECT_KINDS.line,
        transform: [-30, 0, 1, 100, 0],
        props: { start: [0, 0], end: [0, 100] },
      }),
      snapshot({
        id: "actual-world-path",
        kind: BUILTIN_OBJECT_KINDS.line,
        transform: [60, 0, 1, 100, 0],
        props: { start: [0, 0], end: [0, 100] },
      }),
    ]);
    renderer.setTool("eraser");
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(55, 20, 50, { type: "pointerdown" }),
    ));

    renderer.setCamera({ x: 100, y: 0, zoom: 1 });
    internals.onPointerMove(konvaPointerEvent(
      internals,
      "pointermove",
      pointerEvent(55, 160, 50),
    ));

    expect(internals.nodes.get("stale-camera-path")?.visible()).toBe(true);
    expect(internals.nodes.get("actual-world-path")?.visible()).toBe(true);
    expect(internals.nodes.get("actual-world-path")?.opacity()).toBeCloseTo(0.24);
    internals.onPointerUp(konvaPointerEvent(
      internals,
      "pointerup",
      pointerEvent(55, 160, 50, { type: "pointerup" }),
    ));
    expect(vi.mocked(callbacks.onDeleteObjects).mock.calls[0][0])
      .toEqual(["actual-world-path"]);
    renderer.destroy();
  });

  it("cancels erasing safely when zoom changes its logical radius", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "temporarily-erased",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [0, 0, 40, 40, 0],
      }),
    ]);
    renderer.setTool("eraser");
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(57, 20, 20, { type: "pointerdown" }),
    ));
    const trail = internals.activeGesture?.trail;
    expect(internals.nodes.get("temporarily-erased")?.visible()).toBe(true);
    expect(internals.nodes.get("temporarily-erased")?.opacity()).toBeCloseTo(0.24);

    renderer.setCamera({ x: 0, y: 0, zoom: 2 });

    expect(internals.activeGesture).toBeNull();
    expect(internals.nodes.get("temporarily-erased")?.visible()).toBe(true);
    expect(internals.nodes.get("temporarily-erased")?.opacity()).toBe(1);
    expect(trail?.getParent()).toBeNull();
    expect(callbacks.onDeleteObjects).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("keeps a pending object faded when viewport culling rematerializes it", () => {
    const { callbacks, renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "culled",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [0, 0, 40, 40, 0],
      }),
    ]);
    renderer.setTool("eraser");
    internals.onPointerDown(konvaPointerEvent(
      internals,
      "pointerdown",
      pointerEvent(56, 20, 20, { type: "pointerdown" }),
    ));
    expect(internals.nodes.get("culled")?.visible()).toBe(true);
    expect(internals.nodes.get("culled")?.opacity()).toBeCloseTo(0.24);

    renderer.setCamera({ x: -5_000, y: -5_000, zoom: 1 });
    expect(internals.nodes.has("culled")).toBe(false);
    renderer.setCamera({ x: 0, y: 0, zoom: 1 });
    expect(internals.nodes.get("culled")?.visible()).toBe(true);
    expect(internals.nodes.get("culled")?.opacity()).toBeCloseTo(0.24);

    renderer.cancelInteraction();
    expect(internals.nodes.get("culled")?.visible()).toBe(true);
    expect(internals.nodes.get("culled")?.opacity()).toBe(1);
    expect(callbacks.onDeleteObjects).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("renders a short speed-sensitive eraser tail and expires its old end", () => {
    let nextFrameId = 20_000;
    const scheduled = new Map<number, FrameRequestCallback>();
    const requestFrame = vi.spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((callback) => {
        const id = nextFrameId;
        nextFrameId += 1;
        scheduled.set(id, callback);
        return id;
      });
    const cancelFrame = vi.spyOn(globalThis, "cancelAnimationFrame")
      .mockImplementation((id) => {
        scheduled.delete(id);
      });
    let animationClock = performance.now();
    const performanceNow = vi.spyOn(performance, "now")
      .mockImplementation(() => animationClock);
    const runNextFrame = (animationTime: number) => {
      const entry = scheduled.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined;
      expect(entry).toBeDefined();
      if (!entry) return;
      scheduled.delete(entry[0]);
      entry[1](animationTime);
    };
    const { callbacks, renderer, internals } = rendererHarness();
    try {
      const startedAt = animationClock;
      const motionSamples = (pointerId: number, timeOffset = 0) =>
        Array.from({ length: 100 }, (_, index) => pointerEvent(
          pointerId,
          22 + index * 2,
          30,
          { timeStamp: startedAt + timeOffset + index + 1 },
        ));

      renderer.setCamera({ x: 0, y: 0, zoom: 0.02 });
      renderer.setTool("eraser");
      internals.onPointerDown(konvaPointerEvent(
        internals,
        "pointerdown",
        pointerEvent(61, 20, 30, {
          type: "pointerdown",
          timeStamp: startedAt,
        }),
      ));
      const lowZoomGesture = internals.activeGesture!;
      expect(lowZoomGesture.trail).toBeInstanceOf(Konva.Group);
      expect(lowZoomGesture.trail?.getParent()).toBe(internals.interactionScreen);
      expect(lowZoomGesture.trail?.getAbsoluteScale().x).toBe(1);
      expect(lowZoomGesture.trailBody).toBeInstanceOf(Konva.Shape);
      expect(lowZoomGesture.trailBody).not.toBeInstanceOf(Konva.Line);
      expect(lowZoomGesture.trailBody?.getParent()).toBe(lowZoomGesture.trail);
      expect(lowZoomGesture.trail?.getChildren()).toHaveLength(2);
      expect(lowZoomGesture.trailBody?.visible()).toBe(true);
      expect(lowZoomGesture.trailBody?.opacity()).toBe(ERASER_TRAIL_OPACITY);
      expect(lowZoomGesture.trailBody?.fill()).toBe("#66717f");
      expect(lowZoomGesture.trailBody?.getAttr("eraserTrailStations"))
        .toEqual([{
          x: 20,
          y: 30,
          diameter: ERASER_TRAIL_HEAD_MAX_DIAMETER_PX,
        }]);
      expect(lowZoomGesture.trailFootprint?.radius()).toBe(12);
      expect(lowZoomGesture.trailFootprint?.strokeWidth()).toBe(1);
      expect(lowZoomGesture.trailFootprint?.opacity()).toBe(0.12);
      expect(lowZoomGesture.trailFootprint?.stroke()).toBe("#66717f");

      const screenBoundsSpy = vi.spyOn(
        renderer.element,
        "getBoundingClientRect",
      );
      animationClock = startedAt + 1;
      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(61, 20.25, 30, { timeStamp: 0 }),
      ));
      expect(scheduled.size).toBe(1);
      const drawSpy = vi.spyOn(internals.previewLayer, "draw");
      const batchDrawSpy = vi.spyOn(internals.previewLayer, "batchDraw");
      runNextFrame(startedAt + 2);
      expect(lowZoomGesture.trailSamples?.at(-1)?.x).toBe(20.25);
      expect(lowZoomGesture.trailFootprint?.x()).toBe(20.25);
      expect(lowZoomGesture.trailBody?.visible()).toBe(true);
      expect(lowZoomGesture.trailBody?.opacity()).toBe(ERASER_TRAIL_OPACITY);
      expect((lowZoomGesture.trailBody?.getAttr("eraserTrailStations") as
        readonly EraserTrailRenderStation[]).at(-1)?.x).toBe(20.25);
      expect(drawSpy).toHaveBeenCalledTimes(1);
      expect(batchDrawSpy).not.toHaveBeenCalled();
      expect(scheduled.size).toBe(1);

      animationClock = startedAt + 110;
      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(61, 240, 30, {
          timeStamp: startedAt + 110,
          getCoalescedEvents: () => motionSamples(61),
        }),
      ));
      expect(requestFrame).toHaveBeenCalledTimes(2);
      expect(scheduled.size).toBe(1);
      expect(screenBoundsSpy).toHaveBeenCalledTimes(2);
      expect(lowZoomGesture.trailFootprint?.x()).toBe(20.25);

      runNextFrame(startedAt + 120);
      expect(drawSpy).toHaveBeenCalledTimes(2);
      const retainedSamples = lowZoomGesture.trailSamples!;
      expect(retainedSamples.length).toBeLessThanOrEqual(ERASER_TRAIL_MAX_SAMPLES);
      const retainedLength = retainedSamples.slice(1).reduce(
        (total, sample, index) => total + Math.hypot(
          sample.x - retainedSamples[index].x,
          sample.y - retainedSamples[index].y,
        ),
        0,
      );
      expect(retainedLength).toBeGreaterThan(90);
      expect(retainedLength).toBeLessThan(102);
      expect(retainedSamples.at(-1)?.x).toBe(240);
      const lowZoomStations = lowZoomGesture.trailBody?.getAttr(
        "eraserTrailStations",
      ) as readonly EraserTrailRenderStation[];
      expect(lowZoomStations.length).toBeLessThanOrEqual(
        ERASER_TRAIL_MAX_RENDER_STATIONS,
      );
      expect(lowZoomStations.at(-1)).toMatchObject({ x: 240, y: 30 });
      for (let index = 1; index < lowZoomStations.length; index += 1) {
        const previous = lowZoomStations[index - 1];
        const current = lowZoomStations[index];
        expect(Math.hypot(current.x - previous.x, current.y - previous.y))
          .toBeLessThanOrEqual(ERASER_TRAIL_RENDER_STEP_PX + 1e-9);
      }
      expect(lowZoomStations.every(({ x, y, diameter }) =>
        Number.isFinite(x)
        && Number.isFinite(y)
        && diameter > 0
        && diameter <= ERASER_TRAIL_HEAD_MAX_DIAMETER_PX)).toBe(true);
      const lowZoomHeadDiameter = lowZoomStations.at(-1)!.diameter;
      expect(lowZoomHeadDiameter).toBeGreaterThanOrEqual(
        ERASER_TRAIL_HEAD_MIN_DIAMETER_PX,
      );
      expect(lowZoomHeadDiameter).toBeLessThan(
        ERASER_TRAIL_HEAD_MAX_DIAMETER_PX,
      );
      expect(lowZoomGesture.trailBody?.visible()).toBe(true);
      expect(lowZoomGesture.trailBody?.opacity()).toBe(ERASER_TRAIL_OPACITY);
      const renderedTrail = renderEraserTrail(lowZoomGesture.trailBody!);
      expect(renderedTrail.beginPath).toHaveBeenCalledTimes(1);
      expect(renderedTrail.moveTo).toHaveBeenCalledTimes(
        lowZoomStations.length * 2 - 1,
      );
      expect(renderedTrail.lineTo).toHaveBeenCalledTimes(
        (lowZoomStations.length - 1) * 3,
      );
      expect(renderedTrail.closePath).toHaveBeenCalledTimes(
        lowZoomStations.length - 1,
      );
      expect(renderedTrail.arc).toHaveBeenCalledTimes(lowZoomStations.length);
      expect(renderedTrail.fillShape).toHaveBeenCalledTimes(1);
      expect(renderedTrail.fillShape).toHaveBeenCalledWith(
        lowZoomGesture.trailBody,
      );
      expect(lowZoomGesture.trailFootprint?.x()).toBe(240);
      expect(scheduled.size).toBe(1);

      renderer.setTheme("dark");
      expect(lowZoomGesture.trailBody?.fill()).toBe("#cbcbc7");
      expect(lowZoomGesture.trailFootprint?.stroke()).toBe("#cbcbc7");

      runNextFrame(startedAt + 136);
      const firstIdleSamples = lowZoomGesture.trailSamples!;
      const firstIdleLength = firstIdleSamples.slice(1).reduce(
        (total, sample, index) => total + Math.hypot(
          sample.x - firstIdleSamples[index].x,
          sample.y - firstIdleSamples[index].y,
        ),
        0,
      );
      expect(retainedLength - firstIdleLength).toBeCloseTo(
        eraserTrailRetractionDistance(retainedLength, 16),
      );
      expect(firstIdleSamples.at(-1)).toMatchObject({ x: 240, y: 30 });
      expect(scheduled.size).toBe(1);

      runNextFrame(startedAt + 200);
      const midRetractionSamples = lowZoomGesture.trailSamples!;
      const midRetractionLength = midRetractionSamples.slice(1).reduce(
        (total, sample, index) => total + Math.hypot(
          sample.x - midRetractionSamples[index].x,
          sample.y - midRetractionSamples[index].y,
        ),
        0,
      );
      expect(midRetractionLength).toBeGreaterThan(0);
      expect(midRetractionLength).toBeLessThan(firstIdleLength);
      expect(lowZoomGesture.trailSamples!.at(-1))
        .toMatchObject({ x: 240, y: 30 });
      expect(scheduled.size).toBe(1);

      runNextFrame(startedAt + 1_500);
      expect(lowZoomGesture.trailSamples).toHaveLength(1);
      expect(lowZoomGesture.trailBody?.visible()).toBe(true);
      expect(lowZoomGesture.trailBody?.getAttr("eraserTrailStations"))
        .toEqual([expect.objectContaining({ x: 240, y: 30 })]);
      expect(lowZoomGesture.trailFootprint?.visible()).toBe(true);
      expect(scheduled.size).toBe(0);

      renderer.setCamera({ x: 100, y: 80, zoom: 20 });
      expect(lowZoomGesture.trail?.getParent()).toBeNull();
      expect(lowZoomGesture.trailSamples).toHaveLength(0);
      animationClock = startedAt + 1_600;
      internals.onPointerDown(konvaPointerEvent(
        internals,
        "pointerdown",
        pointerEvent(62, 20, 30, {
          type: "pointerdown",
          timeStamp: startedAt + 1_600,
        }),
      ));
      const highZoomGesture = internals.activeGesture!;
      animationClock = startedAt + 1_601;
      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(62, 20.25, 30, { timeStamp: Number.MAX_VALUE }),
      ));
      runNextFrame(startedAt + 1_602);
      animationClock = startedAt + 1_710;
      internals.onPointerMove(konvaPointerEvent(
        internals,
        "pointermove",
        pointerEvent(62, 240, 30, {
          timeStamp: startedAt + 1_710,
          getCoalescedEvents: () => motionSamples(62, 1_600),
        }),
      ));
      runNextFrame(startedAt + 1_720);
      expect(highZoomGesture.trail?.getAbsoluteScale().x).toBe(1);
      expect(highZoomGesture.trailBody?.getAbsoluteScale().x).toBe(1);
      const highZoomStations = highZoomGesture.trailBody?.getAttr(
        "eraserTrailStations",
      ) as readonly EraserTrailRenderStation[];
      expect(highZoomStations.at(-1)!.diameter).toBeCloseTo(
        lowZoomHeadDiameter,
      );
      expect(highZoomStations).toHaveLength(lowZoomStations.length);
      highZoomStations.forEach((station, index) => {
        expect(station.x).toBeCloseTo(lowZoomStations[index].x, 12);
        expect(station.y).toBeCloseTo(lowZoomStations[index].y, 12);
        expect(station.diameter).toBeCloseTo(
          lowZoomStations[index].diameter,
          12,
        );
      });

      const pendingFrame = highZoomGesture.trailAnimationFrame;
      expect(pendingFrame).not.toBeNull();
      renderer.setTool("select");
      expect(cancelFrame).toHaveBeenCalledWith(pendingFrame);
      expect(scheduled.size).toBe(0);
      expect(highZoomGesture.trail?.getParent()).toBeNull();
      expect(highZoomGesture.trailSamples).toHaveLength(0);
      expect(internals.activeGesture).toBeNull();
      expect(callbacks.onDeleteObjects).not.toHaveBeenCalled();
      expect(callbacks.onGesturePreviewChange).not.toHaveBeenCalled();
    } finally {
      renderer.destroy();
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      performanceNow.mockRestore();
    }
  });
});

describe("Konva remote gesture previews", () => {
  it("bounds a long freehand preview and renders it from presence", () => {
    const points = Array.from({ length: 1_000 }, (_, index) => ({
      x: index,
      y: index % 17,
    }));
    const preview = renderGesturePreviewNode({ kind: "pen", points }, "#0a7f59");
    expect(preview).toBeInstanceOf(Konva.Line);
    expect(preview?.stroke()).toBe("#0a7f59");
    expect(preview?.strokeWidth()).toBe(2.5);
    expect(preview?.opacity()).toBe(0.76);
    expect((preview as Konva.Line).points().length).toBeLessThanOrEqual(512);
    expect((preview as Konva.Line).points().slice(0, 2)).toEqual([0, 0]);
    expect((preview as Konva.Line).points().slice(-2)).toEqual([999, 13]);

    const { renderer, internals } = rendererHarness();
    renderer.setPresence([{
      clientId: 92,
      userId: "remote-user",
      displayName: "Remote",
      color: "#0a7f59",
      selectionIds: [],
      gesturePreview: { kind: "pen", points },
    }]);
    expect(internals.presenceWorld.getChildren()).toHaveLength(1);
    expect(internals.presenceWorld.getChildren()[0]).toBeInstanceOf(Konva.Line);

    const legacyNode = internals.presenceRenderEntries.get(92)?.gesturePreview;
    renderer.setPresence([{
      clientId: 92,
      userId: "remote-user",
      displayName: "Remote",
      color: "#0a7f59",
      selectionIds: [],
      gesturePreview: {
        kind: "pen",
        points,
        style: {
          stroke: "#d33f49",
          strokeWidth: 1_000,
          opacity: -1,
        },
      },
    }]);
    const styledNode = internals.presenceRenderEntries.get(92)?.gesturePreview;
    expect(styledNode).not.toBe(legacyNode);
    expect(styledNode?.stroke()).toBe("#d33f49");
    expect(styledNode?.strokeWidth()).toBe(96);
    expect(styledNode?.opacity()).toBe(0);

    const hostile = renderGesturePreviewNode({
      kind: "pen",
      points: points.slice(0, 2),
      style: {
        stroke: "url(javascript:alert(1))",
        strokeWidth: 30,
        opacity: 0.2,
      },
    }, "#0a7f59");
    expect(hostile?.stroke()).toBe("#0a7f59");
    expect(hostile?.strokeWidth()).toBe(2.5);
    expect(hostile?.opacity()).toBe(0.76);

    const legacyHighlighter = renderGesturePreviewNode({
      kind: "highlighter",
      points: points.slice(0, 2),
    }, "#0a7f59");
    expect(legacyHighlighter?.stroke()).toBe("#ffd43b");
    expect(legacyHighlighter?.strokeWidth()).toBe(18);
    expect(legacyHighlighter?.opacity()).toBe(0.38);
    expect(legacyHighlighter?.globalCompositeOperation()).toBe("multiply");
    renderer.destroy();
  });

  it("renders retained styled laser paths and distinguishes fade from cancellation", () => {
    const { renderer, internals } = rendererHarness();
    const presence = {
      clientId: 93,
      userId: "remote-laser-user",
      displayName: "Remote laser",
      color: "#0a7f59",
      selectionIds: [],
    } as const;
    const strokes = [
      {
        points: [{ x: 10, y: 20 }, { x: 40, y: 55 }],
        style: { stroke: "#d33f49", strokeWidth: 7, opacity: 0.45 },
      },
      {
        points: [{ x: 80, y: 30 }, { x: 120, y: 70 }],
        style: { stroke: "#2563eb", strokeWidth: 3, opacity: 0.8 },
      },
    ] as const;

    renderer.setPresence([{ ...presence, laser: { strokes } }]);
    const entry = internals.presenceRenderEntries.get(presence.clientId);
    const lines = entry?.laser?.getChildren() ?? [];
    expect(lines).toHaveLength(2);
    const firstLine = lines[0] as Konva.Line;
    const secondLine = lines[1] as Konva.Line;
    expect(firstLine.points()).toEqual([10, 20, 40, 55]);
    expect(firstLine.stroke()).toBe("#d33f49");
    expect(firstLine.strokeWidth()).toBe(7);
    expect(firstLine.opacity()).toBe(0.45);
    expect(secondLine.points()).toEqual([80, 30, 120, 70]);
    expect(secondLine.stroke()).toBe("#2563eb");
    expect(secondLine.strokeWidth()).toBe(3);
    expect(secondLine.opacity()).toBe(0.8);
    expect(internals.remoteLaserTrails.get(presence.clientId)).toMatchObject({
      active: true,
      expiresAt: Number.POSITIVE_INFINITY,
    });

    renderer.setPresence([{ ...presence, laserClearMode: "fade" }]);
    expect(internals.remoteLaserTrails.get(presence.clientId)).toMatchObject({
      active: false,
      expiresAt: expect.any(Number),
    });
    expect(entry?.laser?.visible()).toBe(true);
    expect(entry?.laser?.getChildren()).toHaveLength(2);

    renderer.setPresence([{ ...presence, laser: { strokes } }]);
    expect(internals.remoteLaserTrails.get(presence.clientId)?.active).toBe(true);
    renderer.setPresence([{ ...presence, laserClearMode: "immediate" }]);
    expect(internals.remoteLaserTrails.has(presence.clientId)).toBe(false);
    expect(entry?.laser?.visible()).toBe(false);
    renderer.destroy();
  });

  it("reuses presence nodes and follows every display RAF without a 60 Hz gate", () => {
    const { renderer, internals } = rendererHarness();
    renderer.setObjects([
      snapshot({
        id: "selected",
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        props: {},
      }),
    ]);
    let nextFrameId = 10_000;
    const scheduled = new Map<number, FrameRequestCallback>();
    const requestFrame = vi.spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((callback) => {
        const id = nextFrameId;
        nextFrameId += 1;
        scheduled.set(id, callback);
        return id;
      });
    const cancelFrame = vi.spyOn(globalThis, "cancelAnimationFrame")
      .mockImplementation((id) => {
        scheduled.delete(id);
      });
    try {
      const firstPresence = {
        clientId: 93,
        userId: "remote-user",
        displayName: "Remote",
        color: "#0a7f59",
        cursor: { x: 10, y: 20 },
        selectionIds: ["selected"],
      };
      renderer.setPresence([firstPresence]);
      const firstEntry = internals.presenceRenderEntries.get(93)!;
      const cursor = firstEntry.cursor;
      const selection = firstEntry.selections.get("selected");
      expect(internals.presenceAnimationFrame).toBeNull();

      renderer.setPresence([{
        ...firstPresence,
        cursor: { x: 80, y: 45 },
      }]);
      const secondEntry = internals.presenceRenderEntries.get(93)!;
      expect(secondEntry.cursor).toBe(cursor);
      expect(secondEntry.selections.get("selected")).toBe(selection);
      const firstAnimationFrame = internals.presenceAnimationFrame;
      expect(firstAnimationFrame).not.toBeNull();

      scheduled.get(firstAnimationFrame!)?.(performance.now() + 7);
      const secondAnimationFrame = internals.presenceAnimationFrame;
      expect(secondAnimationFrame).not.toBeNull();
      expect(secondAnimationFrame).not.toBe(firstAnimationFrame);
      expect(requestFrame).toHaveBeenCalled();
    } finally {
      renderer.destroy();
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });
});
