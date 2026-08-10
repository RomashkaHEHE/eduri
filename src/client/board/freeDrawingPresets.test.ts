import { describe, expect, it } from "vitest";
import {
  createFreeDrawingPreset,
  DEFAULT_FREE_DRAWING_PRESETS,
  deleteFreeDrawingPreset,
  FREE_DRAWING_PRESET_MAX_COUNT,
  freeDrawingPresetStyle,
  loadFreeDrawingPresets,
  moveFreeDrawingPreset,
  parseFreeDrawingPresets,
  patchFreeDrawingPreset,
  serializeFreeDrawingPresets,
} from "./freeDrawingPresets";

function preset(id: string, stroke = "#123456") {
  return {
    id,
    stroke,
    strokeWidth: 2.5,
    opacity: 1,
  };
}

describe("free-drawing presets", () => {
  it("provides independent drawing slots including a translucent wide preset", () => {
    const presets = parseFreeDrawingPresets(null);

    expect(presets).toHaveLength(6);
    expect(presets.at(-1)).toMatchObject({
      stroke: "#ffd43b",
      strokeWidth: 16,
      opacity: 0.38,
    });
    expect(presets[0]).not.toBe(DEFAULT_FREE_DRAWING_PRESETS[0]);
  });

  it("round-trips ordered variable-length V2 palettes", () => {
    const presets = [
      { ...preset("custom-2", "#abcdef"), opacity: 0 },
      {
        id: "graphite",
        stroke: "#17212b",
        strokeWidth: 7.5,
        opacity: 0.44,
      },
      preset("custom-1", "#fedcba"),
    ];

    const serialized = serializeFreeDrawingPresets(presets);

    expect(JSON.parse(serialized)).toEqual({
      version: 2,
      presets,
    });
    expect(parseFreeDrawingPresets(serialized)).toEqual(presets);
    expect(loadFreeDrawingPresets(serialized, "{broken legacy")).toEqual(
      presets,
    );
  });

  it("loads the legacy six-slot value and migrates it to V2", () => {
    const legacy = DEFAULT_FREE_DRAWING_PRESETS.map((value) => ({ ...value }));
    legacy[1] = {
      id: "spoofed",
      stroke: "#ABCDEF",
      strokeWidth: 999,
      opacity: -1,
    };
    const serializedLegacy = JSON.stringify(legacy);

    const loaded = loadFreeDrawingPresets("{broken V2", serializedLegacy);

    expect(loaded[1]).toEqual({
      id: "red",
      stroke: "#abcdef",
      strokeWidth: 16,
      opacity: 0,
    });
    expect(parseFreeDrawingPresets(serializedLegacy)).toEqual(loaded);

    const migrated = serializeFreeDrawingPresets(loaded);

    expect(JSON.parse(migrated)).toEqual({
      version: 2,
      presets: loaded,
    });
    expect(loadFreeDrawingPresets(migrated, null)).toEqual(loaded);
  });

  it("prefers a valid V2 palette over legacy storage", () => {
    const v2Presets = [preset("v2-only", "#abcdef")];
    const legacy = JSON.stringify(DEFAULT_FREE_DRAWING_PRESETS);

    expect(loadFreeDrawingPresets(
      serializeFreeDrawingPresets(v2Presets),
      legacy,
    )).toEqual(v2Presets);
  });

  it.each([
    {
      caseName: "malformed JSON",
      serialized: "{broken",
    },
    {
      caseName: "a non-object envelope",
      serialized: JSON.stringify("not an envelope"),
    },
    {
      caseName: "an unsupported version",
      serialized: JSON.stringify({
        version: 1,
        presets: [preset("only")],
      }),
    },
    {
      caseName: "a non-array presets field",
      serialized: JSON.stringify({
        version: 2,
        presets: {},
      }),
    },
    {
      caseName: "an empty palette",
      serialized: JSON.stringify({
        version: 2,
        presets: [],
      }),
    },
    {
      caseName: "more than the maximum number of presets",
      serialized: JSON.stringify({
        version: 2,
        presets: Array.from(
          { length: FREE_DRAWING_PRESET_MAX_COUNT + 1 },
          (_, index) => preset(`slot-${index}`),
        ),
      }),
    },
    {
      caseName: "a malformed preset record",
      serialized: JSON.stringify({
        version: 2,
        presets: [null],
      }),
    },
    {
      caseName: "an invalid preset ID",
      serialized: JSON.stringify({
        version: 2,
        presets: [preset("contains spaces")],
      }),
    },
    {
      caseName: "duplicate preset IDs",
      serialized: JSON.stringify({
        version: 2,
        presets: [preset("duplicate"), preset("duplicate", "#abcdef")],
      }),
    },
  ])("rejects $caseName without keeping a partial palette", ({
    serialized,
  }) => {
    expect(parseFreeDrawingPresets(serialized)).toEqual(
      DEFAULT_FREE_DRAWING_PRESETS,
    );
  });

  it("rejects an otherwise valid V2 envelope above 64 KiB", () => {
    const serialized = JSON.stringify({
      version: 2,
      presets: [preset("oversized", "#abcdef")],
      padding: "x".repeat(64 * 1024),
    });

    expect(serialized.length).toBeGreaterThan(64 * 1024);
    expect(parseFreeDrawingPresets(serialized)).toEqual(
      DEFAULT_FREE_DRAWING_PRESETS,
    );
  });

  it("normalizes V2 style fields without changing valid IDs or order", () => {
    const stored = DEFAULT_FREE_DRAWING_PRESETS.map((value) => ({ ...value }));
    stored[0] = {
      id: "normalized",
      stroke: "#ABCDEF",
      strokeWidth: 7.26,
      opacity: 0.444,
    };
    stored[1] = {
      id: "bounded",
      stroke: "#123456",
      strokeWidth: -100,
      opacity: 9,
    };
    const serialized = JSON.stringify({
      version: 2,
      presets: [
        ...stored,
        {
          id: "custom-1",
          stroke: "invalid",
          strokeWidth: "wide",
          opacity: null,
        },
      ],
    });

    const parsed = parseFreeDrawingPresets(serialized);

    expect(parsed.map(({ id }) => id)).toEqual([
      "normalized",
      "bounded",
      "blue",
      "green",
      "orange",
      "yellow",
      "custom-1",
    ]);
    expect(parsed[0]).toEqual({
      id: "normalized",
      stroke: "#abcdef",
      strokeWidth: 7.5,
      opacity: 0.44,
    });
    expect(parsed[1]).toEqual({
      id: "bounded",
      stroke: "#123456",
      strokeWidth: 0.5,
      opacity: 1,
    });
    expect(parsed[6]).toEqual({
      id: "custom-1",
      stroke: "#7c3aed",
      strokeWidth: 2.5,
      opacity: 1,
    });
  });

  it("serializes at most the supported number of presets", () => {
    const presets = Array.from(
      { length: FREE_DRAWING_PRESET_MAX_COUNT + 1 },
      (_, index) => preset(`slot-${index}`),
    );

    const envelope = JSON.parse(serializeFreeDrawingPresets(presets)) as {
      presets: unknown[];
    };

    expect(envelope.presets).toHaveLength(FREE_DRAWING_PRESET_MAX_COUNT);
    expect(parseFreeDrawingPresets(
      serializeFreeDrawingPresets(presets),
    )).toHaveLength(FREE_DRAWING_PRESET_MAX_COUNT);
  });

  it("adds a cloned preset with the first available deterministic ID", () => {
    const presets = [
      preset("graphite", "#111111"),
      preset("custom-1", "#222222"),
      preset("custom-3", "#333333"),
    ];
    const before = structuredClone(presets);

    const created = createFreeDrawingPreset(presets, presets[2]);

    expect(created).toEqual({
      ...presets[2],
      id: "custom-2",
    });
    expect(created).not.toBe(presets[2]);
    expect(presets).toEqual(before);
  });

  it("uses safe defaults for an empty palette and refuses to exceed the maximum", () => {
    expect(createFreeDrawingPreset([])).toEqual({
      id: "custom-1",
      stroke: "#7c3aed",
      strokeWidth: 2.5,
      opacity: 1,
    });

    const full = Array.from(
      { length: FREE_DRAWING_PRESET_MAX_COUNT },
      (_, index) => preset(`slot-${index}`),
    );
    expect(createFreeDrawingPreset(full, full[0])).toBeNull();
  });

  it("deletes only an existing preset while preserving the minimum", () => {
    const presets = [preset("first"), preset("second"), preset("third")];
    const before = structuredClone(presets);

    const deleted = deleteFreeDrawingPreset(presets, "second");

    expect(deleted.map(({ id }) => id)).toEqual(["first", "third"]);
    expect(deleted).not.toBe(presets);
    expect(presets).toEqual(before);
    expect(deleteFreeDrawingPreset(presets, "missing")).toBe(presets);

    const onlyPreset = [preset("only")];
    expect(deleteFreeDrawingPreset(onlyPreset, "only")).toBe(onlyPreset);
  });

  it("moves presets by final index without mutating the input", () => {
    const presets = [
      preset("first"),
      preset("second"),
      preset("third"),
      preset("fourth"),
    ];
    const before = structuredClone(presets);

    expect(moveFreeDrawingPreset(presets, "second", 3).map(({ id }) => id))
      .toEqual(["first", "third", "fourth", "second"]);
    expect(moveFreeDrawingPreset(presets, "fourth", 1).map(({ id }) => id))
      .toEqual(["first", "fourth", "second", "third"]);
    expect(moveFreeDrawingPreset(presets, "second", -100).map(({ id }) => id))
      .toEqual(["second", "first", "third", "fourth"]);
    expect(moveFreeDrawingPreset(presets, "second", 100).map(({ id }) => id))
      .toEqual(["first", "third", "fourth", "second"]);
    expect(presets).toEqual(before);
  });

  it("returns the original palette for no-op or invalid moves", () => {
    const presets = [preset("first"), preset("second")];

    expect(moveFreeDrawingPreset(presets, "first", 0)).toBe(presets);
    expect(moveFreeDrawingPreset(presets, "missing", 1)).toBe(presets);
    expect(moveFreeDrawingPreset(presets, "first", 0.5)).toBe(presets);
    expect(moveFreeDrawingPreset(presets, "first", Number.NaN)).toBe(presets);
  });

  it("normalizes patches and always creates a solid source-over style", () => {
    const updated = patchFreeDrawingPreset(DEFAULT_FREE_DRAWING_PRESETS[0], {
      stroke: "#123456",
      strokeWidth: 7.26,
      opacity: 0.444,
    });

    expect(updated).toEqual({
      id: "graphite",
      stroke: "#123456",
      strokeWidth: 7.5,
      opacity: 0.44,
    });
    expect(freeDrawingPresetStyle(updated)).toEqual({
      stroke: "#123456",
      strokeWidth: 7.5,
      opacity: 0.44,
      dash: [],
      blendMode: "source-over",
    });
  });

  it("preserves full transparency and clamps negative opacity to zero", () => {
    const transparent = patchFreeDrawingPreset(
      DEFAULT_FREE_DRAWING_PRESETS[0],
      { opacity: 0 },
    );
    const hostile = patchFreeDrawingPreset(
      DEFAULT_FREE_DRAWING_PRESETS[0],
      { opacity: -1 },
    );

    expect(transparent.opacity).toBe(0);
    expect(hostile.opacity).toBe(0);
    expect(parseFreeDrawingPresets(
      serializeFreeDrawingPresets([transparent]),
    )[0].opacity).toBe(0);
    expect(freeDrawingPresetStyle(transparent).opacity).toBe(0);
  });
});
