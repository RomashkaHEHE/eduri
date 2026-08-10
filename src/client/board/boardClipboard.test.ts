import { describe, expect, it, vi } from "vitest";
import {
  BOARD_CLIPBOARD_IMAGE_MIME_TYPES,
  BOARD_FRAGMENT_CLIPBOARD_MIME,
  BoardClipboard,
  MAX_BOARD_CLIPBOARD_BYTES,
  MAX_BOARD_CLIPBOARD_FRAGMENT_TEXT_BYTES,
  MAX_BOARD_CLIPBOARD_TEXT_BYTES,
  decodeBoardClipboardText,
  encodeBoardClipboardText,
  type BoardClipboardData,
  type BoardClipboardDataItem,
  type BoardSystemClipboardItem,
} from "./boardClipboard";

class MemoryDataTransfer implements BoardClipboardData {
  readonly values = new Map<string, string>();
  readonly items: ArrayLike<BoardClipboardDataItem>;
  readonly files: ArrayLike<Blob>;

  constructor(options: {
    readonly items?: readonly BoardClipboardDataItem[];
    readonly files?: readonly Blob[];
  } = {}) {
    this.items = options.items ?? [];
    this.files = options.files ?? [];
  }

  get types(): readonly string[] {
    return [...this.values.keys()];
  }

  setData(type: string, value: string): void {
    this.values.set(type, value);
  }

  getData(type: string): string {
    return this.values.get(type) ?? "";
  }
}

function systemItem(
  values: Readonly<Record<string, string | Blob>>,
): BoardSystemClipboardItem {
  return {
    types: Object.keys(values),
    getType: vi.fn(async (type: string) => {
      const value = values[type];
      if (value === undefined) throw new Error(`missing clipboard type ${type}`);
      return typeof value === "string"
        ? new Blob([value], { type })
        : value;
    }),
  };
}

