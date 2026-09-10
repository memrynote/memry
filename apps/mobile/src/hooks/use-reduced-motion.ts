import { useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'

import { watchReduceMotion } from '@/lib/reduce-motion'

/**
 * The device's "reduce motion" setting, live.
 *
 * `false` until the first read settles, which is the honest default: the
 * setting is off for most readers and one frame of motion is better than
 * holding the screen back on an accessibility query.
 */
export function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(
    () =>
      watchReduceMotion(
        {
          read: () => AccessibilityInfo.isReduceMotionEnabled(),
          subscribe: (listener) => {
            const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', listener)
            return () => subscription.remove()
          }
        },
        setReducedMotion
      ),
    []
  )

  return reducedMotion
}
