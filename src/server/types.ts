import type Database from "better-sqlite3";
import type { AppConfig } from "./config.js";
import type { LiveKitRoomService } from "./livekit.js";
import type { BoardSyncService } from "./board-v2/sync-service.js";
import type {
  AssetReadyEvent,
  BoardAssetService,
} from "./board-v2/assets.js";
import type { GuestRoomService } from "./guestRooms.js";
import type { CodeSyncService } from "./code-sync/service.js";
import type { CodeBlobService } from "./code-blobs/service.js";
import type { MaterialFileService } from "./material-files/service.js";
import type { LessonCodeSyncService } from "./lesson-code-sync/service.js";

export type Role = "admin" | "tutor" | "student";
export type AccountStatus = "pending" | "active" | "suspended";
export type LessonStatus = "scheduled" | "active" | "completed" | "cancelled";

export interface AuthUser {
  id: string;
  role: Role;
  status: AccountStatus;
  displayName: string;
  loginName?: string;
  tutorId?: string | null;
}

export interface AuthContext {
  user: AuthUser;
  sessionHash: string;
  rawSessionToken: string;
}

export interface GuestBoardAssetPrincipal {
  kind: "guest-board";
  shareKey: string;
}

export type BoardAssetPrincipal = AuthContext | GuestBoardAssetPrincipal;

export interface AppContext {
  config: AppConfig;
  db: Database.Database;
  ownsDatabase: boolean;
  dummyPasswordHash: string;
  livekitRoomService?: LiveKitRoomService;
  boardV2Sync?: BoardSyncService;
  boardAssets?: BoardAssetService<BoardAssetPrincipal>;
  codeSync: CodeSyncService;
  lessonCodeSync: LessonCodeSyncService;
  codeBlobs?: CodeBlobService;
  materialFiles: MaterialFileService;
  guestRooms: GuestRoomService;
  emitBoardAssetReady?: (event: AssetReadyEvent) => void | Promise<void>;
  stopBoardAssetMaintenance?: () => void;
  runGuestRoomMaintenance?: () => Promise<void>;
  stopGuestRoomMaintenance?: () => void;
  runLiveKitRevocationMaintenance?: () => Promise<void>;
  stopMaterialFileMaintenance?: () => void;
  disconnectUserSockets?: (userId: string) => void;
  disconnectSessionSockets?: (sessionHash: string) => void;
  removeLessonSocketMembership?: (lessonId: string, userId?: string) => void;
  emitLessonStatus?: (lessonId: string, status: LessonStatus) => void;
}

export interface StoredUserRow {
  id: string;
  role: Role;
  status: AccountStatus;
  display_name: string;
  login_name: string | null;
  login_name_normalized: string | null;
  credential_lookup: string | null;
  password_hash: string | null;
  tutor_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface InviteRow {
  id: string;
  target_user_id: string;
  purpose: "student_activation" | "tutor_activation" | "password_reset";
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  created_by: string;
  created_at: string;
}
