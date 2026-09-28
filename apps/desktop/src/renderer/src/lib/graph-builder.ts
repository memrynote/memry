import Graph from 'graphology'
import type { GraphDataResponse } from '@memry/contracts/graph-api'
import { PINNED_ATTRIBUTE, type NodePosition } from './graph-physics'

const NODE_COLOR_VARS: Record<string, string> = {
  note: '--graph-node-note',
  journal: '--graph-node-journal',
  task: '--graph-node-task',
  project: '--graph-node-project',
  tag: '--graph-node-tag'
}

const EDGE_COLOR_VARS: Record<string, string> = {
  wikilink: '--graph-edge-wikilink',
  'task-note': '--graph-edge-task-note',
  'project-task': '--graph-edge-project-task',
  canvas: '--graph-edge-canvas',
  'entity-tag': '--graph-node-tag'
}

const EDGE_SIZES: Record<string, number> = {
  wikilink: 2,
  'task-note': 1.5,
  'project-task': 1.5,
  relation: 1.25,
  canvas: 1.5,
  'entity-tag': 0.8
}

/**
 * Edge types that keep their own color when the graph paints every other edge
 * in the soft background tone. A canvas connection was drawn by hand, and it is
 * the one kind of edge that has no text in any note behind it.
 */
export function keepsOwnEdgeColor(attrs: Record<string, unknown>): boolean {
  return attrs.edgeType === 'canvas'
}

function resolveVar(varName: string, fallback = '#8c8c8c'): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return value || fallback
}

/** A tag category the user collapsed into one super-node. */
export interface CollapsedGraphGroup {
  /** The tag category id. The super-node's id is `groupNodeId(id)`. */
  id: string
  label: string
  color: string
  /** Every tag in the category. A node carrying any of them folds into the group. */
  tags: string[]
}

export interface BuildGraphOptions {
  showTags?: boolean
  /**
   * Collapsed tag categories, in category order. A node whose tags fall into
   * more than one collapsed category folds into the first.
   */
  collapsedGroups?: CollapsedGraphGroup[]
}

const GROUP_NODE_PREFIX = 'group:'

export const groupNodeId = (categoryId: string): string => `${GROUP_NODE_PREFIX}${categoryId}`

const TAG_NODE_PREFIX = 'tag:'

/** The tag a `tag:<name>` node stands for, or null for any other node. */
export const tagOfTagNode = (nodeId: string): string | null =>
  nodeId.startsWith(TAG_NODE_PREFIX) ? nodeId.slice(TAG_NODE_PREFIX.length) : null

type GraphAttributes = Record<string, unknown>

interface SpecEdge {
  source: string
  target: string
  attributes: GraphAttributes
}

interface GraphSpec {
  nodes: Map<string, GraphAttributes>
  edges: Map<string, SpecEdge>
  /** Super-node id -> the node ids folded into it. Empty when nothing is collapsed. */
  groupMembers: Map<string, string[]>
}

/** Owned by the force simulation, so a data refresh must never write over them. */
const LAYOUT_ATTRIBUTES = new Set(['x', 'y', PINNED_ATTRIBUTE])

/** How far from its neighbours' centre a newly placed node lands, in graph units. */
const NEIGHBOUR_JITTER = 20

