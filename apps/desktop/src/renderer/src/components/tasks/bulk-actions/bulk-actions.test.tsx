import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { BulkActionButton } from './bulk-action-button'
import { BulkActionDropdown } from './bulk-action-dropdown'
import { BulkActionToolbar } from './bulk-action-toolbar'
import { BulkDeleteDialog } from './bulk-delete-dialog'
import { BulkDueDatePicker } from './bulk-due-date-picker'
import { SelectionCheckbox } from './selection-checkbox'

const labels: Record<string, string> = {
  bulkActions: 'Bulk actions',
  selected: 'selected',
  complete: 'Complete',
  priority: 'Priority',
  dueDate: 'Due date',
  moveTo: 'Move to',
  status: 'Status',
  archive: 'Archive',
  delete: 'Delete',
  cancelSelection: 'Cancel selection',
  cancel: 'Cancel',
  for: ' for ',
  task: ' task',
  delete2: 'Delete ',
  task2: ' task',
  task3: ' task',
  youReAboutToDelete: "You're about to delete ",
  and: 'and ',
  moreTask: ' more task',
  thisActionCanBeUndoneForAShortTimeAfterDeletion: 'This action can be undone shortly.',
  setDueDateFor: 'Set due date for ',
  selectADateToSetAsTheDueDateForAllSelectedTasks: 'Select a date.',
  alsoSetTime: 'Also set time',
  setDueDate: 'Set due date'
}

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => labels[key.split('.').at(-1) ?? ''] ?? key
  })
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
    className
  }: {
    children: React.ReactNode
    onClick?: () => void
    className?: string
  }) => (
    <button type="button" role="menuitem" className={className} onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({
    children,
    className
  }: {
    children: React.ReactNode
    className?: string
  }) => <div className={className}>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({
    children,
    className,
    disabled
  }: {
    children: React.ReactNode
    className?: string
    disabled?: boolean
  }) => (
    <button type="button" className={className} disabled={disabled}>
      {children}
    </button>
  )
}))

vi.mock('@/components/tasks/date-picker-calendar', () => ({
  DatePickerCalendar: ({
    onSelect,
    disabled
  }: {
    onSelect: (date: Date) => void
    disabled?: (date: Date) => boolean
  }) => (
    <button
      type="button"
      onClick={() => {
        const date = new Date('2026-06-01T00:00:00.000Z')
        expect(disabled?.(new Date('2020-01-01T00:00:00.000Z'))).toBe(true)
        onSelect(date)
      }}
    >
      Pick date
    </button>
  )
}))

const projects = [
  {
    id: 'personal',
    name: 'Personal',
    color: '#f59e0b',
    isArchived: false,
    statuses: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z')
  },
  {
    id: 'archived',
    name: 'Archived',
    color: '#64748b',
    isArchived: true,
    statuses: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z')
  }
] as any[]

const statuses = [
  { id: 'todo', name: 'Todo', color: '#64748b', type: 'todo', order: 0 },
  { id: 'done', name: 'Done', color: '#22c55e', type: 'done', order: 1 }
] as any[]

const tasks = Array.from({ length: 7 }, (_, index) => ({
  id: `task-${index}`,
  title: `Task ${index + 1}`,
  parentId: null,
  subtaskIds: [],
  completedAt: null
})) as any[]

