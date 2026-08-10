// @vitest-environment jsdom

import {
  act,
  createElement,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  DEFAULT_FREE_DRAWING_PRESETS,
  createFreeDrawingPreset,
  deleteFreeDrawingPreset,
  freeDrawingPresetStyle,
  moveFreeDrawingPreset,
  patchFreeDrawingPreset,
  type FreeDrawingPreset,
} from "./freeDrawingPresets";
import { BoardStyleBar } from "./BoardStyleBar";

interface PaletteState {
  readonly presets: readonly FreeDrawingPreset[];
  readonly activePresetId: string;
}

interface PaletteEvents {
  readonly select: Mock;
  readonly change: Mock;
  readonly add: Mock;
  readonly remove: Mock;
  readonly move: Mock;
}

function updatePalette(
  setState: Dispatch<SetStateAction<PaletteState>>,
  update: (state: PaletteState) => PaletteState,
): void {
  setState((state) => update(state));
}

function PaletteHarness({
  events,
  initialState,
}: {
  readonly events: PaletteEvents;
  readonly initialState?: PaletteState;
}) {
  const [state, setState] = useState<PaletteState>(() => ({
    presets: (initialState?.presets ?? DEFAULT_FREE_DRAWING_PRESETS.slice(0, 3))
      .map((preset) => ({ ...preset })),
    activePresetId:
      initialState?.activePresetId ?? DEFAULT_FREE_DRAWING_PRESETS[0].id,
  }));
  const activePreset = state.presets.find(
    (preset) => preset.id === state.activePresetId,
  ) ?? state.presets[0];

  return createElement(BoardStyleBar, {
    available: new Set<string>(["stroke"]),
    values: freeDrawingPresetStyle(activePreset),
    mixed: new Set<string>(),
    fontStyleState: { bold: false, italic: false },
    freeDrawingPalette: {
      presets: state.presets,
      activePresetId: state.activePresetId,
      onSelectPreset: (presetId) => {
        events.select(presetId);
        updatePalette(setState, (current) => current.presets.some(
          (preset) => preset.id === presetId,
        )
          ? { ...current, activePresetId: presetId }
          : current);
      },
      onChangePreset: (presetId, patch) => {
        events.change(presetId, patch);
        updatePalette(setState, (current) => ({
          ...current,
          presets: current.presets.map((preset) => preset.id === presetId
            ? patchFreeDrawingPreset(preset, patch)
            : preset),
        }));
      },
      onAddPreset: () => {
        const source = state.presets.find(
          (preset) => preset.id === state.activePresetId,
        );
        const created = createFreeDrawingPreset(state.presets, source);
        if (!created) {
          events.add(null);
          return null;
        }
        setState({
          ...state,
          presets: [...state.presets, created],
        });
        events.add(created.id);
        return created.id;
      },
      onDeletePreset: (presetId) => {
        events.remove(presetId);
        updatePalette(setState, (current) => {
          const removedIndex = current.presets.findIndex(
            (preset) => preset.id === presetId,
          );
          const presets = deleteFreeDrawingPreset(
            current.presets,
            presetId,
          );
          if (presets === current.presets) return current;
          return {
            presets,
            activePresetId: current.activePresetId === presetId
              ? presets[Math.min(removedIndex, presets.length - 1)].id
              : current.activePresetId,
          };
        });
      },
      onMovePreset: (presetId, targetIndex) => {
        events.move(presetId, targetIndex);
        updatePalette(setState, (current) => ({
          ...current,
          presets: moveFreeDrawingPreset(
            current.presets,
            presetId,
            targetIndex,
          ),
        }));
      },
    },
    onStyleChange: vi.fn(),
    onFontStyleToggle: vi.fn(),
  });
}

function FontFamilyHarness({
  changes,
  initialFontFamily = "Inter, Arial, sans-serif",
  mixed = false,
}: {
  readonly changes: Mock;
  readonly initialFontFamily?: string;
  readonly mixed?: boolean;
}) {
  const [fontFamily, setFontFamily] = useState(initialFontFamily);

  return createElement(BoardStyleBar, {
    available: new Set<string>(["fontFamily"]),
    values: { fontFamily },
    mixed: mixed ? new Set<string>(["fontFamily"]) : new Set<string>(),
    fontStyleState: { bold: false, italic: false },
    onStyleChange: (property, value) => {
      changes(property, value);
      if (property === "fontFamily" && typeof value === "string") {
        setFontFamily(value);
      }
    },
    onFontStyleToggle: vi.fn(),
  });
}

function createPaletteEvents(): PaletteEvents {
  return {
    select: vi.fn(),
    change: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    move: vi.fn(),
  };
}

