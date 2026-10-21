/**
 * Snapshot normalization.
 *
 * The snapshot holds learned state only; static configuration stays with the
 * caller. A snapshot whose version differs from the current contract is
 * discarded outright rather than migrated — a V1 snapshot's semantics (fixed
 * rpm/tpm dimensions, token-based accounting) do not mean the same thing in V2,
 * and quietly reinterpreting it would put fabricated numbers into routing
 * decisions.
 *
 * Every field is validated defensively. Absent evidence normalizes to absent,
 * never to a default that looks like an observation.
 */

import { normalizeEstimate } from './estimates.js'
import { normalizePacingSnapshot } from './pacing.js'
import { normalizeCounter } from './counters.js'
import type {
  AdviceDecision,
  Cooldown,
  CooldownKind,
  CooldownScope,
  CooldownSource,
  CounterEstimate,
  CounterLedgerState,
  CounterSpec,
  ProviderCounterTelemetry,
  QuotaGroupRuntime,
  ResourceRuntime,
  ThrottleEvent,
  ThrottleEventKind,
  ThrottleMode,
  ThrottleSnapshot,
} from './types.js'
import { THROTTLE_SNAPSHOT_VERSION } from './types.js'
import { toFiniteNumber } from './numeric.js'

export const MAX_EVENTS_PER_RESOURCE = 32
export const MAX_GLOBAL_EVENTS = 128
export const MAX_COOLDOWNS_PER_SCOPE = 8

const COOLDOWN_KINDS: readonly CooldownKind[] = [
  'rate-limit',
  'quota-exhausted',
  'credential-rejected',
  'transport-failure',
  'resource-missing',
  'manual',
]

const COOLDOWN_SOURCES: readonly CooldownSource[] = [
  'provider-retry-after',
  'provider-reset',
  'window-boundary',
  'operator-config',
  'typed-failure-policy',
  'learned-estimate',
]

const EVENT_KINDS: readonly ThrottleEventKind[] = [
  'advised',
  'success',
  'rate-limit',
  'credential-rejected',
  'transport-failure',
  'resource-missing',
  'recovered',
]

