import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

import { BOARD_PROTOCOL_LIMITS } from "../../board/protocol/index.js";
import type { Role } from "../types.js";

const MAX_AWARENESS_CLOCK = 0xffff_fffe;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_ENTRIES = 1_024;
const MAX_JSON_STRING_BYTES = 16 * 1024;
const RESERVED_IDENTITY_KEYS = new Set([
  "userId",
  "displayName",
  "role",
  "color",
  "identity",
]);
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

export interface BoardAwarenessIdentity {
  userId: string;
  displayName: string;
  role: Exclude<Role, "admin"> | "guest";
  color: string;
}

export interface ParsedAwarenessUpdate {
  clientId: number;
  clock: number;
  state: Record<string, unknown> | null;
}

interface StoredAwarenessUpdate {
  clock: number;
  update: Uint8Array;
}

interface PreparedIdentityUpdate {
  states: Map<number, StoredAwarenessUpdate>;
  stored: StoredAwarenessUpdate;
}

interface JsonBudget {
  entries: number;
}

export class BoardAwarenessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardAwarenessError";
  }
}

function readCanonicalVarUint(
  decoder: decoding.Decoder<ArrayBufferLike>,
  max: number,
  field: string,
): number {
  const start = decoder.pos;
  let value: number;
  try {
    value = decoding.readVarUint(decoder);
  } catch {
    throw new BoardAwarenessError(`Invalid ${field}`);
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new BoardAwarenessError(`${field} is outside its allowed range`);
  }
  let expectedLength = 1;
  for (let remaining = value; remaining >= 128; remaining = Math.floor(remaining / 128)) {
    expectedLength += 1;
  }
  if (decoder.pos - start !== expectedLength) {
    throw new BoardAwarenessError(`${field} is not canonically encoded`);
  }
  return value;
}

function readStateJson(
  decoder: decoding.Decoder<ArrayBufferLike>,
): Record<string, unknown> | null {
  const length = readCanonicalVarUint(
    decoder,
    BOARD_PROTOCOL_LIMITS.maxAwarenessBytes,
    "awareness state length",
  );
  if (decoder.pos + length > decoder.arr.byteLength) {
    throw new BoardAwarenessError("Awareness state is truncated");
  }
  const bytes = decoding.readUint8Array(decoder, length);
  let json: string;
  try {
    json = textDecoder.decode(bytes);
  } catch {
    throw new BoardAwarenessError("Awareness state is not valid UTF-8");
  }
  let state: unknown;
  try {
    state = JSON.parse(json);
  } catch {
    throw new BoardAwarenessError("Awareness state is not valid JSON");
  }
  if (
    state !== null
    && (
      typeof state !== "object"
      || Array.isArray(state)
      || Object.getPrototypeOf(state) !== Object.prototype
    )
  ) {
    throw new BoardAwarenessError("Awareness state must be an object or null");
  }
  return state as Record<string, unknown> | null;
}

function sanitizeJson(
  value: unknown,
  depth: number,
  budget: JsonBudget,
): unknown {
  if (depth > MAX_JSON_DEPTH) {
    throw new BoardAwarenessError("Awareness state is nested too deeply");
  }
  budget.entries += 1;
  if (budget.entries > MAX_JSON_ENTRIES) {
    throw new BoardAwarenessError("Awareness state contains too many values");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new BoardAwarenessError("Awareness state contains a non-finite number");
    }
    return value;
  }
  if (typeof value === "string") {
    if (textEncoder.encode(value).byteLength > MAX_JSON_STRING_BYTES) {
      throw new BoardAwarenessError("Awareness state contains an oversized string");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJson(entry, depth + 1, budget));
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (
        key === "__proto__"
        || key === "constructor"
        || key === "prototype"
        || RESERVED_IDENTITY_KEYS.has(key)
      ) {
        continue;
      }
      result[key] = sanitizeJson(entry, depth + 1, budget);
    }
    return result;
  }
  throw new BoardAwarenessError("Awareness state contains an unsupported value");
}

export function parseAwarenessUpdate(update: Uint8Array): ParsedAwarenessUpdate {
  const decoder = decoding.createDecoder(update);
  const count = readCanonicalVarUint(decoder, 1, "awareness client count");
  if (count !== 1) {
    throw new BoardAwarenessError("A client awareness update must contain exactly one client");
  }
  const clientId = readCanonicalVarUint(decoder, 0xffff_ffff, "awareness client ID");
  const clock = readCanonicalVarUint(decoder, MAX_AWARENESS_CLOCK, "awareness clock");
  const state = readStateJson(decoder);
  if (decoding.hasContent(decoder)) {
    throw new BoardAwarenessError("Awareness update contains trailing bytes");
  }
  return { clientId, clock, state };
}

