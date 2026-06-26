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

// Popover renders trigger + content inline so both screens are reachable in tests.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
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
    onRenameView: vi.fn().mockResolvedValue(undefined),
    onSetViewAsDefault: vi.fn().mockResolvedValue(undefined),
    onDeleteView: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }

  render(<ViewSwitcher {...props} />)
  return props
}

describe('ViewSwitcher', () => {
  it('selects a view from the list', () => {
    const props = renderSwitcher()
    fireEvent.click(screen.getByRole('button', { name: 'Board' }))
    expect(props.onViewChange).toHaveBeenCalledWith(1)
  })

  it('creates a new view immediately by copying the current view', async () => {
    const props = renderSwitcher()

    fireEvent.click(screen.getByRole('button', { name: 'newView' }))

    await waitFor(() =>
      expect(props.onAddView).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'newView', type: 'table', default: false })
      )
    )
  })

  it('renames a view in place on every keystroke (no save button)', async () => {
    const props = renderSwitcher()

    fireEvent.click(screen.getAllByRole('button', { name: 'viewActions' })[1])
    expect(props.onViewChange).toHaveBeenCalledWith(1)

    const input = screen.getByDisplayValue('Board')
    fireEvent.change(input, { target: { value: 'Boar' } })
    fireEvent.change(input, { target: { value: 'Boardd' } })

    await waitFor(() => {
      expect(props.onRenameView).toHaveBeenCalledWith(1, 'Boar')
      expect(props.onRenameView).toHaveBeenCalledWith(1, 'Boardd')
    })
  })

  it('applies a layout change live on click (no save button)', () => {
    const props = renderSwitcher()

    fireEvent.click(screen.getAllByRole('button', { name: 'viewActions' })[1])
    fireEvent.click(screen.getByRole('button', { name: 'list' }))

    expect(props.onUpdateView).toHaveBeenCalledWith({ type: 'list' })
  })

  it('duplicates a view from the editor', async () => {
    const props = renderSwitcher()

    fireEvent.click(screen.getAllByRole('button', { name: 'viewActions' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'duplicate' }))

    await waitFor(() =>
      expect(props.onAddView).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Table (copy)', default: false })
      )
    )
  })

  it('sets a non-default view as default from the editor', async () => {
    const props = renderSwitcher()

    fireEvent.click(screen.getAllByRole('button', { name: 'viewActions' })[1])
    fireEvent.click(screen.getByRole('button', { name: 'setAsDefault' }))

    await waitFor(() => expect(props.onSetViewAsDefault).toHaveBeenCalledWith(1))
  })

  it('deletes a view via confirmation', async () => {
    const props = renderSwitcher()

    fireEvent.click(screen.getAllByRole('button', { name: 'viewActions' })[1])
    fireEvent.click(screen.getByRole('button', { name: 'delete' }))

    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(props.onDeleteView).toHaveBeenCalledWith('Board'))
  })
})
