import type { MockRouteMap } from './types'
import { mockId, mockTimestamp } from './types'

interface MockNote {
  id: string
  title: string
  body: string
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
    body: 'This is a mock note for M1 visual parity.',
    folderId: 'folder-1',
    createdAt: mockTimestamp(7),
    updatedAt: mockTimestamp(1),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-2',
    title: 'Second note',
    body: 'Mock note body with **bold** and *italic*.',
    folderId: 'folder-1',
    createdAt: mockTimestamp(6),
    updatedAt: mockTimestamp(2),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-3',
    title: 'Daily journal entry',
    body: '## Today\n- Task one\n- Task two',
    folderId: 'folder-1',
    createdAt: mockTimestamp(5),
    updatedAt: mockTimestamp(0),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-4',
    title: 'Ideas list',
    body: 'Random brainstorm of mock content.',
    folderId: 'folder-2',
    createdAt: mockTimestamp(4),
    updatedAt: mockTimestamp(0),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-5',
    title: 'Travel plans',
    body: 'Check destinations and dates.',
    folderId: 'folder-2',
    createdAt: mockTimestamp(3),
    updatedAt: mockTimestamp(0),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-6',
    title: 'Reading notes',
    body: 'Book highlights.',
    folderId: 'folder-2',
    createdAt: mockTimestamp(2),
    updatedAt: mockTimestamp(0),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-7',
    title: 'Archive draft',
    body: 'Older content.',
    folderId: 'folder-3',
    createdAt: mockTimestamp(30),
    updatedAt: mockTimestamp(29),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-8',
    title: 'Meeting notes 2026-03-18',
    body: 'Mock meeting summary.',
    folderId: 'folder-3',
    createdAt: mockTimestamp(25),
    updatedAt: mockTimestamp(25),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-9',
    title: 'Project Alpha overview',
    body: 'Mock project details.',
    folderId: 'folder-3',
    createdAt: mockTimestamp(20),
    updatedAt: mockTimestamp(10),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-10',
    title: 'Untitled note',
    body: '',
    folderId: null,
    createdAt: mockTimestamp(1),
    updatedAt: mockTimestamp(1),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-11',
    title: 'Untitled note 2',
    body: '',
    folderId: null,
    createdAt: mockTimestamp(0),
    updatedAt: mockTimestamp(0),
    deletedAt: null,
    properties: {}
  },
  {
    id: 'note-12',
    title: 'Türkçe başlık testi',
    body: 'Türkçe karakter testi için örnek not — şıkğüöç.',
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
      body: input.body ?? '',
      folderId: input.folderId ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      properties: input.properties ?? {}
    }
    notes.unshift(note)
    return note
  },
  notes_update: async (args) => {
    const { id, ...changes } = args as { id: string } & Partial<MockNote>
    const note = notes.find((n) => n.id === id)
    if (!note) throw new Error(`Note ${id} not found`)
    Object.assign(note, changes, { updatedAt: Date.now() })
    return note
  },
  notes_delete: async (args) => {
    const { id } = args as { id: string }
    const note = notes.find((n) => n.id === id)
    if (!note) return { ok: false }
    note.deletedAt = Date.now()
    return { ok: true }
  }
}
