import { Pressable, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'

import { Icon } from '@/components/ui/icon'
import { sizes } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

/** Auth boards inset 24, wider than the 16 gutter the vault shell uses. */
export const AUTH_GUTTER = 24

export interface BackBarProps {
  onPress?: () => void
  label?: string
}

/**
 * The bare chevron the auth boards use instead of a titled nav bar. It sits on
 * the 16 inset, not the 24 auth gutter, so the glyph optically lines up with
 * the text block below it.
 */
export function BackBar({ onPress, label = 'Back' }: BackBarProps) {
  const c = useColors()
  return (
    <View style={styles.bar}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        hitSlop={12}
        onPress={onPress ?? (() => router.back())}
        style={({ pressed }) => pressed && styles.pressed}
      >
        <Icon name="chevron-left" size={24} color={c.tint.text} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    height: sizes.navBar,
    justifyContent: 'center',
    paddingHorizontal: sizes.gutter
  },
  pressed: { transform: [{ scale: 0.97 }] }
})
