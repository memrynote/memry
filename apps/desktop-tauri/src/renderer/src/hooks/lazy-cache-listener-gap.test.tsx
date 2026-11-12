// The caches a page opens on demand read once they mount and listen from then on. A Tauri listener
// goes live only when main answers the page's `listen` call, and main delivers an event only to
// the listeners it knows of then, so a change between the read and that answer reached nobody
// and the cache kept the old answer (#4278). These tests hold the `listen` answers back, as a busy
// main thread does, through the real hooks, services, generated bindings and `subscribeToEvent`.
import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hydrateWikiLinkCard } from '@/components/note/content-area/wiki-link-card-data'
import { usePortalSourceNote } from '@/components/note/content-area/portal/use-portal-source-note'
import { useLinkedHere } from '@/features/tag-fields/use-linked-here'
import { useCanvasEntities } from '@/pages/canvas/use-canvas-entities'
import { useFolderView } from './use-folder-view'
import { useGraphData, useGraphReactivity } from './use-graph-data'
import { useNoteMetadataEvents } from './use-note-metadata-events'
import { useNoteLinksQuery } from './use-notes-query'
import { useTags } from './use-tags'

type Handler = (event: { payload: unknown }) => void

const tauri = vi.hoisted(() => {
  const live = new Map<string, Handler[]>()
  const pending: Array<{ name: string; register: () => void }> = []
  /** What main answers each command with, as the vault reads now. */
  const answers: Record<string, unknown> = {}
  return {
    live,
    pending,
    answers,
    /** Main's emit: only the listeners it has registered hear it. */
    emit(name: string, payload: unknown) {
      for (const handler of live.get(name) ?? []) handler({ payload })
    },
    /** Main answers every `listen` call it was holding. */
    goLive() {
      for (const call of pending.splice(0)) call.register()
    }
  }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, handler: Handler) =>
    new Promise<() => void>((resolve) => {
      tauri.pending.push({
        name,
        register: () => {
          tauri.live.set(name, [...(tauri.live.get(name) ?? []), handler])
          resolve(() => undefined)
        }
      })
    }),
  once: vi.fn(),
  emit: vi.fn(),
  emitTo: vi.fn()
}))

// tests/setup-dom.ts replaces the bindings for component tests; these run the generated ones
// over the Tauri API above and below.
vi.mock('../../../generated/bindings', async (importActual) => await importActual())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (!(command in tauri.answers)) throw new Error(`unexpected command ${command}`)
    return tauri.answers[command]
  },
  Channel: vi.fn()
}))

// The graph and the folder view still read through `window.api` (not ported yet).
const windowApi = window.api as unknown as Record<string, Record<string, unknown>>

const noteView = (title: string) => ({
  id: 'n1',
  path: `notes/${title}.md`,
  title,
  content: `${title} body`,
  frontmatter: {},
  created: 0,
  modified: 0,
  tags: [],
  headerTags: [],
  aliases: [],
  wordCount: 2,
  properties: {},
  emoji: null,
  localOnly: false,
  sizeClass: 'normal',
  largeFile: null,
  contentOmitted: false
})

const mention = (title: string) => ({
  groups: [
    {
      kind: 'mentions',
      total: 1,
      items: [{ noteId: 'n2', title, date: null, snippet: null }]
    }
  ]
})

const tagRow = (name: string) => ({
  name,
  count: 1,
  color: '',
  icon: null,
  categoryId: null,
  sortOrder: 0
})

const preview = (description: string) => ({
  id: 'n1',
  title: 'Target',
  emoji: null,
  snippet: null,
  tags: [],
  createdAt: '2026-05-10T08:00:00.000Z',
  matchedName: null,
  path: 'notes/Target.md',
  cover: null,
  description,
  body: null
})

