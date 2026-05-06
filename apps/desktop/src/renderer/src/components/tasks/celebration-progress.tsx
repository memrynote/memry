import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

import { Check } from '@/lib/icons'
import { SubtaskProgressBar } from './subtask-progress-bar'
import { cn } from '@/lib/utils'
import type { SubtaskProgress } from '@/lib/subtask-utils'
import { useT } from '@memry/i18n/renderer'

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
  const { t: tPhaseF } = useT('tasks')
  const isComplete = progress.total > 0 && progress.completed === progress.total
  const [celebrationState, setCelebrationState] = useState(() => ({
    completed: progress.completed,
    total: progress.total,
    show: false
  }))

  if (
    celebrationState.completed !== progress.completed ||
    celebrationState.total !== progress.total
  ) {
    const wasComplete =
      celebrationState.total > 0 && celebrationState.completed === celebrationState.total
    const show = isComplete && !wasComplete ? true : celebrationState.show
    setCelebrationState({ completed: progress.completed, total: progress.total, show })
  }

  const showCelebration = celebrationState.show

  // Auto-hide the celebration after a few seconds.
  useEffect(() => {
    if (!showCelebration) return
    const timer = setTimeout(() => {
      setCelebrationState((prev) => ({ ...prev, show: false }))
    }, 3000)
    return () => clearTimeout(timer)
  }, [showCelebration])

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
            aria-label={tPhaseF('phaseF.componentsTasksCelebrationProgress.complete')}
          >
            <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default CelebrationProgress
