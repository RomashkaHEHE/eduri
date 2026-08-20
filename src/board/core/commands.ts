import * as Y from "yjs";
import type { BoardLineObjectGeometry } from "./lineGeometry.js";
import {
  type AtomicTransform,
  type BoardObjectInput,
  type BoardObjectRecord,
  type ManifestPageInput,
  type ManifestPageRecord,
  cloneValueForBoard,
  createBoardObject,
  createManifestPageRecord,
  getCollaborativeText,
  getManifestPages,
  getPageObjects,
  normalizeAtomicTransform,
  readBoardObject,
  assertStableUuid,
} from "./schema.js";

export const COMMAND_NAME_META_KEY = Symbol("eduri.board.command-name");

export interface LocalCommandOrigin {
  readonly type: "eduri.board.local-device";
  readonly deviceId: string;
}

export type BoardCommandOrigin = object;

export interface ObjectStylePatch {
  readonly set?: Readonly<Record<string, unknown>>;
  readonly delete?: readonly string[];
}

export interface ObjectStylePatchTarget {
  readonly objectId: string;
  readonly patch: ObjectStylePatch;
}

export function createLocalCommandOrigin(deviceId: string): LocalCommandOrigin {
  if (!deviceId.trim()) throw new TypeError("deviceId must not be empty");
  return Object.freeze({ type: "eduri.board.local-device", deviceId });
}

function assertCommandOrigin(origin: BoardCommandOrigin): void {
  if ((typeof origin !== "object" && typeof origin !== "function") || origin === null) {
    throw new TypeError("A stable caller-provided command origin is required");
  }
}

export function executeBoardCommand<T>(
  doc: Y.Doc,
  origin: BoardCommandOrigin,
  name: string,
  command: () => T,
): T {
  assertCommandOrigin(origin);
  if (!name) throw new TypeError("Command name must not be empty");
  return doc.transact((transaction) => {
    transaction.meta.set(COMMAND_NAME_META_KEY, name);
    return command();
  }, origin);
}

function requireObject(doc: Y.Doc, objectId: string): BoardObjectRecord {
  assertStableUuid(objectId, "objectId");
  const record = getPageObjects(doc).get(objectId);
  if (!record) throw new Error(`Board object ${objectId} does not exist`);
  return record;
}

export function addManifestPage(
  doc: Y.Doc,
  input: ManifestPageInput,
  origin: BoardCommandOrigin,
): ManifestPageRecord {
  const pages = getManifestPages(doc);
  if (pages.has(input.id)) throw new Error(`Manifest page ${input.id} already exists`);
  const record = createManifestPageRecord(input);
  return executeBoardCommand(doc, origin, "manifest.page.add", () => {
    pages.set(input.id, record);
    return record;
  });
}

export function addBoardObject(
  doc: Y.Doc,
  input: BoardObjectInput,
  origin: BoardCommandOrigin,
): BoardObjectRecord {
  const objects = getPageObjects(doc);
  if (objects.has(input.id)) throw new Error(`Board object ${input.id} already exists`);
  const record = createBoardObject(input);
  return executeBoardCommand(doc, origin, "object.add", () => {
    objects.set(input.id, record);
    return record;
  });
}

export function deleteBoardObject(
  doc: Y.Doc,
  objectId: string,
  origin: BoardCommandOrigin,
): void {
  assertStableUuid(objectId, "objectId");
  return executeBoardCommand(doc, origin, "object.delete", () =>
    getPageObjects(doc).delete(objectId),
  );
}

export function deleteBoardObjects(
  doc: Y.Doc,
  objectIds: readonly string[],
  origin: BoardCommandOrigin,
): boolean {
  const objects = getPageObjects(doc);
  const uniqueObjectIds = [...new Set(objectIds)];
  for (const objectId of uniqueObjectIds) {
    assertStableUuid(objectId, "objectId");
    if (!objects.has(objectId)) {
      throw new Error(`Board object ${objectId} does not exist`);
    }
  }
  if (uniqueObjectIds.length === 0) return false;

  executeBoardCommand(doc, origin, "objects.delete", () => {
    for (const objectId of uniqueObjectIds) objects.delete(objectId);
  });
  return true;
}

