// @vitest-environment jsdom

import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalUndoController,
  createLocalCommandOrigin,
} from "../../board/core";
import {
  CollaborativeTextareaBinding,
  type CollaborativeTextEdit,
} from "./collaborativeTextBinding";

const REMOTE_ORIGIN = Object.freeze({ type: "binding-test-remote" });

interface BoundReplica {
  readonly document: Y.Doc;
  readonly text: Y.Text;
  readonly element: HTMLTextAreaElement;
  readonly undo: LocalUndoController;
  readonly binding: CollaborativeTextareaBinding;
}

const replicas: BoundReplica[] = [];

function replaceText(
  document: Y.Doc,
  text: Y.Text,
  origin: object,
  edit: CollaborativeTextEdit,
): void {
  document.transact(() => {
    if (edit.deleteLength > 0) {
      text.delete(edit.index, edit.deleteLength);
    }
    if (edit.insert) text.insert(edit.index, edit.insert);
  }, origin);
}

function bindReplica(document: Y.Doc, deviceId: string): BoundReplica {
  const text = document.getText("source");
  const origin = createLocalCommandOrigin(deviceId);
  const undo = new LocalUndoController(document, origin);
  const element = window.document.createElement("textarea");
  window.document.body.append(element);
  const binding = new CollaborativeTextareaBinding({
    element,
    text,
    localOrigin: origin,
    undo,
    applyEdit: (edit) => replaceText(document, text, origin, edit),
  });
  const replica = { document, text, element, undo, binding };
  replicas.push(replica);
  return replica;
}

function replicaPair(initialValue: string): [BoundReplica, BoundReplica] {
  const seed = new Y.Doc();
  seed.getText("source").insert(0, initialValue);
  const update = Y.encodeStateAsUpdate(seed);
  const firstDocument = new Y.Doc();
  const secondDocument = new Y.Doc();
  Y.applyUpdate(firstDocument, update, REMOTE_ORIGIN);
  Y.applyUpdate(secondDocument, update, REMOTE_ORIGIN);
  seed.destroy();
  return [
    bindReplica(firstDocument, "binding-first"),
    bindReplica(secondDocument, "binding-second"),
  ];
}

function sync(source: BoundReplica, target: BoundReplica): void {
  Y.applyUpdate(
    target.document,
    Y.encodeStateAsUpdate(
      source.document,
      Y.encodeStateVector(target.document),
    ),
    REMOTE_ORIGIN,
  );
}

function browserInput(
  replica: BoundReplica,
  value: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): void {
  replica.element.value = value;
  replica.element.setSelectionRange(selectionStart, selectionEnd);
  replica.element.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    data: null,
    inputType: "insertText",
  }));
}

afterEach(() => {
  for (const replica of replicas.splice(0)) {
    replica.binding.dispose();
    replica.undo.dispose();
    replica.element.remove();
    replica.document.destroy();
  }
});

describe("CollaborativeTextareaBinding", () => {
  it("merges a delayed remote insert before the next local input without overwriting it", () => {
    const [first, second] = replicaPair("ab");
    first.element.setSelectionRange(1, 1);

    browserInput(second, "aXb", 2);
    expect(first.element.value).toBe("ab");
    sync(second, first);

    expect(first.element.value).toBe("aXb");
    expect(first.element.selectionStart).toBe(2);
    browserInput(first, "aXLb", 3);

    sync(first, second);
    sync(second, first);
    expect(first.text.toString()).toBe("aXLb");
    expect(second.text.toString()).toBe("aXLb");
    expect(first.element.value).toBe("aXLb");
    expect(second.element.value).toBe("aXLb");
  });

  it("translates a forward or backward selection through remote inserts and deletes", () => {
    const [first, second] = replicaPair("abcdef");
    first.element.setSelectionRange(2, 4, "backward");

    browserInput(second, "aXXbcdef", 3);
    sync(second, first);

    expect(first.element.value).toBe("aXXbcdef");
    expect(first.element.selectionStart).toBe(4);
    expect(first.element.selectionEnd).toBe(6);
    expect(first.element.selectionDirection).toBe("backward");

    browserInput(second, "XXbcdef", 0);
    sync(second, first);
    expect(first.element.selectionStart).toBe(3);
    expect(first.element.selectionEnd).toBe(5);
  });

  it("keeps composition edits convergent and routes editor undo through local-only Yjs history", async () => {
    const [first, second] = replicaPair("");
    first.element.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
      data: "",
    }));
    browserInput(first, "n", 1);
    sync(first, second);

    browserInput(second, "Rn", 1);
    sync(second, first);
    expect(first.element.value).toBe("Rn");
    expect(first.element.selectionStart).toBe(2);

    browserInput(first, "Rに", 2);
    first.element.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "に",
    }));
    await Promise.resolve();
    expect(first.text.toString()).toBe("Rに");

    const undoEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      code: "KeyZ",
      key: "я",
    });
    first.element.dispatchEvent(undoEvent);
    expect(undoEvent.defaultPrevented).toBe(true);
    expect(first.text.toString()).toBe("R");

    sync(first, second);
    expect(second.text.toString()).toBe("R");

    const redoEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      code: "KeyY",
      key: "н",
    });
    first.element.dispatchEvent(redoEvent);
    expect(redoEvent.defaultPrevented).toBe(true);
    expect(first.text.toString()).toBe("Rに");
    sync(first, second);
    expect(second.text.toString()).toBe("Rに");
  });
});
