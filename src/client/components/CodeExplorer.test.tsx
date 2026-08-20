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
    id: "nested-folder",
    kind: "folder",
    parentId: "src-folder",
    name: "nested",
    rank: "b",
    text: null,
    contentKind: null,
    blob: null,
  },
  {
    id: "deep-py",
    kind: "file",
    parentId: "nested-folder",
    name: "deep.py",
    rank: "a",
    text: "print('deep')\n",
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
    id: "notes-txt",
    kind: "file",
    parentId: null,
    name: "notes.txt",
    rank: "c",
    text: "notes\n",
    contentKind: "text",
    blob: null,
  },
  {
    id: "empty-folder",
    kind: "folder",
    parentId: null,
    name: "empty",
    rank: "d",
    text: null,
    contentKind: null,
    blob: null,
  },
];

const visibleIds = [
  "src-folder",
  "nested-py",
  "nested-folder",
  "deep-py",
  "main-py",
  "notes-txt",
  "empty-folder",
] as const;

const callbacks = () => ({
  onActivate: vi.fn<(entryId: string) => void>(),
  onBeginRename: vi.fn<(entry: CodeWorkspaceEntrySnapshot) => void>(),
  onRenameValueChange: vi.fn<(value: string) => void>(),
  onCommitRename: vi.fn<() => void>(),
  onCancelRename: vi.fn<() => void>(),
  onCreate: vi.fn<(kind: "file" | "folder", parentId: string | null) => void>(),
  onUpload: vi.fn<(files: FileList | null, parentId: string | null) => void>(),
  onDuplicate: vi.fn<(entry: CodeWorkspaceEntrySnapshot) => void>(),
  onDelete: vi.fn<(entries: readonly CodeWorkspaceEntrySnapshot[]) => void>(),
  onMove: vi.fn<(entryIds: readonly string[], parentId: string | null) => void>(),
  onUndo: vi.fn<() => void>(),
  onRedo: vi.fn<() => void>(),
});

type ExplorerCallbacks = ReturnType<typeof callbacks>;

interface RenderOptions {
  readonly activeId?: string | null;
  readonly entries?: readonly CodeWorkspaceEntrySnapshot[];
  readonly readOnly?: boolean;
  readonly renamingId?: string | null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function renderExplorer(
  handlers: ExplorerCallbacks,
  options: RenderOptions = {},
): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(CodeExplorer, {
      entries: options.entries ?? entries,
      activeId: options.activeId === undefined ? "main-py" : options.activeId,
      readOnly: options.readOnly ?? false,
      renamingId: options.renamingId ?? null,
      renameValue: "",
      ...handlers,
    }));
    await Promise.resolve();
  });
}

function entry(entryId: string): CodeWorkspaceEntrySnapshot {
  const result = entries.find((candidate) => candidate.id === entryId);
  if (!result) throw new Error(`Missing fixture entry: ${entryId}`);
  return result;
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...container!.querySelectorAll<HTMLButtonElement>(
    ".code-tree-entry__main",
  )].find((candidate) => candidate.textContent?.trim() === name);
  if (!button) throw new Error(`Missing Explorer button: ${name}`);
  return button;
}

function rowNamed(name: string): HTMLElement {
  const row = buttonNamed(name).closest<HTMLElement>('[role="treeitem"]');
  if (!row) throw new Error(`Missing Explorer row: ${name}`);
  return row;
}

function selectedNames(): readonly string[] {
  return [...container!.querySelectorAll<HTMLElement>(
    '[role="treeitem"][aria-selected="true"]',
  )].map((row) => row.querySelector<HTMLButtonElement>(
    ".code-tree-entry__main",
  )?.textContent?.trim() ?? "");
}

async function clickEntry(
  name: string,
  modifiers: Pick<MouseEventInit, "ctrlKey" | "metaKey" | "shiftKey"> = {},
): Promise<void> {
  await act(async () => {
    buttonNamed(name).dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ...modifiers,
    }));
    await Promise.resolve();
  });
}

async function pressEntry(
  name: string,
  key: string,
  modifiers: Pick<KeyboardEventInit, "code" | "ctrlKey" | "metaKey" | "shiftKey"> = {},
): Promise<void> {
  await act(async () => {
    const button = buttonNamed(name);
    button.focus();
    button.dispatchEvent(new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    }));
    await Promise.resolve();
  });
}

async function pressFocused(
  key: string,
  modifiers: Pick<KeyboardEventInit, "code" | "ctrlKey" | "metaKey" | "shiftKey"> = {},
): Promise<void> {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLButtonElement)) {
    throw new Error("Explorer row does not own DOM focus");
  }
  await act(async () => {
    focused.dispatchEvent(new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    }));
    await Promise.resolve();
  });
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

