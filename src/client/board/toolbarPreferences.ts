export const BOARD_TOOLBAR_PREFERENCES_STORAGE_KEY =
  "eduri-board-toolbar-v2";
export const LEGACY_BOARD_TOOLBAR_PREFERENCES_STORAGE_KEY =
  "eduri-board-toolbar-v1";

export const BOARD_TOOLBAR_ITEM_IDS = Object.freeze([
  "pen",
  "eraser",
  "text",
  "line",
  "arrow",
  "shapes",
  "code",
  "latex",
  "image",
] as const);

export type BoardToolbarItemId = (typeof BOARD_TOOLBAR_ITEM_IDS)[number];

export interface BoardToolbarPreferences {
  readonly order: readonly BoardToolbarItemId[];
  readonly visible: readonly BoardToolbarItemId[];
}

export interface BoardToolbarPreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DEFAULT_BOARD_TOOLBAR_ORDER: readonly BoardToolbarItemId[] =
  BOARD_TOOLBAR_ITEM_IDS;

export const DEFAULT_BOARD_TOOLBAR_VISIBLE = Object.freeze([
  "pen",
  "eraser",
  "text",
  "line",
  "arrow",
  "shapes",
] as const satisfies readonly BoardToolbarItemId[]);

const LEGACY_BOARD_TOOLBAR_ITEM_IDS = Object.freeze([
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
] as const);

const BOARD_TOOLBAR_PREFERENCES_STORAGE_VERSION = 2;
const LEGACY_BOARD_TOOLBAR_PREFERENCES_STORAGE_VERSION = 1;
const BOARD_TOOLBAR_PREFERENCES_MAX_SERIALIZED_LENGTH = 64 * 1024;
const BOARD_TOOLBAR_ITEM_ID_SET: ReadonlySet<string> = new Set(
  BOARD_TOOLBAR_ITEM_IDS,
);
const LEGACY_BOARD_TOOLBAR_ITEM_ID_SET: ReadonlySet<string> = new Set(
  LEGACY_BOARD_TOOLBAR_ITEM_IDS,
);

function copyDefaults(): BoardToolbarPreferences {
  return {
    order: [...DEFAULT_BOARD_TOOLBAR_ORDER],
    visible: [...DEFAULT_BOARD_TOOLBAR_VISIBLE],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function parseItemList(
  value: unknown,
  knownItems: ReadonlySet<string>,
): string[] | null {
  if (!Array.isArray(value)) return null;
  const items: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !knownItems.has(item) || seen.has(item)) {
      return null;
    }
    seen.add(item);
    items.push(item);
  }
  return items;
}

function parseCurrentEnvelope(value: unknown): BoardToolbarPreferences | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["version", "order", "visible"])
    || value.version !== BOARD_TOOLBAR_PREFERENCES_STORAGE_VERSION
  ) {
    return null;
  }

  const order = parseItemList(value.order, BOARD_TOOLBAR_ITEM_ID_SET);
  const visible = parseItemList(value.visible, BOARD_TOOLBAR_ITEM_ID_SET);
  if (
    order === null
    || order.length !== BOARD_TOOLBAR_ITEM_IDS.length
    || visible === null
  ) {
    return null;
  }

  const orderedItems = new Set(order);
  if (
    BOARD_TOOLBAR_ITEM_IDS.some((item) => !orderedItems.has(item))
    || visible.some((item) => !orderedItems.has(item))
  ) {
    return null;
  }
  return {
    order: order as BoardToolbarItemId[],
    visible: visible as BoardToolbarItemId[],
  };
}

