/**
 * Adaptive Throttle engine.
 *
 * The engine is a library, not a service: you construct it, register your
 * resources, ask it what to do, and tell it what happened. It holds all state
 * in a plain JSON snapshot you can persist and hand back after a restart.
 *
 * **The engine never causes a request to exist.** It has no queue, no scheduler,
 * no retry loop, and no probe. Nothing in this file sends anything, retries
 * anything, or tells the caller to send an extra request to satisfy the engine's
 * curiosity ? including when an estimate would benefit from an experiment. Every
 * fact it learns arrives through `settle`, which means it arrived because the
 * caller was already doing that work. When the evidence is too thin to decide, it
 * says so instead of buying certainty with the caller's budget.
 *
 * Two invariants shape everything below:
 *
 * 1. **Only real measurements count as usage.** The ledger records requests that
 *    actually succeeded. Estimates live in a separate structure and are never fed
 *    back as usage, so an inference can never inflate the level that produced it.
 * 2. **The engine never guesses a ceiling in order to block.** Static
 *    configuration, provider telemetry, and time-based cooldowns may withhold a
 *    request. A learned ceiling may only demote one ? in every mode, with no
 *    switch to change that, because a conclusion that can cost availability is
 *    one the engine is not qualified to reach.
 *
 * A third one is worth stating because it is easy to violate while trying to be
 * helpful:
 *
 * 3. **A rejection never names a window on its own.** Whether an estimate may
 *    steer is decided by `confounded`, not by how reproducible it is: a
 *    deterministic traffic pattern reproduces every counter's level, so a
 *    shorter window still in play makes a longer counter's number meaningless as
 *    a ceiling. The engine reports the number either way and lets the caller see
 *    exactly what it does and does not know.
 */

import { parseTimestamp, resolveInstant, systemThrottleClock, toIso, type ThrottleClock } from './clock.js'
import { toFiniteNumber } from './numeric.js'
import { AdaptivePacing, type PacingOptions, type RequestPlanInput, type RequestPlan, type RequestStartInput, type RequestStartResult } from './pacing.js'
import {
  adjustGaugeLevel,
  bucketRefillPerMs,
  charge as chargeLedger,
  counterDisplayLabel,
  createLedgerState,
  normalizeResource,
  readLevel,
  resolveBucketWindow,
  resolveCharge,
  resolveCounterWindow,
  resolveOperationCount,
  windowEndAt,
  windowKeyAt,
} from './counters.js'
import {
  applyProviderDeclaredLimit,
  createEstimate,
  mergeProviderTelemetry,
  observeSuccessfulLevel,
  recordBoundarySample,
  recomputeEstimate,
} from './estimates.js'
import {
  MAX_COOLDOWNS_PER_SCOPE,
  MAX_EVENTS_PER_RESOURCE,
  MAX_GLOBAL_EVENTS,
  createResourceRuntime,
  normalizeSnapshot,
} from './normalize.js'
import {
  UNPROVEN_FAILURE_SCORE_FACTOR,
  assessCounter,
  computeResourceScore,
  decideFromAssessments,
  hasUnprovenFailure,
  isNearLimit,
  resolveEffectiveLimit,
  type EffectiveLimit,
} from './policy.js'
import { attributeRejection } from './advice.js'
import {
  buildHypothesisReport,
  createHypothesisLedger,
  describeCounterBoundary,
  observeAccepted,
  observeRejected,
  type HypothesisLedger,
} from './hypotheses.js'
import { buildQuotaKnowledge, type QuotaKnowledge } from './knowledge.js'
import {
  REPLAY_MEMORY,
  counterFrom,
  eventKey,
  normalizeObservation,
} from './observation.js'
import { resolveWindow, resolveWindowEnd, resolveWindowKey } from './windows.js'
import {
  THROTTLE_ARCHITECTURE_NAME,
  THROTTLE_ENGINE_LABEL,
  THROTTLE_ENGINE_NAME,
  THROTTLE_ENGINE_VERSION,
} from './identity.js'
import type {
  AdviceDecision,
  ClearedCounterReport,
  Cooldown,
  CooldownKind,
  CooldownScope,
  CooldownSource,
  CounterAssessment,
  CounterEstimate,
  CounterSpec,
  DecisionRequest,
  EvaluationResult,
  OutcomeInput,
  ProviderSignal,
  ResourceAdvice,
  ResourceRuntime,
  ResourceSpec,
  RejectionAttribution,
  RoutingAdvice,
  SettlementResult,
  ThrottleEventKind,
  ThrottleMode,
  ThrottleSnapshot,
} from './types.js'
import type { CounterReading, NormalizedObservation } from './types.js'
import { DEFAULT_THROTTLE_MODE, THROTTLE_MODES } from './types.js'

/** A credential rejection means the credential is broken, not that it is busy. */
export const DEFAULT_CREDENTIAL_COOLDOWN_MS = 300_000

/** A transport failure is usually a blip worth retrying soon. */
export const DEFAULT_TRANSPORT_COOLDOWN_MS = 15_000

/** A missing resource stays missing until the caller changes its configuration. */
export const DEFAULT_MISSING_COOLDOWN_MS = 300_000

/**
 * Used only when a rejection carries no retry-after, no reset, and no resolvable
 * window. A rejection always implies *some* delay, and immediately re-sending
 * would burn another request to learn nothing.
 */
export const REJECTION_FALLBACK_HOLD_MS = 1_000

/**
 * How long a failure may keep a resource from being preferred when no success
 * follows it.
 *
 * A single success clears the memory immediately; this is only the bound on the
 * resource that never gets that far, because a memory released by nothing but
 * its own absence of traffic would never be released at all ? see
 * `hasUnprovenFailure`.
 */
export const DEFAULT_FAILURE_MEMORY_MS = 3_600_000

export interface ThrottleEngineOptions {
  pacing?: PacingOptions
  mode?: ThrottleMode | null
  clock?: ThrottleClock | null
  credentialCooldownMs?: number | null
  transportCooldownMs?: number | null
  missingCooldownMs?: number | null
  /**
   * How long a failure may keep a resource from being preferred when no success
   * follows it. Defaults to `DEFAULT_FAILURE_MEMORY_MS`. Any success clears the
   * memory immediately regardless of this value.
   */
  failureMemoryMs?: number | null
  /**
   * Ranking multiplier applied to a failure no success has yet answered, in
   * [0, 1]. Defaults to the historical `UNPROVEN_FAILURE_SCORE_FACTOR` (0.4) in
   * every mode, so a caller that says nothing sees the engine's original
   * behaviour. 1 removes the demotion entirely.
   *
   * Kept as a number rather than a switch because the experiment that
   * motivated it needed the whole range, and because the honest finding from
   * that experiment is a measurement, not a new truth: on a uniform fleet at
   * capacity the demotion cost throughput, and on a mixed fleet it changes
   * nothing measurable.
   */
  failureScoreFactor?: number | null
  /**
   * Tie-break among equally-scored, equally-eligible resources. `'id'` (the
   * default) keeps the original deterministic ordering; `'lru'` prefers the key
   * confirmed successful longest ago. Experiment knob, measured not assumed.
   */
  tieBreakStrategy?: 'lru' | 'id'
  /**
   * Whether a cooldown the engine *inferred* ? a window boundary it guessed at,
   * rather than one the provider stated ? may withhold a request. Defaults to
   * true. Provider-backed waits (retry-after, a reset the provider sent) are
   * never affected by this: they are facts, not guesses.
   */
  inferredCooldowns?: boolean
  /**
   * Whether a learned ceiling may steer a decision ? the `near-limit`
   * demotion and the ranking weight a candidate or established limit carries.
   * Defaults to true. Levels, estimates, samples, telemetry and the shadow
   * ledger are all unchanged when this is false: only the decision pathway
   * stops reading them, which is what makes the knob a clean experiment rather
   * than a different learning system.
   */
  steerOnInference?: boolean
  /**
   * Whether, when *every* resource is waiting on a cooldown the engine inferred
   * ? and nothing factual blocks the request ? the engine may still send to the
   * best-ranked one instead of withholding the request entirely. Defaults to
   * false: holding everything is the historical behaviour, and this knob
   * exists to measure what that caution costs.
   */
  lastResortSend?: boolean
  /**
   * Whether an inferred ceiling may steer only when it *distinguishes* one
   * resource from the alternatives on offer. Defaults to false ? historical
   * behaviour, steer on proximity alone.
   *
   * True implements the discrimination rule: a caution every candidate shares
   * is a description of the fleet, not a preference within it, so it is
   * dropped and the engine falls back to its evidence-free ordering. That is
   * the measured cost of the naive rule ? on a uniform fleet at capacity,
   * steering on a ceiling every key is near chases minute-room while the hour
   * is the window actually refusing ? and it is what makes the difference
   * between an engine that learns a limit and one that learns when a limit is
   * useless.
   */
  discriminationSteering?: boolean
  /**
   * Whether a recently-failed resource goes *behind its equals* in the
   * ordering. Defaults to false.
   *
   * An ordering term, not a multiplier: the historical failure demotion
   * scaled the whole score, so on a fleet where every key is equally near its
   * ceiling it decided the routing outright, and measured as one of the two
   * causes of the homogeneous-load deficit. As a last-resort ordering hint it
   * only breaks ties ? which is the part of the idea that is actually sound:
   * rotate away from the key that just refused, without letting that fact
   * outrank the evidence about which key has room.
   */
  failoverRotation?: boolean
}

export interface EngineRecord {
  module: string
  architecture: string
  version: string
  label: string
  snapshotVersion: number
}

export interface ReserveInput {
  resourceId: string
  charges?: Record<string, number> | null
  operations?: number | null
  now?: string | Date | number
}

