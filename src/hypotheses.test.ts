import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  clauseCandidates,
  counterInterval,
  createHypothesisLedger,
  observeAccepted,
  observeRejected,
} from './hypotheses.js'
import type { HypothesisCounter } from './hypotheses.js'

const MINUTE = 60_000
const HOUR = 3_600_000

const RPM: HypothesisCounter[] = [
  { counterId: 'rpm', windowMs: MINUTE, unit: 'count' },
]

const RPM_RPH: HypothesisCounter[] = [
  { counterId: 'rpm', windowMs: MINUTE, unit: 'count' },
  { counterId: 'rph', windowMs: HOUR, unit: 'count' },
]

const TPM: HypothesisCounter[] = [
  { counterId: 'tpm', windowMs: MINUTE, unit: 'tokens' },
]

const iso = (ms: number) => new Date(ms).toISOString()
const minuteKey = (ms: number) => `fixed:${MINUTE}:${Math.floor(ms / MINUTE) * MINUTE}`
const hourKey = (ms: number) => `fixed:${HOUR}:${Math.floor(ms / HOUR) * HOUR}`

const T0 = Date.parse('2026-08-23T11:00:05.000Z')

/** Walks `count` one-unit requests through a ledger, one window at a time. */
function accept(
  ledger: ReturnType<typeof createHypothesisLedger>,
  at: number,
  attempted: Record<string, number>,
) {
  const windowKeys: Record<string, string> = {}

  for (const counter of ledger.counters) {
    windowKeys[counter.counterId] =
      counter.windowMs === HOUR ? hourKey(at) : minuteKey(at)
  }

  return observeAccepted(ledger, { at: iso(at), attempted, windowKeys })
}

function reject(
  ledger: ReturnType<typeof createHypothesisLedger>,
  at: number,
  attempted: Record<string, number>,
  options?: {
    scope?: 'reported' | 'closed' | 'assumed' | 'open'
    reportedCounter?: string
    trafficShape?: string
  },
) {
  const windowKeys: Record<string, string> = {}

  for (const counter of ledger.counters) {
    windowKeys[counter.counterId] =
      counter.windowMs === HOUR ? hourKey(at) : minuteKey(at)
  }

  return observeRejected(ledger, {
    at: iso(at),
    attempted,
    windowKeys,
    scope: options?.scope,
    reportedCounter: options?.reportedCounter,
    trafficShape: options?.trafficShape,
  })
}

// ---------------------------------------------------------------------------
// 1 — Single counter: the positive control
// ---------------------------------------------------------------------------

test('hypotheses: one counter, four accepted and a fifth refused, pins the ceiling', () => {
  const ledger = createHypothesisLedger('key-1', RPM, { defaultScope: 'closed' })

  for (let level = 1; level <= 4; level += 1) {
    accept(ledger, T0 + level * 1_000, { rpm: level })
  }

  reject(ledger, T0 + 30_000, { rpm: 5 })

  const proof = ledger.proofs.find((entry) => entry.counterId === 'rpm')

  assert.equal(ledger.verdicts.rpm, 'boundary')
  assert.equal(proof?.ceiling, 4)
  assert.equal(proof?.fromClauses.length, 1)

  // The derivation has to be checkable by hand, not just numerically correct.
  assert.match(proof!.entailment, /accepted traffic carried rpm to 4/)
  assert.match(proof!.entailment, /only possible cause at an attempt of 5/)
  assert.match(proof!.entailment, /OBSERVED EFFECTIVE BOUNDARY/)
})

