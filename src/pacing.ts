/** Deterministic request-start pacing. No timers, requests, or key selection. */
export type PacingMode = 'off' | 'low' | 'medium' | 'high' | 'custom' | 'dynamic'
export interface PacingOptions {
  mode: PacingMode
  intervalMs?: number
  /** Dynamic's default range is 500–10000ms; explicit bounds override it. */
  minIntervalMs?: number
  maxIntervalMs?: number
}
export interface PacingState {
  intervalMs: number
  lastStartedAt: number | null
  lastFailureAt: number | null
  successes: number
  /** One pacing increase per refusal episode, retained across restarts. */
  failureEpisode?: boolean
}
export interface PacingSnapshot {
  options: PacingOptions
  resources: Record<string, PacingState>
}
export interface RequestPlanInput {
  resourceId: string
  now?: Date | string | number
  /** Absolute deadline supplied by the caller's retry policy. */
  retryAt?: Date | string | number
  charges?: Record<string, number>
}
export interface RequestPlan {
  resourceId: string
  decision: 'send' | 'wait' | 'blocked'
  notBefore: string | null
  waitMs: number | null
  reason: string
}
export interface RequestStartInput extends RequestPlanInput {
  requestId: string
}
export interface RequestStartResult extends RequestPlan {
  dispatched: boolean
  requestId: string
  startedAt?: string
}

function duration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 86_400_000)
    throw new Error('Pacing durations must be whole milliseconds between 0 and 86400000')
  return value
}

export function pacingBounds(options: PacingOptions): [number, number] {
  switch (options.mode) {
    case 'off':
      return [0, 0]
    case 'low':
      return [500, 1500]
    case 'medium':
      return [2000, 3500]
    case 'high':
      return [5000, 10000]
    case 'custom': {
      if (options.intervalMs == null) throw new Error('Custom pacing requires intervalMs')
      const interval = duration(options.intervalMs)
      return [interval, interval]
    }
    case 'dynamic': {
      const minimum = duration(options.minIntervalMs ?? 500)
      const maximum = duration(options.maxIntervalMs ?? 10000)
      if (minimum > maximum) throw new Error('Pacing minimum exceeds maximum')
      return [minimum, maximum]
    }
    default:
      throw new Error('Unknown pacing mode')
  }
}

export function normalizePacingSnapshot(input: unknown): PacingSnapshot {
  const snapshot: PacingSnapshot = { options: { mode: 'off' }, resources: {} }
  if (input == null || typeof input !== 'object') return snapshot
  const raw = input as Partial<PacingSnapshot>
  try {
    if (raw.options) {
      pacingBounds(raw.options)
      snapshot.options = { ...raw.options }
    }
  } catch {
    return snapshot
  }
  if (raw.resources == null || typeof raw.resources !== 'object' || Array.isArray(raw.resources))
    return snapshot
  for (const [id, state] of Object.entries(raw.resources)) {
    if (!state || typeof state !== 'object') continue
    const instant = (value: unknown) =>
      value === null ||
      (typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= 8_639_999_913_600_000)
    if (
      !Number.isSafeInteger(state.intervalMs) ||
      state.intervalMs < 0 ||
      state.intervalMs > 86_400_000 ||
      !instant(state.lastStartedAt) ||
      !instant(state.lastFailureAt) ||
      !Number.isInteger(state.successes) ||
      state.successes < 0 ||
      state.successes > 2
    )
      continue
    Object.defineProperty(snapshot.resources, id, {
      value: {
        ...state,
        failureEpisode: typeof state.failureEpisode === 'boolean'
          ? state.failureEpisode
          : state.lastFailureAt !== null && state.successes === 0,
      },
      writable: true,
      configurable: true,
      enumerable: true,
    })
  }
  return snapshot
}

export class AdaptivePacing {
  private snapshot: PacingSnapshot
  constructor(snapshot?: unknown) {
    this.snapshot = normalizePacingSnapshot(snapshot)
  }

  configure(options: PacingOptions): void {
    pacingBounds(options)
    this.snapshot.options = { ...options }
    for (const id of Object.keys(this.snapshot.resources)) this.state(id)
  }

  getSnapshot(): PacingSnapshot {
    return structuredClone(this.snapshot)
  }

  notBefore(resourceId: string): number | null {
    if (this.snapshot.options.mode === 'off') return null
    const state = this.state(resourceId)
    return state.lastStartedAt == null ? null : state.lastStartedAt + state.intervalMs
  }

  dispatch(resourceId: string, startedAt: number): void {
    this.state(resourceId).lastStartedAt = startedAt
  }

  settle(resourceId: string, kind: string, startedAt: number, settledAt: number): void {
    const state = this.state(resourceId)
    const options = this.snapshot.options
    if (kind === 'rate-limit') {
      const firstFailure = !state.failureEpisode
      state.failureEpisode = true
      state.lastFailureAt = Math.max(state.lastFailureAt ?? 0, settledAt)
      state.successes = 0
      if (firstFailure && options.mode !== 'off' && options.mode !== 'custom') {
        const [minimum, maximum] = pacingBounds(options)
        state.intervalMs = Math.min(
          maximum,
          Math.max(minimum, state.intervalMs * 2, state.intervalMs + 100),
        )
      }
    } else if (
      kind === 'success' &&
      (state.lastFailureAt == null || startedAt > state.lastFailureAt)
    ) {
      state.failureEpisode = false
      if (options.mode === 'off' || options.mode === 'custom') return
      state.successes++
      if (state.successes >= 3) {
        const [minimum] = pacingBounds(options)
        state.intervalMs = Math.max(
          minimum,
          state.intervalMs - Math.max(100, Math.round(state.intervalMs / 10)),
        )
        state.successes = 0
      }
    } else if (kind !== 'released') state.successes = 0
  }

  private state(resourceId: string): PacingState {
    const [minimum, maximum] = pacingBounds(this.snapshot.options)
    let state = Object.hasOwn(this.snapshot.resources, resourceId)
      ? this.snapshot.resources[resourceId]
      : undefined
    if (!state) {
      state = { intervalMs: minimum, lastStartedAt: null, lastFailureAt: null, successes: 0 }
      Object.defineProperty(this.snapshot.resources, resourceId, {
        value: state,
        writable: true,
        configurable: true,
        enumerable: true,
      })
    }
    state.intervalMs = Math.min(maximum, Math.max(minimum, state.intervalMs))
    return state
  }
}
