import { useMemo } from 'react'
import { Sun, Sunset, Moon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { createJournalDateLabels, getMonthName } from '@/lib/journal-utils'
import type { JournalViewState } from './date-breadcrumb'
import { useT } from '@memry/i18n/renderer'

export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night'

export interface DateParts {
  day: number
  month: string
  monthIndex: number
  year: number
  dayName: string
}

export interface JournalDateDisplayProps {
  viewState: JournalViewState
  dateParts: DateParts | null
  className?: string
}

const TIME_CONFIG = {
  morning: { icon: Sun, labelKey: 'date.greeting.morning', iconColor: 'text-amber-500' },
  afternoon: { icon: Sunset, labelKey: 'date.greeting.afternoon', iconColor: 'text-orange-500' },
  evening: { icon: Moon, labelKey: 'date.greeting.evening', iconColor: 'text-indigo-400' },
  night: { icon: Moon, labelKey: 'date.greeting.night', iconColor: 'text-indigo-400' }
}

function getTimeOfDay(): TimeOfDay {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'afternoon'
  if (hour >= 18 && hour < 21) return 'evening'
  return 'night'
}

export function JournalDateDisplay({ viewState, dateParts, className }: JournalDateDisplayProps) {
  const { t, i18n } = useT('journal')
  const dateLabels = useMemo(() => createJournalDateLabels(t), [t, i18n.language])
  const timeOfDay = useMemo(() => getTimeOfDay(), [])
  const config = TIME_CONFIG[timeOfDay]
  const Icon = config.icon

  if (viewState.type === 'day' && dateParts) {
    return (
      <div className={cn('flex flex-col', className)}>
        <h1
          className="text-[42px] tracking-[-0.02em] leading-12 font-normal text-text-bright"
          style={{ fontFamily: 'var(--font-heading)' }}
        >
          {dateParts.dayName}, {dateParts.month} {dateParts.day}
        </h1>
        <div className="flex items-center gap-2 mt-1.5">
          <Icon className={cn('size-4', config.iconColor)} />
          <span className="font-serif text-sm italic text-muted-foreground">
            {t(config.labelKey)}
          </span>
        </div>
      </div>
    )
  }

  if (viewState.type === 'month') {
    const monthName = getMonthName(viewState.month, dateLabels)
    return (
      <div className={cn('flex flex-col', className)}>
        <h1 className="font-display text-3xl lg:text-4xl font-normal tracking-tight text-foreground">
          {monthName} {viewState.year}
        </h1>
      </div>
    )
  }

  if (viewState.type === 'year') {
    return (
      <div className={cn('flex flex-col', className)}>
        <h1 className="font-display text-3xl lg:text-4xl font-normal tracking-tight text-foreground">
          {viewState.year}
        </h1>
      </div>
    )
  }

  return null
}

export default JournalDateDisplay
