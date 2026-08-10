import { describe, expect, it } from "vitest";
import {
  advanceEraserTrailSamples,
  createEraserTrailAnimationState,
  ERASER_TRAIL_HEAD_MAX_DIAMETER_PX,
  ERASER_TRAIL_HEAD_MIN_DIAMETER_PX,
  ERASER_TRAIL_MAX_BUFFER_SAMPLES,
  ERASER_TRAIL_MAX_RENDER_STATIONS,
  ERASER_TRAIL_MAX_SAMPLES,
  ERASER_TRAIL_OPACITY,
  ERASER_TRAIL_RETRACTION_MAX_SPEED_PX_PER_MS,
  ERASER_TRAIL_RENDER_STEP_PX,
  ERASER_TRAIL_TAIL_DIAMETER_FACTOR,
  appendEraserTrailSample,
  buildEraserTrailProfile,
  eraserTrailRetractionDistance,
  trimEraserTrailSamples,
  type EraserTrailRenderStation,
  type EraserTrailSample,
} from "./eraserTrail";

function sample(
  x: number,
  y: number,
  at: number,
  smoothedSpeed = 0,
): EraserTrailSample {
  return { x, y, at, smoothedSpeed };
}

function trailLength(samples: readonly EraserTrailSample[]): number {
  let length = 0;
  for (let index = 1; index < samples.length; index += 1) {
    length += Math.hypot(
      samples[index].x - samples[index - 1].x,
      samples[index].y - samples[index - 1].y,
    );
  }
  return length;
}

function stationSpacing(
  first: EraserTrailRenderStation,
  second: EraserTrailRenderStation,
): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

