/**
 * Quota knowledge: what the shadow ledger currently licenses, projected.
 *
 * This module holds no state of its own and runs no inference. It reads a
 * `HypothesisLedger` and answers "what may be said about this counter, and on
 * what evidence" — the same question `describeCounterBoundary` answers for a
 * live assessment, in the fuller shape a caller planning a routing change
 * needs: which clauses the claim rests on, which assumptions would have to be
 * re-examined for it to fall, and when it first became available.
 *
 * Two ownership rules, stated because the alternative is a silent confusion:
 *
 * 1. **Provider-stated limits are not here.** A ceiling the provider telemetry
 *    declared is owned by telemetry and reported through the assessment's
 *    `limit`/`contract === 'authoritative'`. From the ledger alone, only
 *    `observedBoundary` and `unresolved` are reachable — a derivation is not a
 *    declaration, and this projection never invents one.
 * 2. **`modelProven` stays unreachable here.** Two traffic shapes agreeing on a
 *    number is a consistency signal, not proof of a quota: a shared pool or a
 *    hidden quota survives a change of load just as well. The vocabulary
 *    exists for the day the assumptions are checkable; nothing promotes into
 *    it by repetition.
 *
 * The view is rebuilt on every call from the ledger's live state, so a bound
 * that is later narrowed, contested, or withdrawn shows up in the next read —
 * there is no cached answer to go stale.
 */

import type { CounterVerdict, HypothesisLedger } from './hypotheses.js'
import { describeCounterStanding } from './hypotheses.js'
import type { LimitContract } from './types.js'

export interface QuotaKnowledge {
  counterId: string
  resourceId: string
  /**
   * Scope of the quota this knowledge is about. `'resource'` until `groups.ts`
   * exists: the engine declares no shared pools, so nothing here may claim a
   * group scope it has no way to check.
   */
  quotaScope: 'resource'
  /**
   * Generation of the current regime, derived rather than stored: the number of
   * quota moves recorded for this counter. `r0` means none has been seen, `r1`
   * means traffic was once accepted above a pinned value and the pin that
   * contradicted it was withdrawn.
   */
  regimeId: string
  /** Highest level accepted traffic has demonstrably carried. */
  provenLowerBound: number
  /**
   * Tightest upper bound the surviving clauses allow, or null when nothing
   * bounds this counter. Null after a quota move as well: a bound belonging to
   * a superseded regime is not evidence for this one, and repeating it would be
   * quoting a dead regime's arithmetic.
   */
  upperBound: number | null
  /** The pinned value, when the constraints force one. Null otherwise. */
  ceiling: number | null
  /**
   * The ledger's own verdict: `proven` and `boundary` both report as the
   * `observedBoundary` contract, but they are not the same claim — a
   * reported-cause pin and an effective boundary differ in what would have to
   * be re-checked for them to fall — so the distinction travels too.
   */
  verdict: CounterVerdict
  contract: LimitContract
  /** Clause ids the pin derives from — the evidence, named and checkable. */
  proofIds: readonly string[]
  /** Assumptions the derivation rests on. Empty when nothing is pinned. */
  assumptions: readonly string[]
  /** When the pin first became available, or null if it never did. */
  firstProvenAt: string | null
  /** Recorded quota moves for this counter. See `regimeId`. */
  regimeChanges: number
  /**
   * Where the evidence lives. `'session'` always: the ledger is not persisted,
   * so a restored engine has no ledger and this view is absent rather than
   * reconstructed. Stable now; the snapshot design decides what it becomes.
   */
  ledgerScope: 'session'
  /** Why this is not a quota claim, in one clause. Present on every entry. */
  standing: string
}

function contractOf(
  verdict: CounterVerdict,
): LimitContract {
  if (verdict === 'proven' || verdict === 'boundary') {
    return 'observedBoundary'
  }

  return 'unresolved'
}

/**
 * Projects a ledger into one entry per tracked counter, in declaration order.
 *
 * Pure: nothing here mutates, and nothing downstream may mutate the result
 * (it is frozen, like a normalized observation). A caller reading
 * `getQuotaKnowledge()` therefore sees exactly what the evidence currently
 * licenses, nothing cached, and nothing it can accidentally corrupt.
 */
export function buildQuotaKnowledge(ledger: HypothesisLedger): readonly QuotaKnowledge[] {
  const clauseAt = new Map<string, string>()

  for (const clause of ledger.clauses) {
    clauseAt.set(clause.id, clause.at)
  }

  return Object.freeze(
    ledger.counters.map((counter) => {
      const id = counter.counterId
      const verdict = ledger.verdicts[id]!
      const proof = ledger.proofs.find((entry) => entry.counterId === id)
      const changes = ledger.regimeChanges[id] ?? 0
      const upper = ledger.upperBound[id] ?? Number.POSITIVE_INFINITY
      const contract = contractOf(verdict)
      const pinned = contract === 'observedBoundary'
      // A bound that belonged to a superseded regime is arithmetic about a quota
      // that no longer exists. Everything else finite is real evidence and is
      // reported, including an unclosed bracket's upper end.
      const withdrawn = !pinned && changes > 0

      return Object.freeze({
        counterId: id,
        resourceId: ledger.resourceId,
        quotaScope: 'resource' as const,
        regimeId: `r${changes}`,
        provenLowerBound: ledger.proven[id] ?? 0,
        upperBound: Number.isFinite(upper) && !withdrawn ? upper : null,
        ceiling: pinned ? (proof?.ceiling ?? null) : null,
        verdict,
        contract,
        proofIds: proof != null ? Object.freeze([...proof.fromClauses]) : Object.freeze([]),
        assumptions: proof != null ? Object.freeze([...proof.dependsOn]) : Object.freeze([]),
        firstProvenAt: ledger.firstProvenAt[id] ?? null,
        regimeChanges: changes,
        ledgerScope: 'session' as const,
        standing: describeCounterStanding(ledger, id, proof != null ? proof.shapes.join(', ') : ''),
      })
    }),
  )
}
