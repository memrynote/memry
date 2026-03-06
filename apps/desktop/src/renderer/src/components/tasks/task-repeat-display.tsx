import { useState, useMemo, useCallback } from 'react'
import { SkipForward } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { RepeatPicker } from './repeat-picker'
import { CustomRepeatDialog } from './custom-repeat-dialog'
import type { RepeatConfig } from '@/data/sample-tasks'
import {
  getRepeatDisplayText,
  calculateNextOccurrences,
  getRepeatProgress
} from '@/lib/repeat-utils'
import { formatDateShort } from '@/lib/task-utils'

// ============================================================================
// TYPES
// ============================================================================

interface TaskRepeatDisplayProps {
  isRepeating: boolean
  repeatConfig: RepeatConfig | null
  dueDate?: Date | null
  onConfigChange?: (config: RepeatConfig | null) => void
  onSkipOccurrence?: () => void
  onToggle?: () => void
  className?: string
}

// ============================================================================
// PROGRESS BAR SUB-COMPONENT
// ============================================================================

interface RepeatProgressBarProps {
  current: number
  total: number
  percentage: number
}

const RepeatProgressBar = ({
  current,
  total,
  percentage
}: RepeatProgressBarProps): React.JSX.Element => {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Progress: {current} of {total} completed
        </span>
        <span>{percentage}%</span>
      </div>
      <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  )
}

// ============================================================================
// TASK REPEAT DISPLAY COMPONENT
// ============================================================================

export const TaskRepeatDisplay = ({
  isRepeating,
  repeatConfig,
  dueDate,
  onConfigChange,
  onSkipOccurrence,
  onToggle,
  className
}: TaskRepeatDisplayProps): React.JSX.Element => {
  const [isCustomDialogOpen, setIsCustomDialogOpen] = useState(false)

  // Get next occurrences for preview
  const nextOccurrences = useMemo(() => {
    if (!isRepeating || !repeatConfig || !dueDate) return []
    return calculateNextOccurrences(dueDate, repeatConfig, 3)
  }, [isRepeating, repeatConfig, dueDate])

  // Get progress for count-limited repeats
  const progress = useMemo(() => {
    if (!repeatConfig) return null
    return getRepeatProgress(repeatConfig)
  }, [repeatConfig])

  // Get end info text
  const endInfo = useMemo(() => {
    if (!repeatConfig) return null
    if (repeatConfig.endType === 'date' && repeatConfig.endDate) {
      return `Ends: ${formatDateShort(repeatConfig.endDate)}`
    }
    if (repeatConfig.endType === 'count' && repeatConfig.endCount && progress) {
      const remaining = repeatConfig.endCount - repeatConfig.completedCount
      return `${remaining} remaining`
    }
    return null
  }, [repeatConfig, progress])

  const handleConfigChange = useCallback(
    (config: RepeatConfig | null): void => {
      onConfigChange?.(config)
    },
    [onConfigChange]
  )

  const handleOpenCustomDialog = useCallback((): void => {
    setIsCustomDialogOpen(true)
  }, [])

  const handleCustomDialogSave = useCallback(
    (config: RepeatConfig): void => {
      onConfigChange?.(config)
      setIsCustomDialogOpen(false)
    },
    [onConfigChange]
  )

  const handleSkipClick = useCallback((): void => {
    onSkipOccurrence?.()
  }, [onSkipOccurrence])

  // Legacy toggle handler (if no onConfigChange provided)
  const handleLegacyClick = useCallback((): void => {
    if (!onConfigChange && onToggle) {
      onToggle()
    }
  }, [onConfigChange, onToggle])

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {/* Section label */}
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Repeat</h3>

      {/* RepeatPicker or legacy button */}
      {onConfigChange ? (
        <RepeatPicker
          value={repeatConfig}
          dueDate={dueDate || null}
          onChange={handleConfigChange}
          onOpenCustomDialog={handleOpenCustomDialog}
        />
      ) : (
        <button
          type="button"
          onClick={handleLegacyClick}
          className={cn(
            'flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm transition-colors',
            'hover:border-primary hover:bg-accent/50 focus:outline-none focus:ring-2 focus:ring-ring'
          )}
          aria-label="Configure repeat settings"
        >
          <span className={cn('flex-1 text-left', !isRepeating && 'text-muted-foreground')}>
            {isRepeating && repeatConfig ? getRepeatDisplayText(repeatConfig) : 'Does not repeat'}
          </span>
        </button>
      )}

      {/* Progress bar for count-limited repeats */}
      {isRepeating && progress && (
        <RepeatProgressBar
          current={progress.current}
          total={progress.total}
          percentage={progress.percentage}
        />
      )}

      {/* Next occurrences preview */}
      {isRepeating && nextOccurrences.length > 1 && (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>Next: {formatDateShort(nextOccurrences[1])}</span>
          {nextOccurrences.length > 2 && (
            <span>After that: {formatDateShort(nextOccurrences[2])}</span>
          )}
          {endInfo && <span className="mt-1">{endInfo}</span>}
        </div>
      )}

      {/* Skip occurrence button */}
      {isRepeating && onSkipOccurrence && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSkipClick}
          className="justify-start text-muted-foreground hover:text-foreground"
        >
          <SkipForward className="mr-2 size-4" />
          Skip this occurrence
        </Button>
      )}

      {/* Custom repeat dialog */}
      <CustomRepeatDialog
        isOpen={isCustomDialogOpen}
        onClose={() => setIsCustomDialogOpen(false)}
        onSave={handleCustomDialogSave}
        initialConfig={repeatConfig}
        dueDate={dueDate}
      />
    </div>
  )
}

export default TaskRepeatDisplay
