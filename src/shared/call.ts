import type { CollaborationProfile } from "./collaborationProfile";

export interface CallLobbyParticipant {
  readonly identity: string;
  readonly displayName: string;
  readonly color: CollaborationProfile["color"];
  readonly microphoneEnabled: boolean;
  readonly cameraEnabled: boolean;
  readonly screenShareEnabled: boolean;
}