export interface ReserveResult {
  resourceId: string
  /** Instantaneous gauge levels after the reservation. */
  gauges: Record<string, number>
  /** Live held amounts per window counter after the reservation. */
  windows: Record<string, number>
  at: string
}

const TYPED_FAILURE_POLICY = {
  'credential-rejected': {
    kind: 'credential-rejected' as CooldownKind,
    event: 'credential-rejected' as ThrottleEventKind,
    option: 'credentialCooldownMs',
    fallback: DEFAULT_CREDENTIAL_COOLDOWN_MS,
    detail: 'The provider rejected the credential.',
  },
  'transport-failure': {
    kind: 'transport-failure' as CooldownKind,
    event: 'transport-failure' as ThrottleEventKind,
    option: 'transportCooldownMs',
    fallback: DEFAULT_TRANSPORT_COOLDOWN_MS,
    detail: 'The provider request failed transiently.',
  },
  'resource-missing': {
    kind: 'resource-missing' as CooldownKind,
    event: 'resource-missing' as ThrottleEventKind,
    option: 'missingCooldownMs',
    fallback: DEFAULT_MISSING_COOLDOWN_MS,
    detail: 'The resource was not found upstream.',
  },
} as const

/**
 * Identity of one resource's outstanding promise on one window counter.
 *
 * JSON-encoded rather than space-joined: a resource id or counter id
 * containing the separator would otherwise let two different pairs collapse
 * onto one key, and one key's promise would silently release another's.
 */
function windowHoldKey(resourceId: string, counterId: string): string {
  return JSON.stringify([resourceId, counterId])
}

/**
 * A refusal's evidence scope, from the counters the caller named: exactly one
 * named counter is a provider fact about that refusal, several or none is not
 * a claim at all and leaves the ledger's own default in place.
 */
function rejectedScope(blamed: readonly string[] | null): 'reported' | undefined {
  return blamed != null && blamed.length === 1 ? 'reported' : undefined
}

export class AdaptiveThrottleEngine {  private snapshot: ThrottleSnapshot
  private readonly pacing: AdaptivePacing
  private readonly dispatches = new Map<string, { startedAt: number; charges?: Record<string, number> }>()
  private readonly clock: ThrottleClock
  private readonly registry = new Map<string, ResourceSpec>()
  /**
   * Shadow evidence ledgers, one per resource. Deliberately outside the
   * snapshot: they are a session-local observation deck, rebuilt from traffic
   * as it arrives, and nothing in `decide()` or the policy layer reads them ?
   * so they can inform an operator (or a future integration) without moving a
   * single request. A restored snapshot starts with no ledgers.
   */
  private readonly hypotheses = new Map<string, HypothesisLedger>()
  /**
   * Outstanding window reservations, one entry per resource and counter.
   * Deliberately outside the snapshot, like the shadow ledgers: a hold is
   * delivery state, not learning ? it says "this much was promised out and
   * has not settled yet", never "this much was used". A restored snapshot
   * starts with no holds, because the process that promised them may be gone;
   * re-promising after a restart is the caller's job, not the snapshot's.
   * Holds never feed samples, estimates, telemetry, or proven bounds.
   */
  private readonly windowHolds = new Map<string, { windowKey: string; amount: number }>()
  /**
   * Event identities already settled, for replay protection. Bounded
   * (`REPLAY_MEMORY`) and insertion-ordered: the oldest identity is forgotten
   * first. Only consulted for callers that supply an `eventId`; without one the
   * map stays empty and every settlement is an event, exactly as before.
   */
  private readonly settledEvents = new Set<string>()
  private readonly durations: {
    credentialCooldownMs: number
    transportCooldownMs: number
    missingCooldownMs: number
    failureMemoryMs: number
  }
  /** Null means the historical default; a number overrides the ranking opinion. */
  private readonly failureScoreFactor: number | null
  private readonly tieBreakStrategy: 'lru' | 'id'
  /**
   * Experiment knobs for the ablation matrix, both defaulting to the behaviour
   * the engine has always had. They exist so the two suspected causes of the
   * remaining homogeneous-burst deficit can be measured separately instead of
   * argued about: `inferredCooldowns` controls whether a *guessed* window
   * boundary may park a key, and `steerOnInference` whether a learned ceiling
   * may steer a decision. Neither is a product recommendation on its own.
   */
  private readonly inferredCooldowns: boolean
  private readonly steerOnInference: boolean
  /**
   * Experiment knobs for the ablation matrix, all defaulting to the behaviour
   * the engine has always had. They exist so the suspected causes of the
   * remaining homogeneous-burst deficit can be measured separately instead of
   * argued about: `inferredCooldowns` controls whether a *guessed* window
   * boundary may park a key, `steerOnInference` whether a learned ceiling may
   * steer a decision, and `lastResortSend` whether an all-inferred-cooldown
   * standstill may still send. None is a product recommendation on its own.
   */
  private readonly lastResortSend: boolean
  private readonly discriminationSteering: boolean
  private readonly failoverRotation: boolean
  private idCounter = 0

  readonly engine: EngineRecord

