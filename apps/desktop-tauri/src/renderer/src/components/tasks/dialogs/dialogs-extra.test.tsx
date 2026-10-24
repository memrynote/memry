import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Task } from '@/data/task-model'
import { AllSubtasksCompleteDialog } from './all-subtasks-complete-dialog'
import { BulkDueDateDialog } from './bulk-due-date-dialog'
import { BulkPriorityDialog } from './bulk-priority-dialog'
import { CompleteParentDialog } from './complete-parent-dialog'
import { DeleteAllSubtasksDialog } from './delete-all-subtasks-dialog'
import { DeleteParentDialog } from './delete-parent-dialog'
import { DuplicateWithSubtasksDialog } from './duplicate-with-subtasks-dialog'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
  })
}))

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: 'Parent task',
  description: '',
  projectId: 'project-1',
  statusId: 'todo',
  priority: 'none',
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  parentId: null,
  subtaskIds: [],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  completedAt: null,
  archivedAt: null,
  ...overrides
})

describe('task dialogs', () => {
  it('returns null for parent-sensitive dialogs without a parent task', () => {
    const { container: deleteParent } = render(
      <DeleteParentDialog
        open
        onOpenChange={vi.fn()}
        parent={null}
        branch={{ direct: 1, deeper: 0, open: 1 }}
        onConfirm={vi.fn()}
      />
    )
    expect(deleteParent).toBeEmptyDOMElement()
  })

  it('applies bulk priority with optional completed subtasks', () => {
    const onClose = vi.fn()
    const onApply = vi.fn()
    render(
      <BulkPriorityDialog
        isOpen
        parentTitle="Parent task"
        subtaskCount={3}
        completedCount={1}
        onClose={onClose}
        onApply={onApply}
      />
    )

    // One ICU message carries both the count and the parent title.
    expect(
      screen.getByText(
        'phaseF.componentsTasksDialogsBulkPriorityDialog.setPriorityForSubtasksIn:{"count":2,"title":"Parent task"}'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'phaseF.componentsTasksDialogsBulkPriorityDialog.alsoApplyToCompletedSubtasksCount:{"count":1}'
      )
    ).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('High'))
    fireEvent.click(screen.getByRole('checkbox'))

    // Including completed subtasks moves the count inside the same message.
    expect(
      screen.getByText(
        'phaseF.componentsTasksDialogsBulkPriorityDialog.setPriorityForSubtasksIn:{"count":3,"title":"Parent task"}'
      )
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /apply/ }))

    expect(onApply).toHaveBeenCalledWith('high', true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clears and applies bulk due dates with completed-subtask choice', () => {
    const onClose = vi.fn()
    const onApply = vi.fn()
    const { rerender } = render(
      <BulkDueDateDialog
        isOpen
        parentTitle="Parent task"
        subtaskCount={2}
        completedCount={1}
        onClose={onClose}
        onApply={onApply}
      />
    )

    expect(
      screen.getByText(
        'phaseF.componentsTasksDialogsBulkDueDateDialog.setDueDateForSubtasksIn:{"count":1,"title":"Parent task"}'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'phaseF.componentsTasksDialogsBulkDueDateDialog.alsoApplyToCompletedSubtasksCount:{"count":1}'
      )
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /clearDate/ }))
    expect(onApply).toHaveBeenCalledWith(null, true)
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(
      <BulkDueDateDialog
        isOpen
        parentTitle="Parent task"
        subtaskCount={2}
        completedCount={0}
        onClose={onClose}
        onApply={onApply}
      />
    )
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /apply/ })).toBeDisabled()
  })

  it('duplicates with and without subtasks', () => {
    const onClose = vi.fn()
    const onDuplicate = vi.fn()
    render(
      <DuplicateWithSubtasksDialog
        isOpen
        taskTitle="Parent task"
        subtaskCount={2}
        onClose={onClose}
        onDuplicate={onDuplicate}
      />
    )

    expect(
      screen.getByText(
        'phaseF.componentsTasksDialogsDuplicateWithSubtasksDialog.createACopyOfTitle:{"title":"Parent task"}'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'phaseF.componentsTasksDialogsDuplicateWithSubtasksDialog.alsoDuplicateSubtasksCount:{"count":2}'
      )
    ).toBeInTheDocument()
    // Parent + 2 subtasks = 3 items, counted inside one ICU plural message.
    expect(
      screen.getByRole('button', {
        name: 'phaseF.componentsTasksDialogsDuplicateWithSubtasksDialog.duplicateWithItems:{"count":3}'
      })
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(
      screen.getByRole('button', {
        name: 'phaseF.componentsTasksDialogsDuplicateWithSubtasksDialog.duplicateTaskOnly'
      })
    )
    expect(onDuplicate).toHaveBeenCalledWith(false)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('chooses completion action when all subtasks are complete', () => {
    const onClose = vi.fn()
    const onKeepOpen = vi.fn()
    const onCompleteParent = vi.fn()
    const { rerender } = render(
      <AllSubtasksCompleteDialog
        isOpen
        parentTitle="Parent task"
        subtaskCount={2}
        onClose={onClose}
        onKeepOpen={onKeepOpen}
        onCompleteParent={onCompleteParent}
      />
    )

    expect(
      screen.getByText(
        'phaseF.componentsTasksDialogsAllSubtasksCompleteDialog.allSubtasksDoneBody:{"title":"Parent task","count":2}'
      )
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /keepTaskOpen/ }))
    expect(onKeepOpen).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(
      <AllSubtasksCompleteDialog
        isOpen
        parentTitle="Parent task"
        subtaskCount={1}
        onClose={onClose}
        onKeepOpen={onKeepOpen}
        onCompleteParent={onCompleteParent}
      />
    )
    expect(
      screen.getByText(
        'phaseF.componentsTasksDialogsAllSubtasksCompleteDialog.allSubtasksDoneBody:{"title":"Parent task","count":1}'
      )
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /completeTask/ }))
    expect(onCompleteParent).toHaveBeenCalledTimes(1)
  })

  it('confirms deleting all subtasks after listing completed status', () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    const { rerender } = render(
      <DeleteAllSubtasksDialog
        isOpen
        parentTitle="Parent task"
        subtasks={[
          makeTask({ id: 'sub-1', title: 'Open subtask' }),
          makeTask({ id: 'sub-2', title: 'Done subtask', completedAt: new Date() })
        ]}
        onClose={onClose}
        onConfirm={onConfirm}
      />
    )

    expect(screen.getByText('Open subtask')).toBeInTheDocument()
    expect(screen.getByText('Done subtask')).toBeInTheDocument()
    expect(
      screen.getByText(
        'phaseF.componentsTasksDialogsDeleteAllSubtasksDialog.deleteSubtasksConfirmation:' +
          JSON.stringify({ count: 2, title: 'Parent task' })
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/rdquo|ldquo/)).not.toBeInTheDocument()

    // Singular goes through the same ICU message — no JS ternary picking the "s".
    rerender(
      <DeleteAllSubtasksDialog
        isOpen
        parentTitle="Parent task"
        subtasks={[makeTask({ id: 'sub-1', title: 'Open subtask' })]}
        onClose={onClose}
        onConfirm={onConfirm}
      />
    )
    expect(
      screen.getByText(
        'phaseF.componentsTasksDialogsDeleteAllSubtasksDialog.deleteSubtasksConfirmation:' +
          JSON.stringify({ count: 1, title: 'Parent task' })
      )
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /deleteAll/ }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('confirms parent delete and complete options', () => {
    const onDeleteOpenChange = vi.fn()
    const onDeleteConfirm = vi.fn()
    const { rerender } = render(
      <DeleteParentDialog
        open
        onOpenChange={onDeleteOpenChange}
        parent={makeTask({ title: 'Parent task' })}
        branch={{ direct: 2, deeper: 1, open: 2 }}
        onConfirm={onDeleteConfirm}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /keepSubtasks/ }))
    expect(onDeleteConfirm).toHaveBeenLastCalledWith(true)
    expect(onDeleteOpenChange).toHaveBeenCalledWith(false)
    fireEvent.click(screen.getByRole('button', { name: /deleteAll/ }))
    expect(onDeleteConfirm).toHaveBeenLastCalledWith(false)

    const onCompleteOpenChange = vi.fn()
    const onCompleteConfirm = vi.fn()
    rerender(
      <CompleteParentDialog
        open
        onOpenChange={onCompleteOpenChange}
        parent={makeTask({ title: 'Parent task' })}
        incompleteSubtasks={[
          makeTask({ id: 'sub-1', title: 'Subtask 1' }),
          makeTask({ id: 'sub-2', title: 'Subtask 2' })
        ]}
        onConfirm={onCompleteConfirm}
      />
    )

    fireEvent.click(screen.getByLabelText(/completeParentOnlyKeepSubtasksIncomplete/))
    fireEvent.click(screen.getByRole('button', { name: /complete$/i }))
    expect(onCompleteConfirm).toHaveBeenCalledWith(false)
    expect(onCompleteOpenChange).toHaveBeenCalledWith(false)
  })
})
