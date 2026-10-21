/**
 * Decision policy: what the engine is allowed to believe, and what it does
 * about it.
 *
 * The central design choice is one table of which evidence may *block*:
 *
 * | evidence                        | off  | observe | smart        | aggressive  |
 * |---------------------------------|------|---------|--------------|-------------|
 * | operator config limit           | no   | no      | blocks       | blocks      |
 * | provider limit                  | no   | no      | blocks       | blocks      |
 * | provider remaining == 0         | yes  | no      | blocks       | blocks      |
 * | provider retry-after            | yes  | no      | blocks       | blocks      |
 * | inferred ceiling, confounded    | no   | no      | ignored      | ignored     |
 * | inferred ceiling                | no   | no      | demotes only | demotes     |
 * | failure not yet proven recovered| no   | no      | demotes      | ranks last  |
 *
 * **No mode blocks on an inference, and there is deliberately no switch that
 * would.** A learned ceiling is a conclusion, and conclusions can be wrong: the
 * failure mode of obeying one is a perfectly good resource looking permanently
 * unusable, while the failure mode of ignoring one is a single wasted request.
 * The asymmetry decides it — inference may only cost ranking. What *does* block
 * is always a fact the provider or the operator stated.
 *
 * `confounded` marks the other half of that honesty: when a shorter window on
 * the same resource still has a live estimate, a longer counter's rejection
 * level cannot be separated from it. Traffic that is deterministic reproduces
 * any counter's level, so such an estimate is reported but does not steer.
 */

import { parseTimestamp } from './clock.js'
import { clamp01 } from './numeric.js'
import { resolveTolerance } from './counters.js'
import type {
  AdviceDecision,
  CounterAssessment,
  CounterEstimate,
  CounterSpec,
  EstimateStatus,
  LimitContract,
  LimitInference,
  LimitSource,
  ObservedBoundary,
  ProviderCounterTelemetry,
  ThrottleMode,
} from './types.js'

/** Utilization at which a resource is flagged cautious rather than blocked. */
export const NEAR_LIMIT_RATIO = 0.8

export interface EffectiveLimit {
  /** The number itself, for display. Null when nothing is known. */
  value: number | null
  source: LimitSource
  /** Ceiling used for level checks. Null means "never blocks on level". */
  blockCeiling: number | null
  /**
   * The point an inferred limit uses to *steer* rather than block: the estimate
   * plus tolerance, so slightly-above-estimate traffic can still disprove it
   * instead of looking permanently near-full.
   *
   * Null for a confounded estimate, which is the whole of its suppression: a
   * level that cannot be separated from a shorter window's must not move a
   * decision. Candidates set it too — a single rejection is enough to say "this
   * key was at four a minute when it failed", and steering on that is how one
   * rejection avoids becoming many.
   */
  softCeiling: number | null
  remainingKnown: boolean
  remaining: number | null
  resetAt: string | null
  confidence: CounterAssessment['confidence']
  /** True when blocking here is backed by a fact rather than an inference. */
  authoritative: boolean
  /** True when a shorter window on the same resource still has a live estimate. */
  confounded: boolean
}

/**
 * Resolves the ceiling for one counter in strict precedence order: operator
 * config, then provider telemetry, then an observed estimate. A candidate
 * estimate never becomes `value` — reporting "the limit is 4" after a single
 * rejection states a conclusion the evidence does not support — but it does
 * become a `softCeiling`, so it can steer.
 *
 * `confounded` comes from the caller's other counters: it is a property of the
 * resource as a whole, not of that record alone.
 *
 * **`nowMs` expires the telemetry's `remaining`.** A declared `limit` is a
 * standing fact — "this account allows 600 an hour" stays true forever — but a
 * `remaining` count only describes the instant it was read, and `resetAt` is
 * exactly the engine being told when that reading goes stale. Honoring it past
 * that instant is a self-inflicted deadlock: the engine sees `remaining: 0`,
 * refuses to route, never sends, never receives a fresh reading, and so never
 * recovers. It sat on a four-hour-old `remaining: 0` and refused two keys that
 * were serving traffic happily the whole time.
 */
