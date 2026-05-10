import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import { useNoteEditor } from './use-note-editor'

describe('useNoteEditor', () => {
  let api: ReturnType<typeof createMockApi>
  const note = {
    id: 'note-1',
    title: 'Original',
    content: 'Body',
    path: 'notes/original.md',
    folder: 'notes',
    tags: ['one'],
    emoji: '📝',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z'
  }

  beforeEach(() => {
    api = createMockApi()
    api.notes.get = vi.fn().mockResolvedValue(note)
    api.notes.update = vi.fn().mockImplementation((input) =>
      Promise.resolve({
        ...note,
        ...input,
        modified: '2026-01-02T00:00:00.000Z'
      })
    )
    api.notes.rename = vi.fn().mockImplementation((id, title) =>
      Promise.resolve({
        ...note,
        id,
        title,
        modified: '2026-01-02T00:00:00.000Z'
      })
    )
    api.onNoteDeleted = vi.fn().mockReturnValue(() => {})
    api.onNoteExternalChange = vi.fn().mockReturnValue(() => {})
    ;(window as Window & { api: unknown }).api = api
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('loads a note, reacts to deletion events, and unsubscribes on unmount', async () => {
    const deletedCallbacks: Array<(event: { id: string }) => void> = []
    const externalCallbacks: Array<(event: { id: string; type: string }) => void> = []
    const unsubDeleted = vi.fn()
    const unsubExternal = vi.fn()
    api.onNoteDeleted = vi.fn((callback) => {
      deletedCallbacks.push(callback)
      return unsubDeleted
    })
    api.onNoteExternalChange = vi.fn((callback) => {
      externalCallbacks.push(callback)
      return unsubExternal
    })

    const { result, unmount } = renderHook(() => useNoteEditor('note-1'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.note?.title).toBe('Original')
    expect(api.notes.get).toHaveBeenCalledWith('note-1')

    act(() => {
      deletedCallbacks[0]({ id: 'other' })
      externalCallbacks[0]({ id: 'note-1', type: 'updated' })
    })
    expect(result.current.isDeleted).toBe(false)

    act(() => {
      externalCallbacks[0]({ id: 'note-1', type: 'deleted' })
    })
    expect(result.current.isDeleted).toBe(true)

    unmount()

    expect(unsubDeleted).toHaveBeenCalled()
    expect(unsubExternal).toHaveBeenCalled()
  })

  it('updates title, emoji, tags, debounced content, manual saves, and saved status reset', async () => {
    const { result } = renderHook(() => useNoteEditor('note-1', { debounceMs: 50 }))

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.updateTitle('Renamed')
      await result.current.updateEmoji('✅')
      await result.current.updateTags(['two'])
    })

    expect(api.notes.rename).toHaveBeenCalledWith('note-1', 'Renamed')
    expect(api.notes.update).toHaveBeenCalledWith({ id: 'note-1', emoji: '✅' })
    expect(api.notes.update).toHaveBeenCalledWith({ id: 'note-1', tags: ['two'] })

    vi.useFakeTimers()

    act(() => {
      result.current.updateContent('Changed')
    })
    expect(api.notes.update).not.toHaveBeenCalledWith({ id: 'note-1', content: 'Changed' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })

    expect(api.notes.update).toHaveBeenCalledWith({ id: 'note-1', content: 'Changed' })

    act(() => {
      result.current.updateContent('Manual')
    })
    await act(async () => {
      await result.current.saveNow()
    })

    expect(api.notes.update).toHaveBeenCalledWith({ id: 'note-1', content: 'Manual' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    expect(result.current.saveStatus).toBe('idle')
  })

  it('handles load and save errors, clearError, null note ids, and disabled autosave', async () => {
    api.notes.get = vi.fn().mockRejectedValueOnce(new Error('load failed'))

    const failedLoad = renderHook(() => useNoteEditor('note-1', { showToasts: false }))
    await waitFor(() => expect(failedLoad.result.current.isLoading).toBe(false))

    expect(failedLoad.result.current.error).toBe('load failed')

    act(() => {
      failedLoad.result.current.clearError()
    })
    expect(failedLoad.result.current.error).toBeNull()

    const nullHook = renderHook(() => useNoteEditor(null))
    await waitFor(() => expect(nullHook.result.current.isLoading).toBe(false))

    await act(async () => {
      await nullHook.result.current.updateTitle('ignored')
      nullHook.result.current.updateContent('ignored')
      await nullHook.result.current.updateEmoji(null)
      await nullHook.result.current.updateTags([])
      await nullHook.result.current.saveNow()
    })

    api.notes.get = vi.fn().mockResolvedValue(note)
    api.notes.update = vi.fn().mockRejectedValueOnce(new Error('save failed'))
    const noAutoSave = renderHook(() =>
      useNoteEditor('note-1', { autoSave: false, showToasts: false })
    )
    await waitFor(() => expect(noAutoSave.result.current.isLoading).toBe(false))

    act(() => {
      noAutoSave.result.current.updateContent('Pending')
    })
    expect(api.notes.update).not.toHaveBeenCalled()

    await act(async () => {
      await noAutoSave.result.current.saveNow()
    })

    expect(noAutoSave.result.current.error).toBe('save failed')
    expect(noAutoSave.result.current.saveStatus).toBe('error')

    act(() => {
      noAutoSave.result.current.clearError()
    })
    expect(noAutoSave.result.current.saveStatus).toBe('idle')
  })
})
