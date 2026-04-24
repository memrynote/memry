import type { MockRouteMap } from './types'
import { mockId, mockTimestamp } from './types'

type InboxStatus = 'unread' | 'read' | 'snoozed' | 'archived' | 'filed'
type InboxKind = 'text' | 'link' | 'image' | 'pdf' | 'voice' | 'clip'

interface MockInboxItem {
  id: string
  kind: InboxKind
  title: string
  snippet: string
  status: InboxStatus
  tags: string[]
  snoozedUntil: number | null
  filedNoteId: string | null
  capturedAt: number
  updatedAt: number
}

const fixtures: Array<Omit<MockInboxItem, 'id'>> = [
  {
    kind: 'text',
    title: 'Quick thought — mock',
    snippet: 'Dashboard redesign note.',
    status: 'unread',
    tags: [],
    snoozedUntil: null,
    filedNoteId: null,
    capturedAt: mockTimestamp(0),
    updatedAt: mockTimestamp(0)
  },
  {
    kind: 'link',
    title: 'Prisma docs',
    snippet: 'https://prisma.io',
    status: 'unread',
    tags: ['docs'],
    snoozedUntil: null,
    filedNoteId: null,
    capturedAt: mockTimestamp(1),
    updatedAt: mockTimestamp(1)
  },
  {
    kind: 'image',
    title: 'Napkin sketch',
    snippet: '512x384 sketch',
    status: 'unread',
    tags: [],
    snoozedUntil: null,
    filedNoteId: null,
    capturedAt: mockTimestamp(1),
    updatedAt: mockTimestamp(1)
  },
  {
    kind: 'voice',
    title: 'Voice memo — idea',
    snippet: '0:42 recording',
    status: 'unread',
    tags: [],
    snoozedUntil: null,
    filedNoteId: null,
    capturedAt: mockTimestamp(2),
    updatedAt: mockTimestamp(2)
  },
  {
    kind: 'pdf',
    title: 'Research paper.pdf',
    snippet: '12 pages',
    status: 'read',
    tags: ['research'],
    snoozedUntil: null,
    filedNoteId: null,
    capturedAt: mockTimestamp(3),
    updatedAt: mockTimestamp(3)
  },
  {
    kind: 'clip',
    title: 'Article clip — web vitals',
    snippet: 'Selection from vercel.com',
    status: 'read',
    tags: [],
    snoozedUntil: null,
    filedNoteId: null,
    capturedAt: mockTimestamp(4),
    updatedAt: mockTimestamp(4)
  },
  {
    kind: 'text',
    title: 'Snoozed idea — kampanya fikri',
    snippet: 'Türkçe not için snooze.',
    status: 'snoozed',
    tags: [],
    snoozedUntil: mockTimestamp(-2),
    filedNoteId: null,
    capturedAt: mockTimestamp(5),
    updatedAt: mockTimestamp(5)
  },
  {
    kind: 'link',
    title: 'Tailwind v4 announcement',
    snippet: 'https://tailwindcss.com',
    status: 'archived',
    tags: ['archive'],
    snoozedUntil: null,
    filedNoteId: null,
    capturedAt: mockTimestamp(10),
    updatedAt: mockTimestamp(10)
  },
  {
    kind: 'text',
    title: 'Filed — release note draft',
    snippet: 'Filed to Projects folder.',
    status: 'filed',
    tags: [],
    snoozedUntil: null,
    filedNoteId: 'note-filed-1',
    capturedAt: mockTimestamp(7),
    updatedAt: mockTimestamp(1)
  },
  {
    kind: 'image',
    title: 'Whiteboard photo',
    snippet: 'Archived.',
    status: 'archived',
    tags: [],
    snoozedUntil: null,
    filedNoteId: null,
    capturedAt: mockTimestamp(14),
    updatedAt: mockTimestamp(14)
  },
  {
    kind: 'text',
    title: 'Weekly reflection',
    snippet: 'Unread reflection.',
    status: 'unread',
    tags: ['reflection'],
    snoozedUntil: null,
    filedNoteId: null,
    capturedAt: mockTimestamp(0),
    updatedAt: mockTimestamp(0)
  },
  {
    kind: 'link',
    title: 'Podcast — API design',
    snippet: '45 min listen',
    status: 'snoozed',
    tags: ['listen'],
    snoozedUntil: mockTimestamp(-1),
    filedNoteId: null,
    capturedAt: mockTimestamp(2),
    updatedAt: mockTimestamp(2)
  }
]

const items: MockInboxItem[] = fixtures.map((f, i) => ({ id: `inbox-${i + 1}`, ...f }))

export const inboxRoutes: MockRouteMap = {
  inbox_list: async () => items.filter((i) => i.status !== 'archived'),
  inbox_list_archived: async () => items.filter((i) => i.status === 'archived'),
  inbox_get: async (args) => {
    const { id } = args as { id: string }
    const item = items.find((i) => i.id === id)
    if (!item) throw new Error(`Inbox item ${id} not found`)
    return item
  },
  inbox_capture_text: async (args) => {
    const { text } = args as { text: string }
    const now = Date.now()
    const item: MockInboxItem = {
      id: mockId('inbox'),
      kind: 'text',
      title: text.slice(0, 60),
      snippet: text.slice(0, 140),
      status: 'unread',
      tags: [],
      snoozedUntil: null,
      filedNoteId: null,
      capturedAt: now,
      updatedAt: now
    }
    items.unshift(item)
    return item
  },
  inbox_capture_link: async (args) => {
    const { url, title } = args as { url: string; title?: string }
    const now = Date.now()
    const item: MockInboxItem = {
      id: mockId('inbox'),
      kind: 'link',
      title: title ?? url,
      snippet: url,
      status: 'unread',
      tags: [],
      snoozedUntil: null,
      filedNoteId: null,
      capturedAt: now,
      updatedAt: now
    }
    items.unshift(item)
    return item
  },
  inbox_update: async (args) => {
    const { id, ...changes } = args as { id: string } & Partial<MockInboxItem>
    const item = items.find((i) => i.id === id)
    if (!item) throw new Error(`Inbox item ${id} not found`)
    Object.assign(item, changes, { updatedAt: Date.now() })
    return item
  },
  inbox_archive: async (args) => {
    const { id } = args as { id: string }
    const item = items.find((i) => i.id === id)
    if (!item) throw new Error(`Inbox item ${id} not found`)
    item.status = 'archived'
    item.updatedAt = Date.now()
    return item
  },
  inbox_snooze: async (args) => {
    const { id, until } = args as { id: string; until: number }
    const item = items.find((i) => i.id === id)
    if (!item) throw new Error(`Inbox item ${id} not found`)
    item.status = 'snoozed'
    item.snoozedUntil = until
    item.updatedAt = Date.now()
    return item
  },
  inbox_file: async (args) => {
    const { id } = args as { id: string; folderId: string }
    const item = items.find((i) => i.id === id)
    if (!item) throw new Error(`Inbox item ${id} not found`)
    const noteId = mockId('note')
    item.status = 'filed'
    item.filedNoteId = noteId
    item.updatedAt = Date.now()
    return { ok: true, noteId }
  },
  inbox_stats: async () => ({
    total: items.length,
    unread: items.filter((i) => i.status === 'unread').length,
    snoozed: items.filter((i) => i.status === 'snoozed').length,
    archived: items.filter((i) => i.status === 'archived').length
  }),
  inbox_filing_history: async () => items.filter((i) => i.status === 'filed'),
  inbox_jobs: async () => ({ jobs: [] })
}
