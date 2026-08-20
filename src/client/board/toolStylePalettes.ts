import { DEFAULT_FREE_DRAWING_PRESETS } from "./freeDrawingPresets";
import {
  boardToolStyleKeys,
  type BoardToolStyleKey,
} from "./rendering/toolStyles";
import {
  normalizeToolStyle,
  type BoardToolStyles,
  type PersistedToolStyleTool,
} from "./toolStylePresets";

export const TOOL_STYLE_PALETTES_STORAGE_KEY =
  "eduri-board-tool-style-palettes-v1";
export const TOOL_STYLE_PALETTE_MIN_COUNT = 1;
export const TOOL_STYLE_PALETTE_MAX_COUNT = 24;

export const TOOL_STYLE_PALETTE_TARGETS = [
  "arrow",
] as const satisfies readonly PersistedToolStyleTool[];

export type ToolStylePaletteTarget =
  (typeof TOOL_STYLE_PALETTE_TARGETS)[number];

export interface ToolStylePalettePreset {
  readonly id: string;
  readonly style: Readonly<Record<string, unknown>>;
}

export interface ToolStylePalette {
  readonly presets: readonly ToolStylePalettePreset[];
  readonly activePresetId: string;
}

export type ToolStylePalettes = Readonly<
  Record<ToolStylePaletteTarget, ToolStylePalette>
>;

const STORAGE_VERSION = 1;
const MAX_SERIALIZED_LENGTH = 256 * 1024;
const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function initialPalette(
  target: ToolStylePaletteTarget,
  legacyStyles: BoardToolStyles,
): ToolStylePalette {
  const current = normalizeToolStyle(target, legacyStyles[target]);
  const presets = DEFAULT_FREE_DRAWING_PRESETS.map((source, index) => ({
    id: source.id,
    style: normalizeToolStyle(target, index === 0
      ? current
      : { ...current, stroke: source.stroke }),
  }));
  return { presets, activePresetId: presets[0].id };
}

export function defaultToolStylePalettes(
  legacyStyles: BoardToolStyles,
): ToolStylePalettes {
  return Object.fromEntries(TOOL_STYLE_PALETTE_TARGETS.map((target) => [
    target,
    initialPalette(target, legacyStyles),
  ])) as ToolStylePalettes;
}

function parsePalette(
  target: ToolStylePaletteTarget,
  value: unknown,
): ToolStylePalette | null {
  if (
    !isRecord(value)
    || !Array.isArray(value.presets)
    || value.presets.length < TOOL_STYLE_PALETTE_MIN_COUNT
    || value.presets.length > TOOL_STYLE_PALETTE_MAX_COUNT
    || typeof value.activePresetId !== "string"
  ) {
    return null;
  }
  const ids = new Set<string>();
  const presets: ToolStylePalettePreset[] = [];
  for (const candidate of value.presets) {
    if (
      !isRecord(candidate)
      || typeof candidate.id !== "string"
      || !PRESET_ID_PATTERN.test(candidate.id)
      || ids.has(candidate.id)
      || !isRecord(candidate.style)
      || Object.keys(candidate.style).some((property) =>
        !boardToolStyleKeys(target).includes(property as BoardToolStyleKey))
    ) {
      return null;
    }
    ids.add(candidate.id);
    presets.push({
      id: candidate.id,
      style: normalizeToolStyle(target, candidate.style),
    });
  }
  if (!ids.has(value.activePresetId)) return null;
  return { presets, activePresetId: value.activePresetId };
}

export function loadToolStylePalettes(
  serialized: string | null,
  legacyStyles: BoardToolStyles,
): ToolStylePalettes {
  if (!serialized || serialized.length > MAX_SERIALIZED_LENGTH) {
    return defaultToolStylePalettes(legacyStyles);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return defaultToolStylePalettes(legacyStyles);
  }
  if (
    !isRecord(parsed)
    || parsed.version !== STORAGE_VERSION
    || !isRecord(parsed.palettes)
    || Object.keys(parsed.palettes).length !== TOOL_STYLE_PALETTE_TARGETS.length
  ) {
    return defaultToolStylePalettes(legacyStyles);
  }
  const palettes: Partial<Record<ToolStylePaletteTarget, ToolStylePalette>> = {};
  for (const target of TOOL_STYLE_PALETTE_TARGETS) {
    const palette = parsePalette(target, parsed.palettes[target]);
    if (!palette) return defaultToolStylePalettes(legacyStyles);
    palettes[target] = palette;
  }
  return palettes as ToolStylePalettes;
}

