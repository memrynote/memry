import type { EditorToolbarSelection, InlineStyle } from '@memry/contracts/webview-bridge'
import {
  I18nManager,
  Platform,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle
} from 'react-native'

import type { ToolbarIntents, ToolbarPanel } from '@/editor/toolbar/bottom-chrome'
import { Glyph } from '@/editor/toolbar/glyph'
import { TOOLBAR_PATHS } from '@/editor/toolbar/icon-paths'
import { ToolbarButton } from '@/editor/toolbar/toolbar-button'
import { fontFamilies } from '@/theme/fonts'
import { radius, sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export interface ToolbarRowProps {
  /** The open panel, or `null` while the row sits on the keyboard. */
  panel: ToolbarPanel | null
  selection: EditorToolbarSelection
  intents: ToolbarIntents
}

export function MainRow({ panel, selection, intents }: ToolbarRowProps) {
  const c = useColors()
  const surface = { backgroundColor: c.canvas.background, borderTopColor: c.line.border }
  const toggle = (target: ToolbarPanel) => {
    if (panel === target) intents.closePanel()
    else intents.openPanel(target)
  }

  return (
    <View
      accessibilityRole="toolbar"
      accessibilityLabel="Editor"
      style={[styles.row, styles.mainRow, surface]}
    >
      <ToolbarButton
        label="Insert blocks"
        selected={panel === 'blocks'}
        onPress={() => toggle('blocks')}
      >
        {(colour) => <Glyph paths={TOOLBAR_PATHS.insertBlocks} colour={colour} />}
      </ToolbarButton>
      <ToolbarButton
        label="Formatting"
        style={styles.formattingButton}
        onPress={() => intents.showRow('formatting')}
      >
        {(colour) => <Text style={[styles.aa, { color: colour }]}>Aa</Text>}
      </ToolbarButton>
      <ToolbarButton
        label="Insert wiki link"
        onPress={() => intents.act({ kind: 'insert-wiki-link' })}
      >
        {(colour) => <Text style={[styles.wiki, { color: colour }]}>[[</Text>}
      </ToolbarButton>
      <ToolbarButton label="Insert image" onPress={() => intents.act({ kind: 'insert-image' })}>
        {(colour) => <Glyph paths={TOOLBAR_PATHS.image} colour={colour} />}
      </ToolbarButton>
      {selection.table !== null ? (
        <ToolbarButton label="Table" selected={panel === 'table'} onPress={() => toggle('table')}>
          {(colour) => <Text style={[styles.table, { color: colour }]}>▦</Text>}
        </ToolbarButton>
      ) : null}
      {panel === null ? (
        <>
          <TurnIntoChip blockLabel={selection.blockLabel} intents={intents} />
          <ToolbarButton
            label="Block actions"
            onPress={() => intents.act({ kind: 'open-block-actions' })}
          >
            {(colour) => <Glyph paths={TOOLBAR_PATHS.blockActions} colour={colour} />}
          </ToolbarButton>
        </>
      ) : null}
      <View style={styles.spacer} />
      <ToolbarButton
        label="Undo"
        style={styles.historyButton}
        hitSlop={2}
        onPress={() => intents.act({ kind: 'undo' })}
      >
        {(colour) => <Glyph paths={TOOLBAR_PATHS.undo} colour={colour} />}
      </ToolbarButton>
      <ToolbarButton
        label="Redo"
        style={styles.historyButton}
        hitSlop={2}
        onPress={() => intents.act({ kind: 'redo' })}
      >
        {(colour) => <Glyph paths={TOOLBAR_PATHS.redo} colour={colour} />}
      </ToolbarButton>
      {panel === null ? (
        <ToolbarButton
          label="Hide keyboard"
          style={styles.historyButton}
          hitSlop={2}
          onPress={() => intents.act({ kind: 'blur' })}
        >
          {(colour) => <Glyph paths={TOOLBAR_PATHS.hideKeyboard} colour={colour} />}
        </ToolbarButton>
      ) : (
        <ToolbarButton
          label="Dismiss picker"
          style={styles.historyButton}
          hitSlop={2}
          onPress={intents.closePanel}
        >
          {(colour) => <Glyph paths={TOOLBAR_PATHS.dismissPicker} colour={colour} />}
        </ToolbarButton>
      )}
    </View>
  )
}

const INLINE_STYLE_BUTTONS: readonly { style: InlineStyle; label: string; glyph: string }[] = [
  { style: 'bold', label: 'Bold', glyph: 'B' },
  { style: 'italic', label: 'Italic', glyph: 'I' },
  { style: 'underline', label: 'Underline', glyph: 'U' },
  { style: 'strike', label: 'Strikethrough', glyph: 'S' }
]

const INLINE_STYLE_TEXT: Readonly<Partial<Record<InlineStyle, StyleProp<TextStyle>>>> = {
  // The platform serif rather than Crimson Pro: no italic face of it is
  // registered, and a synthesised slant at regular weight is not the DOM's
  // Georgia italic at 600.
  italic: {
    fontFamily: Platform.select({ ios: 'Georgia', default: 'serif' }),
    fontStyle: 'italic',
    fontWeight: '600'
  },
  underline: { textDecorationLine: 'underline' },
  strike: { textDecorationLine: 'line-through' }
}

export function FormattingRow({ panel, selection, intents }: ToolbarRowProps) {
  const c = useColors()
  const surface = { backgroundColor: c.canvas.background, borderTopColor: c.line.border }

  return (
    <View
      accessibilityRole="toolbar"
      accessibilityLabel="Formatting"
      style={[styles.row, styles.formattingRow, surface]}
    >
      <ToolbarButton label="Back to editor toolbar" onPress={() => intents.showRow('main')}>
        {(colour) => (
          <Glyph paths={TOOLBAR_PATHS.back} colour={colour} mirrored={I18nManager.isRTL} />
        )}
      </ToolbarButton>
      <TurnIntoChip blockLabel={selection.blockLabel} intents={intents} style={styles.formatItem} />
      {INLINE_STYLE_BUTTONS.map((item) => (
        <ToolbarButton
          key={item.style}
          label={item.label}
          style={styles.formatItem}
          selected={selection.activeStyles[item.style]}
          onPress={() => intents.act({ kind: 'toggle-style', style: item.style })}
        >
          {(colour) => (
            <Text style={[styles.formatGlyph, INLINE_STYLE_TEXT[item.style], { color: colour }]}>
              {item.glyph}
            </Text>
          )}
        </ToolbarButton>
      ))}
      <ToolbarButton
        label="Bulleted list"
        style={styles.formatItem}
        onPress={() => intents.act({ kind: 'toggle-bulleted-list' })}
      >
        {(colour) => <Glyph paths={TOOLBAR_PATHS.bulletedList} colour={colour} />}
      </ToolbarButton>
      <ToolbarButton
        label="Link"
        style={styles.formatItem}
        onPress={() => intents.openPanel('link-prompt')}
      >
        {(colour) => <Glyph paths={TOOLBAR_PATHS.link} colour={colour} />}
      </ToolbarButton>
      <ToolbarButton
        label="Inline code"
        style={styles.formatItem}
        selected={selection.activeStyles.code}
        onPress={() => intents.act({ kind: 'toggle-style', style: 'code' })}
      >
        {(colour) => <Glyph paths={TOOLBAR_PATHS.inlineCode} colour={colour} />}
      </ToolbarButton>
      <ToolbarButton
        label="Style"
        style={styles.formatItem}
        selected={panel === 'style'}
        onPress={() => (panel === 'style' ? intents.closePanel() : intents.openPanel('style'))}
      >
        {(colour) => <Glyph paths={TOOLBAR_PATHS.style} colour={colour} />}
      </ToolbarButton>
    </View>
  )
}

function TurnIntoChip({
  blockLabel,
  intents,
  style
}: {
  blockLabel: string
  intents: ToolbarIntents
  style?: StyleProp<ViewStyle>
}) {
  const c = useColors()
  return (
    <ToolbarButton
      label={`Turn into. Current block: ${blockLabel}`}
      style={style}
      onPress={() => intents.openPanel('turn-into')}
    >
      {() => (
        <View style={[styles.chip, { backgroundColor: c.canvas.surfaceActive }]}>
          <Text style={[styles.chipLabel, { color: c.text.primary }]}>{blockLabel}</Text>
        </View>
      )}
    </ToolbarButton>
  )
}

const styles = StyleSheet.create({
  row: {
    height: sizes.row,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.s8,
    borderTopWidth: StyleSheet.hairlineWidth
  },
  mainRow: { gap: space.s2 },
  formattingRow: { justifyContent: 'space-between' },
  formattingButton: { width: 46 },
  historyButton: { width: 40 },
  // `flex: 1 1 42px; min-inline-size: 0` in the DOM: a hard 42pt floor would
  // overflow the row on every phone narrower than 440pt.
  formatItem: { flexBasis: 42, flexGrow: 1, flexShrink: 1, width: 'auto', minWidth: 0 },
  spacer: { flex: 1 },
  aa: { fontFamily: fontFamilies.sansMedium, fontSize: 18, lineHeight: 22, letterSpacing: -0.36 },
  wiki: { fontFamily: fontFamilies.mono, fontSize: 15, lineHeight: 20, letterSpacing: -0.6 },
  table: { fontFamily: fontFamilies.sans, fontSize: 17, lineHeight: 24 },
  formatGlyph: { fontFamily: fontFamilies.sansSemiBold, fontSize: 18, lineHeight: 22 },
  chip: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full
  },
  chipLabel: { fontFamily: fontFamilies.serifSemiBold, fontSize: 15, lineHeight: 20 }
})
