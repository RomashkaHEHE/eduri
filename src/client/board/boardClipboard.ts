import {
  BOARD_FRAGMENT_LIMITS,
  BOARD_FRAGMENT_MIME_TYPE,
  SUPPORTED_BOARD_ASSET_MIME_TYPES,
} from "../../board/core";

export const BOARD_FRAGMENT_CLIPBOARD_MIME =
  BOARD_FRAGMENT_MIME_TYPE;

const BOARD_FRAGMENT_CLIPBOARD_PREFIX = "EDURI_BOARD_FRAGMENT_V1:";
const BOARD_FRAGMENT_CLIPBOARD_RESERVED_PREFIX = "EDURI_BOARD_FRAGMENT_";
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_CODES = Uint8Array.from(
  BASE64_ALPHABET,
  (character) => character.charCodeAt(0),
);
const BASE64_VALUES = new Int16Array(128).fill(-1);
for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
  BASE64_VALUES[BASE64_ALPHABET.charCodeAt(index)] = index;
}

export const MAX_BOARD_CLIPBOARD_BYTES =
  BOARD_FRAGMENT_LIMITS.maxEncodedBytes;
export const MAX_BOARD_CLIPBOARD_TEXT_BYTES = 4 * 1024 * 1024;
export const MAX_BOARD_CLIPBOARD_FRAGMENT_TEXT_BYTES =
  BOARD_FRAGMENT_CLIPBOARD_PREFIX.length
  + Math.ceil(MAX_BOARD_CLIPBOARD_BYTES / 3) * 4;

export const BOARD_CLIPBOARD_IMAGE_MIME_TYPES =
  SUPPORTED_BOARD_ASSET_MIME_TYPES;

const boardClipboardImageMimeTypes = new Set<string>(
  BOARD_CLIPBOARD_IMAGE_MIME_TYPES,
);
const BOARD_FRAGMENT_PREFIX_PROBE_BYTES =
  BOARD_FRAGMENT_CLIPBOARD_RESERVED_PREFIX.length + 3;

export interface BoardSystemClipboardItem {
  readonly types: readonly string[];
  getType(type: string): Promise<Blob>;
}

export interface BoardSystemClipboard {
  writeText?(value: string): Promise<void>;
  readText?(): Promise<string>;
  read?(): Promise<readonly BoardSystemClipboardItem[]>;
}

export interface BoardClipboardDataItem {
  readonly kind: string;
  readonly type: string;
  getAsFile?(): Blob | null;
}

export interface BoardClipboardData {
  setData(type: string, value: string): void;
  getData(type: string): string;
  readonly types?: ArrayLike<string>;
  readonly items?: ArrayLike<BoardClipboardDataItem>;
  readonly files?: ArrayLike<Blob>;
}

export interface BoardClipboardWriteResult {
  readonly system: boolean;
}

export type BoardPastePayload =
  | {
      readonly kind: "fragment";
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: "image";
      readonly blob: Blob;
      readonly mimeType: string;
      readonly fileName: string | null;
    }
  | {
      readonly kind: "text";
      readonly text: string;
    };

const clipboardTextEncoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  const output = new Uint8Array(Math.ceil(bytes.byteLength / 3) * 4);
  let cursor = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const first = bytes[offset];
    const second = offset + 1 < bytes.byteLength ? bytes[offset + 1] : 0;
    const third = offset + 2 < bytes.byteLength ? bytes[offset + 2] : 0;
    const value = (first << 16) | (second << 8) | third;
    output[cursor++] = BASE64_CODES[(value >>> 18) & 63];
    output[cursor++] = BASE64_CODES[(value >>> 12) & 63];
    output[cursor++] = offset + 1 < bytes.byteLength
      ? BASE64_CODES[(value >>> 6) & 63]
      : 0x3d;
    output[cursor++] = offset + 2 < bytes.byteLength
      ? BASE64_CODES[value & 63]
      : 0x3d;
  }
  return new TextDecoder().decode(output);
}

