import { and, eq, inArray, isNull } from 'drizzle-orm'
import { noteCache, noteTags, noteLinks, propertyRefs } from '@memry/db-schema/schema/notes-cache'
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

const GHOST_PREFIX = 'ghost:'

/**
 * Node factories shared by the whole-vault build and the local traversal, so the two can
 * never drift on the shape of a node they both have to be able to emit.
 */
function createNoteNode(
  row: {
    id: string
    title: string
    date: string | null
    wordCount: number | null
    emoji: string | null
  },
  tags: string[]
): GraphNode {
  const type: GraphNode['type'] = row.date ? 'journal' : 'note'
  return {
    id: row.id,
    type,
    label: row.title || 'Untitled',
    tags,
    wordCount: row.wordCount ?? 0,
    connectionCount: 0,
    emoji: row.emoji ?? null,
    color: NODE_COLORS[type],
    isOrphan: false,
    isUnresolved: false
  }
}

function createTaskNode(row: { id: string; title: string }): GraphNode {
  return {
    id: row.id,
    type: 'task',
    label: row.title || 'Untitled Task',
    tags: [],
    wordCount: 0,
    connectionCount: 0,
    emoji: null,
    color: NODE_COLORS.task,
    isOrphan: false,
    isUnresolved: false
  }
}

function createProjectNode(row: { id: string; name: string; icon: string | null }): GraphNode {
  return {
    id: row.id,
    type: 'project',
    label: row.name || 'Untitled Project',
    tags: [],
    wordCount: 0,
    connectionCount: 0,
    emoji: row.icon ?? null,
    color: NODE_COLORS.project,
    isOrphan: false,
    isUnresolved: false
  }
}

function createGhostNode(targetTitle: string): GraphNode {
  return {
    id: `${GHOST_PREFIX}${targetTitle}`,
    type: 'note',
    label: targetTitle,
    tags: [],
    wordCount: 0,
    connectionCount: 0,
    emoji: null,
    color: GHOST_COLOR,
    isOrphan: false,
    isUnresolved: true
  }
}

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
    nodes.push(createNoteNode(note, tagsByNoteId.get(note.id) ?? []))
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
    nodes.push(createTaskNode(task))
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
    nodes.push(createProjectNode(project))
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
      const ghostId = `${GHOST_PREFIX}${link.targetTitle}`
      if (!nodeIds.has(ghostId)) {
        nodes.push(createGhostNode(link.targetTitle))
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

  const allPropertyRefs = indexDb
    .select({
      sourceNoteId: propertyRefs.sourceNoteId,
      targetType: propertyRefs.targetType,
      targetId: propertyRefs.targetId
    })
    .from(propertyRefs)
    .all()

  for (const ref of allPropertyRefs) {
    // Note→note edges only in v1: task/event targets aren't graph nodes today.
    if (ref.targetType !== 'note') continue
    // property_refs is a rebuildable index-DB cache with no FK enforcement on
    // the target, so a ref can point at a note that was since deleted.
    if (!nodeIds.has(ref.sourceNoteId) || !nodeIds.has(ref.targetId)) continue

    edges.push({
      id: `${ref.sourceNoteId}-${ref.targetId}-relation`,
      source: ref.sourceNoteId,
      target: ref.targetId,
      type: 'relation',
      weight: 1
    })
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

/** Keeps every `IN (...)` list well under SQLite's bound-parameter ceiling. */
const ID_CHUNK_SIZE = 400

function chunk<T>(values: T[]): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < values.length; i += ID_CHUNK_SIZE) {
    batches.push(values.slice(i, i + ID_CHUNK_SIZE))
  }
  return batches
}

/**
 * A full-graph edge, plus the identity of the row that produced it so the same row picked
 * up from both of its endpoints is only ever counted once.
 */
interface EdgeCandidate {
  rowKey: string
  edge: GraphEdge
  /**
   * False only for `project-task`, which the whole-vault build emits without checking that
   * the project is still a node — a task under an archived project keeps its dangling edge.
   */
  requiresBothNodes: boolean
}

