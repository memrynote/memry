import type { MockRouteMap } from './types'
import { mockId, mockTimestamp } from './types'

// Mock note shape matches the fields the renderer actually reads (`content`,
// `title`, `properties`, timestamps). M5 replaces this file with real Rust
// commands returning the full `NotesRpc.Note` contract; until then, this is
// the smallest surface that keeps the ported UI happy (editor, list view,
// journal drawer, graph, search previews).
interface MockNote {
  id: string
  title: string
  path: string
  content: string
  folderId: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  properties: Record<string, unknown>
}

const notes: MockNote[] = [
  {
    id: 'note-1',
    title: 'Welcome to Memry (Tauri)',
    content: 'This is a mock note for M1 visual parity.',
    folderId: 'folder-1',
    createdAt: mockTimestamp(7),
    updatedAt: mockTimestamp(1),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-2',
    title: 'Second note',
    content: 'Mock note body with **bold** and *italic*.',
    folderId: 'folder-1',
    createdAt: mockTimestamp(6),
    updatedAt: mockTimestamp(2),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-3',
    title: 'Daily journal entry',
    content: '## Today\n- Task one\n- Task two',
    folderId: 'folder-1',
    createdAt: mockTimestamp(5),
    updatedAt: mockTimestamp(0),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-4',
    title: 'Ideas list',
    content: 'Random brainstorm of mock content.',
    folderId: 'folder-2',
    createdAt: mockTimestamp(4),
    updatedAt: mockTimestamp(0),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-5',
    title: 'Travel plans',
    content: 'Check destinations and dates.',
    folderId: 'folder-2',
    createdAt: mockTimestamp(3),
    updatedAt: mockTimestamp(0),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-6',
    title: 'Reading notes',
    content: 'Book highlights.',
    folderId: 'folder-2',
    createdAt: mockTimestamp(2),
    updatedAt: mockTimestamp(0),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-7',
    title: 'Archive draft',
    content: 'Older content.',
    folderId: 'folder-3',
    createdAt: mockTimestamp(30),
    updatedAt: mockTimestamp(29),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-8',
    title: 'Meeting notes 2026-03-18',
    content: 'Mock meeting summary.',
    folderId: 'folder-3',
    createdAt: mockTimestamp(25),
    updatedAt: mockTimestamp(25),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-9',
    title: 'Project Alpha overview',
    content: 'Mock project details.',
    folderId: 'folder-3',
    createdAt: mockTimestamp(20),
    updatedAt: mockTimestamp(10),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-10',
    title: 'Untitled note',
    content: '',
    folderId: null,
    createdAt: mockTimestamp(1),
    updatedAt: mockTimestamp(1),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-11',
    title: 'Untitled note 2',
    content: '',
    folderId: null,
    createdAt: mockTimestamp(0),
    updatedAt: mockTimestamp(0),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-12',
    title: 'Türkçe başlık testi',
    content: 'Türkçe karakter testi için örnek not — şıkğüöç.',
    folderId: 'folder-1',
    createdAt: mockTimestamp(0),
    updatedAt: mockTimestamp(0),
    deletedAt: null,
    properties: {}
  }
].map((n) => ({
  ...n,
  // Derive a path the renderer's NotesTree can split on — real backend will
  // return the actual vault-relative path per note.
  path: `${n.folderId ?? 'inbox'}/${n.title.replace(/\s+/g, '-').toLowerCase()}.md`
})) as MockNote[]

/**
 * Transform an internal MockNote into the NoteListItem contract shape the
 * renderer expects: Date objects for created/modified, tags array, wordCount.
 * Keeps notes[] above as the internal mutable state; this is the serialized
 * form sent over the mock IPC boundary.
 */
function toListItem(n: MockNote): Record<string, unknown> {
  return {
    id: n.id,
    path: n.path,
    title: n.title,
    created: new Date(n.createdAt),
    modified: new Date(n.updatedAt),
    tags: [],
    wordCount: n.content.split(/\s+/).filter(Boolean).length,
    snippet: n.content.slice(0, 200),
    emoji: null,
    localOnly: false
  }
}

export const notesRoutes: MockRouteMap = {
  // Contract: NoteListResponse = { notes, total, hasMore }
  notes_list: async () => {
    const active = notes.filter((n) => n.deletedAt === null).map(toListItem)
    return { notes: active, total: active.length, hasMore: false }
  },
  notes_list_by_folder: async (args) => {
    const { folderId } = (args as { folderId: string }) ?? { folderId: '' }
    const active = notes
      .filter((n) => n.folderId === folderId && n.deletedAt === null)
      .map(toListItem)
    return { notes: active, total: active.length, hasMore: false }
  },
  notes_get_all_positions: async () => ({ success: true, positions: {} as Record<string, number> }),
  notes_get_positions: async () => ({ success: true, positions: {} as Record<string, number> }),
  // Contract: FolderInfo[] = { path, icon? }[]
  notes_get_folders: async () => [
    { path: 'Inbox', icon: 'inbox' },
    { path: 'Projects', icon: 'folder' },
    { path: 'Archive', icon: 'archive' }
  ],
  notes_get_folder_config: async () => null,
  notes_set_folder_config: async () => ({ success: true }),
  notes_get_local_only_count: async () => ({ count: 0 }),
  notes_get_tags: async () => [],
  notes_get_property_definitions: async () => [],
  notes_get: async (args) => {
    const { id } = args as { id: string }
    const note = notes.find((n) => n.id === id)
    if (!note) throw new Error(`Note ${id} not found`)
    return note
  },
  notes_create: async (args) => {
    const input = (args as Partial<MockNote>) ?? {}
    const now = Date.now()
    const title = input.title ?? 'Untitled'
    const folderId = input.folderId ?? null
    const note: MockNote = {
      id: mockId('note'),
      title,
      path:
        input.path ?? `${folderId ?? 'inbox'}/${title.replace(/\s+/g, '-').toLowerCase()}.md`,
      content: input.content ?? '',
      folderId: input.folderId ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      properties: input.properties ?? {}
    }
    notes.unshift(note)
    // Wrapped in NoteCreateResponse so App.handleNewNote()'s
    // `result.success && result.note` guard lets the new note open.
    return { success: true, note }
  },
  notes_update: async (args) => {
    const { id, ...changes } = args as { id: string } & Partial<MockNote>
    const note = notes.find((n) => n.id === id)
    if (!note) throw new Error(`Note ${id} not found`)
    Object.assign(note, changes, { updatedAt: Date.now() })
    return { success: true, note }
  },
  notes_delete: async (args) => {
    const { id } = args as { id: string }
    const note = notes.find((n) => n.id === id)
    if (!note) return { success: false }
    note.deletedAt = Date.now()
    return { success: true }
  }
}