describe("CodeExplorer desktop selection", () => {
  it("exposes an ARIA multiselect tree with one roving focus target", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "notes-txt" });

    const tree = container!.querySelector<HTMLElement>('[role="tree"]');
    expect(tree?.getAttribute("aria-multiselectable")).toBe("true");
    expect(selectedNames()).toEqual(["notes.txt"]);
    expect(rowNamed("notes.txt").getAttribute("aria-selected")).toBe("true");
    expect(rowNamed("main.py").getAttribute("aria-selected")).toBe("false");
    expect(buttonNamed("notes.txt").tabIndex).toBe(0);
    expect([...container!.querySelectorAll<HTMLButtonElement>(
      ".code-tree-entry__main",
    )].filter((button) => button.tabIndex === 0)).toEqual([
      buttonNamed("notes.txt"),
    ]);
  });

  it("replaces selection and activates on an ordinary pointer click", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "notes-txt" });
    await clickEntry("empty");

    expect(handlers.onActivate).toHaveBeenCalledOnce();
    expect(handlers.onActivate).toHaveBeenCalledWith("empty-folder");
    expect(selectedNames()).toEqual(["empty"]);
    expect(buttonNamed("empty").tabIndex).toBe(0);
  });

  it("toggles Ctrl and Meta pointer selections without activation", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "main-py" });

    await clickEntry("nested.py", { ctrlKey: true });
    expect(selectedNames()).toEqual(["nested.py", "main.py"]);
    expect(buttonNamed("nested.py").tabIndex).toBe(0);

    await clickEntry("main.py", { metaKey: true });
    expect(selectedNames()).toEqual(["nested.py"]);
    expect(buttonNamed("main.py").tabIndex).toBe(0);
    expect(handlers.onActivate).not.toHaveBeenCalled();
  });

  it("selects inclusive visible Shift ranges from a stable anchor", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "main-py" });

    await clickEntry("nested.py", { shiftKey: true });
    expect(selectedNames()).toEqual([
      "nested.py",
      "nested",
      "deep.py",
      "main.py",
    ]);

    await clickEntry("empty", { shiftKey: true });
    expect(selectedNames()).toEqual(["main.py", "notes.txt", "empty"]);
    expect(handlers.onActivate).not.toHaveBeenCalled();
  });

  it("collapses folders without changing their icon and selects only visible rows", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "src-folder" });
    const folderButton = buttonNamed("src");
    const folderIcon = folderButton.querySelector(".code-tree-entry__icon")?.innerHTML;

    await clickEntry("src");
    expect(rowNamed("src").getAttribute("aria-expanded")).toBe("false");
    expect(container!.textContent).not.toContain("nested.py");
    expect(folderButton.querySelector(".code-tree-entry__icon")?.innerHTML)
      .toBe(folderIcon);

    await pressEntry("src", "a", { ctrlKey: true, code: "KeyA" });
    expect(selectedNames()).toEqual(["src", "main.py", "notes.txt", "empty"]);
  });

  it("renders empty folders without disclosure state or disclosure-key behavior", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "empty-folder" });
    const emptyButton = buttonNamed("empty");
    const emptyRow = rowNamed("empty");

    expect(emptyRow.hasAttribute("aria-expanded")).toBe(false);
    expect(emptyButton.querySelector(".code-tree-entry__chevron svg")).toBeNull();
    await pressEntry("empty", "ArrowLeft");
    expect(emptyRow.hasAttribute("aria-expanded")).toBe(false);
    expect(selectedNames()).toEqual(["empty"]);
  });
});

