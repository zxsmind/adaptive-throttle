/**
 * Rejection attribution and human-readable explanation.
 *
 * This module answers the question the engine exists for: after a resource is
 * rejected, *which window* was the problem?
 *
 * The honest answer is usually "not yet", and saying so is the feature. Three
 * counters at 4, 28 and 245 all look like plausible culprits after a single
 * rejection, because a rejection only proves the true limit is at or below the
 * observed level — never which counter carries it. The engine therefore reports
 * a confidence alongside the suspicion, and reports zero confidence when the
 * observations do not separate one counter from another.
 *
 * What resolves the ambiguity is time, not cleverness — and it costs nothing,
 * because the engine is not allowed to spend a request. Once the shortest window
 * rolls over, the traffic the caller was sending anyway either succeeds above a
 * candidate's level, contradicting it, or is rejected again in a nearly empty
 * window, ruling that counter out. `nextEvidenceAt` reports when that happens; it
 * schedules nothing.
 */

import { clamp01, formatAmount } from './numeric.js'
import type { CounterAssessment, CounterEstimate, CounterSpec, RejectionAttribution } from './types.js'
import type { EffectiveLimit } from './policy.js'

/**
 * Below this confidence the engine reports `unresolved` instead of naming a
 * culprit. Naming a cause on weak evidence is worse than admitting ignorance:
 * a caller that trusts a wrong attribution will configure around a problem that
 * does not exist.
 */
export const ATTRIBUTION_MIN_CONFIDENCE = 0.35

/** A counter below this utilization is treated as plainly not the cause. */
export const SUSPICION_FLOOR_RATIO = 0.5

export interface AttributionInput {
  settledAt: string
  assessments: readonly CounterAssessment[]
  limits: ReadonlyMap<string, EffectiveLimit>
  estimates: ReadonlyMap<string, CounterEstimate>
  specs: readonly CounterSpec[]
  /** Caller-named culprits, when the provider or the caller actually said. */
  blamedCounterIds: readonly string[] | null
  retryAfterSeconds: number | null
  providerResetAt: string | null
  settledAtMs: number
  windowEndAt: ReadonlyMap<string, string | null>
}

/**
 * Attributes a rejection to a counter, or explicitly declines to.
 *
 * A caller that knows which counter the provider blamed short-circuits the whole
 * inference; that is the strongest evidence available and it is not second-
 * guessed. Otherwise suspicion comes from how full each counter was relative to
 * whatever limit is known for it, and confidence is the separation between the
 * leading counter and the one behind it.
 */
export function attributeRejection(input: AttributionInput): RejectionAttribution {
  const observations = input.assessments.map((assessment) => {
    const limit = input.limits.get(assessment.counterId)
    const estimate = input.estimates.get(assessment.counterId)
    const cleared = estimate?.status === 'cleared'
    // A candidate is a usable reference for suspicion even though it is not a
    // ceiling: "this counter is as full as we have ever seen it get" is the
    // whole signal being weighed here.
    const reference = assessment.limit ?? assessment.candidateLimit

    return {
      counterId: assessment.counterId,
      unit: assessment.unit,
      level: assessment.level,
      limit: assessment.limit,
      candidateLimit: cleared ? null : assessment.candidateLimit,
      cleared,
      confounded: assessment.confounded,
      limitSource: assessment.limitSource,
      utilization: reference != null && reference > 0 ? clamp01(assessment.level / reference) : null,
      suspicion: 0,
      state: cleared ? 'unknown-limit' : resolveState(assessment),
    }
  })

  if (observations.length === 0) {
    return unresolved(input.settledAt, input.retryAfterSeconds, input.providerResetAt, nextEvidenceAt(input))
  }

  if (input.blamedCounterIds != null && input.blamedCounterIds.length > 0) {
    return attributedByName(input, observations)
  }

  const scored = observations
    .map((observation) => {
      const cleared = input.estimates.get(observation.counterId)?.status === 'cleared'

      return {
        observation,
        // A counter already ruled out carries no weight, however full it looks.
        raw:
          cleared ||
          observation.utilization == null ||
          observation.utilization < SUSPICION_FLOOR_RATIO
            ? 0
            : observation.utilization,
      }
    })
    .sort(
      (left, right) =>
        right.raw - left.raw ||
        left.observation.counterId.localeCompare(right.observation.counterId),
    )

  const leader = scored[0]!
  const runnerUp = scored[1]

  for (const entry of scored) {
    entry.observation.suspicion = leader.raw > 0 ? clamp01(entry.raw / leader.raw) : 0
  }

  // Separation, not absolute fullness, is what makes an attribution credible: a
  // leader at 95% against a runner-up at 12% is a real signal, two counters both
  // at 95% is not.
  const separation = runnerUp && leader.raw > 0 ? 1 - runnerUp.raw / leader.raw : 1
  const evidenceWeight = resolveEvidenceWeight(leader.observation.counterId, input.estimates)
  const confidence = clamp01(Math.round(leader.raw * separation * evidenceWeight * 100) / 100)

  if (leader.raw <= 0 || confidence < ATTRIBUTION_MIN_CONFIDENCE) {
    return {
      ...unresolved(
        input.settledAt,
        input.retryAfterSeconds,
        input.providerResetAt,
        nextEvidenceAt(input),
      ),
      observations,
    }
  }

  const spec = input.specs.find((entry) => entry.counterId === leader.observation.counterId)

  return {
    settledAt: input.settledAt,
    kind: 'rate-limit',
    cause: 'resolved',
    source: 'inferred',
    causeCounterId: leader.observation.counterId,
    causeUnit: leader.observation.unit,
    causeLevel: leader.observation.level,
    causeLimit: leader.observation.limit,
    causeLimitSource: leader.observation.limitSource,
    suspectCounterId: leader.observation.counterId,
    confidence,
    observations,
    retryAt: resolveRetryAt(input),
    nextEvidenceAt: spec ? input.windowEndAt.get(spec.counterId) ?? null : null,
  }
}

