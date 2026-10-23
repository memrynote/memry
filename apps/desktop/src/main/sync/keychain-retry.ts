import type { SyncStatusChangedEvent } from '@memry/contracts/ipc-events'

import { isKeychainUnreadableError } from '../crypto/vault-key-error'
import { createLogger } from '../lib/logger'
import { onKeychainRecovered } from '../secrets/secret-storage'

const log = createLogger('Sync:KeychainRetry')

/**
 * Sync startup could not read its secrets (refresh token or vault master key)
 * from this machine's secret storage. The secrets still exist — see the
 * false-absent guard in secrets/secret-storage.ts — so this is a paused state,
 * not a signed-out one. On Linux it is mostly a keyring that is still locked at
 * login, or a Secret Service that came up after Memry did (#2521).
 *
 * Before this, the failed start simply returned null: sync stayed dark for the
 * whole run with no status in the UI and no retry. Now the renderer gets an
 * explicit `keychain_unavailable` status, the start is retried on a backoff,
 * and immediately when a timed-out OS keychain call finally answers.
 *
 * Nothing here writes, deletes, or regenerates a secret.
 */
export const KEYCHAIN_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const

export const KEYCHAIN_UNAVAILABLE_STATUS: SyncStatusChangedEvent = {
  status: 'error',
  pendingCount: 0,
  error: 'errors:sync.keychainUnavailable',
  errorCategory: 'keychain_unavailable'
}

export interface KeychainRetryDeps {
  start: () => Promise<unknown>
  emitStatus: (event: SyncStatusChangedEvent) => void
}

let attempt = 0
let reported = false
// Bumped on every unreadable-keychain failure, so a retry can tell whether its
// own start failed the same way again.
let failureCount = 0
let retryTimer: NodeJS.Timeout | null = null
let unsubscribeRecovered: (() => void) | null = null

function cancelPendingRetry(): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  unsubscribeRecovered?.()
  unsubscribeRecovered = null
}

function retryStart(deps: KeychainRetryDeps, trigger: 'timer' | 'keychain-recovered'): void {
  cancelPendingRetry()
  const failuresBefore = failureCount
  deps.start().then(
    () => {
      if (failureCount !== failuresBefore) return
      // The secrets read this time. Whatever the start decided next (an engine,
      // local-only, a recovery prompt) emitted its own status; only forget the
      // episode here.
      log.info('Sync secrets readable again', { trigger, attempts: attempt })
      attempt = 0
      reported = false
    },
    (err: unknown) => {
      log.warn('Sync start retry after unreadable keychain failed', {
        trigger,
        error: err instanceof Error ? err.message : String(err)
      })
      // Still paused; keep a retry armed rather than strand the status.
      armRetry(deps)
    }
  )
}

function armRetry(deps: KeychainRetryDeps): void {
  if (!unsubscribeRecovered) {
    unsubscribeRecovered = onKeychainRecovered(() => retryStart(deps, 'keychain-recovered'))
  }
  if (!retryTimer) {
    const delay = KEYCHAIN_RETRY_DELAYS_MS[Math.min(attempt, KEYCHAIN_RETRY_DELAYS_MS.length - 1)]
    attempt += 1
    retryTimer = setTimeout(() => retryStart(deps, 'timer'), delay)
    retryTimer.unref?.()
  }
}

/**
 * If `error` means the sync secrets exist but could not be read this run, pause
 * sync instead of failing it: show the paused status and arm the next attempt.
 * Returns false for any other error, which the caller handles as before.
 */
export function pauseForKeychain(error: unknown, deps: KeychainRetryDeps): boolean {
  if (!isKeychainUnreadableError(error)) return false
  failureCount += 1
  const first = !reported
  reported = true
  // Re-sent on every failed attempt, not just the first: the startup attempt
  // can fail before any window listens, and a window that loads later must not
  // be stuck on a stale status.
  deps.emitStatus(KEYCHAIN_UNAVAILABLE_STATUS)
  armRetry(deps)

  // One error report per episode; the retries under it are expected.
  if (first) log.error('Sync paused: secrets unreadable from the OS keychain', error)
  else log.info('Sync still paused: secrets unreadable', { attempt, error: String(error) })
  return true
}

/** The paused status while an unreadable-keychain episode is open, else null. */
export function getKeychainUnavailableStatus(): SyncStatusChangedEvent | null {
  return reported ? KEYCHAIN_UNAVAILABLE_STATUS : null
}

/** Test-only: reset module state between cases. */
export function resetKeychainRetryForTests(): void {
  cancelPendingRetry()
  attempt = 0
  reported = false
  failureCount = 0
}
