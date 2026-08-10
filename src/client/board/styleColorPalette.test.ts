import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STYLE_COLOR_SLOTS,
  STYLE_COLOR_PALETTE_MAX_COUNT,
  STYLE_COLOR_PALETTE_RECENT_MAX_COUNT,
  STYLE_COLOR_PALETTE_STORAGE_KEY,
  canonicalStyleColor,
  changeStyleColorSlot,
  createStyleColorSlot,
  deleteStyleColorSlot,
  loadStyleColorPalette,
  moveStyleColorSlot,
  parseStyleColorPalette,
  persistStyleColorPalette,
  rememberRecentStyleColor,
  serializeStyleColorPalette,
  type StyleColorPaletteStorage,
  type StyleColorSlot,
} from "./styleColorPalette";

function serialized(
  slots: readonly StyleColorSlot[] = DEFAULT_STYLE_COLOR_SLOTS,
  recentColors: readonly string[] = [],
): string {
  return JSON.stringify({ version: 1, slots, recentColors });
}

describe("shared board style color palette", () => {
  it("provides independent canonical default slots", () => {
    const first = parseStyleColorPalette(null);
    const second = parseStyleColorPalette(null);

    expect(first).toEqual({
      slots: DEFAULT_STYLE_COLOR_SLOTS,
      recentColors: [],
    });
    expect(first.slots).not.toBe(DEFAULT_STYLE_COLOR_SLOTS);
    expect(first.slots[0]).not.toBe(DEFAULT_STYLE_COLOR_SLOTS[0]);
    expect(second.slots).not.toBe(first.slots);
    expect(canonicalStyleColor("#AABBCC")).toBe("#aabbcc");
    expect(canonicalStyleColor("#abc")).toBeNull();
  });

  it("round-trips ordered slots and recent colors through a versioned envelope", () => {
    const source = {
      slots: [
        { id: "primary", color: "#AABBCC" },
        { id: "secondary", color: "#102030" },
      ],
      recentColors: ["#FEDCBA", "#123456"],
    };

    const parsed = parseStyleColorPalette(serializeStyleColorPalette(source));
    expect(parsed).toEqual({
      slots: [
        { id: "primary", color: "#aabbcc" },
        { id: "secondary", color: "#102030" },
      ],
      recentColors: ["#fedcba", "#123456"],
    });
  });

  it.each([
    ["malformed JSON", "{"],
    ["wrong version", JSON.stringify({
      version: 2,
      slots: [{ id: "one", color: "#112233" }],
      recentColors: [],
    })],
    ["missing recents", JSON.stringify({
      version: 1,
      slots: [{ id: "one", color: "#112233" }],
    })],
    ["unknown envelope field", JSON.stringify({
      version: 1,
      slots: [{ id: "one", color: "#112233" }],
      recentColors: [],
      future: true,
    })],
    ["unknown slot field", JSON.stringify({
      version: 1,
      slots: [{ id: "one", color: "#112233", label: "future" }],
      recentColors: [],
    })],
    ["empty slots", serialized([])],
    ["duplicate IDs", serialized([
      { id: "same", color: "#112233" },
      { id: "same", color: "#445566" },
    ])],
    ["invalid ID", serialized([{ id: "bad id", color: "#112233" }])],
    ["invalid color", serialized([{ id: "one", color: "red" }])],
    ["duplicate canonical recents", serialized(
      [{ id: "one", color: "#112233" }],
      ["#AABBCC", "#aabbcc"],
    )],
  ])("fails the complete %s envelope closed", (_name, value) => {
    expect(parseStyleColorPalette(value)).toEqual({
      slots: DEFAULT_STYLE_COLOR_SLOTS,
      recentColors: [],
    });
  });

  it("rejects count limits and serialized input above 64 KiB", () => {
    const tooManySlots = Array.from(
      { length: STYLE_COLOR_PALETTE_MAX_COUNT + 1 },
      (_, index) => ({ id: `slot-${index}`, color: "#123456" }),
    );
    const tooManyRecents = Array.from(
      { length: STYLE_COLOR_PALETTE_RECENT_MAX_COUNT + 1 },
      (_, index) => `#00000${index}`,
    );

    expect(parseStyleColorPalette(serialized(tooManySlots)).slots)
      .toEqual(DEFAULT_STYLE_COLOR_SLOTS);
    expect(parseStyleColorPalette(serialized(
      [{ id: "one", color: "#112233" }],
      tooManyRecents,
    )).slots).toEqual(DEFAULT_STYLE_COLOR_SLOTS);
    expect(parseStyleColorPalette(`${serialized()}${" ".repeat(64 * 1024)}`).slots)
      .toEqual(DEFAULT_STYLE_COLOR_SLOTS);
  });

  it("creates a canonical slot with the first available stable custom ID", () => {
    const slots = [
      { id: "custom-1", color: "#111111" },
      { id: "kept", color: "#222222" },
      { id: "custom-3", color: "#333333" },
    ];

    expect(createStyleColorSlot(slots, "#ABCDEF")).toEqual({
      id: "custom-2",
      color: "#abcdef",
    });
    expect(createStyleColorSlot(slots)).toEqual({
      id: "custom-2",
      color: "#333333",
    });
    expect(createStyleColorSlot(slots, "not-a-color")).toBeNull();
  });

  it("refuses additions at the maximum slot count", () => {
    const slots = Array.from(
      { length: STYLE_COLOR_PALETTE_MAX_COUNT },
      (_, index) => ({ id: `slot-${index}`, color: "#123456" }),
    );
    expect(createStyleColorSlot(slots, "#abcdef")).toBeNull();
  });

  it("changes color without changing slot identity or mutating input", () => {
    const slots = [
      { id: "one", color: "#111111" },
      { id: "two", color: "#222222" },
    ];
    const changed = changeStyleColorSlot(slots, "one", "#ABCDEF");

    expect(changed).toEqual([
      { id: "one", color: "#abcdef" },
      { id: "two", color: "#222222" },
    ]);
    expect(changed).not.toBe(slots);
    expect(changed[1]).toBe(slots[1]);
    expect(changeStyleColorSlot(slots, "missing", "#abcdef")).toBe(slots);
    expect(changeStyleColorSlot(slots, "one", "invalid")).toBe(slots);
  });

  it("deletes only an existing slot while preserving the final slot", () => {
    const slots = [
      { id: "one", color: "#111111" },
      { id: "two", color: "#222222" },
    ];
    const remaining = deleteStyleColorSlot(slots, "one");

    expect(remaining).toEqual([{ id: "two", color: "#222222" }]);
    expect(deleteStyleColorSlot(remaining, "two")).toBe(remaining);
    expect(deleteStyleColorSlot(slots, "missing")).toBe(slots);
  });

  it("moves a stable slot to a final bounded index without mutating input", () => {
    const slots = [
      { id: "one", color: "#111111" },
      { id: "two", color: "#222222" },
      { id: "three", color: "#333333" },
    ];

    expect(moveStyleColorSlot(slots, "one", 99).map((slot) => slot.id))
      .toEqual(["two", "three", "one"]);
    expect(slots.map((slot) => slot.id)).toEqual(["one", "two", "three"]);
    expect(moveStyleColorSlot(slots, "two", 1)).toBe(slots);
    expect(moveStyleColorSlot(slots, "missing", 0)).toBe(slots);
    expect(moveStyleColorSlot(slots, "one", 1.5)).toBe(slots);
  });

  it("deduplicates, canonicalizes, orders, and caps recent colors", () => {
    let recent: readonly string[] = [];
    for (let index = 0; index < 10; index += 1) {
      recent = rememberRecentStyleColor(
        recent,
        `#0000${index.toString(16).padStart(2, "0")}`,
      );
    }
    expect(recent).toHaveLength(STYLE_COLOR_PALETTE_RECENT_MAX_COUNT);
    expect(recent[0]).toBe("#000009");
    expect(recent.at(-1)).toBe("#000002");

    const promoted = rememberRecentStyleColor(recent, "#000005");
    expect(promoted[0]).toBe("#000005");
    expect(promoted.filter((color) => color === "#000005")).toHaveLength(1);
    expect(rememberRecentStyleColor(promoted, "invalid")).toBe(promoted);
    expect(rememberRecentStyleColor(promoted, "#000005")).toBe(promoted);
  });

  it("keeps favorites out of recents without letting them evict useful colors", () => {
    const slots = [
      { id: "favorite", color: "#112233" },
      { id: "second-favorite", color: "#445566" },
    ];
    const recent = ["#112233", "#abcdef", "#445566", "#123456"];

    expect(rememberRecentStyleColor(recent, "#112233", slots)).toEqual([
      "#abcdef",
      "#123456",
    ]);
    expect(rememberRecentStyleColor(recent, "#fedcba", slots)).toEqual([
      "#fedcba",
      "#abcdef",
      "#123456",
    ]);
    expect(parseStyleColorPalette(serialized(slots, recent))).toEqual({
      slots,
      recentColors: ["#abcdef", "#123456"],
    });
  });

  it("loads and persists through the versioned key", () => {
    const values = new Map<string, string>();
    const storage: StyleColorPaletteStorage = {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
    };
    const state = {
      slots: [{ id: "one", color: "#ABCDEF" }],
      recentColors: ["#123456"],
    };

    expect(persistStyleColorPalette(storage, state)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(
      STYLE_COLOR_PALETTE_STORAGE_KEY,
      expect.any(String),
    );
    expect(loadStyleColorPalette(storage)).toEqual({
      slots: [{ id: "one", color: "#abcdef" }],
      recentColors: ["#123456"],
    });
  });

  it("falls back safely when storage is absent or throws", () => {
    const throwingStorage: StyleColorPaletteStorage = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("quota");
      }),
    };
    const state = parseStyleColorPalette(null);

    expect(loadStyleColorPalette(null)).toEqual(state);
    expect(loadStyleColorPalette(throwingStorage)).toEqual(state);
    expect(persistStyleColorPalette(null, state)).toBe(false);
    expect(persistStyleColorPalette(throwingStorage, state)).toBe(false);
  });
});
