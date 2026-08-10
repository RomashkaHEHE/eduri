import { describe, expect, it, vi } from "vitest";
import {
  BOARD_TOOLBAR_ITEM_IDS,
  BOARD_TOOLBAR_PREFERENCES_STORAGE_KEY,
  DEFAULT_BOARD_TOOLBAR_ORDER,
  DEFAULT_BOARD_TOOLBAR_VISIBLE,
  LEGACY_BOARD_TOOLBAR_PREFERENCES_STORAGE_KEY,
  defaultBoardToolbarPreferences,
  loadBoardToolbarPreferences,
  parseBoardToolbarPreferences,
  persistBoardToolbarPreferences,
  resetBoardToolbarPreferences,
  serializeBoardToolbarPreferences,
  type BoardToolbarItemId,
  type BoardToolbarPreferences,
  type BoardToolbarPreferencesStorage,
} from "./toolbarPreferences";

function envelope(
  order: readonly unknown[] = DEFAULT_BOARD_TOOLBAR_ORDER,
  visible: readonly unknown[] = DEFAULT_BOARD_TOOLBAR_VISIBLE,
): string {
  return JSON.stringify({ version: 2, order, visible });
}

function legacyEnvelope(
  order: readonly unknown[] = [
    "pen",
    "eraser",
    "text",
    "line",
    "arrow",
    "shapes",
    "laser",
    "code",
    "latex",
    "image",
  ],
  visible: readonly unknown[] = [
    "pen",
    "eraser",
    "text",
    "line",
    "arrow",
    "shapes",
  ],
): string {
  return JSON.stringify({ version: 1, order, visible });
}

function reorderedPreferences(): BoardToolbarPreferences {
  return {
    order: [
      "image",
      "pen",
      "text",
      "shapes",
      "eraser",
      "line",
      "arrow",
      "code",
      "latex",
    ],
    visible: ["image", "pen", "text", "shapes"],
  };
}

