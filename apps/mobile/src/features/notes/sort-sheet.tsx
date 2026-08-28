import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '@/components/ui/app-text'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { Icon } from '@/components/ui/icon'
import { MOBILE_SORT_LABELS, MOBILE_SORT_MODES, type MobileSortMode } from '@/features/notes/tree'
import { fontFamilies } from '@/theme/fonts'
import { useColors } from '@/theme/use-colors'

// 52 and 14 are not on the `sizes` / `space` scales, and one sheet does not
// earn a step on either — `tree-row.tsx` keeps its own 40 for the same reason.
const ROW_HEIGHT = 52
const ROW_GAP = 14
const CHECK_SLOT = 24

export interface SheetRowProps {
  label: string
  selected?: boolean
  onPress: () => void
}

/**
 * Exported because the notes list's `···` sheet is the same 52pt row and must
 * not restate these styles.
 */
export function SheetRow({ label, selected, onPress }: SheetRowProps) {
  const c = useColors()

  return (
    <Pressable
      accessibilityRole="button"
      // An action row has no selection concept and must not claim one.
      {...(selected === undefined ? {} : { accessibilityState: { selected } })}
      onPress={onPress}
      style={[styles.row, { borderTopColor: c.line.border }]}
    >
      <View style={styles.checkSlot}>
        {selected ? <Icon name="check" size={18} color={c.tint.base} /> : null}
      </View>
      <AppText color={selected ? c.tint.base : c.text.primary}>{label}</AppText>
    </Pressable>
  )
}

export interface SortSheetProps {
  visible: boolean
  sort: MobileSortMode
  onSelect: (mode: MobileSortMode) => void
  onClose: () => void
}

export function SortSheet({ visible, sort, onSelect, onClose }: SortSheetProps) {
  const c = useColors()
  const insets = useSafeAreaInsets()

  return (
    <BottomSheet visible={visible} onClose={onClose} accessibilityLabel="Sort notes">
      <View style={styles.header}>
        <AppText style={styles.headerTitle}>Sort notes</AppText>
        <Pressable accessibilityRole="button" onPress={onClose}>
          <AppText variant="callout" color={c.tint.base}>
            Done
          </AppText>
        </Pressable>
      </View>

      {/* The board also drew a `Manual` row. `MOBILE_SORT_MODES` has no
          `manual` because no note payload carries a position. */}
      {MOBILE_SORT_MODES.map((mode) => (
        <SheetRow
          key={mode}
          label={MOBILE_SORT_LABELS[mode]}
          selected={mode === sort}
          onPress={() => onSelect(mode)}
        />
      ))}

      <View
        style={[
          styles.footnote,
          { borderTopColor: c.line.border, paddingBottom: 16 + insets.bottom }
        ]}
      >
        <AppText variant="footnote" color={c.text.secondary}>
          Folders stay A → Z under every time mode.
        </AppText>
      </View>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  row: {
    height: ROW_HEIGHT,
    paddingHorizontal: 16,
    gap: ROW_GAP,
    borderTopWidth: 1,
    flexDirection: 'row',
    alignItems: 'center'
  },
  checkSlot: { width: CHECK_SLOT, alignItems: 'center', justifyContent: 'center' },
  header: {
    height: ROW_HEIGHT,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center'
  },
  headerTitle: { flex: 1, fontFamily: fontFamilies.sansSemiBold, letterSpacing: -0.17 },
  footnote: { paddingTop: 12, paddingHorizontal: 16, borderTopWidth: 1 }
})