test('hypotheses: a boundary carries the traffic shapes and evidence source it rests on', () => {
  const ledger = createHypothesisLedger('key-1', RPM, { defaultScope: 'closed' })

  for (let level = 1; level <= 4; level += 1) {
    accept(ledger, T0 + level * 1_000, { rpm: level })
  }

  reject(ledger, T0 + 30_000, { rpm: 5 }, { trafficShape: 'steady-trickle' })

  const proof = ledger.proofs.find((entry) => entry.counterId === 'rpm')!

  // The number is useless without the conditions it was observed under: a quota
  // is a property of the account, and this was observed under one load only.
  assert.deepEqual(proof.shapes, ['steady-trickle'])
  assert.ok(proof.fromClauses.length >= 1, 'every clause that bound it is named')
  assert.ok(
    proof.dependsOn.includes('independentQuota (this key does not share a pool with another)'),
    'topology independence is a recorded dependency, not a silent one',
  )
  assert.ok(
    proof.dependsOn.includes('accountingVerified (a request costs what the engine was told)'),
    'charge accounting is a recorded dependency, not a silent one',
  )
  assert.ok(
    proof.dependsOn.includes('windowModelVerified (alignment and reset match the provider)'),
    'window alignment is a recorded dependency, not a silent one',
  )
  assert.match(proof.entailment, /OBSERVED EFFECTIVE BOUNDARY/)
  assert.doesNotMatch(proof.entailment, /is the quota/)
})

test('hypotheses: three independent windows corroborate one pinned ceiling', () => {
  const ledger = createHypothesisLedger('key-1', RPM, { defaultScope: 'closed' })

  for (let window = 0; window < 3; window += 1) {
    const start = T0 + window * MINUTE

    for (let level = 1; level <= 4; level += 1) {
      accept(ledger, start + level * 1_000, { rpm: level })
    }

    reject(ledger, start + 30_000, { rpm: 5 })
  }

  assert.equal(ledger.verdicts.rpm, 'boundary')
  assert.equal(ledger.proofs[0]!.ceiling, 4)
  assert.equal(ledger.proofs[0]!.windows.length, 3)
})

test('hypotheses: an assumed cause set records the assumption the proof depends on', () => {
  // Identical mathematics to the `closed` case, different epistemics. The
  // operator asserted completeness; the provider did not. The ceiling is derived,
  // so it is worth reporting — and it rests on a claim, so it must not be
  // reported as authority.
  const ledger = createHypothesisLedger('key-1', RPM, { defaultScope: 'assumed' })

  for (let level = 1; level <= 4; level += 1) {
    accept(ledger, T0 + level * 1_000, { rpm: level })
  }

  reject(ledger, T0 + 30_000, { rpm: 5 })

  const proof = ledger.proofs.find((entry) => entry.counterId === 'rpm')!

  assert.equal(ledger.verdicts.rpm, 'boundary')
  assert.equal(proof.ceiling, 4)
  assert.equal(proof.verdict, 'boundary')
  assert.ok(proof.dependsOn.some((dep) => dep.includes('causeSetComplete')))
  assert.ok(proof.dependsOn.some((dep) => dep.includes('causeSetComplete')), 'the operator claim is recorded as a dependency')
})

test('hypotheses: one assumed clause makes the whole ceiling depend on that assumption', () => {
  const ledger = createHypothesisLedger('key-1', RPM, { defaultScope: 'closed' })

  for (let level = 1; level <= 4; level += 1) {
    accept(ledger, T0 + level * 1_000, { rpm: level })
  }

  reject(ledger, T0 + 30_000, { rpm: 5 })
  // A second window, this time only asserted complete. The assumption is
  // load-bearing: drop it and the derivation loses a step.
  const start = T0 + MINUTE
  for (let level = 1; level <= 4; level += 1) {
    accept(ledger, start + level * 1_000, { rpm: level })
  }
  reject(ledger, start + 30_000, { rpm: 5 }, { scope: 'assumed' })

  assert.equal(ledger.verdicts.rpm, 'boundary')
  assert.ok(
    ledger.proofs[0]!.dependsOn.some((dep) => dep.includes('causeSetComplete')),
    'the operator claim is carried as a dependency of the whole ceiling',
  )
})

test('hypotheses: a reported cause bounds its counter and nothing else', () => {
  const ledger = createHypothesisLedger('key-1', RPM_RPH, { defaultScope: 'open' })

  for (let level = 1; level <= 4; level += 1) {
    accept(ledger, T0 + level * 1_000, { rpm: level, rph: level })
  }

  const clause = reject(
    ledger,
    T0 + 30_000,
    { rpm: 5, rph: 5 },
    { scope: 'reported', reportedCounter: 'rpm' },
  )

  // The provider named the minute, so the hour is out from the start rather than
  // by later elimination — and the named counter pins unconditionally even though
  // the ledger's default scope is open.
  assert.deepEqual(clauseCandidates(ledger, clause), ['rpm'])
  assert.equal(ledger.verdicts.rpm, 'proven')
  assert.equal(ledger.proofs[0]!.ceiling, 4)
  assert.equal(ledger.verdicts.rph, 'unresolved')
})

