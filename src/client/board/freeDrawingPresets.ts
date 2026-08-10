export interface FreeDrawingPreset {
  readonly id: string;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly opacity: number;
}

export type FreeDrawingPresetPatch = Partial<
  Pick<FreeDrawingPreset, "stroke" | "strokeWidth" | "opacity">
>;

export const FREE_DRAWING_PRESETS_STORAGE_KEY =
  "eduri-board-free-drawing-presets-v2";
// Keep the legacy key read-only so current six-slot presets survive migration
// and an older rollback cannot overwrite the variable-length v2 palette.
export const LEGACY_FREE_DRAWING_PRESETS_STORAGE_KEY =
  "eduri-board-handwriting-presets-v1";
export const FREE_DRAWING_PRESET_MIN_COUNT = 1;
export const FREE_DRAWING_PRESET_MAX_COUNT = 24;
export const FREE_DRAWING_STROKE_WIDTH_MIN = 0.5;
export const FREE_DRAWING_STROKE_WIDTH_MAX = 16;
export const FREE_DRAWING_STROKE_WIDTH_STEP = 0.5;
export const FREE_DRAWING_OPACITY_MIN = 0;
export const FREE_DRAWING_OPACITY_MAX = 1;
export const FREE_DRAWING_OPACITY_STEP = 0.01;

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;
const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/iu;
const FREE_DRAWING_PRESETS_STORAGE_VERSION = 2;
const FREE_DRAWING_PRESETS_MAX_SERIALIZED_LENGTH = 64 * 1024;
const NEW_FREE_DRAWING_PRESET = {
  stroke: "#7c3aed",
  strokeWidth: 2.5,
  opacity: 1,
} as const;

export const DEFAULT_FREE_DRAWING_PRESETS: readonly FreeDrawingPreset[] = [
  { id: "graphite", stroke: "#17212b", strokeWidth: 2.5, opacity: 1 },
  { id: "red", stroke: "#d33f49", strokeWidth: 2.5, opacity: 1 },
  { id: "blue", stroke: "#2563eb", strokeWidth: 2.5, opacity: 1 },
  { id: "green", stroke: "#16825d", strokeWidth: 2.5, opacity: 1 },
  { id: "orange", stroke: "#d97706", strokeWidth: 2.5, opacity: 1 },
  { id: "yellow", stroke: "#ffd43b", strokeWidth: 16, opacity: 0.38 },
];

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function normalizeStroke(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value)
    ? value.toLowerCase()
    : fallback;
}

function normalizeStrokeWidth(value: unknown, fallback: number): number {
  const bounded = Math.max(
    FREE_DRAWING_STROKE_WIDTH_MIN,
    Math.min(
      FREE_DRAWING_STROKE_WIDTH_MAX,
      finiteNumber(value, fallback),
    ),
  );
  return Math.round(bounded / FREE_DRAWING_STROKE_WIDTH_STEP)
    * FREE_DRAWING_STROKE_WIDTH_STEP;
}

function normalizeOpacity(value: unknown, fallback: number): number {
  const bounded = Math.max(
    FREE_DRAWING_OPACITY_MIN,
    Math.min(FREE_DRAWING_OPACITY_MAX, finiteNumber(value, fallback)),
  );
  return Math.round(bounded * 100) / 100;
}

function copyDefaults(): FreeDrawingPreset[] {
  return DEFAULT_FREE_DRAWING_PRESETS.map((preset) => ({ ...preset }));
}

