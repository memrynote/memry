import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => ({
  deleted: new Set<(event: { id: string }) => void>(),
  created: new Set<(event: { note: { id: string } }) => void>()
}))
const useNote = vi.hoisted(() => vi.fn())
const refetch = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/use-notes-query', () => ({ useNote }))
vi.mock('@/services/notes-service', () => {
  const subscribe =
    <E>(set: Set<(event: E) => void>) =>
    (callback: (event: E) => void) => {
      set.add(callback)
      return () => set.delete(callback)
    }
  const none = () => () => undefined
  return {
    onNoteDeleted: subscribe(handlers.deleted),
    onNoteCreated: subscribe(handlers.created),
    onNoteUpdated: none,
    onNoteRenamed: none,
    onNoteMoved: none
  }
})

import { usePortalSourceNote } from './use-portal-source-note'

const note = { id: 'src', title: 'Source' }

beforeEach(() => {
  handlers.deleted.clear()
  handlers.created.clear()
  refetch.mockReset()
  useNote.mockReturnValue({ note, isLoading: false, refetch })
})

describe('usePortalSourceNote', () => {
  it('reads as missing the moment the source note is deleted', () => {
    const { result } = renderHook(() => usePortalSourceNote('src'))
    expect(result.current.note).toBe(note)

    act(() => {
      handlers.deleted.forEach((cb) => cb({ id: 'src' }))
    })

    expect(result.current.note).toBeNull()
  })

  it('ignores the deletion of another note', () => {
    const { result } = renderHook(() => usePortalSourceNote('src'))
    act(() => {
      handlers.deleted.forEach((cb) => cb({ id: 'other' }))
    })
    expect(result.current.note).toBe(note)
  })

  it('recovers, and reloads the note, when the source note comes back', () => {
    const { result } = renderHook(() => usePortalSourceNote('src'))
    act(() => {
      handlers.deleted.forEach((cb) => cb({ id: 'src' }))
    })
    expect(result.current.note).toBeNull()

    act(() => {
      handlers.created.forEach((cb) => cb({ note: { id: 'src' } }))
    })

    expect(refetch).toHaveBeenCalledTimes(1)
    expect(result.current.note).toBe(note)
  })

  it('does not reload a note that was never deleted', () => {
    renderHook(() => usePortalSourceNote('src'))
    act(() => {
      handlers.created.forEach((cb) => cb({ note: { id: 'src' } }))
    })
    expect(refetch).not.toHaveBeenCalled()
  })
})
