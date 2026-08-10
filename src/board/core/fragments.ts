import * as Y from "yjs";
import { BOARD_PROTOCOL_LIMITS } from "../protocol/constants.js";
import {
  type BoardCommandOrigin,
  executeBoardCommand,
} from "./commands.js";
import {
  BOARD_CORE_SCHEMA_VERSION,
  BUILTIN_OBJECT_KINDS,
  type AtomicTransform,
  type BoardObjectRecord,
  assertStableUuid,
  getPageObjects,
  readBoardObject,
} from "./schema.js";
import {
  compareBoardObjectZOrder,
  generateZRanksBetween,
  isValidZRank,
  normalizeObjectZRanks,
} from "./zOrder.js";

export const BOARD_FRAGMENT_FORMAT = "eduri.board.fragment";
export const BOARD_FRAGMENT_VERSION = 1;
export const BOARD_FRAGMENT_MIME_TYPE =
  "application/vnd.eduri.board-fragment";

const FRAGMENT_OBJECTS_ROOT = "eduri.board.fragment.objects";
const FRAGMENT_MAGIC = new TextEncoder().encode(
  "EDURI_BOARD_FRAGMENT_V1\n",
);
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_UINT32 = 0xffff_ffff;

export const BOARD_FRAGMENT_LIMITS = Object.freeze({
  maxHeaderBytes: 4 * 1024 * 1024,
  maxDocumentUpdateBytes:
    BOARD_PROTOCOL_LIMITS.maxUpdateBytes - 4 * 1024 * 1024,
  maxObjectCount: 50_000,
  maxEncodedBytes:
    BOARD_PROTOCOL_LIMITS.maxUpdateBytes + 4 * 1024,
});

export interface BoardFragmentScope {
  readonly boardId: string;
  readonly generation: number;
  readonly pageId: string;
}

export interface BoardFragment {
  readonly format: typeof BOARD_FRAGMENT_FORMAT;
  readonly version: typeof BOARD_FRAGMENT_VERSION;
  readonly schemaVersion: number;
  readonly scope: BoardFragmentScope;
  /** Source object IDs in canonical source z-order. */
  readonly objectIds: readonly string[];
  /** Standard Yjs update-v1 for an isolated fragment object map. */
  readonly documentUpdate: Uint8Array;
}

export interface BoardFragmentPoint {
  readonly x: number;
  readonly y: number;
}

export interface BoardFragmentBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
  readonly centerX: number;
  readonly centerY: number;
}

export type BoardFragmentIdFactory = (
  sourceObjectId: string,
  index: number,
) => string;

export interface BoardFragmentInsertOptions {
  readonly idFactory: BoardFragmentIdFactory;
  /** Adds this logical offset to every pasted transform. */
  readonly translation?: BoardFragmentPoint;
  /** Moves the axis-aligned fragment-bounds center to this logical point. */
  readonly anchor?: BoardFragmentPoint;
}

export interface BoardFragmentImageAssetIdentity {
  readonly objectId: string;
  readonly assetId: string;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly originalBytes: number;
}

export interface BoardFragmentUnresolvedImageAsset {
  readonly objectId: string;
  readonly version: number;
  readonly reason: "unsupported-version" | "invalid-identity";
}

export interface BoardFragmentImageAssets {
  readonly identities: readonly BoardFragmentImageAssetIdentity[];
  readonly unresolved: readonly BoardFragmentUnresolvedImageAsset[];
}

export interface CreateBoardFragmentOptions {
  readonly scope: BoardFragmentScope;
}

interface BoardFragmentHeader {
  readonly format: typeof BOARD_FRAGMENT_FORMAT;
  readonly version: typeof BOARD_FRAGMENT_VERSION;
  readonly schemaVersion: number;
  readonly scope: BoardFragmentScope;
  readonly objectIds: readonly string[];
  readonly updateBytes: number;
}

interface MaterializedFragmentObject {
  readonly id: string;
  readonly record: BoardObjectRecord;
  readonly transform: AtomicTransform;
  readonly zRank: string;
  readonly parentId: string | null;
}

