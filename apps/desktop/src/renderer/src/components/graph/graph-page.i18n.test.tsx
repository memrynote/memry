import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { GRAPH_SETTINGS_DEFAULTS, GRAPH_VIEW_STATE_DEFAULTS } from '@memry/contracts/graph-api'
import { GraphPage } from './graph-page'
import type { GraphFilterState } from '@/hooks/use-graph-filters'
import type { GraphDataResponse } from '@memry/contracts/graph-api'

const graphHookMocks = vi.hoisted(() => ({
  useGraphData: vi.fn(),
  useGraphReactivity: vi.fn(),
  useGraphFilters: vi.fn(),
  useGraphSettings: vi.fn(),
  useGraphViews: vi.fn(),
  useTagCategories: vi.fn()
}))

const renderingMocks = vi.hoisted(() => ({
  webglAvailable: true,
  panelProps: null as null | Record<string, any>,
  canvasProps: null as null | Record<string, any>
}))

vi.mock('@/hooks/use-graph-data', () => ({
  useGraphData: graphHookMocks.useGraphData,
  useGraphReactivity: graphHookMocks.useGraphReactivity
}))

vi.mock('@/hooks/use-graph-filters', () => ({
  useGraphFilters: graphHookMocks.useGraphFilters,
  isGraphFiltered: () => false
}))

vi.mock('@/hooks/use-graph-views', () => ({
  useGraphViews: graphHookMocks.useGraphViews
}))

vi.mock('@/hooks/use-tag-categories', () => ({
  useTagCategories: graphHookMocks.useTagCategories
}))

vi.mock('@/hooks/use-graph-layout', () => ({
  useGraphLayout: () => ({ layout: null, isLoading: false }),
  useGraphLayoutActions: () => ({ save: vi.fn(), clear: vi.fn() })
}))

vi.mock('@/hooks/use-graph-settings', () => ({
  useGraphSettings: graphHookMocks.useGraphSettings
}))

vi.mock('@/lib/webgl-support', () => ({
  hasWebGLSupport: () => renderingMocks.webglAvailable
}))

vi.mock('./graph-canvas', () => ({
  GraphCanvas: (props: Record<string, any>) => {
    renderingMocks.canvasProps = props
    return <div data-testid="graph-canvas" />
  }
}))

vi.mock('./graph-views-menu', () => ({
  GraphViewsMenu: () => null
}))

vi.mock('./graph-control-panel', () => ({
  GraphControlPanel: (props: Record<string, any>) => {
    renderingMocks.panelProps = props
    return <div data-testid="graph-control-panel" />
  }
}))

const defaultFilterState: GraphFilterState = {
  showNotes: true,
  showTasks: true,
  showJournals: true,
  showProjects: true,
  showTags: true,
  showOrphans: true,
  showCanvasEdges: true,
  selectedTags: [],
  focusNodeId: null,
  focusDepth: 2,
  searchQuery: ''
}

let i18nEn: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

beforeEach(() => {
  renderingMocks.webglAvailable = true
  graphHookMocks.useGraphData.mockReturnValue({
    data: null,
    isLoading: false,
    error: null,
    refetch: vi.fn()
  })
  graphHookMocks.useGraphFilters.mockReturnValue({
    viewState: { ...GRAPH_VIEW_STATE_DEFAULTS, filters: defaultFilterState },
    activeViewId: null,
    filterState: defaultFilterState,
    dispatch: vi.fn(),
    isFiltered: false,
    setColorBy: vi.fn(),
    toggleCollapsed: vi.fn(),
    applyView: vi.fn()
  })
  graphHookMocks.useGraphViews.mockReturnValue({
    views: [],
    lastState: null,
    isLoading: false,
    saveView: vi.fn(),
    updateView: vi.fn(),
    deleteView: vi.fn(),
    rememberState: vi.fn()
  })
  graphHookMocks.useTagCategories.mockReturnValue({ categories: [], isLoading: false })
  graphHookMocks.useGraphSettings.mockReturnValue({
    settings: GRAPH_SETTINGS_DEFAULTS,
    updateSettings: vi.fn()
  })
})

function renderPage(): void {
  render(
    <I18nextProvider i18n={i18nEn}>
      <GraphPage />
    </I18nextProvider>
  )
}

function graphData(data: GraphDataResponse): GraphDataResponse {
  return data
}

