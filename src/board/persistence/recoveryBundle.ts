import * as Y from "yjs";

const RECOVERY_FORMAT = "eduri.board.recovery";
const RECOVERY_VERSION = 1;
const MAGIC = new TextEncoder().encode("EDURI_BOARD_RECOVERY_V1\n");
const MAX_HEADER_BYTES = 4 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export const BOARD_RECOVERY_MIME_TYPE =
  "application/vnd.eduri.board-recovery";

export interface BoardRecoveryIdentity {
  readonly boardId: string;
  readonly lessonId: string;
  readonly generation: number;
  readonly schemaVersion: number;
  readonly documentKey: string;
  readonly pageId: string;
}

export interface BoardRecoveryAssetInput {
  readonly assetId: string;
  readonly sha256: string;
  readonly mimeType: string;
  readonly fileName?: string | null;
  readonly bytes: Uint8Array;
}

export interface BoardRecoveryAssetDescriptor {
  readonly assetId: string;
  readonly sha256: string;
  readonly mimeType: string;
  readonly fileName?: string | null;
  readonly byteLength: number;
}

interface BoardRecoveryBundleBaseInput {
  readonly identity: BoardRecoveryIdentity;
  readonly document: Y.Doc;
  readonly reason: string;
  readonly pendingUpdateCount: number;
  readonly createdAt?: string;
}

export interface BoardRecoveryBundleInput extends BoardRecoveryBundleBaseInput {
  readonly assets?: readonly BoardRecoveryAssetInput[];
}

export interface BoardRecoveryBundlePrefixInput
  extends BoardRecoveryBundleBaseInput {
  readonly assets?: readonly BoardRecoveryAssetDescriptor[];
}

export interface ParsedBoardRecoveryAsset {
  readonly assetId: string;
  readonly sha256: string;
  readonly mimeType: string;
  readonly fileName: string | null;
  readonly bytes: Uint8Array;
}

export interface ParsedBoardRecoveryBundle {
  readonly identity: BoardRecoveryIdentity;
  readonly reason: string;
  readonly pendingUpdateCount: number;
  readonly createdAt: string;
  readonly documentUpdate: Uint8Array;
  readonly assets: readonly ParsedBoardRecoveryAsset[];
}

interface RecoveryHeader {
  readonly format: typeof RECOVERY_FORMAT;
  readonly version: typeof RECOVERY_VERSION;
  readonly identity: BoardRecoveryIdentity;
  readonly reason: string;
  readonly pendingUpdateCount: number;
  readonly createdAt: string;
  readonly documentBytes: number;
  readonly assets: ReadonlyArray<{
    readonly assetId: string;
    readonly sha256: string;
    readonly mimeType: string;
    readonly fileName: string | null;
    readonly bytes: number;
  }>;
}

function assertNonEmpty(value: unknown, field: string, maximum = 512): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
  ) {
    throw new Error(`Recovery bundle ${field} is invalid`);
  }
  return value;
}

function assertSafeCount(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`Recovery bundle ${field} is invalid`);
  }
  return value as number;
}

function validateIdentity(value: unknown): BoardRecoveryIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Recovery bundle identity is invalid");
  }
  const identity = value as Partial<BoardRecoveryIdentity>;
  return {
    boardId: assertNonEmpty(identity.boardId, "boardId"),
    lessonId: assertNonEmpty(identity.lessonId, "lessonId"),
    generation: assertSafeCount(identity.generation, "generation", 1),
    schemaVersion: assertSafeCount(identity.schemaVersion, "schemaVersion", 1),
    documentKey: assertNonEmpty(identity.documentKey, "documentKey"),
    pageId: assertNonEmpty(identity.pageId, "pageId"),
  };
}

function validateCreatedAt(value: unknown): string {
  const createdAt = assertNonEmpty(value, "createdAt", 128);
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error("Recovery bundle createdAt is invalid");
  }
  return createdAt;
}

