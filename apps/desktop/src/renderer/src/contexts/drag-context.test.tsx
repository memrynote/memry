import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dndMocks = vi.hoisted(() => ({
  latestProps: null as null | Record<string, any>,
  useSensor: vi.fn((sensor: unknown, config?: unknown) => ({ sensor, config })),
  useSensors: vi.fn((...sensors: unknown[]) => sensors),
  closestCenter: vi.fn(() => [{ id: 'closest' }]),
  pointerWithin: vi.fn(() => []),
  rectIntersection: vi.fn(() => [])
}))

vi.mock('@dnd-kit/core', () => ({
  DndContext: (props: Record<string, any>) => {
    dndMocks.latestProps = props
    return props.children
  },
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  TouchSensor: vi.fn(),
  useSensor: dndMocks.useSensor,
  useSensors: dndMocks.useSensors,
  closestCenter: dndMocks.closestCenter,
  pointerWithin: dndMocks.pointerWithin,
  rectIntersection: dndMocks.rectIntersection
}))

vi.mock('@dnd-kit/sortable', () => ({
  sortableKeyboardCoordinates: vi.fn()
}))

import {
  DragProvider,
  dragAnnouncements,
  resolveTaskEdgeFromDndEvent,
  useDragContext
} from './drag-context'
import type { Task } from '@/data/task-model'

const task = (id: string, title = id): Task =>
  ({
    id,
    title,
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
    createdAt: new Date(),
    completedAt: null,
    archivedAt: null
  }) as Task

describe('DragProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    dndMocks.latestProps = null
    Object.defineProperty(navigator, 'vibrate', {
      value: vi.fn(),
      configurable: true
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('tracks multi-drag state, over targets, callbacks, and post-drop highlight', () => {
    const callbacks = {
      start: vi.fn(),
      over: vi.fn(),
      end: vi.fn(),
      cancel: vi.fn()
    }
    const selectedIds = new Set(['task-1', 'task-2'])
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DragProvider
        tasks={[task('task-1', 'One'), task('task-2', 'Two')]}
        selectedIds={selectedIds}
        onDragStart={callbacks.start}
        onDragOver={callbacks.over}
        onDragEnd={callbacks.end}
        onDragCancel={callbacks.cancel}
      >
        {children}
      </DragProvider>
    )

    const { result } = renderHook(() => useDragContext(), { wrapper })

    act(() => {
      dndMocks.latestProps?.onDragStart({
        active: {
          id: 'task-1',
          data: {
            current: {
              type: 'task',
              sectionId: 'today',
              overlayRowVariant: 'parent',
              overlayShowProjectBadge: true,
              overlayParentProgress: { completed: 1, total: 2 },
              overlayParentExpanded: true
            }
          },
          rect: { current: { initial: { width: 122.6 } } }
        }
      })
    })

    expect(result.current.dragState.activeIds).toEqual(['task-1', 'task-2'])
    expect(result.current.dragState.overlayWidth).toBe(123)
    expect(result.current.dragState.overlayRowVariant).toBe('parent')
    expect(result.current.isMultiDrag).toBe(true)
    expect(callbacks.start).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ activeId: 'task-1', activeIds: ['task-1', 'task-2'] })
    )

    act(() => {
      dndMocks.latestProps?.onDragOver({
        active: { rect: { current: { translated: { top: 0, height: 20 } } } },
        over: {
          id: 'task-2',
          data: { current: { type: 'task', sectionId: 'today', columnId: 'today' } },
          rect: { top: 20, height: 40 }
        },
        activatorEvent: new MouseEvent('pointerdown', { clientY: 10 }),
        delta: { y: 40 }
      })
    })

    expect(result.current.dragState.overId).toBe('task-2')
    expect(result.current.dragState.overTaskEdge).toBe('after')
    expect(callbacks.over).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ overId: 'task-2', overTaskEdge: 'after' })
    )

    act(() => {
      dndMocks.latestProps?.onDragEnd({
        active: { id: 'task-1', data: { current: {} } },
        over: { id: 'task-2', data: { current: { type: 'task' } } }
      })
    })

    expect(callbacks.end).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ activeId: 'task-1' })
    )
    expect(result.current.dragState.activeId).toBeNull()

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(result.current.dragState.lastDroppedId).toBe('task-1')

    act(() => {
      vi.advanceTimersByTime(1100)
    })
    expect(result.current.dragState.lastDroppedId).toBeNull()

    act(() => {
      dndMocks.latestProps?.onDragCancel()
    })
    expect(callbacks.cancel).toHaveBeenCalledTimes(1)
  })

  it('allows manual state updates through the context value', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DragProvider tasks={[task('task-1')]} selectedIds={new Set()}>
        {children}
      </DragProvider>
    )

    const { result } = renderHook(() => useDragContext(), { wrapper })

    act(() => {
      result.current.setDragState({ activeId: 'manual', activeIds: ['manual'], isDragging: true })
    })

    expect(result.current.dragState.activeId).toBe('manual')
    expect(result.current.dragCount).toBe(1)

    act(() => {
      result.current.resetDragState()
    })
    expect(result.current.dragState.activeId).toBeNull()
  })

  it('throws when the hook is used without a provider', () => {
    expect(() => renderHook(() => useDragContext())).toThrow(
      'useDragContext must be used within a DragProvider'
    )
  })
})

