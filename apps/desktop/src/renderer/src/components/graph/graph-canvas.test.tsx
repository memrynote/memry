import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphDataResponse, GraphSettings } from '@memry/contracts/graph-api'
import type { GraphFilterState } from '@/hooks/use-graph-filters'

const graphCanvasMocks = vi.hoisted(() => ({
  sigma: {
    setSetting: vi.fn(),
    refresh: vi.fn(),
    // Sigma retains its graph reference even after kill(). The live instance is
    // the one holding the graph the container was rendered with; a stale
    // instance returns something else. Overridden per-test to model the race.
    getGraph: (): unknown => graphCanvasMocks.sigmaContainerProps?.graph
  },
  sigmaContainerProps: null as null | Record<string, any>,
  layoutStart: vi.fn(),
  layoutStop: vi.fn(),
  openTab: vi.fn(),
  createNote: vi.fn()
}))

vi.mock('@react-sigma/core', () => ({
  SigmaContainer: (props: Record<string, any>) => {
    graphCanvasMocks.sigmaContainerProps = props
    return <div data-testid="sigma">{props.children}</div>
  },
  useSigma: () => graphCanvasMocks.sigma
}))

vi.mock('@react-sigma/layout-forceatlas2', () => ({
  useWorkerLayoutForceAtlas2: () => ({
    start: graphCanvasMocks.layoutStart,
    stop: graphCanvasMocks.layoutStop
  })
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ openTab: graphCanvasMocks.openTab })
}))

vi.mock('@/hooks/use-notes-query', () => ({
  useNoteMutations: () => ({
    createNote: { mutateAsync: graphCanvasMocks.createNote }
  })
}))

vi.mock('./graph-events', () => ({
  GraphEvents: ({
    onHoverNode,
    onTooltipMove,
    onFocusNode,
    onContextMenu,
    onNodeGrab,
    onNodeDrag,
    onNodeRelease
  }: {
    onHoverNode: (id: string | null) => void
    onTooltipMove: (pos: { x: number; y: number } | null) => void
    onFocusNode: (id: string) => void
    onContextMenu?: (menu: { nodeId: string; x: number; y: number } | null) => void
    onNodeGrab?: (id: string) => void
    onNodeDrag?: (id: string, x: number, y: number) => void
    onNodeRelease?: (id: string) => void
  }) => (
    <div>
      <button
        type="button"
        onClick={() => {
          onHoverNode('note-a')
          onTooltipMove({ x: 10, y: 20 })
        }}
      >
        hover note
      </button>
      <button type="button" onClick={() => onFocusNode('note-b')}>
        focus note
      </button>
      <button type="button" onClick={() => onContextMenu?.({ nodeId: 'note-a', x: 1, y: 2 })}>
        context note
      </button>
      <button type="button" onClick={() => onContextMenu?.({ nodeId: 'ghost', x: 3, y: 4 })}>
        context ghost
      </button>
      <button type="button" onClick={() => onNodeGrab?.('note-a')}>
        grab note
      </button>
      <button type="button" onClick={() => onNodeDrag?.('note-a', 777, -321)}>
        drag note
      </button>
      <button type="button" onClick={() => onNodeRelease?.('note-a')}>
        release note
      </button>
    </div>
  )
}))

vi.mock('./graph-tooltip', () => ({
  GraphTooltip: ({ nodeId, x, y }: { nodeId: string; x: number; y: number }) => (
    <div data-testid="tooltip">
      {nodeId}:{x}:{y}
    </div>
  )
}))

vi.mock('./graph-context-menu', () => ({
  GraphContextMenu: ({
    menu,
    onFocusNode,
    onOpenInTab,
    onCreateNote,
    onClose
  }: {
    menu: { nodeId: string }
    onFocusNode: (nodeId: string) => void
    onOpenInTab: (nodeId: string) => void
    onCreateNote?: (title: string) => void
    onClose: () => void
  }) => (
    <div data-testid="context-menu">
      <button type="button" onClick={() => onFocusNode(menu.nodeId)}>
        menu focus
      </button>
      <button type="button" onClick={() => onOpenInTab(menu.nodeId)}>
        menu open
      </button>
      <button type="button" onClick={() => onCreateNote?.('Created from graph')}>
        menu create
      </button>
      <button type="button" onClick={onClose}>
        menu close
      </button>
    </div>
  )
}))

