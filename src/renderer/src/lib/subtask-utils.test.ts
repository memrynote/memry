import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { Task, Priority } from "@/data/sample-tasks"

// Mock generateTaskId
vi.mock("@/data/sample-tasks", async () => {
  const actual = await vi.importActual("@/data/sample-tasks")
  let idCounter = 0
  return {
    ...actual,
    generateTaskId: () => `generated-task-${++idCounter}`,
  }
})

import {
  // Types
  type SubtaskProgress,
  type TaskWithSubtasks,
  type SubtaskOperationResult,
  type CreateSubtaskOptions,
  // Helper functions
  isSubtask,
  hasSubtasks,
  getSubtasks,
  getParentTask,
  getTopLevelTasks,
  calculateProgress,
  buildTaskTree,
  getAllSubtaskIds,
  canHaveSubtasks,
  validateSubtaskRelationship,
  filterTasksWithSubtasks,
  sortTasksWithSubtasks,
  // CRUD operations
  createSubtask,
  createMultipleSubtasks,
  reorderSubtasks,
  promoteToTask,
  demoteToSubtask,
  deleteSubtask,
  deleteParentWithSubtasks,
  // Completion handling
  completeParentWithSubtasks,
  getIncompleteSubtasks,
  hasIncompleteSubtasks,
  getPotentialParents,
} from "./subtask-utils"

// ============================================================================
// MOCK FACTORY
// ============================================================================

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
  createdAt: new Date(),
  completedAt: null,
  archivedAt: null,
  ...overrides,
})

// ============================================================================
// TEST SETUP
// ============================================================================