describe("CodeExplorer desktop keyboard", () => {
  it("moves and selects through visible rows with arrows, Home, and End", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "nested-py" });

    await pressEntry("nested.py", "ArrowDown");
    expect(selectedNames()).toEqual(["nested"]);
    expect(document.activeElement).toBe(buttonNamed("nested"));

    await pressFocused("ArrowDown");
    expect(selectedNames()).toEqual(["deep.py"]);
    expect(document.activeElement).toBe(buttonNamed("deep.py"));

    await pressFocused("ArrowUp");
    expect(document.activeElement).toBe(buttonNamed("nested"));
    await pressFocused("Home");
    expect(selectedNames()).toEqual(["src"]);
    expect(document.activeElement).toBe(buttonNamed("src"));
    await pressFocused("End");
    expect(selectedNames()).toEqual(["empty"]);
    expect(document.activeElement).toBe(buttonNamed("empty"));
    expect(handlers.onActivate).not.toHaveBeenCalled();
  });

  it("moves only roving focus with Ctrl or Meta navigation", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "nested-py" });

    await pressEntry("nested.py", "ArrowDown", { ctrlKey: true });
    expect(selectedNames()).toEqual(["nested.py"]);
    expect(document.activeElement).toBe(buttonNamed("nested"));

    await pressFocused("End", { metaKey: true });
    expect(selectedNames()).toEqual(["nested.py"]);
    expect(document.activeElement).toBe(buttonNamed("empty"));
  });

  it("grows and shrinks a Shift-arrow range around its anchor", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "nested-py" });

    await pressEntry("nested.py", "ArrowDown", { shiftKey: true });
    expect(selectedNames()).toEqual(["nested.py", "nested"]);

    await pressFocused("ArrowDown", { shiftKey: true });
    expect(selectedNames()).toEqual(["nested.py", "nested", "deep.py"]);

    await pressFocused("ArrowUp", { shiftKey: true });
    expect(selectedNames()).toEqual(["nested.py", "nested"]);
  });

  it("selects visible rows with Ctrl+A and clears with Escape", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "notes-txt" });

    await pressEntry("notes.txt", "a", { ctrlKey: true, code: "KeyA" });
    expect(selectedNames()).toEqual([
      "src",
      "nested.py",
      "nested",
      "deep.py",
      "main.py",
      "notes.txt",
      "empty",
    ]);
    expect(visibleIds).toHaveLength(selectedNames().length);

    await pressFocused("Escape");
    expect(selectedNames()).toEqual([]);
    expect(document.activeElement).toBe(buttonNamed("notes.txt"));
  });

  it("renames one selected row with F2 and activates it with Enter", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "notes-txt" });

    await pressEntry("notes.txt", "F2");
    expect(handlers.onBeginRename).toHaveBeenCalledOnce();
    expect(handlers.onBeginRename).toHaveBeenCalledWith(entry("notes-txt"));
    expect(handlers.onActivate).not.toHaveBeenCalled();

    await pressEntry("notes.txt", "Enter");
    expect(handlers.onActivate).toHaveBeenCalledOnce();
    expect(handlers.onActivate).toHaveBeenCalledWith("notes-txt");
  });

  it("deletes the selected group in visible order with Delete", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "nested-py" });
    await clickEntry("notes.txt", { ctrlKey: true });
    await pressEntry("notes.txt", "Delete");

    expect(handlers.onDelete).toHaveBeenCalledOnce();
    expect(handlers.onDelete).toHaveBeenCalledWith([
      entry("nested-py"),
      entry("notes-txt"),
    ]);
  });

  it("keeps undo and redo local while Explorer owns focus", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "notes-txt" });

    await pressEntry("notes.txt", "я", { ctrlKey: true, code: "KeyZ" });
    await pressEntry("notes.txt", "z", { ctrlKey: true, shiftKey: true });
    await pressEntry("notes.txt", "y", { ctrlKey: true });
    expect(handlers.onUndo).toHaveBeenCalledOnce();
    expect(handlers.onRedo).toHaveBeenCalledTimes(2);
  });
});

