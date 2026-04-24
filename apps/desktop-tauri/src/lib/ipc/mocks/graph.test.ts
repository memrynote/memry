import { describe, it, expect } from 'vitest'

import { graphRoutes } from './graph'

describe('graphRoutes', () => {
  it('graph_get returns nodes + edges for the full vault graph', async () => {
    const graph = (await graphRoutes.graph_get!(undefined)) as {
      nodes: Array<{ id: string }>
      edges: Array<{ source: string; target: string }>
    }
    expect(graph.nodes.length).toBeGreaterThanOrEqual(10)
    expect(graph.edges.length).toBeGreaterThan(0)
    const ids = new Set(graph.nodes.map((n) => n.id))
    for (const edge of graph.edges) {
      expect(ids.has(edge.source)).toBe(true)
      expect(ids.has(edge.target)).toBe(true)
    }
  })

  it('graph_neighbors returns nodes within hops of a note', async () => {
    const neighbors = (await graphRoutes.graph_neighbors!({
      noteId: 'note-1',
      depth: 1
    })) as Array<{ id: string }>
    expect(Array.isArray(neighbors)).toBe(true)
  })

  it('graph_backlinks returns incoming links to a note', async () => {
    const backlinks = (await graphRoutes.graph_backlinks!({ noteId: 'note-1' })) as Array<{
      source: string
    }>
    expect(Array.isArray(backlinks)).toBe(true)
  })

  it('graph_forward_links returns outgoing links from a note', async () => {
    const forward = (await graphRoutes.graph_forward_links!({ noteId: 'note-1' })) as Array<{
      target: string
    }>
    expect(Array.isArray(forward)).toBe(true)
  })
})
