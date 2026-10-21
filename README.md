# Adaptive Throttle

Provider-agnostic quota accounting, routing advice, cooldowns, and request
pacing for Node.js 18 and newer. The package is ESM-only and has no runtime
dependencies. JavaScript ESM and TypeScript declaration files are included;
CommonJS `require()` is not supported.

The library does not send requests, create timers, probe providers, retry, store
state, or select credentials. Your application owns the provider adapter,
waiting, retries, persistence, and the mapping from resource IDs to secrets.

```sh
npm install adaptive-throttle
```

## Configure resources

Each `resourceId` represents a routeable provider resource, such as a key or
account. Use a stable opaque ID; do not put a secret key in it. Declare the
counters that matter to your provider:

```ts
import {
  AdaptiveThrottleEngine,
  type OutcomeInput,
  type ResourceSpec,
} from 'adaptive-throttle'

const resources: ResourceSpec[] = [
  {
    resourceId: 'key-a',
    counters: [
      {
        counterId: 'rpm',
        kind: 'window',
        unit: 'count',
        window: { windowMs: 60_000, alignment: 'fixed' },
        limit: 60,
      },
      {
        counterId: 'inflight',
        kind: 'gauge',
        unit: 'count',
        limit: 8,
      },
    ],
  },
  {
    resourceId: 'key-b',
    counters: [
      {
        counterId: 'rpm',
        kind: 'window',
        unit: 'count',
        window: { windowMs: 60_000, alignment: 'fixed' },
        limit: 60,
      },
      {
        counterId: 'inflight',
        kind: 'gauge',
        unit: 'count',
        limit: 8,
      },
    ],
  },
]

const throttle = new AdaptiveThrottleEngine(undefined, { mode: 'smart' })
throttle.register(resources)
```

`window` counters model a fixed or sliding quota window. `bucket` counters
model a refill bucket and use `bucket: { windowMs }` instead of `window`.
`gauge` counters represent current levels such as in-flight requests and do not
have a window. All durations are milliseconds. Set `limit` only when your
configuration or provider states it; omit it when the limit is unknown and
should be learned from observed outcomes.

Units are open-ended strings, so counters can represent requests, tokens,
bytes, cost, or application-specific units. Use `defaultCharge` for the usual
charge on a counter. Supply `usage.charges` when an operation has a different
actual charge. `forecast` on `decide()` or `charges` on `recordRequestStart()`
can reserve an expected charge before the provider call.

Resources that share one provider-side account or project quota can use the
same `quotaGroupId`. A refusal reported for that shared quota then informs all
members of the group.

## Route one request

`decide()` returns advice; your adapter makes the request and reports its real
outcome. The example accepts a provider adapter as an argument so no SDK,
endpoint, or credential format is assumed:

```ts
type ProviderOutcome = Pick<
  OutcomeInput,
  'kind' | 'detail' | 'rateLimit' | 'usage' | 'provider'
>

async function routeOne(
  sendRequest: (resourceId: string) => Promise<ProviderOutcome>,
) {
  const { advice } = throttle.decide()

  switch (advice.action.type) {
    case 'proceed':
    case 'proceed-cautious': {
      const resourceId = advice.action.resourceId
      const outcome = await sendRequest(resourceId)
      throttle.settle({ resourceId, ...outcome })
      return advice.action
    }
    case 'wait':
      // Wait in your application, then call routeOne again to re-evaluate.
      return advice.action
    case 'stop':
      // Do not send this request; surface the reason to your application.
      return advice.action
  }
}
```

`proceed-cautious` still names a usable resource; its `note` explains the
caution. `wait` includes `waitMs` and an absolute `retryAt`. Re-evaluate after
waiting because quota state or other concurrent requests may have changed.
`stop` means the configured facts prevent a request from being sent.

The adapter must classify outcomes using what the provider actually reported:

