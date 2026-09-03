import type { ReactNode } from 'react'
import {
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '@/components/ui/app-text'
import { Icon } from '@/components/ui/icon'
import type { RowAction, RowActionGroups, RowActionId } from '@/features/notes/row-actions'
import { radius, sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

/**
 * The iOS long-press menu (boards 26B / 26C): the pressed row lifts onto a
 * card and the verbs open under it.
 *
 * `groups` is the caller's table — see `row-actions.ts`. Nothing here knows
 * what a folder offers that a note does not; it draws rows, an 8pt band
 * between groups, and the destructive colour for the rows that ask for it.
 *
 * The menu is ANCHORED to where the finger was rather than centred, because
 * the whole point of a context menu is that the thing it acts on is still
 * visible. It is clamped into the safe area so a row near the bottom does not
 * push the menu under the home indicator.
 */

const MENU_WIDTH = 268
const ITEM_HEIGHT = 46
const GROUP_GAP = 8
const PREVIEW_HEIGHT = 46
const PREVIEW_GAP = 10

export interface ContextMenuProps {
  visible: boolean
  /** Page-space y of the long press, from the gesture event. */
  anchorY: number
  /** The lifted row: the caller renders the same content the list drew. */
  preview: ReactNode
  groups: RowActionGroups
  onSelect: (id: RowActionId) => void
  onClose: () => void
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}

function menuHeight(groups: RowActionGroups): number {
  const rows = groups.reduce((total, group) => total + group.length, 0)
  return rows * ITEM_HEIGHT + Math.max(groups.length - 1, 0) * GROUP_GAP
}

export function ContextMenu({
  visible,
  anchorY,
  preview,
  groups,
  onSelect,
  onClose,
  accessibilityLabel,
  style
}: ContextMenuProps) {
  const c = useColors()
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()

  const block = PREVIEW_HEIGHT + PREVIEW_GAP + menuHeight(groups)
  const lowest = height - insets.bottom - space.s16 - block
  const highest = insets.top + space.s8
  // `Math.max` last: on a short screen the block simply starts at the top
  // rather than being pushed off it by the clamp meant to keep it on screen.
  const top = Math.max(highest, Math.min(anchorY - PREVIEW_HEIGHT / 2, lowest))

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close menu"
          onPress={onClose}
          style={[StyleSheet.absoluteFill, styles.scrim, { backgroundColor: c.text.primary }]}
        />

        <View style={[styles.block, { top }, style]} pointerEvents="box-none">
          <View
            style={[
              styles.preview,
              { backgroundColor: c.canvas.background, borderRadius: radius.md }
            ]}
          >
            {preview}
          </View>

          <View
            accessibilityViewIsModal
            accessibilityLabel={accessibilityLabel}
            style={[styles.menu, { backgroundColor: c.line.border }]}
          >
            {groups.map((group, index) => (
              <View
                key={group.map((action) => action.id).join('|')}
                style={[
                  styles.group,
                  { backgroundColor: c.canvas.background },
                  index > 0 && styles.groupGap
                ]}
              >
                {group.map((action, row) => (
                  <MenuItem
                    key={action.id}
                    action={action}
                    divider={row > 0}
                    onPress={() => onSelect(action.id)}
                  />
                ))}
              </View>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  )
}

function MenuItem({
  action,
  divider,
  onPress
}: {
  action: RowAction
  divider: boolean
  onPress: () => void
}) {
  const c = useColors()
  const color = action.destructive ? c.ui.destructiveText : c.text.primary

  return (
    <>
      {divider ? <View style={[styles.divider, { backgroundColor: c.line.border }]} /> : null}
      <Pressable
        accessibilityRole="menuitem"
        accessibilityLabel={action.label}
        onPress={onPress}
        style={({ pressed }) => [styles.item, pressed && { backgroundColor: c.canvas.surface }]}
      >
        <AppText color={color} style={styles.itemLabel}>
          {action.label}
        </AppText>
        <Icon name={action.icon} size={18} color={color} />
      </Pressable>
    </>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // The theme has no scrim token; the same ink-at-40-percent `BottomSheet` uses.
  scrim: { opacity: 0.4 },
  block: { position: 'absolute', start: space.s12, end: space.s12 },
  preview: {
    height: PREVIEW_HEIGHT,
    justifyContent: 'center',
    overflow: 'hidden',
    boxShadow: [{ offsetX: 0, offsetY: 12, blurRadius: 28, color: 'rgba(31, 29, 26, 0.24)' }]
  },
  menu: {
    marginTop: PREVIEW_GAP,
    width: MENU_WIDTH,
    borderRadius: radius.lg,
    overflow: 'hidden',
    boxShadow: [{ offsetX: 0, offsetY: 16, blurRadius: 40, color: 'rgba(31, 29, 26, 0.28)' }]
  },
  // The menu's own background shows through as the 8pt band between groups, so
  // a divider is a gap rather than a drawn element.
  group: { overflow: 'hidden' },
  groupGap: { marginTop: GROUP_GAP },
  item: {
    height: ITEM_HEIGHT,
    paddingHorizontal: sizes.gutter,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s12
  },
  itemLabel: { flex: 1, letterSpacing: -0.17 },
  divider: { height: StyleSheet.hairlineWidth, marginStart: sizes.gutter }
})
