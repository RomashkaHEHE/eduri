export const ERASER_TRAIL_RETRACTION_BASE_SPEED_PX_PER_MS = 0.0;
export const ERASER_TRAIL_RETRACTION_LENGTH_GAIN_PER_MS_PER_PX = 0.015;
export const ERASER_TRAIL_RETRACTION_MAX_SPEED_PX_PER_MS = 3;
export const ERASER_TRAIL_MAX_SAMPLES = 256;
export const ERASER_TRAIL_MAX_BUFFER_SAMPLES = ERASER_TRAIL_MAX_SAMPLES * 2;
export const ERASER_TRAIL_RENDER_STEP_PX = 1;
export const ERASER_TRAIL_MAX_RENDER_STATIONS = 256;
export const ERASER_TRAIL_SPEED_EMA_MS = 35;
export const ERASER_TRAIL_HEAD_MAX_DIAMETER_PX = 15;
export const ERASER_TRAIL_HEAD_MIN_DIAMETER_PX = 9;
export const ERASER_TRAIL_TAIL_DIAMETER_FACTOR = 0.55;
export const ERASER_TRAIL_OPACITY = 0.2;

const ERASER_TRAIL_FAST_SPEED_PX_PER_MS = 2;
const ERASER_TRAIL_MAX_TRACKED_SPEED_PX_PER_MS = 64;
const ERASER_TRAIL_SETTLED_SPEED_PX_PER_MS = 0.01;
const GEOMETRY_EPSILON = 1e-6;

export interface EraserTrailPoint {
  readonly x: number;
  readonly y: number;
}

export interface EraserTrailSample extends EraserTrailPoint {
  readonly at: number;
  readonly smoothedSpeed: number;
}

export interface EraserTrailAnimationState {
  previousFrameAt: number;
}

export interface EraserTrailRenderStation extends EraserTrailPoint {
  readonly diameter: number;
}

export interface EraserTrailHead {
  readonly point: EraserTrailPoint;
  readonly diameter: number;
}

export interface EraserTrailProfile {
  readonly stations: readonly EraserTrailRenderStation[];
  readonly opacity: number;
  readonly head: EraserTrailHead | null;
  readonly pathLength: number;
  readonly hasTransientTail: boolean;
  readonly needsAnimation: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function distance(first: EraserTrailPoint, second: EraserTrailPoint): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

export function createEraserTrailAnimationState(
  at: number,
): EraserTrailAnimationState {
  const timestamp = Number.isFinite(at) ? at : 0;
  return {
    previousFrameAt: timestamp,
  };
}

function resetEraserTrailFrameClock(
  state: EraserTrailAnimationState | undefined,
  at: number,
): void {
  if (!state) return;
  state.previousFrameAt = Number.isFinite(at) ? at : 0;
}

function interpolateSample(
  first: EraserTrailSample,
  second: EraserTrailSample,
  amount: number,
): EraserTrailSample {
  const boundedAmount = clamp(amount, 0, 1);
  return {
    x: first.x + (second.x - first.x) * boundedAmount,
    y: first.y + (second.y - first.y) * boundedAmount,
    at: first.at + (second.at - first.at) * boundedAmount,
    smoothedSpeed: first.smoothedSpeed
      + (second.smoothedSpeed - first.smoothedSpeed) * boundedAmount,
  };
}

function compactSamplesInPlace(
  samples: EraserTrailSample[],
  targetCount: number,
): void {
  if (samples.length <= targetCount) return;
  const sourceLength = samples.length;
  for (let targetIndex = 0; targetIndex < targetCount; targetIndex += 1) {
    const sourceIndex = Math.round(
      targetIndex * (sourceLength - 1) / (targetCount - 1),
    );
    samples[targetIndex] = samples[sourceIndex];
  }
  samples.length = targetCount;
}

/**
 * Adds one accepted pointer sample without allocating or replacing the buffer.
 * Age and path-length trimming is intentionally separate so callers can do it
 * once per animation frame instead of once per coalesced pointer sample.
 */
export function appendEraserTrailSample(
  samples: EraserTrailSample[],
  point: EraserTrailPoint,
  at: number,
  animationState?: EraserTrailAnimationState,
): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;

