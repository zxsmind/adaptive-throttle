/**
 * Adaptive Throttle — engine identity, the single cross-surface source of truth.
 *
 * `adaptive-throttle` is the module (package) name. `toomanyidiots` is the
 * durable architecture family id and never changes; each generation appends a
 * generation suffix and owns exactly one canonical record here. This is
 * generation 2 — a generic rewrite of generation 1, which was specific to AI
 * model providers (fixed rpm/tpm/rpd dimensions, tokens and cost as the only
 * metered units, provider/model/key composite scopes).
 *
 * This module must stay environment-neutral (browser, mobile, Node, CLI): no
 * runtime imports, no platform APIs — pure constants only. It is exposed as the
 * `adaptive-throttle/identity` subpath so browser-safe consumers can import it
 * without pulling in the engine runtime.
 */

export const THROTTLE_MODULE_NAME = 'adaptive-throttle'

export const THROTTLE_ARCHITECTURE_NAME = 'toomanyidiots'

export const THROTTLE_ARCHITECTURE_ID = `${THROTTLE_ARCHITECTURE_NAME}-2`

export type ThrottleArchitectureId = typeof THROTTLE_ARCHITECTURE_ID

export const THROTTLE_ENGINE_VERSION = 'V2'

export const THROTTLE_ENGINE_LABEL = `${THROTTLE_ARCHITECTURE_NAME} ${THROTTLE_ENGINE_VERSION}`

export const THROTTLE_ENGINE_NAME = THROTTLE_MODULE_NAME