describe('GraphPage i18n', () => {
  it('offers a close action when the device cannot render WebGL', () => {
    renderingMocks.webglAvailable = false
    const onClose = vi.fn()

    render(
      <I18nextProvider i18n={i18nEn}>
        <GraphPage onClose={onClose} />
      </I18nextProvider>
    )

    expect(screen.getByText("Graph isn't available on this device")).toBeInTheDocument()
    expect(screen.queryByTestId('graph-control-panel')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('renders loading state copy', () => {
    graphHookMocks.useGraphData.mockReturnValue({
      data: null,
      isLoading: true,
      error: null,
      refetch: vi.fn()
    })

    renderPage()

    expect(screen.getByText('Loading graph...')).toBeInTheDocument()
  })

  it('renders error state copy', () => {
    graphHookMocks.useGraphData.mockReturnValue({
      data: null,
      isLoading: false,
      error: new Error('boom'),
      refetch: vi.fn()
    })

    renderPage()

    expect(screen.getByText('Failed to load graph data')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('renders empty state copy', () => {
    graphHookMocks.useGraphData.mockReturnValue({
      data: graphData({ nodes: [], edges: [] }),
      isLoading: false,
      error: null,
      refetch: vi.fn()
    })

    renderPage()

    expect(screen.getByText('Your knowledge graph')).toBeInTheDocument()
    expect(screen.getByText('Link your notes')).toBeInTheDocument()
    expect(screen.getByText('Discover patterns')).toBeInTheDocument()
  })

  it('renders graph aria copy and screen-reader node list label', () => {
    graphHookMocks.useGraphData.mockReturnValue({
      data: graphData({
        nodes: [
          {
            id: 'note-1',
            type: 'note',
            label: 'Alpha',
            tags: [],
            wordCount: 0,
            connectionCount: 1,
            emoji: null,
            color: '#000000',
            isOrphan: false,
            isUnresolved: false
          }
        ],
        edges: [
          {
            id: 'edge-1',
            source: 'note-1',
            target: 'task-1',
            type: 'task-note',
            weight: 1
          }
        ]
      }),
      isLoading: false,
      error: null,
      refetch: vi.fn()
    })

    renderPage()

    expect(
      screen.getByRole('img', {
        name: 'Knowledge graph with 1 node and 1 connection: 1 note.'
      })
    ).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Graph nodes' })).toBeInTheDocument()
  })

  describe('saved views wiring', () => {
    const noteNode = {
      id: 'note-1',
      type: 'note' as const,
      label: 'Alpha',
      tags: ['job'],
      wordCount: 0,
      connectionCount: 0,
      emoji: null,
      color: '#000000',
      isOrphan: false,
      isUnresolved: false
    }
    const savedView = {
      id: 'v1',
      name: 'Work',
      state: GRAPH_VIEW_STATE_DEFAULTS,
      layout: 'circular' as const,
      createdAt: '',
      updatedAt: ''
    }

    function setup(
      filterOverrides: Partial<GraphFilterState> = {},
      activeViewId: string | null = null
    ) {
      const filters = { ...defaultFilterState, ...filterOverrides }
      const hooks = {
        applyView: vi.fn(),
        saveView: vi.fn(() => savedView),
        updateView: vi.fn(),
        deleteView: vi.fn(),
        rememberState: vi.fn(),
        updateSettings: vi.fn()
      }
      graphHookMocks.useGraphData.mockReturnValue({
        data: graphData({ nodes: [noteNode], edges: [] }),
        isLoading: false,
        error: null,
        refetch: vi.fn()
      })
      graphHookMocks.useGraphFilters.mockReturnValue({
        viewState: { ...GRAPH_VIEW_STATE_DEFAULTS, filters },
        activeViewId,
        filterState: filters,
        dispatch: vi.fn(),
        isFiltered: false,
        setColorBy: vi.fn(),
        toggleCollapsed: vi.fn(),
        applyView: hooks.applyView
      })
      graphHookMocks.useGraphViews.mockReturnValue({
        views: [savedView],
        lastState: null,
        isLoading: false,
        saveView: hooks.saveView,
        updateView: hooks.updateView,
        deleteView: hooks.deleteView,
        rememberState: hooks.rememberState
      })
      graphHookMocks.useGraphSettings.mockReturnValue({
        settings: GRAPH_SETTINGS_DEFAULTS,
        updateSettings: hooks.updateSettings
      })
      graphHookMocks.useTagCategories.mockReturnValue({
        categories: [{ id: 'work', name: 'Work', sortOrder: 0, tags: [{ tag: 'job' }] }],
        isLoading: false
      })
      const view = render(
        <I18nextProvider i18n={i18nEn}>
          <GraphPage />
        </I18nextProvider>
      )
      return { hooks, view, menu: renderingMocks.panelProps!.viewsMenu.props }
    }

    it('counts category members and drops a focus on a node that no longer exists', () => {
      setup({ focusNodeId: 'deleted-note' })
      expect(renderingMocks.panelProps!.categories).toMatchObject([{ id: 'work', count: 1 }])
      expect(renderingMocks.canvasProps!.filterState.focusNodeId).toBeNull()
    })

    it('applies, saves, updates and deletes views', () => {
      const { hooks, menu } = setup({}, 'v1')
      expect(menu.activeView).toBe(savedView)
      // The saved view uses a circular layout; the current one does not.
      expect(menu.isModified).toBe(true)

      menu.onApply(savedView)
      expect(hooks.applyView).toHaveBeenCalledWith(savedView.state, 'v1')
      expect(hooks.updateSettings).toHaveBeenCalledWith({ layout: 'circular' })

      expect(menu.onSaveAs('Work')).toBe(true)
      expect(hooks.saveView).toHaveBeenCalledWith('Work', expect.any(Object), 'forceatlas2')
      expect(hooks.applyView).toHaveBeenLastCalledWith(expect.any(Object), 'v1')

      menu.onUpdate(savedView)
      expect(hooks.updateView).toHaveBeenCalledWith('v1', expect.any(Object), 'forceatlas2')

      menu.onDelete(savedView)
      expect(hooks.deleteView).toHaveBeenCalledWith('v1')
      expect(hooks.applyView).toHaveBeenLastCalledWith(expect.any(Object), null)
    })

    it('reports a failed save and remembers the state on unmount', () => {
      const { hooks, menu, view } = setup()
      hooks.saveView.mockReturnValueOnce(null as never)
      expect(menu.onSaveAs('Work')).toBe(false)
      expect(hooks.rememberState).not.toHaveBeenCalled()
      view.unmount()
      expect(hooks.rememberState).toHaveBeenCalledOnce()
    })
  })
})
