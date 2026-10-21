/**
 * The shadow evidence engine.
 *
 * It exists because one 429 is a **disjunction**, not a set of independent
 * measurements. When a request is refused, the only thing the provider has
 * stated is that at least one of its quotas is at its ceiling:
 *
 *     429  ⟹  (rpm exceeded) ∨ (rph exceeded) ∨ (rpd exceeded) ∨ …
 *
 * Recording that single event as an upper bound on *every* counter — which is
 * what per-counter inference does — manufactures samples that never existed.
 * The measured consequence: a key's minute samples become `[1, 3, 4]` because
 * half the rejections were really the hour's, the samples never agree, and
 * nothing ever establishes. The engine reaches its true ceiling on most keys and
 * still learns nothing.
 *
 * So this module keeps the disjunction intact and only ever narrows it:
 *
 * - **Accepted traffic** proves a lower bound. If the counter demonstrably
 *   carried `n`, then `L ≥ n`, forever, for that quota.
 * - **A rejection** contributes one clause: `L_c < attempted_c` for at least one
 *   surviving `c`. It is stored, not decomposed.
 * - **Elimination** is retroactive. A clause written when rpm might have been
 *   the cause is re-read every time a later success raises rpm's proven bound
 *   past that attempt — at which point rpm provably could not have refused it.
 *   Doing this lazily is the whole point: eager propagation at the moment of the
 *   rejection throws away the evidence that only becomes usable later.
 * - **Unit propagation** fires only when exactly one candidate survives *and*
 *   the cause set is known complete. Then `proven ≤ L < attempted`, which on a
 *   discrete counter with a one-unit gap pins a single integer.
 * - **OR, never XOR.** Several quotas can be at their ceiling at once. Two
 *   surviving candidates stay two; the engine does not pick one.
 * - **`unknownCause` is preserved.** A provider may enforce a quota nobody
 *   modelled. While that door is open, a lone surviving candidate does not
 *   license a ceiling — the refusal may simply have been the unmodelled one.
 *   Some events staying unresolved is the correct output, not a failure.
 *
 * This module is a shadow: it observes and infers, and nothing routes on it. It
 * deliberately does not touch `estimates.ts`, `policy.ts`, or any decision, so
 * the two engines can be compared on identical evidence.
 */

import type { CounterUnit } from './types.js'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface HypothesisCounter {
  counterId: string
  /** The quota window this counter measures, in milliseconds. */
  windowMs: number
  unit: CounterUnit
}

/**
 * One rejection, kept as a clause rather than as per-counter bounds.
 *
 * `windowKeys` records which window each counter was in at the moment of the
 * refusal. Window identity and quota identity are different things: the minute
 * window rolls over many times while the rpm ceiling stays the same, so samples
 * from different minute windows still describe one quota — but they are
 * independent observations of it, and only independent ones corroborate.
 */
export interface RejectionClause {
  id: string
  at: string
  /** How much this refusal is evidence about. See `EvidenceScope`. */
  scope: EvidenceScope
  /** What the provider named, when `scope` is `reported`. */
  reportedCounter: string | null
  /**
   * The traffic shape this refusal arrived under, as the caller describes it —
   * a burst, a steady trickle, a batch wake-up. Optional because a caller that
   * cannot characterise its own load has not lied, it has simply declined to
   * claim: such a clause counts as one anonymous shape, which is enough to pin a
   * boundary and never enough to prove a quota.
   */
  trafficShape: string | null
  /** What the request would have taken each counter to, had it been accepted. */
  attempted: Record<string, number>
  windowKeys: Record<string, string>
  /** Counters ruled out by later proof. Grows; never shrinks. */
  eliminated: string[]
  /** True once elimination left exactly one candidate. */
  resolved: boolean
  /** The single survivor, when `resolved`. */
  soleCandidate: string | null
  /**
   * Set when the clause's own survivor was later cleared by traffic that walked
   * past the ceiling this clause pinned. That is not an innocent counter — it is
   * the provider having moved the quota, and the clause describes a regime that
   * no longer exists. Such a clause stops bounding anything, but is kept: the
   * evidence happened, and losing it silently would make the engine forget it
   * ever knew a smaller number.
   */
  superseded: boolean
}

