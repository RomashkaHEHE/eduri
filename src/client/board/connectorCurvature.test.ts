import { describe, expect, it, vi } from "vitest";
import {
  BOARD_CONNECTOR_CURVATURE_STORAGE_KEY,
  clampBoardConnectorCurvature,
  defaultBoardConnectorCurvature,
  loadBoardConnectorCurvature,
  persistBoardConnectorCurvature,
} from "./connectorCurvature";

describe("connector curvature preferences", () => {
  it("defaults both connector tools to straight and clamps to stable steps", () => {
    expect(defaultBoardConnectorCurvature()).toEqual({ line: 0, arrow: 0 });
    expect(clampBoardConnectorCurvature(0.074)).toBe(0.05);
    expect(clampBoardConnectorCurvature(-3)).toBe(-1);
    expect(clampBoardConnectorCurvature(Number.NaN)).toBe(0);
  });

  it("round-trips finite bounded values through device storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    expect(persistBoardConnectorCurvature({ line: 0.5, arrow: -0.25 }, storage))
      .toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(
      BOARD_CONNECTOR_CURVATURE_STORAGE_KEY,
      expect.any(String),
    );
    expect(loadBoardConnectorCurvature(storage)).toEqual({
      line: 0.5,
      arrow: -0.25,
    });
  });

  it.each([
    null,
    "{",
    JSON.stringify({ version: 2, values: { line: 0, arrow: 0 } }),
    JSON.stringify({ version: 1, values: { line: 2, arrow: 0 } }),
    JSON.stringify({ version: 1, values: { line: 0, arrow: "0" } }),
    JSON.stringify({ version: 1, values: { line: 0, arrow: 0, extra: 1 } }),
  ])("fails malformed preferences closed", (serialized) => {
    expect(loadBoardConnectorCurvature({ getItem: () => serialized }))
      .toEqual(defaultBoardConnectorCurvature());
  });

  it("contains blocked storage", () => {
    expect(loadBoardConnectorCurvature({
      getItem: () => { throw new Error("blocked"); },
    })).toEqual(defaultBoardConnectorCurvature());
    expect(persistBoardConnectorCurvature({ line: 0, arrow: 0 }, {
      setItem: () => { throw new Error("quota"); },
    })).toBe(false);
  });
});
