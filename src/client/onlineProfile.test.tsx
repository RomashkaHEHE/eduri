// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ONLINE_PROFILE_COLOR,
  ONLINE_PROFILE_STORAGE_KEY,
  OnlineProfileButton,
  OnlineProfileProvider,
  loadOnlineProfile,
  normalizeOnlineProfile,
  parseOnlineProfileStorage,
  resetOnlineProfileMemoryForTests,
  saveOnlineProfile,
  useOnlineProfile,
} from "./onlineProfile";

function storedProfile(displayName: string, color: string): string {
  return JSON.stringify({ version: 1, displayName, color });
}

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

function ProfileState({
  defaultDisplayName,
  required,
}: {
  defaultDisplayName?: string;
  required?: boolean;
}) {
  const state = useOnlineProfile({
    ...(defaultDisplayName === undefined ? {} : { defaultDisplayName }),
    ...(required === undefined ? {} : { required }),
  });
  return createElement("output", {
    "data-testid": "profile-state",
    "data-configured": String(state.configured),
    "data-name": state.profile?.displayName ?? "",
    "data-color": state.profile?.color ?? "",
  });
}

describe("online profile storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetOnlineProfileMemoryForTests();
  });

  afterEach(() => {
    window.localStorage.clear();
    resetOnlineProfileMemoryForTests();
    vi.restoreAllMocks();
  });

  it("normalizes user input but accepts only canonical strict storage", () => {
    expect(normalizeOnlineProfile({
      displayName: "  Ａlice   Smith  ",
      color: "#AABBCC",
    })).toEqual({ displayName: "Alice Smith", color: "#aabbcc" });
    expect(normalizeOnlineProfile({
      displayName: "Alice\nSmith",
      color: "#aabbcc",
    })).toBeNull();
    expect(normalizeOnlineProfile({
      displayName: "Alice\u202eSmith",
      color: "#aabbcc",
    })).toBeNull();

    const canonical = storedProfile("Alice Smith", "#aabbcc");
    expect(parseOnlineProfileStorage(canonical)).toEqual({
      displayName: "Alice Smith",
      color: "#aabbcc",
    });
    expect(parseOnlineProfileStorage(storedProfile(" Alice ", "#aabbcc")))
      .toBeNull();
    expect(parseOnlineProfileStorage(storedProfile("Alice", "#AABBCC")))
      .toBeNull();
    expect(parseOnlineProfileStorage(JSON.stringify({
      version: 1,
      displayName: "Alice",
      color: "#aabbcc",
      extra: true,
    }))).toBeNull();
    expect(parseOnlineProfileStorage(JSON.stringify({
      version: 2,
      displayName: "Alice",
      color: "#aabbcc",
    }))).toBeNull();
  });

  it("persists the canonical envelope and keeps a memory fallback", () => {
    const saved = saveOnlineProfile({
      displayName: "  Alice   Smith ",
      color: "#AABBCC",
    }, window.localStorage);
    expect(saved).toEqual({ displayName: "Alice Smith", color: "#aabbcc" });
    expect(window.localStorage.getItem(ONLINE_PROFILE_STORAGE_KEY))
      .toBe(storedProfile("Alice Smith", "#aabbcc"));
    expect(loadOnlineProfile(window.localStorage)).toEqual(saved);

    resetOnlineProfileMemoryForTests();
    const deniedStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      removeItem: vi.fn(),
    } as unknown as Storage;
    const fallback = saveOnlineProfile({
      displayName: "Memory User",
      color: DEFAULT_ONLINE_PROFILE_COLOR,
    }, deniedStorage);
    expect(loadOnlineProfile(deniedStorage)).toEqual(fallback);
  });
});

