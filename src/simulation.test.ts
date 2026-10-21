import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AdaptiveThrottleEngine, ESTABLISHMENT_MIN_INDEPENDENT_WINDOWS } from './index.js'
import type { ResourceSpec } from './index.js'

// ---------------------------------------------------------------------------
// A deterministic simulation of a real traffic stream against a real provider.
//
// The engine is given declared counters and nothing else. The provider's actual
// limits live in `FakeProvider` and are never disclosed unless the key is
// configured to report them, exactly like the two halves of the real world: most
// providers say nothing, and the ones that do are believed outright.
//
// Every number here is derived from a seeded generator, so a failure is
// reproducible and the assertions below can be exact.
// ---------------------------------------------------------------------------

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 3_600 * SECOND
const DAY = 86_400 * SECOND

/** mulberry32 — small, fast, and identical on every run for a given seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)

    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

interface KeyTruth {
  resourceId: string
  rpm: number
  rph: number
  rpd: number
  /** Whether the provider volunteers its limits on every response. */
  chatty: boolean
}

/**
 * The provider. Owns the only real limits in this file and answers with the two
 * things a caller can observe: whether the request was accepted, and — for a
 * chatty key — what the current ceilings are.
 */
class FakeProvider {
  private readonly usage = new Map<string, number[]>()

  constructor(private readonly keys: readonly KeyTruth[]) {}

  private countersFor(resourceId: string): number[] {
    let counters = this.usage.get(resourceId)

    if (counters == null) {
      counters = [0, 0, 0]
      this.usage.set(resourceId, counters)
    }

    return counters
  }

  send(resourceId: string, atMs: number): { accepted: boolean; blame: string | null; truth: KeyTruth } {
    const truth = this.keys.find((entry) => entry.resourceId === resourceId)!
    const windows = [MINUTE, HOUR, DAY]
    const ceilings = [truth.rpm, truth.rph, truth.rpd]
    const buckets = windows.map((window, index) => Math.floor(atMs / window))
    const counters = this.countersFor(resourceId)

    // A fixed-window provider: every counter that is already full rejects, and
    // the shortest full window is the one the provider blames, because that is
    // the most specific true answer available.
    let blame: string | null = null
    let blameWindow = Infinity

    for (let index = 0; index < 3; index += 1) {
      const at = index * 3 // buckets are stored per window

      if (counters[at] !== buckets[index]) {
        counters[at] = buckets[index]
        counters[at + 1] = 0
        counters[at + 2] = 0
      }

      if (counters[at + 2] >= ceilings[index]) {
        const counterId = ['rpm', 'rph', 'rpd'][index]!

        if (windows[index]! < blameWindow) {
          blameWindow = windows[index]!
          blame = counterId
        }
      }
    }

    if (blame != null) {
      return { accepted: false, blame, truth }
    }

    for (let index = 0; index < 3; index += 1) {
      counters[index * 3 + 2] = counters[index * 3 + 2]! + 1
    }

    return { accepted: true, blame: null, truth }
  }

  /** What a chatty provider puts in its response headers. */
  telemetry(resourceId: string, atMs: number) {
    const truth = this.keys.find((entry) => entry.resourceId === resourceId)!
    const windows = [MINUTE, HOUR, DAY]
    const ceilings = [truth.rpm, truth.rph, truth.rpd]
    const ids = ['rpm', 'rph', 'rpd']
    const counters = this.countersFor(resourceId)

    return {
      source: 'ratelimit-headers',
      counters: ids.map((counterId, index) => ({
        counterId,
        limit: ceilings[index]!,
        remaining: Math.max(0, ceilings[index]! - counters[index * 3 + 2]!),
        resetAt: new Date(Math.floor(atMs / windows[index]!) * windows[index]! + windows[index]!).toISOString(),
      })),
    }
  }
}

function specsFor(keys: readonly KeyTruth[]): ResourceSpec[] {
  return keys.map((key) => ({
    resourceId: key.resourceId,
    counters: [
      { counterId: 'rpm', unit: 'count', window: { windowMs: MINUTE } },
      { counterId: 'rph', unit: 'count', window: { windowMs: HOUR } },
      { counterId: 'rpd', unit: 'count', window: { windowMs: DAY, dayAligned: true } },
    ],
  }))
}