| `kind` | Report it when |
| --- | --- |
| `success` | The provider accepted the operation |
| `rate-limit` | The provider refused it because of a quota or rate limit |
| `credential-rejected` | The provider says the credential is invalid or unauthorized |
| `transport-failure` | The request failed at the transport layer, such as a timeout |
| `resource-missing` | The addressed model, endpoint, or resource does not exist |
| `released` | A tracked request was cancelled before an outcome was known |

Do not label an unknown server error, exhausted credit balance, or invalid key
as `rate-limit` unless the provider identifies it as a quota refusal. There is
no generic server-error or credit-exhausted outcome kind; handle those cases in
your application and do not invent quota evidence.

For a rate limit, pass only facts the provider or your adapter can substantiate:

```ts
throttle.settle({
  resourceId: 'key-a',
  kind: 'rate-limit',
  rateLimit: {
    retryAfterSeconds: 2,
    rejectedCounterId: 'rpm',
    rejectedCharge: 1,
    limitScope: 'resource',
  },
})
```

`rateLimit` fields are optional. They include `retryAfterSeconds`,
`providerResetAt` (an absolute timestamp), `rejectedCounterId`, `rejectedCharge`,
`blamedCounterIds`, and `limitScope` (`resource` or `quota-group`). Leave facts out when the
provider did not supply them; the engine can still attribute a refusal from
recorded usage. `settle()` returns that attribution and the observation used.

Every real outcome should be settled once. For untracked legacy calls, supply
`eventId` if you need duplicate delivery protection. Repeating a settled event
ID does not charge or learn a second time. If the adapter throws, catch only
errors it can classify, settle the matching outcome, then apply your retry or
failure policy.

`routeOne()` makes at most one provider call. It deliberately leaves retries to
the caller, which can bound attempts, honor cancellation, and avoid repeating
an expensive request unexpectedly.

## Modes

The default mode is `smart`.

| Mode | Behavior |
| --- | --- |
| `off` | Measures usage; inferred limits do not steer. Explicit provider facts are still honored. |
| `observe` | Produces full advice but does not withhold a request based on inference. |
| `smart` | Inferences steer requests toward healthier resources; they never hard-block. |
| `aggressive` | Ranks a resource with an unanswered failure below healthy choices; it remains eligible as a last resort. |

The engine only advises. It never selects or rotates API keys on its own.

## Concurrent starts and request pacing

`decide()` is advisory and does not reserve a send slot. For concurrent callers
sharing one engine, `recordRequestStart()` performs a synchronous decision and
reservation. It does not send the request or wait for you:

```ts
import { randomUUID } from 'node:crypto'

async function sendTrackedRequest(
  sendRequest: (resourceId: string) => Promise<ProviderOutcome>,
) {
  const resourceId = 'key-a'
  const requestId = randomUUID()
  let start = throttle.recordRequestStart({ resourceId, requestId })

  while (!start.dispatched) {
    if (start.decision === 'blocked') return start
    await new Promise((resolve) => setTimeout(resolve, start.waitMs ?? 0))
    start = throttle.recordRequestStart({ resourceId, requestId })
  }

  const outcome = await sendRequest(resourceId)
  throttle.settle({ resourceId, requestId, ...outcome })
  return start
}
```

Only send when `dispatched` is true. If the result is `blocked`, take the
application action shown in `reason`; if it is `wait`, wait and re-check. A
refused start does not consume the request ID. After a successful start, settle
with the same `resourceId` and `requestId`; use `released` if it is cancelled
without a provider outcome. IDs must be unique for each actual request.

`planRequest()` is a non-reserving preview. It takes the latest of the pacing
interval, your `retryAt`, and active cooldown deadlines, so overlapping waits
are not added together. Always re-check by calling `recordRequestStart()` before
sending.

Configure pacing globally on the engine, with learned intervals scoped to each
resource:

| Mode | Target gap between starts |
| --- | --- |
| `off` | No pacing gap |
| `low` | 500–1500ms |
| `medium` | 2000–3500ms |
| `high` | 5000–10000ms |
| `custom` | Fixed `intervalMs` |
| `dynamic` | 500–10000ms by default; set `minIntervalMs`/`maxIntervalMs` to change the bounds |

