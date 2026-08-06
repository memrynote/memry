import { describe, expect, it } from 'vitest'
import Graph from 'graphology'

import { GraphPhysics } from './graph-physics'

function makeGraph(
  nodes: Array<[string, number, number, number?]>,
  edges: Array<[string, string]> = []
): Graph {
  const graph = new Graph({ multi: true, type: 'undirected' })
  for (const [id, x, y, size] of nodes) {
    graph.addNode(id, { x, y, size: size ?? 5 })
  }
  edges.forEach(([source, target], i) => {
    graph.addEdgeWithKey(`e${i}`, source, target, { weight: 1 })
  })
  return graph
}

function distance(graph: Graph, a: string, b: string): number {
  const dx = (graph.getNodeAttribute(a, 'x') as number) - (graph.getNodeAttribute(b, 'x') as number)
  const dy = (graph.getNodeAttribute(a, 'y') as number) - (graph.getNodeAttribute(b, 'y') as number)
  return Math.hypot(dx, dy)
}

function settle(physics: GraphPhysics, ticks = 600): void {
  for (let i = 0; i < ticks; i++) physics.tick()
}

describe('GraphPhysics', () => {
  it('writes simulated positions back onto the graphology graph', () => {
    const graph = makeGraph([
      ['a', 0, 0],
      ['b', 40, 10]
    ])
    const physics = new GraphPhysics(graph)

    physics.tick()

    const moved = graph.getNodeAttribute('a', 'x') !== 0 || graph.getNodeAttribute('a', 'y') !== 0
    expect(moved).toBe(true)
  })

  it('pushes unconnected nodes apart', () => {
    const graph = makeGraph([
      ['a', 0, 0],
      ['b', 12, 4]
    ])
    const physics = new GraphPhysics(graph)
    const before = distance(graph, 'a', 'b')

    for (let i = 0; i < 40; i++) physics.tick()

    expect(distance(graph, 'a', 'b')).toBeGreaterThan(before)
  })

  it('pulls linked nodes toward each other when they start far apart', () => {
    const graph = makeGraph(
      [
        ['a', -900, 0],
        ['b', 900, 0]
      ],
      [['a', 'b']]
    )
    const physics = new GraphPhysics(graph)
    const before = distance(graph, 'a', 'b')

    for (let i = 0; i < 60; i++) physics.tick()

    expect(distance(graph, 'a', 'b')).toBeLessThan(before)
  })

  it('keeps overlapping nodes from sitting on top of each other', () => {
    const graph = makeGraph([
      ['a', 0, 0, 12],
      ['b', 0.5, 0.5, 12]
    ])
    const physics = new GraphPhysics(graph)

    for (let i = 0; i < 80; i++) physics.tick()

    expect(distance(graph, 'a', 'b')).toBeGreaterThan(12)
  })

  it('cools down as it ticks', () => {
    const physics = new GraphPhysics(
      makeGraph([
        ['a', 0, 0],
        ['b', 30, 0]
      ])
    )
    const start = physics.alpha

    for (let i = 0; i < 50; i++) physics.tick()

    expect(physics.alpha).toBeLessThan(start)
  })

  it('starts unsettled and reports settled once it has cooled', () => {
    const physics = new GraphPhysics(
      makeGraph([
        ['a', 0, 0],
        ['b', 30, 0]
      ])
    )

    expect(physics.isSettled).toBe(false)

    settle(physics)

    expect(physics.isSettled).toBe(true)
  })

  it('reheat wakes a settled simulation back up', () => {
    const physics = new GraphPhysics(
      makeGraph([
        ['a', 0, 0],
        ['b', 30, 0]
      ])
    )
    settle(physics)
    expect(physics.isSettled).toBe(true)

    physics.reheat()

    expect(physics.isSettled).toBe(false)
  })

  it('pins a grabbed node exactly at the drag position', () => {
    const graph = makeGraph([
      ['a', 0, 0],
      ['b', 40, 0]
    ])
    const physics = new GraphPhysics(graph)

    physics.grab('a')
    physics.dragTo('a', 100, 60)
    physics.tick()

    expect(graph.getNodeAttribute('a', 'x')).toBe(100)
    expect(graph.getNodeAttribute('a', 'y')).toBe(60)
  })

  it('keeps a grabbed node pinned while the rest of the graph keeps moving', () => {
    const graph = makeGraph([
      ['a', 0, 0],
      ['b', 40, 0]
    ])
    const physics = new GraphPhysics(graph)

    physics.grab('a')
    physics.dragTo('a', 100, 60)
    for (let i = 0; i < 30; i++) physics.tick()

    expect(graph.getNodeAttribute('a', 'x')).toBe(100)
    expect(graph.getNodeAttribute('a', 'y')).toBe(60)
  })

  it('drags linked neighbours along with the grabbed node', () => {
    const graph = makeGraph(
      [
        ['a', 0, 0],
        ['b', 40, 0]
      ],
      [['a', 'b']]
    )
    const physics = new GraphPhysics(graph)

    physics.grab('a')
    physics.dragTo('a', 600, 0)
    for (let i = 0; i < 60; i++) physics.tick()

    expect(graph.getNodeAttribute('b', 'x')).toBeGreaterThan(40)
  })

  it('lets a released node drift again', () => {
    const graph = makeGraph([
      ['a', 0, 0],
      ['b', 40, 0]
    ])
    const physics = new GraphPhysics(graph)

    physics.grab('a')
    physics.dragTo('a', 100, 60)
    physics.tick()
    physics.release('a')
    for (let i = 0; i < 40; i++) physics.tick()

    expect(graph.getNodeAttribute('a', 'x')).not.toBe(100)
  })

  it('ignores drag calls for nodes that are not in the graph', () => {
    const graph = makeGraph([['a', 0, 0]])
    const physics = new GraphPhysics(graph)

    expect(() => {
      physics.grab('missing')
      physics.dragTo('missing', 10, 10)
      physics.release('missing')
      physics.tick()
    }).not.toThrow()
  })

  it('stops ticking after destroy', () => {
    const graph = makeGraph([
      ['a', 0, 0],
      ['b', 40, 10]
    ])
    const physics = new GraphPhysics(graph)
    physics.destroy()

    const x = graph.getNodeAttribute('a', 'x')
    physics.tick()

    expect(graph.getNodeAttribute('a', 'x')).toBe(x)
  })

  it('handles an empty graph without throwing', () => {
    const physics = new GraphPhysics(new Graph())

    expect(() => physics.tick()).not.toThrow()
    expect(physics.isSettled).toBe(true)
  })
})
