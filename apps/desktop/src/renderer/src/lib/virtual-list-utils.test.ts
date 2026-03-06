import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project, Status, StatusType } from '@/data/tasks-data'
import type { TaskGroupByDate, TaskGroupByStatus, UrgencyLevel } from '@/lib/task-utils'

// Mock dependencies
vi.mock('@/lib/task-utils', async () => {
  const actual = await vi.importActual('@/lib/task-utils')
  return {
    ...actual,
    groupTasksByDueDate: vi.fn(),
    groupTasksByStatus: vi.fn()
  }
})

vi.mock('@/lib/subtask-utils', () => ({
  getTopLevelTasks: vi.fn((tasks: Task[]) => tasks.filter((t) => t.parentId === null)),
  getSubtasks: vi.fn((id: string, tasks: Task[]) => tasks.filter((t) => t.parentId === id)),
  hasSubtasks: vi.fn((task: Task) => task.subtaskIds?.length > 0)
}))

import {
  ITEM_HEIGHTS,
  estimateItemHeight,
  flattenTasksByDueDate,
  flattenTodayTasks,
  flattenTasksByStatus,
  getTaskIdsFromVirtualItems,
  type VirtualItem,
  type SectionHeaderItem,
  type StatusHeaderItem,
  type TaskItem,
  type ParentTaskItem,
  type EmptyStateItem,
  type AddTaskButtonItem,
  type TodayViewData,
  type WeekAccordionHeaderItem,
  type DayHeaderItem
} from './virtual-list-utils'

import { groupTasksByDueDate, groupTasksByStatus, dueDateGroupConfig } from '@/lib/task-utils'
import { getTopLevelTasks, getSubtasks, hasSubtasks } from '@/lib/subtask-utils'

// ============================================================================
// MOCK FACTORIES
// ============================================================================

const createMockTask = (overrides: Partial<Task> = {}): Task => ({
  id: `task-${Math.random().toString(36).substring(2, 9)}`,
  title: 'Test Task',
  description: '',
  projectId: 'project-1',
  statusId: 'status-todo',
  priority: 'none' as Priority,
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
  archivedAt: null,
  ...overrides
})

const createMockStatus = (overrides: Partial<Status> = {}): Status => ({
  id: 'status-todo',
  name: 'Todo',
  color: '#gray',
  type: 'todo' as StatusType,
  order: 0,
  ...overrides
})

const createMockProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  name: 'Test Project',
  description: '',
  icon: 'folder',
  color: '#3b82f6',
  statuses: [
    createMockStatus({ id: 'status-todo', name: 'Todo', type: 'todo', order: 0 }),
    createMockStatus({ id: 'status-done', name: 'Done', color: '#green', type: 'done', order: 1 })
  ],
  isDefault: false,
  isArchived: false,
  createdAt: new Date(),
  taskCount: 0,
  ...overrides
})

// ============================================================================
// TEST SETUP
// ============================================================================

