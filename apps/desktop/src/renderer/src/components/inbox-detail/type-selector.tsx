/**
 * Type selector — inbox detail panel.
 *
 * Segmented control choosing what the captured item becomes:
 * Note (file to a folder) · Task · Event · Reminder. Replaces the old bottom
 * "Convert" row; the selection drives the panel body and primary action.
 * Binary items (image/pdf/video/clip) can only become a note, so the other
 * options are disabled with a tooltip.
 */

import { FileText, ListTodo, CalendarClock, Bell } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ConvertType } from './convert-types'

interface TypeSelectorProps {
  value: ConvertType
  onChange: (type: ConvertType) => void
  noteOnly: boolean
}

const OPTIONS: { type: ConvertType; icon: React.ReactNode }[] = [
  { type: 'note', icon: <FileText className="size-3.5" aria-hidden="true" /> },
  { type: 'task', icon: <ListTodo className="size-3.5" aria-hidden="true" /> },
  { type: 'event', icon: <CalendarClock className="size-3.5" aria-hidden="true" /> },
  { type: 'reminder', icon: <Bell className="size-3.5" aria-hidden="true" /> }
]

export const TypeSelector = ({
  value,
  onChange,
  noteOnly
}: TypeSelectorProps): React.JSX.Element => {
  const { t } = useT('inbox')

  return (
    <TooltipProvider>
      <div
        role="radiogroup"
        aria-label={t('convert.chooseType')}
        className="grid grid-cols-4 gap-1 p-1 rounded-md bg-foreground/[0.03] border border-border"
      >
        {OPTIONS.map((opt) => {
          const disabled = noteOnly && opt.type !== 'note'
          const selected = value === opt.type
          const button = (
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(opt.type)}
              className={cn(
                'flex w-full items-center justify-center gap-1.5 rounded-sm py-1.5 text-[12px] transition-colors',
                selected
                  ? 'bg-[var(--tint)]/10 text-[var(--tint)] font-medium'
                  : 'text-muted-foreground hover:text-foreground',
                disabled && 'opacity-40 cursor-not-allowed hover:text-muted-foreground'
              )}
            >
              {opt.icon}
              {t(`convert.${opt.type}`)}
            </button>
          )

          if (disabled) {
            return (
              <Tooltip key={opt.type}>
                <TooltipTrigger asChild>
                  <span className="flex">{button}</span>
                </TooltipTrigger>
                <TooltipContent>{t('convert.binaryOnlyNote')}</TooltipContent>
              </Tooltip>
            )
          }
          return (
            <span key={opt.type} className="flex">
              {button}
            </span>
          )
        })}
      </div>
    </TooltipProvider>
  )
}
