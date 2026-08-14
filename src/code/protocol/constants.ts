export const CODE_SYNC_PROTOCOL_VERSION = 3 as const;
export const CODE_SYNC_UPDATE_ENCODING = "yjs-update-v1" as const;

export const CODE_SYNC_NAMESPACE = "/code-sync";
export const CODE_SYNC_MESSAGE_EVENT = "code-sync:message";

export const CODE_SYNC_CAPABILITIES = {
  multiSelectionAwareness: "multi-selection-awareness-v1",
} as const;

export const CODE_SYNC_TAGS = {
  syncStep1: "eduri.code.sync-step1",
  update: "eduri.code.update",
  awareness: "eduri.code.awareness",
  ready: "eduri.code.ready",
  syncStep2: "eduri.code.sync-step2",
  remoteUpdate: "eduri.code.remote-update",
  updateAck: "eduri.code.update-ack",
  capabilities: "eduri.code.capabilities",
  profileUpdate: "eduri.code.profile-update",
  profileUpdated: "eduri.code.profile-updated",
  control: "eduri.code.control",
} as const;

export const CODE_SYNC_LIMITS = {
  maxUpdateBytes: 4 * 1024 * 1024,
  maxStateVectorBytes: 64 * 1024,
  maxAwarenessBytes: 2 * 1024,
  maxIdentifierLength: 128,
  maxRelativePositionBytes: 512,
  maxYTextSelections: 32,
  maxScalarDraftLength: 1024,
} as const;
