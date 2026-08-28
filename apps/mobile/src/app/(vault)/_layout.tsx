import { useCallback, useEffect, useRef, useState } from 'react'
import { Stack } from 'expo-router'
import { FirstSyncScreen } from '@/features/sync/first-sync-screen'
import { FirstSyncProgressBar } from '@/features/sync/progress'
import { SyncErrorScreen } from '@/features/sync/sync-error-screen'
import { SyncStatusBanner } from '@/features/sync/status'
import { createLogger } from '@/lib/logger'
import { loadCurrentVaultId } from '@/sync/auth-client'
import {
  registerBackgroundSync,
  setBackgroundSyncVault,
  wireForegroundSync
} from '@/sync/background'
import { getEditorSession } from '@/editor/session'
import { getSyncEngine } from '@/sync/engine'
import { runFirstSyncIfNeeded, type FirstSyncProgress } from '@/sync/first-sync'
import { readSyncState, type VaultSyncState } from '@/sync/sync-state'

const log = createLogger('VaultLayout')

/**
 * What covers the shell during the very first download.
 *
 * A union rather than a pair of booleans, because "showing progress" and
 * "showing the failure" are mutually exclusive and a boolean pair can express
 * both at once.
 */
type Overlay =
  { kind: 'none' } | { kind: 'first-sync' } | { kind: 'failed'; state: VaultSyncState | null }

/**
 * Vault shell: wires foreground/background sync (T052) and runs the windowed
 * first sync (T047) with the app fully usable behind the progress strip.
 */
export default function VaultLayout() {
  const [progress, setProgress] = useState<FirstSyncProgress | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [unsyncedCount, setUnsyncedCount] = useState(0)
  const [overlay, setOverlay] = useState<Overlay>({ kind: 'none' })
  const [attempt, setAttempt] = useState(0)
  // Once the user has asked for the app, a later phase event must not pull the
  // full-screen view back over it. A ref, because the progress callback closes
  // over this and re-reading state there would see the mount-time value.
  const dismissed = useRef(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const vaultId = await loadCurrentVaultId()
      if (!vaultId || cancelled) return
      setBackgroundSyncVault(vaultId)
      wireForegroundSync()
      void registerBackgroundSync()

      try {
        setSyncing(true)
        const ranFirst = await runFirstSyncIfNeeded(vaultId, (p) => {
          if (cancelled) return
          setProgress(p)
          if (p.phase === 'done') {
            setOverlay({ kind: 'none' })
            return
          }
          if (!dismissed.current) setOverlay({ kind: 'first-sync' })
        })
        if (!ranFirst) {
          await getSyncEngine(vaultId).sync()
        }
      } catch (err) {
        log.warn('Initial sync pass failed', {
          error: err instanceof Error ? err.message : String(err)
        })
        // A dead run must not leave a frozen 0% bar on screen forever.
        if (cancelled) return
        const state = await readSyncState(vaultId).catch(() => null)
        if (cancelled) return
        setOverlay(dismissed.current ? { kind: 'none' } : { kind: 'failed', state })
      } finally {
        if (!cancelled) setSyncing(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [attempt])

  const dismissOverlay = useCallback(() => {
    dismissed.current = true
    setOverlay({ kind: 'none' })
  }, [])

  const retry = useCallback(() => {
    setOverlay({ kind: 'first-sync' })
    setAttempt((n) => n + 1)
  }, [])

  /**
   * Outbox depth, polled rather than pushed.
   *
   * The queue is written from several places (editor persists, note ops, the
   * drain worker), and a change notification from each of them would be four
   * ways to forget one. A 2 s poll of a COUNT over a small table is cheap and
   * cannot go stale.
   */
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null

    // The poll re-tries its own setup instead of running once at mount. The
    // vault id and the session are not necessarily ready on the first frame,
    // and a setup that gave up there left the banner at zero for the whole
    // session — including the one the offline matrix waits on to declare the
    // outbox drained.
    const tick = async (): Promise<void> => {
      const vaultId = await loadCurrentVaultId()
      if (!vaultId || cancelled) return
      const session = await getEditorSession(vaultId)
      const depth = await session.outbox.pendingCount()
      if (!cancelled) setUnsyncedCount(depth)
    }

    void tick().catch((err: unknown) => {
      log.debug('Outbox depth poll failed', {
        error: err instanceof Error ? err.message : String(err)
      })
    })
    timer = setInterval(() => void tick().catch(() => {}), 2_000)

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [])

  if (overlay.kind === 'first-sync' && progress) {
    return <FirstSyncScreen progress={progress} onDismiss={dismissOverlay} />
  }
  if (overlay.kind === 'failed') {
    return (
      <SyncErrorScreen
        state={overlay.state}
        progress={progress}
        onRetry={retry}
        onContinue={dismissOverlay}
      />
    )
  }

  return (
    <>
      <SyncStatusBanner syncing={syncing} unsyncedCount={unsyncedCount} />
      <FirstSyncProgressBar progress={progress} />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  )
}
