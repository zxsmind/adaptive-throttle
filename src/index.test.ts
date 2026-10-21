import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ATTRIBUTION_MIN_CONFIDENCE,
  DAY_MS,
  ESTABLISHMENT_MIN_INDEPENDENT_WINDOWS,
  AdaptiveThrottleEngine,
  clauseCandidates,
  counterFrom,
  createHypothesisLedger,
  formatRejectionAttribution,
  normalizeObservation,
  observeAccepted,
  observeRejected,
  resolveDayBucket,
  resolveDayStart,
  resolveNextDayBoundary,
  resolveTolerance,
} from './index.js'

import type {
  CounterReading,
  NormalizedObservation,
  OutcomeInput,
  ResourceSpec,
  RoutingAdvice,
} from './index.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REJECTED_AT = '2026-08-23T11:30:25.000Z'

/**
 * The scenario the engine was built for: one key has sent 245 today, 28 this
 * hour, 4 this minute, and was then rejected with "too many requests".
 */
function buildWindowedResource(resourceId: string): ResourceSpec {
  return {
    resourceId,
    counters: [
      { counterId: 'rpm', unit: 'count', window: { windowMs: 60_000, alignment: 'fixed' } },
      { counterId: 'rph', unit: 'count', window: { windowMs: 3_600_000, alignment: 'fixed' } },
      {
        counterId: 'rpd',
        unit: 'count',
        window: { windowMs: DAY_MS, alignment: 'fixed', dayAligned: true },
      },
    ],
  }
}

/** Fills k1 with exactly 4 / 28 / 245 requests at the moment of rejection. */
function loadKeyToTheScenarioLimits(engine: AdaptiveThrottleEngine): void {
  const send = (at: string) => {
    engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: at })
  }

  // 217 earlier today. The traffic has to respect the very ceilings the story is
  // about — 4 a minute, 28 an hour. The old fixture squeezed all 217 into four
  // minutes, which proved the minute ceiling was at least 60 and the hourly one
  // at least 217, and the engine is right to then rule both out as the culprit:
  // a request rejected at 4 cannot be the fault of a window that demonstrably
  // carried 60. That inference is sound; the fixture was the lie.
  const sendHour = (hour: number, count: number) => {
    let sent = 0

    for (let minute = 0; minute < 60 && sent < count; minute += 1) {
      for (let index = 0; index < 4 && sent < count; index += 1) {
        sent += 1

        send(
          new Date(
            Date.parse('2026-08-23T00:00:00.000Z') +
              hour * 3_600_000 +
              minute * 60_000 +
              index * 1_000,
          ).toISOString(),
        )
      }
    }
  }

  for (let hour = 0; hour < 7; hour += 1) {
    sendHour(hour, 28)
  }

  sendHour(7, 21)

  // 24 across earlier minutes of the current hour, at the same 4-a-minute rate.
  sendHour(11, 24)

  // 4 inside the current minute.
  for (const second of [5, 10, 15, 20]) {
    send(`2026-08-23T11:30:${String(second).padStart(2, '0')}.000Z`)
  }
}

function buildTwoKeyEngine(options?: Parameters<typeof AdaptiveThrottleEngine.prototype.constructor>[1]) {
  const engine = new AdaptiveThrottleEngine(undefined, options ?? null)

  engine.register([buildWindowedResource('key-1'), buildWindowedResource('key-2')])

  return engine
}

function rejectOnce(engine: AdaptiveThrottleEngine, at = REJECTED_AT): OutcomeInput {
  return {
    resourceId: 'key-1',
    kind: 'rate-limit',
    settledAt: at,
    detail: 'too many requests',
  }
}

// ---------------------------------------------------------------------------
// Acceptance 1 — the 245 / 28 / 4 scenario
// ---------------------------------------------------------------------------

test('acceptance 1: one rejection after 4 / 28 / 245 requests cannot name the culprit, and says so', () => {
  const engine = buildTwoKeyEngine()
  loadKeyToTheScenarioLimits(engine)

  const { attribution } = engine.settle(rejectOnce(engine))

  assert.ok(attribution)
  assert.equal(attribution.cause, 'unresolved')
  assert.equal(attribution.confidence, 0)
  assert.equal(attribution.suspectCounterId, null)

  // Every counter is reported with its real level, so the caller can see exactly
  // what the engine knows instead of a bare "rate limited".
  const levels = new Map(attribution.observations.map((entry) => [entry.counterId, entry.level]))

  assert.equal(levels.get('rpm'), 4)
  assert.equal(levels.get('rph'), 28)
  assert.equal(levels.get('rpd'), 245)

  for (const observation of attribution.observations) {
    // No ceiling is claimed: the levels 4, 28 and 245 are observations, not
    // limits, and reporting them as limits would be the exact mistake this
    // module exists to avoid.
    assert.equal(observation.limit, null)
    assert.equal(observation.limitSource, 'unknown')

    // Each rejection did plant a candidate, held separately from `limit`.
    assert.equal(observation.candidateLimit, observation.level)
  }

  // Reported, not scheduled: the shortest window ends here, so whatever the
  // caller sends next carries more information than the last thing did.
  assert.equal(attribution.nextEvidenceAt, '2026-08-23T11:31:00.000Z')
})

test('acceptance 1b: the explanation reads as evidence, not as a verdict', () => {
  const engine = buildTwoKeyEngine()
  loadKeyToTheScenarioLimits(engine)

  const { attribution } = engine.settle(rejectOnce(engine))
  const text = formatRejectionAttribution(attribution!)

  assert.match(text, /cause unresolved/)
  assert.match(text, /rpm: level 4 count \(limit unknown \(candidate 4\)\)/)
  assert.match(text, /rph: level 28 count \(limit unknown \(candidate 28\)\) \[confounded by a shorter window\]/)
  assert.match(text, /rpd: level 245 count \(limit unknown \(candidate 245\)\) \[confounded by a shorter window\]/)
  assert.doesNotMatch(text, /rpm:[^\n]*\[confounded/, 'the shortest window is the one allowed to steer')
  assert.match(text, /rph, rpd cannot be separated from this rejection/)
  assert.match(text, /2026-08-23T11:31:00\.000Z/)

  // The explanation is read by humans, so its punctuation has to be the
  // characters that were written and not a mis-decoded byte sequence.
  assert.ok(text.includes('\u2014'), 'renders the em dash that was authored')
  assert.doesNotMatch(text, /\u00E2\u20AC/, 'renders no double-encoded punctuation')
})

test('acceptance 2: the rejected key is routed around and the healthy key is used', () => {
  const engine = buildTwoKeyEngine()
  loadKeyToTheScenarioLimits(engine)
  engine.settle(rejectOnce(engine))

  const { advice } = engine.decide({ now: '2026-08-23T11:30:30.000Z' })

  assert.equal(advice.resourceId, 'key-2')
  assert.equal(advice.action.type, 'proceed')
  assert.equal(advice.speculative, true)
})

test('acceptance 3: a single rejection produces a candidate that never blocks', () => {
  const engine = buildTwoKeyEngine()
  loadKeyToTheScenarioLimits(engine)
  engine.settle(rejectOnce(engine))

  const estimates = engine.getResourceRuntime('key-1')!.estimates

  for (const counterId of ['rpm', 'rph', 'rpd']) {
    assert.equal(estimates[counterId]!.status, 'candidate')
    assert.equal(estimates[counterId]!.supportingWindowCount, 1)
  }

  // After the cooldown elapses the key is fully usable again — one rejection is
  // not evidence of a limit.
  const { perResource } = engine.decide({ now: '2026-08-23T11:31:00.000Z' })
  const key1 = perResource.find((entry) => entry.resourceId === 'key-1')!

  assert.equal(key1.decision, 'send')
  assert.equal(
    perResource.find((entry) => entry.resourceId === 'key-2')!.decision,
    'send',
  )
})

test('acceptance 4: the engine schedules nothing and asks for no extra request', () => {
  const engine = buildTwoKeyEngine()
  loadKeyToTheScenarioLimits(engine)
  engine.settle(rejectOnce(engine))

  // The public surface is read-only advice plus reporting. There is no method
  // that can produce, queue, or schedule a request, and nothing in the advice
  // asks the caller to send one.
  const engineSurface = Object.getOwnPropertyNames(AdaptiveThrottleEngine.prototype).filter(
    (name) => name !== 'constructor' && !name.startsWith('private'),
  )

  assert.deepEqual(
    engineSurface.filter((name) => /probe|verify|retry|schedule|enqueue|dispatch|send/i.test(name)),
    [],
  )

  const { attribution } = engine.settle({
    resourceId: 'key-2',
    kind: 'rate-limit',
    settledAt: '2026-08-23T11:35:00.000Z',
  })

  assert.equal(attribution!.nextEvidenceAt, '2026-08-23T11:36:00.000Z')
  assert.doesNotMatch(
    formatRejectionAttribution(attribution!),
    /re-test|probe|send an extra|retry the/i,
  )
})

test('acceptance 4b: a rejection in a nearly empty window rules that counter out for free', () => {
  const engine = buildTwoKeyEngine()
  loadKeyToTheScenarioLimits(engine)

  const first = engine.settle(rejectOnce(engine))
  assert.equal(first.attribution!.cause, 'unresolved')

  // The caller's ordinary next request lands after the 1-minute window rolled,
  // so the minute counter is empty. Rejecting anyway is proof that the minute
  // counter was never the limiter — no experiment required.
  const second = engine.settle({
    resourceId: 'key-1',
    kind: 'rate-limit',
    settledAt: '2026-08-23T11:31:05.000Z',
  })

  const observations = new Map(
    second.attribution!.observations.map((entry) => [entry.counterId, entry]),
  )

  assert.equal(observations.get('rpm')!.level, 0)
  assert.equal(observations.get('rpm')!.cleared, true)
  assert.equal(observations.get('rpm')!.suspicion, 0)
  assert.equal(observations.get('rph')!.cleared, false)
  assert.equal(observations.get('rpd')!.cleared, false)

  assert.equal(engine.getResourceRuntime('key-1')!.estimates.rpm!.status, 'cleared')

  // The ruled-out counter is reported rather than silently dropped.
  const cleared = engine.listClearedCounters()

  assert.equal(cleared.length, 1)
  assert.equal(cleared[0]!.resourceId, 'key-1')
  assert.equal(cleared[0]!.counters[0]!.counterId, 'rpm')
  assert.equal(cleared[0]!.counters[0]!.rejectedLevel, 0)
  assert.match(formatRejectionAttribution(second.attribution!), /ruled out as the limiter/)
})

test('acceptance 4c: a ruled-out counter is restored by accepted traffic above it', () => {
  const engine = buildTwoKeyEngine()
  loadKeyToTheScenarioLimits(engine)
  engine.settle(rejectOnce(engine))
  engine.settle({ resourceId: 'key-1', kind: 'rate-limit', settledAt: '2026-08-23T11:31:05.000Z' })

  assert.equal(engine.getResourceRuntime('key-1')!.estimates.rpm!.status, 'cleared')

  // Eight accepted requests in one minute disprove the ceiling of four that the
  // minute counter was cleared for, so it returns as a candidate rather than
  // staying ruled out forever.
  for (const second of [2, 6, 10, 14, 18, 22, 26, 30]) {
    engine.settle({
      resourceId: 'key-1',
      kind: 'success',
      settledAt: `2026-08-23T11:35:${String(second).padStart(2, '0')}.000Z`,
    })
  }

  const estimate = engine.getResourceRuntime('key-1')!.estimates.rpm!

  assert.equal(estimate.status, 'candidate')
  assert.equal(estimate.estimatedLimit, 8)
})

// ---------------------------------------------------------------------------
// Acceptance 5 — the state machine converges
// ---------------------------------------------------------------------------

function establishMinuteLimitOfFour(engine: AdaptiveThrottleEngine, firstMinute: number): void {
  for (let offset = 0; offset < ESTABLISHMENT_MIN_INDEPENDENT_WINDOWS; offset += 1) {
    const minute = firstMinute + offset

    for (let index = 0; index < 4; index += 1) {
      engine.settle({
        resourceId: 'key-1',
        kind: 'success',
        settledAt: `2026-08-23T11:${String(minute).padStart(2, '0')}:${String(index * 5).padStart(2, '0')}.000Z`,
      })
    }

    engine.settle({
      resourceId: 'key-1',
      kind: 'rate-limit',
      settledAt: `2026-08-23T11:${String(minute).padStart(2, '0')}:40.000Z`,
      detail: 'too many requests',
    })
  }
}

function buildSingleCounterEngine(mode?: 'smart' | 'aggressive' | 'off' | 'observe'): AdaptiveThrottleEngine {
  const engine = new AdaptiveThrottleEngine(undefined, mode != null ? { mode } : null)

  engine.register([
    {
      resourceId: 'key-1',
      counters: [{ counterId: 'rpm', unit: 'count', window: { windowMs: 60_000 } }],
    },
    {
      resourceId: 'key-2',
      counters: [{ counterId: 'rpm', unit: 'count', window: { windowMs: 60_000 } }],
    },
  ])

  return engine
}

test('acceptance 5: three consistent independent windows establish a limit of four', () => {
  const engine = buildSingleCounterEngine()
  establishMinuteLimitOfFour(engine, 0)

  const estimate = engine.getResourceRuntime('key-1')!.estimates.rpm!

  assert.equal(estimate.status, 'established')
  assert.equal(estimate.estimatedLimit, 4)
  assert.equal(estimate.supportingWindowCount, ESTABLISHMENT_MIN_INDEPENDENT_WINDOWS)
  assert.equal(estimate.source, 'observed')
  assert.equal(estimate.confidence, 1)
})

test('acceptance 6: no mode blocks on a learned ceiling — it may only cost the ranking', () => {
  const smart = buildSingleCounterEngine('smart')
  const aggressive = buildSingleCounterEngine('aggressive')

  for (const engine of [smart, aggressive]) {
    establishMinuteLimitOfFour(engine, 0)

    // Four accepted requests in a fresh minute, then three more queued: the
    // forecast pushes the window past the established ceiling of four.
    for (const second of [2, 7, 12, 17]) {
      engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: `2026-08-23T11:10:${String(second).padStart(2, '0')}.000Z` })
    }
  }

  const request = { now: '2026-08-23T11:10:20.000Z', forecast: { rpm: 3 } }

  for (const engine of [smart, aggressive]) {
    const key1 = engine.decide(request).perResource.find((entry) => entry.resourceId === 'key-1')!

    // A learned ceiling is never allowed to withhold. Blocking on a conclusion
    // is how a perfectly good key gets written off for the day because the
    // engine was wrong about a window it could not identify.
    assert.equal(key1.decision, 'send-cautious')
    assert.equal(key1.counters[0]!.blocking, false)
    // And it is never allowed to be *reported* as the limit either. The number
    // lives in `inference`, labeled with its evidence, where no caller can
    // mistake it for a ceiling somebody actually declared.
    assert.equal(key1.counters[0]!.limit, null)
    assert.equal(key1.counters[0]!.contract, 'legacyEstimate')
    assert.equal(key1.counters[0]!.inference.estimatedLimit, 4)
    assert.equal(key1.counters[0]!.inference.evidence, '3 independent window(s) at level 4')
    assert.equal(key1.counters[0]!.limitSource, 'inferred')

    // It still costs the ranking, which is the entire price inference may charge.
    assert.equal(engine.decide(request).advice.resourceId, 'key-2')
  }
})