/**
 * How much a single refusal is evidence *about*.
 *
 * This used to be one global boolean on the ledger, which made the whole engine
 * either trust its own model or say nothing at all. It is a property of the
 * event, because the provider's answer varies per refusal: sometimes it names a
 * quota, sometimes it enumerates the possibilities, and mostly it says "too many
 * requests" and nothing else.
 *
 * - `reported` — the provider named the quota. Direct, unconditional bound.
 * - `closed` — the named set of quotas is exhaustive, by the provider's own word
 *   or a documented contract. OR resolution and elimination are licensed, and a
 *   lone survivor pins outright.
 * - `assumed` — an operator declared the modelled counters complete. The same
 *   mathematics applies, so the result is reported as a *conditional* proof: the
 *   number is derived, not guessed, and the assumption it rests on travels with
 *   it.
 * - `open` — a generic 429. The evidence is kept and used to eliminate, but it
 *   can never bound anything, because an unmodelled quota explains it just as
 *   well.
 */
export type EvidenceScope = 'reported' | 'closed' | 'assumed' | 'open'

/**
 * What the evidence licenses the engine to say about one counter.
 *
 * `proven` is deliberately hard to earn. It means the number is the *provider's
 * quota*, not merely a level traffic never got past. That claim is only
 * warranted two ways: the provider named it, or the same value fell out under
 * two different traffic shapes — because a quota is a property of the account,
 * while an effective boundary is a property of the account *and* the load, and
 * only the first survives a change of load.
 *
 * `boundary` is the honest remainder: the engine has pinned a level that this
 * traffic could not exceed, and it says exactly that and no more. It is not a
 * weaker guess at the same fact — it is a different, true fact, and collapsing
 * the two is how a wrong quota gets reported as authority.
 *
 * `contested` means different traffic shapes pinned different values. That is a
 * contradiction about the quota claim, not a range to be averaged: the engine
 * has no basis to name a number at all, and says so.
 *
 * There is still no `contradictory` verdict. A clause that loses every candidate
 * is a scope violation, handled by reopening that clause; see `reopenedClauses`.
 */
export type CounterVerdict = 'proven' | 'boundary' | 'contested' | 'unresolved'

/**
 * Why a counter is `unresolved`. Silence without a reason is indistinguishable
 * from "nothing was ever going to pin here", which is exactly the ambiguity an
 * operator cannot act on.
 */
export type UnresolvedReason =
  | 'insufficient-evidence'
  | 'open-cause-set'
  | 'model-conflict'
  | 'contested-across-shapes'

/** How a ceiling was derived, in terms a reviewer can check by hand. */
export interface CeilingProof {
  counterId: string
  /** The pinned value: `proven ≤ L < attempted` leaves exactly this integer. */
  ceiling: number
  /** Clauses whose sole survivor is this counter and that supplied the bound. */
  fromClauses: string[]
  /** Independent windows those clauses came from. */
  windows: string[]
  verdict: CounterVerdict
  /**
   * The traffic shapes that produced this value. One shape means the number is
   * only known to hold under that load; two or more agreeing shapes is what
   * promotes it from an effective boundary to a quota.
   */
  shapes: string[]
  /**
   * The model assumptions this derivation rests on, named. A dependency is what
   * has to be re-examined if the assumption is later doubted — which is broader
   * than `reopen`, because reopening only reacts to a contradiction the
   * constraints themselves expose.
   */
  dependsOn: string[]
  entailment: string
}

/**
 * A resolved clause folded into a per-counter summary because the ledger was
 * full. It contributes exactly what it contributed alive — its bound, its
 * shape, and its provenance — and nothing else. Elimination state is not kept
 * because a resolved clause has, by definition, one survivor left; if later
 * proof clears even that one, the regime-change path (not the clause) carries
 * the news, and the summary for that counter is voided wholesale.
 */
export interface CompactedBound {
  upper: number
  shape: string
  clauseId: string
  at: string
  windowKey: string
  scope: EvidenceScope
}

/**
 * How many live refusal clauses a ledger may hold before it starts folding the
 * oldest resolved ones into per-counter summaries. Unresolved clauses are never
 * folded — an open hypothesis dropped is evidence destroyed, not stored — so a
 * ledger under a flood of genuinely ambiguous refusals can still exceed this.
 * That case is counted (`droppedUnresolved`), reported, and left visible rather
 * than silently absorbed, because quiet data loss is worse than a big ledger.
 */
export const MAX_LIVE_CLAUSES = 256

