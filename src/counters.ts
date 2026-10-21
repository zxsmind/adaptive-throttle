/**
 * Counter specifications and the real-measurement ledger.
 *
 * Two rules govern this module:
 *
 * 1. A counter without a resolvable window is inert. It is still reported, so a
 *    caller can see "declared but unmeasurable", but it never produces a level,
 *    a limit, or a block. Guessing a window would invent rate limiting.
 * 2. The ledger records only real charges. Estimates live in a separate
 *    structure (`estimates.ts`) and are never fed back as usage.
 */

import { toFiniteNumber } from './numeric.js'
import {
  pruneBuckets,
  resolveBucketStart,
  resolveWindow,
  resolveWindowEnd,
  resolveWindowKey,
  type ResolvedWindow,
} from './windows.js'
import type {
  CounterKind,
  CounterLedgerState,
  CounterSpec,
  CounterUnit,
  CounterWindowSpec,
  ResourceSpec,
  ToleranceSpec,
} from './types.js'

// ---------------------------------------------------------------------------
// Specification normalization
// ---------------------------------------------------------------------------

export function normalizeCounterUnit(value: unknown): CounterUnit {
  return typeof value === 'string' && value.trim() ? value.trim() : 'count'
}

export function normalizeCounter(input: unknown): CounterSpec | null {
  if (!input || typeof input !== 'object') {
    return null
  }

  const raw = input as Partial<CounterSpec>
  const counterId = typeof raw.counterId === 'string' ? raw.counterId.trim() : ''

  if (!counterId) {
    return null
  }

  const kind: CounterKind = raw.kind === 'gauge' ? 'gauge' : raw.kind === 'bucket' ? 'bucket' : 'window'
  const limit = toFiniteNumber(raw.limit)

  return {
    counterId,
    kind,
    unit: normalizeCounterUnit(raw.unit),
    window:
      kind === 'window' && raw.window && typeof raw.window === 'object'
        ? normalizeWindowSpec(raw.window)
        : null,
    // A bucket needs a refill period to be measurable at all; one declared
    // without is normalized away rather than silently treated as a cumulative
    // counter, because an unmeasurable bucket would read as usage that never
    // returns ? which is a different, and wrong, thing to say about a provider.
    bucket:
      kind === 'bucket' && raw.bucket && typeof raw.bucket === 'object'
        ? { windowMs: Math.max(0, toFiniteNumber(raw.bucket.windowMs) ?? 0) }
        : null,
    defaultCharge: toFiniteNumber(raw.defaultCharge),
    limit: limit != null && limit >= 0 ? limit : null,
    enforce: raw.enforce !== false,
    tolerance: normalizeToleranceSpec(raw.tolerance),
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : null,
  }
}

function normalizeWindowSpec(input: Partial<CounterWindowSpec>): CounterWindowSpec {
  return {
    windowMs: toFiniteNumber(input.windowMs) ?? 0,
    alignment: input.alignment === 'sliding' ? 'sliding' : 'fixed',
    dayAligned: input.dayAligned === true,
    timeZone:
      typeof input.timeZone === 'string' && input.timeZone.trim() ? input.timeZone.trim() : null,
    bucketMs: toFiniteNumber(input.bucketMs),
  }
}

export function normalizeToleranceSpec(input: unknown): ToleranceSpec | null {
  if (!input || typeof input !== 'object') {
    return null
  }

  const raw = input as Partial<ToleranceSpec>

  return {
    ratio: toFiniteNumber(raw.ratio),
    floor: toFiniteNumber(raw.floor),
  }
}

export function normalizeResource(input: unknown): ResourceSpec | null {
  if (!input || typeof input !== 'object') {
    return null
  }

  const raw = input as Partial<ResourceSpec>
  const resourceId = typeof raw.resourceId === 'string' ? raw.resourceId.trim() : ''

  if (!resourceId) {
    return null
  }

  const counters = Array.isArray(raw.counters)
    ? raw.counters
        .map((entry) => normalizeCounter(entry))
        .filter((entry): entry is CounterSpec => entry != null)
    : []

  // Two counters sharing an id inside one resource would make a level ambiguous,
  // so the first declaration wins and the rest are dropped.
  const uniqueCounters = new Map<string, CounterSpec>()

  for (const counter of counters) {
    if (!uniqueCounters.has(counter.counterId)) {
      uniqueCounters.set(counter.counterId, counter)
    }
  }

  return {
    resourceId,
    counters: [...uniqueCounters.values()],
    enabled: raw.enabled !== false,
    quotaGroupId:
      typeof raw.quotaGroupId === 'string' && raw.quotaGroupId.trim()
        ? raw.quotaGroupId.trim()
        : null,
    priority: toFiniteNumber(raw.priority),
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : null,
  }
}

// ---------------------------------------------------------------------------
// Tolerance
// ---------------------------------------------------------------------------

export const DEFAULT_TOLERANCE_RATIO = 0.1

