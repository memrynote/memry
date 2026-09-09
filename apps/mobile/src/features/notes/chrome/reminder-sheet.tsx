import { useCallback, useMemo, useState } from 'react'
import { Alert, Linking, Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { DatePicker, Host } from '@expo/ui/swift-ui'

import { AppText } from '@/components/ui/app-text'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { Icon } from '@/components/ui/icon'
import { extractErrorMessage } from '@/lib/errors'
import { createLogger } from '@/lib/logger'
import type { NoteOpsContext } from '@/features/notes/note-ops'
import {
  clearNoteReminder,
  formatReminderTime,
  reminderPresets,
  setNoteReminder,
  type NoteReminder
} from '@/features/notes/reminders'
import { fontFamilies } from '@/theme/fonts'
import { radius, sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

const log = createLogger('ReminderSheet')

// The same 52pt row `sort-sheet.tsx` uses; one more sheet does not earn a step
// on the size scale.
const ROW_HEIGHT = 52
const PICKER_HEIGHT = 220

export interface ReminderSheetProps {
  visible: boolean
  ctx: NoteOpsContext | null
  noteId: string
  noteTitle: string
  reminder: NoteReminder | null
  onClose: () => void
  onChanged: (reminder: NoteReminder | null) => void
}

/**
 * `setNoteReminder` saves and syncs whatever happens with the OS, so every
 * branch below is about DELIVERY — what this device will or will not show —
 * never about whether the reminder exists.
 */
export function ReminderSheet({
  visible,
  ctx,
  noteId,
  noteTitle,
  reminder,
  onClose,
  onChanged
}: ReminderSheetProps) {
  const c = useColors()
  const insets = useSafeAreaInsets()
  const [custom, setCustom] = useState<Date | null>(null)

  // Anchored to the mount. The note screen mounts this sheet only while it is
  // open, so "the moment the sheet opened" and "the moment it mounted" are the
  // same instant, and presets cannot move under the user's finger mid-render.
  const now = useMemo(() => new Date(), [])
  const presets = useMemo(() => reminderPresets(now), [now])

  const pick = useCallback(
    async (at: Date) => {
      if (!ctx) return
      onClose()
      try {
        // No `title`: that field is the user's own reminder text on the
        // desktop, and the banner already falls back to the note's title. This
        // sheet has no text input, so writing one would be inventing data.
        const result = await setNoteReminder(ctx, noteId, at)
        onChanged(result.reminder)
        switch (result.delivery) {
          case 'scheduled':
            return
          case 'permission-denied':
            return Alert.alert(
              'Reminder saved, notifications are off',
              'Memry can’t show a notification on this device until you allow them in Settings. The reminder still syncs to your other devices.',
              [
                { text: 'Not now', style: 'cancel' },
                { text: 'Open Settings', onPress: () => void Linking.openSettings() }
              ]
            )
          case 'in-the-past':
            return Alert.alert(
              'Reminder saved',
              'That time has already passed, so no notification will be shown.'
            )
          case 'device-limit':
            return Alert.alert(
              'Reminder saved',
              'This device is already holding its maximum number of scheduled reminders. This one is scheduled as earlier reminders pass.'
            )
          case 'unavailable':
            // Simulator, a stale dev client, or a build without the module.
            // Saved and syncing; saying nothing beats a dialog about a
            // capability the user did not ask for.
            return
        }
      } catch (error) {
        const message = extractErrorMessage(error, 'That reminder could not be saved.')
        log.error('Setting a reminder failed', { noteId, error: message })
        Alert.alert('Reminder failed', message)
      }
    },
    [ctx, noteId, onChanged, onClose]
  )

  const remove = useCallback(async () => {
    if (!ctx) return
    onClose()
    try {
      await clearNoteReminder(ctx, noteId)
      onChanged(null)
    } catch (error) {
      const message = extractErrorMessage(error, 'That reminder could not be removed.')
      log.error('Clearing a reminder failed', { noteId, error: message })
      Alert.alert('Reminder failed', message)
    }
  }, [ctx, noteId, onChanged, onClose])

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel={`Remind me about ${noteTitle}`}
      style={{ paddingBottom: insets.bottom }}
    >
      <View style={styles.header}>
        <AppText style={styles.headerTitle}>Remind me</AppText>
        {reminder && reminder.state.kind !== 'dismissed' ? (
          <AppText variant="footnote" color={c.text.secondary}>
            {formatReminderTime(reminder.state.at, now)}
          </AppText>
        ) : null}
      </View>

      {presets.map((preset) => (
        <Pressable
          key={preset.key}
          accessibilityRole="button"
          accessibilityLabel={`${preset.label}, ${formatReminderTime(preset.at, now)}`}
          onPress={() => void pick(preset.at)}
          style={[styles.row, { borderTopColor: c.line.border }]}
        >
          <View style={styles.iconSlot}>
            <Icon name="bell" size={18} color={c.text.secondary} />
          </View>
          <AppText style={styles.rowLabel}>{preset.label}</AppText>
          <AppText variant="footnote" color={c.text.tertiary}>
            {formatReminderTime(preset.at, now)}
          </AppText>
        </Pressable>
      ))}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Pick a date and time"
        accessibilityState={{ expanded: custom !== null }}
        // Opens in place rather than as a second sheet: a picker stacked on a
        // modal is the arrangement `properties.tsx` already declined.
        onPress={() => setCustom((open) => (open ? null : defaultCustom(now)))}
        style={[styles.row, { borderTopColor: c.line.border }]}
      >
        <View style={styles.iconSlot}>
          <Icon name="calendar" size={18} color={c.text.secondary} />
        </View>
        <AppText style={styles.rowLabel}>Pick date &amp; time…</AppText>
      </Pressable>

      {custom ? (
        <View style={[styles.picker, { borderTopColor: c.line.border }]}>
          <Host matchContents style={styles.pickerHost}>
            <DatePicker
              selection={custom}
              displayedComponents={['date', 'hourAndMinute']}
              onDateChange={setCustom}
            />
          </Host>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Set reminder"
            onPress={() => void pick(custom)}
            style={[styles.confirm, { backgroundColor: c.tint.base }]}
          >
            <AppText color={c.tint.foreground}>Set reminder</AppText>
          </Pressable>
        </View>
      ) : null}

      {reminder ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Remove reminder"
          onPress={() => void remove()}
          style={[styles.row, { borderTopColor: c.line.border }]}
        >
          <View style={styles.iconSlot}>
            <Icon name="trash" size={18} color={c.ui.destructiveText} />
          </View>
          <AppText color={c.ui.destructiveText} style={styles.rowLabel}>
            Remove reminder
          </AppText>
        </Pressable>
      ) : null}
    </BottomSheet>
  )
}

/** The picker opens on the next whole hour, not on `now` to the second. */
function defaultCustom(now: Date): Date {
  const at = new Date(now)
  at.setMinutes(0, 0, 0)
  at.setHours(at.getHours() + 1)
  return at
}

const styles = StyleSheet.create({
  header: {
    height: ROW_HEIGHT,
    paddingHorizontal: sizes.gutter,
    flexDirection: 'row',
    alignItems: 'center'
  },
  headerTitle: { flex: 1, fontFamily: fontFamilies.sansSemiBold, letterSpacing: -0.17 },
  row: {
    height: ROW_HEIGHT,
    paddingHorizontal: sizes.gutter,
    gap: space.s12,
    borderTopWidth: 1,
    flexDirection: 'row',
    alignItems: 'center'
  },
  iconSlot: { width: 24, alignItems: 'center', justifyContent: 'center' },
  rowLabel: { flex: 1, minWidth: 0 },
  picker: {
    borderTopWidth: 1,
    paddingHorizontal: sizes.gutter,
    paddingVertical: space.s12,
    gap: space.s12
  },
  pickerHost: { minHeight: PICKER_HEIGHT },
  confirm: {
    height: sizes.tapTarget,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center'
  }
})
