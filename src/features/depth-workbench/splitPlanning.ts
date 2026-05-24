export interface VideoSplitRange {
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
}

const DEFAULT_TARGET_SEC = 9.9;
const DEFAULT_MAX_SEC = 10;
const DEFAULT_MIN_LAST_SEC = 5;
const SECOND_PRECISION = 3;

export function planVideoSplitRanges(
  durationSec: number,
  options: {
    targetSec?: number;
    maxSec?: number;
    minLastSec?: number;
  } = {}
): VideoSplitRange[] {
  const duration = roundSec(durationSec);
  if (!Number.isFinite(duration) || duration <= 0) return [];

  const targetSec = options.targetSec ?? DEFAULT_TARGET_SEC;
  const maxSec = options.maxSec ?? DEFAULT_MAX_SEC;
  const minLastSec = options.minLastSec ?? DEFAULT_MIN_LAST_SEC;
  if (targetSec <= 0 || maxSec <= 0 || minLastSec <= 0 || targetSec > maxSec) {
    throw new Error("Invalid split range options.");
  }

  if (duration <= maxSec) {
    return [rangeAt(0, 0, duration)];
  }

  let fullCount = Math.floor(duration / targetSec);
  let lastDuration = roundSec(duration - fullCount * targetSec);
  if (lastDuration === 0) {
    fullCount -= 1;
    lastDuration = targetSec;
  }

  const durations = Array.from({ length: fullCount }, () => targetSec);
  durations.push(lastDuration);

  const lastIndex = durations.length - 1;
  if (durations[lastIndex] > 0 && durations[lastIndex] < minLastSec) {
    const deficit = roundSec(minLastSec - durations[lastIndex]);
    const donorCount = durations.length - 1;
    if (donorCount <= 0 || duration < minLastSec * 2) {
      return [rangeAt(0, 0, duration)];
    }
    const borrowEach = deficit / donorCount;
    for (let index = 0; index < donorCount; index += 1) {
      durations[index] = roundSec(durations[index] - borrowEach);
    }
    durations[lastIndex] = minLastSec;
  }

  let cursor = 0;
  return durations.map((item, index) => {
    const startSec = roundSec(cursor);
    const isLast = index === durations.length - 1;
    const endSec = isLast ? duration : roundSec(cursor + item);
    cursor = endSec;
    return rangeAt(index, startSec, endSec);
  });
}

function rangeAt(index: number, startSec: number, endSec: number): VideoSplitRange {
  return {
    index,
    startSec: roundSec(startSec),
    endSec: roundSec(endSec),
    durationSec: roundSec(endSec - startSec)
  };
}

function roundSec(value: number) {
  return Number(value.toFixed(SECOND_PRECISION));
}
