import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  CODE_SYNC_CAPABILITIES,
  CODE_SYNC_PROTOCOL_VERSION,
  CODE_SYNC_LIMITS,
  CODE_SYNC_TAGS,
  CODE_SYNC_UPDATE_ENCODING,
  CodeProtocolError,
  parseCodeAwarenessState,
  parseCodeSyncClientMessage,
  parseCodeSyncHandshakeAuth,
  toLegacyCodeAwarenessState,
} from "./index.js";

describe("Code sync protocol codec", () => {
  function relativePosition(text: Y.Text, index: number): Uint8Array {
    return Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(text, index),
    );
  }

  it("accepts only shareId and deviceId in handshake auth", () => {
    const shareId = "a".repeat(43);
    expect(parseCodeSyncHandshakeAuth({ shareId, deviceId: "device-1" }))
      .toEqual({ shareId, deviceId: "device-1" });
    expect(() => parseCodeSyncHandshakeAuth({
      shareId,
      deviceId: "device-1",
      capability: "secret-in-url",
    })).toThrowError(CodeProtocolError);
  });

  it("copies tagged update-v1 payloads", () => {
    const source = Uint8Array.of(1, 2, 3);
    const parsed = parseCodeSyncClientMessage({
      type: CODE_SYNC_TAGS.update,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      requestId: "request-1",
      updateId: "update-1",
      updateEncoding: CODE_SYNC_UPDATE_ENCODING,
      update: source,
    });
    expect(parsed.type).toBe(CODE_SYNC_TAGS.update);
    if (parsed.type !== CODE_SYNC_TAGS.update) return;
    source[0] = 9;
    expect([...parsed.update]).toEqual([1, 2, 3]);
  });

  it("accepts only the canonical plural-awareness capability message", () => {
    expect(parseCodeSyncClientMessage({
      type: CODE_SYNC_TAGS.capabilities,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      capabilities: [CODE_SYNC_CAPABILITIES.multiSelectionAwareness],
    })).toEqual({
      type: CODE_SYNC_TAGS.capabilities,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      capabilities: [CODE_SYNC_CAPABILITIES.multiSelectionAwareness],
    });
    for (const capabilities of [
      [],
      ["unknown"],
      [
        CODE_SYNC_CAPABILITIES.multiSelectionAwareness,
        CODE_SYNC_CAPABILITIES.multiSelectionAwareness,
      ],
    ]) {
      expect(() => parseCodeSyncClientMessage({
        type: CODE_SYNC_TAGS.capabilities,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        capabilities,
      })).toThrowError(CodeProtocolError);
    }
  });

  it("rejects legacy, untagged, and unknown protocol messages", () => {
    expect(() => parseCodeSyncClientMessage({ id: "legacy", code: "x" }))
      .toThrowError(CodeProtocolError);
    expect(() => parseCodeSyncClientMessage({
      type: CODE_SYNC_TAGS.syncStep1,
      protocolVersion: 1,
      requestId: "request-1",
      stateVector: Uint8Array.of(0),
    })).toThrowError(CodeProtocolError);
    expect(() => parseCodeSyncClientMessage({
      type: CODE_SYNC_TAGS.syncStep1,
      protocolVersion: 2,
      requestId: "request-1",
      stateVector: Uint8Array.of(0),
    })).toThrowError(CodeProtocolError);
    expect(() => parseCodeSyncClientMessage(Object.create({
      type: CODE_SYNC_TAGS.syncStep1,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      requestId: "request-1",
      stateVector: Uint8Array.of(0),
    }))).toThrowError(CodeProtocolError);
  });

  it("accepts every canonical awareness target", () => {
    const targets = [
      { kind: "file", entryId: "main-py", field: "text" },
      { kind: "test", testId: "test-1", field: "stdin" },
      { kind: "test", testId: "test-1", field: "expectedOutput" },
      { kind: "test", testId: "test-1", field: "name" },
      { kind: "test", testId: "test-1", field: "timeout" },
      { kind: "terminal", field: "input" },
      { kind: "explorer", entryId: "main-py", field: "rename" },
    ] as const;
    for (const target of targets) {
      expect(parseCodeSyncClientMessage({
        type: CODE_SYNC_TAGS.awareness,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        state: { target },
      })).toMatchObject({ state: { target } });
    }
  });

  it("preserves ordered directional selections and defensively copies every endpoint", () => {
    const document = new Y.Doc();
    const text = document.getText("file:main-py:text");
    text.insert(0, "hello");
    const selections = [
      { anchor: relativePosition(text, 4), head: relativePosition(text, 1) },
      { anchor: relativePosition(text, 2), head: relativePosition(text, 2) },
      { anchor: relativePosition(text, 0), head: relativePosition(text, 5) },
    ];
    const expected = selections.map(({ anchor, head }) => ({
      anchor: [...anchor],
      head: [...head],
    }));
    const targets = [
      { kind: "file", entryId: "main-py", field: "text" },
      { kind: "test", testId: "test-1", field: "stdin" },
      { kind: "test", testId: "test-1", field: "expectedOutput" },
    ] as const;
    for (const target of targets) {
      const parsed = parseCodeSyncClientMessage({
        type: CODE_SYNC_TAGS.awareness,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        state: { target, selections },
      });
      expect(parsed).toMatchObject({ state: { target } });
      if (
        parsed.type !== CODE_SYNC_TAGS.awareness
        || parsed.state === null
        || !("selections" in parsed.state)
      ) {
        throw new Error("expected plural awareness state");
      }
      expect(parsed.state.selections?.map(({ anchor, head }) => ({
        anchor: [...anchor],
        head: [...head],
      }))).toEqual(expected);
    }
    const parsed = parseCodeSyncClientMessage({
      type: CODE_SYNC_TAGS.awareness,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      state: { target: targets[0], selections },
    });
    selections[0]!.anchor.fill(0);
    selections[0]!.head.fill(0);
    selections.splice(0, selections.length);
    if (
      parsed.type !== CODE_SYNC_TAGS.awareness
      || parsed.state === null
      || !("selections" in parsed.state)
    ) {
      throw new Error("expected plural awareness state");
    }
    expect(parsed.state.selections?.map(({ anchor, head }) => ({
      anchor: [...anchor],
      head: [...head],
    }))).toEqual(expected);
    document.destroy();
  });

  it("accepts exactly 32 Y.Text selections and legacy singular ingress", () => {
    const document = new Y.Doc();
    const text = document.getText("file:main-py:text");
    text.insert(0, "hello");
    const maximum = Array.from(
      { length: CODE_SYNC_LIMITS.maxYTextSelections },
      (_, index) => ({
        anchor: relativePosition(text, index % (text.length + 1)),
        head: relativePosition(text, (index + 1) % (text.length + 1)),
      }),
    );
    expect(parseCodeAwarenessState({
      target: { kind: "file", entryId: "main-py", field: "text" },
      selections: maximum,
    }).selections).toHaveLength(CODE_SYNC_LIMITS.maxYTextSelections);

    const legacy = maximum[0]!;
    const normalized = parseCodeAwarenessState({
      target: { kind: "file", entryId: "main-py", field: "text" },
      selection: legacy,
    });
    expect(normalized).not.toHaveProperty("selection");
    expect(normalized.selections).toHaveLength(1);
    expect(normalized.selections?.[0]).toEqual(legacy);
    expect(normalized.selections?.[0]).not.toBe(legacy);
    expect(normalized.selections?.[0]?.anchor).not.toBe(legacy.anchor);
    expect(normalized.selections?.[0]?.head).not.toBe(legacy.head);
    document.destroy();
  });

  it("downgrades plural awareness to a defensive copy of the primary selection", () => {
    const document = new Y.Doc();
    const text = document.getText("file:main-py:text");
    text.insert(0, "hello");
    const primary = {
      anchor: relativePosition(text, 4),
      head: relativePosition(text, 1),
    };
    const secondary = {
      anchor: relativePosition(text, 2),
      head: relativePosition(text, 5),
    };
    const legacy = toLegacyCodeAwarenessState({
      target: { kind: "file", entryId: "main-py", field: "text" },
      selections: [primary, secondary],
    });
    expect(legacy).toEqual({
      target: { kind: "file", entryId: "main-py", field: "text" },
      selection: primary,
    });
    if (!("selection" in legacy) || !legacy.selection) {
      throw new Error("expected legacy selection");
    }
    expect(legacy.selection.anchor).not.toBe(primary.anchor);
    expect(legacy.selection.head).not.toBe(primary.head);
    primary.anchor.fill(0);
    primary.head.fill(0);
    expect([...legacy.selection.anchor]).not.toEqual([...primary.anchor]);
    expect([...legacy.selection.head]).not.toEqual([...primary.head]);
    document.destroy();
  });

  it("accepts directional UTF-16 selections with bounded scalar drafts", () => {
    const targets = [
      { kind: "test", testId: "test-1", field: "name" },
      { kind: "test", testId: "test-1", field: "timeout" },
      { kind: "explorer", entryId: "main-py", field: "rename" },
    ] as const;
    for (const target of targets) {
      const parsed = parseCodeSyncClientMessage({
        type: CODE_SYNC_TAGS.awareness,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        state: {
          target,
          input: {
            draft: "a😀b",
            selection: { anchor: 3, head: 1 },
          },
        },
      });
      expect(parsed).toEqual({
        type: CODE_SYNC_TAGS.awareness,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        state: {
          target,
          input: {
            draft: "a😀b",
            selection: { anchor: 3, head: 1 },
          },
        },
      });
    }
  });

  it("keeps scalar input and relative Y.Text selections mutually exclusive", () => {
    const document = new Y.Doc();
    const position = relativePosition(document.getText("file:main-py:text"), 0);
    expect(() => parseCodeSyncClientMessage({
      type: CODE_SYNC_TAGS.awareness,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      state: {
        target: { kind: "file", entryId: "main-py", field: "text" },
        input: { draft: "x", selection: { anchor: 1, head: 1 } },
      },
    })).toThrowError(CodeProtocolError);
    expect(() => parseCodeSyncClientMessage({
      type: CODE_SYNC_TAGS.awareness,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      state: {
        target: { kind: "test", testId: "test-1", field: "name" },
        selections: [{ anchor: position, head: position }],
      },
    })).toThrowError(CodeProtocolError);
    expect(() => parseCodeSyncClientMessage({
      type: CODE_SYNC_TAGS.awareness,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      state: {
        target: { kind: "terminal", field: "input" },
        input: { draft: "x", selection: { anchor: 1, head: 1 } },
      },
    })).toThrowError(CodeProtocolError);
  });

  it("rejects malformed, out-of-range, and oversized scalar input", () => {
    const target = { kind: "test", testId: "test-1", field: "name" };
    const invalidInputs = [
      undefined,
      null,
      { draft: "x" },
      { draft: "x", selection: { anchor: 0 } },
      { draft: "x", selection: { anchor: 0, head: 0, affinity: "left" } },
      { draft: "x", selection: { anchor: -1, head: 0 } },
      { draft: "x", selection: { anchor: 0, head: 2 } },
      { draft: "x", selection: { anchor: 0.5, head: 1 } },
      { draft: "x", selection: { anchor: Number.NaN, head: 1 } },
      {
        draft: "x".repeat(CODE_SYNC_LIMITS.maxScalarDraftLength + 1),
        selection: { anchor: 0, head: 0 },
      },
    ];
    for (const input of invalidInputs) {
      expect(() => parseCodeSyncClientMessage({
        type: CODE_SYNC_TAGS.awareness,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        state: { target, input },
      })).toThrowError(CodeProtocolError);
    }
    expect(() => parseCodeSyncClientMessage({
      type: CODE_SYNC_TAGS.awareness,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      state: {
        target,
        input: {
          draft: "\u0000".repeat(CODE_SYNC_LIMITS.maxScalarDraftLength),
          selection: { anchor: 0, head: 0 },
        },
      },
    })).toThrowError(CodeProtocolError);
  });

  it("rejects plural selections for scalar, terminal, and explorer targets", () => {
    const document = new Y.Doc();
    const text = document.getText("test:test-1:stdin");
    const position = relativePosition(text, 0);
    const targets = [
      { kind: "test", testId: "test-1", field: "name" },
      { kind: "test", testId: "test-1", field: "timeout" },
      { kind: "terminal", field: "input" },
      { kind: "explorer", entryId: "main-py", field: "rename" },
    ] as const;
    for (const target of targets) {
      expect(() => parseCodeSyncClientMessage({
        type: CODE_SYNC_TAGS.awareness,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        state: {
          target,
          selections: [{ anchor: position, head: position }],
        },
      })).toThrowError(CodeProtocolError);
    }
  });

  it("rejects malformed and oversized plural selection payloads", () => {
    const document = new Y.Doc();
    const position = relativePosition(document.getText("file:main-py:text"), 0);
    const sparse = new Array(2);
    sparse[1] = { anchor: position, head: position };
    const invalidSelections = [
      undefined,
      null,
      {},
      [],
      sparse,
      [{ anchor: position }],
      [{ anchor: position, head: position, affinity: "left" }],
      [{ anchor: "|", head: position }],
      [{ anchor: [], head: position }],
      [{ anchor: new Uint8Array(0), head: position }],
      [{ anchor: Uint8Array.of(255), head: position }],
      [{
        anchor: new Uint8Array(CODE_SYNC_LIMITS.maxRelativePositionBytes + 1),
        head: position,
      }],
      Array.from(
        { length: CODE_SYNC_LIMITS.maxYTextSelections + 1 },
        () => ({ anchor: position, head: position }),
      ),
    ];
    for (const selections of invalidSelections) {
      expect(() => parseCodeSyncClientMessage({
        type: CODE_SYNC_TAGS.awareness,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        state: {
          target: { kind: "file", entryId: "main-py", field: "text" },
          selections,
        },
      })).toThrowError(CodeProtocolError);
    }

    expect(() => parseCodeAwarenessState({
      target: { kind: "file", entryId: "main-py", field: "text" },
      selection: { anchor: position, head: position },
      selections: [{ anchor: position, head: position }],
    })).toThrowError(CodeProtocolError);
    document.destroy();
  });

  it("applies the aggregate awareness byte limit to all relative selections", () => {
    const document = new Y.Doc();
    const longNamedText = document.getText("x".repeat(480));
    const position = relativePosition(longNamedText, 0);
    expect(position.byteLength).toBeLessThanOrEqual(
      CODE_SYNC_LIMITS.maxRelativePositionBytes,
    );
    const selections = Array.from({ length: 3 }, () => ({
      anchor: position,
      head: position,
    }));
    expect(selections.reduce((sum, selection) => (
      sum + selection.anchor.byteLength + selection.head.byteLength
    ), 0)).toBeGreaterThan(CODE_SYNC_LIMITS.maxAwarenessBytes);
    expect(() => parseCodeAwarenessState({
      target: { kind: "file", entryId: "main-py", field: "text" },
      selections,
    })).toThrowError(/awareness state exceeds its size limit/iu);
    expect(CODE_SYNC_LIMITS.maxYTextSelections).toBe(32);
    expect(CODE_SYNC_LIMITS.maxAwarenessBytes).toBe(2 * 1024);
    document.destroy();
  });

  it("rejects legacy awareness and unsupported fields fail-closed", () => {
    const legacyStates = [
      { cursor: { entryId: "main-py", offset: 3 } },
      {
        target: { kind: "file", entryId: "main-py", field: "text" },
        selection: { entryId: "main-py", anchor: 1, head: 3 },
      },
      {
        terminal: {
          kind: "host",
          runId: "run-1",
          requestId: "request-1",
        },
      },
      {
        terminal: {
          kind: "input",
          runId: "run-1",
          requestId: "request-1",
          submissionId: "submission-1",
          value: "|",
        },
      },
      { target: { kind: "terminal", field: "input", value: "|" } },
      { target: { kind: "file", entryId: "main-py", field: "|" } },
      {
        target: { kind: "file", entryId: "main-py", field: "text" },
        cursor: "|",
      },
    ];
    for (const state of legacyStates) {
      expect(() => parseCodeSyncClientMessage({
        type: CODE_SYNC_TAGS.awareness,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        state,
      })).toThrowError(CodeProtocolError);
    }
  });
});