  constructor(snapshot?: unknown, options?: ThrottleEngineOptions | null) {
    this.clock = options?.clock ?? systemThrottleClock
    const mode = normalizeMode(options?.mode) ?? DEFAULT_THROTTLE_MODE
    this.snapshot = normalizeSnapshot(snapshot, mode)
    this.pacing = new AdaptivePacing(this.snapshot.pacing)
    if (options?.pacing) this.pacing.configure(options.pacing)
    this.durations = {
      credentialCooldownMs: resolveDuration(options?.credentialCooldownMs, DEFAULT_CREDENTIAL_COOLDOWN_MS),
      transportCooldownMs: resolveDuration(options?.transportCooldownMs, DEFAULT_TRANSPORT_COOLDOWN_MS),
      missingCooldownMs: resolveDuration(options?.missingCooldownMs, DEFAULT_MISSING_COOLDOWN_MS),
      failureMemoryMs: resolveDuration(options?.failureMemoryMs, DEFAULT_FAILURE_MEMORY_MS),
    }
    this.failureScoreFactor =
      options?.failureScoreFactor == null || !Number.isFinite(options.failureScoreFactor)
        ? null
        : Math.max(0, Math.min(1, options.failureScoreFactor))
    this.tieBreakStrategy = options?.tieBreakStrategy === 'lru' ? 'lru' : 'id'
    this.inferredCooldowns = options?.inferredCooldowns !== false
    this.steerOnInference = options?.steerOnInference !== false
    this.lastResortSend = options?.lastResortSend === true
    // Default on, and measured rather than argued: an inferred caution the whole
    // fleet shares carried no information, and steering on it was the measured
    // cause of the homogeneous-burst deficit; pairing it with the
    // recency-of-failure ordering hint recovered nearly all of it while leaving
    // the heterogeneous fleet's routing untouched. Either may be turned off to
    // reproduce the historical behaviour exactly.
    this.discriminationSteering = options?.discriminationSteering !== false
    this.failoverRotation = options?.failoverRotation !== false
    this.engine = {
      module: THROTTLE_ENGINE_NAME,
      architecture: THROTTLE_ARCHITECTURE_NAME,
      version: THROTTLE_ENGINE_VERSION,
      label: THROTTLE_ENGINE_LABEL,
      snapshotVersion: this.snapshot.version,
    }
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  /**
   * Declares the resources the engine may advise on. Configuration is held in
   * memory only and is never persisted: after a restart the caller re-registers
   * it, and the snapshot supplies the learned state back.
   *
   * Specs are normalized on the way in, so a caller may omit any field that has
   * a safe default ? most importantly `kind`, which defaults to `window`. An
   * unnormalized spec with no `kind` would silently measure nothing.
   */
  register(input: { resources: ResourceSpec[] } | ResourceSpec[]): void {
    const resources = Array.isArray(input) ? input : input.resources

    for (const candidate of resources) {
      const spec = normalizeResource(candidate)

      if (!spec) {
        continue
      }

      this.registry.set(spec.resourceId, spec)
      // Fresh configuration means fresh delivery state: holds promised under
      // a previous spec (possibly different windows) do not carry over.
      for (const key of this.windowHolds.keys()) {
        if (key === spec.resourceId || key.startsWith(`${spec.resourceId} `)) {
          this.windowHolds.delete(key)
        }
      }
      // Materialized eagerly so a caller can read a resource's state straight
      // after registering it instead of having to trigger a decision first.
      this.ensureRuntime(spec.resourceId, spec)
    }
  }

  getRegisteredResources(): ResourceSpec[] {
    return [...this.registry.values()]
  }

  getMode(): ThrottleMode {
    return this.snapshot.mode
  }

  setMode(mode: ThrottleMode): void {
    this.snapshot.mode = normalizeMode(mode) ?? DEFAULT_THROTTLE_MODE
  }

  getSnapshot(): ThrottleSnapshot {
    return { ...structuredClone(this.snapshot), pacing: this.pacing.getSnapshot() }
  }

  configurePacing(options: PacingOptions): void {
    this.pacing.configure(options)
  }

  /** Evaluates only this resource. The caller owns waiting and must re-evaluate before dispatch. */
  planRequest(input: RequestPlanInput): RequestPlan {
    const nowMs = this.requestInstant(input.now)
    const spec = this.registry.get(input.resourceId)
    if (!spec || spec.enabled === false) return {
      resourceId: input.resourceId, decision: 'blocked', notBefore: null, waitMs: null,
      reason: 'The requested resource is not registered or is disabled',
    }
    const evaluation = this.decide({ resources: [spec], now: nowMs, forecast: input.charges })
    if (evaluation.advice.action.type === 'stop') return {
      resourceId: input.resourceId, decision: 'blocked', notBefore: null, waitMs: null,
      reason: evaluation.advice.reason,
    }
    const cooldowns = selectBlockingCooldowns(evaluation.perResource[0]!.activeCooldowns, this.getMode())
    const retryAt = input.retryAt == null ? nowMs : this.requestInstant(input.retryAt)
    const notBefore = Math.max(nowMs, retryAt, this.pacing.notBefore(input.resourceId) ?? nowMs,
      ...cooldowns.map((entry) => parseTimestamp(entry.blockedUntil)))
    return {
      resourceId: input.resourceId,
      decision: notBefore > nowMs ? 'wait' : 'send',
      notBefore: new Date(notBefore).toISOString(), waitMs: notBefore - nowMs,
      reason: notBefore > nowMs ? 'Waiting for pacing, retry, and all active cooldown deadlines' : evaluation.advice.reason,
    }
  }

  /** Synchronous check + reservation + timestamp, so competing callers cannot consume the same pacing slot. */
  recordRequestStart(input: RequestStartInput): RequestStartResult {
    if (typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 128) throw new Error('requestId must contain 1–128 characters')
    const key = eventKey(input.resourceId, input.requestId)
    if (this.dispatches.has(key) || this.settledEvents.has(key)) throw new Error('Request identity was already used')
    const now = this.requestInstant(input.now)
    const plan = this.planRequest({ ...input, now })
    if (plan.decision !== 'send') return { ...plan, dispatched: false, requestId: input.requestId }
    this.reserve({ resourceId: input.resourceId, now, charges: input.charges })
    this.pacing.dispatch(input.resourceId, now)
    this.dispatches.set(key, { startedAt: now, charges: input.charges ? { ...input.charges } : undefined })
    return { ...plan, dispatched: true, requestId: input.requestId, startedAt: new Date(now).toISOString() }
  }

  private requestInstant(value?: Date | string | number): number {
    const instant = value == null ? this.clock.now().getTime() : value instanceof Date ? value.getTime() :
      typeof value === 'number' ? value : Date.parse(value)
    if (!Number.isSafeInteger(instant) || instant < 0 || instant > 8_639_999_913_600_000) throw new Error('Invalid request timestamp')
    return instant
  }

  getResourceRuntime(resourceId: string): ResourceRuntime | null {
    return this.snapshot.resources[resourceId] ?? null
  }

  // ---------------------------------------------------------------------------
  // Decision
  // ---------------------------------------------------------------------------

  /**
   * Decides where to send the next operation, and explains why.
   *
   * `resources` overrides the registry for this call only; omitting it uses what
   * was registered. A resource that is not enabled is never advised regardless of
   * any evidence it has accumulated.
   */
  decide(request?: DecisionRequest | null): EvaluationResult {
    const nowMs = resolveInstant(this.clock, request?.now).getTime()
    const mode = normalizeMode(request?.mode) ?? this.snapshot.mode
    const specs = request?.resources != null
      ? request.resources
      : [...this.registry.values()]

    // Pre-pass for the discrimination rule: a caution that every candidate
    // resource shares carries no information, so it must not decide anything.
    // When *some* resources are near an inferred ceiling and others are not,
    // the caution is discriminating and the engine steers on it as usual; when
    // all or none are, steering on it is reading noise, and the engine falls
    // back to its evidence-free ordering. Provider-stated ceilings are facts
    // and are never discounted here ? a fact does not need to be discriminating
    // to be true.
    const inferredMaySteer = this.steerOnInference && this.discriminationSteering
      ? this.discriminationHolds(specs, nowMs, request?.forecast)
      : this.steerOnInference

    const perResource: ResourceAdvice[] = []
    const inflightByResource = new Map<string, number>()

    for (const spec of specs) {
      if (!spec.resourceId || spec.enabled === false) {
        continue
      }

      const runtime = this.ensureRuntime(spec.resourceId, spec)
      const active = this.collectActiveCooldowns(runtime, spec.quotaGroupId, nowMs)
      const blocking = selectBlockingCooldowns(active, mode)
      const confounded = resolveConfoundedCounters(spec, runtime)
      // The shadow ledger, when this resource has observed anything yet. Read
      // here and only here on the decision path: the projection below labels
      // the report, and no ranking input may change between the two reads.
      const shadow = this.hypotheses.get(spec.resourceId)

      const assessments: CounterAssessment[] = []
      const scoreEntries: Array<{ level: number; limit: EffectiveLimit }> = []
      let inflightTotal = 0
      const inflightParts: string[] = []

      for (const counter of spec.counters) {
        const ledger = runtime.counters[counter.counterId]
        const level = readLevel(ledger, counter, nowMs, this.bucketRate(counter, runtime))
        // A hold is a level that has been promised out but not settled yet, so
        // every routing computation that reads the committed level reads the
        // committed level plus live holds instead ? except the reported
        // `level` itself, which stays a fact about settled traffic, and
        // everything learning touches, which never sees holds at all.
        const held = counter.kind === 'window' ? this.liveWindowHold(spec.resourceId, counter, nowMs) : 0
        const effective = level + held
        const forecastCharge = resolveCharge(counter, request?.forecast, 1)
        const limit = resolveEffectiveLimit(
          counter,
          runtime.estimates[counter.counterId],
          runtime.providerTelemetry[counter.counterId],
          confounded.has(counter.counterId),
          nowMs,
        )

        if (held > 0) {
          inflightTotal += held
          inflightParts.push(`${held} in flight on ${counterDisplayLabel(counter)}`)
        }

        // Steering knob: with inference steering off ? or, under the
        // discrimination rule, with a caution that no alternative distinguishes
        // ? the counter still reports exactly what it knows (`softCeiling` is
        // carried unchanged), but neither the caution state nor the ranking
        // weight reads it. Only stated (authoritative) ceilings always steer.
        const steeringLimit: EffectiveLimit =
          inferredMaySteer || limit.authoritative ? limit : { ...limit, softCeiling: null }

        assessments.push(
          assessCounter({
            counter,
            limit,
            estimate: runtime.estimates[counter.counterId],
            level,
            projectedLevel: effective + forecastCharge,
            mode,
            nextResetAt: windowEndAt(counter, nowMs),
            label: counterDisplayLabel(counter),
            // Read-only reporting connection: the shadow's boundary finding
            // rides along for the operator to read. Routing cannot see it ?
            // no score, ceiling, cooldown, or ordering input is derived from
            // it, and the ledger it comes from is never written on this path.
            boundary: shadow ? describeCounterBoundary(shadow, counter.counterId) : null,
            ignoreSteering: !inferredMaySteer,
          }),
        )
        scoreEntries.push({ level: effective, limit: steeringLimit })
      }

      const unprovenFailure =
        mode === 'smart' || mode === 'aggressive'
          ? hasUnprovenFailure(runtime, nowMs, this.durations.failureMemoryMs)
          : false

      // Scaled rather than subtracted, so the ordering among penalised keys is
      // preserved: a nearly-full key that has not failed still ranks below one
      // that is both empty and currently failing.
      const baseScore = computeResourceScore(scoreEntries, spec.priority)
      // The failure cooldown already protects delivery. This multiplier is a
      // ranking opinion on top of it, and it is opt-in: pass a factor to
      // measure or keep the historical behaviour. Defaults to the historical
      // 0.4 in every mode, so nothing changes for a caller that says nothing.
      const failureFactor = this.failureScoreFactor ?? UNPROVEN_FAILURE_SCORE_FACTOR
      const health = unprovenFailure ? baseScore * failureFactor : baseScore

      const counterDecision = decideFromAssessments(assessments, mode)

      let decision: AdviceDecision = counterDecision.decision
      let reason = counterDecision.reason
      let waitMs: number | null = null

      if (blocking.length > 0) {
        const earliest = Math.min(...blocking.map((entry) => parseTimestamp(entry.blockedUntil)))
        waitMs = Math.max(0, earliest - nowMs)

        if (mode === 'observe') {
          decision = 'send-cautious'
          reason = `observe mode: ${describeCooldown(blocking[0]!)} is unresolved; nothing is withheld`
        } else {
          decision = 'defer'
          reason = `${describeCooldown(blocking[0]!)} until ${toIso(earliest)}`
        }
      } else if (unprovenFailure) {
        // Both modes say why; `aggressive` additionally puts the key behind
        // every healthy one. It stays eligible, so a lone failing key is still
        // used ? this sheds load across keys, it does not withhold the last one.
        reason = `${reason}; no success has followed the last failure on this key`

        if (mode === 'aggressive') {
          decision = 'send-cautious'
        }
      }

      if (inflightTotal > 0) {
        // Disclosed, not hidden: whenever outstanding promises moved a
        // decision, the reason says by how much and on which counter, so a
        // 'defer' against an authoritative ceiling reads as "promised out",
        // never as "measured full".
        reason = `${reason}; ${inflightParts.join(', ')}`
      }

      inflightByResource.set(spec.resourceId, inflightTotal)

      const advice: ResourceAdvice = {
        resourceId: spec.resourceId,
        label: spec.label ?? spec.resourceId,
        decision,
        score: health,
        waitMs,
        reason,
        counters: assessments,
        activeCooldowns: active,
      }

      perResource.push(advice)
      runtime.lastAdvisedAt = new Date(nowMs).toISOString()
      runtime.lastDecision = decision

      // Only notable decisions are recorded, so a busy caller does not drown the
      // event log in routine "everything is fine" entries.
      if (decision !== 'send') {
        this.appendEvent(runtime, decision === 'defer' ? 'rate-limit' : 'advised', reason, nowMs, waitMs != null ? nowMs + waitMs : null)
      }
    }

    return { advice: this.assembleAdvice(perResource, mode, nowMs, inflightByResource), perResource }
  }

  /**
   * Picks the resource to use and the action to take.
   *
   * Ranking puts an outright-safe resource ahead of a merely-cautious one before
   * comparing health, because "healthy" is a guess while "not near any known
   * ceiling" is a fact. Ties break on health (which already folds in operator
   * priority), then outstanding promises, then id, so the same inputs always
   * produce the same choice. The in-flight tie-break is what spreads a burst across equal keys:
   * it is a fact about the engine's own unsettled advice, not a claim about
   * any ceiling, so it moves load without stating a single limit.
   */
  private assembleAdvice(
    perResource: ResourceAdvice[],
    mode: ThrottleMode,
    nowMs: number,
    inflightByResource: ReadonlyMap<string, number>,
  ): RoutingAdvice {
    const rankOf = (decision: AdviceDecision): number =>
      decision === 'send' ? 0 : decision === 'send-cautious' ? 1 : 2

    // How recently this resource was refused and that refusal is still
    // unanswered, in epoch milliseconds; 0 when it has recovered or never
    // failed. Scoped on purpose: `lastFailureAt` itself is never cleared ? a
    // fact, not a memory ? so an un-scoped ordering term would keep a key that
    // recovered months ago behind a key that never failed at all, which is
    // remembering a grudge rather than spreading load.
    const unresolvedFailureAt = (resourceId: string): number => {
      const runtime = this.snapshot.resources[resourceId]

      if (runtime == null || !hasUnprovenFailure(runtime, nowMs, this.durations.failureMemoryMs)) {
        return 0
      }

      return parseTimestamp(runtime.lastFailureAt)
    }

    const ranked = [...perResource].sort(
      (left, right) =>
        rankOf(left.decision) - rankOf(right.decision) ||
        right.score - left.score ||
        (inflightByResource.get(left.resourceId) ?? 0) - (inflightByResource.get(right.resourceId) ?? 0) ||
        // Experiment knob, off by default. Under `lru`, a tie with no evidence
        // either way prefers the key confirmed successful longest ago, so a
        // fleet of equal keys does not keep hammering the lexicographically
        // first one. `id` keeps the original deterministic ordering.
        (this.tieBreakStrategy === 'lru'
          ? parseTimestamp(this.snapshot.resources[left.resourceId]?.lastUsedAt ?? null) -
            parseTimestamp(this.snapshot.resources[right.resourceId]?.lastUsedAt ?? null)
          : 0) ||
        // Rotation hint, off by default. A resource that was refused recently
        // goes behind its equally-scored peers, so the engine does not walk
        // straight back to the key that just rejected it ? which is what pure
        // rotation does by construction, and what the fleet's hour windows feel
        // as uneven packing. Deliberately an *ordering* term rather than a score
        // multiplier: measured as a multiplier it dominated the very evidence it
        // was supposed to break ties on, and turned a tie-break into a veto.
        (this.failoverRotation
          ? (unresolvedFailureAt(left.resourceId) || Number.NEGATIVE_INFINITY) -
            (unresolvedFailureAt(right.resourceId) || Number.NEGATIVE_INFINITY)
          : 0) ||
        left.resourceId.localeCompare(right.resourceId),
    )

    const eligible = ranked.filter(
      (entry) => entry.decision === 'send' || entry.decision === 'send-cautious',
    )
    const speculative = ranked.some(
      (entry) =>
        // `counter.inferred`, not `limitSource === 'inferred'`: a candidate has
        // no stated limit and so no inferred source, yet it still ranks the
        // resource. Reading the source here instead would have called every
        // candidate-driven decision factual ? the one thing this flag exists to
        // prevent.
        entry.counters.some((counter) => counter.inferred) ||
        entry.activeCooldowns.some((cooldown) => !cooldown.authoritative),
    )

    // True when something factual ? a stated ceiling, or a wait the provider
    // itself stated ? stands in the way of every resource. Everything else that
    // withholds a request is the engine's own caution, and caution is the one
    // thing that must never withhold the request itself.
    const factBlocked = ranked.some(
      (entry) =>
        entry.counters.some((counter) => counter.blocking) ||
        entry.activeCooldowns.some((cooldown) => cooldown.authoritative),
    )

    // Last resort, off by default. Withholding every resource because each one
    // is waiting on a cooldown the engine guessed at withholds the request:
    // nothing factual stands in the way, only the engine's own caution. The
    // caller that would have sent anyway now sends to the best-ranked resource,
    // labelled cautious ? and pays the same price a router without any model
    // pays: a possible rejection, which is also evidence the engine can learn
    // from. It never overrides a fact.
    if (eligible.length === 0 && this.lastResortSend && !factBlocked && ranked.length > 0) {
      const pick = ranked[0]!

      return {
        decision: 'send-cautious',
        mode,
        action: {
          type: 'proceed-cautious',
          resourceId: pick.resourceId,
          note: 'every resource is waiting on a cooldown the engine inferred; nothing factual blocks this request',
        },
        resourceId: pick.resourceId,
        waitMs: null,
        retryAt: null,
        reason: `${pick.reason}; every resource is waiting on an inferred cooldown, so sending rather than withholding the request`,
        alternatives: ranked.slice(1).map((entry) => ({
          resourceId: entry.resourceId,
          score: entry.score,
          reason: entry.reason,
        })),
        speculative,
        evaluatedAt: new Date(nowMs).toISOString(),
      }
    }

    if (eligible.length === 0) {
      const waiting = ranked.filter((entry) => entry.decision === 'defer' && entry.waitMs != null)
      const earliestWait = waiting.length > 0 ? Math.min(...waiting.map((entry) => entry.waitMs!)) : null

      if (earliestWait != null) {
        const retryAt = new Date(nowMs + earliestWait).toISOString()

        return {
          decision: 'defer',
          mode,
          action: { type: 'wait', waitMs: earliestWait, retryAt },
          resourceId: null,
          waitMs: earliestWait,
          retryAt,
          reason:
            waiting.length === 1
              ? `Only one resource is registered and it is cooling down: ${waiting[0]!.reason}`
              : `Every resource is cooling down; the earliest retry is ${retryAt}`,
          alternatives: [],
          speculative,
          evaluatedAt: new Date(nowMs).toISOString(),
        }
      }

      const reason =
        ranked.length === 0
          ? 'No resource is registered, so there is nothing to route to'
          : `Every resource is unavailable: ${ranked[0]!.reason}`

      return {
        decision: 'hold',
        mode,
        action: { type: 'stop', reason },
        resourceId: null,
        waitMs: null,
        retryAt: null,
        reason,
        alternatives: [],
        speculative,
        evaluatedAt: new Date(nowMs).toISOString(),
      }
    }

    const primary = eligible[0]!
    const alternatives = eligible.slice(1)

    if (primary.decision === 'send-cautious') {
      return {
        decision: 'send-cautious',
        mode,
        action: { type: 'proceed-cautious', resourceId: primary.resourceId, note: primary.reason },
        resourceId: primary.resourceId,
        waitMs: null,
        retryAt: null,
        reason: primary.reason,
        alternatives: alternatives.map((entry) => ({
          resourceId: entry.resourceId,
          score: entry.score,
          reason: entry.reason,
        })),
        speculative,
        evaluatedAt: new Date(nowMs).toISOString(),
      }
    }

    return {
      decision: 'send',
      mode,
      action: { type: 'proceed', resourceId: primary.resourceId },
      resourceId: primary.resourceId,
      waitMs: null,
      retryAt: null,
      reason: primary.reason,
      alternatives: alternatives.map((entry) => ({
        resourceId: entry.resourceId,
        score: entry.score,
        reason: entry.reason,
      })),
      speculative,
      evaluatedAt: new Date(nowMs).toISOString(),
    }
  }

  // ---------------------------------------------------------------------------
  // In-flight accounting
  // ---------------------------------------------------------------------------

  /**
   * Raises the instantaneous gauges of a resource before the operation leaves the
   * process. Gauges model levels that exist while a call is open ? in-flight
   * requests, open connections, queued jobs ? which is the limit most likely to
   * be hit by a burst no request-rate window can see.
   *
   * Window counters take a hold in the same call: the amount is promised out of
   * the current window, visible to every later `decide()` until this operation
   * settles or the window rolls. A hold is not usage ? learning never sees it ?
   * it is the engine remembering its own outstanding advice so eight concurrent
   * decisions do not all read the same empty level. Over-reservation
   * self-corrects at the window roll; under-reservation (never calling this)
   * behaves exactly as before.
   */
  reserve(input: ReserveInput): ReserveResult {
    const nowMs = resolveInstant(this.clock, input.now).getTime()
    const spec = this.registry.get(input.resourceId)

    if (!spec) {
      return { resourceId: input.resourceId, gauges: {}, windows: {}, at: new Date(nowMs).toISOString() }
    }

    const runtime = this.ensureRuntime(input.resourceId, spec)
    const operations = resolveOperationCount(input.operations)
    const gauges: Record<string, number> = {}
    const windows: Record<string, number> = {}

    for (const counter of spec.counters) {
      if (counter.kind === 'gauge') {
        const ledger = runtime.counters[counter.counterId]!

        adjustGaugeLevel(ledger, resolveCharge(counter, input.charges, operations))
        gauges[counter.counterId] = ledger.gaugeLevel
        continue
      }

      if (counter.kind !== 'window') {
        continue
      }

      const windowKey = windowKeyAt(counter, nowMs)

      if (windowKey == null) {
        continue
      }

      const amount = resolveCharge(counter, input.charges, operations)

      if (!(amount > 0)) {
        continue
      }

      const key = windowHoldKey(input.resourceId, counter.counterId)
      const stored = this.windowHolds.get(key)

      if (stored && stored.windowKey === windowKey) {
        stored.amount += amount
      } else {
        // A hold stamped for a dead window is replaced, not topped up: the
        // previous promise belonged to quota that no longer exists.
        this.windowHolds.set(key, { windowKey, amount })
      }

      windows[counter.counterId] = this.windowHolds.get(key)!.amount
    }

    return { resourceId: input.resourceId, gauges, windows, at: new Date(nowMs).toISOString() }
  }

  /**
   * Live held amount for one window counter: the stored promise, but only
   * while its window is still the current one. A hold for a rolled window is
   * already invisible to routing; dropping the entry here only reclaims it ?
   * the matching `settle()`, if it ever arrives, treats a missing entry as
   * "nothing to release".
   */
  private liveWindowHold(resourceId: string, counter: CounterSpec, nowMs: number): number {
    const key = windowHoldKey(resourceId, counter.counterId)
    const stored = this.windowHolds.get(key)

    if (!stored) {
      return 0
    }

    if (stored.windowKey !== windowKeyAt(counter, nowMs)) {
      this.windowHolds.delete(key)
      return 0
    }

    return stored.amount
  }

  // ---------------------------------------------------------------------------
  // Outcome settlement
  // ---------------------------------------------------------------------------

  /**
   * Reports what happened to one operation. This is the only place the engine
   * learns, so a caller that never settles has an engine that knows nothing ?
   * which is the honest outcome rather than a guess.
   *
   * One settlement, one observation: the ledgers are read exactly once, before
   * anything is charged or released, and every consumer below ? the legacy
   * estimates, the shadow constraints, the attribution ? reads that one record
   * instead of going back to the ledgers on its own schedule.
   */
  settle(input: OutcomeInput): SettlementResult {
    if (input.requestId != null) {
      if (input.eventId != null && input.eventId !== input.requestId) throw new Error('eventId must match requestId')
      input = { ...input, eventId: input.requestId }
    }
    const nowMs = resolveInstant(this.clock, input.settledAt).getTime()
    const settledAt = new Date(nowMs).toISOString()
    const spec = this.registry.get(input.resourceId)
    const runtime = this.ensureRuntime(input.resourceId, spec)

    const dispatchKey = input.requestId == null ? null : eventKey(input.resourceId, input.requestId)
    const dispatch = dispatchKey == null ? undefined : this.dispatches.get(dispatchKey)
    const startedAt = dispatch?.startedAt
    if (dispatchKey != null && !this.settledEvents.has(dispatchKey) && (startedAt == null || nowMs < startedAt)) {
      throw new Error('Settlement requires a recorded dispatch and cannot precede it')
    }
    if (dispatch && input.usage?.operations != null && input.usage.operations !== 1) throw new Error('A recorded dispatch settles exactly one operation')

    // Replay guard first: a repeated eventId must not charge, learn, cool, or
    // attribute a second time. Nothing at all is settled, and the caller is
    // told so rather than being handed a second copy of a fact it already has.
    if (input.eventId != null) {
      const key = eventKey(input.resourceId, input.eventId)

      if (this.settledEvents.has(key)) {
        return {
          resourceId: input.resourceId,
          settledAt,
          attribution: null,
          observation: null,
          replay: true,
        }
      }

      this.settledEvents.add(key)

      if (this.settledEvents.size > REPLAY_MEMORY) {
        // Insertion order is the settle order, so the first key is the oldest.
        const oldest = this.settledEvents.values().next().value

        if (oldest != null) {
          this.settledEvents.delete(oldest)
        }
      }
    }

    if (dispatchKey != null && startedAt != null) {
      input = { ...input, startedAt: new Date(startedAt).toISOString() }
      this.dispatches.delete(dispatchKey)
      this.pacing.settle(input.resourceId, input.kind, startedAt, nowMs)
    }
    const operations = resolveOperationCount(input.usage?.operations)
    const observation = normalizeObservation(
      input,
      spec?.counters ?? [],
      this.readCounters(spec, runtime, nowMs),
      settledAt,
    )

    this.releaseGauges(runtime, spec, dispatch ? dispatch.charges : input.usage?.charges, operations)
    this.releaseWindowHolds(spec, input.resourceId, dispatch ? dispatch.charges : input.usage?.charges, operations, nowMs, startedAt)
    this.applyProviderSignal(observation)

    switch (input.kind) {
      case 'success':
        this.applySuccess(spec, runtime, input, observation, operations, nowMs)
        break
      case 'rate-limit':
        return {
          resourceId: input.resourceId,
          settledAt,
          attribution: this.applyRejection(spec, runtime, observation, nowMs, settledAt),
          observation,
        }
      case 'credential-rejected':
      case 'transport-failure':
      case 'resource-missing':
        this.applyTypedFailure(spec, runtime, input, input.kind, nowMs, settledAt)
        break
      case 'released':
        break
    }

    return { resourceId: input.resourceId, settledAt, attribution: null, observation }
  }

  /**
   * The refill rate of a bucket counter, from the ceiling the engine currently
   * holds for it. One place, so the decay used for a reading, a charge and a
   * report is always the same rate ? a bucket measured at two different rates
   * would drift against itself exactly as the old window counters did.
   */
  private bucketRate(counter: CounterSpec, runtime: ResourceRuntime): number | null {
    if (counter.kind !== 'bucket') {
      return null
    }

    // Provider telemetry first: a stated limit is a fact, so the decay computed
    // from it is a fact too.
    const telemetry = runtime.providerTelemetry[counter.counterId]

    if (telemetry?.limit != null && telemetry.limit > 0) {
      return bucketRefillPerMs(counter, telemetry.limit)
    }

    if (counter.limit != null && counter.limit > 0) {
      return bucketRefillPerMs(counter, counter.limit)
    }

    const estimated = runtime.estimates[counter.counterId]?.estimatedLimit

    if (estimated != null && estimated > 0) {
      return bucketRefillPerMs(counter, estimated)
    }

    return null
  }

  /**
   * The single read of a resource's window counters, taken before anything is
   * charged or released. Gauges are not read here: their accounting is
   * level-of-the-instant, and the two paths that adjust them run before this
   * read would matter ? a gauge level captured here would be a fact about a
   * moment that has already changed.
   */
  private readCounters(
    spec: ResourceSpec | undefined,
    runtime: ResourceRuntime,
    nowMs: number,
  ): Map<string, CounterReading> {
    const readings = new Map<string, CounterReading>()

    if (!spec) {
      return readings
    }

    for (const counter of spec.counters) {
      if (counter.kind === 'gauge') {
        continue
      }

      const rate = this.bucketRate(counter, runtime)

      if (counter.kind === 'bucket') {
        const fallback = resolveBucketWindow(counter)

        if (fallback == null) {
          continue
        }

        // Measured at the known rate when there is one, and at the trailing
        // window of the same period when there is not ? never skipped, or the
        // bucket could never earn its first ceiling and so never earn a rate.
        readings.set(counter.counterId, {
          level: readLevel(runtime.counters[counter.counterId], counter, nowMs, rate),
          windowKey: resolveWindowKey(nowMs, fallback),
        })

        continue
      }

      if (resolveCounterWindow(counter) == null) {
        continue
      }

      readings.set(counter.counterId, {
        level: readLevel(runtime.counters[counter.counterId], counter, nowMs),
        windowKey: windowKeyAt(counter, nowMs) ?? `window:${nowMs}`,
      })
    }

    return readings
  }

  /**
   * Does an inferred caution distinguish anything right now?
   *
   * True when *some* but not all of the resources on offer are near an
   * inferred ceiling ? the state in which "this key is fuller than that one"
   * is a fact about the fleet rather than a description of the whole fleet. A
   * uniform fleet of identical keys is near all of its ceilings together or
   * none of them, so the caution there is noise, and paying attention to it is
   * exactly what cost throughput in the homogeneous-burst measurement.
   *
   * Read-only: it inspects levels and ceilings and changes no state.
   */
  private discriminationHolds(
    specs: readonly ResourceSpec[],
    nowMs: number,
    forecast: Record<string, number> | null | undefined,
  ): boolean {
    let near = 0
    let total = 0

    for (const spec of specs) {
      if (!spec.resourceId || spec.enabled === false) {
        continue
      }

      total += 1
      const runtime = this.ensureRuntime(spec.resourceId, spec)
      // Same confounding rule the decision pass uses, or this pre-pass could see
      // a softCeiling the decision path has already suppressed ? and then the
      // discrimination test would be answering a different question than the one
      // the routing is about to act on.
      const confounded = resolveConfoundedCounters(spec, runtime)
      let specNear = false

      for (const counter of spec.counters) {
        if (counter.kind === 'gauge') {
          continue
        }

        if (counter.kind === 'bucket' && resolveBucketWindow(counter) == null) {
          continue
        }

        const limit = resolveEffectiveLimit(
          counter,
          runtime.estimates[counter.counterId],
          runtime.providerTelemetry[counter.counterId],
          confounded.has(counter.counterId),
          nowMs,
        )

        // Only an inferred ceiling needs the discrimination test: an
        // authoritative one is a fact and steers on its own.
        if (limit.authoritative || limit.softCeiling == null) {
          continue
        }

        const level = readLevel(runtime.counters[counter.counterId], counter, nowMs)
        const projected = level + resolveCharge(counter, forecast, 1)

        if (isNearLimit(projected, limit)) {
          specNear = true
        }
      }

      if (specNear) {
        near += 1
      }
    }

    return near > 0 && near < total
  }

  /**
   * What the shadow OR-constraint engine concluded about one resource, per
   * counter, as of the last settlement. A projection of the ledger, rebuilt on
   * every call and mutated by nothing: read it as often as you like.
   *
   * Null when the engine holds no ledger for the resource ? it has observed
   * nothing yet, or the snapshot was restored and the ledger, being session
   * state, did not come back. That absence is reported, not papered over: a
   * knowledge view implying evidence that no longer exists would be the exact
   * failure the session scope is there to prevent.
   */
  getQuotaKnowledge(resourceId: string): readonly QuotaKnowledge[] | null {
    const ledger = this.hypotheses.get(resourceId)

    return ledger ? buildQuotaKnowledge(ledger) : null
  }

  private applySuccess(
    spec: ResourceSpec | undefined,
    runtime: ResourceRuntime,
    input: OutcomeInput,
    observation: NormalizedObservation,
    operations: number,
    nowMs: number,
  ): void {
    if (spec) {
      for (const counter of spec.counters) {
        if (counter.kind === 'gauge') {
          continue
        }

        const recorded = counterFrom(observation, counter.counterId)

        // A window counter with no resolvable window ? or a bucket with no
        // refill rate ? has no reading: it cannot be measured, so the
        // observation carries nothing for it and neither learning engine can
        // use it. It is still charged, because `charge` records
        // `totalCharged`/`lastChargeAt` and a caller reading its own runtime
        // would otherwise see traffic the engine silently dropped. The caller's
        // own words supply that amount.
        if (recorded == null) {
          const ledger = runtime.counters[counter.counterId]

          if (ledger) {
            chargeLedger(ledger, counter, resolveCharge(counter, input.usage?.charges, operations), nowMs, resolveCounterWindow(counter), this.bucketRate(counter, runtime))
          }

          continue
        }

        const ledger = runtime.counters[counter.counterId]!
        const window = resolveCounterWindow(counter)

        chargeLedger(ledger, counter, recorded.charge, nowMs, window, this.bucketRate(counter, runtime))

        // `attempted` is the post-charge level ? the level this success proves
        // the window carried ? taken from the one observation rather than by
        // re-reading the ledger after charging it.
        const estimate = runtime.estimates[counter.counterId]

        if (estimate) {
          // Feeding the real level back is what keeps an inference honest: a
          // limit that turned out to be too low gets revised, not obeyed.
          observeSuccessfulLevel(counter, estimate, {
            observedValue: recorded.attempted,
            occurredAt: observation.settledAt,
          })
        }
      }
    }

    // Shadow ledger: the same observation, consumed as a record rather than
    // re-read. Levels are the same ones the legacy path just charged.
    this.feedHypotheses(spec, observation)

    // A response to an older in-flight request does not prove a newer refusal recovered.
    if (input.startedAt != null && runtime.lastFailureAt != null && parseTimestamp(input.startedAt) <= parseTimestamp(runtime.lastFailureAt)) return
    const hadCooldown = runtime.cooldowns.length > 0
    runtime.cooldowns = []
    runtime.lastUsedAt = observation.settledAt
    runtime.lastHealthOutcome = 'success'

    if (spec?.quotaGroupId) {
      const group = this.ensureQuotaGroup(spec.quotaGroupId)

      // A success proves the shared allowance is not blocking this resource.
      if (input.startedAt == null || group.lastRateLimitAt == null || parseTimestamp(input.startedAt) > parseTimestamp(group.lastRateLimitAt)) {
        group.cooldowns = []
      }
    }

    if (hadCooldown) {
      this.appendEvent(
        runtime,
        'recovered',
        'A successful operation cleared the previous cooldown.',
        nowMs,
        null,
      )
    }
  }

  private applyRejection(
    spec: ResourceSpec | undefined,
    runtime: ResourceRuntime,
    observation: NormalizedObservation,
    nowMs: number,
    settledAt: string,
  ): RejectionAttribution {
    const rejection = observation.rejection
    const retryAfterSeconds = rejection?.retryAfterSeconds ?? null
    const providerResetAt = rejection?.providerResetAt ?? null
    const providerResetMs = parseTimestamp(providerResetAt)

    if (spec) {
      this.recordBoundarySamples(spec, runtime, observation)
    }

    // Shadow ledger second: the same observation, consumed as a record. Window
    // ledgers were not charged by the legacy path above, so the levels here are
    // the ones it sampled ? from the same record, not from a second read.
    this.feedHypotheses(spec, observation)

    const attribution = this.attribute(spec, runtime, observation, {
      settledAt,
      nowMs,
      retryAfterSeconds,
      providerResetAt,
    })

    // Read-only by construction: the report is attached to the output and never
    // read back by any decision. Routing cannot see it.
    const shadow = spec != null ? this.hypotheses.get(spec.resourceId) : undefined

    if (shadow) {
      attribution.hypotheses = buildHypothesisReport(shadow, settledAt)
    }

    const { blockedUntilMs, source, authoritative } = resolveCooldownWindow({
      nowMs,
      retryAfterSeconds,
      providerResetMs,
      // Only a window the provider *named* may park this resource until that
      // window ends. A window the engine merely guessed at must not: attribution
      // is a conclusion from a single rejection, and pinning a key to the end of
      // its day because the engine guessed "rpd" is how one bad guess takes a
      // whole fleet offline until midnight. A guessed cause caps the wait at the
      // earliest rollover instead ? the soonest anything could plausibly free
      // up, and if the guess was wrong the cost is one more rejection, which is
      // exactly how the next guess gets better.
      suspectedWindowEndMs:
        attribution.source === 'reported' ? this.suspectedWindowEnd(spec, runtime, attribution, nowMs) : null,
      anyWindowEndMs: this.earliestWindowEnd(spec, nowMs),
    })

    const scope: CooldownScope =
      observation.rejection?.limitScope === 'quota-group' && spec?.quotaGroupId
        ? 'quota-group'
        : 'resource'

    const cooldown: Cooldown = {
      id: this.nextId('cd'),
      kind: 'rate-limit',
      counterId: attribution.suspectCounterId,
      scope,
      blockedUntil: new Date(blockedUntilMs).toISOString(),
      setAt: settledAt,
      source,
      detail:
        observation.rejection?.detail?.trim() ||
        `${spec?.resourceId ?? runtime.resourceId} was rejected; ${attribution.cause === 'resolved' ? `most likely ${attribution.suspectCounterId}` : 'cause unresolved'}.`,
      // A cooldown backed by a provider fact is authoritative; one derived from
      // a guessed window boundary is not, and `off` mode ignores it.
      authoritative,
    }

    // Experiment knob, on by default. Off drops waits the engine *guessed* (an
    // inferred window boundary) while keeping every provider-backed one: a
    // retry-after or a reset the provider actually sent is a fact and still
    // withholds the request. The failure memory is untouched ? this is about
    // whether the engine parks a key, not about whether it demotes one.
    if (authoritative || this.inferredCooldowns) {
      this.pushCooldown(runtime, spec, scope, cooldown)
    }

    this.appendEvent(
      runtime,
      'rate-limit',
      cooldown.detail,
      nowMs,
      parseTimestamp(cooldown.blockedUntil),
    )
    // Recorded in every mode: whether to *act* on it is a mode question, but
    // that it happened is a measurement, and the engine's job is to measure.
    runtime.lastFailureAt = settledAt
    runtime.lastHealthOutcome = 'failure'

    return attribution
  }

  /**
   * Legacy boundary sampling, now reading the one observation instead of going
   * back to the ledger. The numbers recorded are the same numbers it has always
   * recorded ? `observedValue`/`attemptedValue`, the named counter's
   * caller-supplied charge, the window key ? which is the point: normalization
   * changes where the numbers come from, not what they are.
   */
  private recordBoundarySamples(
    spec: ResourceSpec,
    runtime: ResourceRuntime,
    observation: NormalizedObservation,
  ): void {
    for (const counter of spec.counters) {
      // A bucket is measured like a window; only a gauge ? and a window with no
      // resolvable window, or a bucket with no refill rate to measure against ?
      // carries nothing to sample.
      if (counter.kind === 'gauge') {
        continue
      }

      if (counter.kind === 'window' && resolveCounterWindow(counter) == null) {
        continue
      }

      if (counter.kind === 'bucket' && resolveBucketWindow(counter) == null) {
        continue
      }

      const estimate = runtime.estimates[counter.counterId] ?? createEstimate(counter.counterId)

      runtime.estimates[counter.counterId] = estimate

      // A provider-declared limit is not out-voted by local evidence, and a
      // counter that cannot be inferred from (a gauge) never records a sample.
      if (estimate.source === 'provider') {
        continue
      }

      const recorded = counterFrom(observation, counter.counterId)

      if (recorded == null) {
        continue
      }

      // The rejected operation may itself have counted against the window; when
      // the caller says so, the sample reflects that ? so the named counter
      // reports what the refused attempt would have carried, and every other
      // counter reports the level it was actually at. The named counter is the
      // caller's own `rejectedCounterId`, exactly as it has always been: the
      // derived single-`blamedCounterIds` rule belongs to the shadow's scope
      // decision, not to this sampler.
      const isReportedCounter =
        observation.rejection?.rejectedCounterId === counter.counterId

      recordBoundarySample(counter, estimate, {
        counterId: counter.counterId,
        occurredAt: observation.settledAt,
        windowKey: recorded.windowKey,
        observedValue: isReportedCounter ? recorded.attempted : recorded.usage,
        attemptedValue: recorded.attempted,
        unit: counter.unit,
        retryAfterSeconds: observation.rejection?.retryAfterSeconds ?? null,
        providerResetAt: observation.rejection?.providerResetAt ?? null,
      })
    }
  }

  /**
   * Feeds one observation to the shadow evidence ledger. Read-only by
   * construction: this method returns void, writes nowhere the decision path
   * reads, and exists so the same refusal can be reviewed twice ? once by the
   * legacy per-counter sampler above, once by the OR-constraint engine that
   * keeps the refusal whole. Any divergence the two produce is itself the
   * measurement the next integration step needs.
   *
   * Both engines now consume the same record, so the "same evidence" property
   * is structural rather than maintained by two parallel readings.
   */
  private feedHypotheses(
    spec: ResourceSpec | undefined,
    observation: NormalizedObservation,
  ): void {
    if (!spec) {
      return
    }

    let ledger = this.hypotheses.get(spec.resourceId)

    if (!ledger) {
      ledger = createHypothesisLedger(
        spec.resourceId,
        spec.counters
          .filter((counter) => counter.kind === 'window' && resolveCounterWindow(counter) != null)
          .map((counter) => ({
            counterId: counter.counterId,
            windowMs: resolveCounterWindow(counter)!.windowMs,
            unit: counter.unit,
          })),
      )
      this.hypotheses.set(spec.resourceId, ledger)
    }

    const attempted: Record<string, number> = {}
    const windowKeys: Record<string, string> = {}
    const shape = observation.trafficShape

    for (const recorded of observation.counters) {
      // A refusal is evidence about the level it was refused at; an acceptance
      // is evidence about the level it reached. Both are the observation's own
      // `attempted`, which is why the two engines cannot drift apart any more.
      attempted[recorded.counterId] = recorded.attempted
      windowKeys[recorded.counterId] = recorded.windowKey
    }

    if (observation.kind === 'rate-limit') {
      // Exactly one named counter is a provider fact about this refusal; several
      // named counters, or none, leave the cause set as the ledger declares it.
      const rejection = observation.rejection
      const blamed = rejection?.blamedCounterIds ?? null

      observeRejected(ledger, {
        at: observation.settledAt,
        attempted,
        windowKeys,
        scope: rejectedScope(blamed),
        reportedCounter: rejection?.reportedCounterId ?? null,
        trafficShape: shape,
      })
    } else if (observation.kind === 'success') {
      observeAccepted(ledger, { at: observation.settledAt, attempted, windowKeys, trafficShape: shape })
    }
  }

  private attribute(
    spec: ResourceSpec | undefined,
    runtime: ResourceRuntime,
    observation: NormalizedObservation,
    context: {
      settledAt: string
      nowMs: number
      retryAfterSeconds: number | null
      providerResetAt: string | null
    },
  ): RejectionAttribution {
    if (!spec) {
      return {
        settledAt: context.settledAt,
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
        retryAt: null,
        nextEvidenceAt: null,
      }
    }

    const assessments: CounterAssessment[] = []
    const limits = new Map<string, EffectiveLimit>()
    const estimates = new Map<string, CounterEstimate>()
    const ends = new Map<string, string | null>()
    const confounded = resolveConfoundedCounters(spec, runtime)

    for (const counter of spec.counters) {
      // Every counter's level comes from the one observation when it has one,
      // and from a live read only for the counters the observation cannot
      // carry: gauges (their level is adjusted before this runs), and window
      // counters with no resolvable window (which no reading can place).
      const recorded = counterFrom(observation, counter.counterId)
      const level = recorded != null
        ? recorded.usage
        : readLevel(runtime.counters[counter.counterId], counter, context.nowMs)
      const limit = resolveEffectiveLimit(
        counter,
        runtime.estimates[counter.counterId],
        runtime.providerTelemetry[counter.counterId],
        confounded.has(counter.counterId),
        context.nowMs,
      )
      const estimate = runtime.estimates[counter.counterId]

      if (estimate) {
        estimates.set(counter.counterId, estimate)
      }

      limits.set(counter.counterId, limit)
      ends.set(counter.counterId, windowEndAt(counter, context.nowMs))
      assessments.push(
        assessCounter({
          counter,
          limit,
          estimate,
          level,
          projectedLevel: level,
          // Attribution is a diagnostic, not a decision: it reports what the
          // counters looked like when the rejection landed, identically in every
          // mode. `smart` is the reference view where facts are visible and
          // nothing learned is allowed to withhold.
          mode: 'smart',
          nextResetAt: ends.get(counter.counterId) ?? null,
          label: counterDisplayLabel(counter),
        }),
      )
    }

    return attributeRejection({
      settledAt: context.settledAt,
      assessments,
      limits,
      estimates,
      specs: spec.counters,
      // The named counters, from the one observation: a reported cause is a fact
      // about this refusal, so the attribution reads the same record the shadow
      // and the legacy sampler did. Filtered to strings here, as the ledger has
      // always done ? `attributedByName` treats an empty list and a null alike.
      blamedCounterIds: observation.rejection?.blamedCounterIds ?? null,
      retryAfterSeconds: context.retryAfterSeconds,
      providerResetAt: context.providerResetAt,
      settledAtMs: context.nowMs,
      windowEndAt: ends,
    })
  }

  private applyTypedFailure(
    spec: ResourceSpec | undefined,
    runtime: ResourceRuntime,
    input: OutcomeInput,
    kind: 'credential-rejected' | 'transport-failure' | 'resource-missing',
    nowMs: number,
    settledAt: string,
  ): void {
    const policy = TYPED_FAILURE_POLICY[kind]
    const durationMs = this.durations[policy.option]
    const detail = input.detail?.trim() ?? policy.detail

    const cooldown: Cooldown = {
      id: this.nextId('cd'),
      kind: policy.kind,
      counterId: null,
      scope: 'resource',
      blockedUntil: new Date(nowMs + durationMs).toISOString(),
      setAt: settledAt,
      source: 'typed-failure-policy',
      detail,
      // The provider stated this outright, so it is a fact rather than an
      // inference and is honoured even in `off` mode.
      authoritative: true,
    }

    this.pushCooldown(runtime, spec, 'resource', cooldown)
    this.appendEvent(runtime, policy.event, detail, nowMs, nowMs + durationMs)

    // A transport blip is the one failure that says nothing about this key's
    // standing ? its own short cooldown already covers it, and remembering a
    // network hiccup for an hour would push traffic off a perfectly good key.
    if (kind !== 'transport-failure') {
      runtime.lastFailureAt = settledAt
      runtime.lastHealthOutcome = 'failure'
    }
  }

  private releaseGauges(
    runtime: ResourceRuntime,
    spec: ResourceSpec | undefined,
    charges: Record<string, number> | null | undefined,
    operations: number,
  ): void {
    if (!spec) {
      return
    }

    for (const counter of spec.counters) {
      if (counter.kind !== 'gauge') {
        continue
      }

      const ledger = runtime.counters[counter.counterId]

      if (ledger) {
        adjustGaugeLevel(ledger, -resolveCharge(counter, charges, operations))
      }
    }
  }

  /**
   * Releases one operation's window holds on every outcome kind: the operation
   * is over, so its promise is over with it, whether it succeeded, was
   * rejected, or failed another way. A hold stamped for a window that has
   * since rolled was already invisible to every read; dropping it here only
   * reclaims the entry. Like gauges, this runs before any learning, and like
   * gauges it touches no estimate, sample, or telemetry.
   */
  private releaseWindowHolds(
    spec: ResourceSpec | undefined,
    resourceId: string,
    charges: Record<string, number> | null | undefined,
    operations: number,
    nowMs: number,
    reservedAtMs?: number,
  ): void {
    if (!spec) {
      return
    }

    for (const counter of spec.counters) {
      if (counter.kind !== 'window') {
        continue
      }

      const key = windowHoldKey(resourceId, counter.counterId)
      const stored = this.windowHolds.get(key)

      if (!stored) {
        continue
      }

      if (stored.windowKey !== windowKeyAt(counter, nowMs)) {
        this.windowHolds.delete(key)
        continue
      }

      if (reservedAtMs != null && stored.windowKey !== windowKeyAt(counter, reservedAtMs)) continue
      const left = stored.amount - resolveCharge(counter, charges, operations)

      if (left <= 0) {
        this.windowHolds.delete(key)
      } else {
        stored.amount = left
      }
    }
  }

  private applyProviderSignal(observation: NormalizedObservation): void {
    const signal = observation.provider

    if (!signal) {
      return
    }

    const runtime = this.ensureRuntime(observation.resourceId, this.registry.get(observation.resourceId))
    const observedAt = signal.observedAt?.trim() || observation.settledAt
    const source = signal.source?.trim() || 'provider'

    for (const counterSignal of signal.counters ?? []) {
      if (!counterSignal?.counterId) {
        continue
      }

      const { telemetry, declaredLimit } = mergeProviderTelemetry(
        runtime.providerTelemetry[counterSignal.counterId],
        counterSignal,
        { observedAt, source },
      )

      if (telemetry) {
        runtime.providerTelemetry[counterSignal.counterId] = telemetry
      }

      if (declaredLimit != null) {
        const estimate = runtime.estimates[counterSignal.counterId] ?? createEstimate(counterSignal.counterId)

        runtime.estimates[counterSignal.counterId] = estimate
        applyProviderDeclaredLimit(estimate, declaredLimit, observedAt)
      }
    }

    if (
      signal.retryAfterSeconds != null &&
      Number.isFinite(signal.retryAfterSeconds) &&
      signal.retryAfterSeconds >= 0
    ) {
      runtime.providerRetryAfter = {
        seconds: signal.retryAfterSeconds,
        observedAt,
        source,
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Reporting
  // ---------------------------------------------------------------------------

  /**
   * Lists counters that real rejections have ruled out as the limiter, so a
   * report can say so explicitly rather than silently omitting them.
   *
   * This is a read-only projection of the snapshot. Nothing here schedules work,
   * and no entry implies that a request should be sent.
   */
  listClearedCounters(): ClearedCounterReport[] {
    const reports: ClearedCounterReport[] = []

    for (const [resourceId, runtime] of Object.entries(this.snapshot.resources)) {
      const spec = this.registry.get(resourceId)
      const counters: ClearedCounterReport['counters'] = []

      for (const [counterId, estimate] of Object.entries(runtime.estimates)) {
        if (estimate.status !== 'cleared') {
          continue
        }

        const counter = spec?.counters.find((entry) => entry.counterId === counterId)
        const lastSample = estimate.samples[estimate.samples.length - 1]

        counters.push({
          counterId,
          unit: counter?.unit ?? estimate.samples[0]?.unit ?? 'count',
          clearedAt: estimate.lastRateLimitAt ?? estimate.updatedAt ?? '',
          rejectedLevel: lastSample?.observedValue ?? 0,
          previousEstimate: estimate.estimatedLimit,
        })
      }

      if (counters.length > 0) {
        reports.push({ resourceId, counters })
      }
    }

    return reports
  }

  /** Drops expired cooldowns and stale ledger buckets. */
  gc(now?: string | Date | number): void {
    const nowMs = resolveInstant(this.clock, now).getTime()

    for (const runtime of Object.values(this.snapshot.resources)) {
      runtime.cooldowns = runtime.cooldowns.filter(
        (cooldown) => parseTimestamp(cooldown.blockedUntil) > nowMs,
      )
      runtime.events = runtime.events.slice(-MAX_EVENTS_PER_RESOURCE)
    }

    for (const group of Object.values(this.snapshot.quotaGroups)) {
      group.cooldowns = group.cooldowns.filter(
        (cooldown) => parseTimestamp(cooldown.blockedUntil) > nowMs,
      )
    }

    this.snapshot.events = this.snapshot.events.slice(-MAX_GLOBAL_EVENTS)
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private ensureRuntime(resourceId: string, spec?: ResourceSpec): ResourceRuntime {
    let runtime = this.snapshot.resources[resourceId]

    if (!runtime) {
      runtime = createResourceRuntime(resourceId)
      this.snapshot.resources[resourceId] = runtime
    }

    if (!spec) {
      return runtime
    }

    for (const counter of spec.counters) {
      if (!runtime.counters[counter.counterId]) {
        runtime.counters[counter.counterId] = createLedgerState(counter)
      }

      if (!runtime.estimates[counter.counterId]) {
        runtime.estimates[counter.counterId] = createEstimate(counter.counterId)
      } else {
        // The snapshot cannot recompute derived state without a declared window,
        // so the first time the spec is known the estimate is brought in line
        // with the current policy.
        recomputeEstimate(counter, runtime.estimates[counter.counterId]!)
      }
    }

    if (spec.quotaGroupId) {
      this.ensureQuotaGroup(spec.quotaGroupId)
    }

    return runtime
  }

  private ensureQuotaGroup(quotaGroupId: string) {
    let group = this.snapshot.quotaGroups[quotaGroupId]

    if (!group) {
      group = { quotaGroupId, cooldowns: [], lastRateLimitAt: null }
      this.snapshot.quotaGroups[quotaGroupId] = group
    }

    return group
  }

  private collectActiveCooldowns(
    runtime: ResourceRuntime,
    quotaGroupId: string | null | undefined,
    nowMs: number,
  ): Cooldown[] {
    const groupCooldowns =
      quotaGroupId != null ? this.snapshot.quotaGroups[quotaGroupId]?.cooldowns ?? [] : []

    return [...runtime.cooldowns, ...groupCooldowns]
      .filter((cooldown) => parseTimestamp(cooldown.blockedUntil) > nowMs)
      .sort((left, right) => left.blockedUntil.localeCompare(right.blockedUntil))
  }

  private pushCooldown(
    runtime: ResourceRuntime,
    spec: ResourceSpec | undefined,
    scope: CooldownScope,
    cooldown: Cooldown,
  ): void {
    if (scope === 'quota-group' && spec?.quotaGroupId) {
      const group = this.ensureQuotaGroup(spec.quotaGroupId)

      group.cooldowns = [...group.cooldowns, cooldown].slice(-MAX_COOLDOWNS_PER_SCOPE)
      group.lastRateLimitAt = cooldown.setAt
      return
    }

    runtime.cooldowns = [...runtime.cooldowns, cooldown].slice(-MAX_COOLDOWNS_PER_SCOPE)
  }

  private appendEvent(
    runtime: ResourceRuntime,
    kind: ThrottleEventKind,
    detail: string,
    nowMs: number,
    nextEligibleAtMs: number | null,
  ): void {
    const trimmed = detail.trim()

    if (!trimmed) {
      return
    }

    const event = {
      id: this.nextId('evt'),
      kind,
      createdAt: new Date(nowMs).toISOString(),
      detail: trimmed,
      nextEligibleAt: toIso(nextEligibleAtMs),
    }

    runtime.events = [...runtime.events, event].slice(-MAX_EVENTS_PER_RESOURCE)
    this.snapshot.events = [...this.snapshot.events, event].slice(-MAX_GLOBAL_EVENTS)
  }

  private suspectedWindowEnd(
    spec: ResourceSpec | undefined,
    runtime: ResourceRuntime,
    attribution: RejectionAttribution,
    nowMs: number,
  ): number | null {
    if (!spec || attribution.suspectCounterId == null) {
      return null
    }

    const counter = spec.counters.find((entry) => entry.counterId === attribution.suspectCounterId)

    if (!counter) {
      return null
    }

    const window = resolveWindow(counter)
    return window ? resolveWindowEnd(nowMs, window) : null
  }

  private earliestWindowEnd(spec: ResourceSpec | undefined, nowMs: number): number | null {
    if (!spec) {
      return null
    }

    let earliest: number | null = null

    for (const counter of spec.counters) {
      const window = resolveWindow(counter)

      if (!window) {
        continue
      }

      const end = resolveWindowEnd(nowMs, window)

      if (earliest == null || end < earliest) {
        earliest = end
      }
    }

    return earliest
  }

  private nextId(prefix: string): string {
    this.idCounter += 1
    return `${prefix}-${this.idCounter}`
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Which counters on a resource are confounded: a *shorter* window on the same
 * resource still holds a live estimate, so this counter's rejection level cannot
 * be separated from it.
 *
 * A rejection lands in every open window at once, which is exactly why a longer
 * counter's level is so easy to mistake for a ceiling ? it reproduces because
 * the traffic pattern reproduces, not because the provider counted to it. Two
 * corrections to the obvious rule: a counter already `cleared` is no longer an
 * explanation for anything, so it does not confound; and a window of equal
 * length does not confound either, because two counters that reset together are
 * indistinguishable rather than one nested inside the other.
 */
function resolveConfoundedCounters(spec: ResourceSpec, runtime: ResourceRuntime): Set<string> {
  const windows = new Map<string, number>()
  const live = new Set<string>()

  for (const counter of spec.counters) {
    const window = resolveCounterWindow(counter)

    if (window) {
      windows.set(counter.counterId, window.windowMs)
    }

    const estimate = runtime.estimates[counter.counterId]

    if (estimate && estimate.estimatedLimit != null && estimate.status !== 'cleared') {
      live.add(counter.counterId)
    }
  }

  const confounded = new Set<string>()

  for (const counterId of live) {
    const own = windows.get(counterId)

    if (own == null) {
      continue
    }

    for (const [otherId, otherWindowMs] of windows) {
      if (otherId === counterId || otherWindowMs >= own || !live.has(otherId)) {
        continue
      }

      confounded.add(counterId)
      break
    }
  }

  return confounded
}

function normalizeMode(mode: unknown): ThrottleMode | null {
  return THROTTLE_MODES.find((candidate) => candidate === mode) ?? null
}

function resolveDuration(value: number | null | undefined, fallback: number): number {
  const parsed = toFiniteNumber(value)
  return parsed == null ? fallback : Math.max(0, Math.trunc(parsed))
}

function describeCooldown(cooldown: Cooldown): string {
  switch (cooldown.kind) {
    case 'rate-limit':
      return cooldown.counterId != null
        ? `rate-limited on ${cooldown.counterId}`
        : 'rate-limited by the provider'
    case 'quota-exhausted':
      return cooldown.counterId != null
        ? `${cooldown.counterId} has no capacity left`
        : 'quota capacity exhausted'
    case 'credential-rejected':
      return 'the credential was rejected'
    case 'transport-failure':
      return 'recovering from a transport failure'
    case 'resource-missing':
      return 'the resource is missing upstream'
    case 'manual':
      return 'parked by an operator'
  }
}

/**
 * Which cooldowns may withhold a request in this mode.
 *
 * `off` honours only provider-stated cooldowns: ignoring a fact the provider just
 * sent would waste a request to learn nothing. `observe` honours none ? it exists
 * to produce advice, not to withhold.
 */
function selectBlockingCooldowns(cooldowns: Cooldown[], mode: ThrottleMode): Cooldown[] {
  if (mode === 'observe') {
    return []
  }

  if (mode === 'off') {
    return cooldowns.filter((cooldown) => cooldown.authoritative)
  }

  return cooldowns
}

/**
 * Chooses how long to hold a rejected resource, preferring the strongest evidence
 * available: an explicit retry-after, then a declared reset, then the window the
 * rejection is attributed to, then the shortest window, then a short fixed
 * fallback. A hold backed by a fact is marked authoritative; one derived from
 * window arithmetic is not.
 */
function resolveCooldownWindow(input: {
  nowMs: number
  retryAfterSeconds: number | null
  providerResetMs: number
  suspectedWindowEndMs: number | null
  anyWindowEndMs: number | null
}): { blockedUntilMs: number; source: CooldownSource; authoritative: boolean } {
  if (input.retryAfterSeconds != null) {
    return {
      blockedUntilMs: input.nowMs + input.retryAfterSeconds * 1000,
      source: 'provider-retry-after',
      authoritative: true,
    }
  }

  if (input.providerResetMs > input.nowMs) {
    return {
      blockedUntilMs: input.providerResetMs,
      source: 'provider-reset',
      authoritative: true,
    }
  }

  const windowEnd = input.suspectedWindowEndMs ?? input.anyWindowEndMs

  if (windowEnd != null && windowEnd > input.nowMs) {
    return {
      blockedUntilMs: windowEnd,
      source: 'window-boundary',
      authoritative: false,
    }
  }

  return {
    blockedUntilMs: input.nowMs + REJECTION_FALLBACK_HOLD_MS,
    source: 'typed-failure-policy',
    authoritative: true,
  }
}
