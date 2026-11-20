/**
 * A task title keeps its note links as `[[…]]` text (#5294). The row shows
 * them as links that open the note, and a click on one is the link's alone:
 * the row under it does not open the task.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TaskRow } from './task-row'
import type { Project } from '@/data/tasks-data'
import type { Task } from '@/data/task-model'

const { openWikiTarget } = vi.hoisted(() => ({ openWikiTarget: vi.fn() }))
vi.mock('@/hooks/use-open-wiki-target', () => ({ useOpenWikiTarget: () => openWikiTarget }))
vi.mock('@/hooks/use-reminders', () => ({ useNextTaskReminders: () => new Map() }))
vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t: (key: string) => key }) }))
vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))

const project = {
  id: 'project-1',
  name: 'Inbox',
  color: '#000',
  statuses: [{ id: 'todo', name: 'Todo', type: 'todo', color: '#aaa', order: 0 }]
} as unknown as Project

const task: Task = {
  id: 'task-1',
  title: 'Check up on [[Person D]] at [[Customer E|the customer]] next Tuesday',
  description: '',
  projectId: 'project-1',
  statusId: 'todo',
  priority: 'none',
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  repeatFrom: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  tags: [],
  parentId: null,
  subtaskIds: [],
  createdAt: new Date(2026, 0, 1),
  completedAt: null,
  archivedAt: null
}

describe('task title note links', () => {
  it('renders each link as a link and opens its note', () => {
    const onClick = vi.fn()
    render(
      <TaskRow
        task={task}
        project={project}
        projects={[project]}
        isCompleted={false}
        onToggleComplete={vi.fn()}
        onClick={onClick}
      />
    )

    const person = screen.getByRole('link', { name: 'Person D' })
    // An alias is the label the user chose; the target is what opens.
    const customer = screen.getByRole('link', { name: 'the customer' })
    expect(screen.queryByText(/\[\[/)).toBeNull()
    expect(person.closest('[role="button"]')?.textContent).toContain(
      'Check up on Person D at the customer next Tuesday'
    )

    fireEvent.click(person)
    fireEvent.keyDown(customer, { key: 'Enter' })

    expect(openWikiTarget.mock.calls).toEqual([['Person D'], ['Customer E']])
    expect(onClick).not.toHaveBeenCalled()
  })
})
