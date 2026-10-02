// @vitest-environment jsdom

import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalUndoController,
  createLocalCommandOrigin,
} from "../../board/core";
import {
  CollaborativeRichTextBinding,
  readContentEditableSelection,
  writeContentEditableSelection,
  type CollaborativeRichTextEdit,
} from "./collaborativeRichTextBinding";

interface Harness {
  readonly document: Y.Doc;
  readonly text: Y.Text;
  readonly element: HTMLDivElement;
  readonly undo: LocalUndoController;
  readonly binding: CollaborativeRichTextBinding;
}

const harnesses: Harness[] = [];

function createHarness(
  value = "abc",
  inheritedAttributes?: () => Readonly<Record<string, unknown>>,
): Harness {
  const document = new Y.Doc();
  const text = document.getText("text");
  text.insert(0, value);
  const origin = createLocalCommandOrigin("rich-text-binding-test");
  const undo = new LocalUndoController(document, origin);
  const element = window.document.createElement("div");
  element.contentEditable = "true";
  element.tabIndex = 0;
  window.document.body.append(element);
  const applyEdit = (edit: CollaborativeRichTextEdit) => {
    document.transact(() => {
      if (edit.deleteLength > 0) text.delete(edit.index, edit.deleteLength);
      if (edit.insert) text.insert(edit.index, edit.insert, { ...edit.attributes });
    }, origin);
  };
  const binding = new CollaborativeRichTextBinding({
    element,
    text,
    localOrigin: origin,
    undo,
    inheritedAttributes,
    applyEdit,
    applyFormat: (index, length, attributes) => {
      document.transact(() => text.format(index, length, { ...attributes }), origin);
    },
  });
  const harness = { document, text, element, undo, binding };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!;
    harness.binding.dispose();
    harness.undo.manager.destroy();
    harness.document.destroy();
    harness.element.remove();
  }
});

