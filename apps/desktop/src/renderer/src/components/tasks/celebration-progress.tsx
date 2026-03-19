import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

import { Check } from '@/lib/icons'
import { SubtaskProgressBar } from './subtask-progress-bar'
import { cn } from '@/lib/utils'
import type { SubtaskProgress } from '@/lib/subtask-utils'

// ============================================================================
// TYPES
// ============================================================================

interface CelebrationProgressProps {
  progress: SubtaskProgress
  size?: 'sm' | 'md'
  showLabel?: boolean
  className?: string
}

// ============================================================================
// CELEBRATION PROGRESS COMPONENT
// Progress bar with sparkle animation when 100% complete
// ============================================================================

export const CelebrationProgress = ({
  progress,
  size = 'sm',
  showLabel = true,
  className
}: CelebrationProgressProps): React.JSX.Element | null => {
  const [showCelebration, setShowCelebration] = useState(false)
  const prevCompletedRef = useRef<number>(progress.completed)
  const prevTotalRef = useRef<number>(progress.total)

  const isComplete = progress.total > 0 && progress.completed === progress.total

  // Detect transition from incomplete to complete
  useEffect(() => {
    const prevCompleted = prevCompletedRef.current
    const prevTotal = prevTotalRef.current
    const wasComplete = prevTotal > 0 && prevCompleted === prevTotal
    const justCompleted = isComplete && !wasComplete
    let timer: ReturnType<typeof setTimeout> | null = null

    if (justCompleted) {
      setShowCelebration(true)
      timer = setTimeout(() => {
        setShowCelebration(false)
      }, 3000) // Show for 3 seconds
    }

    // Update refs for next comparison
    prevCompletedRef.current = progress.completed
    prevTotalRef.current = progress.total

    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [progress.completed, progress.total, isComplete])

  // Don't render if no subtasks
  if (progress.total === 0) return null

  return (
    <div className={cn('relative flex items-center overflow-visible', className)}>
      {/* Progress bar with celebration styling */}
      <div className={cn('flex-1 relative', showCelebration && 'z-10')}>
        <SubtaskProgressBar progress={progress} size={size} showLabel={showLabel} />

        {/* Pulse ring effect when complete */}
        <AnimatePresence>
          {showCelebration && (
            <motion.div
              initial={{ scale: 1, opacity: 0.8 }}
              animate={{ scale: 1.5, opacity: 0 }}
              transition={{ duration: 0.8, ease: 'easeOut' }}
              className="absolute inset-0 rounded-full border-2 border-task-complete pointer-events-none"
            />
          )}
        </AnimatePresence>
      </div>

      {/* Subtle checkmark animation */}
      <AnimatePresence>
        {showCelebration && (
          <motion.div
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="ml-2 flex items-center justify-center w-4 h-4 rounded-full bg-task-complete"
            aria-label="Complete"
          >
            <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default CelebrationProgress
