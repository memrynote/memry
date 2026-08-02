import { buildRedirectTab, type RedirectTab } from '@/pages/canvas/canvas-redirect'
import type { ProjectLinkedEvent } from '@memry/rpc/tasks'

/**
 * Open a linked calendar event the way clicking it in the Calendar would:
 * the Calendar tab, scrolled to the event's day, with its detail open.
 *
 * Delegates to the redirect builder the canvas already uses rather than
 * re-deriving the viewState keys the Calendar page consumes.
 */
export function openLinkedEvent(
  event: ProjectLinkedEvent,
  openTab: (tab: RedirectTab) => void,
  now: number
): void {
  const tab = buildRedirectTab({
    entityType: 'calendar_event',
    entityId: event.id,
    title: event.title,
    startAt: event.startAt,
    now
  })
  if (tab) openTab(tab)
}