test('hypotheses: firstProvenAt records when the ceiling became usable', () => {
  const ledger = createHypothesisLedger('key-1', RPM, { defaultScope: 'closed' })

  for (let level = 1; level <= 4; level += 1) {
    accept(ledger, T0 + level * 1_000, { rpm: level })
  }

  assert.equal(ledger.firstProvenAt.rpm, null, 'nothing pinned before the refusal')

  reject(ledger, T0 + 30_000, { rpm: 5 })

  // A ceiling known at the end of a five-hour run is worth nothing to routing, so
  // the moment it arrived is part of the result, not a footnote.
  assert.equal(ledger.firstProvenAt.rpm, iso(T0 + 30_000))
})

test('hypotheses: the same value under two traffic shapes promotes a boundary to a quota', () => {
  // This is the whole of the `proven` contract. A quota is a property of the
  // account; an effective boundary is a property of the account and the load.
  // The only way to tell them apart from inside the evidence is whether the
  // number survives a change of load.
  const ledger = createHypothesisLedger('key-1', RPM, { defaultScope: 'closed' })

  const shapes = ['steady-2-per-minute', 'burst-6-at-once']

  for (const [index, shape] of shapes.entries()) {
    const start = T0 + index * MINUTE

    for (let level = 1; level <= 4; level += 1) {
      accept(ledger, start + level * 1_000, { rpm: level })
    }

    reject(ledger, start + 30_000, { rpm: 5 }, { trafficShape: shape })
  }

  assert.equal(ledger.verdicts.rpm, 'proven')
  assert.deepEqual(ledger.proofs[0]!.shapes.sort(), shapes.slice().sort())
  assert.match(ledger.proofs[0]!.entailment, /2 distinct traffic shapes/)
  assert.match(ledger.proofs[0]!.entailment, /is the quota, not merely this load.s boundary/)
})

test('hypotheses: a burst refusal below the proven level reopens, it does not contest', () => {
  // The hidden-burst case, and the reason shape-labeling alone does not solve it.
  // Steady traffic reaches four. Under burst load a per-second quota nobody
  // modelled holds the minute to two. The engine cannot see the second number as
  // a rival ceiling: it has already watched the minute carry four, so a refusal
  // at two is impossible for the minute, and the clause is refuted rather than
  // contested. What it proves is that the completeness claim was false.
  const ledger = createHypothesisLedger('key-1', RPM, { defaultScope: 'closed' })

  for (let level = 1; level <= 4; level += 1) {
    accept(ledger, T0 + level * 1_000, { rpm: level })
  }
  reject(ledger, T0 + 30_000, { rpm: 5 }, { trafficShape: 'steady' })

  assert.equal(ledger.verdicts.rpm, 'boundary')
  assert.equal(ledger.proofs[0]!.ceiling, 4)

  const start = T0 + MINUTE
  for (let level = 1; level <= 2; level += 1) {
    accept(ledger, start + level * 20, { rpm: level })
  }
  const burst = reject(ledger, start + 40, { rpm: 3 }, { trafficShape: 'burst' })

  assert.deepEqual(clauseCandidates(ledger, burst), [], 'the minute carried four, so it cannot refuse three')
  assert.equal(burst.scope, 'open', 'so the clause that claimed a complete set is reopened')
  assert.equal(ledger.scopeViolations, 1)

  // The steady boundary survives, because reopening is per clause: the evidence
  // refuted the burst clause's completeness claim, not the steady clause's number.
  assert.equal(ledger.verdicts.rpm, 'boundary')
  assert.equal(ledger.proofs[0]!.ceiling, 4)
})

