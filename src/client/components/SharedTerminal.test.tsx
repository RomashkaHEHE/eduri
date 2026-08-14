// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    emitData(data: string): void;
    emitCursorMove(): void;
    emitRender(): void;
    emitResize(): void;
    emitScroll(): void;
    emitWriteParsed(): void;
    listenerCount(): number;
    buffer: {
      active: {
        baseY: number;
        cursorX: number;
        cursorY: number;
        viewportY: number;
      };
    };
    cols: number;
    rows: number;
    hostRect: DOMRect;
    screenRect: DOMRect;
    output: string;
    options: Record<string, unknown>;
    resetCount: number;
    disposeCount: number;
  }>,
}));

const mediaMocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    matches: true,
    listeners,
    query: {
      get matches() { return mediaMocks.matches; },
      media: "(hover: hover)",
      onchange: null,
      addEventListener(type: string, listener: () => void) {
        if (type === "change") listeners.add(listener);
      },
      removeEventListener(type: string, listener: () => void) {
        if (type === "change") listeners.delete(listener);
      },
      addListener(listener: () => void) { listeners.add(listener); },
      removeListener(listener: () => void) { listeners.delete(listener); },
      dispatchEvent() { return true; },
    },
    setMatches(matches: boolean) {
      mediaMocks.matches = matches;
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    buffer = {
      active: {
        baseY: 0,
        cursorX: 3,
        cursorY: 2,
        viewportY: 0,
      },
    };
    hostRect = {
      x: 100,
      y: 50,
      left: 100,
      top: 50,
      right: 920,
      bottom: 310,
      width: 820,
      height: 260,
      toJSON: () => ({}),
    } as DOMRect;
    screenRect = {
      x: 110,
      y: 70,
      left: 110,
      top: 70,
      right: 910,
      bottom: 310,
      width: 800,
      height: 240,
      toJSON: () => ({}),
    } as DOMRect;
    output = "";
    resetCount = 0;
    disposeCount = 0;
    options: Record<string, unknown>;
    private element: HTMLElement | null = null;
    private dataListener: ((data: string) => void) | null = null;
    private eventListeners = {
      cursorMove: new Set<() => void>(),
      render: new Set<() => void>(),
      resize: new Set<() => void>(),
      scroll: new Set<() => void>(),
      writeParsed: new Set<() => void>(),
    };

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      terminalMocks.instances.push(this);
    }

    loadAddon() {}
    open(parent: HTMLElement) {
      const element = parent.ownerDocument.createElement("div");
      element.className = "xterm";
      const screen = parent.ownerDocument.createElement("div");
      screen.className = "xterm-screen";
      screen.getBoundingClientRect = () => this.screenRect;
      element.append(screen);
      parent.append(element);
      parent.getBoundingClientRect = () => this.hostRect;
      this.element = element;
    }
    reset() {
      this.resetCount += 1;
      this.output = "";
    }
    write(value: string) { this.output += value; }
    dispose() {
      this.disposeCount += 1;
      this.element?.remove();
      this.element = null;
    }
    onData(listener: (data: string) => void) {
      this.dataListener = listener;
      return { dispose: () => { this.dataListener = null; } };
    }
    private subscribe(
      listeners: Set<() => void>,
      listener: () => void,
    ) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    }
    onCursorMove(listener: () => void) {
      return this.subscribe(this.eventListeners.cursorMove, listener);
    }
    onRender(listener: () => void) {
      return this.subscribe(this.eventListeners.render, listener);
    }
    onResize(listener: () => void) {
      return this.subscribe(this.eventListeners.resize, listener);
    }
    onScroll(listener: () => void) {
      return this.subscribe(this.eventListeners.scroll, listener);
    }
    onWriteParsed(listener: () => void) {
      return this.subscribe(this.eventListeners.writeParsed, listener);
    }
    emitData(data: string) { this.dataListener?.(data); }
    emitCursorMove() {
      for (const listener of this.eventListeners.cursorMove) listener();
    }
    emitRender() {
      for (const listener of this.eventListeners.render) listener();
    }
    emitResize() {
      for (const listener of this.eventListeners.resize) listener();
    }
    emitScroll() {
      for (const listener of this.eventListeners.scroll) listener();
    }
    emitWriteParsed() {
      for (const listener of this.eventListeners.writeParsed) listener();
    }
    listenerCount() {
      return (this.dataListener ? 1 : 0)
        + Object.values(this.eventListeners).reduce(
          (total, listeners) => total + listeners.size,
          0,
        );
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit() {}
  },
}));

