// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  BUILTIN_OBJECT_KINDS,
  LocalUndoController,
  addBoardObject,
  createCodeProps,
  createLocalCommandOrigin,
  createPageDocument,
  createTextProps,
  compareBoardObjectZOrder,
  getCollaborativeText,
  getPageId,
  getPageObjects,
  patchObjectStyles,
  readBoardObject,
  setObjectTransform,
  type BoardCommandOrigin,
} from "../../board/core";
import {
  BOARD_GRID_VISIBILITY_STORAGE_KEY,
  BoardSurface,
  type BoardSurfaceProps,
} from "./BoardSurface";
import {
  PYTHON_RUNNER_PROTOCOL_VERSION,
  PYTHON_RUNNER_REQUEST_TYPE,
  PYTHON_RUNNER_RESULT_TYPE,
  PYTHON_RUNNER_WORKER_URL,
  type PythonRunnerRequest,
} from "../pythonRunner";
import { THEME_STORAGE_KEY, ThemeProvider } from "../theme";
import {
  BOARD_FRAGMENT_CLIPBOARD_MIME,
  BoardClipboard,
  type BoardClipboardData,
  type BoardClipboardDataItem,
  type BoardSystemClipboardItem,
} from "./boardClipboard";
import { FREE_DRAWING_PRESETS_STORAGE_KEY } from "./freeDrawingPresets";
import { BOARD_CONNECTOR_CURVATURE_STORAGE_KEY } from "./connectorCurvature";
import { STYLE_COLOR_PALETTE_STORAGE_KEY } from "./styleColorPalette";
import { TOOL_STYLE_PRESETS_STORAGE_KEY } from "./toolStylePresets";
import type {
  BoardCamera,
  BoardObjectDraft,
  BoardObjectSnapshot,
  BoardPresence,
  BoardRenderer,
  BoardRendererCallbacks,
  BoardRendererFactory,
  BoardShapeKind,
  BoardTheme,
  BoardTool,
} from "./rendering/types";

const PAGE_ONE = "00000000-0000-4000-8000-000000000201";
const PAGE_TWO = "00000000-0000-4000-8000-000000000202";
const CODE_OBJECT = "00000000-0000-4000-8000-000000000203";
const IMAGE_OBJECT = "00000000-0000-4000-8000-000000000204";
const OTHER_IMAGE_OBJECT = "00000000-0000-4000-8000-000000000205";
const MALFORMED_OBJECT = "00000000-0000-4000-8000-000000000206";
const RECTANGLE_ONE = "00000000-0000-4000-8000-000000000207";
const RECTANGLE_TWO = "00000000-0000-4000-8000-000000000208";
const RECTANGLE_THREE = "00000000-0000-4000-8000-000000000209";
const TEXT_ONE = "00000000-0000-4000-8000-00000000020a";
const TEXT_TWO = "00000000-0000-4000-8000-00000000020b";

class MemoryClipboardData implements BoardClipboardData {
  readonly values = new Map<string, string>();
  readonly items: ArrayLike<BoardClipboardDataItem>;
  readonly files: ArrayLike<Blob>;

  constructor(options: {
    readonly items?: readonly BoardClipboardDataItem[];
    readonly files?: readonly Blob[];
  } = {}) {
    this.items = options.items ?? [];
    this.files = options.files ?? [];
  }

  get types(): readonly string[] {
    return [...this.values.keys()];
  }

  setData(type: string, value: string): void {
    this.values.set(type, value);
  }

  getData(type: string): string {
    return this.values.get(type) ?? "";
  }
}

function imageClipboardData(
  file: File,
  plainText = "",
): MemoryClipboardData {
  const data = new MemoryClipboardData({
    items: [{
      kind: "file",
      type: file.type,
      getAsFile: () => file,
    }],
  });
  if (plainText.length > 0) data.setData("text/plain", plainText);
  return data;
}

function systemClipboardItem(
  values: Readonly<Record<string, string | Blob>>,
): BoardSystemClipboardItem {
  return {
    types: Object.keys(values),
    getType: vi.fn(async (type: string) => {
      const value = values[type];
      if (value === undefined) throw new Error(`missing clipboard type ${type}`);
      return typeof value === "string"
        ? new Blob([value], { type })
        : value;
    }),
  };
}

function dispatchClipboardEvent(
  type: "copy" | "cut" | "paste",
  data: BoardClipboardData,
  target: Window | HTMLElement = window,
): Event {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "clipboardData", {
    configurable: true,
    value: data,
  });
  target.dispatchEvent(event);
  return event;
}

class FakeRenderer implements BoardRenderer {
  readonly element: HTMLDivElement;
  readonly callbacks: BoardRendererCallbacks;
  readonly options: Parameters<BoardRendererFactory["create"]>[2];
  camera: BoardCamera = { x: 0, y: 0, zoom: 1 };
  selection: readonly string[] = [];
  objects: readonly BoardObjectSnapshot[] = [];
  presences: readonly BoardPresence[] = [];
  tool: BoardTool = "select";
  shapeKind: BoardShapeKind = "rectangle";
  theme: BoardTheme = "light";
  gridVisible = true;
  creationStyle: Readonly<Record<string, unknown>> = {};
  connectorCurvature = 0;
  inlineEditingObjectId: string | null = null;
  readOnly = false;
  destroyCount = 0;
  fitCount = 0;
  cancelInteractionCount = 0;

  constructor(
    element: HTMLDivElement,
    callbacks: BoardRendererCallbacks,
    options: Parameters<BoardRendererFactory["create"]>[2],
  ) {
    this.element = element;
    this.callbacks = callbacks;
    this.options = options;
    this.gridVisible = options?.gridVisible ?? true;
  }

  setTool(tool: BoardTool): void {
    this.tool = tool;
  }

  setShapeKind(kind: BoardShapeKind): void {
    this.shapeKind = kind;
  }

  setCreationStyle(style: Readonly<Record<string, unknown>>): void {
    this.creationStyle = style;
  }

  setConnectorCurvature(curvature: number): void {
    this.connectorCurvature = curvature;
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
  }

  setObjects(objects: readonly BoardObjectSnapshot[]): void {
    this.objects = objects;
  }

  setObject(object: BoardObjectSnapshot): void {
    this.objects = [...this.objects.filter((entry) => entry.id !== object.id), object];
  }

  deleteObject(id: string): void {
    this.objects = this.objects.filter((object) => object.id !== id);
  }

  setPresence(presence: readonly BoardPresence[]): void {
    this.presences = presence;
  }

  setSelection(ids: readonly string[]): void {
    this.selection = ids;
  }

  setInlineEditingObject(id: string | null): void {
    this.inlineEditingObjectId = id;
  }

  setTheme(theme: BoardTheme): void {
    this.theme = theme;
  }

  setGridVisible(visible: boolean): void {
    this.gridVisible = visible;
  }

  setCamera(camera: BoardCamera): void {
    this.camera = camera;
  }

  fitToContent(): void {
    this.fitCount += 1;
  }

  cancelInteraction(): void {
    this.cancelInteractionCount += 1;
  }

  resize(): void {}

  destroy(): void {
    this.destroyCount += 1;
  }
}

class FakeRendererFactory implements BoardRendererFactory {
  readonly instances: FakeRenderer[] = [];

  create(
    element: HTMLDivElement,
    callbacks: BoardRendererCallbacks,
    options?: Parameters<BoardRendererFactory["create"]>[2],
  ): BoardRenderer {
    const renderer = new FakeRenderer(element, callbacks, options);
    this.instances.push(renderer);
    return renderer;
  }
}

interface BoardContext {
  readonly document: ReturnType<typeof createPageDocument>;
  readonly origin: BoardCommandOrigin;
  readonly undo: LocalUndoController;
}

function createBoardContext(pageId: string): BoardContext {
  const document = createPageDocument(pageId);
  const origin = createLocalCommandOrigin(`surface-${pageId}`);
  return {
    document,
    origin,
    undo: new LocalUndoController(document, origin),
  };
}

function surfaceProps(
  context: BoardContext,
  rendererFactory: BoardRendererFactory,
  overrides: Partial<BoardSurfaceProps> = {},
): BoardSurfaceProps {
  return {
    document: context.document,
    localOrigin: context.origin,
    undo: context.undo,
    status: "synced",
    fragmentScope: {
      boardId: "board-test",
      generation: 1,
      pageId: getPageId(context.document),
    },
    rendererFactory,
    ...overrides,
  };
}

function setBoardViewport(width: number, height: number): void {
  const host = container?.querySelector<HTMLDivElement>(".board-v2__canvas");
  if (!host) throw new Error("Board canvas host was not rendered");
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  });
}

function focusBoard(): void {
  container?.querySelector<HTMLElement>(".board-v2")?.focus();
}

function objectViewByKind(
  context: BoardContext,
  kind: string,
) {
  const object = [...getPageObjects(context.document).values()]
    .map((record) => readBoardObject(record))
    .find((entry) => entry.kind === kind);
  if (!object) throw new Error(`Board object '${kind}' was not created`);
  return object;
}

function addRectangle(
  context: BoardContext,
  id: string,
  zRank: string,
  fill: string,
): void {
  addBoardObject(context.document, {
    id,
    kind: BUILTIN_OBJECT_KINDS.rectangle,
    version: 1,
    transform: [10, 20, 120, 80, 0],
    zRank,
    style: {
      stroke: "#17212b",
      strokeWidth: 2,
      fill,
      opacity: 1,
      dash: [],
    },
    props: {},
  }, context.origin);
}

function addText(
  context: BoardContext,
  id: string,
  zRank: string,
  fontStyle: string,
): void {
  addBoardObject(context.document, {
    id,
    kind: BUILTIN_OBJECT_KINDS.text,
    version: 1,
    transform: [10, 20, 180, 60, 0],
    zRank,
    style: {
      fill: "#17212b",
      fontSize: 20,
      fontFamily: "Inter, Arial, sans-serif",
      fontStyle,
      opacity: 1,
    },
    props: createTextProps("Текст"),
  }, context.origin);
}

function emptyTextDraft(): BoardObjectDraft {
  return {
    kind: BUILTIN_OBJECT_KINDS.text,
    transform: [40, 60, 240, 52, 0],
    props: { text: "" },
  };
}

function orderedObjectIds(context: BoardContext): string[] {
  return [...getPageObjects(context.document).entries()]
    .map(([id, record]) => ({
      id,
      zRank: readBoardObject(record).zRank,
    }))
    .sort(compareBoardObjectZOrder)
    .map((object) => object.id);
}

function styleSwatch(color: string): HTMLButtonElement | undefined {
  return [...(container?.querySelectorAll<HTMLButtonElement>(
    ".board-stylebar__swatch, .board-color-control__favorite",
  ) ?? [])].find(
    (button) =>
      button.style.getPropertyValue("--board-swatch") === color
      || button.style.getPropertyValue("--board-color-value") === color,
  );
}

function fillSwatches(): HTMLButtonElement[] {
  return [...(container?.querySelectorAll<HTMLButtonElement>(
    ".board-color-control__favorite",
  ) ?? [])];
}

function setRangeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!setter) throw new Error("HTMLInputElement value setter is unavailable");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function openColorFormats(scope: ParentNode): void {
  const preview = scope.querySelector<HTMLElement>(
    ".board-color-picker__preview",
  );
  if (!preview) throw new Error("Color format preview not rendered");
  preview.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  }));
}

function axisAlignedObjectsOverlap(
  left: ReturnType<typeof readBoardObject>["transform"],
  right: ReturnType<typeof readBoardObject>["transform"],
): boolean {
  return left[0] < right[0] + right[2]
    && left[0] + left[2] > right[0]
    && left[1] < right[1] + right[3]
    && left[1] + left[3] > right[1];
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let contexts: BoardContext[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  contexts = [];
  try {
    window.localStorage.clear();
  } catch {
    // Some jsdom configurations expose an opaque origin.
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  for (const context of contexts) {
    context.undo.dispose();
    context.document.destroy();
  }
  contexts = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BoardSurface renderer lifecycle", () => {
  it("keeps one renderer across prop changes and replaces it only with the document", async () => {
    const first = createBoardContext(PAGE_ONE);
    const second = createBoardContext(PAGE_TWO);
    contexts.push(first, second);
    const factory = new FakeRendererFactory();
    const firstAwareness = vi.fn();
    const secondAwareness = vi.fn();
    const firstResolver = vi.fn(() => "/old-image");
    const secondResolver = vi.fn(() => "/new-image");

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(first, factory, {
        onAwarenessChange: firstAwareness,
        resolveAssetUrl: firstResolver,
      })));
    });
    const firstRenderer = factory.instances[0];

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(first, factory, {
        onAwarenessChange: secondAwareness,
        resolveAssetUrl: secondResolver,
        readOnly: true,
      })));
    });

    expect(factory.instances).toHaveLength(1);
    expect(firstRenderer.destroyCount).toBe(0);
    await act(async () => firstRenderer.callbacks.onSelectionChange([]));
    expect(secondAwareness).toHaveBeenCalledWith({ selectionIds: [] });
    expect(firstAwareness).not.toHaveBeenCalledWith({ selectionIds: [] });
    expect(await Promise.resolve(
      firstRenderer.options?.resolveAssetUrl?.("asset", null),
    )).toBe("/new-image");

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(second, factory, {
        onAwarenessChange: secondAwareness,
      })));
    });

    expect(factory.instances).toHaveLength(2);
    expect(firstRenderer.destroyCount).toBe(1);
    expect(factory.instances[1].destroyCount).toBe(0);

    await act(async () => root?.unmount());
    root = undefined;
    expect(factory.instances[1].destroyCount).toBe(1);
  });

  it("keeps rendering when an object-map entry is a primitive", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const objects = getPageObjects(context.document) as Y.Map<unknown>;
    objects.set(MALFORMED_OBJECT, 42);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });

    const renderer = factory.instances[0];
    expect(renderer.objects).toEqual([
      expect.objectContaining({
        id: MALFORMED_OBJECT,
        kind: "eduri/malformed",
        rendering: expect.objectContaining({ status: "malformed" }),
      }),
    ]);

    await act(async () => {
      objects.set(MALFORMED_OBJECT, false);
    });
    expect(renderer.objects).toEqual([
      expect.objectContaining({
        id: MALFORMED_OBJECT,
        rendering: expect.objectContaining({ status: "malformed" }),
      }),
    ]);

    await act(async () => {
      objects.set(MALFORMED_OBJECT, undefined);
    });
    expect(objects.has(MALFORMED_OBJECT)).toBe(true);
    expect(renderer.objects).toEqual([
      expect.objectContaining({
        id: MALFORMED_OBJECT,
        rendering: expect.objectContaining({ status: "malformed" }),
      }),
    ]);
  });

  it("does not subscribe to expensive document metrics until the size panel opens", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();
    const onSpy = vi.spyOn(context.document, "on");

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    expect(onSpy.mock.calls.filter(([event]) => event === "update")).toHaveLength(0);

    const sizeButton = container?.querySelector<HTMLButtonElement>('[aria-label="Размер доски"]');
    await act(async () => sizeButton?.click());
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });

    expect(onSpy.mock.calls.filter(([event]) => event === "update")).toHaveLength(1);
    expect(container?.textContent).toContain("Снимок CRDT");
    expect(container?.textContent).not.toContain("Считаем");
  });
});

describe("BoardSurface connection status", () => {
  it("does not flash ordinary pending synchronization", async () => {
    vi.useFakeTimers();
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        status: "pending",
        pendingUpdates: 1,
      })));
    });
    expect(container?.textContent).not.toContain("Отправляем изменения");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(899);
    });
    expect(container?.textContent).not.toContain("Отправляем изменения");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(container?.textContent).toContain("Отправляем изменения: 1");

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    expect(container?.textContent).not.toContain("Отправляем изменения");
  });
});

describe("BoardSurface placement tools", () => {
  it("selects Code without creating it, then places Code and LaTeX at canvas clicks", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    setBoardViewport(800, 600);
    const overflowButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Ещё инструменты"]',
    );
    await act(async () => overflowButton?.click());
    const codeButton = container?.querySelector<HTMLButtonElement>(
      '[data-toolbar-tool="code"]',
    );
    await act(async () => codeButton?.click());
    expect(factory.instances[0].tool).toBe("code");
    expect(getPageObjects(context.document).size).toBe(0);

    await act(async () => {
      factory.instances[0].callbacks.onPlaceTool("code", { x: 180, y: 160 });
    });
    await act(async () => overflowButton?.click());
    const latexButton = container?.querySelector<HTMLButtonElement>(
      '[data-toolbar-tool="latex"]',
    );
    await act(async () => latexButton?.click());
    expect(factory.instances[0].tool).toBe("latex");
    await act(async () => {
      factory.instances[0].callbacks.onPlaceTool("latex", { x: 610, y: 420 });
    });

    const code = objectViewByKind(context, BUILTIN_OBJECT_KINDS.code);
    const latex = objectViewByKind(context, BUILTIN_OBJECT_KINDS.latex);
    expect(axisAlignedObjectsOverlap(code.transform, latex.transform)).toBe(false);
    expect(code.transform[0] + code.transform[2] / 2).toBe(180);
    expect(code.transform[1] + code.transform[3] / 2).toBe(160);
    expect(latex.transform[0] + latex.transform[2] / 2).toBe(610);
    expect(latex.transform[1] + latex.transform[3] / 2).toBe(420);
    for (const object of [code, latex]) {
      expect(object.transform[0]).toBeGreaterThanOrEqual(0);
      expect(object.transform[1]).toBeGreaterThanOrEqual(0);
      expect(object.transform[0] + object.transform[2]).toBeLessThanOrEqual(800);
      expect(object.transform[1] + object.transform[3]).toBeLessThanOrEqual(600);
    }
  });

  it("scales a clicked placement to remain usable in a narrow zoomed viewport", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    setBoardViewport(280, 180);
    await act(async () => {
      factory.instances[0].callbacks.onCameraChange({
        x: 100,
        y: 50,
        zoom: 2,
      });
    });
    await act(async () => {
      factory.instances[0].callbacks.onPlaceTool("code", { x: 20, y: 20 });
    });

    const code = objectViewByKind(context, BUILTIN_OBJECT_KINDS.code);
    expect(code.transform[2]).toBeLessThan(360);
    expect(code.transform[3]).toBeLessThan(240);
    expect(code.transform[0]).toBeGreaterThanOrEqual(-50);
    expect(code.transform[1]).toBeGreaterThanOrEqual(-25);
    expect(code.transform[0] + code.transform[2]).toBeLessThanOrEqual(90);
    expect(code.transform[1] + code.transform[3]).toBeLessThanOrEqual(65);
    expect(code.transform[0] + code.transform[2] / 2).toBe(20);
    expect(code.transform[1] + code.transform[3] / 2).toBe(20);
  });

  it("positions a new editor with the renderer camera before React camera state catches up", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    setBoardViewport(800, 600);
    factory.instances[0].camera = { x: 300, y: 200, zoom: 1 };
    await act(async () => {
      factory.instances[0].callbacks.onPlaceTool("code", { x: 100, y: 100 });
    });

    const editor = container?.querySelector<HTMLElement>(".board-v2__editor--code");
    expect(editor?.style.left).toBe("220px");
    expect(editor?.style.top).toBe("180px");
  });

  it("opens the image picker from a canvas click and keeps Image active after durable insertion", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();
    const insertImage = vi.fn().mockResolvedValue({
      assetId: "placed-image",
      contentHash: "d".repeat(64),
      mimeType: "image/png",
      width: 320,
      height: 180,
      originalBytes: 3,
    });

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        insertImage,
      })));
    });
    setBoardViewport(800, 600);
    const input = container?.querySelector<HTMLInputElement>('input[type="file"]');
    const picker = vi.spyOn(input!, "click").mockImplementation(() => {});
    const overflow = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Ещё инструменты"]',
    );
    await act(async () => overflow?.click());
    await act(async () => container?.querySelector<HTMLButtonElement>(
      '[data-toolbar-tool="image"]',
    )?.click());
    expect(factory.instances[0].tool).toBe("image");

    await act(async () => {
      factory.instances[0].callbacks.onPlaceTool("image", { x: 300, y: 220 });
    });
    expect(picker).toHaveBeenCalledTimes(1);
    expect(getPageObjects(context.document).size).toBe(0);

    const file = new File([Uint8Array.of(1, 2, 3)], "placed.png", {
      type: "image/png",
    });
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    await act(async () => {
      input?.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(insertImage).toHaveBeenCalledWith(file);
    const [[id, record]] = [...getPageObjects(context.document).entries()];
    const image = readBoardObject(record);
    expect(image.transform[0] + image.transform[2] / 2).toBe(300);
    expect(image.transform[1] + image.transform[3] / 2).toBe(220);
    expect(factory.instances[0].tool).toBe("image");
    expect(factory.instances[0].selection).toEqual([id]);

    await act(async () => context.undo.undo());
    expect(getPageObjects(context.document).size).toBe(0);
  });

  it("ignores a late image-picker change after the board document changes", async () => {
    const first = createBoardContext(PAGE_ONE);
    const second = createBoardContext(PAGE_TWO);
    contexts.push(first, second);
    const factory = new FakeRendererFactory();
    const insertImage = vi.fn();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(first, factory, {
        insertImage,
      })));
    });
    const firstInput = container?.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    vi.spyOn(firstInput!, "click").mockImplementation(() => {});
    await act(async () => {
      factory.instances[0].callbacks.onPlaceTool("image", { x: 120, y: 90 });
    });

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(second, factory, {
        insertImage,
      })));
    });
    const currentInput = container?.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    const file = new File([Uint8Array.of(1, 2, 3)], "late.png", {
      type: "image/png",
    });
    Object.defineProperty(currentInput, "files", {
      configurable: true,
      value: [file],
    });
    await act(async () => {
      currentInput?.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(insertImage).not.toHaveBeenCalled();
    expect(getPageObjects(first.document).size).toBe(0);
    expect(getPageObjects(second.document).size).toBe(0);
  });

  it("clears a pending image target when the native picker is cancelled", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();
    const insertImage = vi.fn();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        insertImage,
      })));
    });
    const input = container?.querySelector<HTMLInputElement>('input[type="file"]');
    vi.spyOn(input!, "click").mockImplementation(() => {});
    await act(async () => {
      factory.instances[0].callbacks.onPlaceTool("image", { x: 80, y: 70 });
      input?.dispatchEvent(new Event("cancel"));
    });

    const file = new File([Uint8Array.of(1)], "cancelled.png", {
      type: "image/png",
    });
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    await act(async () => {
      input?.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(insertImage).not.toHaveBeenCalled();
    expect(getPageObjects(context.document).size).toBe(0);
  });
});

