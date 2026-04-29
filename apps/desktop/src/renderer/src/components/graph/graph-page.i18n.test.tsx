import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { GRAPH_SETTINGS_DEFAULTS } from '@memry/contracts/graph-api'
import { GraphPage } from './graph-page'
import type { GraphFilterState } from '@/hooks/use-graph-filters'
import type { GraphDataResponse } from '@memry/contracts/graph-api'

const graphHookMocks = vi.hoisted(() => ({
  useGraphData: vi.fn(),
  useGraphReactivity: vi.fn(),
  useGraphFilters: vi.fn(),
  useGraphSettings: vi.fn()
}))

vi.mock('@/hooks/use-graph-data', () => ({
  useGraphData: graphHookMocks.useGraphData,
  useGraphReactivity: graphHookMocks.useGraphReactivity
}))

vi.mock('@/hooks/use-graph-filters', () => ({
  useGraphFilters: graphHookMocks.useGraphFilters
}))

vi.mock('@/hooks/use-graph-settings', () => ({
  useGraphSettings: graphHookMocks.useGraphSettings
}))

vi.mock('./graph-canvas', () => ({
  GraphCanvas: () => <div data-testid="graph-canvas" />
}))

vi.mock('./graph-control-panel', () => ({
  GraphControlPanel: () => <div data-testid="graph-control-panel" />
}))

const defaultFilterState: GraphFilterState = {
  showNotes: true,
  showTasks: true,
  showJournals: true,
  showProjects: true,
  showTags: true,
  showOrphans: true,
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
  graphHookMocks.useGraphData.mockReturnValue({
    data: null,
    isLoading: false,
    error: null,
    refetch: vi.fn()
  })
  graphHookMocks.useGraphFilters.mockReturnValue({
    filterState: defaultFilterState,
    dispatch: vi.fn(),
    isFiltered: false
  })
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
})
