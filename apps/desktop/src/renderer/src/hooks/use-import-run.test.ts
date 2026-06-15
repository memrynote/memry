import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ImportProgressEvent } from '@memry/contracts/import-channels'
import { useImportRun } from './use-import-run'

function installApi() {
  let progressCb: (e: ImportProgressEvent) => void = () => {}
  const startedIds: string[] = []
  const cancel = vi.fn()
  ;(window as unknown as { api: unknown }).api = {
    onImportProgress: (fn: (e: ImportProgressEvent) => void) => {
      progressCb = fn
      return () => {}
    },
    import: {
      pickFiles: vi.fn(async () => ({ canceled: false, filePaths: ['a.zip'] })),
      start: vi.fn(async (input: { importId: string }) => {
        startedIds.push(input.importId)
        return {
          success: true as const,
          summary: { imported: 2, attachments: 1, skipped: 0, failed: [] }
        }
      }),
      cancel
    }
  }
  return { emit: (e: ImportProgressEvent) => progressCb(e), startedIds, cancel }
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
})
