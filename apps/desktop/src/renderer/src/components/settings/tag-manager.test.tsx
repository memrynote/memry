import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { TagManager } from './tag-manager'

const mocks = vi.hoisted(() => ({
  tagsState: {
    tags: [] as Array<{ name: string; count: number; color?: string | null; icon?: string | null }>,
    isLoading: false,
    error: null as string | null
  },
  renameTag: vi.fn(),
  mergeTag: vi.fn(),
  deleteTag: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      [key, params?.name, params?.oldName, params?.newName, params?.source, params?.target]
        .filter(Boolean)
        .join(':')
  })
}))

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError
  }
}))

vi.mock('@/hooks/use-tags', () => ({
  useTags: () => ({
    ...mocks.tagsState,
    renameTag: mocks.renameTag,
    mergeTag: mocks.mergeTag,
    deleteTag: mocks.deleteTag
  })
}))

vi.mock('./tag-icon-chip', () => ({
  TagIconChip: () => <button type="button">tag-icon</button>
}))

vi.mock('@/components/note/tags-row/tag-colors', () => ({
  getTagColors: (color: string) => ({ background: `${color}-bg`, text: `${color}-text` }),
  isHexColor: (v: string) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v),
  TAG_COLORS: {
    red: { background: '#f00' },
    blue: { background: '#00f' }
  },
  COLOR_ROWS: [['red', 'blue']]
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick
  }: {
    children: ReactNode
    onClick?: () => void
    className?: string
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />
}))

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="alertdialog">{children}</div> : null,
  AlertDialogAction: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: ReactNode
  }) => (
    <div>
      {children}
      <select
        aria-label="merge target"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        <option value="" />
        <option value="work">work</option>
        <option value="home">home</option>
      </select>
    </div>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: ({ placeholder }: { placeholder: string }) => <span>{placeholder}</span>
}))

describe('TagManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tagsState = {
      tags: [
        { name: 'work', count: 3, color: 'red' },
        { name: 'home', count: 1, color: null }
      ],
      isLoading: false,
      error: null
    }
    mocks.renameTag.mockResolvedValue({ success: true })
    mocks.mergeTag.mockResolvedValue({ success: true, affectedItems: 2 })
    mocks.deleteTag.mockResolvedValue({ success: true, affectedNotes: 3 })
    ;(window as Window & { api: any }).api.tags.updateTagColor = vi
      .fn()
      .mockResolvedValue({ success: true })
    ;(window as Window & { api: any }).api.tags.updateTagIcon = vi
      .fn()
      .mockResolvedValue({ success: true })
  })

  it('renders loading, error, empty, filtering, and no-match states', () => {
    mocks.tagsState.isLoading = true
    const loading = render(<TagManager />)
    expect(screen.getByText('tags.loading')).toBeInTheDocument()

    loading.unmount()
    mocks.tagsState.isLoading = false
    mocks.tagsState.error = 'failed'
    const errored = render(<TagManager />)
    expect(screen.getByText('failed')).toBeInTheDocument()

    errored.unmount()
    mocks.tagsState.error = null
    mocks.tagsState.tags = []
    const empty = render(<TagManager />)
    expect(screen.getByText('tags.empty')).toBeInTheDocument()

    empty.unmount()
    mocks.tagsState.tags = [{ name: 'work', count: 3, color: 'red' }]
    render(<TagManager />)
    fireEvent.change(screen.getByPlaceholderText('tags.filterPlaceholder'), {
      target: { value: 'missing' }
    })
    expect(screen.getByText('tags.noMatch')).toBeInTheDocument()
  })

  it('renames tags, skips unchanged names, and reports rename failures', async () => {
    const { rerender } = render(<TagManager />)

    fireEvent.click(screen.getAllByText('tags.actions.rename')[0])
    const input = screen.getByDisplayValue('work')
    fireEvent.change(input, { target: { value: 'later' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(mocks.renameTag).toHaveBeenCalledWith('work', 'later')
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('tags.toasts.renamed:work:later')

    mocks.renameTag.mockClear()
    fireEvent.click(screen.getAllByText('tags.actions.rename')[0])
    fireEvent.keyDown(screen.getByDisplayValue('work'), { key: 'Escape' })
    expect(mocks.renameTag).not.toHaveBeenCalled()

    mocks.renameTag.mockResolvedValueOnce({ success: false, error: 'duplicate' })
    rerender(<TagManager />)
    fireEvent.click(screen.getAllByText('tags.actions.rename')[0])
    fireEvent.change(screen.getByDisplayValue('work'), { target: { value: 'home' } })
    fireEvent.blur(screen.getByDisplayValue('home'))

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('duplicate')
    })
  })

  it('deletes, merges, and changes tag colors with success and error toasts', async () => {
    render(<TagManager />)

    fireEvent.click(screen.getAllByText('tags.actions.delete')[0])
    fireEvent.click(screen.getAllByText('tags.actions.delete').at(-1)!)
    await waitFor(() => {
      expect(mocks.deleteTag).toHaveBeenCalledWith('work')
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('tags.toasts.deleted:work')

    fireEvent.click(screen.getAllByText('tags.actions.mergeInto')[0])
    fireEvent.change(screen.getByLabelText('merge target'), { target: { value: 'home' } })
    fireEvent.click(screen.getByText('tags.actions.merge'))
    await waitFor(() => {
      expect(mocks.mergeTag).toHaveBeenCalledWith('work', 'home')
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('tags.toasts.merged:work:home')

    fireEvent.click(screen.getAllByText('tags.actions.changeColor')[0])
    fireEvent.click(screen.getByTitle('blue'))
    await waitFor(() => {
      expect(window.api.tags.updateTagColor).toHaveBeenCalledWith({ tag: 'work', color: 'blue' })
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('tags.toasts.colorUpdated:work')
    ;(window.api.tags.updateTagColor as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('color failed')
    )
    fireEvent.click(screen.getAllByText('tags.actions.changeColor')[0])
    fireEvent.click(screen.getByTitle('red'))
    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('color failed')
    })
  })
})