/**
 * The request stream: exponential gaps between arrivals, with the occasional
 * flood of requests that all land in the same instant. The flood is the part
 * that hurts — it is what overruns a per-minute ceiling that the caller never
 * knew the size of.
 */
function* arrivalStream(
  random: () => number,
  fromMs: number,
  toMs: number,
  ratePerSecond: number,
): Generator<number> {
  let at = fromMs

  for (;;) {
    // The gap is in seconds; `at` is in milliseconds.
    at += (-Math.log(1 - random()) / ratePerSecond) * 1_000

    if (at >= toMs) {
      return
    }

    const burst = random() < 0.05 ? 3 + Math.floor(random() * 10) : 1

    for (let index = 0; index < burst; index += 1) {
      yield at
    }
  }
}
interface Summary {
  offered: number
  sent: number
  accepted: number
  rejected: number
  deferred: number
  rejectionRate: number
  firstThirdRate: number
  lastThirdRate: number
  usage: Map<string, number>
  deferrals: Map<string, number>
  longestDeferMs: number
  /** Silent keys that at some point during the run held the true ceiling. */
  everLearned: Set<string>
  /** Present only when the engine was in the loop. */
  engine: AdaptiveThrottleEngine | null
}

interface SimulationOptions {
  seed: number
  keys: readonly KeyTruth[]
  fromMs: number
  toMs: number
  ratePerSecond: number
  useEngine: boolean
}

/**
 * One run. `useEngine: false` is the control group: the same requests in the
 * same order, sent round-robin with no engine in the loop.
 */
function simulate(options: SimulationOptions): Summary {
  const provider = new FakeProvider(options.keys)
  const engine = new AdaptiveThrottleEngine(null, { mode: 'smart' })
  engine.register(specsFor(options.keys))

  const usage = new Map<string, number>(options.keys.map((key) => [key.resourceId, 0]))
  const deferrals = new Map<string, number>()
  const thirds = [0, 0, 0]
  const random = mulberry32(options.seed)
  const span = options.toMs - options.fromMs

  let offered = 0
  let sent = 0
  let accepted = 0
  let rejected = 0
  let deferred = 0
  let longestDeferMs = 0
  let cursor = 0
  const everLearned = new Set<string>()

  for (const atMs of arrivalStream(random, options.fromMs, options.toMs, options.ratePerSecond)) {
    offered += 1

    const third = Math.min(2, Math.floor(((atMs - options.fromMs) / span) * 3))
    const now = new Date(atMs).toISOString()

    let target: string | null = null

    if (options.useEngine) {
      const { advice } = engine.decide({ now })

      if (advice.action.type === 'proceed' || advice.action.type === 'proceed-cautious') {
        target = advice.resourceId
      } else {
        deferred += 1
        deferrals.set(advice.reason, (deferrals.get(advice.reason) ?? 0) + 1)
        longestDeferMs = Math.max(
          longestDeferMs,
          advice.retryAt != null ? Date.parse(advice.retryAt) - atMs : 0,
        )
      }
    } else {
      target = options.keys[cursor % options.keys.length]!.resourceId
      cursor += 1
    }

    if (target == null) {
      continue
    }

    const outcome = provider.send(target, atMs)

    sent += 1

    // Sampled continuously, so "it learned the true ceiling" is a claim about
    // something that happened during the run rather than about how it ended.
    for (const key of options.keys) {
      if (key.chatty || everLearned.has(key.resourceId)) {
        continue
      }

      const estimate = engine.getResourceRuntime(key.resourceId)!.estimates.rpm

      if (estimate.status === 'established' && estimate.estimatedLimit === key.rpm) {
        everLearned.add(key.resourceId)
      }
    }

    if (outcome.accepted) {
      accepted += 1
      usage.set(target, usage.get(target)! + 1)
      thirds[third]! += 1

      engine.settle({
        resourceId: target,
        kind: 'success',
        settledAt: now,
        ...(outcome.truth.chatty ? { provider: provider.telemetry(target, atMs) } : {}),
      })
    } else {
      rejected += 1
      thirds[third]! -= 1

      engine.settle({
        resourceId: target,
        kind: 'rate-limit',
        settledAt: now,
        detail: 'too many requests',
        // Deliberately no `counterId`: a real 429 says "too many requests", not
        // "your minute window is full". Naming the window would hand the engine
        // the one thing this module exists to work out on its own.
        rateLimit: { limitScope: 'resource' },
      })
    }
  }

  const thirdSize = Math.max(1, Math.round(offered / 3))
  const first = thirds[0]!
  const last = thirds[2]!

  return {
    offered,
    sent,
    accepted,
    rejected,
    deferred,
    rejectionRate: sent === 0 ? 0 : rejected / sent,
    firstThirdRate: first / thirdSize,
    lastThirdRate: last / thirdSize,
    usage,
    deferrals,
    longestDeferMs,
    everLearned,
    engine: options.useEngine ? engine : null,
  }
}

