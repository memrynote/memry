import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NoteBreadcrumb, SIDEBAR_REVEAL_FOLDER_EVENT } from '@/components/note/note-breadcrumb'
import { NoteLayout } from '@/components/note/note-layout'
import { ProjectsEmptyState } from '@/components/sidebar/projects-empty-state'
import { ProjectsSkeleton } from '@/components/sidebar/projects-skeleton'
import { SortableProjectItem } from '@/components/sidebar/sortable-project-item'
import type { Project } from '@/data/tasks-data'

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  setActiveHeading: vi.fn(),
  sortableState: {
    attributes: { 'data-sortable': 'true' },
    listeners: { onPointerDown: vi.fn() },
    transform: { x: 4, y: 8, scaleX: 1, scaleY: 1 },
    transition: 'transform 120ms',
    isDragging: false
  },
  droppableState: {
    isOver: false,
    // The drag dnd-kit reports as in flight, or null for none.
    active: null as { data: { current: { type: string } } } | null
  },
  dragState: {
    isDragging: false
  }
}))

// The row-level middle-click / preference hooks reach useTabActions, which
// these renders have no TabProvider for — stub the whole open-target module.
vi.mock('@/hooks/use-open-target', () => ({
  useOpenTarget: () => ({ openInNewTab: vi.fn(), openToTheSide: vi.fn() }),
  useOpenPage: () => ({ openPage: vi.fn(), reuseActiveTab: false })
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({
    openTab: mocks.openTab
  }),
  // NoteLayout's scroll-restore hook renders outside a TabProvider here.
  useTabActionsOptional: () => null
}))

vi.mock('@/hooks/use-active-heading', () => ({
  useActiveHeading: () => ({
    activeHeadingId: 'intro',
    setActiveHeading: mocks.setActiveHeading
  })
}))

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: mocks.sortableState.attributes,
    listeners: mocks.sortableState.listeners,
    setNodeRef: vi.fn(),
    transform: mocks.sortableState.transform,
    transition: mocks.sortableState.transition,
    isDragging: mocks.sortableState.isDragging
  })
}))

vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({
    setNodeRef: vi.fn(),
    isOver: mocks.droppableState.isOver
  }),
  // The row reads the in-flight drag to decide whether it may advertise itself
  // as a task drop target. `active: null` is "nothing is being dragged", which
  // is the state these cold-render cases describe.
  useDndContext: () => ({ active: mocks.droppableState.active ?? null })
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: (transform: { x: number; y: number } | null) =>
        transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined
    }
  }
}))

vi.mock('@/contexts/drag-context', () => ({
  useDragContext: () => ({
    dragState: mocks.dragState
  }),
  useOptionalDragContext: () => ({
    dragState: mocks.dragState
  })
}))

vi.mock('@/components/ui/sidebar', () => ({
  SidebarMenuItem: ({
    children,
    className,
    style,
    ...props
  }: React.HTMLAttributes<HTMLLIElement>) => (
    <li className={className} style={style} {...props}>
      {children}
    </li>
  ),
  SidebarMenuButton: ({
    children,
    isActive,
    onClick,
    tooltip
  }: {
    children: React.ReactNode
    isActive?: boolean
    onClick?: React.MouseEventHandler
    tooltip?: string
  }) => (
    <button type="button" data-active={String(isActive)} title={tooltip} onClick={onClick}>
      {children}
    </button>
  ),
  SidebarMenuBadge: ({
    children,
    className
  }: {
    children: React.ReactNode
    className?: string
  }) => <span className={className}>{children}</span>,
  SidebarMenuAction: ({
    children,
    className,
    onClick
  }: {
    children: React.ReactNode
    className?: string
    onClick?: React.MouseEventHandler
  }) => (
    <button type="button" className={className} onClick={onClick}>
      {children}
    </button>
  ),
  useSidebar: () => ({ isMobile: false })
}))

const project: Project = {
  id: 'project-1',
  name: 'Writing',
  color: '#f59e0b',
  statusDefinitions: [],
  taskCount: 3,
  archivedAt: null,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z'
}

