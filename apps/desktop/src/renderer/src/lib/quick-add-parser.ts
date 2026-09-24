/**
 * Quick-add parsing for the capture bar and task inputs.
 *
 * The grammar lives in `@memry/domain-tasks/parsing` so the iOS core is held to
 * it by conformance vectors (spec 004 D1, D5). This module supplies the
 * renderer's clock and keeps the renderer-only helpers (preview, autocomplete).
 */
import type { Priority } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import {
  findDatePhrase as findDatePhraseAt,
  findQuickAddSpans as findQuickAddSpansAt,
  hasSpecialSyntax as hasSpecialSyntaxAt,
  parseQuickAdd as parseQuickAddAt
} from '@memry/domain-tasks/parsing'
import type { DatePhraseMatch, ParsedQuickAdd, QuickAddSpan } from '@memry/domain-tasks/parsing'

export {
  findNoteLinks,
  findProjectByName,
  parsePriorityKeyword,
  predictRepeatCompletion
} from '@memry/domain-tasks/parsing'
export type {
  DatePhraseMatch,
  NoteLinkMatch,
  ParsedQuickAdd,
  QuickAddSpan,
  QuickAddSpanKind
} from '@memry/domain-tasks/parsing'

/**
 * Find the first `@…` run that reads as a date. Longest match wins, so
 * "@next wednesday call bob" keeps "call bob" in the title.
 */
export const findDatePhrase = (input: string, now: Date = new Date()): DatePhraseMatch | null =>
  findDatePhraseAt(input, now)

/**
 * Parse quick add input string with special syntax
 *
 * Syntax (the note editor's grammar, so both surfaces agree):
 * - Due date: @tomorrow, @next wednesday, @dec 20 at 3pm
 * - Repeat: every day, every weekday, every monday, every 2 weeks, every month
 * - Priority: !urgent, !high, !medium, !low
 * - Project: +project-name, +personal, +work
 * - Tag: #launch, #work/client — every tag in the input counts
 * - Note link: [[Roadmap]]
 */
export const parseQuickAdd = (
  input: string,
  projects: Project[],
  now: Date = new Date()
): ParsedQuickAdd => parseQuickAddAt(input, projects, now)

/** The stretches of `input` that carry syntax, for the token overlay. */
export const findQuickAddSpans = (input: string, now: Date = new Date()): QuickAddSpan[] =>
  findQuickAddSpansAt(input, now)

// ============================================================================
// PREVIEW HELPERS
// ============================================================================

/**
 * Check if input has any special syntax
 */
export const hasSpecialSyntax = (input: string, now: Date = new Date()): boolean =>
  hasSpecialSyntaxAt(input, now)

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
 * Get priority options for autocomplete, filtered by query
 */
export const getPriorityOptions = (query: string): AutocompleteOption[] => {
  const options: AutocompleteOption[] = [
    { value: '!urgent', label: 'Urgent' },
    { value: '!high', label: 'High' },
    { value: '!medium', label: 'Medium' },
    { value: '!low', label: 'Low' }
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
      value: `+${p.name}`,
      label: p.name
    }))
  }

  const lowerQuery = query.toLowerCase()
  return activeProjects
    .filter(
      (p) => p.name.toLowerCase().includes(lowerQuery) || p.id.toLowerCase().includes(lowerQuery)
    )
    .map((p) => ({
      value: `+${p.name}`,
      label: p.name
    }))
}

/**
 * Get tag options for autocomplete, filtered by query. The pool is the app's
 * existing tags (notes and tasks share it), in the order the caller supplies.
 */
export const getTagOptions = (query: string, tags: string[]): AutocompleteOption[] => {
  const options: AutocompleteOption[] = tags.map((tag) => ({ value: `#${tag}`, label: tag }))

  if (!query) return options

  const lowerQuery = query.toLowerCase()
  return options.filter((opt) => opt.label.toLowerCase().includes(lowerQuery))
}