interface MaterializedFragment {
  readonly document: Y.Doc;
  readonly scope: BoardFragmentScope;
  readonly objects: readonly MaterializedFragmentObject[];
}

interface TargetRankPlan {
  readonly normalize: boolean;
  readonly lower: string | null;
}

interface PreparedInsertionRecord {
  readonly id: string;
  readonly record: BoardObjectRecord;
}

function fragmentError(message: string, cause?: unknown): never {
  throw new Error(
    `Board fragment ${message}`,
    cause === undefined ? undefined : { cause },
  );
}

function assertOpaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    fragmentError(`${label} must be a 1-128 character opaque ID`);
  }
  return value;
}

function assertPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fragmentError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function assertNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fragmentError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function validateScope(value: unknown): BoardFragmentScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fragmentError("scope is invalid");
  }
  const scope = value as Partial<BoardFragmentScope>;
  const boardId = assertOpaqueId(scope.boardId, "scope.boardId");
  const generation = assertPositiveInteger(
    scope.generation,
    "scope.generation",
  );
  if (typeof scope.pageId !== "string") {
    fragmentError("scope.pageId is invalid");
  }
  try {
    assertStableUuid(scope.pageId, "scope.pageId");
  } catch (error) {
    fragmentError("scope.pageId is invalid", error);
  }
  return Object.freeze({
    boardId,
    generation,
    pageId: scope.pageId,
  });
}

function validateObjectIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) fragmentError("objectIds must be an array");
  if (value.length > BOARD_FRAGMENT_LIMITS.maxObjectCount) {
    fragmentError(
      `object count exceeds the per-operation limit of ${BOARD_FRAGMENT_LIMITS.maxObjectCount}`,
    );
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") {
      fragmentError("objectIds contains a non-string value");
    }
    try {
      assertStableUuid(candidate, "fragment objectId");
    } catch (error) {
      fragmentError("objectIds contains an invalid UUID", error);
    }
    if (seen.has(candidate)) {
      fragmentError(`contains duplicate object ID ${candidate}`);
    }
    seen.add(candidate);
    result.push(candidate);
  }
  return Object.freeze(result);
}

function assertCommandOrigin(origin: BoardCommandOrigin): void {
  if (
    (typeof origin !== "object" && typeof origin !== "function")
    || origin === null
  ) {
    throw new TypeError("A stable caller-provided command origin is required");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

interface TextDeltaOperation {
  readonly insert?: unknown;
  readonly retain?: number;
  readonly delete?: number;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

function cloneTextDelta(text: Y.Text): Array<unknown> {
  return (text.toDelta() as TextDeltaOperation[]).map((operation) => {
    const cloned: Record<string, unknown> = {};
    if ("insert" in operation) {
      cloned.insert = cloneFragmentValue(operation.insert);
    }
    if ("retain" in operation) cloned.retain = operation.retain;
    if ("delete" in operation) cloned.delete = operation.delete;
    if (operation.attributes) {
      cloned.attributes = Object.fromEntries(
        Object.entries(operation.attributes).map(([key, value]) => [
          key,
          cloneFragmentValue(value),
        ]),
      );
    }
    return cloned;
  });
}

function cloneSharedType(value: Y.AbstractType<any>): Y.AbstractType<any> {
  if (value instanceof Y.XmlText) {
    const clone = new Y.XmlText();
    clone.applyDelta(cloneTextDelta(value));
    return clone;
  }
  if (value instanceof Y.Text) {
    const clone = new Y.Text();
    clone.applyDelta(cloneTextDelta(value));
    return clone;
  }
  if (value instanceof Y.XmlHook) {
    const clone = new Y.XmlHook(value.hookName);
    for (const [key, entry] of value.entries()) {
      clone.set(key, cloneFragmentValue(entry));
    }
    return clone;
  }
  if (value instanceof Y.XmlElement) {
    const clone = new Y.XmlElement(value.nodeName);
    for (const [key, entry] of Object.entries(value.getAttributes())) {
      clone.setAttribute(key, cloneFragmentValue(entry) as string);
    }
    clone.insert(
      0,
      value.toArray().map((entry) =>
        cloneFragmentValue(entry) as Y.XmlElement | Y.XmlText),
    );
    return clone;
  }
  if (value instanceof Y.XmlFragment) {
    const clone = new Y.XmlFragment();
    clone.insert(
      0,
      value.toArray().map((entry) =>
        cloneFragmentValue(entry) as Y.XmlElement | Y.XmlText),
    );
    return clone;
  }
  if (value instanceof Y.Array) {
    const clone = new Y.Array<unknown>();
    clone.insert(
      0,
      value.toArray().map((entry) => cloneFragmentValue(entry)),
    );
    return clone;
  }
  if (value instanceof Y.Map) {
    const clone = new Y.Map<unknown>();
    for (const [key, entry] of value.entries()) {
      clone.set(key, cloneFragmentValue(entry));
    }
    return clone;
  }
  return value.clone();
}

function cloneFragmentValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof Y.AbstractType) return cloneSharedType(value);
  if (Array.isArray(value)) {
    return value.map((entry) => cloneFragmentValue(entry));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        cloneFragmentValue(entry),
      ]),
    );
  }
  return value;
}

