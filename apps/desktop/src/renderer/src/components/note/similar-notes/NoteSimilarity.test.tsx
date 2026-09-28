import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  similar: [] as unknown[],
  tagSuggestions: [] as unknown[],
  spatialCanvas: true,
  openTab: vi.fn(),
  mutateAsync: vi.fn(),
  addItemsToCanvas: vi.fn(),
  listCanvases: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const subject = values?.title ?? values?.tag
      return subject === undefined ? key : `${key}:${String(subject)}`
    }
  })
}))
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, info: mocks.toastInfo, error: mocks.toastError }
}))
vi.mock('@/hooks/use-note-similarity', () => ({
  useSimilarNotes: () => mocks.similar,
  useTagSuggestions: (_id: string, { enabled }: { enabled: boolean }) =>
    enabled ? mocks.tagSuggestions : []
}))
vi.mock('@/hooks/use-feature-flags', () => ({
  useFeatureFlags: () => ({ flags: { spatialCanvas: mocks.spatialCanvas } })
}))
vi.mock('@/contexts/tabs', () => ({ useTabs: () => ({ openTab: mocks.openTab }) }))
vi.mock('@/hooks/use-notes-query', () => ({
  useNoteMutations: () => ({ updateNote: { mutateAsync: mocks.mutateAsync } })
}))
vi.mock('@/pages/canvas/canvas-write', () => ({ addItemsToCanvas: mocks.addItemsToCanvas }))
vi.mock('@/services/canvas-service', () => ({ canvasService: { list: mocks.listCanvases } }))
vi.mock('@/components/note/content-area/wiki-link', () => ({
  createWikiLinkInlineContent: (target: string) => ({ type: 'wikiLink', props: { target } })
}))

import { NoteSimilarNotes, NoteSuggestedTags } from './NoteSimilarity'

const similar = { id: 'b', title: 'B', path: 'b.md', emoji: null, snippet: null, similarity: 0.8 }

function editorWith(document: Array<{ id: string; type: string; content?: unknown }>) {
  return { document, insertBlocks: vi.fn(), updateBlock: vi.fn() }
}

const renderNotes = (props: Partial<Parameters<typeof NoteSimilarNotes>[0]> = {}) =>
  render(
    <NoteSimilarNotes
      noteId="a"
      getEditor={() => null}
      largeFile={false}
      reviewing={false}
      deleted={false}
      openLinked={vi.fn()}
      {...props}
    />
  )

describe('NoteSimilarNotes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.similar = [similar]
    mocks.spatialCanvas = true
  })

  it('appends a link after the last block, reusing a trailing empty paragraph', async () => {
    const user = userEvent.setup()
    const filled = editorWith([{ id: 'p1', type: 'paragraph', content: ['text'] }])
    const { unmount } = renderNotes({ getEditor: () => filled })
    await user.click(screen.getByRole('button', { name: 'similarNotes.addLinkAria:B' }))
    expect(filled.insertBlocks).toHaveBeenCalledWith(
      [{ type: 'paragraph', content: [{ type: 'wikiLink', props: { target: 'B' } }] }],
      'p1',
      'after'
    )
    expect(mocks.toastSuccess).toHaveBeenCalledWith('similarNotes.linked:B')
    unmount()

    const trailing = editorWith([{ id: 'p2', type: 'paragraph', content: [] }])
    renderNotes({ getEditor: () => trailing })
    await user.click(screen.getByRole('button', { name: 'similarNotes.addLinkAria:B' }))
    expect(trailing.updateBlock).toHaveBeenCalledWith('p2', {
      type: 'paragraph',
      content: [{ type: 'wikiLink', props: { target: 'B' } }]
    })
    expect(trailing.insertBlocks).not.toHaveBeenCalled()
  })

  it('offers no link without a live editor and no canvas with canvases off', () => {
    mocks.spatialCanvas = false
    renderNotes({ reviewing: true })
    expect(screen.queryByRole('button', { name: /addLinkAria/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /addToCanvasAria/ })).not.toBeInTheDocument()
  })

  it('opens a similar note as a note tab', async () => {
    const openLinked = vi.fn()
    renderNotes({ openLinked })
    await userEvent.click(screen.getByText('B'))
    expect(openLinked).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', entityId: 'b', path: '/notes/b' })
    )
  })

  it('adds to a canvas and reports a note that is already there', async () => {
    const user = userEvent.setup()
    mocks.listCanvases.mockResolvedValue({
      canvases: [{ id: 'c1', title: 'Board', ownerNoteId: null }]
    })
    mocks.addItemsToCanvas.mockResolvedValueOnce({
      mutation: { applied: [{ entityType: 'note', entityId: 'b' }] }
    })
    renderNotes()

    await user.click(screen.getByRole('button', { name: 'similarNotes.addToCanvasAria:B' }))
    await user.click(await screen.findByText('Board'))
    await waitFor(() =>
      expect(mocks.addItemsToCanvas).toHaveBeenCalledWith('c1', [
        { entityType: 'note', entityId: 'b' }
      ])
    )
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'similarNotes.addedToCanvas:B',
      expect.objectContaining({ action: expect.anything() })
    )

    mocks.addItemsToCanvas.mockResolvedValueOnce({ mutation: { applied: [] } })
    await user.click(screen.getByRole('button', { name: 'similarNotes.addToCanvasAria:B' }))
    await user.click(await screen.findByText('Board'))
    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledWith('similarNotes.alreadyOnCanvas:B')
    )
  })
})

describe('NoteSuggestedTags', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tagSuggestions = [{ tag: 'sleep', confidence: 0.6, support: 2 }]
  })

  it('adds a picked tag through the note update path', async () => {
    mocks.mutateAsync.mockResolvedValue({ success: true })
    render(<NoteSuggestedTags noteId="a" tags={[]} disabled={false} />)
    await userEvent.click(screen.getByRole('button', { name: 'suggestedTags.acceptAria:sleep' }))
    expect(mocks.mutateAsync).toHaveBeenCalledWith({ id: 'a', tags: ['sleep'] })
  })

  it('hides for tagged notes and once dismissed', async () => {
    const { unmount } = render(<NoteSuggestedTags noteId="a" tags={['x']} disabled={false} />)
    expect(screen.queryByTestId('suggested-tags')).not.toBeInTheDocument()
    unmount()

    render(<NoteSuggestedTags noteId="a" tags={[]} disabled={false} />)
    await userEvent.click(screen.getByRole('button', { name: 'suggestedTags.dismiss' }))
    expect(screen.queryByTestId('suggested-tags')).not.toBeInTheDocument()
  })

  it('surfaces a failed write', async () => {
    mocks.mutateAsync.mockRejectedValue(new Error('nope'))
    render(<NoteSuggestedTags noteId="a" tags={[]} disabled={false} />)
    await userEvent.click(screen.getByRole('button', { name: 'suggestedTags.acceptAria:sleep' }))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled())
  })
})
