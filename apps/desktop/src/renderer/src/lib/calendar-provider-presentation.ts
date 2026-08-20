import type { AppIcon } from '@/lib/icons'
import { Calendar, CalendarDays, Link2, Server } from '@/lib/icons'

/**
 * Everything about a calendar provider that main cannot tell the renderer: the
 * icon to draw and which `integrations.registry.*` block holds its name and
 * description. Capabilities come from `calendar:list-providers`, not from here
 * — this file must never become a second source of truth for behavior.
 */
export interface CalendarProviderPresentation {
  icon: AppIcon
  /** Key under `integrations.registry.*` in the settings namespace. */
  i18nKey: string
}

const PRESENTATION: Record<string, CalendarProviderPresentation> = {
  google: { icon: Calendar, i18nKey: 'googleCalendar' },
  ics: { icon: Link2, i18nKey: 'icsSubscription' },
  caldav: { icon: Server, i18nKey: 'caldav' },
  microsoft: { icon: CalendarDays, i18nKey: 'outlookCalendar' },
  apple: { icon: CalendarDays, i18nKey: 'appleCalendar' }
}

/**
 * A provider id this build's renderer has never heard of still has to render.
 * That happens the moment main ships a provider ahead of the UI, and a blank
 * row would read as a bug.
 */
const FALLBACK: CalendarProviderPresentation = { icon: Calendar, i18nKey: 'unknownCalendar' }

export function calendarProviderPresentation(providerId: string): CalendarProviderPresentation {
  return PRESENTATION[providerId] ?? FALLBACK
}
