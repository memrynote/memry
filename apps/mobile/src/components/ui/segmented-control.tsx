import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { AppText } from '@/components/ui/app-text'
import { space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export interface SegmentedControlProps<T extends string> {
  segments: readonly T[]
  value: T
  onChange: (value: T) => void
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}

export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  accessibilityLabel,
  style
}: SegmentedControlProps<T>) {
  const c = useColors()

  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      style={[styles.track, { backgroundColor: c.canvas.surface }, style]}
    >
      {segments.map((segment) => {
        const selected = segment === value
        return (
          <Pressable
            key={segment}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(segment)}
            style={[
              styles.segment,
              selected && styles.segmentSelected,
              selected && { backgroundColor: c.canvas.card }
            ]}
          >
            <AppText variant="subheadEmphasis" color={selected ? c.text.primary : c.text.secondary}>
              {segment}
            </AppText>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  track: {
    height: 34,
    borderRadius: 9,
    padding: space.s2,
    gap: space.s2,
    flexDirection: 'row'
  },
  segment: {
    flex: 1,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center'
  },
  segmentSelected: {
    boxShadow: [{ offsetX: 0, offsetY: 1, blurRadius: 3, color: 'rgba(0, 0, 0, 0.08)' }]
  }
})
