/**
 * Adaptive Throttle V2 — canonical types.
 *
 * The engine is unit-agnostic and limit-agnostic by construction. Callers
 * declare an unbounded set of counters (window length, unit, alignment) at
 * registration time; the engine keeps real local measurements per counter,
 * learns provider limits from real rejections, and produces a routing
 * decision with its evidence attached.
 *
 * Static configuration (which resources exist, what their counters are, known
 * limits, enabled state) is supplied by the caller at decision time and is
 * never part of the runtime snapshot. The snapshot below is the single
 * decision authority; every other representation must be a read-only
 * projection of it.
 */

export const THROTTLE_SNAPSHOT_VERSION = 1

// ---------------------------------------------------------------------------
// Units and counter kinds
// ---------------------------------------------------------------------------

/**
 * Units are open-ended strings. The known list exists only for editor
 * completion — any unit a caller needs is valid, including domain-specific
 * ones (`messages`, `emails`, `gpu-seconds`, `credits`).
 */
export const KNOWN_UNITS = [
  'count',
  'bytes',
  'cost-usd',
  'points',
  'jobs',
  'items',
  'seconds',
] as const

export type KnownUnit = (typeof KNOWN_UNITS)[number]

export type CounterUnit = KnownUnit | (string & {})

/**
 * - `window`: a rate over a time window (requests per minute, bytes per hour,
 *   credits per day). This is the kind that can be *learned* from rejections.
 * - `gauge`: an instantaneous level (in-flight requests, open connections,
 *   queue depth, remaining seats). Rejections caused by a gauge prove only a
 *   lower bound, so gauges are never inferred — they act on config or
 *   provider-declared values only.
 */
/**
 * What kind of level a counter measures.
 *
 * - `window`: usage over a time window — fixed (epoch-aligned buckets) or
 *   sliding (the trailing window). Most providers.
 * - `bucket`: a token bucket / leaky bucket — usage that *decays* at a fixed
 *   rate rather than expiring at a boundary. The distinction is not cosmetic: a
 *   60s window that empties frees nothing until the oldest charge ages out,
 *   while a bucket frees a slot as soon as it refills. Measured against the
 *   Groq API, a refusal said `retry-after: 2s` and the next success came 2.5s
 *   later, while the 30 requests it counted spanned up to 64s — which no 60s
 *   window can do and a 30-token bucket at 0.5/s does exactly.
 * - `gauge`: an instantaneous level (in-flight requests, open connections).
 */
export type CounterKind = 'window' | 'bucket' | 'gauge'

export type WindowAlignment = 'fixed' | 'sliding'

export interface CounterWindowSpec {
  windowMs: number
  /**
   * `fixed` counts inside wall-clock aligned buckets (what most providers do).
   * `sliding` counts everything inside the trailing window. Both are exact for
   * the estimate machine: only the bucket resolution is approximate, and the
   * tolerance band absorbs that.
   */
  alignment: WindowAlignment
  /**
   * Marks a daily quota: the window resets on the provider's calendar day
   * rather than on a fixed epoch multiple, and the window key follows that
   * boundary so two rejections on either side of a reset count as independent
   * windows. Ignored unless `windowMs` is one day.
   */
  dayAligned?: boolean | null
  /**
   * Fallback reset timezone for a `dayAligned` counter. Provider telemetry
   * overrides it whenever the provider discloses its own zone.
   */
  timeZone?: string | null
  /** Ledger resolution. Defaults to `windowMs` for fixed, `windowMs / 10` for sliding. */
  bucketMs?: number | null
}

export interface ToleranceSpec {
  /** Share of the estimate that counts as "same limit". Defaults to 0.1. */
  ratio?: number | null
  /** Absolute share that counts as "same limit". Defaults to 1 for `count`. */
  floor?: number | null
}

