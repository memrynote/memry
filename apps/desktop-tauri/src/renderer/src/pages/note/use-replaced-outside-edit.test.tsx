import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useReplacedOutsideEdit } from './use-replaced-outside-edit'

const kept = vi.hoisted(() => new Set<(event: { id: string }) => void>())
const openTab = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({ toast: vi.fn() }))
vi.mock('@/contexts/tabs', () => ({ useTabActionsOptional: () => ({ openTab }) }))
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
    renderHook(() => useReplacedOutsideEdit('n1', 'Alpha', vi.fn()))
    renderHook(() => useReplacedOutsideEdit('n1', 'Alpha', vi.fn()))

    act(() => {
      for (const handler of kept) handler({ id: 'n1' })
    })

    const ids = vi.mocked(toast).mock.calls.map(([, options]) => options?.id)
    expect(ids).toEqual(['outside-edit-replaced:n1', 'outside-edit-replaced:n1'])
  })

  // The core alone says whether the replaced text is a version (#4110): a save sent before the
  // editor heard of another editor's small save lands over it with none.
  it('tells of a replaced outside edit only when the save says the core kept it', () => {
    const { result } = renderHook(() => useReplacedOutsideEdit('n1', 'Alpha', vi.fn()))
    const edit = result.current

    edit.held('n1', 'saved in the tab')
    expect(edit.saved('n1', 'typing', { success: true, note: null })).toBe(false)
    // Kept, but this save replaced no text the editor did not show.
    expect(edit.saved('n1', 'typing', { success: true, note: null, keptReplaced: true })).toBe(
      false
    )
    expect(toast).not.toHaveBeenCalled()

    edit.held('n1', 'saved in the tab')
    expect(edit.saved('n1', 'typing', { success: true, note: null, keptReplaced: true })).toBe(true)
    expect(toast).toHaveBeenCalledTimes(1)
  })

  // The save sent when the editor leaves a note answers after it shows the next one, or after it
  // closed: the toast's action opens the replaced note's history, not the shown note's (#4088).
  describe("the toast's action opens the version history of the note the save replaced", () => {
    const replace = (
      edit: ReturnType<typeof useReplacedOutsideEdit>
    ): { onClick: () => void; description?: string } => {
      edit.held('n1', 'outside')
      act(() => {
        edit.saved('n1', 'typing', { success: true, keptReplaced: true })
      })
      const [, options] = vi.mocked(toast).mock.calls.at(-1)!
      const action = options?.action as { onClick: () => void }
      return { onClick: action.onClick, description: options?.description as string }
    }
    const openedWithVersions = {
      type: 'note',
      entityId: 'n1',
      title: 'Alpha',
      path: '/note/n1',
      viewState: { versionHistory: true }
    }

    it('while the editor shows the note', () => {
      const show = vi.fn()
      const { result } = renderHook(() => useReplacedOutsideEdit('n1', 'Alpha', show))

      replace(result.current).onClick()

      expect(show).toHaveBeenCalledTimes(1)
      expect(openTab).not.toHaveBeenCalled()
    })

    it('after the editor moved to another note', () => {
      const show = vi.fn()
      const { result, rerender } = renderHook(
        ({ id, title }) => useReplacedOutsideEdit(id, title, show),
        { initialProps: { id: 'n1', title: 'Alpha' } }
      )
      rerender({ id: 'n2', title: 'Beta' })

      const toasted = replace(result.current)
      toasted.onClick()

      expect(toasted.description).toBe('Alpha')
      expect(show).not.toHaveBeenCalled()
      expect(openTab).toHaveBeenCalledWith(expect.objectContaining(openedWithVersions))
    })

    it('after the editor closed', () => {
      const show = vi.fn()
      const { result, unmount } = renderHook(() => useReplacedOutsideEdit('n1', 'Alpha', show))
      const edit = result.current
      unmount()

      replace(edit).onClick()

      expect(show).not.toHaveBeenCalled()
      expect(openTab).toHaveBeenCalledWith(expect.objectContaining(openedWithVersions))
    })
  })
})
