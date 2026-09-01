import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { X } from '@/lib/icons'
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

function ProjectChipLabel({ project }: { project: ProjectRef }): React.JSX.Element {
  return (
    <>
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: project.color }}
        aria-hidden="true"
      />
      <span className="max-w-32 truncate">{project.name}</span>
    </>
  )
}

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
 * Small pill row showing the projects an item belongs to, via `project_links`,
 * with a remove control per chip.
 *
 * The remove control is not optional. This row is the only place a binary
 * file's project membership is ever shown — a file has no frontmatter, so it
 * has no `project` property row to edit the way a markdown note does — and
 * three separate surfaces can add one (sidebar drag, the file page's "Add to
 * project", the project hub's paperclip import). Without it the membership is
 * a one-way door out of which the only exits are deleting the project or the
 * file.
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

  // The main side answers a failed unlink with an error envelope rather than a
  // rejection, so the envelope has to be checked before the reload; and the
  // reload runs either way so the row shows what the DB actually holds.
  const handleRemove = async (projectId: string): Promise<void> => {
    try {
      const result = await tasksService.unlinkProjectItem({ projectId, itemType, itemId })
      if (!result.success) throw new Error(result.error)
    } catch (error) {
      log.error('Failed to remove item from project', extractErrorMessage(error))
      toast.error(extractErrorMessage(error, t('itemProjects.removeFailed')))
    }
    await load()
  }

  if (!isLoading && projects.length === 0) return null

  const visible = maxVisible === undefined ? projects : projects.slice(0, maxVisible)
  const hiddenCount = projects.length - visible.length

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {visible.map((project) => (
        <span
          key={project.id}
          className="inline-flex items-center rounded-full border border-border bg-muted/40 text-xs"
        >
          {/* The name is a control only where it leads somewhere. The file page
              mounts this row without `onProjectClick`, and a second tab stop
              that does nothing beside the real remove control is worse than
              plain text. */}
          {onProjectClick ? (
            <button
              type="button"
              aria-label={t('itemProjects.openProject', { name: project.name })}
              onClick={() => onProjectClick(project.id)}
              className="inline-flex items-center gap-1.5 rounded-full ps-2 pe-1 py-0.5 transition-colors hover:bg-muted/70"
            >
              <ProjectChipLabel project={project} />
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 ps-2 pe-1 py-0.5">
              <ProjectChipLabel project={project} />
            </span>
          )}
          <button
            type="button"
            aria-label={t('itemProjects.removeFromProject', { name: project.name })}
            onClick={() => void handleRemove(project.id)}
            className="rounded-full ps-0.5 pe-1.5 py-0.5 text-muted-foreground transition-colors hover:text-destructive"
          >
            <X className="size-3" />
          </button>
        </span>
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