For example, `throttle.configurePacing({ mode: 'custom', intervalMs: 1200 })`
sets a fixed 1.2-second gap. Pass the caller's retry deadline as `retryAt` to
`planRequest()` or `recordRequestStart()` when one exists.

The profiles are deterministic; no random jitter is added. Dynamic doubles its
target once on the first refusal in a consecutive refusal episode, then waits
for a qualifying success before growing again. Every three qualifying
successes reduce the current target by 10% (at least 100ms), down to the
configured minimum. Auth, credit, transport, and missing-resource errors do
not train this rate-limit controller.

## Snapshots and persistence

The engine does not write to disk or a database. Persist the returned snapshot
with storage owned by your application:

```ts
const snapshot = throttle.getSnapshot()
const serialized = JSON.stringify(snapshot)
// Store `serialized` in your database or file using your application's policy.
```

On restart, pass the parsed snapshot to `AdaptiveThrottleEngine` and register
the resource configuration again:

```ts
const restored = new AdaptiveThrottleEngine(JSON.parse(serialized), { mode: 'smart' })
restored.register(resources)
```

Snapshots retain quota measurements, cooldowns, and learned pacing state.
Resource configuration and live request identities/reservations are not
persisted. Reconcile in-flight operations in your application after restart.
Separate processes also need a shared owner or external coordination; one
engine synchronizes only callers using that same instance.

## Measured pacing results

These are means over 40 paired seeds; each mode received identical offered
jobs. “Completed” counts successful jobs during the 10-minute arrival window.
“Drain” is the time to finish the entire offered workload.

| Scenario | Completed by 10m, off → dynamic | 429s, off → dynamic | Drain minutes, off → dynamic |
| --- | ---: | ---: | ---: |
| Burst headroom | 100.0 → 100.0 | 0.0 → 0.0 | 9.52 → 9.54 |
| Sustained overload | 305.6 → 308.7 | 84.0 → 76.2 | 15.29 → 15.47 |
| Small token bucket burst | 301.8 → 288.2 | 559.4 → 25.0 | 15.92 → 16.62 |
| Fast headroom | 600.0 → 600.0 | 0.0 → 0.0 | 9.99 → 9.99 |
| Slow model (8s latency) | 74.0 → 74.0 | 0.0 → 0.0 | 80.00 → 80.00 |
| Quota tightens, 60 → 15 RPM | 376.6 → 369.9 | 518.5 → 18.0 | 24.85 → 25.83 |
| Quota recovers, 15 → 60 RPM | 375.8 → 322.2 | 478.5 → 33.0 | 13.73 → 14.75 |
| Token-bound | 32.0 → 32.0 | 1194.5 → 305.8 | 99.14 → 99.13 |
| Holdout: fixed 15 RPM | 161.4 → 154.7 | 131.8 → 126.3 | 23.12 → 23.34 |
| Holdout: bucket 90 RPM | 428.8 → 587.9 | 1199.0 → 69.0 | 27.96 → 20.55 |
| Holdout: quota recovers, 10 → 40 RPM | 253.9 → 175.4 | 368.1 → 17.5 | 11.14 → 13.17 |
| Holdout: quota drops, 90 → 20 RPM | 504.0 → 502.3 | 681.5 → 22.1 | 24.77 → 24.82 |

The scenarios are synthetic, single-key FIFO simulations with fixed-window or
token-bucket limiters. They made no HTTP requests and included no provider
headers or other callers sharing quota. Rejected attempts did not consume quota
in these models. Every offered job finished without terminal failure. These
results do not predict any named provider's behavior.

Dynamic sharply reduced simulated 429s, but sometimes delayed work: by the
10-minute mark it completed 14% fewer jobs in the quota-recovery case and 31%
fewer in the 10 → 40 RPM holdout. It also completed more jobs in the 90 RPM
bucket holdout. Treat Dynamic as an opt-in trade-off, not a universal default.
The earlier 39.6-minute drain came from the superseded controller. The revised
sustained-overload run drained in 15.47 minutes (pacing off: 15.29).