function attributedByName(
  input: AttributionInput,
  observations: RejectionAttribution['observations'],
): RejectionAttribution {
  const blamed = input.blamedCounterIds!
  const lead = observations.find((observation) => observation.counterId === blamed[0]) ?? null

  for (const observation of observations) {
    observation.suspicion = blamed.includes(observation.counterId) ? 1 : 0
  }

  return {
    settledAt: input.settledAt,
    kind: 'rate-limit',
    cause: 'resolved',
    // The culprit was named rather than deduced, so the engine records that
    // difference instead of presenting a received fact as its own conclusion.
    source: 'reported',
    causeCounterId: lead?.counterId ?? blamed[0]!,
    causeUnit: lead?.unit ?? 'count',
    causeLevel: lead?.level ?? null,
    causeLimit: lead?.limit ?? null,
    causeLimitSource: lead?.limitSource ?? 'unknown',
    suspectCounterId: lead?.counterId ?? blamed[0]!,
    confidence: 0.95,
    observations,
    retryAt: resolveRetryAt(input),
    nextEvidenceAt: lead ? input.windowEndAt.get(lead.counterId) ?? null : null,
  }
}

function unresolved(
  settledAt: string,
  retryAfterSeconds: number | null,
  providerResetAt: string | null,
  evidenceAt: string | null,
): RejectionAttribution {
  return {
    settledAt,
    kind: 'rate-limit',
    cause: 'unresolved',
    source: 'inferred',
    causeCounterId: null,
    causeUnit: null,
    causeLevel: null,
    causeLimit: null,
    causeLimitSource: 'unknown',
    suspectCounterId: null,
    confidence: 0,
    observations: [],
    retryAt: resolveRetryAtFrom(retryAfterSeconds, providerResetAt, settledAt),
    nextEvidenceAt: evidenceAt,
  }
}

function resolveRetryAt(input: AttributionInput): string | null {
  return resolveRetryAtFrom(input.retryAfterSeconds, input.providerResetAt, input.settledAt)
}

function resolveRetryAtFrom(
  retryAfterSeconds: number | null,
  providerResetAt: string | null,
  settledAt: string,
): string | null {
  if (retryAfterSeconds != null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return new Date(Date.parse(settledAt) + retryAfterSeconds * 1000).toISOString()
  }

  return providerResetAt
}

/**
 * The earliest moment at which traffic the caller is sending anyway will produce
 * evidence that separates the remaining candidates: the end of the shortest
 * window whose estimate is still unconfirmed.
 *
 * This is a report, not a plan. The engine never schedules work and never asks
 * for a request to be sent; whatever traffic happens next simply carries more
 * information than the last one did.
 */
function nextEvidenceAt(input: AttributionInput): string | null {
  let earliestMs = Number.POSITIVE_INFINITY
  let earliestIso: string | null = null

  for (const spec of input.specs) {
    const estimate = input.estimates.get(spec.counterId)

    if (
      !estimate ||
      estimate.source !== 'observed' ||
      estimate.status === 'established' ||
      estimate.status === 'cleared'
    ) {
      continue
    }

    const end = input.windowEndAt.get(spec.counterId)

    if (!end) {
      continue
    }

    const endMs = Date.parse(end)

    if (Number.isFinite(endMs) && endMs < earliestMs) {
      earliestMs = endMs
      earliestIso = end
    }
  }

  return earliestIso
}