describe('a change made before an on-demand cache listens', () => {
  let queryClient: QueryClient
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  beforeEach(() => {
    tauri.live.clear()
    tauri.pending.length = 0
    tauri.answers = { vault_locks_list: { notes: [], folders: [] } }
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  it('a note linked to the open note shows in its links', async () => {
    tauri.answers.notes_get_links = { outgoing: [], incoming: [] }
    const { result } = renderHook(() => useNoteLinksQuery('n1'), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const backlink = { sourceId: 'n2', sourceTitle: 'Linker', contexts: [] }
    tauri.answers.notes_get_links = { outgoing: [], incoming: [backlink] }
    tauri.emit('note-links-changed-event', { sourceIds: ['n2'], targetIds: ['n1'] })
    await act(async () => tauri.goLive())

    await waitFor(() => expect(result.current.incoming).toEqual([backlink]))
  })

  it('the graph shows a note made while it opened', async () => {
    let graph = { nodes: [], edges: [] }
    windowApi.graph = { getData: vi.fn(async () => graph) }
    const { result } = renderHook(
      () => {
        useGraphReactivity()
        return useGraphData()
      },
      { wrapper }
    )
    await waitFor(() => expect(result.current.data).toEqual({ nodes: [], edges: [] }))

    graph = { nodes: [{ id: 'n1' }], edges: [] } as unknown as typeof graph
    tauri.emit('note-created-event', { note: noteView('Made'), source: 'internal' })
    await act(async () => tauri.goLive())

    await waitFor(() => expect(result.current.data).toEqual(graph))
  })

  it('a link card shows the description its note was given while the card loaded', async () => {
    tauri.answers.vault_get_status = { revision: 0, path: '/vault' }
    tauri.answers.notes_preview_by_title = preview('Before')
    const chip = document.createElement('span')
    chip.className = 'wiki-link'
    chip.setAttribute('data-wiki-link-card', '')
    chip.setAttribute('data-target', 'Target')
    document.body.append(chip)
    const fill = vi.fn()
    await hydrateWikiLinkCard(chip, fill)
    expect(fill).toHaveBeenLastCalledWith(chip, expect.objectContaining({ text: 'Before' }))

    tauri.answers.notes_preview_by_title = preview('After')
    tauri.emit('note-updated-event', { id: 'n1', changes: {}, source: 'external' })
    await act(async () => tauri.goLive())

    await waitFor(() =>
      expect(fill).toHaveBeenLastCalledWith(chip, expect.objectContaining({ text: 'After' }))
    )
    chip.remove()
  })

  it('a portal stops showing a source note deleted while it opened', async () => {
    tauri.answers.notes_get = noteView('Source')
    const { result } = renderHook(() => usePortalSourceNote('n1'), { wrapper })
    await waitFor(() => expect(result.current.note?.title).toBe('Source'))

    tauri.answers.notes_get = null
    tauri.emit('note-deleted-event', { id: 'n1', path: 'notes/Source.md', source: 'external' })
    await act(async () => tauri.goLive())

    await waitFor(() => expect(result.current.note).toBeNull())
  })

  it('a canvas card shows the title its note was given while the canvas opened', async () => {
    tauri.answers.notes_get = noteView('Before')
    const refs = [
      {
        entityType: 'note',
        entityId: 'n1',
        elementId: 'e1',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        angle: 0
      }
    ] as Parameters<typeof useCanvasEntities>[0]
    const { result } = renderHook(() => useCanvasEntities(refs), { wrapper })
    await waitFor(() => expect(result.current.get('note:n1')).toMatchObject({ title: 'Before' }))

    tauri.answers.notes_get = noteView('After')
    tauri.emit('note-renamed-event', {
      id: 'n1',
      oldPath: 'notes/Before.md',
      newPath: 'notes/After.md'
    })
    await act(async () => tauri.goLive())

    await waitFor(() => expect(result.current.get('note:n1')).toMatchObject({ title: 'After' }))
  })

  it('what links here shows a note that started linking while it opened', async () => {
    tauri.answers.tags_get_linked_here = mention('Before')
    const { result } = renderHook(() => useLinkedHere('n1', 5), { wrapper })
    await waitFor(() => expect(result.current.groups).toEqual(mention('Before').groups))

    tauri.answers.tags_get_linked_here = mention('After')
    tauri.emit('note-links-changed-event', { sourceIds: ['n2'], targetIds: ['n1'] })
    await act(async () => tauri.goLive())

    await waitFor(() => expect(result.current.groups).toEqual(mention('After').groups))
  })

  it('a tag list opened after startup shows a tag added while it opened', async () => {
    tauri.answers.tags_get_all_with_counts = [tagRow('work')]
    renderHook(() => useNoteMetadataEvents(), { wrapper })
    await act(async () => tauri.goLive())

    // The tag manager opens long after the app's listeners went live.
    const { result } = renderHook(() => useTags(), { wrapper })
    await waitFor(() => expect(result.current.tags.map((tag) => tag.name)).toEqual(['work']))

    tauri.answers.tags_get_all_with_counts = [tagRow('work'), tagRow('home')]
    tauri.emit('note-tags-changed-event', null)
    await act(async () => tauri.goLive())

    await waitFor(() =>
      expect(result.current.tags.map((tag) => tag.name)).toEqual(['work', 'home'])
    )
  })

  it("a tag's view shows a note pinned while it opened", async () => {
    let notes = [{ id: 'a', title: 'A', path: 'A.md', properties: {} }]
    windowApi.folderView = {
      getViews: vi.fn(async () => ({ views: [], defaultIndex: 0 })),
      getAvailableProperties: vi.fn(async () => ({ properties: [], builtIn: [], formulas: [] })),
      listWithProperties: vi.fn(async () => ({ notes, hasMore: false, total: notes.length }))
    }
    const { result } = renderHook(() => useFolderView({ scope: { kind: 'tag', tag: 'work' } }), {
      wrapper
    })
    await waitFor(() => expect(result.current.totalNotes).toBe(1))

    notes = [...notes, { id: 'b', title: 'B', path: 'B.md', properties: {} }]
    tauri.emit('tag-notes-changed-event', { tag: 'Work', noteId: 'b', action: 'pinned' })
    await act(async () => tauri.goLive())

    await waitFor(() => expect(result.current.totalNotes).toBe(2))
  })
})
