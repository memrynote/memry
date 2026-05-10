import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ViewSwitcher } from './view-switcher'
import type { ViewConfig } from '@/hooks/use-folder-view'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({
    getFixedT: () => (key: string) => key
  })
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn() })
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect
  }: {
    children: React.ReactNode
    onSelect?: (event: { preventDefault: () => void }) => void
  }) => (
    <button type="button" onClick={() => onSelect?.({ preventDefault: vi.fn() })}>
      {children}
    </button>
  )
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="alertdialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  AlertDialogAction: ({
    children,
    onClick
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  )
}))

const views: ViewConfig[] = [
  {
    name: 'Table',
    type: 'table',
    default: true,
    columns: [{ id: 'title', width: 250 }],
    order: [{ property: 'modified', direction: 'desc' }]
  },
  {
    name: 'Board',
    type: 'table',
    columns: [{ id: 'status', width: 120 }],
    order: [{ property: 'title', direction: 'asc' }]
  }
]

function renderSwitcher(overrides: Partial<React.ComponentProps<typeof ViewSwitcher>> = {}) {
  const props = {
    views,
    activeViewIndex: 0,
    activeView: views[0],
    onViewChange: vi.fn(),
    onAddView: vi.fn().mockResolvedValue(undefined),
    onUpdateView: vi.fn().mockResolvedValue(undefined),
    onSetViewAsDefault: vi.fn().mockResolvedValue(undefined),
    onDeleteView: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }

  render(<ViewSwitcher {...props} />)
  return props
}

describe('ViewSwitcher', () => {
  it('selects, duplicates, sets default, and deletes views', async () => {
    const props = renderSwitcher()

    fireEvent.click(screen.getByRole('button', { name: /Board/ }))
    expect(props.onViewChange).toHaveBeenCalledWith(1)

    fireEvent.click(screen.getAllByRole('button', { name: /duplicate/ })[0])
    await waitFor(() =>
      expect(props.onAddView).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Table (copy)', default: false })
      )
    )

    fireEvent.click(screen.getByRole('button', { name: /setAsDefault/ }))
    await waitFor(() => expect(props.onSetViewAsDefault).toHaveBeenCalledWith(1))

    fireEvent.click(screen.getAllByRole('button', { name: /delete/ })[1])
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(props.onDeleteView).toHaveBeenCalledWith('Board'))
  })

  it('creates fresh views and renames non-active views', async () => {
    const props = renderSwitcher()

    fireEvent.click(screen.getByRole('button', { name: /createNewView/ }))
    fireEvent.change(screen.getByLabelText('viewName'), { target: { value: 'Research' } })
    fireEvent.click(screen.getByLabelText('startFreshDefaultColumns'))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(props.onAddView).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Research',
          type: 'table',
          order: [{ property: 'modified', direction: 'desc' }]
        })
      )
    )

    fireEvent.click(screen.getAllByRole('button', { name: /rename/ })[1])
    fireEvent.change(screen.getByLabelText('viewName2'), { target: { value: 'Planning' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(props.onViewChange).toHaveBeenCalledWith(1))
    expect(props.onUpdateView).toHaveBeenCalledWith({ name: 'Planning' })
  })
})