import { GraphCanvas } from './graph-canvas'

const data: GraphDataResponse = {
  nodes: [
    {
      id: 'note-a',
      type: 'note',
      label: 'Alpha',
      tags: ['alpha'],
      wordCount: 100,
      connectionCount: 2,
      emoji: 'A',
      color: '#111111',
      isOrphan: false,
      isUnresolved: false
    },
    {
      id: 'note-b',
      type: 'note',
      label: 'Beta',
      tags: ['beta'],
      wordCount: 25,
      connectionCount: 1,
      emoji: null,
      color: '#222222',
      isOrphan: false,
      isUnresolved: false
    },
    {
      id: 'task-1',
      type: 'task',
      label: 'Task',
      tags: [],
      wordCount: 0,
      connectionCount: 1,
      emoji: null,
      color: '#333333',
      isOrphan: false,
      isUnresolved: false
    },
    {
      id: 'ghost',
      type: 'note',
      label: 'Ghost',
      tags: [],
      wordCount: 0,
      connectionCount: 0,
      emoji: null,
      color: '#444444',
      isOrphan: true,
      isUnresolved: true
    }
  ],
  edges: [
    { id: 'edge-a-b', source: 'note-a', target: 'note-b', type: 'wikilink', weight: 2 },
    { id: 'edge-a-task', source: 'note-a', target: 'task-1', type: 'task-note', weight: 1 }
  ]
}

const filters: GraphFilterState = {
  showNotes: true,
  showTasks: true,
  showJournals: true,
  showProjects: true,
  showTags: true,
  showOrphans: true,
  selectedTags: [],
  focusNodeId: null,
  focusDepth: 1,
  searchQuery: ''
}

const settings: GraphSettings = {
  layout: 'circular',
  showLabels: true,
  showEdgeLabels: false,
  animateLayout: false,
  showTagEdges: true
}

