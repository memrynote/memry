import type { EditorToolbarSelection } from '@memry/contracts/webview-bridge'
import type { ReactNode } from 'react'
import { ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'

import type { ToolbarIntents } from '@/editor/toolbar/bottom-chrome'
import {
  BLOCK_PICKER_GROUPS,
  TABLE_PICKER_GROUPS,
  TURN_INTO_ITEMS,
  type PickerVisual
} from '@/editor/toolbar/picker-items'
import { ToolbarButton } from '@/editor/toolbar/toolbar-button'
import { fontFamilies } from '@/theme/fonts'
import { radius, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export interface PickerShellProps {
  title: string
  accessory?: ReactNode
  style?: StyleProp<ViewStyle>
  children: ReactNode
}

export function PickerShell({ title, accessory, style, children }: PickerShellProps) {
  const c = useColors()
  return (
    <View
      accessibilityLabel={title}
      style={[
        styles.panel,
        { backgroundColor: c.canvas.background, borderTopColor: c.line.border },
        style
      ]}
    >
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: c.text.secondary }]}>{title}</Text>
        {accessory}
      </View>
      {children}
    </View>
  )
}

export function PickerScroll({ children }: { children: ReactNode }) {
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      bounces={false}
      overScrollMode="never"
    >
      {children}
    </ScrollView>
  )
}

export function SectionLabel({ label }: { label: string }) {
  const c = useColors()
  return (
    <View style={styles.sectionLabel}>
      <Text style={[styles.sectionLabelText, { color: c.text.secondary }]}>{label}</Text>
    </View>
  )
}

export function PickerCard({
  visual,
  selected = false,
  onPress
}: {
  visual: PickerVisual
  selected?: boolean
  onPress: () => void
}) {
  const c = useColors()
  return (
    <ToolbarButton
      label={visual.label}
      selected={selected}
      background={c.canvas.surface}
      style={[styles.card, { borderColor: c.line.border }]}
      onPress={onPress}
    >
      {() => (
        <>
          <Text
            style={[
              styles.cardGlyph,
              visual.glyphStyle === 'serif' ? styles.cardGlyphSerif : null,
              visual.glyphStyle === 'mono' ? styles.cardGlyphMono : null,
              { color: c.text.secondary }
            ]}
          >
            {visual.glyph}
          </Text>
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={[styles.cardLabel, { color: c.text.primary }]}
          >
            {visual.label}
          </Text>
          {selected ? <Text style={[styles.cardCheck, { color: c.tint.text }]}>✓</Text> : null}
        </>
      )}
    </ToolbarButton>
  )
}

/**
 * The two-column grid, laid out as explicit rows.
 *
 * RN has no `grid`, and a wrapping row with percentage bases cannot both honour
 * the 8pt gutter and land two equal columns, so the items are paired and each
 * card takes half of what is left after the gutter.
 */
function PickerGrid<T extends { label: string }>({
  items,
  renderItem
}: {
  items: readonly T[]
  renderItem: (item: T) => ReactNode
}) {
  const rows: T[][] = []
  for (let index = 0; index < items.length; index += 2) rows.push(items.slice(index, index + 2))

  return (
    <View style={styles.grid}>
      {rows.map((row) => (
        <View key={row[0].label} style={styles.gridRow}>
          {row.map((item) => renderItem(item))}
          {row.length === 1 ? <View style={styles.gridFiller} /> : null}
        </View>
      ))}
    </View>
  )
}

export function BlocksPanel({
  style,
  intents
}: {
  style?: StyleProp<ViewStyle>
  intents: ToolbarIntents
}) {
  return (
    <PickerShell title="Blocks" style={style}>
      <PickerScroll>
        {BLOCK_PICKER_GROUPS.map((group) => (
          <View key={group.label}>
            <SectionLabel label={group.label} />
            <PickerGrid
              items={group.items}
              renderItem={(item) => (
                <PickerCard
                  key={item.label}
                  visual={item}
                  onPress={() => {
                    intents.closePanel()
                    intents.act({ kind: 'insert', action: item.action })
                  }}
                />
              )}
            />
          </View>
        ))}
      </PickerScroll>
    </PickerShell>
  )
}

