import { useMemo, type CSSProperties } from 'react'
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

// Time-of-day tinted fog drifting behind the date. Two radial blobs (::before /
// ::after) read these custom properties; see `.journal-date-fog` in base.css.
const FOG_CONFIG: Record<TimeOfDay, { tint: string; tint2: string }> = {
  morning: { tint: 'rgba(217, 119, 6, 0.72)', tint2: 'rgba(245, 158, 11, 0.55)' },
  afternoon: { tint: 'rgba(234, 88, 12, 0.72)', tint2: 'rgba(249, 115, 22, 0.52)' },
  evening: { tint: 'rgba(99, 102, 241, 0.75)', tint2: 'rgba(79, 70, 229, 0.55)' },
  night: { tint: 'rgba(79, 70, 229, 0.82)', tint2: 'rgba(67, 56, 202, 0.62)' }
}

function getTimeOfDay(): TimeOfDay {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'afternoon'
  if (hour >= 18 && hour < 21) return 'evening'
  return 'night'
}

export function JournalDateDisplay({ viewState, dateParts, className }: JournalDateDisplayProps) {
  const { t, i18n: _i18n } = useT('journal')
  const dateLabels = useMemo(() => createJournalDateLabels(t), [t])
  const timeOfDay = useMemo(() => getTimeOfDay(), [])

  if (viewState.type === 'day' && dateParts) {
    const fog = FOG_CONFIG[timeOfDay]
    return (
      <div className={cn('relative flex flex-col', className)}>
        <div
          className="journal-date-fog"
          style={{ '--fog-tint': fog.tint, '--fog-tint-2': fog.tint2 } as CSSProperties}
          aria-hidden="true"
        />
        <h1
          className="relative z-[1] text-[42px] tracking-[-0.02em] leading-12 font-normal text-text-bright"
          style={{ fontFamily: 'var(--font-heading)' }}
        >
          {dateParts.dayName}, {dateParts.month} {dateParts.day}
        </h1>
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
