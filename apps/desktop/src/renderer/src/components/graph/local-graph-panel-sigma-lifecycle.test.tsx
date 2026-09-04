/**
 * Renderer lifecycle harness for the local graph panel.
 *
 * Unlike `local-graph-panel.test.tsx` — which stubs `SigmaContainer` with a plain
 * div — this suite drives the *real* `SigmaContainer` from `@react-sigma/core` and
 * stubs the `sigma` package underneath it, so the container's real "recreate on
 * graph/settings identity change" rule decides how many Sigma instances (and
 * therefore WebGL contexts) get built. That makes the instance count an observable
 * assertion instead of a claim about timing.
 */
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Graph from 'graphology'
import type { GraphDataResponse } from '@memry/contracts/graph-api'

const mocks = vi.hoisted(() => ({
  localGraph: { data: null as GraphDataResponse | null, isLoading: false },
  /** Every Sigma ever constructed in this test file, in creation order. */
  instances: [] as FakeSigmaLike[]
}))

interface FakeSigmaLike {
  graph: Graph
  settings: Record<string, unknown>
  killed: boolean
  refreshCount: number
  cameraState: { x: number; y: number; ratio: number; angle: number }
  getGraph: () => Graph
}

vi.mock('sigma', () => {
  class FakeSigma {
    killed = false
    refreshCount = 0
    cameraState = { x: 0, y: 0, ratio: 1, angle: 0 }
    private readonly camera = {
      getState: (): FakeSigma['cameraState'] => this.cameraState,
      setState: (state: FakeSigma['cameraState']): void => {
        this.cameraState = { ...state }
      }
    }

    constructor(
      public graph: Graph,
      public container: HTMLElement,
      public settings: Record<string, unknown>
    ) {
      mocks.instances.push(this as unknown as FakeSigmaLike)
    }

    getGraph(): Graph {
      return this.graph
    }

    // jsdom does no layout, so the real container measures 0 and the refresh
    // guard would skip every repaint. Hand it one that measures.
    getContainer(): HTMLElement {
      return Object.defineProperty(document.createElement('div'), 'offsetWidth', { value: 800 })
    }

    getCamera(): FakeSigma['camera'] {
      return this.camera
    }

    setSetting(key: string, value: unknown): void {
      this.settings = { ...this.settings, [key]: value }
    }

    refresh(): void {
      this.refreshCount += 1
    }

    /** A killed Sigma releases its WebGL context; a leaked one never does. */
    kill(): void {
      this.killed = true
    }
  }

  return { Sigma: FakeSigma, default: FakeSigma }
})

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' })
}))

vi.mock('@/hooks/use-graph-data', () => ({
  useLocalGraphData: () => mocks.localGraph
}))

vi.mock('./graph-events', () => ({
  GraphEvents: () => null
}))

const { LocalGraphPanel } = await import('./local-graph-panel')

function node(
  id: string,
  label: string,
  overrides: Partial<GraphDataResponse['nodes'][number]> = {}
): GraphDataResponse['nodes'][number] {
  return {
    id,
    type: 'note',
    label,
    tags: [],
    wordCount: 5,
    connectionCount: 1,
    emoji: null,
    isOrphan: false,
    isUnresolved: false,
    ...overrides
  }
}

/** note-a (the centre) linked to note-b, plus an unconnected note-c. */
const baseData: GraphDataResponse = {
  nodes: [node('note-a', 'Alpha'), node('note-b', 'Beta'), node('note-c', 'Gamma')],
  edges: [{ source: 'note-a', target: 'note-b', type: 'wikilink', weight: 1 }]
}

function liveContextCount(): number {
  return mocks.instances.filter((instance) => !instance.killed).length
}

function currentSigma(): FakeSigmaLike {
  const sigma = mocks.instances.at(-1)
  if (!sigma) throw new Error('no Sigma was constructed')
  return sigma
}

function nodeIds(graph: Graph): string[] {
  return graph.nodes().sort()
}

function edgeKeys(graph: Graph): string[] {
  return graph.edges().sort()
}

/**
 * Pending animation frames, keyed by handle so a cancel really drops the callback —
 * a torn-down simulation must not keep stepping just because its frame was queued.
 */
let frames = new Map<number, FrameRequestCallback>()
let nextFrameHandle = 0

function runFrames(count: number): void {
  act(() => {
    for (let i = 0; i < count; i++) {
      const next = frames.entries().next()
      if (next.done) return
      frames.delete(next.value[0])
      next.value[1](16 * (i + 1))
    }
  })
}

