import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphDataResponse } from '@memry/contracts/graph-api'

import { buildGraphologyGraph, computeFocusSet } from './graph-builder'

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

    expect(mocks.assign).toHaveBeenCalledWith(
      graph,
      expect.objectContaining({
        iterations: expect.any(Number),
        settings: expect.objectContaining({
          gravity: 0.5,
          barnesHutOptimize: false
        })
      })
    )
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
