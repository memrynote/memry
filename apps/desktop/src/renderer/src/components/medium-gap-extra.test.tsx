import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ActiveFiltersBar } from './tasks/filters/active-filters-bar'
import { ExpandChevron } from './tasks/expand-chevron'
import { SortableSubtaskList } from './tasks/sortable-subtask-list'
import { detectClusters, getClusterKey } from '@/lib/ai-clustering'
import {
  createHashTagSpacePlugin,
  matchHashTagBeforeCursor
} from './note/content-area/hash-tag-space-plugin'
import { useActiveHeading } from '@/hooks/use-active-heading'
import type { Project, TaskFilters, Status } from '@/data/tasks-data'
import type { Task } from '@/data/task-model'
import type { InboxItemListItem } from '@/types'

const mockDnd = vi.hoisted(() => ({
  dragEnd: null as ((event: { active: { id: string }; over: { id: string } | null }) => void) | null
}))

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({
    children,
    onDragEnd
  }: {
    children: React.ReactNode
    onDragEnd: typeof mockDnd.dragEnd
  }) => {
    mockDnd.dragEnd = onDragEnd
    return <div data-testid="dnd-context">{children}</div>
  },
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn((sensor, options) => ({ sensor, options })),
  useSensors: vi.fn((...sensors) => sensors)
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sortable-context">{children}</div>
  ),
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: vi.fn()
}))

vi.mock('@dnd-kit/modifiers', () => ({
  restrictToVerticalAxis: vi.fn(),
  restrictToParentElement: vi.fn()
}))

vi.mock('@/components/tasks/sortable-subtask-row', () => ({
  SortableSubtaskRow: ({
    subtask,
    onToggleComplete,
    onClick
  }: {
    subtask: Task
    onToggleComplete: (id: string) => void
    onClick?: (id: string) => void
  }) => (
    <button
      type="button"
      data-testid={`subtask-${subtask.id}`}
      onClick={() => {
        onToggleComplete(subtask.id)
        onClick?.(subtask.id)
      }}
    >
      {subtask.title}
    </button>
  )
}))

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  name: 'Work',
  description: '',
  icon: 'briefcase',
  color: '#2563eb',
  statuses: [
    { id: 'todo', name: 'Todo', color: '#64748b', type: 'todo', order: 0 },
    { id: 'done', name: 'Done', color: '#16a34a', type: 'done', order: 1 }
  ],
  isDefault: false,
  isArchived: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  taskCount: 0,
  ...overrides
})

const makeFilters = (overrides: Partial<TaskFilters> = {}): TaskFilters => ({
  search: '',
  projectIds: [],
  priorities: [],
  tags: [],
  dueDate: { type: 'any', customStart: null, customEnd: null },
  statusIds: [],
  completion: 'all',
  repeatType: 'all',
  hasTime: 'all',
  ...overrides
})

const makeItem = (overrides: Partial<InboxItemListItem>): InboxItemListItem =>
  ({
    id: 'item',
    type: 'link',
    title: 'Untitled',
    content: null,
    sourceUrl: null,
    metadata: null,
    tags: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    status: 'active',
    ...overrides
  }) as InboxItemListItem

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: 'Task',
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
  parentId: 'parent-1',
  subtaskIds: [],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  completedAt: null,
  archivedAt: null,
  ...overrides
})

const rect = (top: number, bottom: number): DOMRect =>
  ({
    top,
    bottom,
    left: 0,
    right: 0,
    width: 0,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({})
  }) as DOMRect

