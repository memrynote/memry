import { StyleSheet, View } from 'react-native'
import { ThemedText } from '@/components/themed-text'
import { Spacing } from '@/constants/theme'
import type { FirstSyncProgress } from '@/sync/first-sync'

/**
 * Determinate first-sync progress (T047 / FR-008). The app stays usable
 * behind it — this renders as a slim strip, not a blocking screen.
 */
export function FirstSyncProgressBar({ progress }: { progress: FirstSyncProgress | null }) {
  if (!progress || progress.phase === 'done') return null

  const label =
    progress.phase === 'refs'
      ? 'Preparing your vault…'
      : progress.phase === 'metadata'
        ? `Syncing items (${progress.itemsPulled}/${progress.itemsTotal})`
        : 'Fetching recent notes…'

  const percent = Math.round(progress.fraction * 100)

  return (
    <View
      style={styles.container}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: percent }}
    >
      <ThemedText type="small">{label}</ThemedText>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${percent}%` }]} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    gap: 4
  },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(127,127,127,0.25)',
    overflow: 'hidden'
  },
  fill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: '#ff671a'
  }
})
