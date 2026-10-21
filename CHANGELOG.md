# Changelog

## 1.0.0 — 2026-10-21

### Added: per-resource request pacing

Added `AdaptivePacing` and engine methods for planning and recording request
starts. Fixed low, medium, and high profiles, custom intervals, and a bounded
dynamic profile now combine with retry and cooldown deadlines without adding
overlapping waits. Dynamic pacing increases once per refusal episode and
recovers from successful traffic; pacing state is included in snapshots.

The package build now publishes compiled JavaScript and declaration files,
creates its build during `prepack`, and runs the portable test suite before
publication. See the README for reproduced synthetic pacing measurements and
their limits.

### Added: read-only shadow boundary reporting on `CounterAssessment`

Every live assessment now carries `boundary: ObservedBoundary | null` — what
the shadow OR-constraint engine concluded about that counter, beside the
legacy `inference`, never merged into it. When the ledger pins a value, the
assessment reports under contract `'observedBoundary'`; when it does not pin,
the contract stays the legacy engine's and the boundary still explains why
not (`standing`), with the session scope stated (`ledgerScope: 'session'` —
a restore resets the ledger).

Deliberately not included: `modelProven` remains a valid contract state with
no in-engine producer. Nothing the engine observes promotes a derivation into
a quota claim on its own — not even two traffic shapes agreeing (acceptance
48 guards the veto). `limit` is still set if and only if
`contract === 'authoritative'`.

Routing is unchanged: scores, `blockCeiling`, `softCeiling`, cooldowns,
ordering and `decide()` results take identical paths — routing never reads
`contract` or `boundary` (acceptance 33 guards this). Only reporting grew.

### BREAKING: `CounterAssessment.limit` is now only ever a verified ceiling

`limit` is set if and only if `contract === 'authoritative'` — the operator or
the provider stated it. A ceiling that merely reproduced (three windows, any
number of windows) no longer appears in `limit`, `causeLimit`, or any text
derived from them. It lives in `inference.estimatedLimit` / `candidateLimit`,
labeled with its evidence.

If you read `limit` (or `causeLimit`, or `limitSource === 'inferred'` rendered
next to a number) as "the provider's quota", that reading was already wrong —
shared-pool runs showed 28% of those numbers disagreeing with the true ceiling —
and it is now impossible: the field is null unless the ceiling is a fact.

Migration: replace reads of `assessment.limit` with `assessment.limit ??
assessment.inference.estimatedLimit`, and branch on `assessment.contract`
(`'authoritative'` = fact, `'observedBoundary'` = traffic could not pass this
level, `'legacyEstimate'` = repeated but unproven, `'unresolved'` = nothing
known). `modelProven` is a valid contract state with no in-engine producer;
nothing may claim it until an explicit assumption surface arrives —
`acceptance 32` guards this.

Routing is unchanged: scores, `blockCeiling`, `softCeiling`, cooldowns, the
failure memory and the mode table take identical paths. Only what is *reported*
as a limit moved.
