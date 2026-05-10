import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { MoveMenu } from './move-menu'
import {
  ArchiveDropZone,
  DroppableProjectItem,
  SidebarDropZones,
  TrashDropZone
} from './sidebar-drop-zones'
import type { Project, Status } from '@/data/tasks-data'
import type { Task } from '@/data/task-model'

const mocks = vi.hoisted(() => ({
  isDragging: false,
  dragCount: 1,
  overIds: new Set<string>()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key.split('.').at(-1) ?? key
  })
}))

vi.mock('@dnd-kit/core', () => ({
  useDroppable: ({ id }: { id: string }) => ({
    setNodeRef: vi.fn(),
    isOver: mocks.overIds.has(id)
  })
}))

vi.mock('@/contexts/drag-context', () => ({
  useDragContext: () => ({
    dragState: { isDragging: mocks.isDragging },
    dragCount: mocks.dragCount
  })
}))

vi.mock('@/components/icon-picker', () => ({
  getIconByName: (name?: string | null) =>
    name
      ? ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
          <span data-testid={`icon-${name}`} className={className} style={style} />
        )
      : null
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    disabled,
    onClick
  }: {
    children: ReactNode
    disabled?: boolean
    onClick?: () => void
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'work',
    name: 'Work',
    description: '',
    icon: null,
    color: '#2255ff',
    statuses: [],
    isDefault: false,
    isArchived: false,
    createdAt: new Date('2026-05-10T09:00:00'),
    taskCount: 3,
    ...overrides
  } as Project
}

function createStatus(overrides: Partial<Status> = {}): Status {
  return {
    id: 'todo',
    name: 'Todo',
    color: '#888888',
    type: 'todo',
    order: 0,
    ...overrides
  } as Status
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Plan coverage',
    description: '',
    projectId: 'work',
    statusId: 'todo',
    priority: 'medium',
    dueDate: null,
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    parentId: null,
    subtaskIds: [],
    createdAt: new Date('2026-05-10T09:00:00'),
    completedAt: null,
    archivedAt: null,
    ...overrides
  } as Task
}

describe('drag/drop medium surfaces', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 4, 10, 9, 0, 0))
    vi.clearAllMocks()
    mocks.isDragging = false
    mocks.dragCount = 1
    mocks.overIds = new Set()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs move menu date, project, status, and reorder actions', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onChangeDueDate = vi.fn()
    const onChangeProject = vi.fn()
    const onChangeStatus = vi.fn()
    const onMoveUp = vi.fn()
    const onMoveDown = vi.fn()
    const onMoveToTop = vi.fn()
    const onMoveToBottom = vi.fn()

    render(
      <MoveMenu
        task={createTask()}
        projects={[
          createProject(),
          createProject({ id: 'home', name: 'Home', icon: 'folder', color: '#11aa55' }),
          createProject({ id: 'old', name: 'Old', isArchived: true })
        ]}
        statuses={[
          createStatus(),
          createStatus({ id: 'done', name: 'Done', type: 'done', color: '#22c55e' })
        ]}
        onChangeDueDate={onChangeDueDate}
        onChangeProject={onChangeProject}
        onChangeStatus={onChangeStatus}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onMoveToTop={onMoveToTop}
        onMoveToBottom={onMoveToBottom}
      />
    )

    expect(screen.getByRole('button', { name: 'moveTask' })).toBeInTheDocument()
    expect(screen.queryByText('Old')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'today' }))
    expect(onChangeDueDate.mock.calls.at(-1)?.[0].toDateString()).toBe('Sun May 10 2026')
    await user.click(screen.getByRole('button', { name: 'tomorrow' }))
    expect(onChangeDueDate.mock.calls.at(-1)?.[0].toDateString()).toBe('Mon May 11 2026')
    await user.click(screen.getByRole('button', { name: 'nextWeek' }))
    expect(onChangeDueDate.mock.calls.at(-1)?.[0].toDateString()).toBe('Sun May 17 2026')
    await user.click(screen.getByRole('button', { name: 'removeDate' }))
    expect(onChangeDueDate).toHaveBeenLastCalledWith(null)

    expect(screen.getByRole('button', { name: /Workcurrent/ })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /Home/ }))
    expect(onChangeProject).toHaveBeenCalledWith('home')
    expect(screen.getByTestId('icon-folder')).toHaveStyle({ color: '#11aa55' })

    expect(screen.getByRole('button', { name: /Todocurrent2/ })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /Done/ }))
    expect(onChangeStatus).toHaveBeenCalledWith('done')

    await user.click(screen.getByRole('button', { name: /Move up/ }))
    await user.click(screen.getByRole('button', { name: /Move down/ }))
    await user.click(screen.getByRole('button', { name: /Move to top/ }))
    await user.click(screen.getByRole('button', { name: /Move to bottom/ }))
    expect(onMoveUp).toHaveBeenCalled()
    expect(onMoveDown).toHaveBeenCalled()
    expect(onMoveToTop).toHaveBeenCalled()
    expect(onMoveToBottom).toHaveBeenCalled()
  })

  it('renders droppable project items and routes click, keyboard, edit, and drop states', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onClick = vi.fn()
    const onEdit = vi.fn()
    const project = createProject({ icon: 'folder' })

    const { rerender } = render(
      <DroppableProjectItem
        project={project}
        isSelected={false}
        onClick={onClick}
        onEdit={onEdit}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Work, 3 tasks' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Work, 3 tasks' }), { key: 'Enter' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Work, 3 tasks' }), { key: ' ' })
    expect(onClick).toHaveBeenCalledTimes(3)

    await user.click(screen.getByRole('button', { name: 'Edit Work' }))
    expect(onEdit).toHaveBeenCalledWith(project)
    expect(screen.getByText('3')).toBeInTheDocument()

    mocks.isDragging = true
    mocks.overIds = new Set(['project-work'])
    rerender(
      <DroppableProjectItem project={project} isSelected onClick={onClick} onEdit={onEdit} />
    )

    expect(screen.getByText('dropHere')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit Work' })).not.toBeInTheDocument()
    expect(screen.queryByText('3')).not.toBeInTheDocument()
  })

  it('shows archive and trash drop zones only during drag and reflects singular/plural counts', () => {
    const { container, rerender } = render(<SidebarDropZones />)
    expect(container).toBeEmptyDOMElement()

    mocks.isDragging = true
    mocks.dragCount = 1
    mocks.overIds = new Set(['archive'])
    rerender(<ArchiveDropZone className="archive-extra" />)
    expect(screen.getByText('Archive 1 task')).toBeInTheDocument()

    mocks.dragCount = 3
    mocks.overIds = new Set(['trash'])
    rerender(<TrashDropZone className="trash-extra" />)
    expect(screen.getByText('Delete 3 tasks')).toBeInTheDocument()

    mocks.overIds = new Set()
    rerender(<SidebarDropZones className="zones-extra" />)
    expect(screen.getByText('Drop to archive')).toBeInTheDocument()
    expect(screen.getByText('Drop to delete')).toBeInTheDocument()
  })
})
