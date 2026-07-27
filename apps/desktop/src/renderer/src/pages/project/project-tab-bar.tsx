import { useCallback, useRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import type { ProjectTabKey } from './use-project-hub'
import { PROJECT_TAB_KEYS } from './project-view-state'

interface ProjectTabBarProps {
  active: ProjectTabKey
  onChange: (tab: ProjectTabKey) => void
  counts: { tasks: number; notes: number; files: number; events: number }
}

export const ProjectTabBar = ({
  active,
  onChange,
  counts
}: ProjectTabBarProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const listRef = useRef<HTMLDivElement>(null)

  // Roving focus: arrow keys move between tabs, which is what `tablist` promises.
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
      className="flex items-center gap-1 border-b border-border px-4"
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
              'flex items-center gap-1.5 rounded-t-md px-3 py-2 text-sm transition-colors',
              isActive
                ? 'bg-surface font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {t(`projectHub.tabs.${key}`)}
            {count != null ? (
              <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