describe('LocalGraphPanel Sigma lifecycle', () => {
  beforeEach(() => {
    mocks.instances.length = 0
    mocks.localGraph = { data: baseData, isLoading: false }
    frames = new Map()
    nextFrameHandle = 0
    document.documentElement.style.setProperty('--graph-dimmed-node', '#dddddd')
    document.documentElement.style.setProperty('--graph-edge-soft', '#cccccc')
    document.documentElement.style.setProperty('--graph-label-color', '#111111')
    // Deterministic node seeding so a moved node is a force, not a coin flip.
    let seed = 0.13
    vi.spyOn(Math, 'random').mockImplementation(() => {
      seed = (seed * 9301 + 0.49297) % 1
      return seed
    })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      nextFrameHandle += 1
      frames.set(nextFrameHandle, callback)
      return nextFrameHandle
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) => {
      frames.delete(handle)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function renderPanel(noteId = 'note-a'): ReturnType<typeof render> {
    return render(<LocalGraphPanel noteId={noteId} onClose={vi.fn()} />)
  }

  function refetch(
    view: ReturnType<typeof render>,
    data: GraphDataResponse,
    noteId = 'note-a'
  ): void {
    // React Query hands back a fresh object for every refetch whose payload is not
    // deeply equal to the cached one — a note save changes wordCount, so it always is.
    mocks.localGraph = { data, isLoading: false }
    act(() => {
      view.rerender(<LocalGraphPanel noteId={noteId} onClose={vi.fn()} />)
    })
  }

  it('builds one Sigma instance and holds one WebGL context across repeated refetches', () => {
    const view = renderPanel()
    expect(mocks.instances).toHaveLength(1)

    for (let i = 1; i <= 10; i++) {
      refetch(view, {
        nodes: baseData.nodes.map((n) =>
          n.id === 'note-a' ? { ...n, wordCount: 5 + i } : { ...n }
        ),
        edges: baseData.edges.map((edge) => ({ ...edge }))
      })
    }

    expect(mocks.instances).toHaveLength(1)
    expect(liveContextCount()).toBe(1)
  })

  it('shows exactly the refetched local graph, with no leftovers from the previous one', () => {
    const view = renderPanel()
    const sigma = currentSigma()
    expect(nodeIds(sigma.getGraph())).toEqual(['note-a', 'note-b', 'note-c'])
    expect(edgeKeys(sigma.getGraph())).toEqual(['note-a-note-b-wikilink'])

    // note-c is gone, note-d arrived and is linked, note-b was renamed.
    refetch(view, {
      nodes: [
        node('note-a', 'Alpha'),
        node('note-b', 'Beta renamed'),
        node('note-d', 'Delta', { tags: ['ideas'] })
      ],
      edges: [{ source: 'note-a', target: 'note-d', type: 'wikilink', weight: 1 }]
    })

    const graph = currentSigma().getGraph()
    expect(mocks.instances).toHaveLength(1)
    expect(nodeIds(graph)).toEqual(['note-a', 'note-b', 'note-d', 'tag:ideas'])
    expect(edgeKeys(graph)).toEqual(['note-a-note-d-wikilink', 'note-d-tag:ideas-entity-tag'])
    expect(graph.getNodeAttribute('note-b', 'label')).toBe('Beta renamed')
  })

  it('keeps the position a surviving node was simulated to, and the camera the user set', () => {
    const view = renderPanel()
    const sigma = currentSigma()
    runFrames(3)
    sigma.getCamera().setState({ x: 0.25, y: -0.5, ratio: 0.4, angle: 0 })
    const settled = {
      x: sigma.getGraph().getNodeAttribute('note-a', 'x') as number,
      y: sigma.getGraph().getNodeAttribute('note-a', 'y') as number
    }

    refetch(view, {
      nodes: [node('note-a', 'Alpha'), node('note-b', 'Beta'), node('note-c', 'Gamma')],
      edges: [{ source: 'note-a', target: 'note-b', type: 'wikilink', weight: 1 }]
    })

    expect(currentSigma().getGraph().getNodeAttribute('note-a', 'x')).toBe(settled.x)
    expect(currentSigma().getGraph().getNodeAttribute('note-a', 'y')).toBe(settled.y)
    expect(currentSigma().getCamera().getState()).toEqual({
      x: 0.25,
      y: -0.5,
      ratio: 0.4,
      angle: 0
    })
  })

  it('lets the simulation place a node that a refetch added', () => {
    const view = renderPanel()
    runFrames(3)

    refetch(view, {
      nodes: [...baseData.nodes, node('note-d', 'Delta')],
      edges: baseData.edges.map((edge) => ({ ...edge }))
    })

    const graph = currentSigma().getGraph()
    const seeded = graph.getNodeAttribute('note-d', 'x') as number
    runFrames(3)
    expect(graph.getNodeAttribute('note-d', 'x')).not.toBe(seeded)
  })

  describe('rebuilding the simulation', () => {
    /**
     * The graph instance now outlives the data, so the effect keyed on it no longer
     * re-runs and a stale simulation would keep pushing nodes the refetch deleted.
     *
     * A rebuilt simulation re-reads positions from the graph; a running one keeps its
     * own copy and writes it back every tick. So: park a sentinel on a surviving node,
     * refetch, tick once, and the sentinel survives only if the simulation was rebuilt.
     */
    const SENTINEL = 1_000_000

    function simulationWasRebuilt(
      view: ReturnType<typeof render>,
      data: GraphDataResponse
    ): boolean {
      runFrames(2)
      currentSigma().getGraph().setNodeAttribute('note-a', 'x', SENTINEL)
      refetch(view, data)
      runFrames(1)
      return Math.abs(currentSigma().getGraph().getNodeAttribute('note-a', 'x') as number) > 1_000
    }

    it('is left alone when only node attributes changed', () => {
      const view = renderPanel()
      expect(
        simulationWasRebuilt(view, {
          nodes: baseData.nodes.map((n) => ({ ...n, wordCount: 99 })),
          edges: baseData.edges.map((edge) => ({ ...edge }))
        })
      ).toBe(false)
    })

    it('is rebuilt when a refetch removed a node', () => {
      const view = renderPanel()
      expect(
        simulationWasRebuilt(view, {
          nodes: baseData.nodes.filter((n) => n.id !== 'note-c'),
          edges: baseData.edges.map((edge) => ({ ...edge }))
        })
      ).toBe(true)
    })

    it('is rebuilt when a refetch removed a link but kept every node', () => {
      const view = renderPanel()
      expect(simulationWasRebuilt(view, { nodes: baseData.nodes, edges: [] })).toBe(true)
    })

    it('is rebuilt when a refetch added a link between nodes it already had', () => {
      const view = renderPanel()
      expect(
        simulationWasRebuilt(view, {
          nodes: baseData.nodes,
          edges: [
            { source: 'note-a', target: 'note-b', type: 'wikilink', weight: 1 },
            { source: 'note-a', target: 'note-c', type: 'wikilink', weight: 1 }
          ]
        })
      ).toBe(true)
    })
  })

  it('re-centres on a new note without building a second Sigma', () => {
    const view = renderPanel('note-a')
    const sigma = currentSigma()
    expect(
      (sigma.settings.nodeReducer as (id: string, attrs: Record<string, unknown>) => unknown)(
        'note-b',
        { size: 5 }
      )
    ).not.toMatchObject({ color: '#f59e0b' })

    refetch(view, baseData, 'note-b')

    expect(mocks.instances).toHaveLength(1)
    expect(
      (
        currentSigma().settings.nodeReducer as (
          id: string,
          attrs: Record<string, unknown>
        ) => unknown
      )('note-b', { size: 5 })
    ).toMatchObject({ color: '#f59e0b', highlighted: true, forceLabel: true })
  })

  it('kills its Sigma instance on unmount, releasing the WebGL context', () => {
    const view = renderPanel()
    refetch(view, {
      nodes: [...baseData.nodes, node('note-d', 'Delta')],
      edges: baseData.edges.map((edge) => ({ ...edge }))
    })

    view.unmount()

    expect(mocks.instances).toHaveLength(1)
    expect(liveContextCount()).toBe(0)
  })

  it('releases every context when the panel is remounted, as a vault switch does', () => {
    for (let i = 0; i < 4; i++) {
      const view = renderPanel()
      refetch(view, {
        nodes: baseData.nodes.map((n) => ({ ...n, wordCount: 5 + i })),
        edges: baseData.edges.map((edge) => ({ ...edge }))
      })
      view.unmount()
    }

    expect(mocks.instances).toHaveLength(4)
    expect(liveContextCount()).toBe(0)
  })
})
