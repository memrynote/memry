// A Tauri listener goes live only when main answers the page's `listen` call, and main delivers
// an event to the listeners it knows of then. The sidebar's list read before that and a note made
// in between left the note out of the tree until the next note event (#3967): these tests hold
// the `listen` answer back, as a busy main thread does, through the real service and hook.
import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNoteFoldersQuery, useNotesList } from './use-notes-query'

type Handler = (event: { payload: unknown }) => void

const tauri = vi.hoisted(() => {
  const live = new Map<string, Handler[]>()
  const pending: Array<() => void> = []
  return {
    live,
    pending,
    notes: [] as Array<Record<string, unknown>>,
    folders: [] as Array<Record<string, unknown>>,
    /** Main's emit: only the listeners it has registered hear it. */
    emit(name: string, payload: unknown) {
      for (const handler of live.get(name) ?? []) handler({ payload })
    },
    /** Main answers every `listen` call it was holding. */
    goLive() {
      for (const register of pending.splice(0)) register()
    }
  }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, handler: Handler) =>
    new Promise<() => void>((resolve) => {
      tauri.pending.push(() => {
        tauri.live.set(name, [...(tauri.live.get(name) ?? []), handler])
        resolve(() => undefined)
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
    if (command === 'notes_list') {
      return { notes: tauri.notes, total: tauri.notes.length, hasMore: false }
    }
    if (command === 'notes_get_folders') return tauri.folders
    throw new Error(`unexpected command ${command}`)
  },
  Channel: vi.fn()
}))

const view = (id: string, path: string) => ({
  id,
  path,
  title: id,
  created: 0,
  modified: 0,
  tags: [],
  emoji: null,
  localOnly: false,
  fileType: 'markdown'
})

describe('a note made before the list listens', () => {
  let queryClient: QueryClient
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  beforeEach(() => {
    tauri.live.clear()
    tauri.pending.length = 0
    tauri.notes = [view('first', 'First.md')]
    tauri.folders = []
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  it('is listed once the listener goes live', async () => {
    const { result } = renderHook(() => useNotesList({ fields: 'tree' }), { wrapper })
    await waitFor(() => expect(result.current.notes.map((note) => note.id)).toEqual(['first']))

    const made = view('made', 'notes/made.md')
    tauri.notes = [made, ...tauri.notes]
    tauri.emit('note-created-event', { note: made, source: 'internal' })
    await act(async () => tauri.goLive())

    await waitFor(() =>
      expect(result.current.notes.map((note) => note.id)).toEqual(['made', 'first'])
    )
  })

  it('brings the folder it was made in into the folder list', async () => {
    const { result } = renderHook(() => useNoteFoldersQuery(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    tauri.folders = [{ path: 'notes', name: 'notes', count: 1 }]
    tauri.emit('note-created-event', { note: view('made', 'notes/made.md'), source: 'internal' })
    await act(async () => tauri.goLive())

    await waitFor(() =>
      expect(result.current.folders.map((folder) => folder.path)).toEqual(['notes'])
    )
  })
})
