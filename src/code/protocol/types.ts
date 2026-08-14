import {
  CODE_SYNC_CAPABILITIES,
  CODE_SYNC_PROTOCOL_VERSION,
  CODE_SYNC_TAGS,
  CODE_SYNC_UPDATE_ENCODING,
} from "./constants.js";
import type { CollaborationProfile } from "../../shared/collaborationProfile.js";

export interface CodeSyncHandshakeAuth {
  readonly shareId: string;
  readonly deviceId: string;
  readonly profile?: CollaborationProfile;
}

export type CodeYTextAwarenessTarget =
  | {
      readonly kind: "file";
      readonly entryId: string;
      readonly field: "text";
    }
  | {
      readonly kind: "test";
      readonly testId: string;
      readonly field: "stdin" | "expectedOutput";
    };

export type CodeScalarAwarenessTarget =
  | {
      readonly kind: "test";
      readonly testId: string;
      readonly field: "name" | "timeout";
    }
  | {
      readonly kind: "explorer";
      readonly entryId: string;
      readonly field: "rename";
    };

export interface CodeTerminalAwarenessTarget {
  readonly kind: "terminal";
  readonly field: "input";
}

export type CodeAwarenessTarget =
  | CodeYTextAwarenessTarget
  | CodeScalarAwarenessTarget
  | CodeTerminalAwarenessTarget;

export interface CodeRelativeSelection {
  readonly anchor: Uint8Array;
  readonly head: Uint8Array;
}

export interface CodeAbsoluteSelection {
  /** UTF-16 offset into the accompanying scalar draft. */
  readonly anchor: number;
  /** UTF-16 offset into the accompanying scalar draft. */
  readonly head: number;
}

export interface CodeScalarInputPresence {
  readonly draft: string;
  readonly selection: CodeAbsoluteSelection;
}

export type CodeAwarenessState =
  | {
      readonly target: CodeYTextAwarenessTarget;
      readonly selections?: readonly CodeRelativeSelection[];
      readonly input?: undefined;
    }
  | {
      readonly target: CodeScalarAwarenessTarget;
      readonly input?: CodeScalarInputPresence;
      readonly selections?: undefined;
    }
  | {
      readonly target: CodeTerminalAwarenessTarget;
      readonly selections?: undefined;
      readonly input?: undefined;
    };

/** Legacy protocol-v3 shape used only for recipients without plural awareness. */
export type CodeLegacyAwarenessState =
  | {
      readonly target: CodeYTextAwarenessTarget;
      readonly selection?: CodeRelativeSelection;
      readonly input?: undefined;
    }
  | Exclude<CodeAwarenessState, { readonly target: CodeYTextAwarenessTarget }>;

export type CodeAwarenessWireState =
  | CodeAwarenessState
  | CodeLegacyAwarenessState;

export type CodeSyncCapability =
  typeof CODE_SYNC_CAPABILITIES.multiSelectionAwareness;

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
  readonly state: CodeAwarenessWireState | null;
}

export interface CodeSyncCapabilitiesMessage extends CodeSyncMessageBase {
  readonly type: typeof CODE_SYNC_TAGS.capabilities;
  readonly capabilities: readonly [CodeSyncCapability];
}

export interface CodeSyncProfileUpdateMessage extends CodeSyncMessageBase {
  readonly type: typeof CODE_SYNC_TAGS.profileUpdate;
  readonly profile: CollaborationProfile;
}

export type CodeSyncClientMessage =
  | CodeSyncStep1Message
  | CodeSyncUpdateMessage
  | CodeSyncAwarenessMessage
  | CodeSyncCapabilitiesMessage
  | CodeSyncProfileUpdateMessage;

export interface CodeSyncReadyMessage extends CodeSyncMessageBase {
  readonly type: typeof CODE_SYNC_TAGS.ready;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly deviceId: string;
  readonly participant: CodeParticipantIdentity;
  readonly updateEncoding: typeof CODE_SYNC_UPDATE_ENCODING;
  readonly capabilities?: readonly CodeSyncCapability[];
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
  readonly state: CodeAwarenessWireState | null;
}

export interface CodeSyncProfileUpdatedMessage extends CodeSyncMessageBase {
  readonly type: typeof CODE_SYNC_TAGS.profileUpdated;
  readonly participant: CodeParticipantIdentity;
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
  | CodeSyncProfileUpdatedMessage
  | CodeSyncControlMessage;
