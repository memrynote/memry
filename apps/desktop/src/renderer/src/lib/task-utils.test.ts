/**
 * Task Utils Tests (T072-T076, T084-T089)
 *
 * This file contains tests for:
 * - T072: Date Helpers - Basic (startOfDay, addDays, subDays, isSameDay, isBefore, isAfter)
 * - T073: Date Helpers - Intervals (isWithinInterval, differenceInDays + edge cases)
 * - T074: Date Helpers - Week/Month (startOfWeek, endOfWeek, startOfMonth, endOfMonth, addWeeks, addMonths, subMonths, isSameMonth, nextSaturday, nextMonday, endOfDay)
 * - T075: Date Formatting (formatTime, formatDateShort, formatDayName, formatDueDate)
 * - T076: Task Status Helpers (isTaskCompleted, getDefaultTodoStatus, getDefaultDoneStatus)
 * - T084: Task Filtering - Main Filter Function (getFilteredTasks)
 * - T085: Task Counts & Formatting (getTaskCounts, formatTaskSubtitle)
 * - T086: Today & Upcoming View Helpers (getTodayTasks, getUpcomingTasks, getDayHeaderText)
 * - T087: Completed Tasks & Archive (getCompletedTasks, getArchivedTasks, groupCompletedByPeriod, groupArchivedByMonth)
 * - T088: Completion Statistics (getCompletionStats, calculateStreak, filterCompletedBySearch, getTasksOlderThan)
 * - T089: Advanced Filters & Composition (applyFiltersAndSort, hasActiveFilters, countActiveFilters, group configs)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project, Status, StatusType, TaskFilters, TaskSort } from '@/data/tasks-data'
import {
  // Date Helpers - Basic (T072)
  startOfDay,
  addDays,
  subDays,
  isSameDay,
  isBefore,
  isAfter,
  // Date Helpers - Intervals (T073)
  isWithinInterval,
  differenceInDays,
  // Date Helpers - Week/Month (T074)
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  addWeeks,
  addMonths,
  subMonths,
  isSameMonth,
  nextSaturday,
  nextMonday,
  endOfDay,
  // Date Formatting (T075)
  formatTime,
  formatDateShort,
  formatDayName,
  formatDueDate,
  // Task Status Helpers (T076)
  isTaskCompleted,
  getDefaultTodoStatus,
  getDefaultDoneStatus,
  // Task Sorting (T077-T078)
  sortTasksByPriorityAndDate,
  sortTasksForDay,
  sortTasksByTimeAndPriority,
  sortOverdueTasks,
  sortTasksAdvanced,
  // Task Grouping (T079-T080)
  groupTasksByDueDate,
  groupTasksByStatus,
  groupTasksByCompletion,
  // Calendar Helpers (T081)
  formatDateKey,
  parseDateKey,
  getCalendarDays,
  groupTasksByCalendarDate,
  // Task Filtering - Basic (T082)
  filterBySearch,
  filterByProjects,
  scopeTasksByProject,
  filterByPriorities,
  filterByStatuses,
  // Task Filtering - Date & Completion (T083)
  filterByDueDateRange,
  filterByCompletion,
  filterByRepeatType,
  filterByHasTime,
  // Task Filtering (T084)
  getFilteredTasks,
  // Task Counts (T085)
  getTaskCounts,
  formatTaskSubtitle,
  // Today & Upcoming View Helpers (T086)
  getTodayTasks,
  getTodayWithWeekTasks,
  formatDateKey,
  getUpcomingTasks,
  getDayHeaderText,
  // Completed Tasks & Archive (T087)
  getCompletedTasks,
  getArchivedTasks,
  groupCompletedByPeriod,
  groupArchivedByMonth,
  // Completion Statistics (T088)
  getCompletionStats,
  calculateStreak,
  filterCompletedBySearch,
  getTasksOlderThan,
  // Advanced Filters & Composition (T089)
  applyFiltersAndSort,
  hasActiveFilters,
  countActiveFilters,
  dueDateGroupConfig,
  completionGroupConfig,
  completionPeriodConfig
} from './task-utils'

// ============================================================================
// MOCK FACTORIES
// ============================================================================

/**
 * Factory to create mock Task objects with sensible defaults
 */
const createMockTask = (overrides: Partial<Task> = {}): Task => ({
  id: `task-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
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
  createdAt: new Date('2026-01-01T10:00:00Z'),
  completedAt: null,
  archivedAt: null,
  ...overrides
})

/**
 * Factory to create mock Status objects with sensible defaults
 */
const createMockStatus = (overrides: Partial<Status> = {}): Status => ({
  id: `status-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
  name: 'To Do',
  color: '#6b7280',
  type: 'todo' as StatusType,
  order: 0,
  ...overrides
})

/**
 * Factory to create mock Project objects with sensible defaults
 */
