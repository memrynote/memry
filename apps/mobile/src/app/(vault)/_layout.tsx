import { useCallback, useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
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
import { shutdownSyncSocket, startSyncSocket } from '@/sync/socket-controller'
import { getSyncEngine } from '@/sync/engine'
import { runFirstSyncIfNeeded, type FirstSyncProgress } from '@/sync/first-sync'
import { readSyncState, type VaultSyncState } from '@/sync/sync-state'
import { useColors } from '@/theme/use-colors'

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
  const c = useColors()
  const insets = useSafeAreaInsets()
  const [progress, setProgress] = useState<FirstSyncProgress | null>(null)
  const [syncing, setSyncing] = useState(false)
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
      startSyncSocket(vaultId)

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
      // Three things already leak here (two NetInfo subscriptions and the
      // engine registry, none of which have a removal path), so the socket
      // gets an explicit stop rather than becoming a fourth. Clearing the
      // background vault with it is what stops the 15-minute task syncing the
      // last vault forever after a sign-out.
      shutdownSyncSocket()
      setBackgroundSyncVault(null)
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
      {/*
        The shell owns the top inset, and always — not only when a banner is
        showing. Two owners is what put the banner's text under the clock and
        moved every screen down by the band's height the moment one appeared,
        so vault screens claim `left`/`right` only and this strip is here even
        when it holds nothing. Board 21 draws the status bar on the canvas with
        the band below it, which is why the colour is the canvas and not the
        band's surface.
      */}
      <View style={{ paddingTop: insets.top, backgroundColor: c.canvas.background }}>
        <SyncStatusBanner syncing={syncing} />
        <FirstSyncProgressBar progress={progress} />
      </View>
      <Stack screenOptions={{ headerShown: false }} />
    </>
  )
}
