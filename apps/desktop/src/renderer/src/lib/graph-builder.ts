import Graph from 'graphology'
import type { GraphDataResponse } from '@memry/contracts/graph-api'

const NODE_COLOR_VARS: Record<string, string> = {
  note: '--graph-node-note',
  journal: '--graph-node-journal',
  task: '--graph-node-task',
  project: '--graph-node-project'
}

const EDGE_COLOR_VARS: Record<string, string> = {
  wikilink: '--graph-edge-wikilink',
  'task-note': '--graph-edge-task-note',
  'project-task': '--graph-edge-project-task',
  'tag-cooccurrence': '--graph-edge-tag-cooccurrence'
}

const EDGE_SIZES: Record<string, number> = {
  wikilink: 2,
  'task-note': 1.5,
  'project-task': 1.5,
  'tag-cooccurrence': 0.8
}

function resolveVar(varName: string, fallback = '#8c8c8c'): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return value || fallback
}

export interface BuildGraphOptions {
  showTagEdges?: boolean
  nodeSizing?: 'uniform' | 'by-connections' | 'by-word-count'
}

export function buildGraphologyGraph(
  data: GraphDataResponse,
  options: BuildGraphOptions = {}
): Graph {
  const { showTagEdges = false, nodeSizing = 'uniform' } = options
  const graph = new Graph({ multi: true, type: 'undirected' })

  const ghostColor = resolveVar('--graph-ghost-node', '#c4c2bc')

  const resolvedNodeColors: Record<string, string> = {}
  for (const [type, varName] of Object.entries(NODE_COLOR_VARS)) {
    resolvedNodeColors[type] = resolveVar(varName)
  }

  const resolvedEdgeColors: Record<string, string> = {}
  for (const [type, varName] of Object.entries(EDGE_COLOR_VARS)) {
    resolvedEdgeColors[type] = resolveVar(varName)
  }

  for (const node of data.nodes) {
    const angle = Math.random() * 2 * Math.PI
    const radius = 100 + Math.random() * 400
    const color = node.isUnresolved
      ? ghostColor
      : (resolvedNodeColors[node.type] ?? resolvedNodeColors.note)

    graph.addNode(node.id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      size: computeNodeSize(node.connectionCount, node.wordCount, node.isUnresolved, nodeSizing),
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
    if (!showTagEdges && edge.type === 'tag-cooccurrence') continue
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      const edgeKey = `${edge.source}-${edge.target}-${edge.type}`
      if (!graph.hasEdge(edgeKey)) {
        graph.addEdgeWithKey(edgeKey, edge.source, edge.target, {
          size: EDGE_SIZES[edge.type] ?? 1,
          color: resolvedEdgeColors[edge.type] ?? defaultEdgeColor,
          edgeType: edge.type,
          weight: edge.weight
        })
      }
    }
  }

  return graph
}

function computeNodeSize(
  connectionCount: number,
  wordCount: number,
  isUnresolved: boolean,
  sizing: 'uniform' | 'by-connections' | 'by-word-count'
): number {
  if (isUnresolved) return 3
  switch (sizing) {
    case 'uniform':
      return 6
    case 'by-connections': {
      const base = 5
      return base + Math.min(connectionCount, 20) * 0.5
    }
    case 'by-word-count': {
      const base = 4
      return base + Math.min(wordCount / 100, 12)
    }
  }
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

export function extractAllTags(data: GraphDataResponse): string[] {
  const tagSet = new Set<string>()
  for (const node of data.nodes) {
    for (const tag of node.tags) {
      tagSet.add(tag)
    }
  }
  return Array.from(tagSet).sort()
}