/** Everything the traversal has resolved so far. Lives for one `getLocalGraph` call. */
interface TraversalState {
  /** Ids that resolved to a real graph node, with the node itself. */
  nodes: Map<string, GraphNode>
  /** Every id we have already tried to resolve, node or not. */
  resolved: Set<string>
  /** `tasks.project_id` for resolved task nodes, for the project-task edge off a task. */
  taskProjectIds: Map<string, string | null>
}

function isGhostId(id: string): boolean {
  return id.startsWith(GHOST_PREFIX)
}

/**
 * Resolve ids to graph nodes with indexed primary-key lookups, mirroring exactly which rows
 * the whole-vault build turns into nodes: markdown notes, unarchived tasks, unarchived
 * projects. Anything else stays unresolved, which is what keeps its edges out of the result.
 */
function resolveNodes(
  indexDb: IndexDb,
  dataDb: DataDb,
  ids: string[],
  state: TraversalState
): void {
  const pending = ids.filter((id) => !state.resolved.has(id))
  if (pending.length === 0) return

  const realIds: string[] = []
  for (const id of pending) {
    state.resolved.add(id)
    if (isGhostId(id)) {
      state.nodes.set(id, createGhostNode(id.slice(GHOST_PREFIX.length)))
    } else {
      realIds.push(id)
    }
  }

  const noteIds: string[] = []
  for (const batch of chunk(realIds)) {
    const noteRows = indexDb
      .select({
        id: noteCache.id,
        title: noteCache.title,
        date: noteCache.date,
        wordCount: noteCache.wordCount,
        emoji: noteCache.emoji
      })
      .from(noteCache)
      .where(and(eq(noteCache.fileType, 'markdown'), inArray(noteCache.id, batch)))
      .all()

    for (const row of noteRows) {
      state.nodes.set(row.id, createNoteNode(row, []))
      noteIds.push(row.id)
    }

    const taskRows = dataDb
      .select({ id: tasks.id, title: tasks.title, projectId: tasks.projectId })
      .from(tasks)
      .where(and(isNull(tasks.archivedAt), inArray(tasks.id, batch)))
      .all()

    for (const row of taskRows) {
      state.nodes.set(row.id, createTaskNode(row))
      state.taskProjectIds.set(row.id, row.projectId)
    }

    const projectRows = dataDb
      .select({ id: projects.id, name: projects.name, icon: projects.icon })
      .from(projects)
      .where(and(isNull(projects.archivedAt), inArray(projects.id, batch)))
      .all()

    for (const row of projectRows) {
      state.nodes.set(row.id, createProjectNode(row))
    }
  }

  for (const batch of chunk(noteIds)) {
    const tagRows = indexDb
      .select({ noteId: noteTags.noteId, tag: noteTags.tag })
      .from(noteTags)
      .where(inArray(noteTags.noteId, batch))
      .all()

    for (const row of tagRows) {
      state.nodes.get(row.noteId)?.tags.push(row.tag)
    }
  }
}

function projectTaskCandidate(taskId: string, projectId: string): EdgeCandidate {
  return {
    rowKey: `project-task\u0000${taskId}`,
    requiresBothNodes: false,
    edge: {
      id: `${taskId}-${projectId}-project-task`,
      source: taskId,
      target: projectId,
      type: 'project-task',
      weight: 1
    }
  }
}

/**
 * Every full-graph edge touching one of `frontier`, found with indexed lookups instead of a
 * whole-vault scan. Both directions of every relationship are queried, so a node's backlinks
 * are reached exactly like its outgoing links.
 */