describe("subtask-utils", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 10)) // January 10, 2026
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  // ==========================================================================
  // T091: SUBTASK HELPER FUNCTIONS
  // ==========================================================================

  describe("T091: Subtask Helper Functions", () => {
    describe("isSubtask", () => {
      it("returns true when task has a parentId", () => {
        const task = createMockTask({ parentId: "parent-1" })
        expect(isSubtask(task)).toBe(true)
      })

      it("returns false when task has no parentId (null)", () => {
        const task = createMockTask({ parentId: null })
        expect(isSubtask(task)).toBe(false)
      })

      it("returns false for top-level task", () => {
        const task = createMockTask()
        expect(isSubtask(task)).toBe(false)
      })
    })

    describe("hasSubtasks", () => {
      it("returns true when subtaskIds is not empty", () => {
        const task = createMockTask({ subtaskIds: ["sub-1", "sub-2"] })
        expect(hasSubtasks(task)).toBe(true)
      })

      it("returns false when subtaskIds is empty", () => {
        const task = createMockTask({ subtaskIds: [] })
        expect(hasSubtasks(task)).toBe(false)
      })

      it("returns true with single subtask", () => {
        const task = createMockTask({ subtaskIds: ["sub-1"] })
        expect(hasSubtasks(task)).toBe(true)
      })
    })

    describe("getSubtasks", () => {
      it("returns subtasks in order of subtaskIds", () => {
        const subtask1 = createMockTask({ id: "sub-1", parentId: "parent-1" })
        const subtask2 = createMockTask({ id: "sub-2", parentId: "parent-1" })
        const subtask3 = createMockTask({ id: "sub-3", parentId: "parent-1" })
        const parent = createMockTask({
          id: "parent-1",
          subtaskIds: ["sub-2", "sub-1", "sub-3"],
        })

        const allTasks = [parent, subtask1, subtask2, subtask3]
        const result = getSubtasks("parent-1", allTasks)

        expect(result).toHaveLength(3)
        expect(result[0].id).toBe("sub-2")
        expect(result[1].id).toBe("sub-1")
        expect(result[2].id).toBe("sub-3")
      })

      it("returns empty array when parent not found", () => {
        const task = createMockTask({ id: "task-1" })
        const result = getSubtasks("nonexistent", [task])
        expect(result).toEqual([])
      })

      it("returns empty array when parent has no subtasks", () => {
        const parent = createMockTask({ id: "parent-1", subtaskIds: [] })
        const result = getSubtasks("parent-1", [parent])
        expect(result).toEqual([])
      })

      it("filters out subtasks that do not exist in allTasks", () => {
        const subtask1 = createMockTask({ id: "sub-1", parentId: "parent-1" })
        const parent = createMockTask({
          id: "parent-1",
          subtaskIds: ["sub-1", "sub-2", "sub-3"],
        })

        const allTasks = [parent, subtask1]
        const result = getSubtasks("parent-1", allTasks)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("sub-1")
      })
    })

    describe("getParentTask", () => {
      it("finds parent by parentId", () => {
        const parent = createMockTask({ id: "parent-1" })
        const subtask = createMockTask({ id: "sub-1", parentId: "parent-1" })
        const allTasks = [parent, subtask]

        const result = getParentTask(subtask, allTasks)

        expect(result).not.toBeNull()
        expect(result?.id).toBe("parent-1")
      })

      it("returns null when task has no parentId", () => {
        const task = createMockTask({ parentId: null })
        const result = getParentTask(task, [task])
        expect(result).toBeNull()
      })

      it("returns null when parent not found in allTasks", () => {
        const subtask = createMockTask({ parentId: "nonexistent" })
        const result = getParentTask(subtask, [subtask])
        expect(result).toBeNull()
      })
    })

    describe("getTopLevelTasks", () => {
      it("filters to tasks with parentId === null", () => {
        const topLevel1 = createMockTask({ id: "top-1", parentId: null })
        const topLevel2 = createMockTask({ id: "top-2", parentId: null })
        const subtask1 = createMockTask({ id: "sub-1", parentId: "top-1" })
        const subtask2 = createMockTask({ id: "sub-2", parentId: "top-2" })

        const allTasks = [topLevel1, subtask1, topLevel2, subtask2]
        const result = getTopLevelTasks(allTasks)

        expect(result).toHaveLength(2)
        expect(result.map((t) => t.id)).toEqual(["top-1", "top-2"])
      })

      it("returns empty array when all tasks are subtasks", () => {
        const subtask1 = createMockTask({ id: "sub-1", parentId: "parent-1" })
        const subtask2 = createMockTask({ id: "sub-2", parentId: "parent-2" })

        const result = getTopLevelTasks([subtask1, subtask2])
        expect(result).toEqual([])
      })

      it("returns all tasks when none are subtasks", () => {
        const task1 = createMockTask({ id: "task-1" })
        const task2 = createMockTask({ id: "task-2" })
        const task3 = createMockTask({ id: "task-3" })

        const result = getTopLevelTasks([task1, task2, task3])
        expect(result).toHaveLength(3)
      })
    })

    describe("getAllSubtaskIds", () => {
      it("returns subtaskIds for parent task", () => {
        const parent = createMockTask({
          id: "parent-1",
          subtaskIds: ["sub-1", "sub-2", "sub-3"],
        })
        const result = getAllSubtaskIds("parent-1", [parent])
        expect(result).toEqual(["sub-1", "sub-2", "sub-3"])
      })

      it("returns empty array when parent not found", () => {
        const result = getAllSubtaskIds("nonexistent", [])
        expect(result).toEqual([])
      })

      it("returns empty array when parent has no subtasks", () => {
        const parent = createMockTask({ id: "parent-1", subtaskIds: [] })
        const result = getAllSubtaskIds("parent-1", [parent])
        expect(result).toEqual([])
      })
    })
  })

  // ==========================================================================
  // T092: PROGRESS CALCULATION
  // ==========================================================================

  describe("T092: Progress Calculation", () => {
    describe("calculateProgress", () => {
      it("returns zero values for empty array", () => {
        const result = calculateProgress([])
        expect(result).toEqual({ total: 0, completed: 0, percentage: 0 })
      })

      it("calculates correct percentage for partial completion", () => {
        const tasks = [
          createMockTask({ id: "1", completedAt: new Date() }),
          createMockTask({ id: "2", completedAt: null }),
          createMockTask({ id: "3", completedAt: null }),
        ]

        const result = calculateProgress(tasks)
        expect(result).toEqual({ total: 3, completed: 1, percentage: 33 })
      })

      it("returns 100% when all tasks completed", () => {
        const tasks = [
          createMockTask({ id: "1", completedAt: new Date() }),
          createMockTask({ id: "2", completedAt: new Date() }),
        ]

        const result = calculateProgress(tasks)
        expect(result).toEqual({ total: 2, completed: 2, percentage: 100 })
      })

      it("returns 0% when no tasks completed", () => {
        const tasks = [
          createMockTask({ id: "1", completedAt: null }),
          createMockTask({ id: "2", completedAt: null }),
        ]

        const result = calculateProgress(tasks)
        expect(result).toEqual({ total: 2, completed: 0, percentage: 0 })
      })

      it("rounds percentage correctly", () => {
        // 2/3 = 0.666... should round to 67
        const tasks = [
          createMockTask({ id: "1", completedAt: new Date() }),
          createMockTask({ id: "2", completedAt: new Date() }),
          createMockTask({ id: "3", completedAt: null }),
        ]

        const result = calculateProgress(tasks)
        expect(result.percentage).toBe(67)
      })

      it("calculates 50% for half completed", () => {
        const tasks = [
          createMockTask({ id: "1", completedAt: new Date() }),
          createMockTask({ id: "2", completedAt: null }),
        ]

        const result = calculateProgress(tasks)
        expect(result.percentage).toBe(50)
      })

      it("handles single completed task", () => {
        const tasks = [createMockTask({ id: "1", completedAt: new Date() })]
        const result = calculateProgress(tasks)
        expect(result).toEqual({ total: 1, completed: 1, percentage: 100 })
      })

      it("handles single incomplete task", () => {
        const tasks = [createMockTask({ id: "1", completedAt: null })]
        const result = calculateProgress(tasks)
        expect(result).toEqual({ total: 1, completed: 0, percentage: 0 })
      })
    })

    describe("buildTaskTree", () => {
      it("returns TaskWithSubtasks[] with progress attached", () => {
        const subtask1 = createMockTask({
          id: "sub-1",
          parentId: "parent-1",
          completedAt: new Date(),
        })
        const subtask2 = createMockTask({
          id: "sub-2",
          parentId: "parent-1",
          completedAt: null,
        })
        const parent = createMockTask({
          id: "parent-1",
          subtaskIds: ["sub-1", "sub-2"],
        })

        const allTasks = [parent, subtask1, subtask2]
        const result = buildTaskTree(allTasks)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("parent-1")
        expect(result[0].subtasks).toHaveLength(2)
        expect(result[0].progress).toEqual({
          total: 2,
          completed: 1,
          percentage: 50,
        })
      })

      it("includes only top-level tasks", () => {
        const parent1 = createMockTask({ id: "p-1", subtaskIds: [] })
        const parent2 = createMockTask({ id: "p-2", subtaskIds: ["sub-1"] })
        const subtask = createMockTask({ id: "sub-1", parentId: "p-2" })

        const result = buildTaskTree([parent1, parent2, subtask])

        expect(result).toHaveLength(2)
        expect(result.map((t) => t.id)).toEqual(["p-1", "p-2"])
      })

      it("returns empty subtasks array for tasks without children", () => {
        const parent = createMockTask({ id: "parent-1", subtaskIds: [] })

        const result = buildTaskTree([parent])

        expect(result).toHaveLength(1)
        expect(result[0].subtasks).toEqual([])
        expect(result[0].progress).toEqual({
          total: 0,
          completed: 0,
          percentage: 0,
        })
      })

      it("maintains subtask order from subtaskIds", () => {
        const subtask1 = createMockTask({ id: "sub-1", parentId: "p-1" })
        const subtask2 = createMockTask({ id: "sub-2", parentId: "p-1" })
        const subtask3 = createMockTask({ id: "sub-3", parentId: "p-1" })
        const parent = createMockTask({
          id: "p-1",
          subtaskIds: ["sub-3", "sub-1", "sub-2"],
        })

        const result = buildTaskTree([parent, subtask1, subtask2, subtask3])

        expect(result[0].subtasks.map((s) => s.id)).toEqual([
          "sub-3",
          "sub-1",
          "sub-2",
        ])
      })

      it("handles multiple parents with different progress", () => {
        const p1Sub = createMockTask({
          id: "p1-sub",
          parentId: "p-1",
          completedAt: new Date(),
        })
        const p2Sub1 = createMockTask({ id: "p2-sub1", parentId: "p-2" })
        const p2Sub2 = createMockTask({ id: "p2-sub2", parentId: "p-2" })
        const parent1 = createMockTask({ id: "p-1", subtaskIds: ["p1-sub"] })
        const parent2 = createMockTask({
          id: "p-2",
          subtaskIds: ["p2-sub1", "p2-sub2"],
        })

        const result = buildTaskTree([parent1, parent2, p1Sub, p2Sub1, p2Sub2])

        expect(result).toHaveLength(2)
        expect(result[0].progress.percentage).toBe(100)
        expect(result[1].progress.percentage).toBe(0)
      })
    })
  })

  // ==========================================================================
  // T093: VALIDATION & CONSTRAINTS
  // ==========================================================================

  describe("T093: Validation & Constraints", () => {
    describe("canHaveSubtasks", () => {
      it("returns true only if parentId === null", () => {
        const topLevelTask = createMockTask({ parentId: null })
        expect(canHaveSubtasks(topLevelTask)).toBe(true)
      })

      it("returns false if task is a subtask", () => {
        const subtask = createMockTask({ parentId: "parent-1" })
        expect(canHaveSubtasks(subtask)).toBe(false)
      })
    })

    describe("validateSubtaskRelationship", () => {
      it('returns error "A task cannot be its own parent"', () => {
        const task = createMockTask({ id: "task-1" })
        const result = validateSubtaskRelationship("task-1", "task-1", [task])

        expect(result).toEqual({
          valid: false,
          error: "A task cannot be its own parent",
        })
      })

      it('returns error "Parent or subtask not found" when parent missing', () => {
        const subtask = createMockTask({ id: "subtask-1" })
        const result = validateSubtaskRelationship("nonexistent", "subtask-1", [
          subtask,
        ])

        expect(result).toEqual({
          valid: false,
          error: "Parent or subtask not found",
        })
      })

      it('returns error "Parent or subtask not found" when subtask missing', () => {
        const parent = createMockTask({ id: "parent-1" })
        const result = validateSubtaskRelationship("parent-1", "nonexistent", [
          parent,
        ])

        expect(result).toEqual({
          valid: false,
          error: "Parent or subtask not found",
        })
      })

      it('returns error "Subtask must belong to the same project as parent"', () => {
        const parent = createMockTask({ id: "parent-1", projectId: "project-a" })
        const subtask = createMockTask({
          id: "subtask-1",
          projectId: "project-b",
        })

        const result = validateSubtaskRelationship("parent-1", "subtask-1", [
          parent,
          subtask,
        ])

        expect(result).toEqual({
          valid: false,
          error: "Subtask must belong to the same project as parent",
        })
      })

      it('returns error "Cannot add subtasks to a subtask (no nested subtasks)"', () => {
        const grandparent = createMockTask({ id: "grandparent" })
        const parent = createMockTask({
          id: "parent-1",
          parentId: "grandparent",
          projectId: "project-1",
        })
        const subtask = createMockTask({
          id: "subtask-1",
          projectId: "project-1",
        })

        const result = validateSubtaskRelationship("parent-1", "subtask-1", [
          grandparent,
          parent,
          subtask,
        ])

        expect(result).toEqual({
          valid: false,
          error: "Cannot add subtasks to a subtask (no nested subtasks)",
        })
      })

      it('returns error "Cannot make a parent task into a subtask"', () => {
        const parent = createMockTask({
          id: "parent-1",
          projectId: "project-1",
        })
        const taskWithChildren = createMockTask({
          id: "task-with-children",
          projectId: "project-1",
          subtaskIds: ["child-1"],
        })

        const result = validateSubtaskRelationship(
          "parent-1",
          "task-with-children",
          [parent, taskWithChildren]
        )

        expect(result).toEqual({
          valid: false,
          error: "Cannot make a parent task into a subtask",
        })
      })

      it("returns valid for valid relationships", () => {
        const parent = createMockTask({
          id: "parent-1",
          projectId: "project-1",
          parentId: null,
        })
        const potentialSubtask = createMockTask({
          id: "subtask-1",
          projectId: "project-1",
          parentId: null,
          subtaskIds: [],
        })

        const result = validateSubtaskRelationship("parent-1", "subtask-1", [
          parent,
          potentialSubtask,
        ])

        expect(result).toEqual({ valid: true })
      })

      it("allows adding subtask to parent with existing subtasks", () => {
        const existingSubtask = createMockTask({
          id: "existing-sub",
          parentId: "parent-1",
          projectId: "project-1",
        })
        const parent = createMockTask({
          id: "parent-1",
          projectId: "project-1",
          subtaskIds: ["existing-sub"],
        })
        const newSubtask = createMockTask({
          id: "new-sub",
          projectId: "project-1",
        })

        const result = validateSubtaskRelationship("parent-1", "new-sub", [
          parent,
          existingSubtask,
          newSubtask,
        ])

        expect(result).toEqual({ valid: true })
      })
    })
  })

  // ==========================================================================
  // T094: FILTERING & SORTING
  // ==========================================================================

  describe("T094: Filtering & Sorting", () => {
    describe("filterTasksWithSubtasks", () => {
      it("includes matching top-level tasks", () => {
        const matching = createMockTask({
          id: "match-1",
          title: "Important",
          priority: "high",
        })
        const nonMatching = createMockTask({
          id: "no-match",
          title: "Normal",
          priority: "none",
        })

        const result = filterTasksWithSubtasks(
          [matching, nonMatching],
          (t) => t.priority === "high"
        )

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("match-1")
      })

      it("includes subtasks of matching parents", () => {
        const parent = createMockTask({
          id: "parent-1",
          priority: "high",
          subtaskIds: ["sub-1"],
        })
        const subtask = createMockTask({
          id: "sub-1",
          parentId: "parent-1",
          priority: "none",
        })

        const result = filterTasksWithSubtasks(
          [parent, subtask],
          (t) => t.priority === "high"
        )

        expect(result).toHaveLength(2)
        expect(result.map((t) => t.id)).toContain("parent-1")
        expect(result.map((t) => t.id)).toContain("sub-1")
      })

      it("excludes non-matching parents and their subtasks", () => {
        const parent = createMockTask({
          id: "parent-1",
          priority: "none",
          subtaskIds: ["sub-1"],
        })
        const subtask = createMockTask({
          id: "sub-1",
          parentId: "parent-1",
          priority: "high",
        })
        const matchingTop = createMockTask({
          id: "match-1",
          priority: "high",
        })

        const result = filterTasksWithSubtasks(
          [parent, subtask, matchingTop],
          (t) => t.priority === "high"
        )

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("match-1")
      })

      it("filters by due date", () => {
        const today = new Date()
        const parent = createMockTask({
          id: "parent-1",
          dueDate: today,
          subtaskIds: ["sub-1"],
        })
        const subtask = createMockTask({
          id: "sub-1",
          parentId: "parent-1",
          dueDate: null,
        })
        const noDate = createMockTask({ id: "no-date", dueDate: null })

        const result = filterTasksWithSubtasks(
          [parent, subtask, noDate],
          (t) => t.dueDate !== null
        )

        expect(result).toHaveLength(2)
        expect(result.map((t) => t.id)).toEqual(["parent-1", "sub-1"])
      })

      it("returns empty when no matches", () => {
        const task = createMockTask({ priority: "none" })

        const result = filterTasksWithSubtasks(
          [task],
          (t) => t.priority === "urgent"
        )

        expect(result).toEqual([])
      })

      it("handles complex filter with multiple subtasks", () => {
        const parent1 = createMockTask({
          id: "p1",
          priority: "high",
          subtaskIds: ["s1", "s2"],
        })
        const sub1 = createMockTask({ id: "s1", parentId: "p1" })
        const sub2 = createMockTask({ id: "s2", parentId: "p1" })
        const parent2 = createMockTask({
          id: "p2",
          priority: "none",
          subtaskIds: ["s3"],
        })
        const sub3 = createMockTask({ id: "s3", parentId: "p2" })

        const result = filterTasksWithSubtasks(
          [parent1, sub1, sub2, parent2, sub3],
          (t) => t.priority === "high"
        )

        expect(result).toHaveLength(3)
        expect(result.map((t) => t.id)).toEqual(["p1", "s1", "s2"])
      })
    })

    describe("sortTasksWithSubtasks", () => {
      it("sorts top-level tasks by comparator", () => {
        const task1 = createMockTask({
          id: "task-1",
          title: "Zebra",
          subtaskIds: [],
        })
        const task2 = createMockTask({
          id: "task-2",
          title: "Apple",
          subtaskIds: [],
        })

        const result = sortTasksWithSubtasks([task1, task2], (a, b) =>
          a.title.localeCompare(b.title)
        )

        expect(result.map((t) => t.id)).toEqual(["task-2", "task-1"])
      })

      it("keeps subtasks immediately after their parent", () => {
        const parent1 = createMockTask({
          id: "p1",
          title: "Zebra",
          subtaskIds: ["s1", "s2"],
        })
        const sub1 = createMockTask({ id: "s1", parentId: "p1", title: "Sub1" })
        const sub2 = createMockTask({ id: "s2", parentId: "p1", title: "Sub2" })
        const parent2 = createMockTask({
          id: "p2",
          title: "Apple",
          subtaskIds: [],
        })

        const result = sortTasksWithSubtasks(
          [parent1, sub1, sub2, parent2],
          (a, b) => a.title.localeCompare(b.title)
        )

        expect(result.map((t) => t.id)).toEqual(["p2", "p1", "s1", "s2"])
      })

      it("preserves subtask order from subtaskIds", () => {
        const parent = createMockTask({
          id: "p1",
          subtaskIds: ["s3", "s1", "s2"],
        })
        const sub1 = createMockTask({ id: "s1", parentId: "p1" })
        const sub2 = createMockTask({ id: "s2", parentId: "p1" })
        const sub3 = createMockTask({ id: "s3", parentId: "p1" })

        const result = sortTasksWithSubtasks(
          [parent, sub1, sub2, sub3],
          () => 0
        )

        expect(result.map((t) => t.id)).toEqual(["p1", "s3", "s1", "s2"])
      })

      it("handles priority-based sorting", () => {
        const priorityOrder: Record<Priority, number> = {
          urgent: 0,
          high: 1,
          medium: 2,
          low: 3,
          none: 4,
        }
        const high = createMockTask({
          id: "high",
          priority: "high",
          subtaskIds: ["h-sub"],
        })
        const highSub = createMockTask({
          id: "h-sub",
          parentId: "high",
          priority: "none",
        })
        const urgent = createMockTask({
          id: "urgent",
          priority: "urgent",
          subtaskIds: [],
        })

        const result = sortTasksWithSubtasks([high, highSub, urgent], (a, b) =>
          priorityOrder[a.priority] - priorityOrder[b.priority]
        )

        expect(result.map((t) => t.id)).toEqual(["urgent", "high", "h-sub"])
      })

      it("handles date-based sorting", () => {
        const early = createMockTask({
          id: "early",
          dueDate: new Date(2026, 0, 1),
          subtaskIds: [],
        })
        const late = createMockTask({
          id: "late",
          dueDate: new Date(2026, 0, 15),
          subtaskIds: [],
        })

        const result = sortTasksWithSubtasks([late, early], (a, b) =>
          (a.dueDate?.getTime() || 0) - (b.dueDate?.getTime() || 0)
        )

        expect(result.map((t) => t.id)).toEqual(["early", "late"])
      })
    })
  })

  // ==========================================================================
  // T095: CRUD OPERATIONS
  // ==========================================================================

  describe("T095: CRUD Operations", () => {
    describe("createSubtask", () => {
      it("returns success with updatedTasks and newTask", () => {
        const parent = createMockTask({ id: "parent-1", subtaskIds: [] })

        const result = createSubtask(
          { title: "New Subtask", parentId: "parent-1" },
          [parent]
        )

        expect(result.success).toBe(true)
        expect(result.newTask).toBeDefined()
        expect(result.newTask?.title).toBe("New Subtask")
        expect(result.newTask?.parentId).toBe("parent-1")
        expect(result.updatedTasks).toBeDefined()
        expect(
          result.updatedTasks?.find((t) => t.id === "parent-1")?.subtaskIds
        ).toContain(result.newTask?.id)
      })

      it('returns error "Parent task not found"', () => {
        const result = createSubtask(
          { title: "New Subtask", parentId: "nonexistent" },
          []
        )

        expect(result).toEqual({
          success: false,
          error: "Parent task not found",
        })
      })

      it('returns error "Cannot add subtask to another subtask"', () => {
        const parent = createMockTask({ id: "parent-1", parentId: "grandpa" })

        const result = createSubtask(
          { title: "New Subtask", parentId: "parent-1" },
          [parent]
        )

        expect(result).toEqual({
          success: false,
          error: "Cannot add subtask to another subtask",
        })
      })

      it("inherits projectId and statusId from parent", () => {
        const parent = createMockTask({
          id: "parent-1",
          projectId: "proj-abc",
          statusId: "status-xyz",
        })

        const result = createSubtask(
          { title: "New Subtask", parentId: "parent-1" },
          [parent]
        )

        expect(result.newTask?.projectId).toBe("proj-abc")
        expect(result.newTask?.statusId).toBe("status-xyz")
      })

      it("respects priority option", () => {
        const parent = createMockTask({ id: "parent-1" })

        const result = createSubtask(
          { title: "High Priority Subtask", parentId: "parent-1", priority: "high" },
          [parent]
        )

        expect(result.newTask?.priority).toBe("high")
      })

      it("respects dueDate and dueTime options", () => {
        const parent = createMockTask({ id: "parent-1" })
        const dueDate = new Date(2026, 0, 20)

        const result = createSubtask(
          {
            title: "Subtask with due",
            parentId: "parent-1",
            dueDate,
            dueTime: "14:30",
          },
          [parent]
        )

        expect(result.newTask?.dueDate).toEqual(dueDate)
        expect(result.newTask?.dueTime).toBe("14:30")
      })

      it("creates subtask with createdAt set to current time", () => {
        const parent = createMockTask({ id: "parent-1" })

        const result = createSubtask(
          { title: "New Subtask", parentId: "parent-1" },
          [parent]
        )

        expect(result.newTask?.createdAt).toEqual(new Date(2026, 0, 10))
      })
    })

    describe("createMultipleSubtasks", () => {
      it("creates all subtasks with newTasks array", () => {
        const parent = createMockTask({ id: "parent-1", subtaskIds: [] })

        const result = createMultipleSubtasks(
          "parent-1",
          ["Task A", "Task B", "Task C"],
          [parent]
        )

        expect(result.success).toBe(true)
        expect(result.newTasks).toHaveLength(3)
        expect(result.newTasks?.map((t) => t.title)).toEqual([
          "Task A",
          "Task B",
          "Task C",
        ])
      })

      it('returns error "No titles provided" for empty array', () => {
        const parent = createMockTask({ id: "parent-1" })

        const result = createMultipleSubtasks("parent-1", [], [parent])

        expect(result).toEqual({
          success: false,
          error: "No titles provided",
        })
      })

      it('returns error "Parent task not found"', () => {
        const result = createMultipleSubtasks("nonexistent", ["Task A"], [])

        expect(result).toEqual({
          success: false,
          error: "Parent task not found",
        })
      })

      it('returns error "Cannot add subtask to another subtask"', () => {
        const parent = createMockTask({ id: "parent-1", parentId: "grandpa" })

        const result = createMultipleSubtasks("parent-1", ["Task A"], [parent])

        expect(result).toEqual({
          success: false,
          error: "Cannot add subtask to another subtask",
        })
      })

      it("adds all new subtask IDs to parent", () => {
        const parent = createMockTask({
          id: "parent-1",
          subtaskIds: ["existing"],
        })

        const result = createMultipleSubtasks(
          "parent-1",
          ["Task A", "Task B"],
          [parent]
        )

        const updatedParent = result.updatedTasks?.find(
          (t) => t.id === "parent-1"
        )
        expect(updatedParent?.subtaskIds).toHaveLength(3)
        expect(updatedParent?.subtaskIds[0]).toBe("existing")
      })

      it("all subtasks inherit parent projectId and statusId", () => {
        const parent = createMockTask({
          id: "parent-1",
          projectId: "proj-xyz",
          statusId: "status-abc",
        })

        const result = createMultipleSubtasks(
          "parent-1",
          ["Task A", "Task B"],
          [parent]
        )

        result.newTasks?.forEach((task) => {
          expect(task.projectId).toBe("proj-xyz")
          expect(task.statusId).toBe("status-abc")
          expect(task.parentId).toBe("parent-1")
        })
      })
    })

    describe("deleteSubtask", () => {
      it("removes from parent's subtaskIds", () => {
        const parent = createMockTask({
          id: "parent-1",
          subtaskIds: ["sub-1", "sub-2"],
        })
        const subtask = createMockTask({ id: "sub-1", parentId: "parent-1" })

        const result = deleteSubtask("sub-1", [parent, subtask])

        expect(result.success).toBe(true)
        const updatedParent = result.updatedTasks?.find(
          (t) => t.id === "parent-1"
        )
        expect(updatedParent?.subtaskIds).toEqual(["sub-2"])
      })

      it("removes task from array", () => {
        const parent = createMockTask({
          id: "parent-1",
          subtaskIds: ["sub-1"],
        })
        const subtask = createMockTask({ id: "sub-1", parentId: "parent-1" })

        const result = deleteSubtask("sub-1", [parent, subtask])

        expect(result.updatedTasks?.find((t) => t.id === "sub-1")).toBeUndefined()
      })

      it('returns error "Task is not a subtask"', () => {
        const task = createMockTask({ id: "task-1", parentId: null })

        const result = deleteSubtask("task-1", [task])

        expect(result).toEqual({
          success: false,
          error: "Task is not a subtask",
        })
      })

      it('returns error "Subtask not found"', () => {
        const result = deleteSubtask("nonexistent", [])

        expect(result).toEqual({
          success: false,
          error: "Subtask not found",
        })
      })

      it('returns error "Parent task not found"', () => {
        const subtask = createMockTask({ id: "sub-1", parentId: "nonexistent" })

        const result = deleteSubtask("sub-1", [subtask])

        expect(result).toEqual({
          success: false,
          error: "Parent task not found",
        })
      })
    })

    describe("deleteParentWithSubtasks", () => {
      it("promotes all subtasks when keepSubtasks=true", () => {
        const parent = createMockTask({
          id: "parent-1",
          subtaskIds: ["sub-1", "sub-2"],
        })
        const sub1 = createMockTask({
          id: "sub-1",
          parentId: "parent-1",
          title: "Subtask 1",
        })
        const sub2 = createMockTask({
          id: "sub-2",
          parentId: "parent-1",
          title: "Subtask 2",
        })

        const result = deleteParentWithSubtasks("parent-1", true, [
          parent,
          sub1,
          sub2,
        ])

        expect(result.success).toBe(true)
        expect(
          result.updatedTasks?.find((t) => t.id === "parent-1")
        ).toBeUndefined()
        expect(result.updatedTasks?.find((t) => t.id === "sub-1")?.parentId).toBeNull()
        expect(result.updatedTasks?.find((t) => t.id === "sub-2")?.parentId).toBeNull()
        expect(result.updatedTasks).toHaveLength(2)
      })

      it("deletes all subtasks when keepSubtasks=false", () => {
        const parent = createMockTask({
          id: "parent-1",
          subtaskIds: ["sub-1", "sub-2"],
        })
        const sub1 = createMockTask({ id: "sub-1", parentId: "parent-1" })
        const sub2 = createMockTask({ id: "sub-2", parentId: "parent-1" })
        const otherTask = createMockTask({ id: "other" })

        const result = deleteParentWithSubtasks("parent-1", false, [
          parent,
          sub1,
          sub2,
          otherTask,
        ])

        expect(result.success).toBe(true)
        expect(result.updatedTasks).toHaveLength(1)
        expect(result.updatedTasks?.[0].id).toBe("other")
      })

      it('returns error "Parent task not found"', () => {
        const result = deleteParentWithSubtasks("nonexistent", true, [])

        expect(result).toEqual({
          success: false,
          error: "Parent task not found",
        })
      })

      it("handles parent with no subtasks", () => {
        const parent = createMockTask({ id: "parent-1", subtaskIds: [] })
        const otherTask = createMockTask({ id: "other" })

        const result = deleteParentWithSubtasks("parent-1", false, [
          parent,
          otherTask,
        ])

        expect(result.success).toBe(true)
        expect(result.updatedTasks).toHaveLength(1)
        expect(result.updatedTasks?.[0].id).toBe("other")
      })
    })
  })

  // ==========================================================================
  // T096: REORDERING
  // ==========================================================================

  describe("T096: Reordering", () => {
    describe("reorderSubtasks", () => {
      it("updates parent's subtaskIds with new order", () => {
        const parent = createMockTask({
          id: "parent-1",
          subtaskIds: ["sub-1", "sub-2", "sub-3"],
        })
        const sub1 = createMockTask({ id: "sub-1", parentId: "parent-1" })
        const sub2 = createMockTask({ id: "sub-2", parentId: "parent-1" })
        const sub3 = createMockTask({ id: "sub-3", parentId: "parent-1" })

        const result = reorderSubtasks(
          "parent-1",
          ["sub-3", "sub-1", "sub-2"],
          [parent, sub1, sub2, sub3]
        )

        expect(result.success).toBe(true)
        const updatedParent = result.updatedTasks?.find(
          (t) => t.id === "parent-1"
        )
        expect(updatedParent?.subtaskIds).toEqual(["sub-3", "sub-1", "sub-2"])
      })

      it("returns reorderedTasks", () => {
        const parent = createMockTask({
          id: "parent-1",
          subtaskIds: ["sub-1", "sub-2"],
        })
        const sub1 = createMockTask({ id: "sub-1", parentId: "parent-1" })
        const sub2 = createMockTask({ id: "sub-2", parentId: "parent-1" })

        const result = reorderSubtasks("parent-1", ["sub-2", "sub-1"], [
          parent,
          sub1,
          sub2,
        ])

        expect(result.reorderedTasks).toBeDefined()
        expect(result.reorderedTasks?.map((t) => t.id)).toEqual([
          "sub-2",
          "sub-1",
        ])
      })

      it('returns error "Invalid subtask IDs in new order"', () => {
        const parent = createMockTask({
          id: "parent-1",
          subtaskIds: ["sub-1", "sub-2"],
        })

        const result = reorderSubtasks(
          "parent-1",
          ["sub-1", "invalid-id"],
          [parent]
        )

        expect(result).toEqual({
          success: false,
          error: "Invalid subtask IDs in new order",
        })
      })

      it("appends missing IDs to end", () => {
        const parent = createMockTask({
          id: "parent-1",
          subtaskIds: ["sub-1", "sub-2", "sub-3"],
        })
        const sub1 = createMockTask({ id: "sub-1", parentId: "parent-1" })
        const sub2 = createMockTask({ id: "sub-2", parentId: "parent-1" })
        const sub3 = createMockTask({ id: "sub-3", parentId: "parent-1" })

        // Only reorder two of three
        const result = reorderSubtasks("parent-1", ["sub-2", "sub-1"], [
          parent,
          sub1,
          sub2,
          sub3,
        ])

        expect(result.success).toBe(true)
        const updatedParent = result.updatedTasks?.find(
          (t) => t.id === "parent-1"
        )
        expect(updatedParent?.subtaskIds).toEqual(["sub-2", "sub-1", "sub-3"])
      })

      it('returns error "Parent task not found"', () => {
        const result = reorderSubtasks("nonexistent", ["sub-1"], [])

        expect(result).toEqual({
          success: false,
          error: "Parent task not found",
        })
      })

      it("handles single subtask reorder (no change)", () => {
        const parent = createMockTask({
          id: "parent-1",
          subtaskIds: ["sub-1"],
        })
        const sub1 = createMockTask({ id: "sub-1", parentId: "parent-1" })

        const result = reorderSubtasks("parent-1", ["sub-1"], [parent, sub1])

        expect(result.success).toBe(true)
        const updatedParent = result.updatedTasks?.find(
          (t) => t.id === "parent-1"
        )
        expect(updatedParent?.subtaskIds).toEqual(["sub-1"])
      })
    })
  })

  // ==========================================================================
  // T097: PROMOTE & DEMOTE
  // ==========================================================================

  describe("T097: Promote & Demote", () => {
    describe("promoteToTask", () => {
      it("sets parentId to null", () => {
        const parent = createMockTask({
          id: "parent-1",
          subtaskIds: ["sub-1"],
        })
        const subtask = createMockTask({ id: "sub-1", parentId: "parent-1" })

        const result = promoteToTask("sub-1", [parent, subtask])

        expect(result.success).toBe(true)
        const promoted = result.updatedTasks?.find((t) => t.id === "sub-1")
        expect(promoted?.parentId).toBeNull()
      })

      it("removes from parent's subtaskIds", () => {
        const parent = createMockTask({
          id: "parent-1",
          subtaskIds: ["sub-1", "sub-2"],
        })
        const subtask = createMockTask({ id: "sub-1", parentId: "parent-1" })
        const subtask2 = createMockTask({ id: "sub-2", parentId: "parent-1" })

        const result = promoteToTask("sub-1", [parent, subtask, subtask2])

        const updatedParent = result.updatedTasks?.find(
          (t) => t.id === "parent-1"
        )
        expect(updatedParent?.subtaskIds).toEqual(["sub-2"])
      })

      it('returns error "Task is already a standalone task"', () => {
        const task = createMockTask({ id: "task-1", parentId: null })

        const result = promoteToTask("task-1", [task])

        expect(result).toEqual({
          success: false,
          error: "Task is already a standalone task",
        })
      })

      it('returns error "Subtask not found"', () => {
        const result = promoteToTask("nonexistent", [])

        expect(result).toEqual({
          success: false,
          error: "Subtask not found",
        })
      })

      it('returns error "Parent task not found"', () => {
        const subtask = createMockTask({ id: "sub-1", parentId: "nonexistent" })

        const result = promoteToTask("sub-1", [subtask])

        expect(result).toEqual({
          success: false,
          error: "Parent task not found",
        })
      })
    })

    describe("demoteToSubtask", () => {
      it("validates relationship first", () => {
        // Self-reference
        const task = createMockTask({ id: "task-1", projectId: "project-1" })

        const result = demoteToSubtask("task-1", "task-1", [task])

        expect(result).toEqual({
          success: false,
          error: "A task cannot be its own parent",
        })
      })

      it("updates projectId and statusId to match parent", () => {
        // Note: Tasks must be in the same project initially to pass validation
        // The function will still update projectId/statusId from parent
        const parent = createMockTask({
          id: "parent-1",
          projectId: "project-1",
          statusId: "status-parent",
        })
        const task = createMockTask({
          id: "task-1",
          projectId: "project-1",
          statusId: "status-task",
        })

        const result = demoteToSubtask("task-1", "parent-1", [parent, task])

        expect(result.success).toBe(true)
        const demoted = result.updatedTasks?.find((t) => t.id === "task-1")
        expect(demoted?.projectId).toBe("project-1")
        expect(demoted?.statusId).toBe("status-parent")
        expect(demoted?.parentId).toBe("parent-1")
      })

      it("adds task to parent's subtaskIds", () => {
        const parent = createMockTask({
          id: "parent-1",
          projectId: "project-1",
          subtaskIds: ["existing"],
        })
        const task = createMockTask({
          id: "task-1",
          projectId: "project-1",
        })

        const result = demoteToSubtask("task-1", "parent-1", [parent, task])

        const updatedParent = result.updatedTasks?.find(
          (t) => t.id === "parent-1"
        )
        expect(updatedParent?.subtaskIds).toEqual(["existing", "task-1"])
      })

      it('returns error "Task is already a subtask"', () => {
        const parent = createMockTask({
          id: "parent-1",
          projectId: "project-1",
        })
        const subtask = createMockTask({
          id: "sub-1",
          parentId: "other-parent",
          projectId: "project-1",
          subtaskIds: [],
        })

        const result = demoteToSubtask("sub-1", "parent-1", [parent, subtask])

        expect(result).toEqual({
          success: false,
          error: "Task is already a subtask",
        })
      })

      it("fails when parent is a subtask (no nested)", () => {
        const grandparent = createMockTask({
          id: "grandparent",
          projectId: "project-1",
        })
        const parent = createMockTask({
          id: "parent-1",
          parentId: "grandparent",
          projectId: "project-1",
        })
        const task = createMockTask({
          id: "task-1",
          projectId: "project-1",
        })

        const result = demoteToSubtask("task-1", "parent-1", [
          grandparent,
          parent,
          task,
        ])

        expect(result).toEqual({
          success: false,
          error: "Cannot add subtasks to a subtask (no nested subtasks)",
        })
      })

      it("fails when task has subtasks", () => {
        const parent = createMockTask({
          id: "parent-1",
          projectId: "project-1",
        })
        const taskWithChildren = createMockTask({
          id: "task-1",
          projectId: "project-1",
          subtaskIds: ["child-1"],
        })

        const result = demoteToSubtask("task-1", "parent-1", [
          parent,
          taskWithChildren,
        ])

        expect(result).toEqual({
          success: false,
          error: "Cannot make a parent task into a subtask",
        })
      })

      it("fails when different projects", () => {
        const parent = createMockTask({
          id: "parent-1",
          projectId: "project-a",
        })
        const task = createMockTask({
          id: "task-1",
          projectId: "project-b",
        })

        const result = demoteToSubtask("task-1", "parent-1", [parent, task])

        expect(result).toEqual({
          success: false,
          error: "Subtask must belong to the same project as parent",
        })
      })
    })
  })

  // ==========================================================================
  // T098: COMPLETION HANDLING
  // ==========================================================================

  describe("T098: Completion Handling", () => {
    describe("completeParentWithSubtasks", () => {
      it("marks all subtasks completed when completeSubtasks=true", () => {
        const parent = createMockTask({
          id: "parent-1",
          subtaskIds: ["sub-1", "sub-2"],
        })
        const sub1 = createMockTask({
          id: "sub-1",
          parentId: "parent-1",
          completedAt: null,
        })
        const sub2 = createMockTask({
          id: "sub-2",
          parentId: "parent-1",
          completedAt: null,
        })

        const result = completeParentWithSubtasks("parent-1", true, [
          parent,
          sub1,
          sub2,
        ])

        expect(result.success).toBe(true)
        const updatedParent = result.updatedTasks?.find(
          (t) => t.id === "parent-1"
        )
        const updatedSub1 = result.updatedTasks?.find((t) => t.id === "sub-1")
        const updatedSub2 = result.updatedTasks?.find((t) => t.id === "sub-2")

        expect(updatedParent?.completedAt).toEqual(new Date(2026, 0, 10))
        expect(updatedSub1?.completedAt).toEqual(new Date(2026, 0, 10))
        expect(updatedSub2?.completedAt).toEqual(new Date(2026, 0, 10))
      })

      it("only marks parent completed when completeSubtasks=false", () => {
        const parent = createMockTask({
          id: "parent-1",
          subtaskIds: ["sub-1"],
        })
        const sub1 = createMockTask({
          id: "sub-1",
          parentId: "parent-1",
          completedAt: null,
        })

        const result = completeParentWithSubtasks("parent-1", false, [
          parent,
          sub1,
        ])

        expect(result.success).toBe(true)
        const updatedParent = result.updatedTasks?.find(
          (t) => t.id === "parent-1"
        )
        const updatedSub1 = result.updatedTasks?.find((t) => t.id === "sub-1")

        expect(updatedParent?.completedAt).toEqual(new Date(2026, 0, 10))
        expect(updatedSub1?.completedAt).toBeNull()
      })

      it("does not re-complete already completed subtasks", () => {
        const earlier = new Date(2026, 0, 5)
        const parent = createMockTask({
          id: "parent-1",
          subtaskIds: ["sub-1"],
        })
        const sub1 = createMockTask({
          id: "sub-1",
          parentId: "parent-1",
          completedAt: earlier,
        })

        const result = completeParentWithSubtasks("parent-1", true, [
          parent,
          sub1,
        ])

        const updatedSub1 = result.updatedTasks?.find((t) => t.id === "sub-1")
        expect(updatedSub1?.completedAt).toEqual(earlier)
      })

      it('returns error "Parent task not found"', () => {
        const result = completeParentWithSubtasks("nonexistent", true, [])

        expect(result).toEqual({
          success: false,
          error: "Parent task not found",
        })
      })
    })

    describe("getIncompleteSubtasks", () => {
      it("filters by completedAt === null", () => {
        const sub1 = createMockTask({
          id: "sub-1",
          parentId: "parent-1",
          completedAt: null,
        })
        const sub2 = createMockTask({
          id: "sub-2",
          parentId: "parent-1",
          completedAt: new Date(),
        })
        const sub3 = createMockTask({
          id: "sub-3",
          parentId: "parent-1",
          completedAt: null,
        })

        const result = getIncompleteSubtasks("parent-1", [sub1, sub2, sub3])

        expect(result).toHaveLength(2)
        expect(result.map((t) => t.id)).toEqual(["sub-1", "sub-3"])
      })

      it("returns empty when all completed", () => {
        const sub1 = createMockTask({
          id: "sub-1",
          parentId: "parent-1",
          completedAt: new Date(),
        })

        const result = getIncompleteSubtasks("parent-1", [sub1])
        expect(result).toEqual([])
      })

      it("returns empty when parent has no subtasks", () => {
        const result = getIncompleteSubtasks("parent-1", [])
        expect(result).toEqual([])
      })

      it("only returns subtasks of specified parent", () => {
        const sub1 = createMockTask({
          id: "sub-1",
          parentId: "parent-1",
          completedAt: null,
        })
        const sub2 = createMockTask({
          id: "sub-2",
          parentId: "parent-2",
          completedAt: null,
        })

        const result = getIncompleteSubtasks("parent-1", [sub1, sub2])

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe("sub-1")
      })
    })

    describe("hasIncompleteSubtasks", () => {
      it("returns true when incomplete subtasks exist", () => {
        const sub1 = createMockTask({
          id: "sub-1",
          parentId: "parent-1",
          completedAt: null,
        })

        const result = hasIncompleteSubtasks("parent-1", [sub1])
        expect(result).toBe(true)
      })

      it("returns false when all subtasks completed", () => {
        const sub1 = createMockTask({
          id: "sub-1",
          parentId: "parent-1",
          completedAt: new Date(),
        })

        const result = hasIncompleteSubtasks("parent-1", [sub1])
        expect(result).toBe(false)
      })

      it("returns false when no subtasks", () => {
        const result = hasIncompleteSubtasks("parent-1", [])
        expect(result).toBe(false)
      })

      it("returns true even with one incomplete among completed", () => {
        const sub1 = createMockTask({
          id: "sub-1",
          parentId: "parent-1",
          completedAt: new Date(),
        })
        const sub2 = createMockTask({
          id: "sub-2",
          parentId: "parent-1",
          completedAt: null,
        })

        const result = hasIncompleteSubtasks("parent-1", [sub1, sub2])
        expect(result).toBe(true)
      })
    })

    describe("getPotentialParents", () => {
      it("excludes self from results", () => {
        const task = createMockTask({ id: "task-1", projectId: "project-1" })

        const result = getPotentialParents("task-1", [task])
        expect(result.find((t) => t.id === "task-1")).toBeUndefined()
      })

      it("excludes subtasks from results", () => {
        const task = createMockTask({ id: "task-1", projectId: "project-1" })
        const subtask = createMockTask({
          id: "subtask-1",
          parentId: "parent-1",
          projectId: "project-1",
        })

        const result = getPotentialParents("task-1", [task, subtask])
        expect(result.find((t) => t.id === "subtask-1")).toBeUndefined()
      })

      it("prioritizes same project", () => {
        const task = createMockTask({ id: "task-1", projectId: "project-1" })
        const sameProject = createMockTask({
          id: "same-proj",
          projectId: "project-1",
          createdAt: new Date(2026, 0, 1),
        })
        const differentProject = createMockTask({
          id: "diff-proj",
          projectId: "project-2",
          createdAt: new Date(2026, 0, 5),
        })

        const result = getPotentialParents("task-1", [task, sameProject, differentProject], "project-1")

        expect(result[0].id).toBe("same-proj")
        expect(result[1].id).toBe("diff-proj")
      })

      it("sorts by recency within same project priority", () => {
        const task = createMockTask({ id: "task-1", projectId: "project-1" })
        const older = createMockTask({
          id: "older",
          projectId: "project-1",
          createdAt: new Date(2026, 0, 1),
        })
        const newer = createMockTask({
          id: "newer",
          projectId: "project-1",
          createdAt: new Date(2026, 0, 10),
        })

        const result = getPotentialParents("task-1", [task, older, newer], "project-1")

        expect(result[0].id).toBe("newer")
        expect(result[1].id).toBe("older")
      })

      it("returns empty array if task not found", () => {
        const result = getPotentialParents("nonexistent", [])
        expect(result).toEqual([])
      })

      it("allows tasks with existing subtasks to be parents", () => {
        const task = createMockTask({ id: "task-1", projectId: "project-1" })
        const parentWithSubs = createMockTask({
          id: "parent-with-subs",
          projectId: "project-1",
          subtaskIds: ["existing-sub"],
        })

        const result = getPotentialParents("task-1", [task, parentWithSubs])

        expect(result.find((t) => t.id === "parent-with-subs")).toBeDefined()
      })

      it("includes tasks from all projects when no currentProjectId", () => {
        const task = createMockTask({ id: "task-1", projectId: "project-1" })
        const projA = createMockTask({
          id: "proj-a",
          projectId: "project-a",
          createdAt: new Date(2026, 0, 1),
        })
        const projB = createMockTask({
          id: "proj-b",
          projectId: "project-b",
          createdAt: new Date(2026, 0, 5),
        })

        const result = getPotentialParents("task-1", [task, projA, projB])

        expect(result).toHaveLength(2)
        // Sorted by recency when no project preference
        expect(result[0].id).toBe("proj-b")
        expect(result[1].id).toBe("proj-a")
      })

      it("handles complex scenario with mixed tasks", () => {
        const task = createMockTask({
          id: "task-to-demote",
          projectId: "project-1",
          createdAt: new Date(2026, 0, 8),
        })
        const sameProjectRecent = createMockTask({
          id: "same-recent",
          projectId: "project-1",
          createdAt: new Date(2026, 0, 10),
        })
        const sameProjectOld = createMockTask({
          id: "same-old",
          projectId: "project-1",
          createdAt: new Date(2026, 0, 1),
        })
        const diffProjectRecent = createMockTask({
          id: "diff-recent",
          projectId: "project-2",
          createdAt: new Date(2026, 0, 9),
        })
        const subtaskInProject = createMockTask({
          id: "subtask",
          projectId: "project-1",
          parentId: "same-recent",
        })

        const result = getPotentialParents(
          "task-to-demote",
          [task, sameProjectRecent, sameProjectOld, diffProjectRecent, subtaskInProject],
          "project-1"
        )

        // Excludes self and subtasks
        expect(result.map((t) => t.id)).not.toContain("task-to-demote")
        expect(result.map((t) => t.id)).not.toContain("subtask")
        // Same project first, then sorted by recency
        expect(result[0].id).toBe("same-recent")
        expect(result[1].id).toBe("same-old")
        expect(result[2].id).toBe("diff-recent")
      })
    })
  })
})
