import { useRef, useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'

import { AppText } from '@/components/ui/app-text'
import { spill } from '@/features/auth/phrase-entry'
import type { Color } from '@/theme/colors'
import { radius, space } from '@/theme/primitives'
import { textStyles } from '@/theme/text-styles'
import { useColors } from '@/theme/use-colors'

const CELL_HEIGHT = 42
const COLUMNS = 3

type CellState = 'focused' | 'resting'

interface CellSurface {
  background: Color
  border: Color
  borderWidth: number
}

export interface PhraseGridProps {
  words: string[]
  onChange: (words: string[]) => void
  focused: number
  onFocusIndex: (index: number) => void
  editable?: boolean
}

/**
 * The recovery phrase entry grid (Paper `08 · Auth — Unlock, recovery phrase`).
 *
 * One input per word rather than one field for the whole phrase, so a typo
 * lands in a numbered slot the user can see. Whitespace in any cell splits and
 * spills forward, which is what makes pasting a whole phrase work without a
 * separate paste affordance.
 */
export function PhraseGrid({
  words,
  onChange,
  focused,
  onFocusIndex,
  editable = true
}: PhraseGridProps) {
  const c = useColors()
  const inputs = useRef<(TextInput | null)[]>([])
  // Cells are measured off the grid rather than fixed at the board's 106,
  // which leaves a ragged right edge on a 402 screen. Undefined for the first
  // frame, so the row sizes to content once and then snaps to thirds.
  const [gridWidth, setGridWidth] = useState(0)
  const cellWidth = gridWidth > 0 ? (gridWidth - space.s8 * (COLUMNS - 1)) / COLUMNS : undefined

  const surfaces: Record<CellState, CellSurface> = {
    focused: { background: c.canvas.background, border: c.tint.base, borderWidth: 1.5 },
    resting: { background: c.canvas.surface, border: c.line.border, borderWidth: 1 }
  }

  const write = (index: number, text: string) => {
    const result = spill(words, index, text)
    onChange(result.words)
    if (result.landing !== index) inputs.current[result.landing]?.focus()
  }

  return (
    <View style={styles.grid} onLayout={(event) => setGridWidth(event.nativeEvent.layout.width)}>
      {words.map((word, index) => {
        const surface = surfaces[index === focused ? 'focused' : 'resting']
        return (
          <Pressable
            key={index}
            accessible={false}
            onPress={() => inputs.current[index]?.focus()}
            style={[
              styles.cell,
              {
                width: cellWidth,
                backgroundColor: surface.background,
                borderColor: surface.border,
                borderWidth: surface.borderWidth
              }
            ]}
          >
            <AppText variant="caption" color={c.text.tertiary}>
              {index + 1}
            </AppText>
            <TextInput
              ref={(node) => {
                inputs.current[index] = node
              }}
              value={word}
              onChangeText={(text) => write(index, text)}
              onFocus={() => onFocusIndex(index)}
              onSubmitEditing={() => inputs.current[index + 1]?.focus()}
              onKeyPress={({ nativeEvent }) => {
                // Backspace on an empty cell walks back, so correcting a word
                // three slots ago does not need an accurate tap.
                if (nativeEvent.key === 'Backspace' && word.length === 0 && index > 0) {
                  inputs.current[index - 1]?.focus()
                }
              }}
              editable={editable}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              returnKeyType={index === words.length - 1 ? 'done' : 'next'}
              accessibilityLabel={`Word ${index + 1}`}
              style={[styles.input, textStyles.mono, { color: c.text.primary }]}
            />
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s8 },
  cell: {
    height: CELL_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s6,
    paddingHorizontal: 10,
    borderRadius: radius.md
  },
  input: { flex: 1, padding: 0 }
})
