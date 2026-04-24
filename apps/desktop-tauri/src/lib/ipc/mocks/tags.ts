import type { MockRouteMap } from './types'
import { mockId, mockTimestamp } from './types'

interface MockTag {
  id: string
  name: string
  color: string | null
  count: number
  createdAt: number
  updatedAt: number
}

const names = [
  'work',
  'personal',
  'research',
  'reading',
  'archive',
  'urgent',
  'someday',
  'önemli'
]

const tags: MockTag[] = names.map((name, i) => ({
  id: `tag-${i + 1}`,
  name,
  color: ['#60a5fa', '#4ade80', '#f97316', '#f472b6'][i % 4]!,
  count: Math.max(0, 10 - i),
  createdAt: mockTimestamp(30 - i),
  updatedAt: mockTimestamp(i)
}))

const noteTagMap: Record<string, string[]> = {
  'note-1': ['tag-1', 'tag-2'],
  'note-2': ['tag-3'],
  'note-3': [],
  'note-4': ['tag-2', 'tag-4'],
  'note-5': ['tag-1']
}

export const tagsRoutes: MockRouteMap = {
  tags_list: async () => tags,
  // Sidebar reads { tag, color, count }[]
  tags_get_all_with_counts: async () =>
    tags.map((t) => ({ tag: t.name, color: t.color ?? '#a3a3a3', count: t.count })),
  tags_get: async (args) => {
    const { id } = args as { id: string }
    const tag = tags.find((t) => t.id === id)
    if (!tag) throw new Error(`Tag ${id} not found`)
    return tag
  },
  tags_create: async (args) => {
    const { name, color } = args as { name: string; color?: string | null }
    const now = Date.now()
    const tag: MockTag = {
      id: mockId('tag'),
      name,
      color: color ?? null,
      count: 0,
      createdAt: now,
      updatedAt: now
    }
    tags.push(tag)
    return tag
  },
  tags_update: async (args) => {
    const { id, ...changes } = args as { id: string } & Partial<MockTag>
    const tag = tags.find((t) => t.id === id)
    if (!tag) throw new Error(`Tag ${id} not found`)
    Object.assign(tag, changes, { updatedAt: Date.now() })
    return tag
  },
  tags_delete: async (args) => {
    const { id } = args as { id: string }
    const idx = tags.findIndex((t) => t.id === id)
    if (idx >= 0) tags.splice(idx, 1)
    return { ok: true }
  },
  tags_by_note: async (args) => {
    const { noteId } = args as { noteId: string }
    const ids = noteTagMap[noteId] ?? []
    return tags.filter((t) => ids.includes(t.id))
  },
  tags_attach: async (args) => {
    const { noteId, tagId } = args as { noteId: string; tagId: string }
    const existing = noteTagMap[noteId] ?? []
    if (!existing.includes(tagId)) {
      noteTagMap[noteId] = [...existing, tagId]
    }
    return { ok: true }
  },
  tags_detach: async (args) => {
    const { noteId, tagId } = args as { noteId: string; tagId: string }
    noteTagMap[noteId] = (noteTagMap[noteId] ?? []).filter((id) => id !== tagId)
    return { ok: true }
  }
}