/**
 * Floor of the tolerance band. Defaults to 1 for `count` counters so a limit of
 * "3 or 4 requests" stays one limit instead of flapping between two. Units with
 * no natural discrete step default to 0 and are expected to declare an explicit
 * floor: guessing a floor for an arbitrary unit would either hide real drift or
 * make every observation look identical.
 */
export function resolveToleranceFloor(counter: CounterSpec): number {
  const declared = toFiniteNumber(counter.tolerance?.floor)

  if (declared != null && declared >= 0) {
    return declared
  }

  return counter.unit === 'count' ? 1 : 0
}

export function resolveTolerance(counter: CounterSpec, value: number): number {
  const floor = resolveToleranceFloor(counter)

  if (!Number.isFinite(value) || value <= 0) {
    return floor
  }

  const ratio = toFiniteNumber(counter.tolerance?.ratio) ?? DEFAULT_TOLERANCE_RATIO

  return Math.max(floor, value * Math.max(0, ratio))
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export function createLedgerState(counter: CounterSpec): CounterLedgerState {
  return {
    counterId: counter.counterId,
    kind: counter.kind,
    unit: counter.unit,
    buckets: [],
    gaugeLevel: 0,
    bucketDebt: 0,
    bucketChargedAt: null,
    totalCharged: 0,
    lastChargeAt: null,
  }
}

export function resolveCounterWindow(counter: CounterSpec): ResolvedWindow | null {
  return resolveWindow(counter)
}

/**
 * Current level. Expired buckets are dropped first, so a unit charged exactly
 * `windowMs` ago stops counting at exactly `windowMs` ago.
 */
/**
 * A bucket's fallback: the trailing window of its own refill period.
 *
 * A bucket needs its refill rate to be measured, and its rate is
 * `limit / period` ? so before a ceiling is known there is no rate, and a
 * counter that reported only its outstanding debt would report a lifetime
 * cumulative instead of a level. That is a real deadlock, not a hypothetical
 * one: the first version of this sampling rule skipped unrated buckets
 * entirely, so a bucket could never learn its first ceiling and never earn a
 * rate. The trailing window of the same period is the level a bucket with
 * capacity `limit` reports whenever a burst exhausts it, so it is a sound
 * bootstrap ? and the moment an estimate exists, the decay takes over.
 */
export function resolveBucketWindow(counter: CounterSpec): ResolvedWindow | null {
  const windowMs = counter.bucket?.windowMs

  if (windowMs == null || windowMs <= 0) {
    return null
  }

  // A fine resolution, because a charge must stop counting at about the time it
  // ages out. With buckets as wide as the window itself, a charge would stay in
  // the trailing window for up to twice its period — measured at 62s for a
  // 60s period — which is the difference between a window and a running total.
  const bucketMs = Math.min(windowMs, Math.max(1_000, Math.floor(windowMs / 60)))

  return {
    windowMs,
    bucketMs,
    alignment: 'sliding',
    dayAligned: false,
    timeZone: null,
  }
}

export function readLevel(
  ledger: CounterLedgerState | undefined,
  counter: CounterSpec,
  instantMs: number,
  /** Refill rate for a `bucket` counter, in units per millisecond. */
  refillPerMs?: number | null,
): number {
  if (!ledger) {
    return 0
  }

  if (counter.kind === 'gauge') {
    return Math.max(0, ledger.gaugeLevel)
  }

  if (counter.kind === 'bucket') {
    // A known rate decays; an unknown one falls back to the trailing window,
    // which is the same period and therefore the same shape.
    if (refillPerMs != null && refillPerMs > 0) {
      return readBucketLevel(ledger, instantMs, refillPerMs)
    }

    const fallback = resolveBucketWindow(counter)

    return fallback == null ? Math.max(0, ledger.bucketDebt) : resolveLevel(ledger.buckets, instantMs, fallback)
  }

  const window = resolveWindow(counter)

  if (!window) {
    return 0
  }

  pruneBuckets(ledger.buckets, instantMs, window)
  return resolveLevel(ledger.buckets, instantMs, window)
}

/**
 * A bucket's refill rate: the ceiling per refill period. Null when the ceiling
 * is unknown, because a rate computed from a limit that is itself an estimate
 * would be an estimate of an estimate ? and with no limit at all there is no
 * rate to report, which is the honest answer: an unlearned bucket does not
 * decay. The caller who knows the period (most do ? it is the provider's stated
 * policy, "thirty a minute") passes it, and the estimate supplies the rest.
 */
export function bucketRefillPerMs(
  counter: CounterSpec,
  effectiveLimit: number | null | undefined,
): number | null {
  const period = counter.bucket?.windowMs

  if (period == null || period <= 0 || effectiveLimit == null || effectiveLimit <= 0) {
    return null
  }

  return effectiveLimit / period
}

function readBucketLevel(
  ledger: CounterLedgerState,
  instantMs: number,
  refillPerMs: number | null | undefined,
): number {
  const debt = Math.max(0, ledger.bucketDebt)

  if (ledger.bucketChargedAt == null || debt <= 0 || refillPerMs == null || refillPerMs <= 0) {
    return debt
  }

  const elapsed = Math.max(0, instantMs - ledger.bucketChargedAt)
  const decayed = Math.max(0, debt - elapsed * refillPerMs)

  // A bucket holds whole units. The refill is continuous, so without rounding a
  // level drifts across the same value — 3.0, then 2.95, then 3.05 — and the
  // estimator reads that as "accepted traffic proved 3.05 while a refusal came at
  // 3.0", revising a ceiling that was never wrong. Integral units report
  // integral levels.
  return INTEGRAL_UNITS.has(ledger.unit) ? Math.round(decayed) : decayed
}

/** Units whose whole point is that they are counted in whole things. */
const INTEGRAL_UNITS = new Set(['count', 'tokens', 'bytes', 'requests'])

function resolveLevel(
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
 * Records real usage. `window` must be the same resolved window `readLevel`
 * used for this counter. A null window means the charge cannot be placed in a
 * window, so it is not recorded: an unplaceable charge is not evidence.
 */
export function charge(
  ledger: CounterLedgerState,
  counter: CounterSpec,
  amount: number,
  instantMs: number,
  window: ResolvedWindow | null,
  refillPerMs?: number | null,
): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    return
  }

  ledger.totalCharged += amount
  ledger.lastChargeAt = new Date(instantMs).toISOString()

  if (counter.kind === 'gauge') {
    ledger.gaugeLevel = Math.max(0, ledger.gaugeLevel + amount)
    return
  }

  if (counter.kind === 'bucket') {
    // Both representations are kept. The debt is what a known rate decays; the
    // window buckets are the fallback for before a rate is known, and they cost
    // one bucket per refill period.
    ledger.bucketDebt = readBucketLevel(ledger, instantMs, refillPerMs) + amount
    ledger.bucketChargedAt = instantMs

    const fallback = resolveBucketWindow(counter)

    if (fallback != null) {
      pruneBuckets(ledger.buckets, instantMs, fallback)
      const start = resolveBucketStart(instantMs, fallback)
      const existing = ledger.buckets.find((entry) => entry.start === start)

      if (existing) {
        existing.amount += amount
      } else {
        ledger.buckets.push({ start, amount })
        ledger.buckets.sort((left, right) => left.start - right.start)
      }
    }

    return
  }

  if (!window) {
    return
  }

  pruneBuckets(ledger.buckets, instantMs, window)
  const start = resolveBucketStart(instantMs, window)
  const existing = ledger.buckets.find((bucket) => bucket.start === start)

  if (existing) {
    existing.amount += amount
  } else {
    ledger.buckets.push({ start, amount })
    ledger.buckets.sort((left, right) => left.start - right.start)
  }
}