describe("BoardSurface text draft lifecycle", () => {
  it("discards a blank new textbox on Escape, Enter, or blur without history", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    context.undo.clear();
    const renderer = factory.instances[0];
    const outside = document.createElement("button");
    document.body.append(outside);

    const closeDraft = async (mode: "Escape" | "Enter" | "blur") => {
      await act(async () => renderer.callbacks.onCreateObject(emptyTextDraft()));
      const textarea = container?.querySelector<HTMLTextAreaElement>("textarea");
      expect(textarea).not.toBeNull();
      expect(getPageObjects(context.document).size).toBe(0);
      expect(renderer.selection).toEqual([]);
      expect(renderer.inlineEditingObjectId).toBeNull();

      await act(async () => {
        if (mode === "blur") {
          textarea?.focus();
          outside.focus();
          return;
        }
        textarea?.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: mode,
          key: mode,
        }));
      });

      expect(container?.querySelector("textarea")).toBeNull();
      expect(getPageObjects(context.document).size).toBe(0);
      expect(context.undo.canUndo).toBe(false);
      expect(context.undo.canRedo).toBe(false);
    };

    try {
      await closeDraft("Escape");
      await closeDraft("Enter");
      await closeDraft("blur");
    } finally {
      outside.remove();
    }
  });

  it("promotes first text input and exits to board shortcuts without an empty undo state", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    context.undo.clear();
    const renderer = factory.instances[0];

    await act(async () => renderer.callbacks.onCreateObject(emptyTextDraft()));
    const textarea = container?.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    expect(getPageObjects(context.document).size).toBe(0);

    await act(async () => {
      if (!textarea) return;
      textarea.value = "П";
      textarea.setSelectionRange(1, 1);
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: "П",
        inputType: "insertText",
      }));
    });

    const [objectId, record] = [...getPageObjects(context.document).entries()][0];
    expect(objectId).toBeTruthy();
    expect(getCollaborativeText(record, "text")?.toString()).toBe("П");
    expect(renderer.selection).toEqual([objectId]);
    expect(renderer.inlineEditingObjectId).toBe(objectId);

    const promotedTextarea =
      container?.querySelector<HTMLTextAreaElement>("textarea");
    await act(async () => {
      if (!promotedTextarea) return;
      promotedTextarea.value = "Привет";
      promotedTextarea.setSelectionRange(6, 6);
      promotedTextarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: "ривет",
        inputType: "insertText",
      }));
    });
    expect(getCollaborativeText(record, "text")?.toString()).toBe("Привет");

    const board = container?.querySelector<HTMLElement>(".board-v2");
    expect(document.activeElement).toBe(promotedTextarea);
    await act(async () => {
      promotedTextarea?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Escape",
        key: "Escape",
      }));
    });
    expect(container?.querySelector("textarea")).toBeNull();
    expect(renderer.selection).toEqual([]);
    expect(document.activeElement).toBe(board);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Digit2",
        key: "2",
      }));
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Digit1",
        key: "1",
      }));
    });
    expect(renderer.tool).toBe("select");

    await act(async () => {
      expect(context.undo.undo()).toBe(true);
    });
    expect(getCollaborativeText(record, "text")?.toString()).toBe("П");

    await act(async () => {
      expect(context.undo.undo()).toBe(true);
    });
    expect(getPageObjects(context.document).size).toBe(0);

    await act(async () => {
      expect(context.undo.redo()).toBe(true);
      expect(context.undo.redo()).toBe(true);
    });
    const restored = getPageObjects(context.document).get(objectId);
    expect(restored).toBeDefined();
    expect(getCollaborativeText(restored!, "text")?.toString()).toBe("Привет");
  });

  it("keeps modified Enter inside a blank provisional editor", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    context.undo.clear();
    await act(async () => {
      factory.instances[0].callbacks.onCreateObject(emptyTextDraft());
    });
    const textarea = container?.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();

    for (const modifiers of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
    ]) {
      await act(async () => {
        textarea?.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: "Enter",
          key: "Enter",
          ...modifiers,
        }));
      });
      expect(container?.querySelector("textarea")).toBe(textarea);
    }
    expect(getPageObjects(context.document).size).toBe(0);
    expect(context.undo.canUndo).toBe(false);
  });

  it("keeps whitespace-only input provisional and preserves it on promotion", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    context.undo.clear();
    await act(async () => {
      const draft = emptyTextDraft();
      factory.instances[0].callbacks.onCreateObject({
        ...draft,
        props: {
          ...draft.props,
          text: " \n\t",
        },
      });
    });
    const textarea = container?.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();

    await act(async () => {
      if (!textarea) return;
      textarea.value = " \n\t";
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: " \n\t",
        inputType: "insertText",
      }));
    });
    expect(getPageObjects(context.document).size).toBe(0);
    expect(context.undo.canUndo).toBe(false);
    expect(container?.querySelector("textarea")).toBe(textarea);

    await act(async () => {
      if (!textarea) return;
      textarea.value = " \n\tX ";
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: "X ",
        inputType: "insertText",
      }));
    });

    const [record] = [...getPageObjects(context.document).values()];
    expect(getPageObjects(context.document).size).toBe(1);
    expect(getCollaborativeText(record, "text")?.toString()).toBe(" \n\tX ");
    await act(async () => {
      expect(context.undo.undo()).toBe(true);
    });
    expect(getPageObjects(context.document).size).toBe(0);
  });

  it("closes the promoted editor when Ctrl+Z removes its initial add", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    context.undo.clear();
    const textTool =
      container?.querySelector<HTMLButtonElement>('button[aria-label="Текст"]');
    await act(async () => textTool?.click());
    expect(container?.querySelector(".board-v2__stylebar")).not.toBeNull();

    const renderer = factory.instances[0];
    await act(async () => renderer.callbacks.onCreateObject(emptyTextDraft()));
    const textarea = container?.querySelector<HTMLTextAreaElement>("textarea");
    await act(async () => {
      if (!textarea) return;
      textarea.value = "X";
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: "X",
        inputType: "insertText",
      }));
    });
    expect(getPageObjects(context.document).size).toBe(1);
    expect(container?.querySelector(".board-v2__stylebar")).toBeNull();

    const promotedTextarea =
      container?.querySelector<HTMLTextAreaElement>("textarea");
    const undoEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyZ",
      key: "z",
      ctrlKey: true,
    });
    await act(async () => promotedTextarea?.dispatchEvent(undoEvent));

    expect(undoEvent.defaultPrevented).toBe(true);
    expect(getPageObjects(context.document).size).toBe(0);
    expect(container?.querySelector("textarea")).toBeNull();
    expect(container?.querySelector(".board-v2__stylebar")).not.toBeNull();
    expect(renderer.selection).toEqual([]);
  });

  it("waits for IME composition to finish before promoting the text draft", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    context.undo.clear();
    await act(async () => {
      factory.instances[0].callbacks.onCreateObject(emptyTextDraft());
    });
    const textarea = container?.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();

    await act(async () => {
      if (!textarea) return;
      textarea.dispatchEvent(new CompositionEvent("compositionstart", {
        bubbles: true,
        data: "",
      }));
      textarea.value = "т";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));

      const composingEnter = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Enter",
        key: "Enter",
      });
      textarea.dispatchEvent(composingEnter);

      const legacyCompositionEscape = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Escape",
        key: "Escape",
      });
      Object.defineProperty(legacyCompositionEscape, "keyCode", {
        configurable: true,
        value: 229,
      });
      textarea.dispatchEvent(legacyCompositionEscape);
    });
    expect(getPageObjects(context.document).size).toBe(0);
    expect(context.undo.canUndo).toBe(false);
    expect(container?.querySelector("textarea")).toBe(textarea);

    await act(async () => {
      if (!textarea) return;
      textarea.value = "текст";
      textarea.dispatchEvent(new CompositionEvent("compositionend", {
        bubbles: true,
        data: "текст",
      }));
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: "текст",
        inputType: "insertText",
      }));
    });

    const [record] = [...getPageObjects(context.document).values()];
    expect(getPageObjects(context.document).size).toBe(1);
    expect(getCollaborativeText(record, "text")?.toString()).toBe("текст");
    expect(document.activeElement).toBe(
      container?.querySelector<HTMLTextAreaElement>("textarea"),
    );
  });

  it("drops an uncommitted blank textbox on read-only and document changes", async () => {
    const first = createBoardContext(PAGE_ONE);
    const second = createBoardContext(PAGE_TWO);
    contexts.push(first, second);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(first, factory)));
    });
    await act(async () => {
      factory.instances[0].callbacks.onCreateObject(emptyTextDraft());
    });
    expect(container?.querySelector("textarea")).not.toBeNull();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(first, factory, {
        readOnly: true,
      })));
    });
    expect(container?.querySelector("textarea")).toBeNull();
    expect(getPageObjects(first.document).size).toBe(0);

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(first, factory)));
    });
    await act(async () => {
      factory.instances.at(-1)?.callbacks.onCreateObject(emptyTextDraft());
    });
    expect(container?.querySelector("textarea")).not.toBeNull();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(second, factory)));
    });
    expect(container?.querySelector("textarea")).toBeNull();
    expect(getPageObjects(first.document).size).toBe(0);
    expect(getPageObjects(second.document).size).toBe(0);
  });
});

