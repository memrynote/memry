import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { GRAPH_SETTINGS_DEFAULTS } from '@memry/contracts/graph-api'
import { GraphControlPanel } from './graph-control-panel'
import { GraphFilters } from './graph-filters'
import { GraphSearch } from './graph-search'
import type { GraphFilterState } from '@/hooks/use-graph-filters'
import type { GraphSettings } from '@memry/contracts/graph-api'

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

function renderWithI18n(ui: React.ReactElement): void {
  render(<I18nextProvider i18n={i18nEn}>{ui}</I18nextProvider>)
}

function renderControlPanel(
  overrides: Partial<GraphFilterState> = {},
  settings: GraphSettings = GRAPH_SETTINGS_DEFAULTS
): void {
  renderWithI18n(
    <GraphControlPanel
      filterState={{ ...defaultFilterState, ...overrides }}
      dispatch={vi.fn()}
      isFiltered={Object.keys(overrides).length > 0}
      focusLabel={overrides.focusNodeId ? 'Alpha' : null}
      settings={settings}
      updateSettings={vi.fn()}
    />
  )
}

describe('graph controls i18n', () => {
  it('renders control panel labels and titles', () => {
    renderControlPanel()

    const settingsButton = screen.getByTitle('Graph settings')
    fireEvent.click(settingsButton)

    expect(screen.getByTitle('Hide settings')).toBeInTheDocument()
    expect(screen.getByText('Filters')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Search nodes...')).toBeInTheDocument()
    expect(screen.getByText('Notes')).toBeInTheDocument()
    expect(screen.getByText('Orphans')).toBeInTheDocument()
    expect(screen.getByText('Display')).toBeInTheDocument()
    expect(screen.getByText('Show labels')).toBeInTheDocument()
  })

  it('offers a canvas connections switch that toggles canvas edges', () => {
    const dispatch = vi.fn()
    renderWithI18n(
      <GraphControlPanel
        filterState={defaultFilterState}
        dispatch={dispatch}
        isFiltered={false}
        focusLabel={null}
        settings={GRAPH_SETTINGS_DEFAULTS}
        updateSettings={vi.fn()}
      />
    )

    const toggle = screen.getByRole('switch', { name: 'Canvas connections' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)

    expect(dispatch).toHaveBeenCalledWith({ type: 'TOGGLE_CANVAS_EDGES' })
  })

  it('asks before Re-layout and only runs it on confirm', async () => {
    const onRelayout = vi.fn()
    renderWithI18n(
      <GraphControlPanel
        filterState={defaultFilterState}
        dispatch={vi.fn()}
        isFiltered={false}
        focusLabel={null}
        settings={GRAPH_SETTINGS_DEFAULTS}
        updateSettings={vi.fn()}
        onRelayout={onRelayout}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Re-layout' }))
    expect(await screen.findByText('Re-layout the graph?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onRelayout).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Re-layout' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Re-layout' }))
    expect(onRelayout).toHaveBeenCalledOnce()
  })

  it('renders focused node depth and clear-focus accessible label', () => {
    renderControlPanel({ focusNodeId: 'note-1', focusDepth: 2 })
    fireEvent.click(screen.getByTitle('Graph settings'))

    expect(screen.getByText('depth 2')).toBeInTheDocument()
    expect(screen.getByLabelText('Clear focused node')).toBeInTheDocument()
  })

  it('renders standalone graph search labels', () => {
    renderWithI18n(
      <GraphSearch
        filterState={{ ...defaultFilterState, searchQuery: 'alpha' }}
        dispatch={vi.fn()}
      />
    )

    expect(screen.getByPlaceholderText('Search nodes...')).toBeInTheDocument()
    expect(screen.getByLabelText('Clear graph search')).toBeInTheDocument()
  })

  it('renders legacy filter toolbar accessible labels', () => {
    renderWithI18n(
      <GraphFilters
        filterState={defaultFilterState}
        dispatch={vi.fn()}
        isFiltered={true}
        focusLabel={null}
      />
    )

    expect(screen.getByLabelText('Toggle Notes')).toBeInTheDocument()
    expect(screen.getByLabelText('Toggle orphan nodes')).toBeInTheDocument()
    expect(screen.getByLabelText('Reset filters')).toBeInTheDocument()
  })

  it('lists tag categories as a legend with collapse controls', () => {
    const onColorByChange = vi.fn()
    const onToggleCategory = vi.fn()
    const categories = [
      { id: 'work', label: 'Work', colorVar: '--graph-group-1', tags: ['job'], count: 3 },
      { id: 'home', label: 'Home', colorVar: '--graph-group-2', tags: ['kids'], count: 0 },
      { id: 'old', label: 'Old', colorVar: '--graph-group-3', tags: ['x'], count: 0 }
    ]
    renderWithI18n(
      <GraphControlPanel
        filterState={defaultFilterState}
        dispatch={vi.fn()}
        isFiltered={false}
        focusLabel={null}
        settings={GRAPH_SETTINGS_DEFAULTS}
        updateSettings={vi.fn()}
        viewsMenu={<div data-testid="views-menu" />}
        colorBy="tag-category"
        onColorByChange={onColorByChange}
        categories={categories}
        collapsedCategoryIds={['old']}
        onToggleCategory={onToggleCategory}
      />
    )

    expect(screen.getByTestId('views-menu')).toBeInTheDocument()
    expect(screen.getByText('Uncategorized')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Collapse Work'))
    expect(onToggleCategory).toHaveBeenCalledWith('work')
    // An empty category has nothing to collapse, but a collapsed one can still expand.
    expect(screen.getByLabelText('Collapse Home')).toBeDisabled()
    expect(screen.getByLabelText('Expand Old')).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('switch', { name: 'Color by category' }))
    expect(onColorByChange).toHaveBeenCalledWith('type')
  })

  it('explains tag categories when there are none', () => {
    renderWithI18n(
      <GraphControlPanel
        filterState={defaultFilterState}
        dispatch={vi.fn()}
        isFiltered={false}
        focusLabel={null}
        settings={GRAPH_SETTINGS_DEFAULTS}
        updateSettings={vi.fn()}
        colorBy="type"
        onColorByChange={vi.fn()}
        categories={[]}
        onToggleCategory={vi.fn()}
      />
    )

    expect(screen.getByText(/Group tags into categories/)).toBeInTheDocument()
  })
})
