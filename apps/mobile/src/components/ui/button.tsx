import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  type StyleProp,
  type ViewStyle
} from 'react-native'

import { AppText } from '@/components/ui/app-text'
import type { Color } from '@/theme/colors'
import { radius, sizes } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export type ButtonVariant = 'primary' | 'tint' | 'secondary' | 'outline' | 'destructive' | 'ghost'

export interface ButtonProps {
  label: string
  onPress?: () => void
  variant?: ButtonVariant
  accessibilityLabel?: string
  disabled?: boolean
  /** Swaps the label for a spinner and blocks presses while a request is out. */
  busy?: boolean
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
  disabled = false,
  busy = false,
  style
}: ButtonProps) {
  const c = useColors()
  const surfaces: Record<ButtonVariant, ButtonSurface> = {
    primary: { background: c.ui.primary, label: c.ui.primaryForeground },
    // tint.text rather than tint.base: white on the accent at fill strength is
    // 2.8:1, and a filled action's label is not large text.
    tint: { background: c.tint.text, label: c.tint.foreground },
    secondary: { background: c.canvas.surface, border: c.line.border, label: c.text.primary },
    outline: { background: c.canvas.background, border: c.line.border, label: c.text.primary },
    destructive: { background: c.ui.destructive, label: c.ui.destructiveForeground },
    ghost: { label: c.tint.text }
  }
  // Disabled is its own surface in the design system, not the variant's
  // surface dimmed: a filled button at reduced opacity still reads as pressable.
  const surface = disabled
    ? { background: c.canvas.surfaceActive, label: c.text.tertiary }
    : surfaces[variant]
  const inert = disabled || busy

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: inert, busy }}
      disabled={inert}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: surface.background,
          borderColor: surface.border,
          borderWidth: surface.border ? 1 : 0
        },
        !inert && pressed && styles.pressed,
        style
      ]}
    >
      {busy ? (
        <ActivityIndicator color={surface.label} />
      ) : (
        <AppText variant="bodyEmphasis" color={surface.label}>
          {label}
        </AppText>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  base: {
    height: sizes.control,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center'
  },
  pressed: { transform: [{ scale: 0.97 }] }
})
