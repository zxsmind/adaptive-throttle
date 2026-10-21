/**
 * Numeric helpers shared across the engine.
 *
 * Every conversion here is total: unusable input becomes a declared neutral
 * value rather than `NaN`. A single `NaN` reaching a level comparison would
 * silently make a resource look permanently eligible, so coercion is
 * centralised instead of repeated at each call site.
 */

/** Parses a number or numeric string; anything else yields null. */
export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

/** Parses a number and floors it at zero; unusable input yields zero. */
export function toNonNegative(value: unknown): number {
  const parsed = toFiniteNumber(value)
  return parsed == null || parsed < 0 ? 0 : parsed
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.min(1, value))
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min
  }

  return Math.max(min, Math.min(max, value))
}

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0
  }

  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/**
 * Formats a level or limit for humans without inventing precision. Large
 * magnitudes lose decimals; small ones keep them, so `0.0042` never renders as
 * `0` and `1200000` never renders as `1200000.00`.
 */
export function formatAmount(value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return 'unknown'
  }

  if (value === 0) {
    return '0'
  }

  const magnitude = Math.abs(value)

  if (magnitude >= 1000) {
    return Math.trunc(value).toLocaleString('en-US')
  }

  if (magnitude >= 1) {
    return String(Math.round(value * 100) / 100)
  }

  return String(Math.round(value * 100_000) / 100_000)
}
