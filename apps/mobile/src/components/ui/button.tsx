import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native'

import { AppText } from '@/components/ui/app-text'
import type { Color } from '@/theme/colors'
import { radius } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export type ButtonVariant = 'primary' | 'tint' | 'secondary' | 'destructive' | 'ghost'

export interface ButtonProps {
  label: string
  onPress?: () => void
  variant?: ButtonVariant
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}

interface ButtonSurface {
  background?: Color
  border?: Color
  label: Color
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  accessibilityLabel,
  style
}: ButtonProps) {
  const c = useColors()
  const surfaces: Record<ButtonVariant, ButtonSurface> = {
    primary: { background: c.ui.primary, label: c.ui.primaryForeground },
    tint: { background: c.tint.base, label: c.tint.foreground },
    secondary: { background: c.canvas.surface, border: c.line.border, label: c.text.primary },
    destructive: { background: c.ui.destructive, label: c.ui.destructiveForeground },
    ghost: { label: c.tint.base }
  }
  const surface = surfaces[variant]

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: surface.background,
          borderColor: surface.border,
          borderWidth: surface.border ? 1 : 0
        },
        pressed && styles.pressed,
        style
      ]}
    >
      <AppText variant="bodyEmphasis" color={surface.label}>
        {label}
      </AppText>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  base: {
    height: 50,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center'
  },
  pressed: { transform: [{ scale: 0.97 }] }
})
