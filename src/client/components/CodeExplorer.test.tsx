// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeWorkspaceEntrySnapshot } from "../../code/core";
import { CodeExplorer } from "./CodeExplorer.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const entries: readonly CodeWorkspaceEntrySnapshot[] = [
  {
    id: "src-folder",
    kind: "folder",
    parentId: null,
    name: "src",
    rank: "a",
    text: null,
    contentKind: null,
    blob: null,
  },
  {
    id: "nested-py",
    kind: "file",
    parentId: "src-folder",
    name: "nested.py",
    rank: "a",
    text: "pass\n",
    contentKind: "text",
    blob: null,
  },
  {
    id: "main-py",
    kind: "file",
    parentId: null,
    name: "main.py",
    rank: "b",
    text: "pass\n",
    contentKind: "text",
    blob: null,
  },
  {
    id: "empty-folder",
    kind: "folder",
    parentId: null,
    name: "empty",
    rank: "c",
    text: null,
    contentKind: null,
    blob: null,
  },
];

const callbacks = () => ({
  onSelect: vi.fn(),
  onBeginRename: vi.fn(),
  onRenameValueChange: vi.fn(),
  onCommitRename: vi.fn(),
  onCancelRename: vi.fn(),
  onCreate: vi.fn(),
  onUpload: vi.fn(),
  onDuplicate: vi.fn(),
  onDelete: vi.fn(),
  onMove: vi.fn(),
  onUndo: vi.fn(),
  onRedo: vi.fn(),
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function renderExplorer(
  handlers: ReturnType<typeof callbacks>,
  readOnly = false,
): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(CodeExplorer, {
      entries,
      activeId: "main-py",
      readOnly,
      renamingId: null,
      renameValue: "",
      ...handlers,
    }));
    await Promise.resolve();
  });
}

function buttonNamed(name: string): HTMLButtonElement | undefined {
  return [...container!.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === name);
}

function contextMenu(target: Element): void {
  target.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 50,
  }));
}

function menuAction(name: string): HTMLButtonElement | undefined {
  return [...container!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent?.trim() === name);
}

function dataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "uninitialized",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: (format?: string) => {
      if (format) values.delete(format);
      else values.clear();
    },
    getData: (format: string) => values.get(format) ?? "",
    setData: (format: string, value: string) => {
      values.set(format, value);
    },
    setDragImage: () => undefined,
  };
}

function drag(target: Element, type: string, transfer: DataTransfer): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  target.dispatchEvent(event);
}

