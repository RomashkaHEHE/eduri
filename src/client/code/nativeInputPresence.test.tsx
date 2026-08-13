// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODE_SYNC_LIMITS } from "../../code/protocol/constants.js";
import type {
  CodeAwarenessState,
  CodeScalarAwarenessTarget,
} from "../../code/protocol/types.js";
import {
  NativeInputPresence,
  nativeInputAwarenessState,
  type NativeInputPresencePeer,
  type NativeInputPresencePublisher,
} from "./nativeInputPresence.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const target = {
  kind: "test",
  testId: "test-1",
  field: "name",
} as const;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function Harness({
  initialValue,
  activeTarget = target,
  peers = [],
  publish,
}: {
  readonly initialValue: string;
  readonly activeTarget?: CodeScalarAwarenessTarget;
  readonly peers?: readonly NativeInputPresencePeer[];
  readonly publish: NativeInputPresencePublisher;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <NativeInputPresence
      target={activeTarget}
      value={value}
      peers={peers}
      publish={publish}
    >
      {(presence) => (
        <input
          {...presence}
          aria-label="Collaborative scalar"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      )}
    </NativeInputPresence>
  );
}

function input(): HTMLInputElement {
  const result = container?.querySelector<HTMLInputElement>("input");
  if (!result) throw new Error("expected input");
  return result;
}

function peer(
  participantId: string,
  displayName: string,
  draft: string,
  anchor: number,
  head: number,
  color = "#ef4444",
): NativeInputPresencePeer {
  return {
    participant: { participantId, displayName, color },
    state: { target, input: { draft, selection: { anchor, head } } },
  };
}

