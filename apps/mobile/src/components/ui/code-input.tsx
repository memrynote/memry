import { useRef, useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'

import { AppText } from '@/components/ui/app-text'
import type { Color } from '@/theme/colors'
import { radius } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

const CELL_HEIGHT = 56
const CELL_GAP = 10
const CARET_HEIGHT = 26
// One step above title3 and only ever a digit, so it stays local to this cell
// rather than entering the shared type scale.
const digit = { fontSize: 24, lineHeight: 30 }

type CellState = 'filled' | 'pending'

interface CellSurface {
  background: Color
  border: Color
  borderWidth: number
}

export interface CodeInputProps {
  value: string
  onChangeText: (next: string) => void
  length?: number
  editable?: boolean
  autoFocus?: boolean
  accessibilityLabel: string
}

/**
 * Fixed-length numeric code entry (Paper `04 · Auth — Sign in, code`).
 *
 * One real TextInput sits transparent over the cells rather than one input per
 * cell: iOS only offers one-time-code autofill to a single field, and per-cell
 * inputs turn backspace into focus bookkeeping that gets a keystroke wrong.
 */
export function CodeInput({
  value,
  onChangeText,
  length = 6,
  editable = true,
  autoFocus,
  accessibilityLabel
}: CodeInputProps) {
  const c = useColors()
  const input = useRef<TextInput>(null)
  const [focused, setFocused] = useState(false)

  const surfaces: Record<CellState, CellSurface> = {
    filled: { background: c.canvas.background, border: c.tint.base, borderWidth: 1.5 },
    pending: { background: c.canvas.surface, border: c.line.border, borderWidth: 1 }
  }

  const caretAt = focused && editable ? Math.min(value.length, length - 1) : -1

  return (
    <Pressable
      accessible={false}
      onPress={() => input.current?.focus()}
      style={styles.row}
      testID="code-input"
    >
      {Array.from({ length }, (_, index) => {
        const char = value[index]
        const surface = surfaces[char ? 'filled' : 'pending']
        return (
          <View
            key={index}
            style={[
              styles.cell,
              {
                backgroundColor: surface.background,
                borderColor: surface.border,
                borderWidth: surface.borderWidth
              }
            ]}
          >
            {char ? (
              <AppText variant="title3" style={digit}>
                {char}
              </AppText>
            ) : index === caretAt ? (
              <View style={[styles.caret, { backgroundColor: c.tint.base }]} />
            ) : null}
          </View>
        )
      })}
      <TextInput
        ref={input}
        value={value}
        onChangeText={(next) => onChangeText(next.replace(/\D/g, '').slice(0, length))}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={length}
        caretHidden
        editable={editable}
        autoFocus={autoFocus}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        accessibilityLabel={accessibilityLabel}
        style={styles.field}
      />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: CELL_GAP },
  cell: {
    flex: 1,
    height: CELL_HEIGHT,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center'
  },
  caret: { width: 2, height: CARET_HEIGHT },
  // Transparent rather than hidden: a display:none input takes no keystrokes
  // and iOS will not offer autofill to it.
  field: { ...StyleSheet.absoluteFill, opacity: 0 }
})
