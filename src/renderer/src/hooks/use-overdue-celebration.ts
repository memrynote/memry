import { useState, useEffect, useRef, useCallback } from "react"

// ============================================================================
// TYPES
// ============================================================================

interface UseOverdueCelebrationResult {
  /** Whether to show the celebration banner */
  showCelebration: boolean
  /** Manually dismiss the celebration banner */
  dismiss: () => void
}

interface UseOverdueCelebrationOptions {
  /** Duration in ms before auto-dismissing (default: 3000) */
  autoDismissDelay?: number
  /** Whether to enable auto-dismiss (default: true) */
  autoDismiss?: boolean
}

// ============================================================================
// USE OVERDUE CELEBRATION HOOK
// ============================================================================

/**
 * Hook to track when overdue tasks are cleared and show a celebration.
 *
 * The celebration is triggered when:
 * 1. The previous overdue count was > 0
 * 2. The current overdue count is 0
 *
 * The celebration auto-dismisses after a configurable delay.
 *
 * @param overdueCount - Current number of overdue tasks
 * @param options - Configuration options
 * @returns Object with showCelebration state and dismiss function
 *
 * @example
 * ```tsx
 * const { showCelebration, dismiss } = useOverdueCelebration(overdueTasksCount)
 *
 * return (
 *   <AnimatePresence>
 *     {showCelebration && <OverdueClearedBanner onDismiss={dismiss} />}
 *   </AnimatePresence>
 * )
 * ```
 */
export const useOverdueCelebration = (
  overdueCount: number,
  options: UseOverdueCelebrationOptions = {}
): UseOverdueCelebrationResult => {
  const { autoDismissDelay = 3000, autoDismiss = true } = options

  const [showCelebration, setShowCelebration] = useState(false)
  const prevCountRef = useRef(overdueCount)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear any existing timer
  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // Dismiss the celebration
  const dismiss = useCallback(() => {
    clearTimer()
    setShowCelebration(false)
  }, [clearTimer])

  useEffect(() => {
    // Check if overdue tasks were just cleared (went from >0 to 0)
    if (prevCountRef.current > 0 && overdueCount === 0) {
      setShowCelebration(true)

      // Auto-dismiss after delay
      if (autoDismiss) {
        clearTimer()
        timerRef.current = setTimeout(() => {
          setShowCelebration(false)
        }, autoDismissDelay)
      }
    }

    // Update the previous count reference
    prevCountRef.current = overdueCount

    // Cleanup timer on unmount
    return () => {
      clearTimer()
    }
  }, [overdueCount, autoDismiss, autoDismissDelay, clearTimer])

  return { showCelebration, dismiss }
}

export default useOverdueCelebration
