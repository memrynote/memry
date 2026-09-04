import { useCallback, useId, useRef } from 'react'
import { LayoutGroup, motion, useReducedMotion } from 'motion/react'
import { useT } from '@memry/i18n/renderer'
import { MoreHorizontal, PanelRight } from '@/lib/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { ProjectTabKey } from './use-project-hub'
import { PROJECT_RAIL_VISIBLE, PROJECT_TAB_KEYS } from './project-view-state'

interface ProjectTabBarProps {
  active: ProjectTabKey
  onChange: (tab: ProjectTabKey) => void
  counts: { tasks: number; notes: number; files: number; events: number }
  railOpen: boolean
  onToggleRail: () => void
  onEdit: () => void
  onArchive: () => void
  /**
   * False for the inbox, which the data layer refuses to archive. Offering the
   * action and then throwing `Cannot archive the inbox project` is an error
   * standing in for an affordance that should never have been live.
   */
  canArchive: boolean
}

export const ProjectTabBar = ({
  active,
  onChange,
  counts,
  railOpen,
  onToggleRail,
  onEdit,
  onArchive,
  canArchive
}: ProjectTabBarProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const listRef = useRef<HTMLDivElement>(null)
  const prefersReducedMotion = useReducedMotion()
  const layoutGroupId = useId()

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
    <div className="flex items-center gap-1 px-4 py-1.5">
      <LayoutGroup id={layoutGroupId}>
        <div
          ref={listRef}
          role="tablist"
          aria-label={t('projectHub.tabs.label')}
          onKeyDown={handleKeyDown}
          className="flex h-7 min-w-0 shrink-0 items-center gap-0.5 text-[12px] leading-4"
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
                  'relative flex h-6 items-center gap-1.25 rounded-[5px] px-2.5 transition-colors duration-150',
                  'focus-visible:outline-none active:scale-[0.97]',
                  !isActive && 'hover:bg-surface-active/50'
                )}
              >
                {isActive && (
                  <motion.span
                    layoutId="project-tab-pill"
                    aria-hidden="true"
                    transition={
                      prefersReducedMotion
                        ? { duration: 0 }
                        : { type: 'spring', bounce: 0, duration: 0.35 }
                    }
                    className="absolute inset-0 rounded-[5px] bg-surface-active"
                  />
                )}
                <span
                  className={cn(
                    'relative z-10 text-[12px] leading-3.75',
                    isActive ? 'font-medium text-text-primary' : 'text-text-tertiary'
                  )}
                >
                  {t(`projectHub.tabs.${key}`)}
                </span>
                {count != null ? (
                  <span className="relative z-10 text-[11px] leading-3.5 tabular-nums text-text-secondary">
                    {count}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </LayoutGroup>

      <div className="ms-auto flex shrink-0 items-center gap-1">
        {PROJECT_RAIL_VISIBLE ? (
          <button
            type="button"
            onClick={onToggleRail}
            aria-pressed={railOpen}
            aria-label={t('projectHub.header.toggleRail')}
            className={cn(
              'rounded-sm p-1.5 transition-colors hover:bg-surface-active',
              railOpen ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            <PanelRight className="size-4" aria-hidden="true" />
          </button>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('projectHub.header.menu')}
              className="rounded-sm p-1.5 text-muted-foreground transition-colors hover:bg-surface-active hover:text-foreground"
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>
              {t('projectHub.header.editProject')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canArchive} onSelect={onArchive}>
              {t('projectHub.header.archiveProject')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
