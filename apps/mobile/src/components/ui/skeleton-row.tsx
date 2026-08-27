import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { radius, sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export interface SkeletonRowProps {
  style?: StyleProp<ViewStyle>
}

export function SkeletonRow({ style }: SkeletonRowProps) {
  const c = useColors()

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.container, { backgroundColor: c.canvas.background }, style]}
    >
      <View style={[styles.barWide, { backgroundColor: c.canvas.surfaceActive }]} />
      <View style={[styles.barNarrow, { backgroundColor: c.canvas.surfaceActive }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    height: 64,
    paddingVertical: 14,
    paddingHorizontal: sizes.gutter,
    gap: space.s8,
    justifyContent: 'center'
  },
  barWide: { width: 220, height: 12, borderRadius: radius.sm },
  barNarrow: { width: 140, height: 12, borderRadius: radius.sm }
})