function collectIncidentEdges(
  indexDb: IndexDb,
  dataDb: DataDb,
  frontier: string[],
  state: TraversalState
): EdgeCandidate[] {
  const noteIds: string[] = []
  const taskIds: string[] = []
  const ghostTitles: string[] = []
  // Resolved projects, plus ids that resolved to nothing: a task can point at an archived or
  // deleted project, and the whole-vault build still walks that edge.
  const projectLikeIds: string[] = []

  for (const id of frontier) {
    if (isGhostId(id)) {
      ghostTitles.push(id.slice(GHOST_PREFIX.length))
      continue
    }
    const node = state.nodes.get(id)
    if (!node || node.type === 'project') projectLikeIds.push(id)
    else if (node.type === 'task') taskIds.push(id)
    else noteIds.push(id)
  }

  const candidates: EdgeCandidate[] = []

  for (const taskId of taskIds) {
    const projectId = state.taskProjectIds.get(taskId)
    if (projectId) candidates.push(projectTaskCandidate(taskId, projectId))
  }

  for (const batch of chunk(projectLikeIds)) {
    const rows = dataDb
      .select({ id: tasks.id, projectId: tasks.projectId })
      .from(tasks)
      .where(and(isNull(tasks.archivedAt), inArray(tasks.projectId, batch)))
      .all()

    for (const row of rows) {
      if (row.projectId) candidates.push(projectTaskCandidate(row.id, row.projectId))
    }
  }

  const linkColumns = {
    sourceId: noteLinks.sourceId,
    targetId: noteLinks.targetId,
    targetTitle: noteLinks.targetTitle
  }
  const linkRows = new Map<
    string,
    { sourceId: string; targetId: string | null; targetTitle: string }
  >()

  for (const batch of chunk(noteIds)) {
    for (const row of indexDb
      .select(linkColumns)
      .from(noteLinks)
      .where(inArray(noteLinks.sourceId, batch))
      .all()) {
      linkRows.set(`${row.sourceId}\u0000${row.targetTitle}`, row)
    }
    for (const row of indexDb
      .select(linkColumns)
      .from(noteLinks)
      .where(inArray(noteLinks.targetId, batch))
      .all()) {
      linkRows.set(`${row.sourceId}\u0000${row.targetTitle}`, row)
    }
  }

  // A ghost is shared by every note linking to that missing title, so it is expanded by title.
  for (const batch of chunk(ghostTitles)) {
    for (const row of indexDb
      .select(linkColumns)
      .from(noteLinks)
      .where(and(isNull(noteLinks.targetId), inArray(noteLinks.targetTitle, batch)))
      .all()) {
      linkRows.set(`${row.sourceId}\u0000${row.targetTitle}`, row)
    }
  }

  for (const [rowKey, row] of linkRows) {
    const target = row.targetId ?? `${GHOST_PREFIX}${row.targetTitle}`
    candidates.push({
      rowKey: `wikilink\u0000${rowKey}`,
      requiresBothNodes: true,
      edge: {
        id: `${row.sourceId}-${target}-wikilink`,
        source: row.sourceId,
        target,
        type: 'wikilink',
        weight: 1
      }
    })
  }

  const refColumns = {
    sourceNoteId: propertyRefs.sourceNoteId,
    propertyName: propertyRefs.propertyName,
    targetId: propertyRefs.targetId
  }
  const refRows = new Map<
    string,
    { sourceNoteId: string; propertyName: string; targetId: string }
  >()

  for (const batch of chunk(noteIds)) {
    for (const row of indexDb
      .select(refColumns)
      .from(propertyRefs)
      .where(and(eq(propertyRefs.targetType, 'note'), inArray(propertyRefs.sourceNoteId, batch)))
      .all()) {
      refRows.set(`${row.sourceNoteId}\u0000${row.propertyName}\u0000${row.targetId}`, row)
    }
    for (const row of indexDb
      .select(refColumns)
      .from(propertyRefs)
      .where(and(eq(propertyRefs.targetType, 'note'), inArray(propertyRefs.targetId, batch)))
      .all()) {
      refRows.set(`${row.sourceNoteId}\u0000${row.propertyName}\u0000${row.targetId}`, row)
    }
  }

  for (const [rowKey, row] of refRows) {
    candidates.push({
      rowKey: `relation\u0000${rowKey}`,
      requiresBothNodes: true,
      edge: {
        id: `${row.sourceNoteId}-${row.targetId}-relation`,
        source: row.sourceNoteId,
        target: row.targetId,
        type: 'relation',
        weight: 1
      }
    })
  }

  const taskNoteRows = new Map<string, { taskId: string; noteId: string }>()
  for (const batch of chunk(taskIds)) {
    for (const row of dataDb
      .select({ taskId: taskNotes.taskId, noteId: taskNotes.noteId })
      .from(taskNotes)
      .where(inArray(taskNotes.taskId, batch))
      .all()) {
      taskNoteRows.set(`${row.taskId}\u0000${row.noteId}`, row)
    }
  }
  for (const batch of chunk(noteIds)) {
    for (const row of dataDb
      .select({ taskId: taskNotes.taskId, noteId: taskNotes.noteId })
      .from(taskNotes)
      .where(inArray(taskNotes.noteId, batch))
      .all()) {
      taskNoteRows.set(`${row.taskId}\u0000${row.noteId}`, row)
    }
  }

  for (const [rowKey, row] of taskNoteRows) {
    candidates.push({
      rowKey: `task-note\u0000${rowKey}`,
      requiresBothNodes: true,
      edge: {
        id: `${row.taskId}-${row.noteId}-task-note`,
        source: row.taskId,
        target: row.noteId,
        type: 'task-note',
        weight: 1
      }
    })
  }

  return candidates
}

