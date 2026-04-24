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
]

export const notesRoutes: MockRouteMap = {
  notes_list: async () => notes.filter((n) => n.deletedAt === null),
  notes_list_by_folder: async (args) => {
    const { folderId } = (args as { folderId: string }) ?? { folderId: '' }
    return notes.filter((n) => n.folderId === folderId && n.deletedAt === null)
  },
  notes_get: async (args) => {
    const { id } = args as { id: string }
    const note = notes.find((n) => n.id === id)
    if (!note) throw new Error(`Note ${id} not found`)
    return note
  },
  notes_create: async (args) => {
    const input = (args as Partial<MockNote>) ?? {}
    const now = Date.now()
    const note: MockNote = {
      id: mockId('note'),
      title: input.title ?? 'Untitled',
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
