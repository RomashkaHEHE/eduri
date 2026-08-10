// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCriticalDataGuard } from "./criticalDataGuard";

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let runGuarded: ((action: () => void) => boolean) | undefined;

function Probe({ active }: { active: boolean }) {
  runGuarded = useCriticalDataGuard(active, "risk");
  return null;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(window.history, "back").mockImplementation(() => undefined);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  runGuarded = undefined;
  vi.restoreAllMocks();
});

describe("critical Board data guard", () => {
  it("guards reload, browser Back and explicit in-app navigation", async () => {
    const push = vi.spyOn(window.history, "pushState");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    await act(async () => root?.render(createElement(Probe, { active: true })));
    expect(push).toHaveBeenCalledTimes(1);

    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(confirm).toHaveBeenCalledWith("risk");
    expect(push).toHaveBeenCalledTimes(2);
    expect(window.history.back).not.toHaveBeenCalled();

    const action = vi.fn();
    expect(runGuarded?.(action)).toBe(false);
    expect(action).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    expect(runGuarded?.(action)).toBe(true);
    expect(action).toHaveBeenCalledOnce();
  });

  it("allows normal navigation without touching browser history", async () => {
    const push = vi.spyOn(window.history, "pushState");
    const confirm = vi.spyOn(window, "confirm");
    const action = vi.fn();

    await act(async () => root?.render(createElement(Probe, { active: false })));

    expect(runGuarded?.(action)).toBe(true);
    expect(action).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});
