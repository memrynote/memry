import { useT } from '@memry/i18n/renderer'
import { formatReminderDate } from '@/components/reminder/reminder-presets'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useNextTaskReminders } from '@/hooks/use-reminders'
import { ArrowRight, BellRing } from '@/lib/icons'
import { formatDateShort } from '@/lib/task-utils'

export const TaskRowReminder = ({ taskId }: { taskId: string }): React.JSX.Element | null => {
  const { t } = useT('tasks')
  const {
    settings: { clockFormat }
  } = useGeneralSettings()
  const remindAt = useNextTaskReminders().get(taskId)
  if (!remindAt) return null
  const label = t('reminders.summary', {
    date: formatReminderDate(new Date(remindAt), clockFormat)
  })
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0" aria-label={label}>
            <BellRing className="size-3 text-amber-500" aria-hidden />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** Start date, with an arrow toward the due date when the row shows one. */
export const TaskRowStartDate = ({
  startDate,
  hasDueDisplay
}: {
  startDate: Date | null | undefined
  hasDueDisplay: boolean
}): React.JSX.Element | null => {
  if (!startDate) return null
  return (
    <div className="flex items-center gap-1 text-[11px] shrink-0 leading-3.5 whitespace-nowrap text-text-tertiary has-[svg]:-me-1.5">
      <span>{formatDateShort(startDate)}</span>
      {hasDueDisplay && <ArrowRight className="size-3 rtl:rotate-180" aria-hidden />}
    </div>
  )
}
