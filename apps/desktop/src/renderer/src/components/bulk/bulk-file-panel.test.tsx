import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BulkFilePanel } from './bulk-file-panel'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
  })
}))

vi.mock('@/components/filing/folder-selector', () => ({
  FolderSelector: ({
    folders,
    suggestedFolders,
    onSelect
  }: {
    folders: Array<{ id: string; name: string; path: string }>
    suggestedFolders: Array<{ id: string; name: string; path: string }>
    onSelect: (folder: { id: string; name: string; path: string }) => void
  }) => (
    <div>
      <div>folders:{folders.map((folder) => folder.name).join(',')}</div>
      <div>suggested:{suggestedFolders.map((folder) => folder.name).join(',')}</div>
      <button onClick={() => onSelect(folders[1] ?? folders[0])}>select folder</button>
    </div>
  )
}))

vi.mock('@/components/filing/tag-autocomplete', () => ({
  TagAutocomplete: ({
    tags,
    onTagsChange
  }: {
    tags: string[]
    onTagsChange: (tags: string[]) => void
  }) => <button onClick={() => onTagsChange([...tags, 'urgent'])}>tags:{tags.join(',')}</button>
}))

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

const items = [
  {
    id: 'item-1',
    title: 'First link',
    type: 'link',
    tags: ['shared', 'links']
  },
  {
    id: 'item-2',
    title: 'Voice note',
    type: 'voice',
    tags: ['shared']
  },
  {
    id: 'item-3',
    title: 'PDF capture',
    type: 'pdf',
    tags: ['shared', 'docs']
  }
] as const

describe('BulkFilePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    window.api.notes.getFolders = vi
      .fn()
      .mockResolvedValue([
        { path: 'Projects' },
        { path: 'Projects/Research' },
        { path: 'Archive' },
        { path: '' }
      ])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads folders, computes common tags, files selected items, and closes on sheet dismiss', async () => {
    const onClose = vi.fn()
    const onFile = vi.fn()

    render(<BulkFilePanel isOpen items={[...items]} onClose={onClose} onFile={onFile} />, {
      wrapper: wrapper()
    })

    expect(screen.getByText('bulk.filePanel.title:{"count":3}')).toBeInTheDocument()
    expect(screen.getByText('First link')).toBeInTheDocument()
    expect(screen.getByText('Voice note')).toBeInTheDocument()
    expect(screen.getByText('PDF capture')).toBeInTheDocument()

    await waitFor(() => expect(window.api.notes.getFolders).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByText(/folders:/)).toHaveTextContent(
        'folders:detail.notesRootLabel,Projects,Research,Archive'
      )
    )
    expect(screen.getByText(/suggested:/)).toHaveTextContent(
      'suggested:detail.notesRootLabel,Projects,Research'
    )
    expect(screen.getByText('tags:shared')).toBeInTheDocument()

    fireEvent.click(screen.getByText('select folder'))
    fireEvent.click(screen.getByText('tags:shared'))
    fireEvent.click(screen.getByRole('button', { name: /bulk.filePanel.submit/ }))

    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    expect(onFile).toHaveBeenCalledWith(['item-1', 'item-2', 'item-3'], 'Projects', [
      'shared',
      'urgent'
    ])
    expect(onClose).toHaveBeenCalled()
  })

  it('does not fetch or render content while closed', () => {
    render(<BulkFilePanel isOpen={false} items={[...items]} onClose={vi.fn()} onFile={vi.fn()} />, {
      wrapper: wrapper()
    })

    expect(screen.queryByText('First link')).not.toBeInTheDocument()
    expect(window.api.notes.getFolders).not.toHaveBeenCalled()
  })
})
