// A Tauri listener goes live only when main answers the page's `listen` call, and main delivers
// an event only to the listeners it knows of then. A page that read before its listeners went
// live missed what changed in between (#4270): these tests hold the `listen` answers back, as a
// busy main thread does, through the real hooks, services, generated bindings and
// `subscribeToEvent`.
import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNoteBody } from '@/pages/note/use-note-body'
import { useJournalEntry } from './use-journal-entry'
import { useNotesList } from './use-notes-query'

type Handler = (event: { payload: unknown }) => void

const tauri = vi.hoisted(() => {
  const live = new Map<string, Handler[]>()
  const pending: Array<{ name: string; register: () => void }> = []
  return {
    live,
    pending,
    notes: [] as Array<Record<string, unknown>>,
    note: null as Record<string, unknown> | null,
    day: null as Record<string, unknown> | null,
    /** A note read waits for this before it answers. */
    noteRead: Promise.resolve(),
    /** The saves main was asked for; none of them answers. */
    updates: [] as Array<Record<string, unknown>>,
    /** Main's emit: only the listeners it has registered hear it. */
    emit(name: string, payload: unknown) {
      for (const handler of live.get(name) ?? []) handler({ payload })
    },
    /** Main answers the `listen` calls it was holding, of `names` alone when given. */
    goLive(names?: string[]) {
      for (const call of pending.filter((held) => !names || names.includes(held.name))) {
        pending.splice(pending.indexOf(call), 1)
        call.register()
      }
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
  invoke: async (command: string, args?: { input?: Record<string, unknown> }) => {
    switch (command) {
      case 'notes_update':
        tauri.updates.push(args?.input ?? {})
        return new Promise(() => undefined)
      case 'notes_list':
        return { notes: tauri.notes, total: tauri.notes.length, hasMore: false }
      case 'notes_get': {
        // Main reads the file now and answers when `noteRead` lets it.
        const read = tauri.note
        await tauri.noteRead
        return read
      }
      case 'journal_get_entry':
        return tauri.day
      case 'vault_locks_list':
        return { notes: [], folders: [] }
      default:
        throw new Error(`unexpected command ${command}`)
    }
  },
  Channel: vi.fn()
}))

vi.mock('@/services/templates-service', () => ({ getTemplate: vi.fn() }))

const listItem = (id: string, title: string) => ({
  id,
  path: `${title}.md`,
  title,
  created: 0,
  modified: 0,
  tags: [],
  emoji: null,
  localOnly: false,
  fileType: 'markdown'
})

const noteView = (content: string) => ({
  id: 'n1',
  path: 'notes/Outside.md',
  title: 'Outside',
  content,
  frontmatter: {},
  created: 0,
  modified: 0,
  tags: [],
  headerTags: [],
  aliases: [],
  wordCount: 1,
  properties: {},
  emoji: null,
  localOnly: false,
  sizeClass: 'normal',
  largeFile: null,
  contentOmitted: false
})

const DAY = '2026-05-10'
const dayView = (content: string) => ({
  id: `j-${DAY}`,
  date: DAY,
  content,
  wordCount: 1,
  characterCount: content.length,
  tags: [],
  aliases: [],
  properties: null,
  createdAt: '2026-05-10T08:00:00.000Z',
  modifiedAt: '2026-05-10T08:00:00.000Z'
})

describe('a change made before the page listens', () => {
  let queryClient: QueryClient
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  beforeEach(() => {
    tauri.live.clear()
    tauri.pending.length = 0
    tauri.noteRead = Promise.resolve()
    tauri.updates.length = 0
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  it('an outside edit of the open note reaches its editor once the note listens', async () => {
    tauri.note = noteView('Written in the app')
    const { result } = renderHook(
      () => useNoteBody('n1', { surface: 'note-page', showVersionHistory: () => undefined }),
      { wrapper }
    )
    await waitFor(() => expect(result.current.content).toBe('Written in the app'))

    tauri.note = noteView('Rewritten by another program')
    tauri.emit('note-updated-event', {
      id: 'n1',
      changes: { content: 'Rewritten by another program' },
      source: 'external'
    })
    await act(async () => tauri.goLive())

    await waitFor(() => expect(result.current.content).toBe('Rewritten by another program'))
    expect(result.current.revision).toBe(1)
  })

  it('a note that listens before its first read answers takes the edit that read missed', async () => {
    tauri.note = noteView('Written in the app')
    let answer: () => void = () => undefined
    tauri.noteRead = new Promise((resolve) => (answer = resolve))
    const { result } = renderHook(
      () => useNoteBody('n1', { surface: 'note-page', showVersionHistory: () => undefined }),
      { wrapper }
    )
    // The read saw the file before the edit, whose event went to nobody.
    tauri.note = noteView('Rewritten by another program')
    tauri.noteRead = Promise.resolve()
    await act(async () => tauri.goLive())
    expect(result.current.revision).toBe(0)

    await act(async () => answer())
    await waitFor(() => expect(result.current.content).toBe('Rewritten by another program'))
    expect(result.current.revision).toBe(1)
  })

  it('the read the listeners ask for does not tell a save in flight that it went over unseen text', async () => {
    tauri.note = noteView('Written in the app')
    const { result } = renderHook(
      () => useNoteBody('n1', { surface: 'note-page', showVersionHistory: () => undefined }),
      { wrapper }
    )
    await waitFor(() => expect(result.current.content).toBe('Written in the app'))

    // A save of the typing is in flight when main answers the page's `listen` calls.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    act(() => result.current.onMarkdownChange('First typing'))
    await act(async () => void (await vi.advanceTimersByTimeAsync(1500)))
    vi.useRealTimers()
    await waitFor(() => expect(tauri.updates).toHaveLength(1))
    await act(async () => tauri.goLive())

    // The save that follows while the first still runs is no replacement of a text never shown.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    act(() => result.current.onMarkdownChange('Second typing'))
    await act(async () => void (await vi.advanceTimersByTimeAsync(1500)))
    vi.useRealTimers()
    await waitFor(() => expect(tauri.updates).toHaveLength(2))
    expect(tauri.updates[1]).toMatchObject({ content: 'Second typing' })
    expect(tauri.updates[1].keepReplaced).toBeFalsy()
  })

  it('an outside edit of the open day reaches its editor once the day listens', async () => {
    tauri.day = dayView('Written in the app.')
    const { result } = renderHook(() => useJournalEntry(DAY), { wrapper })
    await waitFor(() => expect(result.current.loadedForDate).toBe(DAY))
    await waitFor(() => expect(result.current.entry?.content).toBe('Written in the app.'))

    tauri.day = dayView('Rewritten outside.')
    tauri.emit('journal-entry-updated-event', {
      date: DAY,
      entry: dayView('Rewritten outside.'),
      source: 'external'
    })
    await act(async () => tauri.goLive())

    await waitFor(() => expect(result.current.externalUpdateCount).toBe(1))
    expect(result.current.entry?.content).toBe('Rewritten outside.')
  })

  it('a note renamed after one of the list listeners went live is listed by its new title', async () => {
    tauri.notes = [listItem('first', 'First')]
    const { result } = renderHook(() => useNotesList({ fields: 'tree' }), { wrapper })
    await waitFor(() => expect(result.current.notes.map((note) => note.title)).toEqual(['First']))

    // The created listener answers first, and the list is read again then; the rename comes
    // before the rest answer.
    await act(async () => tauri.goLive(['note-created-event']))
    tauri.notes = [listItem('first', 'Renamed')]
    tauri.emit('note-renamed-event', { id: 'first', oldPath: 'First.md', newPath: 'Renamed.md' })
    await act(async () => tauri.goLive())

    await waitFor(() => expect(result.current.notes.map((note) => note.title)).toEqual(['Renamed']))
  })
})
