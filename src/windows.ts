/**
 * Window arithmetic for Adaptive Throttle.
 *
 * Callers declare unbounded window lengths (5s, 1m, 1h, 7d), alignments, and
 * optionally provider-day alignment. The ledger stores charges in fixed-size
 * buckets, so a sliding level is a bounded approximation whose error never
 * exceeds one bucket. That error is absorbed by the tolerance band in the
 * estimate machine rather than hidden: an inferred limit is never reported more
 * precisely than the evidence and the bucket resolution can support.
 */

import { parseTimestamp } from './clock.js'
import type { CounterSpec, WindowAlignment } from './types.js'

export const MIN_WINDOW_MS = 1_000
export const MAX_WINDOW_MS = 366 * 24 * 60 * 60_000
export const DAY_MS = 24 * 60 * 60_000

export interface ResolvedWindow {
  windowMs: number
  alignment: WindowAlignment
  bucketMs: number
  dayAligned: boolean
  timeZone: string | null
}

/**
 * Resolves a declared window into concrete arithmetic parameters. A `gauge`
 * counter, or a window too small to mean anything, resolves to null rather than
 * a fabricated default: a counter with no usable window is never treated as
 * rate-limited.
 */
export function resolveWindow(counter: CounterSpec): ResolvedWindow | null {
  if (counter.kind !== 'window' || !counter.window) {
    return null
  }

  const declared = counter.window.windowMs

  if (!Number.isFinite(declared) || declared < MIN_WINDOW_MS) {
    return null
  }

  const windowMs = Math.min(Math.trunc(declared), MAX_WINDOW_MS)
  const dayAligned =
    counter.window.dayAligned === true &&
    windowMs === DAY_MS &&
    counter.window.alignment !== 'sliding'

  if (dayAligned) {
    return {
      windowMs,
      alignment: 'fixed',
      bucketMs: DAY_MS,
      dayAligned: true,
      timeZone: isValidTimeZone(counter.window.timeZone) ? counter.window.timeZone : null,
    }
  }

  const alignment: WindowAlignment = counter.window.alignment === 'sliding' ? 'sliding' : 'fixed'

  return {
    windowMs,
    alignment,
    bucketMs: resolveBucketMs(counter.window.bucketMs, windowMs, alignment),
    dayAligned: false,
    timeZone: null,
  }
}

function resolveBucketMs(
  declared: number | null | undefined,
  windowMs: number,
  alignment: WindowAlignment,
): number {
  if (declared != null && Number.isFinite(declared) && declared >= MIN_WINDOW_MS) {
    return Math.min(Math.trunc(declared), windowMs)
  }

  // A fixed window needs no finer resolution than itself; a sliding window does,
  // because it has to place the trailing edge between buckets.
  return alignment === 'fixed'
    ? windowMs
    : Math.max(MIN_WINDOW_MS, Math.trunc(windowMs / 10))
}

/**
 * Start of the window bucket containing `instantMs`. For a provider-day counter
 * this is the provider's local midnight as an instant, so the boundary follows
 * the declared zone instead of drifting with UTC.
 */
export function resolveBucketStart(instantMs: number, window: ResolvedWindow): number {
  if (window.dayAligned) {
    return resolveDayStart(instantMs, window.timeZone)
  }

  return Math.floor(instantMs / window.bucketMs) * window.bucketMs
}

/**
 * Identity of the independent quota window containing `instantMs`. Two
 * rejections sharing this key are the same window and cannot corroborate each
 * other; distinct keys can.
 */
export function resolveWindowKey(instantMs: number, window: ResolvedWindow): string {
  if (window.dayAligned) {
    return resolveDayWindowKey(instantMs, window.timeZone)
  }

  return `${window.alignment}:${window.windowMs}:${resolveBucketStart(instantMs, window)}`
}

/** The instant the current window stops holding charges. */
export function resolveWindowEnd(instantMs: number, window: ResolvedWindow): number {
  if (window.dayAligned) {
    return resolveNextDayBoundary(instantMs, window.timeZone)
  }

  return resolveBucketStart(instantMs, window) + window.bucketMs
}

/**
 * Level across the current window. For `fixed` and provider-day alignment this
 * is the current bucket; for `sliding` it is every bucket still overlapping the
 * trailing window.
 */
export function resolveWindowLevel(
  buckets: ReadonlyArray<{ start: number; amount: number }>,
  instantMs: number,
  window: ResolvedWindow,
): number {
  if (window.alignment === 'fixed') {
    const currentStart = resolveBucketStart(instantMs, window)
    let total = 0

    for (const bucket of buckets) {
      if (bucket.start === currentStart) {
        total += bucket.amount
      }
    }

    return total
  }

  const windowStart = instantMs - window.windowMs
  let total = 0

  for (const bucket of buckets) {
    if (bucket.start + window.bucketMs > windowStart) {
      total += bucket.amount
    }
  }

  return total
}