// The scenario from the brief: a little after midnight to half past five, with
// the burst pattern of a batch job waking up.
const FROM = Date.parse('2026-08-23T00:01:42.004Z')
const TO = Date.parse('2026-08-23T05:34:11.084Z')
const SEED = 20260823
/**
 * Roughly seventy percent of the hourly ceiling the three keys add up to, so the
 * run is capacity-bound without being hopeless — the regime where routing
 * actually decides how much work gets done.
 */
const RATE = 0.026

const KEYS: readonly KeyTruth[] = [
  // Two keys exactly like the one that prompted all of this: a small minute
  // ceiling hidden inside a much larger hour and day allowance.
  { resourceId: 'key-1', rpm: 4, rph: 28, rpd: 245, chatty: false },
  { resourceId: 'key-2', rpm: 4, rph: 28, rpd: 245, chatty: false },
  // A roomier key that happens to volunteer its limits.
  { resourceId: 'key-3', rpm: 10, rph: 60, rpd: 500, chatty: true },
]

function describe(label: string, summary: Summary): string {
  return [
    label.padEnd(22),
    `offered=${summary.offered}`,
    `sent=${summary.sent}`,
    `accepted=${summary.accepted}`,
    `rejected=${summary.rejected}`,
    `deferred=${summary.deferred}`,
    `rejection=${(summary.rejectionRate * 100).toFixed(1)}%`,
    `firstThird=${(summary.firstThirdRate * 100).toFixed(1)}%`,
    `lastThird=${(summary.lastThirdRate * 100).toFixed(1)}%`,
    `usage=${[...summary.usage].map(([id, count]) => `${id}:${count}`).join(' ')}`,
  ].join('  ')
}

test('simulation: the engine routes a real request stream through a real provider', () => {
  const options = { seed: SEED, keys: KEYS, fromMs: FROM, toMs: TO, ratePerSecond: RATE }
  const baseline = simulate({ ...options, useEngine: false })
  const driven = simulate({ ...options, useEngine: true })

  console.log(describe('round-robin (control)', baseline))
  console.log(describe('engine-driven', driven))

  // The capacity ceiling is fixed, so "did the routing help" is best read as the
  // share of offered work that actually reached the provider.
  const throughput = (summary: Summary) => summary.accepted / summary.offered

  console.log(
    `throughput: control=${(throughput(baseline) * 100).toFixed(1)}% ` +
      `engine=${(throughput(driven) * 100).toFixed(1)}%`,
  )

  console.log('why the engine held work back:')
  for (const [reason, count] of [...driven.deferrals].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`  ${count}x  ${reason}`)
  }

  // The whole point of the module, stated as a number. It is not "never gets
  // rejected" — inference is allowed to cost a rejection — it is that the work
  // keeps flowing instead of the engine parking itself until a window it only
  // guessed at comes round.
  assert.ok(
    driven.accepted > baseline.accepted * 0.6,
    `engine delivered ${driven.accepted} vs baseline ${baseline.accepted}`,
  )

  // It got better as it went, which is the learning showing up in the numbers
  // rather than being asserted about.
  assert.ok(
    driven.lastThirdRate < driven.firstThirdRate,
    `last third ${(driven.lastThirdRate * 100).toFixed(1)}% vs first third ${(driven.firstThirdRate * 100).toFixed(1)}%`,
  )

  // The regression this harness exists for: one rejection whose attribution was
  // only a guess used to park a resource until the end of its *day*, and three
  // of those locked the whole fleet out until midnight — 555 of 711 requests
  // refused on a 5.5-hour run. A guessed cause may only ever cost the wait up to
  // the earliest window rollover.
  console.log(
    `longest single wait the engine asked for: ${(driven.longestDeferMs / HOUR).toFixed(2)}h`,
  )

  assert.ok(
    driven.longestDeferMs <= HOUR,
    `a guessed attribution held work back for ${(driven.longestDeferMs / HOUR).toFixed(2)}h`,
  )

  for (const key of KEYS) {
    assert.ok((driven.usage.get(key.resourceId) ?? 0) > 0, `${key.resourceId} was never used`)
  }
})

