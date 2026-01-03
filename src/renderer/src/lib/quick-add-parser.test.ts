import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { Project } from "@/data/tasks-data"
import {
  parseDateKeyword,
  parsePriorityKeyword,
  findProjectByName,
  parseQuickAdd,
  hasSpecialSyntax,
  getParsePreview,
  getDateOptions,
  getPriorityOptions,
  getProjectOptions,
} from "./quick-add-parser"

// ============================================================================
// TEST HELPERS
// ============================================================================

const createMockProject = (overrides: Partial<Project> = {}): Project => ({
  id: "project-1",
  name: "Test Project",
  description: "",
  icon: "folder",
  color: "#3b82f6",
  statuses: [],
  isDefault: false,
  isArchived: false,
  createdAt: new Date(),
  taskCount: 0,
  ...overrides,
})

// ============================================================================
// T104: DATE KEYWORD PARSING
// ============================================================================

describe("parseDateKeyword", () => {
  beforeEach(() => {
    // January 10, 2026 is a Saturday
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 10))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("today keyword", () => {
    it("should parse 'today' to current date", () => {
      const result = parseDateKeyword("today")
      expect(result).toEqual(new Date(2026, 0, 10))
    })

    it("should handle uppercase 'TODAY'", () => {
      const result = parseDateKeyword("TODAY")
      expect(result).toEqual(new Date(2026, 0, 10))
    })

    it("should handle mixed case 'Today'", () => {
      const result = parseDateKeyword("Today")
      expect(result).toEqual(new Date(2026, 0, 10))
    })
  })

  describe("tomorrow keywords", () => {
    it("should parse 'tomorrow' to next day", () => {
      const result = parseDateKeyword("tomorrow")
      expect(result).toEqual(new Date(2026, 0, 11))
    })

    it("should parse 'tmr' to next day", () => {
      const result = parseDateKeyword("tmr")
      expect(result).toEqual(new Date(2026, 0, 11))
    })

    it("should parse 'tom' to next day", () => {
      const result = parseDateKeyword("tom")
      expect(result).toEqual(new Date(2026, 0, 11))
    })
  })

  describe("next week keywords", () => {
    it("should parse 'nextweek' to +7 days", () => {
      const result = parseDateKeyword("nextweek")
      expect(result).toEqual(new Date(2026, 0, 17))
    })

    it("should parse 'next' to +7 days", () => {
      const result = parseDateKeyword("next")
      expect(result).toEqual(new Date(2026, 0, 17))
    })
  })

  describe("day name parsing (from Saturday Jan 10, 2026)", () => {
    it("should parse 'sun' to next Sunday (Jan 11)", () => {
      const result = parseDateKeyword("sun")
      expect(result).toEqual(new Date(2026, 0, 11))
    })

    it("should parse 'sunday' to next Sunday (Jan 11)", () => {
      const result = parseDateKeyword("sunday")
      expect(result).toEqual(new Date(2026, 0, 11))
    })

    it("should parse 'mon' to next Monday (Jan 12)", () => {
      const result = parseDateKeyword("mon")
      expect(result).toEqual(new Date(2026, 0, 12))
    })

    it("should parse 'monday' to next Monday (Jan 12)", () => {
      const result = parseDateKeyword("monday")
      expect(result).toEqual(new Date(2026, 0, 12))
    })

    it("should parse 'tue' to next Tuesday (Jan 13)", () => {
      const result = parseDateKeyword("tue")
      expect(result).toEqual(new Date(2026, 0, 13))
    })

    it("should parse 'tuesday' to next Tuesday (Jan 13)", () => {
      const result = parseDateKeyword("tuesday")
      expect(result).toEqual(new Date(2026, 0, 13))
    })

    it("should parse 'wed' to next Wednesday (Jan 14)", () => {
      const result = parseDateKeyword("wed")
      expect(result).toEqual(new Date(2026, 0, 14))
    })

    it("should parse 'wednesday' to next Wednesday (Jan 14)", () => {
      const result = parseDateKeyword("wednesday")
      expect(result).toEqual(new Date(2026, 0, 14))
    })

    it("should parse 'thu' to next Thursday (Jan 15)", () => {
      const result = parseDateKeyword("thu")
      expect(result).toEqual(new Date(2026, 0, 15))
    })

    it("should parse 'thursday' to next Thursday (Jan 15)", () => {
      const result = parseDateKeyword("thursday")
      expect(result).toEqual(new Date(2026, 0, 15))
    })

    it("should parse 'fri' to next Friday (Jan 16)", () => {
      const result = parseDateKeyword("fri")
      expect(result).toEqual(new Date(2026, 0, 16))
    })

    it("should parse 'friday' to next Friday (Jan 16)", () => {
      const result = parseDateKeyword("friday")
      expect(result).toEqual(new Date(2026, 0, 16))
    })

    it("should parse 'sat' to next Saturday (Jan 17)", () => {
      const result = parseDateKeyword("sat")
      expect(result).toEqual(new Date(2026, 0, 17))
    })

    it("should parse 'saturday' to next Saturday (Jan 17)", () => {
      const result = parseDateKeyword("saturday")
      expect(result).toEqual(new Date(2026, 0, 17))
    })
  })

  describe("month + day format", () => {
    it("should parse 'dec20' to Dec 20, 2026", () => {
      const result = parseDateKeyword("dec20")
      expect(result).toEqual(new Date(2026, 11, 20))
    })

    it("should parse 'dec 20' (with space) to Dec 20, 2026", () => {
      const result = parseDateKeyword("dec 20")
      expect(result).toEqual(new Date(2026, 11, 20))
    })

    it("should parse 'december20' to Dec 20, 2026", () => {
      const result = parseDateKeyword("december20")
      expect(result).toEqual(new Date(2026, 11, 20))
    })

    it("should parse 'jan5' to Jan 5, 2027 (past date rolls to next year)", () => {
      const result = parseDateKeyword("jan5")
      expect(result).toEqual(new Date(2027, 0, 5))
    })

    it("should parse 'feb14' to Feb 14, 2026", () => {
      const result = parseDateKeyword("feb14")
      expect(result).toEqual(new Date(2026, 1, 14))
    })

    it("should parse 'mar1' to Mar 1, 2026", () => {
      const result = parseDateKeyword("mar1")
      expect(result).toEqual(new Date(2026, 2, 1))
    })
  })

  describe("invalid keywords", () => {
    it("should return null for 'invalid'", () => {
      const result = parseDateKeyword("invalid")
      expect(result).toBeNull()
    })

    it("should return null for 'dec32' (invalid day)", () => {
      const result = parseDateKeyword("dec32")
      expect(result).toBeNull()
    })

    it("should return null for empty string", () => {
      const result = parseDateKeyword("")
      expect(result).toBeNull()
    })

    it("should return null for random text", () => {
      const result = parseDateKeyword("xyz123")
      expect(result).toBeNull()
    })

    it("should return null for 'dec0' (day 0 is invalid)", () => {
      const result = parseDateKeyword("dec0")
      expect(result).toBeNull()
    })
  })
})

