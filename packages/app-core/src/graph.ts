import type { NotesService } from './service-types.ts'
import type { TasksService } from './tasks.ts'

export interface GraphNode {
  id: string
  type: 'note' | 'journal' | 'task' | 'project'
  label: string
  tags: string[]
  wordCount: number
  connectionCount: number
  emoji: string | null
  color: string
  isOrphan: boolean
  isUnresolved: boolean
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  type: 'wikilink' | 'project-task'
  weight: number
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface GraphService {
  data(): Promise<GraphData>
  local(noteId: string, depth?: number): Promise<GraphData>
}

const COLORS: Record<GraphNode['type'], string> = {
  note: 'var(--graph-node-note)',
  journal: 'var(--graph-node-journal)',
  task: 'var(--graph-node-task)',
  project: 'var(--graph-node-project)'
}

function wikilinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)
  return [...matches].map((match) => match[1]?.trim()).filter((title): title is string => !!title)
}

function withConnectionCounts(graph: GraphData): GraphData {
  const counts = new Map<string, number>()
  for (const edge of graph.edges) {
    counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1)
    counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1)
  }

  return {
    nodes: graph.nodes.map((node) => {
      const connectionCount = counts.get(node.id) ?? 0
      return { ...node, connectionCount, isOrphan: connectionCount === 0 }
    }),
    edges: graph.edges
  }
}

export function createGraphService({
  notes,
  tasks
}: {
  notes: NotesService
  tasks: TasksService
}): GraphService {
  return {
    async data() {
      const nodes: GraphNode[] = []
      const edges: GraphEdge[] = []
      const nodeIds = new Set<string>()
      const notesByTitle = new Map<string, string>()

      const noteRows = [
        ...(await notes.list({ limit: 10000 })),
        ...(await notes.list({ journalOnly: true, limit: 10000 }))
      ]
      for (const note of noteRows) {
        const type = note.journalDate ? 'journal' : 'note'
        nodes.push({
          id: note.id,
          type,
          label: note.title || 'Untitled',
          tags: note.tags,
          wordCount: note.wordCount,
          connectionCount: 0,
          emoji: null,
          color: COLORS[type],
          isOrphan: false,
          isUnresolved: false
        })
        nodeIds.add(note.id)
        notesByTitle.set(note.title, note.id)
      }

      for (const project of await tasks.projects.list()) {
        if (project.archivedAt) continue
        nodes.push({
          id: project.id,
          type: 'project',
          label: project.name || 'Untitled Project',
          tags: [],
          wordCount: 0,
          connectionCount: 0,
          emoji: project.icon,
          color: COLORS.project,
          isOrphan: false,
          isUnresolved: false
        })
        nodeIds.add(project.id)
      }

      for (const task of await tasks.list({ includeCompleted: true })) {
        if (task.archivedAt) continue
        nodes.push({
          id: task.id,
          type: 'task',
          label: task.title || 'Untitled Task',
          tags: task.tags,
          wordCount: 0,
          connectionCount: 0,
          emoji: null,
          color: COLORS.task,
          isOrphan: false,
          isUnresolved: false
        })
        nodeIds.add(task.id)
        edges.push({
          id: `${task.id}-${task.projectId}-project-task`,
          source: task.id,
          target: task.projectId,
          type: 'project-task',
          weight: 1
        })
      }

      for (const note of noteRows) {
        for (const title of wikilinks(note.content)) {
          const targetId = notesByTitle.get(title)
          if (targetId) {
            edges.push({
              id: `${note.id}-${targetId}-wikilink`,
              source: note.id,
              target: targetId,
              type: 'wikilink',
              weight: 1
            })
            continue
          }

          const ghostId = `ghost:${title}`
          if (!nodeIds.has(ghostId)) {
            nodes.push({
              id: ghostId,
              type: 'note',
              label: title,
              tags: [],
              wordCount: 0,
              connectionCount: 0,
              emoji: null,
              color: 'var(--graph-ghost-node)',
              isOrphan: false,
              isUnresolved: true
            })
            nodeIds.add(ghostId)
          }
          edges.push({
            id: `${note.id}-${ghostId}-wikilink`,
            source: note.id,
            target: ghostId,
            type: 'wikilink',
            weight: 1
          })
        }
      }

      return withConnectionCounts({ nodes, edges })
    },

    async local(noteId, depth = 2) {
      const graph = await this.data()
      const adjacency = new Map<string, Set<string>>()
      for (const edge of graph.edges) {
        if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set())
        if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set())
        adjacency.get(edge.source)?.add(edge.target)
        adjacency.get(edge.target)?.add(edge.source)
      }

      const visited = new Set<string>([noteId])
      const queue: Array<{ id: string; level: number }> = [{ id: noteId, level: 0 }]
      while (queue.length > 0) {
        const current = queue.shift()
        if (!current || current.level >= depth) continue
        for (const next of adjacency.get(current.id) ?? []) {
          if (visited.has(next)) continue
          visited.add(next)
          queue.push({ id: next, level: current.level + 1 })
        }
      }

      return {
        nodes: graph.nodes.filter((node) => visited.has(node.id)),
        edges: graph.edges.filter((edge) => visited.has(edge.source) && visited.has(edge.target))
      }
    }
  }
}
