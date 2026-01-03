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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { Task, Priority } from "@/data/sample-tasks"
import type { Project, Status, StatusType, TaskFilters, TaskSort } from "@/data/tasks-data"
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
  // Task Filtering (T084)
  getFilteredTasks,
  // Task Counts (T085)
  getTaskCounts,
  formatTaskSubtitle,
  // Today & Upcoming View Helpers (T086)
  getTodayTasks,
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
  completionPeriodConfig,
} from "./task-utils"

// ============================================================================
// MOCK FACTORIES
// ============================================================================

/**
 * Factory to create mock Task objects with sensible defaults
 */
const createMockTask = (overrides: Partial<Task> = {}): Task => ({
  id: `task-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
  title: "Test Task",
  description: "",
  projectId: "project-1",
  statusId: "status-todo",
  priority: "none" as Priority,
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  parentId: null,
  subtaskIds: [],
  createdAt: new Date("2026-01-01T10:00:00Z"),
  completedAt: null,
  archivedAt: null,
  ...overrides,
})

/**
 * Factory to create mock Status objects with sensible defaults
 */
const createMockStatus = (overrides: Partial<Status> = {}): Status => ({
  id: `status-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
  name: "To Do",
  color: "#6b7280",
  type: "todo" as StatusType,
  order: 0,
  ...overrides,
})

/**
 * Factory to create mock Project objects with sensible defaults
 */
