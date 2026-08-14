import { describe, expect, it, vi } from "vitest";
import {
  CODE_WORKSPACE_LAYOUT_STORAGE_KEY,
  DEFAULT_CODE_WORKSPACE_LAYOUT,
  clampCodeWorkspaceLayout,
  clampConsoleHeight,
  clampExplorerHeight,
  clampExplorerWidth,
  clampTestsHeight,
  clampTestsWidth,
  loadCodeWorkspaceLayout,
  parseCodeWorkspaceLayout,
  persistCodeWorkspaceLayout,
  type CodeWorkspaceLayout,
} from "./codeWorkspaceLayout";

const SAVED_LAYOUT: CodeWorkspaceLayout = {
  version: 1,
  explorerWidth: 260,
  explorerHeight: 130,
  consoleHeight: 280,
  testsWidth: 420,
  testsHeight: 270,
};

describe("Code workspace layout", () => {
  it("provides stable defaults for wide and compact layouts", () => {
    expect(DEFAULT_CODE_WORKSPACE_LAYOUT).toEqual({
      version: 1,
      explorerWidth: 220,
      explorerHeight: 110,
      consoleHeight: 220,
      testsWidth: 360,
      testsHeight: 240,
    });
    expect(Object.isFrozen(DEFAULT_CODE_WORKSPACE_LAYOUT)).toBe(true);
  });

  it("parses only the exact versioned finite integer schema", () => {
    expect(parseCodeWorkspaceLayout(JSON.stringify(SAVED_LAYOUT)))
      .toEqual(SAVED_LAYOUT);

    const invalid = [
      null,
      "",
      "{",
      "[]",
      JSON.stringify({ ...SAVED_LAYOUT, version: 2 }),
      JSON.stringify({ ...SAVED_LAYOUT, testsHeight: undefined }),
      JSON.stringify({ ...SAVED_LAYOUT, extra: 1 }),
      JSON.stringify({ ...SAVED_LAYOUT, explorerWidth: "260" }),
      JSON.stringify({ ...SAVED_LAYOUT, explorerHeight: 1.5 }),
      JSON.stringify({ ...SAVED_LAYOUT, consoleHeight: -1 }),
      JSON.stringify({ ...SAVED_LAYOUT, testsWidth: 100_001 }),
      '{"version":1,"explorerWidth":1e309,"explorerHeight":130,'
        + '"consoleHeight":280,"testsWidth":420,"testsHeight":270}',
      " ".repeat(1_025),
    ];
    for (const serialized of invalid) {
      expect(parseCodeWorkspaceLayout(serialized)).toBeNull();
    }
  });

  it("clamps every split against its live available size", () => {
    expect(clampExplorerWidth(250, 1_000)).toBe(250);
    expect(clampExplorerWidth(900, 1_000)).toBe(400);
    expect(clampExplorerWidth(20, 1_000)).toBe(150);

    expect(clampExplorerHeight(900, 800)).toBe(320);
    expect(clampExplorerHeight(10, 800)).toBe(80);

    expect(clampConsoleHeight(900, 700)).toBe(432);
    expect(clampConsoleHeight(20, 700)).toBe(180);

    expect(clampTestsWidth(900, 1_000)).toBe(652);
    expect(clampTestsWidth(20, 1_000)).toBe(300);

    expect(clampTestsHeight(900, 600)).toBe(442);
    expect(clampTestsHeight(20, 600)).toBe(190);
  });

  it("stays within tiny containers when both pane minima cannot fit", () => {
    expect(clampExplorerWidth(220, 100)).toBe(92);
    expect(clampConsoleHeight(220, 0)).toBe(0);
    expect(clampTestsWidth(360, Number.NaN)).toBe(0);
    expect(clampTestsHeight(Number.NaN, 200)).toBe(190);
  });

  it("supports caller-provided minima and divider geometry", () => {
    expect(clampConsoleHeight(500, 700, {
      minimumSize: 100,
      minimumRemainingSize: 300,
      maximumSize: 250,
      dividerSize: 10,
    })).toBe(250);
    expect(clampExplorerWidth(500, 1_000, {
      maximumFraction: 0.5,
      maximumSize: 600,
    })).toBe(500);
  });

  it("clamps a complete layout using workspace and console dimensions", () => {
    expect(clampCodeWorkspaceLayout({
      version: 1,
      explorerWidth: 900,
      explorerHeight: 900,
      consoleHeight: 900,
      testsWidth: 900,
      testsHeight: 900,
    }, {
      workspaceWidth: 1_000,
      workspaceHeight: 700,
      consoleWidth: 800,
      consoleHeight: 500,
      compactExplorerAvailableHeight: 500,
    })).toEqual({
      version: 1,
      explorerWidth: 400,
      explorerHeight: 272,
      consoleHeight: 432,
      testsWidth: 452,
      testsHeight: 342,
    });
  });

  it("round-trips through the versioned storage key", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };

    expect(persistCodeWorkspaceLayout(SAVED_LAYOUT, storage)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(
      CODE_WORKSPACE_LAYOUT_STORAGE_KEY,
      JSON.stringify(SAVED_LAYOUT),
    );
    expect(loadCodeWorkspaceLayout(storage)).toEqual(SAVED_LAYOUT);
  });

  it("falls back safely for absent, invalid, and inaccessible storage", () => {
    expect(loadCodeWorkspaceLayout(null)).toEqual(DEFAULT_CODE_WORKSPACE_LAYOUT);
    expect(loadCodeWorkspaceLayout({ getItem: () => "invalid" }))
      .toEqual(DEFAULT_CODE_WORKSPACE_LAYOUT);
    expect(loadCodeWorkspaceLayout({
      getItem: () => { throw new Error("blocked"); },
    })).toEqual(DEFAULT_CODE_WORKSPACE_LAYOUT);
    expect(persistCodeWorkspaceLayout(SAVED_LAYOUT, {
      setItem: () => { throw new Error("quota"); },
    })).toBe(false);
  });

  it("refuses to persist invalid runtime values", () => {
    const setItem = vi.fn();
    expect(persistCodeWorkspaceLayout({
      ...SAVED_LAYOUT,
      testsHeight: Number.NaN,
    }, { setItem })).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });
});
