import { fireEvent, render, renderHook, screen } from '@testing-library/react'
import { type ButtonHTMLAttributes, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { JournalMonthView } from './journal/journal-month-view'
import { JournalYearView } from './journal/journal-year-view'
import { LinkedTasksSection } from './note/linked-tasks'
import { createTaskBlock, getTaskSlashMenuItem } from './note/content-area/task-block'
import { PasteLinkMenu } from './note/content-area/paste-link-menu'
import { HashTagMenu } from './note/content-area/hash-tag-menu'
import { useClickOutside } from './note/note-title/use-click-outside'
import { SortableProjectList } from './sidebar/sortable-project-list'
import { SplitLayoutRenderer } from './split-view/split-layout-renderer'
import { EditRepeatingTaskDialog } from './tasks/edit-repeating-task-dialog'
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from './ui/breadcrumb'
import { InputGroup, InputGroupAddon, InputGroupInput } from './ui/input-group'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  createTask: vi.fn(),
  listProjects: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
    i18n: { language: 'en' }
  })
}))

vi.mock('./journal/journal-entry-list-item', () => ({
  JournalEntryListItem: ({
    date,
    preview,
    heatmapLevel,
    isFuture,
    onClick
  }: {
    date: string
    preview?: string
    heatmapLevel: number
    isFuture: boolean
    onClick: () => void
  }) => (
    <button type="button" onClick={onClick}>
      {date}:{preview ?? 'empty'}:{heatmapLevel}:{String(isFuture)}
    </button>
  )
}))

vi.mock('@blocknote/react', () => ({
  createReactBlockSpec: vi.fn((schema, impl) => ({ schema, impl }))
}))

vi.mock('./note/content-area/task-block/task-block-renderer', () => ({
  TaskBlockRenderer: () => <div>task block renderer</div>
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    listProjects: (...args: unknown[]) => mocks.listProjects(...args),
    create: (...args: unknown[]) => mocks.createTask(...args),
    update: vi.fn().mockResolvedValue({ success: true })
  }
}))

vi.mock('@/lib/quick-add-parser', () => ({
  parseQuickAdd: (text: string) => ({
    title: text,
    priority: 'high',
    projectId: 'project-2',
    dueDate: new Date('2026-05-10T00:00:00.000Z')
  })
}))

vi.mock('@/lib/task-utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/task-utils')>('@/lib/task-utils')
  return {
    ...actual,
    formatDateKey: (date: Date) => date.toISOString().slice(0, 10)
  }
})

vi.mock('@/components/inbox-detail/content-section', () => ({
  ContentSection: ({ item }: { item: { id: string } }) => <div>content:{item.id}</div>
}))

vi.mock('@/services/inbox-service', () => ({
  formatTimeAgo: () => '1m ago'
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: {}
}))

vi.mock('./sidebar/sortable-project-item', () => ({
  SortableProjectItem: ({ project, isActive, onClick, onEdit, onArchive, onDelete }: any) => (
    <div>
      <button type="button" onClick={onClick}>
        project:{project.name}:{String(isActive)}
      </button>
      <button type="button" onClick={() => onEdit(project)}>
        edit:{project.name}
      </button>
      <button type="button" onClick={() => onArchive(project)}>
        archive:{project.name}
      </button>
      <button type="button" onClick={() => onDelete(project.id)}>
        delete:{project.name}
      </button>
    </div>
  )
}))

vi.mock('./sidebar/projects-empty-state', () => ({
  ProjectsEmptyState: ({ onCreateProject }: { onCreateProject: () => void }) => (
    <button type="button" onClick={onCreateProject}>
      create project empty
    </button>
  )
}))

vi.mock('./sidebar/projects-skeleton', () => ({
  ProjectsSkeleton: ({ count }: { count: number }) => <div>skeleton:{count}</div>
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({
    state: {
      activeGroupId: 'group-1',
      tabGroups: {
        'group-1': { id: 'group-1' },
        'group-2': { id: 'group-2' }
      }
    },
    dispatch: mocks.dispatch
  })
}))

vi.mock('./split-view/split-pane', () => ({
  SplitPane: ({
    direction,
    ratio,
    onResize,
    children
  }: {
    direction: string
    ratio: number
    onResize: (ratio: number) => void
    children: ReactNode
  }) => (
    <div>
      <button type="button" onClick={() => onResize(0.65)}>
        split:{direction}:{ratio}
      </button>
      {children}
    </div>
  )
}))

vi.mock('./split-view/tab-pane', () => ({
  TabPane: ({ groupId, isActive, showSidebarToggle }: any) => (
    <div>
      pane:{groupId}:{String(isActive)}:{String(showSidebarToggle)}
    </div>
  )
}))

