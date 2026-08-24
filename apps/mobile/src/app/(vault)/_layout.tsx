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

  return (
    <>
      <SyncStatusBanner syncing={syncing} />
      <FirstSyncProgressBar progress={progress} />
      <Stack screenOptions={{ headerShown: true }} />
    </>
  )
}