// ============================================================================
// T105: PRIORITY KEYWORD PARSING
// ============================================================================

describe("parsePriorityKeyword", () => {
  describe("urgent priority", () => {
    it("should parse 'urgent' to 'urgent'", () => {
      expect(parsePriorityKeyword("urgent")).toBe("urgent")
    })

    it("should parse 'u' to 'urgent'", () => {
      expect(parsePriorityKeyword("u")).toBe("urgent")
    })
  })

  describe("high priority", () => {
    it("should parse 'high' to 'high'", () => {
      expect(parsePriorityKeyword("high")).toBe("high")
    })

    it("should parse 'h' to 'high'", () => {
      expect(parsePriorityKeyword("h")).toBe("high")
    })
  })

  describe("medium priority", () => {
    it("should parse 'medium' to 'medium'", () => {
      expect(parsePriorityKeyword("medium")).toBe("medium")
    })

    it("should parse 'med' to 'medium'", () => {
      expect(parsePriorityKeyword("med")).toBe("medium")
    })

    it("should parse 'm' to 'medium'", () => {
      expect(parsePriorityKeyword("m")).toBe("medium")
    })
  })

  describe("low priority", () => {
    it("should parse 'low' to 'low'", () => {
      expect(parsePriorityKeyword("low")).toBe("low")
    })

    it("should parse 'l' to 'low'", () => {
      expect(parsePriorityKeyword("l")).toBe("low")
    })
  })

  describe("none priority", () => {
    it("should parse 'none' to 'none'", () => {
      expect(parsePriorityKeyword("none")).toBe("none")
    })

    it("should parse 'n' to 'none'", () => {
      expect(parsePriorityKeyword("n")).toBe("none")
    })
  })

  describe("case insensitivity", () => {
    it("should parse 'URGENT' to 'urgent'", () => {
      expect(parsePriorityKeyword("URGENT")).toBe("urgent")
    })

    it("should parse 'High' to 'high'", () => {
      expect(parsePriorityKeyword("High")).toBe("high")
    })

    it("should parse 'MED' to 'medium'", () => {
      expect(parsePriorityKeyword("MED")).toBe("medium")
    })
  })

  describe("invalid keywords", () => {
    it("should return null for 'invalid'", () => {
      expect(parsePriorityKeyword("invalid")).toBeNull()
    })

    it("should return null for 'xxx'", () => {
      expect(parsePriorityKeyword("xxx")).toBeNull()
    })

    it("should return null for empty string", () => {
      expect(parsePriorityKeyword("")).toBeNull()
    })

    it("should return null for whitespace", () => {
      expect(parsePriorityKeyword("  ")).toBeNull()
    })
  })
})

