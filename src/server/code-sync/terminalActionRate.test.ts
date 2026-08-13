import { describe, expect, it } from "vitest";
import type { SharedTerminalAction } from "../../code/terminal/index.js";
import { consumeTerminalActionRate } from "./terminalActionRate.js";

describe("shared terminal action rate", () => {
  it("does not charge stable retries while still limiting distinct actions", () => {
    const output = {
      type: "host-output",
      actionId: "output-1",
      runId: "run-1",
      chunk: ".",
    } as const satisfies SharedTerminalAction;
    let scope;
    for (let retry = 0; retry < 3; retry += 1) {
      const result = consumeTerminalActionRate(scope, output, retry * 600, 2);
      expect(result.allowed).toBe(true);
      scope = result.scope;
    }
    expect(scope?.count).toBe(1);

    const second = consumeTerminalActionRate(scope, {
      ...output,
      actionId: "output-2",
    }, 1_800, 2);
    expect(second.allowed).toBe(true);
    const blocked = consumeTerminalActionRate(second.scope, {
      ...output,
      actionId: "output-3",
    }, 2_400, 2);
    expect(blocked.allowed).toBe(false);
  });

  it("charges a conflicting payload that reuses an action ID", () => {
    const initial = consumeTerminalActionRate(undefined, {
      type: "edit-input",
      actionId: "edit-1",
      value: "a",
      cursor: 1,
    }, 0, 2);
    const conflict = consumeTerminalActionRate(initial.scope, {
      type: "edit-input",
      actionId: "edit-1",
      value: "b",
      cursor: 1,
    }, 1, 2);
    expect(conflict.scope.count).toBe(2);
  });
});