describe("BoardSurface clipboard", () => {
  it("does not intercept clipboard or board shortcuts outside the focused board", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#fff3bf");
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    await act(async () => {
      factory.instances[0].callbacks.onSelectionChange([RECTANGLE_ONE]);
    });

    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    const data = new MemoryClipboardData();
    const copy = dispatchClipboardEvent("copy", data);
    const selectAll = window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyA",
      ctrlKey: true,
      key: "a",
    }));

    expect(copy.defaultPrevented).toBe(false);
    expect(data.values.size).toBe(0);
    expect(selectAll).toBe(true);
    expect(factory.instances[0].selection).toEqual([RECTANGLE_ONE]);
    outside.remove();
  });

  it("copies and pastes offline as one undoable fragment", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#fff3bf");
    context.undo.clear();
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    setBoardViewport(800, 600);
    await act(async () => {
      factory.instances[0].callbacks.onSelectionChange([RECTANGLE_ONE]);
    });
    focusBoard();

    const data = new MemoryClipboardData();
    const copied = dispatchClipboardEvent("copy", data);
    expect(copied.defaultPrevented).toBe(true);
    expect(data.values.get(BOARD_FRAGMENT_CLIPBOARD_MIME)).toBeTruthy();

    await act(async () => {
      dispatchClipboardEvent("paste", data);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const objects = [...getPageObjects(context.document).values()]
      .map((record) => readBoardObject(record));
    expect(objects).toHaveLength(2);
    const pasted = objects.find((object) => object.id !== RECTANGLE_ONE);
    expect(pasted?.style.get("fill")).toBe("#fff3bf");
    expect(factory.instances[0].selection).toEqual([pasted?.id]);

    await act(async () => context.undo.undo());
    expect(getPageObjects(context.document).has(RECTANGLE_ONE)).toBe(true);
    expect(getPageObjects(context.document).size).toBe(1);
  });

  it("pastes plain text as one collaborative text object at the captured cursor", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    context.undo.clear();
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    setBoardViewport(800, 600);
    focusBoard();
    await act(async () => {
      factory.instances[0].callbacks.onCursorChange({ x: 310, y: 220 });
    });
    const data = new MemoryClipboardData();
    data.setData("text/plain", "  Первая строка\nВторая строка  ");

    let pasteEvent!: Event;
    await act(async () => {
      pasteEvent = dispatchClipboardEvent("paste", data);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(pasteEvent.defaultPrevented).toBe(true);
    const entries = [...getPageObjects(context.document).entries()];
    expect(entries).toHaveLength(1);
    const [id, record] = entries[0];
    const pasted = readBoardObject(record);
    expect(pasted.kind).toBe(BUILTIN_OBJECT_KINDS.text);
    expect(getCollaborativeText(record, "text")?.toString())
      .toBe("  Первая строка\nВторая строка  ");
    expect(pasted.transform[0] + pasted.transform[2] / 2).toBe(310);
    expect(pasted.transform[1] + pasted.transform[3] / 2).toBe(220);
    expect(factory.instances[0].selection).toEqual([id]);
    expect(container?.querySelector(".board-v2__editor")).toBeNull();

    await act(async () => context.undo.undo());
    expect(getPageObjects(context.document).size).toBe(0);
    expect(context.undo.canUndo).toBe(false);
    await act(async () => context.undo.redo());
    expect(getPageObjects(context.document).size).toBe(1);
  });

  it("persists a pasted image before creating its object and freezes its anchor", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    context.undo.clear();
    const factory = new FakeRendererFactory();
    let resolveInsertion!: (
      value: Awaited<ReturnType<NonNullable<BoardSurfaceProps["insertImage"]>>>,
    ) => void;
    const insertion = new Promise<
      Awaited<ReturnType<NonNullable<BoardSurfaceProps["insertImage"]>>>
    >((resolve) => {
      resolveInsertion = resolve;
    });
    const insertImage = vi.fn(() => insertion);

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        insertImage,
      })));
    });
    setBoardViewport(800, 600);
    focusBoard();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyP",
        key: "p",
      }));
      factory.instances[0].callbacks.onCursorChange({ x: 200, y: 150 });
    });
    expect(factory.instances[0].tool).toBe("pen");
    const file = new File([Uint8Array.of(1, 2, 3)], "clipboard.png", {
      type: "image/png",
    });
    const data = imageClipboardData(file, "screenshot fallback");

    let pasteEvent!: Event;
    await act(async () => {
      pasteEvent = dispatchClipboardEvent("paste", data);
      await Promise.resolve();
    });
    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(insertImage).toHaveBeenCalledWith(file);
    expect(getPageObjects(context.document).size).toBe(0);
    expect(factory.instances[0].tool).toBe("pen");
    expect(factory.instances[0].selection).toEqual([]);

    await act(async () => {
      factory.instances[0].callbacks.onCursorChange({ x: 700, y: 500 });
      factory.instances[0].callbacks.onCameraChange({
        x: 180,
        y: 120,
        zoom: 2,
      });
      resolveInsertion({
        assetId: "clipboard-asset",
        contentHash: "a".repeat(64),
        mimeType: "image/png",
        width: 400,
        height: 200,
        originalBytes: file.size,
      });
      await insertion;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const [[id, record]] = [...getPageObjects(context.document).entries()];
    const image = readBoardObject(record);
    expect(image.kind).toBe(BUILTIN_OBJECT_KINDS.image);
    expect(image.props.get("assetId")).toBe("clipboard-asset");
    expect(image.props.get("contentHash")).toBe("a".repeat(64));
    expect(image.transform[0] + image.transform[2] / 2).toBe(200);
    expect(image.transform[1] + image.transform[3] / 2).toBe(150);
    expect(factory.instances[0].tool).toBe("select");
    expect(factory.instances[0].selection).toEqual([id]);
    await act(async () => context.undo.undo());
    expect(getPageObjects(context.document).size).toBe(0);
  });

  it("creates no partial object when pasted image persistence fails", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    context.undo.clear();
    const factory = new FakeRendererFactory();
    const insertImage = vi.fn().mockRejectedValue(
      new Error("Clipboard image is invalid"),
    );

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        insertImage,
      })));
    });
    focusBoard();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyP",
        key: "p",
      }));
    });
    expect(factory.instances[0].tool).toBe("pen");
    const file = new File([Uint8Array.of(1)], "invalid.png", {
      type: "image/png",
    });
    await act(async () => {
      dispatchClipboardEvent("paste", imageClipboardData(file));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(insertImage).toHaveBeenCalledTimes(1);
    expect(getPageObjects(context.document).size).toBe(0);
    expect(context.undo.canUndo).toBe(false);
    expect(container?.textContent).toContain("Clipboard image is invalid");
    expect(factory.instances[0].tool).toBe("pen");
    expect(factory.instances[0].selection).toEqual([]);
  });

  it("serializes image and text paste while preserving each command anchor", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    context.undo.clear();
    const factory = new FakeRendererFactory();
    let resolveInsertion!: (
      value: Awaited<ReturnType<NonNullable<BoardSurfaceProps["insertImage"]>>>,
    ) => void;
    const insertion = new Promise<
      Awaited<ReturnType<NonNullable<BoardSurfaceProps["insertImage"]>>>
    >((resolve) => {
      resolveInsertion = resolve;
    });
    const insertImage = vi.fn(() => insertion);

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        insertImage,
      })));
    });
    setBoardViewport(800, 600);
    focusBoard();
    const file = new File([Uint8Array.of(1)], "queued.png", {
      type: "image/png",
    });
    await act(async () => {
      factory.instances[0].callbacks.onCursorChange({ x: 100, y: 100 });
      dispatchClipboardEvent("paste", imageClipboardData(file));
      await Promise.resolve();
      factory.instances[0].callbacks.onCursorChange({ x: 500, y: 320 });
      const text = new MemoryClipboardData();
      text.setData("text/plain", "queued text");
      dispatchClipboardEvent("paste", text);
      await Promise.resolve();
    });
    expect(getPageObjects(context.document).size).toBe(0);

    await act(async () => {
      resolveInsertion({
        assetId: "queued-asset",
        contentHash: "b".repeat(64),
        mimeType: "image/png",
        width: 120,
        height: 80,
        originalBytes: file.size,
      });
      await insertion;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const pasted = [...getPageObjects(context.document).values()]
      .map((record) => readBoardObject(record));
    expect(pasted).toHaveLength(2);
    const image = pasted.find(
      (object) => object.kind === BUILTIN_OBJECT_KINDS.image,
    )!;
    const text = pasted.find(
      (object) => object.kind === BUILTIN_OBJECT_KINDS.text,
    )!;
    expect(image.transform[0] + image.transform[2] / 2).toBe(100);
    expect(image.transform[1] + image.transform[3] / 2).toBe(100);
    expect(text.transform[0] + text.transform[2] / 2).toBe(500);
    expect(text.transform[1] + text.transform[3] / 2).toBe(320);

    await act(async () => context.undo.undo());
    expect([...getPageObjects(context.document).values()]
      .map((record) => readBoardObject(record).kind))
      .toEqual([BUILTIN_OBJECT_KINDS.image]);
    await act(async () => context.undo.undo());
    expect(getPageObjects(context.document).size).toBe(0);
  });

  it("queues a toolbar clipboard read before later native paste events", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    context.undo.clear();
    const factory = new FakeRendererFactory();
    let finishRead!: (value: string) => void;
    const read = new Promise<string>((resolve) => {
      finishRead = resolve;
    });
    const clipboard = new BoardClipboard({
      readText: () => read,
    });

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        clipboard,
      })));
    });
    setBoardViewport(800, 600);
    focusBoard();
    await act(async () => {
      factory.instances[0].callbacks.onCursorChange({ x: 100, y: 100 });
    });
    const pasteButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Вставить"]',
    );
    await act(async () => {
      pasteButton?.click();
      await Promise.resolve();
      factory.instances[0].callbacks.onCursorChange({ x: 500, y: 320 });
      const nativeText = new MemoryClipboardData();
      nativeText.setData("text/plain", "native second");
      dispatchClipboardEvent("paste", nativeText);
      await Promise.resolve();
    });

    expect(getPageObjects(context.document).size).toBe(0);

    await act(async () => {
      finishRead("toolbar first");
      await read;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const texts = orderedObjectIds(context).map((id) => {
      const record = getPageObjects(context.document).get(id);
      return record ? getCollaborativeText(record, "text")?.toString() : null;
    });
    expect(texts).toEqual(["toolbar first", "native second"]);
    const objects = orderedObjectIds(context).map((id) => {
      const record = getPageObjects(context.document).get(id);
      if (!record) throw new Error(`Missing pasted object ${id}`);
      return readBoardObject(record);
    });
    expect(objects[0].transform[0] + objects[0].transform[2] / 2).toBe(100);
    expect(objects[0].transform[1] + objects[0].transform[3] / 2).toBe(100);
    expect(objects[1].transform[0] + objects[1].transform[2] / 2).toBe(500);
    expect(objects[1].transform[1] + objects[1].transform[3] / 2).toBe(320);
  });

  it("queues Duplicate behind an earlier toolbar clipboard read", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#fff3bf");
    context.undo.clear();
    const factory = new FakeRendererFactory();
    let finishRead!: (value: string) => void;
    const read = new Promise<string>((resolve) => {
      finishRead = resolve;
    });
    const clipboard = new BoardClipboard({
      readText: () => read,
    });

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        clipboard,
      })));
    });
    setBoardViewport(800, 600);
    await act(async () => {
      factory.instances[0].callbacks.onSelectionChange([RECTANGLE_ONE]);
      factory.instances[0].callbacks.onCursorChange({ x: 120, y: 100 });
    });
    focusBoard();
    const pasteButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Вставить"]',
    );
    await act(async () => {
      pasteButton?.click();
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyD",
        key: "d",
        ctrlKey: true,
      }));
      await Promise.resolve();
    });

    expect(getPageObjects(context.document).size).toBe(1);

    await act(async () => {
      finishRead("toolbar first");
      await read;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(orderedObjectIds(context).map((id) => {
      const record = getPageObjects(context.document).get(id);
      if (!record) throw new Error(`Missing queued object ${id}`);
      return readBoardObject(record).kind;
    })).toEqual([
      BUILTIN_OBJECT_KINDS.rectangle,
      BUILTIN_OBJECT_KINDS.text,
      BUILTIN_OBJECT_KINDS.rectangle,
    ]);

    await act(async () => context.undo.undo());
    expect(getPageObjects(context.document).size).toBe(2);
    await act(async () => context.undo.undo());
    expect(getPageObjects(context.document).size).toBe(1);
  });

  it("starts a new document paste queue without waiting for stale image persistence", async () => {
    const source = createBoardContext(PAGE_ONE);
    const target = createBoardContext(PAGE_TWO);
    contexts.push(source, target);
    source.undo.clear();
    target.undo.clear();
    const factory = new FakeRendererFactory();
    let resolveInsertion!: (
      value: Awaited<ReturnType<NonNullable<BoardSurfaceProps["insertImage"]>>>,
    ) => void;
    const insertion = new Promise<
      Awaited<ReturnType<NonNullable<BoardSurfaceProps["insertImage"]>>>
    >((resolve) => {
      resolveInsertion = resolve;
    });
    const insertImage = vi.fn(() => insertion);

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(source, factory, {
        insertImage,
      })));
    });
    focusBoard();
    const file = new File([Uint8Array.of(1)], "stale-queue.png", {
      type: "image/png",
    });
    await act(async () => {
      dispatchClipboardEvent("paste", imageClipboardData(file));
      await Promise.resolve();
    });
    expect(insertImage).toHaveBeenCalledTimes(1);

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(target, factory, {
        insertImage,
      })));
    });
    focusBoard();
    const text = new MemoryClipboardData();
    text.setData("text/plain", "new document text");
    await act(async () => {
      dispatchClipboardEvent("paste", text);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(getPageObjects(target.document).size).toBe(1);
    expect(container?.querySelector<HTMLButtonElement>(
      '[aria-label="Вставить"]',
    )?.disabled).toBe(false);

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(source, factory, {
        insertImage,
      })));
    });
    await act(async () => {
      resolveInsertion({
        assetId: "stale-queue-asset",
        contentHash: "f".repeat(64),
        mimeType: "image/png",
        width: 100,
        height: 80,
        originalBytes: file.size,
      });
      await insertion;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(getPageObjects(source.document).size).toBe(0);
    expect(getPageObjects(target.document).size).toBe(1);
    expect(source.undo.canUndo).toBe(false);
  });

  it("degrades an asynchronous cut to copy-only when the document changes", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#fff3bf");
    context.undo.clear();
    const factory = new FakeRendererFactory();
    let finishWrite: (() => void) | undefined;
    const write = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const clipboard = new BoardClipboard({
      writeText: () => write,
      readText: async () => "",
    });

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        clipboard,
      })));
    });
    await act(async () => {
      factory.instances[0].callbacks.onSelectionChange([RECTANGLE_ONE]);
    });
    const cutButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Вырезать выбранное"]',
    );
    await act(async () => cutButton?.click());

    await act(async () => {
      setObjectTransform(
        context.document,
        RECTANGLE_ONE,
        [40, 50, 120, 80, 0],
        Object.freeze({ type: "remote-test" }),
      );
      finishWrite?.();
      await write;
      await Promise.resolve();
    });

    expect(getPageObjects(context.document).has(RECTANGLE_ONE)).toBe(true);
    expect(container?.textContent).toContain("не удалены");
  });

  it("never revives an asynchronous cut after an A-B-A document switch", async () => {
    const source = createBoardContext(PAGE_ONE);
    const other = createBoardContext(PAGE_TWO);
    contexts.push(source, other);
    addRectangle(source, RECTANGLE_ONE, "a0", "#fff3bf");
    source.undo.clear();
    const factory = new FakeRendererFactory();
    let finishWrite!: () => void;
    const write = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const clipboard = new BoardClipboard({
      writeText: () => write,
    });

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(source, factory, {
        clipboard,
      })));
    });
    await act(async () => {
      factory.instances[0].callbacks.onSelectionChange([RECTANGLE_ONE]);
    });
    const cutButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Вырезать выбранное"]',
    );
    await act(async () => cutButton?.click());

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(other, factory, {
        clipboard,
      })));
    });
    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(source, factory, {
        clipboard,
      })));
    });
    await act(async () => {
      factory.instances.at(-1)?.callbacks.onSelectionChange([RECTANGLE_ONE]);
      finishWrite();
      await write;
      await Promise.resolve();
    });

    expect(getPageObjects(source.document).has(RECTANGLE_ONE)).toBe(true);
    expect(source.undo.canUndo).toBe(false);
  });

  it("allows copy but never cut or paste while read-only", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#fff3bf");
    context.undo.clear();
    const factory = new FakeRendererFactory();
    const insertImage = vi.fn();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        readOnly: true,
        insertImage,
      })));
    });
    await act(async () => {
      factory.instances[0].callbacks.onSelectionChange([RECTANGLE_ONE]);
    });
    focusBoard();

    const data = new MemoryClipboardData();
    expect(dispatchClipboardEvent("copy", data).defaultPrevented).toBe(true);
    expect(dispatchClipboardEvent("cut", data).defaultPrevented).toBe(false);
    expect(getPageObjects(context.document).size).toBe(1);
    expect(dispatchClipboardEvent("paste", data).defaultPrevented).toBe(false);
    const text = new MemoryClipboardData();
    text.setData("text/plain", "external text");
    expect(dispatchClipboardEvent("paste", text).defaultPrevented).toBe(false);
    const image = new File([Uint8Array.of(1)], "readonly.png", {
      type: "image/png",
    });
    expect(dispatchClipboardEvent(
      "paste",
      imageClipboardData(image),
    ).defaultPrevented).toBe(false);
    await act(async () => Promise.resolve());
    expect(getPageObjects(context.document).size).toBe(1);
    expect(insertImage).not.toHaveBeenCalled();
    expect(context.undo.canUndo).toBe(false);
  });

  it("keeps native paste inside an inline text editor", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addText(context, TEXT_ONE, "a0", "normal");
    context.undo.clear();
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    await act(async () => {
      factory.instances[0].callbacks.onSelectionChange([TEXT_ONE]);
    });
    focusBoard();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Enter",
        key: "Enter",
      }));
    });
    const editor = container?.querySelector<HTMLTextAreaElement>(
      ".board-v2__editor textarea",
    );
    expect(editor).not.toBeNull();
    editor?.focus();
    const data = new MemoryClipboardData();
    data.setData("text/plain", "native editor paste");

    const event = dispatchClipboardEvent("paste", data, editor!);
    expect(event.defaultPrevented).toBe(false);
    await act(async () => Promise.resolve());
    expect(getPageObjects(context.document).size).toBe(1);
    expect(context.undo.canUndo).toBe(false);
  });

  it("exits ordinary text editing to unselected board shortcuts on Escape", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addText(context, TEXT_ONE, "a0", "bold italic");
    setObjectTransform(
      context.document,
      TEXT_ONE,
      [10, 20, 180, 60, Math.PI / 6],
      context.origin,
    );
    context.undo.clear();
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    await act(async () => {
      factory.instances[0].callbacks.onSelectionChange([TEXT_ONE]);
    });
    factory.instances[0].camera = { x: 37, y: -11, zoom: 1.5 };
    focusBoard();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Enter",
        key: "Enter",
      }));
    });

    const overlay = container?.querySelector<HTMLElement>(
      ".board-v2__editor--inline-text",
    );
    const editor = overlay?.querySelector<HTMLTextAreaElement>("textarea");
    const board = container?.querySelector<HTMLElement>(".board-v2");
    expect(overlay).not.toBeNull();
    expect(editor?.getAttribute("aria-label")).toBe("Редактировать текст");
    expect(editor?.getAttribute("wrap")).toBe("soft");
    expect(overlay?.style.left).toBe("52px");
    expect(overlay?.style.top).toBe("19px");
    expect(overlay?.style.width).toBe("270px");
    expect(overlay?.style.height).toBe("90px");
    expect(overlay?.style.fontSize).toBe("30px");
    expect(overlay?.style.fontWeight).toBe("700");
    expect(overlay?.style.fontStyle).toBe("italic");
    expect(overlay?.style.transform).toBe(`rotate(${Math.PI / 6}rad)`);
    expect(factory.instances[0].inlineEditingObjectId).toBe(TEXT_ONE);
    expect(overlay?.querySelector(".board-v2__editor-head")).toBeNull();
    expect(overlay?.querySelector("button")).toBeNull();
    expect(overlay?.querySelector("pre")).toBeNull();
    expect(container?.querySelector(".board-v2__editor--code")).toBeNull();
    expect(factory.instances[0].selection).toEqual([TEXT_ONE]);
    expect(document.activeElement).toBe(editor);

    await act(async () => {
      editor?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Escape",
        key: "Escape",
      }));
    });
    expect(factory.instances[0].inlineEditingObjectId).toBeNull();
    expect(container?.querySelector(".board-v2__editor--inline-text")).toBeNull();
    expect(factory.instances[0].selection).toEqual([]);
    expect(document.activeElement).toBe(board);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Digit2",
        key: "2",
      }));
    });
    expect(factory.instances[0].tool).toBe("pen");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Digit1",
        key: "1",
      }));
    });
    expect(factory.instances[0].tool).toBe("select");
  });

  it("reads rich clipboard images from the toolbar paste command", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    context.undo.clear();
    const factory = new FakeRendererFactory();
    const blob = new Blob([Uint8Array.of(1, 2, 3)], {
      type: "image/png",
    });
    const read = vi.fn().mockResolvedValue([
      systemClipboardItem({
        "text/plain": "screenshot fallback",
        "image/png": blob,
      }),
    ]);
    const clipboard = new BoardClipboard({ read });
    const insertImage = vi.fn().mockResolvedValue({
      assetId: "toolbar-asset",
      contentHash: "c".repeat(64),
      mimeType: "image/png",
      width: 320,
      height: 180,
      originalBytes: blob.size,
    });

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        clipboard,
        insertImage,
      })));
    });
    setBoardViewport(800, 600);
    const pasteButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Вставить"]',
    );
    await act(async () => {
      pasteButton?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(insertImage).toHaveBeenCalledTimes(1);
    const [record] = [...getPageObjects(context.document).values()];
    const image = readBoardObject(record);
    expect(image.kind).toBe(BUILTIN_OBJECT_KINDS.image);
    expect(image.props.get("assetId")).toBe("toolbar-asset");
    expect(image.transform[0] + image.transform[2] / 2).toBe(400);
    expect(image.transform[1] + image.transform[3] / 2).toBe(300);
  });

  it("prefers a Board Fragment over image and text event representations", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#fff3bf");
    context.undo.clear();
    const factory = new FakeRendererFactory();
    const insertImage = vi.fn();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        insertImage,
      })));
    });
    await act(async () => {
      factory.instances[0].callbacks.onSelectionChange([RECTANGLE_ONE]);
    });
    focusBoard();
    const file = new File([Uint8Array.of(1)], "fallback.png", {
      type: "image/png",
    });
    const data = imageClipboardData(file, "ordinary text");
    dispatchClipboardEvent("copy", data);

    await act(async () => {
      dispatchClipboardEvent("paste", data);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(insertImage).not.toHaveBeenCalled();
    expect(getPageObjects(context.document).size).toBe(2);
    expect([...getPageObjects(context.document).values()]
      .map((record) => readBoardObject(record).kind))
      .toEqual([
        BUILTIN_OBJECT_KINDS.rectangle,
        BUILTIN_OBJECT_KINDS.rectangle,
      ]);
  });

  it("does not create an image object after the target document changes", async () => {
    const source = createBoardContext(PAGE_ONE);
    const target = createBoardContext(PAGE_TWO);
    contexts.push(source, target);
    source.undo.clear();
    target.undo.clear();
    const factory = new FakeRendererFactory();
    let resolveInsertion!: (
      value: Awaited<ReturnType<NonNullable<BoardSurfaceProps["insertImage"]>>>,
    ) => void;
    const insertion = new Promise<
      Awaited<ReturnType<NonNullable<BoardSurfaceProps["insertImage"]>>>
    >((resolve) => {
      resolveInsertion = resolve;
    });
    const insertImage = vi.fn(() => insertion);

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(source, factory, {
        insertImage,
      })));
    });
    focusBoard();
    const file = new File([Uint8Array.of(1)], "pending.png", {
      type: "image/png",
    });
    await act(async () => {
      dispatchClipboardEvent("paste", imageClipboardData(file));
      await Promise.resolve();
    });
    expect(insertImage).toHaveBeenCalledTimes(1);

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(target, factory, {
        insertImage,
      })));
    });
    await act(async () => {
      resolveInsertion({
        assetId: "orphan-safe-asset",
        contentHash: "d".repeat(64),
        mimeType: "image/png",
        width: 100,
        height: 100,
        originalBytes: file.size,
      });
      await insertion;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(getPageObjects(source.document).size).toBe(0);
    expect(getPageObjects(target.document).size).toBe(0);
    expect(source.undo.canUndo).toBe(false);
    expect(target.undo.canUndo).toBe(false);
  });

  it("does not create an image object after becoming read-only", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    context.undo.clear();
    const factory = new FakeRendererFactory();
    let resolveInsertion!: (
      value: Awaited<ReturnType<NonNullable<BoardSurfaceProps["insertImage"]>>>,
    ) => void;
    const insertion = new Promise<
      Awaited<ReturnType<NonNullable<BoardSurfaceProps["insertImage"]>>>
    >((resolve) => {
      resolveInsertion = resolve;
    });
    const insertImage = vi.fn(() => insertion);

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        insertImage,
      })));
    });
    focusBoard();
    const file = new File([Uint8Array.of(1)], "pending-readonly.png", {
      type: "image/png",
    });
    await act(async () => {
      dispatchClipboardEvent("paste", imageClipboardData(file));
      await Promise.resolve();
    });
    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        insertImage,
        readOnly: true,
      })));
    });
    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        insertImage,
        readOnly: false,
      })));
    });
    await act(async () => {
      resolveInsertion({
        assetId: "readonly-orphan",
        contentHash: "e".repeat(64),
        mimeType: "image/png",
        width: 100,
        height: 80,
        originalBytes: file.size,
      });
      await insertion;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(getPageObjects(context.document).size).toBe(0);
    expect(context.undo.canUndo).toBe(false);
  });

  it("invalidates a pending image paste on Undo without consuming Redo", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#fff3bf");
    context.undo.clear();
    const factory = new FakeRendererFactory();
    let resolveInsertion!: (
      value: Awaited<ReturnType<NonNullable<BoardSurfaceProps["insertImage"]>>>,
    ) => void;
    const insertion = new Promise<
      Awaited<ReturnType<NonNullable<BoardSurfaceProps["insertImage"]>>>
    >((resolve) => {
      resolveInsertion = resolve;
    });
    const insertImage = vi.fn(() => insertion);
    const rectangleX = () => {
      const record = getPageObjects(context.document).get(RECTANGLE_ONE);
      if (!record) throw new Error("Undo test rectangle is missing");
      return readBoardObject(record).transform[0];
    };

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        insertImage,
      })));
    });
    await act(async () => {
      setObjectTransform(
        context.document,
        RECTANGLE_ONE,
        [40, 50, 120, 80, 0],
        context.origin,
      );
      context.undo.commandBoundary();
    });
    focusBoard();
    const file = new File([Uint8Array.of(1)], "undo-pending.png", {
      type: "image/png",
    });
    await act(async () => {
      dispatchClipboardEvent("paste", imageClipboardData(file));
      await Promise.resolve();
    });

    expect(insertImage).toHaveBeenCalledTimes(1);
    expect(container?.querySelector<HTMLButtonElement>(
      '[aria-label="Вставить"]',
    )?.disabled).toBe(true);

    await act(async () => {
      context.undo.undo();
      await Promise.resolve();
    });
    expect(rectangleX()).toBe(10);
    expect(context.undo.canRedo).toBe(true);
    expect(container?.querySelector<HTMLButtonElement>(
      '[aria-label="Вставить"]',
    )?.disabled).toBe(false);

    await act(async () => {
      resolveInsertion({
        assetId: "undo-pending-asset",
        contentHash: "1".repeat(64),
        mimeType: "image/png",
        width: 100,
        height: 80,
        originalBytes: file.size,
      });
      await insertion;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(getPageObjects(context.document).size).toBe(1);
    expect(context.undo.canRedo).toBe(true);
    await act(async () => context.undo.redo());
    expect(rectangleX()).toBe(40);
    expect(getPageObjects(context.document).size).toBe(1);
  });

  it("keeps a pending image paste separate from an intervening local text edit", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addText(context, TEXT_ONE, "a0", "normal");
    context.undo.clear();
    const factory = new FakeRendererFactory();
    let resolveInsertion!: (
      value: Awaited<ReturnType<NonNullable<BoardSurfaceProps["insertImage"]>>>,
    ) => void;
    const insertion = new Promise<
      Awaited<ReturnType<NonNullable<BoardSurfaceProps["insertImage"]>>>
    >((resolve) => {
      resolveInsertion = resolve;
    });
    const insertImage = vi.fn(() => insertion);

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        insertImage,
      })));
    });
    focusBoard();
    const file = new File([Uint8Array.of(2)], "text-boundary.png", {
      type: "image/png",
    });
    await act(async () => {
      dispatchClipboardEvent("paste", imageClipboardData(file));
      await Promise.resolve();
    });

    const textRecord = getPageObjects(context.document).get(TEXT_ONE);
    const text = textRecord
      ? getCollaborativeText(textRecord, "text")
      : undefined;
    if (!text) throw new Error("Collaborative text was not created");
    await act(async () => {
      context.document.transact(() => {
        text.insert(text.length, " изменён");
      }, context.origin);
    });
    expect(text.toString()).toBe("Текст изменён");

    await act(async () => {
      resolveInsertion({
        assetId: "text-boundary-asset",
        contentHash: "2".repeat(64),
        mimeType: "image/png",
        width: 120,
        height: 90,
        originalBytes: file.size,
      });
      await insertion;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(getPageObjects(context.document).size).toBe(2);

    await act(async () => context.undo.undo());
    expect(getPageObjects(context.document).size).toBe(1);
    expect(getPageObjects(context.document).has(TEXT_ONE)).toBe(true);
    expect(text.toString()).toBe("Текст изменён");
    expect(context.undo.canUndo).toBe(true);
  });

  it("validates foreign image references before mutating the target document", async () => {
    const source = createBoardContext(PAGE_ONE);
    const target = createBoardContext(PAGE_TWO);
    contexts.push(source, target);
    addBoardObject(source.document, {
      id: IMAGE_OBJECT,
      kind: BUILTIN_OBJECT_KINDS.image,
      version: 1,
      transform: [10, 20, 320, 180, 0],
      zRank: "a0",
      props: {
        assetId: "asset-1",
        contentHash: "a".repeat(64),
        mimeType: "image/png",
        pixelWidth: 4,
        pixelHeight: 3,
        originalBytes: 100,
      },
    }, source.origin);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(source, factory)));
    });
    await act(async () => {
      factory.instances[0].callbacks.onSelectionChange([IMAGE_OBJECT]);
    });
    focusBoard();
    const data = new MemoryClipboardData();
    dispatchClipboardEvent("copy", data);

    const validateFragmentPaste = vi.fn().mockRejectedValue(
      new Error("Изображение недоступно в этой доске"),
    );
    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(target, factory, {
        fragmentScope: {
          boardId: "other-board",
          generation: 1,
          pageId: PAGE_TWO,
        },
        validateFragmentPaste,
      })));
    });
    focusBoard();
    await act(async () => {
      dispatchClipboardEvent("paste", data);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(validateFragmentPaste).toHaveBeenCalledTimes(1);
    expect(getPageObjects(target.document).size).toBe(0);
    expect(container?.textContent).toContain("Изображение недоступно");
  });
});

