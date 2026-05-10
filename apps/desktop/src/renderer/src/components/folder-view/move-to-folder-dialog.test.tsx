import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders, getMockApi } from '@tests/utils/render'

import { MoveToFolderDialog } from './move-to-folder-dialog'
import { notesService } from '@/services/notes-service'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) || key })
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({
    children,
    onKeyDown
  }: {
    children: React.ReactNode
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>
  }) => (
    <div role="dialog" onKeyDown={onKeyDown}>
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    getFolders: vi.fn(),
    createFolder: vi.fn()
  }
}))

describe('MoveToFolderDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(notesService.getFolders).mockResolvedValue([
      { path: 'Archive', icon: null },
      { path: 'Projects/Memry', icon: null },
      { path: 'Writing', icon: null }
    ] as any)
    vi.mocked(notesService.createFolder).mockResolvedValue({ success: true } as any)
    const api = getMockApi() as any
    api.folderView = {
      getFolderSuggestions: vi.fn().mockResolvedValue({
        suggestions: [
          { path: 'Projects/Memry', confidence: 0.92, reason: 'similar note' },
          { path: 'Archive', confidence: 0.75, reason: 'current folder skipped' }
        ]
      })
    }
  })

  it('renders suggestions and moves to a selected suggested folder', async () => {
    const user = userEvent.setup()
    const onMove = vi.fn()
    const onOpenChange = vi.fn()

    renderWithProviders(
      <MoveToFolderDialog
        open
        onOpenChange={onOpenChange}
        noteIds={['note-1']}
        currentFolder="Writing"
        noteTitle="Launch plan"
        onMove={onMove}
      />
    )

    expect(screen.getByRole('heading', { name: 'Move "Launch plan"' })).toBeInTheDocument()
    expect(await screen.findByText('Projects/Memry')).toBeInTheDocument()
    expect(screen.getAllByText('bestMatch')).not.toHaveLength(0)
    expect(screen.getByRole('button', { name: /Writing/ })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: /Projects\/Memry/ }))

    expect(onMove).toHaveBeenCalledWith('Projects/Memry')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('searches folders, creates a new folder, and handles keyboard actions', async () => {
    const user = userEvent.setup()
    const onMove = vi.fn()
    const onOpenChange = vi.fn()

    renderWithProviders(
      <MoveToFolderDialog
        open
        onOpenChange={onOpenChange}
        noteIds={['n1', 'n2']}
        currentFolder=""
        onMove={onMove}
      />
    )

    expect(screen.getByRole('heading', { name: 'Move 2 Notes' })).toBeInTheDocument()

    await user.type(await screen.findByPlaceholderText('searchFolders'), 'Research/New')
    await user.click(screen.getByRole('button', { name: /createResearch\/New/ }))

    await waitFor(() => expect(notesService.createFolder).toHaveBeenCalledWith('Research/New'))
    expect(onMove).toHaveBeenCalledWith('Research/New')
    expect(onOpenChange).toHaveBeenCalledWith(false)

    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('uses keyboard shortcuts for suggested folders and the footer move button', async () => {
    const user = userEvent.setup()
    const onMove = vi.fn()
    const onOpenChange = vi.fn()

    renderWithProviders(
      <MoveToFolderDialog
        open
        onOpenChange={onOpenChange}
        noteIds={['note-1']}
        currentFolder="Archive"
        onMove={onMove}
      />
    )

    await screen.findByText('Projects/Memry')
    await user.keyboard('1')
    expect(onMove).toHaveBeenCalledWith('Projects/Memry')

    onMove.mockClear()
    await user.click(screen.getByRole('button', { name: 'Move' }))
    expect(onMove).toHaveBeenCalledWith('Projects/Memry')
  })
})
