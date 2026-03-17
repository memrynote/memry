import type { Priority } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'
import { startOfDay, addDays } from '@/lib/task-utils'

// ============================================================================
// TYPES
// ============================================================================

export interface ParsedQuickAdd {
  title: string
  dueDate: Date | null
  priority: Priority
  projectId: string | null
}

// ============================================================================
// DATE PARSING
// ============================================================================

/**
 * Map of day name abbreviations to day indices (0 = Sunday)
 */
const dayNameMap: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6
}

/**
 * Map of month name abbreviations to month indices (0 = January)
 */
const monthNameMap: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11
}

/**
 * Get next occurrence of a day of the week
 */
const getNextDayOfWeek = (targetDay: number): Date => {
  const today = startOfDay(new Date())
  const currentDay = today.getDay()
  let daysUntil = targetDay - currentDay

  // If today is the target day, get next week's
  if (daysUntil <= 0) {
    daysUntil += 7
  }

  return addDays(today, daysUntil)
}

const buildDateWithRollover = (monthIndex: number, day: number): Date => {
  const today = new Date()
  const year = today.getFullYear()
  const date = new Date(year, monthIndex, day)
  date.setHours(0, 0, 0, 0)

  if (date < startOfDay(today)) {
    date.setFullYear(year + 1)
  }

  return date
}

/**
 * Parse date keyword to Date object
 * Supports: today, tomorrow, day names (mon, tue, etc.), month+day (dec20, 20dec)
 */
export const parseDateKeyword = (keyword: string): Date | null => {
  const lower = keyword.toLowerCase().trim()

  if (lower === 'today') {
    return startOfDay(new Date())
  }

  if (lower === 'tomorrow' || lower === 'tmr' || lower === 'tom') {
    return addDays(startOfDay(new Date()), 1)
  }

  if (lower === 'nextweek' || lower === 'next') {
    return addDays(startOfDay(new Date()), 7)
  }

  if (dayNameMap[lower] !== undefined) {
    return getNextDayOfWeek(dayNameMap[lower])
  }

  // Month + day: dec20, dec 20, december20
  const monthDayMatch = lower.match(/^([a-z]+)\s*(\d{1,2})$/)
  if (monthDayMatch) {
    const [, monthStr, dayStr] = monthDayMatch
    const monthIndex = monthNameMap[monthStr]
    const day = parseInt(dayStr, 10)

    if (monthIndex !== undefined && day >= 1 && day <= 31) {
      return buildDateWithRollover(monthIndex, day)
    }
  }

  // Day + month: 20dec, 21jan, 23may
  const dayMonthMatch = lower.match(/^(\d{1,2})\s*([a-z]+)$/)
  if (dayMonthMatch) {
    const [, dayStr, monthStr] = dayMonthMatch
    const monthIndex = monthNameMap[monthStr]
    const day = parseInt(dayStr, 10)

    if (monthIndex !== undefined && day >= 1 && day <= 31) {
      return buildDateWithRollover(monthIndex, day)
    }
  }

  return null
}

// ============================================================================
// PRIORITY PARSING
// ============================================================================

const priorityMap: Record<string, Priority> = {
  urgent: 'urgent',
  u: 'urgent',
  high: 'high',
  h: 'high',
  medium: 'medium',
  med: 'medium',
  m: 'medium',
  low: 'low',
  l: 'low',
  none: 'none',
  n: 'none'
}

/**
 * Parse priority keyword to Priority value
 */
export const parsePriorityKeyword = (keyword: string): Priority | null => {
  const lower = keyword.toLowerCase().trim()
  return priorityMap[lower] || null
}

// ============================================================================
// PROJECT PARSING
// ============================================================================

/**
 * Find project by name or ID (case-insensitive)
 */
export const findProjectByName = (name: string, projects: Project[]): string | null => {
  const lower = name.toLowerCase().trim()

  // Try exact ID match first
  const byId = projects.find((p) => p.id.toLowerCase() === lower)
  if (byId) return byId.id

  // Try exact name match
  const byName = projects.find((p) => p.name.toLowerCase() === lower)
  if (byName) return byName.id

  // Try partial name match (starts with)
  const byPartial = projects.find((p) => p.name.toLowerCase().startsWith(lower))
  if (byPartial) return byPartial.id

  // Try kebab-case name match (e.g., "project-alpha" matches "Project Alpha")
  const kebabName = lower.replace(/-/g, ' ')
  const byKebab = projects.find((p) => p.name.toLowerCase() === kebabName)
  if (byKebab) return byKebab.id

  return null
}

// ============================================================================
// MAIN PARSER
// ============================================================================

/**
 * Parse quick add input string with special syntax
 *
 * Syntax:
 * - Due date: !today, !tomorrow, !mon, !dec20
 * - Priority: !!urgent, !!high, !!medium, !!low
 * - Project: #project-name, #personal, #work
 *
 * Examples:
 * - "Buy groceries !today !!high" → title: "Buy groceries", due: today, priority: high
 * - "Review PR #work !tomorrow" → title: "Review PR", project: work, due: tomorrow
 */
