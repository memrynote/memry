import type { ReactNode } from 'react'
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native'

import type { Color } from '@/theme/colors'
import { radius, sizes } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export interface ToolbarButtonProps {
  label: string
  onPress: () => void
  /** Painted like a press for as long as the state holds, and takes the accent. */
  selected?: boolean
  disabled?: boolean
  /** Set when the visual is smaller than the 44pt floor. */
  hitSlop?: number
  /** The resting fill. A press still paints over it, as the DOM's `:active` did. */
  background?: Color
  style?: StyleProp<ViewStyle>
  children: (colour: Color) => ReactNode
}

export function ToolbarButton({
  label,
  onPress,
  selected = false,
  disabled = false,
  hitSlop,
  background,
  style,
  children
}: ToolbarButtonProps) {
  const c = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        background ? { backgroundColor: background } : null,
        style,
        disabled ? styles.disabled : null,
        selected ? { backgroundColor: c.canvas.surfaceActive } : null,
        // A button with its own fill keeps it while pressed; the ink-filled
        // Add button would otherwise lose its paper label under the wash.
        pressed
          ? background && !selected
            ? styles.pressedFill
            : { backgroundColor: c.canvas.surfaceActive }
          : null
      ]}
    >
      {children(selected ? c.tint.text : c.text.primary)}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: {
    width: sizes.tapTarget,
    height: sizes.tapTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg
  },
  disabled: { opacity: 0.35 },
  pressedFill: { opacity: 0.7 }
})
