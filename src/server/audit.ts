import type { Request, Response } from "express";
import type { AppContext } from "./types.js";
import { getClientIp, newId, nowIso } from "./security.js";
import { currentAuth } from "./http.js";

export function writeAudit(
  context: AppContext,
  req: Request,
  res: Response,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata: Record<string, unknown> = {},
): void {
  const actor = currentAuth(res).user;
  context.db.prepare(`
    INSERT INTO audit_log (id, actor_id, action, target_type, target_id, metadata_json, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newId(), actor.id, action, targetType, targetId, JSON.stringify(metadata), getClientIp(req), nowIso());
}