export const parseQuickAdd = (input: string, projects: Project[]): ParsedQuickAdd => {
  let title = input
  let dueDate: Date | null = null
  let priority: Priority = 'none'
  let projectId: string | null = null

  // Parse due date: !keyword (single !)
  // Match !word but not !!word (priority)
  const dateMatches = input.match(/(?<![!])!([a-zA-Z0-9]+)/g)
  if (dateMatches) {
    for (const match of dateMatches) {
      const keyword = match.slice(1) // Remove the !
      const parsedDate = parseDateKeyword(keyword)
      if (parsedDate) {
        dueDate = parsedDate
        title = title.replace(match, '').trim()
        break // Only use first valid date
      }
    }
  }

  // Parse priority: !!keyword (double !)
  const priorityMatch = input.match(/!!([a-zA-Z]+)/)
  if (priorityMatch) {
    const keyword = priorityMatch[1]
    const parsedPriority = parsePriorityKeyword(keyword)
    if (parsedPriority) {
      priority = parsedPriority
      title = title.replace(priorityMatch[0], '').trim()
    }
  }

  // Parse project: #project-name
  const projectMatch = input.match(/#([\w-]+)/)
  if (projectMatch) {
    const projectName = projectMatch[1]
    const foundProjectId = findProjectByName(projectName, projects)
    if (foundProjectId) {
      projectId = foundProjectId
      title = title.replace(projectMatch[0], '').trim()
    }
  }

  // Clean up extra whitespace
  title = title.replace(/\s+/g, ' ').trim()

  return {
    title,
    dueDate,
    priority,
    projectId
  }
}

// ============================================================================
// PREVIEW HELPERS
// ============================================================================

/**
 * Check if input has any special syntax
 */
export const hasSpecialSyntax = (input: string): boolean => {
  return (
    /(?<![!])![a-zA-Z0-9]+/.test(input) || // date
    /!![a-zA-Z]+/.test(input) || // priority
    /#[\w-]+/.test(input)
  ) // project
}

/**
 * Get parsed preview info (without modifying title)
 */
export const getParsePreview = (
  input: string,
  projects: Project[]
): {
  hasDate: boolean
  hasPriority: boolean
  hasProject: boolean
  dueDate: Date | null
  priority: Priority
  projectId: string | null
  projectName: string | null
} => {
  const parsed = parseQuickAdd(input, projects)
  const project = projects.find((p) => p.id === parsed.projectId)

  return {
    hasDate: parsed.dueDate !== null,
    hasPriority: parsed.priority !== 'none',
    hasProject: parsed.projectId !== null,
    dueDate: parsed.dueDate,
    priority: parsed.priority,
    projectId: parsed.projectId,
    projectName: project?.name || null
  }
}

// ============================================================================
// AUTOCOMPLETE OPTION GENERATORS
// ============================================================================

export interface AutocompleteOption {
  value: string
  label: string
  icon?: string
}

export const resolveDateDay = (keyword: string): number | null => {
  const date = parseDateKeyword(keyword)
  return date ? date.getDate() : null
}

/**
 * Get date options for autocomplete, filtered by query
 */
export const getDateOptions = (query: string): AutocompleteOption[] => {
  const keywords = [
    { keyword: 'today', label: 'Today' },
    { keyword: 'tomorrow', label: 'Tomorrow' },
    { keyword: 'nextweek', label: 'Next Week' },
    { keyword: 'monday', label: 'Monday' },
    { keyword: 'tuesday', label: 'Tuesday' },
    { keyword: 'wednesday', label: 'Wednesday' },
    { keyword: 'thursday', label: 'Thursday' },
    { keyword: 'friday', label: 'Friday' },
    { keyword: 'saturday', label: 'Saturday' },
    { keyword: 'sunday', label: 'Sunday' }
  ]

  const options: AutocompleteOption[] = keywords.map(({ keyword, label }) => ({
    value: `!${keyword}`,
    label
  }))

  if (!query) return options.slice(0, 5)

  const lowerQuery = query.toLowerCase()
  return options.filter(
    (opt) =>
      opt.value.toLowerCase().includes(lowerQuery) || opt.label.toLowerCase().includes(lowerQuery)
  )
}

/**
 * Get priority options for autocomplete, filtered by query
 */
export const getPriorityOptions = (query: string): AutocompleteOption[] => {
  const options: AutocompleteOption[] = [
    { value: '!!urgent', label: 'Urgent' },
    { value: '!!high', label: 'High' },
    { value: '!!medium', label: 'Medium' },
    { value: '!!low', label: 'Low' }
  ]

  if (!query) return options

  const lowerQuery = query.toLowerCase()
  return options.filter(
    (opt) =>
      opt.value.toLowerCase().includes(lowerQuery) || opt.label.toLowerCase().includes(lowerQuery)
  )
}

/**
 * Get project options for autocomplete, filtered by query
 */
export const getProjectOptions = (query: string, projects: Project[]): AutocompleteOption[] => {
  const activeProjects = projects.filter((p) => !p.isArchived)

  if (!query) {
    return activeProjects.map((p) => ({
      value: `#${p.name}`,
      label: p.name
    }))
  }

  const lowerQuery = query.toLowerCase()
  return activeProjects
    .filter(
      (p) => p.name.toLowerCase().includes(lowerQuery) || p.id.toLowerCase().includes(lowerQuery)
    )
    .map((p) => ({
      value: `#${p.name}`,
      label: p.name
    }))
}