/**
 * Drops buckets that can no longer contribute to any future level query. A
 * bucket is retained while it still overlaps the trailing window, so a single
 * charged unit stays visible for exactly `windowMs` and no longer.
 */
export function pruneBuckets(
  buckets: Array<{ start: number; amount: number }>,
  instantMs: number,
  window: ResolvedWindow,
): void {
  const cutoff = window.alignment === 'fixed'
    ? resolveBucketStart(instantMs, window)
    : instantMs - window.windowMs

  let writeIndex = 0

  for (const bucket of buckets) {
    if (bucket.start + window.bucketMs <= cutoff) {
      continue
    }

    buckets[writeIndex] = bucket
    writeIndex += 1
  }

  buckets.length = writeIndex
}

export function sumBuckets(buckets: ReadonlyArray<{ amount: number }>): number {
  let total = 0

  for (const bucket of buckets) {
    total += bucket.amount
  }

  return total
}

// ---------------------------------------------------------------------------
// Provider-day arithmetic
// ---------------------------------------------------------------------------

interface ZonedDateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function getZonedParts(instantMs: number, timeZone: string): ZonedDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(instantMs))
  const values = new Map(parts.map((part) => [part.type, Number(part.value)]))

  return {
    year: values.get('year') ?? 1970,
    month: values.get('month') ?? 1,
    day: values.get('day') ?? 1,
    hour: values.get('hour') ?? 0,
    minute: values.get('minute') ?? 0,
    second: values.get('second') ?? 0,
  }
}

export function isValidTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) {
    return false
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

function zonedPartsAsUtc(parts: ZonedDateParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
}

/** Zone offset at `utcMs`, in milliseconds. */
function resolveOffsetMs(utcMs: number, timeZone: string): number {
  return zonedPartsAsUtc(getZonedParts(utcMs, timeZone)) - utcMs
}

/**
 * Start of the provider calendar day containing `instantMs`, as an instant.
 * Converged twice so a DST transition inside the guess day still lands on the
 * correct boundary.
 */
export function resolveDayStart(instantMs: number, timeZone: string | null | undefined): number {
  if (!isValidTimeZone(timeZone)) {
    const cursor = new Date(instantMs)
    return Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate())
  }

  try {
    const local = getZonedParts(instantMs, timeZone)
    const wallClockMidnight = Date.UTC(local.year, local.month - 1, local.day)
    let candidate = wallClockMidnight - resolveOffsetMs(wallClockMidnight, timeZone)
    candidate = wallClockMidnight - resolveOffsetMs(candidate, timeZone)

    return candidate
  } catch {
    return resolveDayStart(instantMs, null)
  }
}

/**
 * Calendar-day bucket ("YYYY-MM-DD") in the provider's reset timezone. An
 * unknown timezone falls back to the UTC calendar date — an explicit contract,
 * not an assumption about any specific provider.
 */
export function resolveDayBucket(instantMs: number, timeZone: string | null | undefined): string {
  if (!isValidTimeZone(timeZone)) {
    return new Date(instantMs).toISOString().slice(0, 10)
  }

  try {
    const parts = getZonedParts(instantMs, timeZone)
    return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
  } catch {
    return new Date(instantMs).toISOString().slice(0, 10)
  }
}

/** Independent-window identity for a provider-day quota. */
export function resolveDayWindowKey(
  instantMs: number,
  timeZone: string | null | undefined,
): string {
  return `day:${resolveDayBucket(instantMs, timeZone)}`
}

/**
 * The instant the provider's quota day rolls over, honoring DST. Used for the
 * `nextResetAt` a caller sees when a provider discloses a daily reset without an
 * explicit timestamp.
 */
export function resolveNextDayBoundary(
  instantMs: number,
  timeZone: string | null | undefined,
): number {
  if (!isValidTimeZone(timeZone)) {
    const cursor = new Date(instantMs)
    return Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1)
  }

  try {
    const local = getZonedParts(instantMs, timeZone)
    const nextWallClock = Date.UTC(local.year, local.month - 1, local.day + 1)
    return nextWallClock - resolveOffsetMs(nextWallClock, timeZone)
  } catch {
    return resolveNextDayBoundary(instantMs, null)
  }
}

export function resolveExplicitResetTimestamp(resetAt: string | null | undefined): number {
  return parseTimestamp(resetAt ?? null)
}