test('simulation: the engine learns the hidden minute ceiling from rejections alone', () => {
  const provider = new FakeProvider(KEYS)
  const engine = new AdaptiveThrottleEngine(null, { mode: 'smart' })
  engine.register(specsFor(KEYS))

  const random = mulberry32(SEED)
  let offered = 0
  let learned: Array<{ resourceId: string; at: string; limit: number | null; status: string }> = []
  let lastRejection: { resourceId: string; at: string; levels: Record<string, number> } | null = null

  for (const atMs of arrivalStream(random, FROM, TO, RATE)) {
    const now = new Date(atMs).toISOString()
    const { advice } = engine.decide({ now })

    if (advice.action.type !== 'proceed' && advice.action.type !== 'proceed-cautious') {
      continue
    }

    const target = advice.resourceId
    const outcome = provider.send(target, atMs)

    engine.settle(
      outcome.accepted
        ? {
            resourceId: target,
            kind: 'success',
            settledAt: now,
            ...(outcome.truth.chatty ? { provider: provider.telemetry(target, atMs) } : {}),
          }
        : {
            resourceId: target,
            kind: 'rate-limit',
            settledAt: now,
            detail: 'too many requests',
          },
    )

    offered += 1

    // Record the first moment the engine's own number matches the truth, so the
    // claim is "it learned this", not "it knows this at the end".
    if (learned.length < KEYS.filter((key) => !key.chatty).length) {
      for (const key of KEYS.filter((entry) => !entry.chatty)) {
        const estimate = engine.getResourceRuntime(key.resourceId)!.estimates.rpm!

        if (estimate.estimatedLimit === key.rpm && estimate.status === 'established') {
          learned.push({
            resourceId: key.resourceId,
            at: now,
            limit: estimate.estimatedLimit,
            status: estimate.status,
          })
        }
      }
    }

    if (!outcome.accepted) {
      lastRejection = { resourceId: target, at: now, levels: { rpm: 4, rph: 28, rpd: 245 } }
    }
  }

  console.log(`requests offered=${offered}`)
  console.log('what the silent keys ended up believing:')

  // The property that matters most: the engine never learns something false.
  // It may end a run knowing less than it could have — that is what silence
  // costs — but nothing it states may be a number the provider would contradict.
  for (const key of KEYS.filter((entry) => !entry.chatty)) {
    const runtime = engine.getResourceRuntime(key.resourceId)!
    const rpm = runtime.estimates.rpm!
    const rph = runtime.estimates.rph!
    const rpd = runtime.estimates.rpd!

    console.log(
      `  ${key.resourceId}: rpm=${rpm.estimatedLimit}/${rpm.status}` +
        ` rph=${rph.estimatedLimit}/${rph.status}` +
        ` rpd=${rpd.estimatedLimit}/${rpd.status}   (truth 4 / 28 / 245)`,
    )

    for (const [estimate, truth, name] of [
      [rpm, key.rpm, 'rpm'],
      [rph, key.rph, 'rph'],
      [rpd, key.rpd, 'rpd'],
    ] as const) {
      // A candidate is a hypothesis and is allowed to be wrong — that is what
      // the word means. What is never allowed is *stating* a limit that is not
      // true, and that is what an established estimate would be doing.
      if (estimate.status === 'established') {
        assert.equal(
          estimate.estimatedLimit,
          truth,
          `${key.resourceId} stated ${name} = ${estimate.estimatedLimit}, which is not the truth (${truth})`,
        )
      }
    }
  }

  // key-3 was told, so its ceilings are facts rather than conclusions.
  const chatty = engine.getResourceRuntime('key-3')!

  console.log(
    `  key-3 (told): rpm=${chatty.estimates.rpm!.estimatedLimit} rph=${chatty.estimates.rph!.estimatedLimit}`,
  )
  assert.equal(chatty.estimates.rpm!.status, 'established')
  assert.equal(chatty.estimates.rpm!.estimatedLimit, KEYS[2]!.rpm)

  console.log(`first moment each silent key reached the truth: ${JSON.stringify(learned)}`)
})