export function serializeToolStylePalettes(
  palettes: ToolStylePalettes,
): string {
  return JSON.stringify({
    version: STORAGE_VERSION,
    palettes: Object.fromEntries(TOOL_STYLE_PALETTE_TARGETS.map((target) => {
      const palette = palettes[target];
      return [target, {
        activePresetId: palette.activePresetId,
        presets: palette.presets.slice(0, TOOL_STYLE_PALETTE_MAX_COUNT).map(
          (preset) => ({
            id: preset.id,
            style: normalizeToolStyle(target, preset.style),
          }),
        ),
      }];
    })),
  });
}

function updateTarget(
  palettes: ToolStylePalettes,
  target: ToolStylePaletteTarget,
  update: (palette: ToolStylePalette) => ToolStylePalette,
): ToolStylePalettes {
  const current = palettes[target];
  const next = update(current);
  return next === current ? palettes : { ...palettes, [target]: next };
}

export function selectToolStylePreset(
  palettes: ToolStylePalettes,
  target: ToolStylePaletteTarget,
  presetId: string,
): ToolStylePalettes {
  return updateTarget(palettes, target, (palette) =>
    palette.activePresetId !== presetId
      && palette.presets.some((preset) => preset.id === presetId)
      ? { ...palette, activePresetId: presetId }
      : palette);
}

export function patchToolStylePreset(
  palettes: ToolStylePalettes,
  target: ToolStylePaletteTarget,
  presetId: string,
  patch: Readonly<Record<string, unknown>>,
): ToolStylePalettes {
  return updateTarget(palettes, target, (palette) => {
    let changed = false;
    const presets = palette.presets.map((preset) => {
      if (preset.id !== presetId) return preset;
      const style = normalizeToolStyle(target, { ...preset.style, ...patch });
      if (JSON.stringify(style) === JSON.stringify(preset.style)) return preset;
      changed = true;
      return { ...preset, style };
    });
    return changed ? { ...palette, presets } : palette;
  });
}

function nextPresetId(presets: readonly ToolStylePalettePreset[]): string {
  const ids = new Set(presets.map((preset) => preset.id));
  for (let index = 1; index <= TOOL_STYLE_PALETTE_MAX_COUNT + 1; index += 1) {
    const id = `custom-${index}`;
    if (!ids.has(id)) return id;
  }
  return `custom-${TOOL_STYLE_PALETTE_MAX_COUNT + 2}`;
}

export function addToolStylePreset(
  palettes: ToolStylePalettes,
  target: ToolStylePaletteTarget,
): Readonly<{ palettes: ToolStylePalettes; presetId: string | null }> {
  const palette = palettes[target];
  if (palette.presets.length >= TOOL_STYLE_PALETTE_MAX_COUNT) {
    return { palettes, presetId: null };
  }
  const source = palette.presets.find(
    (preset) => preset.id === palette.activePresetId,
  ) ?? palette.presets[0];
  const presetId = nextPresetId(palette.presets);
  return {
    palettes: {
      ...palettes,
      [target]: {
        ...palette,
        presets: [...palette.presets, {
          id: presetId,
          style: { ...source.style },
        }],
      },
    },
    presetId,
  };
}

export function deleteToolStylePreset(
  palettes: ToolStylePalettes,
  target: ToolStylePaletteTarget,
  presetId: string,
): ToolStylePalettes {
  return updateTarget(palettes, target, (palette) => {
    if (palette.presets.length <= TOOL_STYLE_PALETTE_MIN_COUNT) return palette;
    const index = palette.presets.findIndex((preset) => preset.id === presetId);
    if (index < 0) return palette;
    const presets = palette.presets.filter((preset) => preset.id !== presetId);
    return {
      presets,
      activePresetId: palette.activePresetId === presetId
        ? presets[Math.min(index, presets.length - 1)].id
        : palette.activePresetId,
    };
  });
}

export function moveToolStylePreset(
  palettes: ToolStylePalettes,
  target: ToolStylePaletteTarget,
  presetId: string,
  targetIndex: number,
): ToolStylePalettes {
  return updateTarget(palettes, target, (palette) => {
    const sourceIndex = palette.presets.findIndex(
      (preset) => preset.id === presetId,
    );
    if (sourceIndex < 0 || !Number.isInteger(targetIndex)) return palette;
    const bounded = Math.max(0, Math.min(
      palette.presets.length - 1,
      targetIndex,
    ));
    if (bounded === sourceIndex) return palette;
    const presets = [...palette.presets];
    const [moved] = presets.splice(sourceIndex, 1);
    presets.splice(bounded, 0, moved);
    return { ...palette, presets };
  });
}

export function activeToolStylePreset(
  palettes: ToolStylePalettes,
  target: ToolStylePaletteTarget,
): ToolStylePalettePreset {
  const palette = palettes[target];
  return palette.presets.find(
    (preset) => preset.id === palette.activePresetId,
  ) ?? palette.presets[0];
}
