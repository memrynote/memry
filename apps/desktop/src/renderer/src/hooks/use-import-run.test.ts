import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type {
  ImportMessage,
  ImportPreview,
  ImportPreviewResponse,
  ImportProgressEvent,
  ImportStartResponse
} from '@memry/contracts/import-channels'
import { useImportRun } from './use-import-run'

type ProgressListener = (event: ImportProgressEvent) => void

interface RunInput {
  importId: string
  importerId: string
  sourcePaths: string[]
}

interface ApiOptions {
  start?: (input: RunInput) => Promise<unknown>
  preview?: (input: RunInput) => Promise<unknown>
}

const SUMMARY = { imported: 2, attachments: 1, skipped: 0, failed: [] }

/**
 * Installs a window.api double whose progress subscription is real: the
 * unsubscribe it hands back actually detaches the listener, so tests can prove
 * the hook stops listening (rather than merely calling a no-op).
 */
function installApi(options: ApiOptions = {}) {
  const listeners = new Set<ProgressListener>()
  const unsubscribes: ReturnType<typeof vi.fn>[] = []
  const startedIds: string[] = []
  const previewedIds: string[] = []
  const cancel = vi.fn()

  const onImportProgress = vi.fn((fn: ProgressListener) => {
    listeners.add(fn)
    const unsubscribe = vi.fn(() => {
      listeners.delete(fn)
    })
    unsubscribes.push(unsubscribe)
    return unsubscribe
  })

  const start = vi.fn(async (input: RunInput) => {
    startedIds.push(input.importId)
    if (options.start) return await options.start(input)
    return { success: true as const, summary: SUMMARY }
  })

  const preview = vi.fn(async (input: RunInput) => {
    previewedIds.push(input.importId)
    if (options.preview) return await options.preview(input)
    return { success: true as const, preview: { groups: [] } }
  })
  ;(window as unknown as { api: unknown }).api = {
    onImportProgress,
    import: {
      pickFiles: vi.fn(async () => ({ canceled: false, filePaths: ['a.zip'] })),
      start,
      preview,
      cancel
    }
  }

  return {
    emit: (event: ImportProgressEvent) => {
      for (const fn of [...listeners]) fn(event)
    },
    listenerCount: () => listeners.size,
    unsubscribes,
    onImportProgress,
    startedIds,
    previewedIds,
    start,
    preview,
    cancel
  }
}

