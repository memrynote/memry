import { useEffect, useState } from 'react'
import { Stack } from 'expo-router'
import { FirstSyncProgressBar } from '@/features/sync/progress'
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

const log = createLogger('VaultLayout')

/**
 * Vault shell: wires foreground/background sync (T052) and runs the windowed
 * first sync (T047) with the app fully usable behind the progress strip.
 */
export default function VaultLayout() {
  const [progress, setProgress] = useState<FirstSyncProgress | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [unsyncedCount, setUnsyncedCount] = useState(0)

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
          if (!cancelled) setProgress(p)
        })
        if (!ranFirst) {
          await getSyncEngine(vaultId).sync()
        }
      } catch (err) {
        log.warn('Initial sync pass failed', {
          error: err instanceof Error ? err.message : String(err)
        })
        // A dead run must not leave a frozen 0% bar on screen forever.
        if (!cancelled) setProgress(null)
      } finally {
        if (!cancelled) setSyncing(false)
      }
    })()
    return () => {
      cancelled = true
    }
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

  return (
    <>
      <SyncStatusBanner syncing={syncing} unsyncedCount={unsyncedCount} />
      <FirstSyncProgressBar progress={progress} />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  )
}
