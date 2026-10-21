/**
 * The evidence state machine.
 *
 * This is the part of the engine that decides what it is allowed to believe.
 *
 * One rejection creates at most a *candidate*. A candidate never blocks. Only
 * repeated, mutually consistent observations from *independent* windows promote
 * a counter to *established*, and a higher real usage level demotes it to
 * *contradicted* and revises it upward, so the engine can never lock a resource
 * to a ceiling the provider has already moved past.
 *
 * Provider-declared limits are authoritative and always win. Every inference
 * carries its provenance so callers can render "inferred, established from 4
 * independent windows" instead of a bare number.
 */

import { clamp01, median } from './numeric.js'
import { resolveTolerance, resolveToleranceFloor } from './counters.js'
import type {
  BoundarySample,
  CounterEstimate,
  CounterSpec,
  EstimateStatus,
  ProviderCounterSignal,
  ProviderCounterTelemetry,
} from './types.js'

/**
 * Distinct quota windows required before an inference may act. One rejection
 * proves nothing about a limit: it can equally be an account-level cap, a
 * concurrency guard, or a one-off rejection for a reason unrelated to volume.
 */
export const ESTABLISHMENT_MIN_INDEPENDENT_WINDOWS = 3

/** Bound on retained samples per counter; the ledger owns the rest. */
export const MAX_RETAINED_SAMPLES = 8

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function createEstimate(counterId: string): CounterEstimate {
  return {
    counterId,
    status: 'unobserved',
    source: null,
    estimatedLimit: null,
    lowerBound: null,
    upperBound: null,
    provenLowerBound: null,
    samples: [],
    supportingWindowCount: 0,
    contradictingObservationCount: 0,
    confidence: 0,
    lastObservedAt: null,
    lastRateLimitAt: null,
    updatedAt: null,
  }
}

export function createEstimateStore(
  counters: readonly CounterSpec[],
): Record<string, CounterEstimate> {
  const store: Record<string, CounterEstimate> = {}

  for (const counter of counters) {
    store[counter.counterId] = createEstimate(counter.counterId)
  }

  return store
}

/**
 * An estimate may constrain a decision when it rests on provider telemetry or
 * when observed learning reached `established`. Candidates and contradicted
 * records inform explanation only.
 */
export function isActionableEstimate(record: CounterEstimate | undefined): boolean {
  if (!record || record.estimatedLimit == null) {
    return false
  }

  return record.source === 'provider' || record.status === 'established'
}

