import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import type {
  AssetDecodeRequest,
  DecodedAssetInfo,
} from "./assets.js";
import type { SupportedBoardAssetMime } from "./assetsImage.js";

// Staging paths are published or removed immediately after validation. The
// libvips file cache otherwise retains WebP handles on Windows after decoding.
sharp.cache({ files: 0 });

const SHARP_FORMAT_BY_MIME: Readonly<Record<SupportedBoardAssetMime, string>> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
  "image/gif": "gif",
};

interface ImageGeometry {
  width: number;
  frameHeight: number;
  frameCount: number;
  totalHeight: number;
  totalDecodedPixels: number;
}

interface SharpMetadata {
  format?: string;
  width?: number;
  height?: number;
  pages?: number;
  pageHeight?: number;
}

interface RawOutputInfo {
  format: string;
  width: number;
  height: number;
  channels: number;
  size: number;
  pages?: number;
  pageHeight?: number;
}

class CountingDiscardStream extends Writable {
  byteLength = 0;

  constructor(private readonly maxByteLength: number) {
    super();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.byteLength += chunk.byteLength;
    if (this.byteLength > this.maxByteLength) {
      callback(new Error("decoded pixel stream exceeded its verified byte limit"));
      return;
    }
    callback();
  }
}

function decoderMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertPositiveSafeInteger(
  value: unknown,
  field: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`asset decoder: ${field} must be a positive safe integer`);
  }
}

function safeProduct(values: readonly number[], field: string): number {
  let result = 1;
  for (const value of values) {
    assertPositiveSafeInteger(value, field);
    result *= value;
    if (!Number.isSafeInteger(result)) {
      throw new Error(`asset decoder: ${field} exceeds the safe integer range`);
    }
  }
  return result;
}

function validateRequest(request: AssetDecodeRequest): void {
  if (typeof request.filePath !== "string" || request.filePath.length === 0) {
    throw new Error("asset decoder: filePath must not be empty");
  }
  if (!(request.mimeType in SHARP_FORMAT_BY_MIME)) {
    throw new Error(`asset decoder: unsupported expected MIME '${request.mimeType}'`);
  }
  assertPositiveSafeInteger(request.encodedWidth, "encodedWidth");
  assertPositiveSafeInteger(request.encodedHeight, "encodedHeight");
  assertPositiveSafeInteger(request.limits.maxWidth, "limits.maxWidth");
  assertPositiveSafeInteger(request.limits.maxHeight, "limits.maxHeight");
  assertPositiveSafeInteger(request.limits.maxPixelsPerFrame, "limits.maxPixelsPerFrame");
  assertPositiveSafeInteger(request.limits.maxFrameCount, "limits.maxFrameCount");
  assertPositiveSafeInteger(
    request.limits.maxTotalDecodedPixels,
    "limits.maxTotalDecodedPixels",
  );
  assertPositiveSafeInteger(
    request.limits.decodeTimeoutSeconds,
    "limits.decodeTimeoutSeconds",
  );
}

function geometryFromMetadata(
  metadata: SharpMetadata,
  request: AssetDecodeRequest,
): ImageGeometry {
  const expectedFormat = SHARP_FORMAT_BY_MIME[request.mimeType];
  if (metadata.format !== expectedFormat) {
    throw new Error(
      `asset decoder: expected ${expectedFormat} input but decoder identified ${metadata.format}`,
    );
  }

  const frameCount = metadata.pages ?? 1;
  const frameHeight = metadata.pageHeight ?? metadata.height;
  assertPositiveSafeInteger(metadata.width, "decoded width");
  assertPositiveSafeInteger(frameHeight, "decoded frame height");
  assertPositiveSafeInteger(frameCount, "decoded frame count");

  const totalHeight = safeProduct(
    [frameHeight, frameCount],
    "decoded stacked height",
  );
  if (metadata.height !== totalHeight) {
    throw new Error("asset decoder: inconsistent multi-frame metadata");
  }
  if (
    metadata.width !== request.encodedWidth
    || frameHeight !== request.encodedHeight
  ) {
    throw new Error(
      "asset decoder: decoded dimensions differ from the encoded image header",
    );
  }

  const pixelsPerFrame = safeProduct(
    [metadata.width, frameHeight],
    "decoded pixels per frame",
  );
  const totalDecodedPixels = safeProduct(
    [pixelsPerFrame, frameCount],
    "total decoded pixels",
  );
  if (
    metadata.width > request.limits.maxWidth
    || frameHeight > request.limits.maxHeight
    || pixelsPerFrame > request.limits.maxPixelsPerFrame
  ) {
    throw new Error("asset decoder: per-frame dimension or pixel limit exceeded");
  }
  if (frameCount > request.limits.maxFrameCount) {
    throw new Error("asset decoder: frame count limit exceeded");
  }
  if (totalDecodedPixels > request.limits.maxTotalDecodedPixels) {
    throw new Error("asset decoder: total decoded pixel limit exceeded");
  }

  return {
    width: metadata.width,
    frameHeight,
    frameCount,
    totalHeight,
    totalDecodedPixels,
  };
}

