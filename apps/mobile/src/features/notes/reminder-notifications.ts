import * as Notifications from 'expo-notifications'

import { createLogger } from '@/lib/logger'
import type {
  ReminderPermission,
  ReminderScheduler,
  ScheduledReminder,
  ScheduleRequest
} from '@/features/notes/reminders'

const log = createLogger('ReminderNotifications')

/**
 * The ONLY file that imports `expo-notifications`.
 *
 * Everything crossing this boundary is a domain value: an expo `Notification`,
 * `NotificationRequest` or permission object never escapes, so `reminders.ts`
 * can be driven by a fake in a test and the app has exactly one place to look
 * when the OS behaves differently from the docs.
 *
 * **The identifier of a scheduled reminder IS the reminder id.** That is the
 * load-bearing choice of the whole delivery design:
 *
 * - cancel is O(1) and needs no lookup table;
 * - scheduling twice REPLACES rather than duplicates, so every path is
 *   idempotent by construction and there is no "did I already schedule this"
 *   bookkeeping to get out of step;
 * - the OS list is therefore a complete, crash-proof record of what this device
 *   holds — exactly the local table we would otherwise have to add and migrate.
 *
 * iOS honours a caller-supplied identifier, which is what this rests on. This
 * feature is iOS-only for v1.
 */

const MARKER = 'reminder'

/**
 * A reminder banner is worth interrupting for while the app is open — the whole
 * point is that the user asked to be told at this moment.
 */
Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true
    })
})

export interface ReminderRef {
  reminderId: string
  noteId: string
}

/** Validate the OS payload here so no unchecked `any` reaches the domain. */
function toRef(data: unknown): ReminderRef | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  if (record.memry !== MARKER) return null
  const { reminderId, noteId } = record
  if (typeof reminderId !== 'string' || typeof noteId !== 'string') return null
  return { reminderId, noteId }
}

function toScheduled(request: Notifications.NotificationRequest): ScheduledReminder | null {
  const ref = toRef(request.content.data)
  if (!ref) return null
  // The time is read out of OUR data, not out of the trigger: the trigger's
  // shape differs by platform and by trigger type, and this comparison is what
  // lets the reconciler spot an entry that still has the right id at the wrong
  // time.
  const raw = (request.content.data as Record<string, unknown>).at
  const ms = typeof raw === 'string' ? Date.parse(raw) : NaN
  if (!Number.isFinite(ms)) return null
  return { reminderId: ref.reminderId, noteId: ref.noteId, at: new Date(ms) }
}

function toPermission(status: Notifications.NotificationPermissionsStatus): ReminderPermission {
  // iOS's granular states matter here: PROVISIONAL and EPHEMERAL both deliver,
  // and `granted` already folds them in.
  return status.granted ? 'granted' : 'denied'
}

async function permission(): Promise<ReminderPermission> {
  try {
    return toPermission(await Notifications.getPermissionsAsync())
  } catch (err) {
    log.warn('Reading the notification permission failed', {
      error: err instanceof Error ? err.message : String(err)
    })
    return 'unavailable'
  }
}

async function request(): Promise<ReminderPermission> {
  try {
    const current = await Notifications.getPermissionsAsync()
    if (current.granted) return 'granted'
    // Asking again once iOS has recorded a denial does nothing — the prompt
    // never appears and the call resolves denied. The user has to go to
    // Settings, which is what the sheet offers them.
    if (!current.canAskAgain) return 'denied'
    return toPermission(
      await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: false, allowSound: true }
      })
    )
  } catch (err) {
    log.warn('Requesting the notification permission failed', {
      error: err instanceof Error ? err.message : String(err)
    })
    return 'unavailable'
  }
}

async function list(): Promise<ScheduledReminder[]> {
  const requests = await Notifications.getAllScheduledNotificationsAsync()
  const entries: ScheduledReminder[] = []
  for (const item of requests) {
    const entry = toScheduled(item)
    // Anything that is not one of ours is left alone. This app schedules
    // nothing else today, but cancelling a stranger's notification because it
    // was not in `want` is the kind of bug that only shows up later.
    if (entry) entries.push(entry)
  }
  return entries
}

async function schedule(input: ScheduleRequest): Promise<'ok' | 'denied' | 'unavailable'> {
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: input.reminderId,
      content: {
        title: input.title,
        body: input.body,
        data: {
          memry: MARKER,
          reminderId: input.reminderId,
          noteId: input.noteId,
          vaultId: input.vaultId,
          at: input.at.toISOString()
        }
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: input.at }
    })
    return 'ok'
  } catch (err) {
    log.warn('Scheduling a reminder notification failed', {
      reminderId: input.reminderId,
      error: err instanceof Error ? err.message : String(err)
    })
    return 'unavailable'
  }
}

async function cancel(reminderId: string): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(reminderId)
  } catch (err) {
    log.warn('Cancelling a reminder notification failed', {
      reminderId,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

export const notificationScheduler: ReminderScheduler = {
  permission,
  request,
  list,
  schedule,
  cancel
}

/**
 * Route a tapped banner back to its note. Returns an unsubscribe.
 *
 * The cold-start response is checked too: a tap that LAUNCHED the app has
 * already been delivered by the time any listener attaches, so a listener alone
 * would open the app on the notes list and lose the tap.
 */
export function onReminderTap(handler: (ref: ReminderRef) => void): () => void {
  let live = true
  void Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (!live || !response) return
      const ref = toRef(response.notification.request.content.data)
      if (!ref) return
      // Without this the same launch tap is replayed on every later cold start
      // that happens to have no newer response.
      Notifications.clearLastNotificationResponse()
      handler(ref)
    })
    .catch((err: unknown) => {
      log.warn('Reading the launch notification response failed', {
        error: err instanceof Error ? err.message : String(err)
      })
    })

  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const ref = toRef(response.notification.request.content.data)
    if (ref) handler(ref)
  })

  return () => {
    live = false
    subscription.remove()
  }
}