export function encodeAwarenessState(
  clientId: number,
  clock: number,
  state: Record<string, unknown> | null,
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint(encoder, clientId);
  encoding.writeVarUint(encoder, clock);
  encoding.writeVarString(encoder, JSON.stringify(state));
  return encoding.toUint8Array(encoder);
}

export function authorizeAwarenessUpdate(
  update: Uint8Array,
  expectedClientId: number,
  identity: BoardAwarenessIdentity,
): ParsedAwarenessUpdate & { update: Uint8Array } {
  const parsed = parseAwarenessUpdate(update);
  if (parsed.clientId !== expectedClientId) {
    throw new BoardAwarenessError("A connection cannot update another awareness client ID");
  }
  if (parsed.state === null) return { ...parsed, update };

  const sanitized = sanitizeJson(parsed.state, 0, { entries: 0 }) as Record<string, unknown>;
  const authoritative = {
    ...sanitized,
    userId: identity.userId,
    displayName: identity.displayName,
    role: identity.role,
    color: identity.color,
  };
  const authorizedUpdate = encodeAwarenessState(
    parsed.clientId,
    parsed.clock,
    authoritative,
  );
  if (authorizedUpdate.byteLength > BOARD_PROTOCOL_LIMITS.maxAwarenessBytes) {
    throw new BoardAwarenessError("Authorized awareness update exceeds the size limit");
  }
  return { ...parsed, state: authoritative, update: authorizedUpdate };
}

export class BoardAwarenessRegistry {
  private readonly documents = new Map<string, Map<number, StoredAwarenessUpdate>>();

  accept(
    documentIdentity: string,
    update: ParsedAwarenessUpdate & { update: Uint8Array },
  ): Uint8Array | null {
    const states = this.documents.get(documentIdentity) ?? new Map();
    const previous = states.get(update.clientId);
    if (
      previous
      && (
        update.clock < previous.clock
        || (update.clock === previous.clock && update.state !== null)
      )
    ) {
      return null;
    }
    if (update.state === null) {
      states.delete(update.clientId);
      if (states.size === 0) this.documents.delete(documentIdentity);
    } else {
      states.set(update.clientId, {
        clock: update.clock,
        update: update.update.slice(),
      });
      this.documents.set(documentIdentity, states);
    }
    return update.update;
  }

  current(documentIdentity: string): Uint8Array[] {
    return [...(this.documents.get(documentIdentity)?.values() ?? [])]
      .map((state) => state.update.slice());
  }

  updateIdentitiesAtomically(
    documentIdentities: readonly string[],
    clientId: number,
    identity: BoardAwarenessIdentity,
  ): ReadonlyMap<string, Uint8Array> {
    const prepared = new Map<string, PreparedIdentityUpdate>();
    const result = new Map<string, Uint8Array>();

    // Complete every fallible operation before mutating any document.
    for (const documentIdentity of new Set(documentIdentities)) {
      const states = this.documents.get(documentIdentity);
      const previous = states?.get(clientId);
      if (!states || !previous) continue;
      if (previous.clock >= MAX_AWARENESS_CLOCK - 1) {
        throw new BoardAwarenessError(
          "Awareness clock cannot advance for a profile update",
        );
      }
      const parsed = parseAwarenessUpdate(previous.update);
      if (parsed.state === null) continue;
      const update = authorizeAwarenessUpdate(
        encodeAwarenessState(clientId, previous.clock + 1, parsed.state),
        clientId,
        identity,
      );
      prepared.set(documentIdentity, {
        states,
        stored: {
          clock: update.clock,
          update: update.update.slice(),
        },
      });
      result.set(documentIdentity, update.update.slice());
    }

    for (const { states, stored } of prepared.values()) {
      states.set(clientId, stored);
    }
    return result;
  }

  remove(documentIdentity: string, clientId: number): Uint8Array | null {
    const states = this.documents.get(documentIdentity);
    const previous = states?.get(clientId);
    if (!states || !previous) return null;
    states.delete(clientId);
    if (states.size === 0) this.documents.delete(documentIdentity);
    return encodeAwarenessState(clientId, previous.clock + 1, null);
  }

  clear(): void {
    this.documents.clear();
  }
}
