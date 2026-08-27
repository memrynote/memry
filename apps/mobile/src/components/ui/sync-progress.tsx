import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { AppText } from '@/components/ui/app-text'
import { space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export interface SyncProgressProps {
  label: string
  detail?: string
  progress: number
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}

export function SyncProgress({
  label,
  detail,
  progress,
  accessibilityLabel,
  style
}: SyncProgressProps) {
  const c = useColors()
  const clamped = Math.min(1, Math.max(0, progress))

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      style={[styles.container, style]}
    >
      <View style={styles.labelRow}>
        <AppText variant="subhead" color={c.text.secondary}>
          {label}
        </AppText>
        {detail ? (
          <AppText variant="footnote" color={c.text.secondary}>
            {detail}
          </AppText>
        ) : null}
      </View>
      <View style={[styles.track, { backgroundColor: c.canvas.surfaceActive }]}>
        <View style={[styles.fill, { backgroundColor: c.tint.base, width: `${clamped * 100}%` }]} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { height: 46, gap: space.s8 },
  labelRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 }
})
