import { useCallback, useId, useRef } from 'react'
import { LayoutGroup, motion, useReducedMotion } from 'motion/react'
import { useT } from '@memry/i18n/renderer'
import { MoreHorizontal, PanelRight } from '@/lib/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { ProjectTabKey } from './use-project-hub'
import { PROJECT_RAIL_VISIBLE, PROJECT_TAB_KEYS } from './project-view-state'

interface ProjectTabBarProps {
  active: ProjectTabKey
  onChange: (tab: ProjectTabKey) => void
  counts: { all: number; tasks: number; notes: number; files: number; events: number }
  /** The All tab lists finished items too. The toggle sits in the "..." menu. */
  showDone: boolean
  onShowDoneChange: (showDone: boolean) => void
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
  showDone,
  onShowDoneChange,
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

  // An empty category has nothing to show, so its tab stays out of the way until
  // something lands in it. The active tab never hides under the user's cursor.
  const visibleKeys = PROJECT_TAB_KEYS.filter(
    (key) => key === 'overview' || key === 'all' || key === active || counts[key] > 0
  )

  // Roving focus: arrow keys move between tabs, which is what `tablist` promises.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      if (delta === 0) return
      event.preventDefault()
      const index = visibleKeys.indexOf(active)
      const next = visibleKeys[(index + delta + visibleKeys.length) % visibleKeys.length]
      onChange(next)
      listRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()
    },
    [active, onChange, visibleKeys]
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
          {visibleKeys.map((key) => {
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
                onClick={() => {
                  onChange(key)
                }}
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
            {active === 'all' ? (
              <>
                <DropdownMenuCheckboxItem checked={showDone} onCheckedChange={onShowDoneChange}>
                  {t('projectHub.all.showDone')}
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
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