describe("BoardSurface context menu", () => {
  it("targets objects with desktop selection rules and keeps opening local-only", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#ffffff");
    addRectangle(context, RECTANGLE_TWO, "a1", "#fff3bf");
    addRectangle(context, RECTANGLE_THREE, "a2", "#dbeafe");
    context.undo.clear();
    const updates = vi.fn();
    context.document.on("update", updates);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    await act(async () => {
      factory.instances[0].callbacks.onSelectionChange([
        RECTANGLE_ONE,
        RECTANGLE_TWO,
      ]);
      factory.instances[0].callbacks.onContextMenu({
        screen: { x: 120, y: 90 },
        world: { x: 120, y: 90 },
        objectId: RECTANGLE_ONE,
      });
    });

    expect(factory.instances[0].selection).toEqual([
      RECTANGLE_ONE,
      RECTANGLE_TWO,
    ]);
    const objectMenu = container?.querySelector<HTMLElement>(
      '.board-v2__context-menu:not(.board-v2__context-menu--submenu)',
    );
    expect(objectMenu?.textContent).toContain("Порядок слоёв");
    expect(objectMenu?.textContent).not.toContain("На передний план");

    await act(async () => {
      factory.instances[0].callbacks.onContextMenu({
        screen: { x: 180, y: 130 },
        world: { x: 180, y: 130 },
        objectId: RECTANGLE_THREE,
      });
    });
    expect(factory.instances[0].selection).toEqual([RECTANGLE_THREE]);

    await act(async () => {
      factory.instances[0].callbacks.onContextMenu({
        screen: { x: 240, y: 180 },
        world: { x: 240, y: 180 },
        objectId: null,
      });
    });
    expect(factory.instances[0].selection).toEqual([]);
    expect(container?.querySelector('[role="menu"]')?.textContent)
      .toContain("Показывать сетку");
    expect(updates).not.toHaveBeenCalled();
    expect(context.undo.canUndo).toBe(false);
    expect(factory.instances[0].cancelInteractionCount).toBe(3);
  });

  it("deletes through the shared command path as one undoable item", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#ffffff");
    context.undo.clear();
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    await act(async () => {
      factory.instances[0].callbacks.onContextMenu({
        screen: { x: 40, y: 50 },
        world: { x: 40, y: 50 },
        objectId: RECTANGLE_ONE,
      });
    });
    const deleteButton = [...(container?.querySelectorAll<HTMLButtonElement>(
      '[role="menu"] button',
    ) ?? [])].find((button) => button.textContent?.includes("Удалить"));
    await act(async () => deleteButton?.click());

    expect(getPageObjects(context.document).has(RECTANGLE_ONE)).toBe(false);
    expect(context.undo.canUndo).toBe(true);
    await act(async () => context.undo.undo());
    expect(getPageObjects(context.document).has(RECTANGLE_ONE)).toBe(true);
    expect(context.undo.canUndo).toBe(false);
  });

  it("persists grid visibility and updates the renderer without board data", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    window.localStorage.setItem(BOARD_GRID_VISIBILITY_STORAGE_KEY, "false");
    const updates = vi.fn();
    context.document.on("update", updates);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    expect(factory.instances[0].gridVisible).toBe(false);

    await act(async () => {
      factory.instances[0].callbacks.onContextMenu({
        screen: { x: 100, y: 100 },
        world: { x: 100, y: 100 },
        objectId: null,
      });
    });
    const gridButton = container?.querySelector<HTMLButtonElement>(
      '[role="menuitemcheckbox"]',
    );
    expect(gridButton?.getAttribute("aria-checked")).toBe("false");
    await act(async () => gridButton?.click());

    expect(factory.instances[0].gridVisible).toBe(true);
    expect(window.localStorage.getItem(BOARD_GRID_VISIBILITY_STORAGE_KEY))
      .toBe("true");
    expect(updates).not.toHaveBeenCalled();
  });

  it("keeps board shortcuts out of the accessible keyboard menu", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#ffffff");
    context.undo.clear();
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    await act(async () => {
      factory.instances[0].callbacks.onSelectionChange([RECTANGLE_ONE]);
    });
    focusBoard();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "ContextMenu",
        key: "ContextMenu",
      }));
    });

    const menu = container?.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    expect((document.activeElement as HTMLElement | null)?.textContent)
      .toContain("Вырезать");

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "ArrowDown",
        key: "ArrowDown",
      }));
    });
    expect((document.activeElement as HTMLElement | null)?.textContent)
      .toContain("Копировать");

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Delete",
        key: "Delete",
      }));
    });
    expect(getPageObjects(context.document).has(RECTANGLE_ONE)).toBe(true);

    let digitAccepted = false;
    await act(async () => {
      digitAccepted = document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: "Digit3",
          key: "3",
        }),
      ) ?? false;
    });
    expect(digitAccepted).toBe(true);
    expect(factory.instances[0].tool).toBe("select");

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Escape",
        key: "Escape",
      }));
    });
    expect(container?.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(container?.querySelector(".board-v2"));
    expect(factory.instances[0].selection).toEqual([RECTANGLE_ONE]);
  });

  it("opens the layer group by hover, click, and keyboard without mixing menu levels", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#ffffff");
    context.undo.clear();
    const updates = vi.fn();
    context.document.on("update", updates);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    await act(async () => {
      factory.instances[0].callbacks.onSelectionChange([RECTANGLE_ONE]);
      factory.instances[0].callbacks.onContextMenu({
        screen: { x: 120, y: 90 },
        world: { x: 120, y: 90 },
        objectId: RECTANGLE_ONE,
      });
    });

    const mainMenu = container?.querySelector<HTMLElement>(
      '.board-v2__context-menu:not(.board-v2__context-menu--submenu)',
    );
    const layerGroup = [...(mainMenu?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]',
    ) ?? [])].find((button) => button.textContent?.includes("Порядок слоёв"));
    expect(layerGroup?.getAttribute("aria-haspopup")).toBe("menu");
    expect(layerGroup?.getAttribute("aria-expanded")).toBe("false");
    expect(layerGroup?.getAttribute("aria-controls")).toBeTruthy();
    expect(mainMenu?.textContent).not.toContain("На передний план");
    const focusBeforeHover = document.activeElement;

    await act(async () => {
      layerGroup?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    });
    let submenu = container?.querySelector<HTMLElement>(
      ".board-v2__context-menu--submenu",
    );
    expect(submenu).not.toBeNull();
    expect(layerGroup?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(focusBeforeHover);
    expect([...submenu!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .map((button) => button.textContent)).toEqual([
      "На передний планCtrl+Shift+]",
      "На слой вышеCtrl+]",
      "На слой нижеCtrl+[",
      "На задний планCtrl+Shift+[",
    ]);
    expect(updates).not.toHaveBeenCalled();
    expect(context.undo.canUndo).toBe(false);

    vi.useFakeTimers();
    const selectAll = [...(mainMenu?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]',
    ) ?? [])].find((button) => button.textContent?.includes("Выделить всё"));
    await act(async () => {
      selectAll?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
      submenu?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
      vi.advanceTimersByTime(181);
    });
    expect(container?.querySelector(".board-v2__context-menu--submenu")).not.toBeNull();
    vi.useRealTimers();

    await act(async () => layerGroup?.click());
    expect((document.activeElement as HTMLElement | null)?.textContent)
      .toContain("На передний план");
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "End",
      }));
    });
    expect((document.activeElement as HTMLElement | null)?.textContent)
      .toContain("На задний план");
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowLeft",
      }));
    });
    expect(container?.querySelector(".board-v2__context-menu--submenu")).toBeNull();
    expect(document.activeElement).toBe(layerGroup);

    await act(async () => {
      layerGroup?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowRight",
      }));
    });
    submenu = container?.querySelector<HTMLElement>(
      ".board-v2__context-menu--submenu",
    );
    expect(submenu).not.toBeNull();
    expect((document.activeElement as HTMLElement | null)?.textContent)
      .toContain("На передний план");
    vi.useFakeTimers();
    await act(async () => {
      submenu?.dispatchEvent(new MouseEvent("pointerout", {
        bubbles: true,
        relatedTarget: document.body,
      }));
      vi.advanceTimersByTime(181);
    });
    expect(container?.querySelector(".board-v2__context-menu--submenu")).toBeNull();
    expect(document.activeElement).toBe(layerGroup);
    vi.useRealTimers();

    await act(async () => {
      layerGroup?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowRight",
      }));
    });
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
    });
    expect(container?.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(container?.querySelector(".board-v2"));
  });

  it("keeps submenu pointer actions inside the menu and closes both panels outside", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#ffffff");
    addRectangle(context, RECTANGLE_TWO, "a1", "#ffffff");
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    await act(async () => {
      factory.instances[0].callbacks.onSelectionChange([RECTANGLE_ONE]);
      factory.instances[0].callbacks.onContextMenu({
        screen: { x: 100, y: 80 },
        world: { x: 100, y: 80 },
        objectId: RECTANGLE_ONE,
      });
    });
    const layerGroup = [...(container?.querySelectorAll<HTMLButtonElement>(
      '.board-v2__context-menu:not(.board-v2__context-menu--submenu) [role="menuitem"]',
    ) ?? [])].find((button) => button.textContent?.includes("Порядок слоёв"));
    await act(async () => layerGroup?.click());
    const forward = [...(container?.querySelectorAll<HTMLButtonElement>(
      '.board-v2__context-menu--submenu [role="menuitem"]',
    ) ?? [])].find((button) => button.textContent?.includes("На слой выше"));
    await act(async () => {
      forward?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(container?.querySelector(".board-v2__context-menu--submenu")).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(container?.querySelector('[role="menu"]')).toBeNull();
  });

  it("places the layer submenu on the available side and clamps it vertically", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#ffffff");
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    await act(async () => {
      factory.instances[0].callbacks.onSelectionChange([RECTANGLE_ONE]);
      factory.instances[0].callbacks.onContextMenu({
        screen: { x: 100, y: 50 },
        world: { x: 100, y: 50 },
        objectId: RECTANGLE_ONE,
      });
    });
    const surface = container?.querySelector<HTMLElement>(".board-v2");
    const mainMenu = container?.querySelector<HTMLElement>(
      '.board-v2__context-menu:not(.board-v2__context-menu--submenu)',
    );
    const layerGroup = [...(mainMenu?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]',
    ) ?? [])].find((button) => button.textContent?.includes("Порядок слоёв"));
    await act(async () => layerGroup?.click());
    const submenu = container?.querySelector<HTMLElement>(
      ".board-v2__context-menu--submenu",
    );
    expect(surface).not.toBeNull();
    expect(mainMenu).not.toBeNull();
    expect(layerGroup).not.toBeUndefined();
    expect(submenu).not.toBeNull();

    Object.defineProperties(surface!, {
      clientWidth: { configurable: true, value: 900 },
      clientHeight: { configurable: true, value: 600 },
    });
    Object.defineProperties(submenu!, {
      offsetWidth: { configurable: true, value: 272 },
      offsetHeight: { configurable: true, value: 156 },
    });
    vi.spyOn(surface!, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 900,
      bottom: 600,
      left: 0,
      width: 900,
      height: 600,
      toJSON: () => ({}),
    });
    let menuLeft = 100;
    let triggerTop = 200;
    vi.spyOn(mainMenu!, "getBoundingClientRect").mockImplementation(() => ({
      x: menuLeft,
      y: 50,
      top: 50,
      right: menuLeft + 246,
      bottom: 330,
      left: menuLeft,
      width: 246,
      height: 280,
      toJSON: () => ({}),
    }));
    vi.spyOn(layerGroup!, "getBoundingClientRect").mockImplementation(() => ({
      x: menuLeft,
      y: triggerTop,
      top: triggerTop,
      right: menuLeft + 246,
      bottom: triggerTop + 34,
      left: menuLeft,
      width: 246,
      height: 34,
      toJSON: () => ({}),
    }));

    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(submenu?.dataset.side).toBe("right");
    expect(submenu?.style.left).toBe("350px");
    expect(submenu?.style.top).toBe("195px");

    menuLeft = 646;
    triggerTop = 520;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(submenu?.dataset.side).toBe("left");
    expect(submenu?.style.left).toBe("370px");
    expect(submenu?.style.top).toBe("436px");
  });

  it("shows only non-mutating object actions while read-only", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#ffffff");
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        readOnly: true,
      })));
    });
    await act(async () => {
      factory.instances[0].callbacks.onContextMenu({
        screen: { x: 60, y: 70 },
        world: { x: 60, y: 70 },
        objectId: RECTANGLE_ONE,
      });
    });
    const menuText = container?.querySelector('[role="menu"]')?.textContent ?? "";
    expect(menuText).toContain("Копировать");
    expect(menuText).toContain("Выделить всё");
    expect(menuText).not.toContain("Вырезать");
    expect(menuText).not.toContain("Вставить");
    expect(menuText).not.toContain("Дублировать");
    expect(menuText).not.toContain("Удалить");
    expect(menuText).not.toContain("На передний план");
    expect(menuText).not.toContain("Порядок слоёв");
  });

  it("anchors context-menu paste to the invocation point across an async read", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#fff3bf");
    context.undo.clear();
    let finishRead: ((value: string) => void) | undefined;
    const read = new Promise<string>((resolve) => {
      finishRead = resolve;
    });
    const clipboard = new BoardClipboard({
      readText: () => read,
    });
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        clipboard,
      })));
    });
    await act(async () => {
      factory.instances[0].callbacks.onSelectionChange([RECTANGLE_ONE]);
    });
    focusBoard();
    const data = new MemoryClipboardData();
    dispatchClipboardEvent("copy", data);

    await act(async () => {
      factory.instances[0].callbacks.onContextMenu({
        screen: { x: 200, y: 150 },
        world: { x: 200, y: 150 },
        objectId: null,
      });
    });
    const pasteButton = [...(container?.querySelectorAll<HTMLButtonElement>(
      '[role="menu"] button',
    ) ?? [])].find((button) => button.textContent?.includes("Вставить"));
    await act(async () => pasteButton?.click());
    await act(async () => {
      factory.instances[0].callbacks.onCursorChange({ x: 700, y: 500 });
      finishRead?.(data.getData("text/plain"));
      await read;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const pasted = [...getPageObjects(context.document).values()]
      .map((record) => readBoardObject(record))
      .find((object) => object.id !== RECTANGLE_ONE);
    expect(pasted).toBeDefined();
    expect(pasted!.transform[0] + pasted!.transform[2] / 2).toBe(200);
    expect(pasted!.transform[1] + pasted!.transform[3] / 2).toBe(150);
    expect(context.undo.canUndo).toBe(true);
  });
});

