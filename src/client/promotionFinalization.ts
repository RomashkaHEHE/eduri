import { ApiError, type GuestRoomDraft } from "./api";

export type GuestPromotionKind = "board" | "code";

export interface PendingGuestFinalization {
  readonly version: 1;
  readonly kind: GuestPromotionKind;
  readonly draft: GuestRoomDraft;
  readonly preparedAt: string;
}

const STORAGE_PREFIX = "eduri:guest-promotion-finalization:v1:";
const volatileFallback = new Map<string, string>();
const durableMirrors = new Set<string>();
const GENERIC_PROMOTION_ERROR =
  "Не удалось начать сеанс. Проверьте соединение и попробуйте ещё раз.";

export function guestPromotionErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.message.trim()) return error.message;
  return GENERIC_PROMOTION_ERROR;
}

function legacyKey(kind: GuestPromotionKind): string {
  return `${STORAGE_PREFIX}${kind}`;
}

function attemptKey(kind: GuestPromotionKind, draft: GuestRoomDraft): string {
  return `${legacyKey(kind)}:${encodeURIComponent(draft.room.shareId)}`;
}

function belongsToKind(storageKey: string, kind: GuestPromotionKind): boolean {
  const base = legacyKey(kind);
  return storageKey === base || storageKey.startsWith(`${base}:`);
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function validRecord(
  value: unknown,
  kind: GuestPromotionKind,
): value is PendingGuestFinalization {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PendingGuestFinalization>;
  return candidate.version === 1
    && candidate.kind === kind
    && typeof candidate.preparedAt === "string"
    && Boolean(candidate.draft)
    && typeof candidate.draft?.initializationToken === "string"
    && candidate.draft.initializationToken.length > 0
    && typeof candidate.draft.room?.shareId === "string"
    && candidate.draft.room.shareId.length > 0;
}

function parseRecord(
  serialized: string,
  kind: GuestPromotionKind,
): PendingGuestFinalization | null {
  try {
    const parsed: unknown = JSON.parse(serialized);
    return validRecord(parsed, kind) ? parsed : null;
  } catch {
    return null;
  }
}

function sameAttempt(
  record: PendingGuestFinalization,
  draft: GuestRoomDraft,
): boolean {
  return record.draft.room.shareId === draft.room.shareId
    && record.draft.initializationToken === draft.initializationToken;
}

interface StorageSnapshot {
  readonly entries: Map<string, string>;
  readonly complete: boolean;
}

function readPersistentEntries(kind: GuestPromotionKind): StorageSnapshot {
  const entries = new Map<string, string>();
  const storage = browserStorage();
  if (!storage) return { entries, complete: false };
  try {
    const length = storage.length;
    for (let index = 0; index < length; index += 1) {
      const storageKey = storage.key(index);
      if (!storageKey || !belongsToKind(storageKey, kind)) continue;
      const serialized = storage.getItem(storageKey);
      if (serialized !== null) entries.set(storageKey, serialized);
    }
    return { entries, complete: true };
  } catch {
    return { entries, complete: false };
  }
}

function readEntries(kind: GuestPromotionKind): Map<string, string> {
  const persistent = readPersistentEntries(kind);
  if (persistent.complete) {
    for (const storageKey of durableMirrors) {
      if (
        belongsToKind(storageKey, kind)
        && !persistent.entries.has(storageKey)
      ) {
        durableMirrors.delete(storageKey);
        volatileFallback.delete(storageKey);
      }
    }
    for (const [storageKey, serialized] of persistent.entries) {
      durableMirrors.add(storageKey);
      volatileFallback.set(storageKey, serialized);
    }
  }

  const result = new Map(persistent.entries);
  for (const [storageKey, serialized] of volatileFallback) {
    if (belongsToKind(storageKey, kind) && !result.has(storageKey)) {
      result.set(storageKey, serialized);
    }
  }
  return result;
}

function writeEntry(storageKey: string, serialized: string): void {
  volatileFallback.set(storageKey, serialized);
  const storage = browserStorage();
  if (!storage) {
    durableMirrors.delete(storageKey);
    return;
  }
  try {
    storage.setItem(storageKey, serialized);
    durableMirrors.add(storageKey);
  } catch {
    durableMirrors.delete(storageKey);
  }
}

function removeEntryIfUnchanged(
  storageKey: string,
  expectedSerialized: string,
): void {
  const storage = browserStorage();
  if (storage) {
    try {
      if (storage.getItem(storageKey) === expectedSerialized) {
        storage.removeItem(storageKey);
        durableMirrors.delete(storageKey);
      }
    } catch {
      // Keep the persistent record when it cannot be compared and removed.
    }
  }
  if (volatileFallback.get(storageKey) === expectedSerialized) {
    volatileFallback.delete(storageKey);
    durableMirrors.delete(storageKey);
  }
}

export function loadPendingGuestFinalization(
  kind: GuestPromotionKind,
): PendingGuestFinalization | null {
  const candidates: Array<{
    readonly storageKey: string;
    readonly serialized: string;
    readonly record: PendingGuestFinalization;
  }> = [];
  for (const [storageKey, serialized] of readEntries(kind)) {
    const record = parseRecord(serialized, kind);
    if (!record) {
      // Corrupt recovery metadata cannot authorize a server mutation.
      removeEntryIfUnchanged(storageKey, serialized);
      continue;
    }
    candidates.push({ storageKey, serialized, record });
  }
  candidates.sort((left, right) => (
    left.record.preparedAt.localeCompare(right.record.preparedAt)
    || left.storageKey.localeCompare(right.storageKey)
  ));
  return candidates[0]?.record ?? null;
}

export function savePendingGuestFinalization(
  kind: GuestPromotionKind,
  draft: GuestRoomDraft,
): void {
  const record: PendingGuestFinalization = {
    version: 1,
    kind,
    draft,
    preparedAt: new Date().toISOString(),
  };
  writeEntry(attemptKey(kind, draft), JSON.stringify(record));
}

export function clearPendingGuestFinalization(
  kind: GuestPromotionKind,
  draft: GuestRoomDraft,
): void {
  for (const [storageKey, serialized] of readEntries(kind)) {
    const record = parseRecord(serialized, kind);
    if (record && sameAttempt(record, draft)) {
      removeEntryIfUnchanged(storageKey, serialized);
    }
  }
}

export function isDefinitiveGuestFinalizationFailure(
  error: unknown,
): boolean {
  return error instanceof ApiError
    && (error.status === 400 || error.status === 404 || error.status === 410);
}