export function TurnIntoPanel({
  style,
  selection,
  intents
}: {
  style?: StyleProp<ViewStyle>
  selection: EditorToolbarSelection
  intents: ToolbarIntents
}) {
  return (
    <PickerShell title="Turn into" style={style}>
      <PickerScroll>
        <PickerGrid
          items={TURN_INTO_ITEMS}
          renderItem={(item) => {
            const label = item.block.kind === 'heading' ? `H${item.block.level}` : item.glyph
            return (
              <PickerCard
                key={item.label}
                visual={item}
                selected={selection.blockLabel === label}
                onPress={() => {
                  intents.closePanel()
                  intents.act({ kind: 'turn-into', block: item.block })
                }}
              />
            )
          }}
        />
      </PickerScroll>
    </PickerShell>
  )
}

export function TablePanel({
  style,
  selection,
  intents
}: {
  style?: StyleProp<ViewStyle>
  selection: EditorToolbarSelection
  intents: ToolbarIntents
}) {
  const c = useColors()
  const locked = selection.table?.structureLocked === true

  return (
    <PickerShell title="Table" style={style}>
      <PickerScroll>
        {locked ? (
          // Honest rather than silently wrong: the merge came from a desktop
          // the phone cannot re-index, and a "working" button would corrupt the
          // table.
          <Text accessibilityRole="text" style={[styles.note, { color: c.text.secondary }]}>
            This table has merged cells. Rows and columns can only be changed on desktop.
          </Text>
        ) : null}
        {TABLE_PICKER_GROUPS.map((group) => {
          const items = group.items.filter((item) => !(locked && item.structural))
          if (items.length === 0) return null
          return (
            <View key={group.label}>
              <SectionLabel label={group.label} />
              <PickerGrid
                items={items}
                renderItem={(item) => (
                  <PickerCard
                    key={item.label}
                    visual={item}
                    onPress={() => {
                      // Structure rows keep the panel open: a reader adding
                      // three rows should not re-open it between each one.
                      if (item.action.kind !== 'structure') intents.closePanel()
                      intents.act({ kind: 'table', action: item.action })
                    }}
                  />
                )}
              />
            </View>
          )
        })}
      </PickerScroll>
    </PickerShell>
  )
}

const styles = StyleSheet.create({
  panel: { borderTopWidth: StyleSheet.hairlineWidth },
  header: {
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s4,
    paddingHorizontal: space.s12
  },
  headerTitle: { fontFamily: fontFamilies.sansSemiBold, fontSize: 13, lineHeight: 18 },
  scroll: { flexShrink: 1 },
  scrollContent: { paddingBottom: space.s12 },
  sectionLabel: { height: 24, justifyContent: 'center', paddingHorizontal: space.s12 },
  sectionLabelText: { fontFamily: fontFamilies.sansMedium, fontSize: 11, lineHeight: 16 },
  grid: { gap: space.s8, paddingHorizontal: space.s12 },
  gridRow: { flexDirection: 'row', gap: space.s8 },
  gridFiller: { flex: 1 },
  card: {
    flex: 1,
    width: 'auto',
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 10,
    paddingHorizontal: space.s12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg
  },
  cardGlyph: {
    width: 26,
    textAlign: 'center',
    fontFamily: fontFamilies.sansMedium,
    fontSize: 18,
    lineHeight: 24
  },
  cardGlyphSerif: { fontFamily: fontFamilies.serif },
  cardGlyphMono: { fontFamily: fontFamilies.mono, fontSize: 11 },
  cardLabel: { flexShrink: 1, fontFamily: fontFamilies.sansMedium, fontSize: 14, lineHeight: 18 },
  cardCheck: { marginStart: 'auto', fontSize: 13 },
  note: {
    paddingVertical: space.s8,
    paddingHorizontal: space.s12,
    fontFamily: fontFamilies.sans,
    fontSize: 12,
    lineHeight: 17
  }
})
