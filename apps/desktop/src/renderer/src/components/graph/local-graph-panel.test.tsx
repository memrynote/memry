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
    refresh: vi.fn()
  },
  sigmaContainerProps: null as null | Record<string, any>,
  layoutStart: vi.fn(),
  layoutStop: vi.fn()
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

vi.mock('@react-sigma/layout-forceatlas2', () => ({
  useWorkerLayoutForceAtlas2: () => ({
    start: mocks.layoutStart,
    stop: mocks.layoutStop
  })
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
    expect(mocks.layoutStart).toHaveBeenCalledTimes(1)
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
    expect(mocks.layoutStop).toHaveBeenCalled()
  })
})
