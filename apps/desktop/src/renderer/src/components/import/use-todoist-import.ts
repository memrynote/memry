import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type {
  TodoistImportSummary,
  TodoistPreviewResponse
} from '@memry/contracts/todoist-import-api'

type PreviewState = Extract<TodoistPreviewResponse, { canceled: false }>

/** Drives the Todoist import flow: pick files → preview → confirm. */
export function useTodoistImport() {
  const { t } = useT('settings')
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [summary, setSummary] = useState<TodoistImportSummary | null>(null)

  const chooseFiles = useCallback(async () => {
    setSummary(null)
    setIsPreviewing(true)
    try {
      const res = await window.api.todoistImport.preview()
      if (!res.canceled) setPreview(res)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('import.todoist.error'))
    } finally {
      setIsPreviewing(false)
    }
  }, [t])

  const cancel = useCallback(() => setPreview(null), [])

  const confirmImport = useCallback(async () => {
    if (!preview) return
    setIsImporting(true)
    try {
      const result = await window.api.todoistImport.run({ filePaths: preview.filePaths })
      setSummary(result)
      setPreview(null)
      const projects = result.files.filter((f) => f.projectId).length
      const tasks = result.files.reduce((n, f) => n + f.stats.tasks, 0)
      toast.success(t('import.todoist.success', { projects, tasks }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('import.todoist.error'))
    } finally {
      setIsImporting(false)
    }
  }, [preview, t])

  return { preview, isPreviewing, isImporting, summary, chooseFiles, confirmImport, cancel }
}
