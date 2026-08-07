import Graph from 'graphology'
import type { GraphDataResponse } from '@memry/contracts/graph-api'

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
  'entity-tag': '--graph-node-tag'
}

const EDGE_SIZES: Record<string, number> = {
  wikilink: 2,
  'task-note': 1.5,
  'project-task': 1.5,
  relation: 1.25,
  'entity-tag': 0.8
}

function resolveVar(varName: string, fallback = '#8c8c8c'): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return value || fallback
}

export interface BuildGraphOptions {
  showTags?: boolean
}

type GraphAttributes = Record<string, unknown>

interface SpecEdge {
  source: string
  target: string
  attributes: GraphAttributes
}

interface GraphSpec {
  nodes: Map<string, GraphAttributes>
  edges: Map<string, SpecEdge>
}

/** Owned by the force simulation, so a data refresh must never write over them. */
const LAYOUT_ATTRIBUTES = new Set(['x', 'y'])

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
        const tagNodeId = `tag:${tag}`
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

  return { nodes, edges }
}

export function buildGraphologyGraph(
  data: GraphDataResponse,
  options: BuildGraphOptions = {}
): Graph {
  const graph = new Graph({ multi: true, type: 'undirected' })
  const spec = buildGraphSpec(data, options)

  for (const [id, attributes] of spec.nodes) graph.addNode(id, attributes)
  for (const [key, edge] of spec.edges) {
    graph.addEdgeWithKey(key, edge.source, edge.target, edge.attributes)
  }

  return graph
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
  options: BuildGraphOptions = {}
): GraphSyncResult {
  const spec = buildGraphSpec(data, options)
  let changed = false
  let structureChanged = false

  for (const key of graph.edges()) {
    if (spec.edges.has(key)) continue
    graph.dropEdge(key)
    structureChanged = true
  }

  for (const id of graph.nodes()) {
    if (spec.nodes.has(id)) continue
    graph.dropNode(id)
    structureChanged = true
  }

  for (const [id, attributes] of spec.nodes) {
    if (!graph.hasNode(id)) {
      graph.addNode(id, attributes)
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

  return { changed: changed || structureChanged, structureChanged }
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
