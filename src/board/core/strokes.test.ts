import { describe, expect, it } from "vitest";
import { decodeStrokePoints, encodeStrokePoints, strokeBounds } from "./strokes";

describe("Board v2 stroke encoding", () => {
  it("round-trips delta-coded coordinates and pressure", () => {
    const encoded = encodeStrokePoints([
      { x: -12.25, y: 8.5, pressure: 0.25 },
      { x: -11.75, y: 9.125, pressure: 0.8 },
      { x: 2_000.125, y: -900.5, pressure: 1 },
    ]);

    expect(decodeStrokePoints(encoded)).toEqual([
      { x: -12.25, y: 8.5, pressure: 64 / 255 },
      { x: -11.75, y: 9.125, pressure: 204 / 255 },
      { x: 2_000.125, y: -900.5, pressure: 1 },
    ]);
    expect(encoded.byteLength).toBeLessThan(40);
  });

  it("rejects truncated, trailing, and unsupported data", () => {
    const encoded = encodeStrokePoints([{ x: 0, y: 0, pressure: 0.5 }]);
    expect(() => decodeStrokePoints(encoded.slice(0, -1))).toThrow("Truncated");
    expect(() => decodeStrokePoints(Uint8Array.from([...encoded, 0]))).toThrow("Trailing");
    expect(() => decodeStrokePoints(Uint8Array.from([99, 1, 0, 0, 0]))).toThrow(
      "Unsupported stroke format",
    );
  });

  it("calculates stable logical bounds", () => {
    expect(strokeBounds([
      { x: 7, y: -2, pressure: 0.5 },
      { x: -3, y: 9, pressure: 0.5 },
    ])).toEqual({ x: -3, y: -2, width: 10, height: 11 });
  });
});