/** The shape `data` should have on screen, independent of any existing graph. */
function buildGraphSpec(data: GraphDataResponse, options: BuildGraphOptions): GraphSpec {
  const { showTags = true } = options
  const nodes = new Map<string, GraphAttributes>()
  const edges = new Map<string, SpecEdge>()

  const ghostColor = resolveVar('--graph-ghost-node', '#c4c2bc')

  const resolvedNodeColors: Record<string, string> = {}
  for (const [type, varName] of Object.entries(NODE_COLOR_VARS)) {
    resolvedNodeColors[type] = resolveVar(varName)
  }

  const resolvedEdgeColors: Record<string, string> = {}
  for (const [type, varName] of Object.entries(EDGE_COLOR_VARS)) {
    resolvedEdgeColors[type] = resolveVar(varName)
  }

  // Seeded near the scale the force simulation settles at, so the opening frames
  // read as the graph organising itself rather than imploding from a huge cloud.
  const spread = Math.max(60, Math.sqrt(data.nodes.length) * 30)

  for (const node of data.nodes) {
    const angle = Math.random() * 2 * Math.PI
    const radius = spread * 0.2 + Math.random() * spread * 0.8
    const color = node.isUnresolved
      ? ghostColor
      : (resolvedNodeColors[node.type] ?? resolvedNodeColors.note)

    nodes.set(node.id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      size: computeNodeSize(node.connectionCount, node.isUnresolved),
      color,
      label: node.label,
      nodeType: node.type,
      tags: node.tags,
      wordCount: node.wordCount,
      connectionCount: node.connectionCount,
      emoji: node.emoji,
      isOrphan: node.isOrphan,
      isUnresolved: node.isUnresolved
    })
  }

  const defaultEdgeColor = resolvedEdgeColors.wikilink
  for (const edge of data.edges) {
    if (edge.type === 'tag-cooccurrence') continue
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue
    const edgeKey = `${edge.source}-${edge.target}-${edge.type}`
    if (edges.has(edgeKey)) continue
    edges.set(edgeKey, {
      source: edge.source,
      target: edge.target,
      attributes: {
        size: EDGE_SIZES[edge.type] ?? 1,
        color: resolvedEdgeColors[edge.type] ?? defaultEdgeColor,
        edgeType: edge.type,
        weight: edge.weight
      }
    })
  }

  if (showTags) {
    const tagColor = resolvedNodeColors.tag
    const tagEdgeColor = resolvedEdgeColors['entity-tag']
    const tagDegrees = new Map<string, number>()

    for (const node of data.nodes) {
      for (const tag of node.tags) {
        const tagNodeId = `${TAG_NODE_PREFIX}${tag}`
        if (!nodes.has(tagNodeId)) {
          const angle = Math.random() * 2 * Math.PI
          const radius = spread * 0.3 + Math.random() * spread * 0.7
          nodes.set(tagNodeId, {
            x: Math.cos(angle) * radius,
            y: Math.sin(angle) * radius,
            size: 3,
            color: tagColor,
            label: `#${tag}`,
            nodeType: 'tag',
            tags: [],
            wordCount: 0,
            connectionCount: 0,
            emoji: null,
            isOrphan: false,
            isUnresolved: false
          })
          tagDegrees.set(tagNodeId, 0)
        }

        const edgeKey = `${node.id}-${tagNodeId}-entity-tag`
        if (edges.has(edgeKey)) continue
        edges.set(edgeKey, {
          source: node.id,
          target: tagNodeId,
          attributes: {
            size: EDGE_SIZES['entity-tag'],
            color: tagEdgeColor,
            edgeType: 'entity-tag',
            weight: 1
          }
        })
        tagDegrees.set(tagNodeId, (tagDegrees.get(tagNodeId) ?? 0) + 1)
      }
    }

    for (const [tagNodeId, degree] of tagDegrees) {
      const attributes = nodes.get(tagNodeId)
      if (!attributes) continue
      attributes.size = degree <= 1 ? 3 : 3 + Math.log2(degree) * 2
      attributes.connectionCount = degree
    }
  }

  return collapseGroups({ nodes, edges, groupMembers: new Map() }, options.collapsedGroups ?? [])
}

/**
 * Fold every member of a collapsed category into one super-node.
 *
 * Members leave the spec entirely, so the layout simulates the super-node
 * alone. Every edge with exactly one end inside a group is redirected to the
 * super-node, and parallel redirected edges merge into one whose weight is how
 * many they replaced. Edges between two members of the same group disappear.
 */
