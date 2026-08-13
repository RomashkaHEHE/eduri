import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalActionOutbox } from "./terminalActionOutbox.js";

describe("terminal action outbox", () => {
  afterEach(() => vi.useRealTimers());

  it("retries with one stable action ID and stops after an ACK", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const outbox = createTerminalActionOutbox({
      connected: () => true,
      send,
      retryDelayMs: 20,
    });
    const action = { type: "submit-line", actionId: "submit-1", value: "pwd" } as const;
    expect(outbox.dispatch(action)).toBe(true);
    vi.advanceTimersByTime(20);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(([sent]) => sent === action)).toBe(true);
    outbox.acknowledge(action.actionId);
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("coalesces full input drafts and never replays across disconnect", () => {
    vi.useFakeTimers();
    let connected = true;
    const send = vi.fn();
    const outbox = createTerminalActionOutbox({
      connected: () => connected,
      send,
      retryDelayMs: 20,
    });
    outbox.dispatch({
      type: "edit-input",
      actionId: "edit-1",
      value: "p",
      cursor: 1,
    });
    outbox.dispatch({
      type: "edit-input",
      actionId: "edit-2",
      value: "py",
      cursor: 2,
    });
    vi.advanceTimersByTime(20);
    expect(send.mock.calls.map(([action]) => action.actionId))
      .toEqual(["edit-1", "edit-2", "edit-2"]);
    connected = false;
    outbox.clear();
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("reports an action whose stable retries are exhausted", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const onDiscard = vi.fn();
    const outbox = createTerminalActionOutbox({
      connected: () => true,
      send,
      onDiscard,
      retryDelayMs: 20,
    });
    const action = {
      type: "submit-line",
      actionId: "submit-lost",
      value: "pwd",
    } as const;

    expect(outbox.dispatch(action)).toBe(true);
    await vi.advanceTimersByTimeAsync(60);
    expect(send).toHaveBeenCalledTimes(3);
    expect(onDiscard).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledWith(action, "attempts-exhausted");
  });
});
