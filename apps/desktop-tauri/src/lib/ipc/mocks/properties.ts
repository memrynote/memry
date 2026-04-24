import type { MockRouteMap } from './types'

type PropertyType = 'string' | 'number' | 'boolean' | 'date' | 'select' | 'multiselect'

interface MockPropertyDef {
  key: string
  type: PropertyType
  options?: string[]
}

const definitions: MockPropertyDef[] = [
  { key: 'priority', type: 'select', options: ['low', 'medium', 'high', 'urgent'] },
  { key: 'status', type: 'select', options: ['draft', 'active', 'done', 'archived'] },
  { key: 'deadline', type: 'date' },
  { key: 'owner', type: 'string' },
  { key: 'estimate', type: 'number' },
  { key: 'pinned', type: 'boolean' },
  { key: 'labels', type: 'multiselect', options: ['work', 'personal', 'research'] }
]

const noteProperties: Record<string, Record<string, unknown>> = {
  'note-1': { priority: 'high', owner: 'Kaan', pinned: true },
  'note-2': { priority: 'medium', status: 'draft' },
  'note-4': { priority: 'medium', estimate: 3, labels: ['research'] },
  'note-9': { priority: 'urgent', status: 'active', estimate: 8 }
}

export const propertiesRoutes: MockRouteMap = {
  properties_list: async () => definitions,
  properties_get_for_note: async (args) => {
    const { noteId } = args as { noteId: string }
    return noteProperties[noteId] ?? {}
  },
  properties_set_for_note: async (args) => {
    const { noteId, key, value } = args as {
      noteId: string
      key: string
      value: unknown
    }
    const current = noteProperties[noteId] ?? {}
    noteProperties[noteId] = { ...current, [key]: value }
    return noteProperties[noteId]
  },
  properties_unset_for_note: async (args) => {
    const { noteId, key } = args as { noteId: string; key: string }
    const current = { ...(noteProperties[noteId] ?? {}) }
    delete current[key]
    noteProperties[noteId] = current
    return current
  },
  properties_distinct_values: async (args) => {
    const { key } = args as { key: string }
    const def = definitions.find((d) => d.key === key)
    if (def?.options) return def.options
    const values = new Set<string>()
    for (const props of Object.values(noteProperties)) {
      const v = props[key]
      if (typeof v === 'string') values.add(v)
    }
    return Array.from(values)
  }
}
