import { buildMemryHref, tabFromMemryHref, type OpenableTab } from '@/lib/memry-links'
import type { ProjectLinkedEvent } from '@memry/rpc/tasks'

/**
 * Open a linked calendar event the way clicking it in the Calendar would:
 * the Calendar tab, scrolled to the event's day, with its detail open.
 *
 * Delegates to the shared `memry://` grammar rather than re-deriving the
 * viewState keys the Calendar page consumes.
 */
export function openLinkedEvent(
  event: ProjectLinkedEvent,
  openTab: (tab: OpenableTab) => void,
  now: number
): void {
  const href = buildMemryHref({
    kind: 'calendar_event',
    id: event.id,
    date: event.startAt ? event.startAt.slice(0, 10) : null
  })
  const tab = href ? tabFromMemryHref(href, { title: event.title, now }) : null
  if (tab) openTab(tab)
}
