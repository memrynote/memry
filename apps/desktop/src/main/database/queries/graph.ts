import { eq, isNull } from 'drizzle-orm'
import { noteCache, noteTags, noteLinks } from '@memry/db-schema/schema/notes-cache'
import { tasks } from '@memry/db-schema/schema/tasks'
import { taskNotes } from '@memry/db-schema/schema/task-relations'
import { projects } from '@memry/db-schema/schema/projects'
import type { GraphNode, GraphEdge, GraphDataResponse } from '@memry/contracts/graph-api'
import type { DataDb, IndexDb } from '../types'

const NODE_COLORS: Record<GraphNode['type'], string> = {
  note: 'var(--graph-node-note)',
  journal: 'var(--graph-node-journal)',
  task: 'var(--graph-node-task)',
  project: 'var(--graph-node-project)'
}

const GHOST_COLOR = 'var(--graph-ghost-node)'

export function getGraphData(indexDb: IndexDb, dataDb: DataDb): GraphDataResponse {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const nodeIds = new Set<string>()

  const allNotes = indexDb
    .select({
      id: noteCache.id,
      title: noteCache.title,
      date: noteCache.date,
      wordCount: noteCache.wordCount,
      emoji: noteCache.emoji
    })
    .from(noteCache)
    .where(eq(noteCache.fileType, 'markdown'))
    .all()

  const allNoteTags = indexDb
    .select({ noteId: noteTags.noteId, tag: noteTags.tag })
    .from(noteTags)
    .all()

  const tagsByNoteId = new Map<string, string[]>()
  for (const nt of allNoteTags) {
    const arr = tagsByNoteId.get(nt.noteId) ?? []
    arr.push(nt.tag)
    tagsByNoteId.set(nt.noteId, arr)
  }

  for (const note of allNotes) {
    const type: GraphNode['type'] = note.date ? 'journal' : 'note'
    const tags = tagsByNoteId.get(note.id) ?? []
    nodes.push({
      id: note.id,
      type,
      label: note.title || 'Untitled',
      tags,
      wordCount: note.wordCount ?? 0,
      connectionCount: 0,
      emoji: note.emoji ?? null,
      color: NODE_COLORS[type],
      isOrphan: false,
      isUnresolved: false
    })
    nodeIds.add(note.id)
  }

  const allTasks = dataDb
    .select({
      id: tasks.id,
      title: tasks.title,
      projectId: tasks.projectId
    })
    .from(tasks)
    .where(isNull(tasks.archivedAt))
    .all()

  for (const task of allTasks) {
    nodes.push({
      id: task.id,
      type: 'task',
      label: task.title || 'Untitled Task',
      tags: [],
      wordCount: 0,
      connectionCount: 0,
      emoji: null,
      color: NODE_COLORS.task,
      isOrphan: false,
      isUnresolved: false
    })
    nodeIds.add(task.id)

    if (task.projectId) {
      edges.push({
        id: `${task.id}-${task.projectId}-project-task`,
        source: task.id,
        target: task.projectId,
        type: 'project-task',
        weight: 1
      })
    }
  }

  const allProjects = dataDb
    .select({
      id: projects.id,
      name: projects.name,
      icon: projects.icon
    })
    .from(projects)
    .where(isNull(projects.archivedAt))
    .all()

  for (const project of allProjects) {
    nodes.push({
      id: project.id,
      type: 'project',
      label: project.name || 'Untitled Project',
      tags: [],
      wordCount: 0,
      connectionCount: 0,
      emoji: project.icon ?? null,
      color: NODE_COLORS.project,
      isOrphan: false,
      isUnresolved: false
    })
    nodeIds.add(project.id)
  }

  const allLinks = indexDb
    .select({
      sourceId: noteLinks.sourceId,
      targetId: noteLinks.targetId,
      targetTitle: noteLinks.targetTitle
    })
    .from(noteLinks)
    .all()

  for (const link of allLinks) {
    if (link.targetId && nodeIds.has(link.sourceId) && nodeIds.has(link.targetId)) {
      edges.push({
        id: `${link.sourceId}-${link.targetId}-wikilink`,
        source: link.sourceId,
        target: link.targetId,
        type: 'wikilink',
        weight: 1
      })
    } else if (!link.targetId && nodeIds.has(link.sourceId)) {
      const ghostId = `ghost:${link.targetTitle}`
      if (!nodeIds.has(ghostId)) {
        nodes.push({
          id: ghostId,
          type: 'note',
          label: link.targetTitle,
          tags: [],
          wordCount: 0,
          connectionCount: 0,
          emoji: null,
          color: GHOST_COLOR,
          isOrphan: false,
          isUnresolved: true
        })
        nodeIds.add(ghostId)
      }
      edges.push({
        id: `${link.sourceId}-${ghostId}-wikilink`,
        source: link.sourceId,
        target: ghostId,
        type: 'wikilink',
        weight: 1
      })
    }
  }

  const allTaskNotes = dataDb
    .select({ taskId: taskNotes.taskId, noteId: taskNotes.noteId })
    .from(taskNotes)
    .all()

  for (const tn of allTaskNotes) {
    if (nodeIds.has(tn.taskId) && nodeIds.has(tn.noteId)) {
      edges.push({
        id: `${tn.taskId}-${tn.noteId}-task-note`,
        source: tn.taskId,
        target: tn.noteId,
        type: 'task-note',
        weight: 1
      })
    }
  }

  const connectionCounts = new Map<string, number>()
  for (const edge of edges) {
    connectionCounts.set(edge.source, (connectionCounts.get(edge.source) ?? 0) + 1)
    connectionCounts.set(edge.target, (connectionCounts.get(edge.target) ?? 0) + 1)
  }

  for (const node of nodes) {
    node.connectionCount = connectionCounts.get(node.id) ?? 0
    node.isOrphan = node.connectionCount === 0
  }

  return { nodes, edges }
}

export function getLocalGraph(
  indexDb: IndexDb,
  dataDb: DataDb,
  noteId: string,
  depth: number
): GraphDataResponse {
  const fullGraph = getGraphData(indexDb, dataDb)

  const adjacency = new Map<string, Set<string>>()
  for (const edge of fullGraph.edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set())
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set())
    adjacency.get(edge.source)!.add(edge.target)
    adjacency.get(edge.target)!.add(edge.source)
  }

  const visited = new Set<string>()
  const queue: Array<{ id: string; level: number }> = [{ id: noteId, level: 0 }]
  visited.add(noteId)

  while (queue.length > 0) {
    const { id, level } = queue.shift()!
    if (level >= depth) continue

    const neighbors = adjacency.get(id)
    if (!neighbors) continue

    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor)
        queue.push({ id: neighbor, level: level + 1 })
      }
    }
  }

  const localNodes = fullGraph.nodes.filter((n) => visited.has(n.id))
  const localEdges = fullGraph.edges.filter((e) => visited.has(e.source) && visited.has(e.target))

  return { nodes: localNodes, edges: localEdges }
}
