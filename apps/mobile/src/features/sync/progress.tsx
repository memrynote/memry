import { StyleSheet, View } from 'react-native'
import { AppText } from '@/components/ui/app-text'
import type { FirstSyncProgress } from '@/sync/first-sync'
import { radius, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

/**
 * Determinate first-sync progress (T047 / FR-008). The app stays usable
 * behind it — this renders as a slim strip, not a blocking screen.
 */
export function FirstSyncProgressBar({ progress }: { progress: FirstSyncProgress | null }) {
  const c = useColors()
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
      <AppText variant="caption" color={c.text.secondary}>
        {label}
      </AppText>
      <View style={[styles.track, { backgroundColor: c.canvas.surfaceActive }]}>
        <View style={[styles.fill, { width: `${percent}%`, backgroundColor: c.tint.base }]} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: space.s16,
    paddingVertical: space.s8,
    gap: space.s4
  },
  track: { height: 4, borderRadius: radius.full, overflow: 'hidden' },
  fill: { height: 4, borderRadius: radius.full }
})
