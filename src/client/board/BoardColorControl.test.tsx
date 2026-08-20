// @vitest-environment jsdom

import { act, useState } from "react";
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
  BOARD_COLOR_TRANSPARENT,
  BoardColorControl,
  type BoardColorPaletteSlot,
} from "./BoardColorControl";

interface Events {
  readonly apply: Mock;
  readonly commit: Mock;
  readonly change: Mock;
  readonly add: Mock;
  readonly remove: Mock;
  readonly move: Mock;
  readonly continuousStart: Mock;
  readonly continuousEnd: Mock;
}

interface HarnessProps {
  readonly events: Events;
  readonly initialCurrent?: string;
  readonly mixed?: boolean;
  readonly allowTransparent?: boolean;
  readonly recentColors?: readonly string[];
}

const INITIAL_SLOTS: readonly BoardColorPaletteSlot[] = [
  { id: "graphite", color: "#17212b" },
  { id: "red", color: "#d33f49" },
  { id: "blue", color: "#2563eb" },
];

function moveSlot(
  slots: readonly BoardColorPaletteSlot[],
  slotId: string,
  targetIndex: number,
): readonly BoardColorPaletteSlot[] {
  const sourceIndex = slots.findIndex((slot) => slot.id === slotId);
  if (
    sourceIndex < 0
    || targetIndex < 0
    || targetIndex >= slots.length
    || targetIndex === sourceIndex
  ) {
    return slots;
  }
  const next = [...slots];
  const [slot] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, slot);
  return next;
}

function Harness({
  events,
  initialCurrent = "#17212b",
  mixed = false,
  allowTransparent = true,
  recentColors = ["#abcdef", "#d33f49"],
}: HarnessProps) {
  const [current, setCurrent] = useState(initialCurrent);
  const [slots, setSlots] = useState<readonly BoardColorPaletteSlot[]>(
    INITIAL_SLOTS,
  );
  return (
    <div className="board-v2">
      <BoardColorControl
        property="fill"
        current={current}
        mixed={mixed}
        allowTransparent={allowTransparent}
        paletteSlots={slots}
        recentColors={recentColors}
        onApply={(color) => {
          events.apply(color);
          setCurrent(color);
        }}
        onCommitColor={events.commit}
        onChangePaletteSlot={(slotId, color) => {
          events.change(slotId, color);
          setSlots((value) => value.map((slot) => slot.id === slotId
            ? { ...slot, color }
            : slot));
        }}
        onAddPaletteSlot={(color) => {
          const id = `custom-${slots.length + 1}`;
          events.add(color, id);
          setSlots((value) => [...value, { id, color }]);
          return id;
        }}
        onDeletePaletteSlot={(slotId) => {
          events.remove(slotId);
          setSlots((value) => value.filter((slot) => slot.id !== slotId));
        }}
        onMovePaletteSlot={(slotId, targetIndex) => {
          events.move(slotId, targetIndex);
          setSlots((value) => moveSlot(value, slotId, targetIndex));
        }}
        onContinuousChangeStart={events.continuousStart}
        onContinuousChangeEnd={events.continuousEnd}
      />
    </div>
  );
}

function createEvents(): Events {
  return {
    apply: vi.fn(),
    commit: vi.fn(),
    change: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    move: vi.fn(),
    continuousStart: vi.fn(),
    continuousEnd: vi.fn(),
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!setter) throw new Error("HTMLInputElement value setter unavailable");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function pointerEvent(
  type: string,
  options: {
    readonly x: number;
    readonly y?: number;
    readonly pointerId?: number;
    readonly pointerType?: string;
    readonly isPrimary?: boolean;
  },
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: options.x,
    clientY: options.y ?? 12,
  });
  Object.defineProperties(event, {
    pointerId: { value: options.pointerId ?? 1 },
    pointerType: { value: options.pointerType ?? "mouse" },
    isPrimary: { value: options.isPrimary ?? true },
  });
  return event;
}

function setHorizontalScrollGeometry(
  element: HTMLElement,
  {
    clientWidth = 120,
    scrollWidth = 500,
    scrollLeft = 0,
  }: {
    readonly clientWidth?: number;
    readonly scrollWidth?: number;
    readonly scrollLeft?: number;
  } = {},
): void {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: clientWidth },
    scrollWidth: { configurable: true, value: scrollWidth },
    scrollLeft: { configurable: true, writable: true, value: scrollLeft },
  });
}