describe('note and sidebar cold surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sortableState.isDragging = false
    mocks.droppableState.isOver = false
    mocks.dragState.isDragging = false
  })

  it('opens note breadcrumb folders, dispatches sidebar reveal, and skips root notes', async () => {
    const user = userEvent.setup()
    const revealSpy = vi.fn()
    window.addEventListener(SIDEBAR_REVEAL_FOLDER_EVENT, revealSpy)

    const { rerender } = render(
      <NoteBreadcrumb notePath="notes/Projects/Research/Deep Work.md" noteTitle="Deep Work" />
    )

    await user.click(screen.getByText('Projects'))
    expect(revealSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { folderPath: 'Projects' }
      })
    )
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'folder',
        title: 'Projects',
        path: '/folder/Projects',
        entityId: 'Projects',
        isPreview: false
      })
    )

    await user.click(screen.getByLabelText('editor.breadcrumb.parentFolderAria'))
    expect(mocks.openTab).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'Research',
        entityId: 'Projects/Research'
      })
    )

    rerender(<NoteBreadcrumb notePath="notes/Root.md" noteTitle="Root" />)
    expect(screen.queryByLabelText('editor.breadcrumb.locationAria')).toBeNull()
    window.removeEventListener(SIDEBAR_REVEAL_FOLDER_EVENT, revealSpy)
  })

  it('renders layout chrome around the note body, outline, and marquee zone', () => {
    const onHeadingClick = vi.fn()
    const headings = [
      { id: 'intro', level: 2, text: 'Intro', position: 0 },
      { id: 'details', level: 3, text: 'Details', position: 40 }
    ]

    const marqueeRef = vi.fn()
    render(
      <NoteLayout
        headings={headings}
        onHeadingClick={onHeadingClick}
        breadcrumb={<span>Breadcrumb</span>}
        actions={<button type="button">Action</button>}
        topBar={<div>Top bar</div>}
        stats={{ wordCount: 10, characterCount: 50, readingTime: 1 }}
        fullWidth
        marqueeZoneRef={marqueeRef}
      >
        <article>Note body</article>
      </NoteLayout>
    )

    expect(screen.getByText('Breadcrumb')).toBeInTheDocument()
    expect(screen.getByText('Action')).toBeInTheDocument()
    expect(screen.getByText('Top bar')).toBeInTheDocument()
    expect(screen.getByText('Note body')).toBeInTheDocument()
    expect(marqueeRef).toHaveBeenCalled()
  })

  it('reports the heading the reader is on, so the mind map knows where to open', async () => {
    const onActiveHeadingChange = vi.fn()
    const headings = [
      { id: 'intro', level: 2, text: 'Intro', position: 0 },
      { id: 'details', level: 3, text: 'Details', position: 40 }
    ]

    render(
      <NoteLayout headings={headings} onActiveHeadingChange={onActiveHeadingChange}>
        <article>
          <h2 data-id="intro">Intro</h2>
          <h3 data-id="details">Details</h3>
        </article>
      </NoteLayout>
    )

    // Reported rather than lifted: nothing above this layout re-renders when
    // the reader scrolls past a heading, but the note page still has to know
    // which one they were on when they ask for the map.
    await waitFor(() => expect(onActiveHeadingChange).toHaveBeenCalled())
    const reported = onActiveHeadingChange.mock.calls.at(-1)?.[0]
    expect(headings.map((heading) => heading.id)).toContain(reported)
  })

  it('hangs the comment rail off the centered content column', () => {
    const { container } = render(
      <NoteLayout
        headings={[]}
        breadcrumb={<span>Breadcrumb</span>}
        sideRail={<aside>Comment rail</aside>}
        contentWidth="640px"
      >
        <article>Note body</article>
      </NoteLayout>
    )

    const canvas = container.querySelector('[data-note-layout-canvas]')
    const main = container.querySelector('[data-note-layout-main]')
    const rail = container.querySelector('[data-note-layout-rail]')

    expect(canvas).toHaveClass('px-24')
    expect(canvas).toHaveStyle({ maxWidth: 'calc(640px + 12rem)' })
    expect(main).toHaveClass('review-canvas')
    expect(main).toContainElement(screen.getByText('Note body'))
    expect(rail).toContainElement(screen.getByText('Comment rail'))
    expect(rail).toHaveClass('review-canvas-rail')
  })

  it('reserves a grid rail column in full width mode', () => {
    const { container } = render(
      <NoteLayout
        headings={[]}
        breadcrumb={<span>Breadcrumb</span>}
        sideRail={<aside>Comment rail</aside>}
        fullWidth
      >
        <article>Note body</article>
      </NoteLayout>
    )

    const canvas = container.querySelector('[data-note-layout-canvas]')
    const rail = container.querySelector('[data-note-layout-rail]')

    expect(canvas).toHaveClass('grid')
    expect(canvas).toHaveStyle({ maxWidth: '100%' })
    expect(rail).toContainElement(screen.getByText('Comment rail'))
    expect(rail).toHaveClass('max-[920px]:hidden')
  })

  it('renders project empty, skeleton, and sortable drop/edit states', async () => {
    const user = userEvent.setup()
    const onCreateProject = vi.fn()
    render(<ProjectsEmptyState onCreateProject={onCreateProject} className="custom-empty" />)
    await user.click(
      screen.getByText('phaseF.componentsSidebarProjectsEmptyState.createYourFirstProject2')
    )
    fireEvent.keyDown(
      screen.getByLabelText('phaseF.componentsSidebarProjectsEmptyState.createYourFirstProject'),
      { key: 'Enter' }
    )
    fireEvent.keyDown(
      screen.getByLabelText('phaseF.componentsSidebarProjectsEmptyState.createYourFirstProject'),
      { key: ' ' }
    )
    expect(onCreateProject).toHaveBeenCalledTimes(3)

    const { container, rerender } = render(
      <ProjectsSkeleton count={4} className="loading-projects" />
    )
    expect(container.querySelectorAll('.animate-pulse').length).toBe(12)

    const handlers = {
      onClick: vi.fn(),
      onEdit: vi.fn(),
      onArchive: vi.fn(),
      onDelete: vi.fn()
    }
    rerender(<SortableProjectItem project={project} isActive={false} {...handlers} />)
    await user.click(screen.getByTitle('Writing'))
    await user.click(screen.getByText('phaseF.componentsSidebarSortableProjectItem.editProject'))
    expect(handlers.onClick).toHaveBeenCalledOnce()
    expect(handlers.onEdit).toHaveBeenCalledWith(project)
    expect(screen.getByText('3')).toBeInTheDocument()

    mocks.dragState.isDragging = true
    rerender(<SortableProjectItem project={{ ...project, taskCount: 0 }} isActive {...handlers} />)
    expect(container.querySelector('.border-dotted')).toBeInTheDocument()
    expect(screen.queryByText('phaseF.componentsSidebarSortableProjectItem.editProject')).toBeNull()

    mocks.droppableState.isOver = true
    rerender(<SortableProjectItem project={project} isActive={false} {...handlers} />)
    expect(
      screen.getByText('phaseF.componentsSidebarSortableProjectItem.dropHere')
    ).toBeInTheDocument()
    expect(screen.queryByText('3')).toBeNull()

    // Dragging a project to REORDER it must not turn the rows into task drop
    // targets. It used to: the row's droppable won the collision, the drop
    // resolved to no project, and the reorder was reported as "0 tasks moved".
    mocks.droppableState.active = { data: { current: { type: 'project-sort' } } }
    rerender(<SortableProjectItem project={project} isActive={false} {...handlers} />)
    expect(screen.queryByText('phaseF.componentsSidebarSortableProjectItem.dropHere')).toBeNull()
    expect(container.querySelector('.border-dotted')).toBeNull()
    mocks.droppableState.active = null

    mocks.sortableState.isDragging = true
    mocks.droppableState.isOver = false
    rerender(<SortableProjectItem project={project} isActive={false} {...handlers} />)
    expect(container.querySelector('.opacity-50')).toBeInTheDocument()
  })
})
