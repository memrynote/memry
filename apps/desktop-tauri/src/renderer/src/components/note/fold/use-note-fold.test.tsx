import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FoldLayers } from '@memry/contracts/note-fold'
import { commands } from '../../../../../generated/bindings'
import { layers } from './fold-fixtures'
import { useNoteFold } from './use-note-fold'

vi.mock('../../../../../generated/bindings', () => ({
  commands: { foldRun: vi.fn(), foldRetry: vi.fn() },
  events: { noteFoldUpdatedEvent: { listen: vi.fn(() => Promise.resolve(() => {})) } }
}))

/** A fold answer the test sends when it chooses. */
function pending(): { promise: Promise<FoldLayers>; answer: (layers: FoldLayers) => void } {
  let answer: (layers: FoldLayers) => void = () => {}
  const promise = new Promise<FoldLayers>((resolve) => (answer = resolve))
  return { promise, answer }
}

describe('useNoteFold', () => {
  beforeEach(() => {
    vi.mocked(commands.foldRun).mockReset()
    vi.mocked(commands.foldRetry).mockReset()
  })

  // The journal keeps one hook while the reader moves between days, and a long day folds
  // slower than a short one, so the previous day's answer can land after the current one's.
  it("keeps the current day's fold when the previous day's answer lands after it", async () => {
    const dayA = pending()
    const dayB = pending()
    vi.mocked(commands.foldRun).mockReturnValueOnce(dayA.promise).mockReturnValueOnce(dayB.promise)
    const { result, rerender } = renderHook(({ id }) => useNoteFold(id, 1104), {
      initialProps: { id: 'day-a' }
    })
    rerender({ id: 'day-b' })
    await waitFor(() => expect(commands.foldRun).toHaveBeenCalledWith('day-b', 'full'))

    dayB.answer(layers({ noteId: 'day-b' }))
    await waitFor(() => expect(result.current.layers?.noteId).toBe('day-b'))
    await act(async () => {
      dayA.answer(layers({ noteId: 'day-a' }))
      await dayA.promise
    })

    expect(result.current.layers?.noteId).toBe('day-b')
  })

  it('shows the fold a retry wrote', async () => {
    vi.mocked(commands.foldRun).mockResolvedValue(layers({ ready: [], status: 'failed' }))
    vi.mocked(commands.foldRetry).mockResolvedValue(layers())
    const { result } = renderHook(() => useNoteFold('note-1', 1104))
    await waitFor(() => expect(result.current.layers?.status).toBe('failed'))

    act(() => result.current.retry())

    await waitFor(() => expect(result.current.layers?.status).toBe('ready'))
    expect(commands.foldRetry).toHaveBeenCalledWith('note-1')
  })
})
