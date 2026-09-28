import { describe, expect, it } from 'vitest'
import type { GraphDataResponse, GraphNode } from '@memry/contracts/graph-api'
import {
  buildGraphologyGraph,
  createGraphPositionCache,
  groupNodeId,
  syncGraphologyGraph,
  type BuildGraphOptions,
  type CollapsedGraphGroup
} from './graph-builder'
import { buildGraphCategoryIndex, categoryRankOf } from './graph-categories'

const node = (id: string, tags: string[]): GraphNode => ({
  id,
  type: 'note',
  label: id,
  tags,
  wordCount: 0,
  connectionCount: 0,
  emoji: null,
  color: '#000000',
  isOrphan: false,
  isUnresolved: false
})

// work: a, b   home: c   none: d
const data: GraphDataResponse = {
  nodes: [node('a', ['job']), node('b', ['job', 'kids']), node('c', ['kids']), node('d', [])],
  edges: [
    { id: 'e1', source: 'a', target: 'b', type: 'wikilink', weight: 1 },
    { id: 'e2', source: 'a', target: 'd', type: 'wikilink', weight: 1 },
    { id: 'e3', source: 'b', target: 'd', type: 'wikilink', weight: 1 },
    { id: 'e4', source: 'c', target: 'd', type: 'wikilink', weight: 1 }
  ]
}

const work: CollapsedGraphGroup = { id: 'work', label: 'Work', color: '#111111', tags: ['job'] }
const home: CollapsedGraphGroup = { id: 'home', label: 'Home', color: '#222222', tags: ['kids'] }

const options = (groups: CollapsedGraphGroup[]): BuildGraphOptions => ({
  showTags: false,
  collapsedGroups: groups
})

describe('collapsed tag categories', () => {
  it('folds members into one super-node and aggregates their outside edges', () => {
    const graph = buildGraphologyGraph(data, options([work]))

    expect(graph.hasNode('a')).toBe(false)
    expect(graph.hasNode('b')).toBe(false)
    expect(graph.hasNode('c')).toBe(true)

    const group = groupNodeId('work')
    expect(graph.getNodeAttributes(group)).toMatchObject({
      nodeType: 'group',
      categoryId: 'work',
      memberCount: 2,
      label: 'Work (2)',
      color: '#111111'
    })
    // a-d and b-d become one edge of weight 2; the internal a-b edge is gone.
    const edges = graph.edges(group, 'd')
    expect(edges).toHaveLength(1)
    expect(graph.getEdgeAttribute(edges[0], 'weight')).toBe(2)
    expect(graph.size).toBe(2)
  })

  it('puts a node in two collapsed categories into the first one', () => {
    const graph = buildGraphologyGraph(data, options([home, work]))
    expect(graph.getNodeAttribute(groupNodeId('home'), 'memberCount')).toBe(2)
    expect(graph.getNodeAttribute(groupNodeId('work'), 'memberCount')).toBe(1)
  })

  it('folds tag nodes of a collapsed category too', () => {
    const graph = buildGraphologyGraph(data, { showTags: true, collapsedGroups: [work] })
    expect(graph.hasNode('tag:job')).toBe(false)
    expect(graph.hasNode('tag:kids')).toBe(true)
    // b carries both tags, so its edge to #kids now leaves the work group.
    expect(graph.edges(groupNodeId('work'), 'tag:kids')).toHaveLength(1)
  })

  it('creates no super-node for a category with no members', () => {
    const empty: CollapsedGraphGroup = { id: 'x', label: 'X', color: '#000000', tags: ['none'] }
    const graph = buildGraphologyGraph(data, options([empty]))
    expect(graph.hasNode(groupNodeId('x'))).toBe(false)
    expect(graph.order).toBe(4)
  })

  it('collapses at the members centroid and restores them where they sat, shifted with the group', () => {
    const graph = buildGraphologyGraph(data, options([]))
    const cache = createGraphPositionCache()
    graph.mergeNodeAttributes('a', { x: 0, y: 0 })
    graph.mergeNodeAttributes('b', { x: 10, y: 20 })
    graph.mergeNodeAttributes('c', { x: 500, y: 500 })

    const collapsed = syncGraphologyGraph(graph, data, options([work]), cache)
    expect(collapsed.structureChanged).toBe(true)
    const group = groupNodeId('work')
    expect(graph.getNodeAttribute(group, 'x')).toBe(5)
    expect(graph.getNodeAttribute(group, 'y')).toBe(10)

    // The user drags the super-node, and an unrelated node stays put.
    graph.mergeNodeAttributes(group, { x: 105, y: 10 })

    syncGraphologyGraph(graph, data, options([]), cache)
    expect(graph.hasNode(group)).toBe(false)
    expect(graph.getNodeAttributes('a')).toMatchObject({ x: 100, y: 0 })
    expect(graph.getNodeAttributes('b')).toMatchObject({ x: 110, y: 20 })
    expect(graph.getNodeAttributes('c')).toMatchObject({ x: 500, y: 500 })
    expect(graph.edges('a', 'b')).toHaveLength(1)
  })
})

describe('graph categories', () => {
  const index = buildGraphCategoryIndex([
    { id: 'work', name: 'Work', tags: [{ tag: 'job' }] },
    { id: 'home', name: 'Home', tags: [{ tag: 'kids' }] }
  ])

  it('assigns palette slots by category order', () => {
    expect(index.categories.map((category) => category.colorVar)).toEqual([
      '--graph-group-1',
      '--graph-group-2'
    ])
  })

  it('ranks a node by its first category and a tag node by its own tag', () => {
    expect(categoryRankOf('b', ['kids', 'job'], index.rankByTag)).toBe(0)
    expect(categoryRankOf('c', ['kids'], index.rankByTag)).toBe(1)
    expect(categoryRankOf('d', [], index.rankByTag)).toBeUndefined()
    expect(categoryRankOf('tag:kids', [], index.rankByTag)).toBe(1)
  })
})