// ============================================================================
// T106: PROJECT NAME PARSING
// ============================================================================

describe("findProjectByName", () => {
  const projects: Project[] = [
    createMockProject({ id: "project-1", name: "Test Project" }),
    createMockProject({ id: "work", name: "Work" }),
    createMockProject({ id: "personal", name: "Personal Tasks" }),
    createMockProject({ id: "project-alpha", name: "Project Alpha" }),
  ]

  describe("exact ID match", () => {
    it("should find project by exact ID 'project-1'", () => {
      const result = findProjectByName("project-1", projects)
      expect(result).toBe("project-1")
    })

    it("should find project by exact ID 'work'", () => {
      const result = findProjectByName("work", projects)
      expect(result).toBe("work")
    })

    it("should be case-insensitive for ID match", () => {
      const result = findProjectByName("WORK", projects)
      expect(result).toBe("work")
    })
  })

  describe("exact name match (case-insensitive)", () => {
    it("should find project by exact name 'Test Project'", () => {
      const result = findProjectByName("Test Project", projects)
      expect(result).toBe("project-1")
    })

    it("should find project by lowercase name 'test project'", () => {
      const result = findProjectByName("test project", projects)
      expect(result).toBe("project-1")
    })

    it("should find project by uppercase name 'TEST PROJECT'", () => {
      const result = findProjectByName("TEST PROJECT", projects)
      expect(result).toBe("project-1")
    })
  })

  describe("partial name match (starts with)", () => {
    it("should find project starting with 'Test'", () => {
      const result = findProjectByName("Test", projects)
      expect(result).toBe("project-1")
    })

    it("should find project starting with 'Personal'", () => {
      const result = findProjectByName("Personal", projects)
      expect(result).toBe("personal")
    })

    it("should find project starting with 'project' (matches first partial)", () => {
      const result = findProjectByName("project", projects)
      // Partial match searches project names, not IDs - "Project Alpha" starts with "project"
      expect(result).toBe("project-alpha")
    })
  })

  describe("kebab-case name match", () => {
    it("should find 'Test Project' using 'test-project'", () => {
      const result = findProjectByName("test-project", projects)
      expect(result).toBe("project-1")
    })

    it("should find 'Personal Tasks' using 'personal-tasks'", () => {
      const result = findProjectByName("personal-tasks", projects)
      expect(result).toBe("personal")
    })

    it("should find 'Project Alpha' using 'project-alpha'", () => {
      const result = findProjectByName("project-alpha", projects)
      expect(result).toBe("project-alpha")
    })
  })

  describe("not found cases", () => {
    it("should return null for non-existent project", () => {
      const result = findProjectByName("nonexistent", projects)
      expect(result).toBeNull()
    })

    it("should return null for empty projects array", () => {
      const result = findProjectByName("work", [])
      expect(result).toBeNull()
    })

    it("should match first project when empty name (starts with empty string)", () => {
      // Empty string matches first project via startsWith (all names start with "")
      const result = findProjectByName("", projects)
      expect(result).toBe("project-1")
    })
  })
})

