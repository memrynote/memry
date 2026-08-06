import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { CaptureBar, type CaptureBarParsed } from '@/components/capture-bar'
import { PageToolbar } from '@/components/ui/page-toolbar'
import { classifyCapture, normalizeUrl } from '@/lib/capture-intent'
import { tasksService } from '@/services/tasks-service'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
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
 * The hub's one capture affordance — the shared CaptureBar wired to the project.
 * Plain text becomes a task in this project (quick-add syntax still works, so
 * `!friday !!high` parses); a bare URL becomes a linked note; the paperclip
 * imports files and links them.
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
        trackRendererError('project_capture_url', error)
        toast.error(extractErrorMessage(error, t('projectHub.capture.linkError')))
      } finally {
        setIsBusy(false)
      }
    },
    [project.id, onChanged, t]
  )

  const handleSubmit = useCallback(
    (title: string, parsed?: CaptureBarParsed): void => {
      if (classifyCapture(title) === 'url') {
        void captureUrl(title)
        return
      }
      onAddTask(title, parsed)
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
        // Importer-level failures carry no path (the copy never produced one),
        // so naming a file would be a lie — show what actually went wrong.
        toast.error(
          failure.path
            ? t('projectHub.capture.fileError', { name: failure.path })
            : failure.error || t('projectHub.capture.fileErrorGeneric')
        )
        log.error('Failed to link imported file', failure.path, failure.error)
        trackRendererError('project_import_files', new Error(failure.error || 'link failed'))
      }
    } catch (error) {
      log.error('Failed to import files', extractErrorMessage(error))
      trackRendererError('project_import_files', error)
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
    // The real toolbar, not just its padding: PageToolbar also sets the
    // `text-[12px] leading-4` context the CaptureBar's unfocused shortcut badge
    // inherits. Without it the badge falls back to the page's 14px/1.5 strut,
    // grows past the action buttons, and the box visibly shrinks the moment
    // focus unmounts it. `min-h-[38px]` pins the row the same way as Inbox/Tasks.
    <PageToolbar className="px-2 py-1 min-h-[38px] border-b-0">
      <CaptureBar
        className="grow shrink basis-0 min-w-0"
        ariaLabel={t('projectHub.capture.label', { name: project.name })}
        placeholder={t('projectHub.capture.placeholder', { name: project.name })}
        accentColor={project.color}
        quickAdd={{ projects }}
        onSubmit={handleSubmit}
        focusSignal={focusSignal}
        attachment={{
          onAttach: handleAttach,
          label: t('projectHub.capture.attach'),
          busy: isBusy
        }}
      />
    </PageToolbar>
  )
}