test('acceptance 6b: a key that failed and has not succeeded since loses to one that has not', () => {
  const engine = buildTwoKeyEngine()
  loadKeyToTheScenarioLimits(engine)
  engine.settle(rejectOnce(engine))

  // The cooldown expires at 11:31:00, and every counter is empty again — so
  // nothing in the counters says "avoid this key". The failure does, which is
  // the whole point: the engine does not know which window was at fault, but it
  // does know which key did not fail.
  const afterCooldown = engine.decide({ now: '2026-08-23T11:31:25.000Z' })
  const key1 = afterCooldown.perResource.find((entry) => entry.resourceId === 'key-1')!

  assert.equal(afterCooldown.advice.resourceId, 'key-2')
  assert.equal(key1.decision, 'send', 'ranked behind, not withheld')
  assert.match(key1.reason, /no success has followed the last failure/)

  // One accepted request is all it takes. The memory is released by evidence,
  // not by the clock: a key that works again is not a key to avoid.
  engine.settle({
    resourceId: 'key-1',
    kind: 'success',
    settledAt: '2026-08-23T11:31:30.000Z',
  })

  const recovered = engine.decide({ now: '2026-08-23T11:31:35.000Z' })
  const recoveredKey1 = recovered.perResource.find((entry) => entry.resourceId === 'key-1')!
  const recoveredKey2 = recovered.perResource.find((entry) => entry.resourceId === 'key-2')!

  // Recovery is asserted by what it removes, not by which key a tie-break picks:
  // the failure memory is gone from the reason and from the score. The ordering
  // itself belongs to the routing policy under test (see acceptance 60), and
  // pinning it here would make a memory test fail for a tie-break decision.
  assert.doesNotMatch(recoveredKey1.reason, /no success has followed/)
  assert.equal(recoveredKey1.decision, 'send', 'recovered means eligible, not favoured')
  assert.ok(
    recoveredKey1.score >= recoveredKey2.score,
    'a recovered key competes on par with one that never failed',
  )
})

test('acceptance 6c: aggressive ranks a failed key behind every healthy one, but never withholds the last key', () => {
  const engine = buildTwoKeyEngine({ mode: 'aggressive' })
  loadKeyToTheScenarioLimits(engine)
  engine.settle(rejectOnce(engine))

  const afterCooldown = engine.decide({ now: '2026-08-23T11:31:25.000Z' })
  const key1 = afterCooldown.perResource.find((entry) => entry.resourceId === 'key-1')!

  assert.equal(afterCooldown.advice.resourceId, 'key-2')
  assert.equal(key1.decision, 'send-cautious')

  // With no alternative, the failing key is still the answer. Aggressive sheds
  // load across keys; it does not turn a single key into an outage.
  const alone = new AdaptiveThrottleEngine(undefined, { mode: 'aggressive' })
  alone.register([buildWindowedResource('key-1')])
  loadKeyToTheScenarioLimits(alone)
  alone.settle(rejectOnce(alone))

  const single = alone.decide({ now: '2026-08-23T11:31:25.000Z' })

  assert.equal(single.advice.resourceId, 'key-1')
  assert.equal(single.advice.action.type, 'proceed-cautious')
})

test("acceptance 6d: a long window that reproduces only because traffic does is reported but does not steer", () => {
  const engine = buildTwoKeyEngine()
  const dayStart = Date.parse('2026-08-23T00:00:00.000Z')
  const firstFailure = Date.parse('2026-08-23T11:30:25.000Z')

  // Three days of an identical pattern: 245 today, 28 this hour, 4 this minute,
  // then a rejection. The real limiter is rpm; the daily counter only reproduces
  // because the caller's day does.
  for (let day = 0; day < 3; day += 1) {
    const start = dayStart + day * DAY_MS
    const failure = firstFailure + day * DAY_MS

    for (let index = 0; index < 221; index += 1) {
      engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: new Date(start + index * 60_000).toISOString() })
    }

    for (let index = 0; index < 24; index += 1) {
      engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: new Date(failure - (24 - index) * 60_000 - 25_000).toISOString() })
    }

    for (const offset of [5, 10, 15, 20]) {
      engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: new Date(failure - 25_000 + offset * 1000).toISOString() })
    }

    engine.settle({ resourceId: 'key-1', kind: 'rate-limit', settledAt: new Date(failure).toISOString() })
  }

  const estimates = engine.getResourceRuntime('key-1')!.estimates

  // Reproducibility is not attribution, and the engine says both halves: the
  // daily level did repeat three times, and it still cannot be separated from
  // the minute window that resets inside it.
  assert.equal(estimates.rpm!.status, 'established')
  assert.equal(estimates.rpd!.status, 'established')
  // The hour never even became a hypothesis here. This fixture's own traffic
  // carried ~60 requests inside a single hour, which proves the hourly ceiling is
  // at least 60 — so a rejection at 28 demonstrably was not the hour's doing, and
  // there is nothing to rule out because nothing was ever proposed. `unobserved`
  // is the honest state; the old `cleared` expectation assumed a candidate that
  // the traffic had already refuted.
  assert.equal(estimates.rph!.status, 'unobserved')

  const key1 = engine
    .decide({ now: '2026-08-25T11:31:00.000Z' })
    .perResource.find((entry) => entry.resourceId === 'key-1')!
  const byId = new Map(key1.counters.map((counter) => [counter.counterId, counter]))

  assert.equal(byId.get('rpm')!.confounded, false)
  assert.equal(byId.get('rpm')!.limit, null, 'even unconfounded, inference is not a limit')
  assert.equal(byId.get('rpm')!.contract, 'legacyEstimate')
  assert.equal(byId.get('rpm')!.inference.estimatedLimit, 4)

  assert.equal(byId.get('rpd')!.confounded, true)
  assert.equal(
    byId.get('rpd')!.limit,
    null,
    'a level that cannot be separated from a shorter window is not a limit',
  )
  assert.equal(byId.get('rpd')!.candidateLimit, 249)

  // Without this the daily candidate would sit at 249 of 249, read as near-limit
  // for the rest of the day, and bench a key whose only problem is four
  // requests a minute.
  assert.notEqual(byId.get('rpd')!.state, 'near-limit')
  assert.equal(key1.decision, 'send')
})

test('acceptance 6e: the failure memory expires on its own, so one rejection cannot seal a key away', () => {
  const engine = buildTwoKeyEngine()
  loadKeyToTheScenarioLimits(engine)
  engine.settle(rejectOnce(engine))

  const soon = engine.decide({ now: '2026-08-23T11:31:25.000Z' })
  const soonKey1 = soon.perResource.find((entry) => entry.resourceId === 'key-1')!

  assert.equal(soon.advice.resourceId, 'key-2')
  assert.match(soonKey1.reason, /no success has followed the last failure/)

  // An hour later nothing has been sent to key-1, so it never succeeded, so it
  // could never have cleared the memory itself — the engine would have been
  // avoiding it forever on the strength of one rejection. The horizon lifts the
  // penalty anyway: a penalty only the penalised party can lift is a deadlock.
  const later = engine.decide({ now: '2026-08-23T12:31:00.000Z' })
  const laterKey1 = later.perResource.find((entry) => entry.resourceId === 'key-1')!

  assert.doesNotMatch(laterKey1.reason, /no success has followed the last failure/)
  assert.equal(later.advice.resourceId, 'key-1')
})

test('acceptance 6f: the expiry horizon is a configured duration, not a hidden constant', () => {
  // The rejection lands at 11:30:25 and the cooldown releases at 11:31:00, so
  // five minutes of memory covers 11:31:30 and not 11:36:00.
  const short = buildTwoKeyEngine({ failureMemoryMs: 300_000 })
  loadKeyToTheScenarioLimits(short)
  short.settle(rejectOnce(short))

  assert.match(
    short.decide({ now: '2026-08-23T11:31:30.000Z' }).perResource.find((entry) => entry.resourceId === 'key-1')!.reason,
    /no success has followed the last failure/,
  )
  assert.doesNotMatch(
    short.decide({ now: '2026-08-23T11:36:00.000Z' }).perResource.find((entry) => entry.resourceId === 'key-1')!.reason,
    /no success has followed the last failure/,
  )

  // The default is an hour, so the two engines disagree about this instant: the
  // horizon really is read from options rather than baked in.
  const normal = buildTwoKeyEngine()
  loadKeyToTheScenarioLimits(normal)
  normal.settle(rejectOnce(normal))

  assert.match(
    normal.decide({ now: '2026-08-23T11:36:00.000Z' }).perResource.find((entry) => entry.resourceId === 'key-1')!.reason,
    /no success has followed the last failure/,
  )
})

test('acceptance 7: real traffic above the inferred ceiling revises it instead of locking out', () => {
  const engine = buildSingleCounterEngine('smart')
  establishMinuteLimitOfFour(engine, 0)

  // The provider was in fact raised to nine; six accepted requests in one minute
  // must not be refused forever.
  for (const second of [2, 7, 12, 17, 22, 27]) {
    engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: `2026-08-23T11:10:${String(second).padStart(2, '0')}.000Z` })
  }

  const estimate = engine.getResourceRuntime('key-1')!.estimates.rpm!

  assert.equal(estimate.estimatedLimit, 6)
  // `contradicted` is the honest label: an established limit of four was proved
  // wrong by real traffic, which is a stronger statement than "still a guess".
  assert.equal(estimate.status, 'contradicted')
  assert.equal(estimate.contradictingObservationCount, 1)

  const key1 = engine
    .decide({ now: '2026-08-23T11:10:30.000Z', forecast: { rpm: 1 } })
    .perResource.find((entry) => entry.resourceId === 'key-1')!

  assert.equal(key1.decision, 'send')
})

// ---------------------------------------------------------------------------
// Acceptance 8 — provider facts always win
// ---------------------------------------------------------------------------

test('acceptance 8: a provider-declared limit blocks in the default mode', () => {
  const engine = buildSingleCounterEngine()
  engine.settle({
    resourceId: 'key-1',
    kind: 'success',
    settledAt: '2026-08-23T11:20:00.000Z',
    provider: { source: 'x-ratelimit-limit', counters: [{ counterId: 'rpm', limit: 3 }] },
  })

  for (const second of [5, 10, 15]) {
    engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: `2026-08-23T11:20:${String(second).padStart(2, '0')}.000Z` })
  }

  const key1 = engine
    .decide({ now: '2026-08-23T11:20:20.000Z', forecast: { rpm: 1 } })
    .perResource.find((entry) => entry.resourceId === 'key-1')!

  assert.equal(key1.decision, 'defer')
  assert.equal(key1.counters[0]!.limitSource, 'provider')
  assert.equal(key1.counters[0]!.confidence, 'authoritative')
  assert.equal(engine.decide({ now: '2026-08-23T11:20:20.000Z' }).advice.resourceId, 'key-2')
})

test('acceptance 9: unknown remaining is never exhaustion, reported zero remaining is', () => {
  const unknown = buildSingleCounterEngine()
  const exhausted = buildSingleCounterEngine()

  for (const engine of [unknown, exhausted]) {
    for (let index = 0; index < 40; index += 1) {
      engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: `2026-08-23T11:20:${String(index * 1).padStart(2, '0')}.000Z` })
    }
  }

  unknown.settle({
    resourceId: 'key-1',
    kind: 'success',
    settledAt: '2026-08-23T11:20:41.000Z',
    provider: { source: 'headers', counters: [{ counterId: 'rpm', limit: null, remaining: null }] },
  })

  exhausted.settle({
    resourceId: 'key-1',
    kind: 'success',
    settledAt: '2026-08-23T11:20:41.000Z',
    provider: { source: 'headers', counters: [{ counterId: 'rpm', remaining: 0 }] },
  })

  const unknownKey1 = unknown
    .decide({ now: '2026-08-23T11:20:45.000Z', forecast: { rpm: 1 } })
    .perResource.find((entry) => entry.resourceId === 'key-1')!
  const exhaustedKey1 = exhausted
    .decide({ now: '2026-08-23T11:20:45.000Z', forecast: { rpm: 1 } })
    .perResource.find((entry) => entry.resourceId === 'key-1')!

  assert.equal(unknownKey1.decision, 'send', 'an undisclosed remaining must not be read as zero')
  assert.equal(exhaustedKey1.decision, 'defer')
  assert.equal(exhaustedKey1.counters[0]!.blocking, true)
})

test('acceptance 10: a provider-named counter is trusted without second-guessing', () => {
  const engine = buildTwoKeyEngine()
  loadKeyToTheScenarioLimits(engine)

  const { attribution } = engine.settle({
    ...rejectOnce(engine),
    rateLimit: { blamedCounterIds: ['rpm'], retryAfterSeconds: 30 },
  })

  assert.equal(attribution!.cause, 'resolved')
  assert.equal(attribution!.causeCounterId, 'rpm')
  assert.equal(attribution!.confidence, 0.95)
  assert.match(formatRejectionAttribution(attribution!), /reported by the provider/)

  // The retry-after is a fact, so it is honoured even in `off` mode.
  const off = new AdaptiveThrottleEngine(undefined, { mode: 'off' })
  off.register([buildWindowedResource('key-1'), buildWindowedResource('key-2')])
  loadKeyToTheScenarioLimits(off)
  off.settle({
    resourceId: 'key-1',
    kind: 'rate-limit',
    settledAt: REJECTED_AT,
    rateLimit: { blamedCounterIds: ['rpm'], retryAfterSeconds: 30 },
  })

  const offKey1 = off.decide({ now: '2026-08-23T11:30:30.000Z' }).perResource.find(
    (entry) => entry.resourceId === 'key-1',
  )!

  assert.equal(offKey1.decision, 'defer')
  assert.equal(offKey1.activeCooldowns[0]!.source, 'provider-retry-after')
})

// ---------------------------------------------------------------------------
// Acceptance 11 — quota groups
// ---------------------------------------------------------------------------

test('acceptance 11: a shared account quota holds every member of the group and nobody else', () => {
  const engine = new AdaptiveThrottleEngine()
  const counters = [{ counterId: 'rpm', unit: 'count' as const, window: { windowMs: 60_000 } }]

  engine.register([
    { resourceId: 'key-1', quotaGroupId: 'account-a', counters },
    { resourceId: 'key-2', quotaGroupId: 'account-a', counters },
    { resourceId: 'key-3', quotaGroupId: 'account-b', counters },
  ])

  engine.settle({
    resourceId: 'key-1',
    kind: 'rate-limit',
    settledAt: '2026-08-23T11:40:00.000Z',
    rateLimit: { limitScope: 'quota-group', retryAfterSeconds: 60 },
  })

  const { perResource, advice } = engine.decide({ now: '2026-08-23T11:40:10.000Z' })

  assert.equal(perResource.find((entry) => entry.resourceId === 'key-1')!.decision, 'defer')
  assert.equal(perResource.find((entry) => entry.resourceId === 'key-2')!.decision, 'defer')
  assert.equal(perResource.find((entry) => entry.resourceId === 'key-3')!.decision, 'send')
  assert.equal(advice.resourceId, 'key-3')
})

// ---------------------------------------------------------------------------
// Acceptance 12 — typed failures
// ---------------------------------------------------------------------------

test('acceptance 12: a rejected credential holds only that resource, even in off mode', () => {
  const engine = buildTwoKeyEngine({ mode: 'off' })

  engine.settle({
    resourceId: 'key-1',
    kind: 'credential-rejected',
    settledAt: '2026-08-23T11:50:00.000Z',
  })

  const { perResource, advice } = engine.decide({ now: '2026-08-23T11:50:10.000Z' })
  const key1 = perResource.find((entry) => entry.resourceId === 'key-1')!

  assert.equal(key1.decision, 'defer')
  assert.equal(key1.activeCooldowns[0]!.kind, 'credential-rejected')
  assert.equal(key1.activeCooldowns[0]!.authoritative, true)
  assert.equal(advice.resourceId, 'key-2')

  // The hold expires on its own schedule.
  const later = engine.decide({ now: '2026-08-23T11:56:00.000Z' })
  assert.equal(later.perResource.find((entry) => entry.resourceId === 'key-1')!.decision, 'send')
})

test('acceptance 13: a success clears the cooldown and records the recovery', () => {
  const engine = buildSingleCounterEngine()

  engine.settle({ resourceId: 'key-1', kind: 'rate-limit', settledAt: '2026-08-23T12:00:00.000Z', rateLimit: { retryAfterSeconds: 60 } })
  engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: '2026-08-23T12:00:10.000Z' })

  const runtime = engine.getResourceRuntime('key-1')!

  assert.equal(runtime.cooldowns.length, 0)
  assert.ok(runtime.events.some((event) => event.kind === 'recovered'))
  assert.equal(engine.decide({ now: '2026-08-23T12:00:20.000Z' }).advice.resourceId, 'key-1')
})

// ---------------------------------------------------------------------------
// Acceptance 14 — non-AI shapes
// ---------------------------------------------------------------------------