test('hypotheses: two shapes pinning different numbers above the proven level contest', () => {
  // The one arrangement that does produce a genuine contest: both refusals sit
  // above everything accepted so far, so neither is eliminated, and the two
  // shapes disagree on the number. That disagreement is the proof that the value
  // depends on the load, which a quota cannot do.
  const ledger = createHypothesisLedger('key-1', RPM, { defaultScope: 'closed' })

  accept(ledger, T0 + 1_000, { rpm: 1 })
  reject(ledger, T0 + 2_000, { rpm: 5 }, { trafficShape: 'steady' })

  const start = T0 + MINUTE
  accept(ledger, start + 1_000, { rpm: 1 })
  reject(ledger, start + 2_000, { rpm: 3 }, { trafficShape: 'burst' })

  assert.equal(ledger.verdicts.rpm, 'contested')
  assert.equal(ledger.reasonCodes.rpm, 'contested-across-shapes')
  assert.deepEqual(ledger.proofs, [], 'no number may be claimed')

  // The tightest bound is still kept as an internal interval, because it is a
  // true statement about the worst case even though it names no quota.
  assert.equal(counterInterval(ledger, 'rpm').upper, 2)
})

test('hypotheses: an uncharacterised shape can never prove, only bound', () => {
  // A caller that cannot describe its own load has not lied, it has declined to
  // claim. That must not be read as agreement across shapes.
  const ledger = createHypothesisLedger('key-1', RPM, { defaultScope: 'closed' })

  for (const window of [0, 1, 2]) {
    const start = T0 + window * MINUTE

    for (let level = 1; level <= 4; level += 1) {
      accept(ledger, start + level * 1_000, { rpm: level })
    }

    reject(ledger, start + 30_000, { rpm: 5 })
  }

  assert.equal(ledger.verdicts.rpm, 'boundary', 'three windows, one anonymous shape')
  assert.deepEqual(ledger.proofs[0]!.shapes, ['(uncharacterised)'])
})

test('hypotheses: silence carries a reason', () => {
  const open = createHypothesisLedger('key-1', RPM, { defaultScope: 'open' })

  for (let level = 1; level <= 4; level += 1) {
    accept(open, T0 + level * 1_000, { rpm: level })
  }
  reject(open, T0 + 30_000, { rpm: 5 })

  assert.equal(open.verdicts.rpm, 'unresolved')
  assert.equal(open.reasonCodes.rpm, 'open-cause-set')

  const thin = createHypothesisLedger('key-2', RPM, { defaultScope: 'closed' })
  accept(thin, T0 + 1_000, { rpm: 1 })

  assert.equal(thin.verdicts.rpm, 'unresolved')
  assert.equal(thin.reasonCodes.rpm, 'insufficient-evidence')
})

// ---------------------------------------------------------------------------
// 2 — Two counters, one ambiguous refusal
// ---------------------------------------------------------------------------

test('hypotheses: a refusal either counter could explain produces no ceiling', () => {
  const ledger = createHypothesisLedger('key-1', RPM_RPH, { defaultScope: 'closed' })

  accept(ledger, T0 + 1_000, { rpm: 1, rph: 1 })
  const clause = reject(ledger, T0 + 2_000, { rpm: 2, rph: 2 })

  // Both are still possible causes. OR is not XOR: the engine does not pick.
  assert.deepEqual(clauseCandidates(ledger, clause).sort(), ['rph', 'rpm'])
  assert.equal(clause.resolved, false)
  assert.equal(ledger.verdicts.rpm, 'unresolved')
  assert.equal(ledger.verdicts.rph, 'unresolved')
  assert.deepEqual(ledger.proofs, [])
})

// ---------------------------------------------------------------------------
// 3 — Delayed elimination: the evidence only becomes usable later
// ---------------------------------------------------------------------------