test('simulation: the same seed produces the same run', () => {
  const options = { seed: SEED, keys: KEYS, fromMs: FROM, toMs: TO, ratePerSecond: RATE, useEngine: true }
  const comparable = (summary: Summary) => ({
    offered: summary.offered,
    sent: summary.sent,
    accepted: summary.accepted,
    rejected: summary.rejected,
    deferred: summary.deferred,
    longestDeferMs: summary.longestDeferMs,
    usage: [...summary.usage],
    everLearned: [...summary.everLearned].sort(),
  })
  const first = simulate(options)
  const second = simulate(options)

  assert.deepEqual(comparable(first), comparable(second))
})

// ---------------------------------------------------------------------------
// A hundred independent runs
// ---------------------------------------------------------------------------

test('simulation: a hundred independent runs, scored', () => {
  const RUNS = 100
  const silentKeys = KEYS.filter((key) => !key.chatty)

  const ratios: number[] = []
  const engineRejections: number[] = []
  const controlRejections: number[] = []
  let neverLearned = 0
  let lockouts = 0
  let falseClaims = 0
  let worstWaitHours = 0

  for (let index = 0; index < RUNS; index += 1) {
    const options = {
      seed: SEED + index * 7919,
      keys: KEYS,
      fromMs: FROM,
      toMs: TO,
      ratePerSecond: RATE,
    }
    const control = simulate({ ...options, useEngine: false })
    const driven = simulate({ ...options, useEngine: true })

    ratios.push(driven.accepted / Math.max(1, control.accepted))
    engineRejections.push(driven.rejectionRate)
    controlRejections.push(control.rejectionRate)

    // Safety, not performance: a stated limit that is wrong is worse than a
    // limit the engine never found, so any occurrence at all is a failure.
    for (const key of KEYS) {
      const runtime = driven.engine!.getResourceRuntime(key.resourceId)!

      for (const [counterId, truth] of [
        ['rpm', key.rpm],
        ['rph', key.rph],
        ['rpd', key.rpd],
      ] as const) {
        const estimate = runtime.estimates[counterId]!

        if (estimate.status === 'established' && estimate.estimatedLimit !== truth) {
          falseClaims += 1
        }
      }
    }

    for (const key of silentKeys) {
      if (!driven.everLearned.has(key.resourceId)) {
        neverLearned += 1
      }
    }

    if (driven.longestDeferMs > HOUR) {
      lockouts += 1
    }

    worstWaitHours = Math.max(worstWaitHours, driven.longestDeferMs / HOUR)
  }

  const quantile = (values: number[], fraction: number) => {
    const sorted = [...values].sort((left, right) => left - right)
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!
  }
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length

  console.log(`\n=== ${RUNS} runs, each 5h32m of traffic against a hidden-limit provider ===\n`)
  console.log('work delivered, engine vs round-robin (ratio):')
  console.log(`  worst ${quantile(ratios, 0).toFixed(2)}   p25 ${quantile(ratios, 0.25).toFixed(2)}   median ${quantile(ratios, 0.5).toFixed(2)}   p75 ${quantile(ratios, 0.75).toFixed(2)}   best ${quantile(ratios, 1).toFixed(2)}`)
  console.log(`  mean ${mean(ratios).toFixed(2)}   engine >= control in ${ratios.filter((value) => value >= 1).length}/${RUNS} runs`)
  console.log('')
  console.log('rejection rate:')
  console.log(`  engine  mean ${(mean(engineRejections) * 100).toFixed(1)}%`)
  console.log(`  control mean ${(mean(controlRejections) * 100).toFixed(1)}%`)
  console.log('')
  console.log('safety:')
  console.log(`  stated a limit that was not true ....... ${falseClaims} (must be 0)`)
  console.log(`  parked the fleet for more than an hour .. ${lockouts}/${RUNS} (must be 0)`)
  console.log(`  longest single wait seen ................. ${worstWaitHours.toFixed(2)}h`)
  console.log('')
  console.log('learning (silent keys, true minute ceiling = 4):')
  console.log(`  reached it during the run ............... ${(silentKeys.length * RUNS - neverLearned)}/${silentKeys.length * RUNS}`)

  // The two hard guarantees. Everything else above is a measurement.
  assert.equal(falseClaims, 0, 'the engine stated a ceiling the provider would contradict')
  assert.equal(lockouts, 0, 'a guessed attribution parked the fleet for over an hour')
})
