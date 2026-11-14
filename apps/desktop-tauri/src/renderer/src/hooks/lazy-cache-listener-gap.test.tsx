// The caches a page opens on demand read once they mount and listen from then on. A Tauri listener
// goes live only when main answers the page's `listen` call, and main delivers an event only to
// the listeners it knows of then, so a change between the read and that answer reached nobody
// and the cache kept the old answer (#4278). These tests hold the `listen` answers back, as a busy
// main thread does, through the real hooks, services, generated bindings and `subscribeToEvent`.
// Caches that mount many times (a canvas's cards, a page's portals) start their first read once the
// listeners are live instead, because `notes_get` counts one `note_opened` per read.
import type { ReactNode } from 'react'
import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import type { Transaction } from '@tiptap/pm/state'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCanvasLookupCache } from '@/lib/canvas-lookup'
import {
  WIKI_LINK_BROKEN_PLUGIN_KEY,
  createWikiLinkBrokenPlugin
} from '@/components/note/content-area/wiki-link-broken-plugin'
import { useWikiLinkBroken } from '@/components/note/content-area/hooks/use-wiki-link-broken'
import { useWikiLinkSuggestions } from '@/components/note/content-area/hooks/use-wiki-link-suggestions'
import { PortalInstanceContext } from '@/components/note/content-area/portal/portal-context'
import { PortalSearchView } from '@/components/note/content-area/portal/portal-search-view'
import { hydrateWikiLinkCard } from '@/components/note/content-area/wiki-link-card-data'
import { usePortalSourceNote } from '@/components/note/content-area/portal/use-portal-source-note'
import { useLinkedHere } from '@/features/tag-fields/use-linked-here'
import { useCanvasEntities } from '@/pages/canvas/use-canvas-entities'
import { useUnlinkedMentionsQuery } from './use-unlinked-mentions'
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
  /** Every command the page invoked, with its arguments. */
  const calls: Array<{ command: string; args: Record<string, unknown> }> = []
  return {
    live,
    pending,
    answers,
    calls,
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
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    tauri.calls.push({ command, args })
    if (!(command in tauri.answers)) throw new Error(`unexpected command ${command}`)
    const answer = tauri.answers[command]
    return typeof answer === 'function' ? answer(args) : answer
  },
  Channel: vi.fn()
}))

// The graph and the folder view still read through `window.api` (not ported yet).
const windowApi = window.api as unknown as Record<string, Record<string, unknown>>

const noteView = (title: string, id = 'n1') => ({
  id,
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

const countOf = (command: string) => tauri.calls.filter((call) => call.command === command).length

/** Lets a second read, if the code under test issues one, reach the mocked `invoke`. */
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)))

const searchItem = (text: string) => ({
  noteId: 'n1',
  title: 'Cell Biology',
  path: 'Cell Biology.md',
  blockId: 'b1',
  anchor: null,
  text,
  parentText: null
})

vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ openSidebarItem: vi.fn() })
}))

const wikiSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    wikiLink: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { target: { default: '' }, alias: { default: '' } },
      toDOM: () => ['span']
    },
    text: { group: 'inline' }
  }
})

/** An editor holding one `[[Target]]` link, as `use-wiki-link-broken` reads a mounted one. */
function editorWithLink(target: string) {
  const doc = wikiSchema.node('doc', null, [
    wikiSchema.node('paragraph', null, [wikiSchema.node('wikiLink', { target })])
  ])
  const view = {
    state: EditorState.create({ doc, plugins: [createWikiLinkBrokenPlugin()] }),
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr)
    }
  }
  return {
    view,
    editor: {
      _tiptapEditor: {
        view,
        editorView: view,
        on: vi.fn(),
        off: vi.fn(),
        registerPlugin: vi.fn(),
        unregisterPlugin: vi.fn()
      }
    }
  }
}

const brokenTargetsOf = (state: EditorState): string[] =>
  (WIKI_LINK_BROKEN_PLUGIN_KEY.getState(state)?.decorations?.find() ?? []).map((decoration) => {
    const target: unknown = state.doc.nodeAt(decoration.from)?.attrs.target
    return typeof target === 'string' ? target : ''
  })