describe("native input presence", () => {
  it("publishes directional DOM selection and clears with the same owner token", async () => {
    const publish = vi.fn<NativeInputPresencePublisher>();
    await act(async () => {
      root?.render(<Harness initialValue="alpha" publish={publish} />);
    });
    const element = input();

    await act(async () => {
      element.focus();
      element.setSelectionRange(1, 4, "backward");
      document.dispatchEvent(new Event("selectionchange"));
    });

    const states = publish.mock.calls
      .map((call) => call[1])
      .filter((state): state is CodeAwarenessState => state !== null);
    expect(states.at(-1)).toEqual({
      target,
      input: { draft: "alpha", selection: { anchor: 4, head: 1 } },
    });
    const owner = publish.mock.calls[0]?.[0];
    expect(typeof owner).toBe("symbol");

    await act(async () => element.blur());
    expect(publish).toHaveBeenLastCalledWith(owner, null);
    expect(publish.mock.calls.every((call) => call[0] === owner)).toBe(true);
  });

  it("tracks input and selectionchange without adding cursor text", async () => {
    const publish = vi.fn<NativeInputPresencePublisher>();
    await act(async () => {
      root?.render(<Harness initialValue="a" publish={publish} />);
    });
    const element = input();
    await act(async () => {
      element.focus();
      element.value = "abc";
      element.setSelectionRange(3, 3);
      element.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    expect(publish.mock.calls.at(-1)?.[1]).toEqual({
      target,
      input: { draft: "abc", selection: { anchor: 3, head: 3 } },
    });
    expect(element.value).toBe("abc");
    expect(element.value).not.toContain("|");
  });

  it("renders every valid peer in stable order without changing input layout", async () => {
    const publish = vi.fn<NativeInputPresencePublisher>();
    const peers = [
      peer("participant-b", "Bob", "unsafe", 0, 2, "not-a-color"),
      peer(
        "participant-a",
        "<img src=x onerror=alert(1)>",
        "a<img>b",
        1,
        6,
        "#22c55e",
      ),
      peer("participant-e", "Eve", "shared", 3, 3, "#0ea5e9"),
      peer("participant-c", "Carol", "shared", 3, 3, "#a855f7"),
      peer("participant-d", "Dan", "shared", 3, 3, "#f97316"),
      // A duplicate authenticated ID cannot create a second overlay layer.
      peer("participant-b", "Duplicate Bob", "duplicate", 1, 1),
    ];
    await act(async () => {
      root?.render(
        <Harness initialValue="local value" peers={peers} publish={publish} />,
      );
    });

    const overlay = container?.querySelector<HTMLElement>(
      '[data-eduri-native-remote-overlay="true"]',
    );
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute("aria-hidden")).toBe("true");
    expect(overlay?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(overlay?.textContent).toContain("Bob");
    expect(overlay?.textContent).toContain("Carol");
    expect(overlay?.textContent).not.toContain("Duplicate Bob");
    expect(overlay?.querySelector("img")).toBeNull();
    expect([...overlay?.querySelectorAll(
      "[data-eduri-native-remote-peer]",
    ) ?? []].map((element) => element.getAttribute(
      "data-eduri-native-remote-peer",
    ))).toEqual([
      "participant-a",
      "participant-b",
      "participant-c",
      "participant-d",
      "participant-e",
    ]);
    expect(overlay?.querySelectorAll(
      '[data-eduri-native-remote-caret="true"]',
    )).toHaveLength(5);
    const labels = [...overlay?.querySelectorAll<HTMLElement>(
      '[data-eduri-native-remote-label="true"]',
    ) ?? []];
    expect(labels).toHaveLength(5);
    expect(labels.map((label) => label.textContent)).toEqual([
      "<img src=x onerror=alert(1)>",
      "Bob",
      "Carol",
      "Dan",
      "Eve",
    ]);
    expect(labels.every((label) => (
      label.style.opacity === "0"
      && label.style.visibility === "hidden"
      && label.style.pointerEvents === "none"
    ))).toBe(true);
    expect(overlay?.querySelectorAll(
      '[data-eduri-native-remote-hitbox="true"]',
    )).toHaveLength(5);
    expect(overlay?.querySelector(
      '[data-eduri-native-remote-overflow="true"]',
    )).toBeNull();

    const alicePeer = overlay?.querySelector<HTMLElement>(
      '[data-eduri-native-remote-peer="participant-a"]',
    );
    const aliceCaret = alicePeer?.querySelector<HTMLElement>(
      '[data-eduri-native-remote-caret="true"]',
    );
    const aliceHitbox = aliceCaret?.querySelector<HTMLElement>(
      '[data-eduri-native-remote-hitbox="true"]',
    );
    const aliceLabel = aliceCaret?.querySelector<HTMLElement>(
      '[data-eduri-native-remote-label="true"]',
    );
    expect(aliceHitbox?.parentElement).toBe(aliceCaret);
    expect(aliceHitbox?.nextElementSibling).toBe(aliceLabel);
    expect(aliceLabel?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(alicePeer?.querySelectorAll(
      '[data-eduri-native-remote-label="true"]',
    )).toHaveLength(1);

    // jsdom does not resolve :hover, so verify that the CSS rule can reveal
    // only the label adjacent to the hovered hitbox. Leaving restores the
    // inline hidden state asserted above.
    const hoverStyles = container?.querySelector<HTMLStyleElement>(
      'style[data-eduri-native-remote-presence-styles="true"]',
    )?.textContent ?? "";
    const normalizedHoverStyles = hoverStyles.replace(/\s+/gu, " ");
    expect(normalizedHoverStyles).toMatch(/@media\s*\(hover:\s*hover\)/u);
    expect(normalizedHoverStyles).toMatch(
      /\[data-eduri-native-remote-hitbox="true"\]:hover\s*\+\s*\[data-eduri-native-remote-label="true"\]/u,
    );
    expect(normalizedHoverStyles).toMatch(/opacity:\s*1/u);
    expect(normalizedHoverStyles).toMatch(/visibility:\s*visible/u);
    expect(overlay?.querySelector(
      '[data-eduri-native-remote-peer="participant-a"] '
      + '[data-eduri-native-remote-selection="true"]',
    )?.textContent).toBe("<img>");
    expect(overlay?.querySelector(
      '[data-eduri-native-remote-selection="true"]',
    )?.textContent).toBe("<img>");
    expect(input().value).toBe("local value");
    expect(input().getAttribute("style")).toBeNull();
    expect(overlay?.style.position).toBe("absolute");

    await act(async () => {
      root?.render(
        <Harness
          initialValue="local value"
          peers={[...peers].reverse()}
          publish={publish}
        />,
      );
    });
    expect([...container?.querySelectorAll(
      "[data-eduri-native-remote-peer]",
    ) ?? []].map((element) => element.getAttribute(
      "data-eduri-native-remote-peer",
    ))).toEqual([
      "participant-a",
      "participant-b",
      "participant-c",
      "participant-d",
      "participant-e",
    ]);
    expect(container?.querySelector(
      '[data-eduri-native-remote-peer="participant-b"] '
      + '[data-eduri-native-remote-label="true"]',
    )?.textContent).toBe("Bob");
    expect(container?.querySelector<HTMLElement>(
      '[data-eduri-native-remote-peer="participant-b"] '
      + '[data-eduri-native-remote-label="true"]',
    )?.style.visibility).toBe("hidden");
    expect(input().value).toBe("local value");
    expect(input().getAttribute("style")).toBeNull();
  });

  it("clears owned presence on unmount but never publishes before focus", async () => {
    const publish = vi.fn<NativeInputPresencePublisher>();
    await act(async () => {
      root?.render(<Harness initialValue="draft" publish={publish} />);
    });
    expect(publish).not.toHaveBeenCalled();

    await act(async () => input().focus());
    const owner = publish.mock.calls[0]?.[0];
    await act(async () => root?.unmount());
    root = null;
    expect(publish).toHaveBeenLastCalledWith(owner, null);
  });

  it("fails safely for native types without selection and oversized drafts", () => {
    const numberInput = document.createElement("input");
    numberInput.type = "number";
    numberInput.value = "1200";
    expect(nativeInputAwarenessState(target, numberInput)).toEqual({
      target,
      input: { draft: "1200", selection: { anchor: 4, head: 4 } },
    });

    const textInput = document.createElement("input");
    textInput.value = "x".repeat(CODE_SYNC_LIMITS.maxScalarDraftLength + 1);
    expect(nativeInputAwarenessState(target, textInput)).toEqual({ target });
  });
});
