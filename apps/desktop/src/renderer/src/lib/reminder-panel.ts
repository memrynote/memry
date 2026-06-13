import type { ReminderTargetType } from '@memry/contracts/reminder-types'
import type { ReminderWithTarget } from '@memry/contracts/reminders-api'
import type { ReminderMetadata } from '@memry/contracts/inbox-api'
import type { InboxItemType } from '@/types'

/**
 * Minimal inbox-item shape the panel reads. Both the snoozed-items hook
 * (`InboxItem`, `snoozedUntil: Date | null`) and the inbox list hook
 * (`InboxItemListItem`, `snoozedUntil?: Date`) satisfy it structurally.
 */
export interface PanelInboxItem {
  id: string
  type: InboxItemType
  title: string
  createdAt: Date
  snoozedUntil?: Date | null
  metadata?: unknown
}

/**
 * Everything needed to navigate to a reminder's source (note/task/journal).
 */
export interface ReminderEntryNav {
  targetType: ReminderTargetType
  targetId: string
  targetTitle: string | null
  projectId?: string
  /** For 'note_date' reminders: the inline date pill's stable anchor id. */
  anchorId?: string
  highlightStart?: number
  highlightEnd?: number
  highlightText?: string
}

/**
 * A normalized row in the inbox reminders panel. Either a reminder pointing at
 * a source (note/task/journal/highlight) or a snoozed inbox capture.
 */
export type ReminderPanelEntry =
  | {
      kind: 'reminder-target'
      key: string
      timeMs: number
      time: Date
      nav: ReminderEntryNav
      /** Set when derived from a fired reminder inbox item (opening marks it viewed). */
      inboxItemId?: string
    }
  | {
      kind: 'inbox-item'
      key: string
      timeMs: number
      time: Date
      item: PanelInboxItem
    }

export interface ReminderPanelInput {
  /** Reminders with status pending or snoozed (not yet fired). */
  reminders: ReminderWithTarget[]
  /** Inbox items that are snoozed (any type). */
  snoozedItems: PanelInboxItem[]
  /** Active inbox items of type 'reminder' (already fired). */
  reminderItems: PanelInboxItem[]
  /** Reference time; defaults to now. Injected by tests for determinism. */
  nowMs?: number
}

export interface ReminderPanel {
  upcoming: ReminderPanelEntry[]
  past: ReminderPanelEntry[]
}

function reminderToNav(r: ReminderWithTarget): ReminderEntryNav {
  return {
    targetType: r.targetType,
    targetId: r.targetId,
    targetTitle: r.targetTitle,
    projectId: r.projectId ?? undefined,
    anchorId: r.anchorId ?? undefined,
    highlightStart: r.highlightStart ?? undefined,
    highlightEnd: r.highlightEnd ?? undefined,
    highlightText: r.highlightText ?? undefined
  }
}

function metadataToNav(m: ReminderMetadata): ReminderEntryNav {
  return {
    targetType: m.targetType,
    targetId: m.targetId,
    targetTitle: m.targetTitle,
    projectId: m.projectId,
    anchorId: m.anchorId,
    highlightStart: m.highlightStart,
    highlightEnd: m.highlightEnd,
    highlightText: m.highlightText
  }
}

/**
 * Drop duplicate reminder-target entries that describe the same target at the
 * same time (a reminders-table `snoozed` row colliding with a future-snoozed
 * reminder inbox item). The inbox-derived entry wins because it carries the
 * inbox item id needed to mark it viewed.
 */
function dedupeUpcoming(entries: ReminderPanelEntry[]): ReminderPanelEntry[] {
  const indexByKey = new Map<string, number>()
  const result: ReminderPanelEntry[] = []

  for (const entry of entries) {
    if (entry.kind !== 'reminder-target') {
      result.push(entry)
      continue
    }
    const key = `${entry.nav.targetType}:${entry.nav.targetId}:${entry.timeMs}`
    const existingIndex = indexByKey.get(key)
    if (existingIndex === undefined) {
      indexByKey.set(key, result.length)
      result.push(entry)
      continue
    }
    const existing = result[existingIndex]
    if (entry.inboxItemId && existing.kind === 'reminder-target' && !existing.inboxItemId) {
      result[existingIndex] = entry
    }
  }

  return result
}

/**
 * Merge scheduled reminders and snoozed inbox items into Upcoming/Past groups.
 *
 * - Upcoming: pending/snoozed reminders + future-snoozed inbox items, ascending.
 * - Past: fired reminder inbox items, descending.
 *
 * Pure and time-injected (`nowMs`) so it is deterministic under test.
 */
export function buildReminderPanel(input: ReminderPanelInput): ReminderPanel {
  const { reminders, snoozedItems, reminderItems } = input
  const nowMs = input.nowMs ?? Date.now()

  const upcoming: ReminderPanelEntry[] = []

  for (const r of reminders) {
    const timeMs = Date.parse(r.remindAt)
    upcoming.push({
      kind: 'reminder-target',
      key: `reminder:${r.id}`,
      timeMs,
      time: new Date(timeMs),
      nav: reminderToNav(r)
    })
  }

  for (const item of snoozedItems) {
    const until = item.snoozedUntil ? item.snoozedUntil.getTime() : NaN
    if (!(until > nowMs)) continue

    if (item.type === 'reminder' && item.metadata) {
      upcoming.push({
        kind: 'reminder-target',
        key: `inbox:${item.id}`,
        timeMs: until,
        time: new Date(until),
        nav: metadataToNav(item.metadata as ReminderMetadata),
        inboxItemId: item.id
      })
    } else {
      upcoming.push({
        kind: 'inbox-item',
        key: `inbox:${item.id}`,
        timeMs: until,
        time: new Date(until),
        item
      })
    }
  }

  const dedupedUpcoming = dedupeUpcoming(upcoming)
  dedupedUpcoming.sort((a, b) => a.timeMs - b.timeMs)

  const past: ReminderPanelEntry[] = []

  for (const item of reminderItems) {
    if (item.type !== 'reminder' || !item.metadata) continue
    if (item.snoozedUntil && item.snoozedUntil.getTime() > nowMs) continue

    const meta = item.metadata as ReminderMetadata
    const fromMeta = Date.parse(meta.remindAt)
    const timeMs = Number.isNaN(fromMeta) ? item.createdAt.getTime() : fromMeta
    past.push({
      kind: 'reminder-target',
      key: `inbox:${item.id}`,
      timeMs,
      time: new Date(timeMs),
      nav: metadataToNav(meta),
      inboxItemId: item.id
    })
  }

  past.sort((a, b) => b.timeMs - a.timeMs)

  return { upcoming: dedupedUpcoming, past }
}
