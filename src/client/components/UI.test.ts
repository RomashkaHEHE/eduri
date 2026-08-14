// @vitest-environment jsdom

import {
  act,
  createElement,
  useState,
  type ChangeEvent,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "./UI";

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!setter) throw new Error("HTMLInputElement value setter is unavailable");
  setter.call(input, value);
  input.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    data: value.at(-1) ?? null,
    inputType: "insertText",
  }));
}

describe("Modal focus lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.classList.remove("modal-open");
    vi.restoreAllMocks();
  });

  it("keeps a controlled field focused when an unstable onClose rerenders", async () => {
    const close = vi.fn();

    function Harness() {
      const [value, setValue] = useState("");
      return createElement(
        Modal,
        {
          open: true,
          title: "Редактирование",
          onClose: () => close(value),
        },
        createElement("input", {
          "aria-label": "Название",
          value,
          onChange: (event: ChangeEvent<HTMLInputElement>) =>
            setValue(event.target.value),
        }),
      );
    }

    await act(async () => {
      root.render(createElement(Harness));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const input = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Название"]',
    );
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);

    await act(async () => {
      if (input) setInputValue(input, "а");
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(input?.value).toBe("а");
    expect(document.activeElement).toBe(input);

    await act(async () => {
      if (input) setInputValue(input, "аб");
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(input?.value).toBe("аб");
    expect(document.activeElement).toBe(input);

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        key: "Escape",
      }));
    });
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith("аб");
  });

  it("links its description and keeps a non-dismissible dialog open", async () => {
    const close = vi.fn();
    await act(async () => {
      root.render(createElement(
        Modal,
        {
          open: true,
          title: "Profile",
          description: "Choose a display name",
          dismissible: false,
          onClose: close,
        },
        createElement("input", { "aria-label": "Display Name" }),
      ));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    const descriptionId = dialog?.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId ?? "")?.textContent)
      .toBe("Choose a display name");
    expect(dialog?.querySelector('[aria-label="Закрыть"]')).toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        key: "Escape",
      }));
      document.body.querySelector<HTMLElement>(".modal-backdrop")
        ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(close).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