function pointerEvent(
  type: string,
  options: {
    readonly pointerId?: number;
    readonly pointerType?: string;
    readonly isPrimary?: boolean;
    readonly x: number;
    readonly y?: number;
  },
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: options.x,
    clientY: options.y ?? 10,
  });
  Object.defineProperties(event, {
    pointerId: {
      configurable: true,
      value: options.pointerId ?? 1,
    },
    pointerType: {
      configurable: true,
      value: options.pointerType ?? "mouse",
    },
    isPrimary: {
      configurable: true,
      value: options.isPrimary ?? true,
    },
  });
  return event;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!setter) throw new Error("HTMLInputElement value setter is unavailable");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function serializedFontFamily(value: string): string {
  const preview = document.createElement("span");
  preview.style.fontFamily = value;
  return preview.style.fontFamily;
}

function presetButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(
    ".board-stylebar__pen-preset",
  )];
}

function presetOrder(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>(
    "[data-pen-preset-id]",
  )].map((slot) => slot.dataset.penPresetId ?? "");
}

let container: HTMLDivElement;
let root: Root;
let animationFrames: Map<number, FrameRequestCallback>;
let nextAnimationFrameId: number;

function flushAnimationFrames(frameTime = performance.now()): void {
  const callbacks = [...animationFrames.values()];
  animationFrames.clear();
  for (const callback of callbacks) callback(frameTime);
}

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  animationFrames = new Map();
  nextAnimationFrameId = 1;
  vi.stubGlobal("requestAnimationFrame", (
    callback: FrameRequestCallback,
  ): number => {
    const id = nextAnimationFrameId;
    nextAnimationFrameId += 1;
    animationFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    animationFrames.delete(id);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderPalette(
  events: PaletteEvents,
  initialState?: PaletteState,
): Promise<void> {
  await act(async () => {
    root.render(createElement(PaletteHarness, { events, initialState }));
  });
}

async function renderFontFamily(
  changes: Mock,
  options: {
    readonly initialFontFamily?: string;
    readonly mixed?: boolean;
  } = {},
): Promise<void> {
  await act(async () => {
    root.render(createElement(FontFamilyHarness, { changes, ...options }));
  });
}

function fontFamilyTrigger(): HTMLButtonElement {
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-label="Шрифт"]',
  );
  expect(trigger).not.toBeNull();
  return trigger!;
}

function fontFamilyOption(label: string): HTMLButtonElement | null {
  return [...document.body.querySelectorAll<HTMLButtonElement>(
    '.board-font-family-menu button[role="option"]',
  )].find((option) => option.textContent?.trim() === label) ?? null;
}

async function openFontFamilyMenu(): Promise<HTMLElement> {
  const trigger = fontFamilyTrigger();
  await act(async () => {
    trigger.click();
  });
  const listbox = document.body.querySelector<HTMLElement>(
    '[role="listbox"][aria-label="Выбор шрифта"]',
  );
  expect(listbox).not.toBeNull();
  return listbox!;
}

describe("BoardStyleBar font family menu", () => {
  const expectedOptions = [
    ["Inter", "Inter, Arial, sans-serif"],
    ["Georgia", "Georgia, Times New Roman, serif"],
    ["Cascadia Code", "Cascadia Code, Consolas, monospace"],
    ["Arial", "Arial, sans-serif"],
    ["Verdana", "Verdana, sans-serif"],
    ["Trebuchet MS", "Trebuchet MS, sans-serif"],
    ["Times New Roman", "Times New Roman, serif"],
    ["Courier New", "Courier New, monospace"],
  ] as const;

  it("previews the current font and renders every known option in that font", async () => {
    const changes = vi.fn();
    await renderFontFamily(changes);

    const trigger = fontFamilyTrigger();
    const current = trigger.querySelector<HTMLElement>(
      ".board-font-family-control__current",
    );
    expect(current?.textContent).toBe("Inter");
    expect(current?.style.fontFamily).toBe("Inter, Arial, sans-serif");

    const listbox = await openFontFamilyMenu();
    const options = [...listbox.querySelectorAll<HTMLButtonElement>(
      'button[role="option"]',
    )];
    expect(options.map((option) => option.textContent?.trim())).toEqual(
      expectedOptions.map(([label]) => label),
    );

    for (const [label, fontFamily] of expectedOptions) {
      const option = fontFamilyOption(label);
      expect(option?.dataset.fontFamily).toBe(fontFamily);
      expect(option?.querySelector<HTMLElement>(
        ".board-font-family-menu__label",
      )?.style.fontFamily).toBe(serializedFontFamily(fontFamily));
    }
    expect(fontFamilyOption("Другой шрифт...")).toBeNull();

    const georgia = fontFamilyOption("Georgia");
    await act(async () => {
      georgia?.click();
    });
    expect(changes).toHaveBeenCalledWith(
      "fontFamily",
      "Georgia, Times New Roman, serif",
    );
    expect(document.body.querySelector('[role="listbox"]')).toBeNull();
    expect(current?.textContent).toBe("Georgia");
    expect(current?.style.fontFamily).toBe(
      serializedFontFamily("Georgia, Times New Roman, serif"),
    );
    expect(document.activeElement).toBe(trigger);
  });

  it("does not expose unsupported stored stacks and keeps mixed state in the interface font", async () => {
    const changes = vi.fn();
    await renderFontFamily(changes, {
      initialFontFamily: '"Noto Sans", Arial, sans-serif',
    });

    let current = fontFamilyTrigger().querySelector<HTMLElement>(
      ".board-font-family-control__current",
    );
    expect(current?.textContent).toBe("Выберите шрифт");
    expect(current?.style.fontFamily).toBe("");

    await act(async () => {
      root.render(createElement(FontFamilyHarness, {
        changes,
        initialFontFamily: '"Noto Sans", Arial, sans-serif',
        mixed: true,
      }));
    });
    current = fontFamilyTrigger().querySelector<HTMLElement>(
      ".board-font-family-control__current",
    );
    expect(current?.textContent).toBe("Смешанный");
    expect(current?.style.fontFamily).toBe("");
  });

  it("supports keyboard selection, Escape, and outside dismissal", async () => {
    const changes = vi.fn();
    await renderFontFamily(changes);
    const trigger = fontFamilyTrigger();
    trigger.focus();

    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowDown",
      }));
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowDown",
      }));
    });
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }));
    });
    expect(changes).toHaveBeenCalledWith(
      "fontFamily",
      "Georgia, Times New Roman, serif",
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);

    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "End",
      }));
    });
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);

    await openFontFamilyMenu();
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", {
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.querySelector('[role="listbox"]')).toBeNull();
  });
});