export function setObjectTransform(
  doc: Y.Doc,
  objectId: string,
  transform: AtomicTransform,
  origin: BoardCommandOrigin,
): void {
  const record = requireObject(doc, objectId);
  const normalized = normalizeAtomicTransform(transform);
  executeBoardCommand(doc, origin, "object.transform", () => {
    record.set("transform", normalized);
  });
}

export function transformObjects(
  doc: Y.Doc,
  transforms: ReadonlyMap<string, AtomicTransform> | Readonly<Record<string, AtomicTransform>>,
  origin: BoardCommandOrigin,
): void {
  const entries = transforms instanceof Map
    ? [...transforms.entries()]
    : Object.entries(transforms);
  const changes = entries.map(([objectId, transform]) => ({
    record: requireObject(doc, objectId),
    transform: normalizeAtomicTransform(transform),
  }));

  executeBoardCommand(doc, origin, "objects.transform", () => {
    for (const change of changes) change.record.set("transform", change.transform);
  });
}

/** Replaces a line's transform and geometry props as one undoable CRDT command. */
export function setLineObjectGeometry(
  doc: Y.Doc,
  objectId: string,
  geometry: BoardLineObjectGeometry,
  origin: BoardCommandOrigin,
): void {
  const record = requireObject(doc, objectId);
  const { props } = readBoardObject(record);
  const transform = normalizeAtomicTransform(geometry.transform);
  const nextProps = Object.entries(geometry.props).map(([property, value]) => [
    property,
    cloneValueForBoard(value, `props.${property}`),
  ] as const);
  executeBoardCommand(doc, origin, "line.points.set", () => {
    record.set("transform", transform);
    props.delete("start");
    props.delete("end");
    props.delete("control");
    props.delete("points");
    for (const [property, value] of nextProps) props.set(property, value);
  });
}

export function setObjectZRank(
  doc: Y.Doc,
  objectId: string,
  zRank: string,
  origin: BoardCommandOrigin,
): void {
  if (!zRank) throw new TypeError("zRank must not be empty");
  const record = requireObject(doc, objectId);
  executeBoardCommand(doc, origin, "object.z-rank", () => record.set("zRank", zRank));
}

export function setObjectParent(
  doc: Y.Doc,
  objectId: string,
  parentId: string | null,
  origin: BoardCommandOrigin,
): void {
  if (parentId !== null) {
    assertStableUuid(parentId, "parentId");
    if (parentId === objectId) throw new TypeError("An object cannot parent itself");
    requireObject(doc, parentId);
  }
  const record = requireObject(doc, objectId);
  executeBoardCommand(doc, origin, "object.parent", () => record.set("parentId", parentId));
}

export function setObjectStyle(
  doc: Y.Doc,
  objectId: string,
  property: string,
  value: unknown,
  origin: BoardCommandOrigin,
): void {
  assertStyleProperty(property);
  assertStyleValue(value);
  const { style } = readBoardObject(requireObject(doc, objectId));
  const prepared = prepareStyleSetEntry(property, value, "style");
  executeBoardCommand(doc, origin, "object.style.set", () =>
    style.set(prepared[0], prepared[1]));
}

export function deleteObjectStyle(
  doc: Y.Doc,
  objectId: string,
  property: string,
  origin: BoardCommandOrigin,
): void {
  if (!property) throw new TypeError("Style property must not be empty");
  const { style } = readBoardObject(requireObject(doc, objectId));
  return executeBoardCommand(doc, origin, "object.style.delete", () => style.delete(property));
}

interface ValidatedStylePatch {
  readonly set: readonly (readonly [property: string, value: unknown])[];
  readonly delete: readonly string[];
}

