const STROKE_FORMAT_VERSION = 1;
const COORDINATE_SCALE = 64;
const MAX_STROKE_POINTS = 1_000_000;

export interface StrokePoint {
  readonly x: number;
  readonly y: number;
  readonly pressure: number;
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
}

function quantizeCoordinate(value: number, label: string): number {
  assertFinite(value, label);
  const quantized = Math.round(value * COORDINATE_SCALE);
  // Keeping absolute coordinates inside 30 signed bits also keeps any
  // consecutive delta inside the 32-bit ZigZag range.
  if (!Number.isSafeInteger(quantized) || quantized < -0x3fff_ffff || quantized > 0x3fff_ffff) {
    throw new RangeError(`${label} is outside the supported board coordinate range`);
  }
  return quantized;
}

function quantizePressure(value: number): number {
  assertFinite(value, "pressure");
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

function zigZagEncode(value: number): number {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

function zigZagDecode(value: number): number {
  return (value >>> 1) ^ -(value & 1);
}

function pushVarUint(target: number[], value: number): void {
  let remaining = value >>> 0;
  do {
    const continuation = remaining > 0x7f;
    target.push((remaining & 0x7f) | (continuation ? 0x80 : 0));
    remaining >>>= 7;
  } while (remaining > 0);
}

function readVarUint(bytes: Uint8Array, cursor: { value: number }): number {
  let value = 0;
  let shift = 0;
  for (let index = 0; index < 5; index += 1) {
    if (cursor.value >= bytes.byteLength) throw new Error("Truncated stroke data");
    const byte = bytes[cursor.value++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value >>> 0;
    shift += 7;
  }
  throw new Error("Invalid stroke varint");
}

export function encodeStrokePoints(points: readonly StrokePoint[]): Uint8Array {
  if (points.length === 0) throw new TypeError("A stroke must contain at least one point");
  if (points.length > MAX_STROKE_POINTS) {
    throw new RangeError(`A stroke cannot contain more than ${MAX_STROKE_POINTS} points`);
  }

  const output: number[] = [STROKE_FORMAT_VERSION];
  pushVarUint(output, points.length);
  let previousX = 0;
  let previousY = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const x = quantizeCoordinate(point.x, `points[${index}].x`);
    const y = quantizeCoordinate(point.y, `points[${index}].y`);
    pushVarUint(output, zigZagEncode(x - previousX));
    pushVarUint(output, zigZagEncode(y - previousY));
    output.push(quantizePressure(point.pressure));
    previousX = x;
    previousY = y;
  }
  return Uint8Array.from(output);
}

export function decodeStrokePoints(bytes: Uint8Array): StrokePoint[] {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2) {
    throw new Error("Invalid stroke data");
  }
  const cursor = { value: 0 };
  const version = bytes[cursor.value++];
  if (version !== STROKE_FORMAT_VERSION) {
    throw new Error(`Unsupported stroke format version ${version}`);
  }
  const pointCount = readVarUint(bytes, cursor);
  if (pointCount === 0 || pointCount > MAX_STROKE_POINTS) {
    throw new Error("Invalid stroke point count");
  }

  const points: StrokePoint[] = [];
  let x = 0;
  let y = 0;
  for (let index = 0; index < pointCount; index += 1) {
    x += zigZagDecode(readVarUint(bytes, cursor));
    y += zigZagDecode(readVarUint(bytes, cursor));
    if (cursor.value >= bytes.byteLength) throw new Error("Truncated stroke pressure");
    points.push({
      x: x / COORDINATE_SCALE,
      y: y / COORDINATE_SCALE,
      pressure: bytes[cursor.value++] / 255,
    });
  }
  if (cursor.value !== bytes.byteLength) throw new Error("Trailing stroke data");
  return points;
}

export function strokeBounds(points: readonly StrokePoint[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (points.length === 0) throw new TypeError("A stroke must contain at least one point");
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    assertFinite(point.x, "point.x");
    assertFinite(point.y, "point.y");
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(1 / COORDINATE_SCALE, maxX - minX),
    height: Math.max(1 / COORDINATE_SCALE, maxY - minY),
  };
}