describe("BoardStyleBar drawing palette configuration", () => {
  it("adjusts the hovered preset width by wheel without selecting it or reaching the board", async () => {
    const events = createPaletteEvents();
    await renderPalette(events);
    let buttons = presetButtons(container);
    const propagated = vi.fn();
    document.addEventListener("wheel", propagated);

    const inactiveUp = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -120,
    });
    await act(async () => buttons[1].dispatchEvent(inactiveUp));
    document.removeEventListener("wheel", propagated);

    expect(inactiveUp.defaultPrevented).toBe(true);
    expect(propagated).not.toHaveBeenCalled();
    expect(events.change).toHaveBeenLastCalledWith("red", {
      strokeWidth: 3,
    });
    expect(events.select).not.toHaveBeenCalled();
    buttons = presetButtons(container);
    expect(buttons[1].getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(buttons[1].style.getPropertyValue("--board-pen-radius")).toBe(
      "3px",
    );

    const inactiveDown = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    });
    await act(async () => buttons[1].dispatchEvent(inactiveDown));
    expect(inactiveDown.defaultPrevented).toBe(true);
    expect(events.change).toHaveBeenLastCalledWith("red", {
      strokeWidth: 2.5,
    });
    expect(events.select).not.toHaveBeenCalled();

    const activeUp = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -24,
    });
    await act(async () => presetButtons(container)[0].dispatchEvent(activeUp));
    expect(activeUp.defaultPrevented).toBe(true);
    expect(events.change).toHaveBeenLastCalledWith("graphite", {
      strokeWidth: 3,
    });
    expect(events.select).not.toHaveBeenCalled();
    buttons = presetButtons(container);
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
    expect(buttons[0].style.getPropertyValue("--board-pen-radius")).toBe(
      "3px",
    );

    await act(async () => buttons[0].click());
    expect(container.querySelector<HTMLInputElement>(
      '.board-stylebar__pen-popover input[min="0.5"][max="16"]',
    )?.value).toBe("3");
  });

  it("normalizes trackpad wheel bursts and leaves horizontal scrolling alone", async () => {
    const events = createPaletteEvents();
    await renderPalette(events);
    const red = presetButtons(container)[1];

    const firstHalf = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -12,
    });
    const secondHalf = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -12,
    });
    await act(async () => {
      red.dispatchEvent(firstHalf);
      red.dispatchEvent(secondHalf);
    });

    expect(firstHalf.defaultPrevented).toBe(true);
    expect(secondHalf.defaultPrevented).toBe(true);
    expect(events.change).toHaveBeenCalledOnce();
    expect(events.change).toHaveBeenLastCalledWith("red", {
      strokeWidth: 3,
    });

    events.change.mockClear();
    const partialBeforeLine = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 12,
    });
    const lineReset = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      deltaY: 1,
    });
    await act(async () => {
      red.dispatchEvent(partialBeforeLine);
      red.dispatchEvent(lineReset);
    });
    expect(events.change).toHaveBeenCalledOnce();
    expect(events.change).toHaveBeenLastCalledWith("red", {
      strokeWidth: 2.5,
    });

    events.change.mockClear();
    const partialAfterLine = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 12,
    });
    await act(async () => presetButtons(container)[1].dispatchEvent(
      partialAfterLine,
    ));
    expect(partialAfterLine.defaultPrevented).toBe(true);
    expect(events.change).not.toHaveBeenCalled();

    const pinch = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaX: 60,
      deltaY: -8,
    });
    await act(async () => red.dispatchEvent(pinch));
    expect(pinch.defaultPrevented).toBe(true);
    expect(events.change).not.toHaveBeenCalled();

    const propagated = vi.fn();
    document.addEventListener("wheel", propagated);
    const horizontal = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: 60,
      deltaY: -8,
    });
    await act(async () => red.dispatchEvent(horizontal));
    document.removeEventListener("wheel", propagated);
    expect(horizontal.defaultPrevented).toBe(false);
    expect(propagated).toHaveBeenCalledOnce();
    expect(events.change).not.toHaveBeenCalled();

    const lineMode = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      deltaY: 1,
    });
    await act(async () => presetButtons(container)[1].dispatchEvent(lineMode));
    expect(lineMode.defaultPrevented).toBe(true);
    expect(events.change).toHaveBeenLastCalledWith("red", {
      strokeWidth: 2,
    });
  });

  it("does not change width while a palette reorder owns the pointer", async () => {
    const events = createPaletteEvents();
    await renderPalette(events);
    await act(async () => container.querySelector<HTMLButtonElement>(
      ".board-stylebar__palette-toggle",
    )?.click());
    const red = presetButtons(container)[1];

    await act(async () => red.dispatchEvent(pointerEvent("pointerdown", {
      pointerId: 71,
      x: 48,
    })));
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -120,
    });
    await act(async () => container.querySelector<HTMLElement>(
      ".board-stylebar__strip",
    )?.dispatchEvent(wheel));

    expect(wheel.defaultPrevented).toBe(true);
    expect(events.change).not.toHaveBeenCalled();
    expect(events.select).not.toHaveBeenCalled();

    await act(async () => red.dispatchEvent(pointerEvent("pointerup", {
      pointerId: 71,
      x: 48,
    })));
  });

  it("consumes boundary no-ops and adjusts a slot in palette configuration mode", async () => {
    const events = createPaletteEvents();
    await renderPalette(events, {
      presets: [
        {
          ...DEFAULT_FREE_DRAWING_PRESETS[0],
          strokeWidth: 16,
        },
        {
          ...DEFAULT_FREE_DRAWING_PRESETS[1],
          strokeWidth: 0.5,
        },
      ],
      activePresetId: DEFAULT_FREE_DRAWING_PRESETS[0].id,
    });
    let buttons = presetButtons(container);

    const maximumUp = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -120,
    });
    const minimumDown = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    });
    await act(async () => {
      buttons[0].dispatchEvent(maximumUp);
      buttons[1].dispatchEvent(minimumDown);
    });
    expect(maximumUp.defaultPrevented).toBe(true);
    expect(minimumDown.defaultPrevented).toBe(true);
    expect(events.change).not.toHaveBeenCalled();
    buttons = presetButtons(container);
    expect(buttons[0].style.getPropertyValue("--board-pen-radius")).toBe(
      "16px",
    );
    expect(buttons[1].style.getPropertyValue("--board-pen-radius")).toBe(
      "0.5px",
    );
    expect(events.select).not.toHaveBeenCalled();

    await act(async () => container.querySelector<HTMLButtonElement>(
      ".board-stylebar__palette-toggle",
    )?.click());
    buttons = presetButtons(container);
    const editingUp = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -120,
    });
    await act(async () => {
      buttons[1].dispatchEvent(editingUp);
    });

    expect(editingUp.defaultPrevented).toBe(true);
    expect(events.change).toHaveBeenCalledOnce();
    expect(events.change).toHaveBeenLastCalledWith("red", {
      strokeWidth: 1,
    });
    expect(events.select).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(presetButtons(container)[1].style.getPropertyValue(
      "--board-pen-radius",
    )).toBe("1px");
  });

  it("keeps ordinary selection behavior and directly edits any slot in configuration mode", async () => {
    const events = createPaletteEvents();
    await renderPalette(events);
    const toggle = container.querySelector<HTMLButtonElement>(
      ".board-stylebar__palette-toggle",
    );
    let buttons = presetButtons(container);

    await act(async () => buttons[1].click());
    expect(events.select).toHaveBeenCalledWith("red");
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    buttons = presetButtons(container);
    await act(async () => buttons[1].click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => toggle?.click());
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".board-v2__stylebar")?.classList.contains(
      "board-v2__stylebar--palette-editing",
    )).toBe(true);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelectorAll(".board-stylebar__pen-delete"))
      .toHaveLength(3);
    expect(container.querySelector(".board-stylebar__pen-add")).not.toBeNull();

    buttons = presetButtons(container);
    await act(async () => buttons[0].click());
    expect(events.select).toHaveBeenCalledTimes(1);
    expect(buttons[0].getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(buttons[0]);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
    });
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(toggle);

    await act(async () => toggle?.click());
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => toggle?.click());
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("edits Drawing opacity through the alpha-enabled color picker", async () => {
    const events = createPaletteEvents();
    await renderPalette(events);

    await act(async () => presetButtons(container)[0].click());
    const alpha = container.querySelector<HTMLInputElement>(
      ".board-stylebar__pen-popover .board-color-picker__alpha",
    );
    if (!alpha) throw new Error("Drawing alpha slider not rendered");

    expect(alpha.min).toBe("0");
    expect(alpha.max).toBe("1");
    expect(alpha.step).toBe("0.01");
    expect(alpha.value).toBe("1");
    expect(alpha.dir).toBe("rtl");
    expect(container.querySelector(
      '[aria-label="Непрозрачность рисования"]',
    )).toBeNull();

    await act(async () => {
      setInputValue(alpha, "0");
      flushAnimationFrames();
    });
    expect(events.change).toHaveBeenLastCalledWith("graphite", {
      opacity: 0,
    });
    expect(alpha.getAttribute("aria-valuetext")).toBe("0%");
  });

  it("adds an inactive cloned slot, edits it immediately, and keeps one undeletable slot", async () => {
    const events = createPaletteEvents();
    await renderPalette(events);
    await act(async () => container.querySelector<HTMLButtonElement>(
      ".board-stylebar__palette-toggle",
    )?.click());

    await act(async () => container.querySelector<HTMLButtonElement>(
      ".board-stylebar__pen-add",
    )?.click());
    expect(events.add).toHaveBeenCalledWith("custom-1");
    expect(presetButtons(container)).toHaveLength(4);
    expect(presetButtons(container).at(-1)?.getAttribute("aria-pressed"))
      .toBe("false");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    const preview = container.querySelector<HTMLButtonElement>(
      ".board-stylebar__pen-popover .board-color-picker__preview",
    );
    await act(async () => {
      preview?.focus();
      preview?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
      }));
    });
    const color = container.querySelector<HTMLInputElement>(
      '.board-stylebar__pen-popover [aria-label="Цвет в формате HEX"]',
    );
    await act(async () => {
      if (!color) throw new Error("Pen HEX input not rendered");
      setInputValue(color, "#abcdefff");
      color.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }));
    });
    expect(events.change).toHaveBeenCalledWith("custom-1", {
      stroke: "#abcdef",
    });
    expect(container.querySelector('input[type="color"]')).toBeNull();
    expect(presetButtons(container).at(-1)?.style.getPropertyValue(
      "--board-swatch",
    )).toBe("#abcdef");

    await act(async () => {
      color?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
    });
    expect(container.querySelector(".board-color-picker__formats")).toBeNull();
    expect(container.querySelector(".board-stylebar__pen-popover"))
      .not.toBeNull();
    expect(document.activeElement).toBe(preview);

    await act(async () => container.querySelectorAll<HTMLButtonElement>(
      ".board-stylebar__pen-delete",
    )[0].click());
    await act(async () => flushAnimationFrames());
    expect(events.remove).toHaveBeenCalledWith("graphite");
    expect(presetButtons(container)[0].getAttribute("aria-pressed")).toBe("true");

    while (presetButtons(container).length > 1) {
      await act(async () => container.querySelectorAll<HTMLButtonElement>(
        ".board-stylebar__pen-delete",
      )[0].click());
      await act(async () => flushAnimationFrames());
    }
    const onlyDelete = container.querySelector<HTMLButtonElement>(
      ".board-stylebar__pen-delete",
    );
    expect(onlyDelete?.disabled).toBe(true);
    expect(presetButtons(container)).toHaveLength(1);
  });

  it("keeps the edit-only add control outside the centered preset strip", async () => {
    const events = createPaletteEvents();
    await renderPalette(events);
    await act(async () => container.querySelector<HTMLButtonElement>(
      ".board-stylebar__palette-toggle",
    )?.click());

    const stylebar = container.querySelector<HTMLElement>(
      ".board-v2__stylebar",
    );
    const strip = container.querySelector<HTMLElement>(
      ".board-stylebar__strip",
    );
    const add = container.querySelector<HTMLButtonElement>(
      ".board-stylebar__pen-add",
    );
    expect(stylebar).not.toBeNull();
    expect(strip).not.toBeNull();
    expect(add).not.toBeNull();
    expect(add?.parentElement).toBe(stylebar);
    expect(strip?.contains(add ?? null)).toBe(false);
    expect(strip?.querySelectorAll("[data-pen-preset-id]")).toHaveLength(3);

    await act(async () => add?.click());
    expect(strip?.querySelectorAll("[data-pen-preset-id]")).toHaveLength(4);
    expect(add?.parentElement).toBe(stylebar);
  });

  it("reorders focused slots with Alt+Arrow and preserves focus", async () => {
    const events = createPaletteEvents();
    await renderPalette(events);
    await act(async () => container.querySelector<HTMLButtonElement>(
      ".board-stylebar__palette-toggle",
    )?.click());
    const red = presetButtons(container)[1];
    red.focus();

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      altKey: true,
      key: "ArrowRight",
    });
    await act(async () => red.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(events.move).toHaveBeenCalledOnce();
    expect(events.move).toHaveBeenCalledWith("red", 2);
    expect(presetOrder(container)).toEqual(["graphite", "blue", "red"]);
    expect(document.activeElement).toBe(red);

    const boundaryEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      altKey: true,
      key: "ArrowRight",
    });
    await act(async () => red.dispatchEvent(boundaryEvent));
    expect(boundaryEvent.defaultPrevented).toBe(true);
    expect(events.move).toHaveBeenCalledOnce();
  });

  it("keeps the dragged slot under the pointer and shifts neighbors smoothly", async () => {
    const events = createPaletteEvents();
    await renderPalette(events);
    await act(async () => container.querySelector<HTMLButtonElement>(
      ".board-stylebar__palette-toggle",
    )?.click());

    const buttons = presetButtons(container);
    const strip = container.querySelector<HTMLElement>(
      ".board-stylebar__strip",
    );
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 400 },
      scrollWidth: { configurable: true, value: 400 },
    });
    vi.spyOn(strip!, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 400,
      bottom: 32,
      left: 0,
      width: 400,
      height: 32,
      toJSON: () => ({}),
    });
    buttons.forEach((button, index) => {
      vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
        x: index * 40,
        y: 0,
        top: 0,
        right: index * 40 + 32,
        bottom: 32,
        left: index * 40,
        width: 32,
        height: 32,
        toJSON: () => ({}),
      });
    });

    await act(async () => {
      buttons[1].dispatchEvent(pointerEvent("pointerdown", {
        pointerId: 21,
        x: 42,
      }));
      buttons[1].dispatchEvent(pointerEvent("pointermove", {
        pointerId: 21,
        x: 83,
      }));
      flushAnimationFrames();
    });

    const redSlot = container.querySelector<HTMLElement>(
      '[data-pen-preset-id="red"]',
    );
    const blueSlot = container.querySelector<HTMLElement>(
      '[data-pen-preset-id="blue"]',
    );
    expect(presetOrder(container)).toEqual(["graphite", "red", "blue"]);
    expect(redSlot?.classList.contains("is-dragging")).toBe(true);
    expect(redSlot?.style.getPropertyValue("--board-palette-drag-x"))
      .toBe("41px");
    expect(blueSlot?.classList.contains("is-displaced")).toBe(true);
    expect(blueSlot?.style.getPropertyValue("--board-palette-drag-x"))
      .toBe("-40px");

    await act(async () => {
      buttons[1].dispatchEvent(pointerEvent("pointerup", {
        pointerId: 21,
        x: 83,
      }));
      buttons[1].click();
    });

    expect(events.move).toHaveBeenCalledOnce();
    expect(events.move).toHaveBeenCalledWith("red", 2);
    expect(presetOrder(container)).toEqual(["graphite", "blue", "red"]);
    expect(container.querySelector(".is-dragging")).toBeNull();
    expect(container.querySelector("[role=\"dialog\"]")).toBeNull();
    expect(container.querySelector(".board-v2__stylebar")?.classList.contains(
      "board-v2__stylebar--palette-drop-commit",
    )).toBe(true);

    await act(async () => flushAnimationFrames(16));
    expect(container.querySelector(".board-v2__stylebar")?.classList.contains(
      "board-v2__stylebar--palette-drop-commit",
    )).toBe(true);
    await act(async () => flushAnimationFrames(32));
    expect(container.querySelector(".board-v2__stylebar")?.classList.contains(
      "board-v2__stylebar--palette-drop-commit",
    )).toBe(false);
  });

  it("starts mouse reorder after three pixels and suppresses its click", async () => {
    const events = createPaletteEvents();
    await renderPalette(events);
    await act(async () => container.querySelector<HTMLButtonElement>(
      ".board-stylebar__palette-toggle",
    )?.click());
    const red = presetButtons(container)[1];

    const move = pointerEvent("pointermove", {
      pointerId: 25,
      x: 59,
    });
    await act(async () => {
      red.dispatchEvent(pointerEvent("pointerdown", {
        pointerId: 25,
        x: 56,
      }));
      red.dispatchEvent(move);
      flushAnimationFrames();
    });

    expect(move.defaultPrevented).toBe(true);
    expect(container.querySelector(
      '[data-pen-preset-id="red"]',
    )?.classList.contains("is-dragging")).toBe(true);

    await act(async () => {
      red.dispatchEvent(pointerEvent("pointerup", {
        pointerId: 25,
        x: 59,
      }));
      red.click();
    });
    expect(events.move).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("does not advance edge scrolling on pointer release", async () => {
    const events = createPaletteEvents();
    await renderPalette(events, {
      presets: DEFAULT_FREE_DRAWING_PRESETS,
      activePresetId: DEFAULT_FREE_DRAWING_PRESETS[0].id,
    });
    await act(async () => container.querySelector<HTMLButtonElement>(
      ".board-stylebar__palette-toggle",
    )?.click());
    const buttons = presetButtons(container);
    const strip = container.querySelector<HTMLElement>(
      ".board-stylebar__strip",
    )!;
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 240 },
    });
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 120,
      bottom: 32,
      left: 0,
      width: 120,
      height: 32,
      toJSON: () => ({}),
    });
    buttons.forEach((button, index) => {
      vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
        x: index * 40,
        y: 0,
        top: 0,
        right: index * 40 + 32,
        bottom: 32,
        left: index * 40,
        width: 32,
        height: 32,
        toJSON: () => ({}),
      });
    });

    await act(async () => {
      buttons[0].dispatchEvent(pointerEvent("pointerdown", {
        pointerId: 26,
        x: 16,
      }));
      buttons[0].dispatchEvent(pointerEvent("pointermove", {
        pointerId: 26,
        x: 94,
      }));
      flushAnimationFrames(16);
    });
    const scrollBeforeRelease = strip.scrollLeft;
    expect(scrollBeforeRelease).toBeGreaterThan(0);
    expect(animationFrames.size).toBe(1);

    await act(async () => buttons[0].dispatchEvent(pointerEvent("pointerup", {
      pointerId: 26,
      x: 94,
    })));
    expect(strip.scrollLeft).toBe(scrollBeforeRelease);
    expect(events.move).toHaveBeenCalledOnce();
  });

  it("bounds edge scrolling to the intrinsic pre-drag range", async () => {
    const events = createPaletteEvents();
    await renderPalette(events, {
      presets: DEFAULT_FREE_DRAWING_PRESETS,
      activePresetId: DEFAULT_FREE_DRAWING_PRESETS[0].id,
    });
    await act(async () => container.querySelector<HTMLButtonElement>(
      ".board-stylebar__palette-toggle",
    )?.click());
    const buttons = presetButtons(container);
    const strip = container.querySelector<HTMLElement>(
      ".board-stylebar__strip",
    )!;
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: {
        configurable: true,
        get: () => 240 + strip.scrollLeft,
      },
    });
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 120,
      bottom: 32,
      left: 0,
      width: 120,
      height: 32,
      toJSON: () => ({}),
    });
    buttons.forEach((button, index) => {
      vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
        x: index * 40,
        y: 0,
        top: 0,
        right: index * 40 + 32,
        bottom: 32,
        left: index * 40,
        width: 32,
        height: 32,
        toJSON: () => ({}),
      });
    });

    await act(async () => {
      buttons[0].dispatchEvent(pointerEvent("pointerdown", {
        pointerId: 27,
        x: 16,
      }));
      buttons[0].dispatchEvent(pointerEvent("pointermove", {
        pointerId: 27,
        x: 94,
      }));
      for (let frame = 1; frame <= 30; frame += 1) {
        flushAnimationFrames(frame * 16);
      }
    });

    expect(strip.scrollLeft).toBe(120);
    expect(animationFrames.size).toBe(0);
    const dragOffset = Number.parseFloat(
      container.querySelector<HTMLElement>(
        '[data-pen-preset-id="graphite"]',
      )?.style.getPropertyValue("--board-palette-drag-x") ?? "NaN",
    );
    expect(Number.isFinite(dragOffset)).toBe(true);
    expect(dragOffset).toBe(198);

    await act(async () => buttons[0].dispatchEvent(pointerEvent("pointerup", {
      pointerId: 27,
      x: 94,
    })));
    expect(strip.scrollLeft).toBe(120);
  });

  it("suppresses a completed drag click without committing a no-op move", async () => {
    const events = createPaletteEvents();
    await renderPalette(events);
    await act(async () => container.querySelector<HTMLButtonElement>(
      ".board-stylebar__palette-toggle",
    )?.click());
    const buttons = presetButtons(container);

    await act(async () => {
      buttons[1].dispatchEvent(pointerEvent("pointerdown", {
        pointerId: 22,
        x: 56,
        y: 10,
      }));
      buttons[1].dispatchEvent(pointerEvent("pointermove", {
        pointerId: 22,
        x: 56,
        y: 24,
      }));
      flushAnimationFrames();
      buttons[1].dispatchEvent(pointerEvent("pointerup", {
        pointerId: 22,
        x: 56,
        y: 24,
      }));
      buttons[1].click();
    });

    expect(events.move).not.toHaveBeenCalled();
    expect(presetOrder(container)).toEqual(["graphite", "red", "blue"]);
    expect(container.querySelector("[role=\"dialog\"]")).toBeNull();
    expect(buttons[1].dataset.pointerFocus).toBe("true");

    await act(async () => buttons[1].dispatchEvent(new KeyboardEvent(
      "keydown",
      { bubbles: true, cancelable: true, key: "ArrowLeft" },
    )));
    expect(buttons[1].dataset.pointerFocus).toBeUndefined();
  });

  it("distinguishes a click from a touch drag and commits one final reorder", async () => {
    const events = createPaletteEvents();
    await renderPalette(events);
    await act(async () => container.querySelector<HTMLButtonElement>(
      ".board-stylebar__palette-toggle",
    )?.click());

    let buttons = presetButtons(container);
    const strip = container.querySelector<HTMLElement>(
      ".board-stylebar__strip",
    );
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 600 },
    });
    vi.spyOn(strip!, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 120,
      bottom: 32,
      left: 0,
      width: 120,
      height: 32,
      toJSON: () => ({}),
    });
    buttons.forEach((button, index) => {
      vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
        x: index * 40,
        y: 0,
        top: 0,
        right: index * 40 + 32,
        bottom: 32,
        left: index * 40,
        width: 32,
        height: 32,
        toJSON: () => ({}),
      });
    });

    await act(async () => {
      buttons[1].dispatchEvent(pointerEvent("pointerdown", { x: 56 }));
      buttons[1].dispatchEvent(pointerEvent("pointermove", { x: 57 }));
      flushAnimationFrames();
      buttons[1].dispatchEvent(pointerEvent("pointerup", { x: 57 }));
      buttons[1].click();
    });
    expect(events.move).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
    });

    buttons = presetButtons(container);
    await act(async () => {
      buttons[0].dispatchEvent(pointerEvent("pointerdown", {
        pointerId: 5,
        x: 16,
      }));
      buttons[0].dispatchEvent(pointerEvent("pointermove", {
        pointerId: 5,
        x: 130,
      }));
      flushAnimationFrames();
      buttons[0].dispatchEvent(pointerEvent("pointercancel", {
        pointerId: 5,
        x: 130,
      }));
    });
    expect(events.move).not.toHaveBeenCalled();
    expect(presetOrder(container)).toEqual(["graphite", "red", "blue"]);

    await act(async () => {
      buttons[1].dispatchEvent(pointerEvent("pointerdown", {
        pointerId: 6,
        pointerType: "touch",
        x: 56,
      }));
      window.dispatchEvent(pointerEvent("pointermove", {
        pointerId: 6,
        pointerType: "touch",
        x: 20,
      }));
      window.dispatchEvent(pointerEvent("pointerup", {
        pointerId: 6,
        pointerType: "touch",
        x: 20,
      }));
      buttons[1].click();
    });
    expect(strip?.scrollLeft).toBeGreaterThan(0);
    expect(events.move).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      buttons[1].dispatchEvent(pointerEvent("pointerdown", {
        pointerId: 9,
        x: 56,
      }));
      buttons[1].dispatchEvent(pointerEvent("pointermove", {
        pointerId: 9,
        x: 130,
      }));
      flushAnimationFrames();
      document.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
      window.dispatchEvent(pointerEvent("pointerup", {
        pointerId: 9,
        x: 130,
      }));
      buttons[1].click();
    });
    expect(events.move).not.toHaveBeenCalled();
    expect(presetOrder(container)).toEqual(["graphite", "red", "blue"]);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    vi.useFakeTimers();
    await act(async () => {
      buttons[1].dispatchEvent(pointerEvent("pointerdown", {
        pointerId: 7,
        pointerType: "touch",
        x: 56,
      }));
      buttons[2].dispatchEvent(pointerEvent("pointerdown", {
        pointerId: 8,
        pointerType: "touch",
        isPrimary: false,
        x: 96,
      }));
      vi.advanceTimersByTime(240);
      window.dispatchEvent(pointerEvent("pointermove", {
        pointerId: 7,
        pointerType: "touch",
        x: 130,
      }));
      window.dispatchEvent(pointerEvent("pointerup", {
        pointerId: 7,
        pointerType: "touch",
        x: 130,
      }));
      buttons[1].click();
    });

    expect(events.move).toHaveBeenCalledOnce();
    expect(events.move).toHaveBeenCalledWith("red", 2);
    expect(presetOrder(container)).toEqual(["graphite", "blue", "red"]);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