describe("BoardSurface style and layer controls", () => {
  it("keeps Line and Arrow curvature independent, local, and persistent", async () => {
    window.localStorage.setItem(
      BOARD_CONNECTOR_CURVATURE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        values: { line: 0.35, arrow: -0.4 },
      }),
    );
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();
    const documentUpdates = vi.fn();
    context.document.on("update", documentUpdates);

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    const line = container?.querySelector<HTMLButtonElement>(
      '[data-toolbar-tool="line"]',
    );
    const arrow = container?.querySelector<HTMLButtonElement>(
      '[data-toolbar-tool="arrow"]',
    );

    await act(async () => line?.click());
    expect(renderer.connectorCurvature).toBeCloseTo(0.35);
    let slider = container?.querySelector<HTMLInputElement>(
      '.board-stylebar__curvature input[type="range"]',
    );
    await act(async () => {
      if (slider) setRangeValue(slider, "0.65");
    });
    expect(renderer.connectorCurvature).toBeCloseTo(0.65);

    await act(async () => arrow?.click());
    expect(renderer.connectorCurvature).toBeCloseTo(-0.4);
    slider = container?.querySelector<HTMLInputElement>(
      '.board-stylebar__curvature input[type="range"]',
    );
    await act(async () => {
      if (slider) setRangeValue(slider, "-0.2");
    });
    expect(renderer.connectorCurvature).toBeCloseTo(-0.2);
    await act(async () => line?.click());
    expect(renderer.connectorCurvature).toBeCloseTo(0.65);

    expect(documentUpdates).not.toHaveBeenCalled();
    expect(context.undo.canUndo).toBe(false);
    expect(JSON.parse(
      window.localStorage.getItem(BOARD_CONNECTOR_CURVATURE_STORAGE_KEY) ?? "{}",
    )).toEqual({
      version: 1,
      values: { line: 0.65, arrow: -0.2 },
    });

    await act(async () => root?.unmount());
    root = createRoot(container!);
    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    await act(async () => container?.querySelector<HTMLButtonElement>(
      '[data-toolbar-tool="line"]',
    )?.click());
    expect(factory.instances.at(-1)?.connectorCurvature).toBeCloseTo(0.65);
    expect(documentUpdates).not.toHaveBeenCalled();
    expect(context.undo.canUndo).toBe(false);
  });

  it("configures independent free-drawing presets without rebuilding or mutating the board", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();
    const documentUpdates = vi.fn();
    context.document.on("update", documentUpdates);

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    expect(container?.querySelector(".board-v2__stylebar")).toBeNull();

    const pen = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Рисование"]',
    );
    expect(pen?.querySelector(".lucide-pencil")).not.toBeNull();
    expect(pen?.querySelector(".lucide-pen-tool")).toBeNull();
    expect(container?.querySelector('[aria-label="Маркер"]')).toBeNull();
    await act(async () => pen?.click());
    const presets = container?.querySelectorAll<HTMLButtonElement>(
      ".board-stylebar__pen-preset",
    );
    expect(presets).toHaveLength(6);
    expect(container?.querySelector('[aria-label="Толщина 8"]')).toBeNull();
    expect(container?.querySelector('[aria-label="Тип линии"]')).toBeNull();

    const red = container?.querySelector<HTMLButtonElement>(
      '[aria-label^="Перо 2,"]',
    );
    const blue = container?.querySelector<HTMLButtonElement>(
      '[aria-label^="Перо 3,"]',
    );
    expect(red).not.toBeNull();
    expect(blue).not.toBeNull();
    const inactiveWheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -120,
    });
    await act(async () => blue?.dispatchEvent(inactiveWheel));
    expect(inactiveWheel.defaultPrevented).toBe(true);
    expect(blue?.style.getPropertyValue("--board-pen-radius")).toBe("3px");
    expect(renderer.creationStyle).toMatchObject({
      stroke: "#17212b",
      strokeWidth: 2.5,
    });

    await act(async () => red?.click());
    expect(container?.querySelector('[role="dialog"]')).toBeNull();
    expect(renderer.creationStyle).toMatchObject({
      stroke: "#d33f49",
      strokeWidth: 2.5,
      opacity: 1,
      dash: [],
      blendMode: "source-over",
    });

    const activeWheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -120,
    });
    await act(async () => red?.dispatchEvent(activeWheel));
    expect(activeWheel.defaultPrevented).toBe(true);
    expect(red?.style.getPropertyValue("--board-pen-radius")).toBe("3px");
    expect(renderer.creationStyle).toMatchObject({
      stroke: "#d33f49",
      strokeWidth: 3,
    });
    expect(documentUpdates).not.toHaveBeenCalled();
    expect(context.undo.canUndo).toBe(false);

    await act(async () => red?.click());
    expect(container?.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      const popover = container?.querySelector<HTMLElement>(
        ".board-stylebar__pen-popover",
      );
      if (popover) openColorFormats(popover);
    });
    const customColor = container?.querySelector<HTMLInputElement>(
      '.board-stylebar__pen-popover [aria-label="Цвет в формате HEX"]',
    );
    const freeDrawingWidth = container?.querySelector<HTMLInputElement>(
      '[aria-label="Толщина линии рисования"]',
    );
    const freeDrawingOpacity = container?.querySelector<HTMLInputElement>(
      '.board-stylebar__pen-popover [aria-label="Непрозрачность"]',
    );
    await act(async () => {
      if (customColor) {
        setRangeValue(customColor, "#123456ff");
        customColor.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        }));
      }
      if (freeDrawingWidth) setRangeValue(freeDrawingWidth, "8");
      if (freeDrawingOpacity) setRangeValue(freeDrawingOpacity, "0.4");
    });
    expect(renderer.creationStyle).toMatchObject({
      stroke: "#123456",
      strokeWidth: 8,
      opacity: 0.4,
      dash: [],
      blendMode: "source-over",
    });
    expect(red?.style.getPropertyValue("--board-swatch")).toBe("#123456");
    expect(red?.style.getPropertyValue("--board-pen-radius")).toBe("8px");
    expect(red?.style.getPropertyValue("--board-swatch-opacity")).toBe("0.4");

    await act(async () => {
      customColor?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
    });
    expect(container?.querySelector(".board-color-picker__formats")).toBeNull();
    expect(container?.querySelector(".board-stylebar__pen-popover"))
      .not.toBeNull();
    expect(document.activeElement).toBe(container?.querySelector(
      ".board-color-picker__preview",
    ));

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
    });
    expect(container?.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(red);

    await act(async () => red?.click());
    expect(container?.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => red?.click());
    expect(container?.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => red?.click());
    expect(container?.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(container?.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => red?.click());
    expect(container?.querySelector('[role="dialog"]')).not.toBeNull();
    const shape = container?.querySelector<HTMLButtonElement>(
      '[data-toolbar-tool="shape"]',
    );
    await act(async () => shape?.click());
    expect(container?.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => container?.querySelector<HTMLButtonElement>(
      '[aria-label^="Цвет заливки:"]',
    )?.click());
    const blueFill = styleSwatch("#dbeafe");
    expect(blueFill).not.toBeNull();
    await act(async () => blueFill?.click());
    const rectangleWidth = container?.querySelector<HTMLInputElement>(
      '[aria-label="Толщина линии"]',
    );
    expect(rectangleWidth?.type).toBe("range");
    await act(async () => {
      if (rectangleWidth) setRangeValue(rectangleWidth, "6");
    });
    expect(renderer.creationStyle).toMatchObject({
      fill: "#dbeafe",
      stroke: "#17212b",
      strokeWidth: 6,
    });

    await act(async () => pen?.click());
    expect(renderer.creationStyle).toMatchObject({
      stroke: "#123456",
      strokeWidth: 8,
      opacity: 0.4,
    });
    expect(container?.querySelector<HTMLButtonElement>(
      '[aria-label^="Перо 2,"]',
    )?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => shape?.click());
    expect(factory.instances).toHaveLength(1);
    expect(renderer.destroyCount).toBe(0);
    expect(renderer.creationStyle).toMatchObject({
      fill: "#dbeafe",
      stroke: "#17212b",
    });
    expect(container?.querySelector(".board-v2"))
      .toHaveProperty(
        "className",
        "board-v2 board-v2--light board-v2--has-stylebar",
      );
    expect(documentUpdates).not.toHaveBeenCalled();
    expect(context.undo.canUndo).toBe(false);
  });

  it("keeps palette add, delete, and reorder device-local across remounts", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const firstFactory = new FakeRendererFactory();
    const documentUpdates = vi.fn();
    const awarenessChanges = vi.fn();
    context.document.on("update", documentUpdates);

    await act(async () => {
      root?.render(createElement(
        BoardSurface,
        surfaceProps(context, firstFactory, {
          onAwarenessChange: awarenessChanges,
        }),
      ));
    });
    await act(async () => {
      container?.querySelector<HTMLButtonElement>(
        '[aria-keyshortcuts="P 2"]',
      )?.click();
    });
    awarenessChanges.mockClear();
    const renderer = firstFactory.instances[0];
    const paletteToggle = container?.querySelector<HTMLButtonElement>(
      ".board-stylebar__palette-toggle",
    );
    expect(paletteToggle).not.toBeNull();
    await act(async () => paletteToggle?.click());
    expect(container?.querySelector(".board-v2__stylebar")?.classList.contains(
      "board-v2__stylebar--palette-editing",
    )).toBe(true);

    const red = container?.querySelector<HTMLButtonElement>(
      '[data-pen-preset-id="red"] .board-stylebar__pen-preset',
    );
    expect(red).not.toBeNull();
    await act(async () => red?.click());
    expect(container?.querySelector('[role="dialog"]')).not.toBeNull();
    expect(renderer.creationStyle).toMatchObject({
      stroke: "#17212b",
      strokeWidth: 2.5,
      opacity: 1,
    });
    await act(async () => {
      const popover = container?.querySelector<HTMLElement>(
        ".board-stylebar__pen-popover",
      );
      if (popover) openColorFormats(popover);
    });
    const color = container?.querySelector<HTMLInputElement>(
      '.board-stylebar__pen-popover [aria-label="Цвет в формате HEX"]',
    );
    await act(async () => {
      if (color) {
        setRangeValue(color, "#abcdefff");
        color.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        }));
      }
    });
    expect(renderer.creationStyle).toMatchObject({
      stroke: "#17212b",
      strokeWidth: 2.5,
      opacity: 1,
    });

    await act(async () => {
      red?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        altKey: true,
        key: "ArrowRight",
      }));
    });
    expect([
      ...(container?.querySelectorAll<HTMLElement>(
        "[data-pen-preset-id]",
      ) ?? []),
    ].map((slot) => slot.dataset.penPresetId).slice(0, 3)).toEqual([
      "graphite",
      "blue",
      "red",
    ]);

    await act(async () => container?.querySelector<HTMLButtonElement>(
      ".board-stylebar__pen-add",
    )?.click());
    expect(container?.querySelectorAll(".board-stylebar__pen-preset"))
      .toHaveLength(7);
    expect(container?.querySelector(
      '[data-pen-preset-id="custom-1"]',
    )).not.toBeNull();
    expect(renderer.creationStyle).toMatchObject({
      stroke: "#17212b",
      strokeWidth: 2.5,
      opacity: 1,
    });

    await act(async () => container?.querySelector<HTMLButtonElement>(
      '[data-pen-preset-id="graphite"] .board-stylebar__pen-delete',
    )?.click());
    expect(container?.querySelectorAll(".board-stylebar__pen-preset"))
      .toHaveLength(6);
    expect(renderer.creationStyle).toMatchObject({
      stroke: "#2563eb",
      strokeWidth: 2.5,
      opacity: 1,
      dash: [],
      blendMode: "source-over",
    });
    expect(firstFactory.instances).toHaveLength(1);
    expect(renderer.destroyCount).toBe(0);
    expect(documentUpdates).not.toHaveBeenCalled();
    expect(awarenessChanges).not.toHaveBeenCalled();
    expect(context.undo.canUndo).toBe(false);

    await act(async () => root?.unmount());
    root = undefined;
    const stored = JSON.parse(
      window.localStorage.getItem(FREE_DRAWING_PRESETS_STORAGE_KEY) ?? "{}",
    ) as {
      version?: unknown;
      presets?: Array<{ id?: unknown; stroke?: unknown }>;
    };
    expect(stored.version).toBe(2);
    expect(stored.presets?.map((preset) => preset.id)).toEqual([
      "blue",
      "red",
      "green",
      "orange",
      "yellow",
      "custom-1",
    ]);
    expect(stored.presets?.[1]).toMatchObject({
      id: "red",
      stroke: "#abcdef",
    });

    root = createRoot(container!);
    const secondFactory = new FakeRendererFactory();
    await act(async () => {
      root?.render(createElement(
        BoardSurface,
        surfaceProps(context, secondFactory),
      ));
    });
    await act(async () => {
      container?.querySelector<HTMLButtonElement>(
        '[aria-keyshortcuts="P 2"]',
      )?.click();
    });
    expect(secondFactory.instances[0].creationStyle).toMatchObject({
      stroke: "#2563eb",
      strokeWidth: 2.5,
      opacity: 1,
    });
    expect(container?.querySelector<HTMLButtonElement>(
      '[data-pen-preset-id="blue"] .board-stylebar__pen-preset',
    )?.getAttribute("aria-pressed")).toBe("true");
  });

  it("persists unrestricted ordinary styles and keeps shared palette edits outside CRDT", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const firstFactory = new FakeRendererFactory();
    const documentUpdates = vi.fn();
    context.document.on("update", documentUpdates);

    await act(async () => {
      root?.render(createElement(
        BoardSurface,
        surfaceProps(context, firstFactory),
      ));
    });
    await act(async () => container?.querySelector<HTMLButtonElement>(
      '[data-toolbar-tool="shape"]',
    )?.click());
    const renderer = firstFactory.instances[0];

    await act(async () => container?.querySelector<HTMLButtonElement>(
      '[aria-label^="Цвет заливки:"]',
    )?.click());
    await act(async () => {
      if (container) openColorFormats(container);
    });
    const hex = container?.querySelector<HTMLInputElement>(
      '[aria-label="Цвет в формате HEX"]',
    );
    await act(async () => {
      if (hex) setRangeValue(hex, "#12abef");
      hex?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }));
    });
    expect(renderer.creationStyle.fill).toBe("#12abef");

    await act(async () => container?.querySelector<HTMLButtonElement>(
      ".board-color-control__palette-toggle",
    )?.click());
    await act(async () => container?.querySelector<HTMLButtonElement>(
      '[data-color-slot-id="graphite"] .board-color-control__favorite',
    )?.click());
    await act(async () => {
      if (container) openColorFormats(container);
    });
    const slotPicker = container?.querySelector<HTMLInputElement>(
      '[aria-label="Цвет в формате HEX"]',
    );
    await act(async () => {
      if (slotPicker) {
        setRangeValue(slotPicker, "#abcdef");
        slotPicker.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        }));
      }
    });
    expect(renderer.creationStyle.fill).toBe("#12abef");
    expect(documentUpdates).not.toHaveBeenCalled();
    expect(context.undo.canUndo).toBe(false);

    await act(async () => container?.querySelector<HTMLButtonElement>(
      ".board-color-control__close",
    )?.click());
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    const exactWidth = container?.querySelector<HTMLInputElement>(
      '[aria-label="Точная толщина линии"]',
    );
    const exactOpacity = container?.querySelector<HTMLInputElement>(
      '[aria-label="Точная непрозрачность в процентах"]',
    );
    await act(async () => {
      if (exactWidth) setRangeValue(exactWidth, "12.5");
      if (exactOpacity) setRangeValue(exactOpacity, "73");
    });
    await act(async () => container?.querySelector<HTMLButtonElement>(
      '[aria-label="Свой рисунок штриха"]',
    )?.click());
    const dash = container?.querySelector<HTMLInputElement>(
      '[aria-label="Длины штрихов и промежутков"]',
    );
    await act(async () => {
      if (dash) setRangeValue(dash, "12, 4, 2, 4");
      dash?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }));
    });
    expect(renderer.creationStyle).toMatchObject({
      fill: "#12abef",
      strokeWidth: 12.5,
      opacity: 0.73,
      dash: [12, 4, 2, 4],
    });

    await act(async () => container?.querySelector<HTMLButtonElement>(
      '[aria-label="Текст"]',
    )?.click());
    const fontSize = container?.querySelector<HTMLInputElement>(
      '[aria-label="Размер текста"]',
    );
    const fontFamily = container?.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="Шрифт"]',
    );
    const textColor = container?.querySelector<HTMLButtonElement>(
      '[aria-label^="Цвет текста:"]',
    );
    expect(textColor?.querySelector(".lucide-paint-bucket")).toBeNull();
    expect(container?.querySelector(
      '[aria-label="Точная непрозрачность в процентах"]',
    )).toBeNull();
    await act(async () => {
      if (fontSize) setRangeValue(fontSize, "37.5");
      fontFamily?.click();
    });
    const georgiaOption = [...document.body.querySelectorAll<HTMLButtonElement>(
      '.board-font-family-menu button[role="option"]',
    )].find((option) => option.textContent?.trim() === "Georgia");
    await act(async () => {
      georgiaOption?.click();
    });
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -100,
    });
    await act(async () => fontSize?.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(true);
    expect(container?.querySelector('input[type="color"]')).toBeNull();
    expect(renderer.creationStyle).toMatchObject({
      fontSize: 38,
      fontFamily: "Georgia, Times New Roman, serif",
    });
    expect(documentUpdates).not.toHaveBeenCalled();
    expect(context.undo.canUndo).toBe(false);

    await act(async () => root?.unmount());
    root = undefined;
    const storedPalette = JSON.parse(
      window.localStorage.getItem(STYLE_COLOR_PALETTE_STORAGE_KEY) ?? "{}",
    ) as {
      version?: unknown;
      slots?: Array<{ id?: unknown; color?: unknown }>;
      recentColors?: unknown[];
    };
    expect(storedPalette.version).toBe(1);
    expect(storedPalette.slots?.find((slot) => slot.id === "graphite")?.color)
      .toBe("#abcdef");
    expect(storedPalette.recentColors?.[0]).toBe("#12abef");

    const storedTools = JSON.parse(
      window.localStorage.getItem(TOOL_STYLE_PRESETS_STORAGE_KEY) ?? "{}",
    ) as { version?: unknown; styles?: Record<string, Record<string, unknown>> };
    expect(storedTools.version).toBe(1);
    expect(storedTools.styles?.rectangle).toMatchObject({
      fill: "#12abef",
      strokeWidth: 12.5,
      opacity: 0.73,
      dash: [12, 4, 2, 4],
    });
    expect(storedTools.styles?.text).toMatchObject({
      fontSize: 38,
      fontFamily: "Georgia, Times New Roman, serif",
    });

    root = createRoot(container!);
    const secondFactory = new FakeRendererFactory();
    await act(async () => {
      root?.render(createElement(
        BoardSurface,
        surfaceProps(context, secondFactory),
      ));
    });
    await act(async () => container?.querySelector<HTMLButtonElement>(
      '[data-toolbar-tool="shape"]',
    )?.click());
    expect(secondFactory.instances[0].creationStyle).toMatchObject({
      fill: "#12abef",
      strokeWidth: 12.5,
      opacity: 0.73,
      dash: [12, 4, 2, 4],
    });
    await act(async () => container?.querySelector<HTMLButtonElement>(
      '[aria-label="Текст"]',
    )?.click());
    expect(secondFactory.instances[0].creationStyle).toMatchObject({
      fontSize: 38,
      fontFamily: "Georgia, Times New Roman, serif",
    });
  });

  it("flushes free-drawing presets on unmount and restores them on remount", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const firstFactory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(
        BoardSurface,
        surfaceProps(context, firstFactory),
      ));
    });
    await act(async () => {
      container?.querySelector<HTMLButtonElement>(
        '[aria-label="Рисование"]',
      )?.click();
    });
    const red = container?.querySelector<HTMLButtonElement>(
      '[aria-label^="Перо 2,"]',
    );
    await act(async () => red?.click());
    await act(async () => red?.click());
    await act(async () => {
      const popover = container?.querySelector<HTMLElement>(
        ".board-stylebar__pen-popover",
      );
      if (popover) openColorFormats(popover);
    });
    const color = container?.querySelector<HTMLInputElement>(
      '.board-stylebar__pen-popover [aria-label="Цвет в формате HEX"]',
    );
    const width = container?.querySelector<HTMLInputElement>(
      '[aria-label="Толщина линии рисования"]',
    );
    const opacity = container?.querySelector<HTMLInputElement>(
      '.board-stylebar__pen-popover [aria-label="Непрозрачность"]',
    );
    await act(async () => {
      if (color) {
        setRangeValue(color, "#654321ff");
        color.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        }));
      }
      if (width) setRangeValue(width, "7.5");
      if (opacity) setRangeValue(opacity, "0.55");
    });
    window.dispatchEvent(new Event("pagehide"));
    const pagehideStored = JSON.parse(
      window.localStorage.getItem(FREE_DRAWING_PRESETS_STORAGE_KEY) ?? "{}",
    ) as {
      version?: unknown;
      presets?: Array<Record<string, unknown>>;
    };
    expect(pagehideStored.version).toBe(2);
    expect(pagehideStored.presets?.[1]).toMatchObject({
      id: "red",
      stroke: "#654321",
      strokeWidth: 7.5,
      opacity: 0.55,
    });

    await act(async () => root?.unmount());
    root = undefined;
    const stored = JSON.parse(
      window.localStorage.getItem(FREE_DRAWING_PRESETS_STORAGE_KEY) ?? "{}",
    ) as {
      version?: unknown;
      presets?: Array<Record<string, unknown>>;
    };
    expect(stored.version).toBe(2);
    expect(stored.presets?.[1]).toMatchObject({
      id: "red",
      stroke: "#654321",
      strokeWidth: 7.5,
      opacity: 0.55,
    });

    root = createRoot(container!);
    const secondFactory = new FakeRendererFactory();
    await act(async () => {
      root?.render(createElement(
        BoardSurface,
        surfaceProps(context, secondFactory),
      ));
    });
    await act(async () => {
      container?.querySelector<HTMLButtonElement>(
        '[aria-label="Рисование"]',
      )?.click();
    });
    const restored = container?.querySelector<HTMLButtonElement>(
      '[aria-label^="Перо 2,"]',
    );
    expect(restored?.style.getPropertyValue("--board-swatch"))
      .toBe("#654321");
    expect(restored?.style.getPropertyValue("--board-pen-radius"))
      .toBe("7.5px");
    expect(restored?.style.getPropertyValue("--board-swatch-opacity"))
      .toBe("0.55");
  });

  it("creates solid free drawing without selecting it or exposing dash controls", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    await act(async () => {
      container?.querySelector<HTMLButtonElement>(
        '[aria-label="Рисование"]',
      )?.click();
    });
    const widePreset = container?.querySelector<HTMLButtonElement>(
      '[aria-label^="Перо 6,"]',
    );
    expect(widePreset?.style.getPropertyValue("--board-pen-radius")).toBe("16px");
    expect(widePreset?.style.getPropertyValue("--board-swatch-opacity"))
      .toBe("0.38");
    await act(async () => widePreset?.click());
    expect(renderer.creationStyle).toMatchObject({
      stroke: "#ffd43b",
      strokeWidth: 16,
      opacity: 0.38,
      dash: [],
      blendMode: "source-over",
    });

    await act(async () => {
      renderer.callbacks.onCreateObject({
        kind: BUILTIN_OBJECT_KINDS.stroke,
        transform: [10, 20, 30, 10, 0],
        style: renderer.creationStyle,
        props: {
          strokePoints: [
            { x: 0, y: 0, pressure: 0.5 },
            { x: 30, y: 10, pressure: 0.5 },
          ],
        },
      });
    });

    const [strokeId, strokeRecord] = [...getPageObjects(context.document).entries()][0];
    const stroke = readBoardObject(strokeRecord);
    expect(stroke.style.get("stroke")).toBe("#ffd43b");
    expect(stroke.style.get("strokeWidth")).toBe(16);
    expect(stroke.style.get("opacity")).toBe(0.38);
    expect(stroke.style.get("dash")).toEqual([]);
    expect(stroke.style.get("blendMode")).toBe("source-over");
    expect(renderer.selection).toEqual([]);
    expect(container?.querySelector(".board-stylebar__free-drawing")).not.toBeNull();

    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[aria-label="Выбор"]')
        ?.click();
      renderer.callbacks.onSelectionChange([strokeId]);
    });
    expect(container?.querySelector('[aria-label="Тип линии"]')).toBeNull();
    expect(container?.querySelector('[aria-label="Штриховая"]')).toBeNull();
    expect(container?.querySelector<HTMLInputElement>(
      '[aria-label="Толщина линии"]',
    )).not.toBeNull();
  });

  it("groups a continuous opacity gesture into exactly one undo item", async () => {
    vi.useFakeTimers();
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#ffffff");
    context.undo.clear();
    const factory = new FakeRendererFactory();
    const captureTimeout = context.undo.manager.captureTimeout;

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    await act(async () => {
      factory.instances[0].callbacks.onSelectionChange([RECTANGLE_ONE]);
    });
    const opacity = container?.querySelector<HTMLInputElement>(
      '.board-v2__stylebar input[aria-label="Прозрачность"]',
    );
    expect(opacity).not.toBeNull();

    await act(async () => {
      opacity?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      if (opacity) setRangeValue(opacity, "0.8");
    });
    expect(context.undo.manager.captureTimeout).toBe(Number.POSITIVE_INFINITY);
    expect(readBoardObject(
      getPageObjects(context.document).get(RECTANGLE_ONE)!,
    ).style.get("opacity")).toBe(0.8);

    await act(async () => {
      vi.advanceTimersByTime(captureTimeout + 100);
      if (opacity) setRangeValue(opacity, "0.4");
    });
    await act(async () => {
      opacity?.dispatchEvent(new Event("pointerup", { bubbles: true }));
    });

    expect(context.undo.manager.captureTimeout).toBe(captureTimeout);
    expect(readBoardObject(
      getPageObjects(context.document).get(RECTANGLE_ONE)!,
    ).style.get("opacity")).toBe(0.4);

    let undone = false;
    await act(async () => {
      undone = context.undo.undo();
    });
    expect(undone).toBe(true);
    expect(readBoardObject(
      getPageObjects(context.document).get(RECTANGLE_ONE)!,
    ).style.get("opacity")).toBe(1);

    await act(async () => {
      undone = context.undo.undo();
    });
    expect(undone).toBe(false);
  });

  it("separates style undo items on pointer-cancel, blur, and selection change", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#ffffff");
    addRectangle(context, RECTANGLE_TWO, "a1", "#fff3bf");
    context.undo.clear();
    const factory = new FakeRendererFactory();
    const captureTimeout = context.undo.manager.captureTimeout;

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    await act(async () => {
      renderer.callbacks.onSelectionChange([RECTANGLE_ONE]);
    });
    const opacity = container?.querySelector<HTMLInputElement>(
      '.board-v2__stylebar input[aria-label="Прозрачность"]',
    );
    const exactOpacity = container?.querySelector<HTMLInputElement>(
      '[aria-label="Точная непрозрачность в процентах"]',
    );
    expect(opacity).not.toBeNull();
    expect(exactOpacity).not.toBeNull();

    await act(async () => {
      opacity?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      if (opacity) setRangeValue(opacity, "0.8");
    });
    expect(context.undo.manager.captureTimeout).toBe(Number.POSITIVE_INFINITY);
    await act(async () => {
      opacity?.dispatchEvent(new Event("pointercancel", { bubbles: true }));
    });
    expect(context.undo.manager.captureTimeout).toBe(captureTimeout);

    await act(async () => exactOpacity?.focus());
    expect(context.undo.manager.captureTimeout).toBe(Number.POSITIVE_INFINITY);
    await act(async () => {
      if (exactOpacity) setRangeValue(exactOpacity, "70");
      exactOpacity?.blur();
    });
    expect(context.undo.manager.captureTimeout).toBe(captureTimeout);

    await act(async () => {
      opacity?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      if (opacity) setRangeValue(opacity, "0.6");
    });
    expect(context.undo.manager.captureTimeout).toBe(Number.POSITIVE_INFINITY);
    await act(async () => {
      renderer.callbacks.onSelectionChange([RECTANGLE_TWO]);
    });
    expect(context.undo.manager.captureTimeout).toBe(captureTimeout);

    const rectangleOne = () => readBoardObject(
      getPageObjects(context.document).get(RECTANGLE_ONE)!,
    );
    expect(rectangleOne().style.get("opacity")).toBe(0.6);
    await act(async () => expect(context.undo.undo()).toBe(true));
    expect(rectangleOne().style.get("opacity")).toBe(0.7);
    await act(async () => expect(context.undo.undo()).toBe(true));
    expect(rectangleOne().style.get("opacity")).toBe(0.8);
    await act(async () => expect(context.undo.undo()).toBe(true));
    expect(rectangleOne().style.get("opacity")).toBe(1);
    await act(async () => expect(context.undo.undo()).toBe(false));
  });

  it("ends transform undo capture when the renderer cancels the interaction", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();
    const beginGesture = vi.spyOn(context.undo, "beginGesture");
    const endGesture = vi.spyOn(context.undo, "endGesture");

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    await act(async () => {
      factory.instances[0].callbacks.onTransformStart();
    });
    expect(beginGesture).toHaveBeenCalledOnce();

    await act(async () => {
      factory.instances[0].callbacks.onTransformCancel();
    });
    expect(endGesture).toHaveBeenCalledOnce();
    expect(context.undo.canUndo).toBe(false);
  });

  it("closes an opacity gesture when read-only hides the style bar", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#ffffff");
    context.undo.clear();
    const factory = new FakeRendererFactory();
    const captureTimeout = context.undo.manager.captureTimeout;

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    await act(async () => {
      renderer.callbacks.onSelectionChange([RECTANGLE_ONE]);
    });
    const opacity = container?.querySelector<HTMLInputElement>(
      '.board-v2__stylebar input[aria-label="Прозрачность"]',
    );
    await act(async () => {
      opacity?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      if (opacity) setRangeValue(opacity, "0.6");
    });
    expect(context.undo.manager.captureTimeout).toBe(Number.POSITIVE_INFINITY);

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        readOnly: true,
      })));
    });
    expect(context.undo.manager.captureTimeout).toBe(captureTimeout);
    expect(container?.querySelector(".board-v2__stylebar")).toBeNull();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const movedTransform = [80, 90, 120, 80, 0] as const;
    await act(async () => {
      renderer.callbacks.onTransformStart();
      renderer.callbacks.onTransformObjects(new Map([
        [RECTANGLE_ONE, movedTransform],
      ]));
    });

    await act(async () => {
      context.undo.undo();
    });
    expect(readBoardObject(
      getPageObjects(context.document).get(RECTANGLE_ONE)!,
    ).transform).toEqual([10, 20, 120, 80, 0]);
    expect(readBoardObject(
      getPageObjects(context.document).get(RECTANGLE_ONE)!,
    ).style.get("opacity")).toBe(0.6);

    await act(async () => {
      context.undo.undo();
    });
    expect(readBoardObject(
      getPageObjects(context.document).get(RECTANGLE_ONE)!,
    ).style.get("opacity")).toBe(1);
  });

  it("patches a mixed multi-selection atomically and undoes it without reverting remote work", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#ffffff");
    addRectangle(context, RECTANGLE_TWO, "a1", "#fff3bf");
    context.undo.clear();
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    await act(async () => {
      renderer.callbacks.onSelectionChange([RECTANGLE_ONE, RECTANGLE_TWO]);
    });

    await act(async () => container?.querySelector<HTMLButtonElement>(
      '[aria-label^="Цвет заливки:"]',
    )?.click());
    const blueFill = styleSwatch("#dbeafe");
    expect(blueFill?.getAttribute("aria-pressed")).toBe("false");
    const updates: Uint8Array[] = [];
    context.document.on("update", (update: Uint8Array) => updates.push(update));
    await act(async () => blueFill?.click());

    expect(updates).toHaveLength(1);
    expect(factory.instances).toHaveLength(1);
    for (const id of [RECTANGLE_ONE, RECTANGLE_TWO]) {
      expect(readBoardObject(getPageObjects(context.document).get(id)!).style.get("fill"))
        .toBe("#dbeafe");
    }

    const remoteOrigin = createLocalCommandOrigin("remote-style-ui-test");
    const remoteTransform = [80, 90, 160, 100, 0.2] as const;
    await act(async () => {
      setObjectTransform(
        context.document,
        RECTANGLE_ONE,
        remoteTransform,
        remoteOrigin,
      );
    });
    const undoButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Отменить"]',
    );
    await act(async () => undoButton?.click());

    expect(readBoardObject(getPageObjects(context.document).get(RECTANGLE_ONE)!).style.get("fill"))
      .toBe("#ffffff");
    expect(readBoardObject(getPageObjects(context.document).get(RECTANGLE_TWO)!).style.get("fill"))
      .toBe("#fff3bf");
    expect(readBoardObject(getPageObjects(context.document).get(RECTANGLE_ONE)!).transform)
      .toEqual(remoteTransform);
  });

  it("does not offer a general style reset for creation tools or a selection", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#dbeafe");
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    const resetSelector = '[aria-label="Сбросить оформление"]';

    for (const tool of ["Текст", "Линия", "Прямоугольник"]) {
      await act(async () => container?.querySelector<HTMLButtonElement>(
        `[aria-label="${tool}"]`,
      )?.click());
      expect(container?.querySelector(resetSelector)).toBeNull();
    }

    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[aria-label="Выбор"]')
        ?.click();
      renderer.callbacks.onSelectionChange([RECTANGLE_ONE]);
    });
    expect(container?.querySelector(resetSelector)).toBeNull();
  });

  it("toggles mixed font-style tokens atomically without dropping the other token", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addText(context, TEXT_ONE, "a0", "normal");
    addText(context, TEXT_TWO, "a1", "italic");
    context.undo.clear();
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    await act(async () => {
      factory.instances[0].callbacks.onSelectionChange([TEXT_ONE, TEXT_TWO]);
    });

    const bold = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Полужирный"]',
    );
    const italic = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Курсив"]',
    );
    expect(bold?.getAttribute("aria-pressed")).toBe("false");
    expect(italic?.getAttribute("aria-pressed")).toBe("mixed");

    const updates: Uint8Array[] = [];
    context.document.on("update", (update: Uint8Array) => updates.push(update));
    await act(async () => bold?.click());

    expect(updates).toHaveLength(1);
    expect(readBoardObject(
      getPageObjects(context.document).get(TEXT_ONE)!,
    ).style.get("fontStyle")).toBe("bold");
    expect(readBoardObject(
      getPageObjects(context.document).get(TEXT_TWO)!,
    ).style.get("fontStyle")).toBe("bold italic");
    expect(bold?.getAttribute("aria-pressed")).toBe("true");
    expect(italic?.getAttribute("aria-pressed")).toBe("mixed");

    await act(async () => context.undo.undo());
    expect(readBoardObject(
      getPageObjects(context.document).get(TEXT_ONE)!,
    ).style.get("fontStyle")).toBe("normal");
    expect(readBoardObject(
      getPageObjects(context.document).get(TEXT_TWO)!,
    ).style.get("fontStyle")).toBe("italic");
    expect(context.undo.canUndo).toBe(false);
  });

  it("hides text-only opacity and bucket chrome without hiding mixed non-text opacity", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addText(context, TEXT_ONE, "a0", "normal");
    addRectangle(context, RECTANGLE_ONE, "a1", "#ffffff");
    context.undo.clear();
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    await act(async () => renderer.callbacks.onSelectionChange([TEXT_ONE]));

    expect(container?.querySelector(
      '[aria-label="Точная непрозрачность в процентах"]',
    )).toBeNull();
    expect(container?.querySelector(
      '[aria-label^="Цвет текста:"] .lucide-paint-bucket',
    )).toBeNull();

    await act(async () => renderer.callbacks.onSelectionChange([
      TEXT_ONE,
      RECTANGLE_ONE,
    ]));
    expect(container?.querySelector(
      '[aria-label="Точная непрозрачность в процентах"]',
    )).not.toBeNull();
    expect(container?.querySelector(
      '[aria-label^="Цвет текста / заливка:"] .lucide-paint-bucket',
    )).not.toBeNull();
    expect(context.undo.canUndo).toBe(false);
  });

  it("refreshes mixed selection styles after remote Yjs updates", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#ffffff");
    addRectangle(context, RECTANGLE_TWO, "a1", "#ffffff");
    context.undo.clear();
    const factory = new FakeRendererFactory();
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(context.document));
    const remoteOrigin = createLocalCommandOrigin("remote-mixed-style-test");

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    await act(async () => {
      renderer.callbacks.onSelectionChange([RECTANGLE_ONE, RECTANGLE_TWO]);
    });
    await act(async () => container?.querySelector<HTMLButtonElement>(
      '[aria-label^="Цвет заливки:"]',
    )?.click());
    expect(styleSwatch("#ffffff")?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      patchObjectStyles(
        remote,
        [RECTANGLE_ONE],
        { set: { fill: "#dbeafe" } },
        remoteOrigin,
      );
      Y.applyUpdate(
        context.document,
        Y.encodeStateAsUpdate(remote, Y.encodeStateVector(context.document)),
      );
    });
    expect(fillSwatches()).not.toHaveLength(0);
    expect(fillSwatches().every(
      (button) => button.getAttribute("aria-pressed") === "false",
    )).toBe(true);

    await act(async () => {
      patchObjectStyles(
        remote,
        [RECTANGLE_TWO],
        { set: { fill: "#dbeafe" } },
        remoteOrigin,
      );
      Y.applyUpdate(
        context.document,
        Y.encodeStateAsUpdate(remote, Y.encodeStateVector(context.document)),
      );
    });
    expect(styleSwatch("#dbeafe")?.getAttribute("aria-pressed")).toBe("true");
    expect(factory.instances).toHaveLength(1);
    expect(renderer.destroyCount).toBe(0);
    remote.destroy();
  });

  it("moves layers from the object menu and deterministic keyboard commands in one undo step", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#ffffff");
    addRectangle(context, RECTANGLE_TWO, "a1", "#ffffff");
    addRectangle(context, RECTANGLE_THREE, "a2", "#ffffff");
    context.undo.clear();
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    await act(async () => renderer.callbacks.onSelectionChange([RECTANGLE_ONE]));

    expect(container?.querySelector(
      '.board-v2__stylebar [aria-label="На передний план"]',
    )).toBeNull();
    await act(async () => renderer.callbacks.onContextMenu({
      screen: { x: 120, y: 90 },
      world: { x: 120, y: 90 },
      objectId: RECTANGLE_ONE,
    }));
    const layerGroup = [...(container?.querySelectorAll<HTMLButtonElement>(
      '.board-v2__context-menu:not(.board-v2__context-menu--submenu) [role="menuitem"]',
    ) ?? [])].find((button) => button.textContent?.includes("Порядок слоёв"));
    await act(async () => layerGroup?.click());
    const front = [...(container?.querySelectorAll<HTMLButtonElement>(
      '.board-v2__context-menu--submenu [role="menuitem"]',
    ) ?? [])].find((button) => button.textContent?.includes("На передний план"));
    await act(async () => front?.click());
    expect(orderedObjectIds(context)).toEqual([
      RECTANGLE_TWO,
      RECTANGLE_THREE,
      RECTANGLE_ONE,
    ]);

    await act(async () => context.undo.undo());
    expect(orderedObjectIds(context)).toEqual([
      RECTANGLE_ONE,
      RECTANGLE_TWO,
      RECTANGLE_THREE,
    ]);

    await act(async () => {
      container?.querySelector<HTMLElement>(".board-v2")?.focus();
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "BracketRight",
        key: "]",
        ctrlKey: true,
      }));
    });
    expect(orderedObjectIds(context)).toEqual([
      RECTANGLE_TWO,
      RECTANGLE_ONE,
      RECTANGLE_THREE,
    ]);
    expect(factory.instances).toHaveLength(1);
  });
});

