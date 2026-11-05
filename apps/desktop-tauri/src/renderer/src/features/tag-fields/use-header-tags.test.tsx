import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerPendingSave, unregisterPendingSave } from '@/lib/save-registry'
import { useHeaderTags } from './use-header-tags'

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  mutateAsync: vi.fn(),
  undoTagTemplate: vi.fn(),
  toast: vi.fn()
}))

vi.mock('sonner', () => ({ toast: Object.assign(mocks.toast, { error: vi.fn() }) }))
vi.mock('@/hooks/use-notes-query', () => ({
  useNoteMutations: () => ({ updateNote: { mutateAsync: mocks.mutateAsync } })
}))
vi.mock('@/services/notes-service', () => ({
  notesService: { undoTagTemplate: mocks.undoTagTemplate }
}))
vi.mock('./use-tag-schemas', () => ({
  useTagSchemas: () => ({ data: undefined }),
  resolveTag: () => null
}))

beforeEach(() => {
  mocks.order.length = 0
  mocks.toast.mockReset()
  mocks.mutateAsync.mockResolvedValue({
    success: true,
    tagTemplate: { kind: 'applied', tag: 'person', undoToken: 'undo-1' }
  })
  mocks.undoTagTemplate.mockImplementation(async () => {
    mocks.order.push('undo')
    return { status: 'restored' }
  })
})

describe('useHeaderTags', () => {
  it('saves typing not saved yet before a tag template is taken back', async () => {
    registerPendingSave('note-page:n1', () => {
      mocks.order.push('flush')
    })
    const { result } = renderHook(() =>
      useHeaderTags({
        noteId: 'n1',
        noteTitle: 'Ada',
        headerTags: [],
        values: {},
        canEdit: () => true
      })
    )

    await act(() => result.current.addTag('person'))
    const action = mocks.toast.mock.calls[0]?.[1]?.action as { onClick: () => void }
    await act(async () => action.onClick())

    expect(mocks.undoTagTemplate).toHaveBeenCalledWith({ noteId: 'n1', undoToken: 'undo-1' })
    expect(mocks.order).toEqual(['flush', 'undo'])
    unregisterPendingSave('note-page:n1')
  })
})
