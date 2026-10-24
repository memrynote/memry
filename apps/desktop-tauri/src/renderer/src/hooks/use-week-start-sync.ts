import { useEffect } from 'react'
import { useCalendarPreferences, weekStartsOnFromSettings } from '@/hooks/use-calendar-preferences'
import { setWeekStartsOn } from '@/lib/week-start'

// Mirrors the Calendar `weekStartDay` setting into the module-level cache so
// non-React consumers (date-mention pills, pure task-filter utils) see the
// global value regardless of which view is mounted. Mount once at the app root.
export function useWeekStartSync(): void {
  const { settings } = useCalendarPreferences()
  const weekStartsOn = weekStartsOnFromSettings(settings)
  useEffect(() => {
    setWeekStartsOn(weekStartsOn)
  }, [weekStartsOn])
}
