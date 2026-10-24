import { useCallback, useEffect, useRef, useState } from 'react'
import { getI18n } from 'react-i18next'
import type {
  ImportPreview,
  ImportProgressEvent,
  ImportSummaryResult
} from '@memry/contracts/import-channels'

const previewFailed = (): string =>
  getI18n().getFixedT(null, 'settings')('import.dialog.previewError')
const importFailed = (): string => getI18n().getFixedT(null, 'settings')('import.dialog.error')

export interface UseImportRun {
  importId: string | null
  progress: ImportProgressEvent | null
  summary: ImportSummaryResult | null
  preview: ImportPreview | null
  isPreviewing: boolean
  isRunning: boolean
  error: string | null
  runPreview: (importerId: string, sourcePaths: string[]) => Promise<void>
  start: (
    importerId: string,
    sourcePaths: string[],
    options?: Record<string, unknown>
  ) => Promise<void>
  cancel: () => void
  reset: () => void
}

/**
 * Drives a single import run: mints an id, subscribes to streaming progress
 * filtered by that id, starts the run, and exposes the final summary. Cancels
 * the active run on request and tears down the subscription on unmount.
 */
export function useImportRun(): UseImportRun {
  const [importId, setImportId] = useState<string | null>(null)
  const [progress, setProgress] = useState<ImportProgressEvent | null>(null)
  const [summary, setSummary] = useState<ImportSummaryResult | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeIdRef = useRef<string | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => {
      unsubscribeRef.current?.()
    }
  }, [])

  const reset = useCallback(() => {
    setProgress(null)
    setSummary(null)
    setPreview(null)
    setError(null)
    setImportId(null)
    activeIdRef.current = null
  }, [])

  const runPreview = useCallback(
    async (importerId: string, sourcePaths: string[]): Promise<void> => {
      const id = crypto.randomUUID()
      activeIdRef.current = id
      setImportId(id)
      setPreview(null)
      setSummary(null)
      setError(null)
      setIsPreviewing(true)
      try {
        const res = await window.api.import.preview({ importId: id, importerId, sourcePaths })
        if (res.success) setPreview(res.preview)
        else setError(res.error ?? previewFailed())
      } catch (err) {
        setError(err instanceof Error ? err.message : previewFailed())
      } finally {
        setIsPreviewing(false)
      }
    },
    []
  )

  const start = useCallback(
    async (
      importerId: string,
      sourcePaths: string[],
      options?: Record<string, unknown>
    ): Promise<void> => {
      const id = crypto.randomUUID()
      activeIdRef.current = id
      setImportId(id)
      setProgress(null)
      setSummary(null)
      setError(null)
      setIsRunning(true)

      unsubscribeRef.current?.()
      unsubscribeRef.current = window.api.onImportProgress((event) => {
        if (event.importId !== activeIdRef.current) return
        setProgress(event)
      })

      try {
        // The IPC layer resolves errors as a { success: false, error } envelope
        // (it does not reject), so a thrown importer surfaces here, not in catch.
        const result = await window.api.import.start({
          importId: id,
          importerId,
          sourcePaths,
          options
        })
        if (result.success) setSummary(result.summary)
        else setError(result.error ?? importFailed())
      } catch (err) {
        setError(err instanceof Error ? err.message : importFailed())
      } finally {
        setIsRunning(false)
        unsubscribeRef.current?.()
        unsubscribeRef.current = null
      }
    },
    []
  )

  const cancel = useCallback(() => {
    const id = activeIdRef.current
    if (!id) return
    void window.api.import.cancel({ importId: id })
  }, [])

  return {
    importId,
    progress,
    summary,
    preview,
    isPreviewing,
    isRunning,
    error,
    runPreview,
    start,
    cancel,
    reset
  }
}
