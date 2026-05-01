/**
 * Snooze Countdown Hook
 *
 * Hook that returns a live-updating snooze countdown string.
 * Updates every minute automatically.
 *
 * @module components/snooze/use-snooze-countdown
 */

import { useState, useEffect, useCallback } from 'react'
import { formatSnoozeReturn } from './snooze-presets'

/**
 * Hook that returns a live-updating snooze countdown string.
 * Updates every minute.
 *
 * @param snoozedUntil - The date/time when snooze expires
 * @returns Formatted countdown string like "4h left", "1d left"
 */
export function useSnoozeCountdown(snoozedUntil: Date | string | null): string | null {
  const getFormattedTime = useCallback(() => {
    if (!snoozedUntil) return null
    const date = snoozedUntil instanceof Date ? snoozedUntil : new Date(snoozedUntil)
    return formatSnoozeReturn(date)
  }, [snoozedUntil])

  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!snoozedUntil) return

    // Set up interval to update every minute (60000ms)
    const intervalId = setInterval(() => {
      setTick((current) => current + 1)
    }, 60000)

    // Also update when window regains focus (in case app was in background)
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        setTick((current) => current + 1)
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    // Cleanup
    return (): void => {
      clearInterval(intervalId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [snoozedUntil])

  void tick
  return getFormattedTime()
}
