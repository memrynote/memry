import Graph from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'
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
  'entity-tag': 0.8
}

function resolveVar(varName: string, fallback = '#8c8c8c'): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return value || fallback
}

export interface BuildGraphOptions {
  showTags?: boolean
}

export function buildGraphologyGraph(
  data: GraphDataResponse,
  options: BuildGraphOptions = {}
): Graph {
  const { showTags = true } = options
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

  const spread = Math.max(800, Math.sqrt(data.nodes.length) * 100)

  for (const node of data.nodes) {
    const angle = Math.random() * 2 * Math.PI
    const radius = spread * 0.2 + Math.random() * spread * 0.8
    const color = node.isUnresolved
      ? ghostColor
      : (resolvedNodeColors[node.type] ?? resolvedNodeColors.note)

    graph.addNode(node.id, {
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

  if (showTags) {
    const tagColor = resolvedNodeColors.tag
    const tagEdgeColor = resolvedEdgeColors['entity-tag']
    const tagNodeIds = new Map<string, string>()

    for (const node of data.nodes) {
      for (const tag of node.tags) {
        let tagNodeId = tagNodeIds.get(tag)
        if (!tagNodeId) {
          tagNodeId = `tag:${tag}`
          tagNodeIds.set(tag, tagNodeId)
          const angle = Math.random() * 2 * Math.PI
          const radius = spread * 0.3 + Math.random() * spread * 0.7
          graph.addNode(tagNodeId, {
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
        }

        const edgeKey = `${node.id}-${tagNodeId}-entity-tag`
        if (!graph.hasEdge(edgeKey)) {
          graph.addEdgeWithKey(edgeKey, node.id, tagNodeId, {
            size: EDGE_SIZES['entity-tag'],
            color: tagEdgeColor,
            edgeType: 'entity-tag',
            weight: 1
          })
        }
      }
    }

    for (const [, tagNodeId] of tagNodeIds) {
      const degree = graph.degree(tagNodeId)
      const tagSize = degree <= 1 ? 3 : 3 + Math.log2(degree) * 2
      graph.setNodeAttribute(tagNodeId, 'size', tagSize)
      graph.setNodeAttribute(tagNodeId, 'connectionCount', degree)
    }
  }

  if (graph.order > 1) {
    const iterations = Math.min(150, Math.max(50, 600 / Math.sqrt(graph.order)))
    forceAtlas2.assign(graph, {
      iterations,
      settings: {
        gravity: 0.5,
        scalingRatio: 12,
        slowDown: 5,
        barnesHutOptimize: graph.order > 100,
        strongGravityMode: true,
        edgeWeightInfluence: 0
      }
    })
  }

  return graph
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