export interface HypothesisLedger {
  resourceId: string
  counters: HypothesisCounter[]
  /**
   * The scope given to a refusal that arrives without one attached — a generic
   * 429. It defaults to `open`, because the engine has no business assuming the
   * provider's whole quota surface is modelled until someone with the
   * documentation says so.
   */
  defaultScope: EvidenceScope
  /** Highest level accepted traffic has demonstrably carried, per counter. */
  proven: Record<string, number>
  /** Tightest `L < attempted + 1` any resolved clause allows, per counter. */
  upperBound: Record<string, number>
  clauses: RejectionClause[]
  proofs: CeilingProof[]
  verdicts: Record<string, CounterVerdict>
  /** Why a counter is `unresolved`. Silence without a reason cannot be acted on. */
  reasonCodes: Record<string, UnresolvedReason>
  /**
   * Clauses whose scope was reopened because the evidence refuted every
   * candidate they offered. A clause that claimed a closed set and then lost
   * every member of it was wrong about the set being closed, and the only sound
   * response is to treat it as `open` from then on: the pin it supported is
   * withdrawn, and the counter is free to be pinned again by a clause that still
   * holds.
   */
  reopenedClauses: string[]
  /**
   * Clauses every modelled candidate was eliminated from. When the cause set was
   * declared complete this is a genuine model conflict — the constraints are jointly
   * unsatisfiable — and it is counted as one rather than being explained away.
   */
  refutedClauses: string[]
  /**
   * How often a clause's completeness claim was refuted by its own evidence.
   * Non-zero means the operator's or provider's assertion that nothing else can
   * refuse was false, and every conditional proof resting on it is now suspect.
   */
  scopeViolations: number
  /**
   * Positive evidence that a quota moved: traffic was accepted *above* a ceiling
   * this engine had already pinned. Only that counts, because only that is
   * provable from the evidence alone. A clause losing its survivor to ordinary
   * elimination is not a regime change and is not charged here.
   */
  regimeChanges: Record<string, number>
  /**
   * Per counter, the highest ceiling ever pinned — `null` until the engine has
   * actually concluded one. Starting at 0 rather than null would make the first
   * accepted request of any counter look like the provider had moved its quota,
   * which is exactly the false positive this field exists to avoid.
   */
  pinnedCeiling: Record<string, number | null>
  /**
   * Per counter, the first instant its verdict became non-`unresolved`.
   *
   * A ceiling known at the end of a five-hour run is worth nothing to routing.
   * This is what makes "did the engine learn in time to act" a question that can
   * be asked, instead of only "did it learn".
   */
  firstProvenAt: Record<string, string | null>
  observationCount: number
  /**
   * Bounds folded out of dropped resolved clauses, per counter. Read together
   * with the live clauses on every reconcile: a ceiling pinned here is as good
   * as one pinned by a clause still on the books, and its provenance travels
   * with it. Voided wholesale the moment traffic is accepted above a pinned
   * ceiling — a summary of a dead regime is a lie with a paper trail.
   */
  compacted: Record<string, CompactedBound[]>
  /** Resolved clauses folded so far. Unresolved ones are never folded. */
  compactedClauses: number
  /**
   * Unresolved clauses dropped because even the live-clause cap was exceeded by
   * open hypotheses alone. This is evidence loss, counted rather than hidden:
   * a run that needs this number to be zero and finds otherwise has outgrown
   * the cap, not the model.
   */
  droppedUnresolved: number
}

