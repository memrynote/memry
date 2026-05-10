import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { VersionHistory } from './version-history'

const mocks = vi.hoisted(() => ({
  getVersions: vi.fn(),
  getVersion: vi.fn(),
  restoreVersion: vi.fn(),
  deleteVersion: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      [key, params?.title, params?.count].filter(Boolean).join(':')
  })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({ getFixedT: () => (key: string) => key })
}))

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError
  }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    getVersions: mocks.getVersions,
    getVersion: mocks.getVersion,
    restoreVersion: mocks.restoreVersion,
    deleteVersion: mocks.deleteVersion
  }
}))

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  SheetContent: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>
}))

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="alertdialog">{children}</div> : null,
  AlertDialogAction: ({
    children,
    onClick,
    disabled
  }: {
    children: ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => (
    <button disabled={disabled}>{children}</button>
  ),
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h3>{children}</h3>
}))

const renderHistory = (props: Partial<React.ComponentProps<typeof VersionHistory>> = {}) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })

  return render(
    <QueryClientProvider client={client}>
      <VersionHistory open noteId="note-1" noteTitle="Roadmap" onOpenChange={vi.fn()} {...props} />
    </QueryClientProvider>
  )
}

describe('VersionHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getVersions.mockResolvedValue([
      {
        id: 'version-1',
        title: 'Latest draft',
        reason: 'auto',
        wordCount: 42,
        createdAt: '2026-05-10T09:00:00Z'
      },
      {
        id: 'version-2',
        title: 'Older draft',
        reason: 'manual',
        wordCount: 20,
        createdAt: '2026-05-09T09:00:00Z'
      }
    ])
    mocks.getVersion.mockResolvedValue({
      id: 'version-1',
      title: 'Latest draft',
      createdAt: '2026-05-10T09:00:00Z',
      fileContent: '# Draft'
    })
    mocks.restoreVersion.mockResolvedValue({ success: true })
    mocks.deleteVersion.mockResolvedValue({ success: true })
  })

  it('renders empty, error, and closed states', async () => {
    const closed = renderHistory({ open: false })
    expect(closed.container).toBeEmptyDOMElement()

    closed.unmount()
    mocks.getVersions.mockResolvedValueOnce([])
    renderHistory()
    expect(await screen.findByText('versionHistory.empty')).toBeInTheDocument()

    mocks.getVersions.mockRejectedValueOnce(new Error('load failed'))
    const errored = renderHistory({ noteId: 'note-2' })
    expect(await screen.findByText('load failed')).toBeInTheDocument()
    fireEvent.click(screen.getByText('button.retry'))
    errored.unmount()
  })

  it('loads previews, restores, and closes on escape', async () => {
    const onOpenChange = vi.fn()
    const onRestore = vi.fn()
    renderHistory({ onOpenChange, onRestore })

    fireEvent.click(await screen.findByText('Latest draft'))
    await waitFor(() => {
      expect(mocks.getVersion).toHaveBeenCalledWith('version-1')
    })

    fireEvent.click(screen.getByText('versionHistory.showPreview'))
    expect(await screen.findByText('# Draft')).toBeInTheDocument()

    fireEvent.click(screen.getAllByText('versionHistory.restore')[0])
    fireEvent.click(screen.getAllByText('versionHistory.restore')[1])
    await waitFor(() => {
      expect(mocks.restoreVersion).toHaveBeenCalledWith('version-1')
      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(onRestore).toHaveBeenCalled()
      expect(mocks.toastSuccess).toHaveBeenCalledWith('versionHistory.toast.restored')
    })

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('reports preview, restore, and delete failures', async () => {
    mocks.getVersion.mockRejectedValueOnce(new Error('preview failed'))
    mocks.restoreVersion.mockResolvedValueOnce({ success: false, error: 'restore failed' })
    mocks.deleteVersion.mockResolvedValueOnce({ success: false, error: 'delete failed' })

    renderHistory()
    fireEvent.click(await screen.findByText('Latest draft'))

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('versionHistory.toast.loadPreviewFailed')
    })
  })
})
