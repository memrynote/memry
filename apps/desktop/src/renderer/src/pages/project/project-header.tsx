import { createElement } from 'react'
import { useT } from '@memry/i18n/renderer'
import { MoreHorizontal, PanelRight } from '@/lib/icons'
import { getIconByName } from '@/components/icon-picker'
import { IconPickerButton } from '@/components/icon-picker-button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { Project } from '@/data/tasks-data'

interface ProjectHeaderProps {
  project: Project
  done: number
  total: number
  overdue: number
  railOpen: boolean
  onToggleRail: () => void
  onIconChange: (icon: string | null) => void
  onEdit: () => void
  onArchive: () => void
}

export const ProjectHeader = ({
  project,
  done,
  total,
  overdue,
  railOpen,
  onToggleRail,
  onIconChange,
  onEdit,
  onArchive
}: ProjectHeaderProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const ProjectIcon = getIconByName(project.icon)

  return (
    <header className="flex items-center gap-2 px-4 py-3">
      <IconPickerButton
        hasIcon={!!project.icon}
        onIconChange={onIconChange}
        ariaLabel={t('projectHub.header.setIcon', { name: project.name })}
      >
        {ProjectIcon ? (
          createElement(ProjectIcon, {
            className: 'size-4 shrink-0',
            style: { color: project.color },
            'aria-hidden': 'true'
          })
        ) : (
          <span
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: project.color }}
            aria-hidden="true"
          />
        )}
      </IconPickerButton>

      <h1 className="truncate text-lg font-semibold text-foreground">{project.name}</h1>

      <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
        {t('projectHub.header.done', { done, total })}
      </span>

      {overdue > 0 ? (
        <span className="shrink-0 rounded-full border border-destructive/40 px-2 py-0.5 text-xs tabular-nums text-destructive">
          {t('projectHub.header.overdue', { count: overdue })}
        </span>
      ) : null}

      <div className="ms-auto flex shrink-0 items-center gap-1">
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
            <DropdownMenuItem onSelect={onArchive}>
              {t('projectHub.header.archiveProject')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
