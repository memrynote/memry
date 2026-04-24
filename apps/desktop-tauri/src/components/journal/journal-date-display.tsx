import { useMemo } from 'react'
import { Sun, Sunset, Moon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { getMonthName } from '@/lib/journal-utils'
import type { JournalViewState } from './date-breadcrumb'

export type TimeOfDay = 'morning' | 'afternoon' | 'evening'

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
  morning: { icon: Sun, label: 'Good morning', iconColor: 'text-amber-500' },
  afternoon: { icon: Sunset, label: 'Good afternoon', iconColor: 'text-orange-500' },
  evening: { icon: Moon, label: 'Good evening', iconColor: 'text-indigo-400' }
}

function getTimeOfDay(): TimeOfDay {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'afternoon'
  return 'evening'
}

export function JournalDateDisplay({ viewState, dateParts, className }: JournalDateDisplayProps) {
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
          <span className="font-serif text-sm italic text-muted-foreground">{config.label}</span>
        </div>
      </div>
    )
  }

  if (viewState.type === 'month') {
    const monthName = getMonthName(viewState.month)
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
