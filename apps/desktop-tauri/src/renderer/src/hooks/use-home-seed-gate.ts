import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useSync } from '@/contexts/sync-context'

/**
 * Never leave Home blank because the server is unreachable. A paying user with
 * sync configured but no connection gets their board after this long.
 */
const SEED_GRACE_MS = 10_000

/**
 * Should Home seed its default board yet?
 *
 * Boards sync now, so a freshly-installed device must not mint a default board
 * before the first pull has had a chance to deliver the boards that already
 * exist on the account — otherwise every new device permanently adds one.
 *
 * `lastSyncAt` is the "a pull has completed" signal: main sets it first when a
 * pull completes, and only then do pushes move it (push-coordinator, and the
 * ITEM_SYNCED case of syncReducer). Deliberately NOT gating on
 * `status === 'idle'`: sync-core-handlers returns `{ status: 'idle' }` when the
 * engine has not started, which is indistinguishable from "fully synced".
 * `lastSyncAt` is persisted in `sync_state`, so an already-synced existing
 * device passes on first render — zero regression for current installs.
 *
 * The grace period does not cut a first sync short: a fresh device can spend
 * longer than that on packs before the page carrying the boards lands.
 */
export function useHomeSeedGate(): boolean {
  const { state: authState } = useAuth()
  const { state: syncState } = useSync()

  const [graceElapsed, setGraceElapsed] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setGraceElapsed(true), SEED_GRACE_MS)
    return () => clearTimeout(timer)
  }, [])

  // No account means nothing will ever arrive from a peer. 'idle' and
  // 'checking' mean the auth check has not answered yet, not "no account".
  const authResolved = authState.status !== 'idle' && authState.status !== 'checking'
  if (authResolved && authState.status !== 'authenticated') return true
  // Free plan never produces a `lastSyncAt`. `'local_only'` is absent from the
  // renderer's SyncStatus union but main really does send it (sync-core-handlers
  // getStatus), so read it off the raw string.
  if ((syncState.status as string) === 'local_only') return true
  if (syncState.lastSyncAt != null) return true
  const transferring = syncState.status === 'syncing' || syncState.initialSyncProgress != null
  return graceElapsed && !transferring
}
