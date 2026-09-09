import { useRef } from 'react'
import { InteractionManager, Platform, Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '@/components/ui/app-text'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { Icon, type IconName } from '@/components/ui/icon'
import type { Color } from '@/theme/colors'
import type { ReminderBadge } from '@/features/notes/reminders'
import { space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export interface NoteMoreSheetProps {
  visible: boolean
  title: string
  bookmarked: boolean
  readOnly: boolean
  backlinkCount: number
  /** Already derived by `describeReminder`; this sheet never reads the clock. */
  reminder: ReminderBadge
  onClose: () => void
  onToggleBookmark: () => void
  onReminder: () => void
  onBacklinks: () => void
  onRename: () => void
  onMove: () => void
  onDuplicate: () => void
  onShare: () => void
  onExport: () => void
  onDelete: () => void
}

interface MoreAction {
  key:
    | 'bookmark'
    | 'reminder'
    | 'backlinks'
    | 'rename'
    | 'move'
    | 'duplicate'
    | 'share'
    | 'export'
    | 'delete'
  label: string
  icon: IconName
  trailing?: string
  destructive?: boolean
  /** Only the reminder row uses this today, for its active state. */
  iconColor?: Color
  onPress: () => void
}

/** Board 29H, limited to actions that mobile can execute today. */
export function NoteMoreSheet({
  visible,
  title,
  bookmarked,
  readOnly,
  backlinkCount,
  reminder,
  onClose,
  onToggleBookmark,
  onReminder,
  onBacklinks,
  onRename,
  onMove,
  onDuplicate,
  onShare,
  onExport,
  onDelete
}: NoteMoreSheetProps) {
  const c = useColors()
  const insets = useSafeAreaInsets()
  const pendingAction = useRef<(() => void) | null>(null)
  const runPendingAction = (): void => {
    const action = pendingAction.current
    pendingAction.current = null
    action?.()
  }
  const allActions: readonly MoreAction[] = [
    {
      key: 'bookmark',
      label: bookmarked ? 'Remove bookmark' : 'Bookmark note',
      icon: bookmarked ? 'bookmark-off' : 'bookmark',
      onPress: onToggleBookmark
    },
    {
      key: 'reminder',
      label: reminder.label,
      // The ringing bell plus the AA text step of the accent, which is the only
      // tinted colour small enough glyphs are allowed to use.
      icon: reminder.amber ? 'bell-ring' : 'bell',
      ...(reminder.trailing ? { trailing: reminder.trailing } : {}),
      ...(reminder.amber ? { iconColor: c.tint.text } : {}),
      onPress: onReminder
    },
    {
      key: 'backlinks',
      label: 'Backlinks',
      icon: 'link',
      ...(backlinkCount > 0 ? { trailing: String(backlinkCount) } : {}),
      onPress: onBacklinks
    },
    { key: 'rename', label: 'Rename note', icon: 'pencil', onPress: onRename },
    { key: 'move', label: 'Move to folder', icon: 'folder-input', onPress: onMove },
    { key: 'duplicate', label: 'Duplicate note', icon: 'copy', onPress: onDuplicate },
    { key: 'share', label: 'Share a copy', icon: 'share', onPress: onShare },
    { key: 'export', label: 'Export…', icon: 'export', onPress: onExport },
    { key: 'delete', label: 'Delete note', icon: 'trash', destructive: true, onPress: onDelete }
  ]
  // Export reads the note and writes a throwaway file outside the vault, so it
  // stays available when the vault itself is not writable.
  const readOnlyActions: readonly MoreAction['key'][] = ['share', 'export', 'backlinks']
  const actions = readOnly
    ? allActions.filter((action) => readOnlyActions.includes(action.key))
    : allActions

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      onDismiss={runPendingAction}
      accessibilityLabel={`Actions for ${title}`}
      style={{ paddingBottom: insets.bottom }}
    >
      <View style={styles.header}>
        <AppText variant="headline" numberOfLines={1}>
          {title}
        </AppText>
        <AppText variant="caption" color={c.text.secondary}>
          Note actions
        </AppText>
      </View>
      <View style={[styles.actions, { borderTopColor: c.line.border }]}>
        {actions.map((action, index) => {
          const color = action.destructive ? c.ui.destructiveText : c.text.primary
          return (
            <Pressable
              key={action.key}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              onPress={() => {
                pendingAction.current = action.onPress
                onClose()
                // iOS owns sibling Modal sequencing through native onDismiss.
                // Android does not reliably emit onDismiss, so keep its
                // interaction-queue fallback without racing iOS presentation.
                if (Platform.OS !== 'ios') {
                  void InteractionManager.runAfterInteractions(runPendingAction)
                }
              }}
              style={({ pressed }) => [
                styles.action,
                index > 0 && {
                  borderTopColor: c.line.border,
                  borderTopWidth: StyleSheet.hairlineWidth
                },
                pressed && { backgroundColor: c.canvas.surface }
              ]}
            >
              <View style={styles.iconSlot}>
                <Icon name={action.icon} size={22} color={action.iconColor ?? color} />
              </View>
              <AppText color={color} style={styles.actionLabel}>
                {action.label}
              </AppText>
              {action.trailing ? (
                <AppText variant="footnote" color={c.text.tertiary}>
                  {action.trailing}
                </AppText>
              ) : null}
            </Pressable>
          )
        })}
      </View>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  header: {
    height: 53,
    justifyContent: 'center',
    gap: space.s2,
    paddingStart: space.s16,
    paddingEnd: space.s16
  },
  actions: { borderTopWidth: StyleSheet.hairlineWidth },
  action: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingStart: space.s16,
    paddingEnd: space.s16
  },
  iconSlot: {
    width: 24,
    height: 24,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center'
  },
  actionLabel: { flex: 1, minWidth: 0 }
})
