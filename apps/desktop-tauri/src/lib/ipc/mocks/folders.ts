import type { MockRouteMap } from './types'
import { mockId, mockTimestamp } from './types'

interface MockFolder {
  id: string
  name: string
  parentId: string | null
  color: string | null
  icon: string | null
  createdAt: number
  updatedAt: number
}

const folders: MockFolder[] = [
  {
    id: 'folder-1',
    name: 'Inbox',
    parentId: null,
    color: '#4ade80',
    icon: 'inbox',
    createdAt: mockTimestamp(30),
    updatedAt: mockTimestamp(0)
  },
  {
    id: 'folder-2',
    name: 'Projects',
    parentId: null,
    color: '#60a5fa',
    icon: 'folder',
    createdAt: mockTimestamp(30),
    updatedAt: mockTimestamp(0)
  },
  {
    id: 'folder-3',
    name: 'Archive',
    parentId: null,
    color: '#94a3b8',
    icon: 'archive',
    createdAt: mockTimestamp(30),
    updatedAt: mockTimestamp(0)
  }
]

export const foldersRoutes: MockRouteMap = {
  folders_list: async () => folders,
  folders_get: async (args) => {
    const { id } = args as { id: string }
    const f = folders.find((x) => x.id === id)
    if (!f) throw new Error(`Folder ${id} not found`)
    return f
  },
  folders_create: async (args) => {
    const input = (args as Partial<MockFolder>) ?? {}
    const now = Date.now()
    const f: MockFolder = {
      id: mockId('folder'),
      name: input.name ?? 'New folder',
      parentId: input.parentId ?? null,
      color: input.color ?? null,
      icon: input.icon ?? null,
      createdAt: now,
      updatedAt: now
    }
    folders.push(f)
    return f
  },
  folders_update: async (args) => {
    const { id, ...changes } = args as { id: string } & Partial<MockFolder>
    const f = folders.find((x) => x.id === id)
    if (!f) throw new Error(`Folder ${id} not found`)
    Object.assign(f, changes, { updatedAt: Date.now() })
    return f
  },
  folders_delete: async (args) => {
    const { id } = args as { id: string }
    const idx = folders.findIndex((x) => x.id === id)
    if (idx >= 0) folders.splice(idx, 1)
    return { ok: true }
  }
}