describe('GraphCanvas', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    graphCanvasMocks.sigmaContainerProps = null
    graphCanvasMocks.sigma.getGraph = () => graphCanvasMocks.sigmaContainerProps?.graph
    graphCanvasMocks.createNote.mockResolvedValue({
      success: true,
      note: { id: 'created-note', title: 'Created from graph' }
    })
    document.documentElement.style.setProperty('--graph-dimmed-node', '#eeeeee')
    document.documentElement.style.setProperty('--graph-edge-soft', '#dddddd')
    document.documentElement.style.setProperty('--graph-label-color', '#111111')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('builds sigma settings, applies reducers, and handles hover/context menu actions', async () => {
    const onFocusNode = vi.fn()
    render(
      <GraphCanvas
        data={data}
        filterState={{ ...filters, selectedTags: ['alpha'], searchQuery: 'alp' }}
        graphSettings={settings}
        onFocusNode={onFocusNode}
      />
    )

    const settingsFromSigma = graphCanvasMocks.sigmaContainerProps?.settings
    expect(settingsFromSigma.labelRenderedSizeThreshold).toBe(6)
    expect(settingsFromSigma.labelColor).toEqual({ color: '#111111' })

    const graph = graphCanvasMocks.sigmaContainerProps?.graph
    expect(graph.hasNode('note-a')).toBe(true)

    const hiddenTask = settingsFromSigma.nodeReducer('task-1', {
      nodeType: 'task',
      label: 'Task',
      tags: [],
      isOrphan: false
    })
    expect(hiddenTask.hidden).toBe(true)

    const hiddenByTag = settingsFromSigma.nodeReducer('note-b', {
      nodeType: 'note',
      label: 'Beta',
      tags: ['beta'],
      isOrphan: false
    })
    expect(hiddenByTag.hidden).toBe(true)

    const highlighted = settingsFromSigma.nodeReducer('note-a', {
      nodeType: 'note',
      label: 'Alpha',
      tags: ['alpha'],
      isOrphan: false
    })
    expect(highlighted).toMatchObject({ highlighted: true, forceLabel: true, zIndex: 1 })

    const softEdge = settingsFromSigma.edgeReducer('note-a-note-b-wikilink', {
      color: '#000000',
      size: 1
    })
    expect(softEdge).toMatchObject({ color: '#dddddd', size: 1 })

    fireEvent.click(screen.getByText('hover note'))
    expect(screen.getByTestId('tooltip')).toHaveTextContent('note-a:10:20')
    vi.runOnlyPendingTimers()

    fireEvent.click(screen.getByText('focus note'))
    expect(onFocusNode).toHaveBeenCalledWith('note-b')

    fireEvent.click(screen.getByText('context note'))
    fireEvent.click(screen.getByText('menu open'))
    expect(graphCanvasMocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'note',
        title: 'Alpha',
        entityId: 'note-a',
        isPreview: false
      })
    )

    fireEvent.click(screen.getByText('context ghost'))
    fireEvent.click(screen.getByText('menu create'))
    await vi.waitFor(() =>
      expect(graphCanvasMocks.createNote).toHaveBeenCalledWith({ title: 'Created from graph' })
    )
    expect(graphCanvasMocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'note',
        title: 'Created from graph',
        entityId: 'created-note',
        isPreview: false
      })
    )
  })

  it('does not push settings into a sigma instance that does not own our graph', () => {
    // SigmaContainer kills and recreates Sigma whenever the `graph` prop changes.
    // React runs child effects before the container's create effect, so useSigma()
    // can still hand SigmaSettingsSync the OLD, killed instance. kill() empties
    // nodePrograms but keeps the graph, so pushing settings there schedules a
    // render that throws on the next frame. Model that by having the instance
    // report a graph that is not the one we rendered with.
    graphCanvasMocks.sigma.getGraph = () => ({ stale: true })

    render(
      <GraphCanvas
        data={data}
        filterState={filters}
        graphSettings={settings}
        onFocusNode={vi.fn()}
      />
    )

    expect(graphCanvasMocks.sigma.setSetting).not.toHaveBeenCalled()
  })

  it('re-applies settings once the committed instance owns our graph (recovery)', () => {
    // Guard the recovery half of the fix: skipping the stale instance must not
    // leave settings permanently unapplied. First render sees a foreign instance
    // (guard bails, nothing pushed); once the container commits the instance that
    // owns the rendered graph, a later settings change must re-run the effect and
    // actually apply -- proving the guard skips the zombie without stranding
    // settings on the live instance (a silent visual regression otherwise).
    graphCanvasMocks.sigma.getGraph = () => ({ stale: true })
    const { rerender } = render(
      <GraphCanvas
        data={data}
        filterState={filters}
        graphSettings={{ ...settings, showLabels: false }}
        onFocusNode={vi.fn()}
      />
    )
    expect(graphCanvasMocks.sigma.setSetting).not.toHaveBeenCalled()

    graphCanvasMocks.sigma.getGraph = () => graphCanvasMocks.sigmaContainerProps?.graph
    rerender(
      <GraphCanvas
        data={data}
        filterState={filters}
        graphSettings={{ ...settings, showLabels: true }}
        onFocusNode={vi.fn()}
      />
    )
    expect(graphCanvasMocks.sigma.setSetting).toHaveBeenCalledWith('labelRenderedSizeThreshold', 6)
  })

  it('syncs sigma settings and hides nodes outside the focus set', () => {
    render(
      <GraphCanvas
        data={data}
        filterState={{ ...filters, focusNodeId: 'note-a', focusDepth: 1 }}
        graphSettings={{
          ...settings,
          layout: 'forceatlas2',
          animateLayout: true,
          showLabels: false
        }}
        onFocusNode={vi.fn()}
      />
    )

    expect(graphCanvasMocks.sigma.setSetting).toHaveBeenCalledWith(
      'labelRenderedSizeThreshold',
      Infinity
    )

    const settingsFromSigma = graphCanvasMocks.sigmaContainerProps?.settings
    const focusedOut = settingsFromSigma.nodeReducer('ghost', {
      nodeType: 'note',
      label: 'Ghost',
      tags: [],
      isOrphan: true
    })
    expect(focusedOut.hidden).toBe(true)
  })

  describe('live simulation', () => {
    const livePhysics: GraphSettings = {
      ...settings,
      layout: 'forceatlas2',
      animateLayout: true
    }

    function renderLive(overrides: Partial<GraphSettings> = {}): {
      graph: any
      unmount: () => void
    } {
      const { unmount } = render(
        <GraphCanvas
          data={data}
          filterState={filters}
          graphSettings={{ ...livePhysics, ...overrides }}
          onFocusNode={vi.fn()}
        />
      )
      return { graph: graphCanvasMocks.sigmaContainerProps?.graph, unmount }
    }

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('moves nodes and repaints on every animation frame', () => {
      const { graph } = renderLive()
      const before = graph.getNodeAttribute('note-a', 'x')
      graphCanvasMocks.sigma.refresh.mockClear()

      vi.advanceTimersToNextFrame()

      expect(graph.getNodeAttribute('note-a', 'x')).not.toBe(before)
      expect(graphCanvasMocks.sigma.refresh).toHaveBeenCalled()
    })

    it('pins a node to the pointer while it is being dragged', () => {
      const { graph } = renderLive()

      fireEvent.click(screen.getByText('grab note'))
      fireEvent.click(screen.getByText('drag note'))
      vi.advanceTimersToNextFrame()

      expect(graph.getNodeAttribute('note-a', 'x')).toBe(777)
      expect(graph.getNodeAttribute('note-a', 'y')).toBe(-321)
    })

    it('lets a released node settle back into the layout', () => {
      const { graph } = renderLive()

      fireEvent.click(screen.getByText('grab note'))
      fireEvent.click(screen.getByText('drag note'))
      vi.advanceTimersToNextFrame()
      fireEvent.click(screen.getByText('release note'))
      for (let i = 0; i < 20; i++) vi.advanceTimersToNextFrame()

      expect(graph.getNodeAttribute('note-a', 'x')).not.toBe(777)
    })

    it('leaves positions alone for static layouts', () => {
      const { graph } = renderLive({ layout: 'random' })
      const before = graph.getNodeAttribute('note-a', 'x')

      vi.advanceTimersToNextFrame()

      expect(graph.getNodeAttribute('note-a', 'x')).toBe(before)
    })

    it('leaves positions alone when live motion is switched off', () => {
      const { graph } = renderLive({ animateLayout: false })
      const before = graph.getNodeAttribute('note-a', 'x')

      vi.advanceTimersToNextFrame()

      expect(graph.getNodeAttribute('note-a', 'x')).toBe(before)
    })

    it('stops the animation loop on unmount', () => {
      const { graph, unmount } = renderLive()
      unmount()
      const before = graph.getNodeAttribute('note-a', 'x')

      vi.advanceTimersToNextFrame()

      expect(graph.getNodeAttribute('note-a', 'x')).toBe(before)
    })

    describe('repaint scope', () => {
      /**
       * Enough of sigma@3.0.3's `refresh` contract to observe what one repaint
       * costs. A refresh with no `partialGraph` re-runs both reducers over every
       * node and every edge (`Sigma#refresh` -> `addNode`/`addEdge`); a partial
       * one only re-runs them for the items it lists. Either way the indexation
       * pass (`Sigma#process`) re-reads x/y straight off the graph for every
       * node and re-feeds the node *and* edge programs, which is what stops a
       * repaint from being a frame behind. `skipIndexation` is what turns that
       * pass off.
       *
       * TRIPWIRE, read this before bumping sigma. This is a hand-written *model*
       * of that contract, not real Sigma — driving the real renderer needs WebGL.
       * It is pinned to sigma@3.0.3, where the source of truth is two lines of
       * `Sigma#refresh`: `fullRefresh = !opts || !opts.partialGraph` (so `{}`
       * takes the partial branch and reduces nothing) and
       * `if (fullRefresh || !skipIndexation) this.needToProcess = true` (so
       * omitting `skipIndexation` keeps the position pass). Sigma's own docstring
       * scopes `skipIndexation` to "if you haven't modify x, y, zIndex & size".
       *
       * A model cannot notice sigma changing underneath it: if an upgrade alters
       * either mechanism, this file keeps asserting the OLD contract, stays green,
       * and the graph silently renders a frame behind. A sigma major or minor bump
       * must therefore re-read `refresh` in the new dist and re-confirm both lines
       * by hand — the suite will not do it for you.
       */
      function recordRepaints(): {
        nodeReducerCalls: string[]
        edgeReducerCalls: string[]
        painted: Map<string, { x: number; y: number }>
      } {
        const record = {
          nodeReducerCalls: [] as string[],
          edgeReducerCalls: [] as string[],
          painted: new Map<string, { x: number; y: number }>()
        }

        // Sigma reduces with whatever reducer was last pushed into its settings.
        const reducer = (key: 'nodeReducer' | 'edgeReducer'): any => {
          const pushed = graphCanvasMocks.sigma.setSetting.mock.calls.filter(
            ([setting]: [string]) => setting === key
          )
          return pushed.length > 0
            ? pushed[pushed.length - 1][1]
            : graphCanvasMocks.sigmaContainerProps?.settings[key]
        }

        graphCanvasMocks.sigma.refresh.mockImplementation((opts?: any) => {
          const graph = graphCanvasMocks.sigmaContainerProps?.graph
          if (!graph) return
          const partial = opts?.partialGraph

          for (const node of partial ? (partial.nodes ?? []) : graph.nodes()) {
            record.nodeReducerCalls.push(node)
            reducer('nodeReducer')(node, graph.getNodeAttributes(node))
          }
          for (const edge of partial ? (partial.edges ?? []) : graph.edges()) {
            record.edgeReducerCalls.push(edge)
            reducer('edgeReducer')(edge, graph.getEdgeAttributes(edge))
          }

          if (!partial || !opts?.skipIndexation) {
            for (const node of graph.nodes()) {
              record.painted.set(node, {
                x: graph.getNodeAttribute(node, 'x'),
                y: graph.getNodeAttribute(node, 'y')
              })
            }
          }
        })

        return record
      }

      afterEach(() => {
        graphCanvasMocks.sigma.refresh.mockReset()
      })

      it('repaints a physics frame without re-running the reducers over the whole graph', () => {
        const record = recordRepaints()
        renderLive()
        record.nodeReducerCalls.length = 0
        record.edgeReducerCalls.length = 0

        vi.advanceTimersToNextFrame()

        expect(record.nodeReducerCalls).toEqual([])
        expect(record.edgeReducerCalls).toEqual([])
      })

      it('paints every physics frame at the positions that frame just produced', () => {
        const record = recordRepaints()
        const { graph } = renderLive()

        for (let i = 0; i < 3; i++) {
          vi.advanceTimersToNextFrame()

          for (const node of graph.nodes()) {
            expect(record.painted.get(node)).toEqual({
              x: graph.getNodeAttribute(node, 'x'),
              y: graph.getNodeAttribute(node, 'y')
            })
          }
        }
      })

      it('still re-reduces the whole graph when hover changes the dimming', () => {
        const record = recordRepaints()
        const { graph } = renderLive()
        record.nodeReducerCalls.length = 0
        record.edgeReducerCalls.length = 0

        fireEvent.click(screen.getByText('hover note'))
        vi.advanceTimersToNextFrame()

        expect(new Set(record.nodeReducerCalls)).toEqual(new Set(graph.nodes()))
        expect(new Set(record.edgeReducerCalls)).toEqual(new Set(graph.edges()))
      })
    })
  })
})