describe("CollaborativeRichTextBinding", () => {
  it("formats only the selected range and carries its style into following input", () => {
    const harness = createHarness();
    harness.element.focus();
    writeContentEditableSelection(harness.element, { anchor: 1, head: 2 });

    harness.binding.format({ bold: true, color: "#d33f49" });
    expect(harness.text.toDelta()).toEqual([
      { insert: "a" },
      { insert: "b", attributes: { bold: true, color: "#d33f49" } },
      { insert: "c" },
    ]);

    writeContentEditableSelection(harness.element, { anchor: 2, head: 2 });
    const input = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: "X",
      inputType: "insertText",
    });
    harness.element.dispatchEvent(input);

    expect(input.defaultPrevented).toBe(true);
    expect(harness.text.toString()).toBe("abXc");
    expect(harness.text.toDelta()).toEqual([
      { insert: "a" },
      { insert: "bX", attributes: { bold: true, color: "#d33f49" } },
      { insert: "c" },
    ]);
  });

  it("keeps the local selection attached across a remote insertion", () => {
    const harness = createHarness("hello");
    harness.element.focus();
    writeContentEditableSelection(harness.element, { anchor: 2, head: 4 });

    harness.document.transact(() => harness.text.insert(0, "!"), {
      type: "remote-test",
    });

    expect(harness.element.textContent).toBe("!hello");
    expect(readContentEditableSelection(harness.element)).toEqual({
      anchor: 3,
      head: 5,
    });
  });

  it("publishes selection style changes without mutating text for a collapsed caret", () => {
    const harness = createHarness("text");
    const onSelectionChange = vi.fn();
    harness.binding.dispose();
    const origin = createLocalCommandOrigin("rich-text-caret-style");
    const binding = new CollaborativeRichTextBinding({
      element: harness.element,
      text: harness.text,
      localOrigin: origin,
      undo: harness.undo,
      applyEdit: (edit) => {
        harness.document.transact(() => {
          if (edit.deleteLength > 0) {
            harness.text.delete(edit.index, edit.deleteLength);
          }
          if (edit.insert) {
            harness.text.insert(edit.index, edit.insert, { ...edit.attributes });
          }
        }, origin);
      },
      applyFormat: () => undefined,
      onSelectionChange,
    });
    harnesses[harnesses.length - 1] = { ...harness, binding };
    harness.element.focus();
    writeContentEditableSelection(harness.element, { anchor: 2, head: 2 });
    binding.selection();
    const toolbarInput = window.document.createElement("input");
    window.document.body.append(toolbarInput);
    toolbarInput.focus();

    binding.format({ italic: true });
    binding.focus();
    const input = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: "X",
      inputType: "insertText",
    });
    harness.element.dispatchEvent(input);

    expect(input.defaultPrevented).toBe(true);
    expect(harness.text.toDelta()).toEqual([
      { insert: "te" },
      { insert: "X", attributes: { italic: true } },
      { insert: "xt" },
    ]);
    expect(onSelectionChange).toHaveBeenCalled();
    toolbarInput.remove();
  });

  it("restores the selected range after a formatting control temporarily takes focus", () => {
    const harness = createHarness("format me");
    const toolbarButton = window.document.createElement("button");
    window.document.body.append(toolbarButton);
    harness.element.focus();
    writeContentEditableSelection(harness.element, { anchor: 0, head: 6 });
    expect(harness.binding.selection()).toEqual({ anchor: 0, head: 6 });

    toolbarButton.focus();
    harness.binding.format({ bold: true });
    harness.binding.focus();

    expect(window.document.activeElement).toBe(harness.element);
    expect(readContentEditableSelection(harness.element)).toEqual({
      anchor: 0,
      head: 6,
    });
    expect(harness.text.toDelta()).toEqual([
      { insert: "format", attributes: { bold: true } },
      { insert: " me" },
    ]);
    toolbarButton.remove();
  });

  it("selects and deletes the complete value with Ctrl+A then Backspace", () => {
    const harness = createHarness("delete everything");
    harness.element.focus();
    writeContentEditableSelection(harness.element, { anchor: 17, head: 17 });

    const selectAll = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyA",
      key: "a",
      ctrlKey: true,
    });
    harness.element.dispatchEvent(selectAll);
    expect(selectAll.defaultPrevented).toBe(true);
    expect(readContentEditableSelection(harness.element)).toEqual({
      anchor: 0,
      head: 17,
    });

    const backspace = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Backspace",
      key: "Backspace",
    });
    harness.element.dispatchEvent(backspace);
    expect(backspace.defaultPrevented).toBe(true);
    expect(harness.text.toString()).toBe("");
    expect(harness.element.textContent).toBe("");
    expect(harness.element.querySelector("[data-board-text-run]")).toBeNull();
    expect(readContentEditableSelection(harness.element)).toEqual({
      anchor: 0,
      head: 0,
    });
  });

  it("applies standard bold and italic shortcuts to the selected range", () => {
    const harness = createHarness("styled");
    harness.element.focus();
    writeContentEditableSelection(harness.element, { anchor: 0, head: 6 });

    for (const [code, key] of [["KeyB", "b"], ["KeyI", "i"]] as const) {
      const shortcut = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code,
        key,
        ctrlKey: true,
      });
      harness.element.dispatchEvent(shortcut);
      expect(shortcut.defaultPrevented).toBe(true);
    }

    expect(harness.text.toDelta()).toEqual([{
      insert: "styled",
      attributes: { bold: true, italic: true },
    }]);
  });

  it("toggles an inherited object-level style off with its standard shortcut", () => {
    const harness = createHarness("bold", () => ({ bold: true }));
    harness.element.focus();
    writeContentEditableSelection(harness.element, { anchor: 0, head: 4 });

    harness.element.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyB",
      key: "b",
      ctrlKey: true,
    }));

    expect(harness.text.toDelta()).toEqual([{
      insert: "bold",
      attributes: { bold: false },
    }]);
  });
});