test('acceptance 14: a concurrency gauge blocks at its configured ceiling', () => {
  const engine = new AdaptiveThrottleEngine()
  const counters = [
    { counterId: 'inflight', kind: 'gauge' as const, unit: 'count' as const, limit: 2 },
    { counterId: 'rpm', unit: 'count' as const, window: { windowMs: 60_000 } },
  ]

  engine.register([
    { resourceId: 'key-1', counters },
    { resourceId: 'key-2', counters },
  ])

  assert.equal(engine.decide({ now: '2026-08-23T13:00:00.000Z' }).advice.resourceId, 'key-1')

  engine.reserve({ resourceId: 'key-1', now: '2026-08-23T13:00:01.000Z' })
  engine.reserve({ resourceId: 'key-1', now: '2026-08-23T13:00:02.000Z' })

  const full = engine.decide({ now: '2026-08-23T13:00:03.000Z' }).perResource.find(
    (entry) => entry.resourceId === 'key-1',
  )!

  assert.equal(full.decision, 'defer')
  assert.match(full.reason, /inflight/)

  // Releasing one in-flight request frees a slot again; the remaining slot is
  // exactly enough for the operation about to start, which is not a warning.
  engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: '2026-08-23T13:00:04.000Z' })

  const released = engine.decide({ now: '2026-08-23T13:00:05.000Z' }).perResource.find(
    (entry) => entry.resourceId === 'key-1',
  )!

  assert.equal(released.decision, 'send')
  assert.equal(released.counters[0]!.state, 'enforced-full')
  assert.equal(released.counters[0]!.level, 1)
})

test('acceptance 15: a cost counter never charges one unit just because it is unnamed', () => {
  const engine = new AdaptiveThrottleEngine()

  engine.register([
    {
      resourceId: 'key-1',
      counters: [
        {
          counterId: 'spend-usd',
          unit: 'cost-usd',
          window: { windowMs: DAY_MS, dayAligned: true },
        },
      ],
    },
  ])

  engine.settle({
    resourceId: 'key-1',
    kind: 'success',
    settledAt: '2026-08-23T14:00:00.000Z',
    usage: { charges: { 'spend-usd': 0.02 } },
  })

  engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: '2026-08-23T14:01:00.000Z' })

  const assessment = engine.decide({ now: '2026-08-23T14:02:00.000Z' }).perResource[0]!.counters[0]!

  assert.equal(assessment.unit, 'cost-usd')
  assert.equal(assessment.level, 0.02)
})

test('acceptance 16: bytes and credits work as readily as requests', () => {
  const engine = new AdaptiveThrottleEngine()

  engine.register([
    {
      resourceId: 'key-1',
      counters: [
        {
          counterId: 'bandwidth',
          unit: 'bytes',
          window: { windowMs: 60_000, alignment: 'sliding' },
          limit: 1_000_000,
          defaultCharge: 0,
        },
        {
          counterId: 'credits',
          unit: 'credits',
          window: { windowMs: DAY_MS, dayAligned: true, timeZone: 'Europe/Istanbul' },
          limit: 100,
          defaultCharge: 0,
        },
      ],
    },
  ])

  engine.settle({
    resourceId: 'key-1',
    kind: 'success',
    settledAt: '2026-08-23T15:00:00.000Z',
    usage: { charges: { bandwidth: 400_000, credits: 3 } },
  })

  const counters = engine.decide({ now: '2026-08-23T15:00:10.000Z', forecast: { bandwidth: 700_000 } }).perResource[0]!.counters

  assert.equal(counters[0]!.unit, 'bytes')
  assert.equal(counters[0]!.level, 400_000)
  assert.equal(counters[0]!.state, 'blocked')
  assert.equal(counters[1]!.level, 3)
  assert.equal(counters[1]!.unit, 'credits')

  // A sliding window has already forgotten the earlier 400 kB, so a burst can
  // legitimately exceed a per-minute figure the provider never stated.
  const afterWindowRolls = engine.decide({ now: '2026-08-23T15:01:30.000Z', forecast: { bandwidth: 700_000 } })
    .perResource[0]!.counters[0]!

  assert.equal(afterWindowRolls.level, 0)
  assert.equal(afterWindowRolls.state, 'enforced-empty')
})

// ---------------------------------------------------------------------------
// Acceptance 17 — determinism and persistence
// ---------------------------------------------------------------------------

test('acceptance 17: identical snapshot, inputs and clock produce identical advice', () => {
  const first = buildTwoKeyEngine()
  loadKeyToTheScenarioLimits(first)
  first.settle(rejectOnce(first))

  const second = new AdaptiveThrottleEngine(first.getSnapshot())
  second.register([buildWindowedResource('key-1'), buildWindowedResource('key-2')])

  const left: RoutingAdvice = first.decide({ now: '2026-08-23T11:30:30.000Z' }).advice
  const right: RoutingAdvice = second.decide({ now: '2026-08-23T11:30:30.000Z' }).advice

  assert.equal(JSON.stringify(left), JSON.stringify(right))
})

test('acceptance 18: learned state survives a restart, legacy snapshots do not', () => {
  const engine = buildSingleCounterEngine()
  establishMinuteLimitOfFour(engine, 0)

  const restored = new AdaptiveThrottleEngine(JSON.parse(JSON.stringify(engine.getSnapshot())))
  restored.register([
    { resourceId: 'key-1', counters: [{ counterId: 'rpm', unit: 'count', window: { windowMs: 60_000 } }] },
    { resourceId: 'key-2', counters: [{ counterId: 'rpm', unit: 'count', window: { windowMs: 60_000 } }] },
  ])

  assert.equal(restored.getResourceRuntime('key-1')!.estimates.rpm!.status, 'established')
  assert.equal(restored.getResourceRuntime('key-1')!.estimates.rpm!.estimatedLimit, 4)

  // A V1-shaped snapshot carries different semantics and is discarded outright.
  const legacy = new AdaptiveThrottleEngine({ version: 4, scopes: { 'aggregate:key-1': { rpm: 10 } } })
  legacy.register([
    { resourceId: 'key-1', counters: [{ counterId: 'rpm', unit: 'count', window: { windowMs: 60_000 } }] },
  ])

  assert.equal(legacy.getResourceRuntime('key-1')!.estimates.rpm!.status, 'unobserved')
  assert.equal(legacy.getResourceRuntime('key-1')!.estimates.rpm!.estimatedLimit, null)
})

test('acceptance 19: the engine reports when it knows nothing instead of inventing a limit', () => {
  const engine = new AdaptiveThrottleEngine()

  engine.register([
    { resourceId: 'key-1', counters: [{ counterId: 'rpm', unit: 'count', window: { windowMs: 60_000 } }] },
  ])

  const { advice, perResource } = engine.decide({ now: '2026-08-23T16:00:00.000Z' })

  assert.equal(advice.decision, 'send')
  assert.equal(advice.speculative, false)
  assert.equal(perResource[0]!.counters[0]!.limit, null)
  assert.equal(perResource[0]!.counters[0]!.confidence, 'none')
  assert.equal(perResource[0]!.counters[0]!.state, 'unknown-limit')
})

test('acceptance 20: with no usable alternative the engine waits instead of guessing', () => {
  const engine = new AdaptiveThrottleEngine()

  engine.register([
    { resourceId: 'key-1', counters: [{ counterId: 'rpm', unit: 'count', window: { windowMs: 60_000 } }] },
  ])

  engine.settle({ resourceId: 'key-1', kind: 'rate-limit', settledAt: '2026-08-23T17:00:00.000Z', rateLimit: { retryAfterSeconds: 45 } })

  const { advice } = engine.decide({ now: '2026-08-23T17:00:10.000Z' })

  assert.equal(advice.decision, 'defer')
  assert.equal(advice.action.type, 'wait')
  assert.deepEqual(advice.action, {
    type: 'wait',
    waitMs: 35_000,
    retryAt: '2026-08-23T17:00:45.000Z',
  })
})

test('acceptance 21: an unresolved failure is carried across a restart', () => {
  const engine = buildTwoKeyEngine()
  loadKeyToTheScenarioLimits(engine)
  engine.settle(rejectOnce(engine))

  assert.equal(engine.decide({ now: '2026-08-23T11:31:25.000Z' }).advice.resourceId, 'key-2')

  const restored = new AdaptiveThrottleEngine(JSON.parse(JSON.stringify(engine.getSnapshot())))
  restored.register([buildWindowedResource('key-1'), buildWindowedResource('key-2')])

  const after = restored.decide({ now: '2026-08-23T11:31:25.000Z' })
  const key1 = after.perResource.find((entry) => entry.resourceId === 'key-1')!

  assert.equal(after.advice.resourceId, 'key-2')
  assert.match(key1.reason, /no success has followed the last failure/)

  // And a success after the restart still releases it. The memory is persisted
  // state, not an in-process flag that a restart quietly clears.
  restored.settle({ resourceId: 'key-1', kind: 'success', settledAt: '2026-08-23T11:31:30.000Z' })

  assert.doesNotMatch(
    restored.decide({ now: '2026-08-23T11:31:35.000Z' }).perResource.find((entry) => entry.resourceId === 'key-1')!.reason,
    /no success has followed the last failure/,
  )
})

test('acceptance 22: mode and collection are operator controls that leave learned state alone', () => {
  const engine = buildTwoKeyEngine()
  loadKeyToTheScenarioLimits(engine)
  engine.settle(rejectOnce(engine))

  assert.equal(engine.getMode(), 'smart')
  assert.deepEqual(engine.getRegisteredResources().map((spec) => spec.resourceId), ['key-1', 'key-2'])

  engine.setMode('aggressive')
  assert.equal(engine.getMode(), 'aggressive')
  assert.equal(engine.decide({ now: '2026-08-23T11:31:25.000Z' }).advice.mode, 'aggressive')

  // A name this engine never had falls back to the default instead of throwing:
  // a typo in an operator control must not take the process down.
  engine.setMode('strict' as never)
  assert.equal(engine.getMode(), 'smart')

  // Collection expires what has expired and touches nothing the engine learned.
  engine.gc('2026-08-23T12:31:00.000Z')

  const runtime = engine.getResourceRuntime('key-1')!
  assert.deepEqual(runtime.cooldowns, [])
  assert.equal(runtime.lastFailureAt, REJECTED_AT)
  assert.equal(runtime.estimates.rpm!.status, 'candidate')
  assert.equal(runtime.estimates.rpm!.estimatedLimit, 4)
})

test('acceptance 23: operator priority breaks a tie and is never a licence to ignore a better key', () => {
  const now = '2026-08-23T20:00:00.000Z'
  const build = (preferredId: 'key-1' | 'key-2' | null) => {
    const engine = new AdaptiveThrottleEngine(undefined, { mode: 'smart' })
    const spec = (resourceId: 'key-1' | 'key-2') => ({
      ...buildWindowedResource(resourceId),
      priority: preferredId === resourceId ? 100 : null,
    })

    engine.register([spec('key-1'), spec('key-2')])

    return engine
  }

  // Identical state means an identical 0.500, so only the priority separates
  // them — otherwise the id tie-break would choose key-1 either way.
  assert.equal(build(null).decide({ now }).advice.resourceId, 'key-1')
  assert.equal(build('key-2').decide({ now }).advice.resourceId, 'key-2')

  // Now give key-1 the priority *and* a fresh unreleased failure. The ranks are
  // equal and both keys are sendable, but the evidence still outweighs the
  // preference: priority moves ties, it does not overrule what was measured.
  const preferred = build('key-1')
  loadKeyToTheScenarioLimits(preferred)
  preferred.settle(rejectOnce(preferred))

  const { perResource, advice } = preferred.decide({ now: '2026-08-23T11:31:25.000Z' })

  assert.equal(perResource.find((entry) => entry.resourceId === 'key-1')!.decision, 'send')
  assert.equal(perResource.find((entry) => entry.resourceId === 'key-2')!.decision, 'send')
  assert.equal(advice.resourceId, 'key-2')
})

test('acceptance 24: an advice that rests on a candidate admits it', () => {
  const engine = buildTwoKeyEngine()
  loadKeyToTheScenarioLimits(engine)
  engine.settle(rejectOnce(engine))

  // The cooldown is over, so nothing is being withheld any more — yet key-1's
  // ranking still rests entirely on the candidate "rpm = 4". Calling that
  // factual would be the one claim the engine refuses to make everywhere else.
  const { advice, perResource } = engine.decide({ now: '2026-08-23T11:31:25.000Z' })
  const key1 = perResource.find((entry) => entry.resourceId === 'key-1')!

  assert.deepEqual(key1.activeCooldowns, [])
  assert.equal(key1.counters.find((counter) => counter.counterId === 'rpm')!.inferred, true)
  assert.equal(advice.speculative, true)

  // Nothing learned means nothing inferred, so an engine that has only ever
  // been told things is not speculating.
  const pristine = new AdaptiveThrottleEngine(undefined, { mode: 'smart' })
  pristine.register([buildWindowedResource('key-1'), buildWindowedResource('key-2')])

  assert.equal(pristine.decide({ now: '2026-08-23T20:00:00.000Z' }).advice.speculative, false)
})

test('acceptance 25: when one window is unmistakably fuller than the rest, the engine names it', () => {
  const engine = buildTwoKeyEngine()

  // The provider does state the hour and the day, which makes those two
  // authoritative — and both are a long way from full. Only the minute is
  // inferred, and only the minute is at its ceiling. (With nothing stated, the
  // longer windows' candidates track their own levels upward and every counter
  // reads as equally full, which is acceptance 1: no separation, no verdict.)
  engine.settle({
    resourceId: 'key-1',
    kind: 'success',
    settledAt: '2026-08-23T09:00:00.000Z',
    provider: {
      source: 'headers',
      counters: [
        { counterId: 'rph', limit: 100 },
        { counterId: 'rpd', limit: 1000 },
      ],
    },
  })

  // Establish a ceiling of four for rpm: three independent windows of four
  // accepted and then rejected.
  for (const minute of [0, 1, 2]) {
    for (let index = 0; index < 4; index += 1) {
      engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: `2026-08-23T11:${String(minute).padStart(2, '0')}:${String(index * 5).padStart(2, '0')}.000Z` })
    }
    engine.settle({
      resourceId: 'key-1',
      kind: 'rate-limit',
      settledAt: `2026-08-23T11:${String(minute).padStart(2, '0')}:40.000Z`,
    })
  }

  // Four more in a fresh minute, then rejected: the minute is full, the rest are not.
  for (const second of [5, 10, 15, 20]) {
    engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: `2026-08-23T11:20:${String(second).padStart(2, '0')}.000Z` })
  }

  const { attribution } = engine.settle({
    resourceId: 'key-1',
    kind: 'rate-limit',
    settledAt: '2026-08-23T11:20:25.000Z',
    detail: 'too many requests',
  })

  const byId = new Map(attribution!.observations.map((entry) => [entry.counterId, entry]))

  assert.equal(byId.get('rpm')!.level, 4)
  assert.equal(byId.get('rpm')!.utilization, 1)
  assert.equal(byId.get('rph')!.limit, 100)
  assert.equal(byId.get('rpd')!.limit, 1000)

  assert.equal(attribution!.cause, 'resolved')
  // Marked as the engine's own conclusion rather than as something it was told,
  // which is the difference between an answer and a receipt.
  assert.equal(attribution!.source, 'inferred')
  assert.equal(attribution!.causeCounterId, 'rpm')
  assert.ok(attribution!.confidence >= ATTRIBUTION_MIN_CONFIDENCE)

  assert.equal(byId.get('rpm')!.suspicion, 1)
  assert.equal(byId.get('rph')!.suspicion, 0)
  assert.equal(byId.get('rpd')!.suspicion, 0)
})

