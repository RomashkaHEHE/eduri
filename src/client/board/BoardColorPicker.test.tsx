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
import { BoardColorPicker } from "./BoardColorPicker";

interface PickerEvents {
  readonly preview: Mock;
  readonly commit: Mock;
  readonly gestureStart: Mock;
  readonly gestureEnd: Mock;
  readonly alphaPreview: Mock;
  readonly alphaCommit: Mock;
}

function createEvents(): PickerEvents {
  return {
    preview: vi.fn(),
    commit: vi.fn(),
    gestureStart: vi.fn(),
    gestureEnd: vi.fn(),
    alphaPreview: vi.fn(),
    alphaCommit: vi.fn(),
  };
}

function Harness({
  events,
  initialColor = "#ff0000",
  initialAlpha,
}: {
  readonly events: PickerEvents;
  readonly initialColor?: string;
  readonly initialAlpha?: number;
}) {
  const [color, setColor] = useState(initialColor);
  const [alpha, setAlpha] = useState(initialAlpha ?? 1);
  return (
    <BoardColorPicker
      value={color}
      label="Цвет"
      onPreview={(next) => {
        events.preview(next);
        setColor(next);
      }}
      onCommit={events.commit}
      onGestureStart={events.gestureStart}
      onGestureEnd={events.gestureEnd}
      alpha={initialAlpha === undefined ? undefined : {
        value: alpha,
        onPreview: (next) => {
          events.alphaPreview(next);
          setAlpha(next);
        },
        onCommit: events.alphaCommit,
      }}
    />
  );
}

function pointerEvent(
  type: string,
  options: {
    readonly x: number;
    readonly y?: number;
    readonly pointerId?: number;
  },
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: options.x,
    clientY: options.y ?? 0,
  });
  Object.defineProperties(event, {
    pointerId: { value: options.pointerId ?? 1 },
    pointerType: { value: "mouse" },
    isPrimary: { value: true },
  });
  return event;
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

function pickerPlane(container: HTMLElement): HTMLDivElement {
  const plane = container.querySelector<HTMLDivElement>(
    ".board-color-picker__sv",
  );
  if (!plane) throw new Error("SV picker not rendered");
  vi.spyOn(plane, "getBoundingClientRect").mockReturnValue({
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
  return plane;
}

function setCaptureBehavior(
  element: HTMLElement,
  mode: "throw" | "not-held" | "held",
): Mock {
  const setPointerCapture = vi.fn(() => {
    if (mode === "throw") throw new Error("capture unavailable");
  });
  Object.defineProperties(element, {
    setPointerCapture: { configurable: true, value: setPointerCapture },
    hasPointerCapture: {
      configurable: true,
      value: vi.fn(() => mode === "held"),
    },
  });
  return setPointerCapture;
}

function setElementRect(
  element: HTMLElement,
  width = 100,
  height = 30,
  left = 0,
  top = 0,
): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  });
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderPicker(
  events: PickerEvents,
  options: { readonly initialColor?: string; readonly initialAlpha?: number } = {},
): Promise<void> {
  await act(async () => root.render(
    <Harness
      events={events}
      initialColor={options.initialColor}
      initialAlpha={options.initialAlpha}
    />,
  ));
}

