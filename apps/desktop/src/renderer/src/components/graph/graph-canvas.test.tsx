import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphDataResponse, GraphSettings } from '@memry/contracts/graph-api'
import type { GraphFilterState } from '@/hooks/use-graph-filters'

const graphCanvasMocks = vi.hoisted(() => ({
  sigma: {
    setSetting: vi.fn(),
    refresh: vi.fn()
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
    onContextMenu
  }: {
    onHoverNode: (id: string | null) => void
    onTooltipMove: (pos: { x: number; y: number } | null) => void
    onFocusNode: (id: string) => void
    onContextMenu?: (menu: { nodeId: string; x: number; y: number } | null) => void
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
        isPreview: true
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

  it('syncs sigma settings and starts/stops forceatlas layout', () => {
    const { rerender, unmount } = render(
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

    expect(graphCanvasMocks.layoutStart).toHaveBeenCalledTimes(1)
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

    rerender(
      <GraphCanvas
        data={data}
        filterState={filters}
        graphSettings={{ ...settings, layout: 'random', animateLayout: false }}
        onFocusNode={vi.fn()}
      />
    )

    unmount()
    expect(graphCanvasMocks.layoutStop).toHaveBeenCalled()
  })
})