test('hypotheses: sibling-window traffic retroactively clears the longer window', () => {
  const ledger = createHypothesisLedger('key-1', RPM_RPH, { defaultScope: 'closed' })

  // Minute 0 fills to four, so the hour carries four too.
  for (let level = 1; level <= 4; level += 1) {
    accept(ledger, T0 + level * 1_000, { rpm: level, rph: level })
  }

  // Refused at an attempt of 5 in the minute and 5 in the hour. Either could
  // explain it, so nothing is concluded.
  const clause = reject(ledger, T0 + 30_000, { rpm: 5, rph: 5 })

  assert.equal(clause.resolved, false)
  assert.deepEqual(ledger.proofs, [])

  // Traffic in a LATER minute raises the hour's proof without touching minute 0.
  // This is the only direction elimination can work: a request charges every
  // counter at once, so raising the minute's bound always raises the hour's at
  // least as far, and a clause both counters attempted at the same level can
  // never be narrowed by later traffic. Sibling windows break the tie.
  const later = T0 + MINUTE
  for (let level = 1; level <= 4; level += 1) {
    accept(ledger, later + level * 1_000, { rpm: level, rph: 4 + level })
  }

  assert.deepEqual(clauseCandidates(ledger, clause), ['rpm'])
  assert.equal(clause.soleCandidate, 'rpm')
  assert.equal(ledger.verdicts.rpm, 'boundary')
  assert.equal(ledger.proofs.find((entry) => entry.counterId === 'rpm')!.ceiling, 4)
  assert.equal(ledger.verdicts.rph, 'unresolved', 'the hour has no surviving bound')
})

test('hypotheses: a shared attempt level cannot be separated by later traffic at all', () => {
  // The structural limit of the above, stated as its own case: because one
  // request charges every counter, the hour's proof dominates the minute's, so
  // raising the minute past a shared attempt raises the hour past it too.
  const ledger = createHypothesisLedger('key-1', RPM_RPH, { defaultScope: 'closed' })

  accept(ledger, T0 + 1_000, { rpm: 1, rph: 1 })
  const clause = reject(ledger, T0 + 2_000, { rpm: 2, rph: 2 })

  for (const level of [2, 3, 4, 5]) {
    accept(ledger, T0 + level * 1_000, { rpm: level, rph: level })
  }

  assert.deepEqual(clauseCandidates(ledger, clause), [], 'both are cleared together')
  assert.deepEqual(ledger.proofs, [], 'so a same-level shared refusal bounds neither')
})

// ---------------------------------------------------------------------------
// 4 — Two causes at once
// ---------------------------------------------------------------------------

test('hypotheses: two quotas full at the same time keep both candidates', () => {
  const ledger = createHypothesisLedger('key-1', RPM_RPH, { defaultScope: 'closed' })

  // Minute at 4 of 4, hour at 28 of 28: the next request breaches both.
  for (let level = 1; level <= 4; level += 1) {
    accept(ledger, T0 + level * 1_000, { rpm: level, rph: 24 + level })
  }

  const clause = reject(ledger, T0 + 30_000, { rpm: 5, rph: 29 })

  assert.deepEqual(clauseCandidates(ledger, clause).sort(), ['rph', 'rpm'])
  assert.equal(clause.resolved, false)
  assert.deepEqual(ledger.proofs, [], 'a shared refusal bounds neither quota')
})

// ---------------------------------------------------------------------------
// 5 — unknownCause
// ---------------------------------------------------------------------------

test('hypotheses: an incomplete cause set never pins a ceiling', () => {
  // Identical evidence to test 1, minus the claim that nothing else is enforced.
  const ledger = createHypothesisLedger('key-1', RPM, { defaultScope: 'open' })

  for (let level = 1; level <= 4; level += 1) {
    accept(ledger, T0 + level * 1_000, { rpm: level })
  }

  reject(ledger, T0 + 30_000, { rpm: 5 })

  assert.equal(ledger.verdicts.rpm, 'unresolved')
  assert.deepEqual(ledger.proofs, [])
  assert.equal(
    counterInterval(ledger, 'rpm').upper,
    null,
    'an unmodelled quota may have refused it, so no bound transfers',
  )
})

