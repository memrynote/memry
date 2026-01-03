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
})
