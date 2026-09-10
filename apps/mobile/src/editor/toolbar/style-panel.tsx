import {
  BLOCK_COLOURS,
  TEXT_ALIGNMENTS,
  type BlockColour,
  type EditorToolbarSelection,
  type StyleAction
} from '@memry/contracts/webview-bridge'
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'

import { BLOCK_COLOUR_VALUES } from '@/editor/toolbar/block-colours'
import type { ToolbarIntents } from '@/editor/toolbar/bottom-chrome'
import { Glyph } from '@/editor/toolbar/glyph'
import { ALIGNMENT_LABELS, ALIGNMENT_PATHS, INDENT_PATHS } from '@/editor/toolbar/icon-paths'
import { PickerScroll, PickerShell, SectionLabel } from '@/editor/toolbar/pickers'
import { ToolbarButton } from '@/editor/toolbar/toolbar-button'
import { fontFamilies } from '@/theme/fonts'
import { radius, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

/**
 * Alignment, colour and indentation (#2102).
 *
 * The panel stays open after every tap, like the table panel's structure rows:
 * these are settings a reader nudges and looks at, not one-shot insertions.
 */
export function StylePanel({
  style,
  selection,
  intents
}: {
  style?: StyleProp<ViewStyle>
  selection: EditorToolbarSelection
  intents: ToolbarIntents
}) {
  const act = (action: StyleAction) => intents.act({ kind: 'style', action })

  return (
    <PickerShell
      title="Style"
      style={style}
      accessory={<StyleHeaderActions selection={selection} act={act} />}
    >
      <PickerScroll>
        <ColourRow
          title="Text colour"
          tone="text"
          active={selection.textColour}
          onPick={(colour) => act({ kind: 'text-colour', colour })}
        />
        <ColourRow
          title="Highlight"
          tone="background"
          active={selection.backgroundColour}
          onPick={(colour) => act({ kind: 'background-colour', colour })}
        />
      </PickerScroll>
    </PickerShell>
  )
}

/**
 * Alignment and indentation, icon-only, in the panel header (#2102).
 *
 * Six labelled cards took three stacked sections and most of the note with
 * them. The marks are self-describing and the labels carry the words, so the
 * header row does the same job in one line.
 */
function StyleHeaderActions({
  selection,
  act
}: {
  selection: EditorToolbarSelection
  act: (action: StyleAction) => void
}) {
  const c = useColors()
  return (
    <View style={styles.headerActions}>
      {selection.alignment !== null
        ? TEXT_ALIGNMENTS.map((alignment) => (
            <ToolbarButton
              key={alignment}
              label={ALIGNMENT_LABELS[alignment]}
              style={styles.iconButton}
              hitSlop={4}
              selected={selection.alignment === alignment}
              onPress={() => act({ kind: 'align', alignment })}
            >
              {(colour) => <Glyph paths={ALIGNMENT_PATHS[alignment]} colour={colour} size={19} />}
            </ToolbarButton>
          ))
        : null}
      {selection.alignment !== null ? (
        <View style={[styles.divider, { backgroundColor: c.line.border }]} />
      ) : null}
      <ToolbarButton
        label="Outdent"
        style={styles.iconButton}
        hitSlop={4}
        disabled={!selection.canUnnest}
        onPress={() => act({ kind: 'unnest' })}
      >
        {(colour) => <Glyph paths={INDENT_PATHS.unnest} colour={colour} size={19} />}
      </ToolbarButton>
      <ToolbarButton
        label="Indent"
        style={styles.iconButton}
        hitSlop={4}
        disabled={!selection.canNest}
        onPress={() => act({ kind: 'nest' })}
      >
        {(colour) => <Glyph paths={INDENT_PATHS.nest} colour={colour} size={19} />}
      </ToolbarButton>
    </View>
  )
}

/**
 * Ten swatches share one row instead of wrapping onto a second: the palette is
 * a single line at any phone width.
 */
function ColourRow({
  title,
  tone,
  active,
  onPick
}: {
  title: string
  tone: 'text' | 'background'
  active: BlockColour
  onPick: (colour: BlockColour) => void
}) {
  const c = useColors()
  return (
    <View>
      <SectionLabel label={title} />
      <View style={styles.colourRow}>
        {BLOCK_COLOURS.map((colour) => {
          const values = BLOCK_COLOUR_VALUES[colour]
          const selected = active === colour
          return (
            <ToolbarButton
              key={colour}
              label={`${title}: ${colour}`}
              style={styles.swatch}
              hitSlop={5}
              selected={selected}
              onPress={() => onPick(colour)}
            >
              {() => (
                <View
                  style={[
                    styles.chip,
                    {
                      borderWidth: selected ? 1 : StyleSheet.hairlineWidth,
                      borderColor: selected ? c.tint.text : c.line.border,
                      backgroundColor:
                        tone === 'background' ? (values.background ?? 'transparent') : 'transparent'
                    }
                  ]}
                >
                  <Text
                    style={[
                      styles.chipLetter,
                      { color: tone === 'text' ? (values.text ?? c.text.primary) : c.text.primary }
                    ]}
                  >
                    A
                  </Text>
                </View>
              )}
            </ToolbarButton>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  headerActions: {
    marginStart: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s2
  },
  iconButton: { width: 36, height: 36, borderRadius: 9 },
  divider: { width: 1, height: 20, marginHorizontal: 5 },
  colourRow: { flexDirection: 'row', gap: space.s2, paddingHorizontal: space.s8 },
  swatch: { flex: 1, width: 'auto', minWidth: 0, height: 34, borderRadius: 9 },
  chip: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md
  },
  chipLetter: { fontFamily: fontFamilies.sansSemiBold, fontSize: 13, lineHeight: 17 }
})
