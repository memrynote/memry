import { useState, useCallback } from 'react'
import { Plus } from '@/lib/icons'
import type { RepeatConfig } from '@/data/sample-tasks'
import { getRepeatDisplayText } from '@/lib/repeat-utils'
import { formatDateShort } from '@/lib/task-utils'
import { CustomRepeatDialog } from './custom-repeat-dialog'
import { StopRepeatingDialog, type StopRepeatOption } from './stop-repeating-dialog'
import { useT } from '@memry/i18n/renderer'

interface TaskRepeatSectionProps {
  taskTitle: string
  repeatConfig: RepeatConfig | null
  isRepeating: boolean
  dueDate: Date | null
  projectColor: string
  onRepeatChange: (config: RepeatConfig | null) => void
}

const buildRepeatInfoLine = (config: RepeatConfig): string => {
  const parts = ['From: Due date']
  if (config.endType === 'never') parts.push('Ends: Never')
  else if (config.endType === 'date' && config.endDate)
    parts.push(`Ends: ${formatDateShort(config.endDate)}`)
  else if (config.endType === 'count' && config.endCount)
    parts.push(`Ends: After ${config.endCount}x`)
  parts.push(`Done: ${config.completedCount}x`)
  return parts.join(' | ')
}

const RepeatIcon = ({ color }: { color: string }): React.JSX.Element => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    className="shrink-0"
    style={{ color }}
  >
    <path
      d="M2 7a5 5 0 0 1 9-3M12 7a5 5 0 0 1-9 3"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
    <path
      d="M11 2v2.5h-2.5M3 12V9.5h2.5"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const TaskRepeatSection = ({
  taskTitle,
  repeatConfig,
  isRepeating,
  dueDate,
  projectColor,
  onRepeatChange
}: TaskRepeatSectionProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('tasks')
  const { t } = useT('common')
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [isStopDialogOpen, setIsStopDialogOpen] = useState(false)

  const handleSaveRepeat = useCallback(
    (config: RepeatConfig) => {
      onRepeatChange(config)
    },
    [onRepeatChange]
  )

  const handleStopConfirm = useCallback(
    (option: StopRepeatOption) => {
      if (option === 'keep') {
        onRepeatChange(null)
      }
    },
    [onRepeatChange]
  )

  const active = isRepeating && repeatConfig

  return (
    <div className="flex flex-col py-4 px-5 gap-2 border-b border-border">
      <div className="flex items-center justify-between">
        <span className="text-[11px] [letter-spacing:0.05em] uppercase text-text-tertiary font-medium leading-3.5">
          {tPhaseF('phaseF.componentsTasksTaskRepeatSection.repeat')}
        </span>
        {active ? (
          <RepeatIcon color="var(--text-tertiary)" />
        ) : (
          <button
            type="button"
            onClick={() => setIsEditDialogOpen(true)}
            className="text-text-tertiary hover:text-text-secondary transition-colors"
            aria-label={tPhaseF('phaseF.componentsTasksTaskRepeatSection.addRepeat')}
          >
            <Plus size={14} />
          </button>
        )}
      </div>

      {active && (
        <>
          <div className="flex items-center rounded-md py-2 px-2.5 gap-2 bg-foreground/[0.03]">
            <RepeatIcon color={projectColor} />
            <div className="flex flex-col gap-0.5">
              <span className="text-[12px] text-text-primary font-medium leading-4">
                {getRepeatDisplayText(repeatConfig, t)}
              </span>
              <span className="text-[11px] text-text-tertiary leading-3.5">
                {buildRepeatInfoLine(repeatConfig)}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsEditDialogOpen(true)}
              className="flex items-center rounded-[5px] py-1 px-2.5 border border-foreground/10"
              aria-label={tPhaseF('phaseF.componentsTasksTaskRepeatSection.edit')}
            >
              <span className="text-[11px] text-text-primary font-medium leading-3.5">
                {tPhaseF('phaseF.componentsTasksTaskRepeatSection.edit2')}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setIsStopDialogOpen(true)}
              className="flex items-center rounded-[5px] py-1 px-2.5 border border-foreground/10"
              aria-label={tPhaseF('phaseF.componentsTasksTaskRepeatSection.stopRepeating')}
            >
              <span className="text-[11px] text-text-primary font-medium leading-3.5">
                {tPhaseF('phaseF.componentsTasksTaskRepeatSection.stopRepeating2')}
              </span>
            </button>
          </div>
        </>
      )}

      <CustomRepeatDialog
        isOpen={isEditDialogOpen}
        onClose={() => setIsEditDialogOpen(false)}
        onSave={handleSaveRepeat}
        initialConfig={repeatConfig}
        dueDate={dueDate}
      />

      <StopRepeatingDialog
        isOpen={isStopDialogOpen}
        onClose={() => setIsStopDialogOpen(false)}
        onConfirm={handleStopConfirm}
        taskTitle={taskTitle}
        repeatConfig={repeatConfig}
      />
    </div>
  )
}
