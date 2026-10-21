/**
 * Normalized observations: the one record every consumer of an outcome reads.
 *
 * Before this module the two learning engines each read the ledgers on their
 * own schedule: the legacy sampler charged a window and *then* read it back,
 * while the shadow ledger re-read the same runtime separately, at the moment it
 * happened to be called. Those reads agreed only by luck — and the one time
 * they did not (a level read before the charge that produced it), the engine
 * derived a ceiling off traffic that never happened. Both classes of mistake
 * were instrumentation errors that looked like findings.
 *
 * So `settle()` now reads the ledgers exactly once, before anything is charged
 * or released, and turns that single read into one immutable observation that
 * every consumer — legacy estimates, shadow constraints, attribution, the
 * caller — then reads. Nobody downstream touches a ledger to find out what the
 * level was.
 *
 * The shapes live in `types.ts` with the rest of the public contract; this
 * module is the builder, the replay bookkeeping, and nothing else.
 */

import { resolveCharge } from './counters.js'
import type {
  CounterReading,
  CounterSpec,
  NormalizedCounter,
  NormalizedObservation,
  OutcomeInput,
} from './types.js'

/**
 * How many settled event identities are remembered for replay protection.
 *
 * A caller that retries a settlement — after a timeout it cannot distinguish
 * from a lost write, say — needs the engine to recognise the same event. 512 is
 * bounded so a long-running process cannot grow without limit, and it is a
 * ring: the oldest identity is forgotten first. That is a real bound, not a
 * guarantee, and it is why `eventId` is an opt-in for callers who need
 * idempotency rather than a silent change to what `settle()` has always meant.
 */
export const REPLAY_MEMORY = 512

/** Identity of one settled event: one resource may reuse an id another used. */
export function eventKey(resourceId: string, eventId: string): string {
  return `${resourceId}\u0000${eventId}`
}

function toFiniteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Turns one settled event into the single observation every consumer reads.
 *
 * Pure: it touches no clock, no ledger, and no engine state. Everything it
 * needs arrives in `readings`, which the engine fills with one pass over the
 * resource's window counters before mutating anything. A counter with no
 * reading is a counter the engine cannot place in a window, so it is left out
 * rather than guessed at.
 *
 * `settledAt` is the instant the engine already resolved from the caller's
 * input — the observation never re-resolves it, so no consumer can end up on a
 * different clock reading.
 */
export function normalizeObservation(
  input: OutcomeInput,
  counters: readonly CounterSpec[],
  readings: ReadonlyMap<string, CounterReading>,
  settledAt: string,
): NormalizedObservation {
  const retryAfter = input.rateLimit?.retryAfterSeconds
  const blamed = (input.rateLimit?.blamedCounterIds ?? []).filter(
    (id): id is string => typeof id === 'string',
  )
  const rejectedCounterId = input.rateLimit?.rejectedCounterId ?? null
  const blamedCounterId = blamed.length === 1 ? blamed[0]! : null
  const rejectedCharge = toFiniteNonNegative(input.rateLimit?.rejectedCharge)
  const operations = Math.max(
    1,
    Math.trunc(
      typeof input.usage?.operations === 'number' && Number.isFinite(input.usage.operations)
        ? input.usage.operations
        : 1,
    ),
  )

  const normalized: NormalizedCounter[] = []

  for (const counter of counters) {
    // Anything except a gauge carries usage: a bucket is measured like a window,
    // and skipping one here would leave it unobserved, uncharged to its estimate,
    // and therefore unlearnable.
    if (counter.kind === 'gauge') {
      continue
    }

    const reading = readings.get(counter.counterId)

    if (reading == null) {
      continue
    }

    // The named counter carries the caller-supplied charge; every other counter
    // carries its own size. The named-counter override only applies to a
    // rejection: a success has no rejected charge to speak of.
    const charge =
      input.kind === 'rate-limit' && counter.counterId === rejectedCounterId
        ? Math.max(0, rejectedCharge ?? 0)
        : resolveCharge(counter, input.usage?.charges, operations)

    normalized.push({
      counterId: counter.counterId,
      unit: counter.unit,
      windowKey: reading.windowKey,
      usage: reading.level,
      attempted: reading.level + charge,
      charge,
    })
  }

  return Object.freeze({
    ...(input.startedAt == null ? {} : { startedAt: input.startedAt }),
    resourceId: input.resourceId,
    eventId: input.eventId ?? null,
    kind: input.kind,
    settledAt,
    operations,
    counters: Object.freeze(normalized.map((entry) => Object.freeze(entry))),
    trafficShape: input.usage?.trafficShape ?? null,
    provider: input.provider ?? null,
    rejection:
      input.kind === 'rate-limit'
        ? Object.freeze({
            rejectedCounterId,
            blamedCounterIds: blamed.length > 0 ? Object.freeze([...blamed]) : null,
            reportedCounterId: blamedCounterId,
            rejectedCharge,
            retryAfterSeconds:
              retryAfter != null && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null,
            providerResetAt: input.rateLimit?.providerResetAt ?? null,
            limitScope: input.rateLimit?.limitScope ?? null,
            detail: input.detail ?? null,
          })
        : null,
  })
}

/** The observation's slice of one counter, or null when it carries none. */
export function counterFrom(
  observation: NormalizedObservation,
  counterId: string,
): NormalizedCounter | null {
  for (const entry of observation.counters) {
    if (entry.counterId === counterId) {
      return entry
    }
  }

  return null
}
