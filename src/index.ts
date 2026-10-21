/**
 * Adaptive Throttle — public API.
 *
 * A rate-limit and capacity manager for any quota-bearing service: AI model
 * providers, payment gateways, email and SMS senders, mapping and geocoding
 * APIs, scraping backends, job queues, internal services with concurrency caps.
 *
 * The engine learns each resource's real limits from real rejections and answers
 * two questions: which resource should the next operation go to, and — after a
 * rejection — which window was actually at fault.
 *
 * ```ts
 * const engine = new AdaptiveThrottleEngine()
 *
 * engine.register([
 *   {
 *     resourceId: 'key-1',
 *     counters: [
 *       { counterId: 'rpm', window: { windowMs: 60_000 }, unit: 'count' },
 *       { counterId: 'rph', window: { windowMs: 3_600_000 }, unit: 'count' },
 *       { counterId: 'rpd', window: { windowMs: 86_400_000, dayAligned: true }, unit: 'count' },
 *       { counterId: 'inflight', kind: 'gauge', unit: 'count', limit: 8 },
 *     ],
 *   },
 *   { resourceId: 'key-2', counters: [/* … *\/] },
 * ])
 *
 * const { advice } = engine.decide()
 *
 * if (advice.action.type === 'proceed') {
 *   const result = await call(advice.resourceId!)
 *   engine.settle({ resourceId: advice.resourceId!, kind: 'success' })
 * }
 * ```
 */

export * from './identity.js'
export * from './types.js'
export * from './pacing.js'
export * from './clock.js'
export {
  DAY_MS,
  MAX_WINDOW_MS,
  MIN_WINDOW_MS,
  isValidTimeZone,
  pruneBuckets,
  resolveBucketStart,
  resolveDayBucket,
  resolveDayStart,
  resolveDayWindowKey,
  resolveExplicitResetTimestamp,
  resolveNextDayBoundary,
  resolveWindow,
  resolveWindowEnd,
  resolveWindowKey,
  resolveWindowLevel,
  sumBuckets,
  type ResolvedWindow,
} from './windows.js'
export {
  DEFAULT_TOLERANCE_RATIO,
  adjustGaugeLevel,
  charge,
  counterDisplayLabel,
  createLedgerState,
  normalizeCounter,
  normalizeResource,
  normalizeToleranceSpec,
  readLevel,
  resolveCharge,
  resolveCounterWindow,
  resolveOperationCount,
  resolveTolerance,
  resolveToleranceFloor,
  setGaugeLevel,
  windowEndAt,
  windowKeyAt,
} from './counters.js'
export {
  ESTABLISHMENT_MIN_INDEPENDENT_WINDOWS,
  MAX_RETAINED_SAMPLES,
  applyProviderDeclaredLimit,
  createEstimate,
  createEstimateStore,
  isActionableEstimate,
  mergeProviderTelemetry,
  normalizeEstimate,
  observeSuccessfulLevel,
  recomputeEstimate,
  recordBoundarySample,
  supportsInference,
} from './estimates.js'
export {
  MAX_COOLDOWNS_PER_SCOPE,
  MAX_EVENTS_PER_RESOURCE,
  MAX_GLOBAL_EVENTS,
  createEmptySnapshot,
  createResourceRuntime,
  normalizeSnapshot,
} from './normalize.js'
export {
  NEAR_LIMIT_RATIO,
  UNPROVEN_FAILURE_SCORE_FACTOR,
  assessCounter,
  computeResourceScore,
  computeUtilization,
  decideFromAssessments,
  hasUnprovenFailure,
  isNearLimit,
  mayBlockOnLevel,
  remainingProvesExhaustion,
  remainingShare,
  resolveEffectiveLimit,
  type EffectiveLimit,
} from './policy.js'
export {
  ATTRIBUTION_MIN_CONFIDENCE,
  SUSPICION_FLOOR_RATIO,
  attributeRejection,
  formatCounterAssessment,
  formatRejectionAttribution,
  type AttributionInput,
} from './advice.js'
export {
  DEFAULT_CREDENTIAL_COOLDOWN_MS,
  DEFAULT_FAILURE_MEMORY_MS,
  DEFAULT_MISSING_COOLDOWN_MS,
  DEFAULT_TRANSPORT_COOLDOWN_MS,
  REJECTION_FALLBACK_HOLD_MS,
  AdaptiveThrottleEngine,
  type EngineRecord,
  type ReserveInput,
  type ReserveResult,
  type ThrottleEngineOptions,
} from './engine.js'
export {
  MAX_LIVE_CLAUSES,
  buildHypothesisReport,
  clauseCandidates,
  counterInterval,
  createHypothesisLedger,
  describeCounterBoundary,
  observeAccepted,
  observeRejected,
  reconcile,
  type CeilingProof,
  type CounterVerdict,
  type EvidenceScope,
  type HypothesisCounter,
  type HypothesisInput,
  type HypothesisLedger,
  type RejectionClause,
} from './hypotheses.js'
export { buildQuotaKnowledge, type QuotaKnowledge } from './knowledge.js'
export {
  REPLAY_MEMORY,
  counterFrom,
  eventKey,
  normalizeObservation,
} from './observation.js'
export {
  clamp,
  clamp01,
  formatAmount,
  median,
  toFiniteNumber,
  toNonNegative,
} from './numeric.js'

import { AdaptiveThrottleEngine } from './engine.js'
import type { ThrottleEngineOptions } from './engine.js'

export function createAdaptiveThrottle(
  snapshot?: unknown,
  options?: ThrottleEngineOptions | null,
): AdaptiveThrottleEngine {
  return new AdaptiveThrottleEngine(snapshot, options)
}