vi.mock('./split-view/tab-pane-with-drop-zones', () => ({
  TabPaneWithDropZones: ({ groupId, isActive, showSidebarToggle }: any) => (
    <div>
      pane:{groupId}:{String(isActive)}:{String(showSidebarToggle)}
    </div>
  )
}))

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  AlertDialogAction: ({ children, onClick }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>
}))

describe('remaining zero renderer surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listProjects.mockResolvedValue({
      projects: [
        { id: 'project-1', isDefault: true },
        { id: 'project-2', statuses: [] }
      ]
    })
    mocks.createTask.mockResolvedValue({ success: true, task: { id: 'task-new' } })
  })

  it('renders journal month and year views with click callbacks', () => {
    const onDayClick = vi.fn()
    render(
      <JournalMonthView
        year={2026}
        month={4}
        entries={new Map([['2026-05-10', { preview: 'Entry', characterCount: 12 }]])}
        heatmapData={[{ date: '2026-05-10', level: 3, characterCount: 12 }]}
        onDayClick={onDayClick}
      />
    )

    fireEvent.click(screen.getByText(/2026-05-10:Entry:3/))
    expect(onDayClick).toHaveBeenCalledWith('2026-05-10')

    const onMonthClick = vi.fn()
    render(
      <JournalYearView
        year={new Date().getFullYear()}
        currentMonth={4}
        monthStats={[
          { month: 4, monthName: 'May', entryCount: 2, totalChars: 2400, activityDots: [1, 4] }
        ]}
        onMonthClick={onMonthClick}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /2 count.days/ }))
    expect(onMonthClick).toHaveBeenCalledWith(4)
  })

  it('renders linked tasks states and task-block slash command behavior', async () => {
    const onTaskClick = vi.fn()
    const task = {
      id: 'task-1',
      title: 'Linked task',
      completedAt: null
    } as any

    const { rerender } = render(<LinkedTasksSection tasks={[]} />)
    expect(screen.queryByText('linkedTasks.title')).not.toBeInTheDocument()

    rerender(<LinkedTasksSection tasks={[]} isLoading />)
    expect(screen.getByText('linkedTasks.loading')).toBeInTheDocument()

    rerender(<LinkedTasksSection tasks={[task]} onTaskClick={onTaskClick} />)
    fireEvent.click(screen.getByText('Linked task'))
    expect(onTaskClick).toHaveBeenCalledWith('task-1')
    fireEvent.click(screen.getByRole('button', { expanded: true }))
    expect(screen.queryByText('Linked task')).not.toBeInTheDocument()

    expect((createTaskBlock as any).schema.type).toBe('taskBlock')
    const updateBlock = vi.fn()
    const block = { id: 'b1', content: [{ text: 'Plan launch' }] }
    const item = getTaskSlashMenuItem({
      getTextCursorPosition: () => ({ block }),
      updateBlock,
      getBlock: () => block
    })
    await item.onItemClick()
    expect(mocks.createTask).toHaveBeenCalledWith({
      projectId: 'project-2',
      title: 'Plan launch',
      priority: 3,
      dueDate: '2026-05-10',
      linkedNoteIds: []
    })
    expect(updateBlock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'taskBlock' })
    )
  })

  it('drives small menus, click-outside hook, and repeating-task dialog', () => {
    const onPasteSelect = vi.fn()
    const { rerender } = render(
      <PasteLinkMenu
        isOpen={false}
        position={{ x: 1, y: 2 }}
        options={['url', 'mention', 'embed']}
        selectedIndex={0}
        onSelect={onPasteSelect}
      />
    )
    expect(document.querySelector('[data-paste-link-menu]')).toBeNull()
    rerender(
      <PasteLinkMenu
        isOpen
        position={{ x: 1, y: 2 }}
        options={['url', 'mention', 'embed']}
        selectedIndex={1}
        onSelect={onPasteSelect}
      />
    )
    fireEvent.mouseDown(screen.getByText('menus.pasteLink.mention'))
    expect(onPasteSelect).toHaveBeenCalledWith('mention')

    const onTagClick = vi.fn()
    const { rerender: rerenderTags } = render(
      <HashTagMenu items={[]} loadingState="loading" selectedIndex={0} onItemClick={onTagClick} />
    )
    expect(screen.getByText('menus.tags.loading')).toBeInTheDocument()
    rerenderTags(
      <HashTagMenu items={[]} loadingState="loaded" selectedIndex={0} onItemClick={onTagClick} />
    )
    expect(screen.getByText('menus.tags.empty')).toBeInTheDocument()
    rerenderTags(
      <HashTagMenu
        loadingState="loaded"
        selectedIndex={1}
        onItemClick={onTagClick}
        items={[
          { name: 'work', color: '#ff0000', count: 2, type: 'existing' },
          { name: 'new', color: '#00ff00', count: 0, type: 'create' }
        ]}
      />
    )
    fireEvent.click(screen.getByText(/menus.tags.create/))
    expect(onTagClick).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'new', type: 'create' })
    )

    const ref = { current: null as HTMLDivElement | null }
    const outside = vi.fn()
    const { unmount } = renderHook(() => useClickOutside(ref, outside))
    const inside = document.createElement('div')
    document.body.appendChild(inside)
    ref.current = inside
    fireEvent.mouseDown(inside)
    fireEvent.mouseDown(document.body)
    expect(outside).toHaveBeenCalledTimes(1)
    unmount()

    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(
      <EditRepeatingTaskDialog
        isOpen
        onClose={onClose}
        onConfirm={onConfirm}
        taskTitle="Repeat"
        occurrenceDate={new Date('2026-05-10T00:00:00.000Z')}
      />
    )
    fireEvent.click(
      screen.getByText('phaseF.componentsTasksEditRepeatingTaskDialog.onlyThisOccurrence')
    )
    fireEvent.click(screen.getByText('phaseF.componentsTasksEditRepeatingTaskDialog.continue'))
    expect(onConfirm).toHaveBeenCalledWith('this')
    expect(onClose).toHaveBeenCalled()
  })

  it('renders sortable projects, split layouts, and UI wrappers', () => {
    const project = {
      id: 'project-1',
      name: 'Work',
      color: '#111111',
      statuses: [],
      isArchived: false
    } as any
    const onProjectClick = vi.fn()
    const onProjectEdit = vi.fn()
    const onProjectArchive = vi.fn()
    const onProjectDelete = vi.fn()
    const onCreateProject = vi.fn()

    const { rerender } = render(
      <SortableProjectList
        projects={[]}
        activeProjectId={null}
        isLoading
        onProjectClick={onProjectClick}
        onProjectEdit={onProjectEdit}
        onProjectArchive={onProjectArchive}
        onProjectDelete={onProjectDelete}
        onProjectsReorder={vi.fn()}
        onCreateProject={onCreateProject}
      />
    )
    expect(screen.getByText('skeleton:3')).toBeInTheDocument()

    rerender(
      <SortableProjectList
        projects={[]}
        activeProjectId={null}
        onProjectClick={onProjectClick}
        onProjectEdit={onProjectEdit}
        onProjectArchive={onProjectArchive}
        onProjectDelete={onProjectDelete}
        onProjectsReorder={vi.fn()}
        onCreateProject={onCreateProject}
      />
    )
    fireEvent.click(screen.getByText('create project empty'))
    expect(onCreateProject).toHaveBeenCalled()

    rerender(
      <SortableProjectList
        projects={[project]}
        activeProjectId="project-1"
        onProjectClick={onProjectClick}
        onProjectEdit={onProjectEdit}
        onProjectArchive={onProjectArchive}
        onProjectDelete={onProjectDelete}
        onProjectsReorder={vi.fn()}
        onCreateProject={onCreateProject}
      />
    )
    fireEvent.click(screen.getByText('project:Work:true'))
    fireEvent.click(screen.getByText('edit:Work'))
    fireEvent.click(screen.getByText('archive:Work'))
    fireEvent.click(screen.getByText('delete:Work'))
    expect(onProjectClick).toHaveBeenCalledWith('project-1')
    expect(onProjectEdit).toHaveBeenCalledWith(project)
    expect(onProjectArchive).toHaveBeenCalledWith(project)
    expect(onProjectDelete).toHaveBeenCalledWith('project-1')

    render(
      <SplitLayoutRenderer
        path={[]}
        layout={
          {
            type: 'vertical',
            ratio: 0.4,
            first: { type: 'leaf', tabGroupId: 'group-1' },
            second: { type: 'leaf', tabGroupId: 'group-2' }
          } as any
        }
      />
    )
    fireEvent.click(screen.getByText('split:vertical:0.4'))
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'RESIZE_SPLIT',
      payload: { path: [], ratio: 0.65 }
    })
    expect(screen.getByText('pane:group-1:true:true')).toBeInTheDocument()
    expect(screen.getByText('pane:group-2:false:false')).toBeInTheDocument()

    render(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="#home">Home</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbEllipsis />
            <BreadcrumbPage>Page</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    )
    expect(screen.getByLabelText('phaseF.componentsUiBreadcrumb.breadcrumb')).toBeInTheDocument()

    render(
      <InputGroup>
        <InputGroupAddon>prefix</InputGroupAddon>
        <InputGroupInput aria-label="group input" />
        <InputGroupAddon align="inline-end">suffix</InputGroupAddon>
      </InputGroup>
    )
    expect(screen.getByLabelText('group input')).toBeInTheDocument()

    render(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
        </TabsList>
        <TabsContent value="one">Panel one</TabsContent>
      </Tabs>
    )
    expect(screen.getByText('Panel one')).toBeInTheDocument()
  })
})