function collapseGroups(spec: GraphSpec, groups: CollapsedGraphGroup[]): GraphSpec {
  if (groups.length === 0) return spec

  const groupIndexByTag = new Map<string, number>()
  groups.forEach((group, index) => {
    for (const tag of group.tags) {
      if (!groupIndexByTag.has(tag)) groupIndexByTag.set(tag, index)
    }
  })

  const memberOf = new Map<string, string>()
  const groupMembers = new Map<string, string[]>()
  for (const [id, attributes] of spec.nodes) {
    const tagOfNode = tagOfTagNode(id)
    const tags = tagOfNode !== null ? [tagOfNode] : ((attributes.tags as string[]) ?? [])
    let index: number | undefined
    for (const tag of tags) {
      const candidate = groupIndexByTag.get(tag)
      if (candidate !== undefined && (index === undefined || candidate < index)) index = candidate
    }
    if (index === undefined) continue
    const groupId = groupNodeId(groups[index].id)
    memberOf.set(id, groupId)
    const members = groupMembers.get(groupId)
    if (members) members.push(id)
    else groupMembers.set(groupId, [id])
  }

  if (memberOf.size === 0) return spec

  const nodes = new Map<string, GraphAttributes>()
  for (const [id, attributes] of spec.nodes) {
    if (!memberOf.has(id)) nodes.set(id, attributes)
  }

  for (const group of groups) {
    const id = groupNodeId(group.id)
    const members = groupMembers.get(id)
    if (!members) continue
    // The members' seed positions are random, so their centroid is a fresh
    // random-ish point too; a sync onto a live graph overrides it with the
    // centroid of where the members actually sat.
    let x = 0
    let y = 0
    for (const member of members) {
      const attributes = spec.nodes.get(member)
      x += (attributes?.x as number) ?? 0
      y += (attributes?.y as number) ?? 0
    }
    nodes.set(id, {
      x: x / members.length,
      y: y / members.length,
      size: 5 + Math.log2(members.length + 1) * 3,
      color: group.color,
      label: `${group.label} (${members.length})`,
      groupLabel: group.label,
      nodeType: 'group',
      categoryId: group.id,
      memberCount: members.length,
      tags: group.tags,
      wordCount: 0,
      connectionCount: 0,
      emoji: null,
      isOrphan: false,
      isUnresolved: false
    })
  }

  const edges = new Map<string, SpecEdge>()
  const groupDegree = new Map<string, number>()
  for (const [key, edge] of spec.edges) {
    const source = memberOf.get(edge.source) ?? edge.source
    const target = memberOf.get(edge.target) ?? edge.target
    if (source === edge.source && target === edge.target) {
      edges.set(key, edge)
      continue
    }
    if (source === target) continue
    const [a, b] = source < target ? [source, target] : [target, source]
    const groupEdgeKey = `${GROUP_NODE_PREFIX}edge:${a}|${b}`
    const existing = edges.get(groupEdgeKey)
    if (existing) {
      const weight = (existing.attributes.weight as number) + 1
      existing.attributes.weight = weight
      existing.attributes.size = Math.min(4, 1 + Math.log2(weight))
      continue
    }
    edges.set(groupEdgeKey, {
      source: a,
      target: b,
      attributes: { ...edge.attributes, size: 1, edgeType: 'group', weight: 1 }
    })
    for (const end of [a, b]) {
      if (groupMembers.has(end)) groupDegree.set(end, (groupDegree.get(end) ?? 0) + 1)
    }
  }

  for (const [id, degree] of groupDegree) {
    const attributes = nodes.get(id)
    if (attributes) attributes.connectionCount = degree
  }

  return { nodes, edges, groupMembers }
}

/**
 * Build the graph for `data`. With a saved `layout`, every node it knows about
 * starts where it was saved (pins included) and nodes added since are placed
 * next to their saved neighbours, so the reopened graph looks like the last one.
 */
export function buildGraphologyGraph(
  data: GraphDataResponse,
  options: BuildGraphOptions = {},
  layout?: Readonly<Record<string, NodePosition>> | null
): Graph {
  const graph = new Graph({ multi: true, type: 'undirected' })
  const spec = buildGraphSpec(data, options)

  for (const [id, attributes] of spec.nodes) graph.addNode(id, attributes)
  for (const [key, edge] of spec.edges) {
    graph.addEdgeWithKey(key, edge.source, edge.target, edge.attributes)
  }

  if (layout) {
    const placed = new Set<string>()
    const unplaced: string[] = []
    graph.forEachNode((id) => {
      const saved = layout[id]
      if (!saved) {
        unplaced.push(id)
        return
      }
      graph.mergeNodeAttributes(id, { x: saved.x, y: saved.y })
      if (saved.pinned) graph.setNodeAttribute(id, PINNED_ATTRIBUTE, true)
      placed.add(id)
    })
    placeNearNeighbours(graph, unplaced, (id) => placed.has(id))
  }

  return graph
}

