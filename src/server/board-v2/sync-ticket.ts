import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { CollaborationProfile } from "../../shared/collaborationProfile.js";

export const BOARD_SYNC_TICKET_TTL_MS = 60_000;
const MAX_ACTIVE_TICKETS = 10_000;
export const MAX_ACTIVE_BOARD_TICKETS_PER_SESSION = 32;
export const MAX_ACTIVE_BOARD_TICKETS_PER_USER = 64;
const TICKET_CONTEXT = "eduri-board-v2-sync-ticket\0";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u;

export interface BoardSyncTicketScope {
  boardId: string;
  lessonId: string;
  userId: string;
  sessionHash: string;
  generation: number;
  minSchemaVersion: number;
  maxSchemaVersion: number;
  capabilities: number;
  profile?: CollaborationProfile;
}

export interface IssuedBoardSyncTicket {
  ticket: string;
  expiresAt: string;
  scope: BoardSyncTicketScope;
}

interface StoredTicket {
  scope: BoardSyncTicketScope;
  expiresAtMs: number;
}

export class BoardSyncTicketError extends Error {
  constructor(message = "Board sync ticket is invalid or expired") {
    super(message);
    this.name = "BoardSyncTicketError";
  }
}

function ticketKey(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

export class BoardSyncTicketStore {
  private readonly tickets = new Map<string, StoredTicket>();
  private readonly activeBySession = new Map<string, number>();
  private readonly activeByUser = new Map<string, number>();

  constructor(
    private readonly signingKey: string,
    private readonly now: () => number = Date.now,
  ) {}

  issue(scope: BoardSyncTicketScope): IssuedBoardSyncTicket {
    this.removeExpired();
    if (this.tickets.size >= MAX_ACTIVE_TICKETS) {
      throw new BoardSyncTicketError("Too many active Board sync tickets");
    }
    if (
      (this.activeBySession.get(scope.sessionHash) ?? 0)
      >= MAX_ACTIVE_BOARD_TICKETS_PER_SESSION
    ) {
      throw new BoardSyncTicketError(
        "Too many active Board sync tickets for this session",
      );
    }
    if (
      (this.activeByUser.get(scope.userId) ?? 0)
      >= MAX_ACTIVE_BOARD_TICKETS_PER_USER
    ) {
      throw new BoardSyncTicketError(
        "Too many active Board sync tickets for this user",
      );
    }

    const nonce = randomBytes(32).toString("base64url");
    const signature = this.sign(nonce);
    const ticket = `${nonce}.${signature}`;
    const expiresAtMs = this.now() + BOARD_SYNC_TICKET_TTL_MS;
    const storedScope = Object.freeze({ ...scope });
    this.tickets.set(ticketKey(ticket), { scope: storedScope, expiresAtMs });
    this.increment(this.activeBySession, storedScope.sessionHash);
    this.increment(this.activeByUser, storedScope.userId);
    return {
      ticket,
      expiresAt: new Date(expiresAtMs).toISOString(),
      scope: storedScope,
    };
  }

  consume(ticket: string): BoardSyncTicketScope {
    if (typeof ticket !== "string" || !TOKEN_PATTERN.test(ticket)) {
      throw new BoardSyncTicketError();
    }
    const separator = ticket.indexOf(".");
    const nonce = ticket.slice(0, separator);
    const suppliedSignature = Buffer.from(ticket.slice(separator + 1), "base64url");
    const expectedSignature = Buffer.from(this.sign(nonce), "base64url");
    if (
      suppliedSignature.byteLength !== expectedSignature.byteLength
      || !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      throw new BoardSyncTicketError();
    }

    const key = ticketKey(ticket);
    const stored = this.tickets.get(key);
    // Consume before checking expiry so a failed attempt cannot be replayed.
    this.tickets.delete(key);
    if (stored) this.decrementScope(stored.scope);
    if (!stored || stored.expiresAtMs <= this.now()) {
      throw new BoardSyncTicketError();
    }
    return stored.scope;
  }

  clear(): void {
    this.tickets.clear();
    this.activeBySession.clear();
    this.activeByUser.clear();
  }

  private sign(nonce: string): string {
    return createHmac("sha256", this.signingKey)
      .update(TICKET_CONTEXT)
      .update(nonce)
      .digest("base64url");
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [key, ticket] of this.tickets) {
      if (ticket.expiresAtMs <= now) {
        this.tickets.delete(key);
        this.decrementScope(ticket.scope);
      }
    }
  }

  private increment(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  private decrement(counts: Map<string, number>, key: string): void {
    const next = (counts.get(key) ?? 0) - 1;
    if (next > 0) counts.set(key, next);
    else counts.delete(key);
  }

  private decrementScope(scope: BoardSyncTicketScope): void {
    this.decrement(this.activeBySession, scope.sessionHash);
    this.decrement(this.activeByUser, scope.userId);
  }
}