export interface CounterSpec {
  counterId: string
  kind: CounterKind
  unit: CounterUnit
  /** Required for `window` counters; must be null/absent for `gauge`. */
  window?: CounterWindowSpec | null
  /**
   * For a `bucket` counter: the refill period, i.e. how long the bucket takes to
   * refill from empty to one full capacity. The refill *rate* is
   * `limit / windowMs`, so a bucket with no known limit decays at the rate of
   * its current estimate — which is honest: until the ceiling is known, the
   * shape of the decay is not known either. Required for `bucket`.
   */
  bucket?: { windowMs: number } | null
  /** Charge applied when a settlement does not name this counter explicitly. */
  defaultCharge?: number | null
  /**
   * Operator-declared limit. `null` means unknown and learnable. A known limit
   * blocks at its exact value in every mode.
   */
  limit?: number | null
  /** When false the counter is measured and explained but never blocks. Default true. */
  enforce?: boolean
  tolerance?: ToleranceSpec | null
  label?: string | null
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface ResourceSpec {
  resourceId: string
  counters: CounterSpec[]
  /** Disabled resources are never advised, regardless of any other evidence. */
  enabled?: boolean
  /**
   * Resources sharing a `quotaGroupId` are limited by one provider-side quota
   * (an account-level or project-level allowance). A rejection on one member
   * is treated as evidence for the whole group.
   */
  quotaGroupId?: string | null
  /** Operator tie-break hint; higher wins when everything else is equal. */
  priority?: number | null
  label?: string | null
}

export interface ResourceRegistration {
  resources: ResourceSpec[]
  mode?: ThrottleMode | null
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/**
 * - `off`: measure only. Inferred ceilings never influence advice. Explicit
 *   provider retry-after facts are still honoured — ignoring a fact the
 *   provider already sent us would only waste requests.
 * - `observe`: measure and produce full advice, but the decision is always
 *   "proceed". Nothing is ever withheld; the advice exists to be read.
 * - `smart` (default): inferred ceilings and recent failures *steer* — they
 *   demote a resource and mark it cautious, they never hard-block. Only
 *   operator config, provider facts, and provider-reported zero remaining
 *   block. Safe by construction: a wrong inference costs ranking, not
 *   availability.
 * - `aggressive`: everything `smart` does, plus a resource that failed and has
 *   not succeeded since is ranked below every healthy one. It stays eligible —
 *   when it is the only option it is still used — so this mode sheds load
 *   across keys without ever withholding the last key there is.
 *
 * **No mode blocks on an inference.** An estimate is a conclusion, and a
 * conclusion that turns out to be wrong must cost ranking rather than
 * availability: that is the difference between a resource that is merely
 * deprioritised and one that looks permanently unusable. There is no setting
 * that can escalate an inference into a block, by design.
 */
export type ThrottleMode = 'off' | 'observe' | 'smart' | 'aggressive'

export const THROTTLE_MODES: readonly ThrottleMode[] = ['off', 'observe', 'smart', 'aggressive']

export const DEFAULT_THROTTLE_MODE: ThrottleMode = 'smart'

// ---------------------------------------------------------------------------
// Runtime ledger
// ---------------------------------------------------------------------------

export interface CounterBucket {
  /** Bucket start, epoch milliseconds. */
  start: number
  amount: number
}

export interface CounterLedgerState {
  counterId: string
  kind: CounterKind
  unit: CounterUnit
  buckets: CounterBucket[]
  /** Instantaneous level; the only stored value for `gauge` counters. */
  gaugeLevel: number
  /**
   * Outstanding usage on a `bucket` counter, and the instant it was last
   * brought up to date. The level decays from `bucketDebt` at the counter's
   * refill rate, so only the debt and its timestamp need storing.
   */
  bucketDebt: number
  bucketChargedAt: number | null
  totalCharged: number
  lastChargeAt: string | null
}

// ---------------------------------------------------------------------------
// Estimate state machine
// ---------------------------------------------------------------------------

/**
 * Learning state of one counter:
 * - `unobserved`: no rejections and no provider value.
 * - `candidate`: a level was rejected; may explain the past, never constrains.
 * - `established`: the same level was rejected in three independent windows.
 *   This is *reproducibility*, not attribution — a deterministic traffic
 *   pattern reproduces any counter's level. Whether it may steer is decided
 *   separately by `CounterAssessment.confounded`, and it never blocks.
 * - `contradicted`: real usage exceeded the inferred ceiling, so it was revised.
 * - `cleared`: rejections landed far *below* the inferred ceiling, so this
 *   counter has been ruled out as the limiter.
 *
 * `cleared` is what lets the engine narrow a rejection down without ever
 * spending a request of its own: ordinary traffic rejects a resource again in a
 * window that is nearly empty, and that empty rejection eliminates the counter.
 */
export type EstimateStatus = 'unobserved' | 'candidate' | 'established' | 'contradicted' | 'cleared'

export type EstimateSource = 'provider' | 'observed'

/**
 * One real measurement of "the provider rejected an operation after N accepted
 * units were still inside this quota window". The window key identifies the
 * independent quota window; repeated, mutually consistent observations in
 * distinct windows are what promote a candidate estimate to established.
 */
export interface BoundarySample {
  counterId: string
  occurredAt: string
  windowKey: string
  observedValue: number
  /**
   * What this counter would have reached had the rejected request been accepted,
   * i.e. the level before it plus that request's own charge on this counter.
   *
   * Stored separately from `observedValue` because the two differ whenever the
   * request is larger than one unit, and the difference is what makes a ceiling
   * provable: the limit lies in `[proven lower bound, attemptedValue)`. For a
   * `count` counter the interval is one unit wide and pins the number; for a
   * token or byte counter it can be hundreds of thousands wide, and a wide
   * interval pins nothing.
   */
  attemptedValue: number
  unit: CounterUnit
  retryAfterSeconds: number | null
  providerResetAt: string | null
}

export interface CounterEstimate {
  counterId: string
  status: EstimateStatus
  source: EstimateSource | null
  estimatedLimit: number | null
  /**
   * Min/max across retained rejection samples. Describes how much the samples
   * agree with each other, not what the limit provably is — see
   * `provenLowerBound` for the latter.
   */
  lowerBound: number | null
  upperBound: number | null
  /**
   * The highest level this counter has ever been *accepted* at, so the limit is
   * provably at least this. Unlike `lowerBound` this is not derived from
   * rejections: accepted traffic is proof, and nothing observed later can make
   * it untrue.
   *
   * It exists to stop the engine stating a ceiling the traffic already refuted.
   * An estimate below it is not a low-confidence guess, it is a contradiction,
   * and it is reported as one.
   */
  provenLowerBound: number | null
  samples: BoundarySample[]
  supportingWindowCount: number
  contradictingObservationCount: number
  confidence: number
  lastObservedAt: string | null
  lastRateLimitAt: string | null
  updatedAt: string | null
}

// ---------------------------------------------------------------------------
// Provider telemetry
// ---------------------------------------------------------------------------

export interface ProviderCounterSignal {
  counterId: string
  limit?: number | null
  /**
   * Remaining allowance for the current provider window. `null` is unknown and
   * is never treated as zero, never as exhaustion.
   */
  remaining?: number | null
  resetAt?: string | null
  resetTimeZone?: string | null
}

export interface ProviderSignal {
  observedAt?: string | null
  source: string
  counters?: ProviderCounterSignal[] | null
  retryAfterSeconds?: number | null
}

// ---------------------------------------------------------------------------
// Cooldowns
// ---------------------------------------------------------------------------

export type CooldownKind =
  | 'rate-limit'
  | 'quota-exhausted'
  | 'credential-rejected'
  | 'transport-failure'
  | 'resource-missing'
  | 'manual'

export type CooldownScope = 'resource' | 'quota-group'

export type CooldownSource =
  | 'provider-retry-after'
  | 'provider-reset'
  | 'window-boundary'
  | 'operator-config'
  | 'typed-failure-policy'
  | 'learned-estimate'

export interface Cooldown {
  id: string
  kind: CooldownKind
  counterId: string | null
  scope: CooldownScope
  blockedUntil: string
  setAt: string
  source: CooldownSource
  detail: string
  /**
   * True when `blockedUntil` came from a provider fact or operator config rather
   * than a policy guess. Only authoritative cooldowns may hard-block in `smart`
   * mode; learned ones demote.
   */
  authoritative: boolean
}

// ---------------------------------------------------------------------------
// Resource runtime
// ---------------------------------------------------------------------------

export type ThrottleEventKind =
  | 'advised'
  | 'success'
  | 'rate-limit'
  | 'credential-rejected'
  | 'transport-failure'
  | 'resource-missing'
  | 'recovered'

export interface ThrottleEvent {
  id: string
  kind: ThrottleEventKind
  createdAt: string
  detail: string
  nextEligibleAt: string | null
}

export interface ResourceRuntime {
  resourceId: string
  counters: Record<string, CounterLedgerState>
  estimates: Record<string, CounterEstimate>
  providerTelemetry: Record<string, ProviderCounterTelemetry>
  providerRetryAfter: ProviderRetryAfter | null
  cooldowns: Cooldown[]
  lastAdvisedAt: string | null
  lastDecision: AdviceDecision | null
  lastUsedAt: string | null
  /**
   * When this resource last failed. Read together with `lastUsedAt`: while
   * `lastFailureAt` is newer, no success has followed the failure and the
   * engine stops preferring this resource. The memory is released by evidence
   * (a success) or by its expiry horizon, never by a deadline alone — a clock
   * running out does not make a broken key trustworthy.
   */
  lastFailureAt: string | null
  /**
   * Which outcome stamped `lastUsedAt`/`lastFailureAt` last, when both carry the
   * same instant. Without it, a success and a refusal settled in the same
   * millisecond are indistinguishable, and the tie is resolved by whichever
   * comparison the reader happens to make — so a key that failed at the exact
   * instant it last succeeded could read as recovered the moment it failed.
   */
  lastHealthOutcome: 'success' | 'failure' | null
  events: ThrottleEvent[]
}

export interface ProviderCounterTelemetry {
  counterId: string
  limit: number | null
  remaining: number | null
  resetAt: string | null
  resetTimeZone: string | null
  observedAt: string
  source: string
}

export interface ProviderRetryAfter {
  seconds: number
  observedAt: string
  source: string
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface ThrottleSnapshot {
  /** Optional so pre-pacing snapshots remain readable. */
  pacing?: import('./pacing.js').PacingSnapshot
  version: typeof THROTTLE_SNAPSHOT_VERSION
  mode: ThrottleMode
  resources: Record<string, ResourceRuntime>
  quotaGroups: Record<string, QuotaGroupRuntime>
  events: ThrottleEvent[]
}

export interface QuotaGroupRuntime {
  quotaGroupId: string
  cooldowns: Cooldown[]
  lastRateLimitAt: string | null
}

/**
 * The shadow evidence report attached to a rejection: what the OR-constraint
 * engine can say about this resource from everything observed so far.
 *
 * Every value here is traceable: a proof names its clauses, a clause names its
 * instant and window, and an abstention names its reason. Nothing in this
 * object is consumed by routing — it is the observation deck, not the helm.
 * (Unions mirror `CounterVerdict`/`UnresolvedReason` in hypotheses.ts without
 * importing it, so this file stays dependency-free.)
 */
export interface HypothesisReport {
  resourceId: string
  observedAt: string
  verdicts: Record<string, 'proven' | 'boundary' | 'contested' | 'unresolved'>
  reasons: Record<string, 'insufficient-evidence' | 'open-cause-set' | 'model-conflict' | 'contested-across-shapes'>
  proofs: Array<{
    counterId: string
    ceiling: number
    verdict: 'proven' | 'boundary' | 'contested'
    shapes: string[]
    dependsOn: string[]
    entailment: string
    fromClauses: string[]
    windows: string[]
  }>
  clauses: Array<{
    id: string
    at: string
    scope: 'reported' | 'closed' | 'assumed' | 'open'
    candidates: string[]
    resolved: boolean
    soleCandidate: string | null
    superseded: boolean
  }>
  /** Clause ids with zero or several surviving candidates — honest abstention. */
  abstained: string[]
  regimeChanges: Record<string, number>
  scopeViolations: number
}

/** Which window a rejection is attributed to — the question the engine answers. */
export interface RejectionAttribution {
  settledAt: string
  kind: 'rate-limit'
  /**
   * `resolved` only when one counter separates clearly enough from the others to
   * be named. A single rejection normally cannot do that, and saying
   * `unresolved` is a result, not a failure.
   */
  cause: 'resolved' | 'unresolved'
  /**
   * How the culprit was chosen. `reported` means the provider or the caller named
   * it and the engine did not compute it; `inferred` means the engine weighed the
   * counters itself. The distinction matters because a reported cause is a fact
   * and an inferred one is a conclusion.
   */
  source: 'inferred' | 'reported'
  causeCounterId: string | null
  causeUnit: CounterUnit | null
  causeLevel: number | null
  causeLimit: number | null
  causeLimitSource: LimitSource
  suspectCounterId: string | null
  confidence: number
  /**
   * The shadow evidence report for this resource at this instant: which OR
   * clauses are open, what each still allows, and what — if anything — the
   * constraints force. Read-only by construction: nothing in `decide()` or the
   * policy layer reads it, so it can inform an operator or a future integration
   * without moving a single request. Null when the engine has observed nothing
   * for this resource yet.
   */
  hypotheses?: HypothesisReport | null
  /** Every counter's level at rejection, in declaration order. */
  observations: Array<{
    counterId: string
    unit: CounterUnit
    level: number
    limit: number | null
    candidateLimit: number | null
    /** Ruled out as the limiter by a rejection in a nearly empty window. */
    cleared: boolean
    /**
     * True when a shorter window on the same resource still has a live
     * estimate. A rejection lands in every window at once, so while a shorter
     * candidate remains, this counter's level cannot be told apart from it —
     * the number may be reproducible and still mean nothing.
     */
    confounded: boolean
    limitSource: LimitSource
    utilization: number | null
    suspicion: number
    state: CounterState
  }>
  retryAt: string | null
  /**
   * When ordinary traffic will next produce evidence that separates the
   * candidates. Purely informational: the engine never schedules anything and
   * never asks for a request to be sent.
   */
  nextEvidenceAt: string | null
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type AdviceDecision = 'send' | 'send-cautious' | 'defer' | 'hold'

export type LimitSource = 'operator-config' | 'provider' | 'inferred' | 'unknown'

/**
 * What a reported ceiling is allowed to claim. This is the contract between the
 * engine and everyone who reads its numbers, and it exists because one class of
 * number kept masquerading as another: a ceiling that repeated three times is
 * not the provider's quota, and presenting it as one is a lie even when the
 * number happens to be right.
 *
 * - `authoritative`: the operator or the provider stated it. A fact. The only
 *   value that may be used as a hard ceiling.
 * - `modelProven`: an OR-constraint engine derives it from evidence, under
 *   named, checkable assumptions (completeness, independence, accounting,
 *   window model). A conclusion, and it travels with the assumptions it rests
 *   on.
 * - `observedBoundary`: this traffic could not pass this level. True of the
 *   traffic seen, not of the quota. Never a claim about the provider.
 * - `legacyEstimate`: `estimates.ts` inference — repeated, bracketed, possibly
 *   useful — but never entailed. It is carried openly and used cautiously, and
 *   it may never be promoted into a limit by repetition alone.
 * - `unresolved`: nothing to say.
 */
export type LimitContract =
  | 'authoritative'
  | 'modelProven'
  | 'observedBoundary'
  | 'legacyEstimate'
  | 'unresolved'

/**
 * The legacy engine's inference, carried explicitly and never as a limit.
 *
 * Every number a caller repeats becomes, in someone else's incident review, "the
 * limit the docs said". So the inference ships with its own status and the
 * sentence that justifies it — never merged into `limit`, where it would be
 * indistinguishable from a ceiling somebody actually declared.
 */
export interface LimitInference {
  /** The number the legacy engine inferred, if it inferred one. */
  estimatedLimit: number | null
  /** The estimate's own lifecycle state: what stage of evidence it reached. */
  status: EstimateStatus
  /** Independent windows that produced it. Repetition, not proof. */
  windows: number
  /**
   * What this number may be used for, in one clause: "three independent windows
   * at level 4", never "the limit is 4".
   */
  evidence: string
}

export type CounterState =
  | 'blocked'
  | 'enforced-full'
  | 'near-limit'
  | 'enforced-empty'
  | 'unknown-limit'

/**
 * What the shadow OR-constraint engine concluded about one counter, carried
 * read-only on the live assessment. This is the `observedBoundary` finding:
 * true of the traffic seen, never a claim about the provider's quota.
 *
 * It travels with everything needed to check it by hand — the ceiling, the
 * shapes and windows behind it, the rejection clauses it derives from, the
 * assumptions it rests on, and the sentence that says why it is not a quota —
 * because a bare number here would be repeated as "the limit" in someone
 * else's incident review, which is exactly the confusion the contract exists
 * to prevent.
 */
export interface ObservedBoundary {
  /** The shadow ledger's verdict for this counter. */
  verdict: 'proven' | 'boundary' | 'contested' | 'unresolved'
  /** The pinned ceiling, when the verdict pins one. Null otherwise. */
  ceiling: number | null
  /** Traffic shapes the pin was observed under. One shape = load-conditional. */
  shapes: string[]
  /** Independent window keys the pin rests on. */
  windows: string[]
  /** Rejection clauses the pin derives from, with their instants. */
  fromClauses: Array<{ id: string; at: string | null }>
  /** Model assumptions the derivation rests on. Empty when nothing is pinned. */
  dependsOn: string[]
  /** True when a refusal the provider attributed to this counter backs the pin. */
  reportedBacked: boolean
  /** First and last instant of the evidence behind the current verdict. */
  observedFrom: string | null
  observedUntil: string | null
  /**
   * Why this is not a quota, in one clause — the abstention, stated. Present
   * on every verdict including pins: a boundary is true of the traffic seen,
   * not of the quota, and the reason it cannot be promoted travels with it.
   */
  standing: string
  /**
   * Session scope, stated not implied: the shadow ledger lives outside the
   * snapshot, so a restore starts it over. A boundary whose ledger was reset
   * is not a boundary that was refuted — it is a boundary no longer held.
   */
  ledgerScope: 'session'
}

export interface CounterAssessment {
  counterId: string
  label: string
  unit: CounterUnit
  state: CounterState
  level: number
  /**
   * A ceiling the engine is allowed to act on — and, since the contract, the
   * only number callers may repeat as "the limit". It is set **only** when the
   * contract is `authoritative`: the operator or the provider stated it.
   *
   * A ceiling that merely reproduced — however many windows, however
   * consistently — is not here. It lives in `inference`, below, where it cannot
   * be mistaken for a fact in someone else's incident review.
   */
  limit: number | null
  limitSource: LimitSource
  /**
   * Which contract this assessment is reported under. `limit` is only ever set
   * when this is `authoritative`; any other state leaves it null by construction,
   * so no code path can promote an inference into a ceiling by accident.
   */
  contract: LimitContract
  /**
   * What the legacy engine concluded, stated as its own thing rather than as a
   * limit. The shadow engine's boundary findings travel in `boundary`, below —
   * the two are carried side by side and never merged, so neither estimate can
   * overwrite the other.
   */
  inference: LimitInference
  /**
   * What the shadow OR-constraint engine concluded about this counter,
   * stated as its own thing rather than as a limit. Null when the engine
   * holds no ledger for this resource — no observations, no boundary, and
   * the assessment reads exactly as it did before the reporting connection.
   *
   * Read-only by construction: nothing in `decide()` or the policy layer
   * reads this field. It moves no request; it only lets an operator see what
   * the second engine saw.
   */
  boundary: ObservedBoundary | null
  /**
   * The unconfirmed value the engine is currently considering, when there is
   * one. Shown so an operator can see the hypothesis without it masquerading as
   * a known limit — which is why it is populated exactly when `limit` is not.
   */
  candidateLimit: number | null
  /**
   * True when a shorter window on the same resource still has a live estimate,
   * which makes this counter's rejection level unidentifiable: it reproduces
   * because traffic is deterministic, not because it is the ceiling. A
   * confounded counter is reported in full and may be inspected, but it does
   * not steer — nothing that cannot be separated from a shorter cause should
   * move a routing decision.
   */
  confounded: boolean
  /**
   * The ceiling this counter scored against, when the ranking used one. Null
   * when the counter had nothing to say and the resource's score took the
   * neutral 0.5 for it instead — and null for a confounded counter, which is
   * the whole of its suppression.
   *
   * Kept beside `limit` because they answer different questions: `limit` is
   * what the engine may claim, `softCeiling` is what it actually ranked on. For
   * an unconfirmed candidate they deliberately differ — `limit` is null while
   * `softCeiling` is not, which is exactly how one rejection avoids becoming
   * many without the engine pretending to know a number it does not.
   */
  softCeiling: number | null
  /**
   * True when this counter moved the ranking using a number the engine worked
   * out for itself — an established limit or a live candidate — rather than one
   * it was told. The per-counter half of `RoutingAdvice.speculative`: an engine
   * whose every counter reports false is reasoning from facts alone.
   */
  inferred: boolean
  utilization: number | null
  headroom: number | null
  // Deliberately no `suspicion` here. Suspicion is a statement about *the most
  // recent rejection*, so it belongs to `RejectionAttribution.observations`,
  // where it is actually computed. Carrying it on a live assessment as well
  // would put a number on this type that nothing ever fills in — a field that
  // reads as evidence and is always zero.
  /** Coarsened trust in the inference, never in a stated ceiling. Only 'authoritative' describes `limit`; every other value describes the hypothesis in `inference`. */
  confidence: 'authoritative' | 'established' | 'candidate' | 'none'
  nextResetAt: string | null
  blocking: boolean
}

export interface ResourceAdvice {
  resourceId: string
  label: string
  decision: AdviceDecision
  score: number
  waitMs: number | null
  reason: string
  counters: CounterAssessment[]
  activeCooldowns: Cooldown[]
}

/**
 * What the caller should do next. There is deliberately no `retry-elsewhere`
 * variant: "use a different key" is already expressed by `proceed` naming a
 * different `resourceId` and by `alternatives`, so a separate action would only
 * be a second way to say the same thing — and a variant nothing produces is a
 * branch every caller has to write and never exercise.
 */
export type ThrottleAction =
  | { type: 'proceed'; resourceId: string }
  | { type: 'proceed-cautious'; resourceId: string; note: string }
  | { type: 'wait'; waitMs: number; retryAt: string }
  | { type: 'stop'; reason: string }

export interface RoutingAdvice {
  decision: AdviceDecision
  mode: ThrottleMode
  action: ThrottleAction
  /** Best available resource. Null only when nothing is eligible at all. */
  resourceId: string | null
  waitMs: number | null
  retryAt: string | null
  reason: string
  /** Ordered alternatives, most usable first. Empty when no alternative exists. */
  alternatives: Array<{ resourceId: string; score: number; reason: string }>
  /** True when any part of the decision rests on inference rather than facts. */
  speculative: boolean
  evaluatedAt: string
}

export interface EvaluationResult {
  advice: RoutingAdvice
  perResource: ResourceAdvice[]
}

export interface DecisionRequest {
  /** Optional; when omitted, every resource registered with the engine. */
  resources?: ResourceSpec[] | null
  mode?: ThrottleMode | null
  /** Optional charge forecast for the operation about to be sent. */
  forecast?: Record<string, number> | null
  now?: string | Date | number
}

// ---------------------------------------------------------------------------
// Outcome settlement
// ---------------------------------------------------------------------------

export type OutcomeKind =
  | 'success'
  | 'rate-limit'
  | 'credential-rejected'
  | 'transport-failure'
  | 'resource-missing'
  | 'released'

export interface OutcomeUsage {
  /** `counterId -> amount`. Counters omitted fall back to `defaultCharge`. */
  charges?: Record<string, number> | null
  /** Successful operations. Defaults to 1. */
  operations?: number | null
  /**
   * How the caller would describe this operation's traffic shape — a burst, a
   * steady trickle, a batch wake-up, or anything else that distinguishes the
   * load it arrived under. Optional: a caller that cannot characterise its own
   * load has not lied, it has declined to claim, and the observation counts as
   * one anonymous shape. Never inferred from inter-arrival gaps by the engine;
   * a Poisson stream produces sub-second gaps with no bursts at all, so gap
   * timing would promote ceilings on sampling noise.
   */
  trafficShape?: string | null
}

export interface RateLimitDetail {
  /**
   * Exact counters the provider blamed. Callers must not guess this from
   * wording alone; when unsure, leave it null and let the engine attribute
   * the rejection from real measurements.
   */
  blamedCounterIds?: string[] | null
  /**
   * Scope of the provider's limit. `'quota-group'` when one account/project
   * allowance is shared, `'resource'` when the limit belongs to this resource.
   */
  limitScope?: CooldownScope | null
  retryAfterSeconds?: number | null
  providerResetAt?: string | null
  /** Units of the rejected operation, when the caller knows them. */
  rejectedCharge?: number | null
  rejectedCounterId?: string | null
}

/**
 * One counter's slice of a normalized observation. Only window counters appear:
 * a gauge is instantaneous state rather than a window level, and neither
 * learning engine consumes one.
 */
export interface NormalizedCounter {
  counterId: string
  unit: CounterUnit
  /** Window the event belongs to, as the engine identifies it. */
  windowKey: string
  /** What this counter carried when the engine looked — the pre-event truth. */
  usage: number
  /**
   * What this event would have taken the counter to, had it been accepted. For
   * a rejection this is the level the provider refused at; for a success it is
   * the level the success proves the window can carry.
   */
  attempted: number
  /**
   * What this event costs on this counter. For the counter a provider named on
   * a rejection, the caller-supplied rejected charge replaces the request's own
   * size — the rule both engines already applied, now stated in one place.
   */
  charge: number
}

/** The one read of the ledgers: caller-owned, done once, before any mutation. */
export interface CounterReading {
  level: number
  windowKey: string
}

/**
 * The refusal facts of an observation, carried verbatim and filtered only where
 * the engine has always filtered. `reportedCounterId` is the rule both engines
 * already used: exactly one named counter is a provider fact, several or none
 * is not.
 */
export interface NormalizedRejection {
  /**
   * The counter the caller named as carrying the rejected charge, verbatim.
   * Both engines key their named-charge rule off this raw field, so it is
   * carried as given rather than normalized — normalizing it would silently
   * change which charge the legacy sampler recorded.
   */
  rejectedCounterId: string | null
  /**
   * Every counter the caller or provider named. Null when none were named.
   * Distinct from `rejectedCounterId` on purpose: one is a charge fact, the
   * other is a scope claim, and conflating them is how a caller's "this one
   * cost 3 units" becomes "the provider said it was this quota".
   */
  blamedCounterIds: readonly string[] | null
  /** The single named counter, or null. Null means the cause set stays open. */
  reportedCounterId: string | null
  /** Caller-supplied size of the rejected operation. Null when unstated. */
  rejectedCharge: number | null
  /** A provider retry-after, once it has passed the finite/non-negative filter. */
  retryAfterSeconds: number | null
  providerResetAt: string | null
  limitScope: CooldownScope | null
  detail: string | null
}

/**
 * The one record every consumer of an outcome reads.
 *
 * Built by `settle()` from a single read of the ledgers, taken before anything
 * is charged or released, and then consumed by the legacy estimates, the
 * shadow constraints, the attribution, and the caller. Nobody downstream
 * re-reads a ledger to find out what the level was — which is what used to let
 * two engines see two different series of events.
 *
 * What it deliberately does not carry:
 *
 * Quota windows retain their existing `settledAt` accounting. An optional
 * `startedAt` records a tracked dispatch for pacing and outcome ordering;
 * it does not silently change the legacy quota-window accounting.
 * - **Anything the caller did not say.** `provider`, `rejection` and
 *   `trafficShape` are carried verbatim; a missing `blamedCounterIds` stays
 *   missing instead of becoming a claim about the provider's silence.
 */
export interface NormalizedObservation {
  startedAt?: string
  resourceId: string
  /** Caller-supplied identity. Null when the caller cannot deduplicate. */
  eventId: string | null
  kind: OutcomeKind
  /** When the caller said the operation settled. The only window authority. */
  settledAt: string
  /** Operations this settlement represents. Same resolution both engines use. */
  operations: number
  counters: readonly NormalizedCounter[]
  /** How the caller characterised the load this event arrived under. */
  trafficShape: string | null
  /** Provider signal, verbatim. Never inferred from the silence between calls. */
  provider: ProviderSignal | null
  /** Present for `rate-limit` outcomes, null for every other kind. */
  rejection: NormalizedRejection | null
}

export interface OutcomeInput {
  resourceId: string
  /** Identity returned by recordRequestStart; also the settlement replay identity. */
  requestId?: string
  /** Set internally from recordRequestStart; legacy counters still use settledAt. */
  startedAt?: string
  kind: OutcomeKind
  /**
   * Caller-supplied identity for this event, when the caller can supply one.
   *
   * A settlement is normally exactly-once: the caller sends, something
   * happens, it reports. But a timeout the caller cannot distinguish from a
   * lost write is exactly when reporting twice is the safe move, and a second
   * settlement used to mean a second charge and a second piece of evidence.
   * Passing the same `eventId` again makes the engine recognise the replay and
   * settle nothing.
   *
   * Optional because the default contract is unchanged: without it, every
   * call is an event, exactly as before. Identities are remembered for
   * `REPLAY_MEMORY` settlements per process and are not persisted.
   */
  eventId?: string | null
  settledAt?: string | Date | number
  usage?: OutcomeUsage | null
  provider?: ProviderSignal | null
  rateLimit?: RateLimitDetail | null
  detail?: string | null
}

export interface SettlementResult {
  resourceId: string
  settledAt: string
  /** Returned for `rate-limit` outcomes: which window the engine blamed. */
  attribution: RejectionAttribution | null
  /**
   * The single observation this settlement produced, frozen: the one read of
   * the ledgers that the legacy estimates, the shadow constraints, and the
   * attribution all consumed. Echoed so a caller can check what the engine
   * actually saw, and so the two engines' agreement is inspectable rather than
   * assumed.
   *
   * Null exactly on a replay: nothing was observed, so there is nothing to
   * report.
   */
  observation: NormalizedObservation | null
  /** True when this settlement repeated an `eventId` already settled. */
  replay?: boolean
}

/**
 * A counter that no longer has an unresolved estimate, kept so a report can say
 * "this was ruled out" rather than silently omitting it.
 */
export interface ClearedCounterReport {
  resourceId: string
  counters: Array<{
    counterId: string
    unit: CounterUnit
    clearedAt: string
    rejectedLevel: number
    previousEstimate: number | null
  }>
}