function encodeLength(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function concatenateBytes(parts: readonly Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const part of parts) {
    totalLength += part.byteLength;
    if (!Number.isSafeInteger(totalLength)) {
      throw new Error("Recovery bundle is too large");
    }
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function equalPrefix(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.byteLength < prefix.byteLength) return false;
  for (let index = 0; index < prefix.byteLength; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

function normalizeAssetDescriptor(
  asset: BoardRecoveryAssetDescriptor,
): RecoveryHeader["assets"][number] {
  const assetId = assertNonEmpty(asset.assetId, "assetId", 128);
  const sha256 = assertNonEmpty(asset.sha256, "asset sha256", 64);
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error("Recovery bundle asset sha256 is invalid");
  }
  return {
    assetId,
    sha256,
    mimeType: assertNonEmpty(asset.mimeType, "asset mimeType", 256),
    fileName: asset.fileName === null || asset.fileName === undefined
      ? null
      : assertNonEmpty(asset.fileName, "asset fileName", 512),
    bytes: assertSafeCount(asset.byteLength, "asset bytes"),
  };
}

/**
 * Creates the non-asset byte parts without concatenating them. Append asset
 * bodies in descriptor order. A web adapter can pass these parts and its
 * original Blob instances directly to the Blob constructor.
 */
export function createBoardRecoveryBundleParts(
  input: BoardRecoveryBundlePrefixInput,
): readonly Uint8Array[] {
  const identity = validateIdentity(input.identity);
  const createdAt = validateCreatedAt(input.createdAt ?? new Date().toISOString());
  const reason = assertNonEmpty(input.reason, "reason", 256);
  const pendingUpdateCount = assertSafeCount(
    input.pendingUpdateCount,
    "pendingUpdateCount",
  );
  const documentUpdate = Y.encodeStateAsUpdate(input.document);
  const assets = (input.assets ?? []).map(normalizeAssetDescriptor);
  const header: RecoveryHeader = {
    format: RECOVERY_FORMAT,
    version: RECOVERY_VERSION,
    identity,
    reason,
    pendingUpdateCount,
    createdAt,
    documentBytes: documentUpdate.byteLength,
    assets,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (headerBytes.byteLength > MAX_HEADER_BYTES) {
    throw new Error("Recovery bundle header is too large");
  }
  return Object.freeze([
    MAGIC.slice(),
    encodeLength(headerBytes.byteLength),
    headerBytes,
    documentUpdate,
  ]);
}

/**
 * Convenience wrapper for adapters that need one contiguous non-asset prefix.
 */
export function createBoardRecoveryBundlePrefix(
  input: BoardRecoveryBundlePrefixInput,
): Uint8Array {
  return concatenateBytes(createBoardRecoveryBundleParts(input));
}

export function createBoardRecoveryBundle(
  input: BoardRecoveryBundleInput,
): Uint8Array {
  const { assets: rawAssets = [], ...bundle } = input;
  for (const asset of rawAssets) {
    if (!(asset.bytes instanceof Uint8Array)) {
      throw new Error("Recovery bundle asset bytes are invalid");
    }
  }
  const parts = createBoardRecoveryBundleParts({
    ...bundle,
    assets: rawAssets.map((asset) => ({
      assetId: asset.assetId,
      sha256: asset.sha256,
      mimeType: asset.mimeType,
      fileName: asset.fileName,
      byteLength: asset.bytes.byteLength,
    })),
  });
  return concatenateBytes([...parts, ...rawAssets.map((asset) => asset.bytes)]);
}

export function parseBoardRecoveryBundle(
  bundle: Uint8Array,
): ParsedBoardRecoveryBundle {
  if (!(bundle instanceof Uint8Array)) {
    throw new Error("Recovery bundle must be a Uint8Array");
  }
  const prefixBytes = MAGIC.byteLength + 4;
  if (bundle.byteLength < prefixBytes) {
    throw new Error("Recovery bundle is truncated");
  }
  if (!equalPrefix(bundle, MAGIC)) {
    throw new Error("Recovery bundle magic is invalid");
  }
  const headerLength = new DataView(
    bundle.buffer,
    bundle.byteOffset + MAGIC.byteLength,
    4,
  ).getUint32(0, true);
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) {
    throw new Error("Recovery bundle header length is invalid");
  }
  const payloadOffset = prefixBytes + headerLength;
  if (payloadOffset > bundle.byteLength) {
    throw new Error("Recovery bundle header is truncated");
  }
  let rawHeader: unknown;
  try {
    const headerText = new TextDecoder("utf-8", { fatal: true }).decode(
      bundle.subarray(prefixBytes, payloadOffset),
    );
    rawHeader = JSON.parse(headerText);
  } catch {
    throw new Error("Recovery bundle header JSON is invalid");
  }
  if (!rawHeader || typeof rawHeader !== "object" || Array.isArray(rawHeader)) {
    throw new Error("Recovery bundle header is invalid");
  }
  const header = rawHeader as Partial<RecoveryHeader>;
  if (
    header.format !== RECOVERY_FORMAT
    || header.version !== RECOVERY_VERSION
  ) {
    throw new Error("Recovery bundle format is unsupported");
  }
  const identity = validateIdentity(header.identity);
  const reason = assertNonEmpty(header.reason, "reason", 256);
  const pendingUpdateCount = assertSafeCount(
    header.pendingUpdateCount,
    "pendingUpdateCount",
  );
  const documentBytes = assertSafeCount(
    header.documentBytes,
    "documentBytes",
    1,
  );
  if (!Array.isArray(header.assets)) {
    throw new Error("Recovery bundle assets are invalid");
  }

  let cursor = payloadOffset;
  const documentEnd = cursor + documentBytes;
  if (!Number.isSafeInteger(documentEnd) || documentEnd > bundle.byteLength) {
    throw new Error("Recovery bundle document is truncated");
  }
  const documentUpdate = bundle.slice(cursor, documentEnd);
  cursor = documentEnd;

  const assets: ParsedBoardRecoveryAsset[] = [];
  for (const rawAsset of header.assets) {
    if (!rawAsset || typeof rawAsset !== "object" || Array.isArray(rawAsset)) {
      throw new Error("Recovery bundle asset entry is invalid");
    }
    const asset = rawAsset as RecoveryHeader["assets"][number];
    const sha256 = assertNonEmpty(asset.sha256, "asset sha256", 64);
    if (!SHA256_PATTERN.test(sha256)) {
      throw new Error("Recovery bundle asset sha256 is invalid");
    }
    const byteLength = assertSafeCount(asset.bytes, "asset bytes");
    const end = cursor + byteLength;
    if (!Number.isSafeInteger(end) || end > bundle.byteLength) {
      throw new Error("Recovery bundle asset is truncated");
    }
    const mimeType = assertNonEmpty(asset.mimeType, "asset mimeType", 256);
    assets.push({
      assetId: assertNonEmpty(asset.assetId, "assetId", 128),
      sha256,
      mimeType,
      fileName: asset.fileName === null
        ? null
        : assertNonEmpty(asset.fileName, "asset fileName", 512),
      bytes: bundle.slice(cursor, end),
    });
    cursor = end;
  }
  if (cursor !== bundle.byteLength) {
    throw new Error("Recovery bundle contains trailing data");
  }

  return {
    identity,
    reason,
    pendingUpdateCount,
    createdAt: validateCreatedAt(header.createdAt),
    documentUpdate,
    assets,
  };
}

export function restoreBoardRecoveryDocument(
  parsed: Pick<ParsedBoardRecoveryBundle, "documentUpdate">,
): Y.Doc {
  const document = new Y.Doc();
  Y.applyUpdate(document, parsed.documentUpdate);
  return document;
}