describe('resolveTaskEdgeFromDndEvent', () => {
  it('uses pointer, touch, and active-rect fallbacks', () => {
    expect(
      resolveTaskEdgeFromDndEvent({
        active: { rect: { current: { translated: null } } },
        over: null,
        activatorEvent: new MouseEvent('pointerdown', { clientY: 0 }),
        delta: { y: 0 }
      } as any)
    ).toBeNull()

    expect(
      resolveTaskEdgeFromDndEvent({
        active: { rect: { current: { translated: null } } },
        over: { rect: { top: 20, height: 40 } },
        activatorEvent: new MouseEvent('pointerdown', { clientY: 5 }),
        delta: { y: 10 }
      } as any)
    ).toBe('before')

    expect(
      resolveTaskEdgeFromDndEvent({
        active: { rect: { current: { translated: null } } },
        over: { rect: { top: 20, height: 40 } },
        activatorEvent: { touches: [{ clientY: 70 }] },
        delta: { y: 0 }
      } as any)
    ).toBe('after')

    expect(
      resolveTaskEdgeFromDndEvent({
        active: { rect: { current: { translated: { top: 50, height: 20 } } } },
        over: { rect: { top: 20, height: 40 } },
        activatorEvent: {},
        delta: { y: 0 }
      } as any)
    ).toBe('after')
  })
})

