import { useId } from 'react'
import { LayoutGroup, motion, useReducedMotion } from 'motion/react'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { ChevronLeft, ChevronRight, Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import { parseLocalDate } from './date-utils'
import { CalendarSearch } from './calendar-search'
import type { AnchorRect } from './types'

export type CalendarWorkspaceView = 'day' | 'week' | 'month' | 'year'

const VIEW_LABEL_KEYS: Record<CalendarWorkspaceView, `view.${CalendarWorkspaceView}`> = {
  day: 'view.day',
  week: 'view.week',
  month: 'view.month',
  year: 'view.year'
}

const VIEW_OPTIONS = Object.keys(VIEW_LABEL_KEYS) as CalendarWorkspaceView[]

interface CalendarToolbarProps {
  view: CalendarWorkspaceView
  anchorDate: string
  onViewChange: (view: CalendarWorkspaceView) => void
  onPrevious: () => void
  onNext: () => void
  onToday: () => void
  onCreateEvent: (anchorRect: AnchorRect) => void
  onSearchJump: (item: CalendarProjectionItem) => void
  extraActions?: React.ReactNode
}

export function CalendarToolbar({
  view,
  anchorDate,
  onViewChange,
  onPrevious,
  onNext,
  onToday,
  onCreateEvent,
  onSearchJump,
  extraActions
}: CalendarToolbarProps): React.JSX.Element {
  const { t, i18n } = useT('calendar')
  const prefersReducedMotion = useReducedMotion()
  const layoutGroupId = useId()
  const anchorParsed = parseLocalDate(anchorDate)
  const monthName = new Intl.DateTimeFormat(i18n.language, { month: 'long' }).format(anchorParsed)
  const yearStr = String(anchorParsed.getFullYear())

  return (
    <div className="flex h-12 items-center gap-1.5 px-3 @xl:gap-2.5 @xl:px-6">
      <h2 className="min-w-0 truncate text-base font-bold tracking-tight text-foreground @xl:text-lg">
        {view === 'year' ? (
          yearStr
        ) : (
          <>
            {monthName} <span className="font-normal text-muted-foreground">{yearStr}</span>
          </>
        )}
      </h2>

      <div className="min-w-2 flex-1" />

      {/* View switcher — the active pill springs between options instead of teleporting */}
      <LayoutGroup id={layoutGroupId}>
        <div className="flex shrink-0 items-center rounded-full bg-surface-active/80 p-0.5">
          {VIEW_OPTIONS.map((option) => {
            const isActive = view === option
            return (
              <button
                key={option}
                type="button"
                aria-pressed={isActive}
                onClick={() => onViewChange(option)}
                className={cn(
                  'relative rounded-full px-2.5 py-1 text-xs font-medium',
                  'transition-colors duration-150 ease-out active:scale-[0.97] @xl:px-3',
                  isActive ? 'text-tint-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {isActive && (
                  <motion.span
                    layoutId="calendar-view-pill"
                    aria-hidden="true"
                    transition={
                      prefersReducedMotion
                        ? { duration: 0 }
                        : { type: 'spring', bounce: 0, duration: 0.35 }
                    }
                    className="absolute inset-0 rounded-full bg-tint"
                  />
                )}
                <span className="relative z-10">{t(VIEW_LABEL_KEYS[option])}</span>
              </button>
            )
          })}
        </div>
      </LayoutGroup>

      <div className="flex shrink-0 items-center rounded-full bg-surface-active/80">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="rounded-full text-muted-foreground transition-all duration-150 ease-out hover:bg-surface-active hover:text-foreground active:scale-95"
          onClick={onPrevious}
          aria-label={t('toolbar.previous-period')}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <button
          type="button"
          onClick={onToday}
          className="px-2 py-1 text-xs font-medium text-muted-foreground transition-all duration-150 ease-out hover:text-foreground active:scale-95 @xl:px-3 @xl:text-sm"
        >
          {t('toolbar.today')}
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="rounded-full text-muted-foreground transition-all duration-150 ease-out hover:bg-surface-active hover:text-foreground active:scale-95"
          onClick={onNext}
          aria-label={t('toolbar.next-period')}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      <div className="flex shrink-0 items-center gap-1 @xl:gap-1.5">
        {extraActions}
        <CalendarSearch onJump={onSearchJump} />
        <button
          type="button"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            onCreateEvent({
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height
            })
          }}
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-tint text-tint-foreground shadow-sm transition-all duration-150 ease-out hover:brightness-110 active:scale-95"
          aria-label={t('toolbar.create-event')}
        >
          <Plus className="size-4" />
        </button>
      </div>
    </div>
  )
}

export default CalendarToolbar
