import { useState } from 'react'
import {
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle
} from 'react-native'

import { AppText } from '@/components/ui/app-text'
import type { Color } from '@/theme/colors'
import { space } from '@/theme/primitives'
import { textStyles } from '@/theme/text-styles'
import { useColors } from '@/theme/use-colors'

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  error?: string
  style?: StyleProp<ViewStyle>
}

type TextFieldState = 'default' | 'filled' | 'focused' | 'error'

interface TextFieldSurface {
  border: Color
  borderWidth: number
}

export function TextField({ error, style, value, onFocus, onBlur, ...rest }: TextFieldProps) {
  const c = useColors()
  const [focused, setFocused] = useState(false)
  const surfaces: Record<TextFieldState, TextFieldSurface> = {
    default: { border: c.line.input, borderWidth: 1 },
    filled: { border: c.line.input, borderWidth: 1 },
    focused: { border: c.tint.base, borderWidth: 2 },
    error: { border: c.ui.destructive, borderWidth: 2 }
  }
  const state: TextFieldState = error ? 'error' : focused ? 'focused' : value ? 'filled' : 'default'
  const surface = surfaces[state]

  return (
    <View style={style}>
      <View
        style={[
          styles.box,
          {
            backgroundColor: c.canvas.background,
            borderColor: surface.border,
            borderWidth: surface.borderWidth
          }
        ]}
      >
        <TextInput
          value={value}
          placeholderTextColor={c.text.tertiary}
          onFocus={(event) => {
            setFocused(true)
            onFocus?.(event)
          }}
          onBlur={(event) => {
            setFocused(false)
            onBlur?.(event)
          }}
          style={[styles.input, textStyles.body, { color: c.text.primary }]}
          {...rest}
        />
      </View>
      {error ? (
        <AppText
          variant="footnote"
          accessibilityRole="alert"
          // destructiveText not destructive, because the deviations section splits fill from text
          color={c.ui.destructiveText}
          style={styles.message}
        >
          {error}
        </AppText>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  box: {
    height: 50,
    borderRadius: 10,
    paddingHorizontal: 14,
    justifyContent: 'center'
  },
  // padding 0 because Android gives TextInput its own default padding
  input: { padding: 0 },
  message: { marginTop: space.s6 }
})
