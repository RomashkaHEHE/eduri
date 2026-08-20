// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardStrokeWidthControl } from "./BoardStrokeWidthControl";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("BoardStrokeWidthControl", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("gives common thin widths progressive stops and retains exact px input", async () => {
    const change = vi.fn();
    await act(async () => root.render(createElement(BoardStrokeWidthControl, {
      value: 2,
      min: 0.5,
      max: 96,
      onChange: change,
    })));

    const slider = container.querySelector<HTMLInputElement>(
      '.board-stroke-width__slider[aria-label="Толщина линии"]',
    );
    expect(slider?.getAttribute("aria-valuemin")).toBe("0.5");
    expect(slider?.getAttribute("aria-valuemax")).toBe("96");
    expect(slider?.getAttribute("aria-valuenow")).toBe("2");
    expect(slider?.style.getPropertyValue("--board-stroke-width-progress"))
      .toBe("");

    await act(async () => {
      if (!slider) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        ?.set?.call(slider, "9");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(change).toHaveBeenLastCalledWith(8);

    const exact = container.querySelector<HTMLInputElement>(
      '[aria-label="Точная толщина линии"]',
    );
    await act(async () => {
      if (!exact) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        ?.set?.call(exact, "7.5");
      exact.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(change).toHaveBeenLastCalledWith(7.5);
  });
});