describe("BoardSurface theme and standard controls", () => {
  it("suppresses standalone left and right Alt in focused board chrome", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    const updates = vi.fn();
    context.document.on("update", updates);
    context.undo.clear();
    const board = container?.querySelector<HTMLElement>(".board-v2");
    const toolbarButton = container?.querySelector<HTMLButtonElement>(
      ".board-v2__toolbar button",
    );
    expect(board).not.toBeNull();
    expect(toolbarButton).not.toBeNull();

    for (const [target, code] of [
      [board, "AltLeft"],
      [toolbarButton, "AltRight"],
    ] as const) {
      target?.focus();
      const down = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code,
        key: "Alt",
        altKey: true,
      });
      const repeatedDown = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code,
        key: "Alt",
        altKey: true,
        repeat: true,
      });
      const up = new KeyboardEvent("keyup", {
        bubbles: true,
        cancelable: true,
        code,
        key: "Alt",
      });

      let downAccepted = true;
      let repeatedDownAccepted = true;
      let upAccepted = true;
      await act(async () => {
        downAccepted = target?.dispatchEvent(down) ?? true;
        repeatedDownAccepted = target?.dispatchEvent(repeatedDown) ?? true;
        upAccepted = target?.dispatchEvent(up) ?? true;
      });

      expect(downAccepted, `${code} keydown`).toBe(false);
      expect(repeatedDownAccepted, `${code} repeated keydown`).toBe(false);
      expect(upAccepted, `${code} keyup`).toBe(false);
      expect(down.defaultPrevented).toBe(true);
      expect(repeatedDown.defaultPrevented).toBe(true);
      expect(up.defaultPrevented).toBe(true);
    }

    expect(renderer.tool).toBe("select");
    expect(renderer.selection).toEqual([]);
    expect(renderer.cancelInteractionCount).toBe(0);
    expect(getPageObjects(context.document).size).toBe(0);
    expect(updates).not.toHaveBeenCalled();
    expect(context.undo.canUndo).toBe(false);
  });

  it("keeps Alt scoped across focus changes and exempts native editing and AltGraph", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const board = container?.querySelector<HTMLElement>(".board-v2");
    const outside = document.createElement("button");
    document.body.append(outside);

    outside.focus();
    const outsideDown = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "AltLeft",
      key: "Alt",
      altKey: true,
    });
    expect(outside.dispatchEvent(outsideDown)).toBe(true);
    board?.focus();
    const untrackedUp = new KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      code: "AltLeft",
      key: "Alt",
    });
    expect(board?.dispatchEvent(untrackedUp)).toBe(true);

    const boardDown = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "AltRight",
      key: "Alt",
      altKey: true,
    });
    expect(board?.dispatchEvent(boardDown)).toBe(false);
    outside.focus();
    const trackedOutsideUp = new KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      code: "AltRight",
      key: "Alt",
    });
    expect(outside.dispatchEvent(trackedOutsideUp)).toBe(false);

    board?.focus();
    const altGraph = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "AltRight",
      key: "AltGraph",
      altKey: true,
      ctrlKey: true,
    });
    expect(board?.dispatchEvent(altGraph)).toBe(true);
    expect(altGraph.defaultPrevented).toBe(false);

    await act(async () => {
      factory.instances[0].callbacks.onCreateObject(emptyTextDraft());
    });
    const editor = container?.querySelector<HTMLTextAreaElement>("textarea");
    expect(editor).not.toBeNull();
    editor?.focus();
    for (const type of ["keydown", "keyup"] as const) {
      const editorAlt = new KeyboardEvent(type, {
        bubbles: true,
        cancelable: true,
        code: "AltLeft",
        key: "Alt",
        altKey: type === "keydown",
      });
      expect(editor?.dispatchEvent(editorAlt), type).toBe(true);
      expect(editorAlt.defaultPrevented, type).toBe(false);
    }

    expect(factory.instances[0].tool).toBe("select");
    expect(context.undo.canUndo).toBe(false);
    outside.remove();
  });

  it("uses an unselected toolbar as hand mode and toggles it with Select or V", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();
    const onAwarenessChange = vi.fn();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        onAwarenessChange,
      })));
    });
    const renderer = factory.instances[0];
    const board = container?.querySelector<HTMLElement>(".board-v2");
    const toolbar = container?.querySelector<HTMLElement>(".board-v2__toolbar");
    const select = toolbar?.querySelector<HTMLButtonElement>(
      '[aria-label="Выбор"]',
    );

    expect(toolbar?.querySelector('[aria-label="Перемещение"]')).toBeNull();
    expect(select?.getAttribute("aria-pressed")).toBe("true");
    expect(renderer.tool).toBe("select");

    await act(async () => select?.click());
    expect(renderer.tool).toBe("hand");
    expect(select?.getAttribute("aria-pressed")).toBe("false");
    expect(toolbar?.querySelector('[aria-pressed="true"]')).toBeNull();
    expect(onAwarenessChange).toHaveBeenLastCalledWith({ activeTool: "hand" });

    await act(async () => select?.click());
    expect(renderer.tool).toBe("select");
    expect(select?.getAttribute("aria-pressed")).toBe("true");

    board?.focus();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyV",
        key: "v",
      }));
    });
    expect(renderer.tool).toBe("hand");
    expect(select?.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyV",
        key: "v",
      }));
    });
    expect(renderer.tool).toBe("select");
    expect(select?.getAttribute("aria-pressed")).toBe("true");
    expect(onAwarenessChange).toHaveBeenLastCalledWith({ activeTool: "select" });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Digit1",
        key: "1",
      }));
    });
    expect(renderer.tool).toBe("hand");
    expect(select?.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Digit1",
        key: "1",
      }));
    });
    expect(renderer.tool).toBe("select");
    expect(select?.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows numeric shortcut indicators on the matching toolbar tools", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });

    const toolbar = container?.querySelector<HTMLElement>(".board-v2__toolbar");
    const indicators = [
      ...(toolbar?.querySelectorAll<HTMLElement>(".board-tool__shortcut") ?? []),
    ];
    expect(indicators.map((indicator) => indicator.textContent)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
    ]);
    for (const indicator of indicators) {
      const button = indicator.closest("button");
      expect(indicator.getAttribute("aria-hidden")).toBe("true");
      expect(button?.classList.contains("board-tool--numbered")).toBe(true);
      expect(button?.getAttribute("aria-keyshortcuts")?.split(" "))
        .toContain(indicator.textContent);
      expect(button?.getAttribute("aria-label")).toBeTruthy();
    }
    const shapeButton = toolbar?.querySelector<HTMLButtonElement>(
      '[data-toolbar-item="shapes"]',
    );
    expect(shapeButton?.dataset.toolbarTool).toBe("shape");
    expect(shapeButton?.getAttribute("aria-keyshortcuts")?.split(" "))
      .toEqual(["R", "7"]);
    expect(container?.querySelector('[aria-label="Выбрать фигуру"]')).toBeNull();
    expect(container?.querySelector('[data-toolbar-menu="shapes"]')).toBeNull();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        readOnly: true,
      })));
    });
    const readOnlyIndicators = [
      ...(container?.querySelectorAll<HTMLElement>(".board-tool__shortcut") ?? []),
    ];
    expect(readOnlyIndicators.map((indicator) => indicator.textContent))
      .toEqual(indicators.map((indicator) => indicator.textContent));
    expect(readOnlyIndicators[0]?.closest("button")?.hasAttribute("disabled"))
      .toBe(false);
    expect(readOnlyIndicators[1]?.closest("button")?.hasAttribute("disabled"))
      .toBe(false);
    for (const indicator of readOnlyIndicators.slice(2)) {
      expect(indicator.closest("button")?.hasAttribute("disabled")).toBe(true);
    }
  });

  it("presents Drawing as the temporary laser without changing its tool identity", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    const toolbar = container?.querySelector<HTMLElement>(".board-v2__toolbar");
    const drawingButton = () => toolbar?.querySelector<HTMLButtonElement>(
      '[data-toolbar-tool="pen"]',
    );

    await act(async () => drawingButton()?.click());
    expect(renderer.tool).toBe("pen");
    expect(drawingButton()?.getAttribute("aria-label")).toBe("Рисование");
    expect(drawingButton()?.querySelector(".lucide-pencil")).not.toBeNull();

    await act(async () => {
      renderer.callbacks.onPenLaserModeChange?.(true);
    });
    const laserButton = drawingButton();
    expect(laserButton?.getAttribute("aria-label")).toBe("Лазерная указка");
    expect(laserButton?.getAttribute("data-toolbar-tool")).toBe("pen");
    expect(laserButton?.getAttribute("aria-pressed")).toBe("true");
    expect(laserButton?.getAttribute("aria-keyshortcuts")?.split(" "))
      .toEqual(expect.arrayContaining(["P", "2"]));
    expect(laserButton?.querySelector(".lucide-mouse-pointer-click")).not.toBeNull();
    expect(laserButton?.querySelector(".board-tool__shortcut")?.textContent).toBe("2");

    await act(async () => {
      renderer.callbacks.onPenLaserModeChange?.(false);
    });
    const restoredDrawingButton = drawingButton();
    expect(restoredDrawingButton?.getAttribute("aria-label")).toBe("Рисование");
    expect(restoredDrawingButton?.getAttribute("data-toolbar-tool")).toBe("pen");
    expect(restoredDrawingButton?.getAttribute("aria-pressed")).toBe("true");
    expect(restoredDrawingButton?.getAttribute("aria-keyshortcuts")?.split(" "))
      .toEqual(expect.arrayContaining(["P", "2"]));
    expect(restoredDrawingButton?.querySelector(".lucide-pencil")).not.toBeNull();
    expect(restoredDrawingButton?.querySelector(".board-tool__shortcut")?.textContent)
      .toBe("2");

    await act(async () => toolbar?.querySelector<HTMLButtonElement>(
      '[data-toolbar-tool="eraser"]',
    )?.click());
    await act(async () => {
      renderer.callbacks.onPenLaserModeChange?.(true);
    });
    expect(renderer.tool).toBe("eraser");
    expect(toolbar?.querySelector('[data-toolbar-tool="eraser"]')
      ?.getAttribute("aria-pressed")).toBe("true");
    expect(drawingButton()?.getAttribute("aria-label")).toBe("Рисование");
    expect(drawingButton()?.getAttribute("aria-pressed")).toBe("false");
    expect(drawingButton()?.querySelector(".lucide-pencil")).not.toBeNull();
  });

  it("publishes segmented Drawing laser previews and their release through awareness", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();
    const onAwarenessChange = vi.fn();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        onAwarenessChange,
      })));
    });
    const renderer = factory.instances[0];
    const preview = {
      strokes: [
        {
          points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
          style: { stroke: "#2563eb", strokeWidth: 4.5, opacity: 0.72 },
        },
        {
          points: [{ x: 80, y: 90 }, { x: 110, y: 105 }],
          style: { stroke: "#dc2626", strokeWidth: 7, opacity: 0.9 },
        },
      ],
    } as const;

    onAwarenessChange.mockClear();
    await act(async () => {
      renderer.callbacks.onLaserChange(preview);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(onAwarenessChange).toHaveBeenLastCalledWith({
      laser: preview,
      laserClearMode: null,
    });

    await act(async () => {
      renderer.callbacks.onLaserChange(null, "immediate");
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(onAwarenessChange).toHaveBeenLastCalledWith({
      laser: null,
      laserClearMode: "immediate",
    });

    await act(async () => {
      renderer.callbacks.onLaserChange(preview);
      renderer.callbacks.onLaserChange(null, "fade");
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(onAwarenessChange).toHaveBeenLastCalledWith({
      laser: null,
      laserClearMode: "fade",
    });
  });

  it("keeps Drawing available read-only while blocking every creation alias", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        readOnly: true,
        insertImage: vi.fn(),
      })));
    });
    const renderer = factory.instances[0];
    const toolbar = container?.querySelector<HTMLElement>(".board-v2__toolbar");
    const visibleTool = (tool: string) => toolbar?.querySelector<HTMLButtonElement>(
      `[data-toolbar-tool="${tool}"]`,
    );

    expect(visibleTool("select")?.disabled).toBe(false);
    expect(visibleTool("pen")?.disabled).toBe(false);
    for (const tool of [
      "eraser",
      "text",
      "line",
      "arrow",
      "shape",
    ]) {
      expect(visibleTool(tool)?.disabled, tool).toBe(true);
    }

    await act(async () => toolbar?.querySelector<HTMLButtonElement>(
      '[aria-label="Ещё инструменты"]',
    )?.click());
    for (const tool of ["code", "latex", "image"]) {
      expect(container?.querySelector<HTMLButtonElement>(
        `[data-toolbar-menu="overflow"] [data-toolbar-tool="${tool}"]`,
      )?.disabled, tool).toBe(true);
    }

    await act(async () => visibleTool("pen")?.click());
    expect(renderer.tool).toBe("pen");
    expect(visibleTool("pen")?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      renderer.callbacks.onPenLaserModeChange?.(true);
    });
    expect(visibleTool("pen")?.disabled).toBe(false);
    expect(visibleTool("pen")?.getAttribute("aria-label")).toBe("Лазерная указка");
    expect(visibleTool("pen")?.querySelector(".lucide-mouse-pointer-click"))
      .not.toBeNull();

    focusBoard();
    const blockedShortcuts: readonly KeyboardEventInit[] = [
      { code: "KeyE", key: "e" },
      { code: "Digit3", key: "3" },
      { code: "KeyT", key: "t" },
      { code: "Digit4", key: "4" },
      { code: "KeyL", key: "l" },
      { code: "Digit5", key: "5" },
      { code: "KeyA", key: "a" },
      { code: "Digit6", key: "6" },
      { code: "KeyR", key: "r" },
      { code: "Digit7", key: "7" },
      { code: "KeyO", key: "o" },
      { code: "Digit8", key: "8" },
      { code: "KeyD", key: "d" },
      { code: "Digit9", key: "9" },
      { code: "KeyF", key: "f" },
      { code: "Digit0", key: "0" },
    ];
    for (const init of blockedShortcuts) {
      let accepted = false;
      await act(async () => {
        accepted = window.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ...init,
        }));
      });
      expect(accepted, init.code).toBe(true);
      expect(renderer.tool, init.code).toBe("pen");
    }
  });

  it("selects the seven toolbar tools with number-row and NumPad digits", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    const updates = vi.fn();
    context.document.on("update", updates);
    context.undo.clear();
    focusBoard();

    const shortcuts: ReadonlyArray<readonly [string, BoardTool]> = [
      ["1", "select"],
      ["2", "pen"],
      ["3", "eraser"],
      ["4", "text"],
      ["5", "line"],
      ["6", "arrow"],
      ["7", "shape"],
    ];

    for (const prefix of ["Digit", "Numpad"] as const) {
      for (const [digit, expectedTool] of shortcuts) {
        let accepted = true;
        await act(async () => {
          window.dispatchEvent(new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            code: "KeyH",
            key: "h",
          }));
          accepted = window.dispatchEvent(new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            code: `${prefix}${digit}`,
            key: digit,
          }));
        });
        expect(accepted, `${prefix}${digit}`).toBe(false);
        expect(renderer.tool, `${prefix}${digit}`).toBe(expectedTool);
      }
    }

    expect(updates).not.toHaveBeenCalled();
    expect(context.undo.canUndo).toBe(false);

    const styleInput = container?.querySelector<HTMLInputElement>(
      ".board-v2__stylebar input",
    );
    expect(styleInput).not.toBeNull();
    styleInput?.focus();
    let inputAccepted = false;
    await act(async () => {
      inputAccepted = styleInput?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Digit3",
        key: "3",
      })) ?? false;
    });
    expect(inputAccepted).toBe(true);
    expect(renderer.tool).toBe("shape");
  });

  it("configures concrete shapes inside the stable Shapes tool", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();
    const onAwarenessChange = vi.fn();
    const updates = vi.fn();
    context.document.on("update", updates);

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        onAwarenessChange,
      })));
    });
    const renderer = factory.instances[0];
    focusBoard();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Digit7",
        key: "7",
      }));
    });

    expect(renderer.tool).toBe("shape");
    expect(renderer.shapeKind).toBe("rectangle");
    expect(container?.querySelector('[data-toolbar-item="shapes"]')
      ?.getAttribute("aria-pressed")).toBe("true");
    expect(onAwarenessChange).toHaveBeenLastCalledWith({ activeTool: "shape" });

    const shapeGroup = container?.querySelector<HTMLElement>(
      '[role="group"][aria-label="Форма"]',
    );
    expect(shapeGroup).not.toBeNull();
    expect(shapeGroup?.querySelectorAll("button")).toHaveLength(4);
    expect(shapeGroup?.querySelector('[aria-label="Прямоугольник"]')
      ?.getAttribute("aria-pressed")).toBe("true");

    const strokeWidth = container?.querySelector<HTMLInputElement>(
      '[aria-label="Толщина линии"]',
    );
    expect(strokeWidth).not.toBeNull();
    await act(async () => setRangeValue(strokeWidth!, "5"));
    expect(renderer.creationStyle.strokeWidth).toBe(5);

    onAwarenessChange.mockClear();
    await act(async () => shapeGroup?.querySelector<HTMLButtonElement>(
      '[aria-label="Эллипс"]',
    )?.click());
    expect(renderer.tool).toBe("shape");
    expect(renderer.shapeKind).toBe("ellipse");
    expect(renderer.creationStyle.strokeWidth).toBe(2);
    expect(onAwarenessChange).not.toHaveBeenCalled();

    await act(async () => shapeGroup?.querySelector<HTMLButtonElement>(
      '[aria-label="Прямоугольник"]',
    )?.click());
    expect(renderer.shapeKind).toBe("rectangle");
    expect(renderer.creationStyle.strokeWidth).toBe(5);
    expect(updates).not.toHaveBeenCalled();
    expect(context.undo.canUndo).toBe(false);
  });

  it("does not intercept former shape aliases", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    focusBoard();

    for (const init of [
      { code: "Digit8", key: "8" },
      { code: "Digit9", key: "9" },
      { code: "Digit0", key: "0" },
      { code: "Numpad8", key: "8" },
      { code: "Numpad9", key: "9" },
      { code: "Numpad0", key: "0" },
      { code: "KeyO", key: "o" },
      { code: "KeyD", key: "d" },
      { code: "KeyF", key: "f" },
    ] as const) {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: "KeyH",
          key: "h",
        }));
      });
      expect(renderer.tool, `before ${init.code}`).toBe("hand");
      let accepted = false;
      await act(async () => {
        accepted = window.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ...init,
        }));
      });
      expect(accepted, init.code).toBe(true);
      expect(renderer.tool, init.code).toBe("hand");
    }
  });

  it("does not consume modified, repeated, or NumLock-off digit keys", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    focusBoard();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyH",
        key: "h",
      }));
    });
    expect(renderer.tool).toBe("hand");

    const ignoredKeys: readonly KeyboardEventInit[] = [
      { code: "Digit2", key: "2", ctrlKey: true },
      { code: "Digit2", key: "2", metaKey: true },
      { code: "Digit2", key: "2", altKey: true },
      { code: "Digit2", key: "@", shiftKey: true },
      { code: "Digit2", key: "2", repeat: true },
      { code: "Numpad2", key: "ArrowDown" },
    ];
    for (const init of ignoredKeys) {
      let accepted = false;
      await act(async () => {
        accepted = window.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ...init,
        }));
      });
      expect(accepted, init.code).toBe(true);
      expect(renderer.tool, init.code).toBe("hand");
    }
  });

  it("leaves digit entry inside native exact style inputs", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addText(context, TEXT_ONE, "a0", "normal");
    context.undo.clear();
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    await act(async () => {
      renderer.callbacks.onSelectionChange([TEXT_ONE]);
    });

    const fontSize = container?.querySelector<HTMLInputElement>(
      '[aria-label="Размер текста"]',
    );
    expect(fontSize).not.toBeNull();
    fontSize?.focus();
    let accepted = false;
    await act(async () => {
      accepted = fontSize?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Digit2",
        key: "2",
      })) ?? false;
    });

    expect(accepted).toBe(true);
    expect(renderer.tool).toBe("select");
    expect(renderer.selection).toEqual([TEXT_ONE]);
    expect(container?.querySelector(".board-v2__stylebar")).not.toBeNull();
  });

  it("persists a dark board theme without recreating the renderer", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });

    const renderer = factory.instances[0];
    expect(container?.querySelector(".board-v2--light")).not.toBeNull();
    expect(renderer.theme).toBe("light");

    const themeButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Включить тёмную тему"]',
    );
    await act(async () => themeButton?.click());

    expect(container?.querySelector(".board-v2--dark")).not.toBeNull();
    expect(renderer.theme).toBe("dark");
    expect(window.localStorage.getItem("eduri-board-theme")).toBe("dark");
    expect(factory.instances).toHaveLength(1);
    expect(renderer.destroyCount).toBe(0);
  });

  it("follows the global site theme without recreating the renderer", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

    await act(async () => {
      root?.render(createElement(
        ThemeProvider,
        null,
        createElement(BoardSurface, surfaceProps(context, factory)),
      ));
    });

    const renderer = factory.instances[0];
    expect(container?.querySelector(".board-v2--dark")).not.toBeNull();
    expect(renderer.theme).toBe("dark");
    const themeButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Включить светлую тему"]',
    );

    await act(async () => themeButton?.click());

    expect(container?.querySelector(".board-v2--light")).not.toBeNull();
    expect(renderer.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(window.localStorage.getItem("eduri-board-theme")).toBeNull();
    expect(factory.instances).toHaveLength(1);
    expect(renderer.destroyCount).toBe(0);
  });

  it("resets the zoom indicator to 100% and uses smaller symmetric toolbar steps", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    setBoardViewport(800, 600);
    renderer.setCamera({ x: 100, y: 50, zoom: 0.76 });
    await act(async () => {
      renderer.callbacks.onCameraChange(renderer.camera);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    const center = { x: 400, y: 300 };
    const worldBefore = {
      x: (center.x - renderer.camera.x) / renderer.camera.zoom,
      y: (center.y - renderer.camera.y) / renderer.camera.zoom,
    };
    const reset = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Вернуть масштаб 100%"]',
    );
    expect(reset?.textContent).toBe("76%");
    await act(async () => reset?.click());

    expect(renderer.camera.zoom).toBe(1);
    expect((center.x - renderer.camera.x) / renderer.camera.zoom)
      .toBeCloseTo(worldBefore.x);
    expect((center.y - renderer.camera.y) / renderer.camera.zoom)
      .toBeCloseTo(worldBefore.y);
    expect(renderer.fitCount).toBe(0);

    const zoomIn = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Увеличить масштаб"]',
    );
    const zoomOut = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Уменьшить масштаб"]',
    );
    await act(async () => zoomIn?.click());
    expect(renderer.camera.zoom).toBeCloseTo(1.1);
    await act(async () => zoomOut?.click());
    expect(renderer.camera.zoom).toBeCloseTo(1);
  });

  it("clamps toolbar zoom to 2%-2000% without moving the viewport-center anchor", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    setBoardViewport(800, 600);
    const center = { x: 400, y: 300 };
    const zoomSteps = container?.querySelectorAll<HTMLButtonElement>(
      ".board-v2__zoom-step",
    );
    const stableZoomOut = zoomSteps?.item(0);
    const stableZoomIn = zoomSteps?.item(1);
    const stableIndicator = container?.querySelector<HTMLButtonElement>(
      ".board-v2__zoom-value",
    );

    renderer.setCamera({ x: 73, y: 41, zoom: 19.9 });
    const highAnchor = {
      x: (center.x - renderer.camera.x) / renderer.camera.zoom,
      y: (center.y - renderer.camera.y) / renderer.camera.zoom,
    };
    await act(async () => stableZoomIn?.click());
    expect(renderer.camera.zoom).toBe(20);
    expect((center.x - renderer.camera.x) / renderer.camera.zoom)
      .toBeCloseTo(highAnchor.x);
    expect((center.y - renderer.camera.y) / renderer.camera.zoom)
      .toBeCloseTo(highAnchor.y);
    await act(async () => {
      stableZoomIn?.click();
      renderer.callbacks.onCameraChange(renderer.camera);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(renderer.camera.zoom).toBe(20);
    expect(stableIndicator?.textContent).toBe("2000%");

    renderer.setCamera({ x: 91, y: 67, zoom: 0.0201 });
    const lowAnchor = {
      x: (center.x - renderer.camera.x) / renderer.camera.zoom,
      y: (center.y - renderer.camera.y) / renderer.camera.zoom,
    };
    await act(async () => stableZoomOut?.click());
    expect(renderer.camera.zoom).toBe(0.02);
    expect((center.x - renderer.camera.x) / renderer.camera.zoom)
      .toBeCloseTo(lowAnchor.x);
    expect((center.y - renderer.camera.y) / renderer.camera.zoom)
      .toBeCloseTo(lowAnchor.y);
    await act(async () => {
      stableZoomOut?.click();
      renderer.callbacks.onCameraChange(renderer.camera);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(renderer.camera.zoom).toBe(0.02);
    expect(stableIndicator?.textContent).toBe("2%");
  });

  it("centers the plane before resetting Home to 100% zoom", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    setBoardViewport(801, 601);
    renderer.setCamera({ x: 120, y: 80, zoom: 0.76 });
    const zoomToolbar = container?.querySelector<HTMLElement>(".board-v2__zoom");
    const home = zoomToolbar?.querySelector<HTMLButtonElement>(
      '[aria-label="В центр доски, затем масштаб 100%"]',
    );
    expect(home).not.toBeNull();

    await act(async () => home?.click());
    expect(renderer.camera).toEqual({
      x: 400.5,
      y: 300.5,
      zoom: 0.76,
    });

    await act(async () => home?.click());
    expect(renderer.camera).toEqual({
      x: 400.5,
      y: 300.5,
      zoom: 1,
    });

    setBoardViewport(1001, 701);
    renderer.setCamera({ x: 470, y: 260, zoom: 0.65 });
    await act(async () => home?.click());
    expect(renderer.camera).toEqual({
      x: 500.5,
      y: 350.5,
      zoom: 0.65,
    });

    await act(async () => home?.click());
    expect(renderer.camera).toEqual({
      x: 500.5,
      y: 350.5,
      zoom: 1,
    });
    expect(renderer.cancelInteractionCount).toBe(4);
    expect(renderer.fitCount).toBe(0);
  });

  it("selects all, caps awareness, switches tools, and zooms from the keyboard", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#ffffff");
    addRectangle(context, RECTANGLE_TWO, "a1", "#ffffff");
    addRectangle(context, RECTANGLE_THREE, "a2", "#ffffff");
    const factory = new FakeRendererFactory();
    const onAwarenessChange = vi.fn();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        onAwarenessChange,
      })));
    });
    const renderer = factory.instances[0];
    setBoardViewport(800, 600);
    container?.querySelector<HTMLElement>(".board-v2")?.focus();

    let accepted = true;
    await act(async () => {
      accepted = window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        code: "KeyA",
        key: "a",
      }));
    });
    expect(accepted).toBe(false);
    expect(renderer.selection).toEqual([
      RECTANGLE_ONE,
      RECTANGLE_TWO,
      RECTANGLE_THREE,
    ]);

    const oversizedSelection = Array.from(
      { length: 300 },
      (_, index) => `object-${index}`,
    );
    await act(async () => renderer.callbacks.onSelectionChange(oversizedSelection));
    expect(renderer.selection).toHaveLength(300);
    expect(onAwarenessChange).toHaveBeenLastCalledWith({
      selectionIds: oversizedSelection.slice(0, 256),
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Escape",
        key: "Escape",
      }));
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyP",
        key: "p",
      }));
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        code: "Equal",
        key: "+",
      }));
    });
    expect(renderer.selection).toEqual([]);
    expect(renderer.tool).toBe("pen");
    expect(renderer.camera.zoom).toBeCloseTo(1.1);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        code: "Digit1",
        key: "1",
      }));
    });
    expect(renderer.camera.zoom).toBe(1);
    expect(renderer.tool).toBe("pen");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        code: "Digit0",
        key: "0",
      }));
    });
    expect(renderer.fitCount).toBe(1);
    expect(renderer.tool).toBe("pen");
  });

  it("groups arrow-key nudges and duplicates the selection in one undo step", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#ffffff");
    context.undo.clear();
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    await act(async () => {
      factory.instances[0].callbacks.onSelectionChange([RECTANGLE_ONE]);
    });
    focusBoard();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "ArrowRight",
        key: "ArrowRight",
      }));
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "ArrowRight",
        key: "ArrowRight",
        repeat: true,
        shiftKey: true,
      }));
      window.dispatchEvent(new KeyboardEvent("keyup", {
        bubbles: true,
        code: "ArrowRight",
        key: "ArrowRight",
      }));
    });
    expect(readBoardObject(
      getPageObjects(context.document).get(RECTANGLE_ONE)!,
    ).transform[0]).toBe(21);

    await act(async () => context.undo.undo());
    expect(readBoardObject(
      getPageObjects(context.document).get(RECTANGLE_ONE)!,
    ).transform[0]).toBe(10);
    expect(context.undo.canUndo).toBe(false);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyD",
        ctrlKey: true,
        key: "d",
      }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(getPageObjects(context.document).size).toBe(2);

    await act(async () => context.undo.undo());
    expect(getPageObjects(context.document).size).toBe(1);
    expect(getPageObjects(context.document).has(RECTANGLE_ONE)).toBe(true);
  });
});

