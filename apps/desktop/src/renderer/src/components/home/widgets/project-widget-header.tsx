import { useCallback, useRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useTasksContext } from '@/contexts/tasks'
import { ProjectIcon } from '@/components/tasks/project-icon'
import { FolderKanban } from '@/lib/icons/icon-map'
import { cn } from '@/lib/utils'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'
import type { ProjectTabKey } from '@/pages/project/use-project-hub'
import { PROJECT_TAB_KEYS } from '@/pages/project/project-view-state'
import { readProjectId } from './project-widget-config'

/**
 * The widget header's name, in place of the static "Project" label. Three project
 * widgets side by side are only distinguishable by this, which is why the frame
 * grew a `Title` slot rather than the widget printing its name in the body.
 */
export function ProjectWidgetTitle({ config }: WidgetComponentProps): React.JSX.Element {
  const { t } = useT('common')
  const { projects } = useTasksContext()
  const projectId = readProjectId(config)
  const project = projects.find((candidate) => candidate.id === projectId) ?? null

  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex size-4 shrink-0 items-center justify-center">
        <ProjectIcon
          icon={project?.icon}
          color={project?.color}
          className="size-4"
          fallback={
            <FolderKanban className="size-4 text-[var(--text-tertiary)]" aria-hidden="true" />
          }
        />
      </span>
      <span className="truncate text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--text-tertiary)]">
        {project?.name ?? t('home.widget.project')}
      </span>
    </span>
  )
}

interface ProjectWidgetTabsProps {
  active: ProjectTabKey
  onChange: (tab: ProjectTabKey) => void
  counts: { tasks: number; notes: number; files: number; events: number }
}

/**
 * The widget's own tab strip.
 *
 * A trimmed copy of `ProjectTabBar` rather than a shared component: the page's
 * bar also owns the rail toggle, the project overflow menu and a `LayoutGroup`
 * pill animation. Reusing it would mean making every one of those optional and
 * threading widget-only props through the page — for a row of five buttons.
 *
 * It lives in the widget BODY, not the frame's header slot: the active tab is
 * local React state (switching tabs is navigation, not a stored preference), and
 * the header slots only receive `config`, which is persisted and synced.
 */
export function ProjectWidgetTabs({
  active,
  onChange,
  counts
}: ProjectWidgetTabsProps): React.JSX.Element {
  const { t } = useT('tasks')
  const listRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      if (delta === 0) return
      event.preventDefault()
      const index = PROJECT_TAB_KEYS.indexOf(active)
      const next =
        PROJECT_TAB_KEYS[(index + delta + PROJECT_TAB_KEYS.length) % PROJECT_TAB_KEYS.length]
      onChange(next)
      listRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()
    },
    [active, onChange]
  )

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={t('projectHub.tabs.label')}
      onKeyDown={handleKeyDown}
      data-testid="project-widget-tabs"
      className="widget-no-drag mb-1.5 flex items-center gap-0.5 text-[12px] leading-4"
    >
      {PROJECT_TAB_KEYS.map((key) => {
        const isActive = key === active
        const count = key === 'overview' ? null : counts[key]
        return (
          <button
            key={key}
            type="button"
            role="tab"
            data-tab={key}
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(key)}
            className={cn(
              'flex h-6 items-center gap-1 rounded-[5px] px-2 transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]',
              isActive ? 'bg-surface-active' : 'hover:bg-surface-active/50'
            )}
          >
            <span
              className={cn(
                'text-[12px] leading-3.75',
                isActive ? 'font-medium text-text-primary' : 'text-text-tertiary'
              )}
            >
              {t(`projectHub.tabs.${key}`)}
            </span>
            {count != null ? (
              <span className="text-[11px] leading-3.5 tabular-nums text-text-secondary">
                {count}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
