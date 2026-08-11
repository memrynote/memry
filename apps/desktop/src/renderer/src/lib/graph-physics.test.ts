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

/** Deterministic scatter wide enough that the spatial grid holds many occupied cells. */
function makeSpreadGraph(count: number): Graph {
  const graph = new Graph({ multi: true, type: 'undirected' })
  let seed = 42
  const next = (): number => {
    seed = (seed * 48271) % 2147483647
    return seed / 2147483647
  }
  for (let i = 0; i < count; i++) {
    graph.addNode(`n${i}`, {
      x: (next() - 0.5) * 2400,
      y: (next() - 0.5) * 2400,
      size: 4 + (i % 5)
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

/** The grid the tick reuses. Private on purpose — only the reuse tests look at it. */
interface GridInternals {
  grid: Map<unknown, unknown[]>
  cellPool: unknown[][]
}

function internals(physics: GraphPhysics): GridInternals {
  return physics as unknown as GridInternals
}

function binnedNodes(physics: GraphPhysics): unknown[] {
  const out: unknown[] = []
  for (const cell of internals(physics).grid.values()) out.push(...cell)
  return out
}

/**
 * Positions after 120 ticks of `makeSpreadGraph(16)`, captured from the original
 * string-keyed grid (`${Math.floor(x / cellSize)},${...}` + a fresh `Map` per
 * tick). The grid is only an acceleration structure, so swapping how cells are
 * addressed must not move a single node by a single bit — these are exact.
 */
const GOLDEN_SPREAD_16: Array<[string, number, number]> = [
  ['n0', 13.374592190624796, 85.31019820180218],
  ['n1', -63.40504478077077, 105.68555806828485],
  ['n2', -31.089578232049266, 151.71702195809863],
  ['n3', -122.82749496246768, 101.11862016166009],
  ['n4', 14.497199600987559, 4.661536423989247],
  ['n5', 5.471105573919566, -70.11216121173707],
  ['n6', 78.72092452520624, -57.77896580999497],
  ['n7', 111.20033541491098, -108.5714484994886],
  ['n8', 170.36569149718136, -118.50090037424494],
  ['n9', -3.692196145145418, -126.12050776324871],
  ['n10', -100.53604670110629, 58.940910955942115],
  ['n11', -96.17639386828299, 149.9957170597185],
  ['n12', -46.98210943129166, -97.05925879041261],
  ['n13', 205.38353279485526, -76.38864009200664],
  ['n14', 118.03378949328601, -14.243118321828911],
  ['n15', -22.68429529230571, 50.26736166843403]
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

  describe('sync', () => {
    it('reports no work when the graph is untouched', () => {
      const physics = new GraphPhysics(
        makeGraph([
          ['a', 0, 0],
          ['b', 40, 0]
        ])
      )

      expect(physics.sync()).toBe(false)
    })

    it('folds a node added to the graph into the running simulation', () => {
      const graph = makeGraph([
        ['a', 0, 0],
        ['b', 40, 0]
      ])
      const physics = new GraphPhysics(graph)
      settle(physics)
      graph.addNode('c', { x: 4, y: 4, size: 5 })

      expect(physics.sync()).toBe(true)

      physics.reheat()
      for (let i = 0; i < 60; i++) physics.tick()

      expect(graph.getNodeAttribute('c', 'x')).not.toBe(4)
    })

    it('keeps the positions of the nodes that survive a sync', () => {
      const graph = makeGraph([
        ['a', 0, 0],
        ['b', 40, 0]
      ])
      const physics = new GraphPhysics(graph)
      settle(physics)
      const x = graph.getNodeAttribute('a', 'x') as number
      const y = graph.getNodeAttribute('a', 'y') as number

      graph.addNode('c', { x: 300, y: 300, size: 5 })
      physics.sync()
      physics.tick()

      expect(graph.getNodeAttribute('a', 'x')).toBeCloseTo(x, 6)
      expect(graph.getNodeAttribute('a', 'y')).toBeCloseTo(y, 6)
    })

    it('forgets nodes and edges dropped from the graph', () => {
      const graph = makeGraph(
        [
          ['a', 0, 0],
          ['b', 40, 0]
        ],
        [['a', 'b']]
      )
      const physics = new GraphPhysics(graph)
      graph.dropNode('b')

      expect(physics.sync()).toBe(true)
      expect(() => physics.tick()).not.toThrow()
    })

    it('picks up a link added between existing nodes', () => {
      const graph = makeGraph([
        ['a', -900, 0],
        ['b', 900, 0]
      ])
      const physics = new GraphPhysics(graph)
      graph.addEdgeWithKey('later', 'a', 'b', { weight: 1 })

      expect(physics.sync()).toBe(true)

      const before = distance(graph, 'a', 'b')
      for (let i = 0; i < 60; i++) physics.tick()

      expect(distance(graph, 'a', 'b')).toBeLessThan(before)
    })

    it('does nothing after destroy', () => {
      const graph = makeGraph([['a', 0, 0]])
      const physics = new GraphPhysics(graph)
      physics.destroy()
      graph.addNode('b', { x: 5, y: 5, size: 5 })

      expect(physics.sync()).toBe(false)
    })
  })

  it('handles an empty graph without throwing', () => {
    const physics = new GraphPhysics(new Graph())

    expect(() => physics.tick()).not.toThrow()
    expect(physics.isSettled).toBe(true)
  })

  describe('spatial grid', () => {
    it('lands every node exactly where the string-keyed grid left it', () => {
      const graph = makeSpreadGraph(16)
      const physics = new GraphPhysics(graph)

      for (let i = 0; i < 120; i++) physics.tick()

      expect(positions(graph)).toEqual(GOLDEN_SPREAD_16)
    })

    it('reuses one number-keyed grid and one pool of cell arrays across ticks', () => {
      const physics = new GraphPhysics(makeSpreadGraph(16))
      physics.tick()
      const { grid, cellPool } = internals(physics)

      expect(grid).toBeInstanceOf(Map)
      expect(grid.size).toBeGreaterThan(1)
      expect([...new Set([...grid.keys()].map((key) => typeof key))]).toEqual(['number'])
      const firstCell = cellPool[0]

      physics.tick()

      expect(internals(physics).grid).toBe(grid)
      expect(internals(physics).cellPool).toBe(cellPool)
      expect(internals(physics).cellPool[0]).toBe(firstCell)
      expect([...grid.values()]).toContain(firstCell)
    })

    it('rebins every node exactly once a tick, with nothing left over from the last one', () => {
      const physics = new GraphPhysics(makeSpreadGraph(16))

      for (let i = 0; i < 5; i++) {
        physics.tick()
        expect(binnedNodes(physics)).toHaveLength(16)
        expect(new Set(binnedNodes(physics)).size).toBe(16)
      }

      // A drag of several cells: the node's old cell must not still be holding it.
      physics.grab('n0')
      physics.dragTo('n0', 9000, -9000)
      physics.tick()

      expect(binnedNodes(physics)).toHaveLength(16)
      expect(new Set(binnedNodes(physics)).size).toBe(16)
    })

    it('runs two simulations side by side without either disturbing the other', () => {
      const aloneA = makeSpreadGraph(16)
      const aloneB = makeSpreadGraph(9)
      const physicsAloneA = new GraphPhysics(aloneA)
      for (let i = 0; i < 60; i++) physicsAloneA.tick()
      const physicsAloneB = new GraphPhysics(aloneB)
      for (let i = 0; i < 60; i++) physicsAloneB.tick()

      const togetherA = makeSpreadGraph(16)
      const togetherB = makeSpreadGraph(9)
      const physicsA = new GraphPhysics(togetherA)
      const physicsB = new GraphPhysics(togetherB)
      for (let i = 0; i < 60; i++) {
        physicsA.tick()
        physicsB.tick()
      }

      expect(positions(togetherA)).toEqual(positions(aloneA))
      expect(positions(togetherB)).toEqual(positions(aloneB))
    })

    it('lets go of the grid on destroy', () => {
      const physics = new GraphPhysics(makeSpreadGraph(16))
      physics.tick()
      expect(internals(physics).grid.size).toBeGreaterThan(0)
      expect(internals(physics).cellPool.length).toBeGreaterThan(0)

      physics.destroy()

      expect(internals(physics).grid.size).toBe(0)
      expect(internals(physics).cellPool).toHaveLength(0)
    })
  })
})
