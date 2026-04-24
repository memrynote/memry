import type { MockRouteMap } from './types'

interface GraphNode {
  id: string
  label: string
  kind: 'note' | 'tag' | 'folder'
  size: number
}

interface GraphEdge {
  source: string
  target: string
  kind: 'link' | 'tag' | 'folder'
}

const nodes: GraphNode[] = [
  { id: 'note-1', label: 'Welcome to Memry', kind: 'note', size: 6 },
  { id: 'note-2', label: 'Second note', kind: 'note', size: 3 },
  { id: 'note-3', label: 'Daily journal entry', kind: 'note', size: 4 },
  { id: 'note-4', label: 'Ideas list', kind: 'note', size: 5 },
  { id: 'note-5', label: 'Travel plans', kind: 'note', size: 2 },
  { id: 'note-6', label: 'Reading notes', kind: 'note', size: 4 },
  { id: 'note-7', label: 'Archive draft', kind: 'note', size: 2 },
  { id: 'note-8', label: 'Meeting notes 2026-03-18', kind: 'note', size: 3 },
  { id: 'note-9', label: 'Project Alpha overview', kind: 'note', size: 5 },
  { id: 'note-12', label: 'Türkçe başlık', kind: 'note', size: 2 },
  { id: 'tag-1', label: 'work', kind: 'tag', size: 3 },
  { id: 'tag-3', label: 'research', kind: 'tag', size: 2 },
  { id: 'folder-1', label: 'Inbox', kind: 'folder', size: 4 }
]

const edges: GraphEdge[] = [
  { source: 'note-1', target: 'note-2', kind: 'link' },
  { source: 'note-1', target: 'note-3', kind: 'link' },
  { source: 'note-4', target: 'note-1', kind: 'link' },
  { source: 'note-9', target: 'note-4', kind: 'link' },
  { source: 'note-6', target: 'note-3', kind: 'link' },
  { source: 'note-1', target: 'tag-1', kind: 'tag' },
  { source: 'note-2', target: 'tag-3', kind: 'tag' },
  { source: 'note-4', target: 'tag-1', kind: 'tag' },
  { source: 'note-1', target: 'folder-1', kind: 'folder' },
  { source: 'note-2', target: 'folder-1', kind: 'folder' },
  { source: 'note-3', target: 'folder-1', kind: 'folder' },
  { source: 'note-12', target: 'folder-1', kind: 'folder' }
]

function neighborhood(noteId: string, depth: number): GraphNode[] {
  const visited = new Set<string>([noteId])
  let frontier = new Set<string>([noteId])
  for (let d = 0; d < depth; d += 1) {
    const next = new Set<string>()
    for (const edge of edges) {
      if (frontier.has(edge.source) && !visited.has(edge.target)) next.add(edge.target)
      if (frontier.has(edge.target) && !visited.has(edge.source)) next.add(edge.source)
    }
    for (const id of next) visited.add(id)
    frontier = next
    if (frontier.size === 0) break
  }
  visited.delete(noteId)
  return nodes.filter((n) => visited.has(n.id))
}

export const graphRoutes: MockRouteMap = {
  graph_get: async () => ({ nodes, edges }),
  graph_neighbors: async (args) => {
    const { noteId, depth } = args as { noteId: string; depth?: number }
    return neighborhood(noteId, depth ?? 1)
  },
  graph_backlinks: async (args) => {
    const { noteId } = args as { noteId: string }
    return edges.filter((e) => e.target === noteId && e.kind === 'link')
  },
  graph_forward_links: async (args) => {
    const { noteId } = args as { noteId: string }
    return edges.filter((e) => e.source === noteId && e.kind === 'link')
  }
}