describe("CodeExplorer", () => {
  it("expands and collapses folders with pointer and arrow controls", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers);

    const folderButton = buttonNamed("src");
    expect(folderButton).toBeDefined();
    expect(buttonNamed("nested.py")).toBeDefined();
    expect(folderButton?.closest('[role="treeitem"]')?.getAttribute("aria-expanded"))
      .toBe("true");
    const folderIcon = folderButton?.querySelector(".code-tree-entry__icon")
      ?.innerHTML;
    expect(folderIcon).toContain("lucide-folder");
    expect(folderIcon).not.toContain("folder-open");

    await act(async () => {
      folderButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(buttonNamed("nested.py")).toBeUndefined();
    expect(folderButton?.closest('[role="treeitem"]')?.getAttribute("aria-expanded"))
      .toBe("false");
    expect(folderButton?.querySelector(".code-tree-entry__icon")?.innerHTML)
      .toBe(folderIcon);

    await act(async () => {
      folderButton?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
      }));
      await Promise.resolve();
    });
    expect(buttonNamed("nested.py")).toBeDefined();

    await act(async () => {
      folderButton?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        bubbles: true,
      }));
      await Promise.resolve();
    });
    expect(buttonNamed("nested.py")).toBeUndefined();
  });

  it("renders empty folders without disclosure controls", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers);

    const emptyButton = buttonNamed("empty");
    const emptyRow = emptyButton?.closest('[role="treeitem"]');
    expect(emptyRow?.hasAttribute("aria-expanded")).toBe(false);
    expect(emptyButton?.querySelector(".code-tree-entry__chevron svg")).toBeNull();

    await act(async () => {
      emptyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      emptyButton?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        bubbles: true,
      }));
      await Promise.resolve();
    });
    expect(handlers.onSelect).toHaveBeenCalledWith("empty-folder");
    expect(emptyRow?.hasAttribute("aria-expanded")).toBe(false);
  });

  it("keeps create, rename, and delete actions inside the context menu", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers);

    await act(async () => contextMenu(
      buttonNamed("nested.py")!.closest('[role="treeitem"]')!,
    ));
    expect(handlers.onSelect).toHaveBeenCalledWith("nested-py");
    await act(async () => {
      menuAction("Переименовать")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(handlers.onBeginRename).toHaveBeenCalledWith(entries[1]);

    await act(async () => contextMenu(
      buttonNamed("nested.py")!.closest('[role="treeitem"]')!,
    ));
    await act(async () => {
      menuAction("Дублировать")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(handlers.onDuplicate).toHaveBeenCalledWith(entries[1]);

    const rootMenu = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Меню проводника"]',
    );
    await act(async () => {
      rootMenu?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      menuAction("Создать файл")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(handlers.onCreate).toHaveBeenCalledWith("file", null);

    await act(async () => contextMenu(
      buttonNamed("src")!.closest('[role="treeitem"]')!,
    ));
    await act(async () => {
      menuAction("Создать папку")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(handlers.onCreate).toHaveBeenCalledWith("folder", "src-folder");

    await act(async () => contextMenu(
      buttonNamed("nested.py")!.closest('[role="treeitem"]')!,
    ));
    await act(async () => {
      menuAction("Удалить")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(handlers.onDelete).toHaveBeenCalledWith(entries[1]);
  });

  it("routes local undo and redo shortcuts while Explorer owns focus", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers);
    const fileButton = buttonNamed("main.py")!;

    await act(async () => {
      fileButton.dispatchEvent(new KeyboardEvent("keydown", {
        key: "я",
        code: "KeyZ",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
      fileButton.dispatchEvent(new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
      fileButton.dispatchEvent(new KeyboardEvent("keydown", {
        key: "y",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(handlers.onUndo).toHaveBeenCalledTimes(1);
    expect(handlers.onRedo).toHaveBeenCalledTimes(2);
  });

  it("moves entries by dropping on a folder or the explorer root", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers);
    const mainRow = buttonNamed("main.py")!.closest('[role="treeitem"]')!;
    const nestedRow = buttonNamed("nested.py")!.closest('[role="treeitem"]')!;
    const folderRow = buttonNamed("src")!.closest('[role="treeitem"]')!;
    const tree = container!.querySelector('[role="tree"]')!;

    const intoFolder = dataTransfer();
    await act(async () => {
      drag(mainRow, "dragstart", intoFolder);
      drag(folderRow, "dragover", intoFolder);
      drag(folderRow, "drop", intoFolder);
    });
    expect(handlers.onMove).toHaveBeenCalledWith("main-py", "src-folder");

    const toRoot = dataTransfer();
    await act(async () => {
      drag(nestedRow, "dragstart", toRoot);
      drag(tree, "dragover", toRoot);
      drag(tree, "drop", toRoot);
    });
    expect(handlers.onMove).toHaveBeenCalledWith("nested-py", null);

    const ontoFile = dataTransfer();
    await act(async () => {
      drag(nestedRow, "dragstart", ontoFile);
      drag(mainRow, "drop", ontoFile);
    });
    expect(handlers.onMove).toHaveBeenCalledTimes(2);
  });

  it("keeps Explorer mutation actions and dragging disabled when read-only", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, true);
    const folderRow = buttonNamed("src")!.closest<HTMLElement>('[role="treeitem"]')!;
    expect(folderRow.draggable).toBe(false);

    await act(async () => contextMenu(folderRow));
    const actions = [
      ...container!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    expect(actions.length).toBeGreaterThan(3);
    expect(actions.every((button) => button.disabled)).toBe(true);

    await act(async () => {
      buttonNamed("main.py")?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(handlers.onUndo).not.toHaveBeenCalled();
  });
});