test('acceptance 26: a counter the engine knows nothing about is left out of the score', () => {
  const engine = new AdaptiveThrottleEngine(undefined, { mode: 'smart' })
  const rpm = { counterId: 'rpm', unit: 'count' as const, limit: 10, window: { windowMs: 60_000 } }

  engine.register([
    {
      resourceId: 'key-1',
      // Three declared counters: the minute is known, the hour and the day are not.
      counters: [
        rpm,
        { counterId: 'rph', unit: 'count', window: { windowMs: 3_600_000 } },
        { counterId: 'rpd', unit: 'count', window: { windowMs: DAY_MS, dayAligned: true } },
      ],
    },
    {
      resourceId: 'key-2',
      // One declared counter — exactly the same known evidence about the minute.
      counters: [rpm],
    },
  ])

  const { perResource, advice } = engine.decide({ now: '2026-08-23T11:00:00.000Z' })
  const key1 = perResource.find((entry) => entry.resourceId === 'key-1')!

  // Averaging the two unknowns in as a neutral 0.5 gave key-1 a 0.667 against
  // key-2's 1.000 — a difference created entirely by how many counters the
  // operator wrote down, with nothing the provider or the traffic had revealed
  // in it. The score measures measured health, so the unknowns step aside and
  // the tie falls to the id as every other tie does.
  assert.equal(key1.score, 1)
  assert.equal(perResource.find((entry) => entry.resourceId === 'key-2')!.score, 1)
  assert.equal(advice.resourceId, 'key-1')

  // Leaving unknowns out is not the same as ignoring them: a counter with a known
  // ceiling and real traffic in it still counts against the resource. key-1 used
  // five of its ten hourly slots before the current minute, and that has to show.
  const loaded = new AdaptiveThrottleEngine(undefined, { mode: 'smart' })
  loaded.register([
    {
      resourceId: 'key-1',
      counters: [
        rpm,
        { counterId: 'rph', unit: 'count', limit: 10, window: { windowMs: 3_600_000 } },
      ],
    },
    { resourceId: 'key-2', counters: [rpm] },
  ])

  for (const minute of [0, 1, 2, 3, 4]) {
    loaded.settle({ resourceId: 'key-1', kind: 'success', settledAt: `2026-08-23T10:${String(minute).padStart(2, '0')}:00.000Z` })
  }

  // Decided at 10:30 so the minute is fresh while the hour still holds the five
  // requests sent at 10:00–10:04.
  const after = loaded.decide({ now: '2026-08-23T10:30:00.000Z' })
  const loadedKey1 = after.perResource.find((entry) => entry.resourceId === 'key-1')!

  assert.equal(loadedKey1.decision, 'send')
  assert.equal(after.perResource.find((entry) => entry.resourceId === 'key-2')!.decision, 'send')
  assert.equal(loadedKey1.score, 0.75, 'half the hour used, averaged over the two measurable counters')
  assert.equal(after.advice.resourceId, 'key-2')
})

test('acceptance 27: a remaining count expires with its reset time instead of parking the key forever', () => {
  const engine = buildSingleCounterEngine()

  // The provider says ten an hour, none left, and that the window resets at 11:00.
  engine.settle({
    resourceId: 'key-1',
    kind: 'success',
    settledAt: '2026-08-23T10:59:00.000Z',
    provider: {
      source: 'headers',
      counters: [
        { counterId: 'rpm', limit: 10, remaining: 0, resetAt: '2026-08-23T11:00:00.000Z' },
      ],
    },
  })

  // Before the reset it is a fact, and facts hold.
  const during = engine.decide({ now: '2026-08-23T10:59:30.000Z' })
  const held = during.perResource.find((entry) => entry.resourceId === 'key-1')!

  assert.equal(held.decision, 'defer')
  assert.equal(held.counters[0]!.blocking, true)

  // After the reset the *count* it qualified is stale — but the *limit* is not,
  // because "this account allows ten a minute" does not expire.
  const after = engine.decide({ now: '2026-08-23T11:00:30.000Z' })
  const released = after.perResource.find((entry) => entry.resourceId === 'key-1')!

  assert.equal(released.decision, 'send')
  assert.equal(released.counters[0]!.limit, 10, 'the declared ceiling outlives its own reset')
  assert.equal(released.counters[0]!.blocking, false)

  // The regression this exists for: believed indefinitely, a stale `remaining: 0`
  // blocked two healthy keys for the last four hours of a five-hour run, because
  // the engine never sent to them, so never received a fresher reading.
  engine.settle({
    resourceId: 'key-1',
    kind: 'success',
    settledAt: '2026-08-23T11:00:45.000Z',
  })

  assert.equal(
    engine.decide({ now: '2026-08-23T11:00:50.000Z' }).perResource.find((entry) => entry.resourceId === 'key-1')!.decision,
    'send',
  )
})

test('acceptance 28: a rejection in an empty window rules that counter out instead of becoming its ceiling', () => {
  const engine = buildSingleCounterEngine()

  // One accepted request, then a rejection in the same minute: a candidate of 1.
  engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: '2026-08-23T00:00:05.000Z' })
  engine.settle({
    resourceId: 'key-1',
    kind: 'rate-limit',
    settledAt: '2026-08-23T00:00:40.000Z',
    detail: 'too many requests',
  })

  assert.equal(engine.getResourceRuntime('key-1')!.estimates.rpm!.estimatedLimit, 1)

  // Two more rejections, each in a fresh and completely empty minute. An empty
  // window cannot have stopped anything: whatever refused these was a longer
  // window, or a limit the engine was never told about.
  for (const minute of [1, 2]) {
    engine.settle({
      resourceId: 'key-1',
      kind: 'rate-limit',
      settledAt: `2026-08-23T00:0${minute}:10.000Z`,
      detail: 'too many requests',
    })
  }

  const estimate = engine.getResourceRuntime('key-1')!.estimates.rpm!

  // The regression: the three samples [1, 0, 0] used to be median-averaged into
  // an *established* ceiling of 0 — a number the provider would contradict,
  // reached through three independent windows, and so reported to an operator as
  // a limit rather than as a guess. Every one of the 32 false claims in the
  // 240-run burst-free benchmark had this exact shape: all three windows at level
  // 0 when the claim was made.
  assert.equal(estimate.status, 'cleared')
  assert.notEqual(estimate.status, 'established')
  assert.equal(
    engine.decide({ now: '2026-08-23T00:03:00.000Z' }).perResource[0]!.counters[0]!.limit,
    null,
    'a ruled-out counter never states a ceiling',
  )
})

test('acceptance 29: a single oversized request in an empty window brackets the ceiling, it does not name it', () => {
  const engine = new AdaptiveThrottleEngine(undefined, { mode: 'smart' })

  engine.register([
    {
      resourceId: 'key-1',
      counters: [{ counterId: 'tpm', unit: 'tokens', window: { windowMs: 60_000 } }],
    },
  ])

  // 100k tokens accepted: the ceiling is provably at least that.
  engine.settle({
    resourceId: 'key-1',
    kind: 'success',
    settledAt: '2026-08-23T11:00:05.000Z',
    usage: { charges: { tpm: 100_000 } },
  })

  // A 350k request in the same window is refused. The window is not empty, and
  // even if it were, a single request can exceed a ceiling on its own — which is
  // exactly why `observedValue <= 0` was the wrong thing to key off.
  engine.settle({
    resourceId: 'key-1',
    kind: 'rate-limit',
    settledAt: '2026-08-23T11:00:20.000Z',
    detail: 'too many requests',
    usage: { charges: { tpm: 350_000 } },
  })

  const estimate = engine.getResourceRuntime('key-1')!.estimates.tpm!

  // The rejection narrows the ceiling to somewhere in [100k, 450k). Naming 450k
  // would be a claim no sample supports, so the engine states nothing.
  assert.equal(estimate.estimatedLimit, null, 'a wide bracket names no ceiling')
  assert.equal(estimate.status, 'candidate')
  assert.equal(
    engine.decide({ now: '2026-08-23T11:00:30.000Z' }).perResource[0]!.counters[0]!.limit,
    null,
  )
})

test('acceptance 30: a fractional median on a count ceiling is reported as disagreement, not rounded', () => {
  const engine = buildSingleCounterEngine()

  // Four independent minutes, rejections alternating between level 4 and level 5.
  // Every value is within tolerance of the median, so the samples agree — and the
  // median is still 4.5, a request count that was never observed and cannot be a
  // ceiling.
  for (const minute of [0, 1, 2, 3]) {
    const count = minute % 2 === 0 ? 4 : 5

    for (let index = 0; index < count; index += 1) {
      engine.settle({
        resourceId: 'key-1',
        kind: 'success',
        settledAt: `2026-08-23T11:${String(minute).padStart(2, '0')}:${String(index * 5).padStart(2, '0')}.000Z`,
      })
    }

    engine.settle({
      resourceId: 'key-1',
      kind: 'rate-limit',
      settledAt: `2026-08-23T11:${String(minute).padStart(2, '0')}:40.000Z`,
      detail: 'too many requests',
    })
  }

  const estimate = engine.getResourceRuntime('key-1')!.estimates.rpm!

  // Whatever the samples settle on, a count ceiling is never fractional. 4.5 is
  // the median of an even set that disagrees, and rounding it into a number that
  // was never observed would state a precision the evidence does not have.
  assert.ok(
    estimate.estimatedLimit == null || Number.isInteger(estimate.estimatedLimit),
    `a count ceiling must be an integer, got ${estimate.estimatedLimit}`,
  )
})

// The case Claude predicted: three independent minutes, each with one accepted
// request then a rejection. Per counter this is airtight — the ceiling is
// bracketed to [1,2), which pins exactly one integer — and it is still wrong,
// because the real limiter was the hour. No rule that looks at one counter at a
// time can see that. This is the evidence that the remaining learning gap is
// architectural rather than a bug to patch.
test('acceptance 31: one shared refusal is recorded as independent evidence per counter', () => {
  const engine = buildTwoKeyEngine()

  for (const minute of [0, 1, 2]) {
    engine.settle({
      resourceId: 'key-1',
      kind: 'success',
      settledAt: `2026-08-23T11:${String(minute).padStart(2, '0')}:05.000Z`,
    })

    engine.settle({
      resourceId: 'key-1',
      kind: 'rate-limit',
      settledAt: `2026-08-23T11:${String(minute).padStart(2, '0')}:40.000Z`,
      detail: 'too many requests',
    })
  }

  const rpm = engine.getResourceRuntime('key-1')!.estimates.rpm!
  const rph = engine.getResourceRuntime('key-1')!.estimates.rph!

  // What is verifiable here is the engine's own output. Three refusals, each of
  // which a provider would have explained by *one* quota, are recorded once
  // against *every* counter: the minute emerges as established at 1, and the hour
  // carries a candidate — both derived from the same three events, neither of
  // which the engine can attribute. No claim about which quota was really full is
  // needed to see that, and this fixture has no provider, so any such claim would
  // be unfounded. An earlier version asserted "the hour was the real limiter" and
  // then read a conclusion off it, and a version after that claimed both counters
  // stated ceilings — the bracket fix means only the minute does. The narration
  // outran the evidence twice; the assertions below are what actually holds.
  assert.equal(rpm.status, 'established')
  assert.equal(rpm.estimatedLimit, 1)
  assert.equal(rph.status, 'candidate', 'the hour is contaminated, not concluded')
  assert.equal(
    rph.supportingWindowCount,
    1,
    'only one of the three refusals survives the hour\'s own proof of innocence',
  )

  // The provider-grounded version of this — a real simulator deciding which quota
  // is binding, and the shadow engine proving the hour while leaving the minute
  // alone — is `gate: the hour is the real limiter` in hypotheses.test.ts. That is
  // where the claim is actually demonstrated.
})

// ---------------------------------------------------------------------------
// Acceptance 32–34 — the limit contract
// ---------------------------------------------------------------------------

test('acceptance 32: no legacy ceiling can ever occupy limit or read as authoritative', () => {
  const engine = buildTwoKeyEngine()
  establishMinuteLimitOfFour(engine, 0)
  engine.settle({
    resourceId: 'key-1',
    kind: 'success',
    settledAt: '2026-08-23T11:20:00.000Z',
    provider: { source: 'headers', counters: [{ counterId: 'rpd', limit: 245 }] },
  })

  const { perResource } = engine.decide({ now: '2026-08-23T11:20:30.000Z' })

  for (const resource of perResource) {
    for (const counter of resource.counters) {
      // The invariant the false claims violated: a stated limit and an
      // authoritative reading are the same fact, never two. Either both or
      // neither.
      assert.equal(counter.limit != null, counter.contract === 'authoritative')

      if (counter.contract === 'authoritative') {
        assert.ok(counter.limitSource === 'operator-config' || counter.limitSource === 'provider')
        assert.equal(counter.confidence, 'authoritative')
      } else {
        assert.notEqual(counter.confidence, 'authoritative')
        assert.ok(counter.limitSource === 'inferred' || counter.limitSource === 'unknown')
      }

      // modelProven has no in-engine producer: nothing the engine observes
      // promotes a derivation into a quota claim on its own. observedBoundary
      // does — a provider-named pin — but this fixture's evidence is anonymous
      // and open-scoped, which must never pin. If either appears here, the
      // open cause set leaked into a claim and the gate is meaningless.
      assert.ok(counter.contract !== 'modelProven' && counter.contract !== 'observedBoundary')
    }
  }

  const key1 = perResource.find((entry) => entry.resourceId === 'key-1')!
  const byId = new Map(key1.counters.map((counter) => [counter.counterId, counter]))

  // The legacy inference — three independent windows at level 4 — is carried
  // openly, with its evidence sentence, and nowhere else.
  assert.equal(byId.get('rpm')!.limit, null)
  assert.equal(byId.get('rpm')!.contract, 'legacyEstimate')
  assert.equal(byId.get('rpm')!.inference.estimatedLimit, 4)
  assert.equal(byId.get('rpm')!.inference.status, 'established')
  assert.equal(byId.get('rpm')!.inference.windows, 3)
  assert.equal(byId.get('rpm')!.inference.evidence, '3 independent window(s) at level 4')
  // 'established' is trust in the inference, never a limit claim.
  assert.equal(byId.get('rpm')!.confidence, 'established')

  // The provider's number keeps its old behavior exactly.
  assert.equal(byId.get('rpd')!.limit, 245)
  assert.equal(byId.get('rpd')!.contract, 'authoritative')
  assert.equal(byId.get('rpd')!.limitSource, 'provider')
  assert.equal(byId.get('rpd')!.confidence, 'authoritative')
})

test('acceptance 33: reporting honesty never changes a routing decision', () => {
  const smart = buildSingleCounterEngine('smart')
  const aggressive = buildSingleCounterEngine('aggressive')

  for (const engine of [smart, aggressive]) {
    establishMinuteLimitOfFour(engine, 0)

    for (const second of [2, 7, 12, 17]) {
      engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: `2026-08-23T11:10:${String(second).padStart(2, '0')}.000Z` })
    }
  }

  const request = { now: '2026-08-23T11:10:20.000Z', forecast: { rpm: 3 } }

  for (const engine of [smart, aggressive]) {
    const { advice, perResource } = engine.decide(request)
    const key1 = perResource.find((entry) => entry.resourceId === 'key-1')!
    const key2 = perResource.find((entry) => entry.resourceId === 'key-2')!

    // The steering sees the same hypothesis it was always built on: the
    // three-window candidate at four plus tolerance.
    assert.equal(key1.counters[0]!.softCeiling, 5)
    assert.equal(key1.decision, 'send-cautious')
    assert.equal(key2.decision, 'send')
    assert.ok(key1.score < key2.score)

    // And the cautious key still loses the ranking, in both modes.
    assert.equal(advice.action.type, 'proceed')
    assert.equal(advice.resourceId, 'key-2')
    assert.equal(advice.speculative, true)
  }
})

test('acceptance 33b: every inferred number still surfaces, only relabeled', () => {
  // The golden-file rule for contract work: a relabeling may move numbers, it
  // may never lose them. Before the contract, the established inference of 4
  // appeared as `limit`. After it, the same knowledge must be fully present —
  // as a candidate, as the ranking input, and as a labeled inference — with
  // only the limit claim gone.
  const engine = buildSingleCounterEngine('smart')
  establishMinuteLimitOfFour(engine, 0)

  const counter = engine
    .decide({ now: '2026-08-23T11:03:00.000Z' })
    .perResource.find((entry) => entry.resourceId === 'key-1')!.counters[0]!

  // Gone: the limit claim.
  assert.equal(counter.limit, null)
  assert.equal(counter.contract, 'legacyEstimate')

  // Present, each labeled as what it is:
  assert.equal(counter.candidateLimit, 4)
  assert.equal(counter.inference.estimatedLimit, 4)
  assert.equal(counter.inference.status, 'established')
  assert.equal(counter.inference.windows, 3)
  assert.equal(counter.softCeiling, 5)

  // And the two fields that only make sense against a stated ceiling stay
  // silent rather than recomputing against a hypothesis: a dashboard reading
  // "100% used" off an unstated number is the same confusion through the back
  // door.
  assert.equal(counter.utilization, null)
  assert.equal(counter.headroom, null)
})