export function resolveEffectiveLimit(
  counter: CounterSpec,
  estimate: CounterEstimate | undefined,
  telemetry: ProviderCounterTelemetry | undefined,
  confounded = false,
  nowMs = Number.POSITIVE_INFINITY,
): EffectiveLimit {
  const resetAt = telemetry?.resetAt ?? null
  // A reset time already in the past means the count it qualified has expired.
  // Treating it as still valid would let one stale header park a key forever.
  const readingExpired = resetAt != null && parseTimestamp(resetAt) <= nowMs
  const remainingKnown = telemetry?.remaining != null && !readingExpired
  const remaining = remainingKnown ? telemetry!.remaining! : null
  const unknownBase = { remainingKnown, remaining, resetAt }

  if (counter.limit != null) {
    return {
      ...unknownBase,
      value: counter.limit,
      source: 'operator-config',
      blockCeiling: counter.limit,
      softCeiling: counter.limit,
      confidence: 'authoritative',
      authoritative: true,
      // Configuration is a statement about this counter only; a sibling window
      // says nothing about it.
      confounded: false,
    }
  }

  const declared = telemetry?.limit

  if (declared != null) {
    return {
      ...unknownBase,
      value: declared,
      source: 'provider',
      blockCeiling: declared,
      softCeiling: declared,
      confidence: 'authoritative',
      authoritative: true,
      confounded: false,
    }
  }

  if (estimate?.source === 'provider' && estimate.estimatedLimit != null) {
    return {
      ...unknownBase,
      value: estimate.estimatedLimit,
      source: 'provider',
      blockCeiling: estimate.estimatedLimit,
      softCeiling: estimate.estimatedLimit,
      confidence: 'authoritative',
      authoritative: true,
      confounded: false,
    }
  }

  if (
    counter.kind === 'window' &&
    estimate?.estimatedLimit != null &&
    estimate.status !== 'cleared' &&
    estimate.status !== 'unobserved' &&
    // A contradicted value was set by traffic that *succeeded*, so it is a
    // lower bound on the limit: accepted work proves the ceiling is at least
    // this high, never that it is this low. Lower bounds do not cap anything,
    // so they inform the display and stay out of the decision until the record
    // re-establishes from a rejection.
    estimate.status !== 'contradicted'
  ) {
    const point = estimate.estimatedLimit
    const established = estimate.status === 'established'
    // Two separate questions. May the engine *name* this as the limit? Only if
    // it reproduced and is not confounded with a shorter window. May it *steer*
    // on it? Also for a candidate — one rejection is enough to say "this key was
    // at four a minute when it failed", and steering on that is how one
    // rejection avoids becoming many — but never while confounded.
    const steers = !confounded
    const stated = established && steers

    return {
      ...unknownBase,
      value: stated ? point : null,
      // `limitSource` describes `limit`, so with no limit stated there is no
      // source to name: the hypothesis is already carried by `candidateLimit`
      // and `confidence`, and calling it `inferred` while `limit` is null would
      // read as "the limit was inferred" — the one claim the engine refuses.
      source: stated ? 'inferred' : 'unknown',
      // Inference never blocks, in any mode — see the table above.
      blockCeiling: null,
      softCeiling: steers ? point + resolveTolerance(counter, point) : null,
      confidence: stated ? 'established' : 'candidate',
      authoritative: false,
      confounded,
    }
  }

  return {
    ...unknownBase,
    // Nothing the engine may act on. A candidate number is deliberately not
    // promoted into `value`: after one rejection at level 4, calling 4 "the
    // limit" would state a conclusion the evidence does not support. It stays
    // visible through `confidence: 'candidate'` and `candidateLimit`.
    value: null,
    source: 'unknown',
    blockCeiling: null,
    softCeiling: null,
    confidence: resolveConfidence(estimate),
    authoritative: false,
    confounded: false,
  }
}

function resolveConfidence(estimate: CounterEstimate | undefined): CounterAssessment['confidence'] {
  if (!estimate) {
    return 'none'
  }

  if (estimate.source === 'provider') {
    return 'authoritative'
  }

  switch (estimate.status) {
    case 'established':
      return 'established'
    case 'candidate':
    case 'contradicted':
      return 'candidate'
    case 'cleared':
      // Ruled out as the limiter: it has no standing and must not be presented
      // as a plausible cause.
      return 'none'
    default:
      return 'none'
  }
}

export function computeUtilization(level: number, limit: number | null): number | null {
  if (limit == null || limit <= 0) {
    return null
  }

  return clamp01(level / limit)
}

/**
 * May this evidence hard-block on measured level?
 *
 * `authoritative` ceilings block even in `off`: a provider that already sent its
 * limit is stating a fact, and sending anyway burns a request to learn nothing.
 * A learned ceiling never blocks — not in `smart`, not in `aggressive`, not in
 * any mode that could be added later. Only facts withhold.
 */
export function mayBlockOnLevel(limit: EffectiveLimit, mode: ThrottleMode): boolean {
  if (mode === 'observe') {
    return false
  }

  return limit.authoritative
}

