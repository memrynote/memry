import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StatusEditor } from './status-editor'
import type { Status } from '@/data/tasks-data'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  )
}))

vi.mock('@/components/ui/input', () => ({
  Input: ({
    ref: _ref,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    ref?: React.Ref<HTMLInputElement>
  }) => <input {...props} />
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
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

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

const statuses = (): Status[] => [
  { id: 'todo', name: 'To Do', color: '#6b7280', type: 'todo', order: 0 },
  { id: 'doing', name: 'Doing', color: '#f59e0b', type: 'in_progress', order: 1 },
  { id: 'review', name: 'Review', color: '#3b82f6', type: 'in_progress', order: 2 },
  { id: 'done', name: 'Done', color: '#10b981', type: 'done', order: 3 }
]

describe('StatusEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updates status name, color, type, and adds a default status', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    render(<StatusEditor statuses={statuses()} onChange={onChange} error="Statuses are required" />)

    fireEvent.change(screen.getByDisplayValue('Doing'), { target: { value: 'In Flight' } })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'doing', name: 'In Flight' })])
    )

    await user.click(screen.getAllByLabelText('Select red color')[0])
    expect(onChange).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'todo', color: '#ef4444' })])
    )

    const doingRow = screen.getByDisplayValue('Doing').closest('[draggable="true"]') as HTMLElement
    await user.click(within(doingRow).getByRole('button', { name: 'Done' }))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'doing', type: 'done' })])
    )

    await user.click(screen.getByRole('button', { name: /addStatus/i }))
    expect(onChange).toHaveBeenLastCalledWith([
      ...statuses(),
      expect.objectContaining({ id: expect.stringMatching(/^status-/), order: 4, type: 'todo' })
    ])
    expect(screen.getByText('Statuses are required')).toBeInTheDocument()
  })

  it('blocks protected deletes, deletes allowed statuses, and reorders dragged rows', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    render(<StatusEditor statuses={statuses()} onChange={onChange} />)

    await user.click(screen.getAllByLabelText("Projects need at least one 'To Do' status")[0])
    expect(onChange).not.toHaveBeenCalled()

    await user.click(screen.getAllByLabelText('Delete status')[0])
    expect(onChange).toHaveBeenLastCalledWith([
      { id: 'todo', name: 'To Do', color: '#6b7280', type: 'todo', order: 0 },
      { id: 'review', name: 'Review', color: '#3b82f6', type: 'in_progress', order: 1 },
      { id: 'done', name: 'Done', color: '#10b981', type: 'done', order: 2 }
    ])

    const rows = screen
      .getAllByDisplayValue(/To Do|Doing|Review|Done/)
      .map((input) => input.closest('[draggable="true"]'))
      .filter(Boolean) as HTMLElement[]
    fireEvent.dragStart(rows[0], {
      dataTransfer: { effectAllowed: '', dropEffect: '', setData: vi.fn() }
    })
    fireEvent.dragOver(rows[2], {
      dataTransfer: { effectAllowed: '', dropEffect: '', setData: vi.fn() }
    })
    fireEvent.dragEnd(rows[0])

    expect(onChange).toHaveBeenLastCalledWith([
      { id: 'doing', name: 'Doing', color: '#f59e0b', type: 'in_progress', order: 0 },
      { id: 'review', name: 'Review', color: '#3b82f6', type: 'in_progress', order: 1 },
      { id: 'todo', name: 'To Do', color: '#6b7280', type: 'todo', order: 2 },
      { id: 'done', name: 'Done', color: '#10b981', type: 'done', order: 3 }
    ])
  })
})