// ============================================================================
// T107: MAIN PARSER - parseQuickAdd
// ============================================================================

describe("parseQuickAdd", () => {
  const projects: Project[] = [
    createMockProject({ id: "work", name: "Work" }),
    createMockProject({ id: "personal", name: "Personal" }),
  ]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 10))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("basic parsing", () => {
    it("should parse simple title without syntax", () => {
      const result = parseQuickAdd("Buy groceries", projects)
      expect(result).toEqual({
        title: "Buy groceries",
        dueDate: null,
        priority: "none",
        projectId: null,
      })
    })

    it("should preserve title without special syntax", () => {
      const result = parseQuickAdd("Complete the project report", projects)
      expect(result.title).toBe("Complete the project report")
    })
  })

  describe("date parsing", () => {
    it("should parse '!today' in input", () => {
      const result = parseQuickAdd("Buy groceries !today", projects)
      expect(result.title).toBe("Buy groceries")
      expect(result.dueDate).toEqual(new Date(2026, 0, 10))
    })

    it("should parse '!tomorrow' in input", () => {
      const result = parseQuickAdd("Meeting !tomorrow", projects)
      expect(result.title).toBe("Meeting")
      expect(result.dueDate).toEqual(new Date(2026, 0, 11))
    })

    it("should parse '!mon' in input", () => {
      const result = parseQuickAdd("Review code !mon", projects)
      expect(result.title).toBe("Review code")
      expect(result.dueDate).toEqual(new Date(2026, 0, 12))
    })
  })

  describe("priority parsing", () => {
    it("should parse '!!high' in input", () => {
      const result = parseQuickAdd("Buy groceries !!high", projects)
      expect(result.title).toBe("Buy groceries")
      expect(result.priority).toBe("high")
    })

    it("should parse '!!urgent' in input", () => {
      const result = parseQuickAdd("Emergency fix !!urgent", projects)
      expect(result.title).toBe("Emergency fix")
      expect(result.priority).toBe("urgent")
    })

    it("should parse '!!low' in input", () => {
      const result = parseQuickAdd("Nice to have !!low", projects)
      expect(result.title).toBe("Nice to have")
      expect(result.priority).toBe("low")
    })
  })

  describe("project parsing", () => {
    it("should parse '#work' in input", () => {
      const result = parseQuickAdd("Review PR #work", projects)
      expect(result.title).toBe("Review PR")
      expect(result.projectId).toBe("work")
    })

    it("should parse '#personal' in input", () => {
      const result = parseQuickAdd("Buy groceries #personal", projects)
      expect(result.title).toBe("Buy groceries")
      expect(result.projectId).toBe("personal")
    })

    it("should ignore invalid project reference", () => {
      const result = parseQuickAdd("Task #nonexistent", projects)
      expect(result.title).toBe("Task #nonexistent")
      expect(result.projectId).toBeNull()
    })
  })

  describe("combined syntax", () => {
    it("should parse all fields: date, priority, and project", () => {
      const result = parseQuickAdd("Meeting !tomorrow !!urgent #work", projects)
      expect(result.title).toBe("Meeting")
      expect(result.dueDate).toEqual(new Date(2026, 0, 11))
      expect(result.priority).toBe("urgent")
      expect(result.projectId).toBe("work")
    })

    it("should handle syntax in different order", () => {
      const result = parseQuickAdd("#work Meeting !today !!high", projects)
      expect(result.title).toBe("Meeting")
      expect(result.dueDate).toEqual(new Date(2026, 0, 10))
      expect(result.priority).toBe("high")
      expect(result.projectId).toBe("work")
    })

    it("should handle date and priority only", () => {
      const result = parseQuickAdd("Task !today !!medium", projects)
      expect(result.title).toBe("Task")
      expect(result.dueDate).toEqual(new Date(2026, 0, 10))
      expect(result.priority).toBe("medium")
      expect(result.projectId).toBeNull()
    })
  })

  describe("multiple dates", () => {
    it("should use first valid date when multiple dates present", () => {
      const result = parseQuickAdd("Task !today !tomorrow", projects)
      expect(result.title).toBe("Task !tomorrow")
      expect(result.dueDate).toEqual(new Date(2026, 0, 10))
    })
  })

  describe("invalid syntax preserved", () => {
    it("should preserve invalid date keyword in title", () => {
      const result = parseQuickAdd("Buy !invalid groceries", projects)
      expect(result.title).toBe("Buy !invalid groceries")
      expect(result.dueDate).toBeNull()
    })

    it("should preserve invalid priority keyword in title", () => {
      const result = parseQuickAdd("Task !!xyz", projects)
      expect(result.title).toBe("Task !!xyz")
      expect(result.priority).toBe("none")
    })
  })

  describe("whitespace handling", () => {
    it("should clean extra whitespace", () => {
      const result = parseQuickAdd("  Buy   groceries  ", projects)
      expect(result.title).toBe("Buy groceries")
    })

    it("should clean whitespace after removing syntax", () => {
      const result = parseQuickAdd("Buy  !today   groceries", projects)
      expect(result.title).toBe("Buy groceries")
      expect(result.dueDate).toEqual(new Date(2026, 0, 10))
    })
  })
})