describe("BoardSurface asset refresh", () => {
  it("does not create an image object before durable asset insertion resolves", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();
    let resolveInsertion!: (
      value: Awaited<ReturnType<NonNullable<BoardSurfaceProps["insertImage"]>>>,
    ) => void;
    const insertion = new Promise<
      Awaited<ReturnType<NonNullable<BoardSurfaceProps["insertImage"]>>>
    >((resolve) => {
      resolveInsertion = resolve;
    });
    const insertImage = vi.fn(() => insertion);

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        insertImage,
      })));
    });
    const input = container?.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    vi.spyOn(input!, "click").mockImplementation(() => {});
    await act(async () => {
      factory.instances[0].callbacks.onPlaceTool("image", { x: 400, y: 300 });
    });
    const file = new File([Uint8Array.of(1, 2, 3)], "plot.png", {
      type: "image/png",
    });
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    await act(async () => {
      input?.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(insertImage).toHaveBeenCalledWith(file);
    expect(getPageObjects(context.document).size).toBe(0);
    expect(factory.instances[0].tool).toBe("select");
    expect(factory.instances[0].selection).toEqual([]);

    await act(async () => {
      resolveInsertion({
        assetId: "asset-1",
        contentHash: "a".repeat(64),
        mimeType: "image/png",
        width: 4,
        height: 3,
        originalBytes: 3,
      });
      await insertion;
      await Promise.resolve();
    });
    const entries = [...getPageObjects(context.document).entries()];
    const objects = entries.map(([, record]) => readBoardObject(record));
    expect(objects).toHaveLength(1);
    expect(objects[0].kind).toBe(BUILTIN_OBJECT_KINDS.image);
    expect(objects[0].props.get("assetId")).toBe("asset-1");
    expect(objects[0].props.get("contentHash")).toBe("a".repeat(64));
    expect(factory.instances[0].tool).toBe("select");
    expect(factory.instances[0].selection).toEqual([entries[0][0]]);
  });

  it("refreshes image nodes in place when an asset becomes available", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addBoardObject(context.document, {
      id: IMAGE_OBJECT,
      kind: BUILTIN_OBJECT_KINDS.image,
      version: 1,
      transform: [10, 20, 320, 180, 0],
      zRank: "a",
      props: {
        assetId: "asset-1",
        contentHash: "a".repeat(64),
        mimeType: "image/png",
        pixelWidth: 4,
        pixelHeight: 3,
        originalBytes: 100,
      },
    }, context.origin);
    addBoardObject(context.document, {
      id: OTHER_IMAGE_OBJECT,
      kind: BUILTIN_OBJECT_KINDS.image,
      version: 1,
      transform: [360, 20, 320, 180, 0],
      zRank: "b",
      props: {
        assetId: "asset-2",
        contentHash: "b".repeat(64),
        mimeType: "image/png",
        pixelWidth: 4,
        pixelHeight: 3,
        originalBytes: 100,
      },
    }, context.origin);
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        assetRefresh: null,
      })));
    });
    const renderer = factory.instances[0];
    const refresh = vi.spyOn(renderer, "setObject");
    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        assetRefresh: { assetId: "asset-1", revision: 1 },
      })));
    });

    expect(factory.instances).toHaveLength(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][0]).toMatchObject({
      id: IMAGE_OBJECT,
      kind: BUILTIN_OBJECT_KINDS.image,
    });
  });

  it("keeps permanent asset risk visible and offers a local recovery export", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    const factory = new FakeRendererFactory();
    const onExportRecovery = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        assetHealth: {
          pendingLocalCount: 0,
          pendingRemoteCount: 0,
          readyCount: 0,
          blocked: [{
            assetId: "asset-1",
            source: "local",
            errorCode: "QUOTA_EXCEEDED",
            hasLocalRecoveryCopy: true,
          }],
        },
        onExportRecovery,
      })));
    });

    expect(container?.textContent).toContain("Исходник сохранён локально");
    const exportButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Скачать локальную копию доски"]',
    );
    expect(exportButton).not.toBeNull();
    await act(async () => {
      exportButton?.click();
      await Promise.resolve();
    });
    expect(onExportRecovery).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain("Исходник сохранён локально");
  });
});