interface PreparedStylePatch extends ValidatedStylePatch {
  readonly set: readonly (readonly [property: string, value: unknown])[];
}

function assertStyleProperty(property: string): void {
  if (!property) throw new TypeError("Style property must not be empty");
}

function assertStyleValue(value: unknown): void {
  const pending = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current instanceof Y.AbstractType) {
      throw new TypeError("Style values must not contain collaborative types");
    }
    if (
      current instanceof Uint8Array
      || current === null
      || typeof current !== "object"
      || seen.has(current)
    ) {
      continue;
    }
    seen.add(current);
    pending.push(...Object.values(current));
  }
}

function validateStylePatch(patch: ObjectStylePatch): ValidatedStylePatch {
  const set = Object.entries(patch.set ?? {});
  const deletedProperties = [...new Set(patch.delete ?? [])];
  for (const [property, value] of set) {
    assertStyleProperty(property);
    assertStyleValue(value);
  }
  for (const property of deletedProperties) {
    assertStyleProperty(property);
    if (Object.prototype.hasOwnProperty.call(patch.set ?? {}, property)) {
      throw new TypeError(`Style property ${property} cannot be set and deleted`);
    }
  }
  return { set, delete: deletedProperties };
}

function prepareStylePatch(
  patch: ValidatedStylePatch,
  path = "style",
): PreparedStylePatch {
  return {
    set: patch.set.map(([property, value]) =>
      prepareStyleSetEntry(property, value, path)),
    delete: patch.delete,
  };
}

function prepareStyleSetEntry(
  property: string,
  value: unknown,
  path: string,
): readonly [property: string, value: unknown] {
  return [
    property,
    cloneValueForBoard(value, `${path}.${property}`),
  ];
}

function applyPreparedStylePatch(
  style: Y.Map<unknown>,
  patch: PreparedStylePatch,
): void {
  for (const [property, value] of patch.set) style.set(property, value);
  for (const property of patch.delete) style.delete(property);
}

export function patchObjectStyles(
  doc: Y.Doc,
  objectIds: readonly string[],
  patch: ObjectStylePatch,
  origin: BoardCommandOrigin,
): boolean {
  const validatedPatch = validateStylePatch(patch);

  const uniqueObjectIds = [...new Set(objectIds)];
  const changes = uniqueObjectIds.map((objectId) => {
    const { style } = readBoardObject(requireObject(doc, objectId));
    return {
      style,
      patch: prepareStylePatch(validatedPatch),
    };
  });
  if (
    changes.length === 0
    || (
      validatedPatch.set.length === 0
      && validatedPatch.delete.length === 0
    )
  ) {
    return false;
  }

  executeBoardCommand(doc, origin, "objects.style.patch", () => {
    for (const change of changes) {
      applyPreparedStylePatch(change.style, change.patch);
    }
  });
  return true;
}

export function patchObjectStylesByTarget(
  doc: Y.Doc,
  targets: readonly ObjectStylePatchTarget[],
  origin: BoardCommandOrigin,
): boolean {
  const seenObjectIds = new Set<string>();
  const validatedTargets = targets.map((target) => {
    assertStableUuid(target.objectId, "objectId");
    if (seenObjectIds.has(target.objectId)) {
      throw new TypeError(`Duplicate style patch target ${target.objectId}`);
    }
    seenObjectIds.add(target.objectId);
    return {
      objectId: target.objectId,
      patch: validateStylePatch(target.patch),
    };
  });

  const changes = validatedTargets.map((target) => ({
    style: readBoardObject(requireObject(doc, target.objectId)).style,
    patch: prepareStylePatch(target.patch, `objects.${target.objectId}.style`),
  }));
  if (
    changes.length === 0
    || changes.every((change) =>
      change.patch.set.length === 0 && change.patch.delete.length === 0)
  ) {
    return false;
  }

  executeBoardCommand(doc, origin, "objects.style.patch-by-target", () => {
    for (const change of changes) {
      applyPreparedStylePatch(change.style, change.patch);
    }
  });
  return true;
}

