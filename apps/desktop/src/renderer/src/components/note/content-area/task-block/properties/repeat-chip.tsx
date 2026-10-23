import { useMemo, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Check, Repeat } from '@/lib/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { CustomRepeatDialog } from '@/components/tasks/custom-repeat-dialog'
import {
  StopRepeatingDialog,
  type StopRepeatOption
} from '@/components/tasks/stop-repeating-dialog'
import { getRepeatDisplayText, getRepeatPresets } from '@/lib/repeat-utils'
import type { RepeatConfig, Task } from '@/data/task-model'
import { PropertyChip } from './property-chip'
import { shortcutLabelFor, type TaskPropertyOpenState } from './task-property-ids'

interface RepeatChipProps extends TaskPropertyOpenState {
  taskTitle: string
  repeatConfig: RepeatConfig | null
  isRepeating: boolean
  dueDate: Date | null
  onChange: (updates: Partial<Task>) => void
}

/**
 * The rule as a chip. Its menu is the repeat picker's presets plus Custom…
 * and, once set, Stop repeating — both of which keep going through the same
 * dialogs the task drawer uses, so stopping still asks first.
 */
export const RepeatChip = ({
  taskTitle,
  repeatConfig,
  isRepeating,
  dueDate,
  onChange,
  open,
  onOpenChange
}: RepeatChipProps): React.JSX.Element | null => {
  const { t } = useT('tasks')
  const { t: tCommon } = useT('common')
  const [isCustomOpen, setIsCustomOpen] = useState(false)
  const [isStopOpen, setIsStopOpen] = useState(false)

  const active = isRepeating && repeatConfig ? repeatConfig : null
  const isOpen = open === 'repeat'
  // Every block in the note renders this chip, so the presets wait for the menu.
  const presets = useMemo(() => (isOpen ? getRepeatPresets(dueDate) : []), [isOpen, dueDate])
  const displayText = active ? getRepeatDisplayText(active, tCommon) : null
  const matchingPresetId = displayText
    ? (presets.find((preset) => getRepeatDisplayText(preset.config, tCommon) === displayText)?.id ??
      null)
    : null

  const setRule = (config: RepeatConfig | null): void => {
    onChange({ repeatConfig: config, isRepeating: config !== null })
  }

  const handleStopConfirm = (option: StopRepeatOption): void => {
    if (option === 'keep') setRule(null)
  }

  // The dialogs outlive the chip: "Custom…" on a task with no rule closes the
  // menu, which unmounts the chip, and the dialog still has to open.
  const dialogs = (
    <>
      <CustomRepeatDialog
        isOpen={isCustomOpen}
        onClose={() => setIsCustomOpen(false)}
        onSave={setRule}
        initialConfig={repeatConfig}
        dueDate={dueDate}
      />
      <StopRepeatingDialog
        isOpen={isStopOpen}
        onClose={() => setIsStopOpen(false)}
        onConfirm={handleStopConfirm}
        taskTitle={taskTitle}
        repeatConfig={repeatConfig}
      />
    </>
  )

  if (!active && !isOpen) return dialogs

  const label = displayText ?? t('phaseF.componentsTasksTaskRepeatSection.repeat')

  return (
    <>
      <DropdownMenu
        modal={false}
        open={isOpen}
        onOpenChange={(next) => onOpenChange('repeat', next)}
      >
        <DropdownMenuTrigger asChild>
          <PropertyChip
            icon={<Repeat className="size-3 shrink-0" aria-hidden="true" />}
            aria-label={`${t('task.repeat')}: ${label}`}
            title={`${t('task.repeat')} · ${shortcutLabelFor('repeat')}`}
          >
            {label}
          </PropertyChip>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[240px]">
          {presets.map((preset) => (
            <DropdownMenuItem key={preset.id} onSelect={() => setRule(preset.config)}>
              <span className="flex size-4 items-center justify-center">
                {matchingPresetId === preset.id && (
                  <Check className="size-3.5" aria-hidden="true" />
                )}
              </span>
              <span className="truncate">{preset.label}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setIsCustomOpen(true)}>
            <span className="size-4" />
            <span>{t('phaseF.componentsTasksRepeatPicker.custom')}</span>
          </DropdownMenuItem>
          {active && (
            <DropdownMenuItem variant="destructive" onSelect={() => setIsStopOpen(true)}>
              <span className="size-4" />
              <span>{t('phaseF.componentsTasksTaskRepeatSection.stopRepeating2')}</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialogs}
    </>
  )
}