/** A bucket proves a lower bound like a window does; only a gauge cannot. */
export function supportsInference(counter: CounterSpec): boolean {
  return counter.kind !== 'gauge' && (counter.kind === 'bucket' || counter.window != null)
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function deriveConfidence(record: CounterEstimate): number {
  const windowProgress = clamp01(record.supportingWindowCount / ESTABLISHMENT_MIN_INDEPENDENT_WINDOWS)
  const denominator = record.samples.length + record.contradictingObservationCount
  const consistency = denominator <= 0 ? 0 : clamp01(record.samples.length / denominator)

  return Math.round(windowProgress * consistency * 100) / 100
}

function recomputeAggregates(record: CounterEstimate): void {
  record.supportingWindowCount = new Set(record.samples.map((sample) => sample.windowKey)).size
  record.confidence = deriveConfidence(record)
}

/**
 * Recomputes status and bounds from retained samples. Values inside the
 * tolerance band around the robust median describe one limit; values outside it
 * describe a different regime, so the record stays a candidate rather than
 * settling on an average of two incompatible observations.
 *
 * A `cleared` record is left alone: it was ruled out by a rejection in a nearly
 * empty window, and accumulating more samples cannot undo that — only real usage
 * above the old ceiling can, which goes through `observeSuccessfulLevel`.
 */
function applyEstablishmentPolicy(counter: CounterSpec, record: CounterEstimate): void {
  recomputeAggregates(record)

  if (record.source === 'provider' || !supportsInference(counter) || record.status === 'cleared') {
    return
  }

  const values = record.samples.map((sample) => sample.observedValue)

  if (values.length === 0) {
    // Preserve a caller-set status so a contradiction marker is never erased by
    // a subsequent normalisation pass.
    return
  }

  const center = median(values)
  const tolerance = resolveTolerance(counter, center)
  const consistent = values.every((value) => Math.abs(value - center) <= tolerance)

  record.lowerBound = Math.min(...values)
  record.upperBound = Math.max(...values)

  // A rejection names a ceiling only when its bracket is one unit wide. On a
  // discrete counter `[proven, attempted)` with a one-unit request leaves exactly
  // one integer; a 350k-token attempt against a proven 100k leaves hundreds of
  // thousands of values that fit equally well, and collapsing them into a point
  // would state a number no sample supports. The bracket itself is still kept
  // above, because narrowing it is real progress even when it pins nothing.
  const discrete = resolveToleranceFloor(counter) >= 1
  const pinned = record.samples.every(
    (sample) => sample.attemptedValue - sample.observedValue <= 1,
  )

  // A fractional ceiling on a discrete counter is arithmetic rather than
  // evidence: it arises from samples that disagree (the median of an even-length
  // set), so it is reported as disagreement instead of being rounded into a
  // number that was never observed.
  const fractional = discrete && !Number.isInteger(center)

  if (!pinned || fractional) {
    record.estimatedLimit = null
    record.status = 'candidate'
    return
  }

  record.estimatedLimit = center
  record.status = consistent && record.supportingWindowCount >= ESTABLISHMENT_MIN_INDEPENDENT_WINDOWS
    ? 'established'
    : record.status === 'contradicted'
      ? 'contradicted'
      : 'candidate'
}

function reviseUpward(
  counter: CounterSpec,
  record: CounterEstimate,
  observedValue: number,
  wasEstablished: boolean,
  updatedAt: string,
): void {
  // The previous ceiling was wrong. Samples describing the old regime must not
  // anchor the new one, or the estimate can never climb again.
  record.samples = []
  record.estimatedLimit = observedValue
  record.lowerBound = observedValue
  record.upperBound = observedValue
  record.status = wasEstablished ? 'contradicted' : 'candidate'
  record.contradictingObservationCount += 1
  record.updatedAt = updatedAt
  applyEstablishmentPolicy(counter, record)
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/**
 * Records one real rejection for a counter.
 *
 * Rules:
 * - Provider-authoritative counters ignore boundary samples; provider truth is
 *   not out-voted by local evidence.
 * - A rejection with no hypothesis yet and nothing in the window plants no
 *   candidate: zero is not a ceiling, and inventing one would turn "this counter
 *   was empty" into "this counter allows nothing".
 * - A rejection far *below* the inferred ceiling clears the counter: the
 *   resource failed while this window was nearly empty, so this counter is not
 *   what stopped it. This is the signal that separates several candidate windows
 *   without the engine ever spending a request of its own.
 * - A sample above the current ceiling plus tolerance is evidence the ceiling is
 *   too low, so it revises upward rather than being clamped down.
 * - Otherwise one sample per independent window; a later rejection in the same
 *   window replaces that window's sample instead of adding a duplicate.
 */
export function recordBoundarySample(
  counter: CounterSpec,
  record: CounterEstimate,
  sample: BoundarySample,
): void {
  record.lastRateLimitAt = sample.occurredAt
  record.lastObservedAt = sample.occurredAt
  record.updatedAt = sample.occurredAt

  if (record.source === 'provider' || !supportsInference(counter)) {
    return
  }

  record.source = 'observed'

  // A rejection brackets the limit: it is at least whatever accepted traffic has
  // already proved (`provenLowerBound`) and strictly below what this request
  // tried to take the counter to. Everything below follows from that interval.
  const proven = record.provenLowerBound ?? 0
  const attempted = Math.max(sample.attemptedValue, sample.observedValue)

  if (proven <= 0) {
    // Nothing accepted has ever touched this counter, so the interval's lower end
    // rests on nothing. "This window blocked the request" is then one of several
    // readings that fit the same observation — indistinguishable from a longer
    // window, or from a limit the engine was never told about — and naming a
    // ceiling from it would state a number the evidence cannot separate from its
    // alternatives. That is the mistake this module exists to avoid.
    return
  }

  if (attempted <= proven) {
    // The request could not have exceeded this counter: accepted traffic already
    // proved the limit reaches `proven`, and this attempt stayed at or below it.
    // So whatever refused it was a different window. This reading holds whichever
    // window turns out to have been the cause, which is why ruling the counter
    // out needs no attribution — the one inference here that is free of it.
    if (record.estimatedLimit == null) {
      return
    }

    record.status = 'cleared'
    record.samples = [...record.samples, sample].slice(-MAX_RETAINED_SAMPLES)
    recomputeAggregates(record)
    return
  }

  const ceiling = record.estimatedLimit != null
    ? record.estimatedLimit + resolveTolerance(counter, record.estimatedLimit)
    : null

  if (ceiling != null && sample.observedValue > ceiling) {
    reviseUpward(
      counter,
      record,
      sample.observedValue,
      record.status === 'established',
      sample.occurredAt,
    )
    return
  }

  if (record.estimatedLimit != null) {
    // The rejection happened well below the level this counter was believed to
    // stop at. Adopting the lower level as a new ceiling would block the resource
    // even earlier than before, so the counter is ruled out instead.
    const floor = record.estimatedLimit - resolveTolerance(counter, sample.observedValue)

    if (sample.observedValue < floor) {
      record.status = 'cleared'
      record.samples = [...record.samples, sample].slice(-MAX_RETAINED_SAMPLES)
      recomputeAggregates(record)
      return
    }
  }

  if (record.status === 'cleared') {
    // Already ruled out; another low rejection adds nothing.
    return
  }

  const existingIndex = record.samples.findIndex((entry) => entry.windowKey === sample.windowKey)

  if (existingIndex >= 0) {
    record.samples[existingIndex] = sample
  } else {
    record.samples.push(sample)
    if (record.samples.length > MAX_RETAINED_SAMPLES) {
      record.samples = record.samples.slice(-MAX_RETAINED_SAMPLES)
    }
  }

  applyEstablishmentPolicy(counter, record)
}

/**
 * Feeds a real accepted level into the estimate.
 *
 * A level above the current ceiling plus tolerance proves the ceiling was too
 * low, which revises it upward and, if the counter had been cleared, brings it
 * back into consideration: accepted traffic is stronger evidence than a rejected
 * attempt, because a rejection proves only that *something* failed.
 */
export function observeSuccessfulLevel(
  counter: CounterSpec,
  record: CounterEstimate,
  input: { observedValue: number; occurredAt: string },
): void {
  if (input.observedValue <= 0 || record.source === 'provider' || !supportsInference(counter)) {
    return
  }

  if (record.source == null) {
    record.source = 'observed'
  }

  record.lastObservedAt = input.occurredAt

  // Accepted traffic is proof, not evidence: whatever else turns out to be true,
  // this counter demonstrably carried this much. It is the one number in the
  // record that later observations can never retract, so it is kept apart from
  // the bounds derived from rejections and used to refute any ceiling that falls
  // below it.
  if (record.provenLowerBound == null || input.observedValue > record.provenLowerBound) {
    record.provenLowerBound = input.observedValue
  }

  const ceiling = record.estimatedLimit != null
    ? record.estimatedLimit + resolveTolerance(counter, record.estimatedLimit)
    : null

  if (ceiling != null && input.observedValue > ceiling) {
    reviseUpward(
      counter,
      record,
      input.observedValue,
      record.status === 'established',
      input.occurredAt,
    )
  }
}

// ---------------------------------------------------------------------------
// Provider telemetry
// ---------------------------------------------------------------------------

export function mergeProviderTelemetry(
  current: ProviderCounterTelemetry | null | undefined,
  signal: ProviderCounterSignal,
  meta: { observedAt: string; source: string },
): { telemetry: ProviderCounterTelemetry | null; declaredLimit: number | null } {
  const limit = normalizeOptionalNumber(signal.limit)
  const remaining = normalizeOptionalNumber(signal.remaining)
  const resetAt = typeof signal.resetAt === 'string' && signal.resetAt.trim()
    ? signal.resetAt.trim()
    : null
  const resetTimeZone = typeof signal.resetTimeZone === 'string' && signal.resetTimeZone.trim()
    ? signal.resetTimeZone.trim()
    : null

  if (limit == null && remaining == null && resetAt == null && resetTimeZone == null) {
    return { telemetry: current ?? null, declaredLimit: null }
  }

  const telemetry: ProviderCounterTelemetry = {
    counterId: signal.counterId,
    limit: limit ?? current?.limit ?? null,
    remaining,
    resetAt: resetAt ?? current?.resetAt ?? null,
    resetTimeZone: resetTimeZone ?? current?.resetTimeZone ?? null,
    observedAt: meta.observedAt,
    source: meta.source,
  }

  return { telemetry, declaredLimit: telemetry.limit }
}

/**
 * Applies a provider-declared limit. Provider truth replaces inferred bounds
 * entirely: a local estimate must never out-rank a number the provider sent.
 */
export function applyProviderDeclaredLimit(
  record: CounterEstimate,
  limit: number,
  observedAt: string,
): void {
  record.source = 'provider'
  record.estimatedLimit = limit
  record.lowerBound = limit
  record.upperBound = limit
  record.status = 'established'
  record.samples = []
  record.supportingWindowCount = ESTABLISHMENT_MIN_INDEPENDENT_WINDOWS
  record.lastObservedAt = observedAt
  record.updatedAt = observedAt
}

function normalizeOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)

    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes a persisted record without inventing evidence: an absent or
 * malformed sample list becomes an empty list, never a defaulted one.
 */
export function normalizeEstimate(input: unknown, counterId: string): CounterEstimate {
  const base = createEstimate(counterId)

  if (!input || typeof input !== 'object') {
    return base
  }

  const raw = input as Partial<CounterEstimate>
  const samples = Array.isArray(raw.samples)
    ? raw.samples
        .filter((entry): entry is BoundarySample =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          typeof (entry as BoundarySample).windowKey === 'string' &&
          Number.isFinite((entry as BoundarySample).observedValue),
        )
        .map((entry) => ({
          ...entry,
          // Snapshots written before `attemptedValue` existed carry only the
          // level. Reading them as one-unit attempts keeps them pinning a
          // ceiling exactly as they used to, rather than silently demoting every
          // learned estimate to "brackets nothing" on upgrade.
          attemptedValue: Number.isFinite(entry.attemptedValue)
            ? entry.attemptedValue
            : entry.observedValue,
        }))
        .slice(-MAX_RETAINED_SAMPLES)
    : []

  return {
    ...base,
    status: normalizeStatus(raw.status),
    source: raw.source === 'provider' || raw.source === 'observed' ? raw.source : null,
    estimatedLimit: normalizeOptionalNumber(raw.estimatedLimit),
    lowerBound: normalizeOptionalNumber(raw.lowerBound),
    upperBound: normalizeOptionalNumber(raw.upperBound),
    provenLowerBound: normalizeOptionalNumber(raw.provenLowerBound),
    samples,
    supportingWindowCount: normalizeCount(raw.supportingWindowCount),
    contradictingObservationCount: normalizeCount(raw.contradictingObservationCount),
    confidence: clamp01(normalizeOptionalNumber(raw.confidence) ?? 0),
    lastObservedAt: normalizeTimestamp(raw.lastObservedAt),
    lastRateLimitAt: normalizeTimestamp(raw.lastRateLimitAt),
    updatedAt: normalizeTimestamp(raw.updatedAt),
  }
}

function normalizeStatus(value: unknown): EstimateStatus {
  return value === 'candidate' ||
    value === 'established' ||
    value === 'contradicted' ||
    value === 'cleared' ||
    value === 'unobserved'
    ? value
    : 'unobserved'
}

function normalizeCount(value: unknown): number {
  const parsed = normalizeOptionalNumber(value)
  return parsed == null || parsed < 0 ? 0 : Math.trunc(parsed)
}

function normalizeTimestamp(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * Recomputes derived counters so a persisted record agrees with the current
 * establishment policy. Called on load and after every observation.
 */
export function recomputeEstimate(counter: CounterSpec, record: CounterEstimate): void {
  applyEstablishmentPolicy(counter, record)
}
