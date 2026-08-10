import { describe, expect, it } from "vitest";
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

  it("bounds cursor and selection awareness", () => {
    expect(parseCodeSyncClientMessage({
      type: CODE_SYNC_TAGS.awareness,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      state: {
        cursor: { entryId: "main-py", offset: 3 },
        selection: { entryId: "main-py", anchor: 1, head: 3 },
      },
    })).toMatchObject({
      state: {
        cursor: { entryId: "main-py", offset: 3 },
        selection: { entryId: "main-py", anchor: 1, head: 3 },
      },
    });
    expect(() => parseCodeSyncClientMessage({
      type: CODE_SYNC_TAGS.awareness,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      state: { cursor: { entryId: "main-py", offset: -1 } },
    })).toThrowError(CodeProtocolError);
  });

  it("accepts bounded terminal requests and input but rejects persisted-shaped payloads", () => {
    const host = {
      kind: "host",
      runId: "run-1",
      requestId: "request-1",
    } as const;
    const input = {
      kind: "input",
      runId: "run-1",
      requestId: "request-1",
      submissionId: "submission-1",
      value: "Ada",
    } as const;
    for (const terminal of [host, input]) {
      expect(parseCodeSyncClientMessage({
        type: CODE_SYNC_TAGS.awareness,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        state: { terminal },
      })).toMatchObject({ state: { terminal } });
    }
    for (const terminal of [
      { ...input, value: "two\nlines" },
      {
        ...input,
        value: "x".repeat(CODE_SYNC_LIMITS.maxTerminalInputCodeUnits + 1),
      },
      { ...host, value: "must-not-be-stored" },
    ]) {
      expect(() => parseCodeSyncClientMessage({
        type: CODE_SYNC_TAGS.awareness,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        state: { terminal },
      })).toThrowError(CodeProtocolError);
    }
  });
});