test('hypotheses: a refusal every modelled counter is innocent of is refuted, not reassigned', () => {
  const ledger = createHypothesisLedger('key-1', RPM_RPH, { defaultScope: 'open' })

  accept(ledger, T0 + 1_000, { rpm: 4, rph: 28 })
  const clause = reject(ledger, T0 + 2_000, { rpm: 5, rph: 29 })

  // Both modelled counters carried the traffic already, so neither refused it.
  accept(ledger, T0 + 3_000, { rpm: 5, rph: 29 })

  assert.deepEqual(clauseCandidates(ledger, clause), [])
  assert.equal(clause.resolved, false)
  assert.deepEqual(ledger.refutedClauses, [clause.id])
  assert.deepEqual(ledger.proofs, [], 'something unmodelled refused it; no counter is blamed')
})

// ---------------------------------------------------------------------------
// 6 — Variable-unit requests
// ---------------------------------------------------------------------------

test('hypotheses: one oversized token request brackets the ceiling without naming it', () => {
  const ledger = createHypothesisLedger('key-1', TPM, { defaultScope: 'closed' })

  accept(ledger, T0 + 1_000, { tpm: 100_000 })
  reject(ledger, T0 + 2_000, { tpm: 450_000 })

  const interval = counterInterval(ledger, 'tpm')

  assert.equal(interval.lower, 100_000)
  assert.equal(interval.upper, 449_999)
  assert.equal(ledger.verdicts.tpm, 'unresolved', 'a 350k-wide gap pins nothing')
  assert.deepEqual(ledger.proofs, [])
})

test('hypotheses: a token boundary pins only once the gap closes to one unit', () => {
  const ledger = createHypothesisLedger('key-1', TPM, { defaultScope: 'closed' })

  accept(ledger, T0 + 1_000, { tpm: 250_000 })
  reject(ledger, T0 + 2_000, { tpm: 250_001 })

  assert.equal(ledger.verdicts.tpm, 'boundary')
  assert.equal(ledger.proofs[0]!.ceiling, 250_000)
})

// ---------------------------------------------------------------------------
// Gates — measured failures of the per-counter engine, replayed through a real
// provider so the observations are guaranteed physically possible.
//
// Every fixture here used to hand-feed outcomes, and the [1,1,1] one fed a
// rejection at minute level 2 against a hidden ceiling of 4 — a refusal no
// provider could ever produce. The narration ("the hour was the real culprit")
// and the conclusion ("rpm = 1") both rested on observations that cannot exist.
// Driving a provider with real ceilings makes that impossible to repeat: the
// sequence is whatever the provider actually does.
// ---------------------------------------------------------------------------

interface Ceiling {
  resourceId: string
  rpm: number
  rph: number
}

class GateProvider {
  private readonly minute = new Map<string, { bucket: number; count: number }>()
  private readonly hour = new Map<string, { bucket: number; count: number }>()

  constructor(private readonly keys: readonly Ceiling[]) {}

  private static bump(
    state: Map<string, { bucket: number; count: number }>,
    resourceId: string,
    atMs: number,
    size: number,
  ): number {
    const bucket = Math.floor(atMs / size) * size
    let entry = state.get(resourceId)

    if (entry == null || entry.bucket !== bucket) {
      entry = { bucket, count: 0 }
      state.set(resourceId, entry)
    }

    return entry.count
  }

  /** Accepts the request and returns true, or refuses it and returns false. */
  send(resourceId: string, atMs: number): boolean {
    const truth = this.keys.find((key) => key.resourceId === resourceId)!
    const minuteCount = GateProvider.bump(this.minute, resourceId, atMs, MINUTE)
    const hourCount = GateProvider.bump(this.hour, resourceId, atMs, HOUR)

    if (minuteCount >= truth.rpm || hourCount >= truth.rph) {
      return false
    }

    this.minute.get(resourceId)!.count += 1
    this.hour.get(resourceId)!.count += 1

    return true
  }

  /** What the request would have taken each counter to, accepted or not. */
  attempted(resourceId: string, atMs: number): Record<string, number> {
    return {
      rpm: GateProvider.bump(this.minute, resourceId, atMs, MINUTE) + 1,
      rph: GateProvider.bump(this.hour, resourceId, atMs, HOUR) + 1,
    }
  }