function cloneFragmentRecord(record: BoardObjectRecord): BoardObjectRecord {
  return cloneSharedType(record) as BoardObjectRecord;
}

function freezeFragment(input: {
  readonly scope: BoardFragmentScope;
  readonly objectIds: readonly string[];
  readonly documentUpdate: Uint8Array;
}): BoardFragment {
  return Object.freeze({
    format: BOARD_FRAGMENT_FORMAT,
    version: BOARD_FRAGMENT_VERSION,
    schemaVersion: BOARD_CORE_SCHEMA_VERSION,
    scope: validateScope(input.scope),
    objectIds: validateObjectIds(input.objectIds),
    documentUpdate: input.documentUpdate.slice(),
  });
}

function compareMaterializedObjects(
  left: MaterializedFragmentObject,
  right: MaterializedFragmentObject,
): number {
  return compareBoardObjectZOrder(left, right);
}

function materializeBoardFragment(fragment: BoardFragment): MaterializedFragment {
  if (!fragment || typeof fragment !== "object") {
    fragmentError("value is invalid");
  }
  if (
    fragment.format !== BOARD_FRAGMENT_FORMAT
    || fragment.version !== BOARD_FRAGMENT_VERSION
  ) {
    fragmentError("format version is unsupported");
  }
  if (fragment.schemaVersion !== BOARD_CORE_SCHEMA_VERSION) {
    fragmentError("schema version is unsupported");
  }
  const scope = validateScope(fragment.scope);
  const objectIds = validateObjectIds(fragment.objectIds);
  if (!(fragment.documentUpdate instanceof Uint8Array)) {
    fragmentError("document update must be a Uint8Array");
  }
  if (fragment.documentUpdate.byteLength === 0) {
    fragmentError("document update must not be empty");
  }
  if (
    fragment.documentUpdate.byteLength
    > BOARD_FRAGMENT_LIMITS.maxDocumentUpdateBytes
  ) {
    fragmentError("document update exceeds the per-operation limit");
  }

  const document = new Y.Doc();
  const fragmentObjects =
    document.getMap<BoardObjectRecord>(FRAGMENT_OBJECTS_ROOT);
  try {
    Y.applyUpdate(document, fragment.documentUpdate);
    if (document.store.pendingStructs || document.store.pendingDs) {
      fragmentError("document update has unresolved CRDT dependencies");
    }
    if (
      document.share.size !== 1
      || !document.share.has(FRAGMENT_OBJECTS_ROOT)
    ) {
      fragmentError("document update contains unsupported root types");
    }
    if (fragmentObjects.size !== objectIds.length) {
      fragmentError("object count does not match the header");
    }

    const objects = objectIds.map((id) => {
      const value = fragmentObjects.get(id);
      if (!(value instanceof Y.Map)) {
        fragmentError(`object ${id} is missing or is not a Y.Map`);
      }
      let object: ReturnType<typeof readBoardObject>;
      try {
        object = readBoardObject(value);
      } catch (error) {
        fragmentError(`object ${id} is malformed`, error);
      }
      if (object.id !== id) {
        fragmentError(`object ${id} has a mismatched internal ID`);
      }
      return {
        id,
        record: value,
        transform: object.transform,
        zRank: object.zRank,
        parentId: object.parentId,
      };
    });
    const canonicalIds = [...objects]
      .sort(compareMaterializedObjects)
      .map((object) => object.id);
    if (
      canonicalIds.some((id, index) => id !== objectIds[index])
    ) {
      fragmentError("objectIds are not in canonical source z-order");
    }
    return {
      document,
      scope,
      objects: Object.freeze(objects),
    };
  } catch (error) {
    document.destroy();
    if (error instanceof Error && error.message.startsWith("Board fragment ")) {
      throw error;
    }
    fragmentError("document update is invalid", error);
  }
}