function parseStoredJson(serialized: string | null): unknown {
  if (
    !serialized
    || serialized.length > FREE_DRAWING_PRESETS_MAX_SERIALIZED_LENGTH
  ) {
    return null;
  }
  try {
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

function parseLegacyFreeDrawingPresets(parsed: unknown): FreeDrawingPreset[] | null {
  if (
    !Array.isArray(parsed)
    || parsed.length !== DEFAULT_FREE_DRAWING_PRESETS.length
  ) {
    return null;
  }
  return DEFAULT_FREE_DRAWING_PRESETS.map((fallback, index) => {
    const value = parsed[index];
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
    ) {
      return { ...fallback };
    }
    const record = value as Record<string, unknown>;
    return {
      id: fallback.id,
      stroke: normalizeStroke(record.stroke, fallback.stroke),
      strokeWidth: normalizeStrokeWidth(
        record.strokeWidth,
        fallback.strokeWidth,
      ),
      opacity: normalizeOpacity(record.opacity, fallback.opacity),
    };
  });
}

function nextAvailablePresetId(usedIds: ReadonlySet<string>): string {
  for (let sequence = 1; sequence <= FREE_DRAWING_PRESET_MAX_COUNT + 1; sequence += 1) {
    const candidate = `custom-${sequence}`;
    if (!usedIds.has(candidate)) return candidate;
  }
  return `custom-${FREE_DRAWING_PRESET_MAX_COUNT + 2}`;
}

function parseV2FreeDrawingPresets(parsed: unknown): FreeDrawingPreset[] | null {
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
  ) {
    return null;
  }
  const envelope = parsed as Record<string, unknown>;
  if (
    envelope.version !== FREE_DRAWING_PRESETS_STORAGE_VERSION
    || !Array.isArray(envelope.presets)
    || envelope.presets.length < FREE_DRAWING_PRESET_MIN_COUNT
    || envelope.presets.length > FREE_DRAWING_PRESET_MAX_COUNT
  ) {
    return null;
  }

  const presets: FreeDrawingPreset[] = [];
  const usedIds = new Set<string>();
  for (
    let index = 0;
    index < envelope.presets.length;
    index += 1
  ) {
    const value = envelope.presets[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const fallback = DEFAULT_FREE_DRAWING_PRESETS[index]
      ?? NEW_FREE_DRAWING_PRESET;
    if (
      typeof record.id !== "string"
      || !PRESET_ID_PATTERN.test(record.id)
      || usedIds.has(record.id)
    ) {
      return null;
    }
    const id = record.id;
    usedIds.add(id);
    presets.push({
      id,
      stroke: normalizeStroke(record.stroke, fallback.stroke),
      strokeWidth: normalizeStrokeWidth(
        record.strokeWidth,
        fallback.strokeWidth,
      ),
      opacity: normalizeOpacity(record.opacity, fallback.opacity),
    });
  }
  return presets.length >= FREE_DRAWING_PRESET_MIN_COUNT ? presets : null;
}

export function parseFreeDrawingPresets(
  serialized: string | null,
): FreeDrawingPreset[] {
  const parsed = parseStoredJson(serialized);
  return parseV2FreeDrawingPresets(parsed)
    ?? parseLegacyFreeDrawingPresets(parsed)
    ?? copyDefaults();
}

export function loadFreeDrawingPresets(
  serializedV2: string | null,
  serializedLegacy: string | null,
): FreeDrawingPreset[] {
  return parseV2FreeDrawingPresets(parseStoredJson(serializedV2))
    ?? parseLegacyFreeDrawingPresets(parseStoredJson(serializedLegacy))
    ?? copyDefaults();
}

export function serializeFreeDrawingPresets(
  presets: readonly FreeDrawingPreset[],
): string {
  return JSON.stringify({
    version: FREE_DRAWING_PRESETS_STORAGE_VERSION,
    presets: presets.slice(0, FREE_DRAWING_PRESET_MAX_COUNT),
  });
}

export function createFreeDrawingPreset(
  presets: readonly FreeDrawingPreset[],
  source: FreeDrawingPreset | undefined = presets[0],
): FreeDrawingPreset | null {
  if (presets.length >= FREE_DRAWING_PRESET_MAX_COUNT) return null;
  const usedIds = new Set(presets.map((preset) => preset.id));
  return {
    id: nextAvailablePresetId(usedIds),
    stroke: source?.stroke ?? NEW_FREE_DRAWING_PRESET.stroke,
    strokeWidth: source?.strokeWidth ?? NEW_FREE_DRAWING_PRESET.strokeWidth,
    opacity: source?.opacity ?? NEW_FREE_DRAWING_PRESET.opacity,
  };
}

export function deleteFreeDrawingPreset(
  presets: readonly FreeDrawingPreset[],
  presetId: string,
): readonly FreeDrawingPreset[] {
  if (presets.length <= FREE_DRAWING_PRESET_MIN_COUNT) return presets;
  const index = presets.findIndex((preset) => preset.id === presetId);
  if (index < 0) return presets;
  return presets.filter((preset) => preset.id !== presetId);
}

export function moveFreeDrawingPreset(
  presets: readonly FreeDrawingPreset[],
  presetId: string,
  targetIndex: number,
): readonly FreeDrawingPreset[] {
  const sourceIndex = presets.findIndex((preset) => preset.id === presetId);
  if (
    sourceIndex < 0
    || !Number.isInteger(targetIndex)
  ) {
    return presets;
  }
  const boundedTargetIndex = Math.max(
    0,
    Math.min(presets.length - 1, targetIndex),
  );
  if (sourceIndex === boundedTargetIndex) return presets;
  const next = [...presets];
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(boundedTargetIndex, 0, moved);
  return next;
}

export function patchFreeDrawingPreset(
  preset: FreeDrawingPreset,
  patch: FreeDrawingPresetPatch,
): FreeDrawingPreset {
  return {
    id: preset.id,
    stroke: normalizeStroke(patch.stroke, preset.stroke),
    strokeWidth: normalizeStrokeWidth(
      patch.strokeWidth,
      preset.strokeWidth,
    ),
    opacity: normalizeOpacity(patch.opacity, preset.opacity),
  };
}

export function freeDrawingPresetStyle(
  preset: FreeDrawingPreset,
): Readonly<Record<string, unknown>> {
  return {
    stroke: preset.stroke,
    strokeWidth: preset.strokeWidth,
    opacity: preset.opacity,
    dash: [],
    blendMode: "source-over",
  };
}