  windowKeys(resourceId: string, atMs: number): Record<string, string> {
    return {
      rpm: minuteKey(GateProvider.bump(this.minute, resourceId, atMs, MINUTE)),
      rph: hourKey(GateProvider.bump(this.hour, resourceId, atMs, HOUR)),
    }
  }
}

/**
 * The hour is the binding quota, and the minute is not.
 *
 * Hidden truth: rpm 4, rph 2. Two requests a minute, so the hour fills and the
 * minute never does.
 */
test('gate: the hour is the real limiter, and only the shadow engine says so', () => {
  const keys: Ceiling[] = [{ resourceId: 'key-1', rpm: 4, rph: 2 }]
  const provider = new GateProvider(keys)
  const shadow = createHypothesisLedger('key-1', RPM_RPH, { defaultScope: 'closed' })

  const truth = keys[0]!
  const refused: Array<{ at: number; attempted: Record<string, number> }> = []

  // Six minutes of two requests each. The provider decides; the harness records.
  for (let window = 0; window < 6; window += 1) {
    const start = T0 + window * MINUTE

    for (let index = 0; index < 2; index += 1) {
      const at = start + index * 1_000
      const attempted = provider.attempted('key-1', at)
      const accepted = provider.send('key-1', at)

      if (accepted) {
        observeAccepted(shadow, { at: iso(at), attempted, windowKeys: provider.windowKeys('key-1', at) })
      } else {
        refused.push({ at, attempted })
        observeRejected(shadow, { at: iso(at), attempted, windowKeys: provider.windowKeys('key-1', at) })
      }
    }
  }

  assert.ok(refused.length > 0, 'the hour must have refused something')

  // The shadow engine: the hour is pinned to its true ceiling, and the minute —
  // which never bound anything — is left alone rather than given a number.
  assert.equal(shadow.verdicts.rph, 'boundary')
  assert.equal(shadow.proofs.find((entry) => entry.counterId === 'rph')!.ceiling, truth.rph)
  assert.equal(shadow.verdicts.rpm, 'unresolved', 'the minute was never the limiter')
  assert.equal(shadow.scopeViolations, 0)

  // Every pinned ceiling must equal the hidden truth, not merely be internally
  // consistent. This is the assertion the old hand-fed fixture was missing.
  for (const proof of shadow.proofs) {
    assert.equal(proof.ceiling, truth[proof.counterId as 'rpm' | 'rph'])
  }
})

test('gate: a refusal either quota could explain is left unresolved, not split in two', () => {
  const keys: Ceiling[] = [{ resourceId: 'key-1', rpm: 2, rph: 2 }]
  const provider = new GateProvider(keys)
  const shadow = createHypothesisLedger('key-1', RPM_RPH, { defaultScope: 'closed' })

  const at = T0 + 1_000
  const second = T0 + 2_000

  // Both ceilings are 2, so it takes two accepted requests before the third one
  // breaches both at once.
  for (const stamp of [at, second]) {
    const attempted = provider.attempted('key-1', stamp)

    assert.equal(provider.send('key-1', stamp), true, `request at ${stamp} must be accepted`)
    observeAccepted(shadow, {
      at: iso(stamp),
      attempted,
      windowKeys: provider.windowKeys('key-1', stamp),
    })
  }

  const third = T0 + 3_000
  const thirdAttempt = provider.attempted('key-1', third)

  assert.equal(provider.send('key-1', third), false, 'the third request breaches both')
  const clause = observeRejected(shadow, {
    at: iso(third),
    attempted: thirdAttempt,
    windowKeys: provider.windowKeys('key-1', third),
  })

  // Both quotas are at their ceiling, so both explain the refusal and neither is
  // the cause to the exclusion of the other.
  assert.deepEqual(clauseCandidates(shadow, clause).sort(), ['rph', 'rpm'])
  assert.deepEqual(shadow.proofs, [], 'a shared refusal bounds neither quota')
})

