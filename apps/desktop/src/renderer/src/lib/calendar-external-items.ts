import { GOOGLE_CALENDAR_PROVIDER } from '@memry/contracts/calendar-api'
import type { CalendarProjectionItem } from '@/services/calendar-service'

/**
 * An external event nothing in Memry can edit or promote: it comes from a
 * provider without a write path (a subscribed feed). Read from the projection's
 * `editability`, which main derives from the provider's capabilities (#1391),
 * never from the provider id.
 */
export function isReadOnlyExternalItem(
  item: Pick<CalendarProjectionItem, 'sourceType' | 'editability'>
): boolean {
  if (item.sourceType !== 'external_event') return false
  const { canMove, canResize, canEditText, canDelete } = item.editability
  return !canMove && !canResize && !canEditText && !canDelete
}

/**
 * The short label shown next to an external event: "Google" for Google, and
 * the calendar's own name for every other provider (a feed's title, a CalDAV
 * collection's display name).
 */
export function externalEventSourceLabel(
  source: Pick<CalendarProjectionItem['source'], 'provider' | 'title'>
): string | null {
  if (!source.provider) return null
  if (source.provider === GOOGLE_CALENDAR_PROVIDER) return 'Google'
  return source.title ?? source.provider
}