/**
 * Move each node in `ids` next to the centre of its neighbours that are in
 * `isAnchor`. A node with no anchored neighbour keeps its seeded position.
 */
function placeNearNeighbours(
  graph: Graph,
  ids: readonly string[],
  isAnchor: (id: string) => boolean
): void {
  for (const id of ids) {
    let sumX = 0
    let sumY = 0
    let count = 0
    graph.forEachNeighbor(id, (neighbour, attrs) => {
      if (!isAnchor(neighbour)) return
      sumX += attrs.x as number
      sumY += attrs.y as number
      count++
    })
    if (count === 0) continue
    const angle = Math.random() * 2 * Math.PI
    graph.mergeNodeAttributes(id, {
      x: sumX / count + Math.cos(angle) * NEIGHBOUR_JITTER,
      y: sumY / count + Math.sin(angle) * NEIGHBOUR_JITTER
    })
  }
}

export interface GraphSyncResult {
  /** Anything at all moved — nodes, edges, or their attributes. */
  changed: boolean
  /** Nodes or edges were added or removed, so the layout has to react. */
  structureChanged: boolean
}

/**
 * Fold a fresh `data` payload into a graph that is already on screen.
 *
 * Rebuilding the graph would hand `SigmaContainer` a new instance, which kills
 * the renderer and its WebGL context and restarts the layout from scratch —
 * once per note save. Patching keeps the same instance (and the same settled
 * positions) and lets sigma repaint from graphology's own change events.
 */
export function syncGraphologyGraph(
  graph: Graph,
  data: GraphDataResponse,
  options: BuildGraphOptions = {},
  positionCache: GraphPositionCache = createGraphPositionCache()
): GraphSyncResult {
  const spec = buildGraphSpec(data, options)
  let changed = false
  let structureChanged = false
  const added: string[] = []

  const placements = placeArrivingNodes(graph, spec, positionCache)

  for (const key of graph.edges()) {
    if (spec.edges.has(key)) continue
    graph.dropEdge(key)
    structureChanged = true
  }

  for (const id of graph.nodes()) {
    if (spec.nodes.has(id)) continue
    // A pin survives the node leaving: expanding a collapsed category must not
    // silently release what the user pinned inside it.
    const pinned = graph.getNodeAttribute(id, PINNED_ATTRIBUTE) === true
    positionCache.positions.set(id, { ...readPosition(graph, id), ...(pinned && { pinned }) })
    positionCache.groupOrigins.delete(id)
    graph.dropNode(id)
    structureChanged = true
  }

  for (const [id, attributes] of spec.nodes) {
    if (!graph.hasNode(id)) {
      const placed = placements.get(id)
      graph.addNode(id, placed ? { ...attributes, ...placed } : attributes)
      // A node coming back from a collapsed category already knows where it sat.
      if (!placed) added.push(id)
      structureChanged = true
      continue
    }
    const patch = diffAttributes(graph.getNodeAttributes(id), attributes, LAYOUT_ATTRIBUTES)
    if (patch) {
      graph.mergeNodeAttributes(id, patch)
      changed = true
    }
  }

  for (const [key, edge] of spec.edges) {
    if (!graph.hasEdge(key)) {
      graph.addEdgeWithKey(key, edge.source, edge.target, edge.attributes)
      structureChanged = true
      continue
    }
    const patch = diffAttributes(graph.getEdgeAttributes(key), edge.attributes)
    if (patch) {
      graph.mergeEdgeAttributes(key, patch)
      changed = true
    }
  }

  // A new note or link lands beside what it connects to instead of at a random
  // spot, so the settled layout around it barely has to move.
  if (added.length > 0) {
    const addedSet = new Set(added)
    placeNearNeighbours(graph, added, (id) => !addedSet.has(id))
  }

  return { changed: changed || structureChanged, structureChanged }
}

export interface GraphPosition {
  x: number
  y: number
  /** Set on a cached position whose node was pinned when it left the graph. */
  pinned?: boolean
}