describe("BoardClipboard", () => {
  it("round-trips arbitrary binary fragments without Buffer or DOM APIs", () => {
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
    const encoded = encodeBoardClipboardText(bytes);

    expect(decodeBoardClipboardText(encoded)).toEqual(bytes);
    expect(decodeBoardClipboardText("ordinary text")).toBeNull();
  });

  it.each([1, 2, 3, 4, 65_537])(
    "round-trips a %i-byte payload across base64 boundaries",
    (length) => {
      const bytes = Uint8Array.from(
        { length },
        (_, index) => (index * 131 + 17) & 0xff,
      );
      expect(decodeBoardClipboardText(encodeBoardClipboardText(bytes)))
        .toEqual(bytes);
    },
  );

  it("rejects matching but malformed or oversized payloads", () => {
    expect(() => decodeBoardClipboardText("EDURI_BOARD_FRAGMENT_V1:%%%="))
      .toThrow(/base64/u);
    expect(() => encodeBoardClipboardText(
      new Uint8Array(MAX_BOARD_CLIPBOARD_BYTES + 1),
    )).toThrow(/limit/u);
  });

  it("writes both the custom MIME and a text fallback during clipboard events", () => {
    const clipboard = new BoardClipboard(null);
    const transfer = new MemoryDataTransfer();
    const bytes = Uint8Array.from([4, 5, 6]);

    expect(clipboard.writeToDataTransfer(transfer, bytes)).toBe(true);
    expect(transfer.values.get(BOARD_FRAGMENT_CLIPBOARD_MIME))
      .toBe(transfer.values.get("text/plain"));
    expect(clipboard.readFromDataTransfer(transfer)).toEqual({
      kind: "fragment",
      bytes,
    });
  });

  it("keeps a same-tab fallback but reports that a system write failed", async () => {
    const clipboard = new BoardClipboard({
      writeText: vi.fn().mockRejectedValue(new Error("denied")),
      readText: vi.fn().mockRejectedValue(new Error("denied")),
    });
    const bytes = Uint8Array.from([7, 8, 9]);

    await expect(clipboard.write(bytes)).resolves.toEqual({ system: false });
    await expect(clipboard.read()).resolves.toEqual({
      kind: "fragment",
      bytes,
    });
  });

  it("freezes the same-tab fallback when an asynchronous read begins", async () => {
    let rejectRead!: (reason?: unknown) => void;
    const read = new Promise<string>((_resolve, reject) => {
      rejectRead = reject;
    });
    const clipboard = new BoardClipboard({
      readText: () => read,
    });
    const original = Uint8Array.of(1, 2, 3);
    clipboard.remember(original);

    const pending = clipboard.read();
    clipboard.remember(Uint8Array.of(9, 8, 7));
    rejectRead(new Error("denied"));

    await expect(pending).resolves.toEqual({
      kind: "fragment",
      bytes: original,
    });
  });

  it("returns authoritative ordinary system text instead of a stale same-tab fragment", async () => {
    const clipboard = new BoardClipboard({
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue("new unrelated text"),
    });
    await clipboard.write(Uint8Array.from([1, 2, 3]));

    await expect(clipboard.read()).resolves.toEqual({
      kind: "text",
      text: "new unrelated text",
    });
  });

  it("never falls back to stale memory for a malformed authoritative fragment", async () => {
    const clipboard = new BoardClipboard({
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue(
        "EDURI_BOARD_FRAGMENT_V1:%%%=",
      ),
    });
    await clipboard.write(Uint8Array.from([1, 2, 3]));

    await expect(clipboard.read()).rejects.toThrow(/base64/u);
  });

  it("uses a successful rich clipboard read as authoritative even when empty", async () => {
    const readText = vi.fn().mockRejectedValue(new Error("denied"));
    const clipboard = new BoardClipboard({
      writeText: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue([]),
      readText,
    });
    await clipboard.write(Uint8Array.from([1, 2, 3]));

    await expect(clipboard.read()).resolves.toBeNull();
    expect(readText).not.toHaveBeenCalled();
  });

  it("prioritizes a rich Board Fragment over image and ordinary text", async () => {
    const bytes = Uint8Array.from([9, 8, 7]);
    const image = new Blob([Uint8Array.of(1, 2)], { type: "image/png" });
    const clipboard = new BoardClipboard({
      read: vi.fn().mockResolvedValue([
        systemItem({
          "image/png": image,
          "text/plain": "ordinary text",
        }),
        systemItem({
          [BOARD_FRAGMENT_CLIPBOARD_MIME]:
            encodeBoardClipboardText(bytes),
        }),
      ]),
    });

    await expect(clipboard.read()).resolves.toEqual({
      kind: "fragment",
      bytes,
    });
  });

  it("rejects an oversized rich custom fragment before reading the full Blob", async () => {
    const fragment = new Blob(
      [encodeBoardClipboardText(Uint8Array.of(1, 2, 3))],
      { type: BOARD_FRAGMENT_CLIPBOARD_MIME },
    );
    Object.defineProperty(fragment, "size", {
      configurable: true,
      value: MAX_BOARD_CLIPBOARD_FRAGMENT_TEXT_BYTES + 1,
    });
    const readFullText = vi.spyOn(fragment, "text");
    const clipboard = new BoardClipboard({
      read: vi.fn().mockResolvedValue([
        systemItem({
          [BOARD_FRAGMENT_CLIPBOARD_MIME]: fragment,
        }),
      ]),
    });

    await expect(clipboard.read()).rejects.toThrow(/per-operation limit/u);
    expect(readFullText).not.toHaveBeenCalled();
  });

  it("rejects oversized rich plain text without reading the full Blob", async () => {
    const plain = new Blob(["ordinary text"], { type: "text/plain" });
    Object.defineProperty(plain, "size", {
      configurable: true,
      value: MAX_BOARD_CLIPBOARD_TEXT_BYTES + 1,
    });
    const readFullText = vi.spyOn(plain, "text");
    const clipboard = new BoardClipboard({
      read: vi.fn().mockResolvedValue([
        systemItem({ "text/plain": plain }),
      ]),
    });

    await expect(clipboard.read()).rejects.toThrow(/4 МиБ/u);
    expect(readFullText).not.toHaveBeenCalled();
  });

  it("applies the encoded-fragment limit to reserved rich plain text", async () => {
    const fragment = new Blob(
      [encodeBoardClipboardText(Uint8Array.of(1, 2, 3))],
      { type: "text/plain" },
    );
    Object.defineProperty(fragment, "size", {
      configurable: true,
      value: MAX_BOARD_CLIPBOARD_FRAGMENT_TEXT_BYTES + 1,
    });
    const readFullText = vi.spyOn(fragment, "text");
    const clipboard = new BoardClipboard({
      read: vi.fn().mockResolvedValue([
        systemItem({ "text/plain": fragment }),
      ]),
    });

    await expect(clipboard.read()).rejects.toThrow(/per-operation limit/u);
    expect(readFullText).not.toHaveBeenCalled();
  });

  it("does not materialize oversized ordinary rich text when an image wins", async () => {
    const plain = new Blob(["ordinary text"], { type: "text/plain" });
    Object.defineProperty(plain, "size", {
      configurable: true,
      value: MAX_BOARD_CLIPBOARD_TEXT_BYTES + 1,
    });
    const readFullText = vi.spyOn(plain, "text");
    const image = new Blob([Uint8Array.of(1, 2)], { type: "image/png" });
    const clipboard = new BoardClipboard({
      read: vi.fn().mockResolvedValue([
        systemItem({
          "text/plain": plain,
          "image/png": image,
        }),
      ]),
    });

    await expect(clipboard.read()).resolves.toEqual({
      kind: "image",
      blob: image,
      mimeType: "image/png",
      fileName: null,
    });
    expect(readFullText).not.toHaveBeenCalled();
  });

  it("prioritizes the first supported image over ordinary event text", () => {
    const image = new Blob([Uint8Array.of(1, 2)], { type: "image/png" });
    const transfer = new MemoryDataTransfer({
      items: [{
        kind: "file",
        type: "image/png",
        getAsFile: () => image,
      }],
    });
    transfer.setData("text/plain", "screenshot fallback");

    expect(new BoardClipboard(null).readFromDataTransfer(transfer))
      .toEqual({
        kind: "image",
        blob: image,
        mimeType: "image/png",
        fileName: null,
      });
  });

  it("accepts an image item whose MIME is available only from its blob", () => {
    const image = new Blob([Uint8Array.of(1, 2)], { type: "image/png" });
    const transfer = new MemoryDataTransfer({
      items: [{
        kind: "file",
        type: "",
        getAsFile: () => image,
      }],
    });

    expect(new BoardClipboard(null).readFromDataTransfer(transfer))
      .toEqual({
        kind: "image",
        blob: image,
        mimeType: "image/png",
        fileName: null,
      });
  });

  it("fails closed for a claimed but invalid custom fragment", () => {
    const transfer = new MemoryDataTransfer({
      files: [new Blob([Uint8Array.of(1)], { type: "image/png" })],
    });
    transfer.setData(BOARD_FRAGMENT_CLIPBOARD_MIME, "not a fragment");
    transfer.setData("text/plain", "ordinary text");

    expect(() => new BoardClipboard(null).readFromDataTransfer(transfer))
      .toThrow(/custom MIME/u);
  });

  it("fails closed when a claimed custom fragment cannot be read", () => {
    const transfer = new MemoryDataTransfer({
      files: [new Blob([Uint8Array.of(1)], { type: "image/png" })],
    });
    transfer.setData(BOARD_FRAGMENT_CLIPBOARD_MIME, "claimed fragment");
    transfer.setData("text/plain", "ordinary text");
    vi.spyOn(transfer, "getData").mockImplementation((type) => {
      if (type === BOARD_FRAGMENT_CLIPBOARD_MIME) {
        throw new Error("blocked");
      }
      return transfer.values.get(type) ?? "";
    });

    expect(() => new BoardClipboard(null).readFromDataTransfer(transfer))
      .toThrow(/could not be read/u);
  });

  it("fails closed for unsupported reserved Eduri text in native events", () => {
    const transfer = new MemoryDataTransfer({
      files: [new Blob([Uint8Array.of(1)], { type: "image/png" })],
    });
    transfer.setData("text/plain", "EDURI_BOARD_FRAGMENT_V2:AAAA");

    expect(() => new BoardClipboard(null).readFromDataTransfer(transfer))
      .toThrow(/version is unsupported/u);
  });

  it("fails closed for unsupported reserved Eduri text in rich reads", async () => {
    const clipboard = new BoardClipboard({
      read: vi.fn().mockResolvedValue([
        systemItem({
          "text/plain": "EDURI_BOARD_FRAGMENT_V2:AAAA",
          "image/png": new Blob([Uint8Array.of(1)], { type: "image/png" }),
        }),
      ]),
    });

    await expect(clipboard.read()).rejects.toThrow(/version is unsupported/u);
  });

  it("fails closed for unsupported reserved Eduri text in readText", async () => {
    const clipboard = new BoardClipboard({
      readText: vi.fn().mockResolvedValue(
        "EDURI_BOARD_FRAGMENT_V2:AAAA",
      ),
    });

    await expect(clipboard.read()).rejects.toThrow(/version is unsupported/u);
  });

  it("uses the first non-empty plain text item from a rich read", async () => {
    const clipboard = new BoardClipboard({
      read: vi.fn().mockResolvedValue([
        systemItem({ "text/plain": "" }),
        systemItem({ "text/plain": "second item" }),
      ]),
    });

    await expect(clipboard.read()).resolves.toEqual({
      kind: "text",
      text: "second item",
    });
  });

  it("does not use same-tab memory when a native event has no clipboard snapshot", () => {
    const clipboard = new BoardClipboard(null);
    clipboard.remember(Uint8Array.of(1, 2, 3));

    expect(clipboard.readFromDataTransfer(null)).toBeNull();
  });

  it("preserves whitespace text and rejects one oversized text operation", () => {
    const whitespace = new MemoryDataTransfer();
    whitespace.setData("text/plain", " \n ");
    expect(new BoardClipboard(null).readFromDataTransfer(whitespace))
      .toEqual({ kind: "text", text: " \n " });

    const oversized = new MemoryDataTransfer();
    oversized.setData(
      "text/plain",
      "a".repeat(MAX_BOARD_CLIPBOARD_TEXT_BYTES + 1),
    );
    expect(() => new BoardClipboard(null).readFromDataTransfer(oversized))
      .toThrow(/4 МиБ/u);
  });

  it("keeps the supported clipboard image MIME policy explicit", () => {
    expect(BOARD_CLIPBOARD_IMAGE_MIME_TYPES).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ]);
  });
});