function withMaterializedFragment<T>(
  fragment: BoardFragment,
  operation: (materialized: MaterializedFragment) => T,
): T {
  const materialized = materializeBoardFragment(fragment);
  try {
    return operation(materialized);
  } finally {
    materialized.document.destroy();
  }
}

function calculateBounds(
  objects: readonly MaterializedFragmentObject[],
): BoardFragmentBounds | null {
  if (objects.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const { transform } of objects) {
    const left = Math.min(transform[0], transform[0] + transform[2]);
    const right = Math.max(transform[0], transform[0] + transform[2]);
    const top = Math.min(transform[1], transform[1] + transform[3]);
    const bottom = Math.max(transform[1], transform[1] + transform[3]);
    minX = Math.min(minX, left);
    minY = Math.min(minY, top);
    maxX = Math.max(maxX, right);
    maxY = Math.max(maxY, bottom);
  }
  return Object.freeze({
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: minX + (maxX - minX) / 2,
    centerY: minY + (maxY - minY) / 2,
  });
}

function validatePoint(
  value: BoardFragmentPoint | undefined,
  label: string,
): BoardFragmentPoint | undefined {
  if (value === undefined) return undefined;
  if (
    !value
    || typeof value !== "object"
    || typeof value.x !== "number"
    || typeof value.y !== "number"
    || !Number.isFinite(value.x)
    || !Number.isFinite(value.y)
  ) {
    throw new TypeError(`${label} must contain finite x and y values`);
  }
  return { x: value.x, y: value.y };
}

function translatedTransform(
  transform: AtomicTransform,
  translation: BoardFragmentPoint,
): AtomicTransform {
  const x = transform[0] + translation.x;
  const y = transform[1] + translation.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new RangeError("Pasted object transform exceeds finite coordinates");
  }
  return Object.freeze([
    x,
    y,
    transform[2],
    transform[3],
    transform[4],
  ]) as AtomicTransform;
}

function targetRankPlan(doc: Y.Doc): TargetRankPlan {
  const readable = [...getPageObjects(doc).entries()].flatMap(
    ([id, value]) => {
      if (!(value instanceof Y.Map)) return [];
      try {
        const object = readBoardObject(value);
        return object.id === id
          ? [{
              id,
              zRank: object.zRank,
            }]
          : [];
      } catch {
        return [];
      }
    },
  );
  const ranks = new Set<string>();
  const normalize = readable.some(({ zRank }) => {
    const invalid = !isValidZRank(zRank) || ranks.has(zRank);
    ranks.add(zRank);
    return invalid;
  });
  if (normalize) {
    const normalized = generateZRanksBetween(null, null, readable.length);
    return {
      normalize: true,
      lower: normalized.at(-1) ?? null,
    };
  }
  readable.sort(compareBoardObjectZOrder);
  return {
    normalize: false,
    lower: readable.at(-1)?.zRank ?? null,
  };
}