function base64Value(character: string): number {
  const code = character.charCodeAt(0);
  const value = code < BASE64_VALUES.length
    ? BASE64_VALUES[code]
    : -1;
  if (value < 0) throw new Error("Board clipboard payload is not valid base64");
  return value;
}

function base64ToBytes(value: string): Uint8Array {
  if (
    value.length === 0
    || value.length % 4 !== 0
  ) {
    throw new Error("Board clipboard payload is not valid base64");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const byteLength = (value.length / 4) * 3 - padding;
  if (byteLength < 1 || byteLength > MAX_BOARD_CLIPBOARD_BYTES) {
    throw new Error("Board clipboard payload exceeds the per-operation limit");
  }

  const bytes = new Uint8Array(byteLength);
  let cursor = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const first = base64Value(value[offset]);
    const second = base64Value(value[offset + 1]);
    const third = value[offset + 2] === "="
      ? 0
      : base64Value(value[offset + 2]);
    const fourth = value[offset + 3] === "="
      ? 0
      : base64Value(value[offset + 3]);
    const finalBlock = offset + 4 === value.length;
    if (
      (!finalBlock && (value[offset + 2] === "=" || value[offset + 3] === "="))
      || (finalBlock && padding === 2 && (value[offset + 2] !== "=" || second % 16 !== 0))
      || (finalBlock && padding === 1 && (value[offset + 3] !== "=" || third % 4 !== 0))
      || (finalBlock && padding === 0 && (value[offset + 2] === "=" || value[offset + 3] === "="))
    ) {
      throw new Error("Board clipboard payload is not valid base64");
    }
    const packed = (first << 18) | (second << 12) | (third << 6) | fourth;
    if (cursor < byteLength) bytes[cursor++] = (packed >>> 16) & 0xff;
    if (cursor < byteLength) bytes[cursor++] = (packed >>> 8) & 0xff;
    if (cursor < byteLength) bytes[cursor++] = packed & 0xff;
  }
  return bytes;
}

export function encodeBoardClipboardText(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) {
    throw new TypeError("Board clipboard payload must contain bytes");
  }
  if (bytes.byteLength > MAX_BOARD_CLIPBOARD_BYTES) {
    throw new Error("Board clipboard payload exceeds the per-operation limit");
  }
  return `${BOARD_FRAGMENT_CLIPBOARD_PREFIX}${bytesToBase64(bytes)}`;
}

export function decodeBoardClipboardText(value: string): Uint8Array | null {
  if (!value.startsWith(BOARD_FRAGMENT_CLIPBOARD_PREFIX)) return null;
  return base64ToBytes(value.slice(BOARD_FRAGMENT_CLIPBOARD_PREFIX.length));
}

function normalizeMimeType(value: string): string {
  return value.trim().toLowerCase();
}

function isSupportedImageMimeType(value: string): boolean {
  return boardClipboardImageMimeTypes.has(normalizeMimeType(value));
}

function blobFileName(blob: Blob): string | null {
  const name = (blob as Blob & { readonly name?: unknown }).name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

function fragmentPayloadFromText(
  value: string,
  requireFragment = false,
): BoardPastePayload | null {
  const bytes = decodeBoardClipboardText(value);
  if (bytes) return { kind: "fragment", bytes };
  if (value.startsWith(BOARD_FRAGMENT_CLIPBOARD_RESERVED_PREFIX)) {
    throw new Error("Board clipboard fragment version is unsupported or invalid");
  }
  if (requireFragment) {
    throw new Error("Board clipboard custom MIME is not a Board Fragment");
  }
  return null;
}

function plainTextPayload(value: string): BoardPastePayload | null {
  if (value.length === 0) return null;
  if (
    value.length > MAX_BOARD_CLIPBOARD_TEXT_BYTES
    || clipboardTextEncoder.encode(value).byteLength
    > MAX_BOARD_CLIPBOARD_TEXT_BYTES
  ) {
    throw new Error("Текст из буфера превышает лимит 4 МиБ");
  }
  return { kind: "text", text: value };
}

function arrayLikeValues<T>(values: ArrayLike<T> | undefined): T[] {
  if (!values) return [];
  const output: T[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value !== undefined) output.push(value);
  }
  return output;
}

