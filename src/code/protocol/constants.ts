export const CODE_SYNC_PROTOCOL_VERSION = 1 as const;
export const CODE_SYNC_UPDATE_ENCODING = "yjs-update-v1" as const;

export const CODE_SYNC_NAMESPACE = "/code-sync";
export const CODE_SYNC_MESSAGE_EVENT = "code-sync:message";

export const CODE_SYNC_TAGS = {
  syncStep1: "eduri.code.sync-step1",
  update: "eduri.code.update",
  awareness: "eduri.code.awareness",
  ready: "eduri.code.ready",
  syncStep2: "eduri.code.sync-step2",
  remoteUpdate: "eduri.code.remote-update",
  updateAck: "eduri.code.update-ack",
  control: "eduri.code.control",
} as const;

export const CODE_SYNC_LIMITS = {
  maxUpdateBytes: 4 * 1024 * 1024,
  maxStateVectorBytes: 64 * 1024,
  maxAwarenessBytes: 2 * 1024,
  maxIdentifierLength: 128,
  maxTextOffset: 2 * 1024 * 1024,
  maxTerminalInputCodeUnits: 1_024,
} as const;