async function readStrictMetadata(
  request: AssetDecodeRequest,
): Promise<SharpMetadata> {
  const warnings: string[] = [];
  const image = sharp(request.filePath, {
    animated: true,
    failOn: "warning",
    limitInputPixels: request.limits.maxTotalDecodedPixels,
    sequentialRead: true,
    unlimited: false,
  }).timeout({ seconds: request.limits.decodeTimeoutSeconds });
  image.on("warning", (warning) => warnings.push(warning));
  try {
    const metadata = await image.metadata();
    if (warnings.length > 0) {
      throw new Error(warnings.join("; "));
    }
    return metadata;
  } catch (error) {
    throw new Error(
      `asset decoder: image metadata validation failed: ${decoderMessage(error)}`,
      { cause: error },
    );
  } finally {
    image.destroy();
  }
}

async function fullyDecodePixels(
  request: AssetDecodeRequest,
  geometry: ImageGeometry,
): Promise<void> {
  const warnings: string[] = [];
  const maxRawBytes = safeProduct(
    [geometry.totalDecodedPixels, 4],
    "maximum decoded byte count",
  );
  const output = sharp(request.filePath, {
    animated: true,
    failOn: "warning",
    limitInputPixels: request.limits.maxTotalDecodedPixels,
    sequentialRead: true,
    unlimited: false,
  }).timeout({ seconds: request.limits.decodeTimeoutSeconds })
    .raw({ depth: "uchar" });
  let outputInfo: RawOutputInfo | undefined;
  output.on("warning", (warning) => warnings.push(warning));
  output.on("info", (info) => {
    outputInfo = info;
  });
  const discard = new CountingDiscardStream(maxRawBytes);

  try {
    await pipeline(output, discard);
  } catch (error) {
    throw new Error(
      `asset decoder: image pixels could not be fully decoded: ${decoderMessage(error)}`,
      { cause: error },
    );
  } finally {
    output.destroy();
    discard.destroy();
  }
  if (warnings.length > 0) {
    throw new Error(
      `asset decoder: image pixels produced decoder warnings: ${warnings.join("; ")}`,
    );
  }
  if (!outputInfo) {
    throw new Error("asset decoder: full decode completed without output metadata");
  }

  const outputPages = outputInfo.pages ?? 1;
  const outputPageHeight = outputInfo.pageHeight ?? outputInfo.height;
  if (
    outputInfo.format !== "raw"
    || outputInfo.width !== geometry.width
    || outputInfo.height !== geometry.totalHeight
    || outputPages !== geometry.frameCount
    || outputPageHeight !== geometry.frameHeight
  ) {
    throw new Error("asset decoder: full decode geometry differs from source metadata");
  }

  const expectedRawBytes = safeProduct(
    [geometry.totalDecodedPixels, outputInfo.channels],
    "decoded output byte count",
  );
  if (
    outputInfo.size !== expectedRawBytes
    || discard.byteLength !== expectedRawBytes
  ) {
    throw new Error("asset decoder: full decode emitted an incomplete pixel stream");
  }
}

/**
 * Fully decodes every image frame through libvips and discards the raw output
 * incrementally. Metadata-only parsing is never treated as successful decode.
 */
export async function decodeBoardAssetWithSharp(
  request: AssetDecodeRequest,
): Promise<DecodedAssetInfo> {
  validateRequest(request);
  const metadata = await readStrictMetadata(request);
  const geometry = geometryFromMetadata(metadata, request);
  await fullyDecodePixels(request, geometry);
  return {
    fullyDecoded: true,
    width: geometry.width,
    height: geometry.frameHeight,
    frameCount: geometry.frameCount,
    totalDecodedPixels: geometry.totalDecodedPixels,
  };
}
