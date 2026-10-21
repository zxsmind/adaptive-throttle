/**
 * Deterministic clock contract for Adaptive Throttle.
 *
 * The engine never reads wall-clock time on its own. Every entry point either
 * receives an explicit instant (`now`) or uses the injected clock. Identical
 * snapshot plus identical inputs plus an identical clock always produce
 * identical output — this is what makes the learning behaviour testable and
 * what keeps replayed history reproducible.
 */
export interface ThrottleClock {
  now(): Date
}

export const systemThrottleClock: ThrottleClock = {
  now: () => new Date(),
}

export function createFixedThrottleClock(instant: Date | string | number): ThrottleClock & {
  setInstant(instant: Date | string | number): void
} {
  let current = toDate(instant)

  return {
    now: () => new Date(current.getTime()),
    setInstant(next: Date | string | number) {
      current = toDate(next)
    },
  }
}

export function resolveInstant(
  clock: ThrottleClock,
  explicitNow?: string | Date | number | null,
): Date {
  return explicitNow == null || explicitNow === '' ? clock.now() : toDate(explicitNow)
}

/**
 * Coerces any accepted instant input into a valid Date. Anything unusable
 * becomes the epoch rather than `NaN`, so a malformed timestamp can never
 * poison window arithmetic or comparisons.
 */
export function toDate(input: Date | string | number): Date {
  if (input instanceof Date) {
    return Number.isFinite(input.getTime()) ? new Date(input.getTime()) : new Date(0)
  }

  if (typeof input === 'number') {
    return Number.isFinite(input) ? new Date(Math.trunc(input)) : new Date(0)
  }

  const parsed = Date.parse(input.trim())
  return Number.isFinite(parsed) ? new Date(parsed) : new Date(0)
}

export function toIso(timestamp: number | null | undefined): string | null {
  if (timestamp == null || !Number.isFinite(timestamp) || timestamp <= 0) {
    return null
  }

  return new Date(timestamp).toISOString()
}

export function parseTimestamp(value: string | null | undefined): number {
  if (typeof value !== 'string' || !value.trim()) {
    return 0
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}
