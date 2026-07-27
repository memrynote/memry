import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TaskRow } from './task-row'
import { NoteRow } from './note-row'
import { FileRow } from './file-row'
import { EventRow } from './event-row'
import type { Project } from '@/data/tasks-data'
import type { Task } from '@/data/task-model'
import type { ProjectLinkedEvent, ProjectLinkedFile, ProjectLinkedNote } from '@memry/rpc/tasks'

const project: Project = {
  id: 'p1',
  name: 'Hub',
  description: '',
  icon: 'folder',
  color: '#6366f1',
  statuses: [
    { id: 'todo', name: 'To Do', color: '#6b7280', type: 'todo', order: 0 },
    { id: 'done', name: 'Done', color: '#10b981', type: 'done', order: 1 }
  ],
  isDefault: false,
  isArchived: false,
  createdAt: new Date('2026-03-02T00:00:00.000Z'),
  taskCount: 0
}

const task: Task = {
  id: 't1',
  title: 'Review sync conflict edge cases',
  description: '',
  projectId: 'p1',
  statusId: 'todo',
  priority: 'high',
  dueDate: new Date(Date.now() - 3 * 86_400_000),
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  tags: ['sync'],
  parentId: null,
  subtaskIds: [],
  createdAt: new Date('2026-03-02T00:00:00.000Z'),
  completedAt: null,
  archivedAt: null
}

const noop = (): void => {}

describe('TaskRow', () => {
  it('opens the task when the body is clicked', async () => {
    const onOpen = vi.fn()
    render(
      <ul>
        <TaskRow
          task={task}
          project={project}
          onOpen={onOpen}
          onStatusChange={noop}
          onToggleComplete={noop}
          onPriorityChange={noop}
        />
      </ul>
    )

    await userEvent.click(screen.getByRole('button', { name: /open task/i }))
    expect(onOpen).toHaveBeenCalledWith('t1')
  })

  it('does not open the task when the status control is clicked', async () => {
    const onOpen = vi.fn()
    render(
      <ul>
        <TaskRow
          task={task}
          project={project}
          onOpen={onOpen}
          onStatusChange={noop}
          onToggleComplete={noop}
          onPriorityChange={noop}
        />
      </ul>
    )

    await userEvent.click(screen.getByRole('button', { name: /^Status:/ }))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('marks an overdue task with the destructive tone and shows its tag', () => {
    render(
      <ul>
        <TaskRow
          task={task}
          project={project}
          onOpen={noop}
          onStatusChange={noop}
          onToggleComplete={noop}
          onPriorityChange={noop}
        />
      </ul>
    )

    expect(screen.getByText('sync')).toBeInTheDocument()
    expect(screen.getByText('3d late')).toHaveClass('text-destructive')
  })

  it('strikes through a task in a done status', () => {
    render(
      <ul>
        <TaskRow
          task={{ ...task, statusId: 'done' }}
          project={project}
          onOpen={noop}
          onStatusChange={noop}
          onToggleComplete={noop}
          onPriorityChange={noop}
        />
      </ul>
    )

    expect(screen.getByText(task.title)).toHaveClass('line-through')
  })
})

describe('NoteRow', () => {
  const note: ProjectLinkedNote = {
    id: 'n1',
    title: 'Sync architecture decisions',
    emoji: null,
    modifiedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    pinned: false
  }

  it('opens the note from the body and shows a relative time', async () => {
    const onOpen = vi.fn()
    render(
      <ul>
        <NoteRow note={note} onOpen={onOpen} onIconChange={noop} />
      </ul>
    )

    expect(screen.getByText('2h')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /open note/i }))
    expect(onOpen).toHaveBeenCalledWith('n1')
  })

  it('renders an unpin control only when onUnpin is supplied', () => {
    const { rerender } = render(
      <ul>
        <NoteRow note={note} onOpen={noop} onIconChange={noop} />
      </ul>
    )
    expect(
      screen.queryByRole('button', { name: /remove .* from the overview/i })
    ).not.toBeInTheDocument()

    rerender(
      <ul>
        <NoteRow note={note} onOpen={noop} onIconChange={noop} onUnpin={noop} />
      </ul>
    )
    expect(screen.getByRole('button', { name: /remove .* from the overview/i })).toBeInTheDocument()
  })

  it('does not open the note when the icon picker is clicked', async () => {
    const onOpen = vi.fn()
    render(
      <ul>
        <NoteRow note={note} onOpen={onOpen} onIconChange={noop} />
      </ul>
    )

    await userEvent.click(screen.getByRole('button', { name: /set icon for/i }))
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe('FileRow', () => {
  const file: ProjectLinkedFile = {
    id: 'f1',
    title: 'sync-flow-diagram.png',
    fileType: 'image',
    mimeType: 'image/png',
    fileSize: 1_258_291,
    modifiedAt: '2026-03-13T10:00:00.000Z'
  }

  it('shows the size chip and opens the file', async () => {
    const onOpen = vi.fn()
    render(
      <ul>
        <FileRow file={file} onOpen={onOpen} />
      </ul>
    )

    expect(screen.getByText('1.2 MB')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /open file/i }))
    expect(onOpen).toHaveBeenCalledWith('f1')
  })

  it('omits the size chip when the size is unknown', () => {
    render(
      <ul>
        <FileRow file={{ ...file, fileSize: null }} onOpen={noop} />
      </ul>
    )
    expect(screen.queryByText(/MB|KB| B$/)).not.toBeInTheDocument()
  })
})

describe('EventRow', () => {
  const event: ProjectLinkedEvent = {
    id: 'e1',
    title: 'Sync architecture review',
    startAt: '2026-08-08T14:00:00.000Z',
    endAt: null,
    isAllDay: false
  }

  it('passes the whole event to onOpen so the caller can focus the day', async () => {
    const onOpen = vi.fn()
    render(
      <ul>
        <EventRow event={event} onOpen={onOpen} />
      </ul>
    )

    await userEvent.click(screen.getByRole('button', { name: /open event/i }))
    expect(onOpen).toHaveBeenCalledWith(event)
  })

  it('omits the time for an all-day event', () => {
    const { container } = render(
      <ul>
        <EventRow event={{ ...event, isAllDay: true }} onOpen={noop} />
      </ul>
    )
    expect(container.textContent).not.toContain('·')
  })
})
