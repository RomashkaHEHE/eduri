export interface StyleColorSlot {
  readonly id: string;
  readonly color: string;
}

export interface StyleColorPaletteState {
  readonly slots: readonly StyleColorSlot[];
  readonly recentColors: readonly string[];
}

export interface StyleColorPaletteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const STYLE_COLOR_PALETTE_STORAGE_KEY =
  "eduri-board-style-color-palette-v1";
export const STYLE_COLOR_PALETTE_MIN_COUNT = 1;
export const STYLE_COLOR_PALETTE_MAX_COUNT = 24;
export const STYLE_COLOR_PALETTE_RECENT_MAX_COUNT = 8;

const STYLE_COLOR_PALETTE_STORAGE_VERSION = 1;
const STYLE_COLOR_PALETTE_MAX_SERIALIZED_LENGTH = 64 * 1024;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;
const SLOT_ID_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/iu;
const FALLBACK_CUSTOM_COLOR = "#7c3aed";

export const DEFAULT_STYLE_COLOR_SLOTS: readonly StyleColorSlot[] =
  Object.freeze([
    Object.freeze({ id: "graphite", color: "#17212b" }),
    Object.freeze({ id: "gray", color: "#8492a6" }),
    Object.freeze({ id: "white", color: "#ffffff" }),
    Object.freeze({ id: "red", color: "#d33f49" }),
    Object.freeze({ id: "pink", color: "#ec4899" }),
    Object.freeze({ id: "blue", color: "#2563eb" }),
    Object.freeze({ id: "green", color: "#16825d" }),
    Object.freeze({ id: "orange", color: "#d97706" }),
    Object.freeze({ id: "yellow", color: "#ffd43b" }),
    Object.freeze({ id: "purple", color: "#7c3aed" }),
    Object.freeze({ id: "pale-yellow", color: "#fff3bf" }),
    Object.freeze({ id: "pale-blue", color: "#dbeafe" }),
    Object.freeze({ id: "pale-green", color: "#dcfce7" }),
    Object.freeze({ id: "pale-pink", color: "#ffe4e6" }),
  ]);

function copyDefaults(): StyleColorPaletteState {
  return {
    slots: DEFAULT_STYLE_COLOR_SLOTS.map((slot) => ({ ...slot })),
    recentColors: [],
  };
}

export function canonicalStyleColor(value: unknown): string | null {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

function parseStoredJson(serialized: string | null): unknown {
  if (
    !serialized
    || serialized.length > STYLE_COLOR_PALETTE_MAX_SERIALIZED_LENGTH
  ) {
    return null;
  }
  try {
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

function hasExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(record);
  return keys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(record, key));
}

function withoutFavoriteColors(
  recentColors: readonly string[],
  slots: readonly StyleColorSlot[],
): readonly string[] {
  const favoriteColors = new Set(slots.map((slot) => slot.color));
  const filtered = recentColors.filter((color) => !favoriteColors.has(color));
  return filtered.length === recentColors.length ? recentColors : filtered;
}

function parseStyleColorPaletteEnvelope(
  parsed: unknown,
): StyleColorPaletteState | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const envelope = parsed as Record<string, unknown>;
  if (
    !hasExactKeys(envelope, ["version", "slots", "recentColors"])
    || envelope.version !== STYLE_COLOR_PALETTE_STORAGE_VERSION
    || !Array.isArray(envelope.slots)
    || envelope.slots.length < STYLE_COLOR_PALETTE_MIN_COUNT
    || envelope.slots.length > STYLE_COLOR_PALETTE_MAX_COUNT
    || !Array.isArray(envelope.recentColors)
    || envelope.recentColors.length > STYLE_COLOR_PALETTE_RECENT_MAX_COUNT
  ) {
    return null;
  }

  const ids = new Set<string>();
  const slots: StyleColorSlot[] = [];
  for (const value of envelope.slots) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const color = canonicalStyleColor(record.color);
    if (
      !hasExactKeys(record, ["id", "color"])
      || typeof record.id !== "string"
      || !SLOT_ID_PATTERN.test(record.id)
      || ids.has(record.id)
      || color === null
    ) {
      return null;
    }
    ids.add(record.id);
    slots.push({ id: record.id, color });
  }

  const recentColors: string[] = [];
  const recentSet = new Set<string>();
  for (const value of envelope.recentColors) {
    const color = canonicalStyleColor(value);
    if (color === null || recentSet.has(color)) return null;
    recentSet.add(color);
    recentColors.push(color);
  }

  return {
    slots,
    recentColors: withoutFavoriteColors(recentColors, slots),
  };
}

export function parseStyleColorPalette(
  serialized: string | null,
): StyleColorPaletteState {
  return parseStyleColorPaletteEnvelope(parseStoredJson(serialized))
    ?? copyDefaults();
}