export function setGaugeLevel(ledger: CounterLedgerState, level: number): void {
  ledger.gaugeLevel = Math.max(0, level)
}

export function adjustGaugeLevel(ledger: CounterLedgerState, delta: number): void {
  if (!Number.isFinite(delta)) {
    return
  }

  ledger.gaugeLevel = Math.max(0, ledger.gaugeLevel + delta)
}

export function windowKeyAt(counter: CounterSpec, instantMs: number): string | null {
  const window = resolveWindow(counter)
  return window ? resolveWindowKey(instantMs, window) : null
}

export function windowEndAt(counter: CounterSpec, instantMs: number): string | null {
  const window = resolveWindow(counter)
  return window ? new Date(resolveWindowEnd(instantMs, window)).toISOString() : null
}

// ---------------------------------------------------------------------------
// Charge resolution
// ---------------------------------------------------------------------------

/**
 * Resolves how much of one counter one settled operation consumed. An explicit
 * charge wins; otherwise `defaultCharge` applies, which is 1 for `count` and 0
 * for every other unit. A cost counter never silently charges one unit just
 * because nobody declared the amount.
 */
export function resolveCharge(
  counter: CounterSpec,
  charges: Record<string, number> | null | undefined,
  operations: number,
): number {
  const explicit = toFiniteNumber(charges?.[counter.counterId])

  if (explicit != null) {
    return Math.max(0, explicit) * Math.max(1, operations)
  }

  const declared = toFiniteNumber(counter.defaultCharge)
  const perOperation = declared != null
    ? Math.max(0, declared)
    : counter.unit === 'count'
      ? 1
      : 0

  return perOperation * Math.max(1, operations)
}

export function resolveOperationCount(operations: unknown): number {
  const parsed = toFiniteNumber(operations)
  return parsed == null ? 1 : Math.max(1, Math.trunc(parsed))
}

export function counterDisplayLabel(counter: CounterSpec): string {
  return counter.label ?? counter.counterId
}