import {
  SharedTerminal,
  type SharedTerminalProps,
  type SharedTerminalSnapshot,
} from "./SharedTerminal.js";

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function pointerEvent(
  type: string,
  clientX: number,
  clientY: number,
  pointerType = "mouse",
): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  return event as PointerEvent;
}

const baseSnapshot: SharedTerminalSnapshot = {
  generation: 1,
  revision: 0,
  transcript: "Eduri terminal\n",
  prompt: "/workspace $ ",
  input: "",
  cursor: 0,
  busy: false,
  inputOwnerParticipantId: "participant-local",
};

function props(
  snapshot: SharedTerminalSnapshot,
  overrides: Partial<SharedTerminalProps> = {},
): SharedTerminalProps {
  return {
    snapshot,
    localParticipantId: "participant-local",
    readOnly: false,
    theme: "light",
    onEditInput: vi.fn(),
    onSubmitLine: vi.fn(),
    onInterrupt: vi.fn(),
    onEof: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  mediaMocks.matches = true;
  mediaMocks.listeners.clear();
  vi.stubGlobal("matchMedia", vi.fn(() => mediaMocks.query));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  terminalMocks.instances.length = 0;
  mediaMocks.listeners.clear();
  vi.unstubAllGlobals();
});

describe("SharedTerminal", () => {
  it("renders the initial transcript and prompt when xterm mounts", async () => {
    await act(async () => {
      root?.render(<SharedTerminal {...props(baseSnapshot)} />);
    });

    expect(terminalMocks.instances).toHaveLength(1);
    expect(terminalMocks.instances[0]?.output)
      .toBe("Eduri terminal\r\n/workspace $ ");
    expect(terminalMocks.instances[0]?.resetCount).toBe(0);
  });

  it("keeps the latest local draft across delayed server echoes", async () => {
    const onEditInput = vi.fn();
    await act(async () => {
      root?.render(<SharedTerminal {...props(baseSnapshot, { onEditInput })} />);
    });
    const terminal = terminalMocks.instances[0];

    await act(async () => terminal?.emitData("a"));
    expect(onEditInput).toHaveBeenLastCalledWith("a", 1);

    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...baseSnapshot,
        revision: 1,
      }, { onEditInput })} />);
    });
    await act(async () => terminal?.emitData("b"));
    expect(onEditInput).toHaveBeenLastCalledWith("ab", 2);

    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...baseSnapshot,
        revision: 2,
        input: "ab",
        cursor: 2,
      }, { onEditInput })} />);
    });
    await act(async () => terminal?.emitData("\u007f"));
    expect(onEditInput).toHaveBeenLastCalledWith("a", 1);
  });

  it("never renders or publishes a glyph owned by another participant", async () => {
    const onEditInput = vi.fn();
    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...baseSnapshot,
        inputOwnerParticipantId: "participant-other",
        inputOwnerName: "Other user",
      }, { onEditInput })} />);
    });
    const terminal = terminalMocks.instances[0];
    const outputBeforeTyping = terminal?.output;

    await act(async () => terminal?.emitData("x"));

    expect(onEditInput).not.toHaveBeenCalled();
    expect(terminal?.output).toBe(outputBeforeTyping);
    expect(terminal?.options.disableStdin).toBe(true);
  });

  it("keeps a remote owner label collapsed and renders hostile names as text", async () => {
    const hostileName = '<img src=x onerror="alert(1)">';
    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...baseSnapshot,
        inputOwnerParticipantId: "participant-other",
        inputOwnerName: hostileName,
        inputOwnerColor: "not-a-color",
      })} />);
    });

    const terminal = terminalMocks.instances[0];
    const terminalHost = host?.querySelector<HTMLElement>(".code-shared-terminal");
    const caret = terminalHost?.querySelector<HTMLElement>(
      '[data-eduri-terminal-remote-caret="true"]',
    );
    const label = caret?.querySelector<HTMLElement>(
      '[data-eduri-terminal-remote-caret-label="true"]',
    );

    expect(caret?.getAttribute("aria-hidden")).toBe("true");
    expect(caret?.dataset.hovered).not.toBe("true");
    expect(caret?.style.display).toBe("block");
    expect(label?.style.opacity).not.toBe("1");
    expect(label?.style.visibility).not.toBe("visible");
    expect(label?.textContent).toBe(hostileName);
    expect(label?.style.backgroundColor).toBe("rgb(37, 99, 235)");
    expect(caret?.querySelector("img")).toBeNull();
    expect(caret?.querySelector("[onerror]")).toBeNull();
    expect(terminalHost?.querySelector(".xterm-screen")?.textContent).not.toContain("|");
    expect(terminal?.output).not.toContain("|");
  });

  it("reveals the remote label only for a hover-capable non-touch pointer", async () => {
    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...baseSnapshot,
        inputOwnerParticipantId: "participant-other",
        inputOwnerName: "Other user",
        inputOwnerColor: "#abcdef",
      })} />);
    });

    const terminalHost = host?.querySelector<HTMLElement>(".code-shared-terminal");
    const caret = terminalHost?.querySelector<HTMLElement>(
      '[data-eduri-terminal-remote-caret="true"]',
    );
    const label = caret?.querySelector<HTMLElement>(
      '[data-eduri-terminal-remote-caret-label="true"]',
    );
    const hitbox = caret?.querySelector<HTMLElement>(
      '[data-eduri-terminal-remote-caret-hitbox="true"]',
    );

    expect(hitbox?.style.height).toBe("18px");
    expect(caret?.style.pointerEvents).toBe("none");
    expect(hitbox?.style.pointerEvents).toBe("none");
    expect(label?.style.pointerEvents).toBe("none");
    terminalHost?.dispatchEvent(pointerEvent("pointermove", 140, 95));
    expect(caret?.dataset.hovered).toBe("true");
    expect(label?.style.opacity).toBe("1");
    expect(label?.style.visibility).toBe("visible");

    terminalHost?.dispatchEvent(pointerEvent("pointerleave", 140, 95));
    expect(caret?.dataset.hovered).toBe("false");
    expect(label?.style.opacity).toBe("0");
    expect(label?.style.visibility).toBe("hidden");

    mediaMocks.setMatches(false);
    terminalHost?.dispatchEvent(pointerEvent("pointermove", 140, 95));
    expect(caret?.dataset.hovered).toBe("false");
    expect(label?.style.visibility).toBe("hidden");

    mediaMocks.setMatches(true);
    terminalHost?.dispatchEvent(pointerEvent("pointermove", 140, 95, "touch"));
    expect(caret?.dataset.hovered).toBe("false");
    expect(label?.style.visibility).toBe("hidden");
  });

  it("tracks xterm cursor geometry across render, resize, and scroll events", async () => {
    const remoteSnapshot = {
      ...baseSnapshot,
      inputOwnerParticipantId: "participant-other",
      inputOwnerName: "Other user",
      inputOwnerColor: "#123456",
    };
    await act(async () => {
      root?.render(<SharedTerminal {...props(remoteSnapshot)} />);
    });

    const terminal = terminalMocks.instances[0];
    if (!terminal) throw new Error("terminal missing");
    const terminalHost = host?.querySelector<HTMLElement>(".code-shared-terminal");
    const caret = terminalHost?.querySelector<HTMLElement>(
      '[data-eduri-terminal-remote-caret="true"]',
    );
    expect(caret?.style.left).toBe("40px");
    expect(caret?.style.top).toBe("40px");

    terminal.buffer.active.cursorX = 7;
    terminal.buffer.active.cursorY = 3;
    terminal.emitCursorMove();
    expect(caret?.style.left).toBe("80px");
    expect(caret?.style.top).toBe("50px");

    terminal.cols = 40;
    terminal.rows = 12;
    terminal.emitResize();
    expect(caret?.style.left).toBe("150px");
    expect(caret?.style.top).toBe("80px");

    terminal.buffer.active.baseY = 10;
    terminal.buffer.active.viewportY = 11;
    terminal.emitScroll();
    expect(caret?.style.left).toBe("150px");
    expect(caret?.style.top).toBe("60px");

    terminal.buffer.active.cursorX = 9;
    terminal.emitWriteParsed();
    expect(caret?.style.left).toBe("190px");
    terminal.buffer.active.cursorX = 11;
    terminal.emitRender();
    expect(caret?.style.left).toBe("230px");

    terminal.buffer.active.viewportY = 20;
    terminal.emitScroll();
    expect(caret?.style.display).toBe("none");

    terminal.buffer.active.viewportY = 11;
    terminal.emitRender();
    expect(caret?.style.display).toBe("block");
    expect(terminalHost?.querySelectorAll(
      '[data-eduri-terminal-remote-caret="true"]',
    )).toHaveLength(1);
  });

  it("hides local or unowned carets and disposes the stable overlay", async () => {
    const remoteSnapshot = {
      ...baseSnapshot,
      inputOwnerParticipantId: "participant-other",
      inputOwnerName: "Other user",
      inputOwnerColor: "#123456",
    };
    await act(async () => {
      root?.render(<SharedTerminal {...props(remoteSnapshot)} />);
    });

    const terminal = terminalMocks.instances[0];
    if (!terminal) throw new Error("terminal missing");
    const terminalHost = host?.querySelector<HTMLElement>(".code-shared-terminal");
    const caret = terminalHost?.querySelector<HTMLElement>(
      '[data-eduri-terminal-remote-caret="true"]',
    );
    expect(caret?.style.display).toBe("block");
    expect(terminal.listenerCount()).toBe(6);
    expect(mediaMocks.listeners.size).toBe(1);

    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...remoteSnapshot,
        revision: 1,
        inputOwnerParticipantId: "participant-local",
      })} />);
    });
    expect(caret?.style.display).toBe("none");

    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...remoteSnapshot,
        revision: 2,
        inputOwnerParticipantId: null,
        inputOwnerName: null,
      })} />);
    });
    expect(caret?.style.display).toBe("none");
    expect(terminalHost?.querySelector(
      '[data-eduri-terminal-remote-caret="true"]',
    )).toBe(caret);

    await act(async () => root?.unmount());
    root = null;
    expect(caret?.isConnected).toBe(false);
    expect(terminal.disposeCount).toBe(1);
    expect(terminal.listenerCount()).toBe(0);
    expect(mediaMocks.listeners.size).toBe(0);
  });

  it("waits for the authoritative lease before accepting focused input", async () => {
    const onFocus = vi.fn();
    const onEditInput = vi.fn();
    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...baseSnapshot,
        inputOwnerParticipantId: null,
      }, { onFocus, onEditInput })} />);
    });
    const terminal = terminalMocks.instances[0];
    const terminalHost = host?.querySelector<HTMLElement>(".code-shared-terminal");

    await act(async () => terminalHost?.dispatchEvent(new FocusEvent("focusin", {
      bubbles: true,
    })));
    await act(async () => terminal?.emitData("a"));
    expect(onFocus).toHaveBeenCalledOnce();
    expect(onEditInput).not.toHaveBeenCalled();
    expect(terminal?.output).toBe("Eduri terminal\r\n/workspace $ ");
    expect(terminal?.options.disableStdin).toBe(false);

    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...baseSnapshot,
        revision: 1,
        inputOwnerParticipantId: "participant-local",
      }, { onFocus, onEditInput })} />);
    });
    expect(onEditInput).toHaveBeenLastCalledWith("a", 1);
    expect(terminal?.options.disableStdin).toBe(false);
  });

  it("reclaims input when a submitted command returns to the focused prompt", async () => {
    const onFocus = vi.fn();
    const onEditInput = vi.fn();
    const onSubmitLine = vi.fn();
    await act(async () => {
      root?.render(<SharedTerminal {...props(baseSnapshot, {
        onFocus,
        onEditInput,
        onSubmitLine,
      })} />);
    });
    const terminal = terminalMocks.instances[0];
    const terminalHost = host?.querySelector<HTMLElement>(".code-shared-terminal");
    await act(async () => terminalHost?.dispatchEvent(new FocusEvent("focusin", {
      bubbles: true,
    })));
    onFocus.mockClear();

    await act(async () => terminal?.emitData("\r"));
    expect(onSubmitLine).toHaveBeenCalledWith("");
    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...baseSnapshot,
        revision: 1,
        prompt: "",
        busy: true,
        inputOwnerParticipantId: null,
      }, { onFocus, onEditInput, onSubmitLine })} />);
    });
    expect(onFocus).not.toHaveBeenCalled();

    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...baseSnapshot,
        revision: 2,
        inputOwnerParticipantId: null,
      }, { onFocus, onEditInput, onSubmitLine })} />);
    });
    expect(onFocus).toHaveBeenCalledOnce();
    expect(terminal?.options.disableStdin).toBe(false);

    await act(async () => terminal?.emitData("x"));
    expect(onEditInput).not.toHaveBeenCalled();
    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...baseSnapshot,
        revision: 3,
      }, { onFocus, onEditInput, onSubmitLine })} />);
    });
    expect(onEditInput).toHaveBeenLastCalledWith("x", 1);
  });

  it("freezes the current line while a submit waits for synchronization", async () => {
    let resolveSubmit!: () => void;
    const submit = new Promise<void>((resolve) => {
      resolveSubmit = resolve;
    });
    const onSubmitLine = vi.fn(() => submit);
    const onEditInput = vi.fn();
    const command = {
      ...baseSnapshot,
      input: "pwd",
      cursor: 3,
    };
    await act(async () => {
      root?.render(<SharedTerminal {...props(command, {
        onEditInput,
        onSubmitLine,
      })} />);
    });
    const terminal = terminalMocks.instances[0];

    await act(async () => terminal?.emitData("\r"));
    await act(async () => terminal?.emitData("x"));
    expect(onSubmitLine).toHaveBeenCalledOnce();
    expect(onSubmitLine).toHaveBeenCalledWith("pwd");
    expect(onEditInput).not.toHaveBeenCalled();
    expect(terminal?.options.disableStdin).toBe(true);

    // A delayed echo of the last edit is not the submit acknowledgement and
    // must not unlock a newer input action ahead of the queued command.
    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...command,
        revision: 1,
      }, { onEditInput, onSubmitLine })} />);
    });
    await act(async () => terminal?.emitData("y"));
    expect(onEditInput).not.toHaveBeenCalled();
    expect(terminal?.options.disableStdin).toBe(true);

    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...command,
        revision: 2,
        prompt: "",
        input: "",
        cursor: 0,
        busy: true,
        inputOwnerParticipantId: null,
      }, { onEditInput, onSubmitLine })} />);
      resolveSubmit();
      await submit;
    });
    expect(terminal?.options.disableStdin).toBe(false);
  });

  it("unlocks a frozen line when the submit ACK is rejected", async () => {
    const onSubmitLine = vi.fn(async () => undefined);
    const onEditInput = vi.fn();
    await act(async () => {
      root?.render(<SharedTerminal {...props(baseSnapshot, {
        onEditInput,
        onSubmitLine,
      })} />);
    });
    const terminal = terminalMocks.instances[0];
    await act(async () => terminal?.emitData("\r"));
    await act(async () => terminal?.emitData("x"));
    expect(onEditInput).not.toHaveBeenCalled();

    await act(async () => {
      root?.render(<SharedTerminal {...props(baseSnapshot, {
        onEditInput,
        onSubmitLine,
        submitRejectionRevision: 1,
      })} />);
    });
    await act(async () => terminal?.emitData("x"));
    expect(onEditInput).toHaveBeenLastCalledWith("x", 1);
  });

  it("discards buffered claim input when another participant wins", async () => {
    const onEditInput = vi.fn();
    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...baseSnapshot,
        inputOwnerParticipantId: null,
      }, { onEditInput })} />);
    });
    const terminal = terminalMocks.instances[0];
    const terminalHost = host?.querySelector<HTMLElement>(".code-shared-terminal");
    await act(async () => terminalHost?.dispatchEvent(new FocusEvent("focusin", {
      bubbles: true,
    })));
    await act(async () => terminal?.emitData("x"));
    expect(terminal?.output).toBe("Eduri terminal\r\n/workspace $ ");

    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...baseSnapshot,
        revision: 1,
        inputOwnerParticipantId: "participant-other",
      }, { onEditInput })} />);
    });

    expect(onEditInput).not.toHaveBeenCalled();
    expect(terminal?.output).toBe("Eduri terminal\r\n/workspace $ ");
    expect(terminal?.options.disableStdin).toBe(true);
  });

  it("discards buffered input immediately when the claim ACK is rejected", async () => {
    const onEditInput = vi.fn();
    const unowned = {
      ...baseSnapshot,
      inputOwnerParticipantId: null,
    };
    await act(async () => {
      root?.render(<SharedTerminal {...props(unowned, { onEditInput })} />);
    });
    const terminal = terminalMocks.instances[0];
    const terminalHost = host?.querySelector<HTMLElement>(".code-shared-terminal");
    await act(async () => terminalHost?.dispatchEvent(new FocusEvent("focusin", {
      bubbles: true,
    })));
    await act(async () => terminal?.emitData("x"));

    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...unowned,
        revision: 1,
      }, {
        claimRejectionRevision: 1,
        onEditInput,
      })} />);
    });
    expect(onEditInput).not.toHaveBeenCalled();
    expect(terminal?.options.disableStdin).toBe(true);

    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...baseSnapshot,
        revision: 2,
      }, {
        claimRejectionRevision: 1,
        onEditInput,
      })} />);
    });
    expect(onEditInput).not.toHaveBeenCalled();
  });

  it("drops an optimistic draft immediately when the lease moves away", async () => {
    const onEditInput = vi.fn();
    await act(async () => {
      root?.render(<SharedTerminal {...props(baseSnapshot, { onEditInput })} />);
    });
    const terminal = terminalMocks.instances[0];
    await act(async () => terminal?.emitData("a"));
    expect(onEditInput).toHaveBeenCalledOnce();

    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...baseSnapshot,
        revision: 1,
        inputOwnerParticipantId: "participant-other",
      }, { onEditInput })} />);
    });
    const outputAfterLeaseLoss = terminal?.output;
    await act(async () => terminal?.emitData("b"));

    expect(onEditInput).toHaveBeenCalledOnce();
    expect(terminal?.output).toBe(outputAfterLeaseLoss);
    expect(terminal?.options.disableStdin).toBe(true);
  });

  it("rolls back a rejected optimistic edit before the next key", async () => {
    const onEditInput = vi.fn();
    await act(async () => {
      root?.render(<SharedTerminal {...props(baseSnapshot, { onEditInput })} />);
    });
    const terminal = terminalMocks.instances[0];
    await act(async () => terminal?.emitData("a"));
    expect(onEditInput).toHaveBeenLastCalledWith("a", 1);

    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...baseSnapshot,
        revision: 1,
      }, {
        claimRejectionRevision: 1,
        onEditInput,
      })} />);
    });
    await act(async () => terminal?.emitData("b"));

    expect(onEditInput).toHaveBeenLastCalledWith("b", 1);
  });

  it("appends partial program output without resetting scrollback or erasing it", async () => {
    const initial = {
      ...baseSnapshot,
      transcript: "Name: ",
      prompt: "",
      busy: true,
    };
    await act(async () => {
      root?.render(<SharedTerminal {...props(initial)} />);
    });
    const terminal = terminalMocks.instances[0];
    expect(terminal?.output).toBe("Name: ");

    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...initial,
        revision: 1,
        transcript: "Name: ready",
      })} />);
    });
    expect(terminal?.resetCount).toBe(0);
    expect(terminal?.output).toBe("Name: ready");

    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...initial,
        revision: 2,
        transcript: "Name: ready",
        busy: false,
      })} />);
      terminal?.emitData("A");
    });
    expect(terminal?.resetCount).toBe(0);
    expect(terminal?.output).not.toContain("\r\x1b[2K");
  });

  it("appends the new tail after bounded transcript prefix trimming", async () => {
    const initial = {
      ...baseSnapshot,
      transcript: "0123456789",
      input: "xy",
      cursor: 1,
    };
    await act(async () => {
      root?.render(<SharedTerminal {...props(initial)} />);
    });
    const terminal = terminalMocks.instances[0];
    if (!terminal) throw new Error("terminal missing");
    terminal.cols = 8;

    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...initial,
        revision: 1,
        transcript: "56789abc",
      })} />);
    });

    expect(terminal?.resetCount).toBe(0);
    expect(terminal?.output).toContain("abc");
    // The physical line still includes the trimmed "01234" prefix. Its
    // width must remain part of cursor placement after xterm reflows at 8 cols.
    expect(terminal.output).toMatch(/\r\x1b\[3C$/u);
  });

  it("clears every wrapped input row and recalculates after resize", async () => {
    const initial = {
      ...baseSnapshot,
      transcript: "ready\n",
      prompt: "$ ",
      input: "abcdefghijklmno",
      cursor: 7,
    };
    await act(async () => {
      root?.render(<SharedTerminal {...props(initial)} />);
    });
    const terminal = terminalMocks.instances[0];
    if (!terminal) throw new Error("terminal missing");
    terminal.cols = 8;
    const beforeEdit = terminal.output.length;

    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...initial,
        revision: 1,
        input: "abcdefhijklmno",
        cursor: 6,
      })} />);
    });
    const firstRedraw = terminal.output.slice(beforeEdit);
    expect(firstRedraw.match(/\x1b\[2K/gu)).toHaveLength(2);
    expect(firstRedraw).toContain("\x1b[2A");
    expect(terminal.resetCount).toBe(0);

    terminal.cols = 6;
    const beforeResizeEdit = terminal.output.length;
    await act(async () => {
      root?.render(<SharedTerminal {...props({
        ...initial,
        revision: 2,
        input: "abcdehijklmno",
        cursor: 5,
      })} />);
    });
    const resizedRedraw = terminal.output.slice(beforeResizeEdit);
    expect(resizedRedraw.match(/\x1b\[2K/gu)).toHaveLength(2);
    expect(resizedRedraw).toContain("\x1b[2A");
    expect(terminal.resetCount).toBe(0);
  });
});