describe("device-local board toolbar preferences", () => {
  it("provides fresh defaults with Select excluded and exotic tools hidden", () => {
    const first = defaultBoardToolbarPreferences();
    const second = defaultBoardToolbarPreferences();

    expect(first).toEqual({
      order: [
        "pen",
        "eraser",
        "text",
        "line",
        "arrow",
        "shapes",
        "code",
        "latex",
        "image",
      ],
      visible: ["pen", "eraser", "text", "line", "arrow", "shapes"],
    });
    expect(BOARD_TOOLBAR_ITEM_IDS).not.toContain("select");
    expect(first.order).not.toBe(DEFAULT_BOARD_TOOLBAR_ORDER);
    expect(first.visible).not.toBe(DEFAULT_BOARD_TOOLBAR_VISIBLE);
    expect(second.order).not.toBe(first.order);
    expect(second.visible).not.toBe(first.visible);
  });

  it("round-trips a complete reordered toolbar and an empty visible subset", () => {
    const preferences = reorderedPreferences();
    expect(parseBoardToolbarPreferences(
      serializeBoardToolbarPreferences(preferences),
    )).toEqual(preferences);

    expect(parseBoardToolbarPreferences(envelope(preferences.order, [])))
      .toEqual({ order: preferences.order, visible: [] });
  });

  it("migrates a complete v1 preference by removing Laser in place", () => {
    expect(parseBoardToolbarPreferences(legacyEnvelope(
      [
        "image",
        "laser",
        "code",
        "pen",
        "shapes",
        "eraser",
        "text",
        "line",
        "arrow",
        "latex",
      ],
      ["image", "laser", "pen", "shapes"],
    ))).toEqual({
      order: [
        "image",
        "code",
        "pen",
        "shapes",
        "eraser",
        "text",
        "line",
        "arrow",
        "latex",
      ],
      visible: ["image", "pen", "shapes"],
    });
  });

  it.each([
    ["missing value", null],
    ["malformed JSON", "{"],
    ["wrong version", JSON.stringify({
      version: 3,
      order: DEFAULT_BOARD_TOOLBAR_ORDER,
      visible: DEFAULT_BOARD_TOOLBAR_VISIBLE,
    })],
    ["missing field", JSON.stringify({
      version: 2,
      order: DEFAULT_BOARD_TOOLBAR_ORDER,
    })],
    ["unknown envelope field", JSON.stringify({
      version: 2,
      order: DEFAULT_BOARD_TOOLBAR_ORDER,
      visible: DEFAULT_BOARD_TOOLBAR_VISIBLE,
      future: true,
    })],
    ["non-array order", JSON.stringify({
      version: 1,
      order: "pen",
      visible: DEFAULT_BOARD_TOOLBAR_VISIBLE,
    })],
    ["incomplete order", envelope(DEFAULT_BOARD_TOOLBAR_ORDER.slice(1))],
    ["duplicate order", envelope([
      ...DEFAULT_BOARD_TOOLBAR_ORDER.slice(0, -1),
      "pen",
    ])],
    ["unknown order item", envelope([
      ...DEFAULT_BOARD_TOOLBAR_ORDER.slice(0, -1),
      "video",
    ])],
    ["fixed Select in order", envelope([
      ...DEFAULT_BOARD_TOOLBAR_ORDER.slice(0, -1),
      "select",
    ])],
    ["duplicate visible item", envelope(
      DEFAULT_BOARD_TOOLBAR_ORDER,
      ["pen", "pen"],
    )],
    ["unknown visible item", envelope(
      DEFAULT_BOARD_TOOLBAR_ORDER,
      ["pen", "video"],
    )],
    ["non-string visible item", envelope(
      DEFAULT_BOARD_TOOLBAR_ORDER,
      ["pen", 1],
    )],
  ])("fails the complete %s envelope closed", (_name, serialized) => {
    expect(parseBoardToolbarPreferences(serialized)).toEqual(
      defaultBoardToolbarPreferences(),
    );
  });

  it("rejects stored input above 64 KiB", () => {
    const oversized = `${envelope()}${" ".repeat(64 * 1024)}`;
    expect(parseBoardToolbarPreferences(oversized)).toEqual(
      defaultBoardToolbarPreferences(),
    );
  });

  it("serializes invalid runtime input as a complete default envelope", () => {
    const invalid = {
      order: ["pen", "pen"],
      visible: ["unknown"],
    } as unknown as BoardToolbarPreferences;
    const serialized = serializeBoardToolbarPreferences(invalid);
    const parsedJson = JSON.parse(serialized) as {
      version: number;
      order: BoardToolbarItemId[];
      visible: BoardToolbarItemId[];
    };

    expect(parsedJson.version).toBe(2);
    expect(parsedJson.order).toEqual(DEFAULT_BOARD_TOOLBAR_ORDER);
    expect(parsedJson.visible).toEqual(DEFAULT_BOARD_TOOLBAR_VISIBLE);
    expect(serialized.length).toBeLessThanOrEqual(64 * 1024);
  });

  it("loads and persists through the versioned storage key", () => {
    const values = new Map<string, string>();
    const storage: BoardToolbarPreferencesStorage = {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    };
    const preferences = reorderedPreferences();

    expect(persistBoardToolbarPreferences(preferences, storage)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(
      BOARD_TOOLBAR_PREFERENCES_STORAGE_KEY,
      expect.any(String),
    );
    expect(loadBoardToolbarPreferences(storage)).toEqual(preferences);
  });

  it("loads v1 only when v2 is absent and persists the migrated result as v2", () => {
    const values = new Map<string, string>([[
      LEGACY_BOARD_TOOLBAR_PREFERENCES_STORAGE_KEY,
      legacyEnvelope(
        [
          "image",
          "laser",
          "pen",
          "eraser",
          "text",
          "line",
          "arrow",
          "shapes",
          "code",
          "latex",
        ],
        ["image", "laser", "pen"],
      ),
    ]]);
    const storage: BoardToolbarPreferencesStorage = {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    };

    const migrated = loadBoardToolbarPreferences(storage);
    expect(migrated).toEqual({
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
      visible: ["image", "pen"],
    });
    expect(persistBoardToolbarPreferences(migrated, storage)).toBe(true);
    expect(JSON.parse(values.get(BOARD_TOOLBAR_PREFERENCES_STORAGE_KEY) ?? ""))
      .toMatchObject({ version: 2, order: migrated.order, visible: migrated.visible });
  });

  it("does not revive v1 when a malformed v2 value already exists", () => {
    const storage: BoardToolbarPreferencesStorage = {
      getItem: vi.fn((key) => key === BOARD_TOOLBAR_PREFERENCES_STORAGE_KEY
        ? "{"
        : legacyEnvelope()),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    expect(loadBoardToolbarPreferences(storage)).toEqual(
      defaultBoardToolbarPreferences(),
    );
    expect(storage.getItem).toHaveBeenCalledTimes(1);
  });

  it("contains unavailable and throwing storage backends", () => {
    const storage: BoardToolbarPreferencesStorage = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("quota");
      }),
      removeItem: vi.fn(() => {
        throw new Error("blocked");
      }),
    };

    expect(loadBoardToolbarPreferences(null)).toEqual(
      defaultBoardToolbarPreferences(),
    );
    expect(loadBoardToolbarPreferences(storage)).toEqual(
      defaultBoardToolbarPreferences(),
    );
    expect(persistBoardToolbarPreferences(reorderedPreferences(), null))
      .toBe(false);
    expect(persistBoardToolbarPreferences(reorderedPreferences(), storage))
      .toBe(false);
    expect(resetBoardToolbarPreferences(storage)).toEqual(
      defaultBoardToolbarPreferences(),
    );
  });

  it("resets the stored value and returns independent defaults", () => {
    const removeItem = vi.fn();
    const first = resetBoardToolbarPreferences({ removeItem });
    const second = resetBoardToolbarPreferences(null);

    expect(removeItem).toHaveBeenCalledWith(
      BOARD_TOOLBAR_PREFERENCES_STORAGE_KEY,
    );
    expect(removeItem).toHaveBeenCalledWith(
      LEGACY_BOARD_TOOLBAR_PREFERENCES_STORAGE_KEY,
    );
    expect(first).toEqual(defaultBoardToolbarPreferences());
    expect(first.order).not.toBe(second.order);
    expect(first.visible).not.toBe(second.visible);
  });
});