describe('bulk action components', () => {
  it('handles selection checkbox states and event boundaries', () => {
    const onChange = vi.fn()
    const onParentClick = vi.fn()
    const onClick = vi.fn()

    render(
      <div role="button" tabIndex={0} onClick={onParentClick}>
        <SelectionCheckbox
          checked
          indeterminate
          onChange={onChange}
          onClick={onClick}
          aria-label="Select row"
        />
      </div>
    )

    const checkbox = screen.getByRole('checkbox', { name: 'Select row' }) as HTMLInputElement
    expect(checkbox.indeterminate).toBe(true)

    fireEvent.click(checkbox)
    expect(onChange).toHaveBeenCalledWith(false)
    expect(onClick).toHaveBeenCalled()
    expect(onParentClick).not.toHaveBeenCalled()

    fireEvent.keyDown(checkbox, { key: 'Enter' })
    fireEvent.keyDown(checkbox, { key: ' ' })
    expect(checkbox).not.toBeDisabled()
  })

  it('runs button click and keyboard handlers while respecting disabled state', () => {
    const onClick = vi.fn()
    const { rerender } = render(
      <BulkActionButton icon={<span aria-hidden="true">i</span>} label="Do it" onClick={onClick} />
    )

    const button = screen.getByRole('button', { name: 'Do it' })
    fireEvent.click(button)
    fireEvent.keyDown(button, { key: 'Enter' })
    fireEvent.keyDown(button, { key: ' ' })
    expect(onClick).toHaveBeenCalledTimes(3)

    rerender(
      <BulkActionButton
        icon={<span aria-hidden="true">i</span>}
        label="Do it"
        onClick={onClick}
        disabled
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Do it' }))
    expect(onClick).toHaveBeenCalledTimes(3)
  })

  it('opens dropdown options, skips separators, and selects values', () => {
    const onSelect = vi.fn()
    render(
      <BulkActionDropdown
        icon={<span aria-hidden="true">i</span>}
        label="Priority"
        selectedCount={1}
        onSelect={onSelect}
        options={[
          { value: 'high', label: 'High', color: '#ef4444', icon: <span>H</span> },
          { value: 'sep', label: '', isSeparator: true },
          { value: 'low', label: 'Low' }
        ]}
      />
    )

    expect(
      screen.getByText(
        (_, element) => element?.textContent?.replace(/\s+/g, ' ').trim() === 'Priority for 1 task'
      )
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: /high/i }))
    expect(onSelect).toHaveBeenCalledWith('high')
  })

  it('drives toolbar actions, active project filtering, and optional status actions', () => {
    const callbacks = {
      onComplete: vi.fn(),
      onChangePriority: vi.fn(),
      onChangeDueDate: vi.fn(),
      onMoveToProject: vi.fn(),
      onChangeStatus: vi.fn(),
      onArchive: vi.fn(),
      onDelete: vi.fn(),
      onCancel: vi.fn()
    }

    render(
      <BulkActionToolbar
        selectedCount={2}
        projects={projects}
        statuses={statuses}
        showStatusAction
        {...callbacks}
      />
    )

    expect(screen.getByRole('toolbar', { name: 'Bulk actions' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel selection' }))

    expect(callbacks.onComplete).toHaveBeenCalled()
    expect(callbacks.onArchive).toHaveBeenCalled()
    expect(callbacks.onDelete).toHaveBeenCalled()
    expect(callbacks.onCancel).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('menuitem', { name: /urgent/i }))
    expect(callbacks.onChangePriority).toHaveBeenCalledWith('urgent')

    fireEvent.click(screen.getByRole('menuitem', { name: /tomorrow/i }))
    expect(callbacks.onChangeDueDate).toHaveBeenCalledWith('tomorrow')

    expect(screen.queryByRole('menuitem', { name: /archived/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: /personal/i }))
    expect(callbacks.onMoveToProject).toHaveBeenCalledWith('personal')

    fireEvent.click(screen.getByRole('menuitem', { name: /done/i }))
    expect(callbacks.onChangeStatus).toHaveBeenCalledWith('done')
  })

  it('confirms bulk deletes with truncation and closes on cancel', () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn()

    render(<BulkDeleteDialog open onClose={onClose} onConfirm={onConfirm} tasks={tasks} />)

    expect(screen.getByText('Task 1')).toBeInTheDocument()
    expect(screen.queryByText('Task 7')).not.toBeInTheDocument()
    expect(screen.getByText(/and 2 more tasks/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /delete 7 tasks/i }))
    expect(onConfirm).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  /**
   * jsdom does no layout, so this pins the shrink contract instead of the
   * pixels. A long title used to widen the dialog's single grid track past its
   * max width; the footer stretched with the track and carried the confirm
   * button off the dialog, then off the window (#1878). Every box between the
   * dialog and the title has to be allowed to shrink for `truncate` to work.
   */
  it('lets a long task title shrink instead of widening the dialog', () => {
    const longTitle =
      'Research into whether Copilot will classify and retrieve documents instead of Docuware (and retention management)'

    render(
      <BulkDeleteDialog
        open
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        tasks={[{ ...tasks[0], title: longTitle }]}
      />
    )

    expect(screen.getByRole('dialog').className).toContain('grid-cols-[minmax(0,1fr)]')

    const title = screen.getByText(longTitle)
    expect(title).toHaveClass('truncate', 'min-w-0')
    expect(title.parentElement).toHaveClass('min-w-0')
  })

  it('selects due dates with optional time and resets after close', () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    const { rerender } = render(
      <BulkDueDatePicker open onClose={onClose} onConfirm={onConfirm} taskCount={3} />
    )

    expect(screen.getByRole('button', { name: 'Set due date' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Pick date' }))
    fireEvent.click(screen.getByLabelText('Also set time'))
    fireEvent.change(screen.getByDisplayValue('12:00'), { target: { value: '09:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set due date' }))

    expect(onConfirm).toHaveBeenCalledWith(new Date('2026-06-01T00:00:00.000Z'), '09:30')
    expect(onClose).toHaveBeenCalled()

    rerender(<BulkDueDatePicker open onClose={onClose} onConfirm={onConfirm} taskCount={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pick date' }))
    fireEvent.click(screen.getByRole('button', { name: 'Set due date' }))
    expect(onConfirm).toHaveBeenLastCalledWith(new Date('2026-06-01T00:00:00.000Z'), null)
  })
})
