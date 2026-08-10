import {
  CODE_SYNC_PROTOCOL_VERSION,
  CODE_SYNC_TAGS,
  CODE_SYNC_UPDATE_ENCODING,
} from "./constants.js";

export interface CodeSyncHandshakeAuth {
  readonly shareId: string;
  readonly deviceId: string;
}

export interface CodeCursor {
  readonly entryId: string;
  readonly offset: number;
}

export interface CodeSelection {
  readonly entryId: string;
  readonly anchor: number;
  readonly head: number;
}

export type CodeTerminalAwareness =
  | {
      readonly kind: "host";
      readonly runId: string;
      readonly requestId: string;
    }
  | {
      readonly kind: "input";
      readonly runId: string;
      readonly requestId: string;
      readonly submissionId: string;
      readonly value: string;
    };

export interface CodeAwarenessState {
  readonly cursor?: CodeCursor;
  readonly selection?: CodeSelection;
  readonly terminal?: CodeTerminalAwareness;
}

export interface CodeParticipantIdentity {
  readonly participantId: string;
  readonly displayName: string;
  readonly color: string;
}

interface CodeSyncMessageBase {
  readonly protocolVersion: typeof CODE_SYNC_PROTOCOL_VERSION;
}

export interface CodeSyncStep1Message extends CodeSyncMessageBase {
  readonly type: typeof CODE_SYNC_TAGS.syncStep1;
  readonly requestId: string;
  readonly stateVector: Uint8Array;
}

export interface CodeSyncUpdateMessage extends CodeSyncMessageBase {
  readonly type: typeof CODE_SYNC_TAGS.update;
  readonly requestId: string;
  readonly updateId: string;
  readonly updateEncoding: typeof CODE_SYNC_UPDATE_ENCODING;
  readonly update: Uint8Array;
}

export interface CodeSyncAwarenessMessage extends CodeSyncMessageBase {
  readonly type: typeof CODE_SYNC_TAGS.awareness;
  readonly state: CodeAwarenessState | null;
}

export type CodeSyncClientMessage =
  | CodeSyncStep1Message
  | CodeSyncUpdateMessage
  | CodeSyncAwarenessMessage;

export interface CodeSyncReadyMessage extends CodeSyncMessageBase {
  readonly type: typeof CODE_SYNC_TAGS.ready;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly deviceId: string;
  readonly participant: CodeParticipantIdentity;
  readonly updateEncoding: typeof CODE_SYNC_UPDATE_ENCODING;
}

export interface CodeSyncStep2Message extends CodeSyncMessageBase {
  readonly type: typeof CODE_SYNC_TAGS.syncStep2;
  readonly requestId: string;
  readonly part: number;
  readonly done: boolean;
  readonly updateEncoding: typeof CODE_SYNC_UPDATE_ENCODING;
  readonly update: Uint8Array;
  readonly stateVector: Uint8Array;
  readonly sequence: number;
}

export interface CodeSyncRemoteUpdateMessage extends CodeSyncMessageBase {
  readonly type: typeof CODE_SYNC_TAGS.remoteUpdate;
  readonly sourceParticipantId: string;
  readonly updateId: string;
  readonly updateEncoding: typeof CODE_SYNC_UPDATE_ENCODING;
  readonly update: Uint8Array;
  readonly sequence: number;
}

export interface CodeSyncUpdateAckMessage extends CodeSyncMessageBase {
  readonly type: typeof CODE_SYNC_TAGS.updateAck;
  readonly requestId: string;
  readonly updateId: string;
  readonly status: "committed" | "duplicate";
  readonly sequence: number;
}

export interface CodeSyncRemoteAwarenessMessage extends CodeSyncMessageBase {
  readonly type: typeof CODE_SYNC_TAGS.awareness;
  readonly participant: CodeParticipantIdentity;
  readonly state: CodeAwarenessState | null;
}

export type CodeSyncControlCode =
  | "expired"
  | "not-found"
  | "invalid-message"
  | "invalid-update"
  | "storage-error"
  | "rate-limited";

export interface CodeSyncControlMessage extends CodeSyncMessageBase {
  readonly type: typeof CODE_SYNC_TAGS.control;
  readonly code: CodeSyncControlCode;
  readonly message: string;
  readonly terminal: boolean;
  readonly requestId?: string;
}

export type CodeSyncServerMessage =
  | CodeSyncReadyMessage
  | CodeSyncStep2Message
  | CodeSyncRemoteUpdateMessage
  | CodeSyncUpdateAckMessage
  | CodeSyncRemoteAwarenessMessage
  | CodeSyncControlMessage;