export interface HypothesisInput {
  at: string
  /** What this request would have taken each counter to, had it been accepted. */
  attempted: Record<string, number>
  windowKeys: Record<string, string>
  /** How much this refusal is evidence about. Defaults to the ledger's scope. */
  scope?: EvidenceScope
  /** The quota the provider named, when `scope` is `reported`. */
  reportedCounter?: string | null
  /** The load this observation arrived under. See `RejectionClause.trafficShape`. */
  trafficShape?: string | null
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function createHypothesisLedger(
  resourceId: string,
  counters: readonly HypothesisCounter[],
  options?: { defaultScope?: EvidenceScope | null },
): HypothesisLedger {
  const proven: Record<string, number> = {}
  const upperBound: Record<string, number> = {}
  const verdicts: Record<string, CounterVerdict> = {}
  const reasonCodes: Record<string, UnresolvedReason> = {}
  const regimeChanges: Record<string, number> = {}
  const pinnedCeiling: Record<string, number | null> = {}
  const firstProvenAt: Record<string, string | null> = {}
  const compacted: Record<string, CompactedBound[]> = {}

  for (const counter of counters) {
    proven[counter.counterId] = 0
    upperBound[counter.counterId] = Number.POSITIVE_INFINITY
    verdicts[counter.counterId] = 'unresolved'
    reasonCodes[counter.counterId] = 'insufficient-evidence'
    regimeChanges[counter.counterId] = 0
    pinnedCeiling[counter.counterId] = null
    firstProvenAt[counter.counterId] = null
    compacted[counter.counterId] = []
  }

  return {
    resourceId,
    counters: [...counters],
    defaultScope: options?.defaultScope ?? 'open',
    proven,
    upperBound,
    clauses: [],
    proofs: [],
    verdicts,
    reasonCodes,
    reopenedClauses: [],
    refutedClauses: [],
    scopeViolations: 0,
    regimeChanges,
    pinnedCeiling,
    firstProvenAt,
    compacted,
    compactedClauses: 0,
    droppedUnresolved: 0,
    observationCount: 0,
  }
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

/**
 * Records accepted traffic. `attempted` is the level the request reached, so the
 * quota provably carries at least that much.
 *
 * Returns the clauses this new proof eliminated a candidate from — the
 * retroactive part. A clause written months ago may only become usable now, and
 * the caller is told which ones moved so the change is observable rather than
 * silently folded into a bound.
 */
export function observeAccepted(
  ledger: HypothesisLedger,
  input: HypothesisInput,
): RejectionClause[] {
  ledger.observationCount += 1

  for (const counter of ledger.counters) {
    const reached = input.attempted[counter.counterId]

    if (reached == null || reached <= ledger.proven[counter.counterId]!) {
      continue
    }

    ledger.proven[counter.counterId] = reached

    // Positive proof the quota moved: traffic was accepted above a ceiling this
    // engine had already pinned. Nothing else in the system is allowed to
    // conclude a regime change, because nothing else distinguishes "the provider
    // raised the limit" from "our model was wrong" — and conflating the two is
    // how a model error gets filed away as bad news from outside.
    const pinned = ledger.pinnedCeiling[counter.counterId]

    if (pinned != null && reached > pinned) {
      ledger.regimeChanges[counter.counterId] = (ledger.regimeChanges[counter.counterId] ?? 0) + 1
      ledger.pinnedCeiling[counter.counterId] = reached
      // Summaries die with the regime they describe. A folded bound from before
      // the move is exactly as void as the live clauses it came from.
      ledger.compacted[counter.counterId] = []

      for (const clause of ledger.clauses) {
        if (clause.soleCandidate === counter.counterId) {
          clause.superseded = true
          clause.resolved = false
          clause.soleCandidate = null
        }
      }
    }
  }

  return reconcile(ledger)
}

/**
 * Records a refusal as one clause over all modelled counters, minus any the
 * evidence already refutes.
 */
export function observeRejected(
  ledger: HypothesisLedger,
  input: HypothesisInput,
): RejectionClause {
  ledger.observationCount += 1

  const scope = input.scope ?? ledger.defaultScope
  const attempted: Record<string, number> = {}
  const windowKeys: Record<string, string> = {}
  const eliminated: string[] = []

  for (const counter of ledger.counters) {
    const id = counter.counterId
    const value = input.attempted[id] ?? ledger.proven[id]!

    attempted[id] = value
    windowKeys[id] = input.windowKeys[id] ?? `window:${id}`

    // A counter that has already carried this much cannot have refused it.
    if (value <= ledger.proven[id]!) {
      eliminated.push(id)
    }
  }

  // A named cause is a fact about one counter, so every other counter is out
  // from the start rather than by later elimination.
  if (scope === 'reported' && input.reportedCounter != null) {
    for (const counter of ledger.counters) {
      const id = counter.counterId

      if (id !== input.reportedCounter && !eliminated.includes(id)) {
        eliminated.push(id)
      }
    }
  }

  const clause: RejectionClause = {
    id: `r${ledger.clauses.length + 1}`,
    at: input.at,
    scope,
    reportedCounter: scope === 'reported' ? (input.reportedCounter ?? null) : null,
    trafficShape: input.trafficShape ?? null,
    attempted,
    windowKeys,
    eliminated,
    resolved: false,
    soleCandidate: null,
    superseded: false,
  }

  ledger.clauses.push(clause)
  reconcile(ledger)

  return clause
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

/**
 * Re-reads every clause against the current proof state and re-derives bounds.
 *
 * Called after each observation rather than only when a rejection arrives,
 * because elimination is monotonic in the proven bounds: the useful moment is
 * whenever a bound rises, which is usually long after the clause was written.
 *
 * Returns the clauses that gained a survivor reduction since last time.
 */
// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Folds droppable clauses into per-counter summaries so the ledger stays
 * bounded no matter how long the process runs.
 *
 * What may go: a resolved, non-superseded clause, oldest first. Resolution
 * means its survivor is already known, so its only future contribution is the
 * bound it already supplied — which the summary keeps, with its provenance.
 * What stays: every unresolved clause (an open hypothesis dropped is evidence
 * destroyed), and the newest resolved ones (so recent entailments keep naming
 * live clauses, not archive entries).
 *
 * What never goes quietly: if even the live-clause floor is exceeded by open
 * hypotheses alone, the oldest are dropped and counted in
 * `droppedUnresolved`. The number is reported, not absorbed, because a bound on
 * retained evidence is a property callers may need to raise — silently
 * degrading the model to fit the cap would be the worse failure.
 */
export function compactLedger(ledger: HypothesisLedger): void {
  if (ledger.clauses.length <= MAX_LIVE_CLAUSES) {
    return
  }

  const droppable = ledger.clauses.filter((clause) => clause.resolved && !clause.superseded)

  // Newest resolved clauses stay live; the tail folds. (Unresolved clauses are
  // not candidates at all — see above.)
  const keepNewest = 64
  const victims = droppable.slice(0, Math.max(0, droppable.length - keepNewest))

  for (const clause of victims) {
    const sole = clause.soleCandidate!

    ledger.compacted[sole]!.push({
      upper: clause.attempted[sole]! - 1,
      shape: clause.trafficShape ?? '__anonymous__',
      clauseId: clause.id,
      at: clause.at,
      windowKey: clause.windowKeys[sole]!,
      scope: clause.scope,
    })
    ledger.compactedClauses += 1
  }

  if (victims.length > 0) {
    const victimIds = new Set(victims.map((clause) => clause.id))
    ledger.clauses = ledger.clauses.filter((clause) => !victimIds.has(clause.id))
  }

  if (ledger.clauses.length <= MAX_LIVE_CLAUSES) {
    return
  }

  // Only reachable under a flood of genuinely ambiguous refusals. Drop oldest
  // first and count every one.
  const overflow = ledger.clauses.length - MAX_LIVE_CLAUSES
  ledger.clauses.splice(0, overflow)
  ledger.droppedUnresolved += overflow
}

export function reconcile(ledger: HypothesisLedger): RejectionClause[] {
  const moved: RejectionClause[] = []

  compactLedger(ledger)

  for (const counter of ledger.counters) {
    ledger.upperBound[counter.counterId] = Number.POSITIVE_INFINITY
  }

  const refuted: string[] = []
  const reopened: string[] = []
  let violations = 0

  for (const clause of ledger.clauses) {
    if (clause.superseded) {
      clause.resolved = false
      clause.soleCandidate = null
      continue
    }

    const before = clause.eliminated.length

    for (const counter of ledger.counters) {
      const id = counter.counterId

      if (clause.eliminated.includes(id)) {
        continue
      }

      if (clause.attempted[id]! <= ledger.proven[id]!) {
        clause.eliminated.push(id)
      }
    }

    const survivors = ledger.counters
      .map((counter) => counter.counterId)
      .filter((id) => !clause.eliminated.includes(id))

    if (survivors.length === 0) {
      // Every candidate this clause offered is provably innocent. If the clause
      // claimed to know the whole set, that claim was false, and the only sound
      // repair is to reopen it: an unmodelled quota explains the refusal, so it
      // may no longer bound anything. Counting this as a conflict and leaving the
      // pin in place would let a wrong completeness assertion keep poisoning the
      // engine after the evidence had already refuted it.
      refuted.push(clause.id)

      if (clause.scope !== 'open') {
        violations += 1
        reopened.push(clause.id)
        clause.scope = 'open'
      }

      clause.resolved = false
      clause.soleCandidate = null

      if (clause.eliminated.length !== before) {
        moved.push(clause)
      }

      continue
    }

    if (survivors.length !== 1) {
      clause.resolved = false
      clause.soleCandidate = null

      if (clause.eliminated.length !== before) {
        moved.push(clause)
      }

      continue
    }

    const sole = survivors[0]!

    if (!clause.resolved || clause.soleCandidate !== sole || clause.eliminated.length !== before) {
      moved.push(clause)
    }

    clause.resolved = true
    clause.soleCandidate = sole

    // A lone survivor bounds its quota — but only when the clause knew what it
    // was talking about. An `open` clause is a generic 429: the survivor is the
    // only *modelled* explanation, and an unmodelled quota remains just as likely,
    // so nothing transfers.
    if (clause.scope !== 'open') {
      const bound = clause.attempted[sole]! - 1

      if (bound < ledger.upperBound[sole]!) {
        ledger.upperBound[sole] = bound
      }
    }
  }

  ledger.refutedClauses = refuted
  ledger.reopenedClauses = reopened
  ledger.scopeViolations = violations
  ledger.proofs = []

  for (const counter of ledger.counters) {
    const id = counter.counterId
    const proven = ledger.proven[id]!

    // Only clauses that still bound anything: a reopened or superseded clause has
    // had its completeness claim withdrawn, and an `open` one never transferred a
    // bound at all.
    const supporting = ledger.clauses.filter(
      (clause) => clause.soleCandidate === id && !clause.superseded && clause.scope !== 'open',
    )

    // Bound sources: live resolved clauses plus folded summaries, treated
    // identically — a folded bound earned its place by the same rule. Live
    // clauses carry full objects; folded ones carry just enough to bound, date,
    // and name their provenance.
    const sources: Array<{
      value: number
      shape: string
      clauseId: string
      at: string
      windowKey: string
      scope: EvidenceScope
    }> = []

    for (const clause of supporting) {
      sources.push({
        value: clause.attempted[id]! - 1,
        shape: clause.trafficShape ?? '__anonymous__',
        clauseId: clause.id,
        at: clause.at,
        windowKey: clause.windowKeys[id]!,
        scope: clause.scope,
      })
    }

    for (const folded of ledger.compacted[id] ?? []) {
      sources.push({
        value: folded.upper,
        shape: folded.shape,
        clauseId: folded.clauseId,
        at: folded.at,
        windowKey: folded.windowKey,
        scope: folded.scope,
      })
    }

    if (sources.length === 0) {
      ledger.verdicts[id] = 'unresolved'
      ledger.reasonCodes[id] = ledger.clauses.some(
        (clause) => clause.soleCandidate === id && clause.scope === 'open',
      )
        ? 'open-cause-set'
        : ledger.refutedClauses.some((refutedId) =>
            ledger.clauses.some((clause) => clause.id === refutedId && clause.attempted[id] != null),
          )
          ? 'model-conflict'
          : 'insufficient-evidence'
      continue
    }

    const byShape = new Map<string, { value: number; clauses: RejectionClause[] }>()

    for (const source of sources) {
      const existing = byShape.get(source.shape)

      if (existing == null || source.value < existing.value) {
        byShape.set(source.shape, { value: source.value, clauses: [] })
      }
    }

    // Track which live clauses back each shape for the entailment below;
    // folded summaries name their clause ids directly.
    const shapeClauses = new Map<string, string[]>()

    for (const source of sources) {
      const entry = byShape.get(source.shape)!

      if (source.value === entry.value) {
        const list = shapeClauses.get(source.shape) ?? []
        list.push(source.clauseId)
        shapeClauses.set(source.shape, list)
      }
    }

    // Group the pinned value by the traffic shape it was observed under. A quota
    // is a property of the account; an effective boundary is a property of the
    // account and the load. The only way to tell them apart from the inside is
    // whether the number survives a change of load. Live clauses and folded
    // summaries enter on equal footing here — both earned their bound by the
    // same rule, and both name the clause that supplied it.
    const values = [...new Set([...byShape.values()].map((entry) => entry.value))]
    const named = [...byShape.keys()].filter((shape) => shape !== '__anonymous__')
    const reported = sources.some((source) => source.scope === 'reported')

    if (values.length > 1) {
      // Different shapes pinned different numbers. Nothing may be claimed: the
      // engine has demonstrated that the value depends on the load, which is the
      // one thing a quota cannot do.
      ledger.verdicts[id] = 'contested'
      ledger.reasonCodes[id] = 'contested-across-shapes'
      ledger.upperBound[id] = Math.min(...values)
      continue
    }

    const ceiling = values[0]!

    // The bracket has to close to a single integer. `proven <= L < ceiling + 1`
    // names a number only when the two ends meet; a 350k-token attempt against a
    // proven 100k leaves a range, and a range is a real result that must not be
    // collapsed into a guess.
    if (ceiling !== proven) {
      ledger.verdicts[id] = 'unresolved'
      ledger.reasonCodes[id] = 'insufficient-evidence'
      ledger.upperBound[id] = ceiling
      continue
    }

    const survivesLoadChange = reported || named.length >= 2

    ledger.verdicts[id] = survivesLoadChange ? 'proven' : 'boundary'
    delete ledger.reasonCodes[id]
    ledger.upperBound[id] = ceiling
    ledger.pinnedCeiling[id] = ceiling

    if (ledger.firstProvenAt[id] == null) {
      ledger.firstProvenAt[id] = sources
        .map((source) => source.at)
        .sort()
        .at(-1)!
    }

    const fromClauses = sources.map((source) => source.clauseId)
    const windows = [...new Set(sources.map((source) => source.windowKey))]
    const shapes = named.length > 0 ? named : ['(uncharacterised)']

    const dependsOn = [
      ...(sources.some((source) => source.scope === 'reported')
        ? [
            `reported by the provider (${sources
              .filter((source) => source.scope === 'reported')
              .map((source) => source.clauseId)
              .join(', ')})`,
          ]
        : []),
      ...(sources.some((source) => source.scope === 'assumed')
        ? ['causeSetComplete (asserted by the operator, not the provider)']
        : []),
      'independentQuota (this key does not share a pool with another)',
      'accountingVerified (a request costs what the engine was told)',
      'windowModelVerified (alignment and reset match the provider)',
    ]

    ledger.proofs.push({
      counterId: id,
      ceiling,
      fromClauses,
      windows,
      verdict: ledger.verdicts[id]!,
      shapes,
      dependsOn,
      entailment: survivesLoadChange
        ? `accepted traffic carried ${id} to ${proven}, so L >= ${proven}; ` +
          `clause(s) ${fromClauses.join(', ')} leave ${id} as the only possible cause ` +
          `at an attempt of ${ceiling + 1}, so L < ${ceiling + 1}; ` +
          (reported
            ? 'the provider named it, '
            : `the same value fell out under ${named.length} distinct traffic shapes (${shapes.join(', ')}), `) +
          `so ${id} = ${ceiling} is the quota, not merely this load's boundary.`
        : `accepted traffic carried ${id} to ${proven}, so L >= ${proven}; ` +
          `clause(s) ${fromClauses.join(', ')} leave ${id} as the only possible cause ` +
          `at an attempt of ${ceiling + 1}, so L < ${ceiling + 1}. ` +
          `OBSERVED EFFECTIVE BOUNDARY under ${shapes.join(', ')} — not asserted to be ` +
          `the provider's quota, because it has only been seen under one traffic shape.`,
    })
  }

  return moved
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** What a clause still allows, for attribution review rather than inference. */
export function clauseCandidates(
  ledger: HypothesisLedger,
  clause: RejectionClause,
): string[] {
  return ledger.counters
    .map((counter) => counter.counterId)
    .filter((id) => !clause.eliminated.includes(id))
}

/**
 * The interval a counter's evidence still permits. Wide means the engine knows
 * a range but cannot name a number, which is a real result and is reported as
 * one rather than collapsed into a guess.
 */
export function counterInterval(
  ledger: HypothesisLedger,
  counterId: string,
): { lower: number; upper: number | null } {
  const upper = ledger.upperBound[counterId]!

  return {
    lower: ledger.proven[counterId]!,
    upper: Number.isFinite(upper) ? upper : null,
  }
}

/**
 * Why this counter's current state is not a quota claim, in one clause.
 *
 * Shared by every projection of this ledger — the assessment's `boundary` and
 * the `QuotaKnowledge` view — so the sentence a reviewer reads can never
 * disagree with the one another reviewer reads. Pure: it reads state and
 * returns words.
 */
export function describeCounterStanding(
  ledger: HypothesisLedger,
  counterId: string,
  shapeList = '',
): string {
  const verdict = ledger.verdicts[counterId]
  const proof = ledger.proofs.find((entry) => entry.counterId === counterId)
  const reason = ledger.reasonCodes[counterId] ?? null
  const moved = (ledger.regimeChanges[counterId] ?? 0) > 0

  if (verdict === 'proven' && proof != null) {
    return (
      `pinned at ${proof.ceiling}: the constraints force this value under the named assumptions, ` +
      `but the provider never stated the number — it is derived, not declared`
    )
  }

  if (verdict === 'boundary' && proof != null) {
    return (
      `traffic under ${shapeList.length > 0 ? shapeList : 'no traffic yet'} could not pass ${proof.ceiling}: ` +
      `true of the traffic seen, not of the quota`
    )
  }

  if (verdict === 'contested' || reason === 'contested-across-shapes') {
    return 'different traffic shapes pinned different values — no number may be claimed'
  }

  // A quota move outranks every other explanation for a missing pin: the
  // earlier number is not "not quite proven", it is withdrawn.
  if (moved) {
    return 'traffic was accepted above the previously pinned value, so that pin is withdrawn — nothing is claimed here now'
  }

  if (reason === 'open-cause-set') {
    return 'an unmodelled quota explains every refusal just as well — the cause set is not closed'
  }

  if (reason === 'model-conflict') {
    return 'the completeness claim was refuted by its own evidence — the model, not the traffic, is suspect'
  }

  if (reason === 'insufficient-evidence') {
    return 'too little evidence to bound anything yet'
  }

  return 'no bound was derived'
}

/**
 * Projects one counter's shadow state into the report shape the engine carries
 * on a live assessment. Pure projection, like `buildHypothesisReport`: no
 * inference runs here, so calling it can never change what the ledger
 * believes. Null when the ledger tracks no such counter — gauges and
 * windowless counters never enter a ledger, and their assessments read
 * exactly as they did before the reporting connection.
 */
export function describeCounterBoundary(
  ledger: HypothesisLedger,
  counterId: string,
): import('./types.js').ObservedBoundary | null {
  const verdict = ledger.verdicts[counterId]

  if (verdict == null) {
    return null
  }

  const proof = ledger.proofs.find((entry) => entry.counterId === counterId)
  const clauseAt = new Map<string, string>()

  for (const clause of ledger.clauses) {
    clauseAt.set(clause.id, clause.at)
  }

  for (const folded of ledger.compacted[counterId] ?? []) {
    if (!clauseAt.has(folded.clauseId)) {
      clauseAt.set(folded.clauseId, folded.at)
    }
  }

  const fromClauses = (proof?.fromClauses ?? []).map((id) => ({ id, at: clauseAt.get(id) ?? null }))
  const instants = fromClauses
    .map((entry) => entry.at)
    .filter((at): at is string => typeof at === 'string')
    .sort()
  const shapes = proof != null ? [...proof.shapes] : []

  return {
    verdict,
    ceiling: proof?.ceiling ?? null,
    shapes,
    windows: proof != null ? [...proof.windows] : [],
    fromClauses,
    dependsOn: proof != null ? [...proof.dependsOn] : [],
    // The engine itself writes this prefix when a reported refusal contributed
    // (see reconcile); matching the producer's own words keeps the rule in one
    // home instead of re-deriving provenance from clause lookups that folded
    // summaries would defeat.
    reportedBacked: proof?.dependsOn.some((dep) => dep.startsWith('reported by the provider')) ?? false,
    observedFrom: ledger.firstProvenAt[counterId] ?? instants[0] ?? null,
    observedUntil: instants.length > 0 ? instants[instants.length - 1]! : null,
    standing: describeCounterStanding(ledger, counterId, shapes.join(', ')),
    ledgerScope: 'session',
  }
}

/**
 * Projects a ledger into the report shape the engine attaches to an
 * attribution. Pure projection: no inference runs here, so calling it can never
 * change what the ledger believes. The engine calls it at most once per
 * settlement and never reads the result back into a decision.
 */
export function buildHypothesisReport(
  ledger: HypothesisLedger,
  observedAt: string,
): import('./types.js').HypothesisReport {
  const clauses = ledger.clauses.map((clause) => ({
    id: clause.id,
    at: clause.at,
    scope: clause.scope,
    candidates: clauseCandidates(ledger, clause),
    resolved: clause.resolved,
    soleCandidate: clause.soleCandidate,
    superseded: clause.superseded,
  }))

  return {
    resourceId: ledger.resourceId,
    observedAt,
    verdicts: { ...ledger.verdicts },
    reasons: { ...ledger.reasonCodes },
    proofs: ledger.proofs
      .filter(
        (proof): proof is typeof proof & { verdict: 'proven' | 'boundary' | 'contested' } =>
          proof.verdict !== 'unresolved',
      )
      .map((proof) => ({
        counterId: proof.counterId,
        ceiling: proof.ceiling,
        verdict: proof.verdict,
        shapes: [...proof.shapes],
        dependsOn: [...proof.dependsOn],
        entailment: proof.entailment,
        fromClauses: [...proof.fromClauses],
        windows: [...proof.windows],
      })),
    clauses,
    abstained: clauses
      .filter((clause) => clause.candidates.length !== 1)
      .map((clause) => clause.id),
    regimeChanges: { ...ledger.regimeChanges },
    scopeViolations: ledger.scopeViolations,
  }
}
