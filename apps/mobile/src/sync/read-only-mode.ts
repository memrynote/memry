import type { ClientPolicy } from '@memry/contracts/sync-api'
import { createLogger } from '../lib/logger'

const log = createLogger('ReadOnlyMode')

/**
 * Client behaviour for the production-safety kit (T051 / FR-010).
 *
 * Sources of the read-only signal:
 *  - `clientPolicy` on `GET /sync/status` (present because we send
 *    `x-memry-client`) — how a flipped kill switch or raised version floor is
 *    learned WITHOUT attempting a write;
 *  - a write rejected with 403 `PLATFORM_WRITES_DISABLED` or 426
 *    `CLIENT_UPGRADE_REQUIRED` (Phase 4, once writes exist).
 *
 * Contract obligations: explicit banner with a plain explanation and an
 * update path; the outbox is PARKED, never dropped; auto-resume when the
 * policy clears. US1 is pull-only so parking is a no-op today — the state
 * machine and UI land now so the G2 kill-switch drill can exercise them.
 */

export type ReadOnlyReason = 'kill-switch' | 'version-gate' | null

export interface ReadOnlyState {
  readOnly: boolean
  reason: ReadOnlyReason
  /** Present on version-gate: the semver floor the server demands. */
  minWriteVersion?: string
}

type Listener = (state: ReadOnlyState) => void

let current: ReadOnlyState = { readOnly: false, reason: null }
const listeners = new Set<Listener>()

export function getReadOnlyState(): ReadOnlyState {
  return current
}

export function subscribeReadOnly(listener: Listener): () => void {
  listeners.add(listener)
  listener(current)
  return () => listeners.delete(listener)
}

function setState(next: ReadOnlyState): void {
  const changed =
    next.readOnly !== current.readOnly ||
    next.reason !== current.reason ||
    next.minWriteVersion !== current.minWriteVersion
  if (!changed) return
  current = next
  if (next.readOnly) {
    log.warn('Entering read-only mode', { reason: next.reason ?? 'unknown' })
  } else {
    log.info('Read-only mode cleared; outbox resumes')
  }
  for (const listener of listeners) listener(current)
}

/** Compare `a < b` for three-part semvers; malformed input compares equal. */
function semverBelow(a: string, b: string): boolean {
  const pa = a.split('+')[0].split('.').map(Number)
  const pb = b.split('+')[0].split('.').map(Number)
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false
  }
  return false
}

/**
 * Fold a status response's policy into the state machine. An ABSENT policy
 * (old server, response variance) means "no verdict" and never flips the
 * state — only an explicit verdict moves it, in either direction.
 */
export function applyClientPolicy(policy: ClientPolicy | undefined, appSemver: string): void {
  if (!policy) return
  if (!policy.writesEnabled) {
    setState({ readOnly: true, reason: 'kill-switch' })
    return
  }
  if (policy.minWriteVersion && semverBelow(appSemver, policy.minWriteVersion)) {
    setState({ readOnly: true, reason: 'version-gate', minWriteVersion: policy.minWriteVersion })
    return
  }
  setState({ readOnly: false, reason: null })
}

/** Phase 4 write-path hook: 403/426 rejections flip the state immediately. */
export function applyWriteRejection(code: string, minVersion?: string): void {
  if (code === 'PLATFORM_WRITES_DISABLED') {
    setState({ readOnly: true, reason: 'kill-switch' })
  } else if (code === 'CLIENT_UPGRADE_REQUIRED') {
    setState({ readOnly: true, reason: 'version-gate', minWriteVersion: minVersion })
  }
}