/** A provider reporting zero remaining has stated exhaustion outright. */
export function remainingProvesExhaustion(limit: EffectiveLimit): boolean {
  return limit.remainingKnown && (limit.remaining ?? 0) <= 0
}

/**
 * Remaining share of one counter in [0, 1], used for ranking.
 *
 * An unknown limit contributes a neutral 0.5 rather than a penalty: not knowing
 * a limit is not evidence of exhaustion, and ranking a resource down for its
 * ignorance would quietly starve exactly the resources whose limits the provider
 * never discloses.
 *
 * A learned ceiling contributes through its `softCeiling`, so a resource that is
 * close to where it was rejected is ranked below an untouched one. A confounded
 * ceiling contributes nothing at all: `softCeiling` is null, so it falls back to
 * the same neutral 0.5 as an unmeasured counter. That asymmetry is deliberate —
 * the whole reason `confounded` exists is that a level which reproduces only
 * because traffic is deterministic must not move a routing decision.
 */
export function remainingShare(level: number, limit: EffectiveLimit): number {
  if (limit.remainingKnown && limit.remaining != null) {
    const ceiling = limit.value ?? limit.remaining
    return ceiling > 0 ? clamp01(limit.remaining / ceiling) : 0
  }

  const ceiling = limit.authoritative ? limit.value : limit.softCeiling

  if (ceiling == null || ceiling <= 0) {
    return 0.5
  }

  return clamp01(1 - level / ceiling)
}

export function isNearLimit(level: number, limit: EffectiveLimit): boolean {
  if (limit.softCeiling == null || limit.softCeiling <= 0) {
    return false
  }

  return level >= limit.softCeiling * NEAR_LIMIT_RATIO
}

export function assessCounter(input: {
  counter: CounterSpec
  limit: EffectiveLimit
  estimate: CounterEstimate | undefined
  level: number
  projectedLevel: number
  mode: ThrottleMode
  nextResetAt: string | null
  label: string
  /**
   * The shadow ledger's boundary finding for this counter, when the engine
   * holds a ledger for the resource. Carried through untouched and read by
   * nothing in this module except the contract selector below: the verdict
   * labels the report, and every number routing acts on is computed above,
   * before this field is ever looked at.
   */
  boundary?: ObservedBoundary | null
  /**
   * Experiment knob: when true, a learned ceiling may not raise the cautious
   * state. Reported values are unaffected — `softCeiling` still carries the
   * number the ranking would have used — so a report and a decision stay
   * separate even while an experiment is running.
   */
  ignoreSteering?: boolean
}): CounterAssessment {
  const { counter, limit, estimate, level, projectedLevel, mode, nextResetAt, label } = input
  const boundary = input.boundary ?? null
  const ceiling = mayBlockOnLevel(limit, mode) ? limit.blockCeiling : null
  // Displayed utilization is computed against the *stated* ceiling only, for the
  // same reason as `limit` itself: a percentage read off an unstated hypothesis
  // is the same confusion in a friendlier font.
  const utilization = limit.authoritative ? computeUtilization(level, limit.value) : null

  let state: CounterAssessment['state']

  if (remainingProvesExhaustion(limit) || (ceiling != null && projectedLevel > ceiling)) {
    state = 'blocked'
  } else if (ceiling != null && projectedLevel >= ceiling) {
    // Exactly at the ceiling: the operation fits the last available slot. Worth
    // showing, but not a warning — nothing has to be given up.
    state = 'enforced-full'
  } else if (isNearLimit(projectedLevel, limit) && !input.ignoreSteering) {
    // Reached through `softCeiling`, so a candidate gets here too: being at the
    // level where this key was last rejected is worth a caution whether or not
    // the rejection has been repeated enough to be called a limit.
    state = 'near-limit'
  } else if (ceiling != null) {
    state = 'enforced-empty'
  } else {
    state = 'unknown-limit'
  }

  return {
    counterId: counter.counterId,
    label,
    unit: counter.unit,
    state,
    level,
    // The contract is the whole point of this field: only a verified ceiling
    // may be repeated as "the limit". A ceiling that merely reproduced — three
    // windows, five windows, any number — is carried in `inference` instead,
    // where no caller can mistake it for a fact. Routing never reads this
    // field; it acts on `blockCeiling` and `softCeiling`, which are untouched.
    limit: limit.authoritative ? limit.value : null,
    // `limitSource` names where the *inference* came from, not a stated ceiling:
    // 'inferred' here means "the engine worked this out itself", which is
    // provenance of a hypothesis, not a claim.
    limitSource: limit.source,
    contract: selectContract(limit, estimate, boundary?.verdict ?? null),
    /**
     * The shadow boundary finding, attached by the caller and never computed
     * here. It travels beside `inference`, never merged into it: the legacy
     * estimate and the OR-constraint derivation are two engines' two readings
     * of the same traffic, and either may outlive the other.
     */
    boundary,
    inference: describeInference(estimate),
    candidateLimit: limit.authoritative ? null : (estimate?.estimatedLimit ?? null),
    confounded: limit.confounded,
    softCeiling: limit.softCeiling,
    // Authoritative means the ceiling came from the operator or the provider,
    // so anything else that scored is a number the engine inferred.
    inferred: !limit.authoritative && limit.softCeiling != null,
    utilization,
    headroom: limit.authoritative && limit.value != null ? limit.value - projectedLevel : null,
    confidence: limit.confidence,
    nextResetAt: limit.resetAt ?? nextResetAt,
    blocking: state === 'blocked',
  }
}

