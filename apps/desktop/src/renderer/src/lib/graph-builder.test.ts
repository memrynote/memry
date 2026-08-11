import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphDataResponse } from '@memry/contracts/graph-api'

import { buildGraphologyGraph, computeFocusSet, syncGraphologyGraph } from './graph-builder'

const mocks = vi.hoisted(() => ({
  assign: vi.fn()
}))

vi.mock('graphology-layout-forceatlas2', () => ({
  default: {
    assign: mocks.assign
  }
}))

const graphData: GraphDataResponse = {
  nodes: [
    {
      id: 'note-a',
      type: 'note',
      label: 'Alpha',
      tags: ['shared', 'alpha'],
      wordCount: 100,
      connectionCount: 4,
      emoji: 'A',
      isOrphan: false,
      isUnresolved: false
    },
    {
      id: 'note-b',
      type: 'note',
      label: 'Beta',
      tags: ['shared'],
      wordCount: 25,
      connectionCount: 1,
      emoji: null,
      isOrphan: false,
      isUnresolved: false
    },
    {
      id: 'ghost',
      type: 'note',
      label: 'Missing',
      tags: [],
      wordCount: 0,
      connectionCount: 0,
      emoji: null,
      isOrphan: true,
      isUnresolved: true
    },
    {
      id: 'task-1',
      type: 'task',
      label: 'Task',
      tags: [],
      wordCount: 0,
      connectionCount: 2,
      emoji: null,
      isOrphan: false,
      isUnresolved: false
    }
  ],
  edges: [
    { source: 'note-a', target: 'note-b', type: 'wikilink', weight: 2 },
    { source: 'note-a', target: 'note-b', type: 'wikilink', weight: 2 },
    { source: 'note-a', target: 'task-1', type: 'task-note', weight: 1 },
    { source: 'note-a', target: 'missing', type: 'wikilink', weight: 1 },
    { source: 'note-a', target: 'note-b', type: 'tag-cooccurrence', weight: 3 },
    { source: 'note-b', target: 'note-a', type: 'relation', weight: 1 }
  ]
}

