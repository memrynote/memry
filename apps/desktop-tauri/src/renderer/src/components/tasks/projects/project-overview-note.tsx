import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { FileText, Loader2, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { ContentArea } from '@/components/note'
import { EditorErrorBoundary } from '@/components/note/editor-error-boundary'
import { tasksService } from '@/services/tasks-service'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { useT } from '@memry/i18n/renderer'
import { useIsNoteLocked } from '@/lib/vault-locks-store'
import { LockedNoteNotice } from '@/components/note/locked-note-notice'
import { VersionHistory } from '@/components/note/version-history'
import { useNoteBody } from '@/pages/note/use-note-body'

const log = createLogger('ProjectOverview')

interface ProjectOverviewNoteProps {
  projectId: string
  /**
   * `undefined` = not yet resolved (parent is still loading the project),
   * `null` = resolved, no home note set, `string` = the home note id.
   * Distinguishing loading from "no home note" avoids a create-affordance flash.
   */
  homeNoteId: string | null | undefined
  onHomeNoteChange: (noteId: string | null) => void
  className?: string
}

/**
 * Project Home overview — renders the project's home note (a pointer via
 * `projects.home_note_id`, NOT a project link) inline using the shared
 * `ContentArea` editor. Offers create / clear; "pick an existing note" is
 * deferred (see commit message) since no reusable note picker exists yet.
 */
export const ProjectOverviewNote = ({
  projectId,
  homeNoteId,
  onHomeNoteChange,
  className
}: ProjectOverviewNoteProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const [isCreating, setIsCreating] = useState(false)

  const [versionsOpen, setVersionsOpen] = useState(false)
  // Saves the editor's text and hands it outside edits, as the note's own page does (#4088).
  const body = useNoteBody(homeNoteId ?? undefined, {
    surface: 'project-overview',
    showVersionHistory: () => setVersionsOpen(true)
  })
  const { note, isLoading, error: loadError } = body.query
  const isLocked = useIsNoteLocked(homeNoteId, note?.path ?? null)

  const handleCreate = useCallback(async (): Promise<void> => {
    setIsCreating(true)
    try {
      const result = await notesService.create({
        title: t('projectHome.overview.defaultTitle')
      })
      if (!result.success || !result.note) {
        log.error('Failed to create overview note', result.error ?? 'no note returned')
        trackRendererError(
          'project_overview_note_create',
          new Error(result.error ?? 'no note returned')
        )
        toast.error(t('projectHome.overview.createError'))
        return
      }
      const setResult = await tasksService.setProjectHomeNote({
        projectId,
        noteId: result.note.id
      })
      if (!setResult.success) {
        log.error('Failed to set overview note', setResult.error ?? 'unknown')
        trackRendererError('project_overview_note_create', new Error(setResult.error ?? 'unknown'))
        toast.error(t('projectHome.overview.createError'))
        return
      }
      onHomeNoteChange(result.note.id)
    } catch (error) {
      trackRendererError('project_overview_note_create', error)
      toast.error(extractErrorMessage(error, t('projectHome.overview.createError')))
    } finally {
      setIsCreating(false)
    }
  }, [projectId, onHomeNoteChange, t])

  const handleClear = useCallback(async (): Promise<void> => {
    try {
      const result = await tasksService.setProjectHomeNote({ projectId, noteId: null })
      if (!result.success) {
        log.error('Failed to clear overview note', result.error ?? 'unknown')
        trackRendererError('project_overview_note_clear', new Error(result.error ?? 'unknown'))
        toast.error(t('projectHome.overview.clearError'))
        return
      }
      onHomeNoteChange(null)
    } catch (error) {
      trackRendererError('project_overview_note_clear', error)
      toast.error(extractErrorMessage(error, t('projectHome.overview.clearError')))
    }
  }, [projectId, onHomeNoteChange, t])

  if (homeNoteId === undefined) {
    return (
      <section className={cn('px-4 py-3', className)}>
        <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        </div>
      </section>
    )
  }

  if (!homeNoteId) {
    return (
      <section className={cn('px-4 py-3', className)}>
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={isCreating}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border p-4',
            'text-sm text-muted-foreground transition-colors hover:bg-surface-active disabled:opacity-60'
          )}
        >
          {isCreating ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <FileText className="size-4" aria-hidden="true" />
          )}
          {t('projectHome.overview.create')}
        </button>
      </section>
    )
  }

  return (
    <section className={cn('px-4 py-3', className)}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('projectHome.overview.sectionTitle')}
        </h3>
        <button
          type="button"
          onClick={() => void handleClear()}
          className="flex items-center gap-1 rounded-sm p-1 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <X className="size-3.5" aria-hidden="true" />
          {t('projectHome.overview.clear')}
        </button>
      </div>

      <div data-testid="overview-editor" className="rounded-lg border border-border bg-surface p-3">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          </div>
        ) : loadError ? (
          <p className="py-8 text-center text-sm text-destructive">
            {t('projectHome.overview.loadError')}
          </p>
        ) : (
          <EditorErrorBoundary noteId={homeNoteId}>
            {isLocked && <LockedNoteNotice className="mb-2" />}
            <ContentArea
              key={homeNoteId}
              noteId={homeNoteId}
              editable={!isLocked}
              initialContent={body.content}
              contentType="markdown"
              externalContentRevision={body.revision}
              placeholder={t('projectHome.overview.placeholder')}
              onMarkdownChange={body.onMarkdownChange}
            />
          </EditorErrorBoundary>
        )}
      </div>
      {note && (
        <VersionHistory
          open={versionsOpen}
          onOpenChange={setVersionsOpen}
          noteId={note.id}
          noteTitle={note.title}
          onRestore={body.cancelScheduledSave}
        />
      )}
    </section>
  )
}

export default ProjectOverviewNote