function imagePayloadFromDataTransfer(
  data: BoardClipboardData,
): BoardPastePayload | null {
  for (const item of arrayLikeValues(data.items)) {
    if (
      item.kind !== "file"
      || !item.getAsFile
    ) {
      continue;
    }
    const itemMime = normalizeMimeType(item.type);
    if (itemMime.length > 0 && !isSupportedImageMimeType(itemMime)) continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    const blobMime = normalizeMimeType(blob.type);
    const mimeType = isSupportedImageMimeType(blobMime)
      ? blobMime
      : itemMime;
    if (!isSupportedImageMimeType(mimeType)) continue;
    return {
      kind: "image",
      blob,
      mimeType,
      fileName: blobFileName(blob),
    };
  }

  for (const blob of arrayLikeValues(data.files)) {
    const mimeType = normalizeMimeType(blob.type);
    if (!isSupportedImageMimeType(mimeType)) continue;
    return {
      kind: "image",
      blob,
      mimeType,
      fileName: blobFileName(blob),
    };
  }
  return null;
}

function dataTransferHasType(
  data: BoardClipboardData,
  expected: string,
): boolean {
  const normalizedExpected = normalizeMimeType(expected);
  return arrayLikeValues(data.types).some(
    (type) => normalizeMimeType(type) === normalizedExpected,
  );
}

function matchingClipboardType(
  item: BoardSystemClipboardItem,
  expected: string,
): string | null {
  const normalizedExpected = normalizeMimeType(expected);
  return item.types.find(
    (type) => normalizeMimeType(type) === normalizedExpected,
  ) ?? null;
}

async function payloadFromSystemItems(
  items: readonly BoardSystemClipboardItem[],
): Promise<BoardPastePayload | null> {
  for (const item of items) {
    const customType = matchingClipboardType(
      item,
      BOARD_FRAGMENT_CLIPBOARD_MIME,
    );
    if (!customType) continue;
    const customBlob = await item.getType(customType);
    if (customBlob.size > MAX_BOARD_CLIPBOARD_FRAGMENT_TEXT_BYTES) {
      throw new Error("Board clipboard payload exceeds the per-operation limit");
    }
    const custom = await customBlob.text();
    return fragmentPayloadFromText(custom, true);
  }

  let firstPlainText:
    | { readonly kind: "text"; readonly value: string }
    | { readonly kind: "oversized" }
    | null = null;
  for (const item of items) {
    const plainType = matchingClipboardType(item, "text/plain");
    if (!plainType) continue;
    const plainBlob = await item.getType(plainType);
    const prefix = await plainBlob
      .slice(0, BOARD_FRAGMENT_PREFIX_PROBE_BYTES)
      .text();
    if (prefix.startsWith(BOARD_FRAGMENT_CLIPBOARD_RESERVED_PREFIX)) {
      if (plainBlob.size > MAX_BOARD_CLIPBOARD_FRAGMENT_TEXT_BYTES) {
        throw new Error("Board clipboard payload exceeds the per-operation limit");
      }
      const plain = await plainBlob.text();
      const fragment = fragmentPayloadFromText(plain);
      if (fragment) return fragment;
      continue;
    }
    if (firstPlainText !== null) continue;
    if (plainBlob.size > MAX_BOARD_CLIPBOARD_TEXT_BYTES) {
      firstPlainText = { kind: "oversized" };
      continue;
    }
    const plain = await plainBlob.text();
    if (plain.length > 0) {
      firstPlainText = { kind: "text", value: plain };
    }
    const fragment = fragmentPayloadFromText(plain);
    if (fragment) return fragment;
  }

  for (const item of items) {
    for (const type of item.types) {
      const requestedMime = normalizeMimeType(type);
      if (!isSupportedImageMimeType(requestedMime)) continue;
      const blob = await item.getType(type);
      const blobMime = normalizeMimeType(blob.type);
      return {
        kind: "image",
        blob,
        mimeType: isSupportedImageMimeType(blobMime)
          ? blobMime
          : requestedMime,
        fileName: blobFileName(blob),
      };
    }
  }

  if (firstPlainText?.kind === "oversized") {
    throw new Error("Текст из буфера превышает лимит 4 МиБ");
  }
  return firstPlainText === null
    ? null
    : plainTextPayload(firstPlainText.value);
}