function expectNoColorCallbacks(events: Events): void {
  expect(events.apply).not.toHaveBeenCalled();
  expect(events.commit).not.toHaveBeenCalled();
  expect(events.change).not.toHaveBeenCalled();
  expect(events.add).not.toHaveBeenCalled();
  expect(events.remove).not.toHaveBeenCalled();
  expect(events.move).not.toHaveBeenCalled();
  expect(events.continuousStart).not.toHaveBeenCalled();
  expect(events.continuousEnd).not.toHaveBeenCalled();
}

function slotButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(
    ".board-color-control__favorite",
  )];
}

function slotOrder(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>("[data-color-slot-id]")]
    .map((slot) => slot.dataset.colorSlotId ?? "");
}

let container: HTMLDivElement;
let root: Root;
let animationFrames: Map<number, FrameRequestCallback>;
let nextAnimationFrameId: number;

function flushAnimationFrames(): void {
  const callbacks = [...animationFrames.values()];
  animationFrames.clear();
  for (const callback of callbacks) callback(performance.now());
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

async function renderHarness(
  events: Events,
  props: Omit<HarnessProps, "events"> = {},
): Promise<void> {
  await act(async () => {
    root.render(<Harness events={events} {...props} />);
  });
}

async function openControl(): Promise<HTMLButtonElement> {
  const trigger = container.querySelector<HTMLButtonElement>(
    ".board-color-control__trigger",
  );
  if (!trigger) throw new Error("Color trigger not rendered");
  await act(async () => trigger.click());
  return trigger;
}

describe("BoardColorControl", () => {
  it("opens an accessible compact editor and applies favorites, recents, and transparency", async () => {
    const events = createEvents();
    await renderHarness(events);
    const trigger = container.querySelector<HTMLButtonElement>(
      ".board-color-control__trigger",
    );
    expect(trigger?.getAttribute("aria-label")).toContain("#17212B");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    await openControl();
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(document.activeElement).toBe(dialog);
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(dialog?.querySelector(".board-color-picker")).not.toBeNull();
    expect(dialog?.querySelector('input[type="color"]')).toBeNull();

    const red = container.querySelector<HTMLButtonElement>(
      '[data-color-slot-id="red"] .board-color-control__favorite',
    );
    await act(async () => red?.click());
    expect(events.apply).toHaveBeenLastCalledWith("#d33f49");
    expect(red?.getAttribute("aria-pressed")).toBe("true");

    const recent = container.querySelector<HTMLButtonElement>(
      '[aria-label="Выбрать недавний цвет #ABCDEF"]',
    );
    expect(recent).not.toBeNull();
    await act(async () => recent?.click());
    expect(events.apply).toHaveBeenLastCalledWith("#abcdef");

    const transparent = container.querySelector<HTMLButtonElement>(
      ".board-color-control__transparent",
    );
    await act(async () => transparent?.click());
    expect(events.apply).toHaveBeenLastCalledWith(BOARD_COLOR_TRANSPARENT);
    expect(transparent?.getAttribute("aria-pressed")).toBe("true");
  });

  it("scrolls favorites horizontally from vertical mouse-wheel and horizontal trackpad input", async () => {
    const events = createEvents();
    await renderHarness(events);
    await openControl();
    const strip = container.querySelector<HTMLElement>(
      ".board-color-control__favorites",
    );
    const favorite = strip?.querySelector<HTMLButtonElement>(
      ".board-color-control__favorite",
    );
    if (!strip || !favorite) throw new Error("Favorite color strip not rendered");
    setHorizontalScrollGeometry(strip, { scrollLeft: 100 });
    const propagated = vi.fn();
    document.addEventListener("wheel", propagated);
    try {
      const vertical = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 48,
      });
      await act(async () => favorite.dispatchEvent(vertical));
      expect(strip.scrollLeft).toBe(148);
      expect(vertical.defaultPrevented).toBe(true);
      expect(propagated).not.toHaveBeenCalled();

      const horizontal = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaX: 60,
        deltaY: 8,
      });
      await act(async () => favorite.dispatchEvent(horizontal));
      expect(strip.scrollLeft).toBe(208);
      expect(horizontal.defaultPrevented).toBe(true);
      expect(propagated).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("wheel", propagated);
    }
    expectNoColorCallbacks(events);
  });

  it("normalizes line and page wheel input and clamps both scroll boundaries", async () => {
    const events = createEvents();
    await renderHarness(events);
    await openControl();
    const strip = container.querySelector<HTMLElement>(
      ".board-color-control__favorites",
    );
    const favorite = strip?.querySelector<HTMLButtonElement>(
      ".board-color-control__favorite",
    );
    if (!strip || !favorite) throw new Error("Favorite color strip not rendered");
    setHorizontalScrollGeometry(strip, { scrollLeft: 100 });

    const line = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      deltaY: 2,
    });
    await act(async () => favorite.dispatchEvent(line));
    expect(strip.scrollLeft).toBe(164);
    expect(line.defaultPrevented).toBe(true);

    const page = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PAGE,
      deltaY: 1,
    });
    await act(async () => favorite.dispatchEvent(page));
    expect(strip.scrollLeft).toBe(284);
    expect(page.defaultPrevented).toBe(true);

    const pastMaximum = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 1_000,
    });
    await act(async () => favorite.dispatchEvent(pastMaximum));
    expect(strip.scrollLeft).toBe(380);
    expect(pastMaximum.defaultPrevented).toBe(true);

    strip.scrollLeft = 20;
    const pastMinimum = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -1_000,
    });
    await act(async () => favorite.dispatchEvent(pastMinimum));
    expect(strip.scrollLeft).toBe(0);
    expect(pastMinimum.defaultPrevented).toBe(true);
    expectNoColorCallbacks(events);
  });

  it("contains no-overflow and boundary wheel events without cancelling their default", async () => {
    const events = createEvents();
    await renderHarness(events);
    await openControl();
    const strip = container.querySelector<HTMLElement>(
      ".board-color-control__favorites",
    );
    const favorite = strip?.querySelector<HTMLButtonElement>(
      ".board-color-control__favorite",
    );
    if (!strip || !favorite) throw new Error("Favorite color strip not rendered");
    const propagated = vi.fn();
    document.addEventListener("wheel", propagated);
    try {
      setHorizontalScrollGeometry(strip, {
        clientWidth: 120,
        scrollWidth: 120,
      });
      const noOverflow = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 40,
      });
      await act(async () => favorite.dispatchEvent(noOverflow));
      expect(strip.scrollLeft).toBe(0);
      expect(noOverflow.defaultPrevented).toBe(false);
      expect(propagated).not.toHaveBeenCalled();

      setHorizontalScrollGeometry(strip, { scrollLeft: 380 });
      const atBoundary = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 40,
      });
      await act(async () => favorite.dispatchEvent(atBoundary));
      expect(strip.scrollLeft).toBe(380);
      expect(atBoundary.defaultPrevented).toBe(false);
      expect(propagated).not.toHaveBeenCalled();

      const zero = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
      });
      await act(async () => favorite.dispatchEvent(zero));
      expect(zero.defaultPrevented).toBe(false);
      expect(propagated).toHaveBeenCalledOnce();
    } finally {
      document.removeEventListener("wheel", propagated);
    }
    expectNoColorCallbacks(events);
  });

  it("consumes browser pinch and active palette-reorder wheel without scrolling", async () => {
    const events = createEvents();
    await renderHarness(events);
    await openControl();
    const strip = container.querySelector<HTMLElement>(
      ".board-color-control__favorites",
    );
    const favorite = strip?.querySelector<HTMLButtonElement>(
      ".board-color-control__favorite",
    );
    if (!strip || !favorite) throw new Error("Favorite color strip not rendered");
    setHorizontalScrollGeometry(strip, { scrollLeft: 100 });
    const propagated = vi.fn();
    document.addEventListener("wheel", propagated);
    try {
      for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
        const pinch = new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaX: 12,
          deltaY: -30,
          ...modifier,
        });
        await act(async () => favorite.dispatchEvent(pinch));
        expect(strip.scrollLeft).toBe(100);
        expect(pinch.defaultPrevented).toBe(true);
        expect(propagated).not.toHaveBeenCalled();
      }

      await act(async () => container.querySelector<HTMLButtonElement>(
        ".board-color-control__palette-toggle",
      )?.click());
      await act(async () => favorite.dispatchEvent(pointerEvent(
        "pointerdown",
        { x: 16, pointerId: 31 },
      )));
      const duringReorder = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 50,
      });
      await act(async () => favorite.dispatchEvent(duringReorder));
      expect(strip.scrollLeft).toBe(100);
      expect(duringReorder.defaultPrevented).toBe(true);
      expect(propagated).not.toHaveBeenCalled();
      await act(async () => favorite.dispatchEvent(pointerEvent(
        "pointercancel",
        { x: 16, pointerId: 31 },
      )));
    } finally {
      document.removeEventListener("wheel", propagated);
    }
    expectNoColorCallbacks(events);
  });

  it("gives the recent-colors row the same horizontal wheel behavior", async () => {
    const events = createEvents();
    const recentColors = [
      "#000001",
      "#000002",
      "#000003",
      "#000004",
      "#000005",
      "#000006",
      "#000007",
      "#000008",
    ];
    await renderHarness(events, { recentColors });
    await openControl();
    const strip = container.querySelector<HTMLElement>(
      ".board-color-control__recents",
    );
    const recent = strip?.querySelector<HTMLButtonElement>(
      ".board-color-control__recent",
    );
    if (!strip || !recent) throw new Error("Recent color strip not rendered");
    setHorizontalScrollGeometry(strip, {
      clientWidth: 100,
      scrollWidth: 300,
    });
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 64,
    });
    await act(async () => recent.dispatchEvent(wheel));
    expect(strip.scrollLeft).toBe(64);
    expect(wheel.defaultPrevented).toBe(true);
    expectNoColorCallbacks(events);
  });

  it("keeps mixed state explicit and commits only valid six-digit HEX input", async () => {
    const events = createEvents();
    await renderHarness(events, { mixed: true });
    expect(container.querySelector<HTMLButtonElement>(
      ".board-color-control__trigger",
    )?.getAttribute("aria-label")).toContain("смешанные значения");
    await openControl();
    expect(container.querySelector(".board-color-control__mixed-note"))
      .not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLElement>(
        ".board-color-picker__preview",
      )?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      }));
    });
    const input = container.querySelector<HTMLInputElement>(
      '[aria-label="Цвет в формате HEX"]',
    );
    if (!input) throw new Error("HEX input not rendered");

    await act(async () => {
      setInputValue(input, "#12");
      input.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }));
    });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(events.apply).not.toHaveBeenCalled();

    await act(async () => setInputValue(input, "#12AbEf"));
    expect(input.getAttribute("aria-invalid")).toBe("false");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }));
      input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    });
    expect(events.apply).toHaveBeenCalledOnce();
    expect(events.apply).toHaveBeenCalledWith("#12abef");
  });

  it("groups SV and hue pointer previews into one commit per gesture", async () => {
    const events = createEvents();
    await renderHarness(events);
    await openControl();
    const sv = container.querySelector<HTMLElement>(
      ".board-color-picker__sv",
    );
    if (!sv) throw new Error("Saturation/value picker not rendered");
    vi.spyOn(sv, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      toJSON: () => ({}),
    });

    await act(async () => {
      sv.dispatchEvent(pointerEvent("pointerdown", {
        x: 0,
        y: 0,
        pointerId: 11,
      }));
      sv.dispatchEvent(pointerEvent("pointermove", {
        x: 100,
        y: 50,
        pointerId: 11,
      }));
      flushAnimationFrames();
    });
    expect(events.continuousStart).toHaveBeenCalledOnce();
    expect(events.continuousEnd).not.toHaveBeenCalled();
    expect(events.commit).not.toHaveBeenCalled();
    expect(events.apply).toHaveBeenLastCalledWith("#004080");

    await act(async () => {
      sv.dispatchEvent(pointerEvent("pointerup", {
        x: 100,
        y: 0,
        pointerId: 11,
      }));
    });
    expect(events.apply).toHaveBeenLastCalledWith("#0080ff");
    expect(events.commit).toHaveBeenCalledOnce();
    expect(events.commit).toHaveBeenLastCalledWith("#0080ff");
    expect(events.continuousEnd).toHaveBeenCalledOnce();

    const hue = container.querySelector<HTMLInputElement>(
      ".board-color-picker__hue",
    );
    if (!hue) throw new Error("Hue picker not rendered");
    await act(async () => {
      hue.dispatchEvent(pointerEvent("pointerdown", {
        x: 50,
        pointerId: 12,
      }));
      setInputValue(hue, "120");
      flushAnimationFrames();
    });
    expect(events.continuousStart).toHaveBeenCalledTimes(2);
    expect(events.continuousEnd).toHaveBeenCalledOnce();
    expect(events.commit).toHaveBeenCalledOnce();
    expect(events.apply).toHaveBeenLastCalledWith("#00ff00");

    await act(async () => {
      hue.dispatchEvent(pointerEvent("pointerup", {
        x: 50,
        pointerId: 12,
      }));
    });
    expect(events.continuousEnd).toHaveBeenCalledTimes(2);
    expect(events.commit).toHaveBeenCalledTimes(2);
    expect(events.commit).toHaveBeenLastCalledWith("#00ff00");
  });

  it("edits, adds, deletes, and keyboard-reorders stable palette slots without applying them", async () => {
    const events = createEvents();
    await renderHarness(events);
    await openControl();
    const editToggle = container.querySelector<HTMLButtonElement>(
      ".board-color-control__palette-toggle",
    );
    await act(async () => editToggle?.click());
    expect(editToggle?.getAttribute("aria-pressed")).toBe("true");

    const red = container.querySelector<HTMLButtonElement>(
      '[data-color-slot-id="red"] .board-color-control__favorite',
    );
    await act(async () => red?.click());
    expect(events.apply).not.toHaveBeenCalled();
    expect(red?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      container.querySelector<HTMLElement>(
        ".board-color-picker__preview",
      )?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      }));
    });
    const hex = container.querySelector<HTMLInputElement>(
      '[aria-label="Цвет в формате HEX"]',
    );
    if (!hex) throw new Error("HEX input not rendered");
    await act(async () => {
      setInputValue(hex, "#aabbcc");
      hex.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }));
    });
    expect(events.change).toHaveBeenLastCalledWith("red", "#aabbcc");
    expect(container.querySelector('input[type="color"]')).toBeNull();

    await act(async () => {
      red?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        altKey: true,
        key: "ArrowRight",
      }));
    });
    expect(events.move).toHaveBeenLastCalledWith("red", 2);
    expect(slotOrder(container)).toEqual(["graphite", "blue", "red"]);

    const add = container.querySelector<HTMLButtonElement>(
      ".board-color-control__add",
    );
    await act(async () => add?.click());
    expect(events.add).toHaveBeenCalledWith("#aabbcc", "custom-4");
    expect(container.querySelector('[data-color-slot-id="custom-4"]'))
      .not.toBeNull();

    const remove = container.querySelector<HTMLButtonElement>(
      '[data-color-slot-id="blue"] .board-color-control__delete',
    );
    await act(async () => remove?.click());
    expect(events.remove).toHaveBeenCalledWith("blue");
    expect(container.querySelector('[data-color-slot-id="blue"]')).toBeNull();
    expect(events.apply).not.toHaveBeenCalled();
  });

  it("previews and commits mouse reorder once while suppressing the trailing click", async () => {
    const events = createEvents();
    await renderHarness(events);
    await openControl();
    await act(async () => container.querySelector<HTMLButtonElement>(
      ".board-color-control__palette-toggle",
    )?.click());
    const buttons = slotButtons(container);
    buttons.forEach((button, index) => {
      vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
        x: index * 40,
        y: 0,
        left: index * 40,
        top: 0,
        right: index * 40 + 32,
        bottom: 32,
        width: 32,
        height: 32,
        toJSON: () => ({}),
      });
    });

    await act(async () => {
      buttons[0].dispatchEvent(pointerEvent("pointerdown", { x: 16 }));
      buttons[0].dispatchEvent(pointerEvent("pointermove", { x: 104 }));
      flushAnimationFrames();
    });
    const graphiteSlot = container.querySelector<HTMLElement>(
      '[data-color-slot-id="graphite"]',
    );
    expect(graphiteSlot?.classList.contains("is-dragging")).toBe(true);
    expect(graphiteSlot?.style.getPropertyValue("--board-color-drag-x"))
      .toBe("88px");

    await act(async () => {
      buttons[0].dispatchEvent(pointerEvent("pointerup", { x: 104 }));
      buttons[0].click();
    });
    expect(events.move).toHaveBeenCalledOnce();
    expect(events.move).toHaveBeenCalledWith("graphite", 2);
    expect(events.apply).not.toHaveBeenCalled();
    expect(slotOrder(container)).toEqual(["red", "blue", "graphite"]);
  });

  it("requires a touch hold before reorder and treats pre-hold movement as scrolling", async () => {
    vi.useFakeTimers();
    const events = createEvents();
    await renderHarness(events);
    await openControl();
    await act(async () => container.querySelector<HTMLButtonElement>(
      ".board-color-control__palette-toggle",
    )?.click());
    let buttons = slotButtons(container);
    buttons.forEach((button, index) => {
      vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
        x: index * 40,
        y: 0,
        left: index * 40,
        top: 0,
        right: index * 40 + 32,
        bottom: 32,
        width: 32,
        height: 32,
        toJSON: () => ({}),
      });
    });

    await act(async () => {
      buttons[0].dispatchEvent(pointerEvent("pointerdown", {
        x: 16,
        pointerType: "touch",
      }));
      buttons[0].dispatchEvent(pointerEvent("pointermove", {
        x: 70,
        pointerType: "touch",
      }));
      vi.advanceTimersByTime(300);
      buttons[0].dispatchEvent(pointerEvent("pointerup", {
        x: 70,
        pointerType: "touch",
      }));
    });
    expect(events.move).not.toHaveBeenCalled();

    buttons = slotButtons(container);
    await act(async () => {
      buttons[0].dispatchEvent(pointerEvent("pointerdown", {
        x: 16,
        pointerId: 2,
        pointerType: "touch",
      }));
      vi.advanceTimersByTime(240);
      buttons[0].dispatchEvent(pointerEvent("pointermove", {
        x: 104,
        pointerId: 2,
        pointerType: "touch",
      }));
      flushAnimationFrames();
      buttons[0].dispatchEvent(pointerEvent("pointerup", {
        x: 104,
        pointerId: 2,
        pointerType: "touch",
      }));
    });
    expect(events.move).toHaveBeenCalledWith("graphite", 2);
  });

  it("closes on Escape or outside pointer-down and restores focus only for the explicit close path", async () => {
    const events = createEvents();
    await renderHarness(events);
    const trigger = await openControl();
    const preview = container.querySelector<HTMLButtonElement>(
      ".board-color-picker__preview",
    );
    await act(async () => {
      preview?.focus();
      preview?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
      }));
    });
    const formatInput = container.querySelector<HTMLInputElement>(
      '[aria-label="Цвет в формате HEX"]',
    );
    expect(formatInput).not.toBeNull();
    await act(async () => {
      formatInput?.dispatchEvent(pointerEvent("pointerdown", { x: 20 }));
      formatInput?.focus();
    });
    expect(container.querySelector(".board-color-control__popover"))
      .not.toBeNull();
    await act(async () => {
      formatInput?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
    });
    expect(container.querySelector(".board-color-picker__formats")).toBeNull();
    expect(container.querySelector(".board-color-control__popover"))
      .not.toBeNull();
    expect(document.activeElement).toBe(preview);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
      flushAnimationFrames();
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await openControl();
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    await act(async () => {
      outside.dispatchEvent(pointerEvent("pointerdown", { x: 400 }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("leaves palette configuration before closing on Escape", async () => {
    const events = createEvents();
    await renderHarness(events);
    const trigger = await openControl();
    const toggle = container.querySelector<HTMLButtonElement>(
      ".board-color-control__palette-toggle",
    )!;
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(toggle);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
      flushAnimationFrames();
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps internal background clicks open and dismisses on outside Tab focus", async () => {
    vi.useFakeTimers();
    const events = createEvents();
    await renderHarness(events);
    await openControl();
    const dialog = container.querySelector<HTMLElement>(
      ".board-color-control__popover",
    );
    const headerTitle = dialog?.querySelector<HTMLElement>("header strong");
    const close = dialog?.querySelector<HTMLButtonElement>(
      ".board-color-control__close",
    );
    if (!dialog || !headerTitle || !close) {
      throw new Error("Color dialog structure not rendered");
    }

    close.focus();
    await act(async () => {
      headerTitle.dispatchEvent(pointerEvent("pointerdown", { x: 20 }));
      document.body.dispatchEvent(new FocusEvent("focusin", {
        bubbles: true,
        relatedTarget: close,
      }));
    });
    expect(container.querySelector(".board-color-control__popover"))
      .not.toBeNull();

    await act(async () => {
      dialog.dispatchEvent(pointerEvent("pointerdown", { x: 160, y: 300 }));
      document.body.dispatchEvent(new FocusEvent("focusin", {
        bubbles: true,
        relatedTarget: close,
      }));
    });
    expect(container.querySelector(".board-color-control__popover"))
      .not.toBeNull();

    await act(async () => vi.runOnlyPendingTimers());
    const outside = document.createElement("button");
    document.body.append(outside);
    close.focus();
    await act(async () => {
      close.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Tab",
      }));
      outside.focus();
    });
    expect(container.querySelector(".board-color-control__popover")).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
