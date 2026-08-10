import {
  generateKeyBetween,
  generateNKeysBetween,
} from "fractional-indexing";
import * as Y from "yjs";
import {
  type BoardCommandOrigin,
  executeBoardCommand,
} from "./commands.js";
import {
  type BoardObjectRecord,
  assertStableUuid,
  getPageObjects,
  readBoardObject,
} from "./schema.js";

export type ZOrderDirection = "front" | "forward" | "backward" | "back";

export interface ZOrderedObject {
  readonly id: string;
  readonly zRank: string;
}

interface MutableZOrderedObject extends ZOrderedObject {
  readonly record: BoardObjectRecord;
  readonly validRank: boolean;
}

export const Z_ORDER_NORMALIZATION_ORIGIN = Object.freeze({
  type: "eduri.board.z-order-normalization",
});

export function compareCodeUnitStrings(left: string, right: string): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

export function compareBoardObjectZOrder(
  left: ZOrderedObject,
  right: ZOrderedObject,
): number {
  return compareCodeUnitStrings(left.zRank, right.zRank)
    || compareCodeUnitStrings(left.id, right.id);
}

export function generateZRankBetween(
  lower: string | null,
  upper: string | null,
): string {
  return generateKeyBetween(lower, upper);
}

export function generateZRanksBetween(
  lower: string | null,
  upper: string | null,
  count: number,
): readonly string[] {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("count must be a non-negative safe integer");
  }
  return generateNKeysBetween(lower, upper, count);
}

export function newRankAfter(previous: string | null): string {
  return generateZRankBetween(previous, null);
}

export function isValidZRank(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9A-Za-z]+$/u.test(value)) {
    return false;
  }
  try {
    generateKeyBetween(null, value);
    generateKeyBetween(value, null);
    return true;
  } catch {
    return false;
  }
}

function rankedObject(
  id: string,
  value: unknown,
): MutableZOrderedObject | undefined {
  if (!(value instanceof Y.Map)) return undefined;
  try {
    const object = readBoardObject(value);
    if (object.id !== id) return undefined;
    return {
      id,
      zRank: object.zRank,
      record: value,
      validRank: isValidZRank(object.zRank),
    };
  } catch {
    return undefined;
  }
}

function collectObjects(doc: Y.Doc): MutableZOrderedObject[] {
  return [...getPageObjects(doc).entries()].flatMap(([id, record]) => {
    const object = rankedObject(id, record);
    return object ? [object] : [];
  });
}

function hasDuplicateRanks(objects: readonly MutableZOrderedObject[]): boolean {
  const ranks = new Set<string>();
  for (const object of objects) {
    if (ranks.has(object.zRank)) return true;
    ranks.add(object.zRank);
  }
  return false;
}

export function normalizeObjectZRanks(doc: Y.Doc): boolean {
  const objects = collectObjects(doc);
  if (
    objects.every((object) => object.validRank)
    && !hasDuplicateRanks(objects)
  ) {
    return false;
  }

  objects.sort(compareBoardObjectZOrder);
  const ranks = generateZRanksBetween(null, null, objects.length);
  executeBoardCommand(
    doc,
    Z_ORDER_NORMALIZATION_ORIGIN,
    "objects.z-order.normalize",
    () => {
      for (let index = 0; index < objects.length; index += 1) {
        objects[index].record.set("zRank", ranks[index]);
      }
    },
  );
  return true;
}

function orderedObjects(doc: Y.Doc): MutableZOrderedObject[] {
  return collectObjects(doc).sort(compareBoardObjectZOrder);
}

function reorderedIds(
  objects: readonly MutableZOrderedObject[],
  selected: ReadonlySet<string>,
  direction: ZOrderDirection,
): string[] {
  if (direction === "front") {
    return [
      ...objects.filter((object) => !selected.has(object.id)),
      ...objects.filter((object) => selected.has(object.id)),
    ].map((object) => object.id);
  }
  if (direction === "back") {
    return [
      ...objects.filter((object) => selected.has(object.id)),
      ...objects.filter((object) => !selected.has(object.id)),
    ].map((object) => object.id);
  }

  const result = objects.map((object) => object.id);
  if (direction === "forward") {
    for (let index = result.length - 2; index >= 0; index -= 1) {
      if (
        selected.has(result[index])
        && !selected.has(result[index + 1])
      ) {
        [result[index], result[index + 1]] = [
          result[index + 1],
          result[index],
        ];
      }
    }
    return result;
  }

  for (let index = 1; index < result.length; index += 1) {
    if (
      selected.has(result[index])
      && !selected.has(result[index - 1])
    ) {
      [result[index - 1], result[index]] = [
        result[index],
        result[index - 1],
      ];
    }
  }
  return result;
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function reorderObjects(
  doc: Y.Doc,
  objectIds: readonly string[],
  direction: ZOrderDirection,
  origin: BoardCommandOrigin,
): boolean {
  if (
    direction !== "front"
    && direction !== "forward"
    && direction !== "backward"
    && direction !== "back"
  ) {
    throw new TypeError("Unknown z-order direction");
  }

  const objects = getPageObjects(doc);
  const selected = new Set<string>();
  for (const objectId of objectIds) {
    assertStableUuid(objectId, "objectId");
    const value = objects.get(objectId);
    if (value === undefined) {
      throw new Error(`Board object ${objectId} does not exist`);
    }
    if (!rankedObject(objectId, value)) {
      throw new Error(`Board object ${objectId} is malformed`);
    }
    selected.add(objectId);
  }
  if (selected.size === 0) return false;

  normalizeObjectZRanks(doc);
  const ordered = orderedObjects(doc);
  const currentIds = ordered.map((object) => object.id);
  const targetIds = reorderedIds(ordered, selected, direction);
  if (arraysEqual(currentIds, targetIds)) return false;

  const byId = new Map(ordered.map((object) => [object.id, object] as const));
  const changes: Array<readonly [record: BoardObjectRecord, rank: string]> = [];
  let index = 0;
  while (index < targetIds.length) {
    if (!selected.has(targetIds[index])) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < targetIds.length && selected.has(targetIds[index])) {
      index += 1;
    }
    const lower = start > 0 ? byId.get(targetIds[start - 1])!.zRank : null;
    const upper = index < targetIds.length
      ? byId.get(targetIds[index])!.zRank
      : null;
    const ranks = generateZRanksBetween(lower, upper, index - start);
    for (let offset = 0; offset < ranks.length; offset += 1) {
      changes.push([
        byId.get(targetIds[start + offset])!.record,
        ranks[offset],
      ]);
    }
  }

  executeBoardCommand(
    doc,
    origin,
    `objects.z-order.${direction}`,
    () => {
      for (const [record, rank] of changes) record.set("zRank", rank);
    },
  );
  return true;
}
