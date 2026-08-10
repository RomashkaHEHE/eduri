import type { AppContext, InviteRow } from "./types.js";
import { newId, nowIso, randomToken, sha256 } from "./security.js";

export type InvitePurpose = InviteRow["purpose"];

export interface CreatedInvite {
  token: string;
  url: string;
  inviteUrl: string;
  expiresAt: string;
  purpose: InvitePurpose;
}

export function createInvite(
  context: AppContext,
  targetUserId: string,
  purpose: InvitePurpose,
  createdBy: string,
): CreatedInvite {
  const token = randomToken();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + context.config.inviteTtlHours * 60 * 60 * 1000).toISOString();
  context.db.prepare(`
    UPDATE invites SET revoked_at = ?
    WHERE target_user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL
  `).run(createdAt, targetUserId);
  context.db.prepare(`
    INSERT INTO invites (id, target_user_id, purpose, token_hash, expires_at, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(newId(), targetUserId, purpose, sha256(token), expiresAt, createdBy, createdAt);
  const origin = context.config.appOrigins[0] ?? "";
  const inviteUrl = `${origin}/activate#token=${encodeURIComponent(token)}`;
  return {
    token,
    url: inviteUrl,
    inviteUrl,
    expiresAt,
    purpose,
  };
}

export function findUsableInvite(context: AppContext, token: string): InviteRow | undefined {
  return context.db.prepare(`
    SELECT * FROM invites
    WHERE token_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
  `).get(sha256(token), nowIso()) as InviteRow | undefined;
}