test('acceptance 35: one rejection is one shared observation, not one per counter', () => {
  // Ground truth lives in the provider's books, not in the test's narration:
  // rpm allows 1 per minute, rph allows 3 per hour. Every refusal below is
  // decided by those two numbers, and the test asserts against them — never
  // against a story about which quota "must have" failed.
  const truth = { rpm: 1, rph: 3 }
  const minute = new Map<number, number>()
  let hour = 0

  // Fixed-window provider. Returns the set of quotas actually at ceiling.
  function send(atMinute: number): { accepted: boolean; full: string[] } {
    const minuteCount = minute.get(atMinute) ?? 0

    if (minuteCount >= truth.rpm || hour >= truth.rph) {
      const full: string[] = []
      if (minuteCount >= truth.rpm) full.push('rpm')
      if (hour >= truth.rph) full.push('rph')
      return { accepted: false, full }
    }

    minute.set(atMinute, minuteCount + 1)
    hour += 1
    return { accepted: true, full: [] }
  }

  const engine = buildTwoKeyEngine()
  const atMinute = (minute: number, second: number) =>
    `2026-08-23T11:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`

  // Per rejection, in creation order: the true culprits, and the candidate set
  // the shadow reported at that instant.
  const truthByClause: string[][] = []
  const initialCandidates: string[][] = []

  for (const minute of [0, 1, 2]) {
    const first = send(minute)
    assert.equal(first.accepted, true, 'minute opens with room on both quotas')

    engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: atMinute(minute, 5) })

    const second = send(minute)
    assert.equal(second.accepted, false, 'the second request in the minute must refuse')

    const { attribution } = engine.settle({
      resourceId: 'key-1',
      kind: 'rate-limit',
      settledAt: atMinute(minute, 40),
    })

    truthByClause.push([...second.full].sort())

    const clauses = attribution!.hypotheses!.clauses
    initialCandidates.push(clauses[clauses.length - 1]!.candidates.slice().sort())
  }

  // Legacy: every rejection wrote one sample on EVERY counter — but note the
  // asymmetry the window keys create: rpm's three rejections land in three
  // distinct minute windows (three samples), while all three land in the same
  // hour window (one sample, replaced twice). Window identity is doing real
  // work here — the hour's single sample can never establish on its own.
  const runtime = engine.getResourceRuntime('key-1')!
  assert.equal(runtime.estimates.rpm!.samples.length, 3)
  assert.equal(runtime.estimates.rph!.samples.length, 1)

  const report = engine
    .settle({
      resourceId: 'key-1',
      kind: 'rate-limit',
      settledAt: atMinute(3, 40),
    })
    .attribution!.hypotheses!

  // The engine-attached report carries the same ledger the standalone tests
  // exercise: 4 clauses now (the extra refusal above), each traceable.
  assert.equal(report.clauses.length, 4)
  assert.equal(report.resourceId, 'key-1')

  // At creation every clause held both counters — the honest initial state.
  for (const candidates of initialCandidates) {
    assert.equal(candidates.length, 3)

    for (const id of ['rpm', 'rph', 'rpd']) {
      assert.ok(candidates.includes(id), `initial clause holds ${id}`)
    }
  }

  // Final state, read after all evidence landed: the first two clauses narrowed
  // to the minute as the hour proved its innocence, while the third — refused
  // when BOTH quotas were genuinely full — stays ambiguous.
  assert.deepEqual(report.clauses[0]!.candidates, ['rpm'])
  assert.deepEqual(report.clauses[1]!.candidates, ['rpm'])
  assert.deepEqual(report.clauses[2]!.candidates.slice().sort(), ['rpd', 'rph', 'rpm'])

  // And the narrowing landed on the truth every time: no true culprit was ever
  // eliminated from its own clause.
  const finals = [report.clauses[0]!, report.clauses[1]!, report.clauses[2]!].map((clause) =>
    clause.candidates.slice().sort(),
  )

  for (const [index, trueCulprits] of truthByClause.entries()) {
    for (const culprit of trueCulprits) {
      assert.ok(
        finals[index]!.includes(culprit),
        `clause ${index + 1}: true culprit ${culprit} survived elimination`,
      )
    }
  }

  assert.deepEqual(truthByClause[2], ['rph', 'rpm'], 'the third refusal was genuinely joint')
  assert.equal(report.clauses[2]!.resolved, false)
  // The extra refusal lands when the hour is full but the day is nowhere near
  // it — yet rpd can never be eliminated, because nothing in this short run
  // proves the day innocent. So it abstains alongside the joint one, for the
  // opposite reason: not "several quotas might have done it" but "one quota
  // provably did, plus one that can never be ruled out". The report keeps both
  // readings apart instead of merging them.
  assert.equal(report.clauses[3]!.resolved, false)
  assert.deepEqual(report.clauses[3]!.candidates.slice().sort(), ['rpd', 'rph'])
  assert.deepEqual(report.abstained, [report.clauses[2]!.id, report.clauses[3]!.id])

  // With the cause set left open — the engine declares no topology — nothing
  // pins: abstention here is a result, and the verdicts say unresolved with
  // reasons rather than silence.
  assert.equal(report.verdicts.rpm, 'unresolved')
  assert.equal(report.verdicts.rph, 'unresolved')
  assert.deepEqual(report.proofs, [])
})

test('acceptance 37: ambiguous, joint and stale evidence never becomes modelProven', () => {
  // The engine declares no topology, so every clause it opens is `open` scope —
  // and open clauses never pin, whatever the levels say. What CAN appear is a
  // provider-named cause, which pins unconditionally. Both halves:
  const engine = buildTwoKeyEngine()
  const at = (minute: number, second: number) =>
    `2026-08-23T11:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`

  for (const minute of [0, 1]) {
    engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: at(minute, 5) })
    engine.settle({ resourceId: 'key-1', kind: 'rate-limit', settledAt: at(minute, 40) })
  }

  const ambiguous = engine
    .settle({ resourceId: 'key-1', kind: 'rate-limit', settledAt: at(2, 40) })
    .attribution!.hypotheses!

  assert.deepEqual(ambiguous.proofs, [], 'two plausible counters, no pin')
  assert.equal(ambiguous.verdicts.rpm, 'unresolved')

  // ...unless the provider names it. A named cause is a fact about this refusal,
  // not an inference, so it bounds unconditionally — even under open scope. The
  // minute carries one accepted request first, so the named bound lands exactly
  // on proven traffic rather than below it.
  engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: at(3, 5) })
  const named = engine
    .settle({
      resourceId: 'key-1',
      kind: 'rate-limit',
      settledAt: at(3, 40),
      rateLimit: { blamedCounterIds: ['rpm'] },
    })
    .attribution!.hypotheses!

  const rpmProof = named.proofs.find((entry) => entry.counterId === 'rpm')!

  assert.equal(named.verdicts.rpm, 'proven')
  assert.equal(rpmProof.ceiling, 1)
  assert.ok(
    rpmProof.dependsOn.some((dep) => dep.includes('reported')),
    'a reported cause travels with its provenance, not as bare fact',
  )

  // End to end: the same pin surfaces on the live assessment — as an observed
  // boundary, never as a quota claim, and never as modelProven. The legacy
  // engine disagrees (it cleared this level), and both readings are carried
  // side by side: neither overwrites the other.
  const assessed = engine
    .decide({ now: at(3, 50) })
    .perResource.find((entry) => entry.resourceId === 'key-1')!
    .counters.find((counter) => counter.counterId === 'rpm')!

  assert.equal(assessed.contract, 'observedBoundary')
  assert.equal(assessed.limit, null)
  assert.equal(assessed.boundary!.verdict, 'proven')
  assert.equal(assessed.boundary!.ceiling, 1)
  assert.equal(assessed.boundary!.reportedBacked, true)
  assert.equal(assessed.boundary!.ledgerScope, 'session')
  assert.ok(assessed.boundary!.standing.length > 0)
  assert.ok(assessed.boundary!.dependsOn.some((dep) => dep.includes('reported')))
  assert.equal(assessed.inference.estimatedLimit, 1)
  assert.equal(assessed.inference.status, 'cleared')
})

test('acceptance 38: same evidence in, same shadow report out', () => {
  const run = () => {
    const engine = buildTwoKeyEngine()
    engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: '2026-08-23T11:00:05.000Z' })
    return engine.settle({ resourceId: 'key-1', kind: 'rate-limit', settledAt: '2026-08-23T11:00:40.000Z' })
      .attribution!.hypotheses!
  }

  assert.deepEqual(run(), run(), 'reporting must be as deterministic as routing')
})

test('acceptance 39: snapshots carry no shadow state', () => {
  const engine = buildTwoKeyEngine()
  engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: '2026-08-23T11:00:05.000Z' })
  engine.settle({ resourceId: 'key-1', kind: 'rate-limit', settledAt: '2026-08-23T11:00:40.000Z' })

  const snapshotJson = JSON.stringify(engine.getSnapshot())

  assert.ok(!snapshotJson.includes('hypotheses'), 'ledgers live outside the snapshot')
  assert.ok(!snapshotJson.includes('soleCandidate'), 'no clause survives a restart either')

  // A restored engine therefore reports an empty ledger, not a stale one — and
  // crucially, routing is unaffected either way (acceptance 17/33 guard that).
  const restored = new AdaptiveThrottleEngine(JSON.parse(snapshotJson))
  restored.register([buildWindowedResource('key-1'), buildWindowedResource('key-2')])
  const fresh = restored
    .settle({ resourceId: 'key-1', kind: 'rate-limit', settledAt: '2026-08-23T11:01:40.000Z' })
    .attribution!.hypotheses!

  assert.equal(fresh.clauses.length, 1, 'only the post-restart refusal is known')
})

// The general form of the candidateLimit/utilization holes: any field whose
// NAME suggests a ceiling must either be null, sit under an authoritative
// contract, or sit beside its provenance label. This walks a whole public
// decision output so the next added field is caught, not trusted.
const ceilingName = /limit|ceiling|cap|quota|threshold|remaining|maximum/i

