import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  tasksService,
  onProjectUpdated,
  type ProjectItemType,
  type ProjectRef
} from '@/services/tasks-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('ItemProjectChips')

interface ItemProjectChipsProps {
  itemType: ProjectItemType
  itemId: string
  onProjectClick?: (projectId: string) => void
  className?: string
  /**
   * Cap on the chips rendered, with the rest counted in a trailing `+N`. For
   * rows that share a line with other controls — the PDF toolbar — where an
   * unbounded chip list would push them off the end.
   */
  maxVisible?: number
}

/**
 * Small pill row showing the projects an item (note/calendar event) belongs
 * to, via `project_links`. Shared between the note view and the calendar
 * event popover.
 */
export const ItemProjectChips = ({
  itemType,
  itemId,
  onProjectClick,
  className,
  maxVisible
}: ItemProjectChipsProps): React.JSX.Element | null => {
  const { t } = useT('tasks')
  const [projects, setProjects] = useState<ProjectRef[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const load = useCallback(async (): Promise<void> => {
    setIsLoading(true)
    try {
      const result = await tasksService.listForItem(itemType, itemId)
      // `listForItem` runs through the main-side `withDb` wrapper: on a DB
      // error it resolves an error envelope `{ success: false, error }`
      // instead of rejecting, so a raw array is not guaranteed.
      setProjects(Array.isArray(result) ? result : [])
    } catch (error) {
      log.error('Failed to load item projects', extractErrorMessage(error))
      setProjects([])
    } finally {
      setIsLoading(false)
    }
  }, [itemType, itemId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => onProjectUpdated(() => void load()), [load])

  if (!isLoading && projects.length === 0) return null

  const visible = maxVisible === undefined ? projects : projects.slice(0, maxVisible)
  const hiddenCount = projects.length - visible.length

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {visible.map((project) => (
        <button
          key={project.id}
          type="button"
          aria-label={t('itemProjects.openProject', { name: project.name })}
          onClick={() => onProjectClick?.(project.id)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs',
            'transition-colors hover:bg-muted/70'
          )}
        >
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: project.color }}
            aria-hidden="true"
          />
          <span className="max-w-32 truncate">{project.name}</span>
        </button>
      ))}
      {hiddenCount > 0 && (
        <span
          className="shrink-0 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground"
          title={projects
            .slice(visible.length)
            .map((project) => project.name)
            .join(', ')}
        >
          +{hiddenCount}
        </span>
      )}
    </div>
  )
}

export default ItemProjectChips
