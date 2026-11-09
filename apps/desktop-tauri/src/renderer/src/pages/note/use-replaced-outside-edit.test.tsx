import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useReplacedOutsideEdit } from './use-replaced-outside-edit'

const kept = vi.hoisted(() => new Set<(event: { id: string }) => void>())

vi.mock('sonner', () => ({ toast: vi.fn() }))
vi.mock('@/services/notes-service', () => ({
  onNoteOutsideEditKept: (handler: (event: { id: string }) => void) => {
    kept.add(handler)
    return () => kept.delete(handler)
  }
}))

describe('useReplacedOutsideEdit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    kept.clear()
  })

  // A note tab and the project overview of the same note both hear the core's event (#4088).
  it('tells of a kept outside edit in one toast however many editors of the note are open', () => {
    renderHook(() => useReplacedOutsideEdit('n1', vi.fn()))
    renderHook(() => useReplacedOutsideEdit('n1', vi.fn()))

    act(() => {
      for (const handler of kept) handler({ id: 'n1' })
    })

    const ids = vi.mocked(toast).mock.calls.map(([, options]) => options?.id)
    expect(ids).toEqual(['outside-edit-replaced:n1', 'outside-edit-replaced:n1'])
  })
})
