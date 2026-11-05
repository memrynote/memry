import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { commands } from '../../../../generated/bindings'
import { useTagScopeActions } from './use-tag-scope-actions'

const toasts = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn() }))

vi.mock('sonner', () => ({
  toast: {
    success: toasts.success,
    warning: toasts.warning,
    error: toasts.error,
    loading: vi.fn(),
    dismiss: vi.fn()
  }
}))

const left = { oldName: 'old', newName: 'new', left: 1, notes: [{ id: 'n1', title: 'Plan' }] }

async function renameRefusedWith(code: string, message: string): Promise<void> {
  vi.spyOn(commands, 'tagsRenameUnfinished').mockResolvedValue(left)
  vi.spyOn(commands, 'tagsRename').mockRejectedValueOnce({ kind: 'invalid', code, message })
  const { result } = renderHook(() => useTagScopeActions('work', 1, vi.fn()))
  await expect(result.current.handleTagRenameSubmit('home')).rejects.toThrow(message)
}

describe('useTagScopeActions rename', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    toasts.warning.mockClear()
    toasts.error.mockClear()
  })

  it('shows the rename left unfinished in place of the refusal it causes', async () => {
    await renameRefusedWith('tag_rename_unfinished', 'refused')
    expect(toasts.warning).toHaveBeenCalledWith(
      "Renaming #old to #new didn't finish for 1 note. Rename #old to #new again to finish it.",
      expect.objectContaining({ description: 'Plan' })
    )
    expect(toasts.error).not.toHaveBeenCalled()
  })

  it('shows a failure of its own as itself while a rename is left unfinished', async () => {
    await renameRefusedWith('io', 'disk full')
    expect(toasts.error).toHaveBeenCalledWith('disk full')
    expect(toasts.warning).not.toHaveBeenCalled()
  })
})

describe('useTagScopeActions delete', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    toasts.warning.mockClear()
    toasts.error.mockClear()
    toasts.success.mockClear()
  })

  it('says how many notes kept the tag when the delete could not write them all', async () => {
    vi.spyOn(commands, 'tagsDelete').mockResolvedValue({
      affectedNotes: 1,
      failedNotes: [
        { id: 'n1', title: 'Plan' },
        { id: 'n2', title: 'Ideas' }
      ],
      retryFinishes: true
    })
    const closeTab = vi.fn()
    const { result } = renderHook(() => useTagScopeActions('work', 3, closeTab))
    await result.current.handleTagDeleteConfirm()
    expect(toasts.warning).toHaveBeenCalledWith(
      "Couldn't update 2 notes. Delete #work again to finish.",
      { description: 'Plan, Ideas', duration: 10_000 }
    )
    expect(toasts.success).not.toHaveBeenCalled()
    expect(closeTab).toHaveBeenCalled()
  })

  it('shows the rename left unfinished in place of the delete it refused', async () => {
    vi.spyOn(commands, 'tagsRenameUnfinished').mockResolvedValue(left)
    vi.spyOn(commands, 'tagsDelete').mockRejectedValueOnce({
      kind: 'invalid',
      code: 'tag_rename_unfinished',
      message: 'refused'
    })
    const { result } = renderHook(() => useTagScopeActions('work', 3, vi.fn()))
    await result.current.handleTagDeleteConfirm()
    expect(toasts.warning).toHaveBeenCalledWith(
      "Renaming #old to #new didn't finish for 1 note. Rename #old to #new again to finish it.",
      expect.objectContaining({ description: 'Plan' })
    )
    expect(toasts.error).not.toHaveBeenCalled()
  })
})
