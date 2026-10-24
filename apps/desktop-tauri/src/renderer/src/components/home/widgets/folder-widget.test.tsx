import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FolderWidget } from './folder-widget'
import type { ViewConfig } from '@/hooks/use-folder-view'

const note = {
  id: 'n1',
  path: 'notes/projects/alpha.md',
  title: 'Alpha',
  emoji: null,
  folder: '/',
  tags: [],
  created: '2024-01-01T00:00:00.000Z',
  modified: '2024-01-02T00:00:00.000Z',
  wordCount: 42,
  properties: {}
}

const tableView: ViewConfig = {
  name: 'Default',
  type: 'table',
  default: true,
  columns: [{ id: 'title' }, { id: 'status' }, { id: 'modified' }]
}
const galleryView: ViewConfig = { name: 'Cards', type: 'grid' }

const folderViewMock = vi.fn()

vi.mock('@/hooks/use-folder-view', () => ({
  useFolderView: () => folderViewMock()
}))

vi.mock('@/hooks/use-notes-query', () => ({
  useNoteTagsQuery: () => ({ tags: [], isLoading: false, error: null })
}))

vi.mock('@/hooks/use-display-density', () => ({
  useDisplayDensity: () => ({ density: 'comfortable' })
}))

vi.mock('@/contexts/tabs/context', () => ({
  useTabActions: () => ({ openTab: vi.fn() })
}))

// Stub the heavy view bodies so the test exercises the widget's view-type branching, not the
// internals of TanStack Table / gallery / list (those have their own suites).
vi.mock('@/components/folder-view/folder-table-view', () => ({
  FolderTableView: (p: { notes: unknown[]; columns: unknown[] }) => (
    <div data-testid="table-body">{`${p.notes.length} rows / ${p.columns.length} cols`}</div>
  )
}))
vi.mock('@/components/folder-view/folder-gallery-view', () => ({
  FolderGalleryView: (p: { notes: { title: string }[] }) => (
    <div data-testid="gallery-body">{p.notes.map((n) => n.title).join(',')}</div>
  )
}))
vi.mock('@/components/folder-view/folder-list-view', () => ({
  FolderListView: (p: { notes: { title: string }[] }) => (
    <div data-testid="list-body">{p.notes.map((n) => n.title).join(',')}</div>
  )
}))

function mockFolderView(overrides: Record<string, unknown> = {}): void {
  folderViewMock.mockReturnValue({
    views: [tableView, galleryView],
    activeView: tableView,
    activeViewIndex: 0,
    setActiveViewIndex: vi.fn(),
    notes: [note],
    availableProperties: [{ name: 'status', type: 'select', usageCount: 1 }],
    formulasMap: {},
    updateNoteProperty: vi.fn(),
    updateSorting: vi.fn(),
    updateColumns: vi.fn(),
    updateDisplayName: vi.fn(),
    isLoading: false,
    error: null,
    ...overrides
  })
}

describe('FolderWidget', () => {
  beforeEach(() => {
    folderViewMock.mockReset()
    mockFolderView()
  })

  it('renders empty state when no folder is configured', () => {
    render(<FolderWidget config={{ folderPath: '' }} size="M" />)
    expect(screen.getByText('No folder selected')).toBeInTheDocument()
  })

  it('renders the table body with property columns when the active view is a table', () => {
    render(<FolderWidget config={{ folderPath: 'projects' }} size="M" />)
    const wrapper = screen.getByTestId('table-body').closest('[data-widget-folder-view]')
    expect(wrapper).toHaveAttribute('data-widget-folder-view', 'table')
    // 3 columns from the saved view => property columns are passed through.
    expect(screen.getByTestId('table-body')).toHaveTextContent('1 rows / 3 cols')
  })

  it('renders the gallery body when the active view is a grid type', () => {
    mockFolderView({ activeView: galleryView, activeViewIndex: 1 })
    render(<FolderWidget config={{ folderPath: 'projects', viewName: 'Cards' }} size="M" />)
    const wrapper = screen.getByTestId('gallery-body').closest('[data-widget-folder-view]')
    expect(wrapper).toHaveAttribute('data-widget-folder-view', 'grid')
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })
})
