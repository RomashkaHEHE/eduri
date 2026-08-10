// DOM-free encoded image inspection shared by web and server adapters.
export const SUPPORTED_BOARD_ASSET_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type SupportedBoardAssetMime =
  typeof SUPPORTED_BOARD_ASSET_MIME_TYPES[number];

export interface EncodedImageInfo {
  mimeType: SupportedBoardAssetMime;
  width: number;
  height: number;
}

export type EncodedImageErrorCode =
  | "SVG_REJECTED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "MALFORMED_IMAGE";

export class EncodedImageError extends Error {
  constructor(
    public readonly code: EncodedImageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EncodedImageError";
  }
}

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG_START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

function hasBytes(value: Uint8Array, offset: number, expected: Uint8Array): boolean {
  if (offset + expected.byteLength > value.byteLength) return false;
  for (let index = 0; index < expected.byteLength; index += 1) {
    if (value[offset + index] !== expected[index]) return false;
  }
  return true;
}

function ascii(value: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...value.subarray(offset, offset + length));
}

function assertDimensions(width: number, height: number): { width: number; height: number } {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new EncodedImageError("MALFORMED_IMAGE", "encoded image has invalid dimensions");
  }
  return { width, height };
}

function inspectPng(value: Uint8Array): EncodedImageInfo | null {
  if (!hasBytes(value, 0, PNG_SIGNATURE)) return null;
  if (value.byteLength < 24 || ascii(value, 12, 4) !== "IHDR") {
    throw new EncodedImageError("MALFORMED_IMAGE", "PNG is missing a complete IHDR header");
  }
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const dimensions = assertDimensions(view.getUint32(16), view.getUint32(20));
  return { mimeType: "image/png", ...dimensions };
}

function inspectGif(value: Uint8Array): EncodedImageInfo | null {
  if (value.byteLength < 6) return null;
  const version = ascii(value, 0, 6);
  if (version !== "GIF87a" && version !== "GIF89a") return null;
  if (value.byteLength < 10) {
    throw new EncodedImageError("MALFORMED_IMAGE", "GIF is missing its logical screen descriptor");
  }
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const dimensions = assertDimensions(view.getUint16(6, true), view.getUint16(8, true));
  return { mimeType: "image/gif", ...dimensions };
}

function inspectJpeg(value: Uint8Array): EncodedImageInfo | null {
  if (value.byteLength < 2 || value[0] !== 0xff || value[1] !== 0xd8) return null;
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  let offset = 2;
  while (offset < value.byteLength) {
    while (offset < value.byteLength && value[offset] !== 0xff) offset += 1;
    while (offset < value.byteLength && value[offset] === 0xff) offset += 1;
    if (offset >= value.byteLength) break;
    const marker = value[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (offset + 2 > value.byteLength) break;
    const segmentLength = view.getUint16(offset);
    if (segmentLength < 2 || offset + segmentLength > value.byteLength) {
      throw new EncodedImageError("MALFORMED_IMAGE", "JPEG contains a truncated segment");
    }
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (segmentLength < 7) {
        throw new EncodedImageError("MALFORMED_IMAGE", "JPEG frame header is too short");
      }
      const dimensions = assertDimensions(
        view.getUint16(offset + 5),
        view.getUint16(offset + 3),
      );
      return { mimeType: "image/jpeg", ...dimensions };
    }
    offset += segmentLength;
  }
  throw new EncodedImageError("MALFORMED_IMAGE", "JPEG dimensions were not found in the inspected header");
}

function uint24LittleEndian(value: Uint8Array, offset: number): number {
  return value[offset] | (value[offset + 1] << 8) | (value[offset + 2] << 16);
}

function inspectWebp(value: Uint8Array): EncodedImageInfo | null {
  if (
    value.byteLength < 16
    || ascii(value, 0, 4) !== "RIFF"
    || ascii(value, 8, 4) !== "WEBP"
  ) {
    return null;
  }
  const chunkType = ascii(value, 12, 4);
  if (chunkType === "VP8X") {
    if (value.byteLength < 30) {
      throw new EncodedImageError("MALFORMED_IMAGE", "WebP VP8X header is truncated");
    }
    const dimensions = assertDimensions(
      uint24LittleEndian(value, 24) + 1,
      uint24LittleEndian(value, 27) + 1,
    );
    return { mimeType: "image/webp", ...dimensions };
  }
  if (chunkType === "VP8L") {
    if (value.byteLength < 25 || value[20] !== 0x2f) {
      throw new EncodedImageError("MALFORMED_IMAGE", "WebP VP8L header is malformed");
    }
    const bits = (
      value[21]
      | (value[22] << 8)
      | (value[23] << 16)
      | (value[24] << 24)
    ) >>> 0;
    const dimensions = assertDimensions(
      (bits & 0x3fff) + 1,
      ((bits >>> 14) & 0x3fff) + 1,
    );
    return { mimeType: "image/webp", ...dimensions };
  }
  if (chunkType === "VP8 ") {
    if (
      value.byteLength < 30
      || value[23] !== 0x9d
      || value[24] !== 0x01
      || value[25] !== 0x2a
    ) {
      throw new EncodedImageError("MALFORMED_IMAGE", "WebP VP8 frame header is malformed");
    }
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    const dimensions = assertDimensions(
      view.getUint16(26, true) & 0x3fff,
      view.getUint16(28, true) & 0x3fff,
    );
    return { mimeType: "image/webp", ...dimensions };
  }
  throw new EncodedImageError("MALFORMED_IMAGE", `unsupported WebP chunk '${chunkType}'`);
}

function looksLikeSvg(value: Uint8Array): boolean {
  const prefix = new TextDecoder("utf-8", { fatal: false })
    .decode(value.subarray(0, Math.min(value.byteLength, 4096)))
    .replace(/^\uFEFF/u, "")
    .trimStart()
    .toLowerCase();
  if (prefix.startsWith("<svg")) return true;
  if (prefix.startsWith("<!doctype svg")) return true;
  if (prefix.startsWith("<?xml")) {
    return prefix.slice(0, 2048).includes("<svg");
  }
  return false;
}

export function inspectEncodedImage(value: Uint8Array): EncodedImageInfo {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new EncodedImageError("UNSUPPORTED_MEDIA_TYPE", "asset has no image bytes");
  }
  if (looksLikeSvg(value)) {
    throw new EncodedImageError("SVG_REJECTED", "active SVG content is not accepted");
  }
  const inspected = inspectPng(value) ?? inspectJpeg(value) ?? inspectWebp(value) ?? inspectGif(value);
  if (!inspected) {
    throw new EncodedImageError(
      "UNSUPPORTED_MEDIA_TYPE",
      "only PNG, JPEG, WebP, and GIF images are accepted",
    );
  }
  return inspected;
}