  const previous = samples.at(-1);
  const timestamp = Number.isFinite(at)
    ? Math.max(previous?.at ?? at, at)
    : previous?.at ?? 0;
  if (!previous) {
    samples.push({
      x: point.x,
      y: point.y,
      at: timestamp,
      smoothedSpeed: 0,
    });
    resetEraserTrailFrameClock(animationState, timestamp);
    return true;
  }

  const travelled = distance(previous, point);
  if (!Number.isFinite(travelled)) return false;
  const elapsed = timestamp - previous.at;
  let smoothedSpeed = previous.smoothedSpeed;
  if (elapsed > 0) {
    const instantaneousSpeed = clamp(
      travelled / elapsed,
      0,
      ERASER_TRAIL_MAX_TRACKED_SPEED_PX_PER_MS,
    );
    const blend = 1 - Math.exp(-elapsed / ERASER_TRAIL_SPEED_EMA_MS);
    smoothedSpeed += (instantaneousSpeed - smoothedSpeed) * blend;
  }
  smoothedSpeed = clamp(
    Number.isFinite(smoothedSpeed) ? smoothedSpeed : 0,
    0,
    ERASER_TRAIL_MAX_TRACKED_SPEED_PX_PER_MS,
  );

  if (travelled <= GEOMETRY_EPSILON) {
    const changed = timestamp !== previous.at;
    if (changed) {
      samples[samples.length - 1] = {
        x: point.x,
        y: point.y,
        at: timestamp,
        smoothedSpeed,
      };
    }
    return changed;
  }

  if (samples.length >= ERASER_TRAIL_MAX_BUFFER_SAMPLES) {
    compactSamplesInPlace(samples, ERASER_TRAIL_MAX_SAMPLES);
  }
  if (samples.length === 1) {
    resetEraserTrailFrameClock(animationState, timestamp);
  }
  samples.push({
    x: point.x,
    y: point.y,
    at: timestamp,
    smoothedSpeed,
  });
  return true;
}

function sanitizeSamplesInPlace(samples: EraserTrailSample[]): boolean {
  let changed = false;
  let writeIndex = 0;
  let previousAt = 0;
  for (let readIndex = 0; readIndex < samples.length; readIndex += 1) {
    const sample = samples[readIndex];
    if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y)) {
      changed = true;
      continue;
    }
    const at = Number.isFinite(sample.at)
      ? Math.max(writeIndex === 0 ? sample.at : previousAt, sample.at)
      : previousAt;
    const smoothedSpeed = clamp(
      Number.isFinite(sample.smoothedSpeed) ? sample.smoothedSpeed : 0,
      0,
      ERASER_TRAIL_MAX_TRACKED_SPEED_PX_PER_MS,
    );
    const sanitized = at === sample.at && smoothedSpeed === sample.smoothedSpeed
      ? sample
      : { x: sample.x, y: sample.y, at, smoothedSpeed };
    if (sanitized !== sample || writeIndex !== readIndex) changed = true;
    samples[writeIndex] = sanitized;
    previousAt = at;
    writeIndex += 1;
  }
  if (samples.length !== writeIndex) {
    samples.length = writeIndex;
    changed = true;
  }
  return changed;
}

function eraserTrailPathLength(samples: readonly EraserTrailSample[]): number {
  let pathLength = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const segmentLength = distance(samples[index - 1], samples[index]);
    if (Number.isFinite(segmentLength)) pathLength += segmentLength;
  }
  return pathLength;
}

/**
 * Integrates the capped v(length) = min(maxSpeed, baseSpeed + lengthGain *
 * length) exactly. This preserves the same result across display refresh rates
 * while making a longer trail catch up faster.
 */
