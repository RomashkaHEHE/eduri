import { beforeEach, describe, expect, it, vi } from "vitest";

const loaderMocks = vi.hoisted(() => ({
  config: vi.fn(),
}));

vi.mock("@monaco-editor/react", () => ({
  loader: { config: loaderMocks.config },
}));

import {
  MONACO_RUNTIME_BASE_URL,
  configureMonacoRuntime,
} from "./monacoRuntime";

beforeEach(() => {
  loaderMocks.config.mockReset();
});

describe("Monaco runtime configuration", () => {
  it("overrides the loader with a versioned same-origin path", () => {
    configureMonacoRuntime();

    expect(MONACO_RUNTIME_BASE_URL).toBe(
      "/vendor/monaco-editor/0.55.1/vs",
    );
    expect(MONACO_RUNTIME_BASE_URL).not.toMatch(/^https?:\/\//u);
    expect(loaderMocks.config).toHaveBeenCalledWith({
      paths: { vs: MONACO_RUNTIME_BASE_URL },
    });
  });
});