describe("BoardColorPicker", () => {
  it("exposes saturation and brightness as separate accessible axes", async () => {
    const events = createEvents();
    await renderPicker(events);
    const plane = pickerPlane(container);
    const axes = [...plane.querySelectorAll<HTMLInputElement>(
      ".board-color-picker__axis",
    )];

    expect(plane.getAttribute("role")).toBe("group");
    expect(plane.getAttribute("aria-valuenow")).toBeNull();
    expect(axes.map((axis) => axis.getAttribute("aria-label")))
      .toEqual(["Насыщенность", "Яркость"]);
    expect(axes.map((axis) => axis.type)).toEqual(["range", "range"]);
    expect(axes.map((axis) => axis.value)).toEqual(["100", "100"]);
    const helpId = axes[0].getAttribute("aria-describedby");
    expect(helpId).not.toBeNull();
    expect(axes[1].getAttribute("aria-describedby")).toBe(helpId);
    expect(document.getElementById(helpId!)?.textContent).toContain("Shift");
  });

  it("keeps an accessible axis keyboard adjustment in one gesture", async () => {
    const events = createEvents();
    await renderPicker(events);
    const saturation = container.querySelector<HTMLInputElement>(
      '.board-color-picker__axis[aria-label="Насыщенность"]',
    );
    if (!saturation) throw new Error("Saturation axis not rendered");

    await act(async () => {
      saturation.focus();
      saturation.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowLeft",
        shiftKey: true,
      }));
      flushAnimationFrames();
      saturation.dispatchEvent(new KeyboardEvent("keyup", {
        bubbles: true,
        cancelable: true,
        key: "ArrowLeft",
        shiftKey: true,
      }));
    });

    expect(events.preview).toHaveBeenLastCalledWith("#ff1919");
    expect(events.commit).toHaveBeenCalledOnce();
    expect(events.commit).toHaveBeenLastCalledWith("#ff1919");
    expect(events.gestureStart).toHaveBeenCalledOnce();
    expect(events.gestureEnd).toHaveBeenCalledOnce();
  });

  it("handles hue keyboard bounds and autorepeat as one gesture", async () => {
    const events = createEvents();
    await renderPicker(events, { initialColor: "#2563eb" });
    const hue = container.querySelector<HTMLInputElement>(
      ".board-color-picker__hue",
    );
    if (!hue) throw new Error("Hue slider not rendered");

    await act(async () => {
      hue.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Home",
      }));
      flushAnimationFrames();
      hue.dispatchEvent(new KeyboardEvent("keyup", {
        bubbles: true,
        cancelable: true,
        key: "Home",
      }));
    });
    expect(hue.value).toBe("0");
    expect(events.preview).toHaveBeenLastCalledWith("#eb2525");
    expect(events.commit).toHaveBeenLastCalledWith("#eb2525");

    events.preview.mockClear();
    events.commit.mockClear();
    events.gestureStart.mockClear();
    events.gestureEnd.mockClear();

    await act(async () => {
      for (let index = 0; index < 3; index += 1) {
        hue.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "ArrowRight",
          repeat: index > 0,
        }));
      }
      flushAnimationFrames();
      hue.dispatchEvent(new KeyboardEvent("keyup", {
        bubbles: true,
        cancelable: true,
        key: "ArrowRight",
      }));
    });
    expect(hue.value).toBe("3");
    expect(events.preview).toHaveBeenCalledOnce();
    expect(events.commit).toHaveBeenCalledOnce();
    expect(events.gestureStart).toHaveBeenCalledOnce();
    expect(events.gestureEnd).toHaveBeenCalledOnce();
  });

  it("applies hue page keys and commits unowned changes discretely", async () => {
    const events = createEvents();
    await renderPicker(events, { initialColor: "#00ff00" });
    const hue = container.querySelector<HTMLInputElement>(
      ".board-color-picker__hue",
    );
    if (!hue) throw new Error("Hue slider not rendered");

    await act(async () => {
      hue.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "PageDown",
      }));
      flushAnimationFrames();
      hue.dispatchEvent(new KeyboardEvent("keyup", {
        bubbles: true,
        cancelable: true,
        key: "PageDown",
      }));
    });
    expect(hue.value).toBe("110");

    await act(async () => {
      hue.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "PageUp",
      }));
      flushAnimationFrames();
      hue.dispatchEvent(new KeyboardEvent("keyup", {
        bubbles: true,
        cancelable: true,
        key: "PageUp",
      }));
    });
    expect(hue.value).toBe("120");

    await act(async () => setInputValue(hue, "240"));
    expect(events.commit).toHaveBeenLastCalledWith("#0000ff");
    expect(events.gestureStart).toHaveBeenCalledTimes(3);
    expect(events.gestureEnd).toHaveBeenCalledTimes(3);
    expect(events.commit).toHaveBeenCalledTimes(3);
  });

  it.each(["throw", "not-held"] as const)(
    "continues and finishes an SV drag through window when capture is %s",
    async (captureMode) => {
      const events = createEvents();
      await renderPicker(events);
      const plane = pickerPlane(container);
      const setPointerCapture = setCaptureBehavior(plane, captureMode);

      await act(async () => {
        plane.dispatchEvent(pointerEvent("pointerdown", {
          x: 0,
          y: 0,
          pointerId: 17,
        }));
        flushAnimationFrames();
        window.dispatchEvent(pointerEvent("pointermove", {
          x: 100,
          y: 50,
          pointerId: 17,
        }));
        flushAnimationFrames();
      });
      expect(setPointerCapture).toHaveBeenCalledWith(17);
      expect(events.preview).toHaveBeenLastCalledWith("#800000");

      await act(async () => {
        window.dispatchEvent(pointerEvent("pointerup", {
          x: 100,
          y: 100,
          pointerId: 17,
        }));
      });
      expect(events.commit).toHaveBeenCalledOnce();
      expect(events.commit).toHaveBeenLastCalledWith("#000000");
      expect(events.gestureStart).toHaveBeenCalledOnce();
      expect(events.gestureEnd).toHaveBeenCalledOnce();

      const previewCount = events.preview.mock.calls.length;
      await act(async () => {
        window.dispatchEvent(pointerEvent("pointermove", {
          x: 0,
          y: 0,
          pointerId: 17,
        }));
        flushAnimationFrames();
      });
      expect(events.preview).toHaveBeenCalledTimes(previewCount);
    },
  );

  it("falls back to window events if an established SV capture is lost", async () => {
    const events = createEvents();
    await renderPicker(events);
    const plane = pickerPlane(container);
    setCaptureBehavior(plane, "held");

    await act(async () => {
      plane.dispatchEvent(pointerEvent("pointerdown", {
        x: 0,
        y: 0,
        pointerId: 21,
      }));
      plane.dispatchEvent(pointerEvent("lostpointercapture", {
        x: 0,
        y: 0,
        pointerId: 21,
      }));
      window.dispatchEvent(pointerEvent("pointermove", {
        x: 100,
        y: 50,
        pointerId: 21,
      }));
      flushAnimationFrames();
      window.dispatchEvent(pointerEvent("pointerup", {
        x: 100,
        y: 50,
        pointerId: 21,
      }));
    });

    expect(events.commit).toHaveBeenCalledOnce();
    expect(events.commit).toHaveBeenLastCalledWith("#800000");
    expect(events.gestureEnd).toHaveBeenCalledOnce();
  });

  it("does not install or duplicate the window fallback while capture holds", async () => {
    const events = createEvents();
    await renderPicker(events);
    const plane = pickerPlane(container);
    setCaptureBehavior(plane, "held");
    const addEventListener = vi.spyOn(window, "addEventListener");

    await act(async () => {
      plane.dispatchEvent(pointerEvent("pointerdown", {
        x: 0,
        y: 0,
        pointerId: 25,
      }));
      flushAnimationFrames();
    });
    expect(addEventListener.mock.calls.filter(([type]) => type === "pointermove"))
      .toHaveLength(0);

    const previewCount = events.preview.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(pointerEvent("pointermove", {
        x: 100,
        y: 100,
        pointerId: 25,
      }));
      flushAnimationFrames();
    });
    expect(events.preview).toHaveBeenCalledTimes(previewCount);

    await act(async () => {
      plane.dispatchEvent(pointerEvent("pointermove", {
        x: 100,
        y: 50,
        pointerId: 25,
      }));
      flushAnimationFrames();
      plane.dispatchEvent(pointerEvent("pointerup", {
        x: 100,
        y: 50,
        pointerId: 25,
      }));
    });
    expect(events.commit).toHaveBeenCalledOnce();
    expect(events.commit).toHaveBeenLastCalledWith("#800000");
    expect(events.gestureEnd).toHaveBeenCalledOnce();
  });

  it("cancels and removes an active window fallback on pointercancel", async () => {
    const events = createEvents();
    await renderPicker(events);
    const plane = pickerPlane(container);
    setCaptureBehavior(plane, "throw");

    await act(async () => {
      plane.dispatchEvent(pointerEvent("pointerdown", {
        x: 0,
        y: 0,
        pointerId: 29,
      }));
      window.dispatchEvent(pointerEvent("pointercancel", {
        x: 50,
        y: 50,
        pointerId: 29,
      }));
    });
    expect(events.commit).not.toHaveBeenCalled();
    expect(events.gestureEnd).toHaveBeenCalledOnce();

    const previewCount = events.preview.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(pointerEvent("pointermove", {
        x: 100,
        y: 50,
        pointerId: 29,
      }));
      flushAnimationFrames();
    });
    expect(events.preview).toHaveBeenCalledTimes(previewCount);
  });

  it.each(["throw", "not-held"] as const)(
    "continues and commits a hue rail drag outside when capture is %s",
    async (captureMode) => {
      const events = createEvents();
      await renderPicker(events);
      const hue = container.querySelector<HTMLInputElement>(
        ".board-color-picker__hue",
      );
      if (!hue) throw new Error("Hue rail not rendered");
      setElementRect(hue);
      const setPointerCapture = setCaptureBehavior(hue, captureMode);

      await act(async () => {
        hue.dispatchEvent(pointerEvent("pointerdown", {
          x: 0,
          pointerId: 31,
        }));
        window.dispatchEvent(pointerEvent("pointermove", {
          x: 50,
          pointerId: 31,
        }));
        flushAnimationFrames();
      });
      expect(setPointerCapture).toHaveBeenCalledWith(31);
      expect(events.preview).toHaveBeenLastCalledWith("#00ffff");

      await act(async () => {
        window.dispatchEvent(pointerEvent("pointerup", {
          x: 50,
          pointerId: 31,
        }));
      });
      expect(events.commit).toHaveBeenCalledOnce();
      expect(events.commit).toHaveBeenLastCalledWith("#00ffff");
      expect(events.gestureStart).toHaveBeenCalledOnce();
      expect(events.gestureEnd).toHaveBeenCalledOnce();

      const previewCount = events.preview.mock.calls.length;
      await act(async () => {
        window.dispatchEvent(pointerEvent("pointermove", {
          x: 0,
          pointerId: 31,
        }));
        flushAnimationFrames();
      });
      expect(events.preview).toHaveBeenCalledTimes(previewCount);
    },
  );

  it("falls back after lost hue capture and cancels an outside alpha drag cleanly", async () => {
    const events = createEvents();
    await renderPicker(events, { initialAlpha: 0.8 });
    const hue = container.querySelector<HTMLInputElement>(
      ".board-color-picker__hue",
    );
    const alpha = container.querySelector<HTMLInputElement>(
      ".board-color-picker__alpha",
    );
    if (!hue || !alpha) throw new Error("Picker rails not rendered");
    setElementRect(hue);
    setCaptureBehavior(hue, "held");

    await act(async () => {
      hue.dispatchEvent(pointerEvent("pointerdown", {
        x: 0,
        pointerId: 33,
      }));
      hue.dispatchEvent(pointerEvent("lostpointercapture", {
        x: 0,
        pointerId: 33,
      }));
      window.dispatchEvent(pointerEvent("pointerup", {
        x: 50,
        pointerId: 33,
      }));
    });
    expect(events.commit).toHaveBeenLastCalledWith("#00ffff");

    setElementRect(alpha);
    setCaptureBehavior(alpha, "throw");
    await act(async () => {
      alpha.dispatchEvent(pointerEvent("pointerdown", {
        x: 20,
        pointerId: 35,
      }));
      window.dispatchEvent(pointerEvent("pointermove", {
        x: 75,
        pointerId: 35,
      }));
      flushAnimationFrames();
    });
    expect(events.alphaPreview).toHaveBeenLastCalledWith(0.25);

    await act(async () => {
      window.dispatchEvent(pointerEvent("pointercancel", {
        x: 75,
        pointerId: 35,
      }));
    });
    expect(events.alphaCommit).not.toHaveBeenCalled();
    expect(events.gestureStart).toHaveBeenCalledTimes(2);
    expect(events.gestureEnd).toHaveBeenCalledTimes(2);

    const previewCount = events.alphaPreview.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(pointerEvent("pointermove", {
        x: 0,
        pointerId: 35,
      }));
      flushAnimationFrames();
    });
    expect(events.alphaPreview).toHaveBeenCalledTimes(previewCount);
  });

  it("keeps hue authoritative across multi-frame SV previews and controlled echoes", async () => {
    const events = createEvents();
    await renderPicker(events, { initialColor: "#00a6ff" });
    const plane = pickerPlane(container);
    setCaptureBehavior(plane, "held");
    const hue = container.querySelector<HTMLInputElement>(
      ".board-color-picker__hue",
    );
    const picker = container.querySelector<HTMLElement>(".board-color-picker");
    if (!hue || !picker) throw new Error("Picker controls not rendered");

    await act(async () => {
      plane.dispatchEvent(pointerEvent("pointerdown", {
        x: 1,
        y: 20,
        pointerId: 41,
      }));
      flushAnimationFrames();
    });
    const firstGradient = picker.style.getPropertyValue(
      "--board-picker-hue-gradient",
    );
    expect(hue.value).toBe("201");

    await act(async () => {
      plane.dispatchEvent(pointerEvent("pointermove", {
        x: 60,
        y: 20,
        pointerId: 41,
      }));
      flushAnimationFrames();
    });
    expect(hue.value).toBe("201");
    expect(events.preview).toHaveBeenLastCalledWith("#52a1cc");
    expect(picker.style.getPropertyValue("--board-picker-hue-gradient"))
      .not.toBe(firstGradient);

    await act(async () => {
      plane.dispatchEvent(pointerEvent("pointerup", {
        x: 60,
        y: 20,
        pointerId: 41,
      }));
    });
    expect(events.commit).toHaveBeenCalledOnce();
    expect(events.commit).toHaveBeenLastCalledWith("#52a1cc");
  });

  it("retains hue and the exact saturation coordinate at zero value", async () => {
    const events = createEvents();
    await renderPicker(events, { initialColor: "#00a6ff" });
    const plane = pickerPlane(container);
    setCaptureBehavior(plane, "held");
    const hue = container.querySelector<HTMLInputElement>(
      ".board-color-picker__hue",
    );
    const picker = container.querySelector<HTMLElement>(".board-color-picker");
    if (!hue || !picker) throw new Error("Picker controls not rendered");

    await act(async () => {
      plane.dispatchEvent(pointerEvent("pointerdown", {
        x: 80,
        y: 100,
        pointerId: 43,
      }));
      flushAnimationFrames();
    });
    expect(events.preview).toHaveBeenLastCalledWith("#000000");
    expect(hue.value).toBe("201");
    expect(picker.style.getPropertyValue("--board-picker-saturation"))
      .toBe("80%");

    const previewCount = events.preview.mock.calls.length;
    await act(async () => {
      plane.dispatchEvent(pointerEvent("pointermove", {
        x: 20,
        y: 100,
        pointerId: 43,
      }));
      flushAnimationFrames();
    });
    expect(events.preview).toHaveBeenCalledTimes(previewCount);
    expect(hue.value).toBe("201");
    expect(picker.style.getPropertyValue("--board-picker-saturation"))
      .toBe("20%");

    await act(async () => {
      plane.dispatchEvent(pointerEvent("pointercancel", {
        x: 20,
        y: 100,
        pointerId: 43,
      }));
    });
    expect(events.commit).not.toHaveBeenCalled();
  });

  it("coalesces visual and callback SV previews to the latest animation frame", async () => {
    const events = createEvents();
    await renderPicker(events, { initialColor: "#00a6ff" });
    const plane = pickerPlane(container);
    setCaptureBehavior(plane, "held");

    await act(async () => {
      plane.dispatchEvent(pointerEvent("pointerdown", {
        x: 10,
        y: 10,
        pointerId: 47,
      }));
      plane.dispatchEvent(pointerEvent("pointermove", {
        x: 30,
        y: 30,
        pointerId: 47,
      }));
      plane.dispatchEvent(pointerEvent("pointermove", {
        x: 60,
        y: 20,
        pointerId: 47,
      }));
    });
    expect(events.preview).not.toHaveBeenCalled();

    await act(async () => flushAnimationFrames());
    expect(events.preview).toHaveBeenCalledOnce();
    expect(events.preview).toHaveBeenLastCalledWith("#52a1cc");

    await act(async () => {
      plane.dispatchEvent(pointerEvent("pointerup", {
        x: 60,
        y: 20,
        pointerId: 47,
      }));
    });
    expect(events.preview).toHaveBeenCalledOnce();
    expect(events.commit).toHaveBeenCalledOnce();
  });

  it("accepts true external color updates while idle", async () => {
    const events = createEvents();
    const renderExternal = async (color: string) => {
      await act(async () => root.render(
        <BoardColorPicker
          value={color}
          label="Цвет"
          onPreview={events.preview}
          onCommit={events.commit}
        />,
      ));
    };
    await renderExternal("#00a6ff");
    const picker = container.querySelector<HTMLElement>(".board-color-picker");
    const hue = container.querySelector<HTMLInputElement>(
      ".board-color-picker__hue",
    );
    if (!picker || !hue) throw new Error("Picker controls not rendered");
    expect(hue.value).toBe("201");

    await renderExternal("#00ff00");
    expect(hue.value).toBe("120");
    expect(picker.style.getPropertyValue("--board-picker-color"))
      .toBe("#00ff00");
    expect(events.preview).not.toHaveBeenCalled();
    expect(events.commit).not.toHaveBeenCalled();
  });

  it("keeps alpha gestures isolated and exposes opacity consistently", async () => {
    const events = createEvents();
    await renderPicker(events, {
      initialColor: "#ff0000",
      initialAlpha: 0.8,
    });
    const alpha = container.querySelector<HTMLInputElement>(
      ".board-color-picker__alpha",
    );
    const hue = container.querySelector<HTMLInputElement>(
      ".board-color-picker__hue",
    );
    if (!alpha || !hue) throw new Error("Picker rails not rendered");
    expect(alpha.value).toBe("0.8");
    expect(alpha.dir).toBe("rtl");
    expect(alpha.getAttribute("aria-valuetext")).toBe("80%");

    await act(async () => {
      alpha.dispatchEvent(pointerEvent("pointerdown", {
        x: 20,
        pointerId: 53,
      }));
      setInputValue(alpha, "0.25");
    });
    expect(events.alphaPreview).not.toHaveBeenCalled();
    await act(async () => flushAnimationFrames());
    expect(events.alphaPreview).toHaveBeenCalledOnce();
    expect(events.alphaPreview).toHaveBeenLastCalledWith(0.25);
    expect(events.preview).not.toHaveBeenCalled();

    await act(async () => {
      alpha.dispatchEvent(pointerEvent("pointerup", {
        x: 70,
        pointerId: 53,
      }));
    });
    expect(events.alphaCommit).toHaveBeenCalledOnce();
    expect(events.alphaCommit).toHaveBeenLastCalledWith(0.25);
    expect(events.commit).not.toHaveBeenCalled();

    await act(async () => {
      hue.dispatchEvent(pointerEvent("pointerdown", {
        x: 50,
        pointerId: 59,
      }));
      setInputValue(hue, "120");
      flushAnimationFrames();
      hue.dispatchEvent(pointerEvent("pointerup", {
        x: 50,
        pointerId: 59,
      }));
    });
    expect(events.preview).toHaveBeenLastCalledWith("#00ff00");
    expect(events.commit).toHaveBeenCalledOnce();
    expect(events.alphaPreview).toHaveBeenCalledOnce();
    expect(events.alphaCommit).toHaveBeenCalledOnce();
  });

  it("uses RTL arrow direction and explicit bounds for alpha keyboard input", async () => {
    const events = createEvents();
    await renderPicker(events, { initialAlpha: 0.5 });
    const alpha = container.querySelector<HTMLInputElement>(
      ".board-color-picker__alpha",
    );
    if (!alpha) throw new Error("Alpha rail not rendered");

    const press = async (key: string) => {
      await act(async () => {
        alpha.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key,
        }));
        flushAnimationFrames();
        alpha.dispatchEvent(new KeyboardEvent("keyup", {
          bubbles: true,
          cancelable: true,
          key,
        }));
      });
    };

    await press("ArrowLeft");
    expect(alpha.value).toBe("0.51");
    expect(events.alphaCommit).toHaveBeenLastCalledWith(0.51);

    await press("ArrowRight");
    expect(alpha.value).toBe("0.5");
    expect(events.alphaCommit).toHaveBeenLastCalledWith(0.5);

    await press("Home");
    expect(alpha.value).toBe("0");
    expect(events.alphaCommit).toHaveBeenLastCalledWith(0);

    await press("End");
    expect(alpha.value).toBe("1");
    expect(events.alphaCommit).toHaveBeenLastCalledWith(1);
  });

  it("flushes alpha preview but does not commit it on blur", async () => {
    const events = createEvents();
    await renderPicker(events, { initialAlpha: 1 });
    const alpha = container.querySelector<HTMLInputElement>(
      ".board-color-picker__alpha",
    );
    if (!alpha) throw new Error("Alpha rail not rendered");

    await act(async () => {
      alpha.dispatchEvent(pointerEvent("pointerdown", {
        x: 10,
        pointerId: 61,
      }));
      setInputValue(alpha, "0.4");
      window.dispatchEvent(new Event("blur"));
    });
    expect(events.alphaPreview).toHaveBeenLastCalledWith(0.4);
    expect(events.alphaCommit).not.toHaveBeenCalled();
    expect(events.gestureEnd).toHaveBeenCalledOnce();
  });

  it("manages advanced-format focus, Escape, controls, and the open marker", async () => {
    const events = createEvents();
    await renderPicker(events);
    const picker = container.querySelector<HTMLElement>(".board-color-picker");
    const preview = container.querySelector<HTMLButtonElement>(
      ".board-color-picker__preview",
    );
    if (!picker || !preview) throw new Error("Picker preview not rendered");
    vi.stubGlobal("innerWidth", 1200);
    vi.stubGlobal("innerHeight", 800);
    setElementRect(picker, 300, 200, 400, 100);
    setElementRect(preview, 28, 28, 410, 250);

    preview.focus();
    await act(async () => {
      preview.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
      }));
    });
    let formats = document.body.querySelector<HTMLElement>(
      ".board-color-picker__formats",
    );
    expect(formats).not.toBeNull();
    expect(container.querySelector(".board-color-picker__formats")).toBeNull();
    expect(formats?.dataset.boardColorFormatsPopup).toBe("true");
    expect(formats?.dataset.positioned).toBe("true");
    expect(formats?.style.left).toBe("106px");
    expect(document.activeElement).toBe(preview);
    expect(picker.dataset.formatsOpen).toBe("true");
    expect(preview.getAttribute("aria-controls")).toBe(formats?.id);

    await act(async () => {
      preview.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
    });
    await act(async () => flushAnimationFrames());
    expect(document.body.querySelector(".board-color-picker__formats")).toBeNull();
    expect(picker.hasAttribute("data-formats-open")).toBe(false);
    expect(preview.getAttribute("aria-controls")).toBeNull();
    expect(document.activeElement).toBe(preview);

    await act(async () => {
      preview.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "F10",
        shiftKey: true,
      }));
    });
    formats = document.body.querySelector<HTMLElement>(
      ".board-color-picker__formats",
    );
    const rgb = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Цвет в формате RGB"]',
    );
    if (!rgb) throw new Error("Keyboard-opened RGB format not rendered");
    expect(formats).not.toBeNull();
    expect(document.activeElement).toBe(rgb);

    await act(async () => setInputValue(rgb, "rgb(0, 255, 0)"));
    await act(async () => {
      rgb.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
    });
    await act(async () => flushAnimationFrames());
    expect(document.body.querySelector(".board-color-picker__formats")).toBeNull();
    expect(document.activeElement).toBe(preview);
    expect(events.preview).not.toHaveBeenCalled();
    expect(events.commit).not.toHaveBeenCalled();
  });

  it("lazily toggles formats on primary click and applies valid Enter once", async () => {
    const events = createEvents();
    const addEventListener = vi.spyOn(document, "addEventListener");
    await renderPicker(events, { initialColor: "#00a6ff" });
    expect(document.body.querySelector(".board-color-picker__formats")).toBeNull();
    expect(addEventListener.mock.calls.filter(([type]) => type === "pointerdown"))
      .toHaveLength(0);
    const preview = container.querySelector<HTMLButtonElement>(
      ".board-color-picker__preview",
    );
    if (!preview) throw new Error("Color preview not rendered");

    await act(async () => {
      preview.dispatchEvent(pointerEvent("pointerdown", { x: 0 }));
      preview.click();
    });
    const formats = document.body.querySelector(".board-color-picker__formats");
    expect(formats).not.toBeNull();
    expect(container.querySelector(".board-color-picker__formats")).toBeNull();
    expect(addEventListener.mock.calls.filter(([type]) => type === "pointerdown"))
      .toHaveLength(1);
    expect([...document.body.querySelectorAll(".board-color-picker__format-row > span")]
      .map((node) => node.textContent)).toEqual(["RGB", "HSV", "HEX"]);

    const hex = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Цвет в формате HEX"]',
    );
    if (!hex) throw new Error("HEX format not rendered");
    await act(async () => setInputValue(hex, "#123456"));
    await act(async () => {
      hex.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }));
    });
    expect(events.preview).toHaveBeenCalledOnce();
    expect(events.preview).toHaveBeenLastCalledWith("#123456");
    expect(events.commit).toHaveBeenCalledOnce();

    await act(async () => {
      hex.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(events.preview).toHaveBeenCalledOnce();
    expect(events.commit).toHaveBeenCalledOnce();

    await act(async () => {
      preview.dispatchEvent(pointerEvent("pointerdown", { x: 0 }));
      preview.click();
    });
    expect(document.body.querySelector(".board-color-picker__formats")).toBeNull();
  });

  it("rejects invalid formats, discards drafts on Escape, and reports copy outcome", async () => {
    const events = createEvents();
    const writeText = vi.fn(() => Promise.resolve());
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await renderPicker(events);
    const preview = container.querySelector<HTMLButtonElement>(
      ".board-color-picker__preview",
    );
    if (!preview) throw new Error("Color preview not rendered");
    await act(async () => {
      preview.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "F10",
        shiftKey: true,
      }));
    });
    const rgb = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Цвет в формате RGB"]',
    );
    if (!rgb) throw new Error("RGB format not rendered");
    await act(async () => setInputValue(rgb, "rgb(999, 0, 0)"));
    await act(async () => {
      rgb.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(rgb.getAttribute("aria-invalid")).toBe("true");
    expect(events.preview).not.toHaveBeenCalled();
    expect(events.commit).not.toHaveBeenCalled();

    const copy = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Скопировать HEX"]',
    );
    const hex = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Цвет в формате HEX"]',
    );
    if (!copy || !hex) throw new Error("HEX copy controls not rendered");
    await act(async () => setInputValue(hex, "#not-a-color"));
    await act(async () => {
      copy.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("#FF0000");
    expect(document.body.querySelector('[role="status"]')?.textContent)
      .toContain("HEX");

    writeText.mockRejectedValueOnce(new Error("Clipboard blocked"));
    await act(async () => {
      copy.click();
      await Promise.resolve();
    });
    expect(document.body.querySelector('[role="alert"]')?.textContent)
      .toContain("Не удалось");

    await act(async () => {
      rgb.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
    });
    expect(document.body.querySelector(".board-color-picker__formats")).toBeNull();
    expect(events.preview).not.toHaveBeenCalled();
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("edits RGBA, HSVA, and step-snapped eight-digit HEX only in the alpha variant", async () => {
    const events = createEvents();
    await renderPicker(events, { initialAlpha: 0.5 });
    const preview = container.querySelector<HTMLButtonElement>(
      ".board-color-picker__preview",
    );
    if (!preview) throw new Error("Color preview not rendered");
    await act(async () => {
      preview.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
      }));
    });
    expect([...document.body.querySelectorAll(".board-color-picker__format-row > span")]
      .map((node) => node.textContent)).toEqual(["RGBA", "HSVA", "HEX"]);
    const hex = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Цвет в формате HEX"]',
    );
    const rgba = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Цвет в формате RGBA"]',
    );
    if (!hex || !rgba) throw new Error("Alpha formats not rendered");
    expect(hex.value).toBe("#FF000080");

    await act(async () => setInputValue(rgba, "rgba(0, 255, 0, 0.255)"));
    await act(async () => {
      rgba.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }));
    });
    expect(events.preview).toHaveBeenLastCalledWith("#00ff00");
    expect(events.alphaPreview).toHaveBeenLastCalledWith(0.26);
    expect(events.commit).toHaveBeenLastCalledWith("#00ff00");
    expect(events.alphaCommit).toHaveBeenLastCalledWith(0.26);
    expect(hex.value).toBe("#00FF0042");

    await act(async () => setInputValue(hex, "#0000ff80"));
    await act(async () => {
      hex.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }));
    });
    expect(events.preview).toHaveBeenLastCalledWith("#0000ff");
    expect(events.alphaPreview).toHaveBeenLastCalledWith(0.5);
    expect(events.commit).toHaveBeenLastCalledWith("#0000ff");
    expect(events.alphaCommit).toHaveBeenLastCalledWith(0.5);
  });
});
