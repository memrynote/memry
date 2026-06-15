import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useTodoistImport } from './use-todoist-import.ts'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t: (k: string) => k }) }))

const preview = vi.fn()
const run = vi.fn()

beforeEach(() => {
  preview.mockReset()
  run.mockReset()
  // @ts-expect-error test shim for window.api
  window.api = { todoistImport: { preview, run } }
})

const previewFile = {
  fileName: 'Kişisel.csv',
  projectName: 'Kişisel',
  stats: {
    rows: 4,
    tasks: 3,
    subtasks: 1,
    withDueDate: 1,
    comments: 0,
    sectionsFlattened: 0,
    skipped: 0
  },
  sampleTitles: ['parent', 'child'],
  warnings: []
}

describe('useTodoistImport', () => {
  it('chooseFiles stores preview files', async () => {
    preview.mockResolvedValue({
      canceled: false,
      filePaths: ['/x/Kişisel.csv'],
      files: [previewFile]
    })
    const { result } = renderHook(() => useTodoistImport())
    await act(async () => {
      await result.current.chooseFiles()
    })
    await waitFor(() => expect(result.current.preview?.files).toHaveLength(1))
  })

  it('chooseFiles is a no-op when canceled', async () => {
    preview.mockResolvedValue({ canceled: true })
    const { result } = renderHook(() => useTodoistImport())
    await act(async () => {
      await result.current.chooseFiles()
    })
    expect(result.current.preview).toBeNull()
  })

  it('confirmImport calls run with stored paths and clears preview', async () => {
    preview.mockResolvedValue({ canceled: false, filePaths: ['/x/a.csv'], files: [previewFile] })
    run.mockResolvedValue({
      files: [{ projectName: 'a', projectId: 'p1', stats: previewFile.stats, warnings: [] }]
    })
    const { result } = renderHook(() => useTodoistImport())
    await act(async () => {
      await result.current.chooseFiles()
    })
    await act(async () => {
      await result.current.confirmImport()
    })
    expect(run).toHaveBeenCalledWith({ filePaths: ['/x/a.csv'] })
    expect(result.current.preview).toBeNull()
    expect(result.current.summary?.files[0].projectId).toBe('p1')
  })
})