export function eraserTrailRetractionDistance(
  pathLength: number,
  elapsedMs: number,
): number {
  const length = Number.isFinite(pathLength) ? Math.max(0, pathLength) : 0;
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  if (length <= GEOMETRY_EPSILON || elapsed <= 0) return 0;

  const baseSpeed = ERASER_TRAIL_RETRACTION_BASE_SPEED_PX_PER_MS;
  const lengthGain = ERASER_TRAIL_RETRACTION_LENGTH_GAIN_PER_MS_PER_PX;
  const maxSpeed = Math.max(baseSpeed, ERASER_TRAIL_RETRACTION_MAX_SPEED_PX_PER_MS);
  if (lengthGain <= GEOMETRY_EPSILON) {
    return Math.min(length, maxSpeed * elapsed);
  }

  const uncappedLength = Math.max(0, (maxSpeed - baseSpeed) / lengthGain);
  if (length > uncappedLength) {
    const timeToUncappedLength = (length - uncappedLength) / maxSpeed;
    if (elapsed <= timeToUncappedLength) {
      return Math.min(length, maxSpeed * elapsed);
    }

    const remainingElapsed = elapsed - timeToUncappedLength;
    const speedOffset = baseSpeed / lengthGain;
    const retainedLength = (uncappedLength + speedOffset)
      * Math.exp(-lengthGain * remainingElapsed) - speedOffset;
    return Math.min(length, Math.max(0, length - Math.max(0, retainedLength)));
  }

  const speedOffset = baseSpeed / lengthGain;
  const retainedLength = (length + speedOffset) * Math.exp(-lengthGain * elapsed)
    - speedOffset;
  return Math.min(length, Math.max(0, length - retainedLength));
}

function retractEraserTrailSamplesByLength(
  samples: EraserTrailSample[],
  retractedLength: number,
): boolean {
  if (samples.length < 2) return false;
  const boundedRetractedLength = Number.isFinite(retractedLength)
    ? Math.max(0, retractedLength)
    : 0;
  if (boundedRetractedLength <= GEOMETRY_EPSILON) return false;

  const currentLength = eraserTrailPathLength(samples);
  if (boundedRetractedLength + GEOMETRY_EPSILON >= currentLength) {
    const latest = samples[samples.length - 1];
    samples[0] = latest;
    samples.length = 1;
    return true;
  }

  let remainingRetraction = boundedRetractedLength;
  for (let index = 0; index < samples.length - 1; index += 1) {
    const segmentLength = distance(samples[index], samples[index + 1]);
    if (!Number.isFinite(segmentLength)) {
      samples.splice(index, 1);
      index -= 1;
      continue;
    }
    if (remainingRetraction >= segmentLength - GEOMETRY_EPSILON) {
      remainingRetraction -= segmentLength;
      continue;
    }

    const amountFromOlder = segmentLength <= GEOMETRY_EPSILON
      ? 1
      : remainingRetraction / segmentLength;
    const cutoff = interpolateSample(
      samples[index],
      samples[index + 1],
      amountFromOlder,
    );
    samples.splice(0, index + 1, cutoff);
    return true;
  }
  return false;
}

function compactEraserTrailSamples(samples: EraserTrailSample[]): boolean {
  if (samples.length <= ERASER_TRAIL_MAX_SAMPLES) return false;
  compactSamplesInPlace(samples, ERASER_TRAIL_MAX_SAMPLES);
  return true;
}

/**
 * Sanitizes and compacts pointer history without changing its two endpoints.
 */
export function trimEraserTrailSamples(
  samples: EraserTrailSample[],
): boolean {
  let changed = sanitizeSamplesInPlace(samples);
  if (samples.length === 0) return changed;

  return compactEraserTrailSamples(samples) || changed;
}

/** Advances length-sensitive retraction using elapsed animation-frame time. */
export function advanceEraserTrailSamples(
  samples: EraserTrailSample[],
  state: EraserTrailAnimationState,
  now: number,
): boolean {
  let changed = sanitizeSamplesInPlace(samples);
  if (samples.length === 0) return changed;

  const latest = samples[samples.length - 1];
  const previousFrameAt = Number.isFinite(state.previousFrameAt)
    ? state.previousFrameAt
    : latest.at;
  const effectiveNow = Number.isFinite(now)
    ? Math.max(now, previousFrameAt, latest.at)
    : Math.max(previousFrameAt, latest.at);
  state.previousFrameAt = effectiveNow;

  const elapsed = effectiveNow - previousFrameAt;
  if (elapsed > 0 && samples.length > 1) {
    changed = retractEraserTrailSamplesByLength(
      samples,
      eraserTrailRetractionDistance(eraserTrailPathLength(samples), elapsed),
    ) || changed;
  }

  return compactEraserTrailSamples(samples) || changed;
}