describe("BoardSurface mutation guards", () => {
  it("binds code input and editor undo directly to the object's collaborative text", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addBoardObject(context.document, {
      id: CODE_OBJECT,
      kind: BUILTIN_OBJECT_KINDS.code,
      version: 1,
      transform: [10, 20, 320, 180, 0],
      zRank: "a",
      props: createCodeProps("print(1)", "python", "browser"),
    }, context.origin);
    context.undo.clear();
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    await act(async () => factory.instances[0].callbacks.onEditObject(CODE_OBJECT));
    const textarea = container?.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea?.value).toBe("print(1)");

    await act(async () => {
      if (!textarea) return;
      textarea.value = "print(2)";
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: "2",
        inputType: "insertText",
      }));
    });
    const record = getPageObjects(context.document).get(CODE_OBJECT)!;
    expect(getCollaborativeText(record, "source")?.toString())
      .toBe("print(2)");

    await act(async () => {
      textarea?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        code: "KeyZ",
        key: "z",
      }));
    });
    expect(getCollaborativeText(record, "source")?.toString())
      .toBe("print(1)");
  });

  it("updates undo and redo button state from UndoManager events", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addBoardObject(context.document, {
      id: CODE_OBJECT,
      kind: BUILTIN_OBJECT_KINDS.code,
      version: 1,
      transform: [10, 20, 320, 180, 0],
      zRank: "a",
      props: createCodeProps("print(1)", "python", "browser"),
    }, context.origin);
    context.undo.commandBoundary();
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const undoButton = container?.querySelector<HTMLButtonElement>('[aria-label="Отменить"]');
    const redoButton = container?.querySelector<HTMLButtonElement>('[aria-label="Повторить"]');
    expect(undoButton?.disabled).toBe(false);
    expect(redoButton?.disabled).toBe(true);

    await act(async () => undoButton?.click());

    expect(undoButton?.disabled).toBe(true);
    expect(redoButton?.disabled).toBe(false);
    expect(getPageObjects(context.document).has(CODE_OBJECT)).toBe(false);

    await act(async () => redoButton?.click());

    expect(undoButton?.disabled).toBe(false);
    expect(redoButton?.disabled).toBe(true);
    expect(getPageObjects(context.document).has(CODE_OBJECT)).toBe(true);
  });

  it("undoes and redoes an eraser batch atomically without reverting remote work", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addRectangle(context, RECTANGLE_ONE, "a0", "#ffffff");
    addRectangle(context, RECTANGLE_TWO, "a1", "#fff3bf");
    addRectangle(context, RECTANGLE_THREE, "a2", "#dbeafe");
    context.undo.clear();
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];

    await act(async () => {
      renderer.callbacks.onDeleteObjects([
        RECTANGLE_ONE,
        RECTANGLE_TWO,
        RECTANGLE_ONE,
      ]);
    });
    expect(getPageObjects(context.document).has(RECTANGLE_ONE)).toBe(false);
    expect(getPageObjects(context.document).has(RECTANGLE_TWO)).toBe(false);
    expect(getPageObjects(context.document).has(RECTANGLE_THREE)).toBe(true);

    const remoteOrigin = createLocalCommandOrigin("remote-eraser-undo-test");
    const remoteTransform = [90, 110, 150, 95, 0.25] as const;
    await act(async () => {
      setObjectTransform(
        context.document,
        RECTANGLE_THREE,
        remoteTransform,
        remoteOrigin,
      );
    });
    focusBoard();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyZ",
        ctrlKey: true,
        key: "z",
      }));
    });

    expect(renderer.cancelInteractionCount).toBe(1);
    expect(getPageObjects(context.document).has(RECTANGLE_ONE)).toBe(true);
    expect(getPageObjects(context.document).has(RECTANGLE_TWO)).toBe(true);
    expect(readBoardObject(
      getPageObjects(context.document).get(RECTANGLE_THREE)!,
    ).transform).toEqual(remoteTransform);
    expect(context.undo.canUndo).toBe(false);
    expect(context.undo.canRedo).toBe(true);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyY",
        ctrlKey: true,
        key: "y",
      }));
    });

    expect(renderer.cancelInteractionCount).toBe(2);
    expect(getPageObjects(context.document).has(RECTANGLE_ONE)).toBe(false);
    expect(getPageObjects(context.document).has(RECTANGLE_TWO)).toBe(false);
    expect(readBoardObject(
      getPageObjects(context.document).get(RECTANGLE_THREE)!,
    ).transform).toEqual(remoteTransform);
    expect(context.undo.canUndo).toBe(true);
    expect(context.undo.canRedo).toBe(false);
  });

  it("blocks keyboard and renderer mutations while read-only", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addBoardObject(context.document, {
      id: CODE_OBJECT,
      kind: BUILTIN_OBJECT_KINDS.code,
      version: 1,
      transform: [10, 20, 320, 180, 0],
      zRank: "a",
      props: createCodeProps("print(1)", "python", "browser"),
    }, context.origin);
    addRectangle(context, RECTANGLE_ONE, "b0", "#ffffff");
    addRectangle(context, RECTANGLE_TWO, "b1", "#fff3bf");
    addRectangle(context, RECTANGLE_THREE, "b2", "#dbeafe");
    context.undo.commandBoundary();
    const factory = new FakeRendererFactory();

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    const renderer = factory.instances[0];
    await act(async () => {
      renderer.callbacks.onSelectionChange([RECTANGLE_ONE]);
    });
    expect(container?.querySelector(".board-v2__stylebar")).not.toBeNull();
    const orderBefore = orderedObjectIds(context);
    const fillBefore = readBoardObject(
      getPageObjects(context.document).get(RECTANGLE_ONE)!,
    ).style.get("fill");

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory, {
        readOnly: true,
      })));
    });

    focusBoard();
    let blockedDigitAccepted = false;
    let selectDigitAccepted = true;
    await act(async () => {
      blockedDigitAccepted = window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Digit3",
        key: "3",
      }));
      selectDigitAccepted = window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Digit1",
        key: "1",
      }));
    });
    expect(blockedDigitAccepted).toBe(true);
    expect(selectDigitAccepted).toBe(false);
    expect(renderer.tool).toBe("hand");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Digit1",
        key: "1",
      }));
    });
    expect(renderer.tool).toBe("select");

    await act(async () => {
      renderer.callbacks.onEditObject(CODE_OBJECT);
      renderer.callbacks.onDeleteObjects([CODE_OBJECT]);
      renderer.callbacks.onCreateObject({
        kind: BUILTIN_OBJECT_KINDS.rectangle,
        transform: [0, 0, 20, 20, 0],
      });
      renderer.callbacks.onTransformStart();
      renderer.callbacks.onTransformObjects(new Map([
        [CODE_OBJECT, [100, 100, 320, 180, 0] as const],
      ]));
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        bubbles: true,
      }));
      window.dispatchEvent(new KeyboardEvent("keydown", {
        code: "BracketRight",
        key: "]",
        ctrlKey: true,
        bubbles: true,
      }));
      window.dispatchEvent(new KeyboardEvent("keydown", {
        code: "BracketRight",
        key: "]",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }));
    });

    expect(container?.querySelector("textarea")).toBeNull();
    expect(container?.querySelector(".board-v2__stylebar")).toBeNull();
    expect(getPageObjects(context.document).size).toBe(4);
    expect(readBoardObject(getPageObjects(context.document).get(CODE_OBJECT)!).transform)
      .toEqual([10, 20, 320, 180, 0]);
    expect(orderedObjectIds(context)).toEqual(orderBefore);
    expect(readBoardObject(
      getPageObjects(context.document).get(RECTANGLE_ONE)!,
    ).style.get("fill")).toBe(fillBefore);
    expect(factory.instances).toHaveLength(1);
    expect(renderer.destroyCount).toBe(0);
  });

  it("terminates an in-flight code worker when the surface unmounts", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addBoardObject(context.document, {
      id: CODE_OBJECT,
      kind: BUILTIN_OBJECT_KINDS.code,
      version: 1,
      transform: [10, 20, 320, 180, 0],
      zRank: "a",
      props: createCodeProps("while True:\n    pass", "python", "browser"),
    }, context.origin);
    const factory = new FakeRendererFactory();
    const workers: Array<{ terminate: ReturnType<typeof vi.fn> }> = [];

    class WorkerStub {
      readonly terminate = vi.fn();
      readonly postMessage = vi.fn();
      readonly listeners = new Map<string, Set<EventListener>>();

      constructor() {
        workers.push(this);
      }

      addEventListener(type: string, listener: EventListener): void {
        const listeners = this.listeners.get(type) ?? new Set<EventListener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: EventListener): void {
        this.listeners.get(type)?.delete(listener);
      }
    }
    vi.stubGlobal("Worker", WorkerStub);

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    await act(async () => factory.instances[0].callbacks.onEditObject(CODE_OBJECT));
    const runButton = [...(container?.querySelectorAll("button") ?? [])]
      .find((button) => button.textContent === "Запустить");

    await act(async () => runButton?.focus());
    expect(container?.querySelector("textarea")).not.toBeNull();
    await act(async () => runButton?.click());
    expect(workers).toHaveLength(1);
    expect(workers[0].terminate).not.toHaveBeenCalled();

    await act(async () => root?.unmount());
    root = undefined;

    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it("runs Python explicitly and terminates the disposable worker on result", async () => {
    const context = createBoardContext(PAGE_ONE);
    contexts.push(context);
    addBoardObject(context.document, {
      id: CODE_OBJECT,
      kind: BUILTIN_OBJECT_KINDS.code,
      version: 1,
      transform: [10, 20, 320, 180, 0],
      zRank: "a",
      props: createCodeProps("print(2 + 2)", "python", "browser"),
    }, context.origin);
    const factory = new FakeRendererFactory();
    let worker: WorkerStub | undefined;

    class WorkerStub {
      readonly terminate = vi.fn();
      readonly postMessage = vi.fn();
      readonly listeners = new Map<string, Set<EventListener>>();

      constructor(readonly url: string) {
        worker = this;
      }

      addEventListener(type: string, listener: EventListener): void {
        const listeners = this.listeners.get(type) ?? new Set<EventListener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: EventListener): void {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: Event): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    vi.stubGlobal("Worker", WorkerStub);

    await act(async () => {
      root?.render(createElement(BoardSurface, surfaceProps(context, factory)));
    });
    await act(async () => factory.instances[0].callbacks.onEditObject(CODE_OBJECT));
    const runButton = [...(container?.querySelectorAll("button") ?? [])]
      .find((button) => button.textContent === "Запустить");

    await act(async () => runButton?.click());
    expect(worker?.url).toBe(PYTHON_RUNNER_WORKER_URL);
    const request = worker?.postMessage.mock.calls[0]?.[0] as PythonRunnerRequest;
    expect(request).toEqual({
      type: PYTHON_RUNNER_REQUEST_TYPE,
      protocolVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
      runId: expect.any(String),
      payload: { kind: "script", code: "print(2 + 2)" },
    });

    await act(async () => {
      worker?.emit("message", new MessageEvent("message", {
        data: {
          type: PYTHON_RUNNER_RESULT_TYPE,
          protocolVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
          runId: request.runId,
          status: "ok",
          output: "4",
          truncated: false,
        },
      }));
      await Promise.resolve();
    });

    expect(container?.querySelector("pre")?.textContent).toBe("4");
    expect(
      readBoardObject(getPageObjects(context.document).get(CODE_OBJECT)!)
        .props.get("outputSnapshot"),
    ).toBe("4");
    expect(worker?.terminate).toHaveBeenCalledTimes(1);

    await act(async () => root?.unmount());
    root = undefined;
    expect(worker?.terminate).toHaveBeenCalledTimes(1);
  });
});
