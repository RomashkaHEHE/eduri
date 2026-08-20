import { describe, expect, it } from "vitest";
import { loadToolStylePresets } from "./toolStylePresets";
import {
  TOOL_STYLE_PALETTE_MAX_COUNT,
  activeToolStylePreset,
  addToolStylePreset,
  deleteToolStylePreset,
  loadToolStylePalettes,
  moveToolStylePreset,
  patchToolStylePreset,
  selectToolStylePreset,
  serializeToolStylePalettes,
} from "./toolStylePalettes";

describe("tool style palettes", () => {
  it("migrates the legacy Arrow creation style into the first active preset", () => {
    const legacy = loadToolStylePresets(null);
    const customized = {
      ...legacy,
      arrow: {
        ...legacy.arrow,
        stroke: "#abcdef",
        strokeWidth: 7.5,
      },
    };

    const palettes = loadToolStylePalettes(null, customized);
    expect(activeToolStylePreset(palettes, "arrow").style).toMatchObject({
      stroke: "#abcdef",
      strokeWidth: 7.5,
    });
    expect(palettes.arrow.presets).toHaveLength(6);
  });

  it("selects, edits, adds, moves, and deletes presets independently", () => {
    const legacy = loadToolStylePresets(null);
    let palettes = loadToolStylePalettes(null, legacy);
    palettes = selectToolStylePreset(palettes, "arrow", "red");
    palettes = patchToolStylePreset(palettes, "arrow", "red", {
      stroke: "#abcdef",
      strokeWidth: 12.5,
      opacity: 0.73,
      dash: [12, 4],
    });
    expect(activeToolStylePreset(palettes, "arrow").style).toMatchObject({
      stroke: "#abcdef",
      strokeWidth: 12.5,
      opacity: 0.73,
      dash: [12, 4],
    });

    const added = addToolStylePreset(palettes, "arrow");
    expect(added.presetId).toBe("custom-1");
    palettes = added.palettes;
    palettes = moveToolStylePreset(palettes, "arrow", "custom-1", 0);
    expect(palettes.arrow.presets[0].id).toBe("custom-1");
    palettes = deleteToolStylePreset(palettes, "arrow", "red");
    expect(palettes.arrow.activePresetId).not.toBe("red");
  });

  it("round-trips bounded normalized palettes and rejects malformed storage", () => {
    const legacy = loadToolStylePresets(null);
    let palettes = loadToolStylePalettes(null, legacy);
    palettes = patchToolStylePreset(palettes, "arrow", "graphite", {
      stroke: "#abcdef",
      strokeWidth: 37.5,
      dash: [10, 4],
    });
    const restored = loadToolStylePalettes(
      serializeToolStylePalettes(palettes),
      legacy,
    );
    expect(activeToolStylePreset(restored, "arrow").style).toMatchObject({
      stroke: "#abcdef",
      strokeWidth: 37.5,
      dash: [10, 4],
    });

    const malformed = JSON.stringify({
      version: 1,
      palettes: {
        arrow: {
          activePresetId: "missing",
          presets: Array.from({ length: TOOL_STYLE_PALETTE_MAX_COUNT + 1 },
            (_, index) => ({ id: `p-${index}`, style: {} })),
        },
      },
    });
    const fallback = loadToolStylePalettes(malformed, legacy);
    expect(fallback.arrow.activePresetId).toBe("graphite");
    expect(fallback.arrow.presets).toHaveLength(6);
  });
});