function defaultSystemClipboard(): BoardSystemClipboard | null {
  return typeof navigator === "undefined"
    ? null
    : (navigator.clipboard as BoardSystemClipboard | undefined) ?? null;
}

export class BoardClipboard {
  private rememberedText: string | null = null;

  constructor(
    private readonly systemClipboard: BoardSystemClipboard | null =
      defaultSystemClipboard(),
  ) {}

  remember(bytes: Uint8Array): void {
    this.rememberedText = encodeBoardClipboardText(bytes);
  }

  async write(bytes: Uint8Array): Promise<BoardClipboardWriteResult> {
    const text = encodeBoardClipboardText(bytes);
    this.rememberedText = text;
    if (!this.systemClipboard?.writeText) return { system: false };
    try {
      await this.systemClipboard.writeText(text);
      return { system: true };
    } catch {
      return { system: false };
    }
  }

  async read(): Promise<BoardPastePayload | null> {
    const rememberedAtInvocation = this.rememberedText;
    if (this.systemClipboard?.read) {
      let items: readonly BoardSystemClipboardItem[] | null = null;
      try {
        items = await this.systemClipboard.read();
      } catch {
        if (!this.systemClipboard.readText) {
          return this.rememberedPayload(rememberedAtInvocation);
        }
      }
      if (items !== null) return payloadFromSystemItems(items);
    }

    if (this.systemClipboard?.readText) {
      let systemText: string;
      try {
        systemText = await this.systemClipboard.readText();
      } catch {
        // Browser permission failures still allow same-tab copy/paste.
        return this.rememberedPayload(rememberedAtInvocation);
      }
      const fragment = fragmentPayloadFromText(systemText);
      return fragment ?? plainTextPayload(systemText);
    }
    return this.rememberedPayload(rememberedAtInvocation);
  }

  writeToDataTransfer(
    data: BoardClipboardData | null,
    bytes: Uint8Array,
  ): boolean {
    const text = encodeBoardClipboardText(bytes);
    this.rememberedText = text;
    if (!data) return false;

    let written = false;
    try {
      data.setData(BOARD_FRAGMENT_CLIPBOARD_MIME, text);
      written = true;
    } catch {
      // Some engines permit only text/plain for clipboard events.
    }
    try {
      data.setData("text/plain", text);
      written = true;
    } catch {
      // The in-memory copy remains available to this tab.
    }
    return written;
  }

  readFromDataTransfer(
    data: BoardClipboardData | null,
  ): BoardPastePayload | null {
    if (!data) return null;

    const hasCustomType = dataTransferHasType(
      data,
      BOARD_FRAGMENT_CLIPBOARD_MIME,
    );
    let custom: string | null = null;
    let plain = "";
    try {
      custom = data.getData(BOARD_FRAGMENT_CLIPBOARD_MIME);
    } catch {
      if (hasCustomType) {
        throw new Error("Board clipboard custom MIME could not be read");
      }
    }
    try {
      plain = data.getData("text/plain");
    } catch {
      // The current event remains authoritative; do not paste stale memory.
    }
    if (
      custom !== null
      && (
        custom.length > 0
        || hasCustomType
      )
    ) {
      return fragmentPayloadFromText(custom, true);
    }
    const fragment = fragmentPayloadFromText(plain);
    if (fragment) return fragment;
    return imagePayloadFromDataTransfer(data) ?? plainTextPayload(plain);
  }

  private rememberedPayload(
    rememberedText: string | null = this.rememberedText,
  ): BoardPastePayload | null {
    if (!rememberedText) return null;
    const bytes = decodeBoardClipboardText(rememberedText);
    return bytes ? { kind: "fragment", bytes } : null;
  }
}
