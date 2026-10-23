import { useCallback, useRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import type { WidgetTabKey } from '@/pages/project/use-project-hub'
import { PROJECT_TAB_KEYS } from '@/pages/project/project-view-state'

const WIDGET_TAB_KEYS = PROJECT_TAB_KEYS.filter((key): key is WidgetTabKey => key !== 'all')

interface ProjectWidgetTabsProps {
  active: WidgetTabKey
  onChange: (tab: WidgetTabKey) => void
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
      const index = WIDGET_TAB_KEYS.indexOf(active)
      const next =
        WIDGET_TAB_KEYS[(index + delta + WIDGET_TAB_KEYS.length) % WIDGET_TAB_KEYS.length]
      onChange(next)
      listRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()
    },
    [active, onChange]
  )

  return (
    // oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- tablist container is not focusable by design; roving tabindex lives on the tabs
    <div
      ref={listRef}
      role="tablist"
      aria-label={t('projectHub.tabs.label')}
      onKeyDown={handleKeyDown}
      data-testid="project-widget-tabs"
      className="widget-no-drag mb-1.5 flex items-center gap-0.5 text-[12px] leading-4"
    >
      {WIDGET_TAB_KEYS.map((key) => {
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