describe("eraser trail model", () => {
  it("tracks subpixel head motion and drops only the oldest input prefix", () => {
    const samples: EraserTrailSample[] = [];
    expect(appendEraserTrailSample(samples, { x: 0, y: 0 }, 0)).toBe(true);
    expect(appendEraserTrailSample(
      samples,
      { x: 0.25, y: 0 },
      1,
    )).toBe(true);
    expect(samples.at(-1)?.x).toBe(0.25);
    expect(appendEraserTrailSample(
      samples,
      { x: 0.25, y: 0 },
      2,
    )).toBe(true);
    expect(samples).toHaveLength(2);
    expect(samples.at(-1)?.at).toBe(2);

    for (let index = 2; index < 1_000; index += 1) {
      appendEraserTrailSample(samples, { x: index * 2, y: 0 }, index + 1);
    }
    expect(samples.length).toBeLessThanOrEqual(ERASER_TRAIL_MAX_BUFFER_SAMPLES);
    expect(samples.at(-1)?.x).toBe(1_998);
    const recent = samples.slice(-50);
    expect(recent.slice(1).every((entry, index) =>
      entry.x - recent[index].x === 2)).toBe(true);
  });

  it("compacts oversized history without dropping either endpoint", () => {
    const samples = Array.from(
      { length: ERASER_TRAIL_MAX_BUFFER_SAMPLES + 50 },
      (_, index) => sample(index, 0, index),
    );

    trimEraserTrailSamples(samples);
    expect(samples).toHaveLength(ERASER_TRAIL_MAX_SAMPLES);
    expect(samples[0]).toMatchObject({ x: 0, y: 0 });
    expect(samples.at(-1)).toMatchObject({
      x: ERASER_TRAIL_MAX_BUFFER_SAMPLES + 49,
      y: 0,
    });
    expect(trailLength(samples)).toBeCloseTo(
      ERASER_TRAIL_MAX_BUFFER_SAMPLES + 49,
    );
  });

  it("starts retracting on the first idle frame with length-sensitive speed", () => {
    const samples = [sample(0, 0, 0), sample(100, 0, 100, 1)];
    const animationState = createEraserTrailAnimationState(100);

    advanceEraserTrailSamples(samples, animationState, 100);
    advanceEraserTrailSamples(samples, animationState, 116);
    const frameRetraction = eraserTrailRetractionDistance(100, 16);
    expect(samples[0].x).toBeCloseTo(frameRetraction);
    expect(trailLength(samples)).toBeCloseTo(100 - frameRetraction);

    const firstStepEnd = samples[0].x;
    advanceEraserTrailSamples(samples, animationState, 132);
    const lengthAfterTwoFrames = 100 - eraserTrailRetractionDistance(100, 32);
    expect(samples[0].x - firstStepEnd).toBeCloseTo(
      100 - frameRetraction - lengthAfterTwoFrames,
    );
    expect(trailLength(samples)).toBeCloseTo(lengthAfterTwoFrames);

    advanceEraserTrailSamples(samples, animationState, 180);
    expect(trailLength(samples)).toBeCloseTo(
      100 - eraserTrailRetractionDistance(100, 80),
    );
    expect(buildEraserTrailProfile(samples, 180).hasTransientTail).toBe(true);
    expect(samples.at(-1)).toMatchObject({ x: 100, y: 0 });

    advanceEraserTrailSamples(samples, animationState, 1_500);
    expect(samples).toEqual([sample(100, 0, 100, 1)]);
    const settled = buildEraserTrailProfile(samples, 1_500);
    expect(settled.hasTransientTail).toBe(false);
    expect(settled.head?.point).toEqual({ x: 100, y: 0 });
    expect(settled.needsAnimation).toBe(false);
  });

  it("does not let stationary pointer samples postpone retraction", () => {
    const samples: EraserTrailSample[] = [];
    const animationState = createEraserTrailAnimationState(0);
    appendEraserTrailSample(samples, { x: 0, y: 0 }, 0, animationState);
    appendEraserTrailSample(samples, { x: 100, y: 0 }, 100, animationState);
    advanceEraserTrailSamples(samples, animationState, 100);
    appendEraserTrailSample(samples, { x: 100, y: 0 }, 200, animationState);

    advanceEraserTrailSamples(samples, animationState, 200);
    expect(trailLength(samples)).toBeCloseTo(
      100 - eraserTrailRetractionDistance(100, 100),
    );
    expect(samples.at(-1)).toMatchObject({ x: 100, y: 0, at: 200 });
  });

  it("retracts faster when the trail is longer up to the configured maximum speed", () => {
    const shortDistance = eraserTrailRetractionDistance(40, 16);
    const longDistance = eraserTrailRetractionDistance(200, 16);
    const veryLongDistance = eraserTrailRetractionDistance(2_000, 16);

    expect(longDistance).toBeGreaterThan(shortDistance);
    expect(veryLongDistance).toBeGreaterThan(longDistance);
    expect(veryLongDistance).toBeCloseTo(
      ERASER_TRAIL_RETRACTION_MAX_SPEED_PX_PER_MS * 16,
    );
  });

  it("retracts by elapsed time independent of display refresh rate", () => {
    const remainingLengthAt = (refreshRate: number): number => {
      const samples = [sample(0, 0, 0), sample(140, 0, 100, 1)];
      const animationState = createEraserTrailAnimationState(100);
      const finishedAt = 200;
      const frameDuration = 1_000 / refreshRate;
      advanceEraserTrailSamples(samples, animationState, 100);
      for (
        let frameAt = 100 + frameDuration;
        frameAt < finishedAt;
        frameAt += frameDuration
      ) {
        advanceEraserTrailSamples(samples, animationState, frameAt);
      }
      advanceEraserTrailSamples(samples, animationState, finishedAt);
      expect(samples.at(-1)).toMatchObject({ x: 140, y: 0 });
      return trailLength(samples);
    };

    const lengths = [60, 120, 144].map(remainingLengthAt);
    const expectedLength = 140
      - eraserTrailRetractionDistance(140, 100);
    lengths.forEach((length) => expect(length).toBeCloseTo(expectedLength, 8));
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(1e-8);
  });

  it("builds a bounded, densely sampled, continuously tapered profile", () => {
    const samples = Array.from(
      { length: 21 },
      (_, index) => sample(index * 10, 0, index * 10, 0),
    );
    trimEraserTrailSamples(samples);
    const profile = buildEraserTrailProfile(samples, 200);

    expect(profile.pathLength).toBeCloseTo(200);
    expect(profile.stations).toHaveLength(201);
    expect(profile.opacity).toBe(ERASER_TRAIL_OPACITY);
    expect(profile.stations[0]).toMatchObject({ x: 0, y: 0 });
    expect(profile.stations.at(-1)).toMatchObject({ x: 200, y: 0 });
    expect(profile.stations[0].diameter).toBeCloseTo(
      ERASER_TRAIL_HEAD_MAX_DIAMETER_PX * ERASER_TRAIL_TAIL_DIAMETER_FACTOR,
    );
    expect(profile.stations.at(-1)?.diameter)
      .toBe(ERASER_TRAIL_HEAD_MAX_DIAMETER_PX);

    let largestDiameterStep = 0;
    for (let index = 1; index < profile.stations.length; index += 1) {
      const previous = profile.stations[index - 1];
      const current = profile.stations[index];
      expect(stationSpacing(previous, current))
        .toBeLessThanOrEqual(ERASER_TRAIL_RENDER_STEP_PX + 1e-9);
      expect(current.diameter).toBeGreaterThanOrEqual(previous.diameter);
      largestDiameterStep = Math.max(
        largestDiameterStep,
        current.diameter - previous.diameter,
      );
    }
    expect(largestDiameterStep).toBeLessThan(0.1);
    expect(profile.head?.diameter).toBe(ERASER_TRAIL_HEAD_MAX_DIAMETER_PX);

    const longProfile = buildEraserTrailProfile([
      sample(0, 0, 0),
      sample(1_000, 0, 1_000),
    ], 1_000);
    expect(longProfile.pathLength).toBe(1_000);
    expect(longProfile.stations).toHaveLength(ERASER_TRAIL_MAX_RENDER_STATIONS);
    expect(stationSpacing(longProfile.stations[0], longProfile.stations[1]))
      .toBeGreaterThan(ERASER_TRAIL_RENDER_STEP_PX);
  });

  it("densely covers a sharp corner independent of source sample density", () => {
    const sparse = [
      sample(0, 0, 0),
      sample(30, 0, 30),
      sample(30, 40, 70),
    ];
    const dense = [
      ...Array.from(
        { length: 31 },
        (_, index) => sample(index, 0, index),
      ),
      ...Array.from(
        { length: 40 },
        (_, index) => sample(30, index + 1, 31 + index),
      ),
    ];
    const sparseProfile = buildEraserTrailProfile(sparse, 70);
    const denseProfile = buildEraserTrailProfile(dense, 70);

    expect(sparseProfile.pathLength).toBeCloseTo(70);
    expect(sparseProfile.stations).toHaveLength(71);
    expect(sparseProfile.stations).toEqual(denseProfile.stations);
    expect(sparseProfile.stations[29]).toMatchObject({ x: 29, y: 0 });
    expect(sparseProfile.stations[30]).toMatchObject({ x: 30, y: 0 });
    expect(sparseProfile.stations[31]).toMatchObject({ x: 30, y: 1 });
    for (let index = 1; index < sparseProfile.stations.length; index += 1) {
      const previous = sparseProfile.stations[index - 1];
      const current = sparseProfile.stations[index];
      const spacing = stationSpacing(previous, current);
      expect(spacing).toBeLessThanOrEqual(ERASER_TRAIL_RENDER_STEP_PX + 1e-9);
      expect(spacing).toBeLessThan(Math.min(previous.diameter, current.diameter) / 2);
    }
    expect(sparseProfile.opacity).toBe(ERASER_TRAIL_OPACITY);
  });

  it("keeps a full reversal densely overlapped without a geometric spike", () => {
    const profile = buildEraserTrailProfile([
      sample(0, 0, 0),
      sample(24, 0, 24),
      sample(0, 0, 48),
    ], 48);

    expect(profile.pathLength).toBeCloseTo(48);
    expect(profile.stations).toHaveLength(49);
    expect(profile.stations[23]).toMatchObject({ x: 23, y: 0 });
    expect(profile.stations[24]).toMatchObject({ x: 24, y: 0 });
    expect(profile.stations[25]).toMatchObject({ x: 23, y: 0 });
    for (let index = 1; index < profile.stations.length; index += 1) {
      const previous = profile.stations[index - 1];
      const current = profile.stations[index];
      const spacing = stationSpacing(previous, current);
      expect(spacing).toBeLessThanOrEqual(ERASER_TRAIL_RENDER_STEP_PX + 1e-9);
      expect(spacing).toBeLessThan(Math.min(previous.diameter, current.diameter) / 2);
    }
    expect(Math.abs(
      profile.stations[25].diameter - profile.stations[24].diameter,
    )).toBeLessThan(0.25);
    expect(profile.opacity).toBe(ERASER_TRAIL_OPACITY);
  });

  it("makes fast movement thinner, clamps it, and relaxes after stopping", () => {
    const slow = buildEraserTrailProfile([sample(0, 0, 100, 0)], 100);
    const fastSamples = [sample(0, 0, 100, 1_000_000)];
    trimEraserTrailSamples(fastSamples);
    const fast = buildEraserTrailProfile(fastSamples, 100);
    const relaxed = buildEraserTrailProfile(fastSamples, 500);

    expect(slow.head?.diameter).toBe(ERASER_TRAIL_HEAD_MAX_DIAMETER_PX);
    expect(fast.head?.diameter).toBe(ERASER_TRAIL_HEAD_MIN_DIAMETER_PX);
    expect(relaxed.head?.diameter).toBeGreaterThan(fast.head!.diameter);
    expect(relaxed.head?.diameter).toBeLessThanOrEqual(
      ERASER_TRAIL_HEAD_MAX_DIAMETER_PX,
    );
    expect(relaxed.needsAnimation).toBe(false);

    const mixedSpeed = [
      sample(0, 0, 0, 0),
      sample(70, 0, 50, 0),
      sample(140, 0, 100, 2),
    ];
    const movingProfile = buildEraserTrailProfile(mixedSpeed, 100);
    const idleProfile = buildEraserTrailProfile(mixedSpeed, 200);
    expect(idleProfile.head!.diameter).toBeGreaterThan(
      movingProfile.head!.diameter,
    );
    expect(idleProfile.stations.slice(0, -1).map((station) => station.diameter))
      .toEqual(
        movingProfile.stations.slice(0, -1).map((station) => station.diameter),
      );
    expect(idleProfile.stations.at(-1)!.diameter).toBeGreaterThan(
      movingProfile.stations.at(-1)!.diameter,
    );
  });

  it("sanitizes timestamps and speeds without emitting non-finite profile data", () => {
    const samples: EraserTrailSample[] = [];
    expect(appendEraserTrailSample(samples, { x: 0, y: 0 }, Number.NaN)).toBe(true);
    expect(appendEraserTrailSample(samples, { x: 10, y: 0 }, Number.POSITIVE_INFINITY))
      .toBe(true);
    expect(appendEraserTrailSample(samples, { x: Number.NaN, y: 0 }, 1)).toBe(false);
    samples.unshift(sample(-10, 0, Number.NaN, Number.NaN));
    samples.push(sample(20, 0, -100, -5));

    trimEraserTrailSamples(samples);
    expect(samples.every((entry, index) => (
      Number.isFinite(entry.x)
      && Number.isFinite(entry.y)
      && Number.isFinite(entry.at)
      && Number.isFinite(entry.smoothedSpeed)
      && (index === 0 || entry.at >= samples[index - 1].at)
    ))).toBe(true);

    const profile = buildEraserTrailProfile(samples, Number.NaN);
    const values = profile.stations.flatMap((station) => [
      station.x,
      station.y,
      station.diameter,
    ]);
    values.push(profile.opacity);
    if (profile.head) {
      values.push(
        profile.head.point.x,
        profile.head.point.y,
        profile.head.diameter,
      );
    }
    expect(values.every(Number.isFinite)).toBe(true);
  });
});
