/**
 * Builds the openTab argument that opens a card's entity "as if clicked in its
 * home view", reusing the proven viewState deep-links from
 * agent-chat/messages/memry-links.tsx (note → note tab, task → Tasks + drawer,
 * event → Calendar focus). Pure so it unit-tests without the tab context.
 */

import type { Tab } from '@/contexts/tabs/types'
import type { CanvasEntityType } from '@memry/contracts/canvas-api'

export type RedirectTab = Omit<Tab, 'id' | 'openedAt' | 'lastAccessedAt'>

const base = {
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false
} as const

export interface RedirectInput {
  entityType: CanvasEntityType
  entityId: string
  /** Card title for the note tab label. */
  title: string
  /** Event start ISO — required to focus the right calendar day. */
  startAt?: string | null
  /** Monotonic token so a repeat redirect to the same entity re-fires focus. */
  now: number
}

/**
 * Returns the tab descriptor to pass to openTab, or null when the input is
 * insufficient (e.g. a calendar event with no start date to focus).
 */
export function buildRedirectTab(input: RedirectInput): RedirectTab | null {
  switch (input.entityType) {
    case 'note':
      return {
        ...base,
        type: 'note',
        title: input.title || 'Note',
        icon: 'file-text',
        path: `/note/${input.entityId}`,
        entityId: input.entityId
      }
    case 'task':
      return {
        ...base,
        type: 'tasks',
        title: 'Tasks',
        icon: 'list-checks',
        path: '/tasks',
        viewState: { openTaskId: input.entityId }
      }
    case 'calendar_event': {
      if (!input.startAt) {
        return null
      }
      const focusDate = input.startAt.slice(0, 10)
      return {
        ...base,
        type: 'calendar',
        title: 'Calendar',
        icon: 'calendar',
        path: '/calendar',
        viewState: {
          focusCalendarEventId: input.entityId,
          focusDate,
          focusedAt: input.now
        }
      }
    }
  }
}
