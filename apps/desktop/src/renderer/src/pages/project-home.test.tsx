import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { ProjectHomePage } from './project-home'

const mocks = vi.hoisted(() => ({
  addTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  registerUndo: vi.fn(),
  removeUndoEntry: vi.fn(),
  createTask: vi.fn(),
  completeTask: vi.fn(),
  uncompleteTask: vi.fn(),
  openTab: vi.fn(),
  listProjectLinks: vi.fn(),
  getProject: vi.fn(),
  notesGet: vi.fn(),
  notesGetFile: vi.fn(),
  getEvent: vi.fn(),
  projectUpdatedListeners: [] as Array<(event: { id: string; project: Project }) => void>
}))

const project: Project = {
  id: 'p1',
  name: 'Launch',
  description: '',
  icon: '',
  color: '#f00',
  statuses: [
    { id: 'todo', name: 'Todo', type: 'todo', order: 0 },
    { id: 'done', name: 'Done', type: 'done', order: 1 }
  ],
  isDefault: false,
  isArchived: false,
  createdAt: new Date(),
  taskCount: 0
} as unknown as Project

const tasks: Task[] = [
  {
    id: 't1',
    title: 'Write brief',
    description: '',
    projectId: 'p1',
    statusId: 'todo',
    priority: 'none',
    dueDate: null,
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    tags: [],
    parentId: null,
    subtaskIds: [],
    createdAt: new Date(),
    completedAt: null,
    archivedAt: null
  },
  {
    id: 't2',
    title: 'Ship it',
    description: '',
    projectId: 'p1',
    statusId: 'done',
    priority: 'none',
    dueDate: null,
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    tags: [],
    parentId: null,
    subtaskIds: [],
    createdAt: new Date(),
    completedAt: new Date(),
    archivedAt: null
  }
]

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

vi.mock('@/contexts/tasks', () => ({
  useTasksContext: () => ({
    tasks,
    projects: [project],
    addTask: mocks.addTask,
    updateTask: mocks.updateTask,
    deleteTask: mocks.deleteTask
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ openTab: mocks.openTab })
}))

vi.mock('@/hooks/use-undoable-task-actions', () => ({
  useUndoableTaskActions: () => ({
    createTask: mocks.createTask,
    completeTask: mocks.completeTask,
    uncompleteTask: mocks.uncompleteTask
  })
}))

vi.mock('@/hooks', () => ({
  useUndoTracker: () => ({
    registerUndo: mocks.registerUndo,
    removeUndoEntry: mocks.removeUndoEntry
  })
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: { listProjectLinks: mocks.listProjectLinks, getProject: mocks.getProject },
  onProjectUpdated: (cb: (event: { id: string; project: Project }) => void) => {
    mocks.projectUpdatedListeners.push(cb)
    return () => {
      mocks.projectUpdatedListeners = mocks.projectUpdatedListeners.filter((l) => l !== cb)
    }
  }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: { get: mocks.notesGet, getFile: mocks.notesGetFile }
}))

vi.mock('@/services/calendar-service', () => ({
  calendarService: { getEvent: mocks.getEvent }
}))

vi.mock('@/components/tasks/task-list', () => ({
  TaskList: ({ tasks: listTasks }: { tasks: Task[] }) => (
    <div data-testid="task-list">
      {listTasks.map((item) => (
        <div key={item.id}>{item.title}</div>
      ))}
    </div>
  )
}))

vi.mock('@/components/tasks/projects/project-overview-note', () => ({
  ProjectOverviewNote: ({
    projectId,
    homeNoteId
  }: {
    projectId: string
    homeNoteId: string | null | undefined
  }) => (
    <div
      data-testid="project-overview-note"
      data-project-id={projectId}
      data-home-note-id={String(homeNoteId)}
    />
  )
}))

describe('ProjectHomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.projectUpdatedListeners = []
    mocks.listProjectLinks.mockResolvedValue([
      { id: 'link-1', projectId: 'p1', itemType: 'note', itemId: 'n1', position: 0, createdAt: '' }
    ])
    mocks.getProject.mockResolvedValue({ ...project, homeNoteId: null })
  })

  it('#then renders header, stats, and notes section', async () => {
    render(<ProjectHomePage projectId="p1" />)

    expect(await screen.findByText('Launch')).toBeInTheDocument()
    expect(await screen.findByText('50%')).toBeInTheDocument()
    expect(screen.getByTestId('task-list')).toBeInTheDocument()
    expect(screen.getByText('Write brief')).toBeInTheDocument()
    expect(screen.getByText('Ship it')).toBeInTheDocument()
  })

  it('#then renders a calm empty state when no project is found', async () => {
    render(<ProjectHomePage projectId="missing" />)

    expect(await screen.findByText('No project selected')).toBeInTheDocument()
    expect(screen.queryByTestId('task-list')).not.toBeInTheDocument()
  })

  it('#then loads homeNoteId via getProject on mount and reloads it on onProjectUpdated', async () => {
    mocks.getProject.mockResolvedValue({ ...project, homeNoteId: 'n1' })

    render(<ProjectHomePage projectId="p1" />)

    expect(await screen.findByText('Launch')).toBeInTheDocument()
    expect(mocks.getProject).toHaveBeenCalledWith('p1')

    const overview = await screen.findByTestId('project-overview-note')
    await waitFor(() => expect(overview).toHaveAttribute('data-home-note-id', 'n1'))
    expect(overview).toHaveAttribute('data-project-id', 'p1')

    mocks.getProject.mockResolvedValue({ ...project, homeNoteId: 'n2' })
    mocks.projectUpdatedListeners.forEach((listener) => listener({ id: 'p1', project }))

    await waitFor(() =>
      expect(screen.getByTestId('project-overview-note')).toHaveAttribute('data-home-note-id', 'n2')
    )
    expect(mocks.getProject).toHaveBeenCalledTimes(2)
  })

  it('#then renders linked files in the Files section', async () => {
    mocks.listProjectLinks.mockResolvedValue([
      { id: 'l-f', projectId: 'p1', itemType: 'file', itemId: 'f1', position: 0, createdAt: '' }
    ])
    mocks.notesGetFile.mockResolvedValue({ id: 'f1', title: 'Budget.pdf', fileType: 'pdf' })

    render(<ProjectHomePage projectId="p1" />)

    expect(await screen.findByText('Budget.pdf')).toBeInTheDocument()
  })
})
