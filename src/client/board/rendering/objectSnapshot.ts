import * as Y from "yjs";
import {
  normalizeAtomicTransform,
  readBoardObject,
  type AtomicTransform,
  type BoardObjectRecord,
} from "../../../board/core";
import { inspectBoardObjectRendering } from "./pluginRegistry";
import type { BoardObjectSnapshot } from "./types";

const fallbackIds = new WeakMap<object, string>();
let fallbackIdSequence = 0;

function snapshotValue(value: unknown, ancestors = new Set<object>()): unknown {
  if (value instanceof Y.Text) return value.toString();
  if (value instanceof Uint8Array) return value.slice();
  if (value && typeof value === "object") {
    if (ancestors.has(value)) throw new TypeError("Board value contains a cycle");
    ancestors.add(value);
  }
  try {
    if (value instanceof Y.Map) {
      return Object.fromEntries(
        [...value.entries()].map(([key, entry]) => [key, snapshotValue(entry, ancestors)]),
      );
    }
    if (value instanceof Y.Array) {
      return value.toArray().map((entry) => snapshotValue(entry, ancestors));
    }
    if (Array.isArray(value)) {
      return value.map((entry) => snapshotValue(entry, ancestors));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .map(([key, entry]) => [key, snapshotValue(entry, ancestors)]),
      );
    }
    return value;
  } finally {
    if (value && typeof value === "object") ancestors.delete(value);
  }
}

function mapSnapshot(map: Y.Map<unknown>): Readonly<Record<string, unknown>> {
  return Object.fromEntries([...map.entries()].map(([key, value]) => [key, snapshotValue(value)]));
}

function fallbackId(value: unknown, objectIdHint?: string): string {
  if (value instanceof Y.Map) {
    const rawId = value.get("id");
    if (typeof rawId === "string" && rawId.length > 0) return rawId;

    const parentKey = (
      value as BoardObjectRecord & {
        _item?: { parentSub?: unknown };
      }
    )._item?.parentSub;
    if (typeof parentKey === "string" && parentKey.length > 0) return parentKey;
  }
  if (objectIdHint) return objectIdHint;

  if (value !== null && typeof value === "object") {
    const existing = fallbackIds.get(value);
    if (existing) return existing;
  }
  fallbackIdSequence += 1;
  const generated = `malformed-board-object-${fallbackIdSequence}`;
  if (value !== null && typeof value === "object") {
    fallbackIds.set(value, generated);
  }
  return generated;
}

function fallbackTransform(value: unknown): AtomicTransform {
  if (Array.isArray(value)) {
    try {
      return normalizeAtomicTransform(value as number[]);
    } catch {
      // Fall through to a bounded placeholder.
    }
  }
  return Object.freeze([0, 0, 180, 96, 0]) as AtomicTransform;
}

function tryMapSnapshot(value: unknown): Readonly<Record<string, unknown>> {
  if (!(value instanceof Y.Map)) return {};
  try {
    return mapSnapshot(value);
  } catch {
    return {};
  }
}

function malformedSnapshot(
  value: unknown,
  error: unknown,
  objectIdHint?: string,
): BoardObjectSnapshot {
  const record = value instanceof Y.Map ? value : null;
  const id = fallbackId(value, objectIdHint);
  const rawKind = record?.get("kind");
  const rawVersion = record?.get("version");
  const rawZRank = record?.get("zRank");
  const rawParentId = record?.get("parentId");
  const detail = error instanceof Error ? error.message.slice(0, 180) : "Malformed board object";
  return {
    id,
    kind: typeof rawKind === "string" && rawKind.length > 0 ? rawKind : "eduri/malformed",
    version: Number.isSafeInteger(rawVersion) && (rawVersion as number) > 0
      ? rawVersion as number
      : 1,
    transform: fallbackTransform(record?.get("transform")),
    zRank: typeof rawZRank === "string" && rawZRank.length > 0
      ? rawZRank
      : id,
    parentId: rawParentId === null || typeof rawParentId === "string" ? rawParentId : null,
    style: tryMapSnapshot(record?.get("style")),
    props: tryMapSnapshot(record?.get("props")),
    rendering: { status: "malformed", detail },
  };
}

export function boardObjectSnapshot(
  value: unknown,
  objectIdHint?: string,
): BoardObjectSnapshot {
  if (!(value instanceof Y.Map)) {
    return malformedSnapshot(
      value,
      new TypeError("Board object record is not a Y.Map"),
      objectIdHint,
    );
  }
  const record = value as BoardObjectRecord;
  try {
    const object = readBoardObject(record);
    const snapshot: BoardObjectSnapshot = {
      id: object.id,
      kind: object.kind,
      version: object.version,
      transform: object.transform,
      zRank: object.zRank,
      parentId: object.parentId,
      style: mapSnapshot(object.style),
      props: mapSnapshot(object.props),
    };
    return {
      ...snapshot,
      rendering: inspectBoardObjectRendering(snapshot),
    };
  } catch (error) {
    return malformedSnapshot(record, error, objectIdHint);
  }
}
