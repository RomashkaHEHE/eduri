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
import { BoardToolbar } from "./BoardToolbar";
import {
  defaultBoardToolbarPreferences,
  type BoardToolbarPreferences,
} from "./toolbarPreferences";
import type { BoardModifierHintAction, BoardTool } from "./rendering/types";

interface Events {
  readonly chooseTool: Mock;
  readonly changePreferences: Mock;
}

interface HarnessProps {
  readonly events: Events;
  readonly initialPreferences?: BoardToolbarPreferences;
  readonly initialTool?: BoardTool;
  readonly penLaserActive?: boolean;
  readonly modifierHints?: readonly BoardModifierHintAction[];
  readonly readOnly?: boolean;
  readonly imageAvailable?: boolean;
}

function Harness({
  events,
  initialPreferences = defaultBoardToolbarPreferences(),
  initialTool = "select",
  penLaserActive = false,
  modifierHints = [],
  readOnly = false,
  imageAvailable = true,
}: HarnessProps) {
  const [activeTool, setActiveTool] = useState(initialTool);
  const [preferences, setPreferences] = useState(initialPreferences);
  return (
    <BoardToolbar
      activeTool={activeTool}
      penLaserActive={penLaserActive}
      modifierHints={modifierHints}
      readOnly={readOnly}
      imageAvailable={imageAvailable}
      preferences={preferences}
      chooseTool={(tool) => {
        events.chooseTool(tool);
        setActiveTool(tool);
      }}
      changePreferences={(next) => {
        events.changePreferences(next);
        setPreferences(next);
      }}
    />
  );
}

function createEvents(): Events {
  return {
    chooseTool: vi.fn(),
    changePreferences: vi.fn(),
  };
}

function button(selector: string): HTMLButtonElement {
  const value = container.querySelector<HTMLButtonElement>(selector);
  if (!value) throw new Error(`Missing button: ${selector}`);
  return value;
}

function toolbarItemOrder(): string[] {
  const toolbar = container.querySelector<HTMLElement>('[role="toolbar"]');
  if (!toolbar) throw new Error("Toolbar missing");
  return [...toolbar.children]
    .map((child) => (child as HTMLElement).dataset.toolbarItem)
    .filter((item): item is string => Boolean(item));
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => target.click());
}

async function openOverflow(): Promise<HTMLDivElement> {
  await click(button('[aria-label="Ещё инструменты"]'));
  const menu = container.querySelector<HTMLDivElement>(
    '[data-toolbar-menu="overflow"]',
  );
  if (!menu) throw new Error("Overflow menu missing");
  return menu;
}

async function openConfiguration(): Promise<HTMLElement> {
  await openOverflow();
  await click(button('[data-toolbar-action="configure"]'));
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("Configuration dialog missing");
  return dialog;
}

let container: HTMLDivElement;
let root: Root;

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

async function renderHarness(props: HarnessProps): Promise<void> {
  await act(async () => root.render(<Harness {...props} />));
}

