import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImportProgressEvent, ImportSummaryResult } from '@memry/contracts/import-channels'

export interface UseImportRun {
  importId: string | null
  progress: ImportProgressEvent | null
  summary: ImportSummaryResult | null
  isRunning: boolean
  error: string | null
  start: (importerId: string, sourcePaths: string[]) => Promise<void>
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
    setError(null)
    setImportId(null)
    activeIdRef.current = null
  }, [])

  const start = useCallback(async (importerId: string, sourcePaths: string[]): Promise<void> => {
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
      const result = await window.api.import.start({ importId: id, importerId, sourcePaths })
      if (result.success) setSummary(result.summary)
      else setError(result.error ?? 'Import failed')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setIsRunning(false)
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
    }
  }, [])

  const cancel = useCallback(() => {
    const id = activeIdRef.current
    if (!id) return
    void window.api.import.cancel({ importId: id })
  }, [])

  return { importId, progress, summary, isRunning, error, start, cancel, reset }
}
