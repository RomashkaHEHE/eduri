import { describe, expect, it } from "vitest";
import { inspectEncodedImage } from "./assetsImage.js";

describe("inspectEncodedImage", () => {
  it("detects supported formats from bytes rather than file names or declarations", () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);

    const jpeg = Buffer.alloc(21);
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]).copy(jpeg);
    jpeg.writeUInt16BE(200, 7);
    jpeg.writeUInt16BE(300, 9);

    const gif = Buffer.alloc(10);
    gif.write("GIF89a", 0, "ascii");
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(240, 8);

    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBP", 8, "ascii");
    webp.write("VP8X", 12, "ascii");
    webp[24] = 0xff;
    webp[25] = 0x01;
    webp[27] = 0xff;

    expect(inspectEncodedImage(png)).toEqual({ mimeType: "image/png", width: 640, height: 480 });
    expect(inspectEncodedImage(jpeg)).toEqual({ mimeType: "image/jpeg", width: 300, height: 200 });
    expect(inspectEncodedImage(gif)).toEqual({ mimeType: "image/gif", width: 320, height: 240 });
    expect(inspectEncodedImage(webp)).toEqual({ mimeType: "image/webp", width: 512, height: 256 });
  });

  it("rejects active SVG and malformed or unknown input explicitly", () => {
    expect(() => inspectEncodedImage(new TextEncoder().encode(
      "<?xml version='1.0'?><svg xmlns='http://www.w3.org/2000/svg'></svg>",
    ))).toThrowError(expect.objectContaining({ code: "SVG_REJECTED" }));
    expect(() => inspectEncodedImage(Uint8Array.of(0xff, 0xd8, 0xff)))
      .toThrowError(expect.objectContaining({ code: "MALFORMED_IMAGE" }));
    expect(() => inspectEncodedImage(new TextEncoder().encode("not an image")))
      .toThrowError(expect.objectContaining({ code: "UNSUPPORTED_MEDIA_TYPE" }));
  });
});
