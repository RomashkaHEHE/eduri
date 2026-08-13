import { describe, expect, it } from "vitest";
import {
  SHARED_TERMINAL_LIMITS,
  SHARED_TERMINAL_PROTOCOL_VERSION,
  SharedTerminalStateMachine,
  applySharedTerminalDelta,
  parseSharedTerminalAck,
  parseSharedTerminalDelta,
  parseSharedTerminalActionEnvelope,
  parseSharedTerminalClientEffect,
  parseSharedTerminalState,
  sanitizeSharedTerminalOutput,
  sharedTerminalActionFingerprint,
  toSharedTerminalClientEffect,
  type SharedTerminalActor,
  type SharedTerminalAction,
} from "./index.js";

const left: SharedTerminalActor = {
  socketId: "socket-left",
  participantId: "participant-left",
  displayName: "Left",
  color: "#2459d6",
};
const right: SharedTerminalActor = {
  socketId: "socket-right",
  participantId: "participant-right",
  displayName: "Right",
  color: "#087a55",
};

function action<T extends Omit<SharedTerminalAction, "actionId">>(
  value: T,
  id: string = crypto.randomUUID(),
): SharedTerminalAction {
  return { ...value, actionId: id } as SharedTerminalAction;
}

describe("SharedTerminalStateMachine", () => {
  it("starts with a concise help hint", () => {
    expect(new SharedTerminalStateMachine().snapshot().transcript)
      .toBe("help для списка команд\n");
  });

  it("never reuses a run ID when an ephemeral room machine is recreated", () => {
    const first = new SharedTerminalStateMachine();
    const second = new SharedTerminalStateMachine();
    const firstRun = first.dispatch(left, action({
      type: "submit-line",
      value: "pwd",
    }, "first-machine-run"));
    const secondRun = second.dispatch(left, action({
      type: "submit-line",
      value: "pwd",
    }, "second-machine-run"));
    expect(firstRun.state.activeRun?.runId).toBeTruthy();
    expect(secondRun.state.activeRun?.runId).toBeTruthy();
    expect(firstRun.state.activeRun?.runId)
      .not.toBe(secondRun.state.activeRun?.runId);
  });
  it("gives the input lease to the first participant and synchronizes draft/cursor", () => {
    const machine = new SharedTerminalStateMachine();
    expect(machine.dispatch(left, action({ type: "claim" }, "claim-left")).changed)
      .toBe(true);
    expect(machine.dispatch(right, action({
      type: "edit-input",
      value: "lost",
      cursor: 4,
    }, "right-edit"))).toMatchObject({ changed: false, error: "input-owned" });
    const result = machine.dispatch(left, action({
      type: "edit-input",
      value: "py main.py",
      cursor: 2,
    }, "left-edit"));
    expect(result.state.input).toEqual({
      value: "py main.py",
      cursor: 2,
      owner: expect.objectContaining({ participantId: left.participantId }),
    });
  });

  it("orders one run, rejects a second, accepts only host output, and recovers on disconnect", () => {
    const machine = new SharedTerminalStateMachine();
    const started = machine.dispatch(left, action({
      type: "start-run",
      entryId: "main-py",
      entrypoint: "main.py",
    }, "run-left"));
    expect(started.effect).toMatchObject({
      type: "start-run",
      targetSocketId: left.socketId,
    });
    expect(machine.dispatch(right, action({
      type: "start-run",
      entryId: "main-py",
      entrypoint: "main.py",
    }, "run-right"))).toMatchObject({ changed: false, error: "busy" });
    const runId = started.state.activeRun!.runId;
    expect(machine.dispatch(right, action({
      type: "host-output",
      runId,
      chunk: "spoof",
    }, "spoof"))).toMatchObject({ changed: false, error: "not-host" });
    expect(machine.dispatch(left, action({
      type: "host-output",
      runId,
      chunk: "ok\n",
    }, "output"))).toMatchObject({ changed: true });
    const disconnected = machine.disconnect(left.socketId);
    expect(disconnected.state.mode).toBe("shell");
    expect(disconnected.state.transcript).toContain("исполнитель отключился");
  });

  it("routes input() through one request and revokes it atomically on interrupt", () => {
    const machine = new SharedTerminalStateMachine();
    const started = machine.dispatch(left, action({
      type: "start-run",
      entryId: "main-py",
      entrypoint: "main.py",
    }, "start"));
    const runId = started.state.activeRun!.runId;
    expect(machine.dispatch(left, action({
      type: "host-input-request",
      runId,
      requestId: "stdin-one",
    }, "request"))).toMatchObject({
      state: { mode: "program-input", inputRequestId: "stdin-one" },
    });
    const interrupted = machine.dispatch(right, action({
      type: "interrupt",
    }, "interrupt"));
    expect(interrupted).toMatchObject({
      changed: true,
      state: { mode: "busy", inputRequestId: null },
      effect: { type: "interrupt", targetSocketId: left.socketId, runId },
    });
    expect(machine.dispatch(right, action({
      type: "submit-line",
      value: "late",
    }, "late"))).toMatchObject({ changed: false, error: "busy" });
  });

  it("supports a persistent Python prompt and exits it through an ordered EOF effect", () => {
    const machine = new SharedTerminalStateMachine();
    const command = machine.dispatch(left, action({
      type: "submit-line",
      value: "py",
    }, "python"));
    const runId = command.state.activeRun!.runId;
    const ready = machine.dispatch(left, action({
      type: "host-ready",
      runId,
      nextMode: "python",
      prompt: ">>> ",
    }, "python-ready"));
    expect(ready.state).toMatchObject({ mode: "python", prompt: ">>> " });
    const eof = machine.dispatch(right, action({ type: "eof" }, "python-eof"));
    expect(eof).toMatchObject({
      changed: true,
      state: { mode: "busy" },
      effect: { type: "eof", targetSocketId: left.socketId },
    });
  });

  it("keeps the Python REPL alive when Ctrl-C clears an idle or active block", () => {
    const machine = new SharedTerminalStateMachine();
    const opened = machine.dispatch(left, action({
      type: "submit-line",
      value: "py",
    }, "open-python"));
    machine.dispatch(left, action({
      type: "host-ready",
      runId: opened.state.activeRun!.runId,
      nextMode: "python",
      prompt: ">>> ",
    }, "python-opened"));

    const idleInterrupt = machine.dispatch(right, action({
      type: "interrupt",
    }, "interrupt-idle-python"));
    expect(idleInterrupt).toMatchObject({
      changed: true,
      state: { mode: "busy" },
      effect: {
        type: "interrupt",
        targetSocketId: left.socketId,
        pythonMode: true,
      },
    });
    expect(idleInterrupt.state.transcript).toContain("^C\nKeyboardInterrupt\n");
    const idleRunId = idleInterrupt.state.activeRun!.runId;
    machine.dispatch(left, action({
      type: "host-ready",
      runId: idleRunId,
      nextMode: "python",
      prompt: ">>> ",
    }, "idle-interrupt-ready"));

    const block = machine.dispatch(right, action({
      type: "submit-line",
      value: "while True:",
    }, "python-block"));
    expect(block.effect).toMatchObject({ type: "execute-line", pythonMode: true });
    const activeInterrupt = machine.dispatch(right, action({
      type: "interrupt",
    }, "interrupt-active-python"));
    expect(activeInterrupt.effect).toMatchObject({
      type: "interrupt",
      runId: block.state.activeRun!.runId,
      pythonMode: true,
    });
    const wire = toSharedTerminalClientEffect(activeInterrupt.effect!);
    expect(parseSharedTerminalClientEffect(wire)).toEqual(wire);
    const resumed = machine.dispatch(left, action({
      type: "host-ready",
      runId: block.state.activeRun!.runId,
      nextMode: "python",
      prompt: ">>> ",
    }, "active-interrupt-ready"));
    expect(resumed.state).toMatchObject({ mode: "python", prompt: ">>> " });
  });

  it("clears as a shared generation and deduplicates actions", () => {
    const machine = new SharedTerminalStateMachine();
    const first = machine.dispatch(left, action({
      type: "submit-line",
      value: "clear",
    }, "clear-once"));
    expect(first.state).toMatchObject({ generation: 2, transcript: "" });
    const duplicate = machine.dispatch(left, action({
      type: "submit-line",
      value: "clear",
    }, "clear-once"));
    expect(duplicate).toMatchObject({ changed: false });
    expect(duplicate.ack.status).toBe("duplicate");
    expect(duplicate.state.generation).toBe(2);
  });

  it("rejects reuse of an action ID with a different payload", () => {
    const machine = new SharedTerminalStateMachine();
    machine.dispatch(left, action({
      type: "edit-input",
      value: "one",
      cursor: 3,
    }, "same-action"));
    const conflict = machine.dispatch(left, action({
      type: "edit-input",
      value: "two",
      cursor: 3,
    }, "same-action"));
    expect(conflict).toMatchObject({
      changed: false,
      error: "idempotency-conflict",
      ack: { status: "rejected", error: "idempotency-conflict" },
      state: { input: { value: "one" } },
    });
  });

  it("deduplicates a retried action after the client reconnects", () => {
    const machine = new SharedTerminalStateMachine();
    const first = machine.dispatch(left, action({
      type: "edit-input",
      value: "shared",
      cursor: 6,
    }, "reconnect-action"));
    const reconnected = { ...left, socketId: "socket-left-reconnected" };
    const retry = machine.dispatch(reconnected, action({
      type: "edit-input",
      value: "shared",
      cursor: 6,
    }, "reconnect-action"));
    expect(retry).toMatchObject({
      changed: false,
      ack: { status: "duplicate", seq: first.state.seq },
    });
  });

  it("fingerprints nested host results for idempotency", () => {
    const machine = new SharedTerminalStateMachine();
    const started = machine.dispatch(left, action({
      type: "start-run",
      entryId: "main-py",
      entrypoint: "main.py",
      testId: "test-one",
    }, "nested-start"));
    const runId = started.state.activeRun!.runId;
    machine.dispatch(left, action({
      type: "host-ready",
      runId,
      nextMode: "shell",
      testResult: { testId: "test-one", status: "passed" },
    }, "nested-result"));
    const conflict = machine.dispatch(left, action({
      type: "host-ready",
      runId,
      nextMode: "shell",
      testResult: { testId: "test-one", status: "failed" },
    }, "nested-result"));
    expect(conflict).toMatchObject({
      error: "idempotency-conflict",
      ack: { status: "rejected" },
      state: { lastTest: { status: "passed" } },
    });
  });

  it("lets the first simultaneous line win over a competing run", () => {
    const machine = new SharedTerminalStateMachine();
    const line = machine.dispatch(left, action({
      type: "submit-line",
      value: "py main.py",
    }, "line-first"));
    expect(line).toMatchObject({ changed: true, state: { mode: "busy" } });
    expect(machine.dispatch(right, action({
      type: "start-run",
      entryId: "main-py",
      entrypoint: "main.py",
    }, "run-second"))).toMatchObject({
      changed: false,
      error: "busy",
      ack: { status: "rejected" },
    });
  });

  it("rejects unsafe run paths, strips terminal controls, and bounds scrollback", () => {
    const machine = new SharedTerminalStateMachine();
    expect(machine.dispatch(left, action({
      type: "start-run",
      entryId: "main-py",
      entrypoint: "main.py\u001b[2Jspoof",
    }, "unsafe"))).toMatchObject({ changed: false, error: "invalid-run" });
    expect(sanitizeSharedTerminalOutput("a\u001b[2Jb\u0000c\r\nd"))
      .toBe("abc\nd");
    const started = machine.dispatch(left, action({
      type: "start-run",
      entryId: "main-py",
      entrypoint: "main.py",
    }, "safe"));
    const runId = started.state.activeRun!.runId;
    for (let index = 0; index < 6; index += 1) {
      machine.dispatch(left, action({
        type: "host-output",
        runId,
        chunk: "x".repeat(SHARED_TERMINAL_LIMITS.maxOutputChunkCodeUnits),
      }, `chunk-${index}`));
    }
    expect(machine.snapshot().transcript.length)
      .toBeLessThanOrEqual(SHARED_TERMINAL_LIMITS.maxTranscriptCodeUnits);
  });

  it("binds autotest results to the exact active test", () => {
    const machine = new SharedTerminalStateMachine();
    const started = machine.dispatch(left, action({
      type: "start-run",
      entryId: "main-py",
      entrypoint: "main.py",
      testId: "test-one",
    }, "test-start"));
    const runId = started.state.activeRun!.runId;
    expect(machine.dispatch(left, action({
      type: "host-ready",
      runId,
      nextMode: "shell",
      testResult: { testId: "test-other", status: "passed" },
    }, "wrong-result"))).toMatchObject({
      changed: false,
      error: "invalid-test-result",
    });
  });
});

