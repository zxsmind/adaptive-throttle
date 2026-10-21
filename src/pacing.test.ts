import assert from 'node:assert/strict'
import test from 'node:test'
import { AdaptiveThrottleEngine } from './engine.js'
import { AdaptivePacing } from './pacing.js'

const at = 1_000_000
test('pacing: refusal episodes survive restart and stale success; fresh success rearms growth', () => {
  let pacing = new AdaptivePacing()
  pacing.configure({ mode: 'dynamic' })
  pacing.settle('A', 'rate-limit', at, at + 10)
  pacing = new AdaptivePacing(pacing.getSnapshot())
  pacing.settle('A', 'rate-limit', at + 1000, at + 1010)
  pacing.settle('A', 'success', at + 500, at + 1020)
  pacing.settle('A', 'rate-limit', at + 2000, at + 2010)
  assert.equal(pacing.getSnapshot().resources.A!.intervalMs, 1000)
  pacing.settle('A', 'success', at + 3000, at + 3010)
  pacing.settle('A', 'rate-limit', at + 4000, at + 4010)
  assert.equal(pacing.getSnapshot().resources.A!.intervalMs, 2000)
})

test('pacing: ordinary successful traffic recovers from the ceiling without extra probes', () => {
  const pacing = new AdaptivePacing({
    options: { mode: 'dynamic' },
    resources: { A: { intervalMs: 10000, lastStartedAt: at, lastFailureAt: at, successes: 0 } },
  })
  for (let i = 1; i <= 48; i++) pacing.settle('A', 'success', at + i * 10000, at + i * 10000 + 1)
  assert.ok(pacing.getSnapshot().resources.A!.intervalMs <= 2000)
  for (let i = 49; i <= 100; i++) pacing.settle('A', 'success', at + i * 10000, at + i * 10000 + 1)
  assert.equal(pacing.getSnapshot().resources.A!.intervalMs, 500)
})

function fixture(pacing: import('./pacing.js').PacingOptions = { mode: 'low' }) {
  const engine = new AdaptiveThrottleEngine(undefined, { pacing })
  engine.register([
    { resourceId: 'A', counters: [] },
    { resourceId: 'B', counters: [] },
  ])
  return engine
}

test('pacing: dispatch checks the slot synchronously and keeps keys independent', () => {
  const engine = fixture()
  assert.equal(
    engine.recordRequestStart({ resourceId: 'A', requestId: 'a1', now: at }).dispatched,
    true,
  )
  assert.equal(
    engine.recordRequestStart({ resourceId: 'A', requestId: 'a2', now: at }).dispatched,
    false,
  )
  assert.equal(
    engine.recordRequestStart({ resourceId: 'B', requestId: 'b1', now: at }).dispatched,
    true,
  )
  assert.equal(engine.planRequest({ resourceId: 'A', now: at + 100 }).waitMs, 400)
  assert.equal(
    engine.recordRequestStart({ resourceId: 'A', requestId: 'a2', now: at + 500 }).dispatched,
    true,
  )
})

test('pacing: retry, pacing and provider deadlines overlap instead of adding', () => {
  const engine = fixture()
  engine.recordRequestStart({ resourceId: 'A', requestId: 'a1', now: at })
  engine.settle({
    resourceId: 'A',
    requestId: 'a1',
    kind: 'rate-limit',
    settledAt: at + 100,
    rateLimit: { retryAfterSeconds: 2 },
  })
  const plan = engine.planRequest({ resourceId: 'A', now: at + 200, retryAt: at + 1500 })
  assert.equal(plan.notBefore, new Date(at + 2100).toISOString())
  assert.equal(plan.waitMs, 1900)
  assert.equal(
    engine.recordRequestStart({ resourceId: 'A', requestId: 'a2', now: at + 2100 }).dispatched,
    true,
  )
})

test('pacing: a long request already satisfies the custom start interval', () => {
  const engine = fixture({ mode: 'custom', intervalMs: 1000 })
  engine.recordRequestStart({ resourceId: 'A', requestId: 'a1', now: at })
  const result = engine.settle({
    resourceId: 'A',
    requestId: 'a1',
    kind: 'success',
    settledAt: at + 3000,
  })
  assert.equal(result.observation?.startedAt, new Date(at).toISOString())
  assert.equal(engine.planRequest({ resourceId: 'A', now: at + 3000 }).waitMs, 0)
})

test('pacing: late old success cannot clear a newer refusal', () => {
  const engine = fixture()
  engine.recordRequestStart({ resourceId: 'A', requestId: 'old', now: at })
  engine.recordRequestStart({ resourceId: 'A', requestId: 'new', now: at + 500 })
  engine.settle({ resourceId: 'A', requestId: 'new', kind: 'rate-limit', settledAt: at + 600 })
  engine.settle({ resourceId: 'A', requestId: 'old', kind: 'success', settledAt: at + 700 })
  assert.equal(engine.getSnapshot().pacing?.resources.A?.intervalMs, 1000)
  assert.equal(engine.getResourceRuntime('A')?.cooldowns.length, 1)
  assert.equal(engine.planRequest({ resourceId: 'A', now: at + 700 }).decision, 'wait')
})

