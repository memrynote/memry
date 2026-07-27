import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { Loader2, Paperclip } from '@/lib/icons'
import { QuickAddInput } from '@/components/tasks/quick-add-input'
import { classifyCapture, normalizeUrl } from '@/lib/capture-intent'
import { tasksService } from '@/services/tasks-service'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import type { Priority } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'

const log = createLogger('ProjectHubCapture')

interface ProjectCaptureInputProps {
  project: Project
  projects: Project[]
  /** Create a task in this project from parsed quick-add input. */
  onAddTask: (
    title: string,
    parsedData?: { dueDate: Date | null; priority: Priority; projectId: string | null }
  ) => void
  onChanged: () => void
  /** Bump to focus the text field. */
  focusSignal?: number
  /** Bump to open the file picker (the Files section's "+"). */
  importSignal?: number
}

/**
 * The hub's one capture affordance. Plain text becomes a task in this project
 * (through the existing quick-add parser, so `friday p1` still works); a bare
 * URL becomes a linked note; the paperclip imports files and links them.
 */
export const ProjectCaptureInput = ({
  project,
  projects,
  onAddTask,
  onChanged,
  focusSignal,
  importSignal
}: ProjectCaptureInputProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const [isBusy, setIsBusy] = useState(false)

  const captureUrl = useCallback(
    async (raw: string): Promise<void> => {
      setIsBusy(true)
      try {
        const result = await tasksService.captureUrlToProject({
          projectId: project.id,
          url: normalizeUrl(raw)
        })
        if (!result.success) throw new Error(result.error)
        toast.success(t('projectHub.capture.linkAdded'))
        onChanged()
      } catch (error) {
        log.error('Failed to capture url', extractErrorMessage(error))
        toast.error(extractErrorMessage(error, t('projectHub.capture.linkError')))
      } finally {
        setIsBusy(false)
      }
    },
    [project.id, onChanged, t]
  )

  const handleAdd = useCallback(
    (
      title: string,
      parsedData?: { dueDate: Date | null; priority: Priority; projectId: string | null }
    ): void => {
      if (classifyCapture(title) === 'url') {
        void captureUrl(title)
        return
      }
      onAddTask(title, parsedData)
    },
    [captureUrl, onAddTask]
  )

  const handleAttach = useCallback(async (): Promise<void> => {
    const picked = await notesService.showImportDialog()
    if (picked.canceled || picked.filePaths.length === 0) return

    setIsBusy(true)
    try {
      const result = await tasksService.importFilesToProject({
        projectId: project.id,
        sourcePaths: picked.filePaths
      })

      if (result.linked.length > 0) {
        toast.success(t('projectHub.capture.filesAdded', { count: result.linked.length }))
        onChanged()
      }
      for (const failure of result.failed) {
        toast.error(t('projectHub.capture.fileError', { name: failure.path }))
        log.error('Failed to link imported file', failure.path, failure.error)
      }
    } catch (error) {
      log.error('Failed to import files', extractErrorMessage(error))
      toast.error(extractErrorMessage(error, t('projectHub.capture.fileErrorGeneric')))
    } finally {
      setIsBusy(false)
    }
  }, [project.id, onChanged, t])

  // Skip the initial render so the picker only opens on a real "+" press.
  const lastImportSignal = useRef(importSignal)
  useEffect(() => {
    if (importSignal === undefined || importSignal === lastImportSignal.current) return
    lastImportSignal.current = importSignal
    void handleAttach()
  }, [importSignal, handleAttach])

  return (
    <div className="flex items-center gap-2 px-4 pb-2">
      <QuickAddInput
        onAdd={handleAdd}
        projects={projects}
        projectColor={project.color}
        placeholder={t('projectHub.capture.placeholder', { name: project.name })}
        className="flex-1"
        focusSignal={focusSignal}
      />
      <button
        type="button"
        // The button disables itself while importing; firing on pointerdown keeps
        // the activation from being swallowed by the re-render that adds `disabled`.
        onPointerDown={() => void handleAttach()}
        disabled={isBusy}
        aria-label={t('projectHub.capture.attach')}
        className="shrink-0 rounded-md p-2 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-60"
      >
        {isBusy ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <Paperclip className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  )
}
