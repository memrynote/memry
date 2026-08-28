import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityState,
  type StyleProp,
  type ViewStyle
} from 'react-native'

import { AppText } from '@/components/ui/app-text'
import { Icon, type IconName } from '@/components/ui/icon'
import type { NOTE_FILE_TYPE_TONE } from '@/features/notes/tree'
import type { Color } from '@/theme/colors'
import { fontFamilies } from '@/theme/fonts'
import { radius, sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export type NoteToneName = (typeof NOTE_FILE_TYPE_TONE)[keyof typeof NOTE_FILE_TYPE_TONE]

const INDENT = 16
const ROW_HEIGHT = 40
const CHEVRON_SLOT = 16

// The 16x40 chevron slot grown to the 44pt minimum tap target. RN's `Insets`
// takes no start/end, and the slop is symmetric, so RTL is unaffected.
const TOGGLE_HIT_SLOP = {
  top: (sizes.tapTarget - ROW_HEIGHT) / 2,
  bottom: (sizes.tapTarget - ROW_HEIGHT) / 2,
  left: (sizes.tapTarget - CHEVRON_SLOT) / 2,
  right: (sizes.tapTarget - CHEVRON_SLOT) / 2
} as const

// The board's image-note blue. `white.ts` has no token for it and this unit
// cannot touch the theme, so it is branded once here the way `brandTheme`
// brands the palette: one cast at the boundary, never at the use site.
const IMAGE_BLUE = '#2563EB' as Color

export interface TreeSectionHeaderProps {
  label: string
  style?: StyleProp<ViewStyle>
}

// Separate from `SectionHeader`, which is 40pt with a 12px semibold label;
// this board is 32pt with an 11px medium one.
export function TreeSectionHeader({ label, style }: TreeSectionHeaderProps) {
  const c = useColors()

  return (
    <View accessibilityRole="header" style={[styles.sectionHeader, style]}>
      <Text style={[styles.sectionHeaderLabel, { color: c.text.secondary }]}>{label}</Text>
    </View>
  )
}

export type TreeRowProps = {
  label: string
  level: number
  /** A folder row when set, a note row when absent. */
  folder?: { expanded: boolean; icon: string | null }
  /** Recolours the note glyph. Absent on folder rows. */
  tone?: NoteToneName
  /** Draws a trailing 14pt chevron-right (board 27's navigable subfolder rows). */
  chevron?: boolean
  /** Draws a trailing 16pt tint check and tints the label (board 35's selection). */
  selected?: boolean
  onPress?: () => void
  /** Chevron-slot press. Present only on an expandable folder row. */
  onToggle?: () => void
  accessibilityLabel?: string
} & (
  | { count?: number; trailingLabel?: never }
  /** Trailing text instead of a count, e.g. board 35's `current`. */
  | { trailingLabel: string; count?: never }
)

export function TreeRow({
  label,
  level,
  folder,
  tone,
  count,
  trailingLabel,
  chevron,
  selected,
  onPress,
  onToggle,
  accessibilityLabel
}: TreeRowProps) {
  const c = useColors()
  const toneColors: Record<NoteToneName, Color> = {
    destructive: c.ui.destructive,
    blue: IMAGE_BLUE,
    green: c.dot.green,
    purple: c.dot.purple,
    tertiary: c.text.tertiary
  }

  const emoji = folder?.icon ?? null
  let glyph: IconName
  if (folder) {
    glyph = folder.expanded ? 'folder-open' : 'folder'
  } else if (tone === 'blue') {
    glyph = 'image'
  } else {
    glyph = 'file'
  }
  const glyphColor = folder ? c.text.secondary : toneColors[tone ?? 'tertiary']

  const chevronGlyph = folder ? (
    <Icon
      name={folder.expanded ? 'chevron-down' : 'chevron-right'}
      size={16}
      color={c.text.tertiary}
    />
  ) : null

  const accessibilityState: AccessibilityState = {
    ...(folder && onToggle ? { expanded: folder.expanded } : null),
    ...(selected === undefined ? null : { selected })
  }

  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : 'none'}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { paddingStart: level * INDENT + sizes.gutter },
        ((onPress && pressed) || selected) && [
          styles.rowHighlight,
          { backgroundColor: c.canvas.surface, paddingStart: level * INDENT + space.s8 }
        ]
      ]}
    >
      {folder && onToggle ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${folder.expanded ? 'Collapse' : 'Expand'} ${label}`}
          hitSlop={TOGGLE_HIT_SLOP}
          onPress={onToggle}
          style={styles.chevronSlot}
        >
          {chevronGlyph}
        </Pressable>
      ) : (
        <View style={styles.chevronSlot}>{chevronGlyph}</View>
      )}

      <View style={styles.iconSlot}>
        {emoji === null ? (
          <Icon name={glyph} size={16} color={glyphColor} />
        ) : (
          <Text style={styles.emoji}>{emoji}</Text>
        )}
      </View>

      <AppText
        variant="subhead"
        numberOfLines={1}
        color={selected ? c.tint.base : c.text.primary}
        style={styles.label}
      >
        {label}
      </AppText>

      {count === undefined ? null : (
        <AppText variant="caption" color={c.text.tertiary}>
          {count}
        </AppText>
      )}
      {trailingLabel === undefined ? null : (
        <AppText variant="caption" color={c.text.tertiary}>
          {trailingLabel}
        </AppText>
      )}
      {chevron ? (
        <View style={styles.trailingChevron}>
          <Icon name="chevron-right" size={14} color={c.text.tertiary} />
        </View>
      ) : null}
      {selected ? <Icon name="check" size={16} color={c.tint.base} /> : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  sectionHeader: {
    height: 32,
    paddingHorizontal: sizes.gutter,
    flexDirection: 'row',
    alignItems: 'center'
  },
  // `textStyles` has no 11px step and one component does not earn a variant on
  // the shared ramp.
  sectionHeaderLabel: {
    fontFamily: fontFamilies.sansMedium,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.44,
    textTransform: 'uppercase'
  },
  row: {
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s2,
    paddingEnd: space.s12
  },
  // The padding gives back exactly what the margin takes on both edges, so
  // nothing under the finger moves when a row highlights. The board draws
  // `pr-8` here, but its highlight is a persistent selection; ours is also a
  // press state, and 8 would jog the count and the check 4pt inward per tap.
  rowHighlight: {
    borderRadius: radius.sm,
    marginHorizontal: space.s8,
    paddingEnd: space.s4
  },
  chevronSlot: {
    width: CHEVRON_SLOT,
    height: ROW_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center'
  },
  iconSlot: { width: 20, flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
  emoji: { fontSize: 14, lineHeight: 16, textAlign: 'center' },
  // -0.15 is the board's `--tracking-snug` resolved at 15px.
  label: { flex: 1, marginStart: space.s6, letterSpacing: -0.15 },
  trailingChevron: { marginStart: space.s8 }
})
