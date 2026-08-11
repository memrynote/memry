import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphDataResponse } from '@memry/contracts/graph-api'

import { LocalGraphPanel } from './local-graph-panel'

const mocks = vi.hoisted(() => ({
  localGraph: {
    data: null as GraphDataResponse | null,
    isLoading: false
  },
  sigma: {
    refresh: vi.fn(),
    // The panel freezes SigmaContainer's `settings` prop and pushes later reducers
    // through setSetting, so the stub has to accept them.
    setSetting: vi.fn(),
    // The live simulation refreshes only the instance that owns the graph it is
    // stepping, so the mock has to model getGraph like the real Sigma does.
    getGraph: (): unknown => mocks.sigmaContainerProps?.graph
  },
  sigmaContainerProps: null as null | Record<string, any>
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' })
}))

vi.mock('@react-sigma/core', () => ({
  SigmaContainer: (props: Record<string, any>) => {
    mocks.sigmaContainerProps = props
    return <div data-testid="sigma">{props.children}</div>
  },
  useSigma: () => mocks.sigma
}))

vi.mock('@/hooks/use-graph-data', () => ({
  useLocalGraphData: () => mocks.localGraph
}))

vi.mock('./graph-events', () => ({
  GraphEvents: ({
    onHoverNode,
    onTooltipMove,
    onFocusNode
  }: {
    onHoverNode: (id: string | null) => void
    onTooltipMove: (pos: { x: number; y: number } | null) => void
    onFocusNode: (id: string) => void
  }) => (
    <div>
      <button
        type="button"
        onClick={() => {
          onHoverNode('note-b')
          onTooltipMove({ x: 12, y: 24 })
        }}
      >
        hover local
      </button>
      <button
        type="button"
        onClick={() => {
          onHoverNode(null)
          onTooltipMove(null)
        }}
      >
        clear hover
      </button>
      <button type="button" onClick={() => onFocusNode('note-a')}>
        focus local
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

const graphData: GraphDataResponse = {
  nodes: [
    {
      id: 'note-a',
      type: 'note',
      label: 'Alpha',
      tags: [],
      wordCount: 5,
      connectionCount: 1,
      emoji: null,
      color: '#111111',
      isOrphan: false,
      isUnresolved: false
    },
    {
      id: 'note-b',
      type: 'note',
      label: 'Beta',
      tags: [],
      wordCount: 3,
      connectionCount: 1,
      emoji: null,
      color: '#222222',
      isOrphan: false,
      isUnresolved: false
    },
    {
      id: 'note-c',
      type: 'note',
      label: 'Gamma',
      tags: [],
      wordCount: 1,
      connectionCount: 0,
      emoji: null,
      color: '#333333',
      isOrphan: false,
      isUnresolved: false
    }
  ],
  edges: [{ id: 'edge-a-b', source: 'note-a', target: 'note-b', type: 'wikilink', weight: 1 }]
}

describe('LocalGraphPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.localGraph = { data: graphData, isLoading: false }
    mocks.sigmaContainerProps = null
    document.documentElement.style.setProperty('--graph-dimmed-node', '#dddddd')
    document.documentElement.style.setProperty('--graph-edge-soft', '#cccccc')
    document.documentElement.style.setProperty('--graph-label-color', '#111111')
    vi.spyOn(performance, 'now').mockReturnValue(0)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(300)
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders loading and empty states with close controls', () => {
    const onClose = vi.fn()

    mocks.localGraph = { data: null, isLoading: true }
    const loading = render(<LocalGraphPanel noteId="note-a" onClose={onClose} />)
    expect(screen.getByText('local-panel.loading')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('local-panel.close'))
    expect(onClose).toHaveBeenCalledTimes(1)

    loading.unmount()
    mocks.localGraph = { data: { nodes: [], edges: [] }, isLoading: false }
    render(<LocalGraphPanel noteId="note-a" onClose={onClose} />)
    expect(screen.getByText('local-panel.empty')).toBeInTheDocument()
  })

  it('builds the local graph, applies reducers, and handles panel actions', () => {
    const onClose = vi.fn()
    const onOpenFullGraph = vi.fn()

    const { unmount } = render(
      <LocalGraphPanel noteId="note-a" onClose={onClose} onOpenFullGraph={onOpenFullGraph} />
    )

    expect(screen.getByTestId('sigma')).toBeInTheDocument()
    expect(mocks.sigmaContainerProps?.settings.labelColor).toEqual({ color: '#111111' })
    expect(mocks.sigmaContainerProps?.graph.hasNode('note-a')).toBe(true)

    const settings = mocks.sigmaContainerProps?.settings
    expect(settings.nodeReducer('note-a', { size: 5, color: '#000000' })).toMatchObject({
      color: '#f59e0b',
      highlighted: true,
      forceLabel: true,
      zIndex: 2
    })
    expect(
      settings.edgeReducer('note-a-note-b-wikilink', { color: '#000000', size: 1 })
    ).toMatchObject({
      color: '#cccccc',
      size: 1
    })
    expect(settings.edgeReducer('missing', { color: '#000000' })).toEqual({ color: '#000000' })

    fireEvent.click(screen.getByTitle('local-panel.open-full'))
    fireEvent.click(screen.getByTitle('local-panel.close'))
    expect(onOpenFullGraph).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('hover local'))
    expect(screen.getByTestId('tooltip')).toHaveTextContent('note-b:12:24')

    const dimmed = settings.nodeReducer('note-c', { label: 'Gamma', color: '#333333' })
    expect(dimmed).toMatchObject({ label: '', color: '#dddddd', zIndex: 0 })
    const connected = settings.edgeReducer('note-a-note-b-wikilink', { size: 1 })
    expect(connected.size).toBeGreaterThan(1)

    fireEvent.click(screen.getByText('clear hover'))
    expect(screen.queryByTestId('tooltip')).not.toBeInTheDocument()

    act(() => {
      vi.runOnlyPendingTimers()
    })
    unmount()
  })

  it('runs a live simulation and stops it on unmount', () => {
    // The suite-wide stub runs frames synchronously, which would settle the whole
    // simulation during mount. Queue them instead so each step is observable, keyed by
    // handle so a cancel really drops the callback — the simulation is rebuilt once the
    // panel's graph is filled, and its first, superseded frame must not still be pending.
    const frames = new Map<number, FrameRequestCallback>()
    let nextHandle = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      nextHandle += 1
      frames.set(nextHandle, callback)
      return nextHandle
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) => {
      frames.delete(handle)
    })
    const runNextFrame = (time: number): void => {
      const next = frames.entries().next()
      if (next.done) return
      frames.delete(next.value[0])
      next.value[1](time)
    }

    const { unmount } = render(<LocalGraphPanel noteId="note-a" onClose={vi.fn()} />)
    const graph = mocks.sigmaContainerProps?.graph
    const before = graph.getNodeAttribute('note-a', 'x')
    expect(frames.size).toBe(1)

    act(() => {
      runNextFrame(16)
    })
    expect(graph.getNodeAttribute('note-a', 'x')).not.toBe(before)
    expect(frames.size).toBe(1)

    unmount()
    const afterUnmount = graph.getNodeAttribute('note-a', 'x')
    act(() => {
      runNextFrame(32)
    })
    expect(graph.getNodeAttribute('note-a', 'x')).toBe(afterUnmount)
  })
})