describe("OnlineProfileProvider", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    resetOnlineProfileMemoryForTests();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.classList.remove("modal-open");
    window.localStorage.clear();
    resetOnlineProfileMemoryForTests();
    vi.restoreAllMocks();
  });

  it("stays inert until an online consumer requires a profile", async () => {
    await act(async () => {
      root.render(createElement(
        OnlineProfileProvider,
        null,
        createElement(ProfileState),
      ));
    });

    expect(container.querySelector('[data-configured="false"]')).not.toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(window.localStorage.getItem(ONLINE_PROFILE_STORAGE_KEY)).toBeNull();
  });

  it("suggests a profile with a phantom default and allows skipping it", async () => {
    await act(async () => {
      root.render(createElement(
        OnlineProfileProvider,
        null,
        createElement(ProfileState, { defaultDisplayName: "  Рома  " }),
        createElement(OnlineProfileButton),
      ));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const state = container.querySelector<HTMLOutputElement>(
      '[data-testid="profile-state"]',
    );
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    const nameInput = dialog?.querySelector<HTMLInputElement>(
      'input[autocomplete="nickname"]',
    );
    expect(state?.dataset.configured).toBe("false");
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('[aria-label="Закрыть"]')).not.toBeNull();
    expect(nameInput?.value).toBe("");
    expect(nameInput?.placeholder).toBe("Рома");
    expect(dialog?.querySelector(".board-color-picker")).not.toBeNull();
    expect(dialog?.querySelector('input[aria-label="Оттенок"]')).not.toBeNull();
    expect(dialog?.querySelector('input[type="color"]')).toBeNull();

    await act(async () => {
      document.body.querySelector<HTMLElement>(".modal-backdrop")
        ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(state?.dataset.configured).toBe("false");
    expect(state?.dataset.name).toBe("Рома");
    expect(window.localStorage.getItem(ONLINE_PROFILE_STORAGE_KEY)).toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".online-profile-button")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(
        '[role="dialog"] [aria-label="Закрыть"]',
      )?.click();
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(state?.dataset.configured).toBe("false");
    expect(state?.dataset.name).toBe("Рома");
    expect(state?.dataset.color).toBe(DEFAULT_ONLINE_PROFILE_COLOR);
    expect(window.localStorage.getItem(ONLINE_PROFILE_STORAGE_KEY)).toBeNull();
  });

  it("releases the mandatory dialog when the online session ends", async () => {
    await act(async () => {
      root.render(createElement(
        OnlineProfileProvider,
        null,
        createElement(ProfileState, {
          defaultDisplayName: "Guest",
          required: true,
        }),
      ));
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      root.render(createElement(
        OnlineProfileProvider,
        null,
        createElement(ProfileState, {
          defaultDisplayName: "Guest",
          required: false,
        }),
      ));
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(window.localStorage.getItem(ONLINE_PROFILE_STORAGE_KEY)).toBeNull();
  });

  it("edits the current profile and updates consumers without a reload", async () => {
    saveOnlineProfile({
      displayName: "Alice",
      color: "#16825d",
    }, window.localStorage);
    await act(async () => {
      root.render(createElement(
        OnlineProfileProvider,
        null,
        createElement(ProfileState),
        createElement(OnlineProfileButton),
      ));
    });

    const profileButton = container.querySelector<HTMLButtonElement>(
      ".online-profile-button",
    );
    expect(profileButton?.getAttribute("aria-label")).toBe("Профиль");
    expect(profileButton?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => profileButton?.click());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    const input = dialog?.querySelector<HTMLInputElement>(
      'input[autocomplete="nickname"]',
    );
    expect(dialog?.querySelector('[aria-label="Закрыть"]')).not.toBeNull();
    expect(input?.value).toBe("Alice");

    await act(async () => {
      if (input) setInputValue(input, "Bob");
    });
    await act(async () => {
      dialog?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    });

    const state = container.querySelector<HTMLOutputElement>(
      '[data-testid="profile-state"]',
    );
    expect(state?.dataset.configured).toBe("true");
    expect(state?.dataset.name).toBe("Bob");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(loadOnlineProfile(window.localStorage)?.displayName).toBe("Bob");
  });

  it("reconciles profile updates and clears from another tab", async () => {
    await act(async () => {
      root.render(createElement(
        OnlineProfileProvider,
        null,
        createElement(ProfileState, { defaultDisplayName: "Guest" }),
      ));
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    const external = storedProfile("External User", "#d33f49");
    window.localStorage.setItem(ONLINE_PROFILE_STORAGE_KEY, external);
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: ONLINE_PROFILE_STORAGE_KEY,
        newValue: external,
      }));
    });

    const state = container.querySelector<HTMLOutputElement>(
      '[data-testid="profile-state"]',
    );
    expect(state?.dataset.name).toBe("External User");
    expect(state?.dataset.color).toBe("#d33f49");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    window.localStorage.removeItem(ONLINE_PROFILE_STORAGE_KEY);
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: ONLINE_PROFILE_STORAGE_KEY,
        newValue: null,
      }));
    });
    await act(async () => Promise.resolve());

    expect(state?.dataset.configured).toBe("false");
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
