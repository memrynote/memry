import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { AppText } from '@/components/ui/app-text'
import { sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export type SectionHeaderProps = { label: string; style?: StyleProp<ViewStyle> } & (
  | { count?: number; action?: never }
  | { action: { label: string; onPress: () => void }; count?: never }
)

export function SectionHeader({ label, count, action, style }: SectionHeaderProps) {
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
      {action ? (
        <Pressable accessibilityRole="button" hitSlop={10} onPress={action.onPress}>
          <AppText variant="caption" color={c.tint.base}>
            {action.label}
          </AppText>
        </Pressable>
      ) : null}
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