function collectCeilingViolations(output: unknown): string[] {
  const violations: string[] = []

  const visit = (node: unknown, path: string, contract: string | null): void => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${path}[${index}]`, contract))
      return
    }

    if (node === null || typeof node !== 'object') {
      return
    }

    const record = node as Record<string, unknown>
    const here =
      typeof record.contract === 'string' && record.contract !== 'unresolved'
        ? String(record.contract)
        : contract

    for (const [key, value] of Object.entries(record)) {
      const at = `${path}.${key}`

      if (typeof value !== 'number' || !ceilingName.test(key)) {
        // The inference subtree is the label itself — its numbers are asserted
        // structurally by acceptance 32, not by this tripwire.
        if (key !== 'inference') {
          visit(value, at, here)
        }
        continue
      }

      // A fact may carry any number. Anything else may only carry a number that
      // cannot be mistaken for one: candidateLimit and softCeiling are allowed
      // exactly because they share their object with the contract and the
      // inference that explain them. A shadow `ceiling` is allowed exactly
      // because it shares its object with the verdict, the standing sentence,
      // and the session scope that say it is not a quota. Everything else —
      // limit, headroom, utilization, and whatever gets added next — must be
      // null.
      const labeledSteering =
        (key === 'candidateLimit' || key === 'softCeiling') &&
        record.inference != null &&
        typeof record.limitSource === 'string'
      const labeledBoundary =
        key === 'ceiling' &&
        typeof record.standing === 'string' &&
        typeof record.verdict === 'string' &&
        record.ledgerScope === 'session'

      if (here !== 'authoritative' && !labeledSteering && !labeledBoundary) {
        violations.push(`${at} = ${value} with contract ${here ?? 'none'}`);
      }
    }
  }

  visit(output, '$', null)

  return violations
}

test('acceptance 33c: no numeric field reads as a limit unless its contract says so', () => {
  // The general form of the candidateLimit/utilization holes: any future field
  // whose NAME suggests a ceiling must either be null, sit under an
  // authoritative contract, or sit beside its provenance label. This walks the
  // whole public decision output so the next added field is caught, not trusted.
  const engine = buildTwoKeyEngine()
  establishMinuteLimitOfFour(engine, 0)
  engine.settle({
    resourceId: 'key-1',
    kind: 'success',
    settledAt: '2026-08-23T11:20:00.000Z',
    provider: { source: 'headers', counters: [{ counterId: 'rpd', limit: 245 }] },
  })

  const { advice, perResource } = engine.decide({ now: '2026-08-23T11:20:30.000Z' })

  assert.deepEqual(collectCeilingViolations({ advice, perResource }), [], 'every ceiling-named number is labeled or null')
})

test('acceptance 48: two traffic shapes agreeing never promotes to modelProven', () => {
  // The veto, end to end: the same value under two loads is a consistency
  // signal, not a quota claim — a shared pool or a hidden quota survives a
  // change of load just as well. Both shapes are listed so the signal stays
  // useful without becoming authority.
  const engine = buildTwoKeyEngine()
  const shape = (minute: number, name: string) => {
    const pad = String(minute).padStart(2, '0')

    engine.settle({
      resourceId: 'key-1',
      kind: 'success',
      settledAt: `2026-08-23T11:${pad}:05.000Z`,
      usage: { trafficShape: name },
    })
    engine.settle({
      resourceId: 'key-1',
      kind: 'rate-limit',
      settledAt: `2026-08-23T11:${pad}:40.000Z`,
      usage: { trafficShape: name },
      rateLimit: { blamedCounterIds: ['rpm'] },
    })
  }

  shape(0, 'burst')
  shape(1, 'trickle')

  const assessed = engine
    .decide({ now: '2026-08-23T11:01:50.000Z' })
    .perResource.find((entry) => entry.resourceId === 'key-1')!
    .counters.find((counter) => counter.counterId === 'rpm')!

  assert.equal(assessed.contract, 'observedBoundary')
  assert.equal(assessed.limit, null)
  assert.equal(assessed.boundary!.verdict, 'proven')
  assert.equal(assessed.boundary!.ceiling, 1)
  assert.deepEqual([...assessed.boundary!.shapes].sort(), ['burst', 'trickle'])
})

test('acceptance 49: a pinned boundary passes the same ceiling tripwire', () => {
  // The tripwire of acceptance 33c must hold where a real `ceiling` number is
  // present, not only where every ceiling is null: the pin carries its
  // verdict, its standing sentence, and its session scope, or it trips.
  const engine = buildTwoKeyEngine()

  engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: '2026-08-23T11:00:05.000Z' })
  engine.settle({
    resourceId: 'key-1',
    kind: 'rate-limit',
    settledAt: '2026-08-23T11:00:40.000Z',
    rateLimit: { blamedCounterIds: ['rpm'] },
  })

  const { advice, perResource } = engine.decide({ now: '2026-08-23T11:00:50.000Z' })
  const rpm = perResource
    .find((entry) => entry.resourceId === 'key-1')!
    .counters.find((counter) => counter.counterId === 'rpm')!

  assert.equal(rpm.boundary!.ceiling, 1, 'the tripwire runs against a live pin, not an empty chair')
  assert.deepEqual(collectCeilingViolations({ advice, perResource }), [], 'a labeled boundary is not a bare ceiling')
})

test('acceptance 50: an unpinned ledger still explains itself on every assessment', () => {
  // Abstention, stated: anonymous evidence under an open cause set never pins,
  // but the ledger exists, so its silence is reported with its reason — not
  // omitted. The shadow does not override what it did not pin: the contract
  // stays the legacy engine's, beside the shadow's unresolved reading.
  const engine = buildTwoKeyEngine()
  establishMinuteLimitOfFour(engine, 0)

  const rpm = engine
    .decide({ now: '2026-08-23T11:03:00.000Z' })
    .perResource.find((entry) => entry.resourceId === 'key-1')!
    .counters.find((counter) => counter.counterId === 'rpm')!

  assert.equal(rpm.contract, 'legacyEstimate')
  assert.equal(rpm.limit, null)
  assert.equal(rpm.inference.estimatedLimit, 4)
  assert.ok(rpm.boundary != null, 'the ledger exists, so its silence is reported, not omitted')
  assert.equal(rpm.boundary!.verdict, 'unresolved')
  assert.equal(rpm.boundary!.ceiling, null)
  assert.ok(rpm.boundary!.standing.length > 0)
  assert.equal(rpm.boundary!.ledgerScope, 'session')
})

test('acceptance 51: a restore drops the boundary but keeps the legacy reading', () => {
  // The time scope, end to end: the ledger is session-local, so a restored
  // engine reports no boundary — not a refuted one, a reset one. The legacy
  // estimate survives in the snapshot and takes the contract back, with the
  // limit claim still absent.
  const engine = buildTwoKeyEngine()

  engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: '2026-08-23T11:00:05.000Z' })
  engine.settle({
    resourceId: 'key-1',
    kind: 'rate-limit',
    settledAt: '2026-08-23T11:00:40.000Z',
    rateLimit: { blamedCounterIds: ['rpm'] },
  })

  const before = engine
    .decide({ now: '2026-08-23T11:00:50.000Z' })
    .perResource.find((entry) => entry.resourceId === 'key-1')!
    .counters.find((counter) => counter.counterId === 'rpm')!

  assert.equal(before.contract, 'observedBoundary')
  assert.ok(before.boundary != null)

  const restored = new AdaptiveThrottleEngine(JSON.parse(JSON.stringify(engine.getSnapshot())))
  restored.register([buildWindowedResource('key-1'), buildWindowedResource('key-2')])

  const after = restored
    .decide({ now: '2026-08-23T11:00:50.000Z' })
    .perResource.find((entry) => entry.resourceId === 'key-1')!
    .counters.find((counter) => counter.counterId === 'rpm')!

  assert.equal(after.boundary, null, 'no ledger survived the restore, so none is claimed')
  assert.equal(after.contract, 'legacyEstimate')
  assert.equal(after.limit, null)
})

test('acceptance 40: eight concurrent requests collapse onto one key; serialized they split', () => {
  // The same 8 requests, the same provider truth (rpm 4 per key), two dispatch
  // orders. Serialized, the engine sees each settle before the next decide and
  // spreads 4+4... except the fifth request arrives before anything was
  // learned, so one rejection teaches the ceiling and the rest rotate onto
  // key-2: 7 accepted. Concurrent without reservation, all eight decides read
  // the same empty level and land on one key (4 accepted); with the reserve
  // protocol each decision sees the promises the earlier ones made, the eight
  // spread 4+4, and all succeed — no rejection was needed to find the split,
  // because in-flight is a fact about the engine's own advice, not a ceiling
  // that had to be discovered.
  const truth = { rpm: 4 }
  const counts = new Map<string, number>()

  function providerSend(key: string): boolean {
    const used = counts.get(key) ?? 0

    if (used >= truth.rpm) {
      return false
    }

    counts.set(key, used + 1)
    return true
  }

  function build() {
    const engine = new AdaptiveThrottleEngine(undefined, { mode: 'smart' })
    engine.register([buildWindowedResource('key-1'), buildWindowedResource('key-2')])
    return engine
  }

  const now = '2026-08-23T11:00:00.000Z'

  // Arm 1 — serialized: decide, settle, repeat. With zero knowledge every score
  // ties at neutral, so the first four land on key-1; the fifth is refused and
  // teaches the ceiling, and the rest rotate onto key-2.
  const serial = build()
  counts.clear()
  let serialAccepted = 0

  for (let index = 0; index < 8; index += 1) {
    const target = serial.decide({ now }).advice.resourceId!
    const at = `2026-08-23T11:00:${String(index).padStart(2, '0')}.000Z`

    if (providerSend(target)) {
      serialAccepted += 1
      serial.settle({ resourceId: target, kind: 'success', settledAt: at })
    } else {
      serial.settle({ resourceId: target, kind: 'rate-limit', settledAt: at })
    }
  }

  assert.equal(serialAccepted, 7, 'one rejection teaches the ceiling, then it rotates')

  // Arm 2 — concurrent with the reserve protocol: every decide is followed by
  // a reserve, so each decision sees the promises the earlier ones made.
  const concurrent = build()
  counts.clear()
  const targets: string[] = []
  let concurrentRejected = 0

  for (let index = 0; index < 8; index += 1) {
    const target = concurrent.decide({ now }).advice.resourceId!

    targets.push(target)
    concurrent.reserve({ resourceId: target, now })
  }

  targets.forEach((target, index) => {
    const at = `2026-08-23T11:00:${String(index).padStart(2, '0')}.000Z`

    if (providerSend(target!)) {
      concurrent.settle({ resourceId: target!, kind: 'success', settledAt: at })
    } else {
      concurrentRejected += 1
      concurrent.settle({ resourceId: target!, kind: 'rate-limit', settledAt: at })
    }
  })

  assert.equal(new Set(targets).size, 2, 'the reserve protocol spreads concurrent decides across both keys')
  assert.equal(concurrentRejected, 0, 'so all eight succeed with no rejection to learn from')

  // And that is the honest end of it: with no rejection there is no boundary
  // sample, no candidate, no estimate — routing avoided the lesson entirely,
  // and the engine claims nothing it did not observe.
  const runtime = concurrent.getResourceRuntime(targets[0]!)!

  assert.equal(runtime.estimates.rpm!.samples.length, 0, 'no rejection, no sample, no inferred ceiling')
})

// ---------------------------------------------------------------------------
// Acceptance 41–47 — window reservation
// ---------------------------------------------------------------------------

test('acceptance 41: reserved windows steer the next decision onto the emptier key', () => {
  const engine = buildTwoKeyEngine()
  const now = '2026-08-23T11:00:00.000Z'

  assert.equal(engine.decide({ now }).advice.resourceId, 'key-1')

  engine.reserve({ resourceId: 'key-1', now })

  const second = engine.decide({ now })

  assert.equal(second.advice.resourceId, 'key-2')
  assert.match(
    second.perResource.find((entry) => entry.resourceId === 'key-1')!.reason,
    /in flight/,
  )
})

test('acceptance 42: a reported level stays settled traffic while holds are outstanding', () => {
  const engine = buildTwoKeyEngine()
  const now = '2026-08-23T11:00:00.000Z'

  engine.reserve({ resourceId: 'key-1', now })
  engine.reserve({ resourceId: 'key-1', now })

  const level = engine
    .decide({ now })
    .perResource.find((entry) => entry.resourceId === 'key-1')!
    .counters.find((counter) => counter.counterId === 'rpm')!.level

  assert.equal(level, 0, 'holds are promises, not usage, and the report says so')
})

test('acceptance 43: settling releases the hold it promised', () => {
  const engine = buildTwoKeyEngine()
  const now = '2026-08-23T11:00:00.000Z'

  engine.reserve({ resourceId: 'key-1', now })
  assert.equal(engine.decide({ now }).advice.resourceId, 'key-2')

  engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: now })

  const after = engine.decide({ now })
  const key1 = after.perResource.find((entry) => entry.resourceId === 'key-1')!

  assert.equal(after.advice.resourceId, 'key-1', 'the promise settled into usage; both keys read empty of holds')
  assert.equal(key1.counters.find((counter) => counter.counterId === 'rpm')!.level, 1)
  assert.doesNotMatch(key1.reason, /in flight/)
})

test('acceptance 44: holds die with their window', () => {
  const engine = buildSingleCounterEngine()

  for (let index = 0; index < 4; index += 1) {
    engine.reserve({ resourceId: 'key-1', now: '2026-08-23T11:00:59.000Z' })
  }

  const afterRoll = engine.decide({ now: '2026-08-23T11:01:01.000Z' })

  assert.equal(afterRoll.advice.resourceId, 'key-1', 'the minute rolled, so the promises belong to dead quota')
  assert.doesNotMatch(afterRoll.advice.reason, /in flight/)
})

test('acceptance 45: a restart drops outstanding holds', () => {
  const engine = buildTwoKeyEngine()
  const now = '2026-08-23T11:00:00.000Z'

  engine.reserve({ resourceId: 'key-1', now })
  assert.equal(engine.decide({ now }).advice.resourceId, 'key-2')

  const restored = new AdaptiveThrottleEngine(JSON.parse(JSON.stringify(engine.getSnapshot())))
  restored.register([buildWindowedResource('key-1'), buildWindowedResource('key-2')])

  const after = restored.decide({ now })

  assert.equal(after.advice.resourceId, 'key-1', 'the process that promised is gone; the promises went with it')
  assert.doesNotMatch(after.advice.reason, /in flight/)
})

test('acceptance 46: holds never learn — reservation alone estimates nothing', () => {
  const engine = buildTwoKeyEngine()
  const now = '2026-08-23T11:00:00.000Z'

  for (let index = 0; index < 5; index += 1) {
    engine.reserve({ resourceId: 'key-1', now })
  }

  const assessment = engine
    .decide({ now })
    .perResource.find((entry) => entry.resourceId === 'key-1')!
    .counters.find((counter) => counter.counterId === 'rpm')!

  assert.equal(assessment.contract, 'unresolved')
  assert.equal(assessment.candidateLimit, null)
  assert.equal(assessment.inference.status, 'unobserved')
  assert.equal(assessment.level, 0)
})

test('acceptance 47: holds against a stated ceiling withhold — and say why', () => {
  const engine = buildTwoKeyEngine()

  engine.settle({
    resourceId: 'key-1',
    kind: 'success',
    settledAt: '2026-08-23T11:00:10.000Z',
    provider: { source: 'headers', counters: [{ counterId: 'rpm', limit: 4 }] },
  })

  for (let index = 0; index < 4; index += 1) {
    engine.reserve({ resourceId: 'key-1', now: '2026-08-23T11:00:20.000Z' })
  }

  const full = engine.decide({ now: '2026-08-23T11:00:21.000Z' }).perResource.find(
    (entry) => entry.resourceId === 'key-1',
  )!

  assert.equal(full.decision, 'defer')
  assert.match(full.reason, /in flight/)
  assert.equal(
    full.counters.find((counter) => counter.counterId === 'rpm')!.level,
    1,
    'the report still says one settled request, not five',
  )
})

test('acceptance 36: a bare decide never reserves — eight concurrent decides share one view', () => {
  // Purity pin, not a specification of blindness: `decide()` itself never
  // reserves — reservation is an explicit `reserve()` call — so k decisions
  // made before any settle all read the same committed level. This test pins
  // that `decide` stays read-only; the concurrent routing fix lives in the
  // reserve protocol, demonstrated by acceptance 40, and must not change what
  // a bare `decide` observes.
  const engine = buildTwoKeyEngine()
  const now = '2026-08-23T11:00:00.000Z'

  const targets = Array.from({ length: 8 }, () => engine.decide({ now }).advice.resourceId)

  assert.ok(targets.every((target) => target === targets[0]), 'no reservation, no spread: decide alone promises nothing')

  targets.forEach((target, index) => {
    engine.settle({
      resourceId: target!,
      kind: 'success',
      settledAt: `2026-08-23T11:00:${String(index).padStart(2, '0')}.000Z`,
    })
  })

  // The settle path itself is exact: all eight charges land.
  const level = engine
    .decide({ now: '2026-08-23T11:00:30.000Z' })
    .perResource.find((entry) => entry.resourceId === targets[0])!
    .counters.find((counter) => counter.counterId === 'rpm')!.level

  assert.equal(level, 8)
})

test('acceptance 34: the contract survives a restart', () => {  const engine = buildTwoKeyEngine()
  establishMinuteLimitOfFour(engine, 0)
  engine.settle({
    resourceId: 'key-1',
    kind: 'success',
    settledAt: '2026-08-23T11:20:00.000Z',
    provider: { source: 'headers', counters: [{ counterId: 'rpd', limit: 245 }] },
  })

  const input = { now: '2026-08-23T11:20:30.000Z' }
  const before = engine.decide(input).perResource

  const restored = new AdaptiveThrottleEngine(JSON.parse(JSON.stringify(engine.getSnapshot())))
  restored.register([buildWindowedResource('key-1'), buildWindowedResource('key-2')])

  const after = restored.decide(input).perResource

  assert.equal(after.length, before.length)

  for (const left of before) {
    const right = after.find((entry) => entry.resourceId === left.resourceId)!

    for (const counter of left.counters) {
      const match = right.counters.find((entry) => entry.counterId === counter.counterId)!

      // The contract is recomputed from persisted state, so it must come back
      // identical — including which numbers are limits and which are labeled
      // inference.
      assert.equal(match.contract, counter.contract)
      assert.equal(match.limit, counter.limit)
      assert.equal(match.limitSource, counter.limitSource)
      assert.deepEqual(match.inference, counter.inference)
    }
  }
})

// ---------------------------------------------------------------------------
// Acceptance 62–64 — the bucket counter
// ---------------------------------------------------------------------------

/** A provider whose limiter refills: capacity `limit`, one per `windowMs`. */
function buildBucketEngine(limit: number | null): AdaptiveThrottleEngine {
  const engine = new AdaptiveThrottleEngine(null, { mode: 'smart' })
  engine.register([
    {
      resourceId: 'key-1',
      counters: [
        {
          counterId: 'rpm',
          kind: 'bucket',
          unit: 'count',
          bucket: { windowMs: 60_000 },
          ...(limit != null ? { limit } : {}),
        },
      ],
    },
    {
      resourceId: 'key-2',
      counters: [
        {
          counterId: 'rpm',
          kind: 'bucket',
          unit: 'count',
          bucket: { windowMs: 60_000 },
          ...(limit != null ? { limit } : {}),
        },
      ],
    },
  ])

  return engine
}

test('acceptance 62: a bucket refills continuously instead of expiring at a boundary', () => {
  // The difference that a window cannot express: after the bucket empties, a
  // slot comes back as soon as it refills — not when the oldest charge ages out.
  const engine = buildBucketEngine(3)
  const at = (ms: number) => new Date(Date.parse('2026-08-23T11:00:00.000Z') + ms).toISOString()

  // Three requests inside the first second empty a 3-per-minute bucket.
  for (const offset of [0, 100, 200]) {
    engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: at(offset) })
  }

  const level = (nowMs: number): number =>
    engine
      .decide({ now: at(nowMs) })
      .perResource.find((entry) => entry.resourceId === 'key-1')!
      .counters.find((counter) => counter.counterId === 'rpm')!.level

  // Just charged: all three still outstanding. The level is a decayed quantity
  // rather than a count, so it is compared to within the refill of one unit.
  const near = (actual: number, expected: number): void => assert.ok(Math.abs(actual - expected) < 0.5, `${actual} ≈ ${expected}`)

  near(level(300), 3)
  near(level(20_300), 2)
  near(level(40_300), 1)
  near(level(60_300), 0)

  // And the same charges spread over a longer window never accumulate: two
  // requests 20 seconds apart leave one outstanding, not two, because the first
  // has already refilled by the time the second lands.
  const spread = buildBucketEngine(3)

  spread.settle({ resourceId: 'key-1', kind: 'success', settledAt: at(0) })
  spread.settle({ resourceId: 'key-1', kind: 'success', settledAt: at(20_000) })

  near(
    spread
      .decide({ now: at(20_100) })
      .perResource.find((entry) => entry.resourceId === 'key-1')!
      .counters.find((counter) => counter.counterId === 'rpm')!.level,
    1,
  )
})

test('acceptance 63: a bucket refusal is sampled at the occupancy that refused', () => {
  // The measured Groq behaviour: the provider said "Used 30, Limit 30" while the
  // engine's 60s window held a different number. With a bucket, the level at
  // refusal is the occupancy that refused — which is what makes a boundary sample
  // mean anything at all.
  const build = () => {
    const engine = buildBucketEngine(null)

    // Three requests inside each period, then a refusal: the bucket is exhausted
    // at three, the way a provider's is at thirty.
    for (let period = 0; period < ESTABLISHMENT_MIN_INDEPENDENT_WINDOWS; period += 1) {
      const base = period * 60_000

      for (const offset of [0, 1_000, 2_000]) {
        engine.settle({
          resourceId: 'key-1',
          kind: 'success',
          settledAt: new Date(Date.parse('2026-08-23T11:00:00.000Z') + base + offset).toISOString(),
        })
      }

      engine.settle({
        resourceId: 'key-1',
        kind: 'rate-limit',
        settledAt: new Date(Date.parse('2026-08-23T11:00:00.000Z') + base + 3_000).toISOString(),
        detail: 'too many requests',
      })
    }

    return engine
  }

  const engine = build()
  const estimate = engine.getResourceRuntime('key-1')!.estimates.rpm!

  // The regression this test guards: bucket counters were invisible to the
  // observation builder, the boundary sampler and the success path in turn, so a
  // bucket could never be inferred from at all.
  assert.equal(estimate.status, 'established', 'a bucket establishes like a window')
  assert.equal(estimate.estimatedLimit, 3, 'the occupancy at refusal, which is the ceiling')
  assert.equal(estimate.estimatedLimit, build().getResourceRuntime('key-1')!.estimates.rpm!.estimatedLimit, 'and deterministically')
  assert.ok(
    estimate.samples.every((sample) => Math.abs(sample.observedValue - 3) < 0.5),
    `every refusal sampled at the occupancy that refused: ${JSON.stringify(estimate.samples.map((s) => s.observedValue))}`,
  )
})

test('acceptance 64: an unrated bucket is measured as the trailing window of its period', () => {
  // The bootstrap, and the reason it exists. A bucket's rate is `limit / period`,
  // so before a ceiling is known there is no rate — and a counter that reported
  // only its outstanding debt would report a lifetime cumulative instead of a
  // level, which could never earn a first ceiling and so never earn a rate. The
  // trailing window of the same period is measured instead, and the decay takes
  // over the moment an estimate exists.
  const engine = buildBucketEngine(null)
  const at = (ms: number) => new Date(Date.parse('2026-08-23T11:00:00.000Z') + ms).toISOString()

  engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: at(0) })
  engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: at(1_000) })

  const level = (nowMs: number): number =>
    engine
      .decide({ now: at(nowMs) })
      .perResource.find((entry) => entry.resourceId === 'key-1')!
      .counters.find((counter) => counter.counterId === 'rpm')!.level

  assert.equal(level(2_000), 2, 'both charges are inside the period')
  assert.equal(level(62_000), 0, 'and both have left it, so the bucket reads empty')
})

/** Same shape as `establishMinuteLimitOfFour`, on either key. */
function establishFourOn(engine: AdaptiveThrottleEngine, resourceId: string, firstMinute: number): void {
  for (let offset = 0; offset < ESTABLISHMENT_MIN_INDEPENDENT_WINDOWS; offset += 1) {
    const minute = firstMinute + offset
    const pad = String(minute).padStart(2, '0')

    for (let index = 0; index < 4; index += 1) {
      engine.settle({
        resourceId,
        kind: 'success',
        settledAt: `2026-08-23T11:${pad}:${String(index * 5).padStart(2, '0')}.000Z`,
      })
    }

    engine.settle({
      resourceId,
      kind: 'rate-limit',
      settledAt: `2026-08-23T11:${pad}:40.000Z`,
      detail: 'too many requests',
    })
  }
}

test('acceptance 59: a caution the whole fleet shares is not information', () => {
  // The discrimination rule, end to end. When every candidate resource is near
  // the same learned ceiling, the caution describes the fleet rather than
  // choosing within it, so the engine declines to steer on it — and falls back
  // to its evidence-free ordering instead.
  const uniform = buildSingleCounterEngine('smart')
  establishFourOn(uniform, 'key-1', 0)
  establishFourOn(uniform, 'key-2', 0)

  for (const second of [2, 7, 12, 17]) {
    uniform.settle({ resourceId: 'key-1', kind: 'success', settledAt: `2026-08-23T11:10:${String(second).padStart(2, '0')}.000Z` })
    uniform.settle({ resourceId: 'key-2', kind: 'success', settledAt: `2026-08-23T11:10:${String(second).padStart(2, '0')}.000Z` })
  }

  const request = { now: '2026-08-23T11:10:20.000Z', forecast: { rpm: 3 } }
  const uniformAdvice = uniform.decide(request)
  const uniformKey1 = uniformAdvice.perResource.find((entry) => entry.resourceId === 'key-1')!
  const uniformKey2 = uniformAdvice.perResource.find((entry) => entry.resourceId === 'key-2')!

  assert.equal(uniformKey1.counters[0]!.limit, null, 'still nothing a caller may repeat as the limit')
  assert.notEqual(uniformKey1.counters[0]!.state, 'near-limit', 'a shared caution is not a preference')
  assert.notEqual(uniformKey2.counters[0]!.state, 'near-limit')
  assert.equal(uniformKey1.score, uniformKey2.score, 'and it does not order the fleet')

  // Heterogeneous: only one key carries the learned ceiling, so the caution
  // separates it from the alternative — and steers, exactly as before.
  const mixed = buildSingleCounterEngine('smart')
  establishFourOn(mixed, 'key-1', 0)

  for (const second of [2, 7, 12, 17]) {
    mixed.settle({ resourceId: 'key-1', kind: 'success', settledAt: `2026-08-23T11:10:${String(second).padStart(2, '0')}.000Z` })
  }

  const mixedAdvice = mixed.decide(request)
  const mixedKey1 = mixedAdvice.perResource.find((entry) => entry.resourceId === 'key-1')!
  const mixedKey2 = mixedAdvice.perResource.find((entry) => entry.resourceId === 'key-2')!

  assert.equal(mixedKey1.counters[0]!.state, 'near-limit', 'a discriminating caution still steers')
  assert.ok(mixedKey1.score < mixedKey2.score, 'so the fuller key is ranked below the emptier one')
  assert.equal(mixedAdvice.advice.resourceId, 'key-2')
})

test('acceptance 60: the failover hint is a live memory, not a grudge', () => {
  // The rotation rule scoped: a key with an unanswered failure goes behind its
  // equally-scored peers, and the hint disappears the moment the key recovers.
  // An un-scoped version would keep a key that failed once behind a key that
  // never failed, forever — remembering a grudge instead of spreading load.
  //
  // The failure-memory demotion multiplier is turned off so the scores are
  // equal and the ordering term is the only thing that can prefer key-2: that
  // is what makes this a test of the rotation rather than of the multiplier.
  const engine = new AdaptiveThrottleEngine(null, { mode: 'smart', failureScoreFactor: 1 })
  engine.register([
    {
      resourceId: 'key-1',
      counters: [{ counterId: 'rpm', unit: 'count', window: { windowMs: 60_000, alignment: 'fixed' } }],
    },
    {
      resourceId: 'key-2',
      counters: [{ counterId: 'rpm', unit: 'count', window: { windowMs: 60_000, alignment: 'fixed' } }],
    },
  ])

  const at = (minute: number, second: number) =>
    `2026-08-23T11:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`

  engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: at(0, 5) })
  engine.settle({ resourceId: 'key-2', kind: 'success', settledAt: at(0, 6) })
  engine.settle({ resourceId: 'key-1', kind: 'rate-limit', settledAt: at(0, 40) })

  const afterFailure = engine.decide({ now: at(2, 0) })
  const failedKey1 = afterFailure.perResource.find((entry) => entry.resourceId === 'key-1')!
  const failedKey2 = afterFailure.perResource.find((entry) => entry.resourceId === 'key-2')!

  assert.equal(afterFailure.advice.resourceId, 'key-2', 'an unanswered failure rotates load away')
  assert.equal(failedKey1.decision, 'send', 'behind its peers, never withheld')
  assert.equal(failedKey1.score, failedKey2.score, 'the ordering hint, not a score change')

  // Recovery: the hint is gone, so the memory released by evidence is the same
  // memory the ordering read. The pre-failure preference comes back.
  engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: at(3, 5) })

  const afterRecovery = engine.decide({ now: at(4, 0) })
  const recoveredKey1 = afterRecovery.perResource.find((entry) => entry.resourceId === 'key-1')!
  const recoveredKey2 = afterRecovery.perResource.find((entry) => entry.resourceId === 'key-2')!

  assert.equal(afterRecovery.advice.resourceId, 'key-1', 'recovered means the grudge is over')
  assert.doesNotMatch(recoveredKey1.reason, /no success has followed/)
  assert.equal(recoveredKey1.score, recoveredKey2.score, 'and it competes on par')
})

test('acceptance 61: inferred steering can still be turned off entirely', () => {
  // The knob that produced the whole measurement, kept honest: with inference
  // steering off, levels and reports are unchanged and only the decision
  // pathway stops reading them.
  const engine = new AdaptiveThrottleEngine(null, { mode: 'smart', steerOnInference: false })
  engine.register([
    {
      resourceId: 'key-1',
      counters: [{ counterId: 'rpm', unit: 'count', window: { windowMs: 60_000, alignment: 'fixed' } }],
    },
    {
      resourceId: 'key-2',
      counters: [{ counterId: 'rpm', unit: 'count', window: { windowMs: 60_000, alignment: 'fixed' } }],
    },
  ])

  establishFourOn(engine, 'key-1', 0)

  for (const second of [2, 7, 12, 17]) {
    engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: `2026-08-23T11:10:${String(second).padStart(2, '0')}.000Z` })
  }

  const { perResource } = engine.decide({ now: '2026-08-23T11:10:20.000Z', forecast: { rpm: 3 } })
  const key1 = perResource.find((entry) => entry.resourceId === 'key-1')!

  // Reported exactly as before: the number is still there, still labelled.
  assert.equal(key1.counters[0]!.candidateLimit, 4)
  assert.equal(key1.counters[0]!.softCeiling, 5)
  assert.equal(key1.counters[0]!.inference.estimatedLimit, 4)
  // And simply not read: no caution, no demotion.
  assert.notEqual(key1.counters[0]!.state, 'near-limit')
  assert.equal(key1.score, perResource.find((entry) => entry.resourceId === 'key-2')!.score)
})

test('acceptance 52: one event, one observation, and both engines read the same one', () => {
  // The whole point of Faz-A: the legacy sampler and the shadow ledger used to
  // read the ledgers on their own schedule, which is how a level got read
  // before the charge that produced it. Now there is one record, and both
  // engines consume it — here verified end to end against numbers only they
  // know.
  const engine = buildTwoKeyEngine()
  const at = (minute: number, second: number) =>
    `2026-08-23T11:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`

  engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: at(0, 5) })

  const result = engine.settle({
    resourceId: 'key-1',
    kind: 'rate-limit',
    settledAt: at(0, 40),
    rateLimit: { blamedCounterIds: ['rpm'] },
  })
  const observation = result.observation!

  assert.ok(observation != null, 'the settlement reports what the engine saw')
  assert.ok(Object.isFrozen(observation), 'and it is the frozen record, not a copy of it')
  assert.equal(observation.kind, 'rate-limit')
  assert.equal(observation.resourceId, 'key-1')
  assert.equal(observation.settledAt, at(0, 40))

  const rpm = counterFrom(observation, 'rpm')!

  // One accepted request at the single-read instant, then the refused attempt:
  // the level the provider refused at is 2, which is what the shadow pin is
  // bracket-derived from and what the legacy sampler recorded.
  assert.equal(rpm.usage, 1)
  assert.equal(rpm.attempted, 2)
  assert.equal(rpm.charge, 1)
  assert.equal(observation.rejection!.reportedCounterId, 'rpm')
  assert.equal(observation.rejection!.rejectedCounterId, null)

  // Legacy side: the sample carries exactly the observation's numbers.
  const estimate = engine.getResourceRuntime('key-1')!.estimates.rpm!
  const sample = estimate.samples[0]!

  assert.equal(sample.observedValue, rpm.usage)
  assert.equal(sample.attemptedValue, rpm.attempted)
  assert.equal(sample.windowKey, rpm.windowKey)
  assert.equal(sample.occurredAt, observation.settledAt)

  // Shadow side: the pin is the observation's bracket, nothing else.
  const report = result.attribution!.hypotheses!
  const proof = report.proofs.find((entry) => entry.counterId === 'rpm')!

  assert.equal(report.verdicts.rpm, 'proven')
  assert.equal(proof.ceiling, rpm.attempted - 1)

  // And the view agrees with the ledger it is a projection of.
  const knowledge = engine.getQuotaKnowledge('key-1')!

  assert.equal(knowledge.find((entry) => entry.counterId === 'rpm')!.ceiling, proof.ceiling)
})

test('acceptance 53: normalizeObservation is pure, total, and names its own gaps', () => {
  // Unit-level: the builder touches no clock and no ledger, so it can be
  // exercised directly — including the two caller-words that must survive
  // normalization untouched (a charge fact and a scope claim are different).
  const specs: ResourceSpec[] = [
    {
      resourceId: 'key-1',
      counters: [
        { counterId: 'rpm', kind: 'window', unit: 'count', window: { windowMs: 60_000, alignment: 'fixed' } },
        { counterId: 'rph', kind: 'window', unit: 'count', window: { windowMs: 3_600_000, alignment: 'fixed' } },
        // A gauge is instantaneous state, not a window level: no observation
        // carries one, so a caller can never read a gauge off this record.
        { counterId: 'inflight', kind: 'gauge', unit: 'count', limit: 8 },
      ],
    },
  ]

  const readings = new Map<string, CounterReading>([
    ['rpm', { level: 3, windowKey: 'fixed:60000:1' }],
    ['rph', { level: 20, windowKey: 'fixed:3600000:1' }],
  ])

  const input: OutcomeInput = {
    resourceId: 'key-1',
    kind: 'rate-limit',
    settledAt: '2026-08-23T11:00:40.000Z',
    usage: { operations: 2, trafficShape: 'burst' },
    rateLimit: {
      blamedCounterIds: ['rpm'],
      rejectedCounterId: 'rph',
      rejectedCharge: 7,
      retryAfterSeconds: 30,
      providerResetAt: '2026-08-23T12:00:00.000Z',
      limitScope: 'quota-group',
    },
  }

  const built = normalizeObservation(input, specs[0]!.counters, readings, input.settledAt as string)

  // Deterministic: the same words and the same read give the same record.
  assert.deepEqual(normalizeObservation(input, specs[0]!.counters, readings, input.settledAt as string), built)

  assert.equal(built.counters.length, 2, 'only window counters with a reading are carried')
  assert.equal(counterFrom(built, 'inflight'), null)
  assert.equal(built.operations, 2)
  assert.equal(built.trafficShape, 'burst')

  const rpm = counterFrom(built, 'rpm')!
  const rph = counterFrom(built, 'rph')!

  // `usage + charge` for every counter — the rejected charge lands on the
  // counter the CALLER named in `rejectedCounterId`, not on the one the
  // provider blamed. Conflating those two is exactly the bug this split names.
  assert.equal(rpm.usage, 3)
  assert.equal(rpm.attempted, 5, 'two operations at one unit each')
  assert.equal(rpm.charge, 2)
  assert.equal(rph.usage, 20)
  assert.equal(rph.attempted, 27, 'the caller-supplied charge, not the request size')

  assert.equal(built.rejection!.rejectedCounterId, 'rph')
  assert.equal(built.rejection!.reportedCounterId, 'rpm')
  assert.deepEqual([...built.rejection!.blamedCounterIds!], ['rpm'])
  assert.equal(built.rejection!.rejectedCharge, 7)
  assert.equal(built.rejection!.retryAfterSeconds, 30)
  assert.equal(built.rejection!.providerResetAt, '2026-08-23T12:00:00.000Z')
  assert.equal(built.rejection!.limitScope, 'quota-group')

  // A non-rejection carries no rejection facts at all, rather than empty ones.
  const plain = normalizeObservation(
    { resourceId: 'key-1', kind: 'success', settledAt: '2026-08-23T11:00:05.000Z' },
    specs[0]!.counters,
    readings,
    '2026-08-23T11:00:05.000Z',
  )

  assert.equal(plain.rejection, null)
  assert.equal(counterFrom(plain, 'rpm')!.attempted, 4, 'one operation by default')
})

test('acceptance 54: a replayed event id settles nothing the second time', () => {
  // Idempotency, and the contract it preserves: without an eventId every call
  // is an event, exactly as before. With one, a retry after an ambiguous
  // timeout charges once and learns once.
  const replay = new AdaptiveThrottleEngine(null, { mode: 'smart' })
  replay.register([buildWindowedResource('key-1'), buildWindowedResource('key-2')])

  const sent = { resourceId: 'key-1', kind: 'success' as const, settledAt: '2026-08-23T11:00:05.000Z', eventId: 'op-1' }
  const first = replay.settle(sent)
  const second = replay.settle(sent)

  assert.equal(second.replay, true)
  assert.equal(second.observation, null, 'nothing was observed, so nothing is reported')
  assert.equal(second.attribution, null)
  assert.ok(first.observation != null, 'the first settlement is the real one')

  const charged = replay
    .decide({ now: '2026-08-23T11:00:30.000Z' })
    .perResource.find((entry) => entry.resourceId === 'key-1')!
    .counters.find((counter) => counter.counterId === 'rpm')!.level

  assert.equal(charged, 1, 'the replay did not charge the window twice')

  // And the shadow ledger holds one clause for one refusal, not two.
  const refusal = {
    resourceId: 'key-1',
    kind: 'rate-limit' as const,
    settledAt: '2026-08-23T11:00:40.000Z',
    eventId: 'op-2',
  }

  replay.settle(refusal)
  const replayed = replay.settle(refusal)

  assert.equal(replayed.replay, true)
  assert.equal(
    replay.settle({ resourceId: 'key-1', kind: 'rate-limit', settledAt: '2026-08-23T11:00:50.000Z' })
      .attribution!.hypotheses!.clauses.length,
    2,
    'two distinct refusals are still two clauses; the replay was not one',
  )

  // The preserved contract: no eventId, no memory.
  const blind = new AdaptiveThrottleEngine(null, { mode: 'smart' })
  blind.register([buildWindowedResource('key-1'), buildWindowedResource('key-2')])

  blind.settle({ resourceId: 'key-1', kind: 'success', settledAt: '2026-08-23T11:00:05.000Z' })
  blind.settle({ resourceId: 'key-1', kind: 'success', settledAt: '2026-08-23T11:00:05.000Z' })

  const doubled = blind
    .decide({ now: '2026-08-23T11:00:30.000Z' })
    .perResource.find((entry) => entry.resourceId === 'key-1')!
    .counters.find((counter) => counter.counterId === 'rpm')!.level

  assert.equal(doubled, 2, 'without an eventId the old behaviour holds: every call is an event')
})

test('acceptance 55: later evidence pins the view, and a quota move withdraws the pin', () => {
  // The retroactive half of Faz-A: a bound is only as good as the clauses
  // behind it, so the view must follow the evidence as it changes — including
  // losing a pin the moment traffic proves the quota moved.
  const engine = buildTwoKeyEngine()
  const at = (minute: number, second: number) =>
    `2026-08-23T11:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`

  engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: at(0, 5) })
  engine.settle({ resourceId: 'key-1', kind: 'rate-limit', settledAt: at(0, 40) })

  const unresolved = engine.getQuotaKnowledge('key-1')!.find((entry) => entry.counterId === 'rpm')!

  assert.equal(unresolved.verdict, 'unresolved')
  assert.equal(unresolved.ceiling, null)
  assert.equal(unresolved.contract, 'unresolved')
  assert.ok(unresolved.standing.length > 0, 'silence without a reason cannot be acted on')

  // The provider names the counter. The minute carries one accepted request
  // first — otherwise the named bound would land on empty traffic and refute
  // itself — so the pin lands exactly on proven usage.
  engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: at(1, 5) })
  engine.settle({
    resourceId: 'key-1',
    kind: 'rate-limit',
    settledAt: at(1, 40),
    rateLimit: { blamedCounterIds: ['rpm'] },
  })

  const pinned = engine.getQuotaKnowledge('key-1')!.find((entry) => entry.counterId === 'rpm')!

  assert.equal(pinned.contract, 'observedBoundary')
  assert.equal(pinned.verdict, 'proven')
  assert.equal(pinned.ceiling, 1)
  assert.equal(pinned.provenLowerBound, 1)
  assert.ok(pinned.proofIds.length > 0, 'the pin names the clauses it derives from')
  assert.ok(pinned.assumptions.some((assumption) => assumption.includes('reported')))
  assert.ok(pinned.firstProvenAt != null)
  assert.equal(pinned.ledgerScope, 'session')

  // Now the contradiction: traffic is accepted ABOVE the pinned value, so the
  // quota demonstrably moved and the old pin is withdrawn — not revised, not
  // quietly kept. The view must show nothing claimed rather than a stale number.
  for (const second of [5, 10]) {
    engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: `2026-08-23T11:02:${String(second).padStart(2, '0')}.000Z` })
  }

  const withdrawn = engine.getQuotaKnowledge('key-1')!.find((entry) => entry.counterId === 'rpm')!

  assert.equal(withdrawn.ceiling, null)
  assert.equal(withdrawn.contract, 'unresolved')
  assert.equal(withdrawn.regimeChanges, 1)
  assert.equal(withdrawn.regimeId, 'r1')
  assert.equal(withdrawn.upperBound, null, 'a bound from a superseded regime is not evidence for this one')
  assert.match(withdrawn.standing, /accepted above the previously pinned value/)
})

test('acceptance 56: a restore drops the ledger, so the view is absent and says so', () => {
  // Session scope, end to end. The knowledge view must not survive a restart:
  // the ledger it projects did not, and implying otherwise would present
  // evidence that no longer exists.
  const engine = buildTwoKeyEngine()

  engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: '2026-08-23T11:00:05.000Z' })
  engine.settle({
    resourceId: 'key-1',
    kind: 'rate-limit',
    settledAt: '2026-08-23T11:00:40.000Z',
    rateLimit: { blamedCounterIds: ['rpm'] },
  })

  assert.ok(engine.getQuotaKnowledge('key-1') != null, 'the ledger exists, so the view is readable')

  const restored = new AdaptiveThrottleEngine(JSON.parse(JSON.stringify(engine.getSnapshot())))
  restored.register([buildWindowedResource('key-1'), buildWindowedResource('key-2')])

  assert.equal(restored.getQuotaKnowledge('key-1'), null, 'no ledger survived, so none is claimed')
  assert.equal(restored.getQuotaKnowledge('never-seen'), null, 'and an unobserved resource reports nothing')

  // The legacy reading does survive, because it lives in the snapshot.
  const after = restored
    .decide({ now: '2026-08-23T11:00:50.000Z' })
    .perResource.find((entry) => entry.resourceId === 'key-1')!
    .counters.find((counter) => counter.counterId === 'rpm')!

  assert.equal(after.boundary, null)
  assert.equal(after.contract, 'legacyEstimate')
  assert.equal(after.limit, null)
})

test('acceptance 57: the view never claims a quota, and telemetry keeps its authority', () => {
  // Two ownership rules in one: from the ledger alone only `observedBoundary`
  // and `unresolved` are reachable — `modelProven` and `authoritative` are not
  // derivations — and a ceiling the provider stated stays the telemetry's to
  // report, not the ledger's.
  const engine = buildTwoKeyEngine()

  engine.settle({
    resourceId: 'key-1',
    kind: 'success',
    settledAt: '2026-08-23T11:00:10.000Z',
    provider: { source: 'headers', counters: [{ counterId: 'rph', limit: 28 }] },
  })
  engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: '2026-08-23T11:00:20.000Z' })
  engine.settle({
    resourceId: 'key-1',
    kind: 'rate-limit',
    settledAt: '2026-08-23T11:00:40.000Z',
    rateLimit: { blamedCounterIds: ['rpm'] },
  })

  for (const entry of engine.getQuotaKnowledge('key-1')!) {
    assert.notEqual(entry.contract, 'modelProven', 'nothing promotes a derivation into a quota claim')
    assert.notEqual(entry.contract, 'authoritative', 'a stated ceiling belongs to telemetry, not the ledger')
    assert.equal(entry.ceiling != null, entry.contract === 'observedBoundary')
    assert.equal(entry.quotaScope, 'resource', 'no shared pools are declared, so none may be claimed')
    assert.ok(entry.standing.length > 0)
  }

  // Read-only by construction: the projection is frozen, so a caller cannot
  // corrupt what a later read reports.
  const view = engine.getQuotaKnowledge('key-1')!
  assert.ok(Object.isFrozen(view))
  assert.ok(Object.isFrozen(view[0]))

  const advice = engine.decide({ now: '2026-08-23T11:00:50.000Z' })
  const perResource = advice.perResource.find((entry) => entry.resourceId === 'key-1')!
  const rph = perResource.counters.find((counter) => counter.counterId === 'rph')!
  const rpm = perResource.counters.find((counter) => counter.counterId === 'rpm')!

  // The provider's number keeps its old behavior exactly.
  assert.equal(rph.contract, 'authoritative')
  assert.equal(rph.limit, 28)
  assert.equal(rph.limitSource, 'provider')
  // The shadow's pin is an observed boundary and only that — and it is a
  // different number from the one routing steers on, which is the point: the
  // steering input stays the legacy candidate plus tolerance, and the shadow's
  // bracket never becomes it.
  //
  // Note the two numbers are not the same, and why: the provider blamed `rpm`
  // (`blamedCounterIds`) but the caller named no rejected charge
  // (`rejectedCounterId`), so the legacy sampler recorded the level it actually
  // saw — 2 — while the shadow kept the refused attempt whole — 3. Blame alone
  // is not a charge fact, and the legacy engine must not treat it as one.
  assert.equal(rpm.contract, 'observedBoundary')
  assert.equal(rpm.limit, null)
  assert.equal(rpm.boundary!.verdict, 'proven')
  assert.equal(rpm.boundary!.ceiling, 2)
  assert.equal(rpm.candidateLimit, 2)
  assert.equal(rpm.softCeiling, 3)
  assert.notEqual(rpm.softCeiling, rpm.boundary!.ceiling)
})

test('acceptance 58: a scripted run yields the same advice before and after the refactor', () => {
  // The "zero change" gate, pinned to numbers rather than to a snapshot of a
  // previous build: a mixed script of successes, refusals and typed failures
  // through both modes, with the exact advice the engine must still produce.
  const scripted = () => {
    const engine = new AdaptiveThrottleEngine(null, { mode: 'smart' })
    engine.register([buildWindowedResource('key-1'), buildWindowedResource('key-2')])

    const at = (minute: number, second: number) =>
      `2026-08-23T11:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`

    engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: at(0, 5) })
    engine.settle({ resourceId: 'key-1', kind: 'success', settledAt: at(0, 15) })
    engine.settle({ resourceId: 'key-1', kind: 'rate-limit', settledAt: at(0, 40), detail: 'too many requests' })
    engine.settle({ resourceId: 'key-1', kind: 'transport-failure', settledAt: at(1, 10), detail: 'econnreset' })
    engine.settle({ resourceId: 'key-2', kind: 'success', settledAt: at(1, 20) })

    const aggressive = new AdaptiveThrottleEngine(null, { mode: 'aggressive' })
    aggressive.register([buildWindowedResource('key-1'), buildWindowedResource('key-2')])

    aggressive.settle({ resourceId: 'key-1', kind: 'success', settledAt: at(0, 5) })
    aggressive.settle({ resourceId: 'key-1', kind: 'rate-limit', settledAt: at(0, 40) })

    return [engine, aggressive].map((subject) => {
      const { advice, perResource } = subject.decide({ now: at(2, 0) })

      return {
        decision: advice.decision,
        resourceId: advice.resourceId,
        speculative: advice.speculative,
        reason: advice.reason,
        perResource: perResource.map((entry) => ({
          resourceId: entry.resourceId,
          decision: entry.decision,
          score: entry.score,
          reason: entry.reason,
          counters: entry.counters.map((counter) => ({
            counterId: counter.counterId,
            level: counter.level,
            state: counter.state,
            limit: counter.limit,
            contract: counter.contract,
            candidateLimit: counter.candidateLimit,
            softCeiling: counter.softCeiling,
            blocking: counter.blocking,
          })),
        })),
      }
    })
  }

  // Deterministic across builds: the same script, the same advice.
  assert.deepEqual(scripted(), scripted(), 'Faz-A must not move a single decision')

  const [smart, aggressive] = scripted() as Array<{
    decision: string
    resourceId: string
    speculative: boolean
    perResource: Array<{ resourceId: string; decision: string; counters: Array<{ counterId: string; level: number; contract: string; blocking: boolean }> }>
  }>

  // And hand-checked, so a change to either engine shows up here rather than
  // only in the equality with itself. The minute window has rolled by the time
  // of this decision, so rpm reads 0 and the day counter still reads the two
  // charges it took.
  const smartKey1 = smart.perResource.find((entry) => entry.resourceId === 'key-1')!
  const aggressiveKey1 = aggressive.perResource.find((entry) => entry.resourceId === 'key-1')!
  const smartRpm = smartKey1.counters.find((counter) => counter.counterId === 'rpm')!
  const smartRpd = smartKey1.counters.find((counter) => counter.counterId === 'rpd')!

  assert.equal(smart.resourceId, 'key-2', 'the failed key loses to the healthy one')
  assert.equal(smartRpm.level, 0, 'the minute rolled, so nothing is still charged to it')
  assert.equal(smartRpd.level, 2, 'the day counter still holds both charges')
  assert.equal(smartRpm.contract, 'legacyEstimate')
  assert.equal(smartRpm.blocking, false)
  assert.equal(aggressiveKey1.decision, 'send-cautious', 'aggressive ranks the failed key behind, never withholds it')
  assert.equal(aggressive.resourceId, 'key-2')
})

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

test('unit: a day bucket follows the declared zone instead of assuming UTC midnight', () => {
  const instant = Date.parse('2026-08-23T02:00:00.000Z')

  assert.equal(resolveDayBucket(instant, 'UTC'), '2026-08-23')
  assert.equal(resolveDayBucket(instant, 'Europe/Istanbul'), '2026-08-23')
  // 02:00Z is 22:00 the previous day in New York.
  assert.equal(resolveDayBucket(instant, 'America/New_York'), '2026-08-22')
  assert.equal(resolveDayStart(instant, 'America/New_York'), Date.parse('2026-08-22T04:00:00.000Z'))
  assert.equal(resolveNextDayBoundary(instant, 'America/New_York'), Date.parse('2026-08-23T04:00:00.000Z'))
})

test('unit: an unusable timezone falls back to UTC rather than throwing', () => {
  const instant = Date.parse('2026-08-23T02:00:00.000Z')

  assert.equal(resolveDayBucket(instant, 'Mars/Olympus'), '2026-08-23')
  assert.equal(resolveDayBucket(instant, null), '2026-08-23')
})

test('unit: tolerance follows the declared unit, not a fixed token floor', () => {
  const rpm = { counterId: 'rpm', unit: 'count', window: { windowMs: 60_000 } }
  const spend = { counterId: 'spend', unit: 'cost-usd', window: { windowMs: DAY_MS } }

  assert.equal(resolveTolerance(rpm, 10), 1)
  assert.equal(resolveTolerance(rpm, 400), 40)

  // A fractional unit with no declared floor falls back to the 10% band alone.
  assert.equal(resolveTolerance(spend, 0.5), 0.05)

  const declaredFloor = { ...spend, tolerance: { floor: 0.01 } }
  assert.equal(resolveTolerance(declaredFloor, 0.5), 0.05)

  // Turning the ratio off leaves the declared floor as the whole band, which is
  // how a caller demands exact agreement rather than "roughly the same limit".
  const exact = { ...spend, tolerance: { ratio: 0, floor: 0.01 } }
  assert.equal(resolveTolerance(exact, 0.5), 0.01)
})

test('unit: the attribution threshold is a declared constant, not a magic number', () => {
  assert.ok(ATTRIBUTION_MIN_CONFIDENCE > 0 && ATTRIBUTION_MIN_CONFIDENCE < 1)
})