/**
 * Which contract a live assessment is reported under. `authoritative` wins —
 * a stated ceiling is a fact regardless of what either engine inferred. A
 * shadow pin comes next: `proven` and `boundary` alike report as
 * `observedBoundary`, because even a provider-named pin derives its *number*
 * from traffic, and the provider states numbers through telemetry, not names.
 * Two traffic shapes agreeing on a value is a consistency signal, not a quota
 * claim — a shared pool or a hidden quota survives a change of load just as
 * well — so agreement never promotes to `modelProven` on its own. Anything
 * the shadow does not pin falls through to the legacy inference.
 *
 * Report-only: routing never reads the result. It acts on `blockCeiling` and
 * `softCeiling`, which are computed before this function is ever called.
 */
function selectContract(
  limit: EffectiveLimit,
  estimate: CounterEstimate | undefined,
  shadowVerdict: 'proven' | 'boundary' | 'contested' | 'unresolved' | null,
): LimitContract {
  if (limit.authoritative) {
    return 'authoritative'
  }

  if (shadowVerdict === 'proven' || shadowVerdict === 'boundary') {
    return 'observedBoundary'
  }

  return estimateContract(estimate)
}

/**
 * The legacy engine's contract state. `modelProven` is a valid contract state
 * with no in-engine producer yet: nothing the engine observes promotes a
 * derivation into a quota claim on its own. `observedBoundary` is produced by
 * the shadow wiring above.
 */
function estimateContract(estimate: CounterEstimate | undefined): LimitContract {
  if (estimate?.estimatedLimit == null) {
    return 'unresolved'
  }

  return 'legacyEstimate'
}

function describeInference(estimate: CounterEstimate | undefined): LimitInference {
  const estimatedLimit = estimate?.estimatedLimit ?? null
  const status: EstimateStatus = estimate?.status ?? 'unobserved'
  const windows = estimate?.supportingWindowCount ?? 0

  const evidence =
    estimatedLimit == null
      ? 'no ceiling was inferred'
      : `${windows} independent window(s) at level ${formatLevel(estimatedLimit)}`

  return { estimatedLimit, status, windows, evidence }
}

