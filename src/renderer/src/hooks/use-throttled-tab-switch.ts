/**
 * Throttled Tab Switch Hook
 * Prevents rapid tab switching that could cause performance issues
 */

import { useRef, useCallback } from 'react'
import { useTabs } from '@/contexts/tabs'

interface UseThrottledTabSwitchOptions {
  /** Throttle delay in ms (default: 50) */
  delayMs?: number
}

/**
 * Hook that provides a throttled setActiveTab function
 */
export const useThrottledTabSwitch = (
  options: UseThrottledTabSwitchOptions = {}
): ((tabId: string, groupId: string) => void) => {
  const { delayMs = 50 } = options
  const { setActiveTab } = useTabs()
  const lastSwitchRef = useRef(0)

  const throttledSetActiveTab = useCallback(
    (tabId: string, groupId: string): void => {
      const now = Date.now()

      if (now - lastSwitchRef.current < delayMs) {
        return // Throttled
      }

      lastSwitchRef.current = now
      setActiveTab(tabId, groupId)
    },
    [setActiveTab, delayMs]
  )

  return throttledSetActiveTab
}

export default useThrottledTabSwitch