/**
 * The neighbourhood around `noteId` out to `depth` hops.
 *
 * Walks outwards one hop at a time with indexed lookups. It used to materialise the whole
 * vault graph — every note, task, project, link and ref — and then throw all but the
 * neighbourhood away, so opening a note's local graph cost the same on a 5k-note vault as
 * rendering the global graph.
 *
 * Edges incident to the outermost ring are still enumerated (without following them), because
 * `connectionCount` is a node's degree in the *whole* graph, not inside the returned slice.
 */
export function getLocalGraph(
  indexDb: IndexDb,
  dataDb: DataDb,
  noteId: string,
  depth: number
): GraphDataResponse {
  const state: TraversalState = {
    nodes: new Map(),
    resolved: new Set(),
    taskProjectIds: new Map()
  }
  resolveNodes(indexDb, dataDb, [noteId], state)

  const visited = new Set<string>([noteId])
  const edges = new Map<string, GraphEdge>()
  let frontier = [noteId]
  let level = 0

  while (frontier.length > 0) {
    const candidates = collectIncidentEdges(indexDb, dataDb, frontier, state)
    resolveNodes(
      indexDb,
      dataDb,
      candidates.flatMap((candidate) => [candidate.edge.source, candidate.edge.target]),
      state
    )

    const nextFrontier: string[] = []
    for (const { rowKey, edge, requiresBothNodes } of candidates) {
      if (requiresBothNodes && (!state.nodes.has(edge.source) || !state.nodes.has(edge.target))) {
        continue
      }
      if (!edges.has(rowKey)) edges.set(rowKey, edge)
      if (level >= depth) continue
      for (const endpoint of [edge.source, edge.target]) {
        if (visited.has(endpoint)) continue
        visited.add(endpoint)
        nextFrontier.push(endpoint)
      }
    }

    if (level >= depth) break
    level += 1
    frontier = nextFrontier
  }

  const connectionCounts = new Map<string, number>()
  for (const edge of edges.values()) {
    connectionCounts.set(edge.source, (connectionCounts.get(edge.source) ?? 0) + 1)
    connectionCounts.set(edge.target, (connectionCounts.get(edge.target) ?? 0) + 1)
  }

  const nodes: GraphNode[] = []
  for (const id of visited) {
    const node = state.nodes.get(id)
    if (!node) continue
    node.connectionCount = connectionCounts.get(id) ?? 0
    node.isOrphan = node.connectionCount === 0
    nodes.push(node)
  }

  const localEdges = [...edges.values()].filter(
    (edge) => visited.has(edge.source) && visited.has(edge.target)
  )

  return { nodes, edges: localEdges }
}
