import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createDefaultTask } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import type { ProjectLinkedNote } from '@memry/rpc/tasks'
import { AllTab, type AllTabSource } from './all-tab'
import type { HubHandlers } from './hub-handlers'

vi.mock('@/contexts/tasks', () => ({
  useTasksContext: () => ({ projects: [] })
}))

// The hub's task row owns its own tests (rows.test.tsx); here it only has to
// receive the right task, project and callbacks.
vi.mock('../rows/task-row', () => ({
  TaskRow: ({ task, project, onOpen, onToggleComplete, onStatusChange }: any) => (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA role kept to preserve existing layout and styling of the element
    <div role="listitem" data-testid={`task-row-${task.id}`} data-project={project.id}>
      <button type="button" onClick={() => onOpen(task.id)}>
        {task.title}
      </button>
      <button type="button" onClick={() => onToggleComplete(task.id)}>
        toggle {task.title}
      </button>
      <button type="button" onClick={() => onStatusChange(task.id, 'done')}>
        status {task.title}
      </button>
    </div>
  )
}))

const noop = (): void => {}
const handlers = (over: Partial<HubHandlers> = {}): HubHandlers => ({
  onGoToTab: noop,
  onOpenTask: noop,
  onStatusChange: noop,
  onToggleComplete: noop,
  onPriorityChange: noop,
  onOpenNote: noop,
  onNoteIconChange: noop,
  onOpenFile: noop,
  onOpenEvent: noop,
  onAddTask: noop,
  onAddNote: noop,
  onAddFile: noop,
  onAddEvent: noop,
  ...over
})

const project: Project = {
  id: 'p1',
  name: 'Site',
  description: '',
  icon: '',
  color: '',
  statuses: [
    { id: 'todo', name: 'To do', color: '', type: 'todo', order: 0 },
    { id: 'done', name: 'Done', color: '', type: 'done', order: 1 }
  ],
  isDefault: false,
  isArchived: false,
  createdAt: new Date(),
  taskCount: 0
}

const inDays = (n: number): Date => {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() + n)
  return d
}

const brief: ProjectLinkedNote = {
  id: 'brief',
  title: 'Redesign brief',
  emoji: null,
  modifiedAt: new Date().toISOString(),
  pinned: false
}

const task = (title: string, due: Date, over = {}) => ({
  ...createDefaultTask('p1', 'todo', title, due),
  id: title,
  ...over
})

const source = (): AllTabSource => ({
  project,
  projectTasks: [
    task('Write copy', inDays(2), { sourceNoteId: 'brief' }),
    task('Ship logos', inDays(-1), { sourceNoteId: 'brief', completedAt: new Date() })
  ],
  allTasks: [],
  notes: [brief],
  events: []
})

describe('AllTab', () => {
  it('renders each task with the shared task row and the days left to its due date', () => {
    render(<AllTab source={source()} showDone={false} handlers={handlers()} />)

    const row = screen.getByTestId('task-row-Write copy')
    expect(row).toHaveAttribute('data-project', 'p1')
    expect(
      within(row.closest('[role="list"] > div') as HTMLElement).getByText('2d')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /open note redesign brief/i })).toBeInTheDocument()
    expect(screen.queryByText('Ship logos')).not.toBeInTheDocument()
  })

  it('shows finished tasks when showDone is on', () => {
    render(<AllTab source={source()} showDone handlers={handlers()} />)

    expect(screen.getByTestId('task-row-Ship logos')).toBeInTheDocument()
  })

  it('lets the user open, complete and change the status of a task from its row', async () => {
    const onOpenTask = vi.fn()
    const onToggleComplete = vi.fn()
    const onStatusChange = vi.fn()
    const user = userEvent.setup()
    render(
      <AllTab
        source={source()}
        showDone={false}
        handlers={handlers({ onOpenTask, onToggleComplete, onStatusChange })}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Write copy' }))
    await user.click(screen.getByRole('button', { name: 'toggle Write copy' }))
    await user.click(screen.getByRole('button', { name: 'status Write copy' }))

    expect(onOpenTask).toHaveBeenCalledWith('Write copy')
    expect(onToggleComplete).toHaveBeenCalledWith('Write copy')
    expect(onStatusChange).toHaveBeenCalledWith('Write copy', 'done')
  })

  it('opens a note from its row', async () => {
    const onOpenNote = vi.fn()
    const user = userEvent.setup()
    render(<AllTab source={source()} showDone={false} handlers={handlers({ onOpenNote })} />)

    await user.click(screen.getByRole('button', { name: /open note redesign brief/i }))
    expect(onOpenNote).toHaveBeenCalledWith('brief')
  })

  it('collapses the tasks under a note', async () => {
    const user = userEvent.setup()
    render(<AllTab source={source()} showDone={false} handlers={handlers()} />)

    await user.click(screen.getByRole('button', { name: /hide tasks in redesign brief/i }))
    expect(screen.queryByTestId('task-row-Write copy')).not.toBeInTheDocument()
  })

  it('sorts flat by the Title header', async () => {
    const user = userEvent.setup()
    render(<AllTab source={source()} showDone={false} handlers={handlers()} />)

    await user.click(screen.getByRole('button', { name: 'Title' }))
    await user.click(screen.getByRole('button', { name: 'Title' }))

    const titles = screen.getAllByRole('listitem').map((item) => item.textContent)
    expect(titles[0]).toContain('Write copy')
    expect(titles[1]).toContain('Redesign brief')
  })
})