function stageInsertionRecords(
  records: readonly PreparedInsertionRecord[],
): readonly PreparedInsertionRecord[] {
  if (records.length === 0) return [];
  const stagingDocument = new Y.Doc();
  const stagingObjects =
    stagingDocument.getMap<BoardObjectRecord>(FRAGMENT_OBJECTS_ROOT);
  let stagedUpdate: Uint8Array | null = null;
  const capture = (update: Uint8Array) => {
    stagedUpdate = update;
  };
  stagingDocument.on("update", capture);
  try {
    stagingDocument.transact(() => {
      for (const { id, record } of records) stagingObjects.set(id, record);
    });
    if (
      stagedUpdate === null
      || (stagedUpdate as Uint8Array).byteLength
        > BOARD_FRAGMENT_LIMITS.maxDocumentUpdateBytes
    ) {
      fragmentError("pasted update exceeds the per-operation limit");
    }
    return records.map(({ id }) => {
      const record = stagingObjects.get(id);
      if (!(record instanceof Y.Map)) {
        fragmentError(`staging lost object ${id}`);
      }
      return {
        id,
        record: cloneFragmentRecord(record),
      };
    });
  } finally {
    stagingDocument.off("update", capture);
    stagingDocument.destroy();
  }
}

export function createBoardFragment(
  doc: Y.Doc,
  objectIds: readonly string[],
  options: CreateBoardFragmentOptions,
): BoardFragment {
  const scope = validateScope(options?.scope);
  const selectedIds = validateObjectIds([...new Set(objectIds)]);
  const objects = getPageObjects(doc);
  const selected = selectedIds.map((id) => {
    const value = objects.get(id);
    if (!(value instanceof Y.Map)) {
      throw new Error(`Board object ${id} does not exist or is malformed`);
    }
    const object = readBoardObject(value);
    if (object.id !== id) {
      throw new Error(`Board object ${id} has a mismatched internal ID`);
    }
    return {
      id,
      zRank: object.zRank,
      record: value,
    };
  }).sort(compareBoardObjectZOrder);

  const fragmentDocument = new Y.Doc();
  try {
    const fragmentObjects =
      fragmentDocument.getMap<BoardObjectRecord>(FRAGMENT_OBJECTS_ROOT);
    fragmentDocument.transact(() => {
      for (const object of selected) {
        fragmentObjects.set(
          object.id,
          cloneFragmentRecord(object.record),
        );
      }
    });
    const documentUpdate = Y.encodeStateAsUpdate(fragmentDocument);
    if (
      documentUpdate.byteLength
      > BOARD_FRAGMENT_LIMITS.maxDocumentUpdateBytes
    ) {
      fragmentError("document update exceeds the per-operation limit");
    }
    return freezeFragment({
      scope,
      objectIds: selected.map((object) => object.id),
      documentUpdate,
    });
  } finally {
    fragmentDocument.destroy();
  }
}