describe('a change made before an on-demand cache listens', () => {
  let queryClient: QueryClient
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  beforeEach(() => {
    tauri.live.clear()
    tauri.pending.length = 0
    tauri.calls.length = 0
    clearCanvasLookupCache()
    tauri.answers = { vault_locks_list: { notes: [], folders: [] } }
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  it('a note linked to the open note shows in its links', async () => {
    tauri.answers.notes_get_links = { outgoing: [], incoming: [] }
    const { result } = renderHook(() => useNoteLinksQuery('n1'), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const backlink = {
      sourceId: 'n2',
      sourceTitle: 'Linker',
      sourceJournalDate: null,
      sourceTags: [],
      contexts: []
    }
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

  it('a portal stops showing a source note deleted while it opened, and read it once', async () => {
    tauri.answers.notes_get = noteView('Source')
    const { result } = renderHook(() => usePortalSourceNote('n1'), { wrapper })
    expect(result.current.isLoading).toBe(true)
    await settle()
    expect(countOf('notes_get')).toBe(0)

    tauri.answers.notes_get = null
    tauri.emit('note-deleted-event', { id: 'n1', path: 'notes/Source.md', source: 'external' })
    await act(async () => tauri.goLive())

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    await settle()
    expect(result.current.note).toBeNull()
    expect(countOf('notes_get')).toBe(1)
  })

  it('a canvas card shows the title its note was given while the canvas opened', async () => {
    const titles: Record<string, string> = { n1: 'Before', n2: 'Before', n3: 'Before' }
    tauri.answers.notes_get = ({ id }: { id: string }) => noteView(titles[id], id)
    const refs = ['n1', 'n2', 'n3'].map((entityId) => ({
      entityType: 'note',
      entityId,
      elementId: `e-${entityId}`,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      angle: 0
    })) as Parameters<typeof useCanvasEntities>[0]
    const { result } = renderHook(() => useCanvasEntities(refs), { wrapper })
    await settle()
    expect(countOf('notes_get')).toBe(0)

    for (const id of Object.keys(titles)) titles[id] = 'After'
    tauri.emit('note-renamed-event', {
      id: 'n1',
      oldPath: 'notes/Before.md',
      newPath: 'notes/After.md'
    })
    await act(async () => tauri.goLive())

    await waitFor(() => {
      for (const id of Object.keys(titles)) {
        expect(result.current.get(`note:${id}`)).toMatchObject({ title: 'After' })
      }
    })
    await settle()
    // `notes_get` counts one `note_opened` per read: one per card, not two.
    expect(
      tauri.calls.filter((call) => call.command === 'notes_get').map((call) => call.args.id)
    ).toEqual(['n1', 'n2', 'n3'])
  })

  it('a search portal shows a block written while it opened, and searched once', async () => {
    let results = [searchItem('Before')]
    const search = vi.fn(async (_input: unknown) => ({ results, truncated: false }))
    tauri.answers.portals_search = (args: { input: unknown }) => search(args.input)
    const target = { kind: 'search' as const, text: 'exam', tag: 'bio', limit: 50 }
    const editor = {
      isEditable: true,
      getBlock: () => undefined,
      updateBlock: () => {},
      removeBlocks: () => {}
    }
    render(
      <QueryClientProvider client={queryClient}>
        <PortalInstanceContext.Provider value="i1">
          <PortalSearchView
            blockId="p"
            editor={editor}
            definition={{ v: 1, target, raw: {} }}
            target={target}
          />
        </PortalInstanceContext.Provider>
      </QueryClientProvider>
    )
    await settle()
    expect(search).not.toHaveBeenCalled()

    results = [searchItem('After')]
    tauri.emit('note-updated-event', { id: 'n1', changes: {}, source: 'external' })
    await act(async () => tauri.goLive())

    expect(await screen.findByText('After')).toBeTruthy()
    await settle()
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('a note change runs each open search portal once, on its own query', async () => {
    const search = vi.fn(async (_input: unknown) => ({
      results: [searchItem('Hit')],
      truncated: false
    }))
    tauri.answers.portals_search = (args: { input: unknown }) => search(args.input)
    const editor = {
      isEditable: true,
      getBlock: () => undefined,
      updateBlock: () => {},
      removeBlocks: () => {}
    }
    const targets = ['exam', 'lab'].map((text) => ({
      kind: 'search' as const,
      text,
      tag: undefined,
      limit: 50
    }))
    render(
      <QueryClientProvider client={queryClient}>
        <PortalInstanceContext.Provider value="i1">
          {targets.map((target) => (
            <PortalSearchView
              key={target.text}
              blockId={target.text}
              editor={editor}
              definition={{ v: 1, target, raw: {} }}
              target={target}
            />
          ))}
        </PortalInstanceContext.Provider>
      </QueryClientProvider>
    )
    await act(async () => tauri.goLive())
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2))

    tauri.emit('note-updated-event', { id: 'n1', changes: {}, source: 'internal' })
    await waitFor(() => expect(search).toHaveBeenCalledTimes(4), { timeout: 3000 })
    await settle()
    const runsOf = (text: string) =>
      (search.mock.calls as unknown as Array<[{ text: string }]>).filter(
        ([input]) => input.text === text
      ).length
    expect([runsOf('exam'), runsOf('lab')]).toEqual([2, 2])
  })

  it('a link that stopped being broken while the editor opened is repainted', async () => {
    tauri.answers.notes_resolve_titles = { Target: null }
    windowApi.canvas = { list: vi.fn(async () => ({ canvases: [] })) }
    const { view, editor } = editorWithLink('Target')
    renderHook(() => useWikiLinkBroken(editor), { wrapper })
    await waitFor(() => expect(brokenTargetsOf(view.state)).toEqual(['Target']))

    tauri.answers.notes_resolve_titles = { Target: { id: 'n9', path: 'notes/Target.md' } }
    tauri.emit('note-created-event', { note: noteView('Target', 'n9'), source: 'internal' })
    await act(async () => tauri.goLive())

    await waitFor(() => expect(brokenTargetsOf(view.state)).toEqual([]))
  })

  it('link suggestions list a note made after the list they cached was read', async () => {
    windowApi.canvas = { list: vi.fn(async () => ({ canvases: [] })) }
    const row = (id: string, title: string) => ({
      id,
      path: `notes/${title}.md`,
      title,
      created: 0,
      modified: 0,
      tags: [],
      wordCount: 1,
      emoji: null,
      localOnly: false
    })
    tauri.answers.notes_list = { notes: [row('a', 'Alpha')], total: 1, hasMore: false }
    const { result } = renderHook(() => useWikiLinkSuggestions({ insertInlineContent: vi.fn() }), {
      wrapper
    })
    const titles = async () => (await result.current.getWikiLinkItems('')).map((item) => item.title)
    expect(await titles()).toEqual(['Alpha'])

    tauri.answers.notes_list = {
      notes: [row('a', 'Alpha'), row('b', 'Beta')],
      total: 2,
      hasMore: false
    }
    tauri.emit('note-links-changed-event', { sourceIds: ['b'], targetIds: ['a'] })
    await act(async () => tauri.goLive())

    expect(await titles()).toEqual(['Alpha', 'Beta'])
  })

  it('unlinked mentions show a note that began mentioning while the list loaded', async () => {
    const unlinked = (title: string) => [
      {
        sourceId: 'n2',
        sourcePath: 'notes/n2.md',
        sourceTitle: title,
        contexts: [],
        mentionCount: 1,
        truncated: false
      }
    ]
    tauri.answers.notes_get_unlinked_mentions = unlinked('Before')
    const { result } = renderHook(() => useUnlinkedMentionsQuery('n1', true), { wrapper })
    await waitFor(() => expect(result.current.mentions).toHaveLength(1))
    expect(result.current.mentions[0]).toMatchObject({ sourceTitle: 'Before' })

    tauri.answers.notes_get_unlinked_mentions = unlinked('After')
    tauri.emit('note-created-event', { note: noteView('After', 'n2'), source: 'internal' })
    await act(async () => tauri.goLive())

    await waitFor(() => expect(result.current.mentions[0]).toMatchObject({ sourceTitle: 'After' }))
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
