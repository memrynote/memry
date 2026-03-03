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

  const [countdown, setCountdown] = useState<string | null>(getFormattedTime)

  useEffect(() => {
    if (!snoozedUntil) {
      setCountdown(null)
      return
    }

    // Update immediately
    setCountdown(getFormattedTime())

    // Set up interval to update every minute (60000ms)
    const intervalId = setInterval(() => {
      setCountdown(getFormattedTime())
    }, 60000)

    // Also update when window regains focus (in case app was in background)
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        setCountdown(getFormattedTime())
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    // Cleanup
    return (): void => {
      clearInterval(intervalId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [snoozedUntil, getFormattedTime])

  return countdown
}
