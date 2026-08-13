// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_BOARD_THEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
  ThemeProvider,
  ThemeToggle,
  applyTheme,
  initialTheme,
  parseTheme,
} from "./theme";

interface MatchMediaHarness {
  readonly setDark: (dark: boolean) => void;
}

function installMatchMedia(initialDark = false): MatchMediaHarness {
  let dark = initialDark;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    get matches() {
      return dark;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener(_type: string, listener: (event: MediaQueryListEvent) => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: (event: MediaQueryListEvent) => void) {
      listeners.delete(listener);
    },
  } as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn(() => query));
  return {
    setDark(nextDark) {
      dark = nextDark;
      const event = { matches: nextDark } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

describe("site theme preference", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("style");
    Reflect.deleteProperty(document, "visibilityState");
    document.head.innerHTML = '<meta name="theme-color" content="#f5f7f9">';
    installMatchMedia(false);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(document, "visibilityState");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("strictly parses values and migrates the legacy Board preference", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("system")).toBeNull();
    window.localStorage.setItem(THEME_STORAGE_KEY, "invalid");
    window.localStorage.setItem(LEGACY_BOARD_THEME_STORAGE_KEY, "dark");

    expect(initialTheme(window.localStorage)).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(window.localStorage.getItem(LEGACY_BOARD_THEME_STORAGE_KEY)).toBeNull();
  });

  it("removes invalid and stale legacy values so they cannot revive", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    window.localStorage.setItem(LEGACY_BOARD_THEME_STORAGE_KEY, "light");

    expect(initialTheme(window.localStorage)).toBe("dark");
    expect(window.localStorage.getItem(LEGACY_BOARD_THEME_STORAGE_KEY)).toBeNull();

    window.localStorage.removeItem(THEME_STORAGE_KEY);
    expect(initialTheme(window.localStorage)).toBe("light");

    window.localStorage.setItem(THEME_STORAGE_KEY, "invalid-current");
    window.localStorage.setItem(LEGACY_BOARD_THEME_STORAGE_KEY, "invalid-legacy");
    expect(initialTheme(window.localStorage)).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(LEGACY_BOARD_THEME_STORAGE_KEY)).toBeNull();
  });

  it("falls back to the OS when storage is unavailable", () => {
    installMatchMedia(true);
    const deniedStorage = {
      getItem() {
        throw new DOMException("denied", "SecurityError");
      },
    } as unknown as Storage;

    expect(initialTheme(deniedStorage)).toBe("dark");
  });

  it("keeps a readable preference and never throws on partial storage failures", () => {
    const readableCurrentStorage = {
      getItem(key: string) {
        if (key === THEME_STORAGE_KEY) return "dark";
        throw new DOMException("denied", "SecurityError");
      },
      removeItem() {
        throw new DOMException("denied", "SecurityError");
      },
    } as unknown as Storage;
    expect(initialTheme(readableCurrentStorage)).toBe("dark");

    const values = new Map<string, string>([
      [THEME_STORAGE_KEY, "invalid"],
      [LEGACY_BOARD_THEME_STORAGE_KEY, "dark"],
    ]);
    const deniedMigrationStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem() {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem() {
        throw new DOMException("denied", "SecurityError");
      },
    } as unknown as Storage;
    expect(initialTheme(deniedMigrationStorage)).toBe("dark");
    expect(values.get(LEGACY_BOARD_THEME_STORAGE_KEY)).toBe("dark");
  });

  it("updates every browser theme surface and creates a missing meta tag", () => {
    document.head.innerHTML = "";

    applyTheme("dark");

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.documentElement.style.backgroundColor)
      .toBe("rgb(23, 24, 22)");
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content"))
      .toBe("#171816");

    applyTheme("light");

    expect(document.documentElement.style.backgroundColor)
      .toBe("rgb(245, 247, 249)");
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content"))
      .toBe("#f5f7f9");
  });

  it("reconciles a storage change made between render and subscription", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    let changed = false;
    function ChangeStorageDuringRender() {
      if (!changed) {
        changed = true;
        window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
      }
      return createElement(ThemeToggle);
    }

    await act(async () => {
      root.render(createElement(
        ThemeProvider,
        null,
        createElement(ChangeStorageDuringRender),
      ));
    });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(container.querySelector(".theme-toggle")?.getAttribute("aria-label"))
      .toBe("Включить светлую тему");
  });

  it("reconciles an OS change made between render and subscription", async () => {
    const media = installMatchMedia(false);
    let changed = false;
    function ChangeSystemThemeDuringRender() {
      if (!changed) {
        changed = true;
        media.setDark(true);
      }
      return createElement(ThemeToggle);
    }

    await act(async () => {
      root.render(createElement(
        ThemeProvider,
        null,
        createElement(ChangeSystemThemeDuringRender),
      ));
    });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(container.querySelector(".theme-toggle")?.getAttribute("aria-label"))
      .toBe("Включить светлую тему");
  });

  it("applies, persists and exposes an accessible two-state toggle", async () => {
    await act(async () => {
      root.render(createElement(
        ThemeProvider,
        null,
        createElement(ThemeToggle),
      ));
    });

    const button = container.querySelector<HTMLButtonElement>(".theme-toggle");
    expect(button?.getAttribute("aria-pressed")).toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("Включить тёмную тему");
    expect(document.documentElement.dataset.theme).toBe("light");

    await act(async () => button?.click());

    expect(button?.getAttribute("aria-pressed")).toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("Включить светлую тему");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.documentElement.style.backgroundColor)
      .toBe("rgb(23, 24, 22)");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content"))
      .toBe("#171816");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("follows OS changes until the user saves a choice and syncs another tab", async () => {
    const media = installMatchMedia(false);
    await act(async () => {
      root.render(createElement(
        ThemeProvider,
        null,
        createElement(ThemeToggle),
      ));
    });

    await act(async () => media.setDark(true));
    expect(document.documentElement.dataset.theme).toBe("dark");

    const button = container.querySelector<HTMLButtonElement>(".theme-toggle");
    await act(async () => button?.click());
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    await act(async () => media.setDark(true));
    expect(document.documentElement.dataset.theme).toBe("light");

    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: THEME_STORAGE_KEY,
        newValue: "dark",
      }));
    });
    expect(document.documentElement.dataset.theme).toBe("dark");

    await act(async () => media.setDark(false));
    expect(document.documentElement.dataset.theme).toBe("dark");
    window.localStorage.clear();
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("reconciles after BFCache restore and only when a hidden page becomes visible", async () => {
    await act(async () => {
      root.render(createElement(
        ThemeProvider,
        null,
        createElement(ThemeToggle),
      ));
    });
    expect(document.documentElement.dataset.theme).toBe("light");

    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const pageShow = new Event("pageshow");
    Object.defineProperty(pageShow, "persisted", { value: true });
    await act(async () => window.dispatchEvent(pageShow));
    expect(document.documentElement.dataset.theme).toBe("dark");

    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(document.documentElement.dataset.theme).toBe("dark");

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("runs the blocking bootstrap before React and migrates legacy storage", () => {
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    const source = html.match(
      /<script data-eduri-theme-bootstrap>([\s\S]*?)<\/script>/u,
    )?.[1];
    expect(source).toBeTruthy();
    const values = new Map([[LEGACY_BOARD_THEME_STORAGE_KEY, "dark"]]);
    const documentElement = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
    const meta = { content: "#f5f7f9", name: "" };

    vm.runInNewContext(source!, {
      window: {
        localStorage: {
          getItem: (key: string) => values.get(key) ?? null,
          removeItem: (key: string) => values.delete(key),
          setItem: (key: string, value: string) => values.set(key, value),
        },
        matchMedia: () => ({ matches: false }),
      },
      document: {
        documentElement,
        createElement: () => meta,
        head: { appendChild: () => meta },
      },
    });

    expect(documentElement.dataset.theme).toBe("dark");
    expect(documentElement.style.colorScheme).toBe("dark");
    expect(meta.content).toBe("#171816");
    expect(values.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(values.has(LEGACY_BOARD_THEME_STORAGE_KEY)).toBe(false);
  });
});
