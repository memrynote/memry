import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  propertiesGet: vi.fn(),
  propertiesSet: vi.fn(),
  notesGet: vi.fn(),
  updateNote: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn() })
}))

vi.mock('@/services/properties-service', () => ({
  propertiesService: { get: mocks.propertiesGet, set: mocks.propertiesSet }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: { get: mocks.notesGet }
}))

vi.mock('@/hooks/use-notes-query', () => ({
  useNoteMutations: () => ({ updateNote: { mutateAsync: mocks.updateNote } })
}))

vi.mock('sonner', () => ({ toast: mocks.toast }))

import { useGraphEdits } from './use-graph-edits'
import { graphKeys } from './use-graph-data'

const B = 'memry://note/note-b'
const labels = { source: 'Alpha', target: 'Beta' }

function setup() {
  const queryClient = new QueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => useGraphEdits(), { wrapper })
  return { edits: result.current, invalidate }
}

/** The Undo action attached to the last plain toast. */
function lastUndo(): () => void {
  const options = mocks.toast.mock.lastCall?.[1] as { action: { onClick: () => void } }
  return options.action.onClick
}

function props(record: Record<string, unknown>) {
  return Object.entries(record).map(([name, value]) => ({ name, value, type: 'text' }))
}

describe('useGraphEdits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.propertiesSet.mockResolvedValue({ success: true })
    mocks.updateNote.mockResolvedValue({ success: true, note: null })
  })

  it('writes the link into `related`, refreshes the graph, and undoes it', async () => {
    const { edits, invalidate } = setup()
    mocks.propertiesGet.mockResolvedValue(props({ status: 'draft' }))

    await act(() => edits.linkNotes('note-a', 'note-b', labels))

    expect(mocks.propertiesSet).toHaveBeenCalledWith('note-a', { status: 'draft', related: [B] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: graphKeys.all })

    // Undo re-reads, so a property added meanwhile survives.
    mocks.propertiesGet.mockResolvedValue(props({ status: 'draft', related: [B], extra: 1 }))
    await act(async () => {
      lastUndo()()
      await vi.waitFor(() => expect(mocks.propertiesSet).toHaveBeenCalledTimes(2))
    })
    expect(mocks.propertiesSet).toHaveBeenLastCalledWith('note-a', {
      status: 'draft',
      related: [],
      extra: 1
    })
  })

  it('does not write when the link already exists or the property is taken', async () => {
    const { edits } = setup()

    mocks.propertiesGet.mockResolvedValue(props({ source: [B] }))
    await act(() => edits.linkNotes('note-a', 'note-b', labels))

    mocks.propertiesGet.mockResolvedValue(props({ related: 'plain text' }))
    await act(() => edits.linkNotes('note-a', 'note-b', labels))

    expect(mocks.propertiesSet).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledTimes(1)
    expect(mocks.toast.error).toHaveBeenCalledTimes(1)
  })

  it('surfaces a failed write as an error toast', async () => {
    const { edits } = setup()
    mocks.propertiesGet.mockResolvedValue([])
    mocks.propertiesSet.mockResolvedValue({ success: false, error: 'disk full' })

    await act(() => edits.linkNotes('note-a', 'note-b', labels))

    expect(mocks.toast.error).toHaveBeenCalledWith('disk full')
  })

  it('removes the target from every relation property and restores it on undo', async () => {
    const { edits } = setup()
    mocks.propertiesGet.mockResolvedValue(props({ related: [B], source: [B, 'memry://note/c'] }))

    await act(() => edits.unlinkNotes('note-a', 'note-b', labels))

    expect(mocks.propertiesSet).toHaveBeenCalledWith('note-a', {
      related: [],
      source: ['memry://note/c']
    })

    mocks.propertiesGet.mockResolvedValue(props({ related: [], source: ['memry://note/c'] }))
    await act(async () => {
      lastUndo()()
      await vi.waitFor(() => expect(mocks.propertiesSet).toHaveBeenCalledTimes(2))
    })
    expect(mocks.propertiesSet).toHaveBeenLastCalledWith('note-a', {
      related: [B],
      source: ['memry://note/c', B]
    })
  })

  it('adds a tag through notes:update and removes it on undo', async () => {
    const { edits } = setup()
    mocks.notesGet.mockResolvedValue({ id: 'note-a', title: 'Alpha', tags: ['work'] })

    await act(() => edits.addTag('note-a', 'reading'))
    expect(mocks.updateNote).toHaveBeenCalledWith({ id: 'note-a', tags: ['work', 'reading'] })

    mocks.notesGet.mockResolvedValue({ id: 'note-a', title: 'Alpha', tags: ['work', 'reading'] })
    await act(async () => {
      lastUndo()()
      await vi.waitFor(() => expect(mocks.updateNote).toHaveBeenCalledTimes(2))
    })
    expect(mocks.updateNote).toHaveBeenLastCalledWith({ id: 'note-a', tags: ['work'] })
  })

  it('does not write or toast when the unlink target is not in any relation', async () => {
    const { edits } = setup()
    mocks.propertiesGet.mockResolvedValue(props({ related: ['memry://note/c'] }))

    await act(() => edits.unlinkNotes('note-a', 'note-b', labels))

    expect(mocks.propertiesSet).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('reports failed unlink, tag and undo writes as error toasts', async () => {
    const { edits } = setup()

    mocks.propertiesGet.mockRejectedValueOnce(new Error('read failed'))
    await act(() => edits.unlinkNotes('note-a', 'note-b', labels))
    expect(mocks.toast.error).toHaveBeenLastCalledWith('read failed')

    mocks.notesGet.mockResolvedValueOnce(null)
    await act(() => edits.addTag('note-a', 'reading'))
    expect(mocks.toast.error).toHaveBeenLastCalledWith('Note not found')

    mocks.notesGet.mockResolvedValueOnce({ id: 'note-a', title: 'Alpha', tags: [] })
    mocks.updateNote.mockResolvedValueOnce({ success: false, note: null, error: 'locked' })
    await act(() => edits.addTag('note-a', 'reading'))
    expect(mocks.toast.error).toHaveBeenLastCalledWith('locked')

    // A link that lands, then an undo whose re-read fails.
    mocks.propertiesGet.mockResolvedValueOnce([])
    await act(() => edits.linkNotes('note-a', 'note-b', labels))
    mocks.propertiesGet.mockRejectedValueOnce(new Error('undo read failed'))
    await act(async () => {
      lastUndo()()
      await vi.waitFor(() => expect(mocks.toast.error).toHaveBeenLastCalledWith('undo read failed'))
    })
    expect(mocks.propertiesSet).toHaveBeenCalledTimes(1)
  })

  it('skips the undo write when the edit was already reverted elsewhere', async () => {
    const { edits } = setup()
    mocks.propertiesGet.mockResolvedValueOnce([])
    await act(() => edits.linkNotes('note-a', 'note-b', labels))

    mocks.propertiesGet.mockResolvedValueOnce(props({ related: [] }))
    await act(async () => {
      lastUndo()()
      await vi.waitFor(() => expect(mocks.propertiesGet).toHaveBeenCalledTimes(2))
    })
    expect(mocks.propertiesSet).toHaveBeenCalledTimes(1)

    mocks.notesGet.mockResolvedValueOnce({ id: 'note-a', title: 'Alpha', tags: [] })
    await act(() => edits.addTag('note-a', 'reading'))
    mocks.notesGet.mockResolvedValueOnce({ id: 'note-a', title: 'Alpha', tags: [] })
    await act(async () => {
      lastUndo()()
      await vi.waitFor(() => expect(mocks.notesGet).toHaveBeenCalledTimes(2))
    })
    expect(mocks.updateNote).toHaveBeenCalledTimes(1)
  })

  it('skips a tag the note already has, ignoring case', async () => {
    const { edits } = setup()
    mocks.notesGet.mockResolvedValue({ id: 'note-a', title: 'Alpha', tags: ['Reading'] })

    await act(() => edits.addTag('note-a', 'reading'))

    expect(mocks.updateNote).not.toHaveBeenCalled()
  })
})
