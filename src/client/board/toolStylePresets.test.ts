import { describe, expect, it, vi } from "vitest";
import { defaultBoardToolStyle } from "./rendering/toolStyles";
import {
  PERSISTED_TOOL_STYLE_TOOLS,
  TOOL_STYLE_PRESETS_STORAGE_KEY,
  defaultToolStylePresets,
  loadToolStylePresets,
  persistToolStylePresets,
  serializeToolStylePresets,
} from "./toolStylePresets";

describe("ordinary board tool-style persistence", () => {
  it("restores fresh defaults when storage is absent, malformed, or oversized", () => {
    const expected = defaultToolStylePresets();
    expect(loadToolStylePresets(null)).toEqual(expected);
    expect(loadToolStylePresets("not json")).toEqual(expected);
    expect(loadToolStylePresets(JSON.stringify({ version: 2, styles: {} })))
      .toEqual(expected);
    expect(loadToolStylePresets("x".repeat(64 * 1024 + 1))).toEqual(expected);

    const first = loadToolStylePresets(null);
    const second = loadToolStylePresets(null);
    expect(first).not.toBe(second);
    expect(first.line).not.toBe(second.line);
    expect(first.line?.dash).not.toBe(second.line?.dash);
  });

  it("round-trips arbitrary renderer-safe styles and normalizes their spelling", () => {
    const serialized = serializeToolStylePresets({
      text: {
        fill: "#AbC",
        fontSize: 999,
        fontFamily: '  "Noto Sans" , serif  ',
        fontStyle: "italic bold",
        opacity: 0.01,
      },
      line: {
        stroke: "rgba(1, 2, 003, .4)",
        strokeWidth: 200,
        opacity: 2,
        dash: [11.5, 3, 1, 3],
      },
      arrow: {
        stroke: "rgb(012, 34, 56)",
        strokeWidth: 0.1,
        opacity: 0.75,
        dash: [8, 6],
      },
      rectangle: {
        stroke: "#1234",
        fill: "#12345678",
        strokeWidth: 3.25,
        opacity: 0.6,
        dash: [],
      },
    });
    const loaded = loadToolStylePresets(serialized);

    expect(loaded.text).toEqual({
      fill: "#abc",
      opacity: 0.05,
      fontSize: 256,
      fontFamily: '"Noto Sans", serif',
      fontStyle: "bold italic",
    });
    expect(loaded.line).toEqual({
      stroke: "rgba(1,2,3,0.4)",
      strokeWidth: 96,
      opacity: 1,
      dash: [11.5, 3, 1, 3],
    });
    expect(loaded.arrow).toEqual({
      stroke: "rgb(12,34,56)",
      strokeWidth: 0.5,
      opacity: 0.75,
      dash: [8, 6],
    });
    expect(loaded.rectangle).toEqual({
      stroke: "#1234",
      fill: "#12345678",
      strokeWidth: 3.25,
      opacity: 0.6,
      dash: [],
    });
    expect(Object.keys(loaded)).toEqual(PERSISTED_TOOL_STYLE_TOOLS);
  });

  it("falls back per scalar for unsafe values while preserving the envelope", () => {
    const styles = defaultToolStylePresets();
    const envelope = JSON.parse(serializeToolStylePresets(styles)) as {
      styles: Record<string, Record<string, unknown>>;
    };
    envelope.styles.text = {
      fill: "url(javascript:alert(1))",
      opacity: Number.NaN,
      fontSize: "huge",
      fontFamily: "Inter; color: red",
      fontStyle: "bold oblique",
    };
    envelope.styles.line = {
      stroke: "rgb(999,0,0)",
      strokeWidth: null,
      opacity: null,
      dash: [1, -2, 3],
    };
    const loaded = loadToolStylePresets(JSON.stringify(envelope));

    expect(loaded.text).toEqual(defaultBoardToolStyle("text"));
    expect(loaded.line).toEqual(defaultBoardToolStyle("line"));
  });

  it("rejects the complete stored value on structural drift", () => {
    const defaults = defaultToolStylePresets();
    const valid = JSON.parse(serializeToolStylePresets(defaults)) as {
      version: number;
      styles: Record<string, Record<string, unknown>>;
    };

    const missingTool = structuredClone(valid);
    delete missingTool.styles.arrow;
    expect(loadToolStylePresets(JSON.stringify(missingTool))).toEqual(defaults);

    const unknownTool = structuredClone(valid);
    unknownTool.styles.pen = {};
    expect(loadToolStylePresets(JSON.stringify(unknownTool))).toEqual(defaults);

    const unknownProperty = structuredClone(valid);
    unknownProperty.styles.line.script = "nope";
    expect(loadToolStylePresets(JSON.stringify(unknownProperty))).toEqual(defaults);

    const nonRecord = structuredClone(valid) as unknown as {
      styles: Record<string, unknown>;
    };
    nonRecord.styles.line = [];
    expect(loadToolStylePresets(JSON.stringify(nonRecord))).toEqual(defaults);
  });

  it("serializes partial input as a complete bounded envelope", () => {
    const parsed = JSON.parse(serializeToolStylePresets({
      line: {
        stroke: "#abcdef",
        unrelated: "discarded",
      },
      pen: {
        stroke: "#ffffff",
      },
    })) as {
      version: number;
      styles: Record<string, Record<string, unknown>>;
    };

    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.styles)).toEqual(PERSISTED_TOOL_STYLE_TOOLS);
    expect(parsed.styles.line.stroke).toBe("#abcdef");
    expect(parsed.styles.line).not.toHaveProperty("unrelated");
    expect(parsed.styles).not.toHaveProperty("pen");
    expect(JSON.stringify(parsed).length).toBeLessThanOrEqual(64 * 1024);
  });

  it("persists under the versioned key and contains storage failures", () => {
    const setItem = vi.fn();
    expect(persistToolStylePresets({ line: { stroke: "#abcdef" } }, {
      setItem,
    })).toBe(true);
    expect(setItem).toHaveBeenCalledOnce();
    expect(setItem.mock.calls[0][0]).toBe(TOOL_STYLE_PRESETS_STORAGE_KEY);
    expect(loadToolStylePresets(setItem.mock.calls[0][1]).line?.stroke)
      .toBe("#abcdef");

    expect(persistToolStylePresets({}, {
      setItem: () => {
        throw new Error("quota");
      },
    })).toBe(false);
  });
});
