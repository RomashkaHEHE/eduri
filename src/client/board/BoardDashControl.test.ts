// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BoardDashControl,
  boardDashValueEquals,
  parseBoardDashPattern,
} from "./BoardDashControl";

const BOARD_CSS = readFileSync(
  resolve(process.cwd(), "src", "client", "styles.css"),
  "utf8",
);

function boardStyleToken(
  selector: ".board-v2" | ".board-v2--dark",
  name: string,
): string {
  const block = [...BOARD_CSS.matchAll(
    /(\.board-v2(?:--dark)?)\s*\{([^}]*)\}/g,
  )].find((match) => match[1] === selector && match[2].includes(name));
  const value = block?.[2].match(new RegExp(
    `${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(#[0-9a-f]{6})`,
    "i",
  ))?.[1];
  if (!value) throw new Error(`${name} is unavailable for ${selector}`);
  return value;
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

let container: HTMLDivElement;
let root: Root;

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!setter) throw new Error("HTMLInputElement value setter unavailable");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("BoardDashControl", () => {
  it("keeps the 10px primary action readable in both Board themes", () => {
    const primaryRule = BOARD_CSS.match(
      /\.board-style-popover > footer button\.is-primary\s*\{([^}]*)\}/,
    )?.[1];
    const primaryHoverRule = BOARD_CSS.match(
      /\.board-style-popover > footer button\.is-primary:hover\s*\{([^}]*)\}/,
    )?.[1];
    const footerRule = BOARD_CSS.match(
      /\.board-style-popover > footer button\s*\{([^}]*)\}/,
    )?.[1];

    expect(footerRule).toContain("font-size: 10px");
    expect(primaryRule).toContain("color: var(--board-style-on-action)");
    expect(primaryRule).toContain("background: var(--board-style-action-bg)");
    expect(primaryHoverRule).toContain(
      "background: var(--board-style-action-hover)",
    );

    for (const selector of [".board-v2", ".board-v2--dark"] as const) {
      const foreground = boardStyleToken(
        selector,
        "--board-style-on-action",
      );
      const backgrounds = [
        boardStyleToken(selector, "--board-style-action-bg"),
        boardStyleToken(selector, "--board-style-action-hover"),
      ];
      for (const background of backgrounds) {
        expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it("parses bounded arbitrary patterns without confusing an empty value", () => {
    expect(parseBoardDashPattern("")).toEqual([]);
    expect(parseBoardDashPattern("12, 4 2; 4")).toEqual([12, 4, 2, 4]);
    expect(parseBoardDashPattern("0, 0")).toEqual([]);
    expect(parseBoardDashPattern("-1, 2")).toBeNull();
    expect(parseBoardDashPattern("257, 2")).toBeNull();
    expect(parseBoardDashPattern("1,2,3,4,5,6,7,8,9")).toBeNull();
    expect(boardDashValueEquals([8, 6], [8, 6])).toBe(true);
    expect(boardDashValueEquals([8, 5], [8, 6])).toBe(false);
  });

  it("applies a custom pattern, rejects invalid input, and restores trigger focus", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(createElement("div", { className: "board-v2" },
        createElement(BoardDashControl, {
          value: [5, 3, 1, 3],
          mixed: false,
          onChange,
        })));
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Свой рисунок штриха"]',
    )!;
    await act(async () => trigger.click());
    const input = container.querySelector<HTMLInputElement>(
      '[aria-label="Длины штрихов и промежутков"]',
    )!;
    expect(document.activeElement).toBe(input);

    await act(async () => {
      setInputValue(input, "bad");
      container.querySelector<HTMLButtonElement>("footer .is-primary")?.click();
    });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => {
      setInputValue(input, "10, 3, 2, 3");
      input.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }));
    });
    expect(onChange).toHaveBeenCalledWith([10, 3, 2, 3]);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps mixed state explicit and supports Escape without applying", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(createElement("div", { className: "board-v2" },
        createElement(BoardDashControl, {
          value: [8, 6],
          mixed: true,
          onChange,
        })));
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Свой рисунок штриха"]',
    )!;
    await act(async () => trigger.click());
    expect(container.querySelector<HTMLInputElement>(
      '[aria-label="Длины штрихов и промежутков"]',
    )?.placeholder).toBe("Смешанное");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("applies solid immediately and closes on outside pointer or focus", async () => {
    const onChange = vi.fn();
    const outside = document.createElement("button");
    outside.textContent = "outside";
    document.body.append(outside);
    await act(async () => {
      root.render(createElement("div", { className: "board-v2" },
        createElement(BoardDashControl, {
          value: [8, 6],
          mixed: false,
          onChange,
        })));
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Свой рисунок штриха"]',
    )!;

    await act(async () => trigger.click());
    await act(async () => {
      container.querySelector<HTMLButtonElement>("footer button")?.click();
    });
    expect(onChange).toHaveBeenCalledWith([]);
    expect(container.querySelector<HTMLInputElement>(
      '[aria-label="Длины штрихов и промежутков"]',
    )?.value).toBe("");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).not.toBe(trigger);

    await act(async () => trigger.click());
    await act(async () => outside.focus());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
