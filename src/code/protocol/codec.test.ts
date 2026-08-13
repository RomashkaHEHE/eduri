import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  CODE_SYNC_PROTOCOL_VERSION,
  CODE_SYNC_LIMITS,
  CODE_SYNC_TAGS,
  CODE_SYNC_UPDATE_ENCODING,
  CodeProtocolError,
  parseCodeSyncClientMessage,
  parseCodeSyncHandshakeAuth,
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

  it("accepts and defensively copies relative selections on CRDT text targets", () => {
    const document = new Y.Doc();
    const text = document.getText("file:main-py:text");
    text.insert(0, "hello");
    const anchor = relativePosition(text, 1);
    const head = relativePosition(text, 4);
    const expectedAnchor = [...anchor];
    const expectedHead = [...head];
    const targets = [
      { kind: "file", entryId: "main-py", field: "text" },
      { kind: "test", testId: "test-1", field: "stdin" },
      { kind: "test", testId: "test-1", field: "expectedOutput" },
    ] as const;
    for (const target of targets) {
      const parsed = parseCodeSyncClientMessage({
        type: CODE_SYNC_TAGS.awareness,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        state: { target, selection: { anchor, head } },
      });
      expect(parsed).toMatchObject({ state: { target } });
      if (parsed.type !== CODE_SYNC_TAGS.awareness || parsed.state === null) {
        throw new Error("expected awareness state");
      }
      expect([...(parsed.state.selection?.anchor ?? [])]).toEqual(expectedAnchor);
      expect([...(parsed.state.selection?.head ?? [])]).toEqual(expectedHead);
    }
    const parsed = parseCodeSyncClientMessage({
      type: CODE_SYNC_TAGS.awareness,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      state: { target: targets[0], selection: { anchor, head } },
    });
    anchor.fill(0);
    head.fill(0);
    if (parsed.type !== CODE_SYNC_TAGS.awareness || parsed.state === null) {
      throw new Error("expected awareness state");
    }
    expect([...(parsed.state.selection?.anchor ?? [])]).toEqual(expectedAnchor);
    expect([...(parsed.state.selection?.head ?? [])]).toEqual(expectedHead);
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

  it("keeps scalar input and relative Y.Text selection mutually exclusive", () => {
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
        selection: { anchor: position, head: position },
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

  it("rejects selections for scalar, terminal, and explorer targets", () => {
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
          selection: { anchor: position, head: position },
        },
      })).toThrowError(CodeProtocolError);
    }
  });

  it("rejects malformed and oversized relative-position payloads", () => {
    const document = new Y.Doc();
    const position = relativePosition(document.getText("file:main-py:text"), 0);
    const invalidEndpoints = [
      "|",
      [],
      new Uint8Array(0),
      Uint8Array.of(255),
      new Uint8Array(CODE_SYNC_LIMITS.maxRelativePositionBytes + 1),
    ];
    for (const anchor of invalidEndpoints) {
      expect(() => parseCodeSyncClientMessage({
        type: CODE_SYNC_TAGS.awareness,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        state: {
          target: { kind: "file", entryId: "main-py", field: "text" },
          selection: { anchor, head: position },
        },
      })).toThrowError(CodeProtocolError);
    }
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