describe('virtual-list-utils', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 15)) // January 15, 2026
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ==========================================================================
  // T116: ITEM HEIGHT CONSTANTS & ESTIMATION
  // ==========================================================================

  describe('ITEM_HEIGHTS constants (T116)', () => {
    it('should have correct height for section-header', () => {
      expect(ITEM_HEIGHTS['section-header']).toBe(48)
    })

    it('should have correct height for status-header', () => {
      expect(ITEM_HEIGHTS['status-header']).toBe(48)
    })

    it('should have correct height for task', () => {
      expect(ITEM_HEIGHTS.task).toBe(52)
    })

    it('should have correct height for parent-task-collapsed', () => {
      expect(ITEM_HEIGHTS['parent-task-collapsed']).toBe(52)
    })

    it('should have correct height for subtask-row', () => {
      expect(ITEM_HEIGHTS['subtask-row']).toBe(38)
    })

    it('should have correct height for add-subtask-input', () => {
      expect(ITEM_HEIGHTS['add-subtask-input']).toBe(40)
    })

    it('should have correct height for empty-state', () => {
      expect(ITEM_HEIGHTS['empty-state']).toBe(80)
    })

    it('should have correct height for empty-state-celebration', () => {
      expect(ITEM_HEIGHTS['empty-state-celebration']).toBe(200)
    })

    it('should have correct height for add-task-button', () => {
      expect(ITEM_HEIGHTS['add-task-button']).toBe(40)
    })
  })

  describe('estimateItemHeight (T116)', () => {
    const mockProject = createMockProject()
    const emptyExpandedIds = new Set<string>()

    it('should return 48 for section-header', () => {
      const item: SectionHeaderItem = {
        id: 'header-today',
        type: 'section-header',
        sectionKey: 'today',
        label: 'TODAY',
        count: 5,
        urgency: 'high' as UrgencyLevel
      }

      expect(estimateItemHeight(item, emptyExpandedIds, [])).toBe(48)
    })

    it('should return 48 for status-header', () => {
      const item: StatusHeaderItem = {
        id: 'status-header-todo',
        type: 'status-header',
        status: createMockStatus(),
        count: 3
      }

      expect(estimateItemHeight(item, emptyExpandedIds, [])).toBe(48)
    })

    it('should return 52 for task', () => {
      const task = createMockTask()
      const item: TaskItem = {
        id: `task-${task.id}`,
        type: 'task',
        task,
        project: mockProject,
        sectionId: 'today'
      }

      expect(estimateItemHeight(item, emptyExpandedIds, [])).toBe(52)
    })

    it('should return 52 for collapsed parent-task', () => {
      const task = createMockTask({ subtaskIds: ['sub-1', 'sub-2'] })
      const item: ParentTaskItem = {
        id: `parent-task-${task.id}`,
        type: 'parent-task',
        task,
        project: mockProject,
        subtasks: [],
        sectionId: 'today'
      }

      expect(estimateItemHeight(item, emptyExpandedIds, [])).toBe(52)
    })

    it('should return expanded height for parent-task when expanded', () => {
      const parentTask = createMockTask({
        id: 'parent-1',
        subtaskIds: ['sub-1', 'sub-2']
      })
      const subtask1 = createMockTask({ id: 'sub-1', parentId: 'parent-1' })
      const subtask2 = createMockTask({ id: 'sub-2', parentId: 'parent-1' })

      const allTasks = [parentTask, subtask1, subtask2]
      const expandedIds = new Set<string>(['parent-1'])

      const item: ParentTaskItem = {
        id: `parent-task-${parentTask.id}`,
        type: 'parent-task',
        task: parentTask,
        project: mockProject,
        subtasks: [subtask1, subtask2],
        sectionId: 'today'
      }

      // Expected: 52 (base) + 2 * 38 (subtasks) + 40 (add input) = 168
      expect(estimateItemHeight(item, expandedIds, allTasks)).toBe(168)
    })

    it('should return correct height for expanded parent-task with 0 subtasks', () => {
      const parentTask = createMockTask({
        id: 'parent-empty',
        subtaskIds: []
      })

      const allTasks = [parentTask]
      const expandedIds = new Set<string>(['parent-empty'])

      const item: ParentTaskItem = {
        id: `parent-task-${parentTask.id}`,
        type: 'parent-task',
        task: parentTask,
        project: mockProject,
        subtasks: [],
        sectionId: 'today'
      }

      // Expected: 52 (base) + 0 * 38 + 40 (add input) = 92
      expect(estimateItemHeight(item, expandedIds, allTasks)).toBe(92)
    })

    it('should return correct height for expanded parent-task with 5 subtasks', () => {
      const parentTask = createMockTask({
        id: 'parent-many',
        subtaskIds: ['sub-1', 'sub-2', 'sub-3', 'sub-4', 'sub-5']
      })
      const subtasks = Array.from({ length: 5 }, (_, i) =>
        createMockTask({ id: `sub-${i + 1}`, parentId: 'parent-many' })
      )

      const allTasks = [parentTask, ...subtasks]
      const expandedIds = new Set<string>(['parent-many'])

      const item: ParentTaskItem = {
        id: `parent-task-${parentTask.id}`,
        type: 'parent-task',
        task: parentTask,
        project: mockProject,
        subtasks,
        sectionId: 'today'
      }

      // Expected: 52 (base) + 5 * 38 (subtasks) + 40 (add input) = 282
      expect(estimateItemHeight(item, expandedIds, allTasks)).toBe(282)
    })

    it('should return 80 for empty-state with section variant', () => {
      const item: EmptyStateItem = {
        id: 'empty-section',
        type: 'empty-state',
        variant: 'section',
        sectionId: 'today'
      }

      expect(estimateItemHeight(item, emptyExpandedIds, [])).toBe(80)
    })

    it('should return 200 for empty-state with celebration variant', () => {
      const item: EmptyStateItem = {
        id: 'empty-celebration',
        type: 'empty-state',
        variant: 'celebration',
        message: 'All done!'
      }

      expect(estimateItemHeight(item, emptyExpandedIds, [])).toBe(200)
    })

    it('should return 40 for add-task-button', () => {
      const item: AddTaskButtonItem = {
        id: 'add-today',
        type: 'add-task-button',
        sectionId: 'today'
      }

      expect(estimateItemHeight(item, emptyExpandedIds, [])).toBe(40)
    })
  })

  // ==========================================================================
  // T117: FLATTEN BY DUE DATE
  // ==========================================================================

  describe('flattenTasksByDueDate (T117)', () => {
    const mockProject = createMockProject()
    const emptyExpandedIds = new Set<string>()

    beforeEach(() => {
      vi.mocked(getTopLevelTasks).mockImplementation((tasks: Task[]) =>
        tasks.filter((t) => t.parentId === null)
      )
      vi.mocked(hasSubtasks).mockImplementation((task: Task) => task.subtaskIds?.length > 0)
      vi.mocked(getSubtasks).mockImplementation((id: string, tasks: Task[]) =>
        tasks.filter((t) => t.parentId === id)
      )
    })

    it('should return empty array for empty tasks', () => {
      vi.mocked(groupTasksByDueDate).mockReturnValue({
        overdue: [],
        today: [],
        tomorrow: [],
        upcoming: [],
        later: [],
        noDueDate: []
      })

      const result = flattenTasksByDueDate([], [mockProject], emptyExpandedIds, [])
      expect(result).toEqual([])
    })

    it('should return VirtualItem[] array', () => {
      const task = createMockTask({ id: 'task-1' })
      vi.mocked(groupTasksByDueDate).mockReturnValue({
        overdue: [],
        today: [task],
        tomorrow: [],
        upcoming: [],
        later: [],
        noDueDate: []
      })

      const result = flattenTasksByDueDate([task], [mockProject], emptyExpandedIds, [task])
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBeGreaterThan(0)
    })

    it('should include section headers with correct urgency', () => {
      const overdueTask = createMockTask({ id: 'overdue-task' })
      const todayTask = createMockTask({ id: 'today-task' })

      vi.mocked(groupTasksByDueDate).mockReturnValue({
        overdue: [overdueTask],
        today: [todayTask],
        tomorrow: [],
        upcoming: [],
        later: [],
        noDueDate: []
      })

      const result = flattenTasksByDueDate(
        [overdueTask, todayTask],
        [mockProject],
        emptyExpandedIds,
        [overdueTask, todayTask]
      )

      const overdueHeader = result.find(
        (item) => item.type === 'section-header' && item.sectionKey === 'overdue'
      ) as SectionHeaderItem

      const todayHeader = result.find(
        (item) => item.type === 'section-header' && item.sectionKey === 'today'
      ) as SectionHeaderItem

      expect(overdueHeader).toBeDefined()
      expect(overdueHeader.urgency).toBe('critical')

      expect(todayHeader).toBeDefined()
      expect(todayHeader.urgency).toBe('high')
    })

    it('should group tasks in correct order: overdue, today, tomorrow, upcoming, later, noDueDate', () => {
      const tasks = {
        overdue: [createMockTask({ id: 'overdue-1' })],
        today: [createMockTask({ id: 'today-1' })],
        tomorrow: [createMockTask({ id: 'tomorrow-1' })],
        upcoming: [createMockTask({ id: 'upcoming-1' })],
        later: [createMockTask({ id: 'later-1' })],
        noDueDate: [createMockTask({ id: 'no-date-1' })]
      }

      vi.mocked(groupTasksByDueDate).mockReturnValue(tasks)

      const allTasks = Object.values(tasks).flat()
      const result = flattenTasksByDueDate(allTasks, [mockProject], emptyExpandedIds, allTasks)

      const headers = result
        .filter((item) => item.type === 'section-header')
        .map((item) => item.sectionKey)

      expect(headers).toEqual(['overdue', 'today', 'tomorrow', 'upcoming', 'later', 'noDueDate'])
    })

    it('should include add-task-button at end of each section', () => {
      const todayTask = createMockTask({ id: 'today-1' })
      vi.mocked(groupTasksByDueDate).mockReturnValue({
        overdue: [],
        today: [todayTask],
        tomorrow: [],
        upcoming: [],
        later: [],
        noDueDate: []
      })

      const result = flattenTasksByDueDate([todayTask], [mockProject], emptyExpandedIds, [
        todayTask
      ])

      const addButton = result.find((item) => item.type === 'add-task-button') as AddTaskButtonItem
      expect(addButton).toBeDefined()
      expect(addButton.sectionId).toBe('today')
    })

    it('should skip empty groups', () => {
      const todayTask = createMockTask({ id: 'today-1' })
      vi.mocked(groupTasksByDueDate).mockReturnValue({
        overdue: [],
        today: [todayTask],
        tomorrow: [],
        upcoming: [],
        later: [],
        noDueDate: []
      })

      const result = flattenTasksByDueDate([todayTask], [mockProject], emptyExpandedIds, [
        todayTask
      ])

      // Should only have today header, task, and add button
      const headers = result.filter((item) => item.type === 'section-header')
      expect(headers.length).toBe(1)
      expect(headers[0].sectionKey).toBe('today')
    })

    it('should handle parent tasks with subtasks as parent-task type', () => {
      const parentTask = createMockTask({
        id: 'parent-1',
        subtaskIds: ['sub-1']
      })
      const subtask = createMockTask({ id: 'sub-1', parentId: 'parent-1' })

      vi.mocked(groupTasksByDueDate).mockReturnValue({
        overdue: [],
        today: [parentTask],
        tomorrow: [],
        upcoming: [],
        later: [],
        noDueDate: []
      })

      const result = flattenTasksByDueDate([parentTask, subtask], [mockProject], emptyExpandedIds, [
        parentTask,
        subtask
      ])

      const parentItem = result.find((item) => item.type === 'parent-task') as ParentTaskItem
      expect(parentItem).toBeDefined()
      expect(parentItem.task.id).toBe('parent-1')
      expect(parentItem.subtasks).toHaveLength(1)
    })

    it('should handle regular tasks as task type', () => {
      const regularTask = createMockTask({ id: 'regular-1', subtaskIds: [] })

      vi.mocked(groupTasksByDueDate).mockReturnValue({
        overdue: [],
        today: [regularTask],
        tomorrow: [],
        upcoming: [],
        later: [],
        noDueDate: []
      })

      const result = flattenTasksByDueDate([regularTask], [mockProject], emptyExpandedIds, [
        regularTask
      ])

      const taskItem = result.find((item) => item.type === 'task') as TaskItem
      expect(taskItem).toBeDefined()
      expect(taskItem.task.id).toBe('regular-1')
    })

    it('should set isOverdue flag for overdue section', () => {
      const overdueTask = createMockTask({ id: 'overdue-1' })

      vi.mocked(groupTasksByDueDate).mockReturnValue({
        overdue: [overdueTask],
        today: [],
        tomorrow: [],
        upcoming: [],
        later: [],
        noDueDate: []
      })

      const result = flattenTasksByDueDate([overdueTask], [mockProject], emptyExpandedIds, [
        overdueTask
      ])

      const taskItem = result.find((item) => item.type === 'task') as TaskItem
      expect(taskItem).toBeDefined()
      expect(taskItem.isOverdue).toBe(true)
    })

    it('should not set isOverdue flag for non-overdue sections', () => {
      const todayTask = createMockTask({ id: 'today-1' })

      vi.mocked(groupTasksByDueDate).mockReturnValue({
        overdue: [],
        today: [todayTask],
        tomorrow: [],
        upcoming: [],
        later: [],
        noDueDate: []
      })

      const result = flattenTasksByDueDate([todayTask], [mockProject], emptyExpandedIds, [
        todayTask
      ])

      const taskItem = result.find((item) => item.type === 'task') as TaskItem
      expect(taskItem).toBeDefined()
      expect(taskItem.isOverdue).toBe(false)
    })

    it('should include project in task items', () => {
      const task = createMockTask({ id: 'task-1', projectId: 'project-1' })

      vi.mocked(groupTasksByDueDate).mockReturnValue({
        overdue: [],
        today: [task],
        tomorrow: [],
        upcoming: [],
        later: [],
        noDueDate: []
      })

      const result = flattenTasksByDueDate([task], [mockProject], emptyExpandedIds, [task])

      const taskItem = result.find((item) => item.type === 'task') as TaskItem
      expect(taskItem.project).toBeDefined()
      expect(taskItem.project.id).toBe('project-1')
    })

    it('should skip tasks without matching project', () => {
      const task = createMockTask({ id: 'task-1', projectId: 'unknown-project' })

      vi.mocked(groupTasksByDueDate).mockReturnValue({
        overdue: [],
        today: [task],
        tomorrow: [],
        upcoming: [],
        later: [],
        noDueDate: []
      })

      const result = flattenTasksByDueDate([task], [mockProject], emptyExpandedIds, [task])

      const taskItems = result.filter((item) => item.type === 'task' || item.type === 'parent-task')
      expect(taskItems).toHaveLength(0)
    })
  })

  // ==========================================================================
  // T118: FLATTEN TODAY VIEW
  // ==========================================================================

  describe('flattenTodayTasks (T118)', () => {
    const mockProject = createMockProject()
    const emptyExpandedIds = new Set<string>()

    beforeEach(() => {
      vi.mocked(getTopLevelTasks).mockImplementation((tasks: Task[]) =>
        tasks.filter((t) => t.parentId === null)
      )
      vi.mocked(hasSubtasks).mockImplementation((task: Task) => task.subtaskIds?.length > 0)
      vi.mocked(getSubtasks).mockImplementation((id: string, tasks: Task[]) =>
        tasks.filter((t) => t.parentId === id)
      )
    })

    it('should return single empty-state item when empty with celebration', () => {
      const todayData: TodayViewData = { overdue: [], today: [] }

      const result = flattenTodayTasks(todayData, [mockProject], emptyExpandedIds, [], true)

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('empty-state')
      expect((result[0] as EmptyStateItem).variant).toBe('celebration')
      expect((result[0] as EmptyStateItem).message).toBe('All clear for today!')
    })

    it('should return empty array when empty without celebration', () => {
      const todayData: TodayViewData = { overdue: [], today: [] }

      const result = flattenTodayTasks(todayData, [mockProject], emptyExpandedIds, [], false)

      expect(result).toHaveLength(0)
    })

    it('should include overdue section header when has overdue tasks', () => {
      const overdueTask = createMockTask({ id: 'overdue-1' })
      const todayData: TodayViewData = { overdue: [overdueTask], today: [] }

      const result = flattenTodayTasks(
        todayData,
        [mockProject],
        emptyExpandedIds,
        [overdueTask],
        false
      )

      const overdueHeader = result.find(
        (item) => item.type === 'section-header' && item.sectionKey === 'overdue'
      ) as SectionHeaderItem

      expect(overdueHeader).toBeDefined()
      expect(overdueHeader.label).toBe('OVERDUE')
    })

    it('should include today section header when has today tasks', () => {
      const todayTask = createMockTask({ id: 'today-1' })
      const todayData: TodayViewData = { overdue: [], today: [todayTask] }

      const result = flattenTodayTasks(
        todayData,
        [mockProject],
        emptyExpandedIds,
        [todayTask],
        false
      )

      const todayHeader = result.find(
        (item) => item.type === 'section-header' && item.sectionKey === 'today'
      ) as SectionHeaderItem

      expect(todayHeader).toBeDefined()
      expect(todayHeader.label).toBe('TODAY')
    })

    it('should always include today header even when only overdue tasks exist', () => {
      const overdueTask = createMockTask({ id: 'overdue-1' })
      const todayData: TodayViewData = { overdue: [overdueTask], today: [] }

      const result = flattenTodayTasks(
        todayData,
        [mockProject],
        emptyExpandedIds,
        [overdueTask],
        false
      )

      const todayHeader = result.find(
        (item) => item.type === 'section-header' && item.sectionKey === 'today'
      ) as SectionHeaderItem

      expect(todayHeader).toBeDefined()
    })

    it('should have critical urgency for overdue section', () => {
      const overdueTask = createMockTask({ id: 'overdue-1' })
      const todayData: TodayViewData = { overdue: [overdueTask], today: [] }

      const result = flattenTodayTasks(
        todayData,
        [mockProject],
        emptyExpandedIds,
        [overdueTask],
        false
      )

      const overdueHeader = result.find(
        (item) => item.type === 'section-header' && item.sectionKey === 'overdue'
      ) as SectionHeaderItem

      expect(overdueHeader.urgency).toBe('critical')
      expect(overdueHeader.accentColor).toBe('#ef4444')
    })

    it('should have high urgency for today section', () => {
      const todayTask = createMockTask({ id: 'today-1' })
      const todayData: TodayViewData = { overdue: [], today: [todayTask] }

      const result = flattenTodayTasks(
        todayData,
        [mockProject],
        emptyExpandedIds,
        [todayTask],
        false
      )

      const todayHeader = result.find(
        (item) => item.type === 'section-header' && item.sectionKey === 'today'
      ) as SectionHeaderItem

      expect(todayHeader.urgency).toBe('high')
      expect(todayHeader.accentColor).toBe('#3b82f6')
    })

    it('should handle parent tasks correctly in overdue section', () => {
      const parentTask = createMockTask({ id: 'parent-1', subtaskIds: ['sub-1'] })
      const subtask = createMockTask({ id: 'sub-1', parentId: 'parent-1' })
      const todayData: TodayViewData = { overdue: [parentTask, subtask], today: [] }

      const result = flattenTodayTasks(
        todayData,
        [mockProject],
        emptyExpandedIds,
        [parentTask, subtask],
        false
      )

      const parentItem = result.find((item) => item.type === 'parent-task') as ParentTaskItem
      expect(parentItem).toBeDefined()
      expect(parentItem.task.id).toBe('parent-1')
      expect(parentItem.isOverdue).toBe(true)
    })

    it('should handle parent tasks correctly in today section', () => {
      const parentTask = createMockTask({ id: 'parent-1', subtaskIds: ['sub-1'] })
      const subtask = createMockTask({ id: 'sub-1', parentId: 'parent-1' })
      const todayData: TodayViewData = { overdue: [], today: [parentTask, subtask] }

      const result = flattenTodayTasks(
        todayData,
        [mockProject],
        emptyExpandedIds,
        [parentTask, subtask],
        false
      )

      const parentItem = result.find((item) => item.type === 'parent-task') as ParentTaskItem
      expect(parentItem).toBeDefined()
      expect(parentItem.task.id).toBe('parent-1')
      expect(parentItem.isOverdue).toBeUndefined()
    })

    it('should include add-task-button at the end', () => {
      const todayTask = createMockTask({ id: 'today-1' })
      const todayData: TodayViewData = { overdue: [], today: [todayTask] }

      const result = flattenTodayTasks(
        todayData,
        [mockProject],
        emptyExpandedIds,
        [todayTask],
        false
      )

      const addButton = result[result.length - 1] as AddTaskButtonItem
      expect(addButton.type).toBe('add-task-button')
      expect(addButton.sectionId).toBe('today')
    })

    it('should include both overdue and today tasks with correct structure', () => {
      const overdueTask = createMockTask({ id: 'overdue-1' })
      const todayTask = createMockTask({ id: 'today-1' })
      const todayData: TodayViewData = { overdue: [overdueTask], today: [todayTask] }

      const result = flattenTodayTasks(
        todayData,
        [mockProject],
        emptyExpandedIds,
        [overdueTask, todayTask],
        false
      )

      const headers = result.filter((item) => item.type === 'section-header')
      expect(headers).toHaveLength(2)
      expect(headers[0].sectionKey).toBe('overdue')
      expect(headers[1].sectionKey).toBe('today')
    })

    it('should set isOverdue true for tasks in overdue section', () => {
      const overdueTask = createMockTask({ id: 'overdue-1' })
      const todayData: TodayViewData = { overdue: [overdueTask], today: [] }

      const result = flattenTodayTasks(
        todayData,
        [mockProject],
        emptyExpandedIds,
        [overdueTask],
        false
      )

      const taskItem = result.find((item) => item.type === 'task') as TaskItem
      expect(taskItem.isOverdue).toBe(true)
    })
  })

  // ==========================================================================
  // T119: FLATTEN BY STATUS
  // ==========================================================================

  describe('flattenTasksByStatus (T119)', () => {
    const mockProject = createMockProject({
      statuses: [
        createMockStatus({ id: 'status-todo', name: 'Todo', type: 'todo', order: 0 }),
        createMockStatus({
          id: 'status-in-progress',
          name: 'In Progress',
          type: 'in_progress',
          order: 1
        }),
        createMockStatus({ id: 'status-done', name: 'Done', type: 'done', order: 2 })
      ]
    })
    const emptyExpandedIds = new Set<string>()

    beforeEach(() => {
      vi.mocked(getTopLevelTasks).mockImplementation((tasks: Task[]) =>
        tasks.filter((t) => t.parentId === null)
      )
      vi.mocked(hasSubtasks).mockImplementation((task: Task) => task.subtaskIds?.length > 0)
      vi.mocked(getSubtasks).mockImplementation((id: string, tasks: Task[]) =>
        tasks.filter((t) => t.parentId === id)
      )
    })

    it('should return status headers for each project status', () => {
      const todoStatus = mockProject.statuses[0]
      const inProgressStatus = mockProject.statuses[1]
      const doneStatus = mockProject.statuses[2]

      const groupedTasks: TaskGroupByStatus[] = [
        { status: todoStatus, tasks: [] },
        { status: inProgressStatus, tasks: [] },
        { status: doneStatus, tasks: [] }
      ]

      vi.mocked(groupTasksByStatus).mockReturnValue(groupedTasks)

      const result = flattenTasksByStatus([], mockProject, emptyExpandedIds, [])

      const headers = result.filter((item) => item.type === 'status-header')
      expect(headers).toHaveLength(3)
      expect(headers[0].status.id).toBe('status-todo')
      expect(headers[1].status.id).toBe('status-in-progress')
      expect(headers[2].status.id).toBe('status-done')
    })

    it('should always show headers even for empty statuses (for drop targets)', () => {
      const todoStatus = mockProject.statuses[0]
      const inProgressStatus = mockProject.statuses[1]
      const doneStatus = mockProject.statuses[2]

      const groupedTasks: TaskGroupByStatus[] = [
        { status: todoStatus, tasks: [] },
        { status: inProgressStatus, tasks: [] },
        { status: doneStatus, tasks: [] }
      ]

      vi.mocked(groupTasksByStatus).mockReturnValue(groupedTasks)

      const result = flattenTasksByStatus([], mockProject, emptyExpandedIds, [])

      const headers = result.filter((item) => item.type === 'status-header')
      expect(headers).toHaveLength(3)
      headers.forEach((header) => {
        expect(header.count).toBe(0)
      })
    })

    it('should group tasks under correct status', () => {
      const todoTask = createMockTask({ id: 'todo-task', statusId: 'status-todo' })
      const inProgressTask = createMockTask({
        id: 'in-progress-task',
        statusId: 'status-in-progress'
      })

      const groupedTasks: TaskGroupByStatus[] = [
        { status: mockProject.statuses[0], tasks: [todoTask] },
        { status: mockProject.statuses[1], tasks: [inProgressTask] },
        { status: mockProject.statuses[2], tasks: [] }
      ]

      vi.mocked(groupTasksByStatus).mockReturnValue(groupedTasks)

      const allTasks = [todoTask, inProgressTask]
      const result = flattenTasksByStatus(allTasks, mockProject, emptyExpandedIds, allTasks)

      // Find tasks after each header
      const todoHeaderIndex = result.findIndex(
        (item) => item.type === 'status-header' && item.status.id === 'status-todo'
      )
      const todoTaskItem = result[todoHeaderIndex + 1] as TaskItem
      expect(todoTaskItem.type).toBe('task')
      expect(todoTaskItem.task.id).toBe('todo-task')
      expect(todoTaskItem.sectionId).toBe('status-todo')
    })

    it('should handle parent tasks with subtasks', () => {
      const parentTask = createMockTask({
        id: 'parent-1',
        statusId: 'status-todo',
        subtaskIds: ['sub-1']
      })
      const subtask = createMockTask({ id: 'sub-1', parentId: 'parent-1', statusId: 'status-todo' })

      const groupedTasks: TaskGroupByStatus[] = [
        { status: mockProject.statuses[0], tasks: [parentTask] },
        { status: mockProject.statuses[1], tasks: [] },
        { status: mockProject.statuses[2], tasks: [] }
      ]

      vi.mocked(groupTasksByStatus).mockReturnValue(groupedTasks)

      const allTasks = [parentTask, subtask]
      const result = flattenTasksByStatus(allTasks, mockProject, emptyExpandedIds, allTasks)

      const parentItem = result.find((item) => item.type === 'parent-task') as ParentTaskItem
      expect(parentItem).toBeDefined()
      expect(parentItem.task.id).toBe('parent-1')
      expect(parentItem.subtasks).toHaveLength(1)
      expect(parentItem.sectionId).toBe('status-todo')
    })

    it('should include project in task items', () => {
      const task = createMockTask({ id: 'task-1', statusId: 'status-todo' })

      const groupedTasks: TaskGroupByStatus[] = [
        { status: mockProject.statuses[0], tasks: [task] },
        { status: mockProject.statuses[1], tasks: [] },
        { status: mockProject.statuses[2], tasks: [] }
      ]

      vi.mocked(groupTasksByStatus).mockReturnValue(groupedTasks)

      const result = flattenTasksByStatus([task], mockProject, emptyExpandedIds, [task])

      const taskItem = result.find((item) => item.type === 'task') as TaskItem
      expect(taskItem.project).toBe(mockProject)
    })

    it('should have correct count in status headers', () => {
      const task1 = createMockTask({ id: 'task-1', statusId: 'status-todo' })
      const task2 = createMockTask({ id: 'task-2', statusId: 'status-todo' })
      const task3 = createMockTask({ id: 'task-3', statusId: 'status-in-progress' })

      const groupedTasks: TaskGroupByStatus[] = [
        { status: mockProject.statuses[0], tasks: [task1, task2] },
        { status: mockProject.statuses[1], tasks: [task3] },
        { status: mockProject.statuses[2], tasks: [] }
      ]

      vi.mocked(groupTasksByStatus).mockReturnValue(groupedTasks)

      const allTasks = [task1, task2, task3]
      const result = flattenTasksByStatus(allTasks, mockProject, emptyExpandedIds, allTasks)

      const headers = result.filter((item) => item.type === 'status-header')
      expect(headers[0].count).toBe(2) // todo
      expect(headers[1].count).toBe(1) // in-progress
      expect(headers[2].count).toBe(0) // done
    })
  })

  // ==========================================================================
  // T120: HELPER UTILITIES
  // ==========================================================================

  describe('getTaskIdsFromVirtualItems (T120)', () => {
    const mockProject = createMockProject()

    it('should extract IDs from task items', () => {
      const task1 = createMockTask({ id: 'task-1' })
      const task2 = createMockTask({ id: 'task-2' })

      const items: VirtualItem[] = [
        { id: 'task-task-1', type: 'task', task: task1, project: mockProject, sectionId: 'today' },
        { id: 'task-task-2', type: 'task', task: task2, project: mockProject, sectionId: 'today' }
      ]

      const result = getTaskIdsFromVirtualItems(items)
      expect(result).toEqual(['task-1', 'task-2'])
    })

    it('should extract IDs from parent-task items', () => {
      const parentTask = createMockTask({ id: 'parent-1', subtaskIds: ['sub-1'] })
      const subtask = createMockTask({ id: 'sub-1', parentId: 'parent-1' })

      const items: VirtualItem[] = [
        {
          id: 'parent-task-parent-1',
          type: 'parent-task',
          task: parentTask,
          project: mockProject,
          subtasks: [subtask],
          sectionId: 'today'
        }
      ]

      const result = getTaskIdsFromVirtualItems(items)
      expect(result).toEqual(['parent-1'])
    })

    it('should ignore section headers', () => {
      const task = createMockTask({ id: 'task-1' })

      const items: VirtualItem[] = [
        {
          id: 'header-today',
          type: 'section-header',
          sectionKey: 'today',
          label: 'TODAY',
          count: 1,
          urgency: 'high' as UrgencyLevel
        },
        { id: 'task-task-1', type: 'task', task, project: mockProject, sectionId: 'today' }
      ]

      const result = getTaskIdsFromVirtualItems(items)
      expect(result).toEqual(['task-1'])
    })

    it('should ignore status headers', () => {
      const task = createMockTask({ id: 'task-1' })

      const items: VirtualItem[] = [
        {
          id: 'status-header-todo',
          type: 'status-header',
          status: createMockStatus(),
          count: 1
        },
        { id: 'task-task-1', type: 'task', task, project: mockProject, sectionId: 'today' }
      ]

      const result = getTaskIdsFromVirtualItems(items)
      expect(result).toEqual(['task-1'])
    })

    it('should ignore empty states', () => {
      const task = createMockTask({ id: 'task-1' })

      const items: VirtualItem[] = [
        { id: 'empty-celebration', type: 'empty-state', variant: 'celebration' },
        { id: 'task-task-1', type: 'task', task, project: mockProject, sectionId: 'today' }
      ]

      const result = getTaskIdsFromVirtualItems(items)
      expect(result).toEqual(['task-1'])
    })

    it('should ignore add-task-buttons', () => {
      const task = createMockTask({ id: 'task-1' })

      const items: VirtualItem[] = [
        { id: 'task-task-1', type: 'task', task, project: mockProject, sectionId: 'today' },
        { id: 'add-today', type: 'add-task-button', sectionId: 'today' }
      ]

      const result = getTaskIdsFromVirtualItems(items)
      expect(result).toEqual(['task-1'])
    })

    it('should return empty array for items with only headers and buttons', () => {
      const items: VirtualItem[] = [
        {
          id: 'header-today',
          type: 'section-header',
          sectionKey: 'today',
          label: 'TODAY',
          count: 0,
          urgency: 'high' as UrgencyLevel
        },
        { id: 'add-today', type: 'add-task-button', sectionId: 'today' }
      ]

      const result = getTaskIdsFromVirtualItems(items)
      expect(result).toEqual([])
    })

    it('should return empty array for empty items array', () => {
      const result = getTaskIdsFromVirtualItems([])
      expect(result).toEqual([])
    })

    it('should handle mixed items correctly', () => {
      const task1 = createMockTask({ id: 'task-1' })
      const parentTask = createMockTask({ id: 'parent-1', subtaskIds: ['sub-1'] })
      const subtask = createMockTask({ id: 'sub-1', parentId: 'parent-1' })

      const items: VirtualItem[] = [
        {
          id: 'header-today',
          type: 'section-header',
          sectionKey: 'today',
          label: 'TODAY',
          count: 2,
          urgency: 'high' as UrgencyLevel
        },
        { id: 'task-task-1', type: 'task', task: task1, project: mockProject, sectionId: 'today' },
        {
          id: 'parent-task-parent-1',
          type: 'parent-task',
          task: parentTask,
          project: mockProject,
          subtasks: [subtask],
          sectionId: 'today'
        },
        { id: 'empty-section', type: 'empty-state', variant: 'section', sectionId: 'tomorrow' },
        { id: 'add-today', type: 'add-task-button', sectionId: 'today' }
      ]

      const result = getTaskIdsFromVirtualItems(items)
      expect(result).toEqual(['task-1', 'parent-1'])
    })

    it('should preserve order of task IDs', () => {
      const tasks = Array.from({ length: 5 }, (_, i) => createMockTask({ id: `task-${i + 1}` }))

      const items: VirtualItem[] = tasks.map((task) => ({
        id: `task-${task.id}`,
        type: 'task' as const,
        task,
        project: mockProject,
        sectionId: 'today'
      }))

      const result = getTaskIdsFromVirtualItems(items)
      expect(result).toEqual(['task-1', 'task-2', 'task-3', 'task-4', 'task-5'])
    })
  })

  // ==========================================================================
  // WEEK ACCORDION IN TODAY VIEW
  // ==========================================================================

  describe('flattenTodayTasks with weekByDay', () => {
    const mockProject = createMockProject()

    beforeEach(() => {
      vi.mocked(getTopLevelTasks).mockImplementation((tasks: Task[]) =>
        tasks.filter((t) => t.parentId === null)
      )
      vi.mocked(hasSubtasks).mockImplementation((task: Task) => task.subtaskIds?.length > 0)
      vi.mocked(getSubtasks).mockImplementation((id: string, tasks: Task[]) =>
        tasks.filter((t) => t.parentId === id)
      )
    })

    it('should emit week-accordion-header when weekByDay is provided', () => {
      const weekByDay = new Map<string, Task[]>()
      weekByDay.set('2026-03-06', [createMockTask({ id: 'week-1' })])
      weekByDay.set('2026-03-07', [])

      const todayData: TodayViewData = { overdue: [], today: [], weekByDay }
      const items = flattenTodayTasks(
        todayData,
        [mockProject],
        new Set(),
        [],
        true,
        new Set(),
        true
      )

      const weekHeader = items.find(
        (i) => i.type === 'week-accordion-header'
      ) as WeekAccordionHeaderItem
      expect(weekHeader).toBeDefined()
      expect(weekHeader.totalCount).toBe(1)
    })

    it('should hide day items when this-week is collapsed', () => {
      const weekByDay = new Map<string, Task[]>()
      weekByDay.set('2026-03-06', [createMockTask({ id: 'week-1' })])

      const todayData: TodayViewData = { overdue: [], today: [], weekByDay }
      const collapsed = new Set(['this-week'])
      const items = flattenTodayTasks(
        todayData,
        [mockProject],
        new Set(),
        [],
        true,
        collapsed,
        true
      )

      const dayHeaders = items.filter((i) => i.type === 'day-header')
      expect(dayHeaders).toHaveLength(0)
    })

    it('should use dateKey as sectionId for week tasks', () => {
      const weekByDay = new Map<string, Task[]>()
      weekByDay.set('2026-03-06', [createMockTask({ id: 'week-1' })])

      const todayData: TodayViewData = { overdue: [], today: [], weekByDay }
      const items = flattenTodayTasks(
        todayData,
        [mockProject],
        new Set(),
        [],
        true,
        new Set(),
        true
      )

      const taskItems = items.filter((i) => i.type === 'task') as TaskItem[]
      const weekTask = taskItems.find((t) => t.task.id === 'week-1')
      expect(weekTask?.sectionId).toBe('2026-03-06')
    })

    it('should skip empty days when showEmptyDays is false', () => {
      const weekByDay = new Map<string, Task[]>()
      weekByDay.set('2026-03-06', [createMockTask({ id: 'week-1' })])
      weekByDay.set('2026-03-07', [])

      const todayData: TodayViewData = { overdue: [], today: [], weekByDay }
      const items = flattenTodayTasks(
        todayData,
        [mockProject],
        new Set(),
        [],
        true,
        new Set(),
        false
      )

      const dayHeaders = items.filter((i) => i.type === 'day-header') as DayHeaderItem[]
      expect(dayHeaders).toHaveLength(1)
      expect(dayHeaders[0].dateKey).toBe('2026-03-06')
    })
  })
})
