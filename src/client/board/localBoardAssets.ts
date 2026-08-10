import {
  SUPPORTED_BOARD_ASSET_MIME_TYPES,
  inspectEncodedImage,
} from "../../board/core";
import type { BoardImageInsertion, BoardSurfaceProps } from "./BoardSurface";
import {
  BoardAssetOutbox,
  type AssetOutboxEvent,
  type AssetOutboxIdentity,
  type AssetOutboxOptions,
  type AssetOutboxRecord,
} from "./assetOutbox";

export const BOARD_IMAGE_HASH_PATTERN = /^[0-9a-f]{64}$/u;
export const BOARD_IMAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

const BOARD_IMAGE_MIME_TYPES = new Set<string>(
  SUPPORTED_BOARD_ASSET_MIME_TYPES,
);
const BOARD_IMAGE_MAX_BYTES = 128 * 1024 * 1024;
const BOARD_IMAGE_HEADER_BYTES = 1024 * 1024;
const BOARD_IMAGE_MAX_DIMENSION = 16_384;
const BOARD_IMAGE_MAX_PIXELS = 100_000_000;
const FOREIGN_ASSET_LOOKUP_CONCURRENCY = 16;

export interface ValidatedBoardImage {
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalBytes: number;
}

export async function browserImageDimensions(
  file: File,
): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      try {
        return { width: bitmap.width, height: bitmap.height };
      } finally {
        bitmap.close();
      }
    } catch {
      // Some engines expose createImageBitmap but decode fewer image variants.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
      image.onerror = () => reject(new Error("Image could not be decoded"));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function validateBoardImageFile(
  file: File,
): Promise<ValidatedBoardImage> {
  const declaredMime = file.type.trim().toLowerCase()
    || "application/octet-stream";
  if (file.size < 1) throw new Error("Image file is empty");
  if (file.size > BOARD_IMAGE_MAX_BYTES) {
    throw new Error("Image exceeds the 128 MiB per-file limit");
  }
  if (
    declaredMime !== "application/octet-stream"
    && !BOARD_IMAGE_MIME_TYPES.has(declaredMime)
  ) {
    throw new Error("Unsupported image type");
  }

  const header = new Uint8Array(await file
    .slice(0, BOARD_IMAGE_HEADER_BYTES)
    .arrayBuffer());
  const encoded = inspectEncodedImage(header);
  if (
    declaredMime !== "application/octet-stream"
    && declaredMime !== encoded.mimeType
  ) {
    throw new Error(
      `Declared image type ${declaredMime} does not match ${encoded.mimeType}`,
    );
  }
  const encodedPixels = encoded.width * encoded.height;
  if (
    !Number.isSafeInteger(encodedPixels)
    || encoded.width > BOARD_IMAGE_MAX_DIMENSION
    || encoded.height > BOARD_IMAGE_MAX_DIMENSION
    || encodedPixels > BOARD_IMAGE_MAX_PIXELS
  ) {
    throw new Error("Image dimensions exceed the board safety limit");
  }

  const dimensions = await browserImageDimensions(file);
  const pixels = dimensions.width * dimensions.height;
  if (
    !Number.isSafeInteger(pixels)
    || dimensions.width < 1
    || dimensions.height < 1
    || dimensions.width > BOARD_IMAGE_MAX_DIMENSION
    || dimensions.height > BOARD_IMAGE_MAX_DIMENSION
    || pixels > BOARD_IMAGE_MAX_PIXELS
  ) {
    throw new Error("Image dimensions exceed the board safety limit");
  }
  const decodedMatchesHeader =
    dimensions.width === encoded.width
    && dimensions.height === encoded.height;
  const decodedMatchesExifRotation =
    dimensions.width === encoded.height
    && dimensions.height === encoded.width;
  if (!decodedMatchesHeader && !decodedMatchesExifRotation) {
    throw new Error("Decoded image dimensions do not match its header");
  }

  return {
    mimeType: encoded.mimeType,
    width: dimensions.width,
    height: dimensions.height,
    originalBytes: file.size,
  };
}

type FragmentImageAssets = Parameters<
  NonNullable<BoardSurfaceProps["validateFragmentPaste"]>
>[1];
export type FragmentImageIdentity = FragmentImageAssets["identities"][number];

interface FragmentAssetReader {
  get(assetId: string): Promise<AssetOutboxRecord | null>;
}

function sameFragmentImageIdentity(
  left: FragmentImageIdentity,
  right: FragmentImageIdentity,
): boolean {
  return left.assetId === right.assetId
    && left.contentHash === right.contentHash
    && left.originalBytes === right.originalBytes
    && left.mimeType === right.mimeType;
}

export async function validateForeignFragmentImageAssets(
  reader: FragmentAssetReader,
  identities: readonly FragmentImageIdentity[],
): Promise<void> {
  const expectedByAssetId = new Map<string, FragmentImageIdentity>();
  for (const identity of identities) {
    const existing = expectedByAssetId.get(identity.assetId);
    if (existing && !sameFragmentImageIdentity(existing, identity)) {
      throw new Error("Фрагмент содержит противоречивые ссылки на изображение");
    }
    expectedByAssetId.set(identity.assetId, identity);
  }

  const unique = [...expectedByAssetId.values()];
  let cursor = 0;
  const worker = async () => {
    while (cursor < unique.length) {
      const identity = unique[cursor++];
      const available = await reader.get(identity.assetId);
      const availableMime = available?.published?.mimeType
        ?? (
          available?.declaredMime !== "application/octet-stream"
            ? available?.declaredMime
            : null
        );
      if (
        !available
        || available.sha256 !== identity.contentHash
        || available.byteSize !== identity.originalBytes
        || availableMime !== identity.mimeType
        || (!available.blob && available.state !== "ready")
      ) {
        throw new Error(
          "Сначала импортируйте изображения: эта копия создана в другой доске",
        );
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(FOREIGN_ASSET_LOOKUP_CONCURRENCY, unique.length) },
    worker,
  ));
}

export interface LocalBoardAssetRepositoryOptions {
  readonly outbox?: BoardAssetOutbox;
  readonly outboxOptions?: AssetOutboxOptions;
  readonly createObjectUrl?: (blob: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
}

export interface LocalBoardAssetExport {
  readonly assetId: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly declaredMime: string;
  readonly originalFileName: string | null;
  readonly blob: Blob;
}

export class LocalBoardAssetRepository {
  readonly outbox: BoardAssetOutbox;

  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (url: string) => void;
  private readonly objectUrls = new Map<string, {
    readonly sha256: string;
    readonly url: string;
  }>();
  private readonly tasks = new Set<Promise<unknown>>();
  private closed = false;

  constructor(
    identity: AssetOutboxIdentity,
    options: LocalBoardAssetRepositoryOptions = {},
  ) {
    this.outbox = options.outbox
      ?? new BoardAssetOutbox(identity, options.outboxOptions);
    this.createObjectUrl = options.createObjectUrl
      ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectUrl = options.revokeObjectUrl
      ?? ((url) => URL.revokeObjectURL(url));
  }

  async whenReady(): Promise<void> {
    if (this.closed) throw new Error("Local board assets are closed");
    await this.outbox.whenReady();
  }

  subscribe(listener: (event: AssetOutboxEvent) => void): () => void {
    if (this.closed) return () => undefined;
    return this.outbox.subscribe(listener);
  }

  insertImage(file: File): Promise<BoardImageInsertion> {
    return this.track((async () => {
      this.assertOpen();
      const validated = await validateBoardImageFile(file);
      this.assertOpen();
      const stored = await this.outbox.enqueueLocal({
        blob: file,
        declaredMime: validated.mimeType,
        originalFileName: file.name,
      });
      this.assertOpen();
      return {
        assetId: stored.assetId,
        contentHash: stored.sha256,
        mimeType: stored.declaredMime,
        width: validated.width,
        height: validated.height,
        originalBytes: stored.byteSize,
      };
    })());
  }

  resolveAssetUrl(
    assetId: string,
    contentHash: string | null,
  ): Promise<string | null> {
    return this.track((async () => {
      if (this.closed || !BOARD_IMAGE_ID_PATTERN.test(assetId)) return null;
      const record = await this.outbox.get(assetId);
      if (
        this.closed
        || !record?.blob
        || (contentHash !== null && record.sha256 !== contentHash)
      ) {
        return null;
      }
      const cached = this.objectUrls.get(assetId);
      if (cached?.sha256 === record.sha256) return cached.url;
      if (cached) this.revokeObjectUrl(cached.url);
      const url = this.createObjectUrl(record.blob);
      this.objectUrls.set(assetId, { sha256: record.sha256, url });
      return url;
    })());
  }

  validateForeignImages(
    identities: readonly FragmentImageIdentity[],
  ): Promise<void> {
    return this.track(validateForeignFragmentImageAssets(
      this.outbox,
      identities,
    ));
  }

  exportLocalAssets(): Promise<readonly LocalBoardAssetExport[]> {
    return this.track((async () => {
      this.assertOpen();
      await this.outbox.whenReady();
      this.assertOpen();
      const records = await this.outbox.list();
      this.assertOpen();
      return Object.freeze(records.flatMap((record) => {
        if (!record.blob) return [];
        if (record.blob.size !== record.byteSize) {
          throw new Error(
            `Local asset ${record.assetId} no longer matches its durable identity`,
          );
        }
        return [Object.freeze({
          assetId: record.assetId,
          sha256: record.sha256,
          byteSize: record.byteSize,
          declaredMime: record.declaredMime,
          originalFileName: record.originalFileName,
          blob: record.blob.slice(0, record.blob.size, record.blob.type),
        })];
      }));
    })());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    while (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks]);
    }
    await this.outbox.close();
    for (const asset of this.objectUrls.values()) {
      this.revokeObjectUrl(asset.url);
    }
    this.objectUrls.clear();
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.tasks.add(operation);
    void operation.finally(() => {
      this.tasks.delete(operation);
    }).catch(() => undefined);
    return operation;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Local board assets are closed");
  }
}