describe("BoardToolbar", () => {
  it("renders only the contextual modifier hints supplied for the current gesture", async () => {
    const events = createEvents();
    await renderHarness({
      events,
      modifierHints: ["pen-move", "pen-straight"],
    });

    const hints = container.querySelector<HTMLElement>(".board-modifier-hints");
    expect(hints?.getAttribute("aria-label")).toBe(
      "Доступные модификаторы инструмента",
    );
    expect([
      ...container.querySelectorAll<HTMLElement>(".board-modifier-hints__item"),
    ].map((item) => item.textContent)).toEqual([
      "Ctrlдвигать штрих",
      "Shiftпрямая линия",
    ]);
  });

  it("leaves the hint area empty when the current state has no modifiers", async () => {
    await renderHarness({ events: createEvents() });
    expect(container.querySelector(".board-modifier-hints")).toBeNull();
  });

  it("keeps Select first and renders default visible and overflow items", async () => {
    const events = createEvents();
    await renderHarness({ events });

    expect(toolbarItemOrder()).toEqual([
      "select",
      "pen",
      "eraser",
      "text",
      "line",
      "arrow",
      "shapes",
    ]);
    expect(button('[data-toolbar-item="select"] .board-toolbar__shortcut')
      .textContent).toBe("1");
    expect(button('[data-toolbar-item="pen"] .board-toolbar__shortcut')
      .textContent).toBe("2");
    expect(button('[data-toolbar-item="line"] .board-toolbar__shortcut')
      .textContent).toBe("5");
    expect(button('[data-toolbar-item="shapes"] .board-toolbar__shortcut')
      .textContent).toBe("7");

    const overflow = await openOverflow();
    expect([...overflow.querySelectorAll<HTMLElement>("[data-overflow-item]")]
      .map((item) => item.dataset.overflowItem)).toEqual([
      "code",
      "latex",
      "image",
    ]);
    expect(overflow.getAttribute("role")).toBe("menu");
    expect(document.activeElement).toBe(
      overflow.querySelector('[role="menuitem"]:not(:disabled)'),
    );

    await click(button('[data-overflow-item="code"]'));
    const overflowTrigger = button('[aria-label="Ещё инструменты"]');
    expect(overflowTrigger.classList.contains("is-active")).toBe(true);
    expect(overflowTrigger.getAttribute("aria-pressed")).toBe("true");
    const reopened = await openOverflow();
    expect(reopened.querySelector('[data-overflow-item="code"]')
      ?.getAttribute("aria-current")).toBe("true");
  });

  it("raises only the overflow menu above other board popups", async () => {
    const events = createEvents();
    await renderHarness({ events });
    const toolbar = container.querySelector<HTMLElement>('[role="toolbar"]');
    if (!toolbar) throw new Error("Toolbar missing");

    expect(toolbar.classList.contains("board-toolbar--overflow-open")).toBe(false);
    await openOverflow();
    expect(toolbar.classList.contains("board-toolbar--overflow-open")).toBe(true);

    await click(button('[aria-label="Ещё инструменты"]'));
    expect(toolbar.classList.contains("board-toolbar--overflow-open")).toBe(false);
  });

  it("uses preference order and treats placement entries as ordinary tools", async () => {
    const events = createEvents();
    const initialPreferences: BoardToolbarPreferences = {
      order: [
        "image",
        "code",
        "shapes",
        "pen",
        "eraser",
        "text",
        "line",
        "arrow",
        "latex",
      ],
      visible: ["image", "code", "shapes"],
    };
    await renderHarness({ events, initialPreferences });

    expect(toolbarItemOrder()).toEqual([
      "select",
      "image",
      "code",
      "shapes",
    ]);
    await click(button('[data-toolbar-item="image"]'));
    expect(events.chooseTool).toHaveBeenLastCalledWith("image");
    await click(button('[data-toolbar-item="code"]'));
    expect(events.chooseTool).toHaveBeenLastCalledWith("code");
  });

  it("presents Drawing as the latched laser without changing its tool identity", async () => {
    const events = createEvents();
    await renderHarness({
      events,
      initialTool: "pen",
      penLaserActive: true,
    });

    const pen = button('[data-toolbar-item="pen"]');
    expect(pen.dataset.toolbarTool).toBe("pen");
    expect(pen.getAttribute("aria-label")).toBe("Лазерная указка");
    expect(pen.getAttribute("aria-pressed")).toBe("true");
    expect(pen.getAttribute("aria-keyshortcuts")?.split(" "))
      .toEqual(["P", "2"]);
    expect(pen.querySelector(".lucide-mouse-pointer-click")).not.toBeNull();
    expect(pen.querySelector(".board-toolbar__shortcut")?.textContent).toBe("2");

    await click(button('[data-toolbar-item="eraser"]'));
    expect(pen.getAttribute("aria-label")).toBe("Рисование");
    expect(pen.querySelector(".lucide-pencil")).not.toBeNull();

    const dialog = await openConfiguration();
    const penRow = dialog.querySelector<HTMLElement>(
      '[data-toolbar-config-item="pen"]',
    );
    expect(penRow?.textContent).toContain("Рисование");
    expect(penRow?.querySelector(".lucide-pencil")).not.toBeNull();
    expect(dialog.querySelector('[data-toolbar-config-item="laser"]')).toBeNull();
  });

  it("uses one Shapes button without a shape dropdown", async () => {
    const events = createEvents();
    await renderHarness({ events });

    const shape = button('[data-toolbar-item="shapes"]');
    expect(shape.dataset.toolbarTool).toBe("shape");
    expect(shape.getAttribute("aria-label")).toBe("Форма");
    expect(shape.getAttribute("aria-keyshortcuts")?.split(" "))
      .toEqual(["R", "7"]);
    expect(shape.querySelector(".board-toolbar__shortcut")?.textContent)
      .toBe("7");
    expect(container.querySelector('[aria-label="Выбрать фигуру"]')).toBeNull();
    expect(container.querySelector('[data-toolbar-menu="shapes"]')).toBeNull();

    await click(shape);
    expect(events.chooseTool).toHaveBeenLastCalledWith("shape");
    expect(shape.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders hidden Shapes as one ordinary overflow row", async () => {
    const events = createEvents();
    const initialPreferences: BoardToolbarPreferences = {
      ...defaultBoardToolbarPreferences(),
      visible: ["pen", "eraser", "text", "line", "arrow"],
    };
    await renderHarness({ events, initialPreferences });

    const overflow = await openOverflow();
    const shapeRows = overflow.querySelectorAll<HTMLElement>(
      '[data-overflow-item="shapes"]',
    );
    expect(shapeRows).toHaveLength(1);
    expect(shapeRows[0].dataset.toolbarTool).toBe("shape");
    expect(shapeRows[0].textContent).toContain("Форма");
    expect(shapeRows[0].querySelector("kbd")?.textContent).toBe("7");
    expect(overflow.querySelector('[aria-label="Выбрать другую фигуру"]'))
      .toBeNull();

    await click(shapeRows[0]);
    expect(events.chooseTool).toHaveBeenLastCalledWith("shape");
  });

  it("keeps unavailable Image and editing tools disabled in read-only mode", async () => {
    const events = createEvents();
    await renderHarness({ events, readOnly: true, imageAvailable: false });

    expect(button('[data-toolbar-item="select"]').disabled).toBe(false);
    expect(button('[data-toolbar-item="pen"]').disabled).toBe(false);
    const overflow = await openOverflow();
    expect(overflow.querySelector<HTMLButtonElement>('[data-overflow-item="code"]')
      ?.disabled).toBe(true);
    expect(overflow.querySelector<HTMLButtonElement>('[data-overflow-item="image"]')
      ?.disabled).toBe(true);
  });

  it("toggles visibility immediately and keeps fixed Select locked", async () => {
    const events = createEvents();
    await renderHarness({ events });
    const dialog = await openConfiguration();
    const rows = [...dialog.querySelectorAll<HTMLElement>(
      "[data-toolbar-config-item]",
    )];
    expect(rows[0].dataset.toolbarConfigItem).toBe("select");
    expect(rows[0].draggable).toBe(false);
    expect(rows[0].querySelector<HTMLInputElement>('input[type="checkbox"]')
      ?.disabled).toBe(true);

    const codeToggle = dialog.querySelector<HTMLInputElement>(
      '[aria-label="Показывать инструмент Код"]',
    );
    if (!codeToggle) throw new Error("Code visibility toggle missing");
    await click(codeToggle);
    expect(events.changePreferences).toHaveBeenLastCalledWith(expect.objectContaining({
      visible: ["pen", "eraser", "text", "line", "arrow", "shapes", "code"],
    }));
    expect(container.querySelector('[role="toolbar"] [data-toolbar-item="code"]'))
      .not.toBeNull();
  });

  it("reorders with buttons, Alt+Arrow keys, and HTML drag/drop", async () => {
    const events = createEvents();
    await renderHarness({ events });
    await openConfiguration();

    await click(button('[aria-label="Переместить Рисование вниз"]'));
    expect(events.changePreferences).toHaveBeenLastCalledWith(expect.objectContaining({
      order: [
        "eraser",
        "pen",
        "text",
        "line",
        "arrow",
        "shapes",
        "code",
        "latex",
        "image",
      ],
    }));

    const penRow = container.querySelector<HTMLElement>(
      '[data-toolbar-config-item="pen"]',
    );
    if (!penRow) throw new Error("Pen row missing");
    await act(async () => penRow.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      altKey: true,
      key: "ArrowUp",
    })));
    expect(events.changePreferences).toHaveBeenLastCalledWith(expect.objectContaining({
      order: defaultBoardToolbarPreferences().order,
    }));

    const source = container.querySelector<HTMLElement>(
      '[data-toolbar-config-item="image"]',
    );
    const target = container.querySelector<HTMLElement>(
      '[data-toolbar-config-item="pen"]',
    );
    if (!source || !target) throw new Error("Drag rows missing");
    await act(async () => source.dispatchEvent(new Event("dragstart", {
      bubbles: true,
      cancelable: true,
    })));
    await act(async () => target.dispatchEvent(new Event("drop", {
      bubbles: true,
      cancelable: true,
    })));
    expect(events.changePreferences).toHaveBeenLastCalledWith(expect.objectContaining({
      order: [
        "image",
        "pen",
        "eraser",
        "text",
        "line",
        "arrow",
        "shapes",
        "code",
        "latex",
      ],
    }));
  });

  it("resets defaults without a Save step", async () => {
    const events = createEvents();
    const custom: BoardToolbarPreferences = {
      order: [
        "image",
        "latex",
        "code",
        "shapes",
        "arrow",
        "line",
        "text",
        "eraser",
        "pen",
      ],
      visible: ["image", "latex"],
    };
    await renderHarness({ events, initialPreferences: custom });
    await openConfiguration();
    await click(button('[data-toolbar-action="reset"]'));

    expect(events.changePreferences).toHaveBeenLastCalledWith(
      defaultBoardToolbarPreferences(),
    );
    expect(toolbarItemOrder()).toEqual([
      "select",
      "pen",
      "eraser",
      "text",
      "line",
      "arrow",
      "shapes",
    ]);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("dismisses menus and the dialog with Escape or outside press and restores focus", async () => {
    const events = createEvents();
    await renderHarness({ events });
    const overflowTrigger = button('[aria-label="Ещё инструменты"]');

    let overflow = await openOverflow();
    await act(async () => {
      overflow.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-toolbar-menu="overflow"]')).toBeNull();
    expect(document.activeElement).toBe(overflowTrigger);

    overflow = await openOverflow();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-toolbar-menu="overflow"]')).toBeNull();
    expect(document.activeElement).toBe(overflowTrigger);

    await openConfiguration();
    expect(document.activeElement).toBe(button(
      '[aria-label="Закрыть настройку панели"]',
    ));
    const escapedToWindow = vi.fn();
    window.addEventListener("keydown", escapedToWindow);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
      await Promise.resolve();
    });
    window.removeEventListener("keydown", escapedToWindow);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(overflowTrigger);
    expect(escapedToWindow).not.toHaveBeenCalled();
  });
});