// ============================================================================
// T108: SPECIAL SYNTAX DETECTION
// ============================================================================

describe("hasSpecialSyntax", () => {
  describe("date detection", () => {
    it("should detect date syntax '!today'", () => {
      expect(hasSpecialSyntax("task !today")).toBe(true)
    })

    it("should detect date syntax '!tomorrow'", () => {
      expect(hasSpecialSyntax("task !tomorrow")).toBe(true)
    })

    it("should detect date syntax '!mon'", () => {
      expect(hasSpecialSyntax("task !mon")).toBe(true)
    })
  })

  describe("priority detection", () => {
    it("should detect priority syntax '!!high'", () => {
      expect(hasSpecialSyntax("task !!high")).toBe(true)
    })

    it("should detect priority syntax '!!urgent'", () => {
      expect(hasSpecialSyntax("task !!urgent")).toBe(true)
    })

    it("should detect priority syntax '!!low'", () => {
      expect(hasSpecialSyntax("task !!low")).toBe(true)
    })
  })

  describe("project detection", () => {
    it("should detect project syntax '#work'", () => {
      expect(hasSpecialSyntax("task #work")).toBe(true)
    })

    it("should detect project syntax '#my-project'", () => {
      expect(hasSpecialSyntax("task #my-project")).toBe(true)
    })
  })

  describe("no syntax", () => {
    it("should return false for plain task", () => {
      expect(hasSpecialSyntax("plain task")).toBe(false)
    })

    it("should return false for empty string", () => {
      expect(hasSpecialSyntax("")).toBe(false)
    })
  })

  describe("combined syntax", () => {
    it("should detect combined syntax", () => {
      expect(hasSpecialSyntax("task !today #work")).toBe(true)
    })

    it("should detect all three syntaxes", () => {
      expect(hasSpecialSyntax("task !today !!high #work")).toBe(true)
    })
  })

  describe("edge cases", () => {
    it("should return false for '!' alone", () => {
      expect(hasSpecialSyntax("task !")).toBe(false)
    })

    it("should return false for '!!' alone", () => {
      expect(hasSpecialSyntax("task !!")).toBe(false)
    })

    it("should return false for '#' alone", () => {
      expect(hasSpecialSyntax("task #")).toBe(false)
    })

    it("should detect syntax even with leading !!", () => {
      expect(hasSpecialSyntax("!!high")).toBe(true)
    })
  })
})