describe("shared terminal codecs", () => {
  it("parses exact actions, state, and targeted effects fail closed", () => {
    const parsed = parseSharedTerminalActionEnvelope({
      protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
      action: {
        type: "edit-input",
        actionId: "edit-one",
        value: "py",
        cursor: 2,
      },
    });
    expect(parsed?.action).toMatchObject({ type: "edit-input", value: "py" });
    expect(parseSharedTerminalActionEnvelope({
      protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
      action: { type: "sync", actionId: "sync", extra: true },
    })).toBeNull();

    const machine = new SharedTerminalStateMachine();
    expect(parseSharedTerminalState(machine.snapshot())).toEqual(machine.snapshot());
    const result = machine.dispatch(left, action({
      type: "start-run",
      entryId: "main-py",
      entrypoint: "main.py",
    }, "effect"));
    const wire = toSharedTerminalClientEffect(result.effect!);
    expect(parseSharedTerminalClientEffect(wire)).toEqual(wire);
    expect(parseSharedTerminalClientEffect({ ...wire, injected: true })).toBeNull();
  });

  it("applies ordered minimal deltas and requires a snapshot after a gap", () => {
    const machine = new SharedTerminalStateMachine();
    const initial = machine.connect();
    const edit = machine.dispatch(left, action({
      type: "edit-input",
      value: "py main.py",
      cursor: 10,
    }, "delta-edit"));
    expect(edit.delta?.operations).toEqual([{
      type: "input",
      input: edit.state.input,
    }]);
    expect(parseSharedTerminalDelta(edit.delta)).toEqual(edit.delta);
    expect(applySharedTerminalDelta(initial, edit.delta)).toEqual(edit.state);

    const release = machine.dispatch(left, action({ type: "release" }, "release"));
    expect(applySharedTerminalDelta(initial, release.delta)).toBeNull();
    expect(machine.recover(initial.generation, initial.seq)).toEqual(release.state);
    expect(parseSharedTerminalAck(release.ack)).toEqual(release.ack);
  });

  it("uses append deltas whose size does not grow with transcript history", () => {
    const machine = new SharedTerminalStateMachine();
    const started = machine.dispatch(left, action({
      type: "start-run",
      entryId: "main-py",
      entrypoint: "main.py",
    }, "large-start"));
    const runId = started.state.activeRun!.runId;
    for (let index = 0; index < 4; index += 1) {
      machine.dispatch(left, action({
        type: "host-output",
        runId,
        chunk: "x".repeat(SHARED_TERMINAL_LIMITS.maxOutputChunkCodeUnits),
      }, `large-${index}`));
    }
    const tail = machine.dispatch(left, action({
      type: "host-output",
      runId,
      chunk: "tail\n",
    }, "large-tail"));
    expect(tail.delta?.operations).toEqual([{
      type: "transcript-append",
      trimStart: 5,
      value: "tail\n",
    }]);
    expect(JSON.stringify(tail.delta).length).toBeLessThan(256);
    expect(JSON.stringify(tail.state).length).toBeGreaterThan(250_000);
  });

  it("retains a fixed-size action digest for large idempotent output retries", () => {
    const large = {
      type: "host-output",
      actionId: "large-output-action",
      runId: "run-large",
      chunk: "x".repeat(SHARED_TERMINAL_LIMITS.maxOutputChunkCodeUnits),
    } as const satisfies SharedTerminalAction;
    const fingerprint = sharedTerminalActionFingerprint(large);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(sharedTerminalActionFingerprint({ ...large })).toBe(fingerprint);
    expect(sharedTerminalActionFingerprint({ ...large, chunk: `${large.chunk}y` }))
      .not.toBe(fingerprint);
  });

  it("publishes a fresh generation snapshot for clear", () => {
    const machine = new SharedTerminalStateMachine();
    const before = machine.snapshot();
    const cleared = machine.dispatch(left, action({
      type: "submit-line",
      value: "cls",
    }, "clear-generation"));
    expect(cleared.delta).toBeUndefined();
    expect(cleared.snapshot).toEqual(cleared.state);
    expect(cleared.snapshot).toMatchObject({
      generation: before.generation + 1,
      transcript: "",
    });
    expect(machine.recover(before.generation, before.seq)).toEqual(cleared.state);
  });
});
