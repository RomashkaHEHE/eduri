// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CodeSyncIndicator,
  type CodeSyncIndicatorProps,
} from "./CodeSyncIndicator.js";

const ONLINE_STATUS: CodeSyncIndicatorProps = {
  connection: "online",
  durability: "ready",
  pendingUpdates: 0,
  error: null,
  readOnly: false,
};

let container: HTMLDivElement;
let root: Root;
let workspace: HTMLDivElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  workspace = document.createElement("div");
  workspace.className = "full-code-workspace";
  workspace.append(container);
  document.body.append(workspace);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  workspace.remove();
});

async function renderIndicator(status: CodeSyncIndicatorProps): Promise<void> {
  await act(async () => {
    root.render(createElement(CodeSyncIndicator, status));
  });
}

function indicator(): HTMLDivElement {
  const value = container.querySelector<HTMLDivElement>(".code-sync-indicator");
  if (!value) throw new Error("Code sync indicator was not rendered");
  return value;
}

function trigger(): HTMLButtonElement {
  const value = container.querySelector<HTMLButtonElement>(
    ".code-sync-indicator__trigger",
  );
  if (!value) throw new Error("Code sync trigger was not rendered");
  return value;
}

function pointerEvent(
  type: string,
  pointerType: "mouse" | "touch",
  relatedTarget: EventTarget | null = null,
): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    relatedTarget,
  });
  Object.defineProperty(event, "pointerType", {
    configurable: true,
    value: pointerType,
  });
  return event as PointerEvent;
}