export function setObjectProperty(
  doc: Y.Doc,
  objectId: string,
  property: string,
  value: unknown,
  origin: BoardCommandOrigin,
): void {
  if (!property) throw new TypeError("Object property must not be empty");
  const { props } = readBoardObject(requireObject(doc, objectId));
  const cloned = cloneValueForBoard(value, `props.${property}`);
  executeBoardCommand(doc, origin, "object.property.set", () => props.set(property, cloned));
}

export function deleteObjectProperty(
  doc: Y.Doc,
  objectId: string,
  property: string,
  origin: BoardCommandOrigin,
): void {
  if (!property) throw new TypeError("Object property must not be empty");
  const { props } = readBoardObject(requireObject(doc, objectId));
  return executeBoardCommand(doc, origin, "object.property.delete", () => props.delete(property));
}

export function setStrokePoints(
  doc: Y.Doc,
  objectId: string,
  points: Uint8Array,
  origin: BoardCommandOrigin,
): void {
  const { props } = readBoardObject(requireObject(doc, objectId));
  const immutableCopy = points.slice();
  executeBoardCommand(doc, origin, "stroke.points.complete", () => {
    props.set("points", immutableCopy);
  });
}

function requireCollaborativeText(
  doc: Y.Doc,
  objectId: string,
  property: string,
): Y.Text {
  const record = requireObject(doc, objectId);
  const text = getCollaborativeText(record, property);
  if (!text) {
    throw new Error(`Object ${objectId} property ${property} is not collaborative text`);
  }
  return text;
}

export function insertCollaborativeText(
  doc: Y.Doc,
  objectId: string,
  property: string,
  index: number,
  value: string,
  origin: BoardCommandOrigin,
): void {
  const text = requireCollaborativeText(doc, objectId, property);
  if (!Number.isSafeInteger(index) || index < 0 || index > text.length) {
    throw new RangeError("Text insertion index is out of range");
  }
  if (!value) return;
  executeBoardCommand(doc, origin, "text.insert", () => text.insert(index, value));
}

export function deleteCollaborativeText(
  doc: Y.Doc,
  objectId: string,
  property: string,
  index: number,
  length: number,
  origin: BoardCommandOrigin,
): void {
  const text = requireCollaborativeText(doc, objectId, property);
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(length) ||
    index < 0 ||
    length < 0 ||
    index + length > text.length
  ) {
    throw new RangeError("Text deletion range is out of bounds");
  }
  if (length === 0) return;
  executeBoardCommand(doc, origin, "text.delete", () => text.delete(index, length));
}

export function replaceCollaborativeText(
  doc: Y.Doc,
  objectId: string,
  property: string,
  value: string,
  origin: BoardCommandOrigin,
): void {
  const text = requireCollaborativeText(doc, objectId, property);
  executeBoardCommand(doc, origin, "text.replace", () => {
    if (text.length > 0) text.delete(0, text.length);
    if (value) text.insert(0, value);
  });
}

export function replaceCollaborativeTextRange(
  doc: Y.Doc,
  objectId: string,
  property: string,
  index: number,
  deleteLength: number,
  value: string,
  origin: BoardCommandOrigin,
): void {
  const text = requireCollaborativeText(doc, objectId, property);
  if (
    !Number.isSafeInteger(index)
    || !Number.isSafeInteger(deleteLength)
    || index < 0
    || deleteLength < 0
    || index + deleteLength > text.length
  ) {
    throw new RangeError("Text replacement range is out of bounds");
  }
  if (deleteLength === 0 && value.length === 0) return;
  executeBoardCommand(doc, origin, "text.replace-range", () => {
    if (deleteLength > 0) text.delete(index, deleteLength);
    if (value) text.insert(index, value);
  });
}