function migrateLegacyEnvelope(value: unknown): BoardToolbarPreferences | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["version", "order", "visible"])
    || value.version !== LEGACY_BOARD_TOOLBAR_PREFERENCES_STORAGE_VERSION
  ) {
    return null;
  }

  const order = parseItemList(value.order, LEGACY_BOARD_TOOLBAR_ITEM_ID_SET);
  const visible = parseItemList(value.visible, LEGACY_BOARD_TOOLBAR_ITEM_ID_SET);
  if (
    order === null
    || order.length !== LEGACY_BOARD_TOOLBAR_ITEM_IDS.length
    || visible === null
  ) {
    return null;
  }
  const orderedItems = new Set(order);
  if (
    LEGACY_BOARD_TOOLBAR_ITEM_IDS.some((item) => !orderedItems.has(item))
    || visible.some((item) => !orderedItems.has(item))
  ) {
    return null;
  }

  return {
    order: order.filter((item): item is BoardToolbarItemId => item !== "laser"),
    visible: visible.filter((item): item is BoardToolbarItemId => item !== "laser"),
  };
}

function parseEnvelope(value: unknown): BoardToolbarPreferences | null {
  return parseCurrentEnvelope(value) ?? migrateLegacyEnvelope(value);
}

function parseStoredJson(serialized: string | null): unknown {
  if (
    !serialized
    || serialized.length > BOARD_TOOLBAR_PREFERENCES_MAX_SERIALIZED_LENGTH
  ) {
    return null;
  }
  try {
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

function serializeEnvelope(preferences: BoardToolbarPreferences): string {
  return JSON.stringify({
    version: BOARD_TOOLBAR_PREFERENCES_STORAGE_VERSION,
    order: preferences.order,
    visible: preferences.visible,
  });
}

function resolveStorage<T>(storage: T | null | undefined): T | Storage | null {
  if (storage !== undefined) return storage;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function defaultBoardToolbarPreferences(): BoardToolbarPreferences {
  return copyDefaults();
}

export function parseBoardToolbarPreferences(
  serialized: string | null,
): BoardToolbarPreferences {
  return parseEnvelope(parseStoredJson(serialized)) ?? copyDefaults();
}

export function serializeBoardToolbarPreferences(
  preferences: BoardToolbarPreferences,
): string {
  const candidate = serializeEnvelope(preferences);
  const parsed = candidate.length <= BOARD_TOOLBAR_PREFERENCES_MAX_SERIALIZED_LENGTH
    ? parseEnvelope(parseStoredJson(candidate))
    : null;
  return serializeEnvelope(parsed ?? copyDefaults());
}

export function loadBoardToolbarPreferences(
  storage?: Pick<BoardToolbarPreferencesStorage, "getItem"> | null,
): BoardToolbarPreferences {
  const target = resolveStorage(storage);
  if (!target) return copyDefaults();
  try {
    const current = target.getItem(BOARD_TOOLBAR_PREFERENCES_STORAGE_KEY);
    if (current !== null) return parseBoardToolbarPreferences(current);
    return parseBoardToolbarPreferences(
      target.getItem(LEGACY_BOARD_TOOLBAR_PREFERENCES_STORAGE_KEY),
    );
  } catch {
    return copyDefaults();
  }
}

export function persistBoardToolbarPreferences(
  preferences: BoardToolbarPreferences,
  storage?: Pick<BoardToolbarPreferencesStorage, "setItem"> | null,
): boolean {
  const target = resolveStorage(storage);
  if (!target) return false;
  try {
    target.setItem(
      BOARD_TOOLBAR_PREFERENCES_STORAGE_KEY,
      serializeBoardToolbarPreferences(preferences),
    );
    return true;
  } catch {
    return false;
  }
}

export function resetBoardToolbarPreferences(
  storage?: Pick<BoardToolbarPreferencesStorage, "removeItem"> | null,
): BoardToolbarPreferences {
  const target = resolveStorage(storage);
  if (target) {
    for (const key of [
      BOARD_TOOLBAR_PREFERENCES_STORAGE_KEY,
      LEGACY_BOARD_TOOLBAR_PREFERENCES_STORAGE_KEY,
    ]) {
      try {
        target.removeItem(key);
      } catch {
        // A blocked storage backend must not prevent the in-memory reset.
      }
    }
  }
  return copyDefaults();
}
