import { Fragment } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useTaskWorkspaceData } from '@/features/tasks/use-task-queries'
import { getTaskCounts } from '@/lib/task-utils/task-view-helpers'
import { useCalendarRange } from '@/hooks/use-calendar-range'
import { getGreetingKey, buildHeaderMetrics } from '@/lib/home/header-helpers'
import type { HomePage, WidgetType } from '@/lib/home/types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { WidgetGallery } from '@/components/home/widget-gallery'
import { Check, ChevronDown, Plus, Trash } from '@/lib/icons/icon-map'

// Start/end of the local day as ISO strings. Stable for the whole day, so the
// calendar query key doesn't churn between renders.
function todayRangeIso(): { startAt: string; endAt: string } {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  return { startAt: start.toISOString(), endAt: end.toISOString() }
}

interface HomeHeaderProps {
  boards: HomePage[]
  activeBoardId: string | null
  onSelectBoard: (id: string) => void
  onCreateBoard: () => void
  onDeleteBoard: (id: string) => void
  showAddWidget: boolean
  galleryOpen: boolean
  onGalleryOpenChange: (open: boolean) => void
  onAddWidget: (type: WidgetType) => void
}

/**
 * Home page header: time-of-day greeting, today's date, live metrics
 * (tasks due today · events), and a layout switcher dropdown.
 */
export function HomeHeader({
  boards,
  activeBoardId,
  onSelectBoard,
  onCreateBoard,
  onDeleteBoard,
  showAddWidget,
  galleryOpen,
  onGalleryOpenChange,
  onAddWidget
}: HomeHeaderProps): React.JSX.Element {
  const { t, i18n } = useT('common')

  const { tasks, projects } = useTaskWorkspaceData({ enabled: true })
  const tasksDue = getTaskCounts(tasks, 'today', 'view', projects).dueToday
  const { items } = useCalendarRange(todayRangeIso())

  const activeName = boards.find((b) => b.id === activeBoardId)?.name ?? t('home.board.label')

  // ponytail: greeting/date computed once per render; no timer to roll them at
  // midnight/hour boundaries — next interaction re-renders them.
  const now = new Date()
  const greeting = t(`home.greeting.${getGreetingKey(now.getHours())}`)
  const date = now.toLocaleDateString(i18n.language, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })
  const metrics = buildHeaderMetrics({ tasksDue, events: items.length })

  return (
    <div className="flex items-end justify-between px-6 pt-7 pb-5.5 [font-synthesis:none] antialiased">
      <div className="flex flex-col gap-2">
        <h1 className="font-serif font-semibold tracking-[-0.022em] text-foreground text-[34px]/10">
          {greeting}
        </h1>
        <div className="flex items-center gap-2.5">
          <span className="text-text-tertiary text-[13px]/4">{date}</span>
          {metrics.map((m) => (
            <Fragment key={m.key}>
              <span
                aria-hidden="true"
                className="size-0.75 shrink-0 rounded-full bg-text-tertiary"
              />
              <span className="text-text-secondary text-[13px]/4">
                {t(`home.header.${m.key}`, { count: m.count })}
              </span>
            </Fragment>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            data-testid="home-layout-switcher"
            aria-label={t('home.board.label')}
            className="flex h-7.5 items-center gap-1.5 rounded-full border border-border bg-card px-2.75 text-text-secondary text-[12px]/4 transition-[background-color,transform] duration-100 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)] motion-safe:active:scale-[0.96]"
          >
            <span className="max-w-40 truncate font-medium">{activeName}</span>
            <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            {boards.map((b) => (
              <DropdownMenuItem
                key={b.id}
                data-testid="home-layout-item"
                data-board-id={b.id}
                onSelect={() => onSelectBoard(b.id)}
              >
                <span className="flex-1 truncate">{b.name}</span>
                {b.id === activeBoardId && (
                  <Check className="size-4 shrink-0 opacity-70" aria-hidden="true" />
                )}
                {boards.length > 1 && (
                  <button
                    type="button"
                    data-testid="home-layout-delete"
                    aria-label={t('home.board.deleteAria')}
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteBoard(b.id)
                    }}
                    className="shrink-0 rounded p-0.5 text-text-tertiary transition-colors hover:text-destructive focus-visible:text-destructive focus-visible:outline-none"
                  >
                    <Trash className="size-3.5" aria-hidden="true" />
                  </button>
                )}
              </DropdownMenuItem>
            ))}
            {boards.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem data-testid="home-layout-new" onSelect={onCreateBoard}>
              <Plus className="size-4 shrink-0" aria-hidden="true" />
              {t('home.board.newName')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {showAddWidget && (
          <DropdownMenu open={galleryOpen} onOpenChange={onGalleryOpenChange}>
            <DropdownMenuTrigger
              data-testid="add-widget-trigger"
              aria-label={t('home.addWidget')}
              title={t('home.addWidget')}
              className="flex size-7.5 items-center justify-center rounded-full border border-border bg-card text-text-secondary transition-[background-color,transform] duration-100 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)] motion-safe:active:scale-[0.96]"
            >
              <Plus className="size-4" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent data-testid="widget-gallery" align="end" className="w-56">
              <WidgetGallery onAdd={onAddWidget} />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  )
}