describe('medium gap renderer surfaces', () => {
  const originalDateNow = Date.now
  let rafCallbacks: FrameRequestCallback[]

  beforeEach(() => {
    rafCallbacks = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    Date.now = originalDateNow
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  const flushRaf = (): void => {
    const callbacks = [...rafCallbacks]
    rafCallbacks = []
    callbacks.forEach((callback) => callback(0))
  }

  it('clusters inbox items by type, domain, topic, and key', () => {
    expect(detectClusters([], [])).toBeNull()

    const typeCluster = detectClusters(
      [makeItem({ id: 'a', type: 'note', title: 'Design note' })],
      [
        makeItem({ id: 'a', type: 'note', title: 'Design note' }),
        makeItem({ id: 'b', type: 'note', title: 'Other note' })
      ]
    )
    expect(typeCluster?.reason).toBe('1 more notes')

    const domainCluster = detectClusters(
      [
        makeItem({ id: 'a', title: 'One', sourceUrl: 'https://example.com/a' }),
        makeItem({ id: 'selected-note', type: 'note', title: 'Selected note' })
      ],
      [
        makeItem({ id: 'b', title: 'Two', sourceUrl: 'https://example.com/b' }),
        makeItem({ id: 'c', title: 'Other', sourceUrl: 'https://other.test/c' })
      ]
    )
    expect(domainCluster?.reason).toBe('1 more from example.com')

    expect(
      detectClusters(
        [makeItem({ id: 'a', type: 'image', title: 'Figma design tokens' })],
        [makeItem({ id: 'b', type: 'link', title: 'Component design system' })]
      )?.reason
    ).toBe('1 more items about design')

    expect(
      detectClusters(
        [makeItem({ id: 'a', type: 'image', title: 'React architecture' })],
        [makeItem({ id: 'b', type: 'link', title: 'Backend architecture notes' })]
      )?.reason
    ).toBe('1 more items about development')

    const generic = detectClusters(
      [makeItem({ id: 'z', type: 'image', title: 'Quarterly roadmap' })],
      [makeItem({ id: 'y', type: 'link', title: 'Roadmap planning memo' })]
    )
    expect(generic?.reason).toBe('1 more related items')
    expect(getClusterKey(generic!)).toBe('1 more related items:y')
  })

  it('matches hash tags and completes typed tags through the plugin append transaction', () => {
    expect(matchHashTagBeforeCursor('Ship #memrynote-Launch ')).toBe('memrynote-Launch')
    expect(matchHashTagBeforeCursor('Ship #broken/ ')).toBeNull()

    const plugin = createHashTagSpacePlugin((tag) => `color:${tag}`)
    const appendTransaction = plugin.spec.appendTransaction!

    expect(
      appendTransaction(
        [{ docChanged: false, getMeta: () => false } as never],
        {} as never,
        {} as never
      )
    ).toBeNull()

    const tr = {
      replaceWith: vi.fn(() => tr),
      setMeta: vi.fn()
    }
    const hashTagNode = { type: 'hashTag' }
    const textNode = { type: 'text' }
    const state = {
      selection: {
        $from: {
          parent: {
            type: { spec: {} },
            textBetween: () => 'Ship #memrynote '
          },
          parentOffset: 'Ship #memrynote '.length,
          start: () => 10
        }
      },
      schema: {
        nodes: {
          hashTag: {
            create: vi.fn(() => hashTagNode)
          }
        },
        text: vi.fn(() => textNode)
      },
      tr
    }

    const result = appendTransaction(
      [{ docChanged: true, getMeta: () => false } as never],
      {} as never,
      state as never
    )

    expect(result).toBe(tr)
    expect(state.schema.nodes.hashTag.create).toHaveBeenCalledWith({
      tag: 'memrynote',
      color: 'color:memrynote'
    })
    expect(tr.replaceWith).toHaveBeenCalledWith(15, 26, expect.anything())
    expect(tr.setMeta).toHaveBeenCalled()

    const codeState = {
      ...state,
      selection: { $from: { ...state.selection.$from, parent: { type: { spec: { code: true } } } } }
    }
    expect(
      appendTransaction(
        [{ docChanged: true, getMeta: () => false } as never],
        {} as never,
        codeState as never
      )
    ).toBeNull()

    const noNodeState = { ...state, schema: { ...state.schema, nodes: {} } }
    expect(
      appendTransaction(
        [{ docChanged: true, getMeta: () => false } as never],
        {} as never,
        noNodeState as never
      )
    ).toBeNull()
  })

  it('tracks active headings through top, bottom, throttled scroll, and manual override paths', () => {
    const container = document.createElement('div')
    Object.defineProperties(container, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 200, configurable: true },
      scrollTop: { value: 0, configurable: true, writable: true }
    })
    document.body.append(container)

    const h1 = document.createElement('h2')
    h1.dataset.id = 'h1'
    h1.getBoundingClientRect = () => rect(80, 120)
    const h2 = document.createElement('h2')
    h2.dataset.id = 'h2'
    h2.getBoundingClientRect = () => rect(760, 800)
    container.append(h1, h2)

    const scrollContainerRef = { current: container }
    const { result } = renderHook(() =>
      useActiveHeading({
        headings: [
          { id: 'h1', level: 2, text: 'One', position: 0 },
          { id: 'h2', level: 2, text: 'Two', position: 1 }
        ],
        scrollContainerRef,
        throttleMs: 50
      })
    )

    act(flushRaf)
    expect(result.current.activeHeadingId).toBe('h1')

    act(() => {
      result.current.setActiveHeading('h2')
    })
    expect(result.current.activeHeadingId).toBe('h2')

    Object.defineProperty(container, 'scrollTop', { value: 799, configurable: true })
    h2.getBoundingClientRect = () => rect(20, 60)
    Date.now = vi.fn(() => 1000)
    act(() => {
      container.dispatchEvent(new Event('scroll'))
    })
    expect(result.current.activeHeadingId).toBe('h2')

    Object.defineProperty(container, 'scrollTop', { value: 0, configurable: true })
    h1.getBoundingClientRect = () => rect(900, 940)
    h2.getBoundingClientRect = () => rect(1000, 1040)
    Date.now = vi.fn(() => 1010)
    act(() => {
      window.dispatchEvent(new Event('resize'))
      flushRaf()
    })
    expect(result.current.activeHeadingId).toBeNull()
  })

  it('renders active task filters and clears individual pills', () => {
    const onUpdateFilters = vi.fn()
    const onClearAll = vi.fn()
    const onSaveFilter = vi.fn()

    render(
      <ActiveFiltersBar
        filters={makeFilters({
          search: 'roadmap',
          priorities: ['urgent', 'low'],
          statusIds: ['todo', 'missing-status'],
          projectIds: ['project-1', 'missing-project'],
          dueDate: {
            type: 'custom',
            customStart: new Date('2026-05-10T00:00:00Z'),
            customEnd: new Date('2026-05-12T00:00:00Z')
          }
        })}
        projects={[makeProject()]}
        onUpdateFilters={onUpdateFilters}
        onClearAll={onClearAll}
        onSaveFilter={onSaveFilter}
        isSaved
      />
    )

    expect(screen.getByText('Urgent, Low')).toBeInTheDocument()
    expect(screen.getByText('Todo, missing-status')).toBeInTheDocument()
    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.getByText('"roadmap"')).toBeInTheDocument()
    expect(screen.getByText(/May 10/)).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText(/Remove .*priority.* filter/i))
    fireEvent.click(screen.getByLabelText(/Remove .*status.* filter/i))
    fireEvent.click(screen.getByLabelText(/Remove .*project.* filter/i))
    fireEvent.click(screen.getByLabelText(/Remove .*due.* filter/i))
    fireEvent.click(screen.getByLabelText(/Remove .*search.* filter/i))
    fireEvent.click(screen.getByLabelText('Saved'))
    fireEvent.click(screen.getByText(/clear/i))

    expect(onUpdateFilters).toHaveBeenCalledWith({ priorities: [] })
    expect(onUpdateFilters).toHaveBeenCalledWith({ statusIds: [] })
    expect(onUpdateFilters).toHaveBeenCalledWith({ projectIds: [] })
    expect(onUpdateFilters).toHaveBeenCalledWith({
      dueDate: { type: 'any', customStart: null, customEnd: null }
    })
    expect(onUpdateFilters).toHaveBeenCalledWith({ search: '' })
    expect(onSaveFilter).toHaveBeenCalled()
    expect(onClearAll).toHaveBeenCalled()
  })

  it('handles expandable chevrons and sortable subtask drag outcomes', () => {
    vi.useFakeTimers()
    const onExpand = vi.fn()
    const { rerender } = render(
      <ExpandChevron isExpanded={false} hasSubtasks={false} onClick={onExpand} />
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()

    rerender(<ExpandChevron isExpanded={false} hasSubtasks onClick={onExpand} size="sm" />)
    const chevron = screen.getByRole('button', { name: 'Expand subtasks' })
    fireEvent.click(chevron)
    fireEvent.keyDown(chevron, { key: 'Enter' })
    fireEvent.keyDown(chevron, { key: ' ' })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(onExpand).toHaveBeenCalledTimes(3)

    const onReorder = vi.fn()
    const onToggleComplete = vi.fn()
    const onClick = vi.fn()
    const statuses: Status[] = [
      { id: 'todo', name: 'Todo', color: '#64748b', type: 'todo', order: 0 }
    ]
    render(
      <SortableSubtaskList
        parentId="parent-1"
        parentTitle="Parent task"
        statuses={statuses}
        subtasks={[
          makeTask({ id: 'sub-1', title: 'First' }),
          makeTask({ id: 'sub-2', title: 'Second' })
        ]}
        onReorder={onReorder}
        onToggleComplete={onToggleComplete}
        onClick={onClick}
      />
    )

    fireEvent.click(screen.getByTestId('subtask-sub-1'))
    expect(onToggleComplete).toHaveBeenCalledWith('sub-1')
    expect(onClick).toHaveBeenCalledWith('sub-1')

    act(() => {
      mockDnd.dragEnd?.({ active: { id: 'sub-2' }, over: { id: 'sub-1' } })
      mockDnd.dragEnd?.({ active: { id: 'sub-2' }, over: { id: 'sub-2' } })
      mockDnd.dragEnd?.({ active: { id: 'missing' }, over: { id: 'sub-1' } })
      mockDnd.dragEnd?.({ active: { id: 'sub-1' }, over: null })
    })
    expect(onReorder).toHaveBeenCalledWith('parent-1', ['sub-2', 'sub-1'])
    expect(onReorder).toHaveBeenCalledTimes(1)
  })
})