/**
 * Weight applied to a computed attribution by how trustworthy the reference
 * value was. A limit the provider declared is evidence; a bare candidate from
 * one window is a hint, and must not produce confident wording on its own.
 */
function resolveEvidenceWeight(
  counterId: string,
  estimates: ReadonlyMap<string, CounterEstimate>,
): number {
  const estimate = estimates.get(counterId)

  if (!estimate) {
    return 0
  }

  if (estimate.source === 'provider' || estimate.status === 'established') {
    return 1
  }

  return 0.5
}

function resolveState(assessment: CounterAssessment): CounterAssessment['state'] {
  return assessment.state === 'unknown-limit' && assessment.candidateLimit != null
    ? 'enforced-empty'
    : assessment.state
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Renders a rejection explanation. A bare "rate limited" is never the output:
 * every counter's real level is listed with its provenance, and an unresolved
 * attribution says so plainly instead of naming a scapegoat.
 */
export function formatRejectionAttribution(attribution: RejectionAttribution): string {
  const lines: string[] = []

  if (attribution.cause === 'unresolved') {
    lines.push(
      `Rejected at ${attribution.settledAt} — cause unresolved (confidence ${formatAmount(attribution.confidence)}).`,
    )

    if (attribution.observations.length > 0) {
      lines.push('Every counter below is a plausible cause; one rejection cannot separate them:')

      for (const observation of attribution.observations) {
        lines.push(`  ${describeObservation(observation)}`)
      }

      const confounded = attribution.observations.filter((observation) => observation.confounded)

      if (confounded.length > 0) {
        lines.push(
          `${confounded.map((observation) => observation.counterId).join(', ')} cannot be separated from this rejection: a shorter window on the same resource is still a live explanation for it, so those levels are reported but do not steer the routing.`,
        )
      }
    }

    lines.push(
      'No further traffic is needed to narrow this down: the next rejection either repeats at the same level in the same window (confirming it) or lands far below it (ruling that window out), and any accepted request above a candidate clears it.',
    )

    if (attribution.nextEvidenceAt) {
      lines.push(
        `The shortest unconfirmed window ends at ${attribution.nextEvidenceAt}, which is when the picture changes on its own.`,
      )
    }

    return lines.join('\n')
  }

  const reported = attribution.source === 'reported'

  lines.push(
    `Rejected at ${attribution.settledAt} — most likely ${attribution.causeCounterId} (${formatAmount(attribution.causeLevel)} ${attribution.causeUnit ?? 'count'}` +
      `${attribution.causeLimit != null ? ` of ${formatAmount(attribution.causeLimit)}` : ', limit unknown'}), ` +
      `confidence ${formatAmount(attribution.confidence)}${reported ? ', reported by the provider' : ', inferred'}.`,
  )

  for (const observation of attribution.observations) {
    lines.push(`  ${describeObservation(observation)}`)
  }

  return lines.join('\n')
}

function describeObservation(observation: RejectionAttribution['observations'][number]): string {
  if (observation.cleared) {
    return `${observation.counterId}: level ${formatAmount(observation.level)} ${observation.unit} (ruled out as the limiter)`
  }

  const known =
    observation.limit != null
      ? `${formatAmount(observation.limit)} via ${observation.limitSource}`
      : observation.candidateLimit != null
        ? `limit unknown (candidate ${formatAmount(observation.candidateLimit)})`
        : 'limit unknown'

  // Appended outside the parentheses so a confounded level reads as a caveat on
  // the same number rather than as a different kind of reading.
  const caveat = observation.confounded ? ' [confounded by a shorter window]' : ''

  return `${observation.counterId}: level ${formatAmount(observation.level)} ${observation.unit} (${known})${caveat}`
}

/** Renders one counter assessment with provenance, never a bare number. */
export function formatCounterAssessment(assessment: CounterAssessment): string {
  const limit =
    assessment.limit != null
      ? `${formatAmount(assessment.limit)} (${describeLimitSource(assessment.limitSource)}, ${assessment.confidence})`
      : 'unknown'

  const utilization =
    assessment.utilization != null
      ? `, ${Math.round(assessment.utilization * 100)}% used`
      : ''

  const next =
    assessment.nextResetAt != null
      ? `, resets ${assessment.nextResetAt}`
      : ''

  return `${assessment.label}: ${formatAmount(assessment.level)} ${assessment.unit} of ${limit}${utilization}${next} [${assessment.state}${assessment.confounded ? ', confounded' : ''}]`
}

function describeLimitSource(source: CounterAssessment['limitSource']): string {
  switch (source) {
    case 'operator-config':
      return 'operator config'
    case 'provider':
      return 'provider'
    case 'inferred':
      return 'inferred'
    default:
      return 'unknown'
  }
}