describe("CodeExplorer group commands", () => {
  it("keeps single-entry create, rename, and duplicate commands in context menus", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "nested-py" });

    await act(async () => {
      contextMenu(rowNamed("nested.py"));
      await Promise.resolve();
    });
    await act(async () => {
      menuAction("Переименовать")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(handlers.onBeginRename).toHaveBeenCalledWith(entry("nested-py"));

    await act(async () => {
      contextMenu(rowNamed("nested.py"));
      await Promise.resolve();
    });
    await act(async () => {
      menuAction("Дублировать")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(handlers.onDuplicate).toHaveBeenCalledWith(entry("nested-py"));

    const tree = container!.querySelector<HTMLElement>('[role="tree"]');
    await act(async () => {
      contextMenu(tree!);
      await Promise.resolve();
    });
    await act(async () => {
      menuAction("Создать файл")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(handlers.onCreate).toHaveBeenCalledWith("file", null);

    await act(async () => {
      contextMenu(rowNamed("src"));
      await Promise.resolve();
    });
    await act(async () => {
      menuAction("Создать папку")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(handlers.onCreate).toHaveBeenCalledWith("folder", "src-folder");
  });

  it("preserves a selected group on right-click and deletes that group", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "nested-py" });
    await clickEntry("notes.txt", { ctrlKey: true });

    await act(async () => {
      contextMenu(rowNamed("notes.txt"));
      await Promise.resolve();
    });

    expect(selectedNames()).toEqual(["nested.py", "notes.txt"]);
    expect(menuAction("Переименовать")).toBeUndefined();
    expect(menuAction("Дублировать")).toBeUndefined();
    await act(async () => {
      menuAction("Удалить")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(handlers.onDelete).toHaveBeenCalledWith([
      entry("nested-py"),
      entry("notes-txt"),
    ]);
    expect(handlers.onActivate).not.toHaveBeenCalled();
  });

  it("replaces a group when right-clicking an unselected row", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "nested-py" });
    await clickEntry("notes.txt", { ctrlKey: true });

    await act(async () => {
      contextMenu(rowNamed("empty"));
      await Promise.resolve();
    });

    expect(selectedNames()).toEqual(["empty"]);
    expect(menuAction("Переименовать")).toBeDefined();
    await act(async () => {
      menuAction("Удалить")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(handlers.onDelete).toHaveBeenCalledWith([entry("empty-folder")]);
    expect(handlers.onActivate).not.toHaveBeenCalled();
  });

  it("moves every selected entry when dragging any selected row", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "nested-py" });
    await clickEntry("notes.txt", { ctrlKey: true });
    const transfer = dataTransfer();

    await act(async () => {
      drag(rowNamed("notes.txt"), "dragstart", transfer);
      drag(rowNamed("empty"), "dragover", transfer);
      drag(rowNamed("empty"), "drop", transfer);
      await Promise.resolve();
    });

    expect(handlers.onMove).toHaveBeenCalledOnce();
    expect(handlers.onMove).toHaveBeenCalledWith(
      ["nested-py", "notes-txt"],
      "empty-folder",
    );
    expect(selectedNames()).toEqual(["nested.py", "notes.txt"]);
  });

  it("moves one unselected drag source and ignores drops onto files", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "main-py" });
    const tree = container!.querySelector<HTMLElement>('[role="tree"]');
    const rootTransfer = dataTransfer();

    await act(async () => {
      drag(rowNamed("nested.py"), "dragstart", rootTransfer);
      drag(tree!, "dragover", rootTransfer);
      drag(tree!, "drop", rootTransfer);
      await Promise.resolve();
    });
    expect(selectedNames()).toEqual(["nested.py"]);
    expect(handlers.onMove).toHaveBeenCalledWith(["nested-py"], null);

    handlers.onMove.mockClear();
    const fileTransfer = dataTransfer();
    await act(async () => {
      drag(rowNamed("notes.txt"), "dragstart", fileTransfer);
      drag(rowNamed("main.py"), "dragover", fileTransfer);
      expect(tree?.classList.contains("is-drop-target")).toBe(false);
      drag(rowNamed("main.py"), "drop", fileTransfer);
      await Promise.resolve();
    });
    expect(handlers.onMove).not.toHaveBeenCalled();
  });

  it("does not advertise or accept a selected subtree as a drop target", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "src-folder" });
    const tree = container!.querySelector<HTMLElement>('[role="tree"]');
    const transfer = dataTransfer();

    await act(async () => {
      drag(rowNamed("src"), "dragstart", transfer);
      drag(rowNamed("nested"), "dragover", transfer);
      expect(tree?.classList.contains("is-drop-target")).toBe(false);
      expect(rowNamed("nested").classList.contains("is-drop-target")).toBe(false);
      drag(rowNamed("nested"), "drop", transfer);
      await Promise.resolve();
    });

    expect(handlers.onMove).not.toHaveBeenCalled();
  });

  it("keeps the Explorer header free of menu and delete buttons", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "nested-py" });
    const header = container!.querySelector(".code-explorer__head");
    expect(header?.textContent?.trim()).toBe("Проводник");
    expect(header?.querySelector("button")).toBeNull();
  });

  it("blocks keyboard and context-menu deletion when the group includes main.py", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "main-py" });
    await clickEntry("notes.txt", { ctrlKey: true });

    await pressEntry("notes.txt", "Delete");
    await act(async () => {
      contextMenu(rowNamed("notes.txt"));
      await Promise.resolve();
    });
    expect(menuAction("Удалить")).toBeUndefined();
    expect(handlers.onDelete).not.toHaveBeenCalled();
  });

  it("protects an ancestor folder containing main.py from deletion", async () => {
    const handlers = callbacks();
    const nestedMainEntries = entries.map((candidate) => candidate.id === "main-py"
      ? { ...candidate, parentId: "src-folder" }
      : candidate);
    await renderExplorer(handlers, {
      activeId: "src-folder",
      entries: nestedMainEntries,
    });
    await pressEntry("src", "Delete");
    await act(async () => {
      contextMenu(rowNamed("src"));
      await Promise.resolve();
    });
    expect(menuAction("Удалить")).toBeUndefined();
    expect(handlers.onDelete).not.toHaveBeenCalled();
  });

  it("keeps selection navigation available but blocks mutations read-only", async () => {
    const handlers = callbacks();
    await renderExplorer(handlers, { activeId: "nested-py", readOnly: true });

    await clickEntry("notes.txt", { ctrlKey: true });
    expect(selectedNames()).toEqual(["nested.py", "notes.txt"]);
    await pressEntry("notes.txt", "Delete");
    expect(handlers.onDelete).not.toHaveBeenCalled();
    expect(rowNamed("notes.txt").draggable).toBe(false);

    await act(async () => {
      contextMenu(rowNamed("notes.txt"));
      await Promise.resolve();
    });
    expect([...container!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .every((button) => button.disabled)).toBe(true);
  });
});
