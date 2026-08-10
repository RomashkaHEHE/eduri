import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AssetDecodeRequest,
  BoardAssetLimits,
} from "./assets.js";
import { decodeBoardAssetWithSharp } from "./assetsDecode.js";
import type { SupportedBoardAssetMime } from "./assetsImage.js";

const LIMITS: AssetDecodeRequest["limits"] = {
  maxWidth: 1_000,
  maxHeight: 1_000,
  maxPixelsPerFrame: 1_000_000,
  maxFrameCount: 20,
  maxTotalDecodedPixels: 10_000_000,
  decodeTimeoutSeconds: 30,
};

type DecodeLimits = Pick<
  BoardAssetLimits,
  "maxWidth" | "maxHeight" | "maxPixelsPerFrame" | "maxFrameCount" | "maxTotalDecodedPixels" | "decodeTimeoutSeconds"
>;

function request(
  filePath: string,
  mimeType: SupportedBoardAssetMime,
  encodedWidth: number,
  encodedHeight: number,
  limits: Partial<DecodeLimits> = {},
): AssetDecodeRequest {
  return {
    filePath,
    mimeType,
    encodedWidth,
    encodedHeight,
    limits: { ...LIMITS, ...limits },
  };
}

async function animatedGif(
  filePath: string,
  width: number,
  height: number,
  frameCount: number,
): Promise<void> {
  const colors = ["#d02020", "#2080d0", "#20a050", "#c09020"];
  const frames = await Promise.all(
    Array.from({ length: frameCount }, (_, index) => (
      sharp({
        create: {
          width,
          height,
          channels: 4,
          background: colors[index % colors.length],
        },
      }).png().toBuffer()
    )),
  );
  await sharp(frames, { join: { animated: true } })
    .gif({
      delay: Array.from({ length: frameCount }, () => 100),
      loop: 0,
    })
    .toFile(filePath);
}

describe("decodeBoardAssetWithSharp", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-asset-decode-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it.each([
    {
      label: "PNG",
      mimeType: "image/png" as const,
      write: (filePath: string) => sharp({
        create: {
          width: 7,
          height: 5,
          channels: 4,
          background: { r: 12, g: 34, b: 56, alpha: 0.5 },
        },
      }).png().toFile(filePath),
    },
    {
      label: "JPEG",
      mimeType: "image/jpeg" as const,
      write: (filePath: string) => sharp({
        create: {
          width: 7,
          height: 5,
          channels: 3,
          background: "#123456",
        },
      }).jpeg().toFile(filePath),
    },
    {
      label: "WebP",
      mimeType: "image/webp" as const,
      write: (filePath: string) => sharp({
        create: {
          width: 7,
          height: 5,
          channels: 4,
          background: "#123456",
        },
      }).webp().toFile(filePath),
    },
  ])("fully decodes a static $label", async ({ mimeType, write }) => {
    const filePath = path.join(dataDir, "static-image");
    await write(filePath);

    await expect(
      decodeBoardAssetWithSharp(request(filePath, mimeType, 7, 5)),
    ).resolves.toEqual({
      fullyDecoded: true,
      width: 7,
      height: 5,
      frameCount: 1,
      totalDecodedPixels: 35,
    });
  });

  it("fully decodes and counts every animated GIF frame", async () => {
    const filePath = path.join(dataDir, "animated.gif");
    await animatedGif(filePath, 3, 2, 3);

    await expect(
      decodeBoardAssetWithSharp(request(filePath, "image/gif", 3, 2)),
    ).resolves.toEqual({
      fullyDecoded: true,
      width: 3,
      height: 2,
      frameCount: 3,
      totalDecodedPixels: 18,
    });
  });

  it("rejects a truncated image whose metadata remains readable", async () => {
    const complete = await sharp({
      create: {
        width: 32,
        height: 24,
        channels: 4,
        background: { r: 10, g: 20, b: 30, alpha: 0.5 },
      },
    }).png().toBuffer();
    const truncated = complete.subarray(0, complete.byteLength - 20);
    const filePath = path.join(dataDir, "truncated.png");
    fs.writeFileSync(filePath, truncated);

    await expect(sharp(filePath).metadata()).resolves.toMatchObject({
      width: 32,
      height: 24,
    });
    await expect(
      decodeBoardAssetWithSharp(request(filePath, "image/png", 32, 24)),
    ).rejects.toThrow(/pixels could not be fully decoded/i);
  });

  it("enforces frame-count and total-decoded-pixel limits", async () => {
    const filePath = path.join(dataDir, "limited.gif");
    await animatedGif(filePath, 3, 2, 2);

    await expect(
      decodeBoardAssetWithSharp(request(filePath, "image/gif", 3, 2, {
        maxFrameCount: 1,
      })),
    ).rejects.toThrow(/frame count limit/i);
    await expect(
      decodeBoardAssetWithSharp(request(filePath, "image/gif", 3, 2, {
        maxTotalDecodedPixels: 11,
      })),
    ).rejects.toThrow(/pixel limit/i);
  });

  it("enforces per-frame dimension and pixel limits", async () => {
    const filePath = path.join(dataDir, "large-frame.png");
    await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 3,
        background: "#456789",
      },
    }).png().toFile(filePath);

    await expect(
      decodeBoardAssetWithSharp(request(filePath, "image/png", 8, 6, {
        maxWidth: 7,
      })),
    ).rejects.toThrow(/per-frame/i);
    await expect(
      decodeBoardAssetWithSharp(request(filePath, "image/png", 8, 6, {
        maxPixelsPerFrame: 47,
      })),
    ).rejects.toThrow(/per-frame/i);
  });

  it("rejects source format and encoded-dimension mismatches", async () => {
    const filePath = path.join(dataDir, "mismatch.png");
    await sharp({
      create: {
        width: 4,
        height: 3,
        channels: 3,
        background: "#abcdef",
      },
    }).png().toFile(filePath);

    await expect(
      decodeBoardAssetWithSharp(request(filePath, "image/jpeg", 4, 3)),
    ).rejects.toThrow(/expected jpeg input/i);
    await expect(
      decodeBoardAssetWithSharp(request(filePath, "image/png", 5, 3)),
    ).rejects.toThrow(/dimensions differ/i);
  });
});