function progressEvent(overrides: Partial<ImportProgressEvent> & { importId: string }) {
  return {
    phase: 'importing' as const,
    status: 'Importing…',
    imported: 0,
    attachments: 0,
    skipped: 0,
    failed: 0,
    completed: 0,
    total: 2,
    done: false,
    ...overrides
  } satisfies ImportProgressEvent
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useImportRun', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('tracks progress events and the final summary', async () => {
    const api = installApi()
    const { result } = renderHook(() => useImportRun())

    await act(async () => {
      const p = result.current.start('notion', ['a.zip'])
      api.emit({
        importId: api.startedIds[0],
        phase: 'importing',
        status: 'Importing…',
        imported: 1,
        attachments: 0,
        skipped: 0,
        failed: 0,
        completed: 1,
        total: 2,
        done: false
      })
      await p
    })

    expect(result.current.progress?.completed).toBe(1)
    expect(result.current.summary?.imported).toBe(2)
    expect(result.current.isRunning).toBe(false)
  })

  it('surfaces an error envelope and does not show a summary', async () => {
    // Reproduces a rejected import (e.g. a Markdown export): the runner still
    // emits a done progress event with an empty summary, then start() resolves
    // with { success: false, error }. The hook must show the error, not a
    // misleading "Import complete".
    let progressCb: (e: ImportProgressEvent) => void = () => {}
    ;(window as unknown as { api: unknown }).api = {
      onImportProgress: (fn: (e: ImportProgressEvent) => void) => {
        progressCb = fn
        return () => {}
      },
      import: {
        pickFiles: vi.fn(),
        cancel: vi.fn(),
        start: vi.fn(async (input: { importId: string }) => {
          progressCb({
            importId: input.importId,
            phase: 'done',
            status: '',
            imported: 0,
            attachments: 0,
            skipped: 0,
            failed: 0,
            completed: 0,
            total: 0,
            done: true,
            summary: { imported: 0, attachments: 0, skipped: 0, failed: [] }
          })
          return {
            success: false,
            error: 'This looks like a Notion Markdown export. Please re-export as HTML.'
          }
        })
      }
    }

    const { result } = renderHook(() => useImportRun())
    await act(async () => {
      await result.current.start('notion', ['markdown.zip'])
    })

    expect(result.current.error).toMatch(/Markdown export/)
    expect(result.current.summary).toBeNull()
  })

  it('cancels the active run by id', async () => {
    const api = installApi()
    const { result } = renderHook(() => useImportRun())

    await act(async () => {
      await result.current.start('notion', ['a.zip'])
    })

    act(() => {
      result.current.cancel()
    })

    expect(api.cancel).toHaveBeenCalledWith({ importId: api.startedIds[0] })
  })

  // ==========================================================================
  // status: string | ImportMessage
  //
  // The hook is a pass-through for the progress payload. A plain string is the
  // backward-compatibility shape (an older build, or an importer not yet
  // migrated); a structured { code, message, params } is the translatable one.
  // Rendering belongs to import-message, so these assert the value the hook
  // exposes is byte-for-byte what the main process sent.
  // ==========================================================================

  it('exposes a plain-string status untouched (payload from an older build)', async () => {
    const api = installApi()
    const { result } = renderHook(() => useImportRun())

    await act(async () => {
      const p = result.current.start('bear', ['b.zip'])
      api.emit(
        progressEvent({
          importId: api.startedIds[0],
          status: 'Importing 3 of 10 notes…',
          completed: 3,
          total: 10
        })
      )
      await p
    })

    expect(result.current.progress?.status).toBe('Importing 3 of 10 notes…')
    expect(typeof result.current.progress?.status).toBe('string')
  })

  it('exposes a structured status untouched, keeping code and params', async () => {
    const api = installApi()
    const status: ImportMessage = {
      code: 'import.warning.attachmentMissing',
      message: 'Attachment "logo.png" is missing',
      params: { name: 'logo.png', count: 2 }
    }
    const { result } = renderHook(() => useImportRun())

    await act(async () => {
      const p = result.current.start('evernote', ['e.enex'])
      api.emit(progressEvent({ importId: api.startedIds[0], status }))
      await p
    })

    // No flattening to a display string, and no translation at this layer.
    expect(result.current.progress?.status).toEqual(status)
    expect((result.current.progress?.status as ImportMessage).code).toBe(
      'import.warning.attachmentMissing'
    )
    expect((result.current.progress?.status as ImportMessage).params).toEqual({
      name: 'logo.png',
      count: 2
    })
  })

  it('carries a mixed stream of both status shapes within one run', async () => {
    const api = installApi()
    const structured: ImportMessage = { code: 'import.phase.writing', message: 'Writing notes' }
    const { result } = renderHook(() => useImportRun())
    const seen: ImportProgressEvent['status'][] = []

    await act(async () => {
      const p = result.current.start('roam', ['r.json'])
      const id = api.startedIds[0]
      api.emit(progressEvent({ importId: id, status: 'Scanning…', phase: 'scanning' }))
      seen.push('Scanning…')
      api.emit(progressEvent({ importId: id, status: structured }))
      seen.push(structured)
      api.emit(progressEvent({ importId: id, status: 'Finishing…', done: true, phase: 'done' }))
      seen.push('Finishing…')
      await p
    })

    // Last event wins; the earlier structured shape does not leak into it.
    expect(result.current.progress?.status).toBe('Finishing…')
    expect(seen).toHaveLength(3)
  })

  // ==========================================================================
  // Progress routing: stale ids, out-of-order events, events after completion
  // ==========================================================================

  it('ignores progress addressed to a different import id', async () => {
    const api = installApi()
    const { result } = renderHook(() => useImportRun())

    await act(async () => {
      const p = result.current.start('notion', ['a.zip'])
      api.emit(progressEvent({ importId: api.startedIds[0], completed: 1 }))
      api.emit(progressEvent({ importId: 'some-other-run', completed: 99, total: 99 }))
      await p
    })

    expect(result.current.progress?.completed).toBe(1)
    expect(result.current.progress?.importId).toBe(api.startedIds[0])
  })

  it('drops late progress from a previous run once a new run is active', async () => {
    const api = installApi()
    const { result } = renderHook(() => useImportRun())

    await act(async () => {
      await result.current.start('notion', ['first.zip'])
    })
    const firstId = api.startedIds[0]

    await act(async () => {
      const p = result.current.start('notion', ['second.zip'])
      const secondId = api.startedIds[1]
      api.emit(progressEvent({ importId: secondId, completed: 1 }))
      // The abandoned run flushes a trailing event on the live subscription.
      api.emit(progressEvent({ importId: firstId, completed: 42, total: 42 }))
      await p
    })

    expect(firstId).not.toBe(api.startedIds[1])
    expect(result.current.progress?.importId).toBe(api.startedIds[1])
    expect(result.current.progress?.completed).toBe(1)
  })

  it('stops applying progress once the run has finished', async () => {
    const api = installApi()
    const { result } = renderHook(() => useImportRun())

    await act(async () => {
      const p = result.current.start('notion', ['a.zip'])
      api.emit(progressEvent({ importId: api.startedIds[0], completed: 2, total: 2 }))
      await p
    })

    expect(api.unsubscribes[0]).toHaveBeenCalled()
    expect(api.listenerCount()).toBe(0)

    act(() => {
      api.emit(progressEvent({ importId: api.startedIds[0], completed: 0, total: 0, done: true }))
    })

    expect(result.current.progress?.completed).toBe(2)
    expect(result.current.progress?.done).toBe(false)
  })

  it('applies the newest event even when it arrives out of order', async () => {
    // The hook is last-write-wins by design — ordering is the producer's job.
    // Pinning this keeps a future "clamp/monotonic counters" change honest.
    const api = installApi()
    const { result } = renderHook(() => useImportRun())

    await act(async () => {
      const p = result.current.start('notion', ['a.zip'])
      const id = api.startedIds[0]
      api.emit(progressEvent({ importId: id, completed: 5, total: 10 }))
      api.emit(progressEvent({ importId: id, completed: 3, total: 10 }))
      await p
    })

    expect(result.current.progress?.completed).toBe(3)
  })

  it('tears down the progress subscription when unmounted mid-run', () => {
    const pending = deferred<ImportStartResponse>()
    const api = installApi({ start: () => pending.promise })
    const { result, unmount } = renderHook(() => useImportRun())

    act(() => {
      void result.current.start('notion', ['a.zip'])
    })
    expect(api.listenerCount()).toBe(1)

    unmount()

    expect(api.unsubscribes[0]).toHaveBeenCalled()
    expect(api.listenerCount()).toBe(0)
  })

  it('resubscribes for a second run instead of stacking listeners', async () => {
    const api = installApi()
    const { result } = renderHook(() => useImportRun())

    await act(async () => {
      await result.current.start('notion', ['first.zip'])
    })
    await act(async () => {
      await result.current.start('notion', ['second.zip'])
    })

    expect(api.onImportProgress).toHaveBeenCalledTimes(2)
    expect(api.listenerCount()).toBe(0)
  })

  // ==========================================================================
  // start(): failure paths
  // ==========================================================================

  it('reports a thrown IPC failure with the thrown message', async () => {
    installApi({ start: async () => Promise.reject(new Error('EPERM: source is unreadable')) })
    const { result } = renderHook(() => useImportRun())

    await act(async () => {
      await result.current.start('notion', ['a.zip'])
    })

    expect(result.current.error).toBe('EPERM: source is unreadable')
    expect(result.current.summary).toBeNull()
    expect(result.current.isRunning).toBe(false)
  })

  it('falls back to the localized import error when the rejection is not an Error', async () => {
    installApi({ start: async () => Promise.reject('channel closed') })
    const { result } = renderHook(() => useImportRun())

    await act(async () => {
      await result.current.start('notion', ['a.zip'])
    })

    expect(result.current.error).toBe('Import failed')
  })

  it('falls back to the localized import error when the envelope carries no text', async () => {
    installApi({ start: async () => ({ success: false }) })
    const { result } = renderHook(() => useImportRun())

    await act(async () => {
      await result.current.start('notion', ['a.zip'])
    })

    expect(result.current.error).toBe('Import failed')
    expect(result.current.summary).toBeNull()
  })

  it('clears the failed run before retrying so no stale error is shown', async () => {
    const retry = deferred<ImportStartResponse>()
    let attempt = 0
    const api = installApi({
      start: async () => {
        attempt += 1
        if (attempt === 1) return { success: false as const, error: 'Import failed halfway' }
        return await retry.promise
      }
    })
    const { result } = renderHook(() => useImportRun())

    await act(async () => {
      const p = result.current.start('notion', ['a.zip'])
      api.emit(progressEvent({ importId: api.startedIds[0], completed: 1 }))
      await p
    })
    expect(result.current.error).toBe('Import failed halfway')
    expect(result.current.progress?.completed).toBe(1)

    // While the retry is in flight the dialog must show a clean running state,
    // not the previous failure alongside a spinner.
    let run!: Promise<void>
    act(() => {
      run = result.current.start('notion', ['a.zip'])
    })
    expect(result.current.error).toBeNull()
    expect(result.current.progress).toBeNull()
    expect(result.current.isRunning).toBe(true)

    await act(async () => {
      retry.resolve({ success: true, summary: SUMMARY })
      await run
    })

    expect(result.current.error).toBeNull()
    expect(result.current.summary).toEqual(SUMMARY)
  })

  // ==========================================================================
  // cancel()
  // ==========================================================================

  it('cancels the in-flight run and still surfaces the partial summary', async () => {
    const pending = deferred<ImportStartResponse>()
    const api = installApi({ start: () => pending.promise })
    const { result } = renderHook(() => useImportRun())

    let run!: Promise<void>
    act(() => {
      run = result.current.start('notion', ['a.zip'])
    })
    expect(result.current.isRunning).toBe(true)

    act(() => {
      result.current.cancel()
    })
    expect(api.cancel).toHaveBeenCalledWith({ importId: api.startedIds[0] })

    // A cancelled run resolves with what it managed to write.
    const partial = { imported: 1, attachments: 0, skipped: 3, failed: [] }
    await act(async () => {
      pending.resolve({ success: true, summary: partial })
      await run
    })

    expect(result.current.summary).toEqual(partial)
    expect(result.current.error).toBeNull()
    expect(result.current.isRunning).toBe(false)
  })

  it('does not send a cancel when no run has started', () => {
    const api = installApi()
    const { result } = renderHook(() => useImportRun())

    act(() => {
      result.current.cancel()
    })

    expect(api.cancel).not.toHaveBeenCalled()
  })

  it('does not send a cancel for a run that was already reset', async () => {
    const api = installApi()
    const { result } = renderHook(() => useImportRun())

    await act(async () => {
      await result.current.start('notion', ['a.zip'])
    })
    act(() => {
      result.current.reset()
    })
    act(() => {
      result.current.cancel()
    })

    expect(api.cancel).not.toHaveBeenCalled()
  })

  // ==========================================================================
  // runPreview()
  // ==========================================================================

  it('exposes the preview and clears a previous run while previewing', async () => {
    const previewPending = deferred<ImportPreviewResponse>()
    const api = installApi({ preview: () => previewPending.promise })
    const { result } = renderHook(() => useImportRun())

    await act(async () => {
      await result.current.start('notion', ['a.zip'])
    })
    expect(result.current.summary).toEqual(SUMMARY)

    let run!: Promise<void>
    act(() => {
      run = result.current.runPreview('notion', ['b.zip'])
    })

    expect(result.current.isPreviewing).toBe(true)
    expect(result.current.summary).toBeNull()
    expect(result.current.importId).toBe(api.previewedIds[0])
    expect(api.previewedIds[0]).not.toBe(api.startedIds[0])

    const preview: ImportPreview = {
      groups: [{ label: 'Export.zip', counts: [{ labelKey: 'import.preview.notes', value: 12 }] }]
    }
    await act(async () => {
      previewPending.resolve({ success: true, preview })
      await run
    })

    expect(result.current.preview).toEqual(preview)
    expect(result.current.isPreviewing).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('passes preview warnings through in both message shapes', async () => {
    const structured: ImportMessage = {
      code: 'import.warning.unsupportedBlock',
      message: 'Skipped 3 unsupported blocks',
      params: { count: 3 }
    }
    const preview: ImportPreview = {
      groups: [
        {
          label: 'Legacy.zip',
          counts: [{ labelKey: 'import.preview.notes', value: 1 }],
          warnings: ['Plain warning from an older build', structured],
          error: { code: 'import.error.unreadable', message: 'Could not read Legacy.zip' }
        }
      ]
    }
    installApi({ preview: async () => ({ success: true as const, preview }) })
    const { result } = renderHook(() => useImportRun())

    await act(async () => {
      await result.current.runPreview('notion', ['legacy.zip'])
    })

    const group = result.current.preview?.groups[0]
    expect(group?.warnings?.[0]).toBe('Plain warning from an older build')
    expect(group?.warnings?.[1]).toEqual(structured)
    expect(group?.error).toEqual({
      code: 'import.error.unreadable',
      message: 'Could not read Legacy.zip'
    })
  })

  it('surfaces a preview error envelope without a preview', async () => {
    installApi({
      preview: async () => ({ success: false as const, error: 'Not a Notion export' })
    })
    const { result } = renderHook(() => useImportRun())

    await act(async () => {
      await result.current.runPreview('notion', ['wrong.zip'])
    })

    expect(result.current.error).toBe('Not a Notion export')
    expect(result.current.preview).toBeNull()
    expect(result.current.isPreviewing).toBe(false)
  })

  it('falls back to the localized preview error when the envelope carries no text', async () => {
    installApi({ preview: async () => ({ success: false }) })
    const { result } = renderHook(() => useImportRun())

    await act(async () => {
      await result.current.runPreview('notion', ['wrong.zip'])
    })

    expect(result.current.error).toBe('Preview failed')
  })

  it('reports a thrown preview with its message, and falls back otherwise', async () => {
    installApi({ preview: async () => Promise.reject(new Error('ENOENT: wrong.zip')) })
    const { result, rerender } = renderHook(() => useImportRun())

    await act(async () => {
      await result.current.runPreview('notion', ['wrong.zip'])
    })
    expect(result.current.error).toBe('ENOENT: wrong.zip')

    installApi({ preview: async () => Promise.reject('nope') })
    rerender()
    await act(async () => {
      await result.current.runPreview('notion', ['wrong.zip'])
    })
    expect(result.current.error).toBe('Preview failed')
    expect(result.current.isPreviewing).toBe(false)
  })

  // ==========================================================================
  // reset()
  // ==========================================================================

  it('reset clears every exposed field', async () => {
    const api = installApi()
    const { result } = renderHook(() => useImportRun())

    await act(async () => {
      const p = result.current.start('notion', ['a.zip'])
      api.emit(progressEvent({ importId: api.startedIds[0], completed: 1 }))
      await p
    })
    expect(result.current.progress).not.toBeNull()
    expect(result.current.summary).not.toBeNull()

    act(() => {
      result.current.reset()
    })

    expect(result.current.progress).toBeNull()
    expect(result.current.summary).toBeNull()
    expect(result.current.preview).toBeNull()
    expect(result.current.error).toBeNull()
    expect(result.current.importId).toBeNull()
  })

  it('reset detaches an in-flight run so its progress no longer surfaces', async () => {
    const pending = deferred<ImportStartResponse>()
    const api = installApi({ start: () => pending.promise })
    const { result } = renderHook(() => useImportRun())

    let run!: Promise<void>
    act(() => {
      run = result.current.start('notion', ['a.zip'])
    })
    act(() => {
      api.emit(progressEvent({ importId: api.startedIds[0], completed: 1 }))
    })
    expect(result.current.progress?.completed).toBe(1)

    act(() => {
      result.current.reset()
    })
    act(() => {
      api.emit(progressEvent({ importId: api.startedIds[0], completed: 2 }))
    })

    expect(result.current.progress).toBeNull()

    await act(async () => {
      pending.resolve({ success: true, summary: SUMMARY })
      await run
    })
  })
})