test('gate: a ceiling later outgrown by traffic is a regime change, not a contradiction', () => {
  const ledger = createHypothesisLedger('key-1', RPM, { defaultScope: 'closed' })

  accept(ledger, T0 + 1_000, { rpm: 1 })
  const clause = reject(ledger, T0 + 2_000, { rpm: 2 })

  assert.equal(ledger.verdicts.rpm, 'boundary')
  assert.equal(ledger.proofs[0]!.ceiling, 1)
  assert.equal(ledger.regimeChanges.rpm, 0)

  // Traffic is then accepted above the pinned ceiling: the provider moved.
  accept(ledger, T0 + 3_000, { rpm: 4 })

  assert.equal(ledger.verdicts.rpm, 'unresolved')
  assert.equal(ledger.proofs.length, 0)
  assert.equal(clause.superseded, true)
  assert.equal(ledger.regimeChanges.rpm, 1, 'positive proof the quota moved')
  assert.equal(ledger.scopeViolations, 0, 'a moved quota is not a broken model')
  assert.equal(counterInterval(ledger, 'rpm').lower, 4, 'the newer proof stands')
})

test('gate: a false completeness claim reopens the clause and withdraws its pin', () => {
  // The safety property the global boolean could not express. A clause that
  // claimed to know the whole set, and then lost every member of it, was wrong
  // about the set being closed. Leaving its pin in place and merely counting a
  // conflict would let one bad assertion keep bounding ceilings after the
  // evidence had refuted it.
  const ledger = createHypothesisLedger('key-1', RPM, { defaultScope: 'closed' })

  accept(ledger, T0 + 1_000, { rpm: 4 })
  const clause = reject(ledger, T0 + 2_000, { rpm: 5 })

  assert.equal(clause.resolved, true)
  assert.equal(ledger.verdicts.rpm, 'boundary')
  assert.equal(ledger.proofs[0]!.ceiling, 4)

  // A refusal arrives that no modelled quota can explain: rpm already carried 4,
  // so it cannot have refused an attempt of 3. Something unmodelled did it.
  const orphan = reject(ledger, T0 + 4_000, { rpm: 3 })

  assert.deepEqual(clauseCandidates(ledger, orphan), [], 'rpm carried 4, so it cannot refuse 3')
  assert.equal(ledger.scopeViolations, 1, 'the completeness claim was false')
  assert.equal(orphan.scope, 'open', 'and the clause is reopened, not argued about')

  // The earlier pin survives, because that clause still holds on its own
  // evidence — reopening is per clause, not a blanket distrust.
  assert.equal(clause.scope, 'closed')
  assert.equal(ledger.verdicts.rpm, 'boundary')
  assert.equal(ledger.proofs[0]!.ceiling, 4)
})

test('gate: a pin is withdrawn whichever repair path fires, and each names its own cause', () => {
  // Two independent routes lead to a ceiling being pulled, and they must not be
  // confused: traffic walking past the ceiling is the provider moving
  // (`superseded`, charged to regimeChanges), while a clause losing every
  // candidate is the model having been wrong about its own completeness
  // (`reopened`, charged to scopeViolations). Both withdraw the pin. Only one of
  // them is bad news about the provider.
  const ledger = createHypothesisLedger('key-1', RPM_RPH, { defaultScope: 'closed' })

  accept(ledger, T0 + 1_000, { rpm: 4, rph: 4 })
  const clause = reject(ledger, T0 + 2_000, { rpm: 5, rph: 4 })

  // rph carried 4 already, so it is innocent; rpm is the sole survivor and pins.
  assert.deepEqual(clauseCandidates(ledger, clause), ['rpm'])
  assert.equal(ledger.verdicts.rpm, 'boundary')
  assert.equal(ledger.proofs[0]!.ceiling, 4)

  // The provider raises the quota and traffic walks past the pinned ceiling.
  accept(ledger, T0 + 3_000, { rpm: 5, rph: 5 })

  assert.equal(clause.superseded, true, 'this is a quota move, not a model error')
  assert.equal(clause.scope, 'closed', 'the completeness claim was never refuted')
  assert.equal(ledger.scopeViolations, 0)
  assert.equal(ledger.regimeChanges.rpm, 1)
  assert.equal(ledger.verdicts.rpm, 'unresolved', 'and the pin is withdrawn anyway')
  assert.deepEqual(ledger.proofs, [])
})

