import type { Priority, RepeatConfig } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { startOfDay, addDays } from '@/lib/task-utils'
import { parseNaturalDate } from '@/lib/natural-date-parser'
import { findRepeatPhrase, firstOccurrenceFor } from '@/lib/repeat-phrase'

// ============================================================================
// TYPES
// ============================================================================

export interface ParsedQuickAdd {
  title: string
  dueDate: Date | null
  /** "HH:MM", only when the natural-language date carried a time. */
  dueTime: string | null
  priority: Priority
  projectId: string | null
  repeat: RepeatConfig | null
}

/** A stretch of the input that carries syntax rather than title text. */
export type QuickAddSpanKind = 'date' | 'priority' | 'project' | 'datePhrase' | 'repeat'

export interface QuickAddSpan {
  start: number
  /** Exclusive. */
  end: number
  kind: QuickAddSpanKind
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
// NATURAL-LANGUAGE DATE PHRASES (@tomorrow, @next wednesday, @dec 20 at 3pm)
// ============================================================================

export interface DatePhraseMatch {
  /** Index of the `@` in the scanned input. */
  start: number
  /** Exclusive end index of the phrase. */
  end: number
  /** The matched text including the `@` (what the pill paints over). */
  text: string
  date: Date
  /** "HH:MM" when the phrase carried a time, null otherwise. */
  time: string | null
}

/** `@` plus at most this many words — the cap on the greedy phrase scan. */
const MAX_DATE_PHRASE_WORDS = 4

/**
 * Find the first `@…` run that reads as a date, matching the note editor's
 * `@`-mention grammar: the `@` starts a word and the phrase can span several
 * words. Longest match wins, so "@next wednesday call bob" keeps "call bob" in
 * the title.
 */
export const findDatePhrase = (input: string): DatePhraseMatch | null => {
  for (const at of input.matchAll(/@/g)) {
    const start = at.index
    // A mention starts a word — "a@b" is not one.
    if (start > 0 && !/\s/.test(input[start - 1])) continue

    const rest = input.slice(start + 1)
    if (!rest || /^\s/.test(rest)) continue

    const wordEnds = [...rest.matchAll(/\S+/g)]
      .slice(0, MAX_DATE_PHRASE_WORDS)
      .map((word) => word.index + word[0].length)

    for (let count = wordEnds.length; count >= 1; count--) {
      const phrase = rest.slice(0, wordEnds[count - 1])
      const parsed = parseNaturalDate(phrase)
      if (parsed.success) {
        return {
          start,
          end: start + 1 + phrase.length,
          text: `@${phrase}`,
          date: parsed.result.date,
          time: parsed.result.time
        }
      }
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

/** Sorted, non-overlapping — an earlier span wins a contested stretch. */
const dropOverlaps = (spans: QuickAddSpan[]): QuickAddSpan[] => {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const kept: QuickAddSpan[] = []
  for (const span of sorted) {
    if (kept.length > 0 && span.start < kept[kept.length - 1].end) continue
    kept.push(span)
  }
  return kept
}

const stripSpans = (input: string, spans: QuickAddSpan[]): string => {
  let title = ''
  let cursor = 0
  for (const span of spans) {
    title += input.slice(cursor, span.start)
    cursor = span.end
  }
  title += input.slice(cursor)
  return title.replace(/\s+/g, ' ').trim()
}

/**
 * Parse quick add input string with special syntax
 *
 * Syntax:
 * - Due date: !today, !tomorrow, !mon, !dec20
 * - Natural due date: @tomorrow, @next wednesday, @dec 20 at 3pm
 * - Repeat: every day, every weekday, every monday, every 2 weeks, every month
 * - Priority: !!urgent, !!high, !!medium, !!low
 * - Project: #project-name, #personal, #work
 *
 * Examples:
 * - "Buy groceries !today !!high" → title: "Buy groceries", due: today, priority: high
 * - "Review PR #work @next friday" → title: "Review PR", project: work, due: next Friday
 * - "Water plants every 2 weeks" → title: "Water plants", repeats every second week
 */
export const parseQuickAdd = (input: string, projects: Project[]): ParsedQuickAdd => {
  const spans: QuickAddSpan[] = []
  let dueDate: Date | null = null
  let dueTime: string | null = null
  let priority: Priority = 'none'
  let projectId: string | null = null

  // Natural-language due date: @tomorrow, @next wednesday
  const datePhrase = findDatePhrase(input)
  if (datePhrase) {
    dueDate = datePhrase.date
    dueTime = datePhrase.time
    spans.push({ start: datePhrase.start, end: datePhrase.end, kind: 'datePhrase' })
  }

  // Due date keyword: !keyword (single !, never !!keyword — that is priority)
  if (!dueDate) {
    for (const match of input.matchAll(/(?<![!])!([a-zA-Z0-9]+)/g)) {
      const parsedDate = parseDateKeyword(match[1])
      if (parsedDate) {
        dueDate = parsedDate
        spans.push({ start: match.index, end: match.index + match[0].length, kind: 'date' })
        break // Only use first valid date
      }
    }
  }

  // Repeat: every monday, every 2 weeks. Anchored to the due date so a bare
  // "every month" repeats on the day the task is actually due.
  const repeatPhrase = findRepeatPhrase(input, dueDate ?? new Date())
  const repeat = repeatPhrase?.config ?? null
  if (repeatPhrase) {
    spans.push({ start: repeatPhrase.start, end: repeatPhrase.end, kind: 'repeat' })
  }

  // Parse priority: !!keyword (double !)
  const priorityMatch = input.match(/!!([a-zA-Z]+)/)
  if (priorityMatch?.index !== undefined) {
    const parsedPriority = parsePriorityKeyword(priorityMatch[1])
    if (parsedPriority) {
      priority = parsedPriority
      spans.push({
        start: priorityMatch.index,
        end: priorityMatch.index + priorityMatch[0].length,
        kind: 'priority'
      })
    }
  }

  // Parse project: #project-name
  const projectMatch = input.match(/#([\w-]+)/)
  if (projectMatch?.index !== undefined) {
    const foundProjectId = findProjectByName(projectMatch[1], projects)
    if (foundProjectId) {
      projectId = foundProjectId
      spans.push({
        start: projectMatch.index,
        end: projectMatch.index + projectMatch[0].length,
        kind: 'project'
      })
    }
  }

  // A repeat only rolls forward from a due date, so give an undated repeating
  // task its first occurrence.
  if (repeat && !dueDate) {
    dueDate = firstOccurrenceFor(repeat)
  }

  return {
    title: stripSpans(input, dropOverlaps(spans)),
    dueDate,
    dueTime,
    priority,
    projectId,
    repeat
  }
}

/**
 * The stretches of `input` that carry syntax, for the token overlay. Same
 * source of truth as {@link parseQuickAdd}, so a highlighted phrase is always
 * one that actually left the title.
 */
export const findQuickAddSpans = (input: string): QuickAddSpan[] => {
  const spans: QuickAddSpan[] = []

  const datePhrase = findDatePhrase(input)
  if (datePhrase) {
    spans.push({ start: datePhrase.start, end: datePhrase.end, kind: 'datePhrase' })
  }

  const repeatPhrase = findRepeatPhrase(input)
  if (repeatPhrase) {
    spans.push({ start: repeatPhrase.start, end: repeatPhrase.end, kind: 'repeat' })
  }

  // The sigil forms are painted as soon as they are typed, parseable or not —
  // an unfinished "!tom" or an unknown "#foo" still reads as syntax.
  for (const match of input.matchAll(/(!![a-zA-Z]+|(?<![!])![a-zA-Z0-9]+|#[\w-]+)/g)) {
    const raw = match[0]
    const kind: QuickAddSpanKind = raw.startsWith('!!')
      ? 'priority'
      : raw.startsWith('!')
        ? 'date'
        : 'project'
    spans.push({ start: match.index, end: match.index + raw.length, kind })
  }

  return dropOverlaps(spans)
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
    /#[\w-]+/.test(input) || // project
    findDatePhrase(input) !== null || // @tomorrow
    findRepeatPhrase(input) !== null // every monday
  )
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
 * The cadences the ghost completes to. Ordered so the shortest useful phrase
 * wins an ambiguous prefix ("every w" → weekday, the commonest routine).
 */
const REPEAT_PHRASES = [
  'every day',
  'every weekday',
  'every week',
  'every 2 weeks',
  'every weekend',
  'every month',
  'every year'
]

/**
 * Canonical cadence for a half-typed "every …", or null when nothing completes
 * it. Case-insensitive superstring of `query`, like the date completions.
 */
export const predictRepeatCompletion = (query: string): string | null => {
  const lower = query.toLowerCase()
  return REPEAT_PHRASES.find((phrase) => phrase.startsWith(lower)) ?? null
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
