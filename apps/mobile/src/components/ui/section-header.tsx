import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { AppText } from '@/components/ui/app-text'
import { sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export interface SectionHeaderProps {
  label: string
  count?: number
  style?: StyleProp<ViewStyle>
}

export function SectionHeader({ label, count, style }: SectionHeaderProps) {
  const c = useColors()

  return (
    <View
      accessibilityRole="header"
      style={[styles.container, { backgroundColor: c.canvas.background }, style]}
    >
      <AppText variant="captionEmphasis" color={c.text.secondary}>
        {label}
      </AppText>
      {count === undefined ? null : (
        <AppText variant="caption" color={c.text.secondary}>
          {count}
        </AppText>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    height: 40,
    paddingTop: sizes.gutter,
    paddingBottom: space.s8,
    paddingHorizontal: sizes.gutter,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  }
})
