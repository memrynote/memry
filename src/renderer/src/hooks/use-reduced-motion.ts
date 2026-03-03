/**
 * Reduced Motion Hook
 * Respects user's motion preferences
 */

import { useState, useEffect } from 'react'

/**
 * Hook to detect if user prefers reduced motion
 */
export const useReducedMotion = (): boolean => {
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    // Check initial preference
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReducedMotion(mediaQuery.matches)

    // Listen for changes
    const handler = (e: MediaQueryListEvent): void => {
      setReducedMotion(e.matches)
    }

    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [])

  return reducedMotion
}

export default useReducedMotion