/**
 * What the graph remembers about nodes that left it, so a collapse that is
 * undone puts the members back instead of scattering them at random. Owned by
 * the caller so it outlives one sync.
 */
export interface GraphPositionCache {
  /** Last position of every node that was dropped from the graph. */
  positions: Map<string, GraphPosition>
  /** Super-node id -> the centroid it was created at. */
  groupOrigins: Map<string, GraphPosition>
  /** Member id -> the super-node it was folded into. */
  memberGroup: Map<string, string>
}

export function createGraphPositionCache(): GraphPositionCache {
  return { positions: new Map(), groupOrigins: new Map(), memberGroup: new Map() }
}

function readPosition(graph: Graph, id: string): GraphPosition {
  return {
    x: graph.getNodeAttribute(id, 'x') as number,
    y: graph.getNodeAttribute(id, 'y') as number
  }
}

/**
 * Positions for nodes about to be added, measured against the graph BEFORE the
 * sync drops anything:
 *
 * - A new super-node sits at the centroid of the members it swallows, so the
 *   group appears where its members were.
 * - A member coming back out of a super-node returns to where it sat before
 *   the collapse, shifted by however far the super-node moved since.
 * - Anything else seen before returns to its last position.
 */
function placeArrivingNodes(
  graph: Graph,
  spec: GraphSpec,
  cache: GraphPositionCache
): Map<string, GraphPosition> {
  const placements = new Map<string, GraphPosition>()

  for (const [groupId, members] of spec.groupMembers) {
    if (graph.hasNode(groupId)) continue
    const present = members.filter((id) => graph.hasNode(id))
    for (const id of members) cache.memberGroup.set(id, groupId)
    if (present.length === 0) continue
    let x = 0
    let y = 0
    for (const id of present) {
      const position = readPosition(graph, id)
      x += position.x
      y += position.y
    }
    const centroid = { x: x / present.length, y: y / present.length }
    placements.set(groupId, centroid)
    cache.groupOrigins.set(groupId, centroid)
  }

  for (const id of spec.nodes.keys()) {
    if (graph.hasNode(id) || placements.has(id)) continue
    const cached = cache.positions.get(id)
    if (!cached) continue
    const groupId = cache.memberGroup.get(id)
    const origin = groupId ? cache.groupOrigins.get(groupId) : undefined
    // A pinned member goes back exactly where the user put it; the rest follow
    // the super-node.
    if (!cached.pinned && groupId && origin && graph.hasNode(groupId) && !spec.nodes.has(groupId)) {
      const current = readPosition(graph, groupId)
      placements.set(id, {
        ...cached,
        x: cached.x + current.x - origin.x,
        y: cached.y + current.y - origin.y
      })
    } else {
      placements.set(id, cached)
    }
    cache.memberGroup.delete(id)
  }

  return placements
}

/** Only the attributes that actually differ, so sigma is not woken for a no-op. */
function diffAttributes(
  current: GraphAttributes,
  next: GraphAttributes,
  skip?: Set<string>
): GraphAttributes | null {
  let patch: GraphAttributes | null = null

  for (const key of Object.keys(next)) {
    if (skip?.has(key)) continue
    if (isSameAttribute(current[key], next[key])) continue
    patch ??= {}
    patch[key] = next[key]
  }

  return patch
}

function isSameAttribute(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => Object.is(item, b[index]))
  }
  return false
}

function computeNodeSize(connectionCount: number, isUnresolved: boolean): number {
  if (isUnresolved) return 2
  if (connectionCount <= 1) return 3
  return 3 + Math.log2(connectionCount) * 2
}

export function computeFocusSet(graph: Graph, nodeId: string, depth: number): Set<string> {
  if (!graph.hasNode(nodeId)) return new Set()

  const visited = new Set<string>([nodeId])
  let frontier = [nodeId]

  for (let d = 0; d < depth; d++) {
    const nextFrontier: string[] = []
    for (const node of frontier) {
      for (const neighbor of graph.neighbors(node)) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor)
          nextFrontier.push(neighbor)
        }
      }
    }
    frontier = nextFrontier
    if (frontier.length === 0) break
  }

  return visited
}