function formatLevel(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/**
 * How much a resource that has not succeeded since its last failure is scaled
 * down in the ranking. Multiplicative rather than subtractive so the ordering
 * *among* penalised resources is preserved: a nearly-full key that recently
 * failed still ranks below a failed-but-empty one.
 *
 * The factor is chosen so a failed resource loses to a neutral one: an untouched
 * resource scores 0.5, and no resource scores above 1.0, so anything below 0.5
 * guarantees the failure decides the comparison. That is the whole point — after
 * a rejection the engine does not know which window was at fault, but it does
 * know the key that did not fail.
 */
export const UNPROVEN_FAILURE_SCORE_FACTOR = 0.4

/**
 * True while a failure stands unrecovered: the resource failed more recently
 * than it last succeeded, and the memory has not expired.
 *
 * The primary release is evidence — one accepted request clears it outright,
 * because a key that works again is not a key to avoid. The expiry horizon (see
 * `DEFAULT_FAILURE_MEMORY_MS`) exists only for the resource that never gets that
 * far. Without it the memory would be self-sealing: the engine stops routing to
 * the key, the key never succeeds, and it is never tried again, all from a
 * single rejection. A penalty that only the penalised party can lift is a
 * deadlock, not a policy.
 *
 * Steering only: `off` and `observe` never act on it.
 */
export function hasUnprovenFailure(
  timestamps: {
    lastFailureAt: string | null
    lastUsedAt: string | null
    lastHealthOutcome?: 'success' | 'failure' | null
  },
  nowMs: number,
  memoryMs: number,
): boolean {
  const failureMs = parseTimestamp(timestamps.lastFailureAt)

  if (failureMs <= 0) {
    return false
  }

  const usedMs = parseTimestamp(timestamps.lastUsedAt)

  // Recovery is the primary release: a success strictly after the failure ends
  // the memory. When both carry the same millisecond — which a burst settles
  // all the time — only the recorded outcome separates them, so a key that
  // failed at that instant must not read as recovered the moment it failed.
  if (usedMs > failureMs || (usedMs === failureMs && timestamps.lastHealthOutcome !== 'failure')) {
    return false
  }

  return nowMs < failureMs + Math.max(0, memoryMs)
}

/**
 * Ranking score in [0, 1]: the mean remaining share across the counters that
 * have a ceiling to be measured against, nudged by operator priority. Higher is
 * better.
 *
 * **A counter the engine knows nothing about is left out of the mean, not
 * averaged into it as a neutral 0.5.** Zero information is not a measurement,
 * and averaging it in would let a resource's score depend on how many counters
 * the operator bothered to declare rather than on anything the provider or the
 * traffic revealed: two keys with byte-identical evidence about their minute
 * window would rank differently purely because one of them also declared an hour
 * and a day. Under the old rule a key declaring ten counters could never outrank
 * a key declaring one, which is an artefact of configuration, not health.
 *
 * The blind spot this accepts is deliberate: a counter that is *loaded* but
 * unknown is not graded either. The engine cannot tell whether 200 of an unknown
 * daily allowance is fine or catastrophic, and inventing a decay curve would be
 * exactly the fabricated precision this module refuses everywhere else. So the
 * counter stays neutral until a rejection gives it a ceiling — and that happens
 * on its own, because the next rejection at that window is the evidence. This
 * ignorance is temporary by construction, not permanent.
 *
 * With nothing to measure at all the resource scores the neutral 0.5, so an
 * unmeasured resource competes on par with a half-used one instead of losing by
 * default. Priority is a tie-break, not an override, so a preferred resource
 * still loses to a clearly healthier one.
 */
export function computeResourceScore(
  entries: ReadonlyArray<{ level: number; limit: EffectiveLimit }>,
  priority: number | null | undefined,
): number {
  // A counter counts only when something can be compared against it: a ceiling
  // the engine was told (authoritative) or one it inferred (`softCeiling`, which
  // covers both established limits and live candidates).
  const measurable = entries.filter(
    (entry) => entry.limit.authoritative || entry.limit.softCeiling != null,
  )
  const tieBreak = priority != null && Number.isFinite(priority) ? clamp01(priority / 100) * 0.05 : 0

  if (measurable.length === 0) {
    return clamp01(0.5 + tieBreak)
  }

  const mean =
    measurable.reduce((total, entry) => total + remainingShare(entry.level, entry.limit), 0) /
    measurable.length

  return clamp01(mean + tieBreak)
}

/**
 * Per-resource decision from its assessments, ignoring time-based cooldowns
 * (which the engine resolves separately because they carry their own deadline).
 *
 * A demotion in `smart` mode still shows up here as `near-limit` rather than
 * `blocked`: the resource remains usable, it just loses the ranking. That is the
 * whole point of the default mode.
 */
export function decideFromAssessments(
  assessments: readonly CounterAssessment[],
  mode: ThrottleMode,
): { decision: AdviceDecision; reason: string } {
  const blocked = assessments.filter((assessment) => assessment.blocking)

  if (mode === 'observe') {
    if (blocked.length > 0) {
      return {
        decision: 'send-cautious',
        reason: `observe mode: ${blocked[0]!.label} reports a breach; nothing is withheld`,
      }
    }

    return { decision: 'send', reason: 'observe mode: measuring only' }
  }

  if (blocked.length > 0) {
    const labels = blocked.map((assessment) => assessment.label).join(', ')
    const inferred = blocked.some((assessment) => assessment.limitSource === 'inferred')

    return {
      decision: 'defer',
      reason: inferred
        ? `${labels} would exceed a learned ceiling; retrying after the window rolls is expected to succeed`
        : `${labels} would exceed its ceiling for this operation`,
    }
  }

  const cautious = assessments.filter((assessment) => assessment.state === 'near-limit')

  if (cautious.length > 0 && mode !== 'off') {
    return {
      decision: 'send-cautious',
      reason: `${cautious.map((assessment) => assessment.label).join(', ')} is near its ceiling`,
    }
  }

  if (assessments.length === 0) {
    return { decision: 'send', reason: 'no counters are declared, so there is nothing to measure' }
  }

  return { decision: 'send', reason: 'no counter reports a limit within reach' }
}