test('pacing: deterministic growth and gradual recovery stay within profile bounds', () => {
  const engine = fixture({ mode: 'dynamic', minIntervalMs: 500, maxIntervalMs: 1500 })
  let now = at
  for (let i = 0; i < 2; i++) {
    const requestId = `failure-${i}`
    engine.recordRequestStart({ resourceId: 'A', requestId, now })
    engine.settle({ resourceId: 'A', requestId, kind: 'rate-limit', settledAt: now + 1 })
    now += 2000
  }
  assert.equal(engine.getSnapshot().pacing?.resources.A?.intervalMs, 1000)
  for (let i = 0; i < 3; i++) {
    const requestId = `success-${i}`
    engine.recordRequestStart({ resourceId: 'A', requestId, now })
    engine.settle({ resourceId: 'A', requestId, kind: 'success', settledAt: now + 1 })
    now += 2000
  }
  assert.equal(engine.getSnapshot().pacing?.resources.A?.intervalMs, 900)
})

test('pacing: snapshots retain learned intervals and last dispatch, not live reservations', () => {
  const engine = fixture()
  engine.recordRequestStart({ resourceId: 'A', requestId: 'a1', now: at })
  engine.settle({ resourceId: 'A', requestId: 'a1', kind: 'rate-limit', settledAt: at + 1 })
  const restored = new AdaptiveThrottleEngine(engine.getSnapshot())
  restored.register(engine.getRegisteredResources())
  assert.equal(restored.getSnapshot().pacing?.resources.A?.intervalMs, 1000)
  assert.equal(restored.planRequest({ resourceId: 'A', now: at + 10 }).decision, 'wait')
  assert.throws(() =>
    restored.settle({ resourceId: 'A', requestId: 'unknown', kind: 'success', settledAt: at + 20 }),
  )
})

test('pacing: replay, cancellation, and forecast reservations settle once', () => {
  const engine = fixture()
  engine.register([
    {
      resourceId: 'A',
      counters: [{ counterId: 'requests', unit: 'count', window: { windowMs: 60_000 }, limit: 20 }],
    },
  ])
  engine.recordRequestStart({ resourceId: 'A', requestId: 'a1', now: at, charges: { requests: 8 } })
  assert.throws(() =>
    engine.recordRequestStart({ resourceId: 'A', requestId: 'a1', now: at + 1000 }),
  )
  const outcome = {
    resourceId: 'A',
    requestId: 'a1',
    kind: 'success' as const,
    settledAt: at + 10,
    usage: { charges: { requests: 3 } },
  }
  engine.settle(outcome)
  assert.equal(engine.settle(outcome).replay, true)
  const reading = engine
    .decide({ now: at + 20 })
    .perResource.find((entry) => entry.resourceId === 'A')!
  assert.equal(reading.counters[0]?.level, 3)
  assert.equal(reading.reason.includes('in flight'), false)
  engine.recordRequestStart({ resourceId: 'A', requestId: 'cancel', now: at + 1000 })
  engine.settle({ resourceId: 'A', requestId: 'cancel', kind: 'released', settledAt: at + 1001 })
})

test('pacing: every active cooldown must expire and invalid configuration fails', () => {
  const engine = fixture()
  engine.settle({
    resourceId: 'A',
    kind: 'rate-limit',
    settledAt: at,
    rateLimit: { retryAfterSeconds: 2 },
  })
  engine.settle({
    resourceId: 'A',
    kind: 'rate-limit',
    settledAt: at + 1,
    rateLimit: { retryAfterSeconds: 10 },
  })
  assert.equal(
    engine.planRequest({ resourceId: 'A', now: at + 2 }).notBefore,
    new Date(at + 10001).toISOString(),
  )
  assert.throws(() => engine.configurePacing({ mode: 'custom', intervalMs: -1 }))
  assert.throws(() => engine.planRequest({ resourceId: 'A', now: 'invalid' }))
  assert.equal(engine.planRequest({ resourceId: 'missing', now: at }).decision, 'blocked')
})

test('pacing: settlement from a rolled window does not release a newer reservation', () => {
  const engine = fixture({ mode: 'off' })
  engine.register([
    {
      resourceId: 'A',
      counters: [{ counterId: 'rpm', unit: 'count', window: { windowMs: 1000 }, limit: 10 }],
    },
  ])
  engine.recordRequestStart({
    resourceId: 'A',
    requestId: 'old',
    now: at + 900,
    charges: { rpm: 4 },
  })
  engine.recordRequestStart({
    resourceId: 'A',
    requestId: 'new',
    now: at + 1100,
    charges: { rpm: 3 },
  })
  engine.settle({ resourceId: 'A', requestId: 'old', kind: 'released', settledAt: at + 1200 })
  const advice = engine.decide({
    resources: engine.getRegisteredResources().filter((item) => item.resourceId === 'A'),
    now: at + 1300,
  })
  assert.match(advice.perResource[0]!.reason, /3 in flight/)
})

test('pacing: an old success cannot clear another resource shared-quota refusal', () => {
  const engine = fixture({ mode: 'off' })
  engine.register(
    ['A', 'B'].map((resourceId) => ({ resourceId, quotaGroupId: 'account', counters: [] })),
  )
  engine.recordRequestStart({ resourceId: 'A', requestId: 'old', now: at })
  engine.recordRequestStart({ resourceId: 'B', requestId: 'new', now: at + 100 })
  engine.settle({
    resourceId: 'B',
    requestId: 'new',
    kind: 'rate-limit',
    settledAt: at + 200,
    rateLimit: { retryAfterSeconds: 10, limitScope: 'quota-group' },
  })
  engine.settle({ resourceId: 'A', requestId: 'old', kind: 'success', settledAt: at + 300 })
  assert.equal(engine.planRequest({ resourceId: 'A', now: at + 400 }).waitMs, 9800)
})
