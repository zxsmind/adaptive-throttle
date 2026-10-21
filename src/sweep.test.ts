import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AdaptiveThrottleEngine } from './index.js'
import type { ResourceSpec } from './index.js'

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 3_600 * SECOND
const DAY = 86_400 * SECOND
const FROM = Date.parse('2026-08-23T00:01:42.004Z')
const TO = Date.parse('2026-08-23T05:34:11.084Z')

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
  chatty: boolean
}

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

  send(resourceId: string, atMs: number) {
    const truth = this.keys.find((entry) => entry.resourceId === resourceId)!
    const windows = [MINUTE, HOUR, DAY]
    const ceilings = [truth.rpm, truth.rph, truth.rpd]
    const counters = this.countersFor(resourceId)
    let full = false

    for (let index = 0; index < 3; index += 1) {
      const at = index * 3
      const bucket = Math.floor(atMs / windows[index]!)

      if (counters[at] !== bucket) {
        counters[at] = bucket
        counters[at + 1] = 0
        counters[at + 2] = 0
      }

      if (counters[at + 2] >= ceilings[index]) {
        full = true
      }
    }

    if (full) {
      return false
    }

    for (let index = 0; index < 3; index += 1) {
      counters[index * 3 + 2] = counters[index * 3 + 2]! + 1
    }

    return true
  }

  telemetry(resourceId: string, atMs: number) {
    const truth = this.keys.find((entry) => entry.resourceId === resourceId)!
    const windows = [MINUTE, HOUR, DAY]
    const ceilings = [truth.rpm, truth.rph, truth.rpd]
    const counters = this.countersFor(resourceId)

    return {
      source: 'ratelimit-headers',
      counters: ['rpm', 'rph', 'rpd'].map((counterId, index) => ({
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

function* arrivals(random: () => number, fromMs: number, toMs: number, ratePerSecond: number) {
  let at = fromMs

  for (;;) {
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

function run(keys: readonly KeyTruth[], seed: number, rate: number, useEngine: boolean) {
  const provider = new FakeProvider(keys)
  const engine = new AdaptiveThrottleEngine(null, { mode: 'smart' })
  engine.register(specsFor(keys))
  const usage = new Map<string, number>(keys.map((key) => [key.resourceId, 0]))
  const random = mulberry32(seed)
  const reasons = new Map<string, number>()
  let cursor = 0
  let accepted = 0
  let sent = 0
  let offered = 0
  let deferred = 0
  let lastProgressAt = FROM

  for (const atMs of arrivals(random, FROM, TO, rate)) {
    offered += 1
    const now = new Date(atMs).toISOString()
    let target: string | null = null

    if (useEngine) {
      const { advice } = engine.decide({ now })

      if (advice.action.type === 'proceed' || advice.action.type === 'proceed-cautious') {
        target = advice.resourceId
      } else {
        deferred += 1
        reasons.set(advice.reason, (reasons.get(advice.reason) ?? 0) + 1)
      }
    } else {
      target = keys[cursor % keys.length]!.resourceId
      cursor += 1
    }

    if (target == null) {
      continue
    }

    const ok = provider.send(target, atMs)
    sent += 1

    if (ok) {
      accepted += 1
      usage.set(target, usage.get(target)! + 1)
      lastProgressAt = atMs
      engine.settle({
        resourceId: target,
        kind: 'success',
        settledAt: now,
        ...(keys.find((entry) => entry.resourceId === target)!.chatty
          ? { provider: provider.telemetry(target, atMs) }
          : {}),
      })
    } else {
      engine.settle({
        resourceId: target,
        kind: 'rate-limit',
        settledAt: now,
        detail: 'too many requests',
        rateLimit: { limitScope: 'resource' },
      })
    }
  }

  return { offered, sent, accepted, deferred, reasons, lastProgressAt, engine, usage }
}

const UNIFORM: KeyTruth[] = [
  { resourceId: 'key-1', rpm: 4, rph: 28, rpd: 245, chatty: false },
  { resourceId: 'key-2', rpm: 4, rph: 28, rpd: 245, chatty: false },
  { resourceId: 'key-3', rpm: 4, rph: 28, rpd: 245, chatty: false },
]

const MIXED: KeyTruth[] = [
  { resourceId: 'free-1', rpm: 4, rph: 28, rpd: 245, chatty: false },
  { resourceId: 'free-2', rpm: 4, rph: 28, rpd: 245, chatty: false },
  { resourceId: 'pro-1', rpm: 60, rph: 600, rpd: 6000, chatty: true },
  { resourceId: 'pro-2', rpm: 60, rph: 600, rpd: 6000, chatty: true },
]

const HOURS = (TO - FROM) / HOUR

function capacityPerHour(keys: readonly KeyTruth[]): number {
  return keys.reduce((total, key) => total + key.rph, 0)
}

function sweep(name: string, keys: readonly KeyTruth[]) {
  console.log(`\n=== ${name} — ${keys.length} keys, ${capacityPerHour(keys)} requests/hour of capacity ===`)

  for (const fraction of [0.6, 1.2, 3.0]) {
    const rate = (capacityPerHour(keys) * fraction) / 3600
    let controlAccepted = 0
    let engineAccepted = 0
    let sample = run(keys, 1000, rate, true)
    const seeds = 6

      for (let index = 0; index < seeds; index += 1) {
        const seed = 1000 + index * 7919
        controlAccepted += run(keys, seed, rate, false).accepted
        const result = run(keys, seed, rate, true)
        engineAccepted += result.accepted
        sample = result
      }

      const offeredPerRun = run(keys, 1000, rate, false).offered
      const ratio = engineAccepted / Math.max(1, controlAccepted)

      console.log(
        `  load ${fraction.toFixed(1)}x capacity  offered~${offeredPerRun}` +
          `  round-robin ${(controlAccepted / seeds).toFixed(0).padStart(5)}` +
          `  engine ${(engineAccepted / seeds).toFixed(0).padStart(5)}` +
          `  ratio ${ratio.toFixed(2)}  ${ratio >= 1 ? 'ENGINE WINS' : ''}`,
      )

      if (fraction === 1.2 && keys === MIXED) {
        console.log(`      deferred ${sample.deferred} of ${sample.offered} offered`)

        for (const [reason, count] of [...sample.reasons].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
          console.log(`      ${count}x ${reason}`)
        }

        for (const key of MIXED) {
          const usage = sample.usage!.get(key.resourceId) ?? 0
          const runtime = sample.engine!.getResourceRuntime(key.resourceId)!
          const telemetry = runtime.providerTelemetry.rph
          const cooldowns = runtime.cooldowns

          console.log(
            `      ${key.resourceId}: accepted ${usage}` +
              `  cooldowns=${cooldowns.length}` +
              (cooldowns[0] != null ? ` until ${cooldowns[0]!.blockedUntil} (${cooldowns[0]!.source})` : '') +
              `  telemetry.rph=${telemetry == null ? 'none' : `limit=${telemetry.limit} remaining=${telemetry.remaining} resetAt=${telemetry.resetAt}`}`,
          )
        }

        const final = sample.engine!.decide({ now: new Date(TO).toISOString() })

        for (const entry of final.perResource) {
          console.log(`      final ${entry.resourceId}: ${entry.decision}  ${entry.reason}`)
        }
      }
    }
}

test('diagnostic: load sweep', () => {
  sweep('uniform keys (rpm 4 / rph 28 / rpd 245 each)', UNIFORM)
  sweep('mixed tiers (2 free silent, 2 pro chatty)', MIXED)

  // The collapse this file was written to catch: provider telemetry whose reset
  // time had passed was still believed, so two healthy keys were refused for the
  // last four hours of every run. If the engine ever loses to round-robin on the
  // mixed tiers again, this is the first place to look.
  const seeds = 6
  let controlAccepted = 0
  let engineAccepted = 0

  for (let index = 0; index < seeds; index += 1) {
    const seed = 4242 + index * 7919
    controlAccepted += run(MIXED, seed, 0.4, false).accepted
    engineAccepted += run(MIXED, seed, 0.4, true).accepted
  }

  console.log('')
  assert.ok(
    engineAccepted > controlAccepted,
    `engine ${engineAccepted} vs round-robin ${controlAccepted} on mixed tiers under scarcity`,
  )
})
