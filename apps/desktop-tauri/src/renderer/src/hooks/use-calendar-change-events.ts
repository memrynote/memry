import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { onCalendarChanged } from '@/services/calendar-service'
import { calendarRangeKeys } from './use-calendar-range'

/**
 * App-level cache invalidation for every calendar range query.
 *
 * `useCalendarRange` subscribes to `calendar:changed` too, but that subscription
 * lives and dies with the component holding it, and only the active tab of a group
 * is mounted. So a change that lands while the Home board sits in a background tab
 * -- an event created on the Calendar tab, or one a connected provider syncs in
 * while the user is somewhere else -- had no listener at all. The board's cached
 * range stayed valid for its 30s `staleTime`, and re-activating the tab inside that
 * window served the cache instead of refetching, which is the widget "never picking
 * up" a new event.
 *
 * Called once in App.tsx, this listener outlives every tab switch, so an unmounted
 * tab's range is marked invalidated when the change happens and refetches the moment
 * it is shown again. Same reasoning as `useFolderViewEvents`.
 */
export function useCalendarChangeEvents(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    const invalidate = (): void => {
      void queryClient.invalidateQueries({ queryKey: calendarRangeKeys.all() })
    }

    const unsubscribeCalendar = onCalendarChanged(invalidate)

    // Calendar settings (e.g. "show notes on calendar") change what the projection
    // returns for a range, so they invalidate the same keys.
    const unsubscribeSettings = window.api.onSettingsChanged((event) => {
      if (event.key === 'calendar') invalidate()
    })

    return () => {
      unsubscribeCalendar()
      unsubscribeSettings()
    }
  }, [queryClient])
}
