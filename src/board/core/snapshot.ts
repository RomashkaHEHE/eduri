import * as Y from "yjs";
import { PAGE_OBJECTS_ROOT, resolveKnownBoardRootTypes } from "./schema.js";
import { compareCodeUnitStrings } from "./zOrder.js";

export interface SemanticDocumentSnapshot {
  roots: ReadonlyArray<readonly [name: string, value: unknown]>;
}

export interface BoardDocumentMetrics {
  objectCount: number;
  collaborativeTextCharacters: number;
  embeddedBinaryBytes: number;
  compactSnapshotBytes: number;
  stateVectorBytes: number;
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function numberSnapshot(value: number): unknown {
  if (Number.isNaN(value)) return { $number: "NaN" };
  if (value === Number.POSITIVE_INFINITY) return { $number: "Infinity" };
  if (value === Number.NEGATIVE_INFINITY) return { $number: "-Infinity" };
  if (Object.is(value, -0)) return { $number: "-0" };
  return value;
}

function semanticValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") return numberSnapshot(value);
  if (typeof value === "undefined") return { $undefined: true };
  if (value instanceof Uint8Array) return { $binary: bytesToHex(value) };
  if (value instanceof Y.Text) {
    return { $type: "text", delta: semanticValue(value.toDelta()) };
  }
  if (value instanceof Y.Map) {
    return {
      $type: "map",
      entries: [...value.entries()]
        .sort(([left], [right]) => compareCodeUnitStrings(left, right))
        .map(([key, entry]) => [key, semanticValue(entry)]),
    };
  }
  if (value instanceof Y.Array) {
    return { $type: "array", values: value.toArray().map(semanticValue) };
  }
  if (value instanceof Y.XmlFragment) {
    return { $type: "xml", value: value.toString() };
  }
  if (Array.isArray(value)) return value.map(semanticValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCodeUnitStrings(left, right))
        .map(([key, entry]) => [key, semanticValue(entry)]),
    );
  }
  return { $unsupported: String(value) };
}

export function semanticSnapshot(doc: Y.Doc): SemanticDocumentSnapshot {
  resolveKnownBoardRootTypes(doc);
  return {
    roots: [...doc.share.entries()]
      .sort(([left], [right]) => compareCodeUnitStrings(left, right))
      .map(([name, value]) => [name, semanticValue(value)] as const),
  };
}

export function semanticSnapshotJson(doc: Y.Doc): string {
  return JSON.stringify(semanticSnapshot(doc));
}

export function semanticHash(doc: Y.Doc): string {
  const bytes = new TextEncoder().encode(semanticSnapshotJson(doc));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function measureValue(
  value: unknown,
  seen: Set<Y.AbstractType<unknown>>,
): Pick<BoardDocumentMetrics, "collaborativeTextCharacters" | "embeddedBinaryBytes"> {
  if (value instanceof Uint8Array) {
    return { collaborativeTextCharacters: 0, embeddedBinaryBytes: value.byteLength };
  }
  if (value instanceof Y.AbstractType) {
    if (seen.has(value)) {
      return { collaborativeTextCharacters: 0, embeddedBinaryBytes: 0 };
    }
    seen.add(value);
  }
  if (value instanceof Y.Text) {
    return { collaborativeTextCharacters: value.length, embeddedBinaryBytes: 0 };
  }

  const children: unknown[] = value instanceof Y.Map
    ? [...value.values()]
    : value instanceof Y.Array
      ? value.toArray()
      : Array.isArray(value)
        ? value
        : value !== null && typeof value === "object"
          ? Object.values(value as Record<string, unknown>)
          : [];

  return children.reduce<Pick<
    BoardDocumentMetrics,
    "collaborativeTextCharacters" | "embeddedBinaryBytes"
  >>(
    (total, child) => {
      const measured = measureValue(child, seen);
      total.collaborativeTextCharacters += measured.collaborativeTextCharacters;
      total.embeddedBinaryBytes += measured.embeddedBinaryBytes;
      return total;
    },
    { collaborativeTextCharacters: 0, embeddedBinaryBytes: 0 },
  );
}

export function measureBoardDocument(doc: Y.Doc): BoardDocumentMetrics {
  const measured = measureValue([...doc.share.values()], new Set());
  const objects = doc.share.get(PAGE_OBJECTS_ROOT);
  return {
    objectCount: objects instanceof Y.Map ? objects.size : 0,
    collaborativeTextCharacters: measured.collaborativeTextCharacters,
    embeddedBinaryBytes: measured.embeddedBinaryBytes,
    compactSnapshotBytes: Y.encodeStateAsUpdate(doc).byteLength,
    stateVectorBytes: Y.encodeStateVector(doc).byteLength,
  };
}