describe('drag collision detection', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DragProvider tasks={[task('task-1')]} selectedIds={new Set()}>
      {children}
    </DragProvider>
  )
  const collision = (id: string, type: string, data: Record<string, unknown> = {}) =>
    ({
      id,
      data: {
        droppableContainer: {
          data: {
            current: { type, ...data }
          }
        }
      }
    }) as any
  const detectorArgs = (activeData: Record<string, unknown> = {}) =>
    ({
      active: { data: { current: activeData } }
    }) as any

  const getDetector = () => {
    renderHook(() => useDragContext(), { wrapper })
    return dndMocks.latestProps?.collisionDetection as (args: any) => any[]
  }

  it('prioritizes pointer-owned sidebar, date, and list task targets', () => {
    const detect = getDetector()
    const project = collision('project-1', 'project')
    dndMocks.pointerWithin.mockReturnValueOnce([collision('task-1', 'task'), project])
    expect(detect(detectorArgs())).toEqual([project])

    const date = collision('date-1', 'date')
    dndMocks.pointerWithin.mockReturnValueOnce([date])
    expect(detect(detectorArgs())).toEqual([date])

    const taskTarget = collision('task-2', 'task')
    dndMocks.pointerWithin.mockReturnValueOnce([taskTarget])
    expect(detect(detectorArgs({ sourceType: 'list' }))).toEqual([taskTarget])
  })

  it('resolves kanban column intent before falling back to rect and center collisions', () => {
    const detect = getDetector()
    const otherColumn = collision('doing', 'column', { columnId: 'doing' })
    const doingTask = collision('task-2', 'task', { columnId: 'doing' })
    dndMocks.pointerWithin.mockReturnValueOnce([otherColumn])
    dndMocks.closestCenter.mockReturnValueOnce([doingTask])
    expect(detect(detectorArgs({ columnId: 'todo' }))).toEqual([doingTask])

    const sourceColumn = collision('todo', 'column', { columnId: 'todo' })
    const sameColumnTask = collision('task-1', 'task', { columnId: 'todo' })
    dndMocks.pointerWithin.mockReturnValueOnce([sourceColumn])
    dndMocks.closestCenter.mockReturnValueOnce([sameColumnTask])
    expect(detect(detectorArgs({ columnId: 'todo' }))).toEqual([sameColumnTask])

    dndMocks.pointerWithin.mockReturnValueOnce([])
    dndMocks.rectIntersection.mockReturnValueOnce([otherColumn])
    dndMocks.closestCenter.mockReturnValueOnce([
      collision('elsewhere', 'task', { columnId: 'later' })
    ])
    expect(detect(detectorArgs({ columnId: 'todo' }))).toEqual([otherColumn])
  })

  it('falls back through rect column, section, and closest center targets', () => {
    const detect = getDetector()
    const column = collision('status-done', 'column')
    dndMocks.pointerWithin.mockReturnValueOnce([])
    dndMocks.rectIntersection.mockReturnValueOnce([column])
    expect(detect(detectorArgs())).toEqual([column])

    const section = collision('today', 'section')
    dndMocks.pointerWithin.mockReturnValueOnce([])
    dndMocks.rectIntersection.mockReturnValueOnce([section])
    expect(detect(detectorArgs())).toEqual([section])

    dndMocks.pointerWithin.mockReturnValueOnce([])
    dndMocks.rectIntersection.mockReturnValueOnce([])
    dndMocks.closestCenter.mockReturnValueOnce([collision('closest', 'task')])
    expect(detect(detectorArgs())).toEqual([collision('closest', 'task')])
  })
})

describe('dragAnnouncements', () => {
  it('announces drag locations and results for each supported target type', () => {
    const active = { data: { current: { task: { title: 'Write tests' } } } }

    expect(dragAnnouncements.onDragStart({ active } as any)).toContain('Write tests')
    expect(
      dragAnnouncements.onDragOver({
        over: { data: { current: { type: 'section', label: 'Today' } } }
      } as any)
    ).toBe('Over section: Today. Release to drop.')
    expect(
      dragAnnouncements.onDragOver({
        over: { data: { current: { type: 'column', column: { title: 'Done' } } } }
      } as any)
    ).toBe('Over column: Done. Release to change status.')
    expect(
      dragAnnouncements.onDragOver({
        over: { data: { current: { type: 'date', date: new Date('2026-05-09') } } }
      } as any)
    ).toContain('Over date:')
    expect(
      dragAnnouncements.onDragOver({
        over: { data: { current: { type: 'project', project: { name: 'Memry' } } } }
      } as any)
    ).toBe('Over project: Memry. Release to move.')
    expect(
      dragAnnouncements.onDragOver({ over: { data: { current: { type: 'trash' } } } } as any)
    ).toBe('Over trash. Release to delete.')
    expect(
      dragAnnouncements.onDragOver({ over: { data: { current: { type: 'archive' } } } } as any)
    ).toBe('Over archive. Release to archive.')
    expect(dragAnnouncements.onDragOver({ over: null } as any)).toBe('')

    expect(
      dragAnnouncements.onDragEnd({
        active,
        over: { data: { current: { type: 'archive' } } }
      } as any)
    ).toBe('Task Write tests archived.')
    expect(dragAnnouncements.onDragEnd({ active, over: null } as any)).toBe('Drop cancelled.')
    expect(dragAnnouncements.onDragCancel()).toBe('Drag cancelled.')
  })
})