// ============================================================================
// T109: PARSE PREVIEW
// ============================================================================

describe("getParsePreview", () => {
  const projects: Project[] = [
    createMockProject({ id: "work", name: "Work" }),
    createMockProject({ id: "personal", name: "Personal" }),
  ]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 10))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("return structure", () => {
    it("should return all required fields", () => {
      const result = getParsePreview("task", projects)
      expect(result).toHaveProperty("hasDate")
      expect(result).toHaveProperty("hasPriority")
      expect(result).toHaveProperty("hasProject")
      expect(result).toHaveProperty("dueDate")
      expect(result).toHaveProperty("priority")
      expect(result).toHaveProperty("projectId")
      expect(result).toHaveProperty("projectName")
    })
  })

  describe("date preview", () => {
    it("should show hasDate true when date present", () => {
      const result = getParsePreview("task !today", projects)
      expect(result.hasDate).toBe(true)
      expect(result.dueDate).toEqual(new Date(2026, 0, 10))
    })

    it("should show hasDate false when no date", () => {
      const result = getParsePreview("task", projects)
      expect(result.hasDate).toBe(false)
      expect(result.dueDate).toBeNull()
    })
  })

  describe("priority preview", () => {
    it("should show hasPriority true when priority present", () => {
      const result = getParsePreview("task !!high", projects)
      expect(result.hasPriority).toBe(true)
      expect(result.priority).toBe("high")
    })

    it("should show hasPriority false when priority is none", () => {
      const result = getParsePreview("task", projects)
      expect(result.hasPriority).toBe(false)
      expect(result.priority).toBe("none")
    })
  })

  describe("project preview", () => {
    it("should show hasProject true with valid project", () => {
      const result = getParsePreview("task #work", projects)
      expect(result.hasProject).toBe(true)
      expect(result.projectId).toBe("work")
      expect(result.projectName).toBe("Work")
    })

    it("should show hasProject false with invalid project", () => {
      const result = getParsePreview("task #nonexistent", projects)
      expect(result.hasProject).toBe(false)
      expect(result.projectId).toBeNull()
      expect(result.projectName).toBeNull()
    })

    it("should show hasProject false when no project", () => {
      const result = getParsePreview("task", projects)
      expect(result.hasProject).toBe(false)
      expect(result.projectId).toBeNull()
      expect(result.projectName).toBeNull()
    })
  })

  describe("combined preview", () => {
    it("should handle all fields correctly", () => {
      const result = getParsePreview("task !tomorrow !!urgent #personal", projects)
      expect(result.hasDate).toBe(true)
      expect(result.hasPriority).toBe(true)
      expect(result.hasProject).toBe(true)
      expect(result.dueDate).toEqual(new Date(2026, 0, 11))
      expect(result.priority).toBe("urgent")
      expect(result.projectId).toBe("personal")
      expect(result.projectName).toBe("Personal")
    })
  })
})

// ============================================================================
// T110: AUTOCOMPLETE OPTIONS
// ============================================================================

