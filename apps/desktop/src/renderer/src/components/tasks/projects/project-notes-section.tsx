import { useCallback, useEffect, useState } from 'react'
import { FileText, Loader2, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { tasksService } from '@/services/tasks-service'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('ProjectNotes')

interface LinkedNote {
  itemId: string
  title: string
}

interface ProjectNotesSectionProps {
  projectId: string
  onNoteClick?: (noteId: string) => void
  className?: string
}

/**
 * Project Home "Notes" section — lists the notes linked to a project
 * (via `project_links`) and lets the user unlink one.
 */
export const ProjectNotesSection = ({
  projectId,
  onNoteClick,
  className
}: ProjectNotesSectionProps): React.JSX.Element | null => {
  const { t } = useT('tasks')
  const [notes, setNotes] = useState<LinkedNote[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const loadNotes = useCallback(async (): Promise<void> => {
    setIsLoading(true)
    try {
      const links = await tasksService.listProjectLinks(projectId)
      const noteLinks = links.filter((link) => link.itemType === 'note')
      const resolved = await Promise.all(
        noteLinks.map(async (link) => {
          const note = await notesService.get(link.itemId)
          // Skip orphan links whose note no longer exists rather than rendering a
          // card titled with the raw note id (belt-and-suspenders for main-process cleanup).
          return note ? { itemId: link.itemId, title: note.title } : null
        })
      )
      setNotes(resolved.filter((note): note is LinkedNote => note !== null))
    } catch (error) {
      log.error(
        'Failed to load project notes',
        extractErrorMessage(error, t('projectNotes.loadError'))
      )
    } finally {
      setIsLoading(false)
    }
  }, [projectId, t])

  useEffect(() => {
    void loadNotes()
  }, [loadNotes])

  const handleRemove = useCallback(
    async (itemId: string): Promise<void> => {
      try {
        await tasksService.unlinkProjectItem({ projectId, itemType: 'note', itemId })
        setNotes((prev) => prev.filter((note) => note.itemId !== itemId))
      } catch (error) {
        log.error(
          'Failed to remove note from project',
          extractErrorMessage(error, t('projectNotes.removeError'))
        )
      }
    },
    [projectId, t]
  )

  if (!isLoading && notes.length === 0) return null

  return (
    <section className={cn('px-4 py-3 border-t border-border', className)}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('projectNotes.title')}
      </h3>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t('projectNotes.loading')}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {notes.map((note) => (
            <div
              key={note.itemId}
              className="group relative flex items-center gap-2 rounded-md border border-border p-2 hover:bg-surface-hover"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-start"
                onClick={() => onNoteClick?.(note.itemId)}
              >
                <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate text-sm">{note.title}</span>
              </button>
              <button
                type="button"
                aria-label={t('projectNotes.removeFromProject')}
                onClick={() => void handleRemove(note.itemId)}
                className="shrink-0 rounded-sm p-1 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

export default ProjectNotesSection