const createMockProject = (overrides: Partial<Project> = {}): Project => ({
  id: `project-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
  name: 'Test Project',
  description: '',
  icon: 'Folder',
  color: '#6366f1',
  statuses: [
    createMockStatus({ id: 'status-todo', name: 'To Do', type: 'todo', order: 0 }),
    createMockStatus({
      id: 'status-in-progress',
      name: 'In Progress',
      type: 'in_progress',
      order: 1
    }),
    createMockStatus({ id: 'status-done', name: 'Done', type: 'done', order: 2 })
  ],
  isDefault: false,
  isArchived: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  taskCount: 0,
  ...overrides
})

/**
 * Factory to create default TaskFilters object
 */
const createDefaultFilters = (): TaskFilters => ({
  search: '',
  projectIds: [],
  priorities: [],
  dueDate: { type: 'any', customStart: null, customEnd: null },
  statusIds: [],
  completion: 'active',
  repeatType: 'all',
  hasTime: 'all'
})

/**
 * Factory to create default TaskSort object
 */
const createDefaultSort = (): TaskSort => ({
  field: 'dueDate',
  direction: 'asc'
})

// ============================================================================
// TEST SETUP
// ============================================================================

describe('Task Utils', () => {
  // Set up fake timers for deterministic date tests
  beforeEach(() => {
    vi.useFakeTimers()
    // Wednesday, January 14, 2026, 10:30:00 UTC
    vi.setSystemTime(new Date('2026-01-14T10:30:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ============================================================================
  // T072: DATE HELPERS - BASIC
  // ============================================================================

  describe('T072: Date Helpers - Basic', () => {
    describe('startOfDay', () => {
      it('should set time to midnight (00:00:00.000)', () => {
        const date = new Date('2026-01-14T15:45:30.123Z')
        const result = startOfDay(date)

        expect(result.getHours()).toBe(0)
        expect(result.getMinutes()).toBe(0)
        expect(result.getSeconds()).toBe(0)
        expect(result.getMilliseconds()).toBe(0)
      })

      it('should preserve year, month, and day', () => {
        // Use local time constructor to avoid timezone issues
        const date = new Date(2026, 2, 25, 23, 59, 59, 999) // March 25, 2026, 23:59:59.999
        const result = startOfDay(date)

        expect(result.getFullYear()).toBe(2026)
        expect(result.getMonth()).toBe(2) // March (0-indexed)
        expect(result.getDate()).toBe(25)
      })

      it('should not mutate original date', () => {
        const original = new Date('2026-01-14T15:00:00Z')
        const originalTime = original.getTime()
        startOfDay(original)

        expect(original.getTime()).toBe(originalTime)
      })

      it('should handle date already at midnight', () => {
        const date = new Date('2026-01-14T00:00:00.000Z')
        const result = startOfDay(date)

        expect(result.getHours()).toBe(0)
        expect(result.getMinutes()).toBe(0)
        expect(result.getSeconds()).toBe(0)
        expect(result.getMilliseconds()).toBe(0)
      })

      it('should handle edge case: end of year', () => {
        // Use local time constructor to avoid timezone issues
        const date = new Date(2026, 11, 31, 23, 59, 59, 999) // December 31, 2026, 23:59:59.999
        const result = startOfDay(date)

        expect(result.getFullYear()).toBe(2026)
        expect(result.getMonth()).toBe(11) // December
        expect(result.getDate()).toBe(31)
        expect(result.getHours()).toBe(0)
      })
    })

    describe('addDays', () => {
      it('should add positive days correctly', () => {
        const date = new Date('2026-01-14T10:00:00Z')
        const result = addDays(date, 5)

        expect(result.getDate()).toBe(19)
        expect(result.getMonth()).toBe(0) // January
      })

      it('should handle month boundary crossing', () => {
        const date = new Date('2026-01-28T10:00:00Z')
        const result = addDays(date, 5)

        expect(result.getDate()).toBe(2)
        expect(result.getMonth()).toBe(1) // February
      })

      it('should handle year boundary crossing', () => {
        const date = new Date('2026-12-30T10:00:00Z')
        const result = addDays(date, 5)

        expect(result.getDate()).toBe(4)
        expect(result.getMonth()).toBe(0) // January
        expect(result.getFullYear()).toBe(2027)
      })

      it('should handle adding zero days', () => {
        const date = new Date('2026-01-14T10:00:00Z')
        const result = addDays(date, 0)

        expect(result.getTime()).toBe(date.getTime())
      })

      it('should handle adding negative days (subtraction)', () => {
        const date = new Date('2026-01-14T10:00:00Z')
        const result = addDays(date, -3)

        expect(result.getDate()).toBe(11)
      })

      it('should not mutate original date', () => {
        const original = new Date('2026-01-14T10:00:00Z')
        const originalTime = original.getTime()
        addDays(original, 5)

        expect(original.getTime()).toBe(originalTime)
      })

      it('should handle leap year February', () => {
        // 2028 is a leap year
        const date = new Date('2028-02-28T10:00:00Z')
        const result = addDays(date, 1)

        expect(result.getDate()).toBe(29)
        expect(result.getMonth()).toBe(1) // February
      })
    })

    describe('subDays', () => {
      it('should subtract positive days correctly', () => {
        const date = new Date('2026-01-14T10:00:00Z')
        const result = subDays(date, 5)

        expect(result.getDate()).toBe(9)
      })

      it('should handle month boundary crossing backwards', () => {
        const date = new Date('2026-02-03T10:00:00Z')
        const result = subDays(date, 5)

        expect(result.getDate()).toBe(29)
        expect(result.getMonth()).toBe(0) // January
      })

      it('should handle year boundary crossing backwards', () => {
        const date = new Date('2026-01-03T10:00:00Z')
        const result = subDays(date, 5)

        expect(result.getDate()).toBe(29)
        expect(result.getMonth()).toBe(11) // December
        expect(result.getFullYear()).toBe(2025)
      })

      it('should handle subtracting zero days', () => {
        const date = new Date('2026-01-14T10:00:00Z')
        const result = subDays(date, 0)

        expect(result.getTime()).toBe(date.getTime())
      })
    })

    describe('isSameDay', () => {
      it('should return true for same date different times', () => {
        // Use local time constructor to avoid timezone issues
        const date1 = new Date(2026, 0, 14, 8, 0, 0) // January 14, 2026, 08:00
        const date2 = new Date(2026, 0, 14, 23, 59, 59) // January 14, 2026, 23:59:59

        expect(isSameDay(date1, date2)).toBe(true)
      })

      it('should return true for identical dates', () => {
        const date1 = new Date('2026-01-14T10:30:00Z')
        const date2 = new Date('2026-01-14T10:30:00Z')

        expect(isSameDay(date1, date2)).toBe(true)
      })

      it('should return false for different days', () => {
        const date1 = new Date('2026-01-14T10:00:00Z')
        const date2 = new Date('2026-01-15T10:00:00Z')

        expect(isSameDay(date1, date2)).toBe(false)
      })

      it('should return false for different months same day number', () => {
        const date1 = new Date('2026-01-14T10:00:00Z')
        const date2 = new Date('2026-02-14T10:00:00Z')

        expect(isSameDay(date1, date2)).toBe(false)
      })

      it('should return false for different years same month and day', () => {
        const date1 = new Date('2026-01-14T10:00:00Z')
        const date2 = new Date('2027-01-14T10:00:00Z')

        expect(isSameDay(date1, date2)).toBe(false)
      })
    })

    describe('isBefore', () => {
      it('should return true when date1 is before date2', () => {
        const date1 = new Date('2026-01-13T10:00:00Z')
        const date2 = new Date('2026-01-14T10:00:00Z')

        expect(isBefore(date1, date2)).toBe(true)
      })

      it('should return false when date1 is after date2', () => {
        const date1 = new Date('2026-01-15T10:00:00Z')
        const date2 = new Date('2026-01-14T10:00:00Z')

        expect(isBefore(date1, date2)).toBe(false)
      })

      it('should return false when dates are equal', () => {
        const date1 = new Date('2026-01-14T10:00:00Z')
        const date2 = new Date('2026-01-14T10:00:00Z')

        expect(isBefore(date1, date2)).toBe(false)
      })

      it('should compare by milliseconds, not just date', () => {
        const date1 = new Date('2026-01-14T10:00:00.000Z')
        const date2 = new Date('2026-01-14T10:00:00.001Z')

        expect(isBefore(date1, date2)).toBe(true)
      })
    })

    describe('isAfter', () => {
      it('should return true when date1 is after date2', () => {
        const date1 = new Date('2026-01-15T10:00:00Z')
        const date2 = new Date('2026-01-14T10:00:00Z')

        expect(isAfter(date1, date2)).toBe(true)
      })

      it('should return false when date1 is before date2', () => {
        const date1 = new Date('2026-01-13T10:00:00Z')
        const date2 = new Date('2026-01-14T10:00:00Z')

        expect(isAfter(date1, date2)).toBe(false)
      })

      it('should return false when dates are equal', () => {
        const date1 = new Date('2026-01-14T10:00:00Z')
        const date2 = new Date('2026-01-14T10:00:00Z')

        expect(isAfter(date1, date2)).toBe(false)
      })

      it('should compare by milliseconds, not just date', () => {
        const date1 = new Date('2026-01-14T10:00:00.001Z')
        const date2 = new Date('2026-01-14T10:00:00.000Z')

        expect(isAfter(date1, date2)).toBe(true)
      })
    })
  })

  // ============================================================================
  // T073: DATE HELPERS - INTERVALS
  // ============================================================================

  describe('T073: Date Helpers - Intervals', () => {
    describe('isWithinInterval', () => {
      it('should return true when date is within interval (exclusive of boundaries)', () => {
        const date = new Date('2026-01-14T10:00:00Z')
        const start = new Date('2026-01-10T00:00:00Z')
        const end = new Date('2026-01-20T23:59:59Z')

        expect(isWithinInterval(date, { start, end })).toBe(true)
      })

      it('should return true when date equals start boundary (inclusive)', () => {
        const date = new Date('2026-01-10T00:00:00Z')
        const start = new Date('2026-01-10T00:00:00Z')
        const end = new Date('2026-01-20T23:59:59Z')

        expect(isWithinInterval(date, { start, end })).toBe(true)
      })

      it('should return true when date equals end boundary (inclusive)', () => {
        const date = new Date('2026-01-20T23:59:59Z')
        const start = new Date('2026-01-10T00:00:00Z')
        const end = new Date('2026-01-20T23:59:59Z')

        expect(isWithinInterval(date, { start, end })).toBe(true)
      })

      it('should return false when date is before interval', () => {
        const date = new Date('2026-01-05T10:00:00Z')
        const start = new Date('2026-01-10T00:00:00Z')
        const end = new Date('2026-01-20T23:59:59Z')

        expect(isWithinInterval(date, { start, end })).toBe(false)
      })

      it('should return false when date is after interval', () => {
        const date = new Date('2026-01-25T10:00:00Z')
        const start = new Date('2026-01-10T00:00:00Z')
        const end = new Date('2026-01-20T23:59:59Z')

        expect(isWithinInterval(date, { start, end })).toBe(false)
      })

      it('should handle single-day interval', () => {
        const date = new Date('2026-01-14T12:00:00Z')
        const start = new Date('2026-01-14T00:00:00Z')
        const end = new Date('2026-01-14T23:59:59Z')

        expect(isWithinInterval(date, { start, end })).toBe(true)
      })

      it('should handle interval spanning months', () => {
        const date = new Date('2026-02-05T10:00:00Z')
        const start = new Date('2026-01-25T00:00:00Z')
        const end = new Date('2026-02-10T23:59:59Z')

        expect(isWithinInterval(date, { start, end })).toBe(true)
      })

      it('should handle interval spanning years', () => {
        const date = new Date('2027-01-02T10:00:00Z')
        const start = new Date('2026-12-28T00:00:00Z')
        const end = new Date('2027-01-05T23:59:59Z')

        expect(isWithinInterval(date, { start, end })).toBe(true)
      })
    })

    describe('differenceInDays', () => {
      it('should return positive difference when date1 is after date2', () => {
        const date1 = new Date('2026-01-20T10:00:00Z')
        const date2 = new Date('2026-01-14T10:00:00Z')

        expect(differenceInDays(date1, date2)).toBe(6)
      })

      it('should return negative difference when date1 is before date2', () => {
        const date1 = new Date('2026-01-10T10:00:00Z')
        const date2 = new Date('2026-01-14T10:00:00Z')

        expect(differenceInDays(date1, date2)).toBe(-4)
      })

      it('should return zero for same day when date1 is after date2', () => {
        // Use local time constructor to avoid timezone issues
        // Note: differenceInDays returns floor((date1 - date2) / 24h)
        // When date1 is AFTER date2 on the same day, diff is positive fraction -> floors to 0
        const date1 = new Date(2026, 0, 14, 20, 0, 0) // January 14, 2026, 20:00
        const date2 = new Date(2026, 0, 14, 8, 0, 0) // January 14, 2026, 08:00

        expect(differenceInDays(date1, date2)).toBe(0)
      })

      it('should return -1 for same day when date1 is before date2', () => {
        // When date1 is BEFORE date2 on the same day, diff is negative fraction -> floors to -1
        const date1 = new Date(2026, 0, 14, 8, 0, 0) // January 14, 2026, 08:00
        const date2 = new Date(2026, 0, 14, 20, 0, 0) // January 14, 2026, 20:00

        expect(differenceInDays(date1, date2)).toBe(-1)
      })

      it('should floor the result (not round)', () => {
        // Less than 24 hours apart but different calendar days
        const date1 = new Date('2026-01-15T02:00:00Z')
        const date2 = new Date('2026-01-14T22:00:00Z')

        // Only 4 hours difference, which is 0 when floored
        expect(differenceInDays(date1, date2)).toBe(0)
      })

      it('should handle month boundaries', () => {
        const date1 = new Date('2026-02-05T10:00:00Z')
        const date2 = new Date('2026-01-28T10:00:00Z')

        expect(differenceInDays(date1, date2)).toBe(8)
      })

      it('should handle year boundaries', () => {
        const date1 = new Date('2027-01-03T10:00:00Z')
        const date2 = new Date('2026-12-28T10:00:00Z')

        expect(differenceInDays(date1, date2)).toBe(6)
      })

      it('should handle large differences', () => {
        const date1 = new Date('2027-01-14T10:00:00Z')
        const date2 = new Date('2026-01-14T10:00:00Z')

        expect(differenceInDays(date1, date2)).toBe(365)
      })

      it('should handle leap year correctly', () => {
        // 2028 is a leap year
        const date1 = new Date('2028-03-01T10:00:00Z')
        const date2 = new Date('2028-02-28T10:00:00Z')

        expect(differenceInDays(date1, date2)).toBe(2) // Feb 28 -> Feb 29 -> Mar 1
      })
    })
  })

  // ============================================================================
  // T074: DATE HELPERS - WEEK/MONTH
  // ============================================================================

  describe('T074: Date Helpers - Week/Month', () => {
    describe('startOfWeek', () => {
      it('should return Sunday when weekStartsOn is 0 (default)', () => {
        // January 14, 2026 is a Wednesday
        const date = new Date('2026-01-14T10:00:00Z')
        const result = startOfWeek(date)

        // Should be Sunday, January 11, 2026
        expect(result.getDay()).toBe(0) // Sunday
        expect(result.getDate()).toBe(11)
      })

      it('should return Monday when weekStartsOn is 1', () => {
        // January 14, 2026 is a Wednesday
        const date = new Date('2026-01-14T10:00:00Z')
        const result = startOfWeek(date, 1)

        // Should be Monday, January 12, 2026
        expect(result.getDay()).toBe(1) // Monday
        expect(result.getDate()).toBe(12)
      })

      it('should return same day if date is already start of week', () => {
        // January 11, 2026 is a Sunday
        const date = new Date('2026-01-11T10:00:00Z')
        const result = startOfWeek(date, 0)

        expect(result.getDate()).toBe(11)
        expect(result.getDay()).toBe(0)
      })

      it('should set time to midnight', () => {
        const date = new Date('2026-01-14T15:30:45Z')
        const result = startOfWeek(date)

        expect(result.getHours()).toBe(0)
        expect(result.getMinutes()).toBe(0)
        expect(result.getSeconds()).toBe(0)
      })

      it('should handle week crossing month boundary', () => {
        // February 2, 2026 is a Monday
        const date = new Date('2026-02-02T10:00:00Z')
        const result = startOfWeek(date, 0) // Sunday start

        // Should be Sunday, February 1, 2026
        expect(result.getDate()).toBe(1)
        expect(result.getMonth()).toBe(1) // February
      })
    })

    describe('endOfWeek', () => {
      it('should return Saturday when weekStartsOn is 0 (default)', () => {
        // January 14, 2026 is a Wednesday
        const date = new Date('2026-01-14T10:00:00Z')
        const result = endOfWeek(date)

        // Should be Saturday, January 17, 2026
        expect(result.getDay()).toBe(6) // Saturday
        expect(result.getDate()).toBe(17)
      })

      it('should return Sunday when weekStartsOn is 1', () => {
        // January 14, 2026 is a Wednesday
        const date = new Date('2026-01-14T10:00:00Z')
        const result = endOfWeek(date, 1)

        // Should be Sunday, January 18, 2026
        expect(result.getDay()).toBe(0) // Sunday
        expect(result.getDate()).toBe(18)
      })

      it('should handle week crossing month boundary', () => {
        // January 28, 2026 is a Wednesday
        const date = new Date('2026-01-28T10:00:00Z')
        const result = endOfWeek(date, 0)

        // Should be Saturday, January 31, 2026
        expect(result.getDate()).toBe(31)
        expect(result.getMonth()).toBe(0) // January
      })
    })

    describe('startOfMonth', () => {
      it('should return first day of month at midnight', () => {
        const date = new Date('2026-01-14T15:30:00Z')
        const result = startOfMonth(date)

        expect(result.getDate()).toBe(1)
        expect(result.getMonth()).toBe(0) // January
        expect(result.getHours()).toBe(0)
        expect(result.getMinutes()).toBe(0)
      })

      it('should preserve year and month', () => {
        const date = new Date('2026-06-20T10:00:00Z')
        const result = startOfMonth(date)

        expect(result.getFullYear()).toBe(2026)
        expect(result.getMonth()).toBe(5) // June
        expect(result.getDate()).toBe(1)
      })

      it('should handle date already on first day', () => {
        const date = new Date('2026-03-01T10:00:00Z')
        const result = startOfMonth(date)

        expect(result.getDate()).toBe(1)
        expect(result.getMonth()).toBe(2) // March
      })
    })

    describe('endOfMonth', () => {
      it('should return last day of month', () => {
        const date = new Date('2026-01-14T10:00:00Z')
        const result = endOfMonth(date)

        expect(result.getDate()).toBe(31)
        expect(result.getMonth()).toBe(0) // January
      })

      it('should handle February in non-leap year', () => {
        const date = new Date('2026-02-10T10:00:00Z')
        const result = endOfMonth(date)

        expect(result.getDate()).toBe(28)
        expect(result.getMonth()).toBe(1) // February
      })

      it('should handle February in leap year', () => {
        // 2028 is a leap year
        const date = new Date('2028-02-10T10:00:00Z')
        const result = endOfMonth(date)

        expect(result.getDate()).toBe(29)
        expect(result.getMonth()).toBe(1) // February
      })

      it('should handle months with 30 days', () => {
        const date = new Date('2026-04-15T10:00:00Z')
        const result = endOfMonth(date)

        expect(result.getDate()).toBe(30)
        expect(result.getMonth()).toBe(3) // April
      })
    })

    describe('addWeeks', () => {
      it('should add weeks correctly', () => {
        const date = new Date('2026-01-14T10:00:00Z')
        const result = addWeeks(date, 2)

        expect(result.getDate()).toBe(28)
        expect(result.getMonth()).toBe(0) // January
      })

      it('should handle month boundary', () => {
        const date = new Date('2026-01-28T10:00:00Z')
        const result = addWeeks(date, 1)

        expect(result.getDate()).toBe(4)
        expect(result.getMonth()).toBe(1) // February
      })

      it('should handle negative weeks', () => {
        const date = new Date('2026-01-14T10:00:00Z')
        const result = addWeeks(date, -1)

        expect(result.getDate()).toBe(7)
      })
    })

    describe('addMonths', () => {
      it('should add months correctly', () => {
        const date = new Date('2026-01-14T10:00:00Z')
        const result = addMonths(date, 2)

        expect(result.getMonth()).toBe(2) // March
        expect(result.getDate()).toBe(14)
      })

      it('should handle year boundary', () => {
        const date = new Date('2026-11-14T10:00:00Z')
        const result = addMonths(date, 3)

        expect(result.getMonth()).toBe(1) // February
        expect(result.getFullYear()).toBe(2027)
      })

      it('should handle day overflow (e.g., Jan 31 + 1 month)', () => {
        const date = new Date('2026-01-31T10:00:00Z')
        const result = addMonths(date, 1)

        // JavaScript Date wraps to March 3 (31 days into February which has 28)
        expect(result.getMonth()).toBe(2) // March
        expect(result.getDate()).toBe(3)
      })
    })

    describe('subMonths', () => {
      it('should subtract months correctly', () => {
        const date = new Date('2026-03-14T10:00:00Z')
        const result = subMonths(date, 2)

        expect(result.getMonth()).toBe(0) // January
        expect(result.getDate()).toBe(14)
      })

      it('should handle year boundary backwards', () => {
        const date = new Date('2026-02-14T10:00:00Z')
        const result = subMonths(date, 3)

        expect(result.getMonth()).toBe(10) // November
        expect(result.getFullYear()).toBe(2025)
      })
    })

    describe('isSameMonth', () => {
      it('should return true for same month and year', () => {
        const date1 = new Date('2026-01-05T10:00:00Z')
        const date2 = new Date('2026-01-28T20:00:00Z')

        expect(isSameMonth(date1, date2)).toBe(true)
      })

      it('should return false for different months same year', () => {
        const date1 = new Date('2026-01-14T10:00:00Z')
        const date2 = new Date('2026-02-14T10:00:00Z')

        expect(isSameMonth(date1, date2)).toBe(false)
      })

      it('should return false for same month different years', () => {
        const date1 = new Date('2026-01-14T10:00:00Z')
        const date2 = new Date('2027-01-14T10:00:00Z')

        expect(isSameMonth(date1, date2)).toBe(false)
      })
    })

    describe('nextSaturday', () => {
      it('should return this Saturday when today is Wednesday', () => {
        // January 14, 2026 is a Wednesday
        const result = nextSaturday()

        expect(result.getDay()).toBe(6) // Saturday
        expect(result.getDate()).toBe(17) // January 17, 2026
      })

      it('should return today if today is Saturday', () => {
        vi.setSystemTime(new Date('2026-01-17T10:00:00Z')) // Saturday
        const result = nextSaturday()

        expect(result.getDay()).toBe(6)
        expect(result.getDate()).toBe(17)
      })

      it('should return next Saturday if today is Sunday', () => {
        vi.setSystemTime(new Date('2026-01-18T10:00:00Z')) // Sunday
        const result = nextSaturday()

        expect(result.getDay()).toBe(6)
        expect(result.getDate()).toBe(24) // Next Saturday
      })

      it('should accept a custom from date', () => {
        const from = new Date('2026-01-20T10:00:00Z') // Tuesday
        const result = nextSaturday(from)

        expect(result.getDay()).toBe(6)
        expect(result.getDate()).toBe(24)
      })
    })

    describe('nextMonday', () => {
      it('should return next Monday when today is Wednesday', () => {
        // January 14, 2026 is a Wednesday
        const result = nextMonday()

        expect(result.getDay()).toBe(1) // Monday
        expect(result.getDate()).toBe(19) // January 19, 2026
      })

      it('should return next Monday (7 days) if today is Monday', () => {
        vi.setSystemTime(new Date('2026-01-12T10:00:00Z')) // Monday
        const result = nextMonday()

        expect(result.getDay()).toBe(1)
        expect(result.getDate()).toBe(19) // Next Monday
      })

      it('should return tomorrow if today is Sunday', () => {
        vi.setSystemTime(new Date('2026-01-18T10:00:00Z')) // Sunday
        const result = nextMonday()

        expect(result.getDay()).toBe(1)
        expect(result.getDate()).toBe(19) // Next day
      })

      it('should accept a custom from date', () => {
        const from = new Date('2026-01-15T10:00:00Z') // Thursday
        const result = nextMonday(from)

        expect(result.getDay()).toBe(1)
        expect(result.getDate()).toBe(19)
      })
    })

    describe('endOfDay', () => {
      it('should set time to 23:59:59.999', () => {
        const date = new Date('2026-01-14T10:30:00Z')
        const result = endOfDay(date)

        expect(result.getHours()).toBe(23)
        expect(result.getMinutes()).toBe(59)
        expect(result.getSeconds()).toBe(59)
        expect(result.getMilliseconds()).toBe(999)
      })

      it('should preserve year, month, and day', () => {
        const date = new Date('2026-06-20T08:00:00Z')
        const result = endOfDay(date)

        expect(result.getFullYear()).toBe(2026)
        expect(result.getMonth()).toBe(5) // June
        expect(result.getDate()).toBe(20)
      })

      it('should not mutate original date', () => {
        const original = new Date('2026-01-14T10:00:00Z')
        const originalTime = original.getTime()
        endOfDay(original)

        expect(original.getTime()).toBe(originalTime)
      })
    })
  })

  // ============================================================================
  // T075: DATE FORMATTING
  // ============================================================================

  describe('T075: Date Formatting', () => {
    describe('formatTime', () => {
      it('should format morning time correctly', () => {
        expect(formatTime('09:30')).toBe('9:30 AM')
      })

      it('should format afternoon time correctly', () => {
        expect(formatTime('14:45')).toBe('2:45 PM')
      })

      it('should format midnight correctly', () => {
        expect(formatTime('00:00')).toBe('12:00 AM')
      })

      it('should format noon correctly', () => {
        expect(formatTime('12:00')).toBe('12:00 PM')
      })

      it('should format 11 PM correctly', () => {
        expect(formatTime('23:59')).toBe('11:59 PM')
      })

      it('should handle single digit minutes with padding', () => {
        expect(formatTime('10:05')).toBe('10:05 AM')
      })

      it('should format 1 AM correctly', () => {
        expect(formatTime('01:00')).toBe('1:00 AM')
      })

      it('should format 12:30 PM correctly', () => {
        expect(formatTime('12:30')).toBe('12:30 PM')
      })
    })

    describe('formatDateShort', () => {
      it("should format date as 'Mon DD'", () => {
        const date = new Date('2026-01-14T10:00:00Z')
        expect(formatDateShort(date)).toBe('Jan 14')
      })

      it('should format December date correctly', () => {
        const date = new Date('2026-12-25T10:00:00Z')
        expect(formatDateShort(date)).toBe('Dec 25')
      })

      it('should format single digit day without leading zero', () => {
        const date = new Date('2026-03-05T10:00:00Z')
        expect(formatDateShort(date)).toBe('Mar 5')
      })

      it('should format last day of month', () => {
        const date = new Date('2026-01-31T10:00:00Z')
        expect(formatDateShort(date)).toBe('Jan 31')
      })
    })

    describe('formatDayName', () => {
      it('should return full day name', () => {
        const date = new Date('2026-01-14T10:00:00Z') // Wednesday
        expect(formatDayName(date)).toBe('Wednesday')
      })

      it('should format Sunday correctly', () => {
        const date = new Date('2026-01-18T10:00:00Z')
        expect(formatDayName(date)).toBe('Sunday')
      })

      it('should format Monday correctly', () => {
        const date = new Date('2026-01-12T10:00:00Z')
        expect(formatDayName(date)).toBe('Monday')
      })

      it('should format Saturday correctly', () => {
        const date = new Date('2026-01-17T10:00:00Z')
        expect(formatDayName(date)).toBe('Saturday')
      })
    })

    describe('formatDueDate', () => {
      it('should return null for null dueDate', () => {
        expect(formatDueDate(null, null)).toBe(null)
      })

      it('should return "Today" for today\'s date', () => {
        const today = new Date('2026-01-14T15:00:00Z')
        const result = formatDueDate(today, null)

        expect(result).toEqual({ label: 'Today', status: 'today' })
      })

      it('should return "Today" with time for today\'s date with time', () => {
        const today = new Date('2026-01-14T15:00:00Z')
        const result = formatDueDate(today, '14:30')

        expect(result).toEqual({ label: 'Today 2:30 PM', status: 'today' })
      })

      it('should return "Tomorrow" for tomorrow\'s date', () => {
        const tomorrow = new Date('2026-01-15T10:00:00Z')
        const result = formatDueDate(tomorrow, null)

        expect(result).toEqual({ label: 'Tomorrow', status: 'tomorrow' })
      })

      it('should return "Tomorrow" with time', () => {
        const tomorrow = new Date('2026-01-15T10:00:00Z')
        const result = formatDueDate(tomorrow, '09:00')

        expect(result).toEqual({ label: 'Tomorrow 9:00 AM', status: 'tomorrow' })
      })

      it('should return day name for dates within this week', () => {
        const friday = new Date('2026-01-16T10:00:00Z') // Friday, 2 days from now
        const result = formatDueDate(friday, null)

        expect(result).toEqual({ label: 'Friday', status: 'upcoming' })
      })

      it('should return formatted date for overdue dates', () => {
        const overdue = new Date('2026-01-10T10:00:00Z')
        const result = formatDueDate(overdue, null)

        expect(result).toEqual({ label: 'Jan 10', status: 'overdue' })
      })

      it('should return formatted date with time for overdue dates', () => {
        const overdue = new Date('2026-01-10T10:00:00Z')
        const result = formatDueDate(overdue, '16:00')

        expect(result).toEqual({ label: 'Jan 10 4:00 PM', status: 'overdue' })
      })

      it('should return formatted date for later dates (8+ days)', () => {
        const later = new Date('2026-01-25T10:00:00Z')
        const result = formatDueDate(later, null)

        expect(result).toEqual({ label: 'Jan 25', status: 'later' })
      })

      it('should handle edge case: exactly 7 days from now (last day of upcoming)', () => {
        const sixDays = new Date('2026-01-20T10:00:00Z') // 6 days from Jan 14
        const result = formatDueDate(sixDays, null)

        expect(result?.status).toBe('upcoming')
      })

      it('should handle edge case: exactly 8 days from now (first day of later)', () => {
        const sevenDays = new Date('2026-01-21T10:00:00Z') // 7 days = next week
        const result = formatDueDate(sevenDays, null)

        expect(result?.status).toBe('later')
      })
    })
  })

  // ============================================================================
  // T076: TASK STATUS HELPERS
  // ============================================================================

  describe('T076: Task Status Helpers', () => {
    describe('isTaskCompleted', () => {
      it("should return true when task status type is 'done'", () => {
        const project = createMockProject({ id: 'project-1' })
        const task = createMockTask({
          projectId: 'project-1',
          statusId: 'status-done'
        })

        expect(isTaskCompleted(task, [project])).toBe(true)
      })

      it("should return false when task status type is 'todo'", () => {
        const project = createMockProject({ id: 'project-1' })
        const task = createMockTask({
          projectId: 'project-1',
          statusId: 'status-todo'
        })

        expect(isTaskCompleted(task, [project])).toBe(false)
      })

      it("should return false when task status type is 'in_progress'", () => {
        const project = createMockProject({ id: 'project-1' })
        const task = createMockTask({
          projectId: 'project-1',
          statusId: 'status-in-progress'
        })

        expect(isTaskCompleted(task, [project])).toBe(false)
      })

      it('should return false when project is not found', () => {
        const project = createMockProject({ id: 'project-1' })
        const task = createMockTask({
          projectId: 'non-existent-project',
          statusId: 'status-done'
        })

        expect(isTaskCompleted(task, [project])).toBe(false)
      })

      it('should return false when status is not found in project', () => {
        const project = createMockProject({ id: 'project-1' })
        const task = createMockTask({
          projectId: 'project-1',
          statusId: 'non-existent-status'
        })

        expect(isTaskCompleted(task, [project])).toBe(false)
      })

      it('should work with multiple projects', () => {
        const project1 = createMockProject({ id: 'project-1' })
        const project2 = createMockProject({
          id: 'project-2',
          statuses: [createMockStatus({ id: 'custom-done', type: 'done', order: 0 })]
        })

        const task = createMockTask({
          projectId: 'project-2',
          statusId: 'custom-done'
        })

        expect(isTaskCompleted(task, [project1, project2])).toBe(true)
      })

      it('should handle project with custom status names', () => {
        const project = createMockProject({
          id: 'project-1',
          statuses: [
            createMockStatus({ id: 'backlog', name: 'Backlog', type: 'todo', order: 0 }),
            createMockStatus({ id: 'completed', name: 'Completed', type: 'done', order: 1 })
          ]
        })

        const task = createMockTask({
          projectId: 'project-1',
          statusId: 'completed'
        })

        expect(isTaskCompleted(task, [project])).toBe(true)
      })
    })

    describe('getDefaultTodoStatus', () => {
      it('should return first status with type "todo"', () => {
        const project = createMockProject()
        const result = getDefaultTodoStatus(project)

        expect(result).toBeDefined()
        expect(result?.type).toBe('todo')
        expect(result?.id).toBe('status-todo')
      })

      it('should return first "todo" status when multiple exist', () => {
        const project = createMockProject({
          statuses: [
            createMockStatus({ id: 'first-todo', name: 'First Todo', type: 'todo', order: 0 }),
            createMockStatus({ id: 'second-todo', name: 'Second Todo', type: 'todo', order: 1 }),
            createMockStatus({ id: 'done', type: 'done', order: 2 })
          ]
        })

        const result = getDefaultTodoStatus(project)

        expect(result?.id).toBe('first-todo')
      })

      it('should return undefined when no "todo" status exists', () => {
        const project = createMockProject({
          statuses: [
            createMockStatus({ id: 'in-progress', type: 'in_progress', order: 0 }),
            createMockStatus({ id: 'done', type: 'done', order: 1 })
          ]
        })

        const result = getDefaultTodoStatus(project)

        expect(result).toBeUndefined()
      })

      it('should return undefined for project with empty statuses', () => {
        const project = createMockProject({ statuses: [] })
        const result = getDefaultTodoStatus(project)

        expect(result).toBeUndefined()
      })
    })

    describe('getDefaultDoneStatus', () => {
      it('should return first status with type "done"', () => {
        const project = createMockProject()
        const result = getDefaultDoneStatus(project)

        expect(result).toBeDefined()
        expect(result?.type).toBe('done')
        expect(result?.id).toBe('status-done')
      })

      it('should return first "done" status when multiple exist', () => {
        const project = createMockProject({
          statuses: [
            createMockStatus({ id: 'todo', type: 'todo', order: 0 }),
            createMockStatus({ id: 'first-done', name: 'Completed', type: 'done', order: 1 }),
            createMockStatus({ id: 'second-done', name: 'Archived', type: 'done', order: 2 })
          ]
        })

        const result = getDefaultDoneStatus(project)

        expect(result?.id).toBe('first-done')
      })

      it('should return undefined when no "done" status exists', () => {
        const project = createMockProject({
          statuses: [
            createMockStatus({ id: 'todo', type: 'todo', order: 0 }),
            createMockStatus({ id: 'in-progress', type: 'in_progress', order: 1 })
          ]
        })

        const result = getDefaultDoneStatus(project)

        expect(result).toBeUndefined()
      })

      it('should return undefined for project with empty statuses', () => {
        const project = createMockProject({ statuses: [] })
        const result = getDefaultDoneStatus(project)

        expect(result).toBeUndefined()
      })

      it('should work with custom status names', () => {
        const project = createMockProject({
          statuses: [
            createMockStatus({ id: 'new', name: 'New', type: 'todo', order: 0 }),
            createMockStatus({ id: 'shipped', name: 'Shipped', type: 'done', order: 1 })
          ]
        })

        const result = getDefaultDoneStatus(project)

        expect(result?.id).toBe('shipped')
        expect(result?.name).toBe('Shipped')
      })
    })
  })

  // ============================================================================
  // T077: TASK SORTING - PRIORITY & DATE
  // ============================================================================

  describe('T077: Task Sorting - Priority & Date', () => {
    describe('sortTasksByPriorityAndDate', () => {
      it('should sort by priority first (urgent > high > medium > low > none)', () => {
        const tasks = [
          createMockTask({ id: 't1', priority: 'none' }),
          createMockTask({ id: 't2', priority: 'urgent' }),
          createMockTask({ id: 't3', priority: 'low' }),
          createMockTask({ id: 't4', priority: 'high' }),
          createMockTask({ id: 't5', priority: 'medium' })
        ]

        const sorted = sortTasksByPriorityAndDate(tasks)

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't4', 't5', 't3', 't1'])
      })

      it('should sort by due date when priorities are equal (earlier first)', () => {
        const tasks = [
          createMockTask({ id: 't1', priority: 'high', dueDate: new Date('2026-01-20') }),
          createMockTask({ id: 't2', priority: 'high', dueDate: new Date('2026-01-15') }),
          createMockTask({ id: 't3', priority: 'high', dueDate: new Date('2026-01-18') })
        ]

        const sorted = sortTasksByPriorityAndDate(tasks)

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })

      it('should put tasks without due date last within same priority', () => {
        const tasks = [
          createMockTask({ id: 't1', priority: 'medium', dueDate: null }),
          createMockTask({ id: 't2', priority: 'medium', dueDate: new Date('2026-01-20') }),
          createMockTask({ id: 't3', priority: 'medium', dueDate: new Date('2026-01-15') })
        ]

        const sorted = sortTasksByPriorityAndDate(tasks)

        expect(sorted.map((t: Task) => t.id)).toEqual(['t3', 't2', 't1'])
      })

      it('should handle mixed priorities and dates correctly', () => {
        const tasks = [
          createMockTask({ id: 't1', priority: 'low', dueDate: new Date('2026-01-15') }),
          createMockTask({ id: 't2', priority: 'urgent', dueDate: new Date('2026-01-20') }),
          createMockTask({ id: 't3', priority: 'high', dueDate: null }),
          createMockTask({ id: 't4', priority: 'urgent', dueDate: new Date('2026-01-10') })
        ]

        const sorted = sortTasksByPriorityAndDate(tasks)

        expect(sorted.map((t: Task) => t.id)).toEqual(['t4', 't2', 't3', 't1'])
      })

      it('should return empty array for empty input', () => {
        const sorted = sortTasksByPriorityAndDate([])
        expect(sorted).toEqual([])
      })

      it('should handle single task', () => {
        const task = createMockTask({ id: 't1', priority: 'high' })
        const sorted = sortTasksByPriorityAndDate([task])
        expect(sorted).toHaveLength(1)
        expect(sorted[0].id).toBe('t1')
      })

      it('should not mutate original array', () => {
        const tasks = [
          createMockTask({ id: 't1', priority: 'low' }),
          createMockTask({ id: 't2', priority: 'high' })
        ]
        const originalOrder = tasks.map((t) => t.id)
        sortTasksByPriorityAndDate(tasks)
        expect(tasks.map((t) => t.id)).toEqual(originalOrder)
      })

      it('should maintain stable sort for equal priority and date', () => {
        const date = new Date('2026-01-15')
        const tasks = [
          createMockTask({ id: 't1', priority: 'medium', dueDate: date }),
          createMockTask({ id: 't2', priority: 'medium', dueDate: date }),
          createMockTask({ id: 't3', priority: 'medium', dueDate: date })
        ]

        const sorted = sortTasksByPriorityAndDate(tasks)

        expect(sorted.map((t: Task) => t.id)).toEqual(['t1', 't2', 't3'])
      })

      it('should handle all five priority levels in correct order', () => {
        const tasks = [
          createMockTask({ id: 'none', priority: 'none' }),
          createMockTask({ id: 'low', priority: 'low' }),
          createMockTask({ id: 'medium', priority: 'medium' }),
          createMockTask({ id: 'high', priority: 'high' }),
          createMockTask({ id: 'urgent', priority: 'urgent' })
        ]

        const sorted = sortTasksByPriorityAndDate(tasks)

        expect(sorted.map((t: Task) => t.id)).toEqual(['urgent', 'high', 'medium', 'low', 'none'])
      })
    })

    describe('sortTasksForDay', () => {
      it('should put timed tasks first, then untimed', () => {
        const tasks = [
          createMockTask({ id: 't1', dueTime: null }),
          createMockTask({ id: 't2', dueTime: '14:30' }),
          createMockTask({ id: 't3', dueTime: null })
        ]

        const sorted = sortTasksForDay(tasks)

        expect(sorted[0].id).toBe('t2')
      })

      it('should sort timed tasks chronologically', () => {
        const tasks = [
          createMockTask({ id: 't1', dueTime: '14:30' }),
          createMockTask({ id: 't2', dueTime: '09:00' }),
          createMockTask({ id: 't3', dueTime: '18:00' }),
          createMockTask({ id: 't4', dueTime: '12:00' })
        ]

        const sorted = sortTasksForDay(tasks)

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't4', 't1', 't3'])
      })

      it('should sort untimed tasks by priority', () => {
        const tasks = [
          createMockTask({ id: 't1', dueTime: null, priority: 'low' }),
          createMockTask({ id: 't2', dueTime: null, priority: 'urgent' }),
          createMockTask({ id: 't3', dueTime: null, priority: 'high' })
        ]

        const sorted = sortTasksForDay(tasks)

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })

      it('should sort by title when priority is equal (untimed)', () => {
        const tasks = [
          createMockTask({ id: 't1', title: 'Zebra task', dueTime: null, priority: 'medium' }),
          createMockTask({ id: 't2', title: 'Apple task', dueTime: null, priority: 'medium' }),
          createMockTask({ id: 't3', title: 'Mango task', dueTime: null, priority: 'medium' })
        ]

        const sorted = sortTasksForDay(tasks)

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })

      it('should handle mixed timed and untimed tasks with varying priorities', () => {
        const tasks = [
          createMockTask({ id: 't1', dueTime: null, priority: 'urgent' }),
          createMockTask({ id: 't2', dueTime: '14:00', priority: 'low' }),
          createMockTask({ id: 't3', dueTime: null, priority: 'low' }),
          createMockTask({ id: 't4', dueTime: '09:00', priority: 'high' })
        ]

        const sorted = sortTasksForDay(tasks)

        expect(sorted.map((t: Task) => t.id)).toEqual(['t4', 't2', 't1', 't3'])
      })

      it('should handle empty array', () => {
        const sorted = sortTasksForDay([])
        expect(sorted).toEqual([])
      })

      it('should handle all tasks with same time (sort by priority)', () => {
        const tasks = [
          createMockTask({ id: 't1', dueTime: '10:00', priority: 'low' }),
          createMockTask({ id: 't2', dueTime: '10:00', priority: 'high' }),
          createMockTask({ id: 't3', dueTime: '10:00', priority: 'medium' })
        ]

        const sorted = sortTasksForDay(tasks)

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })

      it('should handle edge times (midnight and end of day)', () => {
        const tasks = [
          createMockTask({ id: 't1', dueTime: '23:59' }),
          createMockTask({ id: 't2', dueTime: '00:00' }),
          createMockTask({ id: 't3', dueTime: '12:00' })
        ]

        const sorted = sortTasksForDay(tasks)

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })
    })

    describe('sortTasksByTimeAndPriority', () => {
      it('should put tasks with time before tasks without time', () => {
        const tasks = [
          createMockTask({ id: 't1', dueTime: null }),
          createMockTask({ id: 't2', dueTime: '15:00' })
        ]

        const sorted = sortTasksByTimeAndPriority(tasks)

        expect(sorted[0].id).toBe('t2')
        expect(sorted[1].id).toBe('t1')
      })

      it('should sort tasks with time chronologically', () => {
        const tasks = [
          createMockTask({ id: 't1', dueTime: '17:00' }),
          createMockTask({ id: 't2', dueTime: '09:00' }),
          createMockTask({ id: 't3', dueTime: '12:30' })
        ]

        const sorted = sortTasksByTimeAndPriority(tasks)

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })

      it('should sort by priority when time is equal', () => {
        const tasks = [
          createMockTask({ id: 't1', dueTime: '10:00', priority: 'low' }),
          createMockTask({ id: 't2', dueTime: '10:00', priority: 'urgent' }),
          createMockTask({ id: 't3', dueTime: '10:00', priority: 'medium' })
        ]

        const sorted = sortTasksByTimeAndPriority(tasks)

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })

      it('should sort untimed tasks by priority', () => {
        const tasks = [
          createMockTask({ id: 't1', dueTime: null, priority: 'none' }),
          createMockTask({ id: 't2', dueTime: null, priority: 'high' }),
          createMockTask({ id: 't3', dueTime: null, priority: 'low' })
        ]

        const sorted = sortTasksByTimeAndPriority(tasks)

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })

      it('should handle empty array', () => {
        expect(sortTasksByTimeAndPriority([])).toEqual([])
      })

      it('should handle all tasks without time', () => {
        const tasks = [
          createMockTask({ id: 't1', dueTime: null, priority: 'medium' }),
          createMockTask({ id: 't2', dueTime: null, priority: 'urgent' })
        ]

        const sorted = sortTasksByTimeAndPriority(tasks)

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't1'])
      })

      it('should not mutate original array', () => {
        const tasks = [
          createMockTask({ id: 't1', dueTime: '17:00' }),
          createMockTask({ id: 't2', dueTime: '09:00' })
        ]
        const originalOrder = tasks.map((t) => t.id)
        sortTasksByTimeAndPriority(tasks)
        expect(tasks.map((t) => t.id)).toEqual(originalOrder)
      })
    })

    describe('sortOverdueTasks', () => {
      it('should sort by date (oldest first)', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date('2026-01-10') }),
          createMockTask({ id: 't2', dueDate: new Date('2026-01-05') }),
          createMockTask({ id: 't3', dueDate: new Date('2026-01-12') })
        ]

        const sorted = sortOverdueTasks(tasks)

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't1', 't3'])
      })

      it('should sort by priority when dates are equal', () => {
        const sameDate = new Date('2026-01-10')
        const tasks = [
          createMockTask({ id: 't1', dueDate: sameDate, priority: 'low' }),
          createMockTask({ id: 't2', dueDate: sameDate, priority: 'urgent' }),
          createMockTask({ id: 't3', dueDate: sameDate, priority: 'high' })
        ]

        const sorted = sortOverdueTasks(tasks)

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })

      it('should handle tasks with same date and priority', () => {
        const sameDate = new Date('2026-01-10')
        const tasks = [
          createMockTask({ id: 't1', dueDate: sameDate, priority: 'medium' }),
          createMockTask({ id: 't2', dueDate: sameDate, priority: 'medium' })
        ]

        const sorted = sortOverdueTasks(tasks)

        expect(sorted).toHaveLength(2)
      })

      it('should handle empty array', () => {
        expect(sortOverdueTasks([])).toEqual([])
      })

      it('should handle single task', () => {
        const task = createMockTask({ id: 't1', dueDate: new Date('2026-01-10') })
        const sorted = sortOverdueTasks([task])
        expect(sorted).toHaveLength(1)
        expect(sorted[0].id).toBe('t1')
      })

      it('should not mutate original array', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date('2026-01-12') }),
          createMockTask({ id: 't2', dueDate: new Date('2026-01-05') })
        ]
        const originalOrder = tasks.map((t) => t.id)
        sortOverdueTasks(tasks)
        expect(tasks.map((t) => t.id)).toEqual(originalOrder)
      })

      it('should handle dates spanning months', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date('2026-01-05') }),
          createMockTask({ id: 't2', dueDate: new Date('2025-12-20') }),
          createMockTask({ id: 't3', dueDate: new Date('2026-01-01') })
        ]

        const sorted = sortOverdueTasks(tasks)

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })
    })
  })

  // ============================================================================
  // T078: TASK SORTING - ADVANCED
  // ============================================================================

  describe('T078: Task Sorting - Advanced', () => {
    const mockAdvancedProjects: Project[] = [
      createMockProject({ id: 'p1', name: 'Alpha Project' }),
      createMockProject({ id: 'p2', name: 'Beta Project' }),
      createMockProject({ id: 'p3', name: 'Gamma Project' })
    ]

    describe('sortTasksAdvanced - by dueDate', () => {
      it('should sort by due date ascending', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date('2026-01-20') }),
          createMockTask({ id: 't2', dueDate: new Date('2026-01-10') }),
          createMockTask({ id: 't3', dueDate: new Date('2026-01-15') })
        ]

        const sorted = sortTasksAdvanced(
          tasks,
          { field: 'dueDate', direction: 'asc' },
          mockAdvancedProjects
        )

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })

      it('should sort by due date descending', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date('2026-01-20') }),
          createMockTask({ id: 't2', dueDate: new Date('2026-01-10') }),
          createMockTask({ id: 't3', dueDate: new Date('2026-01-15') })
        ]

        const sorted = sortTasksAdvanced(
          tasks,
          { field: 'dueDate', direction: 'desc' },
          mockAdvancedProjects
        )

        expect(sorted.map((t: Task) => t.id)).toEqual(['t1', 't3', 't2'])
      })

      it('should put tasks without due date at end (ascending)', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: null }),
          createMockTask({ id: 't2', dueDate: new Date('2026-01-15') }),
          createMockTask({ id: 't3', dueDate: null })
        ]

        const sorted = sortTasksAdvanced(
          tasks,
          { field: 'dueDate', direction: 'asc' },
          mockAdvancedProjects
        )

        expect(sorted[0].id).toBe('t2')
        expect(sorted.slice(1).every((t: Task) => t.dueDate === null)).toBe(true)
      })

      it('should sort by time when dates are equal', () => {
        const sameDate = new Date('2026-01-15')
        const tasks = [
          createMockTask({ id: 't1', dueDate: sameDate, dueTime: '15:00' }),
          createMockTask({ id: 't2', dueDate: sameDate, dueTime: '09:00' }),
          createMockTask({ id: 't3', dueDate: sameDate, dueTime: '12:00' })
        ]

        const sorted = sortTasksAdvanced(
          tasks,
          { field: 'dueDate', direction: 'asc' },
          mockAdvancedProjects
        )

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })

      it('should put tasks without time after tasks with time (same date)', () => {
        const sameDate = new Date('2026-01-15')
        const tasks = [
          createMockTask({ id: 't1', dueDate: sameDate, dueTime: null }),
          createMockTask({ id: 't2', dueDate: sameDate, dueTime: '10:00' })
        ]

        const sorted = sortTasksAdvanced(
          tasks,
          { field: 'dueDate', direction: 'asc' },
          mockAdvancedProjects
        )

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't1'])
      })
    })

    describe('sortTasksAdvanced - by priority', () => {
      it('should sort by priority ascending (urgent first)', () => {
        const tasks = [
          createMockTask({ id: 't1', priority: 'low' }),
          createMockTask({ id: 't2', priority: 'urgent' }),
          createMockTask({ id: 't3', priority: 'medium' }),
          createMockTask({ id: 't4', priority: 'high' }),
          createMockTask({ id: 't5', priority: 'none' })
        ]

        const sorted = sortTasksAdvanced(
          tasks,
          { field: 'priority', direction: 'asc' },
          mockAdvancedProjects
        )

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't4', 't3', 't1', 't5'])
      })

      it('should sort by priority descending (none first)', () => {
        const tasks = [
          createMockTask({ id: 't1', priority: 'urgent' }),
          createMockTask({ id: 't2', priority: 'none' }),
          createMockTask({ id: 't3', priority: 'low' })
        ]

        const sorted = sortTasksAdvanced(
          tasks,
          { field: 'priority', direction: 'desc' },
          mockAdvancedProjects
        )

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })
    })

    describe('sortTasksAdvanced - by createdAt', () => {
      it('should sort by creation date ascending (oldest first)', () => {
        const tasks = [
          createMockTask({ id: 't1', createdAt: new Date('2026-01-10') }),
          createMockTask({ id: 't2', createdAt: new Date('2026-01-05') }),
          createMockTask({ id: 't3', createdAt: new Date('2026-01-12') })
        ]

        const sorted = sortTasksAdvanced(
          tasks,
          { field: 'createdAt', direction: 'asc' },
          mockAdvancedProjects
        )

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't1', 't3'])
      })

      it('should sort by creation date descending (newest first)', () => {
        const tasks = [
          createMockTask({ id: 't1', createdAt: new Date('2026-01-10') }),
          createMockTask({ id: 't2', createdAt: new Date('2026-01-05') }),
          createMockTask({ id: 't3', createdAt: new Date('2026-01-12') })
        ]

        const sorted = sortTasksAdvanced(
          tasks,
          { field: 'createdAt', direction: 'desc' },
          mockAdvancedProjects
        )

        expect(sorted.map((t: Task) => t.id)).toEqual(['t3', 't1', 't2'])
      })
    })

    describe('sortTasksAdvanced - by title', () => {
      it('should sort alphabetically ascending', () => {
        const tasks = [
          createMockTask({ id: 't1', title: 'Zebra' }),
          createMockTask({ id: 't2', title: 'Apple' }),
          createMockTask({ id: 't3', title: 'Mango' })
        ]

        const sorted = sortTasksAdvanced(
          tasks,
          { field: 'title', direction: 'asc' },
          mockAdvancedProjects
        )

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })

      it('should sort alphabetically descending', () => {
        const tasks = [
          createMockTask({ id: 't1', title: 'Zebra' }),
          createMockTask({ id: 't2', title: 'Apple' }),
          createMockTask({ id: 't3', title: 'Mango' })
        ]

        const sorted = sortTasksAdvanced(
          tasks,
          { field: 'title', direction: 'desc' },
          mockAdvancedProjects
        )

        expect(sorted.map((t: Task) => t.id)).toEqual(['t1', 't3', 't2'])
      })

      it('should handle case-insensitive sorting via localeCompare', () => {
        const tasks = [
          createMockTask({ id: 't1', title: 'zebra' }),
          createMockTask({ id: 't2', title: 'Apple' }),
          createMockTask({ id: 't3', title: 'MANGO' })
        ]

        const sorted = sortTasksAdvanced(
          tasks,
          { field: 'title', direction: 'asc' },
          mockAdvancedProjects
        )

        expect(sorted.map((t: Task) => t.title.toLowerCase())).toEqual(['apple', 'mango', 'zebra'])
      })
    })

    describe('sortTasksAdvanced - by project', () => {
      it('should sort by project name ascending', () => {
        const tasks = [
          createMockTask({ id: 't1', projectId: 'p3' }),
          createMockTask({ id: 't2', projectId: 'p1' }),
          createMockTask({ id: 't3', projectId: 'p2' })
        ]

        const sorted = sortTasksAdvanced(
          tasks,
          { field: 'project', direction: 'asc' },
          mockAdvancedProjects
        )

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })

      it('should sort by project name descending', () => {
        const tasks = [
          createMockTask({ id: 't1', projectId: 'p1' }),
          createMockTask({ id: 't2', projectId: 'p3' }),
          createMockTask({ id: 't3', projectId: 'p2' })
        ]

        const sorted = sortTasksAdvanced(
          tasks,
          { field: 'project', direction: 'desc' },
          mockAdvancedProjects
        )

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })

      it('should handle tasks with unknown project IDs', () => {
        const tasks = [
          createMockTask({ id: 't1', projectId: 'p1' }),
          createMockTask({ id: 't2', projectId: 'unknown' })
        ]

        const sorted = sortTasksAdvanced(
          tasks,
          { field: 'project', direction: 'asc' },
          mockAdvancedProjects
        )

        expect(sorted[0].id).toBe('t2')
      })
    })

    describe('sortTasksAdvanced - by completedAt', () => {
      it('should sort by completion date ascending', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-12') }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-10') }),
          createMockTask({ id: 't3', completedAt: new Date('2026-01-14') })
        ]

        const sorted = sortTasksAdvanced(
          tasks,
          { field: 'completedAt', direction: 'asc' },
          mockAdvancedProjects
        )

        expect(sorted.map((t: Task) => t.id)).toEqual(['t2', 't1', 't3'])
      })

      it('should sort by completion date descending', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-12') }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-10') }),
          createMockTask({ id: 't3', completedAt: new Date('2026-01-14') })
        ]

        const sorted = sortTasksAdvanced(
          tasks,
          { field: 'completedAt', direction: 'desc' },
          mockAdvancedProjects
        )

        expect(sorted.map((t: Task) => t.id)).toEqual(['t3', 't1', 't2'])
      })

      it('should put incomplete tasks at end', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: null }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-10') }),
          createMockTask({ id: 't3', completedAt: null })
        ]

        const sorted = sortTasksAdvanced(
          tasks,
          { field: 'completedAt', direction: 'asc' },
          mockAdvancedProjects
        )

        expect(sorted[0].id).toBe('t2')
        expect(sorted.slice(1).every((t: Task) => t.completedAt === null)).toBe(true)
      })
    })

    describe('sortTasksAdvanced - edge cases', () => {
      it('should handle empty array', () => {
        const sorted = sortTasksAdvanced(
          [],
          { field: 'dueDate', direction: 'asc' },
          mockAdvancedProjects
        )
        expect(sorted).toEqual([])
      })

      it('should handle single task', () => {
        const task = createMockTask({ id: 't1' })
        const sorted = sortTasksAdvanced(
          [task],
          { field: 'dueDate', direction: 'asc' },
          mockAdvancedProjects
        )
        expect(sorted).toHaveLength(1)
      })

      it('should not mutate original array', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date('2026-01-20') }),
          createMockTask({ id: 't2', dueDate: new Date('2026-01-10') })
        ]
        const originalOrder = tasks.map((t) => t.id)
        sortTasksAdvanced(tasks, { field: 'dueDate', direction: 'asc' }, mockAdvancedProjects)
        expect(tasks.map((t) => t.id)).toEqual(originalOrder)
      })
    })
  })

  // ============================================================================
  // T079: TASK GROUPING - BY DUE DATE
  // ============================================================================

  describe('T079: Task Grouping - By Due Date', () => {
    describe('groupTasksByDueDate', () => {
      it('should group overdue tasks (before today)', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date('2026-01-10') }),
          createMockTask({ id: 't2', dueDate: new Date('2026-01-13') }),
          createMockTask({ id: 't3', dueDate: new Date('2026-01-05') })
        ]

        const groups = groupTasksByDueDate(tasks)

        expect(groups.overdue).toHaveLength(3)
      })

      it('should group tasks due today', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date('2026-01-14') }),
          createMockTask({ id: 't2', dueDate: new Date('2026-01-14') })
        ]

        const groups = groupTasksByDueDate(tasks)

        expect(groups.today).toHaveLength(2)
      })

      it('should group tasks due tomorrow', () => {
        const tasks = [createMockTask({ id: 't1', dueDate: new Date('2026-01-15') })]

        const groups = groupTasksByDueDate(tasks)

        expect(groups.tomorrow).toHaveLength(1)
        expect(groups.tomorrow[0].id).toBe('t1')
      })

      it('should group upcoming tasks (2-7 days out)', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date('2026-01-16') }),
          createMockTask({ id: 't2', dueDate: new Date('2026-01-18') }),
          createMockTask({ id: 't3', dueDate: new Date('2026-01-21') })
        ]

        const groups = groupTasksByDueDate(tasks)

        expect(groups.upcoming).toHaveLength(3)
      })

      it('should group later tasks (8+ days out)', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date('2026-01-22') }),
          createMockTask({ id: 't2', dueDate: new Date('2026-02-14') })
        ]

        const groups = groupTasksByDueDate(tasks)

        expect(groups.later).toHaveLength(2)
      })

      it('should group tasks without due date', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: null }),
          createMockTask({ id: 't2', dueDate: null })
        ]

        const groups = groupTasksByDueDate(tasks)

        expect(groups.noDueDate).toHaveLength(2)
      })

      it('should correctly categorize all date ranges', () => {
        const tasks = [
          createMockTask({ id: 'overdue', dueDate: new Date('2026-01-10') }),
          createMockTask({ id: 'today', dueDate: new Date('2026-01-14') }),
          createMockTask({ id: 'tomorrow', dueDate: new Date('2026-01-15') }),
          createMockTask({ id: 'upcoming', dueDate: new Date('2026-01-18') }),
          createMockTask({ id: 'later', dueDate: new Date('2026-01-30') }),
          createMockTask({ id: 'nodate', dueDate: null })
        ]

        const groups = groupTasksByDueDate(tasks)

        expect(groups.overdue.some((t: Task) => t.id === 'overdue')).toBe(true)
        expect(groups.today.some((t: Task) => t.id === 'today')).toBe(true)
        expect(groups.tomorrow.some((t: Task) => t.id === 'tomorrow')).toBe(true)
        expect(groups.upcoming.some((t: Task) => t.id === 'upcoming')).toBe(true)
        expect(groups.later.some((t: Task) => t.id === 'later')).toBe(true)
        expect(groups.noDueDate.some((t: Task) => t.id === 'nodate')).toBe(true)
      })

      it('should sort tasks within each group by priority and date', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date('2026-01-14'), priority: 'low' }),
          createMockTask({ id: 't2', dueDate: new Date('2026-01-14'), priority: 'urgent' }),
          createMockTask({ id: 't3', dueDate: new Date('2026-01-14'), priority: 'high' })
        ]

        const groups = groupTasksByDueDate(tasks)

        expect(groups.today.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })

      it('should return empty groups for empty input', () => {
        const groups = groupTasksByDueDate([])

        expect(groups.overdue).toEqual([])
        expect(groups.today).toEqual([])
        expect(groups.tomorrow).toEqual([])
        expect(groups.upcoming).toEqual([])
        expect(groups.later).toEqual([])
        expect(groups.noDueDate).toEqual([])
      })

      it('should handle boundary case: exactly 7 days out (upcoming)', () => {
        const tasks = [createMockTask({ id: 't1', dueDate: new Date('2026-01-21') })]

        const groups = groupTasksByDueDate(tasks)

        expect(groups.upcoming).toHaveLength(1)
      })

      it('should handle boundary case: exactly 8 days out (later)', () => {
        const tasks = [createMockTask({ id: 't1', dueDate: new Date('2026-01-22') })]

        const groups = groupTasksByDueDate(tasks)

        expect(groups.later).toHaveLength(1)
      })
    })
  })

  // ============================================================================
  // T080: TASK GROUPING - BY STATUS & COMPLETION
  // ============================================================================

  describe('T080: Task Grouping - By Status & Completion', () => {
    describe('groupTasksByStatus', () => {
      const statusList: Status[] = [
        createMockStatus({ id: 's1', name: 'To Do', type: 'todo', order: 0 }),
        createMockStatus({ id: 's2', name: 'In Progress', type: 'in_progress', order: 1 }),
        createMockStatus({ id: 's3', name: 'Done', type: 'done', order: 2 })
      ]

      it('should group tasks by their status', () => {
        const tasks = [
          createMockTask({ id: 't1', statusId: 's1' }),
          createMockTask({ id: 't2', statusId: 's2' }),
          createMockTask({ id: 't3', statusId: 's1' }),
          createMockTask({ id: 't4', statusId: 's3' })
        ]

        const groups = groupTasksByStatus(tasks, statusList)

        expect(groups).toHaveLength(3)
        expect(groups[0].status.id).toBe('s1')
        expect(groups[0].tasks).toHaveLength(2)
        expect(groups[1].status.id).toBe('s2')
        expect(groups[1].tasks).toHaveLength(1)
        expect(groups[2].status.id).toBe('s3')
        expect(groups[2].tasks).toHaveLength(1)
      })

      it('should order groups by status order', () => {
        const unorderedStatuses: Status[] = [
          createMockStatus({ id: 's2', name: 'In Progress', order: 1 }),
          createMockStatus({ id: 's3', name: 'Done', order: 2 }),
          createMockStatus({ id: 's1', name: 'To Do', order: 0 })
        ]

        const tasks = [createMockTask({ id: 't1', statusId: 's2' })]

        const groups = groupTasksByStatus(tasks, unorderedStatuses)

        expect(groups[0].status.id).toBe('s1')
        expect(groups[1].status.id).toBe('s2')
        expect(groups[2].status.id).toBe('s3')
      })

      it('should return empty tasks array for statuses with no tasks', () => {
        const tasks = [createMockTask({ id: 't1', statusId: 's1' })]

        const groups = groupTasksByStatus(tasks, statusList)

        expect(groups.find((g: { status: Status }) => g.status.id === 's1')?.tasks).toHaveLength(1)
        expect(groups.find((g: { status: Status }) => g.status.id === 's2')?.tasks).toHaveLength(0)
        expect(groups.find((g: { status: Status }) => g.status.id === 's3')?.tasks).toHaveLength(0)
      })

      it('should sort tasks within each group by priority and date', () => {
        const tasks = [
          createMockTask({ id: 't1', statusId: 's1', priority: 'low' }),
          createMockTask({ id: 't2', statusId: 's1', priority: 'urgent' }),
          createMockTask({ id: 't3', statusId: 's1', priority: 'high' })
        ]

        const groups = groupTasksByStatus(tasks, statusList)

        const todoGroup = groups.find((g: { status: Status }) => g.status.id === 's1')!
        expect(todoGroup.tasks.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })

      it('should handle empty tasks array', () => {
        const groups = groupTasksByStatus([], statusList)

        expect(groups).toHaveLength(3)
        groups.forEach((g: { tasks: Task[] }) => expect(g.tasks).toEqual([]))
      })

      it('should handle empty statuses array', () => {
        const tasks = [createMockTask({ id: 't1' })]
        const groups = groupTasksByStatus(tasks, [])

        expect(groups).toEqual([])
      })
    })

    describe('groupTasksByCompletion', () => {
      it('should group tasks completed today', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-14T09:00:00Z') }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-14T15:00:00Z') })
        ]

        const groups = groupTasksByCompletion(tasks)

        expect(groups.today).toHaveLength(2)
      })

      it('should group tasks completed yesterday', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-13T10:00:00Z') }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-13T20:00:00Z') })
        ]

        const groups = groupTasksByCompletion(tasks)

        expect(groups.yesterday).toHaveLength(2)
      })

      it('should group tasks completed earlier', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-10T10:00:00Z') }),
          createMockTask({ id: 't2', completedAt: new Date('2025-12-25T10:00:00Z') })
        ]

        const groups = groupTasksByCompletion(tasks)

        expect(groups.earlier).toHaveLength(2)
      })

      it('should skip tasks without completedAt', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: null }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-14T10:00:00Z') })
        ]

        const groups = groupTasksByCompletion(tasks)

        expect(groups.today).toHaveLength(1)
        expect(groups.yesterday).toHaveLength(0)
        expect(groups.earlier).toHaveLength(0)
      })

      it('should sort within groups by completion date (most recent first)', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-14T09:00:00Z') }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-14T15:00:00Z') }),
          createMockTask({ id: 't3', completedAt: new Date('2026-01-14T12:00:00Z') })
        ]

        const groups = groupTasksByCompletion(tasks)

        expect(groups.today.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })

      it('should return empty groups for empty input', () => {
        const groups = groupTasksByCompletion([])

        expect(groups.today).toEqual([])
        expect(groups.yesterday).toEqual([])
        expect(groups.earlier).toEqual([])
      })

      it('should correctly categorize all completion periods', () => {
        const tasks = [
          createMockTask({ id: 'today', completedAt: new Date('2026-01-14T10:00:00Z') }),
          createMockTask({ id: 'yesterday', completedAt: new Date('2026-01-13T10:00:00Z') }),
          createMockTask({ id: 'earlier', completedAt: new Date('2026-01-01T10:00:00Z') })
        ]

        const groups = groupTasksByCompletion(tasks)

        expect(groups.today.some((t: Task) => t.id === 'today')).toBe(true)
        expect(groups.yesterday.some((t: Task) => t.id === 'yesterday')).toBe(true)
        expect(groups.earlier.some((t: Task) => t.id === 'earlier')).toBe(true)
      })
    })
  })

  // ============================================================================
  // T081: CALENDAR HELPERS
  // ============================================================================

  describe('T081: Calendar Helpers', () => {
    describe('formatDateKey', () => {
      it('should format date as yyyy-MM-dd', () => {
        const date = new Date('2026-01-14')
        expect(formatDateKey(date)).toBe('2026-01-14')
      })

      it('should pad single-digit months', () => {
        const date = new Date('2026-05-01')
        expect(formatDateKey(date)).toBe('2026-05-01')
      })

      it('should pad single-digit days', () => {
        const date = new Date('2026-12-05')
        expect(formatDateKey(date)).toBe('2026-12-05')
      })

      it('should handle year boundaries', () => {
        const date = new Date('2025-12-31')
        expect(formatDateKey(date)).toBe('2025-12-31')
      })

      it('should handle January 1st correctly', () => {
        const date = new Date('2026-01-01')
        expect(formatDateKey(date)).toBe('2026-01-01')
      })

      it('should handle leap year date', () => {
        const date = new Date('2028-02-29')
        expect(formatDateKey(date)).toBe('2028-02-29')
      })
    })

    describe('parseDateKey', () => {
      it('should parse yyyy-MM-dd to Date', () => {
        const date = parseDateKey('2026-01-14')
        expect(date.getFullYear()).toBe(2026)
        expect(date.getMonth()).toBe(0)
        expect(date.getDate()).toBe(14)
      })

      it('should handle December correctly', () => {
        const date = parseDateKey('2026-12-25')
        expect(date.getMonth()).toBe(11)
        expect(date.getDate()).toBe(25)
      })

      it('should handle single-digit months and days', () => {
        const date = parseDateKey('2026-01-05')
        expect(date.getMonth()).toBe(0)
        expect(date.getDate()).toBe(5)
      })

      it('should roundtrip with formatDateKey', () => {
        const original = new Date('2026-07-15')
        const key = formatDateKey(original)
        const parsed = parseDateKey(key)
        expect(parsed.getFullYear()).toBe(original.getFullYear())
        expect(parsed.getMonth()).toBe(original.getMonth())
        expect(parsed.getDate()).toBe(original.getDate())
      })

      it('should parse February 29 in leap year', () => {
        const date = parseDateKey('2028-02-29')
        expect(date.getMonth()).toBe(1)
        expect(date.getDate()).toBe(29)
      })
    })

    describe('getCalendarDays', () => {
      it('should return calendar days for a month', () => {
        const january2026 = new Date('2026-01-01')
        const days = getCalendarDays(january2026)

        expect(days.length).toBeGreaterThan(0)
        expect(days.length % 7).toBe(0)
      })

      it('should mark days in current month correctly', () => {
        const january2026 = new Date('2026-01-15')
        const days = getCalendarDays(january2026)

        const jan15 = days.find(
          (d: { date: Date; isCurrentMonth: boolean }) =>
            d.date.getMonth() === 0 && d.date.getDate() === 15 && d.date.getFullYear() === 2026
        )
        expect(jan15?.isCurrentMonth).toBe(true)
      })

      it('should mark overflow days from previous month', () => {
        const january2026 = new Date('2026-01-01')
        const days = getCalendarDays(january2026, 0)

        expect(days[0].date.getDay()).toBe(0)
        expect(days[0].isCurrentMonth).toBe(false)
      })

      it('should mark overflow days from next month', () => {
        const january2026 = new Date('2026-01-31')
        const days = getCalendarDays(january2026, 0)

        const lastDay = days[days.length - 1]
        expect(lastDay.date.getDay()).toBe(6)
      })

      it('should mark today correctly', () => {
        const currentMonth = new Date('2026-01-14')
        const days = getCalendarDays(currentMonth)

        const today = days.find((d: { isToday: boolean }) => d.isToday)
        expect(today).toBeDefined()
        expect(today?.date.getDate()).toBe(14)
      })

      it('should mark weekends correctly', () => {
        const january2026 = new Date('2026-01-01')
        const days = getCalendarDays(january2026)

        const weekends = days.filter((d: { isWeekend: boolean }) => d.isWeekend)
        weekends.forEach((d: { date: Date }) => {
          expect([0, 6]).toContain(d.date.getDay())
        })
      })

      it('should respect weekStartsOn = 0 (Sunday)', () => {
        const january2026 = new Date('2026-01-01')
        const days = getCalendarDays(january2026, 0)

        expect(days[0].date.getDay()).toBe(0)
      })

      it('should respect weekStartsOn = 1 (Monday)', () => {
        const january2026 = new Date('2026-01-01')
        const days = getCalendarDays(january2026, 1)

        expect(days[0].date.getDay()).toBe(1)
      })

      it('should include all days of the month', () => {
        const january2026 = new Date('2026-01-15')
        const days = getCalendarDays(january2026)

        for (let day = 1; day <= 31; day++) {
          const found = days.some(
            (d: { date: Date }) =>
              d.date.getMonth() === 0 && d.date.getDate() === day && d.date.getFullYear() === 2026
          )
          expect(found).toBe(true)
        }
      })

      it('should handle February with 28 days', () => {
        const february2026 = new Date('2026-02-15')
        const days = getCalendarDays(february2026)

        for (let day = 1; day <= 28; day++) {
          const found = days.some(
            (d: { date: Date }) =>
              d.date.getMonth() === 1 && d.date.getDate() === day && d.date.getFullYear() === 2026
          )
          expect(found).toBe(true)
        }
      })
    })

    describe('groupTasksByCalendarDate', () => {
      it('should group tasks by date key within range', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date('2026-01-14') }),
          createMockTask({ id: 't2', dueDate: new Date('2026-01-15') }),
          createMockTask({ id: 't3', dueDate: new Date('2026-01-14') })
        ]

        const start = new Date('2026-01-10')
        const end = new Date('2026-01-20')
        const grouped = groupTasksByCalendarDate(tasks, start, end)

        expect(grouped.get('2026-01-14')).toHaveLength(2)
        expect(grouped.get('2026-01-15')).toHaveLength(1)
      })

      it('should exclude tasks outside date range', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date('2026-01-05') }),
          createMockTask({ id: 't2', dueDate: new Date('2026-01-15') }),
          createMockTask({ id: 't3', dueDate: new Date('2026-01-25') })
        ]

        const start = new Date('2026-01-10')
        const end = new Date('2026-01-20')
        const grouped = groupTasksByCalendarDate(tasks, start, end)

        expect(grouped.get('2026-01-05')).toBeUndefined()
        expect(grouped.get('2026-01-15')).toHaveLength(1)
        expect(grouped.get('2026-01-25')).toBeUndefined()
      })

      it('should skip tasks without due date', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: null }),
          createMockTask({ id: 't2', dueDate: new Date('2026-01-15') })
        ]

        const start = new Date('2026-01-10')
        const end = new Date('2026-01-20')
        const grouped = groupTasksByCalendarDate(tasks, start, end)

        let totalTasks = 0
        grouped.forEach((tasksForDay: Task[]) => {
          totalTasks += tasksForDay.length
        })
        expect(totalTasks).toBe(1)
      })

      it('should sort tasks within each day', () => {
        const date = new Date('2026-01-15')
        const tasks = [
          createMockTask({ id: 't1', dueDate: date, dueTime: '15:00' }),
          createMockTask({ id: 't2', dueDate: date, dueTime: '09:00' }),
          createMockTask({ id: 't3', dueDate: date, dueTime: '12:00' })
        ]

        const start = new Date('2026-01-10')
        const end = new Date('2026-01-20')
        const grouped = groupTasksByCalendarDate(tasks, start, end)

        const dayTasks = grouped.get('2026-01-15')!
        expect(dayTasks.map((t: Task) => t.id)).toEqual(['t2', 't3', 't1'])
      })

      it('should include boundary dates (inclusive)', () => {
        // Use local date constructors to avoid timezone issues
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date(2026, 0, 10, 12) }),
          createMockTask({ id: 't2', dueDate: new Date(2026, 0, 20, 12) })
        ]

        const start = startOfDay(new Date(2026, 0, 10))
        const end = endOfDay(new Date(2026, 0, 20))
        const grouped = groupTasksByCalendarDate(tasks, start, end)

        expect(grouped.get('2026-01-10')).toHaveLength(1)
        expect(grouped.get('2026-01-20')).toHaveLength(1)
      })

      it('should return empty map for empty tasks', () => {
        const start = new Date('2026-01-10')
        const end = new Date('2026-01-20')
        const grouped = groupTasksByCalendarDate([], start, end)

        expect(grouped.size).toBe(0)
      })
    })
  })

  // ============================================================================
  // T082: TASK FILTERING - BASIC
  // ============================================================================

  describe('T082: Task Filtering - Basic', () => {
    describe('filterBySearch', () => {
      it('should filter by title match', () => {
        const tasks = [
          createMockTask({ id: 't1', title: 'Buy grocery items' }),
          createMockTask({ id: 't2', title: 'Go to gym' }),
          createMockTask({ id: 't3', title: 'Grocery shopping' })
        ]

        const filtered = filterBySearch(tasks, 'grocery')

        expect(filtered).toHaveLength(2)
        expect(filtered.some((t: Task) => t.id === 't1')).toBe(true)
        expect(filtered.some((t: Task) => t.id === 't3')).toBe(true)
      })

      it('should filter by description match', () => {
        const tasks = [
          createMockTask({ id: 't1', title: 'Task 1', description: 'Important meeting' }),
          createMockTask({ id: 't2', title: 'Task 2', description: 'Casual event' })
        ]

        const filtered = filterBySearch(tasks, 'meeting')

        expect(filtered).toHaveLength(1)
        expect(filtered[0].id).toBe('t1')
      })

      it('should be case-insensitive', () => {
        const tasks = [
          createMockTask({ id: 't1', title: 'URGENT Task' }),
          createMockTask({ id: 't2', title: 'urgent work' }),
          createMockTask({ id: 't3', title: 'Normal task' })
        ]

        const filtered = filterBySearch(tasks, 'URGENT')

        expect(filtered).toHaveLength(2)
      })

      it('should return all tasks for empty query', () => {
        const tasks = [createMockTask({ id: 't1' }), createMockTask({ id: 't2' })]

        expect(filterBySearch(tasks, '')).toHaveLength(2)
        expect(filterBySearch(tasks, '   ')).toHaveLength(2)
      })

      it('should match partial strings', () => {
        const tasks = [
          createMockTask({ id: 't1', title: 'Documentation' }),
          createMockTask({ id: 't2', title: 'Testing' })
        ]

        const filtered = filterBySearch(tasks, 'doc')

        expect(filtered).toHaveLength(1)
        expect(filtered[0].id).toBe('t1')
      })

      it('should handle special characters', () => {
        const tasks = [
          createMockTask({ id: 't1', title: 'Task (important)' }),
          createMockTask({ id: 't2', title: 'Task [urgent]' })
        ]

        const filtered = filterBySearch(tasks, '(important)')

        expect(filtered).toHaveLength(1)
      })

      it('should trim query whitespace', () => {
        const tasks = [createMockTask({ id: 't1', title: 'Test task' })]

        const filtered = filterBySearch(tasks, '  test  ')

        expect(filtered).toHaveLength(1)
      })

      it('should handle empty description', () => {
        const tasks = [createMockTask({ id: 't1', title: 'Task', description: '' })]

        expect(() => filterBySearch(tasks, 'something')).not.toThrow()
      })

      it('should match title OR description', () => {
        const tasks = [
          createMockTask({ id: 't1', title: 'Meeting', description: '' }),
          createMockTask({ id: 't2', title: 'Task', description: 'Schedule a meeting' })
        ]

        const filtered = filterBySearch(tasks, 'meeting')

        expect(filtered).toHaveLength(2)
      })
    })

    describe('filterByProjects', () => {
      it('should filter by single project', () => {
        const tasks = [
          createMockTask({ id: 't1', projectId: 'p1' }),
          createMockTask({ id: 't2', projectId: 'p2' }),
          createMockTask({ id: 't3', projectId: 'p1' })
        ]

        const filtered = filterByProjects(tasks, ['p1'])

        expect(filtered).toHaveLength(2)
        expect(filtered.every((t: Task) => t.projectId === 'p1')).toBe(true)
      })

      it('should filter by multiple projects', () => {
        const tasks = [
          createMockTask({ id: 't1', projectId: 'p1' }),
          createMockTask({ id: 't2', projectId: 'p2' }),
          createMockTask({ id: 't3', projectId: 'p3' })
        ]

        const filtered = filterByProjects(tasks, ['p1', 'p2'])

        expect(filtered).toHaveLength(2)
        expect(filtered.some((t: Task) => t.projectId === 'p1')).toBe(true)
        expect(filtered.some((t: Task) => t.projectId === 'p2')).toBe(true)
      })

      it('should return all tasks for empty project list', () => {
        const tasks = [
          createMockTask({ id: 't1', projectId: 'p1' }),
          createMockTask({ id: 't2', projectId: 'p2' })
        ]

        expect(filterByProjects(tasks, [])).toHaveLength(2)
      })

      it('should return empty array if no tasks match', () => {
        const tasks = [
          createMockTask({ id: 't1', projectId: 'p1' }),
          createMockTask({ id: 't2', projectId: 'p2' })
        ]

        expect(filterByProjects(tasks, ['p99'])).toHaveLength(0)
      })

      it('should handle empty tasks array', () => {
        expect(filterByProjects([], ['p1'])).toHaveLength(0)
      })
    })

    describe('scopeTasksByProject', () => {
      it('should return all tasks when projectId is null', () => {
        // #given
        const tasks = [
          createMockTask({ id: 't1', projectId: 'p1' }),
          createMockTask({ id: 't2', projectId: 'p2' }),
          createMockTask({ id: 't3', projectId: 'p1' })
        ]

        // #when
        const result = scopeTasksByProject(tasks, null)

        // #then
        expect(result).toHaveLength(3)
        expect(result).toEqual(tasks)
      })

      it('should filter to single project when projectId is set', () => {
        // #given
        const tasks = [
          createMockTask({ id: 't1', projectId: 'p1' }),
          createMockTask({ id: 't2', projectId: 'p2' }),
          createMockTask({ id: 't3', projectId: 'p1' })
        ]

        // #when
        const result = scopeTasksByProject(tasks, 'p1')

        // #then
        expect(result).toHaveLength(2)
        expect(result.every((t: Task) => t.projectId === 'p1')).toBe(true)
      })

      it('should scope completed tasks to project', () => {
        // #given — simulates Done tab scenario
        const now = new Date()
        const tasks = [
          createMockTask({ id: 't1', projectId: 'p1', completedAt: now }),
          createMockTask({ id: 't2', projectId: 'p2', completedAt: now }),
          createMockTask({ id: 't3', projectId: 'p1', completedAt: now }),
          createMockTask({ id: 't4', projectId: 'p2' })
        ]
        const completedTasks = getCompletedTasks(tasks)

        // #when
        const result = scopeTasksByProject(completedTasks, 'p1')

        // #then
        expect(result).toHaveLength(2)
        expect(result.every((t: Task) => t.projectId === 'p1')).toBe(true)
      })

      it('should return empty when no tasks match projectId', () => {
        const tasks = [
          createMockTask({ id: 't1', projectId: 'p1' }),
          createMockTask({ id: 't2', projectId: 'p2' })
        ]

        expect(scopeTasksByProject(tasks, 'p99')).toHaveLength(0)
      })

      it('should handle empty tasks array', () => {
        expect(scopeTasksByProject([], 'p1')).toHaveLength(0)
      })
    })

    describe('filterByPriorities', () => {
      it('should filter by single priority', () => {
        const tasks = [
          createMockTask({ id: 't1', priority: 'high' }),
          createMockTask({ id: 't2', priority: 'low' }),
          createMockTask({ id: 't3', priority: 'high' })
        ]

        const filtered = filterByPriorities(tasks, ['high'])

        expect(filtered).toHaveLength(2)
        expect(filtered.every((t: Task) => t.priority === 'high')).toBe(true)
      })

      it('should filter by multiple priorities', () => {
        const tasks = [
          createMockTask({ id: 't1', priority: 'urgent' }),
          createMockTask({ id: 't2', priority: 'high' }),
          createMockTask({ id: 't3', priority: 'low' }),
          createMockTask({ id: 't4', priority: 'none' })
        ]

        const filtered = filterByPriorities(tasks, ['urgent', 'high'])

        expect(filtered).toHaveLength(2)
      })

      it('should return all tasks for empty priority list', () => {
        const tasks = [
          createMockTask({ id: 't1', priority: 'high' }),
          createMockTask({ id: 't2', priority: 'low' })
        ]

        expect(filterByPriorities(tasks, [])).toHaveLength(2)
      })

      it('should handle all priority levels', () => {
        const tasks = [
          createMockTask({ id: 't1', priority: 'urgent' }),
          createMockTask({ id: 't2', priority: 'high' }),
          createMockTask({ id: 't3', priority: 'medium' }),
          createMockTask({ id: 't4', priority: 'low' }),
          createMockTask({ id: 't5', priority: 'none' })
        ]

        expect(filterByPriorities(tasks, ['urgent'])).toHaveLength(1)
        expect(filterByPriorities(tasks, ['high'])).toHaveLength(1)
        expect(filterByPriorities(tasks, ['medium'])).toHaveLength(1)
        expect(filterByPriorities(tasks, ['low'])).toHaveLength(1)
        expect(filterByPriorities(tasks, ['none'])).toHaveLength(1)
      })

      it('should handle empty tasks array', () => {
        expect(filterByPriorities([], ['high'])).toHaveLength(0)
      })
    })

    describe('filterByStatuses', () => {
      it('should filter by single status', () => {
        const tasks = [
          createMockTask({ id: 't1', statusId: 's1' }),
          createMockTask({ id: 't2', statusId: 's2' }),
          createMockTask({ id: 't3', statusId: 's1' })
        ]

        const filtered = filterByStatuses(tasks, ['s1'])

        expect(filtered).toHaveLength(2)
        expect(filtered.every((t: Task) => t.statusId === 's1')).toBe(true)
      })

      it('should filter by multiple statuses', () => {
        const tasks = [
          createMockTask({ id: 't1', statusId: 's1' }),
          createMockTask({ id: 't2', statusId: 's2' }),
          createMockTask({ id: 't3', statusId: 's3' })
        ]

        const filtered = filterByStatuses(tasks, ['s1', 's3'])

        expect(filtered).toHaveLength(2)
      })

      it('should return all tasks for empty status list', () => {
        const tasks = [
          createMockTask({ id: 't1', statusId: 's1' }),
          createMockTask({ id: 't2', statusId: 's2' })
        ]

        expect(filterByStatuses(tasks, [])).toHaveLength(2)
      })

      it('should return empty array if no tasks match', () => {
        const tasks = [createMockTask({ id: 't1', statusId: 's1' })]

        expect(filterByStatuses(tasks, ['s99'])).toHaveLength(0)
      })

      it('should handle empty tasks array', () => {
        expect(filterByStatuses([], ['s1'])).toHaveLength(0)
      })
    })
  })

  // ============================================================================
  // T083: TASK FILTERING - DATE & COMPLETION
  // ============================================================================

  describe('T083: Task Filtering - Date & Completion', () => {
    describe('filterByDueDateRange', () => {
      it('should return all tasks for "any" filter', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date('2026-01-15') }),
          createMockTask({ id: 't2', dueDate: null })
        ]

        const filter = { type: 'any' }
        expect(filterByDueDateRange(tasks, filter)).toHaveLength(2)
      })

      it('should filter tasks with no due date ("none")', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: null }),
          createMockTask({ id: 't2', dueDate: new Date('2026-01-15') }),
          createMockTask({ id: 't3', dueDate: null })
        ]

        const filter = { type: 'none' }
        const filtered = filterByDueDateRange(tasks, filter)

        expect(filtered).toHaveLength(2)
        expect(filtered.every((t: Task) => t.dueDate === null)).toBe(true)
      })

      it('should filter overdue tasks', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date('2026-01-10'), completedAt: null }),
          createMockTask({ id: 't2', dueDate: new Date('2026-01-14'), completedAt: null }),
          createMockTask({ id: 't3', dueDate: new Date('2026-01-15'), completedAt: null }),
          createMockTask({ id: 't4', dueDate: new Date('2026-01-10'), completedAt: new Date() })
        ]

        const filter = { type: 'overdue' }
        const filtered = filterByDueDateRange(tasks, filter)

        expect(filtered).toHaveLength(1)
        expect(filtered[0].id).toBe('t1')
      })

      it('should filter tasks due today', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date('2026-01-14T09:00:00Z') }),
          createMockTask({ id: 't2', dueDate: new Date('2026-01-14T18:00:00Z') }),
          createMockTask({ id: 't3', dueDate: new Date('2026-01-15') })
        ]

        const filter = { type: 'today' }
        const filtered = filterByDueDateRange(tasks, filter)

        expect(filtered).toHaveLength(2)
      })

      it('should filter tasks due tomorrow', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date('2026-01-14') }),
          createMockTask({ id: 't2', dueDate: new Date('2026-01-15') }),
          createMockTask({ id: 't3', dueDate: new Date('2026-01-16') })
        ]

        const filter = { type: 'tomorrow' }
        const filtered = filterByDueDateRange(tasks, filter)

        expect(filtered).toHaveLength(1)
        expect(filtered[0].id).toBe('t2')
      })

      it('should filter tasks due this week', () => {
        // Reference: Wed Jan 14, 2026. endOfWeek uses startOfDay (midnight), so use dates safely within range
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date(2026, 0, 13, 12) }), // Tue - before today
          createMockTask({ id: 't2', dueDate: new Date(2026, 0, 14, 12) }), // Wed - today
          createMockTask({ id: 't3', dueDate: new Date(2026, 0, 16, 12) }), // Fri - within week
          createMockTask({ id: 't4', dueDate: new Date(2026, 0, 19, 12) }) // Mon - next week
        ]

        const filter = { type: 'this-week' as const }
        const filtered = filterByDueDateRange(tasks, filter)

        expect(filtered.some((t: Task) => t.id === 't2')).toBe(true)
        expect(filtered.some((t: Task) => t.id === 't3')).toBe(true)
        expect(filtered.some((t: Task) => t.id === 't1')).toBe(false) // before today
        expect(filtered.some((t: Task) => t.id === 't4')).toBe(false) // next week
      })

      it('should filter tasks due next week', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date('2026-01-17') }),
          createMockTask({ id: 't2', dueDate: new Date('2026-01-19') }),
          createMockTask({ id: 't3', dueDate: new Date('2026-01-22') }),
          createMockTask({ id: 't4', dueDate: new Date('2026-01-26') })
        ]

        const filter = { type: 'next-week' }
        const filtered = filterByDueDateRange(tasks, filter)

        expect(filtered.some((t: Task) => t.id === 't2')).toBe(true)
        expect(filtered.some((t: Task) => t.id === 't3')).toBe(true)
      })

      it('should filter tasks due this month', () => {
        // endOfMonth returns startOfDay, so use a date well within the range
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date(2026, 0, 14, 12) }), // Today
          createMockTask({ id: 't2', dueDate: new Date(2026, 0, 25, 12) }), // Middle of month
          createMockTask({ id: 't3', dueDate: new Date(2026, 1, 1, 12) }) // Next month
        ]

        const filter = { type: 'this-month' as const }
        const filtered = filterByDueDateRange(tasks, filter)

        expect(filtered).toHaveLength(2)
        expect(filtered.some((t: Task) => t.id === 't1')).toBe(true)
        expect(filtered.some((t: Task) => t.id === 't2')).toBe(true)
        expect(filtered.some((t: Task) => t.id === 't3')).toBe(false)
      })

      it('should filter tasks in custom date range', () => {
        const tasks = [
          createMockTask({ id: 't1', dueDate: new Date('2026-01-10') }),
          createMockTask({ id: 't2', dueDate: new Date('2026-01-15') }),
          createMockTask({ id: 't3', dueDate: new Date('2026-01-20') }),
          createMockTask({ id: 't4', dueDate: new Date('2026-01-25') })
        ]

        const filter = {
          type: 'custom',
          customStart: new Date('2026-01-14'),
          customEnd: new Date('2026-01-21')
        }
        const filtered = filterByDueDateRange(tasks, filter)

        expect(filtered).toHaveLength(2)
        expect(filtered.some((t: Task) => t.id === 't2')).toBe(true)
        expect(filtered.some((t: Task) => t.id === 't3')).toBe(true)
      })

      it('should return all tasks if custom range has no dates', () => {
        const tasks = [createMockTask({ id: 't1', dueDate: new Date('2026-01-15') })]

        const filter = {
          type: 'custom',
          customStart: null,
          customEnd: null
        }
        const filtered = filterByDueDateRange(tasks, filter)

        expect(filtered).toHaveLength(1)
      })

      it('should handle empty tasks array', () => {
        expect(filterByDueDateRange([], { type: 'today' })).toHaveLength(0)
      })
    })

    describe('filterByCompletion', () => {
      const completionProjects = [
        createMockProject({
          id: 'p1',
          statuses: [
            createMockStatus({ id: 's-todo', type: 'todo' }),
            createMockStatus({ id: 's-done', type: 'done' })
          ]
        })
      ]

      it('should filter active tasks (not completed, not archived)', () => {
        const tasks = [
          createMockTask({ id: 't1', projectId: 'p1', statusId: 's-todo' }),
          createMockTask({ id: 't2', projectId: 'p1', statusId: 's-done' }),
          createMockTask({ id: 't3', projectId: 'p1', statusId: 's-todo', archivedAt: new Date() })
        ]

        const filtered = filterByCompletion(tasks, 'active', completionProjects)

        expect(filtered).toHaveLength(1)
        expect(filtered[0].id).toBe('t1')
      })

      it('should filter completed tasks', () => {
        const tasks = [
          createMockTask({ id: 't1', projectId: 'p1', statusId: 's-todo' }),
          createMockTask({ id: 't2', projectId: 'p1', statusId: 's-done' }),
          createMockTask({ id: 't3', projectId: 'p1', statusId: 's-done' })
        ]

        const filtered = filterByCompletion(tasks, 'completed', completionProjects)

        expect(filtered).toHaveLength(2)
        expect(filtered.every((t: Task) => t.statusId === 's-done')).toBe(true)
      })

      it('should return all non-archived tasks for "all"', () => {
        const tasks = [
          createMockTask({ id: 't1', projectId: 'p1', statusId: 's-todo' }),
          createMockTask({ id: 't2', projectId: 'p1', statusId: 's-done' }),
          createMockTask({ id: 't3', projectId: 'p1', statusId: 's-todo', archivedAt: new Date() })
        ]

        const filtered = filterByCompletion(tasks, 'all', completionProjects)

        expect(filtered).toHaveLength(2)
      })

      it('should always exclude archived tasks', () => {
        const tasks = [
          createMockTask({ id: 't1', projectId: 'p1', statusId: 's-todo', archivedAt: new Date() }),
          createMockTask({ id: 't2', projectId: 'p1', statusId: 's-done', archivedAt: new Date() })
        ]

        expect(filterByCompletion(tasks, 'active', completionProjects)).toHaveLength(0)
        expect(filterByCompletion(tasks, 'completed', completionProjects)).toHaveLength(0)
        expect(filterByCompletion(tasks, 'all', completionProjects)).toHaveLength(0)
      })

      it('should handle empty tasks array', () => {
        expect(filterByCompletion([], 'active', completionProjects)).toHaveLength(0)
      })

      it('should handle empty projects array', () => {
        const tasks = [createMockTask({ id: 't1', projectId: 'p1', statusId: 's-todo' })]

        const filtered = filterByCompletion(tasks, 'active', [])
        expect(filtered).toHaveLength(1)
      })
    })

    describe('filterByRepeatType', () => {
      it('should filter repeating tasks', () => {
        const tasks = [
          createMockTask({ id: 't1', isRepeating: true }),
          createMockTask({ id: 't2', isRepeating: false }),
          createMockTask({ id: 't3', isRepeating: true })
        ]

        const filtered = filterByRepeatType(tasks, 'repeating')

        expect(filtered).toHaveLength(2)
        expect(filtered.every((t: Task) => t.isRepeating)).toBe(true)
      })

      it('should filter one-time tasks', () => {
        const tasks = [
          createMockTask({ id: 't1', isRepeating: true }),
          createMockTask({ id: 't2', isRepeating: false }),
          createMockTask({ id: 't3', isRepeating: false })
        ]

        const filtered = filterByRepeatType(tasks, 'one-time')

        expect(filtered).toHaveLength(2)
        expect(filtered.every((t: Task) => !t.isRepeating)).toBe(true)
      })

      it('should return all tasks for "all"', () => {
        const tasks = [
          createMockTask({ id: 't1', isRepeating: true }),
          createMockTask({ id: 't2', isRepeating: false })
        ]

        const filtered = filterByRepeatType(tasks, 'all')

        expect(filtered).toHaveLength(2)
      })

      it('should handle empty tasks array', () => {
        expect(filterByRepeatType([], 'repeating')).toHaveLength(0)
      })

      it('should handle all tasks being repeating', () => {
        const tasks = [
          createMockTask({ id: 't1', isRepeating: true }),
          createMockTask({ id: 't2', isRepeating: true })
        ]

        expect(filterByRepeatType(tasks, 'repeating')).toHaveLength(2)
        expect(filterByRepeatType(tasks, 'one-time')).toHaveLength(0)
      })
    })

    describe('filterByHasTime', () => {
      it('should filter tasks with time set', () => {
        const tasks = [
          createMockTask({ id: 't1', dueTime: '14:30' }),
          createMockTask({ id: 't2', dueTime: null }),
          createMockTask({ id: 't3', dueTime: '09:00' })
        ]

        const filtered = filterByHasTime(tasks, 'with-time')

        expect(filtered).toHaveLength(2)
        expect(filtered.every((t: Task) => t.dueTime !== null)).toBe(true)
      })

      it('should filter tasks without time', () => {
        const tasks = [
          createMockTask({ id: 't1', dueTime: '14:30' }),
          createMockTask({ id: 't2', dueTime: null }),
          createMockTask({ id: 't3', dueTime: null })
        ]

        const filtered = filterByHasTime(tasks, 'without-time')

        expect(filtered).toHaveLength(2)
        expect(filtered.every((t: Task) => t.dueTime === null)).toBe(true)
      })

      it('should return all tasks for "all"', () => {
        const tasks = [
          createMockTask({ id: 't1', dueTime: '14:30' }),
          createMockTask({ id: 't2', dueTime: null })
        ]

        const filtered = filterByHasTime(tasks, 'all')

        expect(filtered).toHaveLength(2)
      })

      it('should handle empty tasks array', () => {
        expect(filterByHasTime([], 'with-time')).toHaveLength(0)
      })

      it('should handle various time formats', () => {
        const tasks = [
          createMockTask({ id: 't1', dueTime: '00:00' }),
          createMockTask({ id: 't2', dueTime: '23:59' }),
          createMockTask({ id: 't3', dueTime: '12:00' })
        ]

        expect(filterByHasTime(tasks, 'with-time')).toHaveLength(3)
      })
    })

    describe('Combined filtering edge cases', () => {
      it('should handle empty task array for all filters', () => {
        const proj = [createMockProject({ id: 'p1' })]

        expect(filterByDueDateRange([], { type: 'today' })).toEqual([])
        expect(filterByCompletion([], 'active', proj)).toEqual([])
        expect(filterByRepeatType([], 'repeating')).toEqual([])
        expect(filterByHasTime([], 'with-time')).toEqual([])
      })

      it('should handle single task for all filters', () => {
        const proj = [createMockProject({ id: 'project-1' })]
        const task = createMockTask({
          id: 't1',
          projectId: 'project-1',
          statusId: 'status-todo',
          dueDate: new Date('2026-01-14'),
          dueTime: '10:00',
          isRepeating: true
        })

        expect(filterByDueDateRange([task], { type: 'today' })).toHaveLength(1)
        expect(filterByRepeatType([task], 'repeating')).toHaveLength(1)
        expect(filterByHasTime([task], 'with-time')).toHaveLength(1)
      })
    })
  })

  // ============================================================================
  // T084: TASK FILTERING - MAIN FILTER FUNCTION
  // ============================================================================

  describe('T084: Task Filtering - Main Filter Function', () => {
    describe('getFilteredTasks', () => {
      let project: Project
      let projects: Project[]

      beforeEach(() => {
        project = createMockProject({ id: 'project-1' })
        projects = [project]
      })

      describe("View filtering: 'all' view", () => {
        it("should return all incomplete tasks for 'all' view", () => {
          const tasks = [
            createMockTask({ id: 't1', projectId: 'project-1', statusId: 'status-todo' }),
            createMockTask({ id: 't2', projectId: 'project-1', statusId: 'status-in-progress' })
          ]

          const result = getFilteredTasks(tasks, 'all', 'view', projects)

          expect(result).toHaveLength(2)
          expect(result.map((t) => t.id)).toContain('t1')
          expect(result.map((t) => t.id)).toContain('t2')
        })

        it("should exclude completed tasks from 'all' view", () => {
          const tasks = [
            createMockTask({ id: 't1', projectId: 'project-1', statusId: 'status-todo' }),
            createMockTask({
              id: 't2',
              projectId: 'project-1',
              statusId: 'status-done',
              completedAt: new Date('2026-01-13')
            })
          ]

          const result = getFilteredTasks(tasks, 'all', 'view', projects)

          expect(result).toHaveLength(1)
          expect(result[0].id).toBe('t1')
        })

        it('should always exclude archived tasks', () => {
          const tasks = [
            createMockTask({ id: 't1', projectId: 'project-1', statusId: 'status-todo' }),
            createMockTask({
              id: 't2',
              projectId: 'project-1',
              statusId: 'status-todo',
              archivedAt: new Date('2026-01-10')
            })
          ]

          const result = getFilteredTasks(tasks, 'all', 'view', projects)

          expect(result).toHaveLength(1)
          expect(result[0].id).toBe('t1')
        })
      })

      describe("View filtering: 'today' view", () => {
        it('should return tasks due today', () => {
          const tasks = [
            createMockTask({
              id: 't1',
              projectId: 'project-1',
              statusId: 'status-todo',
              dueDate: new Date('2026-01-14')
            }),
            createMockTask({
              id: 't2',
              projectId: 'project-1',
              statusId: 'status-todo',
              dueDate: new Date('2026-01-15')
            })
          ]

          const result = getFilteredTasks(tasks, 'today', 'view', projects)

          expect(result).toHaveLength(1)
          expect(result[0].id).toBe('t1')
        })

        it("should include overdue tasks in 'today' view", () => {
          const tasks = [
            createMockTask({
              id: 't1',
              projectId: 'project-1',
              statusId: 'status-todo',
              dueDate: new Date('2026-01-10')
            }),
            createMockTask({
              id: 't2',
              projectId: 'project-1',
              statusId: 'status-todo',
              dueDate: new Date('2026-01-14')
            })
          ]

          const result = getFilteredTasks(tasks, 'today', 'view', projects)

          expect(result).toHaveLength(2)
          expect(result.map((t) => t.id)).toContain('t1')
          expect(result.map((t) => t.id)).toContain('t2')
        })

        it("should not include tasks without due date in 'today' view", () => {
          const tasks = [
            createMockTask({
              id: 't1',
              projectId: 'project-1',
              statusId: 'status-todo',
              dueDate: null
            }),
            createMockTask({
              id: 't2',
              projectId: 'project-1',
              statusId: 'status-todo',
              dueDate: new Date('2026-01-14')
            })
          ]

          const result = getFilteredTasks(tasks, 'today', 'view', projects)

          expect(result).toHaveLength(1)
          expect(result[0].id).toBe('t2')
        })

        it("should exclude completed tasks from 'today' view", () => {
          const tasks = [
            createMockTask({
              id: 't1',
              projectId: 'project-1',
              statusId: 'status-done',
              dueDate: new Date('2026-01-14'),
              completedAt: new Date()
            })
          ]

          const result = getFilteredTasks(tasks, 'today', 'view', projects)

          expect(result).toHaveLength(0)
        })
      })

      describe("View filtering: 'upcoming' view", () => {
        it('should return tasks due tomorrow through 7 days ahead', () => {
          const tasks = [
            createMockTask({
              id: 't1',
              projectId: 'project-1',
              statusId: 'status-todo',
              dueDate: new Date('2026-01-15')
            }),
            createMockTask({
              id: 't2',
              projectId: 'project-1',
              statusId: 'status-todo',
              dueDate: new Date('2026-01-20')
            }),
            createMockTask({
              id: 't3',
              projectId: 'project-1',
              statusId: 'status-todo',
              dueDate: new Date('2026-01-21')
            }),
            createMockTask({
              id: 't4',
              projectId: 'project-1',
              statusId: 'status-todo',
              dueDate: new Date('2026-01-22')
            })
          ]

          const result = getFilteredTasks(tasks, 'upcoming', 'view', projects)

          expect(result).toHaveLength(3)
          expect(result.map((t) => t.id)).toContain('t1')
          expect(result.map((t) => t.id)).toContain('t2')
          expect(result.map((t) => t.id)).toContain('t3')
          expect(result.map((t) => t.id)).not.toContain('t4')
        })

        it("should not include today in 'upcoming' view", () => {
          const tasks = [
            createMockTask({
              id: 't1',
              projectId: 'project-1',
              statusId: 'status-todo',
              dueDate: new Date('2026-01-14')
            }),
            createMockTask({
              id: 't2',
              projectId: 'project-1',
              statusId: 'status-todo',
              dueDate: new Date('2026-01-15')
            })
          ]

          const result = getFilteredTasks(tasks, 'upcoming', 'view', projects)

          expect(result).toHaveLength(1)
          expect(result[0].id).toBe('t2')
        })

        it("should not include overdue tasks in 'upcoming' view", () => {
          const tasks = [
            createMockTask({
              id: 't1',
              projectId: 'project-1',
              statusId: 'status-todo',
              dueDate: new Date('2026-01-10')
            }),
            createMockTask({
              id: 't2',
              projectId: 'project-1',
              statusId: 'status-todo',
              dueDate: new Date('2026-01-15')
            })
          ]

          const result = getFilteredTasks(tasks, 'upcoming', 'view', projects)

          expect(result).toHaveLength(1)
          expect(result[0].id).toBe('t2')
        })
      })

      describe("View filtering: 'completed' view", () => {
        it('should return only completed tasks', () => {
          const tasks = [
            createMockTask({ id: 't1', projectId: 'project-1', statusId: 'status-todo' }),
            createMockTask({
              id: 't2',
              projectId: 'project-1',
              statusId: 'status-done',
              completedAt: new Date('2026-01-13')
            })
          ]

          const result = getFilteredTasks(tasks, 'completed', 'view', projects)

          expect(result).toHaveLength(1)
          expect(result[0].id).toBe('t2')
        })

        it("should exclude archived tasks from 'completed' view", () => {
          const tasks = [
            createMockTask({
              id: 't1',
              projectId: 'project-1',
              statusId: 'status-done',
              completedAt: new Date('2026-01-13')
            }),
            createMockTask({
              id: 't2',
              projectId: 'project-1',
              statusId: 'status-done',
              completedAt: new Date('2026-01-12'),
              archivedAt: new Date('2026-01-13')
            })
          ]

          const result = getFilteredTasks(tasks, 'completed', 'view', projects)

          expect(result).toHaveLength(1)
          expect(result[0].id).toBe('t1')
        })
      })

      describe('Project filtering', () => {
        it("should return all tasks for selected project when selectedType is 'project'", () => {
          const project2 = createMockProject({ id: 'project-2', name: 'Project 2' })
          const allProjects = [project, project2]

          const tasks = [
            createMockTask({ id: 't1', projectId: 'project-1', statusId: 'status-todo' }),
            createMockTask({ id: 't2', projectId: 'project-2', statusId: 'status-todo' }),
            createMockTask({
              id: 't3',
              projectId: 'project-1',
              statusId: 'status-done',
              completedAt: new Date()
            })
          ]

          const result = getFilteredTasks(tasks, 'project-1', 'project', allProjects)

          expect(result).toHaveLength(2)
          expect(result.every((t) => t.projectId === 'project-1')).toBe(true)
        })

        it('should include both completed and incomplete tasks for project view', () => {
          const tasks = [
            createMockTask({ id: 't1', projectId: 'project-1', statusId: 'status-todo' }),
            createMockTask({
              id: 't2',
              projectId: 'project-1',
              statusId: 'status-done',
              completedAt: new Date()
            })
          ]

          const result = getFilteredTasks(tasks, 'project-1', 'project', projects)

          expect(result).toHaveLength(2)
        })

        it('should still exclude archived tasks from project view', () => {
          const tasks = [
            createMockTask({ id: 't1', projectId: 'project-1', statusId: 'status-todo' }),
            createMockTask({
              id: 't2',
              projectId: 'project-1',
              statusId: 'status-todo',
              archivedAt: new Date('2026-01-10')
            })
          ]

          const result = getFilteredTasks(tasks, 'project-1', 'project', projects)

          expect(result).toHaveLength(1)
          expect(result[0].id).toBe('t1')
        })
      })

      describe('Subtask inclusion', () => {
        it('should include subtasks when parent matches filter', () => {
          const parentTask = createMockTask({
            id: 'parent-1',
            projectId: 'project-1',
            statusId: 'status-todo',
            subtaskIds: ['subtask-1', 'subtask-2']
          })
          const subtask1 = createMockTask({
            id: 'subtask-1',
            projectId: 'project-1',
            statusId: 'status-todo',
            parentId: 'parent-1'
          })
          const subtask2 = createMockTask({
            id: 'subtask-2',
            projectId: 'project-1',
            statusId: 'status-done',
            parentId: 'parent-1',
            completedAt: new Date()
          })

          const tasks = [parentTask, subtask1, subtask2]
          const result = getFilteredTasks(tasks, 'all', 'view', projects)

          expect(result.map((t) => t.id)).toContain('parent-1')
          expect(result.map((t) => t.id)).toContain('subtask-1')
          expect(result.map((t) => t.id)).toContain('subtask-2')
        })

        it('should not include orphan subtasks when parent does not match filter', () => {
          const parentTask = createMockTask({
            id: 'parent-1',
            projectId: 'project-1',
            statusId: 'status-done',
            completedAt: new Date(),
            subtaskIds: ['subtask-1']
          })
          const subtask1 = createMockTask({
            id: 'subtask-1',
            projectId: 'project-1',
            statusId: 'status-todo',
            parentId: 'parent-1'
          })

          const tasks = [parentTask, subtask1]
          const result = getFilteredTasks(tasks, 'all', 'view', projects)

          expect(result.map((t) => t.id)).not.toContain('parent-1')
          expect(result.map((t) => t.id)).not.toContain('subtask-1')
        })
      })

      describe('Edge cases', () => {
        it('should return empty array when no tasks provided', () => {
          const result = getFilteredTasks([], 'all', 'view', projects)
          expect(result).toHaveLength(0)
        })

        it('should handle unknown view ID gracefully (defaults to incomplete)', () => {
          const tasks = [
            createMockTask({ id: 't1', projectId: 'project-1', statusId: 'status-todo' })
          ]

          const result = getFilteredTasks(tasks, 'unknown-view', 'view', projects)

          expect(result).toHaveLength(1)
        })

        it('should handle task with unknown project gracefully', () => {
          const tasks = [
            createMockTask({ id: 't1', projectId: 'unknown-project', statusId: 'status-todo' })
          ]

          const result = getFilteredTasks(tasks, 'all', 'view', projects)

          expect(result).toHaveLength(1)
        })

        it('should handle empty projects array', () => {
          const tasks = [
            createMockTask({ id: 't1', projectId: 'project-1', statusId: 'status-todo' })
          ]

          const result = getFilteredTasks(tasks, 'all', 'view', [])

          expect(result).toHaveLength(1)
        })
      })
    })
  })

  // ============================================================================
  // T085: TASK COUNTS & FORMATTING
  // ============================================================================

  describe('T085: Task Counts & Formatting', () => {
    describe('getTaskCounts', () => {
      let project: Project
      let projects: Project[]

      beforeEach(() => {
        project = createMockProject({ id: 'project-1' })
        projects = [project]
      })

      it('should count total incomplete tasks', () => {
        const tasks = [
          createMockTask({ id: 't1', projectId: 'project-1', statusId: 'status-todo' }),
          createMockTask({ id: 't2', projectId: 'project-1', statusId: 'status-in-progress' }),
          createMockTask({
            id: 't3',
            projectId: 'project-1',
            statusId: 'status-done',
            completedAt: new Date()
          })
        ]

        const counts = getTaskCounts(tasks, 'all', 'view', projects)

        expect(counts.total).toBe(2)
      })

      it('should count tasks due today', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-14')
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-15')
          }),
          createMockTask({
            id: 't3',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-14')
          })
        ]

        const counts = getTaskCounts(tasks, 'all', 'view', projects)

        expect(counts.dueToday).toBe(2)
      })

      it('should count overdue tasks', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-10')
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-13')
          }),
          createMockTask({
            id: 't3',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-14')
          })
        ]

        const counts = getTaskCounts(tasks, 'all', 'view', projects)

        expect(counts.overdue).toBe(2)
      })

      it('should count completed tasks', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-done',
            completedAt: new Date()
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-done',
            completedAt: new Date()
          }),
          createMockTask({ id: 't3', projectId: 'project-1', statusId: 'status-todo' })
        ]

        const counts = getTaskCounts(tasks, 'completed', 'view', projects)

        expect(counts.completed).toBe(2)
      })

      it('should return zeros for empty task list', () => {
        const counts = getTaskCounts([], 'all', 'view', projects)

        expect(counts.total).toBe(0)
        expect(counts.dueToday).toBe(0)
        expect(counts.overdue).toBe(0)
        expect(counts.completed).toBe(0)
      })

      it('should respect project filter in counts', () => {
        const project2 = createMockProject({ id: 'project-2' })
        const allProjects = [project, project2]

        const tasks = [
          createMockTask({ id: 't1', projectId: 'project-1', statusId: 'status-todo' }),
          createMockTask({ id: 't2', projectId: 'project-2', statusId: 'status-todo' })
        ]

        const counts = getTaskCounts(tasks, 'project-1', 'project', allProjects)

        expect(counts.total).toBe(1)
      })
    })

    describe('formatTaskSubtitle', () => {
      describe('View subtitles', () => {
        it("should format 'all' view subtitle with only total", () => {
          const counts = { total: 10, dueToday: 0, overdue: 0, completed: 0 }
          const result = formatTaskSubtitle(counts, 'all', 'view')
          expect(result).toBe('10 tasks')
        })

        it("should format 'all' view subtitle with due today", () => {
          const counts = { total: 10, dueToday: 3, overdue: 0, completed: 0 }
          const result = formatTaskSubtitle(counts, 'all', 'view')
          expect(result).toContain('10 tasks')
          expect(result).toContain('3 due today')
        })

        it("should format 'all' view subtitle with overdue", () => {
          const counts = { total: 10, dueToday: 0, overdue: 2, completed: 0 }
          const result = formatTaskSubtitle(counts, 'all', 'view')
          expect(result).toContain('10 tasks')
          expect(result).toContain('2 overdue')
        })

        it("should format 'all' view subtitle with both due today and overdue", () => {
          const counts = { total: 10, dueToday: 3, overdue: 2, completed: 0 }
          const result = formatTaskSubtitle(counts, 'all', 'view')
          expect(result).toContain('10 tasks')
          expect(result).toContain('3 due today')
          expect(result).toContain('2 overdue')
        })

        it("should format 'today' view subtitle", () => {
          const counts = { total: 5, dueToday: 5, overdue: 2, completed: 0 }
          const result = formatTaskSubtitle(counts, 'today', 'view')
          expect(result).toContain('7 tasks due')
          expect(result).toContain('2 overdue')
        })

        it("should format 'today' view subtitle without overdue", () => {
          const counts = { total: 5, dueToday: 5, overdue: 0, completed: 0 }
          const result = formatTaskSubtitle(counts, 'today', 'view')
          expect(result).toBe('5 tasks due')
        })

        it("should format 'upcoming' view subtitle", () => {
          const counts = { total: 8, dueToday: 0, overdue: 0, completed: 0 }
          const result = formatTaskSubtitle(counts, 'upcoming', 'view')
          expect(result).toBe('8 tasks in the next 7 days')
        })

        it("should format 'completed' view subtitle", () => {
          const counts = { total: 0, dueToday: 0, overdue: 0, completed: 45 }
          const result = formatTaskSubtitle(counts, 'completed', 'view')
          expect(result).toBe('45 tasks completed')
        })

        it('should format unknown view with default subtitle', () => {
          const counts = { total: 5, dueToday: 0, overdue: 0, completed: 0 }
          const result = formatTaskSubtitle(counts, 'unknown', 'view')
          expect(result).toBe('5 tasks')
        })
      })

      describe('Project subtitles', () => {
        it('should format project subtitle with only total', () => {
          const counts = { total: 15, dueToday: 0, overdue: 0, completed: 0 }
          const result = formatTaskSubtitle(counts, 'project-1', 'project')
          expect(result).toBe('15 tasks')
        })

        it('should format project subtitle with due today', () => {
          const counts = { total: 15, dueToday: 4, overdue: 0, completed: 0 }
          const result = formatTaskSubtitle(counts, 'project-1', 'project')
          expect(result).toContain('15 tasks')
          expect(result).toContain('4 due today')
        })
      })
    })
  })

  // ============================================================================
  // T086: TODAY & UPCOMING VIEW HELPERS
  // ============================================================================

  describe('T086: Today & Upcoming View Helpers', () => {
    describe('getTodayTasks', () => {
      let project: Project
      let projects: Project[]

      beforeEach(() => {
        project = createMockProject({ id: 'project-1' })
        projects = [project]
      })

      it('should separate overdue and today tasks', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-10')
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-14')
          }),
          createMockTask({
            id: 't3',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-14T15:00:00Z')
          })
        ]

        const result = getTodayTasks(tasks, projects)

        expect(result.overdue).toHaveLength(1)
        expect(result.overdue[0].id).toBe('t1')
        expect(result.today).toHaveLength(2)
        expect(result.today.map((t) => t.id)).toContain('t2')
        expect(result.today.map((t) => t.id)).toContain('t3')
      })

      it('should exclude completed tasks', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-done',
            dueDate: new Date('2026-01-14'),
            completedAt: new Date()
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-14')
          })
        ]

        const result = getTodayTasks(tasks, projects)

        expect(result.today).toHaveLength(1)
        expect(result.today[0].id).toBe('t2')
      })

      it('should exclude tasks without due date', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: null
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-14')
          })
        ]

        const result = getTodayTasks(tasks, projects)

        expect(result.today).toHaveLength(1)
        expect(result.overdue).toHaveLength(0)
      })

      it('should exclude future tasks', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-15')
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-14')
          })
        ]

        const result = getTodayTasks(tasks, projects)

        expect(result.today).toHaveLength(1)
        expect(result.today[0].id).toBe('t2')
      })

      it('should return empty arrays when no matching tasks', () => {
        const result = getTodayTasks([], projects)

        expect(result.overdue).toHaveLength(0)
        expect(result.today).toHaveLength(0)
      })
    })

    describe('getTodayWithWeekTasks', () => {
      let project: Project
      let projects: Project[]

      beforeEach(() => {
        project = createMockProject({ id: 'project-1' })
        projects = [project]
      })

      it('should separate overdue, today, and week-by-day tasks', () => {
        // #given
        const now = new Date()
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const yesterday = new Date(todayStart)
        yesterday.setDate(yesterday.getDate() - 1)
        const tomorrow = new Date(todayStart)
        tomorrow.setDate(tomorrow.getDate() + 1)
        const dayAfterTomorrow = new Date(todayStart)
        dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 2)

        const tasks = [
          createMockTask({
            id: 'overdue-1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: yesterday
          }),
          createMockTask({
            id: 'today-1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: todayStart
          }),
          createMockTask({
            id: 'tomorrow-1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: tomorrow
          }),
          createMockTask({
            id: 'day-after-1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: dayAfterTomorrow
          })
        ]

        // #when
        const result = getTodayWithWeekTasks(tasks, projects)

        // #then
        expect(result.overdue).toHaveLength(1)
        expect(result.overdue[0].id).toBe('overdue-1')

        expect(result.today).toHaveLength(1)
        expect(result.today[0].id).toBe('today-1')

        const tomorrowKey = formatDateKey(tomorrow)
        const dayAfterKey = formatDateKey(dayAfterTomorrow)
        expect(result.weekByDay.get(tomorrowKey)).toHaveLength(1)
        expect(result.weekByDay.get(tomorrowKey)![0].id).toBe('tomorrow-1')
        expect(result.weekByDay.get(dayAfterKey)).toHaveLength(1)
        expect(result.weekByDay.get(dayAfterKey)![0].id).toBe('day-after-1')
      })

      it('should not include today tasks in weekByDay', () => {
        // #given
        const now = new Date()
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const todayKey = formatDateKey(todayStart)

        const tasks = [
          createMockTask({
            id: 'today-1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: todayStart
          })
        ]

        // #when
        const result = getTodayWithWeekTasks(tasks, projects)

        // #then
        expect(result.today).toHaveLength(1)
        expect(result.weekByDay.has(todayKey)).toBe(false)
      })

      it('should exclude completed tasks', () => {
        // #given
        const now = new Date()
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const tomorrow = new Date(todayStart)
        tomorrow.setDate(tomorrow.getDate() + 1)

        const tasks = [
          createMockTask({
            id: 'done-1',
            projectId: 'project-1',
            statusId: 'status-done',
            dueDate: tomorrow,
            completedAt: new Date()
          }),
          createMockTask({
            id: 'active-1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: tomorrow
          })
        ]

        // #when
        const result = getTodayWithWeekTasks(tasks, projects)
        const tomorrowKey = formatDateKey(tomorrow)

        // #then
        expect(result.weekByDay.get(tomorrowKey)).toHaveLength(1)
        expect(result.weekByDay.get(tomorrowKey)![0].id).toBe('active-1')
      })

      it('should exclude tasks beyond the week range', () => {
        // #given
        const now = new Date()
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const farFuture = new Date(todayStart)
        farFuture.setDate(farFuture.getDate() + 10)

        const tasks = [
          createMockTask({
            id: 'far-1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: farFuture
          })
        ]

        // #when
        const result = getTodayWithWeekTasks(tasks, projects)

        // #then
        let totalWeekTasks = 0
        result.weekByDay.forEach((dayTasks) => {
          totalWeekTasks += dayTasks.length
        })
        expect(totalWeekTasks).toBe(0)
      })

      it('should create empty arrays for all week days even with no tasks', () => {
        // #given — no tasks at all

        // #when
        const result = getTodayWithWeekTasks([], projects)

        // #then — should have 6 day entries (default weekDays=6)
        expect(result.weekByDay.size).toBe(6)
        result.weekByDay.forEach((dayTasks) => {
          expect(dayTasks).toHaveLength(0)
        })
      })

      it('should respect custom weekDays parameter', () => {
        // #given — weekDays=3

        // #when
        const result = getTodayWithWeekTasks([], projects, 3)

        // #then
        expect(result.weekByDay.size).toBe(3)
      })
    })

    describe('getUpcomingTasks', () => {
      let project: Project
      let projects: Project[]

      beforeEach(() => {
        project = createMockProject({ id: 'project-1' })
        projects = [project]
      })

      it('should return overdue tasks separately', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-10')
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-15')
          })
        ]

        const result = getUpcomingTasks(tasks, projects, 7)

        expect(result.overdue).toHaveLength(1)
        expect(result.overdue[0].id).toBe('t1')
      })

      it('should group tasks by day for the next N days', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-14')
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-15')
          }),
          createMockTask({
            id: 't3',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-15')
          }),
          createMockTask({
            id: 't4',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-16')
          })
        ]

        const result = getUpcomingTasks(tasks, projects, 7)

        expect(result.byDay.get('2026-01-14')).toHaveLength(1)
        expect(result.byDay.get('2026-01-15')).toHaveLength(2)
        expect(result.byDay.get('2026-01-16')).toHaveLength(1)
      })

      it('should initialize empty arrays for days without tasks', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-16')
          })
        ]

        const result = getUpcomingTasks(tasks, projects, 7)

        expect(result.byDay.get('2026-01-14')).toHaveLength(0)
        expect(result.byDay.get('2026-01-15')).toHaveLength(0)
        expect(result.byDay.get('2026-01-16')).toHaveLength(1)
      })

      it('should exclude tasks beyond the range', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-25')
          })
        ]

        const result = getUpcomingTasks(tasks, projects, 7)

        expect(result.byDay.has('2026-01-25')).toBe(false)
      })

      it('should exclude completed tasks', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-done',
            dueDate: new Date('2026-01-15'),
            completedAt: new Date()
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-15')
          })
        ]

        const result = getUpcomingTasks(tasks, projects, 7)

        expect(result.byDay.get('2026-01-15')).toHaveLength(1)
        expect(result.byDay.get('2026-01-15')![0].id).toBe('t2')
      })

      it('should respect custom daysAhead parameter', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-14')
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-15')
          }),
          createMockTask({
            id: 't3',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-16')
          })
        ]

        const result = getUpcomingTasks(tasks, projects, 2)

        expect(result.byDay.size).toBe(2)
        expect(result.byDay.has('2026-01-14')).toBe(true)
        expect(result.byDay.has('2026-01-15')).toBe(true)
        expect(result.byDay.has('2026-01-16')).toBe(false)
      })
    })

    describe('getDayHeaderText', () => {
      it("should return 'TODAY' for today", () => {
        const today = new Date('2026-01-14')
        const result = getDayHeaderText(today)

        expect(result.primary).toBe('TODAY')
        expect(result.secondary).toContain('Jan')
        expect(result.secondary).toContain('14')
      })

      it("should return 'TOMORROW' for tomorrow", () => {
        const tomorrow = new Date('2026-01-15')
        const result = getDayHeaderText(tomorrow)

        expect(result.primary).toBe('TOMORROW')
        expect(result.secondary).toContain('Jan')
        expect(result.secondary).toContain('15')
      })

      it('should return day name for other days', () => {
        const friday = new Date('2026-01-16')
        const result = getDayHeaderText(friday)

        expect(result.primary).toBe('FRIDAY')
        expect(result.secondary).toContain('Jan')
        expect(result.secondary).toContain('16')
      })

      it('should return correct weekday for Saturday', () => {
        const saturday = new Date('2026-01-17')
        const result = getDayHeaderText(saturday)

        expect(result.primary).toBe('SATURDAY')
      })

      it('should return correct weekday for Sunday', () => {
        const sunday = new Date('2026-01-18')
        const result = getDayHeaderText(sunday)

        expect(result.primary).toBe('SUNDAY')
      })
    })
  })

  // ============================================================================
  // T087: COMPLETED TASKS & ARCHIVE
  // ============================================================================

  describe('T087: Completed Tasks & Archive', () => {
    describe('getCompletedTasks', () => {
      it('should return tasks that are completed but not archived', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-13'), archivedAt: null }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-12'), archivedAt: null }),
          createMockTask({ id: 't3', completedAt: null, archivedAt: null })
        ]

        const result = getCompletedTasks(tasks)

        expect(result).toHaveLength(2)
        expect(result.map((t) => t.id)).toContain('t1')
        expect(result.map((t) => t.id)).toContain('t2')
      })

      it('should exclude archived tasks', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-13'), archivedAt: null }),
          createMockTask({
            id: 't2',
            completedAt: new Date('2026-01-12'),
            archivedAt: new Date('2026-01-13')
          })
        ]

        const result = getCompletedTasks(tasks)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('t1')
      })

      it('should return empty array when no completed tasks', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: null }),
          createMockTask({ id: 't2', completedAt: null })
        ]

        const result = getCompletedTasks(tasks)

        expect(result).toHaveLength(0)
      })
    })

    describe('getArchivedTasks', () => {
      it('should return only archived tasks', () => {
        const tasks = [
          createMockTask({ id: 't1', archivedAt: new Date('2026-01-10') }),
          createMockTask({ id: 't2', archivedAt: new Date('2026-01-11') }),
          createMockTask({ id: 't3', archivedAt: null })
        ]

        const result = getArchivedTasks(tasks)

        expect(result).toHaveLength(2)
        expect(result.map((t) => t.id)).toContain('t1')
        expect(result.map((t) => t.id)).toContain('t2')
      })

      it('should return empty array when no archived tasks', () => {
        const tasks = [
          createMockTask({ id: 't1', archivedAt: null }),
          createMockTask({ id: 't2', archivedAt: null })
        ]

        const result = getArchivedTasks(tasks)

        expect(result).toHaveLength(0)
      })
    })

    describe('groupCompletedByPeriod', () => {
      it('should group tasks completed today', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-14T08:00:00Z') }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-14T09:00:00Z') })
        ]

        const result = groupCompletedByPeriod(tasks)

        expect(result.today).toHaveLength(2)
        expect(result.yesterday).toHaveLength(0)
        expect(result.earlierThisWeek).toHaveLength(0)
        expect(result.lastWeek).toHaveLength(0)
        expect(result.older).toHaveLength(0)
      })

      it('should group tasks completed yesterday', () => {
        const tasks = [createMockTask({ id: 't1', completedAt: new Date('2026-01-13T15:00:00Z') })]

        const result = groupCompletedByPeriod(tasks)

        expect(result.today).toHaveLength(0)
        expect(result.yesterday).toHaveLength(1)
      })

      it('should group tasks completed last week', () => {
        const tasks = [createMockTask({ id: 't1', completedAt: new Date('2026-01-08T10:00:00Z') })]

        const result = groupCompletedByPeriod(tasks)

        expect(result.lastWeek).toHaveLength(1)
      })

      it('should group older tasks', () => {
        const tasks = [createMockTask({ id: 't1', completedAt: new Date('2025-12-20T10:00:00Z') })]

        const result = groupCompletedByPeriod(tasks)

        expect(result.older).toHaveLength(1)
      })

      it('should sort tasks within each group by completion date (most recent first)', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-14T08:00:00Z') }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-14T10:00:00Z') }),
          createMockTask({ id: 't3', completedAt: new Date('2026-01-14T09:00:00Z') })
        ]

        const result = groupCompletedByPeriod(tasks)

        expect(result.today[0].id).toBe('t2')
        expect(result.today[1].id).toBe('t3')
        expect(result.today[2].id).toBe('t1')
      })

      it('should skip tasks without completedAt', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-14T08:00:00Z') }),
          createMockTask({ id: 't2', completedAt: null })
        ]

        const result = groupCompletedByPeriod(tasks)

        expect(result.today).toHaveLength(1)
      })
    })

    describe('groupArchivedByMonth', () => {
      it('should group archived tasks by month', () => {
        const tasks = [
          createMockTask({ id: 't1', archivedAt: new Date('2026-01-10') }),
          createMockTask({ id: 't2', archivedAt: new Date('2026-01-05') }),
          createMockTask({ id: 't3', archivedAt: new Date('2025-12-15') })
        ]

        const result = groupArchivedByMonth(tasks)

        expect(result).toHaveLength(2)
        expect(result[0].monthKey).toBe('2026-01')
        expect(result[0].tasks).toHaveLength(2)
        expect(result[1].monthKey).toBe('2025-12')
        expect(result[1].tasks).toHaveLength(1)
      })

      it('should format month labels correctly', () => {
        const tasks = [createMockTask({ id: 't1', archivedAt: new Date('2026-01-10') })]

        const result = groupArchivedByMonth(tasks)

        expect(result[0].label).toBe('January 2026')
      })

      it('should sort months by most recent first', () => {
        const tasks = [
          createMockTask({ id: 't1', archivedAt: new Date('2025-10-10') }),
          createMockTask({ id: 't2', archivedAt: new Date('2026-01-10') }),
          createMockTask({ id: 't3', archivedAt: new Date('2025-12-15') })
        ]

        const result = groupArchivedByMonth(tasks)

        expect(result[0].monthKey).toBe('2026-01')
        expect(result[1].monthKey).toBe('2025-12')
        expect(result[2].monthKey).toBe('2025-10')
      })

      it('should sort tasks within month by archived date (most recent first)', () => {
        const tasks = [
          createMockTask({ id: 't1', archivedAt: new Date('2026-01-05') }),
          createMockTask({ id: 't2', archivedAt: new Date('2026-01-15') }),
          createMockTask({ id: 't3', archivedAt: new Date('2026-01-10') })
        ]

        const result = groupArchivedByMonth(tasks)

        expect(result[0].tasks[0].id).toBe('t2')
        expect(result[0].tasks[1].id).toBe('t3')
        expect(result[0].tasks[2].id).toBe('t1')
      })

      it('should return empty array when no archived tasks', () => {
        const tasks = [createMockTask({ id: 't1', archivedAt: null })]

        const result = groupArchivedByMonth(tasks)

        expect(result).toHaveLength(0)
      })
    })
  })

  // ============================================================================
  // T088: COMPLETION STATISTICS
  // ============================================================================

  describe('T088: Completion Statistics', () => {
    describe('getCompletionStats', () => {
      it('should count tasks completed today', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-14T08:00:00Z') }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-14T09:00:00Z') }),
          createMockTask({ id: 't3', completedAt: new Date('2026-01-13T10:00:00Z') })
        ]

        const stats = getCompletionStats(tasks)

        expect(stats.today).toBe(2)
      })

      it('should count tasks completed this week (Monday start)', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-14T08:00:00Z') }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-13T08:00:00Z') }),
          createMockTask({ id: 't3', completedAt: new Date('2026-01-12T08:00:00Z') }),
          createMockTask({ id: 't4', completedAt: new Date('2026-01-11T08:00:00Z') })
        ]

        const stats = getCompletionStats(tasks)

        expect(stats.thisWeek).toBe(3)
      })

      it('should count tasks completed this month', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-14T08:00:00Z') }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-05T08:00:00Z') }),
          createMockTask({ id: 't3', completedAt: new Date('2026-01-01T08:00:00Z') }),
          createMockTask({ id: 't4', completedAt: new Date('2025-12-31T08:00:00Z') })
        ]

        const stats = getCompletionStats(tasks)

        expect(stats.thisMonth).toBe(3)
      })

      it('should return zeros when no completed tasks', () => {
        const tasks = [createMockTask({ id: 't1', completedAt: null })]

        const stats = getCompletionStats(tasks)

        expect(stats.today).toBe(0)
        expect(stats.thisWeek).toBe(0)
        expect(stats.thisMonth).toBe(0)
        expect(stats.streak).toBe(0)
      })

      it('should include streak in stats', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-14T08:00:00Z') }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-13T08:00:00Z') }),
          createMockTask({ id: 't3', completedAt: new Date('2026-01-12T08:00:00Z') })
        ]

        const stats = getCompletionStats(tasks)

        expect(stats.streak).toBe(3)
      })
    })

    describe('calculateStreak', () => {
      it('should return 0 when no completed tasks', () => {
        const streak = calculateStreak([])
        expect(streak).toBe(0)
      })

      it('should return 1 for tasks completed only today', () => {
        const tasks = [createMockTask({ id: 't1', completedAt: new Date('2026-01-14T08:00:00Z') })]

        const streak = calculateStreak(tasks)

        expect(streak).toBe(1)
      })

      it('should return 1 for tasks completed only yesterday', () => {
        const tasks = [createMockTask({ id: 't1', completedAt: new Date('2026-01-13T08:00:00Z') })]

        const streak = calculateStreak(tasks)

        expect(streak).toBe(1)
      })

      it('should count consecutive days from today', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-14T08:00:00Z') }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-13T08:00:00Z') }),
          createMockTask({ id: 't3', completedAt: new Date('2026-01-12T08:00:00Z') }),
          createMockTask({ id: 't4', completedAt: new Date('2026-01-11T08:00:00Z') })
        ]

        const streak = calculateStreak(tasks)

        expect(streak).toBe(4)
      })

      it('should count consecutive days from yesterday when nothing completed today', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-13T08:00:00Z') }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-12T08:00:00Z') })
        ]

        const streak = calculateStreak(tasks)

        expect(streak).toBe(2)
      })

      it('should break streak on gap day', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-14T08:00:00Z') }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-13T08:00:00Z') }),
          createMockTask({ id: 't3', completedAt: new Date('2026-01-11T08:00:00Z') })
        ]

        const streak = calculateStreak(tasks)

        expect(streak).toBe(2)
      })

      it('should return 0 when gap before yesterday', () => {
        const tasks = [createMockTask({ id: 't1', completedAt: new Date('2026-01-12T08:00:00Z') })]

        const streak = calculateStreak(tasks)

        expect(streak).toBe(0)
      })

      it('should count multiple completions on same day as one day', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-14T08:00:00Z') }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-14T10:00:00Z') }),
          createMockTask({ id: 't3', completedAt: new Date('2026-01-14T12:00:00Z') })
        ]

        const streak = calculateStreak(tasks)

        expect(streak).toBe(1)
      })

      it('should handle long streaks correctly', () => {
        const tasks: Task[] = []
        for (let i = 0; i < 10; i++) {
          tasks.push(
            createMockTask({
              id: `t${i}`,
              completedAt: subDays(new Date('2026-01-14T08:00:00Z'), i)
            })
          )
        }

        const streak = calculateStreak(tasks)

        expect(streak).toBe(10)
      })
    })

    describe('filterCompletedBySearch', () => {
      it('should return all tasks when query is empty', () => {
        const tasks = [
          createMockTask({ id: 't1', title: 'Buy groceries' }),
          createMockTask({ id: 't2', title: 'Walk the dog' })
        ]

        const result = filterCompletedBySearch(tasks, '')

        expect(result).toHaveLength(2)
      })

      it('should return all tasks when query is whitespace', () => {
        const tasks = [createMockTask({ id: 't1', title: 'Buy groceries' })]

        const result = filterCompletedBySearch(tasks, '   ')

        expect(result).toHaveLength(1)
      })

      it('should filter tasks by title (case insensitive)', () => {
        const tasks = [
          createMockTask({ id: 't1', title: 'Buy groceries' }),
          createMockTask({ id: 't2', title: 'Walk the dog' }),
          createMockTask({ id: 't3', title: 'GROCERY shopping' })
        ]

        const result = filterCompletedBySearch(tasks, 'grocer')

        expect(result).toHaveLength(2)
        expect(result.map((t) => t.id)).toContain('t1')
        expect(result.map((t) => t.id)).toContain('t3')
      })

      it('should handle partial matches', () => {
        const tasks = [
          createMockTask({ id: 't1', title: 'Meeting with team' }),
          createMockTask({ id: 't2', title: 'Team building' })
        ]

        const result = filterCompletedBySearch(tasks, 'team')

        expect(result).toHaveLength(2)
      })

      it('should return empty array when no matches', () => {
        const tasks = [createMockTask({ id: 't1', title: 'Buy groceries' })]

        const result = filterCompletedBySearch(tasks, 'xyz')

        expect(result).toHaveLength(0)
      })
    })

    describe('getTasksOlderThan', () => {
      it('should return tasks completed more than N days ago', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-14T08:00:00Z') }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-07T08:00:00Z') }),
          createMockTask({ id: 't3', completedAt: new Date('2026-01-01T08:00:00Z') })
        ]

        const result = getTasksOlderThan(tasks, 7)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('t3')
      })

      it('should exclude tasks without completedAt', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: null }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-01T08:00:00Z') })
        ]

        const result = getTasksOlderThan(tasks, 7)

        expect(result).toHaveLength(1)
      })

      it('should return empty array when all tasks are recent', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-14T08:00:00Z') }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-13T08:00:00Z') })
        ]

        const result = getTasksOlderThan(tasks, 7)

        expect(result).toHaveLength(0)
      })

      it('should handle edge case at exactly N days', () => {
        const tasks = [createMockTask({ id: 't1', completedAt: new Date('2026-01-07T08:00:00Z') })]

        const result = getTasksOlderThan(tasks, 7)

        expect(result).toHaveLength(0)
      })

      it('should work with 0 days (all completed tasks from before today)', () => {
        const tasks = [
          createMockTask({ id: 't1', completedAt: new Date('2026-01-14T00:00:00Z') }),
          createMockTask({ id: 't2', completedAt: new Date('2026-01-13T00:00:00Z') })
        ]

        const result = getTasksOlderThan(tasks, 0)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('t2')
      })
    })
  })

  // ============================================================================
  // T089: ADVANCED FILTERS & COMPOSITION
  // ============================================================================

  describe('T089: Advanced Filters & Composition', () => {
    describe('applyFiltersAndSort', () => {
      let project: Project
      let project2: Project
      let projects: Project[]

      beforeEach(() => {
        project = createMockProject({ id: 'project-1', name: 'Alpha Project' })
        project2 = createMockProject({ id: 'project-2', name: 'Beta Project' })
        projects = [project, project2]
      })

      it('should apply search filter', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            title: 'Buy groceries',
            projectId: 'project-1',
            statusId: 'status-todo'
          }),
          createMockTask({
            id: 't2',
            title: 'Walk the dog',
            projectId: 'project-1',
            statusId: 'status-todo'
          })
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), search: 'grocer' }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('t1')
      })

      it('should apply project filter', () => {
        const tasks = [
          createMockTask({ id: 't1', projectId: 'project-1', statusId: 'status-todo' }),
          createMockTask({ id: 't2', projectId: 'project-2', statusId: 'status-todo' })
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), projectIds: ['project-1'] }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('t1')
      })

      it('should apply priority filter', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            priority: 'high'
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            priority: 'low'
          }),
          createMockTask({
            id: 't3',
            projectId: 'project-1',
            statusId: 'status-todo',
            priority: 'urgent'
          })
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), priorities: ['high', 'urgent'] }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(2)
        expect(result.map((t) => t.id)).toContain('t1')
        expect(result.map((t) => t.id)).toContain('t3')
      })

      it('should apply due date filter - today', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-14')
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-15')
          })
        ]

        const filters: TaskFilters = {
          ...createDefaultFilters(),
          dueDate: { type: 'today', customStart: null, customEnd: null }
        }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('t1')
      })

      it('should apply due date filter - overdue', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-10')
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-14')
          })
        ]

        const filters: TaskFilters = {
          ...createDefaultFilters(),
          dueDate: { type: 'overdue', customStart: null, customEnd: null }
        }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('t1')
      })

      it('should apply due date filter - none', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: null
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-14')
          })
        ]

        const filters: TaskFilters = {
          ...createDefaultFilters(),
          dueDate: { type: 'none', customStart: null, customEnd: null }
        }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('t1')
      })

      it('should apply due date filter - custom range', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-15')
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-20')
          }),
          createMockTask({
            id: 't3',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-25')
          })
        ]

        const filters: TaskFilters = {
          ...createDefaultFilters(),
          dueDate: {
            type: 'custom',
            customStart: new Date('2026-01-15'),
            customEnd: new Date('2026-01-20')
          }
        }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(2)
        expect(result.map((t) => t.id)).toContain('t1')
        expect(result.map((t) => t.id)).toContain('t2')
      })

      it('should apply status filter', () => {
        const tasks = [
          createMockTask({ id: 't1', projectId: 'project-1', statusId: 'status-todo' }),
          createMockTask({ id: 't2', projectId: 'project-1', statusId: 'status-in-progress' })
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), statusIds: ['status-todo'] }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('t1')
      })

      it('should return empty when status=done but completion=active (filter interaction)', () => {
        // #given — done-status task + default "active" completion filter
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-done',
            completedAt: new Date()
          }),
          createMockTask({ id: 't2', projectId: 'project-1', statusId: 'status-todo' })
        ]

        // #when — user picks "Done" in status filter, completion stays "active"
        const filters: TaskFilters = {
          ...createDefaultFilters(),
          statusIds: ['status-done'],
          completion: 'active'
        }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        // #then — status passes done, completion strips it → empty
        expect(result).toHaveLength(0)
      })

      it('should show done tasks when both status=done and completion=all', () => {
        // #given
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-done',
            completedAt: new Date()
          }),
          createMockTask({ id: 't2', projectId: 'project-1', statusId: 'status-todo' })
        ]

        // #when — user picks "Done" status AND sets completion to "all"
        const filters: TaskFilters = {
          ...createDefaultFilters(),
          statusIds: ['status-done'],
          completion: 'all'
        }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        // #then — only the done task is returned
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('t1')
      })

      it('should apply completion filter - active', () => {
        const tasks = [
          createMockTask({ id: 't1', projectId: 'project-1', statusId: 'status-todo' }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-done',
            completedAt: new Date()
          })
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), completion: 'active' }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('t1')
      })

      it('should apply completion filter - completed', () => {
        const tasks = [
          createMockTask({ id: 't1', projectId: 'project-1', statusId: 'status-todo' }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-done',
            completedAt: new Date()
          })
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), completion: 'completed' }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('t2')
      })

      it('should apply repeat type filter - repeating', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            isRepeating: true
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            isRepeating: false
          })
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), repeatType: 'repeating' }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('t1')
      })

      it('should apply repeat type filter - one-time', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            isRepeating: true
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            isRepeating: false
          })
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), repeatType: 'one-time' }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('t2')
      })

      it('should apply has time filter - with-time', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueTime: '14:30'
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueTime: null
          })
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), hasTime: 'with-time' }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('t1')
      })

      it('should apply has time filter - without-time', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueTime: '14:30'
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueTime: null
          })
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), hasTime: 'without-time' }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('t2')
      })

      it('should apply sort by due date ascending', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-20')
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-15')
          }),
          createMockTask({
            id: 't3',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-18')
          })
        ]

        const filters = createDefaultFilters()
        const sort: TaskSort = { field: 'dueDate', direction: 'asc' }

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result[0].id).toBe('t2')
        expect(result[1].id).toBe('t3')
        expect(result[2].id).toBe('t1')
      })

      it('should apply sort by due date descending', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-20')
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-15')
          })
        ]

        const filters = createDefaultFilters()
        const sort: TaskSort = { field: 'dueDate', direction: 'desc' }

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result[0].id).toBe('t1')
        expect(result[1].id).toBe('t2')
      })

      it('should apply sort by priority', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            priority: 'low'
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            priority: 'urgent'
          }),
          createMockTask({
            id: 't3',
            projectId: 'project-1',
            statusId: 'status-todo',
            priority: 'high'
          })
        ]

        const filters = createDefaultFilters()
        const sort: TaskSort = { field: 'priority', direction: 'asc' }

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result[0].id).toBe('t2')
        expect(result[1].id).toBe('t3')
        expect(result[2].id).toBe('t1')
      })

      it('should apply sort by title', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            title: 'Zebra task',
            projectId: 'project-1',
            statusId: 'status-todo'
          }),
          createMockTask({
            id: 't2',
            title: 'Alpha task',
            projectId: 'project-1',
            statusId: 'status-todo'
          }),
          createMockTask({
            id: 't3',
            title: 'Beta task',
            projectId: 'project-1',
            statusId: 'status-todo'
          })
        ]

        const filters = createDefaultFilters()
        const sort: TaskSort = { field: 'title', direction: 'asc' }

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result[0].id).toBe('t2')
        expect(result[1].id).toBe('t3')
        expect(result[2].id).toBe('t1')
      })

      it('should apply sort by project name', () => {
        const tasks = [
          createMockTask({ id: 't1', projectId: 'project-2', statusId: 'status-todo' }),
          createMockTask({ id: 't2', projectId: 'project-1', statusId: 'status-todo' })
        ]

        const filters = createDefaultFilters()
        const sort: TaskSort = { field: 'project', direction: 'asc' }

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result[0].id).toBe('t2')
        expect(result[1].id).toBe('t1')
      })

      it('should apply multiple filters combined', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            priority: 'high',
            dueDate: new Date('2026-01-14')
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            priority: 'low',
            dueDate: new Date('2026-01-14')
          }),
          createMockTask({
            id: 't3',
            projectId: 'project-2',
            statusId: 'status-todo',
            priority: 'high',
            dueDate: new Date('2026-01-14')
          }),
          createMockTask({
            id: 't4',
            projectId: 'project-1',
            statusId: 'status-todo',
            priority: 'high',
            dueDate: new Date('2026-01-15')
          })
        ]

        const filters: TaskFilters = {
          ...createDefaultFilters(),
          projectIds: ['project-1'],
          priorities: ['high'],
          dueDate: { type: 'today', customStart: null, customEnd: null }
        }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('t1')
      })

      it('should put tasks without due date at end when sorting by due date', () => {
        const tasks = [
          createMockTask({
            id: 't1',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: null
          }),
          createMockTask({
            id: 't2',
            projectId: 'project-1',
            statusId: 'status-todo',
            dueDate: new Date('2026-01-15')
          })
        ]

        const filters = createDefaultFilters()
        const sort: TaskSort = { field: 'dueDate', direction: 'asc' }

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result[0].id).toBe('t2')
        expect(result[1].id).toBe('t1')
      })
    })

    describe('hasActiveFilters', () => {
      it('should return false for default filters', () => {
        const filters = createDefaultFilters()
        expect(hasActiveFilters(filters)).toBe(false)
      })

      it('should return true when search is set', () => {
        const filters: TaskFilters = { ...createDefaultFilters(), search: 'test' }
        expect(hasActiveFilters(filters)).toBe(true)
      })

      it('should return true when projectIds is set', () => {
        const filters: TaskFilters = { ...createDefaultFilters(), projectIds: ['p1'] }
        expect(hasActiveFilters(filters)).toBe(true)
      })

      it('should return true when priorities is set', () => {
        const filters: TaskFilters = { ...createDefaultFilters(), priorities: ['high'] }
        expect(hasActiveFilters(filters)).toBe(true)
      })

      it("should return true when dueDate type is not 'any'", () => {
        const filters: TaskFilters = {
          ...createDefaultFilters(),
          dueDate: { type: 'today', customStart: null, customEnd: null }
        }
        expect(hasActiveFilters(filters)).toBe(true)
      })

      it('should return true when statusIds is set', () => {
        const filters: TaskFilters = { ...createDefaultFilters(), statusIds: ['s1'] }
        expect(hasActiveFilters(filters)).toBe(true)
      })

      it("should return true when completion is not 'active'", () => {
        const filters: TaskFilters = { ...createDefaultFilters(), completion: 'completed' }
        expect(hasActiveFilters(filters)).toBe(true)
      })

      it("should return true when repeatType is not 'all'", () => {
        const filters: TaskFilters = { ...createDefaultFilters(), repeatType: 'repeating' }
        expect(hasActiveFilters(filters)).toBe(true)
      })

      it("should return true when hasTime is not 'all'", () => {
        const filters: TaskFilters = { ...createDefaultFilters(), hasTime: 'with-time' }
        expect(hasActiveFilters(filters)).toBe(true)
      })
    })

    describe('countActiveFilters', () => {
      it('should return 0 for default filters', () => {
        const filters = createDefaultFilters()
        expect(countActiveFilters(filters)).toBe(0)
      })

      it('should count each active filter type', () => {
        const filters: TaskFilters = {
          ...createDefaultFilters(),
          search: 'test',
          projectIds: ['p1'],
          priorities: ['high']
        }
        expect(countActiveFilters(filters)).toBe(3)
      })

      it('should count all 8 possible filter types', () => {
        const filters: TaskFilters = {
          search: 'test',
          projectIds: ['p1'],
          priorities: ['high'],
          dueDate: { type: 'today', customStart: null, customEnd: null },
          statusIds: ['s1'],
          completion: 'completed',
          repeatType: 'repeating',
          hasTime: 'with-time'
        }
        expect(countActiveFilters(filters)).toBe(8)
      })

      it('should not count empty arrays as active', () => {
        const filters: TaskFilters = {
          ...createDefaultFilters(),
          projectIds: [],
          priorities: []
        }
        expect(countActiveFilters(filters)).toBe(0)
      })
    })

    describe('Group header configurations', () => {
      describe('dueDateGroupConfig', () => {
        it('should have correct urgency levels', () => {
          expect(dueDateGroupConfig.overdue.urgency).toBe('critical')
          expect(dueDateGroupConfig.today.urgency).toBe('high')
          expect(dueDateGroupConfig.tomorrow.urgency).toBe('normal')
          expect(dueDateGroupConfig.upcoming.urgency).toBe('normal')
          expect(dueDateGroupConfig.later.urgency).toBe('low')
          expect(dueDateGroupConfig.noDueDate.urgency).toBe('low')
        })

        it('should have accent colors for critical/high urgency', () => {
          expect(dueDateGroupConfig.overdue.accentColor).toBe('#ef4444')
          expect(dueDateGroupConfig.today.accentColor).toBe('#3b82f6')
        })

        it('should have isMuted for low urgency', () => {
          expect(dueDateGroupConfig.later.isMuted).toBe(true)
          expect(dueDateGroupConfig.noDueDate.isMuted).toBe(true)
        })

        it('should have correct labels', () => {
          expect(dueDateGroupConfig.overdue.label).toBe('OVERDUE')
          expect(dueDateGroupConfig.today.label).toBe('TODAY')
          expect(dueDateGroupConfig.tomorrow.label).toBe('TOMORROW')
          expect(dueDateGroupConfig.upcoming.label).toBe('UPCOMING')
          expect(dueDateGroupConfig.later.label).toBe('LATER')
          expect(dueDateGroupConfig.noDueDate.label).toBe('NO DUE DATE')
        })
      })

      describe('completionGroupConfig', () => {
        it('should have correct urgency levels', () => {
          expect(completionGroupConfig.today.urgency).toBe('high')
          expect(completionGroupConfig.yesterday.urgency).toBe('normal')
          expect(completionGroupConfig.earlier.urgency).toBe('low')
        })

        it('should have green accent color for today', () => {
          expect(completionGroupConfig.today.accentColor).toBe('#10b981')
        })

        it('should have correct labels', () => {
          expect(completionGroupConfig.today.label).toBe('TODAY')
          expect(completionGroupConfig.yesterday.label).toBe('YESTERDAY')
          expect(completionGroupConfig.earlier.label).toBe('EARLIER')
        })
      })

      describe('completionPeriodConfig', () => {
        it('should have all period keys', () => {
          expect(completionPeriodConfig.today).toBeDefined()
          expect(completionPeriodConfig.yesterday).toBeDefined()
          expect(completionPeriodConfig.earlierThisWeek).toBeDefined()
          expect(completionPeriodConfig.lastWeek).toBeDefined()
          expect(completionPeriodConfig.older).toBeDefined()
        })

        it('should have correct urgency progression', () => {
          expect(completionPeriodConfig.today.urgency).toBe('high')
          expect(completionPeriodConfig.yesterday.urgency).toBe('normal')
          expect(completionPeriodConfig.earlierThisWeek.urgency).toBe('normal')
          expect(completionPeriodConfig.lastWeek.urgency).toBe('low')
          expect(completionPeriodConfig.older.urgency).toBe('low')
        })

        it('should have isMuted for older periods', () => {
          expect(completionPeriodConfig.lastWeek.isMuted).toBe(true)
          expect(completionPeriodConfig.older.isMuted).toBe(true)
        })

        it('should have correct labels', () => {
          expect(completionPeriodConfig.earlierThisWeek.label).toBe('EARLIER THIS WEEK')
          expect(completionPeriodConfig.lastWeek.label).toBe('LAST WEEK')
          expect(completionPeriodConfig.older.label).toBe('OLDER')
        })
      })
    })
  })
})
