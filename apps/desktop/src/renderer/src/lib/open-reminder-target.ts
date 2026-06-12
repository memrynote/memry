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
  highlightStart?: number
  highlightEnd?: number
  highlightText?: string
  /** Localized fallback titles, supplied by the caller (helper stays pure). */
  fallbacks: { note: string; journal: string; task: string }
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
 * Shared by the inbox reminder detail and the upcoming/past reminders list
 * so navigation stays identical across both surfaces.
 */
export function buildReminderTargetTab(input: ReminderTargetInput): ReminderTargetTab {
  const { targetType, targetId, targetTitle, projectId, fallbacks } = input

  switch (targetType) {
    case 'journal':
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
            : undefined
      }
  }
}
