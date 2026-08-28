import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { AppText } from '@/components/ui/app-text'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { AUTH_GUTTER } from '@/features/auth/chrome'
import { withThousands } from '@/lib/format'
import type { FirstSyncProgress } from '@/sync/first-sync'
import { nextRetryDelayMs, type SyncFailureReason, type VaultSyncState } from '@/sync/sync-state'
import { radius, sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

const BODY_TOP = 56
const LABEL_LANE = 96

const REASONS: Record<SyncFailureReason, string> = {
  locked: 'Vault locked',
  error: 'Network unreachable',
  refused: 'Server declined the request'
}

function ago(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'moments ago'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return `${Math.floor(hours / 24)} day${Math.floor(hours / 24) === 1 ? '' : 's'} ago`
}

function inWords(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `Automatic, in ${seconds} seconds`
  const minutes = Math.round(seconds / 60)
  return `Automatic, in ${minutes} minute${minutes === 1 ? '' : 's'}`
}

export interface SyncErrorScreenProps {
  state: VaultSyncState | null
  /** How far the interrupted run got, when it reported anything at all. */
  progress: FirstSyncProgress | null
  onRetry: () => void
  onContinue: () => void
}

/** Interrupted sync (Paper `11 · Auth — Sync error`). */
export function SyncErrorScreen({ state, progress, onRetry, onContinue }: SyncErrorScreenProps) {
  const c = useColors()
  // Anchored at mount: reading the clock during render is impure, and the
  // relative lines should not tick while the user reads them anyway.
  const [now] = useState(() => Date.now())
  const reason = state?.lastFailure ? REASONS[state.lastFailure.reason] : 'Sync failed'

  const rows: { label: string; value: string }[] = [
    { label: 'Reason', value: reason },
    {
      label: 'Last success',
      value: state?.lastSuccessAt ? ago(state.lastSuccessAt, now) : 'Not yet on this device'
    },
    { label: 'Next retry', value: state ? inWords(nextRetryDelayMs(state)) : 'On the next attempt' }
  ]

  const reached =
    progress && progress.itemsTotal > 0
      ? `We reached ${withThousands(progress.itemsPulled)} of ${withThousands(progress.itemsTotal)} items before the connection dropped. `
      : 'The download stopped before it finished. '

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.canvas.background }]}>
      <View style={styles.body}>
        <View style={styles.heading}>
          <Icon name="offline" size={28} color={c.text.primary} />
          <AppText variant="largeTitle">Sync stopped partway</AppText>
          <AppText variant="body" color={c.text.secondary}>
            {reached}Nothing was lost — everything already downloaded is readable right now.
          </AppText>
        </View>

        <View style={[styles.detail, { backgroundColor: c.canvas.surface }]}>
          {rows.map((row) => (
            <View key={row.label} style={styles.detailRow}>
              <View style={styles.labelLane}>
                <AppText variant="footnote" color={c.text.secondary}>
                  {row.label}
                </AppText>
              </View>
              <AppText variant="footnote" style={styles.value}>
                {row.value}
              </AppText>
            </View>
          ))}
        </View>

        <AppText variant="body" color={c.text.secondary}>
          This is not a data problem. Your vault on the server is intact, and this device will pick
          up where it left off.
        </AppText>
      </View>

      <View style={styles.actions}>
        <Button label="Try again" onPress={onRetry} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Continue with what's here"
          onPress={onContinue}
          style={styles.continue}
        >
          <AppText variant="body" color={c.tint.base}>
            Continue with what’s here
          </AppText>
        </Pressable>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  body: { flex: 1, paddingHorizontal: AUTH_GUTTER, paddingTop: BODY_TOP, gap: 28 },
  heading: { gap: space.s8 },
  detail: { padding: space.s16, borderRadius: radius.lg, gap: 10 },
  detailRow: { flexDirection: 'row', gap: space.s12 },
  // A fixed label lane keeps the three values on one left edge.
  labelLane: { width: LABEL_LANE, flexShrink: 0 },
  value: { flex: 1 },
  actions: { paddingHorizontal: AUTH_GUTTER, paddingBottom: space.s8, gap: space.s8 },
  continue: { height: sizes.tapTarget, alignItems: 'center', justifyContent: 'center' }
})
