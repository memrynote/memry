import { useEffect, useState } from 'react'
import {
  GOOGLE_CALENDAR_PROVIDER,
  type ProviderCalendarDescriptorRecord
} from '@memry/contracts/calendar-api'
import { createLogger } from '@/lib/logger'

const log = createLogger('WritableCalendars')

export interface WritableCalendarGroup {
  provider: string
  calendars: ProviderCalendarDescriptorRecord[]
  currentDefaultId: string | null
}

/**
 * Writable calendars from every provider other than Google (#2372), one group
 * per provider. Google's list keeps its own hook and query key, so the event
 * form reads exactly what it always did when Google is the only writer.
 */
async function listOtherWritableCalendars(): Promise<WritableCalendarGroup[]> {
  const { providers } = await window.api.calendar.listProviders()
  const writable = providers.filter(
    (provider) => provider.id !== GOOGLE_CALENDAR_PROVIDER && provider.capabilities.supportsWrite
  )
  const groups = await Promise.all(
    writable.map(async ({ id }) => {
      const listed = await window.api.calendar.listProviderCalendars({ provider: id })
      return {
        provider: id,
        calendars: listed.calendars,
        currentDefaultId: listed.currentDefaultId
      }
    })
  )
  return groups.filter((group) => group.calendars.length > 0)
}

export function useOtherWritableCalendars(): { groups: WritableCalendarGroup[] } {
  const [groups, setGroups] = useState<WritableCalendarGroup[]>([])

  useEffect(() => {
    let cancelled = false
    listOtherWritableCalendars()
      .then((next) => {
        if (!cancelled) setGroups(next)
      })
      .catch((error: unknown) => {
        log.warn('Could not list writable calendars from other providers', error)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { groups }
}
