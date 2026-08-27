import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native'

import { Icon } from '@/components/ui/icon'
import { radius } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export interface FABProps {
  onPress: () => void
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}

export function FAB({ onPress, accessibilityLabel, style }: FABProps) {
  const c = useColors()

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: c.ui.primary },
        pressed && styles.pressed,
        style
      ]}
    >
      <Icon name="plus" size={26} color={c.ui.primaryForeground} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  base: {
    width: 56,
    height: 56,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: [{ offsetX: 0, offsetY: 6, blurRadius: 9, color: 'rgba(0, 0, 0, 0.18)' }]
  },
  pressed: { transform: [{ scale: 0.97 }] }
})