export function encodeBoardFragment(fragment: BoardFragment): Uint8Array {
  withMaterializedFragment(fragment, () => undefined);
  const header: BoardFragmentHeader = {
    format: BOARD_FRAGMENT_FORMAT,
    version: BOARD_FRAGMENT_VERSION,
    schemaVersion: BOARD_CORE_SCHEMA_VERSION,
    scope: validateScope(fragment.scope),
    objectIds: validateObjectIds(fragment.objectIds),
    updateBytes: fragment.documentUpdate.byteLength,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (
    headerBytes.byteLength > MAX_UINT32
    || headerBytes.byteLength > BOARD_FRAGMENT_LIMITS.maxHeaderBytes
  ) {
    fragmentError("header is too large");
  }
  const totalLength =
    FRAGMENT_MAGIC.byteLength
    + 4
    + headerBytes.byteLength
    + fragment.documentUpdate.byteLength;
  if (
    !Number.isSafeInteger(totalLength)
    || totalLength > BOARD_FRAGMENT_LIMITS.maxEncodedBytes
  ) {
    fragmentError("is too large");
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  result.set(FRAGMENT_MAGIC, offset);
  offset += FRAGMENT_MAGIC.byteLength;
  new DataView(result.buffer).setUint32(
    offset,
    headerBytes.byteLength,
    true,
  );
  offset += 4;
  result.set(headerBytes, offset);
  offset += headerBytes.byteLength;
  result.set(fragment.documentUpdate, offset);
  return result;
}

export function decodeBoardFragment(bytes: Uint8Array): BoardFragment {
  if (!(bytes instanceof Uint8Array)) {
    fragmentError("bytes must be a Uint8Array");
  }
  if (bytes.byteLength > BOARD_FRAGMENT_LIMITS.maxEncodedBytes) {
    fragmentError("exceeds the per-operation encoded-size limit");
  }
  const prefixLength = FRAGMENT_MAGIC.byteLength + 4;
  if (bytes.byteLength < prefixLength) fragmentError("is truncated");
  for (let index = 0; index < FRAGMENT_MAGIC.byteLength; index += 1) {
    if (bytes[index] !== FRAGMENT_MAGIC[index]) {
      fragmentError("magic is invalid");
    }
  }
  const headerLength = new DataView(
    bytes.buffer,
    bytes.byteOffset + FRAGMENT_MAGIC.byteLength,
    4,
  ).getUint32(0, true);
  const headerStart = prefixLength;
  const payloadStart = headerStart + headerLength;
  if (
    headerLength < 2
    || headerLength > BOARD_FRAGMENT_LIMITS.maxHeaderBytes
    || payloadStart > bytes.byteLength
  ) {
    fragmentError("header is truncated");
  }

  let rawHeader: unknown;
  try {
    rawHeader = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(headerStart, payloadStart),
    ));
  } catch (error) {
    fragmentError("header JSON is invalid", error);
  }
  if (!rawHeader || typeof rawHeader !== "object" || Array.isArray(rawHeader)) {
    fragmentError("header is invalid");
  }
  const header = rawHeader as Partial<BoardFragmentHeader>;
  if (
    header.format !== BOARD_FRAGMENT_FORMAT
    || header.version !== BOARD_FRAGMENT_VERSION
  ) {
    fragmentError("format version is unsupported");
  }
  if (header.schemaVersion !== BOARD_CORE_SCHEMA_VERSION) {
    fragmentError("schema version is unsupported");
  }
  const updateBytes = assertNonNegativeInteger(
    header.updateBytes,
    "updateBytes",
  );
  if (updateBytes === 0) fragmentError("document update must not be empty");
  if (updateBytes > BOARD_FRAGMENT_LIMITS.maxDocumentUpdateBytes) {
    fragmentError("document update exceeds the per-operation limit");
  }
  const payloadEnd = payloadStart + updateBytes;
  if (
    !Number.isSafeInteger(payloadEnd)
    || payloadEnd > bytes.byteLength
  ) {
    fragmentError("document update is truncated");
  }
  if (payloadEnd !== bytes.byteLength) {
    fragmentError("contains trailing data");
  }

  const fragment = freezeFragment({
    scope: validateScope(header.scope),
    objectIds: validateObjectIds(header.objectIds),
    documentUpdate: bytes.slice(payloadStart, payloadEnd),
  });
  withMaterializedFragment(fragment, () => undefined);
  return fragment;
}

export function boardFragmentBounds(
  fragment: BoardFragment,
): BoardFragmentBounds | null {
  return withMaterializedFragment(fragment, ({ objects }) =>
    calculateBounds(objects));
}