describe("CodeSyncIndicator", () => {
  it("opens on hover or focus and dismisses with pointer leave or Escape", async () => {
    await renderIndicator(ONLINE_STATUS);
    const rootElement = indicator();
    const button = trigger();

    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.hasAttribute("aria-controls")).toBe(false);
    expect(container.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => {
      rootElement.dispatchEvent(pointerEvent("pointerover", "mouse", document.body));
    });
    const hoveredPopup = container.querySelector<HTMLElement>('[role="tooltip"]');
    expect(hoveredPopup).not.toBeNull();
    expect(rootElement.dataset.popupPlacement).toBe("below");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe(hoveredPopup?.id);
    expect(button.getAttribute("aria-describedby")).toBe(hoveredPopup?.id);

    await act(async () => {
      rootElement.dispatchEvent(pointerEvent("pointerout", "mouse", document.body));
    });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(rootElement.hasAttribute("data-popup-placement")).toBe(false);
    expect(container.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => button.focus());
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[role="tooltip"]')).not.toBeNull();

    const escape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    await act(async () => button.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.hasAttribute("aria-controls")).toBe(false);
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("keeps bounded details keyboard-scrollable and returns focus on Escape", async () => {
    await renderIndicator(ONLINE_STATUS);
    const button = trigger();

    await act(async () => button.focus());
    const popup = container.querySelector<HTMLElement>('[role="tooltip"]');
    if (!popup) throw new Error("Code sync popup was not rendered");
    expect(popup.tabIndex).toBe(0);

    await act(async () => popup.focus());
    expect(document.activeElement).toBe(popup);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    const arrowDown = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowDown",
    });
    await act(async () => popup.dispatchEvent(arrowDown));
    expect(arrowDown.defaultPrevented).toBe(true);
    expect(popup.scrollTop).toBe(32);

    await act(async () => {
      popup.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
    });
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("updates pending and error details without remounting an open indicator", async () => {
    await renderIndicator(ONLINE_STATUS);
    const rootBefore = indicator();
    const triggerBefore = trigger();
    await act(async () => {
      rootBefore.dispatchEvent(pointerEvent("pointerover", "mouse", document.body));
    });
    const popupBefore = container.querySelector<HTMLElement>('[role="tooltip"]');
    const popupId = popupBefore?.id;
    expect(popupBefore).not.toBeNull();

    await renderIndicator({
      connection: "error",
      durability: "at-risk",
      pendingUpdates: 127,
      error: "IndexedDB недоступен",
      readOnly: true,
    });

    const popupAfter = container.querySelector<HTMLElement>('[role="tooltip"]');
    expect(indicator()).toBe(rootBefore);
    expect(trigger()).toBe(triggerBefore);
    expect(popupAfter).toBe(popupBefore);
    expect(popupAfter?.id).toBe(popupId);
    expect(triggerBefore.getAttribute("aria-expanded")).toBe("true");
    expect(triggerBefore.getAttribute("aria-controls")).toBe(popupId);
    expect(indicator().dataset.state).toBe("error");
    expect(container.querySelector(".code-sync-indicator__count")?.textContent)
      .toBe("99+");
    expect(popupAfter?.textContent).toContain("Ошибка синхронизации");
    expect(popupAfter?.textContent).toContain("Локальное сохранение недоступно");
    expect(popupAfter?.textContent).toContain("127");
    expect(popupAfter?.textContent).toContain("Только чтение");
    expect(popupAfter?.textContent).toContain("Общий терминалНедоступен");
    expect(popupAfter?.textContent).toContain("IndexedDB недоступен");
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toBe("IndexedDB недоступен");
  });

  it("reports an error even while transport and local durability remain ready", async () => {
    await renderIndicator({
      ...ONLINE_STATUS,
      error: "Сервер отклонил обновление",
    });

    expect(indicator().dataset.state).toBe("error");
    expect(trigger().getAttribute("aria-label"))
      .toContain("Синхронизация недоступна");

    await act(async () => {
      indicator().dispatchEvent(pointerEvent("pointerover", "mouse", document.body));
    });
    expect(container.querySelector('[role="tooltip"]')?.textContent)
      .toContain("Синхронизация недоступна");
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toBe("Сервер отклонил обновление");
  });

  it("does not pin hover details with an ordinary mouse click", async () => {
    await renderIndicator(ONLINE_STATUS);
    const rootElement = indicator();
    const button = trigger();

    await act(async () => {
      rootElement.dispatchEvent(pointerEvent("pointerover", "mouse", document.body));
      button.dispatchEvent(pointerEvent("pointerdown", "mouse"));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      rootElement.dispatchEvent(pointerEvent("pointerout", "mouse", document.body));
    });

    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("pins and unpins details with a touch click without hover", async () => {
    await renderIndicator({
      ...ONLINE_STATUS,
      connection: "offline",
      pendingUpdates: 2,
    });
    const rootElement = indicator();
    const button = trigger();

    await act(async () => {
      rootElement.dispatchEvent(pointerEvent("pointerover", "touch", document.body));
    });
    expect(container.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => {
      button.dispatchEvent(pointerEvent("pointerdown", "touch"));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[role="tooltip"]')?.textContent)
      .toContain("Ожидают подтверждения2");

    await act(async () => {
      rootElement.dispatchEvent(pointerEvent("pointerout", "touch", document.body));
    });
    expect(button.getAttribute("aria-expanded")).toBe("true");

    await act(async () => {
      button.dispatchEvent(pointerEvent("pointerdown", "touch"));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("opens upward and scrolls within a short workspace", async () => {
    await renderIndicator(ONLINE_STATUS);
    const rootElement = indicator();
    rootElement.getBoundingClientRect = () => ({
      x: 258,
      y: 100,
      top: 100,
      right: 300,
      bottom: 132,
      left: 258,
      width: 42,
      height: 32,
      toJSON: () => undefined,
    });
    workspace.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      right: 320,
      bottom: 200,
      left: 0,
      width: 320,
      height: 200,
      toJSON: () => undefined,
    });

    await act(async () => {
      rootElement.dispatchEvent(pointerEvent("pointerover", "mouse", document.body));
    });
    const popup = container.querySelector<HTMLElement>('[role="tooltip"]');
    if (!popup) throw new Error("Code sync popup was not rendered");
    Object.defineProperty(popup, "scrollHeight", {
      configurable: true,
      value: 180,
    });

    await act(async () => window.dispatchEvent(new Event("resize")));

    expect(popup.dataset.placement).toBe("above");
    expect(rootElement.dataset.popupPlacement).toBe("above");
    expect(rootElement.style.getPropertyValue("--code-sync-popup-max-height")).toBe("85px");
    expect(rootElement.style.getPropertyValue("--code-sync-popup-width")).toBe("300px");
    expect(rootElement.style.getPropertyValue("--code-sync-popup-right-offset")).toBe("-8px");
  });
});
