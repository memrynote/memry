import type React from 'react'
import { useTaskWorkspaceData } from '@/features/tasks/use-task-queries'
import { useSavedFilters } from '@/hooks/use-task-filters'
import {
  resolveTasksFilter,
  selectTasksForWidget,
  TASK_WIDGET_DATE_VIEWS,
  TASK_WIDGET_NO_DUE_VIEW,
  type TaskWidgetView
} from '@/lib/home/tasks-widget-filter'
import type { WidgetComponentProps, WidgetConfigEditorProps } from '@/lib/home/widget-registry'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { ChevronDown, Filter } from '@/lib/icons/icon-map'
import { useT } from '@memry/i18n/renderer'

const VIEW_LABEL_KEYS: Record<TaskWidgetView, string> = {
  all: 'home.widget.filter.all',
  today: 'home.widget.filter.today',
  tomorrow: 'home.widget.filter.tomorrow',
  next7: 'home.widget.filter.next7',
  nodue: 'home.widget.filter.noDueDate'
}

export function TasksHeaderFilter({
  config,
  onChange
}: WidgetConfigEditorProps): React.JSX.Element {
  const { t } = useT('common')
  const { savedFilters } = useSavedFilters()
  const resolved = resolveTasksFilter(config)

  const label =
    resolved.kind === 'saved'
      ? (savedFilters.find((f) => f.id === resolved.savedFilterId)?.name ??
        t(VIEW_LABEL_KEYS.today))
      : t(VIEW_LABEL_KEYS[resolved.viewId])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border border-[var(--tint-border)] bg-[var(--tint-light)] px-2 text-[11px] font-semibold text-[var(--tint)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]"
        >
          <Filter className="size-3" aria-hidden="true" />
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {TASK_WIDGET_DATE_VIEWS.map((view) => (
          <DropdownMenuItem
            key={view}
            onSelect={() => onChange({ ...config, dateRange: view, savedFilterId: undefined })}
          >
            {t(VIEW_LABEL_KEYS[view])}
          </DropdownMenuItem>
        ))}
        {savedFilters.length > 0 && <DropdownMenuSeparator />}
        {savedFilters.map((filter) => (
          <DropdownMenuItem
            key={filter.id}
            onSelect={() => onChange({ ...config, savedFilterId: filter.id })}
          >
            {filter.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() =>
            onChange({
              ...config,
              dateRange: TASK_WIDGET_NO_DUE_VIEW,
              savedFilterId: undefined
            })
          }
        >
          {t(VIEW_LABEL_KEYS[TASK_WIDGET_NO_DUE_VIEW])}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TasksHeaderCount({ config }: WidgetComponentProps): React.JSX.Element | null {
  const { tasks, projects, isLoading } = useTaskWorkspaceData({ enabled: true })
  const { savedFilters } = useSavedFilters()
  if (isLoading) return null

  const count = selectTasksForWidget(tasks, projects, savedFilters ?? [], config).length
  return (
    <span className="font-mono text-[11px] font-semibold text-[var(--text-tertiary)]">{count}</span>
  )
}