const createMockProject = (overrides: Partial<Project> = {}): Project => ({
  id: `project-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
  name: "Test Project",
  description: "",
  icon: "Folder",
  color: "#6366f1",
  statuses: [
    createMockStatus({ id: "status-todo", name: "To Do", type: "todo", order: 0 }),
    createMockStatus({ id: "status-in-progress", name: "In Progress", type: "in_progress", order: 1 }),
    createMockStatus({ id: "status-done", name: "Done", type: "done", order: 2 }),
  ],
  isDefault: false,
  isArchived: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  taskCount: 0,
  ...overrides,
})

/**
 * Factory to create default TaskFilters object
 */
const createDefaultFilters = (): TaskFilters => ({
  search: "",
  projectIds: [],
  priorities: [],
  dueDate: { type: "any", customStart: null, customEnd: null },
  statusIds: [],
  completion: "active",
  repeatType: "all",
  hasTime: "all",
})

/**
 * Factory to create default TaskSort object
 */
const createDefaultSort = (): TaskSort => ({
  field: "dueDate",
  direction: "asc",
})

// ============================================================================
// TEST SETUP
// ============================================================================

describe("Task Utils", () => {
  // Set up fake timers for deterministic date tests
  beforeEach(() => {
    vi.useFakeTimers()
    // Wednesday, January 14, 2026, 10:30:00 UTC
    vi.setSystemTime(new Date("2026-01-14T10:30:00Z"))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ============================================================================
  // T072: DATE HELPERS - BASIC
  // ============================================================================

  describe("T072: Date Helpers - Basic", () => {
    describe("startOfDay", () => {
      it("should set time to midnight (00:00:00.000)", () => {
        const date = new Date("2026-01-14T15:45:30.123Z")
        const result = startOfDay(date)

        expect(result.getHours()).toBe(0)
        expect(result.getMinutes()).toBe(0)
        expect(result.getSeconds()).toBe(0)
        expect(result.getMilliseconds()).toBe(0)
      })

      it("should preserve year, month, and day", () => {
        // Use local time constructor to avoid timezone issues
        const date = new Date(2026, 2, 25, 23, 59, 59, 999) // March 25, 2026, 23:59:59.999
        const result = startOfDay(date)

        expect(result.getFullYear()).toBe(2026)
        expect(result.getMonth()).toBe(2) // March (0-indexed)
        expect(result.getDate()).toBe(25)
      })

      it("should not mutate original date", () => {
        const original = new Date("2026-01-14T15:00:00Z")
        const originalTime = original.getTime()
        startOfDay(original)

        expect(original.getTime()).toBe(originalTime)
      })

      it("should handle date already at midnight", () => {
        const date = new Date("2026-01-14T00:00:00.000Z")
        const result = startOfDay(date)

        expect(result.getHours()).toBe(0)
        expect(result.getMinutes()).toBe(0)
        expect(result.getSeconds()).toBe(0)
        expect(result.getMilliseconds()).toBe(0)
      })

      it("should handle edge case: end of year", () => {
        // Use local time constructor to avoid timezone issues
        const date = new Date(2026, 11, 31, 23, 59, 59, 999) // December 31, 2026, 23:59:59.999
        const result = startOfDay(date)

        expect(result.getFullYear()).toBe(2026)
        expect(result.getMonth()).toBe(11) // December
        expect(result.getDate()).toBe(31)
        expect(result.getHours()).toBe(0)
      })
    })

    describe("addDays", () => {
      it("should add positive days correctly", () => {
        const date = new Date("2026-01-14T10:00:00Z")
        const result = addDays(date, 5)

        expect(result.getDate()).toBe(19)
        expect(result.getMonth()).toBe(0) // January
      })

      it("should handle month boundary crossing", () => {
        const date = new Date("2026-01-28T10:00:00Z")
        const result = addDays(date, 5)

        expect(result.getDate()).toBe(2)
        expect(result.getMonth()).toBe(1) // February
      })

      it("should handle year boundary crossing", () => {
        const date = new Date("2026-12-30T10:00:00Z")
        const result = addDays(date, 5)

        expect(result.getDate()).toBe(4)
        expect(result.getMonth()).toBe(0) // January
        expect(result.getFullYear()).toBe(2027)
      })

      it("should handle adding zero days", () => {
        const date = new Date("2026-01-14T10:00:00Z")
        const result = addDays(date, 0)

        expect(result.getTime()).toBe(date.getTime())
      })

      it("should handle adding negative days (subtraction)", () => {
        const date = new Date("2026-01-14T10:00:00Z")
        const result = addDays(date, -3)

        expect(result.getDate()).toBe(11)
      })

      it("should not mutate original date", () => {
        const original = new Date("2026-01-14T10:00:00Z")
        const originalTime = original.getTime()
        addDays(original, 5)

        expect(original.getTime()).toBe(originalTime)
      })

      it("should handle leap year February", () => {
        // 2028 is a leap year
        const date = new Date("2028-02-28T10:00:00Z")
        const result = addDays(date, 1)

        expect(result.getDate()).toBe(29)
        expect(result.getMonth()).toBe(1) // February
      })
    })

    describe("subDays", () => {
      it("should subtract positive days correctly", () => {
        const date = new Date("2026-01-14T10:00:00Z")
        const result = subDays(date, 5)

        expect(result.getDate()).toBe(9)
      })

      it("should handle month boundary crossing backwards", () => {
        const date = new Date("2026-02-03T10:00:00Z")
        const result = subDays(date, 5)

        expect(result.getDate()).toBe(29)
        expect(result.getMonth()).toBe(0) // January
      })

      it("should handle year boundary crossing backwards", () => {
        const date = new Date("2026-01-03T10:00:00Z")
        const result = subDays(date, 5)

        expect(result.getDate()).toBe(29)
        expect(result.getMonth()).toBe(11) // December
        expect(result.getFullYear()).toBe(2025)
      })

      it("should handle subtracting zero days", () => {
        const date = new Date("2026-01-14T10:00:00Z")
        const result = subDays(date, 0)

        expect(result.getTime()).toBe(date.getTime())
      })
    })

    describe("isSameDay", () => {
      it("should return true for same date different times", () => {
        // Use local time constructor to avoid timezone issues
        const date1 = new Date(2026, 0, 14, 8, 0, 0) // January 14, 2026, 08:00
        const date2 = new Date(2026, 0, 14, 23, 59, 59) // January 14, 2026, 23:59:59

        expect(isSameDay(date1, date2)).toBe(true)
      })

      it("should return true for identical dates", () => {
        const date1 = new Date("2026-01-14T10:30:00Z")
        const date2 = new Date("2026-01-14T10:30:00Z")

        expect(isSameDay(date1, date2)).toBe(true)
      })

      it("should return false for different days", () => {
        const date1 = new Date("2026-01-14T10:00:00Z")
        const date2 = new Date("2026-01-15T10:00:00Z")

        expect(isSameDay(date1, date2)).toBe(false)
      })

      it("should return false for different months same day number", () => {
        const date1 = new Date("2026-01-14T10:00:00Z")
        const date2 = new Date("2026-02-14T10:00:00Z")

        expect(isSameDay(date1, date2)).toBe(false)
      })

      it("should return false for different years same month and day", () => {
        const date1 = new Date("2026-01-14T10:00:00Z")
        const date2 = new Date("2027-01-14T10:00:00Z")

        expect(isSameDay(date1, date2)).toBe(false)
      })
    })

    describe("isBefore", () => {
      it("should return true when date1 is before date2", () => {
        const date1 = new Date("2026-01-13T10:00:00Z")
        const date2 = new Date("2026-01-14T10:00:00Z")

        expect(isBefore(date1, date2)).toBe(true)
      })

      it("should return false when date1 is after date2", () => {
        const date1 = new Date("2026-01-15T10:00:00Z")
        const date2 = new Date("2026-01-14T10:00:00Z")

        expect(isBefore(date1, date2)).toBe(false)
      })

      it("should return false when dates are equal", () => {
        const date1 = new Date("2026-01-14T10:00:00Z")
        const date2 = new Date("2026-01-14T10:00:00Z")

        expect(isBefore(date1, date2)).toBe(false)
      })

      it("should compare by milliseconds, not just date", () => {
        const date1 = new Date("2026-01-14T10:00:00.000Z")
        const date2 = new Date("2026-01-14T10:00:00.001Z")

        expect(isBefore(date1, date2)).toBe(true)
      })
    })

    describe("isAfter", () => {
      it("should return true when date1 is after date2", () => {
        const date1 = new Date("2026-01-15T10:00:00Z")
        const date2 = new Date("2026-01-14T10:00:00Z")

        expect(isAfter(date1, date2)).toBe(true)
      })

      it("should return false when date1 is before date2", () => {
        const date1 = new Date("2026-01-13T10:00:00Z")
        const date2 = new Date("2026-01-14T10:00:00Z")

        expect(isAfter(date1, date2)).toBe(false)
      })

      it("should return false when dates are equal", () => {
        const date1 = new Date("2026-01-14T10:00:00Z")
        const date2 = new Date("2026-01-14T10:00:00Z")

        expect(isAfter(date1, date2)).toBe(false)
      })

      it("should compare by milliseconds, not just date", () => {
        const date1 = new Date("2026-01-14T10:00:00.001Z")
        const date2 = new Date("2026-01-14T10:00:00.000Z")

        expect(isAfter(date1, date2)).toBe(true)
      })
    })
  })

  // ============================================================================
  // T073: DATE HELPERS - INTERVALS
  // ============================================================================

  describe("T073: Date Helpers - Intervals", () => {
    describe("isWithinInterval", () => {
      it("should return true when date is within interval (exclusive of boundaries)", () => {
        const date = new Date("2026-01-14T10:00:00Z")
        const start = new Date("2026-01-10T00:00:00Z")
        const end = new Date("2026-01-20T23:59:59Z")

        expect(isWithinInterval(date, { start, end })).toBe(true)
      })

      it("should return true when date equals start boundary (inclusive)", () => {
        const date = new Date("2026-01-10T00:00:00Z")
        const start = new Date("2026-01-10T00:00:00Z")
        const end = new Date("2026-01-20T23:59:59Z")

        expect(isWithinInterval(date, { start, end })).toBe(true)
      })

      it("should return true when date equals end boundary (inclusive)", () => {
        const date = new Date("2026-01-20T23:59:59Z")
        const start = new Date("2026-01-10T00:00:00Z")
        const end = new Date("2026-01-20T23:59:59Z")

        expect(isWithinInterval(date, { start, end })).toBe(true)
      })

      it("should return false when date is before interval", () => {
        const date = new Date("2026-01-05T10:00:00Z")
        const start = new Date("2026-01-10T00:00:00Z")
        const end = new Date("2026-01-20T23:59:59Z")

        expect(isWithinInterval(date, { start, end })).toBe(false)
      })

      it("should return false when date is after interval", () => {
        const date = new Date("2026-01-25T10:00:00Z")
        const start = new Date("2026-01-10T00:00:00Z")
        const end = new Date("2026-01-20T23:59:59Z")

        expect(isWithinInterval(date, { start, end })).toBe(false)
      })

      it("should handle single-day interval", () => {
        const date = new Date("2026-01-14T12:00:00Z")
        const start = new Date("2026-01-14T00:00:00Z")
        const end = new Date("2026-01-14T23:59:59Z")

        expect(isWithinInterval(date, { start, end })).toBe(true)
      })

      it("should handle interval spanning months", () => {
        const date = new Date("2026-02-05T10:00:00Z")
        const start = new Date("2026-01-25T00:00:00Z")
        const end = new Date("2026-02-10T23:59:59Z")

        expect(isWithinInterval(date, { start, end })).toBe(true)
      })

      it("should handle interval spanning years", () => {
        const date = new Date("2027-01-02T10:00:00Z")
        const start = new Date("2026-12-28T00:00:00Z")
        const end = new Date("2027-01-05T23:59:59Z")

        expect(isWithinInterval(date, { start, end })).toBe(true)
      })
    })

    describe("differenceInDays", () => {
      it("should return positive difference when date1 is after date2", () => {
        const date1 = new Date("2026-01-20T10:00:00Z")
        const date2 = new Date("2026-01-14T10:00:00Z")

        expect(differenceInDays(date1, date2)).toBe(6)
      })

      it("should return negative difference when date1 is before date2", () => {
        const date1 = new Date("2026-01-10T10:00:00Z")
        const date2 = new Date("2026-01-14T10:00:00Z")

        expect(differenceInDays(date1, date2)).toBe(-4)
      })

      it("should return zero for same day when date1 is after date2", () => {
        // Use local time constructor to avoid timezone issues
        // Note: differenceInDays returns floor((date1 - date2) / 24h)
        // When date1 is AFTER date2 on the same day, diff is positive fraction -> floors to 0
        const date1 = new Date(2026, 0, 14, 20, 0, 0) // January 14, 2026, 20:00
        const date2 = new Date(2026, 0, 14, 8, 0, 0) // January 14, 2026, 08:00

        expect(differenceInDays(date1, date2)).toBe(0)
      })

      it("should return -1 for same day when date1 is before date2", () => {
        // When date1 is BEFORE date2 on the same day, diff is negative fraction -> floors to -1
        const date1 = new Date(2026, 0, 14, 8, 0, 0) // January 14, 2026, 08:00
        const date2 = new Date(2026, 0, 14, 20, 0, 0) // January 14, 2026, 20:00

        expect(differenceInDays(date1, date2)).toBe(-1)
      })

      it("should floor the result (not round)", () => {
        // Less than 24 hours apart but different calendar days
        const date1 = new Date("2026-01-15T02:00:00Z")
        const date2 = new Date("2026-01-14T22:00:00Z")

        // Only 4 hours difference, which is 0 when floored
        expect(differenceInDays(date1, date2)).toBe(0)
      })

      it("should handle month boundaries", () => {
        const date1 = new Date("2026-02-05T10:00:00Z")
        const date2 = new Date("2026-01-28T10:00:00Z")

        expect(differenceInDays(date1, date2)).toBe(8)
      })

      it("should handle year boundaries", () => {
        const date1 = new Date("2027-01-03T10:00:00Z")
        const date2 = new Date("2026-12-28T10:00:00Z")

        expect(differenceInDays(date1, date2)).toBe(6)
      })

      it("should handle large differences", () => {
        const date1 = new Date("2027-01-14T10:00:00Z")
        const date2 = new Date("2026-01-14T10:00:00Z")

        expect(differenceInDays(date1, date2)).toBe(365)
      })

      it("should handle leap year correctly", () => {
        // 2028 is a leap year
        const date1 = new Date("2028-03-01T10:00:00Z")
        const date2 = new Date("2028-02-28T10:00:00Z")

        expect(differenceInDays(date1, date2)).toBe(2) // Feb 28 -> Feb 29 -> Mar 1
      })
    })
  })

  // ============================================================================
  // T074: DATE HELPERS - WEEK/MONTH
  // ============================================================================

  describe("T074: Date Helpers - Week/Month", () => {
    describe("startOfWeek", () => {
      it("should return Sunday when weekStartsOn is 0 (default)", () => {
        // January 14, 2026 is a Wednesday
        const date = new Date("2026-01-14T10:00:00Z")
        const result = startOfWeek(date)

        // Should be Sunday, January 11, 2026
        expect(result.getDay()).toBe(0) // Sunday
        expect(result.getDate()).toBe(11)
      })

      it("should return Monday when weekStartsOn is 1", () => {
        // January 14, 2026 is a Wednesday
        const date = new Date("2026-01-14T10:00:00Z")
        const result = startOfWeek(date, 1)

        // Should be Monday, January 12, 2026
        expect(result.getDay()).toBe(1) // Monday
        expect(result.getDate()).toBe(12)
      })

      it("should return same day if date is already start of week", () => {
        // January 11, 2026 is a Sunday
        const date = new Date("2026-01-11T10:00:00Z")
        const result = startOfWeek(date, 0)

        expect(result.getDate()).toBe(11)
        expect(result.getDay()).toBe(0)
      })

      it("should set time to midnight", () => {
        const date = new Date("2026-01-14T15:30:45Z")
        const result = startOfWeek(date)

        expect(result.getHours()).toBe(0)
        expect(result.getMinutes()).toBe(0)
        expect(result.getSeconds()).toBe(0)
      })

      it("should handle week crossing month boundary", () => {
        // February 2, 2026 is a Monday
        const date = new Date("2026-02-02T10:00:00Z")
        const result = startOfWeek(date, 0) // Sunday start

        // Should be Sunday, February 1, 2026
        expect(result.getDate()).toBe(1)
        expect(result.getMonth()).toBe(1) // February
      })
    })

    describe("endOfWeek", () => {
      it("should return Saturday when weekStartsOn is 0 (default)", () => {
        // January 14, 2026 is a Wednesday
        const date = new Date("2026-01-14T10:00:00Z")
        const result = endOfWeek(date)

        // Should be Saturday, January 17, 2026
        expect(result.getDay()).toBe(6) // Saturday
        expect(result.getDate()).toBe(17)
      })

      it("should return Sunday when weekStartsOn is 1", () => {
        // January 14, 2026 is a Wednesday
        const date = new Date("2026-01-14T10:00:00Z")
        const result = endOfWeek(date, 1)

        // Should be Sunday, January 18, 2026
        expect(result.getDay()).toBe(0) // Sunday
        expect(result.getDate()).toBe(18)
      })

      it("should handle week crossing month boundary", () => {
        // January 28, 2026 is a Wednesday
        const date = new Date("2026-01-28T10:00:00Z")
        const result = endOfWeek(date, 0)

        // Should be Saturday, January 31, 2026
        expect(result.getDate()).toBe(31)
        expect(result.getMonth()).toBe(0) // January
      })
    })

    describe("startOfMonth", () => {
      it("should return first day of month at midnight", () => {
        const date = new Date("2026-01-14T15:30:00Z")
        const result = startOfMonth(date)

        expect(result.getDate()).toBe(1)
        expect(result.getMonth()).toBe(0) // January
        expect(result.getHours()).toBe(0)
        expect(result.getMinutes()).toBe(0)
      })

      it("should preserve year and month", () => {
        const date = new Date("2026-06-20T10:00:00Z")
        const result = startOfMonth(date)

        expect(result.getFullYear()).toBe(2026)
        expect(result.getMonth()).toBe(5) // June
        expect(result.getDate()).toBe(1)
      })

      it("should handle date already on first day", () => {
        const date = new Date("2026-03-01T10:00:00Z")
        const result = startOfMonth(date)

        expect(result.getDate()).toBe(1)
        expect(result.getMonth()).toBe(2) // March
      })
    })

    describe("endOfMonth", () => {
      it("should return last day of month", () => {
        const date = new Date("2026-01-14T10:00:00Z")
        const result = endOfMonth(date)

        expect(result.getDate()).toBe(31)
        expect(result.getMonth()).toBe(0) // January
      })

      it("should handle February in non-leap year", () => {
        const date = new Date("2026-02-10T10:00:00Z")
        const result = endOfMonth(date)

        expect(result.getDate()).toBe(28)
        expect(result.getMonth()).toBe(1) // February
      })

      it("should handle February in leap year", () => {
        // 2028 is a leap year
        const date = new Date("2028-02-10T10:00:00Z")
        const result = endOfMonth(date)

        expect(result.getDate()).toBe(29)
        expect(result.getMonth()).toBe(1) // February
      })

      it("should handle months with 30 days", () => {
        const date = new Date("2026-04-15T10:00:00Z")
        const result = endOfMonth(date)

        expect(result.getDate()).toBe(30)
        expect(result.getMonth()).toBe(3) // April
      })
    })

    describe("addWeeks", () => {
      it("should add weeks correctly", () => {
        const date = new Date("2026-01-14T10:00:00Z")
        const result = addWeeks(date, 2)

        expect(result.getDate()).toBe(28)
        expect(result.getMonth()).toBe(0) // January
      })

      it("should handle month boundary", () => {
        const date = new Date("2026-01-28T10:00:00Z")
        const result = addWeeks(date, 1)

        expect(result.getDate()).toBe(4)
        expect(result.getMonth()).toBe(1) // February
      })

      it("should handle negative weeks", () => {
        const date = new Date("2026-01-14T10:00:00Z")
        const result = addWeeks(date, -1)

        expect(result.getDate()).toBe(7)
      })
    })

    describe("addMonths", () => {
      it("should add months correctly", () => {
        const date = new Date("2026-01-14T10:00:00Z")
        const result = addMonths(date, 2)

        expect(result.getMonth()).toBe(2) // March
        expect(result.getDate()).toBe(14)
      })

      it("should handle year boundary", () => {
        const date = new Date("2026-11-14T10:00:00Z")
        const result = addMonths(date, 3)

        expect(result.getMonth()).toBe(1) // February
        expect(result.getFullYear()).toBe(2027)
      })

      it("should handle day overflow (e.g., Jan 31 + 1 month)", () => {
        const date = new Date("2026-01-31T10:00:00Z")
        const result = addMonths(date, 1)

        // JavaScript Date wraps to March 3 (31 days into February which has 28)
        expect(result.getMonth()).toBe(2) // March
        expect(result.getDate()).toBe(3)
      })
    })

    describe("subMonths", () => {
      it("should subtract months correctly", () => {
        const date = new Date("2026-03-14T10:00:00Z")
        const result = subMonths(date, 2)

        expect(result.getMonth()).toBe(0) // January
        expect(result.getDate()).toBe(14)
      })

      it("should handle year boundary backwards", () => {
        const date = new Date("2026-02-14T10:00:00Z")
        const result = subMonths(date, 3)

        expect(result.getMonth()).toBe(10) // November
        expect(result.getFullYear()).toBe(2025)
      })
    })

    describe("isSameMonth", () => {
      it("should return true for same month and year", () => {
        const date1 = new Date("2026-01-05T10:00:00Z")
        const date2 = new Date("2026-01-28T20:00:00Z")

        expect(isSameMonth(date1, date2)).toBe(true)
      })

      it("should return false for different months same year", () => {
        const date1 = new Date("2026-01-14T10:00:00Z")
        const date2 = new Date("2026-02-14T10:00:00Z")

        expect(isSameMonth(date1, date2)).toBe(false)
      })

      it("should return false for same month different years", () => {
        const date1 = new Date("2026-01-14T10:00:00Z")
        const date2 = new Date("2027-01-14T10:00:00Z")

        expect(isSameMonth(date1, date2)).toBe(false)
      })
    })

    describe("nextSaturday", () => {
      it("should return this Saturday when today is Wednesday", () => {
        // January 14, 2026 is a Wednesday
        const result = nextSaturday()

        expect(result.getDay()).toBe(6) // Saturday
        expect(result.getDate()).toBe(17) // January 17, 2026
      })

      it("should return today if today is Saturday", () => {
        vi.setSystemTime(new Date("2026-01-17T10:00:00Z")) // Saturday
        const result = nextSaturday()

        expect(result.getDay()).toBe(6)
        expect(result.getDate()).toBe(17)
      })

      it("should return next Saturday if today is Sunday", () => {
        vi.setSystemTime(new Date("2026-01-18T10:00:00Z")) // Sunday
        const result = nextSaturday()

        expect(result.getDay()).toBe(6)
        expect(result.getDate()).toBe(24) // Next Saturday
      })

      it("should accept a custom from date", () => {
        const from = new Date("2026-01-20T10:00:00Z") // Tuesday
        const result = nextSaturday(from)

        expect(result.getDay()).toBe(6)
        expect(result.getDate()).toBe(24)
      })
    })

    describe("nextMonday", () => {
      it("should return next Monday when today is Wednesday", () => {
        // January 14, 2026 is a Wednesday
        const result = nextMonday()

        expect(result.getDay()).toBe(1) // Monday
        expect(result.getDate()).toBe(19) // January 19, 2026
      })

      it("should return next Monday (7 days) if today is Monday", () => {
        vi.setSystemTime(new Date("2026-01-12T10:00:00Z")) // Monday
        const result = nextMonday()

        expect(result.getDay()).toBe(1)
        expect(result.getDate()).toBe(19) // Next Monday
      })

      it("should return tomorrow if today is Sunday", () => {
        vi.setSystemTime(new Date("2026-01-18T10:00:00Z")) // Sunday
        const result = nextMonday()

        expect(result.getDay()).toBe(1)
        expect(result.getDate()).toBe(19) // Next day
      })

      it("should accept a custom from date", () => {
        const from = new Date("2026-01-15T10:00:00Z") // Thursday
        const result = nextMonday(from)

        expect(result.getDay()).toBe(1)
        expect(result.getDate()).toBe(19)
      })
    })

    describe("endOfDay", () => {
      it("should set time to 23:59:59.999", () => {
        const date = new Date("2026-01-14T10:30:00Z")
        const result = endOfDay(date)

        expect(result.getHours()).toBe(23)
        expect(result.getMinutes()).toBe(59)
        expect(result.getSeconds()).toBe(59)
        expect(result.getMilliseconds()).toBe(999)
      })

      it("should preserve year, month, and day", () => {
        const date = new Date("2026-06-20T08:00:00Z")
        const result = endOfDay(date)

        expect(result.getFullYear()).toBe(2026)
        expect(result.getMonth()).toBe(5) // June
        expect(result.getDate()).toBe(20)
      })

      it("should not mutate original date", () => {
        const original = new Date("2026-01-14T10:00:00Z")
        const originalTime = original.getTime()
        endOfDay(original)

        expect(original.getTime()).toBe(originalTime)
      })
    })
  })

  // ============================================================================
  // T075: DATE FORMATTING
  // ============================================================================

  describe("T075: Date Formatting", () => {
    describe("formatTime", () => {
      it("should format morning time correctly", () => {
        expect(formatTime("09:30")).toBe("9:30 AM")
      })

      it("should format afternoon time correctly", () => {
        expect(formatTime("14:45")).toBe("2:45 PM")
      })

      it("should format midnight correctly", () => {
        expect(formatTime("00:00")).toBe("12:00 AM")
      })

      it("should format noon correctly", () => {
        expect(formatTime("12:00")).toBe("12:00 PM")
      })

      it("should format 11 PM correctly", () => {
        expect(formatTime("23:59")).toBe("11:59 PM")
      })

      it("should handle single digit minutes with padding", () => {
        expect(formatTime("10:05")).toBe("10:05 AM")
      })

      it("should format 1 AM correctly", () => {
        expect(formatTime("01:00")).toBe("1:00 AM")
      })

      it("should format 12:30 PM correctly", () => {
        expect(formatTime("12:30")).toBe("12:30 PM")
      })
    })

    describe("formatDateShort", () => {
      it("should format date as 'Mon DD'", () => {
        const date = new Date("2026-01-14T10:00:00Z")
        expect(formatDateShort(date)).toBe("Jan 14")
      })

      it("should format December date correctly", () => {
        const date = new Date("2026-12-25T10:00:00Z")
        expect(formatDateShort(date)).toBe("Dec 25")
      })

      it("should format single digit day without leading zero", () => {
        const date = new Date("2026-03-05T10:00:00Z")
        expect(formatDateShort(date)).toBe("Mar 5")
      })

      it("should format last day of month", () => {
        const date = new Date("2026-01-31T10:00:00Z")
        expect(formatDateShort(date)).toBe("Jan 31")
      })
    })

    describe("formatDayName", () => {
      it("should return full day name", () => {
        const date = new Date("2026-01-14T10:00:00Z") // Wednesday
        expect(formatDayName(date)).toBe("Wednesday")
      })

      it("should format Sunday correctly", () => {
        const date = new Date("2026-01-18T10:00:00Z")
        expect(formatDayName(date)).toBe("Sunday")
      })

      it("should format Monday correctly", () => {
        const date = new Date("2026-01-12T10:00:00Z")
        expect(formatDayName(date)).toBe("Monday")
      })

      it("should format Saturday correctly", () => {
        const date = new Date("2026-01-17T10:00:00Z")
        expect(formatDayName(date)).toBe("Saturday")
      })
    })

    describe("formatDueDate", () => {
      it("should return null for null dueDate", () => {
        expect(formatDueDate(null, null)).toBe(null)
      })

      it('should return "Today" for today\'s date', () => {
        const today = new Date("2026-01-14T15:00:00Z")
        const result = formatDueDate(today, null)

        expect(result).toEqual({ label: "Today", status: "today" })
      })

      it('should return "Today" with time for today\'s date with time', () => {
        const today = new Date("2026-01-14T15:00:00Z")
        const result = formatDueDate(today, "14:30")

        expect(result).toEqual({ label: "Today 2:30 PM", status: "today" })
      })

      it('should return "Tomorrow" for tomorrow\'s date', () => {
        const tomorrow = new Date("2026-01-15T10:00:00Z")
        const result = formatDueDate(tomorrow, null)

        expect(result).toEqual({ label: "Tomorrow", status: "tomorrow" })
      })

      it('should return "Tomorrow" with time', () => {
        const tomorrow = new Date("2026-01-15T10:00:00Z")
        const result = formatDueDate(tomorrow, "09:00")

        expect(result).toEqual({ label: "Tomorrow 9:00 AM", status: "tomorrow" })
      })

      it("should return day name for dates within this week", () => {
        const friday = new Date("2026-01-16T10:00:00Z") // Friday, 2 days from now
        const result = formatDueDate(friday, null)

        expect(result).toEqual({ label: "Friday", status: "upcoming" })
      })

      it("should return formatted date for overdue dates", () => {
        const overdue = new Date("2026-01-10T10:00:00Z")
        const result = formatDueDate(overdue, null)

        expect(result).toEqual({ label: "Jan 10", status: "overdue" })
      })

      it("should return formatted date with time for overdue dates", () => {
        const overdue = new Date("2026-01-10T10:00:00Z")
        const result = formatDueDate(overdue, "16:00")

        expect(result).toEqual({ label: "Jan 10 4:00 PM", status: "overdue" })
      })

      it("should return formatted date for later dates (8+ days)", () => {
        const later = new Date("2026-01-25T10:00:00Z")
        const result = formatDueDate(later, null)

        expect(result).toEqual({ label: "Jan 25", status: "later" })
      })

      it("should handle edge case: exactly 7 days from now (last day of upcoming)", () => {
        const sixDays = new Date("2026-01-20T10:00:00Z") // 6 days from Jan 14
        const result = formatDueDate(sixDays, null)

        expect(result?.status).toBe("upcoming")
      })

      it("should handle edge case: exactly 8 days from now (first day of later)", () => {
        const sevenDays = new Date("2026-01-21T10:00:00Z") // 7 days = next week
        const result = formatDueDate(sevenDays, null)

        expect(result?.status).toBe("later")
      })
    })
  })

  // ============================================================================
  // T076: TASK STATUS HELPERS
  // ============================================================================

  describe("T076: Task Status Helpers", () => {
    describe("isTaskCompleted", () => {
      it("should return true when task status type is 'done'", () => {
        const project = createMockProject({ id: "project-1" })
        const task = createMockTask({
          projectId: "project-1",
          statusId: "status-done",
        })

        expect(isTaskCompleted(task, [project])).toBe(true)
      })

      it("should return false when task status type is 'todo'", () => {
        const project = createMockProject({ id: "project-1" })
        const task = createMockTask({
          projectId: "project-1",
          statusId: "status-todo",
        })

        expect(isTaskCompleted(task, [project])).toBe(false)
      })

      it("should return false when task status type is 'in_progress'", () => {
        const project = createMockProject({ id: "project-1" })
        const task = createMockTask({
          projectId: "project-1",
          statusId: "status-in-progress",
        })

        expect(isTaskCompleted(task, [project])).toBe(false)
      })

      it("should return false when project is not found", () => {
        const project = createMockProject({ id: "project-1" })
        const task = createMockTask({
          projectId: "non-existent-project",
          statusId: "status-done",
        })

        expect(isTaskCompleted(task, [project])).toBe(false)
      })

      it("should return false when status is not found in project", () => {
        const project = createMockProject({ id: "project-1" })
        const task = createMockTask({
          projectId: "project-1",
          statusId: "non-existent-status",
        })

        expect(isTaskCompleted(task, [project])).toBe(false)
      })

      it("should work with multiple projects", () => {
        const project1 = createMockProject({ id: "project-1" })
        const project2 = createMockProject({
          id: "project-2",
          statuses: [
            createMockStatus({ id: "custom-done", type: "done", order: 0 }),
          ],
        })

        const task = createMockTask({
          projectId: "project-2",
          statusId: "custom-done",
        })

        expect(isTaskCompleted(task, [project1, project2])).toBe(true)
      })

      it("should handle project with custom status names", () => {
        const project = createMockProject({
          id: "project-1",
          statuses: [
            createMockStatus({ id: "backlog", name: "Backlog", type: "todo", order: 0 }),
            createMockStatus({ id: "completed", name: "Completed", type: "done", order: 1 }),
          ],
        })

        const task = createMockTask({
          projectId: "project-1",
          statusId: "completed",
        })

        expect(isTaskCompleted(task, [project])).toBe(true)
      })
    })

    describe("getDefaultTodoStatus", () => {
      it('should return first status with type "todo"', () => {
        const project = createMockProject()
        const result = getDefaultTodoStatus(project)

        expect(result).toBeDefined()
        expect(result?.type).toBe("todo")
        expect(result?.id).toBe("status-todo")
      })

      it('should return first "todo" status when multiple exist', () => {
        const project = createMockProject({
          statuses: [
            createMockStatus({ id: "first-todo", name: "First Todo", type: "todo", order: 0 }),
            createMockStatus({ id: "second-todo", name: "Second Todo", type: "todo", order: 1 }),
            createMockStatus({ id: "done", type: "done", order: 2 }),
          ],
        })

        const result = getDefaultTodoStatus(project)

        expect(result?.id).toBe("first-todo")
      })

      it('should return undefined when no "todo" status exists', () => {
        const project = createMockProject({
          statuses: [
            createMockStatus({ id: "in-progress", type: "in_progress", order: 0 }),
            createMockStatus({ id: "done", type: "done", order: 1 }),
          ],
        })

        const result = getDefaultTodoStatus(project)

        expect(result).toBeUndefined()
      })

      it("should return undefined for project with empty statuses", () => {
        const project = createMockProject({ statuses: [] })
        const result = getDefaultTodoStatus(project)

        expect(result).toBeUndefined()
      })
    })

    describe("getDefaultDoneStatus", () => {
      it('should return first status with type "done"', () => {
        const project = createMockProject()
        const result = getDefaultDoneStatus(project)

        expect(result).toBeDefined()
        expect(result?.type).toBe("done")
        expect(result?.id).toBe("status-done")
      })

      it('should return first "done" status when multiple exist', () => {
        const project = createMockProject({
          statuses: [
            createMockStatus({ id: "todo", type: "todo", order: 0 }),
            createMockStatus({ id: "first-done", name: "Completed", type: "done", order: 1 }),
            createMockStatus({ id: "second-done", name: "Archived", type: "done", order: 2 }),
          ],
        })

        const result = getDefaultDoneStatus(project)

        expect(result?.id).toBe("first-done")
      })

      it('should return undefined when no "done" status exists', () => {
        const project = createMockProject({
          statuses: [
            createMockStatus({ id: "todo", type: "todo", order: 0 }),
            createMockStatus({ id: "in-progress", type: "in_progress", order: 1 }),
          ],
        })

        const result = getDefaultDoneStatus(project)

        expect(result).toBeUndefined()
      })

      it("should return undefined for project with empty statuses", () => {
        const project = createMockProject({ statuses: [] })
        const result = getDefaultDoneStatus(project)

        expect(result).toBeUndefined()
      })

      it("should work with custom status names", () => {
        const project = createMockProject({
          statuses: [
            createMockStatus({ id: "new", name: "New", type: "todo", order: 0 }),
            createMockStatus({ id: "shipped", name: "Shipped", type: "done", order: 1 }),
          ],
        })

        const result = getDefaultDoneStatus(project)

        expect(result?.id).toBe("shipped")
        expect(result?.name).toBe("Shipped")
      })
    })
  })

  // ============================================================================
  // T084: TASK FILTERING - MAIN FILTER FUNCTION
  // ============================================================================

  describe("T084: Task Filtering - Main Filter Function", () => {
    describe("getFilteredTasks", () => {
      let project: Project
      let projects: Project[]

      beforeEach(() => {
        project = createMockProject({ id: "project-1" })
        projects = [project]
      })

      describe("View filtering: 'all' view", () => {
        it("should return all incomplete tasks for 'all' view", () => {
          const tasks = [
            createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo" }),
            createMockTask({ id: "t2", projectId: "project-1", statusId: "status-in-progress" }),
          ]

          const result = getFilteredTasks(tasks, "all", "view", projects)

          expect(result).toHaveLength(2)
          expect(result.map((t) => t.id)).toContain("t1")
          expect(result.map((t) => t.id)).toContain("t2")
        })

        it("should exclude completed tasks from 'all' view", () => {
          const tasks = [
            createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo" }),
            createMockTask({
              id: "t2",
              projectId: "project-1",
              statusId: "status-done",
              completedAt: new Date("2026-01-13"),
            }),
          ]

          const result = getFilteredTasks(tasks, "all", "view", projects)

          expect(result).toHaveLength(1)
          expect(result[0].id).toBe("t1")
        })

        it("should always exclude archived tasks", () => {
          const tasks = [
            createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo" }),
            createMockTask({
              id: "t2",
              projectId: "project-1",
              statusId: "status-todo",
              archivedAt: new Date("2026-01-10"),
            }),
          ]

          const result = getFilteredTasks(tasks, "all", "view", projects)

          expect(result).toHaveLength(1)
          expect(result[0].id).toBe("t1")
        })
      })

      describe("View filtering: 'today' view", () => {
        it("should return tasks due today", () => {
          const tasks = [
            createMockTask({
              id: "t1",
              projectId: "project-1",
              statusId: "status-todo",
              dueDate: new Date("2026-01-14"),
            }),
            createMockTask({
              id: "t2",
              projectId: "project-1",
              statusId: "status-todo",
              dueDate: new Date("2026-01-15"),
            }),
          ]

          const result = getFilteredTasks(tasks, "today", "view", projects)

          expect(result).toHaveLength(1)
          expect(result[0].id).toBe("t1")
        })

        it("should include overdue tasks in 'today' view", () => {
          const tasks = [
            createMockTask({
              id: "t1",
              projectId: "project-1",
              statusId: "status-todo",
              dueDate: new Date("2026-01-10"),
            }),
            createMockTask({
              id: "t2",
              projectId: "project-1",
              statusId: "status-todo",
              dueDate: new Date("2026-01-14"),
            }),
          ]

          const result = getFilteredTasks(tasks, "today", "view", projects)

          expect(result).toHaveLength(2)
          expect(result.map((t) => t.id)).toContain("t1")
          expect(result.map((t) => t.id)).toContain("t2")
        })

        it("should not include tasks without due date in 'today' view", () => {
          const tasks = [
            createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo", dueDate: null }),
            createMockTask({
              id: "t2",
              projectId: "project-1",
              statusId: "status-todo",
              dueDate: new Date("2026-01-14"),
            }),
          ]

          const result = getFilteredTasks(tasks, "today", "view", projects)

          expect(result).toHaveLength(1)
          expect(result[0].id).toBe("t2")
        })

        it("should exclude completed tasks from 'today' view", () => {
          const tasks = [
            createMockTask({
              id: "t1",
              projectId: "project-1",
              statusId: "status-done",
              dueDate: new Date("2026-01-14"),
              completedAt: new Date(),
            }),
          ]

          const result = getFilteredTasks(tasks, "today", "view", projects)

          expect(result).toHaveLength(0)
        })
      })

      describe("View filtering: 'upcoming' view", () => {
        it("should return tasks due tomorrow through 7 days ahead", () => {
          const tasks = [
            createMockTask({
              id: "t1",
              projectId: "project-1",
              statusId: "status-todo",
              dueDate: new Date("2026-01-15"),
            }),
            createMockTask({
              id: "t2",
              projectId: "project-1",
              statusId: "status-todo",
              dueDate: new Date("2026-01-20"),
            }),
            createMockTask({
              id: "t3",
              projectId: "project-1",
              statusId: "status-todo",
              dueDate: new Date("2026-01-21"),
            }),
            createMockTask({
              id: "t4",
              projectId: "project-1",
              statusId: "status-todo",
              dueDate: new Date("2026-01-22"),
            }),
          ]

          const result = getFilteredTasks(tasks, "upcoming", "view", projects)

          expect(result).toHaveLength(3)
          expect(result.map((t) => t.id)).toContain("t1")
          expect(result.map((t) => t.id)).toContain("t2")
          expect(result.map((t) => t.id)).toContain("t3")
          expect(result.map((t) => t.id)).not.toContain("t4")
        })

        it("should not include today in 'upcoming' view", () => {
          const tasks = [
            createMockTask({
              id: "t1",
              projectId: "project-1",
              statusId: "status-todo",
              dueDate: new Date("2026-01-14"),
            }),
            createMockTask({
              id: "t2",
              projectId: "project-1",
              statusId: "status-todo",
              dueDate: new Date("2026-01-15"),
            }),
          ]

          const result = getFilteredTasks(tasks, "upcoming", "view", projects)

          expect(result).toHaveLength(1)
          expect(result[0].id).toBe("t2")
        })

        it("should not include overdue tasks in 'upcoming' view", () => {
          const tasks = [
            createMockTask({
              id: "t1",
              projectId: "project-1",
              statusId: "status-todo",
              dueDate: new Date("2026-01-10"),
            }),
            createMockTask({
              id: "t2",
              projectId: "project-1",
              statusId: "status-todo",
              dueDate: new Date("2026-01-15"),
            }),
          ]

          const result = getFilteredTasks(tasks, "upcoming", "view", projects)

          expect(result).toHaveLength(1)
          expect(result[0].id).toBe("t2")
        })
      })

      describe("View filtering: 'completed' view", () => {
        it("should return only completed tasks", () => {
          const tasks = [
            createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo" }),
            createMockTask({
              id: "t2",
              projectId: "project-1",
              statusId: "status-done",
              completedAt: new Date("2026-01-13"),
            }),
          ]

          const result = getFilteredTasks(tasks, "completed", "view", projects)

          expect(result).toHaveLength(1)
          expect(result[0].id).toBe("t2")
        })

        it("should exclude archived tasks from 'completed' view", () => {
          const tasks = [
            createMockTask({
              id: "t1",
              projectId: "project-1",
              statusId: "status-done",
              completedAt: new Date("2026-01-13"),
            }),
            createMockTask({
              id: "t2",
              projectId: "project-1",
              statusId: "status-done",
              completedAt: new Date("2026-01-12"),
              archivedAt: new Date("2026-01-13"),
            }),
          ]

          const result = getFilteredTasks(tasks, "completed", "view", projects)

          expect(result).toHaveLength(1)
          expect(result[0].id).toBe("t1")
        })
      })

      describe("Project filtering", () => {
        it("should return all tasks for selected project when selectedType is 'project'", () => {
          const project2 = createMockProject({ id: "project-2", name: "Project 2" })
          const allProjects = [project, project2]

          const tasks = [
            createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo" }),
            createMockTask({ id: "t2", projectId: "project-2", statusId: "status-todo" }),
            createMockTask({
              id: "t3",
              projectId: "project-1",
              statusId: "status-done",
              completedAt: new Date(),
            }),
          ]

          const result = getFilteredTasks(tasks, "project-1", "project", allProjects)

          expect(result).toHaveLength(2)
          expect(result.every((t) => t.projectId === "project-1")).toBe(true)
        })

        it("should include both completed and incomplete tasks for project view", () => {
          const tasks = [
            createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo" }),
            createMockTask({
              id: "t2",
              projectId: "project-1",
              statusId: "status-done",
              completedAt: new Date(),
            }),
          ]

          const result = getFilteredTasks(tasks, "project-1", "project", projects)

          expect(result).toHaveLength(2)
        })

        it("should still exclude archived tasks from project view", () => {
          const tasks = [
            createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo" }),
            createMockTask({
              id: "t2",
              projectId: "project-1",
              statusId: "status-todo",
              archivedAt: new Date("2026-01-10"),
            }),
          ]

          const result = getFilteredTasks(tasks, "project-1", "project", projects)

          expect(result).toHaveLength(1)
          expect(result[0].id).toBe("t1")
        })
      })

      describe("Subtask inclusion", () => {
        it("should include subtasks when parent matches filter", () => {
          const parentTask = createMockTask({
            id: "parent-1",
            projectId: "project-1",
            statusId: "status-todo",
            subtaskIds: ["subtask-1", "subtask-2"],
          })
          const subtask1 = createMockTask({
            id: "subtask-1",
            projectId: "project-1",
            statusId: "status-todo",
            parentId: "parent-1",
          })
          const subtask2 = createMockTask({
            id: "subtask-2",
            projectId: "project-1",
            statusId: "status-done",
            parentId: "parent-1",
            completedAt: new Date(),
          })

          const tasks = [parentTask, subtask1, subtask2]
          const result = getFilteredTasks(tasks, "all", "view", projects)

          expect(result.map((t) => t.id)).toContain("parent-1")
          expect(result.map((t) => t.id)).toContain("subtask-1")
          expect(result.map((t) => t.id)).toContain("subtask-2")
        })

        it("should not include orphan subtasks when parent does not match filter", () => {
          const parentTask = createMockTask({
            id: "parent-1",
            projectId: "project-1",
            statusId: "status-done",
            completedAt: new Date(),
            subtaskIds: ["subtask-1"],
          })
          const subtask1 = createMockTask({
            id: "subtask-1",
            projectId: "project-1",
            statusId: "status-todo",
            parentId: "parent-1",
          })

          const tasks = [parentTask, subtask1]
          const result = getFilteredTasks(tasks, "all", "view", projects)

          expect(result.map((t) => t.id)).not.toContain("parent-1")
          expect(result.map((t) => t.id)).not.toContain("subtask-1")
        })
      })

      describe("Edge cases", () => {
        it("should return empty array when no tasks provided", () => {
          const result = getFilteredTasks([], "all", "view", projects)
          expect(result).toHaveLength(0)
        })

        it("should handle unknown view ID gracefully (defaults to incomplete)", () => {
          const tasks = [createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo" })]

          const result = getFilteredTasks(tasks, "unknown-view", "view", projects)

          expect(result).toHaveLength(1)
        })

        it("should handle task with unknown project gracefully", () => {
          const tasks = [createMockTask({ id: "t1", projectId: "unknown-project", statusId: "status-todo" })]

          const result = getFilteredTasks(tasks, "all", "view", projects)

          expect(result).toHaveLength(1)
        })

        it("should handle empty projects array", () => {
          const tasks = [createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo" })]

          const result = getFilteredTasks(tasks, "all", "view", [])

          expect(result).toHaveLength(1)
        })
      })
    })
  })

  // ============================================================================
  // T085: TASK COUNTS & FORMATTING
  // ============================================================================

  describe("T085: Task Counts & Formatting", () => {
    describe("getTaskCounts", () => {
      let project: Project
      let projects: Project[]

      beforeEach(() => {
        project = createMockProject({ id: "project-1" })
        projects = [project]
      })

      it("should count total incomplete tasks", () => {
        const tasks = [
          createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo" }),
          createMockTask({ id: "t2", projectId: "project-1", statusId: "status-in-progress" }),
          createMockTask({
            id: "t3",
            projectId: "project-1",
            statusId: "status-done",
            completedAt: new Date(),
          }),
        ]

        const counts = getTaskCounts(tasks, "all", "view", projects)

        expect(counts.total).toBe(2)
      })

      it("should count tasks due today", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-14"),
          }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-15"),
          }),
          createMockTask({
            id: "t3",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-14"),
          }),
        ]

        const counts = getTaskCounts(tasks, "all", "view", projects)

        expect(counts.dueToday).toBe(2)
      })

      it("should count overdue tasks", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-10"),
          }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-13"),
          }),
          createMockTask({
            id: "t3",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-14"),
          }),
        ]

        const counts = getTaskCounts(tasks, "all", "view", projects)

        expect(counts.overdue).toBe(2)
      })

      it("should count completed tasks", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-done",
            completedAt: new Date(),
          }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-done",
            completedAt: new Date(),
          }),
          createMockTask({ id: "t3", projectId: "project-1", statusId: "status-todo" }),
        ]

        const counts = getTaskCounts(tasks, "completed", "view", projects)

        expect(counts.completed).toBe(2)
      })

      it("should return zeros for empty task list", () => {
        const counts = getTaskCounts([], "all", "view", projects)

        expect(counts.total).toBe(0)
        expect(counts.dueToday).toBe(0)
        expect(counts.overdue).toBe(0)
        expect(counts.completed).toBe(0)
      })

      it("should respect project filter in counts", () => {
        const project2 = createMockProject({ id: "project-2" })
        const allProjects = [project, project2]

        const tasks = [
          createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo" }),
          createMockTask({ id: "t2", projectId: "project-2", statusId: "status-todo" }),
        ]

        const counts = getTaskCounts(tasks, "project-1", "project", allProjects)

        expect(counts.total).toBe(1)
      })
    })

    describe("formatTaskSubtitle", () => {
      describe("View subtitles", () => {
        it("should format 'all' view subtitle with only total", () => {
          const counts = { total: 10, dueToday: 0, overdue: 0, completed: 0 }
          const result = formatTaskSubtitle(counts, "all", "view")
          expect(result).toBe("10 tasks")
        })

        it("should format 'all' view subtitle with due today", () => {
          const counts = { total: 10, dueToday: 3, overdue: 0, completed: 0 }
          const result = formatTaskSubtitle(counts, "all", "view")
          expect(result).toContain("10 tasks")
          expect(result).toContain("3 due today")
        })

        it("should format 'all' view subtitle with overdue", () => {
          const counts = { total: 10, dueToday: 0, overdue: 2, completed: 0 }
          const result = formatTaskSubtitle(counts, "all", "view")
          expect(result).toContain("10 tasks")
          expect(result).toContain("2 overdue")
        })

        it("should format 'all' view subtitle with both due today and overdue", () => {
          const counts = { total: 10, dueToday: 3, overdue: 2, completed: 0 }
          const result = formatTaskSubtitle(counts, "all", "view")
          expect(result).toContain("10 tasks")
          expect(result).toContain("3 due today")
          expect(result).toContain("2 overdue")
        })

        it("should format 'today' view subtitle", () => {
          const counts = { total: 5, dueToday: 5, overdue: 2, completed: 0 }
          const result = formatTaskSubtitle(counts, "today", "view")
          expect(result).toContain("7 tasks due")
          expect(result).toContain("2 overdue")
        })

        it("should format 'today' view subtitle without overdue", () => {
          const counts = { total: 5, dueToday: 5, overdue: 0, completed: 0 }
          const result = formatTaskSubtitle(counts, "today", "view")
          expect(result).toBe("5 tasks due")
        })

        it("should format 'upcoming' view subtitle", () => {
          const counts = { total: 8, dueToday: 0, overdue: 0, completed: 0 }
          const result = formatTaskSubtitle(counts, "upcoming", "view")
          expect(result).toBe("8 tasks in the next 7 days")
        })

        it("should format 'completed' view subtitle", () => {
          const counts = { total: 0, dueToday: 0, overdue: 0, completed: 45 }
          const result = formatTaskSubtitle(counts, "completed", "view")
          expect(result).toBe("45 tasks completed")
        })

        it("should format unknown view with default subtitle", () => {
          const counts = { total: 5, dueToday: 0, overdue: 0, completed: 0 }
          const result = formatTaskSubtitle(counts, "unknown", "view")
          expect(result).toBe("5 tasks")
        })
      })

      describe("Project subtitles", () => {
        it("should format project subtitle with only total", () => {
          const counts = { total: 15, dueToday: 0, overdue: 0, completed: 0 }
          const result = formatTaskSubtitle(counts, "project-1", "project")
          expect(result).toBe("15 tasks")
        })

        it("should format project subtitle with due today", () => {
          const counts = { total: 15, dueToday: 4, overdue: 0, completed: 0 }
          const result = formatTaskSubtitle(counts, "project-1", "project")
          expect(result).toContain("15 tasks")
          expect(result).toContain("4 due today")
        })
      })
    })
  })

  // ============================================================================
  // T086: TODAY & UPCOMING VIEW HELPERS
  // ============================================================================

  describe("T086: Today & Upcoming View Helpers", () => {
    describe("getTodayTasks", () => {
      let project: Project
      let projects: Project[]

      beforeEach(() => {
        project = createMockProject({ id: "project-1" })
        projects = [project]
      })

      it("should separate overdue and today tasks", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-10"),
          }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-14"),
          }),
          createMockTask({
            id: "t3",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-14T15:00:00Z"),
          }),
        ]

        const result = getTodayTasks(tasks, projects)

        expect(result.overdue).toHaveLength(1)
        expect(result.overdue[0].id).toBe("t1")
        expect(result.today).toHaveLength(2)
        expect(result.today.map((t) => t.id)).toContain("t2")
        expect(result.today.map((t) => t.id)).toContain("t3")
      })

      it("should exclude completed tasks", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-done",
            dueDate: new Date("2026-01-14"),
            completedAt: new Date(),
          }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-14"),
          }),
        ]

        const result = getTodayTasks(tasks, projects)

        expect(result.today).toHaveLength(1)
        expect(result.today[0].id).toBe("t2")
      })

      it("should exclude tasks without due date", () => {
        const tasks = [
          createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo", dueDate: null }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-14"),
          }),
        ]

        const result = getTodayTasks(tasks, projects)

        expect(result.today).toHaveLength(1)
        expect(result.overdue).toHaveLength(0)
      })

      it("should exclude future tasks", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-15"),
          }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-14"),
          }),
        ]

        const result = getTodayTasks(tasks, projects)

        expect(result.today).toHaveLength(1)
        expect(result.today[0].id).toBe("t2")
      })

      it("should return empty arrays when no matching tasks", () => {
        const result = getTodayTasks([], projects)

        expect(result.overdue).toHaveLength(0)
        expect(result.today).toHaveLength(0)
      })
    })

    describe("getUpcomingTasks", () => {
      let project: Project
      let projects: Project[]

      beforeEach(() => {
        project = createMockProject({ id: "project-1" })
        projects = [project]
      })

      it("should return overdue tasks separately", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-10"),
          }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-15"),
          }),
        ]

        const result = getUpcomingTasks(tasks, projects, 7)

        expect(result.overdue).toHaveLength(1)
        expect(result.overdue[0].id).toBe("t1")
      })

      it("should group tasks by day for the next N days", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-14"),
          }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-15"),
          }),
          createMockTask({
            id: "t3",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-15"),
          }),
          createMockTask({
            id: "t4",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-16"),
          }),
        ]

        const result = getUpcomingTasks(tasks, projects, 7)

        expect(result.byDay.get("2026-01-14")).toHaveLength(1)
        expect(result.byDay.get("2026-01-15")).toHaveLength(2)
        expect(result.byDay.get("2026-01-16")).toHaveLength(1)
      })

      it("should initialize empty arrays for days without tasks", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-16"),
          }),
        ]

        const result = getUpcomingTasks(tasks, projects, 7)

        expect(result.byDay.get("2026-01-14")).toHaveLength(0)
        expect(result.byDay.get("2026-01-15")).toHaveLength(0)
        expect(result.byDay.get("2026-01-16")).toHaveLength(1)
      })

      it("should exclude tasks beyond the range", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-25"),
          }),
        ]

        const result = getUpcomingTasks(tasks, projects, 7)

        expect(result.byDay.has("2026-01-25")).toBe(false)
      })

      it("should exclude completed tasks", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-done",
            dueDate: new Date("2026-01-15"),
            completedAt: new Date(),
          }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-15"),
          }),
        ]

        const result = getUpcomingTasks(tasks, projects, 7)

        expect(result.byDay.get("2026-01-15")).toHaveLength(1)
        expect(result.byDay.get("2026-01-15")![0].id).toBe("t2")
      })

      it("should respect custom daysAhead parameter", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-14"),
          }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-15"),
          }),
          createMockTask({
            id: "t3",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-16"),
          }),
        ]

        const result = getUpcomingTasks(tasks, projects, 2)

        expect(result.byDay.size).toBe(2)
        expect(result.byDay.has("2026-01-14")).toBe(true)
        expect(result.byDay.has("2026-01-15")).toBe(true)
        expect(result.byDay.has("2026-01-16")).toBe(false)
      })
    })

    describe("getDayHeaderText", () => {
      it("should return 'TODAY' for today", () => {
        const today = new Date("2026-01-14")
        const result = getDayHeaderText(today)

        expect(result.primary).toBe("TODAY")
        expect(result.secondary).toContain("Jan")
        expect(result.secondary).toContain("14")
      })

      it("should return 'TOMORROW' for tomorrow", () => {
        const tomorrow = new Date("2026-01-15")
        const result = getDayHeaderText(tomorrow)

        expect(result.primary).toBe("TOMORROW")
        expect(result.secondary).toContain("Jan")
        expect(result.secondary).toContain("15")
      })

      it("should return day name for other days", () => {
        const friday = new Date("2026-01-16")
        const result = getDayHeaderText(friday)

        expect(result.primary).toBe("FRIDAY")
        expect(result.secondary).toContain("Jan")
        expect(result.secondary).toContain("16")
      })

      it("should return correct weekday for Saturday", () => {
        const saturday = new Date("2026-01-17")
        const result = getDayHeaderText(saturday)

        expect(result.primary).toBe("SATURDAY")
      })

      it("should return correct weekday for Sunday", () => {
        const sunday = new Date("2026-01-18")
        const result = getDayHeaderText(sunday)

        expect(result.primary).toBe("SUNDAY")
      })
    })
  })

  // ============================================================================
  // T087: COMPLETED TASKS & ARCHIVE
  // ============================================================================

  describe("T087: Completed Tasks & Archive", () => {
    describe("getCompletedTasks", () => {
      it("should return tasks that are completed but not archived", () => {
        const tasks = [
          createMockTask({ id: "t1", completedAt: new Date("2026-01-13"), archivedAt: null }),
          createMockTask({ id: "t2", completedAt: new Date("2026-01-12"), archivedAt: null }),
          createMockTask({ id: "t3", completedAt: null, archivedAt: null }),
        ]

        const result = getCompletedTasks(tasks)

        expect(result).toHaveLength(2)
        expect(result.map((t) => t.id)).toContain("t1")
        expect(result.map((t) => t.id)).toContain("t2")
      })

      it("should exclude archived tasks", () => {
        const tasks = [
          createMockTask({ id: "t1", completedAt: new Date("2026-01-13"), archivedAt: null }),
          createMockTask({
            id: "t2",
            completedAt: new Date("2026-01-12"),
            archivedAt: new Date("2026-01-13"),
          }),
        ]

        const result = getCompletedTasks(tasks)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("t1")
      })

      it("should return empty array when no completed tasks", () => {
        const tasks = [
          createMockTask({ id: "t1", completedAt: null }),
          createMockTask({ id: "t2", completedAt: null }),
        ]

        const result = getCompletedTasks(tasks)

        expect(result).toHaveLength(0)
      })
    })

    describe("getArchivedTasks", () => {
      it("should return only archived tasks", () => {
        const tasks = [
          createMockTask({ id: "t1", archivedAt: new Date("2026-01-10") }),
          createMockTask({ id: "t2", archivedAt: new Date("2026-01-11") }),
          createMockTask({ id: "t3", archivedAt: null }),
        ]

        const result = getArchivedTasks(tasks)

        expect(result).toHaveLength(2)
        expect(result.map((t) => t.id)).toContain("t1")
        expect(result.map((t) => t.id)).toContain("t2")
      })

      it("should return empty array when no archived tasks", () => {
        const tasks = [
          createMockTask({ id: "t1", archivedAt: null }),
          createMockTask({ id: "t2", archivedAt: null }),
        ]

        const result = getArchivedTasks(tasks)

        expect(result).toHaveLength(0)
      })
    })

    describe("groupCompletedByPeriod", () => {
      it("should group tasks completed today", () => {
        const tasks = [
          createMockTask({ id: "t1", completedAt: new Date("2026-01-14T08:00:00Z") }),
          createMockTask({ id: "t2", completedAt: new Date("2026-01-14T09:00:00Z") }),
        ]

        const result = groupCompletedByPeriod(tasks)

        expect(result.today).toHaveLength(2)
        expect(result.yesterday).toHaveLength(0)
        expect(result.earlierThisWeek).toHaveLength(0)
        expect(result.lastWeek).toHaveLength(0)
        expect(result.older).toHaveLength(0)
      })

      it("should group tasks completed yesterday", () => {
        const tasks = [createMockTask({ id: "t1", completedAt: new Date("2026-01-13T15:00:00Z") })]

        const result = groupCompletedByPeriod(tasks)

        expect(result.today).toHaveLength(0)
        expect(result.yesterday).toHaveLength(1)
      })

      it("should group tasks completed last week", () => {
        const tasks = [createMockTask({ id: "t1", completedAt: new Date("2026-01-08T10:00:00Z") })]

        const result = groupCompletedByPeriod(tasks)

        expect(result.lastWeek).toHaveLength(1)
      })

      it("should group older tasks", () => {
        const tasks = [createMockTask({ id: "t1", completedAt: new Date("2025-12-20T10:00:00Z") })]

        const result = groupCompletedByPeriod(tasks)

        expect(result.older).toHaveLength(1)
      })

      it("should sort tasks within each group by completion date (most recent first)", () => {
        const tasks = [
          createMockTask({ id: "t1", completedAt: new Date("2026-01-14T08:00:00Z") }),
          createMockTask({ id: "t2", completedAt: new Date("2026-01-14T10:00:00Z") }),
          createMockTask({ id: "t3", completedAt: new Date("2026-01-14T09:00:00Z") }),
        ]

        const result = groupCompletedByPeriod(tasks)

        expect(result.today[0].id).toBe("t2")
        expect(result.today[1].id).toBe("t3")
        expect(result.today[2].id).toBe("t1")
      })

      it("should skip tasks without completedAt", () => {
        const tasks = [
          createMockTask({ id: "t1", completedAt: new Date("2026-01-14T08:00:00Z") }),
          createMockTask({ id: "t2", completedAt: null }),
        ]

        const result = groupCompletedByPeriod(tasks)

        expect(result.today).toHaveLength(1)
      })
    })

    describe("groupArchivedByMonth", () => {
      it("should group archived tasks by month", () => {
        const tasks = [
          createMockTask({ id: "t1", archivedAt: new Date("2026-01-10") }),
          createMockTask({ id: "t2", archivedAt: new Date("2026-01-05") }),
          createMockTask({ id: "t3", archivedAt: new Date("2025-12-15") }),
        ]

        const result = groupArchivedByMonth(tasks)

        expect(result).toHaveLength(2)
        expect(result[0].monthKey).toBe("2026-01")
        expect(result[0].tasks).toHaveLength(2)
        expect(result[1].monthKey).toBe("2025-12")
        expect(result[1].tasks).toHaveLength(1)
      })

      it("should format month labels correctly", () => {
        const tasks = [createMockTask({ id: "t1", archivedAt: new Date("2026-01-10") })]

        const result = groupArchivedByMonth(tasks)

        expect(result[0].label).toBe("January 2026")
      })

      it("should sort months by most recent first", () => {
        const tasks = [
          createMockTask({ id: "t1", archivedAt: new Date("2025-10-10") }),
          createMockTask({ id: "t2", archivedAt: new Date("2026-01-10") }),
          createMockTask({ id: "t3", archivedAt: new Date("2025-12-15") }),
        ]

        const result = groupArchivedByMonth(tasks)

        expect(result[0].monthKey).toBe("2026-01")
        expect(result[1].monthKey).toBe("2025-12")
        expect(result[2].monthKey).toBe("2025-10")
      })

      it("should sort tasks within month by archived date (most recent first)", () => {
        const tasks = [
          createMockTask({ id: "t1", archivedAt: new Date("2026-01-05") }),
          createMockTask({ id: "t2", archivedAt: new Date("2026-01-15") }),
          createMockTask({ id: "t3", archivedAt: new Date("2026-01-10") }),
        ]

        const result = groupArchivedByMonth(tasks)

        expect(result[0].tasks[0].id).toBe("t2")
        expect(result[0].tasks[1].id).toBe("t3")
        expect(result[0].tasks[2].id).toBe("t1")
      })

      it("should return empty array when no archived tasks", () => {
        const tasks = [createMockTask({ id: "t1", archivedAt: null })]

        const result = groupArchivedByMonth(tasks)

        expect(result).toHaveLength(0)
      })
    })
  })

  // ============================================================================
  // T088: COMPLETION STATISTICS
  // ============================================================================

  describe("T088: Completion Statistics", () => {
    describe("getCompletionStats", () => {
      it("should count tasks completed today", () => {
        const tasks = [
          createMockTask({ id: "t1", completedAt: new Date("2026-01-14T08:00:00Z") }),
          createMockTask({ id: "t2", completedAt: new Date("2026-01-14T09:00:00Z") }),
          createMockTask({ id: "t3", completedAt: new Date("2026-01-13T10:00:00Z") }),
        ]

        const stats = getCompletionStats(tasks)

        expect(stats.today).toBe(2)
      })

      it("should count tasks completed this week (Monday start)", () => {
        const tasks = [
          createMockTask({ id: "t1", completedAt: new Date("2026-01-14T08:00:00Z") }),
          createMockTask({ id: "t2", completedAt: new Date("2026-01-13T08:00:00Z") }),
          createMockTask({ id: "t3", completedAt: new Date("2026-01-12T08:00:00Z") }),
          createMockTask({ id: "t4", completedAt: new Date("2026-01-11T08:00:00Z") }),
        ]

        const stats = getCompletionStats(tasks)

        expect(stats.thisWeek).toBe(3)
      })

      it("should count tasks completed this month", () => {
        const tasks = [
          createMockTask({ id: "t1", completedAt: new Date("2026-01-14T08:00:00Z") }),
          createMockTask({ id: "t2", completedAt: new Date("2026-01-05T08:00:00Z") }),
          createMockTask({ id: "t3", completedAt: new Date("2026-01-01T08:00:00Z") }),
          createMockTask({ id: "t4", completedAt: new Date("2025-12-31T08:00:00Z") }),
        ]

        const stats = getCompletionStats(tasks)

        expect(stats.thisMonth).toBe(3)
      })

      it("should return zeros when no completed tasks", () => {
        const tasks = [createMockTask({ id: "t1", completedAt: null })]

        const stats = getCompletionStats(tasks)

        expect(stats.today).toBe(0)
        expect(stats.thisWeek).toBe(0)
        expect(stats.thisMonth).toBe(0)
        expect(stats.streak).toBe(0)
      })

      it("should include streak in stats", () => {
        const tasks = [
          createMockTask({ id: "t1", completedAt: new Date("2026-01-14T08:00:00Z") }),
          createMockTask({ id: "t2", completedAt: new Date("2026-01-13T08:00:00Z") }),
          createMockTask({ id: "t3", completedAt: new Date("2026-01-12T08:00:00Z") }),
        ]

        const stats = getCompletionStats(tasks)

        expect(stats.streak).toBe(3)
      })
    })

    describe("calculateStreak", () => {
      it("should return 0 when no completed tasks", () => {
        const streak = calculateStreak([])
        expect(streak).toBe(0)
      })

      it("should return 1 for tasks completed only today", () => {
        const tasks = [createMockTask({ id: "t1", completedAt: new Date("2026-01-14T08:00:00Z") })]

        const streak = calculateStreak(tasks)

        expect(streak).toBe(1)
      })

      it("should return 1 for tasks completed only yesterday", () => {
        const tasks = [createMockTask({ id: "t1", completedAt: new Date("2026-01-13T08:00:00Z") })]

        const streak = calculateStreak(tasks)

        expect(streak).toBe(1)
      })

      it("should count consecutive days from today", () => {
        const tasks = [
          createMockTask({ id: "t1", completedAt: new Date("2026-01-14T08:00:00Z") }),
          createMockTask({ id: "t2", completedAt: new Date("2026-01-13T08:00:00Z") }),
          createMockTask({ id: "t3", completedAt: new Date("2026-01-12T08:00:00Z") }),
          createMockTask({ id: "t4", completedAt: new Date("2026-01-11T08:00:00Z") }),
        ]

        const streak = calculateStreak(tasks)

        expect(streak).toBe(4)
      })

      it("should count consecutive days from yesterday when nothing completed today", () => {
        const tasks = [
          createMockTask({ id: "t1", completedAt: new Date("2026-01-13T08:00:00Z") }),
          createMockTask({ id: "t2", completedAt: new Date("2026-01-12T08:00:00Z") }),
        ]

        const streak = calculateStreak(tasks)

        expect(streak).toBe(2)
      })

      it("should break streak on gap day", () => {
        const tasks = [
          createMockTask({ id: "t1", completedAt: new Date("2026-01-14T08:00:00Z") }),
          createMockTask({ id: "t2", completedAt: new Date("2026-01-13T08:00:00Z") }),
          createMockTask({ id: "t3", completedAt: new Date("2026-01-11T08:00:00Z") }),
        ]

        const streak = calculateStreak(tasks)

        expect(streak).toBe(2)
      })

      it("should return 0 when gap before yesterday", () => {
        const tasks = [createMockTask({ id: "t1", completedAt: new Date("2026-01-12T08:00:00Z") })]

        const streak = calculateStreak(tasks)

        expect(streak).toBe(0)
      })

      it("should count multiple completions on same day as one day", () => {
        const tasks = [
          createMockTask({ id: "t1", completedAt: new Date("2026-01-14T08:00:00Z") }),
          createMockTask({ id: "t2", completedAt: new Date("2026-01-14T10:00:00Z") }),
          createMockTask({ id: "t3", completedAt: new Date("2026-01-14T12:00:00Z") }),
        ]

        const streak = calculateStreak(tasks)

        expect(streak).toBe(1)
      })

      it("should handle long streaks correctly", () => {
        const tasks: Task[] = []
        for (let i = 0; i < 10; i++) {
          tasks.push(
            createMockTask({
              id: `t${i}`,
              completedAt: subDays(new Date("2026-01-14T08:00:00Z"), i),
            })
          )
        }

        const streak = calculateStreak(tasks)

        expect(streak).toBe(10)
      })
    })

    describe("filterCompletedBySearch", () => {
      it("should return all tasks when query is empty", () => {
        const tasks = [
          createMockTask({ id: "t1", title: "Buy groceries" }),
          createMockTask({ id: "t2", title: "Walk the dog" }),
        ]

        const result = filterCompletedBySearch(tasks, "")

        expect(result).toHaveLength(2)
      })

      it("should return all tasks when query is whitespace", () => {
        const tasks = [createMockTask({ id: "t1", title: "Buy groceries" })]

        const result = filterCompletedBySearch(tasks, "   ")

        expect(result).toHaveLength(1)
      })

      it("should filter tasks by title (case insensitive)", () => {
        const tasks = [
          createMockTask({ id: "t1", title: "Buy groceries" }),
          createMockTask({ id: "t2", title: "Walk the dog" }),
          createMockTask({ id: "t3", title: "GROCERY shopping" }),
        ]

        const result = filterCompletedBySearch(tasks, "grocer")

        expect(result).toHaveLength(2)
        expect(result.map((t) => t.id)).toContain("t1")
        expect(result.map((t) => t.id)).toContain("t3")
      })

      it("should handle partial matches", () => {
        const tasks = [
          createMockTask({ id: "t1", title: "Meeting with team" }),
          createMockTask({ id: "t2", title: "Team building" }),
        ]

        const result = filterCompletedBySearch(tasks, "team")

        expect(result).toHaveLength(2)
      })

      it("should return empty array when no matches", () => {
        const tasks = [createMockTask({ id: "t1", title: "Buy groceries" })]

        const result = filterCompletedBySearch(tasks, "xyz")

        expect(result).toHaveLength(0)
      })
    })

    describe("getTasksOlderThan", () => {
      it("should return tasks completed more than N days ago", () => {
        const tasks = [
          createMockTask({ id: "t1", completedAt: new Date("2026-01-14T08:00:00Z") }),
          createMockTask({ id: "t2", completedAt: new Date("2026-01-07T08:00:00Z") }),
          createMockTask({ id: "t3", completedAt: new Date("2026-01-01T08:00:00Z") }),
        ]

        const result = getTasksOlderThan(tasks, 7)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("t3")
      })

      it("should exclude tasks without completedAt", () => {
        const tasks = [
          createMockTask({ id: "t1", completedAt: null }),
          createMockTask({ id: "t2", completedAt: new Date("2026-01-01T08:00:00Z") }),
        ]

        const result = getTasksOlderThan(tasks, 7)

        expect(result).toHaveLength(1)
      })

      it("should return empty array when all tasks are recent", () => {
        const tasks = [
          createMockTask({ id: "t1", completedAt: new Date("2026-01-14T08:00:00Z") }),
          createMockTask({ id: "t2", completedAt: new Date("2026-01-13T08:00:00Z") }),
        ]

        const result = getTasksOlderThan(tasks, 7)

        expect(result).toHaveLength(0)
      })

      it("should handle edge case at exactly N days", () => {
        const tasks = [createMockTask({ id: "t1", completedAt: new Date("2026-01-07T08:00:00Z") })]

        const result = getTasksOlderThan(tasks, 7)

        expect(result).toHaveLength(0)
      })

      it("should work with 0 days (all completed tasks from before today)", () => {
        const tasks = [
          createMockTask({ id: "t1", completedAt: new Date("2026-01-14T00:00:00Z") }),
          createMockTask({ id: "t2", completedAt: new Date("2026-01-13T00:00:00Z") }),
        ]

        const result = getTasksOlderThan(tasks, 0)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("t2")
      })
    })
  })

  // ============================================================================
  // T089: ADVANCED FILTERS & COMPOSITION
  // ============================================================================

  describe("T089: Advanced Filters & Composition", () => {
    describe("applyFiltersAndSort", () => {
      let project: Project
      let project2: Project
      let projects: Project[]

      beforeEach(() => {
        project = createMockProject({ id: "project-1", name: "Alpha Project" })
        project2 = createMockProject({ id: "project-2", name: "Beta Project" })
        projects = [project, project2]
      })

      it("should apply search filter", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            title: "Buy groceries",
            projectId: "project-1",
            statusId: "status-todo",
          }),
          createMockTask({
            id: "t2",
            title: "Walk the dog",
            projectId: "project-1",
            statusId: "status-todo",
          }),
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), search: "grocer" }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("t1")
      })

      it("should apply project filter", () => {
        const tasks = [
          createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo" }),
          createMockTask({ id: "t2", projectId: "project-2", statusId: "status-todo" }),
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), projectIds: ["project-1"] }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("t1")
      })

      it("should apply priority filter", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            priority: "high",
          }),
          createMockTask({ id: "t2", projectId: "project-1", statusId: "status-todo", priority: "low" }),
          createMockTask({
            id: "t3",
            projectId: "project-1",
            statusId: "status-todo",
            priority: "urgent",
          }),
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), priorities: ["high", "urgent"] }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(2)
        expect(result.map((t) => t.id)).toContain("t1")
        expect(result.map((t) => t.id)).toContain("t3")
      })

      it("should apply due date filter - today", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-14"),
          }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-15"),
          }),
        ]

        const filters: TaskFilters = {
          ...createDefaultFilters(),
          dueDate: { type: "today", customStart: null, customEnd: null },
        }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("t1")
      })

      it("should apply due date filter - overdue", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-10"),
          }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-14"),
          }),
        ]

        const filters: TaskFilters = {
          ...createDefaultFilters(),
          dueDate: { type: "overdue", customStart: null, customEnd: null },
        }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("t1")
      })

      it("should apply due date filter - none", () => {
        const tasks = [
          createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo", dueDate: null }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-14"),
          }),
        ]

        const filters: TaskFilters = {
          ...createDefaultFilters(),
          dueDate: { type: "none", customStart: null, customEnd: null },
        }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("t1")
      })

      it("should apply due date filter - custom range", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-15"),
          }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-20"),
          }),
          createMockTask({
            id: "t3",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-25"),
          }),
        ]

        const filters: TaskFilters = {
          ...createDefaultFilters(),
          dueDate: {
            type: "custom",
            customStart: new Date("2026-01-15"),
            customEnd: new Date("2026-01-20"),
          },
        }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(2)
        expect(result.map((t) => t.id)).toContain("t1")
        expect(result.map((t) => t.id)).toContain("t2")
      })

      it("should apply status filter", () => {
        const tasks = [
          createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo" }),
          createMockTask({ id: "t2", projectId: "project-1", statusId: "status-in-progress" }),
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), statusIds: ["status-todo"] }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("t1")
      })

      it("should apply completion filter - active", () => {
        const tasks = [
          createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo" }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-done",
            completedAt: new Date(),
          }),
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), completion: "active" }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("t1")
      })

      it("should apply completion filter - completed", () => {
        const tasks = [
          createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo" }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-done",
            completedAt: new Date(),
          }),
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), completion: "completed" }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("t2")
      })

      it("should apply repeat type filter - repeating", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            isRepeating: true,
          }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            isRepeating: false,
          }),
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), repeatType: "repeating" }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("t1")
      })

      it("should apply repeat type filter - one-time", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            isRepeating: true,
          }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            isRepeating: false,
          }),
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), repeatType: "one-time" }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("t2")
      })

      it("should apply has time filter - with-time", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            dueTime: "14:30",
          }),
          createMockTask({ id: "t2", projectId: "project-1", statusId: "status-todo", dueTime: null }),
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), hasTime: "with-time" }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("t1")
      })

      it("should apply has time filter - without-time", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            dueTime: "14:30",
          }),
          createMockTask({ id: "t2", projectId: "project-1", statusId: "status-todo", dueTime: null }),
        ]

        const filters: TaskFilters = { ...createDefaultFilters(), hasTime: "without-time" }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("t2")
      })

      it("should apply sort by due date ascending", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-20"),
          }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-15"),
          }),
          createMockTask({
            id: "t3",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-18"),
          }),
        ]

        const filters = createDefaultFilters()
        const sort: TaskSort = { field: "dueDate", direction: "asc" }

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result[0].id).toBe("t2")
        expect(result[1].id).toBe("t3")
        expect(result[2].id).toBe("t1")
      })

      it("should apply sort by due date descending", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-20"),
          }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-15"),
          }),
        ]

        const filters = createDefaultFilters()
        const sort: TaskSort = { field: "dueDate", direction: "desc" }

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result[0].id).toBe("t1")
        expect(result[1].id).toBe("t2")
      })

      it("should apply sort by priority", () => {
        const tasks = [
          createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo", priority: "low" }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            priority: "urgent",
          }),
          createMockTask({
            id: "t3",
            projectId: "project-1",
            statusId: "status-todo",
            priority: "high",
          }),
        ]

        const filters = createDefaultFilters()
        const sort: TaskSort = { field: "priority", direction: "asc" }

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result[0].id).toBe("t2")
        expect(result[1].id).toBe("t3")
        expect(result[2].id).toBe("t1")
      })

      it("should apply sort by title", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            title: "Zebra task",
            projectId: "project-1",
            statusId: "status-todo",
          }),
          createMockTask({
            id: "t2",
            title: "Alpha task",
            projectId: "project-1",
            statusId: "status-todo",
          }),
          createMockTask({
            id: "t3",
            title: "Beta task",
            projectId: "project-1",
            statusId: "status-todo",
          }),
        ]

        const filters = createDefaultFilters()
        const sort: TaskSort = { field: "title", direction: "asc" }

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result[0].id).toBe("t2")
        expect(result[1].id).toBe("t3")
        expect(result[2].id).toBe("t1")
      })

      it("should apply sort by project name", () => {
        const tasks = [
          createMockTask({ id: "t1", projectId: "project-2", statusId: "status-todo" }),
          createMockTask({ id: "t2", projectId: "project-1", statusId: "status-todo" }),
        ]

        const filters = createDefaultFilters()
        const sort: TaskSort = { field: "project", direction: "asc" }

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result[0].id).toBe("t2")
        expect(result[1].id).toBe("t1")
      })

      it("should apply multiple filters combined", () => {
        const tasks = [
          createMockTask({
            id: "t1",
            projectId: "project-1",
            statusId: "status-todo",
            priority: "high",
            dueDate: new Date("2026-01-14"),
          }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            priority: "low",
            dueDate: new Date("2026-01-14"),
          }),
          createMockTask({
            id: "t3",
            projectId: "project-2",
            statusId: "status-todo",
            priority: "high",
            dueDate: new Date("2026-01-14"),
          }),
          createMockTask({
            id: "t4",
            projectId: "project-1",
            statusId: "status-todo",
            priority: "high",
            dueDate: new Date("2026-01-15"),
          }),
        ]

        const filters: TaskFilters = {
          ...createDefaultFilters(),
          projectIds: ["project-1"],
          priorities: ["high"],
          dueDate: { type: "today", customStart: null, customEnd: null },
        }
        const sort = createDefaultSort()

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("t1")
      })

      it("should put tasks without due date at end when sorting by due date", () => {
        const tasks = [
          createMockTask({ id: "t1", projectId: "project-1", statusId: "status-todo", dueDate: null }),
          createMockTask({
            id: "t2",
            projectId: "project-1",
            statusId: "status-todo",
            dueDate: new Date("2026-01-15"),
          }),
        ]

        const filters = createDefaultFilters()
        const sort: TaskSort = { field: "dueDate", direction: "asc" }

        const result = applyFiltersAndSort(tasks, filters, sort, projects)

        expect(result[0].id).toBe("t2")
        expect(result[1].id).toBe("t1")
      })
    })

    describe("hasActiveFilters", () => {
      it("should return false for default filters", () => {
        const filters = createDefaultFilters()
        expect(hasActiveFilters(filters)).toBe(false)
      })

      it("should return true when search is set", () => {
        const filters: TaskFilters = { ...createDefaultFilters(), search: "test" }
        expect(hasActiveFilters(filters)).toBe(true)
      })

      it("should return true when projectIds is set", () => {
        const filters: TaskFilters = { ...createDefaultFilters(), projectIds: ["p1"] }
        expect(hasActiveFilters(filters)).toBe(true)
      })

      it("should return true when priorities is set", () => {
        const filters: TaskFilters = { ...createDefaultFilters(), priorities: ["high"] }
        expect(hasActiveFilters(filters)).toBe(true)
      })

      it("should return true when dueDate type is not 'any'", () => {
        const filters: TaskFilters = {
          ...createDefaultFilters(),
          dueDate: { type: "today", customStart: null, customEnd: null },
        }
        expect(hasActiveFilters(filters)).toBe(true)
      })

      it("should return true when statusIds is set", () => {
        const filters: TaskFilters = { ...createDefaultFilters(), statusIds: ["s1"] }
        expect(hasActiveFilters(filters)).toBe(true)
      })

      it("should return true when completion is not 'active'", () => {
        const filters: TaskFilters = { ...createDefaultFilters(), completion: "completed" }
        expect(hasActiveFilters(filters)).toBe(true)
      })

      it("should return true when repeatType is not 'all'", () => {
        const filters: TaskFilters = { ...createDefaultFilters(), repeatType: "repeating" }
        expect(hasActiveFilters(filters)).toBe(true)
      })

      it("should return true when hasTime is not 'all'", () => {
        const filters: TaskFilters = { ...createDefaultFilters(), hasTime: "with-time" }
        expect(hasActiveFilters(filters)).toBe(true)
      })
    })

    describe("countActiveFilters", () => {
      it("should return 0 for default filters", () => {
        const filters = createDefaultFilters()
        expect(countActiveFilters(filters)).toBe(0)
      })

      it("should count each active filter type", () => {
        const filters: TaskFilters = {
          ...createDefaultFilters(),
          search: "test",
          projectIds: ["p1"],
          priorities: ["high"],
        }
        expect(countActiveFilters(filters)).toBe(3)
      })

      it("should count all 8 possible filter types", () => {
        const filters: TaskFilters = {
          search: "test",
          projectIds: ["p1"],
          priorities: ["high"],
          dueDate: { type: "today", customStart: null, customEnd: null },
          statusIds: ["s1"],
          completion: "completed",
          repeatType: "repeating",
          hasTime: "with-time",
        }
        expect(countActiveFilters(filters)).toBe(8)
      })

      it("should not count empty arrays as active", () => {
        const filters: TaskFilters = {
          ...createDefaultFilters(),
          projectIds: [],
          priorities: [],
        }
        expect(countActiveFilters(filters)).toBe(0)
      })
    })

    describe("Group header configurations", () => {
      describe("dueDateGroupConfig", () => {
        it("should have correct urgency levels", () => {
          expect(dueDateGroupConfig.overdue.urgency).toBe("critical")
          expect(dueDateGroupConfig.today.urgency).toBe("high")
          expect(dueDateGroupConfig.tomorrow.urgency).toBe("normal")
          expect(dueDateGroupConfig.upcoming.urgency).toBe("normal")
          expect(dueDateGroupConfig.later.urgency).toBe("low")
          expect(dueDateGroupConfig.noDueDate.urgency).toBe("low")
        })

        it("should have accent colors for critical/high urgency", () => {
          expect(dueDateGroupConfig.overdue.accentColor).toBe("#ef4444")
          expect(dueDateGroupConfig.today.accentColor).toBe("#3b82f6")
        })

        it("should have isMuted for low urgency", () => {
          expect(dueDateGroupConfig.later.isMuted).toBe(true)
          expect(dueDateGroupConfig.noDueDate.isMuted).toBe(true)
        })

        it("should have correct labels", () => {
          expect(dueDateGroupConfig.overdue.label).toBe("OVERDUE")
          expect(dueDateGroupConfig.today.label).toBe("TODAY")
          expect(dueDateGroupConfig.tomorrow.label).toBe("TOMORROW")
          expect(dueDateGroupConfig.upcoming.label).toBe("UPCOMING")
          expect(dueDateGroupConfig.later.label).toBe("LATER")
          expect(dueDateGroupConfig.noDueDate.label).toBe("NO DUE DATE")
        })
      })

      describe("completionGroupConfig", () => {
        it("should have correct urgency levels", () => {
          expect(completionGroupConfig.today.urgency).toBe("high")
          expect(completionGroupConfig.yesterday.urgency).toBe("normal")
          expect(completionGroupConfig.earlier.urgency).toBe("low")
        })

        it("should have green accent color for today", () => {
          expect(completionGroupConfig.today.accentColor).toBe("#10b981")
        })

        it("should have correct labels", () => {
          expect(completionGroupConfig.today.label).toBe("TODAY")
          expect(completionGroupConfig.yesterday.label).toBe("YESTERDAY")
          expect(completionGroupConfig.earlier.label).toBe("EARLIER")
        })
      })

      describe("completionPeriodConfig", () => {
        it("should have all period keys", () => {
          expect(completionPeriodConfig.today).toBeDefined()
          expect(completionPeriodConfig.yesterday).toBeDefined()
          expect(completionPeriodConfig.earlierThisWeek).toBeDefined()
          expect(completionPeriodConfig.lastWeek).toBeDefined()
          expect(completionPeriodConfig.older).toBeDefined()
        })

        it("should have correct urgency progression", () => {
          expect(completionPeriodConfig.today.urgency).toBe("high")
          expect(completionPeriodConfig.yesterday.urgency).toBe("normal")
          expect(completionPeriodConfig.earlierThisWeek.urgency).toBe("normal")
          expect(completionPeriodConfig.lastWeek.urgency).toBe("low")
          expect(completionPeriodConfig.older.urgency).toBe("low")
        })

        it("should have isMuted for older periods", () => {
          expect(completionPeriodConfig.lastWeek.isMuted).toBe(true)
          expect(completionPeriodConfig.older.isMuted).toBe(true)
        })

        it("should have correct labels", () => {
          expect(completionPeriodConfig.earlierThisWeek.label).toBe("EARLIER THIS WEEK")
          expect(completionPeriodConfig.lastWeek.label).toBe("LAST WEEK")
          expect(completionPeriodConfig.older.label).toBe("OLDER")
        })
      })
    })
  })
})