function effectiveHeadSpeed(sample: EraserTrailSample, now: number): number {
  const effectiveNow = Number.isFinite(now) ? Math.max(now, sample.at) : sample.at;
  const idleDuration = effectiveNow - sample.at;
  return clamp(
    sample.smoothedSpeed * Math.exp(-idleDuration / ERASER_TRAIL_SPEED_EMA_MS),
    0,
    ERASER_TRAIL_MAX_TRACKED_SPEED_PX_PER_MS,
  );
}

function diameterForSpeed(speed: number): number {
  const speedAmount = clamp(speed / ERASER_TRAIL_FAST_SPEED_PX_PER_MS, 0, 1);
  return ERASER_TRAIL_HEAD_MAX_DIAMETER_PX
    + (ERASER_TRAIL_HEAD_MIN_DIAMETER_PX
      - ERASER_TRAIL_HEAD_MAX_DIAMETER_PX) * speedAmount;
}

function sampleAtDistance(
  samples: readonly EraserTrailSample[],
  cumulativeLengths: readonly number[],
  targetDistance: number,
): EraserTrailSample {
  let segment = 0;
  while (
    segment + 1 < cumulativeLengths.length
    && cumulativeLengths[segment + 1] < targetDistance
  ) {
    segment += 1;
  }
  const first = samples[segment];
  const second = samples[Math.min(segment + 1, samples.length - 1)];
  const segmentLength = cumulativeLengths[Math.min(segment + 1, samples.length - 1)]
    - cumulativeLengths[segment];
  const amount = segmentLength <= GEOMETRY_EPSILON
    ? 0
    : (targetDistance - cumulativeLengths[segment]) / segmentLength;
  return interpolateSample(first, second, amount);
}

function smoothstep(amount: number): number {
  const bounded = clamp(amount, 0, 1);
  return bounded * bounded * (3 - 2 * bounded);
}

/** Builds a bounded, renderer-agnostic screen-space silhouette profile. */
export function buildEraserTrailProfile(
  samples: readonly EraserTrailSample[],
  now: number,
): EraserTrailProfile {
  if (samples.length === 0) {
    return {
      stations: [],
      opacity: ERASER_TRAIL_OPACITY,
      head: null,
      pathLength: 0,
      hasTransientTail: false,
      needsAnimation: false,
    };
  }

  const latest = samples[samples.length - 1];
  const headSpeed = effectiveHeadSpeed(latest, now);
  const headDiameter = diameterForSpeed(headSpeed);
  const cumulativeLengths = new Array<number>(samples.length).fill(0);
  for (let index = 1; index < samples.length; index += 1) {
    const segmentLength = distance(samples[index - 1], samples[index]);
    cumulativeLengths[index] = cumulativeLengths[index - 1]
      + (Number.isFinite(segmentLength) ? segmentLength : 0);
  }
  const totalLength = cumulativeLengths[cumulativeLengths.length - 1];
  const renderSegmentCount = totalLength > GEOMETRY_EPSILON
    ? Math.min(
      ERASER_TRAIL_MAX_RENDER_STATIONS - 1,
      Math.ceil(totalLength / ERASER_TRAIL_RENDER_STEP_PX),
    )
    : 0;
  const stations = Array.from(
    { length: renderSegmentCount + 1 },
    (_, index): EraserTrailRenderStation => {
      const pathDistance = renderSegmentCount === 0
        ? 0
        : totalLength * index / renderSegmentCount;
      const source = sampleAtDistance(samples, cumulativeLengths, pathDistance);
      const recency = totalLength <= GEOMETRY_EPSILON
        ? 1
        : pathDistance / totalLength;
      const localSpeed = index === renderSegmentCount
        ? headSpeed
        : source.smoothedSpeed;
      const taper = ERASER_TRAIL_TAIL_DIAMETER_FACTOR
        + (1 - ERASER_TRAIL_TAIL_DIAMETER_FACTOR) * smoothstep(recency);
      return {
        x: source.x,
        y: source.y,
        diameter: diameterForSpeed(localSpeed) * taper,
      };
    },
  );

  const hasTransientTail = totalLength > GEOMETRY_EPSILON;
  return {
    stations,
    opacity: ERASER_TRAIL_OPACITY,
    head: {
      point: { x: latest.x, y: latest.y },
      diameter: headDiameter,
    },
    pathLength: totalLength,
    hasTransientTail,
    needsAnimation: hasTransientTail
      || headSpeed > ERASER_TRAIL_SETTLED_SPEED_PX_PER_MS,
  };
}
