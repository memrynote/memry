import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commands, type FoldLayers as LocalLayers } from '../../../../../generated/bindings'
import { localLayers } from './fold-fixtures'
import { useNoteFold } from './use-note-fold'

vi.mock('../../../../../generated/bindings', () => ({ commands: { foldRun: vi.fn() } }))

/** A fold answer the test sends when it chooses. */
function pending(): { promise: Promise<LocalLayers>; answer: (layers: LocalLayers) => void } {
  let answer: (layers: LocalLayers) => void = () => {}
  const promise = new Promise<LocalLayers>((resolve) => (answer = resolve))
  return { promise, answer }
}

describe('useNoteFold', () => {
  beforeEach(() => vi.mocked(commands.foldRun).mockReset())

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

    dayB.answer(localLayers({ noteId: 'day-b' }))
    await waitFor(() => expect(result.current.layers?.noteId).toBe('day-b'))
    await act(async () => {
      dayA.answer(localLayers({ noteId: 'day-a' }))
      await dayA.promise
    })

    expect(result.current.layers?.noteId).toBe('day-b')
  })
})