export function createEmptySnapshot(mode: ThrottleMode = 'smart'): ThrottleSnapshot {
  return {
    version: THROTTLE_SNAPSHOT_VERSION,
    mode,
    resources: {},
    quotaGroups: {},
    events: [],
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asNonNegative(value: unknown): number {
  const parsed = toFiniteNumber(value)
  return parsed == null || parsed < 0 ? 0 : parsed
}

function normalizeMode(value: unknown, fallback: ThrottleMode): ThrottleMode {
  return value === 'off' || value === 'observe' || value === 'smart' || value === 'aggressive'
    ? value
    : fallback
}

function normalizeEvent(input: unknown, index: number): ThrottleEvent | null {
  if (!input || typeof input !== 'object') {
    return null
  }

  const raw = input as Partial<ThrottleEvent>
  const kind = EVENT_KINDS.find((candidate) => candidate === raw.kind)
  const detail = asString(raw.detail)

  if (!kind || !detail) {
    return null
  }

  return {
    // A persisted event without an id gets a positional one. Stable across
    // loads, which keeps snapshots reproducible without a random generator.
    id: asString(raw.id) ?? `event-${index}`,
    kind,
    createdAt: asString(raw.createdAt) ?? new Date(0).toISOString(),
    detail,
    nextEligibleAt: asString(raw.nextEligibleAt),
  }
}

function normalizeCooldown(input: unknown, index: number): Cooldown | null {
  if (!input || typeof input !== 'object') {
    return null
  }

  const raw = input as Record<string, unknown>
  const kind = COOLDOWN_KINDS.find((candidate) => candidate === raw.kind)
  const source = COOLDOWN_SOURCES.find((candidate) => candidate === raw.source)
  const blockedUntil = asString(raw.blockedUntil)

  if (!kind || !source || !blockedUntil) {
    return null
  }

  return {
    id: asString(raw.id) ?? `cooldown-${index}`,
    kind,
    counterId: asString(raw.counterId),
    scope: raw.scope === 'quota-group' ? 'quota-group' : 'resource',
    blockedUntil,
    setAt: asString(raw.setAt) ?? blockedUntil,
    source,
    detail: asString(raw.detail) ?? '',
    authoritative: raw.authoritative !== false,
  }
}

function normalizeTelemetry(input: unknown, counterId: string): ProviderCounterTelemetry | null {
  if (!input || typeof input !== 'object') {
    return null
  }

  const raw = input as Record<string, unknown>
  const limit = toFiniteNumber(raw.limit)
  const remaining = toFiniteNumber(raw.remaining)
  const resetAt = asString(raw.resetAt)
  const resetTimeZone = asString(raw.resetTimeZone)

  if (limit == null && remaining == null && resetAt == null && resetTimeZone == null) {
    return null
  }

  return {
    counterId: asString(raw.counterId) ?? counterId,
    limit,
    remaining,
    resetAt,
    resetTimeZone,
    observedAt: asString(raw.observedAt) ?? new Date(0).toISOString(),
    source: asString(raw.source) ?? 'unknown',
  }
}

function normalizeLedger(
  input: unknown,
  counter: CounterSpec,
): CounterLedgerState | null {
  if (!input || typeof input !== 'object') {
    return null
  }

  const raw = input as Record<string, unknown>
  const buckets = Array.isArray(raw.buckets)
    ? raw.buckets
        .map((entry): { start: number; amount: number } | null => {
          if (!entry || typeof entry !== 'object') {
            return null
          }

          const bucket = entry as Record<string, unknown>
          const start = toFiniteNumber(bucket.start)

          if (start == null || start < 0) {
            return null
          }

          return { start: Math.trunc(start), amount: asNonNegative(bucket.amount) }
        })
        .filter((entry): entry is { start: number; amount: number } => entry != null)
        .sort((left, right) => left.start - right.start)
    : []

  return {
    counterId: counter.counterId,
    kind: counter.kind,
    unit: counter.unit,
    buckets,
    gaugeLevel: asNonNegative(raw.gaugeLevel),
    bucketDebt: asNonNegative(raw.bucketDebt),
    bucketChargedAt: typeof raw.bucketChargedAt === 'number' && Number.isFinite(raw.bucketChargedAt) ? raw.bucketChargedAt : null,
    totalCharged: asNonNegative(raw.totalCharged),
    lastChargeAt: asString(raw.lastChargeAt),
  }
}

export function createResourceRuntime(resourceId: string): ResourceRuntime {
  return {
    resourceId,
    counters: {},
    estimates: {},
    providerTelemetry: {},
    providerRetryAfter: null,
    cooldowns: [],
    lastAdvisedAt: null,
    lastDecision: null,
    lastUsedAt: null,
    lastFailureAt: null,
    lastHealthOutcome: null,
    events: [],
  }
}

function normalizeResourceRuntime(input: unknown, resourceId: string): ResourceRuntime {
  const runtime = createResourceRuntime(resourceId)

  if (!input || typeof input !== 'object') {
    return runtime
  }

  const raw = input as Record<string, unknown>
  const counterInputs =
    raw.counters && typeof raw.counters === 'object' && !Array.isArray(raw.counters)
      ? (raw.counters as Record<string, unknown>)
      : {}
  const estimateInputs =
    raw.estimates && typeof raw.estimates === 'object' && !Array.isArray(raw.estimates)
      ? (raw.estimates as Record<string, unknown>)
      : {}
  const telemetryInputs =
    raw.providerTelemetry && typeof raw.providerTelemetry === 'object' && !Array.isArray(raw.providerTelemetry)
      ? (raw.providerTelemetry as Record<string, unknown>)
      : {}

  // Counters declared in the snapshot alone are not measurable — a level needs
  // a window — so they are kept as inert state rather than being resolved here.
  for (const [counterId, counterInput] of Object.entries(counterInputs)) {
    const counter = normalizeCounter({ counterId, ...(counterInput as object) })

    if (counter) {
      runtime.counters[counterId] = normalizeLedger(counterInput, counter)!
    }
  }

  for (const [counterId, estimateInput] of Object.entries(estimateInputs)) {
    // Derived counters are not recomputed here: whether a record may act depends
    // on the counter's declared window, and configuration belongs to the caller.
    // The engine recomputes an estimate the moment it holds the spec.
    runtime.estimates[counterId] = normalizeEstimate(estimateInput, counterId)
  }

  for (const [counterId, telemetryInput] of Object.entries(telemetryInputs)) {
    const telemetry = normalizeTelemetry(telemetryInput, counterId)

    if (telemetry) {
      runtime.providerTelemetry[counterId] = telemetry
    }
  }

  const retryAfterSeconds = toFiniteNumber((raw.providerRetryAfter as Record<string, unknown> | undefined)?.seconds)

  runtime.providerRetryAfter =
    raw.providerRetryAfter && typeof raw.providerRetryAfter === 'object' && retryAfterSeconds != null && retryAfterSeconds >= 0
      ? {
          seconds: retryAfterSeconds,
          observedAt:
            asString((raw.providerRetryAfter as Record<string, unknown>).observedAt) ??
            new Date(0).toISOString(),
          source: asString((raw.providerRetryAfter as Record<string, unknown>).source) ?? 'unknown',
        }
      : null

  runtime.cooldowns = Array.isArray(raw.cooldowns)
    ? raw.cooldowns
        .map((entry, index) => normalizeCooldown(entry, index))
        .filter((entry): entry is Cooldown => entry != null)
        .slice(-MAX_COOLDOWNS_PER_SCOPE)
    : []

  runtime.lastAdvisedAt = asString(raw.lastAdvisedAt)
  runtime.lastDecision = normalizeDecision(raw.lastDecision)
  runtime.lastUsedAt = asString(raw.lastUsedAt)
  runtime.lastFailureAt = asString(raw.lastFailureAt)
  runtime.lastHealthOutcome =
    raw.lastHealthOutcome === 'success' || raw.lastHealthOutcome === 'failure'
      ? raw.lastHealthOutcome
      : null
  runtime.events = Array.isArray(raw.events)
    ? raw.events
        .map((entry, index) => normalizeEvent(entry, index))
        .filter((entry): entry is ThrottleEvent => entry != null)
        .slice(-MAX_EVENTS_PER_RESOURCE)
    : []

  return runtime
}

function normalizeDecision(value: unknown): AdviceDecision | null {
  return value === 'send' || value === 'send-cautious' || value === 'defer' || value === 'hold'
    ? value
    : null
}

function normalizeQuotaGroup(input: unknown, quotaGroupId: string): QuotaGroupRuntime {
  const group: QuotaGroupRuntime = {
    quotaGroupId,
    cooldowns: [],
    lastRateLimitAt: null,
  }

  if (!input || typeof input !== 'object') {
    return group
  }

  const raw = input as Record<string, unknown>
  group.cooldowns = Array.isArray(raw.cooldowns)
    ? raw.cooldowns
        .map((entry, index) => normalizeCooldown(entry, index))
        .filter((entry): entry is Cooldown => entry != null)
        .slice(-MAX_COOLDOWNS_PER_SCOPE)
    : []
  group.lastRateLimitAt = asString(raw.lastRateLimitAt)

  return group
}

/**
 * Normalizes a persisted snapshot. A version mismatch yields an empty snapshot:
 * there is no honest way to carry V1's meaning into V2's model.
 */
export function normalizeSnapshot(input?: unknown, mode: ThrottleMode = 'smart'): ThrottleSnapshot {
  const snapshot = createEmptySnapshot(mode)

  if (!input || typeof input !== 'object') {
    return snapshot
  }

  const raw = input as Record<string, unknown>

  if (toFiniteNumber(raw.version) !== THROTTLE_SNAPSHOT_VERSION) {
    return snapshot
  }

  snapshot.mode = normalizeMode(raw.mode, mode)
  if (raw.pacing !== undefined) snapshot.pacing = normalizePacingSnapshot(raw.pacing)

  if (raw.resources && typeof raw.resources === 'object' && !Array.isArray(raw.resources)) {
    for (const [resourceId, resourceInput] of Object.entries(raw.resources)) {
      snapshot.resources[resourceId] = normalizeResourceRuntime(resourceInput, resourceId)
    }
  }

  if (raw.quotaGroups && typeof raw.quotaGroups === 'object' && !Array.isArray(raw.quotaGroups)) {
    for (const [quotaGroupId, groupInput] of Object.entries(raw.quotaGroups)) {
      snapshot.quotaGroups[quotaGroupId] = normalizeQuotaGroup(groupInput, quotaGroupId)
    }
  }

  snapshot.events = Array.isArray(raw.events)
    ? raw.events
        .map((entry, index) => normalizeEvent(entry, index))
        .filter((entry): entry is ThrottleEvent => entry != null)
        .slice(-MAX_GLOBAL_EVENTS)
    : []

  return snapshot
}
