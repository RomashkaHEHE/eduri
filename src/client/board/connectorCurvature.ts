export type BoardConnectorTool = "line" | "arrow";

export interface BoardConnectorCurvaturePreferences {
  readonly line: number;
  readonly arrow: number;
}

export const BOARD_CONNECTOR_CURVATURE_STORAGE_KEY =
  "eduri-board-connector-curvature-v1";
export const BOARD_CONNECTOR_CURVATURE_MIN = -1;
export const BOARD_CONNECTOR_CURVATURE_MAX = 1;
export const BOARD_CONNECTOR_CURVATURE_STEP = 0.05;

const STORAGE_VERSION = 1;
const MAX_SERIALIZED_LENGTH = 1_024;

export function defaultBoardConnectorCurvature(): BoardConnectorCurvaturePreferences {
  return { line: 0, arrow: 0 };
}

export function clampBoardConnectorCurvature(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const clamped = Math.max(
    BOARD_CONNECTOR_CURVATURE_MIN,
    Math.min(BOARD_CONNECTOR_CURVATURE_MAX, value),
  );
  return Math.round(clamped / BOARD_CONNECTOR_CURVATURE_STEP)
    * BOARD_CONNECTOR_CURVATURE_STEP;
}

function parseEnvelope(serialized: string | null): BoardConnectorCurvaturePreferences | null {
  if (!serialized || serialized.length > MAX_SERIALIZED_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const envelope = parsed as Record<string, unknown>;
  if (
    Object.keys(envelope).length !== 2
    || envelope.version !== STORAGE_VERSION
    || !envelope.values
    || typeof envelope.values !== "object"
    || Array.isArray(envelope.values)
  ) return null;
  const values = envelope.values as Record<string, unknown>;
  if (
    Object.keys(values).length !== 2
    || !Object.hasOwn(values, "line")
    || !Object.hasOwn(values, "arrow")
    || typeof values.line !== "number"
    || !Number.isFinite(values.line)
    || values.line < BOARD_CONNECTOR_CURVATURE_MIN
    || values.line > BOARD_CONNECTOR_CURVATURE_MAX
    || typeof values.arrow !== "number"
    || !Number.isFinite(values.arrow)
    || values.arrow < BOARD_CONNECTOR_CURVATURE_MIN
    || values.arrow > BOARD_CONNECTOR_CURVATURE_MAX
  ) return null;
  return {
    line: clampBoardConnectorCurvature(values.line),
    arrow: clampBoardConnectorCurvature(values.arrow),
  };
}

export function loadBoardConnectorCurvature(
  storage?: Pick<Storage, "getItem"> | null,
): BoardConnectorCurvaturePreferences {
  let target = storage;
  if (target === undefined) {
    if (typeof window === "undefined") return defaultBoardConnectorCurvature();
    try {
      target = window.localStorage;
    } catch {
      return defaultBoardConnectorCurvature();
    }
  }
  if (!target) return defaultBoardConnectorCurvature();
  try {
    return parseEnvelope(target.getItem(BOARD_CONNECTOR_CURVATURE_STORAGE_KEY))
      ?? defaultBoardConnectorCurvature();
  } catch {
    return defaultBoardConnectorCurvature();
  }
}

export function persistBoardConnectorCurvature(
  preferences: BoardConnectorCurvaturePreferences,
  storage?: Pick<Storage, "setItem"> | null,
): boolean {
  let target = storage;
  if (target === undefined) {
    if (typeof window === "undefined") return false;
    try {
      target = window.localStorage;
    } catch {
      return false;
    }
  }
  if (!target) return false;
  const values = {
    line: clampBoardConnectorCurvature(preferences.line),
    arrow: clampBoardConnectorCurvature(preferences.arrow),
  };
  try {
    target.setItem(
      BOARD_CONNECTOR_CURVATURE_STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, values }),
    );
    return true;
  } catch {
    return false;
  }
}
