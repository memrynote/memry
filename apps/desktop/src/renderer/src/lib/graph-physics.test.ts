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

/** Deterministic scatter with a spanning tree, so one tick exercises every force. */
function makeMixedGraph(count: number): Graph {
  const graph = new Graph({ multi: true, type: 'undirected' })
  let seed = 7
  const next = (): number => {
    seed = (seed * 48271) % 2147483647
    return seed / 2147483647
  }
  for (let i = 0; i < count; i++) {
    graph.addNode(`n${i}`, {
      x: (next() - 0.5) * 900,
      y: (next() - 0.5) * 900,
      size: 4 + (i % 6)
    })
  }
  for (let i = 1; i < count; i++) {
    graph.addEdgeWithKey(`e${i}`, `n${i}`, `n${Math.floor(next() * i)}`, { weight: 1 })
  }
  return graph
}

function positions(graph: Graph): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = []
  graph.forEachNode((id, attrs) => {
    out.push([id, attrs.x as number, attrs.y as number])
  })
  return out
}

/** Every graphology attribute event the graph emits, in order. */
function recordAttributeEvents(graph: Graph): string[] {
  const seen: string[] = []
  graph.on('nodeAttributesUpdated', (payload: { key: string; name?: string }) => {
    seen.push(`nodeAttributesUpdated:${payload.key}.${payload.name ?? '*'}`)
  })
  graph.on('eachNodeAttributesUpdated', () => {
    seen.push('eachNodeAttributesUpdated')
  })
  return seen
}

/**
 * Positions after 150 ticks of `makeMixedGraph(12)`, captured from the
 * `setNodeAttribute(id, 'x', …)` + `setNodeAttribute(id, 'y', …)` publish. How
 * a tick hands its result to graphology must not move a node by a single bit,
 * so these are exact doubles, not tolerances.
 */
const GOLDEN_MIXED_12: Array<[string, number, number]> = [
  ['n0', -32.682853572554095, 10.115943671329513],
  ['n1', 34.467567410680445, -43.42329389259581],
  ['n2', 15.67316923174072, -96.31579881675414],
  ['n3', 3.641044913997191, 67.35618663448567],
  ['n4', -64.2931143999873, -36.166041345753015],
  ['n5', 73.87976930883534, -85.15404215585886],
  ['n6', -100.71492081895607, 24.339911204926477],
  ['n7', 56.18484769784674, 109.86992800228032],
  ['n8', 71.68162327899498, 167.81578267528562],
  ['n9', 90.61253201172838, -31.59692348425795],
  ['n10', -155.60752978717684, 21.712830047666813],
  ['n11', 24.169334125816402, 192.43890357419528]
]

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

  describe('publishing positions', () => {
    it('publishes a whole tick without emitting a single attribute event', () => {
      const graph = makeMixedGraph(12)
      const physics = new GraphPhysics(graph)
      const events = recordAttributeEvents(graph)

      physics.tick()

      expect(events).toEqual([])
    })

    it('stays silent every tick, not just the first', () => {
      const graph = makeMixedGraph(12)
      const physics = new GraphPhysics(graph)
      const events = recordAttributeEvents(graph)

      for (let i = 0; i < 5; i++) physics.tick()

      expect(events).toEqual([])
    })

    it('lands every node exactly where the per-attribute writes left it', () => {
      const graph = makeMixedGraph(12)
      const physics = new GraphPhysics(graph)

      for (let i = 0; i < 150; i++) physics.tick()

      expect(positions(graph)).toEqual(GOLDEN_MIXED_12)
    })

    it('reads back through the public accessor, not just the attribute object', () => {
      const graph = makeMixedGraph(12)
      const physics = new GraphPhysics(graph)

      for (let i = 0; i < 150; i++) physics.tick()

      for (const [id, x, y] of GOLDEN_MIXED_12) {
        expect(graph.getNodeAttribute(id, 'x')).toBe(x)
        expect(graph.getNodeAttribute(id, 'y')).toBe(y)
      }
    })

    it('leaves a node added after the simulation started exactly where it was put', () => {
      const graph = makeMixedGraph(12)
      const physics = new GraphPhysics(graph)
      graph.addNode('late', { x: 512, y: -512, size: 5 })

      for (let i = 0; i < 5; i++) physics.tick()

      expect(graph.getNodeAttribute('late', 'x')).toBe(512)
      expect(graph.getNodeAttribute('late', 'y')).toBe(-512)
    })

    it('keeps publishing the survivors after a node is dropped mid-simulation', () => {
      const graph = makeMixedGraph(12)
      const physics = new GraphPhysics(graph)
      physics.tick()
      graph.dropNode('n5')
      const before = graph.getNodeAttribute('n6', 'x')

      expect(() => physics.tick()).not.toThrow()
      expect(graph.getNodeAttribute('n6', 'x')).not.toBe(before)
    })

    it('runs two simulations side by side, each writing only to its own graph', () => {
      const soloA = makeMixedGraph(12)
      const soloB = makeMixedGraph(7)
      const physicsSoloA = new GraphPhysics(soloA)
      for (let i = 0; i < 60; i++) physicsSoloA.tick()
      const physicsSoloB = new GraphPhysics(soloB)
      for (let i = 0; i < 60; i++) physicsSoloB.tick()

      const pairedA = makeMixedGraph(12)
      const pairedB = makeMixedGraph(7)
      const physicsA = new GraphPhysics(pairedA)
      const physicsB = new GraphPhysics(pairedB)
      for (let i = 0; i < 60; i++) {
        physicsA.tick()
        physicsB.tick()
      }

      expect(positions(pairedA)).toEqual(positions(soloA))
      expect(positions(pairedB)).toEqual(positions(soloB))
    })
  })
})