export function serializeStyleColorPalette(
  state: StyleColorPaletteState,
): string {
  const serialized = JSON.stringify({
    version: STYLE_COLOR_PALETTE_STORAGE_VERSION,
    slots: state.slots,
    recentColors: state.recentColors,
  });
  const parsed = parseStyleColorPaletteEnvelope(parseStoredJson(serialized));
  const safe = parsed ?? copyDefaults();
  return JSON.stringify({
    version: STYLE_COLOR_PALETTE_STORAGE_VERSION,
    slots: safe.slots,
    recentColors: safe.recentColors,
  });
}

export function loadStyleColorPalette(
  storage: StyleColorPaletteStorage | null | undefined,
): StyleColorPaletteState {
  if (!storage) return copyDefaults();
  try {
    return parseStyleColorPalette(
      storage.getItem(STYLE_COLOR_PALETTE_STORAGE_KEY),
    );
  } catch {
    return copyDefaults();
  }
}

export function persistStyleColorPalette(
  storage: StyleColorPaletteStorage | null | undefined,
  state: StyleColorPaletteState,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      STYLE_COLOR_PALETTE_STORAGE_KEY,
      serializeStyleColorPalette(state),
    );
    return true;
  } catch {
    return false;
  }
}

function nextAvailableSlotId(slots: readonly StyleColorSlot[]): string {
  const usedIds = new Set(slots.map((slot) => slot.id));
  for (
    let sequence = 1;
    sequence <= STYLE_COLOR_PALETTE_MAX_COUNT + 1;
    sequence += 1
  ) {
    const candidate = `custom-${sequence}`;
    if (!usedIds.has(candidate)) return candidate;
  }
  return `custom-${STYLE_COLOR_PALETTE_MAX_COUNT + 2}`;
}

export function createStyleColorSlot(
  slots: readonly StyleColorSlot[],
  color: unknown = slots.at(-1)?.color ?? FALLBACK_CUSTOM_COLOR,
): StyleColorSlot | null {
  if (slots.length >= STYLE_COLOR_PALETTE_MAX_COUNT) return null;
  const canonicalColor = canonicalStyleColor(color);
  if (canonicalColor === null) return null;
  return {
    id: nextAvailableSlotId(slots),
    color: canonicalColor,
  };
}

export function changeStyleColorSlot(
  slots: readonly StyleColorSlot[],
  slotId: string,
  color: unknown,
): readonly StyleColorSlot[] {
  const canonicalColor = canonicalStyleColor(color);
  const index = slots.findIndex((slot) => slot.id === slotId);
  if (
    canonicalColor === null
    || index < 0
    || slots[index].color === canonicalColor
  ) {
    return slots;
  }
  return slots.map((slot, slotIndex) => slotIndex === index
    ? { ...slot, color: canonicalColor }
    : slot);
}

export function deleteStyleColorSlot(
  slots: readonly StyleColorSlot[],
  slotId: string,
): readonly StyleColorSlot[] {
  if (slots.length <= STYLE_COLOR_PALETTE_MIN_COUNT) return slots;
  const index = slots.findIndex((slot) => slot.id === slotId);
  if (index < 0) return slots;
  return slots.filter((_, slotIndex) => slotIndex !== index);
}

export function moveStyleColorSlot(
  slots: readonly StyleColorSlot[],
  slotId: string,
  targetIndex: number,
): readonly StyleColorSlot[] {
  const sourceIndex = slots.findIndex((slot) => slot.id === slotId);
  if (sourceIndex < 0 || !Number.isInteger(targetIndex)) return slots;
  const boundedTargetIndex = Math.max(
    0,
    Math.min(slots.length - 1, targetIndex),
  );
  if (sourceIndex === boundedTargetIndex) return slots;
  const next = [...slots];
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(boundedTargetIndex, 0, moved);
  return next;
}

export function rememberRecentStyleColor(
  recentColors: readonly string[],
  color: unknown,
  slots: readonly StyleColorSlot[] = [],
): readonly string[] {
  const canonicalColor = canonicalStyleColor(color);
  if (canonicalColor === null) return recentColors;
  const filteredRecents = withoutFavoriteColors(recentColors, slots);
  if (slots.some((slot) => slot.color === canonicalColor)) {
    return filteredRecents;
  }
  if (
    filteredRecents[0] === canonicalColor
    && filteredRecents.length <= STYLE_COLOR_PALETTE_RECENT_MAX_COUNT
    && new Set(filteredRecents).size === filteredRecents.length
  ) {
    return filteredRecents;
  }
  return [
    canonicalColor,
    ...filteredRecents.filter((entry) => entry.toLowerCase() !== canonicalColor),
  ].slice(0, STYLE_COLOR_PALETTE_RECENT_MAX_COUNT);
}