export function boardFragmentImageAssets(
  fragment: BoardFragment,
): BoardFragmentImageAssets {
  return withMaterializedFragment(fragment, ({ objects }) => {
    const identities: BoardFragmentImageAssetIdentity[] = [];
    const unresolved: BoardFragmentUnresolvedImageAsset[] = [];
    for (const object of objects) {
      const view = readBoardObject(object.record);
      if (view.kind !== BUILTIN_OBJECT_KINDS.image) continue;
      if (view.version !== 1) {
        unresolved.push({
          objectId: object.id,
          version: view.version,
          reason: "unsupported-version",
        });
        continue;
      }
      const assetId = view.props.get("assetId");
      const contentHash = view.props.get("contentHash");
      const mimeType = view.props.get("mimeType");
      const originalBytes = view.props.get("originalBytes");
      if (
        typeof assetId !== "string"
        || !ASSET_ID_PATTERN.test(assetId)
        || typeof contentHash !== "string"
        || !SHA256_PATTERN.test(contentHash)
        || typeof mimeType !== "string"
        || mimeType.length < 1
        || mimeType.length > 256
        || !Number.isSafeInteger(originalBytes)
        || (originalBytes as number) < 1
      ) {
        unresolved.push({
          objectId: object.id,
          version: view.version,
          reason: "invalid-identity",
        });
        continue;
      }
      identities.push({
        objectId: object.id,
        assetId,
        contentHash,
        mimeType,
        originalBytes: originalBytes as number,
      });
    }
    return Object.freeze({
      identities: Object.freeze(identities),
      unresolved: Object.freeze(unresolved),
    });
  });
}

export function insertBoardFragment(
  doc: Y.Doc,
  fragment: BoardFragment,
  origin: BoardCommandOrigin,
  options: BoardFragmentInsertOptions,
): readonly string[] {
  assertCommandOrigin(origin);
  if (!options || typeof options.idFactory !== "function") {
    throw new TypeError("Board fragment insertion requires an idFactory");
  }
  const requestedTranslation = validatePoint(
    options.translation,
    "translation",
  );
  const anchor = validatePoint(options.anchor, "anchor");
  if (requestedTranslation && anchor) {
    throw new TypeError("translation and anchor are mutually exclusive");
  }

  const targetObjects = getPageObjects(doc);
  const rankPlan = targetRankPlan(doc);
  const prepared = withMaterializedFragment(fragment, (materialized) => {
    const bounds = calculateBounds(materialized.objects);
    const translation = anchor && bounds
      ? {
          x: anchor.x - bounds.centerX,
          y: anchor.y - bounds.centerY,
        }
      : requestedTranslation ?? { x: 0, y: 0 };
    const sourceIds = new Set(
      materialized.objects.map((object) => object.id),
    );
    const targetIds: string[] = [];
    const targetIdBySource = new Map<string, string>();
    const generatedTargetIds = new Set<string>();
    for (let index = 0; index < materialized.objects.length; index += 1) {
      const sourceId = materialized.objects[index].id;
      const targetId = options.idFactory(sourceId, index);
      try {
        assertStableUuid(targetId, "pasted object ID");
      } catch (error) {
        fragmentError("idFactory returned an invalid UUID", error);
      }
      if (
        sourceIds.has(targetId)
        || generatedTargetIds.has(targetId)
        || targetObjects.has(targetId)
      ) {
        fragmentError(`idFactory returned non-fresh ID ${targetId}`);
      }
      targetIds.push(targetId);
      generatedTargetIds.add(targetId);
      targetIdBySource.set(sourceId, targetId);
    }

    const ranks = generateZRanksBetween(
      rankPlan.lower,
      null,
      materialized.objects.length,
    );
    const records = materialized.objects.map((source, index) => {
      const record = cloneFragmentRecord(source.record);
      const targetId = targetIds[index];
      record.set("id", targetId);
      record.set(
        "parentId",
        source.parentId === null
          ? null
          : targetIdBySource.get(source.parentId) ?? null,
      );
      record.set(
        "transform",
        translatedTransform(source.transform, translation),
      );
      record.set("zRank", ranks[index]);
      return {
        id: targetId,
        record,
      };
    });
    return {
      ids: Object.freeze(targetIds),
      records: stageInsertionRecords(records),
    };
  });

  if (prepared.records.length === 0) return prepared.ids;
  if (rankPlan.normalize) normalizeObjectZRanks(doc);
  executeBoardCommand(doc, origin, "objects.fragment.insert", () => {
    for (const { id, record } of prepared.records) {
      targetObjects.set(id, record);
    }
  });
  return prepared.ids;
}
