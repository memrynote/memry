import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { Task, Priority } from "@/data/sample-tasks"

// Mock generateTaskId for deterministic IDs
vi.mock("@/data/sample-tasks", async () => {
  const actual = await vi.importActual("@/data/sample-tasks")
  let idCounter = 0
  return {
    ...actual,
    generateTaskId: () => `generated-task-${++idCounter}`,
  }
})

import {
  checkAllSubtasksComplete,
  getIncompleteSubtaskCount,
  completeAllSubtasks,
  markAllSubtasksIncomplete,
  setDueDateForAllSubtasks,
  setPriorityForAllSubtasks,
  deleteAllSubtasks,
  duplicateTaskWithSubtasks,
  completeParentTask,
  uncompleteParentTask,
} from "./subtask-bulk-utils"

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

describe("subtask-bulk-utils", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 12, 9, 0, 0))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  // ==========================================================================
  // T135: CHECK ALL SUBTASKS COMPLETE / INCOMPLETE COUNT
  // ==========================================================================

  describe("T135: completion checks", () => {
    it("returns true when all subtasks are complete", () => {
      const parent = createMockTask({
        id: "parent-1",
        subtaskIds: ["sub-1", "sub-2"],
      })
      const subtask1 = createMockTask({
        id: "sub-1",
        parentId: "parent-1",
        completedAt: new Date(2026, 0, 11),
      })
      const subtask2 = createMockTask({
        id: "sub-2",
        parentId: "parent-1",
        completedAt: new Date(2026, 0, 10),
      })

      const result = checkAllSubtasksComplete("parent-1", [
        parent,
        subtask1,
        subtask2,
      ])

      expect(result).toBe(true)
    })

    it("returns false when any subtask is incomplete", () => {
      const parent = createMockTask({
        id: "parent-1",
        subtaskIds: ["sub-1", "sub-2"],
      })
      const subtask1 = createMockTask({
        id: "sub-1",
        parentId: "parent-1",
        completedAt: null,
      })
      const subtask2 = createMockTask({
        id: "sub-2",
        parentId: "parent-1",
        completedAt: new Date(2026, 0, 10),
      })

      const result = checkAllSubtasksComplete("parent-1", [
        parent,
        subtask1,
        subtask2,
      ])

      expect(result).toBe(false)
    })

    it("returns false when parent has no subtasks", () => {
      const parent = createMockTask({ id: "parent-1", subtaskIds: [] })
      const result = checkAllSubtasksComplete("parent-1", [parent])
      expect(result).toBe(false)
    })

    it("counts incomplete subtasks", () => {
      const parent = createMockTask({
        id: "parent-1",
        subtaskIds: ["sub-1", "sub-2", "sub-3"],
      })
      const subtask1 = createMockTask({
        id: "sub-1",
        parentId: "parent-1",
        completedAt: null,
      })
      const subtask2 = createMockTask({
        id: "sub-2",
        parentId: "parent-1",
        completedAt: new Date(2026, 0, 10),
      })
      const subtask3 = createMockTask({
        id: "sub-3",
        parentId: "parent-1",
        completedAt: null,
      })

      const result = getIncompleteSubtaskCount("parent-1", [
        parent,
        subtask1,
        subtask2,
        subtask3,
      ])

      expect(result).toBe(2)
    })
  })

  // ==========================================================================
  // T136: COMPLETE ALL SUBTASKS / MARK ALL INCOMPLETE
  // ==========================================================================

  describe("T136: bulk completion updates", () => {
    it("completes only incomplete subtasks", () => {
      const parent = createMockTask({
        id: "parent-1",
        subtaskIds: ["sub-1", "sub-2"],
      })
      const subtask1 = createMockTask({
        id: "sub-1",
        parentId: "parent-1",
        completedAt: null,
      })
      const completedAt = new Date(2026, 0, 10)
      const subtask2 = createMockTask({
        id: "sub-2",
        parentId: "parent-1",
        completedAt,
      })

      const now = new Date()
      const result = completeAllSubtasks("parent-1", [
        parent,
        subtask1,
        subtask2,
      ])

      expect(result.success).toBe(true)
      expect(result.affectedCount).toBe(1)
      expect(result.completedSubtasks?.map((task) => task.id)).toEqual(["sub-1"])

      const updatedSubtask1 = result.updatedTasks?.find(
        (task) => task.id === "sub-1"
      )
      const updatedSubtask2 = result.updatedTasks?.find(
        (task) => task.id === "sub-2"
      )

      expect(updatedSubtask1?.completedAt).toEqual(now)
      expect(updatedSubtask2?.completedAt).toEqual(completedAt)
    })

    it("returns error when all subtasks are already complete", () => {
      const parent = createMockTask({
        id: "parent-1",
        subtaskIds: ["sub-1"],
      })
      const subtask1 = createMockTask({
        id: "sub-1",
        parentId: "parent-1",
        completedAt: new Date(2026, 0, 10),
      })

      const result = completeAllSubtasks("parent-1", [parent, subtask1])

      expect(result.success).toBe(false)
      expect(result.error).toBe("All subtasks are already complete")
    })

    it("marks only completed subtasks incomplete", () => {
      const parent = createMockTask({
        id: "parent-1",
        subtaskIds: ["sub-1", "sub-2"],
      })
      const completedAt = new Date(2026, 0, 9)
      const subtask1 = createMockTask({
        id: "sub-1",
        parentId: "parent-1",
        completedAt,
      })
      const subtask2 = createMockTask({
        id: "sub-2",
        parentId: "parent-1",
        completedAt: null,
      })

      const result = markAllSubtasksIncomplete("parent-1", [
        parent,
        subtask1,
        subtask2,
      ])

      expect(result.success).toBe(true)
      expect(result.affectedCount).toBe(1)
      expect(result.incompleteSubtasks?.map((task) => task.id)).toEqual([
        "sub-1",
      ])

      const updatedSubtask1 = result.updatedTasks?.find(
        (task) => task.id === "sub-1"
      )
      const updatedSubtask2 = result.updatedTasks?.find(
        (task) => task.id === "sub-2"
      )

      expect(updatedSubtask1?.completedAt).toBeNull()
      expect(updatedSubtask2?.completedAt).toBeNull()
    })

    it("returns error when all subtasks are already incomplete", () => {
      const parent = createMockTask({
        id: "parent-1",
        subtaskIds: ["sub-1"],
      })
      const subtask1 = createMockTask({
        id: "sub-1",
        parentId: "parent-1",
        completedAt: null,
      })

      const result = markAllSubtasksIncomplete("parent-1", [parent, subtask1])

      expect(result.success).toBe(false)
      expect(result.error).toBe("All subtasks are already incomplete")
    })
  })

  // ==========================================================================
  // T137: SET DUE DATE / PRIORITY FOR ALL SUBTASKS
  // ==========================================================================

  describe("T137: bulk due date and priority updates", () => {
    it("sets due date for incomplete subtasks when exclude completed", () => {
      const parent = createMockTask({
        id: "parent-1",
        subtaskIds: ["sub-1", "sub-2"],
      })
      const subtask1 = createMockTask({
        id: "sub-1",
        parentId: "parent-1",
        completedAt: null,
        dueDate: null,
      })
      const existingDueDate = new Date(2026, 0, 5)
      const subtask2 = createMockTask({
        id: "sub-2",
        parentId: "parent-1",
        completedAt: new Date(2026, 0, 8),
        dueDate: existingDueDate,
      })
      const dueDate = new Date(2026, 0, 20)

      const result = setDueDateForAllSubtasks(
        "parent-1",
        dueDate,
        false,
        [parent, subtask1, subtask2]
      )

      expect(result.success).toBe(true)
      expect(result.affectedCount).toBe(1)

      const updatedSubtask1 = result.updatedTasks?.find(
        (task) => task.id === "sub-1"
      )
      const updatedSubtask2 = result.updatedTasks?.find(
        (task) => task.id === "sub-2"
      )

      expect(updatedSubtask1?.dueDate).toEqual(dueDate)
      expect(updatedSubtask2?.dueDate).toEqual(existingDueDate)
    })

    it("sets due date for all subtasks when include completed", () => {
      const parent = createMockTask({
        id: "parent-1",
        subtaskIds: ["sub-1", "sub-2"],
      })
      const subtask1 = createMockTask({
        id: "sub-1",
        parentId: "parent-1",
        completedAt: null,
      })
      const subtask2 = createMockTask({
        id: "sub-2",
        parentId: "parent-1",
        completedAt: new Date(2026, 0, 8),
      })
      const dueDate = new Date(2026, 0, 22)

      const result = setDueDateForAllSubtasks(
        "parent-1",
        dueDate,
        true,
        [parent, subtask1, subtask2]
      )

      expect(result.success).toBe(true)
      expect(result.affectedCount).toBe(2)

      const updatedSubtask1 = result.updatedTasks?.find(
        (task) => task.id === "sub-1"
      )
      const updatedSubtask2 = result.updatedTasks?.find(
        (task) => task.id === "sub-2"
      )

      expect(updatedSubtask1?.dueDate).toEqual(dueDate)
      expect(updatedSubtask2?.dueDate).toEqual(dueDate)
    })

    it("returns error when no matching subtasks for due date update", () => {
      const parent = createMockTask({
        id: "parent-1",
        subtaskIds: ["sub-1"],
      })
      const subtask1 = createMockTask({
        id: "sub-1",
        parentId: "parent-1",
        completedAt: new Date(2026, 0, 8),
      })

      const result = setDueDateForAllSubtasks(
        "parent-1",
        new Date(2026, 0, 20),
        false,
        [parent, subtask1]
      )

      expect(result.success).toBe(false)
      expect(result.error).toBe("No matching subtasks to update")
    })

    it("sets priority for incomplete subtasks when exclude completed", () => {
      const parent = createMockTask({
        id: "parent-1",
        subtaskIds: ["sub-1", "sub-2"],
      })
      const subtask1 = createMockTask({
        id: "sub-1",
        parentId: "parent-1",
        completedAt: null,
        priority: "low",
      })
      const subtask2 = createMockTask({
        id: "sub-2",
        parentId: "parent-1",
        completedAt: new Date(2026, 0, 8),
        priority: "medium",
      })

      const result = setPriorityForAllSubtasks(
        "parent-1",
        "urgent",
        false,
        [parent, subtask1, subtask2]
      )

      expect(result.success).toBe(true)
      expect(result.affectedCount).toBe(1)

      const updatedSubtask1 = result.updatedTasks?.find(
        (task) => task.id === "sub-1"
      )
      const updatedSubtask2 = result.updatedTasks?.find(
        (task) => task.id === "sub-2"
      )

      expect(updatedSubtask1?.priority).toBe("urgent")
      expect(updatedSubtask2?.priority).toBe("medium")
    })
  })

  // ==========================================================================
  // T138: DELETE ALL SUBTASKS
  // ==========================================================================

  describe("T138: deleteAllSubtasks", () => {
    it("removes all subtasks and clears parent references", () => {
      const parent = createMockTask({
        id: "parent-1",
        subtaskIds: ["sub-1", "sub-2"],
      })
      const subtask1 = createMockTask({
        id: "sub-1",
        parentId: "parent-1",
      })
      const subtask2 = createMockTask({
        id: "sub-2",
        parentId: "parent-1",
      })
      const otherTask = createMockTask({ id: "task-3" })

      const result = deleteAllSubtasks("parent-1", [
        parent,
        subtask1,
        subtask2,
        otherTask,
      ])

      expect(result.success).toBe(true)
      expect(result.affectedCount).toBe(2)

      const updatedTasks = result.updatedTasks ?? []
      expect(updatedTasks).toHaveLength(2)
      expect(updatedTasks.some((task) => task.id === "sub-1")).toBe(false)
      expect(updatedTasks.some((task) => task.id === "sub-2")).toBe(false)

      const updatedParent = updatedTasks.find((task) => task.id === "parent-1")
      expect(updatedParent?.subtaskIds).toEqual([])
      expect(updatedTasks.some((task) => task.id === "task-3")).toBe(true)
    })
  })

  // ==========================================================================
  // T139: DUPLICATE TASK WITH SUBTASKS
  // ==========================================================================

  describe("T139: duplicateTaskWithSubtasks", () => {
    it("duplicates a task and its subtasks with new IDs", () => {
      const parent = createMockTask({
        id: "parent-1",
        title: "Parent Task",
        statusId: "status-old",
        subtaskIds: ["sub-1", "sub-2"],
        completedAt: new Date(2026, 0, 2),
        archivedAt: new Date(2026, 0, 3),
      })
      const subtask1 = createMockTask({
        id: "sub-1",
        parentId: "parent-1",
        title: "Subtask One",
        completedAt: new Date(2026, 0, 4),
        archivedAt: new Date(2026, 0, 5),
      })
      const subtask2 = createMockTask({
        id: "sub-2",
        parentId: "parent-1",
        title: "Subtask Two",
        completedAt: null,
        archivedAt: null,
      })
      const otherTask = createMockTask({ id: "task-3" })

      const now = new Date()
      const result = duplicateTaskWithSubtasks(
        "parent-1",
        true,
        [parent, subtask1, subtask2, otherTask],
        "status-new"
      )

      expect(result.success).toBe(true)
      expect(result.affectedCount).toBe(3)

      const duplicatedTask = result.updatedTasks?.find(
        (task) => task.title === "Parent Task (copy)"
      )
      expect(duplicatedTask).toBeDefined()
      expect(duplicatedTask?.id).not.toBe(parent.id)
      expect(duplicatedTask?.id).toMatch(/^generated-task-/)
      expect(duplicatedTask?.statusId).toBe("status-new")
      expect(duplicatedTask?.completedAt).toBeNull()
      expect(duplicatedTask?.archivedAt).toBeNull()
      expect(duplicatedTask?.createdAt).toEqual(now)
      expect(duplicatedTask?.subtaskIds).toHaveLength(2)

      const duplicatedSubtasks =
        result.updatedTasks?.filter(
          (task) => task.parentId === duplicatedTask?.id
        ) ?? []

      expect(duplicatedSubtasks).toHaveLength(2)
      expect(duplicatedSubtasks.map((task) => task.title)).toEqual([
        "Subtask One",
        "Subtask Two",
      ])

      const duplicatedSubtaskIds = duplicatedSubtasks.map((task) => task.id)
      expect(new Set(duplicatedSubtaskIds).size).toBe(2)
      expect(duplicatedTask?.subtaskIds).toEqual(duplicatedSubtaskIds)
      duplicatedSubtaskIds.forEach((id) => {
        expect(parent.subtaskIds).not.toContain(id)
      })

      duplicatedSubtasks.forEach((task) => {
        expect(task.completedAt).toBeNull()
        expect(task.archivedAt).toBeNull()
        expect(task.createdAt).toEqual(now)
      })
    })

    it("duplicates only the task when includeSubtasks is false", () => {
      const parent = createMockTask({
        id: "parent-1",
        title: "Parent Task",
        subtaskIds: ["sub-1"],
      })
      const subtask1 = createMockTask({
        id: "sub-1",
        parentId: "parent-1",
      })

      const result = duplicateTaskWithSubtasks("parent-1", false, [
        parent,
        subtask1,
      ])

      expect(result.success).toBe(true)
      expect(result.affectedCount).toBe(1)

      const duplicatedTask = result.updatedTasks?.find(
        (task) => task.title === "Parent Task (copy)"
      )
      expect(duplicatedTask?.subtaskIds).toEqual([])

      const duplicatedSubtasks =
        result.updatedTasks?.filter(
          (task) => task.parentId === duplicatedTask?.id
        ) ?? []
      expect(duplicatedSubtasks).toHaveLength(0)
    })
  })

  // ==========================================================================
  // T140: COMPLETE / UNCOMPLETE PARENT TASK
  // ==========================================================================

  describe("T140: parent completion helpers", () => {
    it("completes the parent task when incomplete", () => {
      const parent = createMockTask({
        id: "parent-1",
        completedAt: null,
      })
      const now = new Date()

      const result = completeParentTask("parent-1", [parent])

      expect(result.success).toBe(true)
      const updatedParent = result.updatedTasks?.find(
        (task) => task.id === "parent-1"
      )
      expect(updatedParent?.completedAt).toEqual(now)
    })

    it("returns error when parent task is already complete", () => {
      const parent = createMockTask({
        id: "parent-1",
        completedAt: new Date(2026, 0, 10),
      })

      const result = completeParentTask("parent-1", [parent])

      expect(result.success).toBe(false)
      expect(result.error).toBe("Parent task is already complete")
    })

    it("uncompletes the parent task", () => {
      const parent = createMockTask({
        id: "parent-1",
        completedAt: new Date(2026, 0, 10),
      })

      const result = uncompleteParentTask("parent-1", [parent])

      expect(result.success).toBe(true)
      const updatedParent = result.updatedTasks?.find(
        (task) => task.id === "parent-1"
      )
      expect(updatedParent?.completedAt).toBeNull()
    })
  })
})