describe("getDateOptions", () => {
  describe("no query (default options)", () => {
    it("should return first 5 options when no query", () => {
      const result = getDateOptions("")
      expect(result).toHaveLength(5)
      expect(result.map((o) => o.value)).toEqual([
        "!today",
        "!tomorrow",
        "!nextweek",
        "!monday",
        "!tuesday",
      ])
    })
  })

  describe("filtered by query", () => {
    it("should filter options with 'to' query", () => {
      const result = getDateOptions("to")
      expect(result.map((o) => o.value)).toContain("!today")
      expect(result.map((o) => o.value)).toContain("!tomorrow")
    })

    it("should filter options with 'mon' query", () => {
      const result = getDateOptions("mon")
      expect(result).toHaveLength(1)
      expect(result[0].value).toBe("!monday")
    })

    it("should filter options with 'wed' query", () => {
      const result = getDateOptions("wed")
      expect(result).toHaveLength(1)
      expect(result[0].value).toBe("!wednesday")
    })
  })

  describe("option structure", () => {
    it("should have value, label, and icon for each option", () => {
      const result = getDateOptions("")
      result.forEach((option) => {
        expect(option).toHaveProperty("value")
        expect(option).toHaveProperty("label")
        expect(option).toHaveProperty("icon")
      })
    })
  })
})

describe("getPriorityOptions", () => {
  describe("no query (all options)", () => {
    it("should return all 4 options when no query", () => {
      const result = getPriorityOptions("")
      expect(result).toHaveLength(4)
      expect(result.map((o) => o.value)).toEqual([
        "!!urgent",
        "!!high",
        "!!medium",
        "!!low",
      ])
    })
  })

  describe("filtered by query", () => {
    it("should filter options with 'h' query", () => {
      const result = getPriorityOptions("h")
      expect(result.map((o) => o.value)).toContain("!!high")
    })

    it("should filter options with 'ur' query", () => {
      const result = getPriorityOptions("ur")
      expect(result).toHaveLength(1)
      expect(result[0].value).toBe("!!urgent")
    })

    it("should filter options with 'med' query", () => {
      const result = getPriorityOptions("med")
      expect(result).toHaveLength(1)
      expect(result[0].value).toBe("!!medium")
    })
  })

  describe("option structure", () => {
    it("should have value, label, and icon for each option", () => {
      const result = getPriorityOptions("")
      result.forEach((option) => {
        expect(option).toHaveProperty("value")
        expect(option).toHaveProperty("label")
        expect(option).toHaveProperty("icon")
      })
    })
  })
})

describe("getProjectOptions", () => {
  const projects: Project[] = [
    createMockProject({ id: "work", name: "Work" }),
    createMockProject({ id: "personal", name: "Personal" }),
    createMockProject({ id: "archived", name: "Archived", isArchived: true }),
    createMockProject({ id: "dev", name: "Development" }),
  ]

  describe("no query (all non-archived)", () => {
    it("should return all non-archived projects", () => {
      const result = getProjectOptions("", projects)
      expect(result).toHaveLength(3)
      expect(result.map((o) => o.label)).toEqual([
        "Work",
        "Personal",
        "Development",
      ])
    })

    it("should exclude archived projects", () => {
      const result = getProjectOptions("", projects)
      expect(result.map((o) => o.label)).not.toContain("Archived")
    })
  })

  describe("filtered by query", () => {
    it("should filter by name 'work'", () => {
      const result = getProjectOptions("work", projects)
      expect(result).toHaveLength(1)
      expect(result[0].label).toBe("Work")
    })

    it("should filter by name 'dev'", () => {
      const result = getProjectOptions("dev", projects)
      expect(result).toHaveLength(1)
      expect(result[0].label).toBe("Development")
    })

    it("should filter by ID 'personal'", () => {
      const result = getProjectOptions("personal", projects)
      expect(result).toHaveLength(1)
      expect(result[0].label).toBe("Personal")
    })

    it("should return empty for no matches", () => {
      const result = getProjectOptions("xyz", projects)
      expect(result).toHaveLength(0)
    })
  })

  describe("option structure", () => {
    it("should have correct value format '#project-id'", () => {
      const result = getProjectOptions("", projects)
      expect(result[0].value).toBe("#work")
      expect(result[1].value).toBe("#personal")
    })

    it("should have value, label, and icon for each option", () => {
      const result = getProjectOptions("", projects)
      result.forEach((option) => {
        expect(option).toHaveProperty("value")
        expect(option).toHaveProperty("label")
        expect(option).toHaveProperty("icon")
      })
    })
  })
})
