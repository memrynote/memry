import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FolderWidget } from './folder-widget'

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

const folderNotesMock = vi.fn(() => ({ notes: [note], isLoading: false, error: null }))

vi.mock('@/hooks/use-folder-notes', () => ({
  useFolderNotes: (opts: { folderPath: string }) => folderNotesMock(opts)
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

describe('FolderWidget', () => {
  it('renders empty state when no folder is configured', () => {
    render(<FolderWidget config={{ folderPath: '', viewType: 'list' }} size="M" />)
    expect(screen.getByText('Pick a folder')).toBeInTheDocument()
  })

  it('renders the list view body with notes when viewType is list', () => {
    render(
      <FolderWidget config={{ folderPath: 'projects', viewType: 'list' }} size="M" />
    )
    const wrapper = screen.getByText('Alpha').closest('[data-widget-folder-view]')
    expect(wrapper).toHaveAttribute('data-widget-folder-view', 'list')
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })

  it('switches the rendered body when viewType changes', () => {
    const { rerender } = render(
      <FolderWidget config={{ folderPath: 'projects', viewType: 'list' }} size="M" />
    )
    expect(
      screen.getByText('Alpha').closest('[data-widget-folder-view]')
    ).toHaveAttribute('data-widget-folder-view', 'list')

    rerender(<FolderWidget config={{ folderPath: 'projects', viewType: 'gallery' }} size="M" />)
    expect(
      screen.getByText('Alpha').closest('[data-widget-folder-view]')
    ).toHaveAttribute('data-widget-folder-view', 'gallery')
  })
})