describe('graph-builder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.documentElement.style.setProperty('--graph-node-note', '#111111')
    document.documentElement.style.setProperty('--graph-node-task', '#222222')
    document.documentElement.style.setProperty('--graph-node-tag', '#333333')
    document.documentElement.style.setProperty('--graph-edge-wikilink', '#444444')
    document.documentElement.style.setProperty('--graph-edge-task-note', '#555555')
    document.documentElement.style.setProperty('--graph-ghost-node', '#666666')
  })

  it('builds entity nodes, typed edges, resolved colors, and tag nodes', () => {
    const graph = buildGraphologyGraph(graphData)

    expect(graph.hasNode('note-a')).toBe(true)
    expect(graph.getNodeAttribute('note-a', 'color')).toBe('#111111')
    expect(graph.getNodeAttribute('note-a', 'size')).toBe(7)
    expect(graph.getNodeAttribute('ghost', 'color')).toBe('#666666')
    expect(graph.getNodeAttribute('ghost', 'size')).toBe(2)

    expect(graph.hasEdge('note-a-note-b-wikilink')).toBe(true)
    expect(graph.getEdgeAttribute('note-a-note-b-wikilink', 'color')).toBe('#444444')
    expect(graph.getEdgeAttribute('note-a-note-b-wikilink', 'size')).toBe(2)
    expect(graph.getEdgeAttribute('note-a-task-1-task-note', 'size')).toBe(1.5)

    // Relation edges are deliberately drawn thinner than wikilinks while
    // staying the same grey (no dedicated color token) — see task-13 report
    // fix round 2.
    expect(graph.hasEdge('note-b-note-a-relation')).toBe(true)
    expect(graph.getEdgeAttribute('note-b-note-a-relation', 'color')).toBe('#444444')
    expect(graph.getEdgeAttribute('note-b-note-a-relation', 'size')).toBe(1.25)
    expect(graph.getEdgeAttribute('note-b-note-a-relation', 'size')).toBeLessThan(
      graph.getEdgeAttribute('note-a-note-b-wikilink', 'size')
    )

    expect(graph.size).toBe(6)

    expect(graph.hasNode('tag:shared')).toBe(true)
    expect(graph.getNodeAttribute('tag:shared', 'label')).toBe('#shared')
    expect(graph.getNodeAttribute('tag:shared', 'connectionCount')).toBe(2)
    expect(graph.getNodeAttribute('tag:shared', 'size')).toBe(5)
    expect(graph.hasEdge('note-a-tag:shared-entity-tag')).toBe(true)
  })

  it('does not bake a static layout — positions are left to the live simulation', () => {
    buildGraphologyGraph(graphData)

    expect(mocks.assign).not.toHaveBeenCalled()
  })

  it('seeds every node at a finite position inside the simulation scale', () => {
    const graph = buildGraphologyGraph(graphData)
    const seedLimit = Math.max(60, Math.sqrt(graph.order) * 30)

    graph.forEachNode((node) => {
      const x = graph.getNodeAttribute(node, 'x') as number
      const y = graph.getNodeAttribute(node, 'y') as number
      expect(Number.isFinite(x)).toBe(true)
      expect(Number.isFinite(y)).toBe(true)
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(seedLimit)
    })
  })

  it('can omit tag expansion and falls back when CSS variables are absent', () => {
    document.documentElement.style.removeProperty('--graph-node-note')
    document.documentElement.style.removeProperty('--graph-edge-wikilink')

    const graph = buildGraphologyGraph(graphData, { showTags: false })

    expect(graph.hasNode('tag:shared')).toBe(false)
    expect(graph.hasEdge('note-a-tag:shared-entity-tag')).toBe(false)
    expect(graph.getNodeAttribute('note-a', 'color')).toBe('#8c8c8c')
    expect(graph.getEdgeAttribute('note-a-note-b-wikilink', 'color')).toBe('#8c8c8c')
  })

  describe('syncGraphologyGraph', () => {
    const gamma: GraphDataResponse['nodes'][number] = {
      id: 'note-c',
      type: 'note',
      label: 'Gamma',
      tags: [],
      wordCount: 10,
      connectionCount: 1,
      emoji: null,
      isOrphan: false,
      isUnresolved: false
    }

    it('adds new nodes and edges while leaving settled positions alone', () => {
      const graph = buildGraphologyGraph(graphData)
      graph.setNodeAttribute('note-a', 'x', 123)
      graph.setNodeAttribute('note-a', 'y', -45)

      const result = syncGraphologyGraph(graph, {
        nodes: [...graphData.nodes, gamma],
        edges: [...graphData.edges, { source: 'note-a', target: 'note-c', type: 'wikilink' }]
      })

      expect(result).toEqual({ changed: true, structureChanged: true })
      expect(graph.hasNode('note-c')).toBe(true)
      expect(graph.hasEdge('note-a-note-c-wikilink')).toBe(true)
      expect(graph.getNodeAttribute('note-a', 'x')).toBe(123)
      expect(graph.getNodeAttribute('note-a', 'y')).toBe(-45)
    })

    it('drops nodes and their edges when they leave the data', () => {
      const graph = buildGraphologyGraph(graphData)

      const result = syncGraphologyGraph(graph, {
        nodes: graphData.nodes.filter((node) => node.id !== 'task-1'),
        edges: graphData.edges
      })

      expect(result.structureChanged).toBe(true)
      expect(graph.hasNode('task-1')).toBe(false)
      expect(graph.hasEdge('note-a-task-1-task-note')).toBe(false)
      expect(graph.hasNode('note-a')).toBe(true)
    })

    it('drops an unlinked edge but keeps both endpoints', () => {
      const graph = buildGraphologyGraph(graphData)

      const result = syncGraphologyGraph(graph, {
        nodes: graphData.nodes,
        edges: graphData.edges.filter((edge) => edge.type !== 'task-note')
      })

      expect(result.structureChanged).toBe(true)
      expect(graph.hasEdge('note-a-task-1-task-note')).toBe(false)
      expect(graph.hasNode('task-1')).toBe(true)
    })

    it('renames a node in place without disturbing the layout', () => {
      const graph = buildGraphologyGraph(graphData)
      graph.setNodeAttribute('note-a', 'x', 77)

      const result = syncGraphologyGraph(graph, {
        nodes: graphData.nodes.map((node) =>
          node.id === 'note-a' ? { ...node, label: 'Renamed' } : node
        ),
        edges: graphData.edges
      })

      expect(result).toEqual({ changed: true, structureChanged: false })
      expect(graph.getNodeAttribute('note-a', 'label')).toBe('Renamed')
      expect(graph.getNodeAttribute('note-a', 'x')).toBe(77)
    })

    it('reports nothing changed when an identical payload arrives', () => {
      const graph = buildGraphologyGraph(graphData)

      const result = syncGraphologyGraph(graph, {
        nodes: graphData.nodes.map((node) => ({ ...node, tags: [...node.tags] })),
        edges: graphData.edges.map((edge) => ({ ...edge }))
      })

      expect(result).toEqual({ changed: false, structureChanged: false })
    })

    it('honours the tag toggle when patching', () => {
      const graph = buildGraphologyGraph(graphData)
      expect(graph.hasNode('tag:shared')).toBe(true)

      const result = syncGraphologyGraph(graph, graphData, { showTags: false })

      expect(result.structureChanged).toBe(true)
      expect(graph.hasNode('tag:shared')).toBe(false)
    })
  })

  it('computes focus neighborhoods by graph distance', () => {
    const graph = buildGraphologyGraph(graphData)

    expect(computeFocusSet(graph, 'missing-id', 2)).toEqual(new Set())
    expect(computeFocusSet(graph, 'note-a', 0)).toEqual(new Set(['note-a']))
    expect(computeFocusSet(graph, 'note-a', 1)).toEqual(
      new Set(['note-a', 'note-b', 'task-1', 'tag:shared', 'tag:alpha'])
    )
    expect(computeFocusSet(graph, 'task-1', 2)).toEqual(
      new Set(['task-1', 'note-a', 'note-b', 'tag:shared', 'tag:alpha'])
    )
  })
})
