import type { ReminderTargetType } from '@memry/contracts/reminder-types'
import type { Tab } from '@/contexts/tabs/types'

/**
 * Tab descriptor accepted by `openTab` (id/timestamps are assigned by the
 * tabs context).
 */
export type ReminderTargetTab = Omit<Tab, 'id' | 'openedAt' | 'lastAccessedAt'>

export interface ReminderTargetInput {
  targetType: ReminderTargetType
  targetId: string
  targetTitle: string | null
  /** Project the task belongs to — opens the Tasks page filtered to it. */
  projectId?: string
  /** For 'note_date' targets: the inline date pill's stable anchor id. */
  anchorId?: string
  highlightStart?: number
  highlightEnd?: number
  highlightText?: string
  /** Localized fallback titles, supplied by the caller (helper stays pure). */
  fallbacks: { note: string; journal: string; task: string }
}

const JOURNAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Is this reminder's `targetId` a journal day this app can open?
 *
 * A journal reminder is addressed by its local `YYYY-MM-DD` date — that string
 * IS the navigation target, so a value that is not one has no day to open. The
 * shape check is not enough on its own: `2026-02-31` matches the pattern and
 * then rolls forward to March 3rd, which is exactly the "lands on an unrelated
 * date" failure this guard exists to prevent, so the parts are compared back
 * against a real date. Built in UTC deliberately — the check is about the
 * calendar, not about an instant, and a local-midnight construction would make
 * the answer depend on the reader's offset.
 */
export function isJournalDateId(targetId: string): boolean {
  if (!JOURNAL_DATE_PATTERN.test(targetId)) return false
  const [year, month, day] = targetId.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  )
}

const BASE_STATE = {
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false
} as const

/**
 * Map a reminder target to the tab descriptor that opens its source.
 *
 * Shared by the inbox reminder detail, the upcoming/past reminders list and
 * the due-reminder toast / OS notification click, so navigation stays identical
 * across every surface a reminder can be clicked from.
 *
 * Returns null when the target cannot be turned into a destination — today that
 * is only a journal reminder whose `targetId` is not a real calendar day. The
 * caller reports it instead of opening some other date.
 */
export function buildReminderTargetTab(input: ReminderTargetInput): ReminderTargetTab | null {
  const { targetType, targetId, targetTitle, projectId, fallbacks } = input

  switch (targetType) {
    case 'journal':
      // The stored date is the source of truth, never "today": `viewState.date`
      // is what `pages/journal.tsx` reads to pick the day, and the tab keeps the
      // journal's singleton path so an already-open journal tab is moved to that
      // day rather than duplicated.
      if (!isJournalDateId(targetId)) return null
      return {
        type: 'journal',
        title: fallbacks.journal,
        icon: 'book-open',
        path: '/journal',
        ...BASE_STATE,
        viewState: { date: targetId }
      }

    case 'task':
      return {
        type: 'tasks',
        title: targetTitle || fallbacks.task,
        icon: 'CheckSquare',
        path: '/tasks',
        ...BASE_STATE,
        viewState: {
          openTaskId: targetId,
          selectedProjectId: projectId,
          activeInternalTab: 'all',
          activeTab: 'all'
        }
      }

    case 'note':
    case 'highlight':
    case 'note_date':
      return {
        type: 'note',
        title: targetTitle || fallbacks.note,
        icon: 'file-text',
        path: `/notes/${targetId}`,
        entityId: targetId,
        ...BASE_STATE,
        viewState:
          targetType === 'highlight'
            ? {
                highlightStart: input.highlightStart,
                highlightEnd: input.highlightEnd,
                highlightText: input.highlightText
              }
            : targetType === 'note_date'
              ? { anchorId: input.anchorId }
              : undefined
      }
  }
}
