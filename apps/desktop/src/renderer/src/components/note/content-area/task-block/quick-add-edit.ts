import { findQuickAddSpans, parseQuickAdd, type QuickAddSpan } from '@/lib/quick-add-parser'
import type { Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'

/**
 * The Tasks-page quick-add grammar (`!high`, `#tag`, `+project`, `@friday 3pm`,
 * `every week`), applied to an edit of a task block's title (#2241).
 *
 * Only tokens the user typed in this edit count. A title that already carries
 * syntax-shaped text ("Fix #123", a line imported from Obsidian) keeps it: a
 * token already present in the saved title is title text, not a command, so
 * fixing a typo elsewhere in the line never strips it or rewrites a property.
 * Note links (`[[…]]`) are never consumed here; in a note they are the note's
 * business.
 */
export interface QuickAddEdit {
  /** The title with the applied tokens lifted out. */
  title: string
  /** What those tokens set, as a view-model patch. */
  changes: Partial<Task>
}

const tokenText = (input: string, span: QuickAddSpan): string => input.slice(span.start, span.end)

/** Syntax spans in `input` that the saved title does not already contain. */
const findNewSpans = (input: string, previousTitle: string, now: Date): QuickAddSpan[] =>
  findQuickAddSpans(input, now).filter(
    (span) => span.kind !== 'noteLink' && !previousTitle.includes(tokenText(input, span))
  )

/**
 * True while the input holds syntax the user is typing. The block holds its
 * debounced title save back in that window, so neither a half-typed `!hi` nor
 * a finished `#launch` is written into the title on the way to being parsed.
 */
export const hasPendingQuickAddSyntax = (
  input: string,
  previousTitle: string,
  now: Date = new Date()
): boolean => findNewSpans(input, previousTitle, now).length > 0

const doesSomething = (span: string, projects: Project[], now: Date): boolean => {
  const parsed = parseQuickAdd(span, projects, now)
  return (
    parsed.priority !== 'none' ||
    parsed.projectId !== null ||
    parsed.tags.length > 0 ||
    parsed.dueDate !== null ||
    parsed.repeat !== null
  )
}

const stripSpans = (input: string, spans: QuickAddSpan[]): string => {
  let out = ''
  let cursor = 0
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    out += input.slice(cursor, span.start)
    cursor = span.end
  }
  out += input.slice(cursor)
  return out.replace(/\s+/g, ' ').trim()
}

const mergeTags = (existing: string[], added: string[]): string[] => {
  const seen = new Set(existing.map((tag) => tag.toLowerCase()))
  const merged = [...existing]
  for (const tag of added) {
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(tag)
  }
  return merged
}

/**
 * Parse the title edit, or null when it carries no new syntax that does
 * anything. A token that names nothing (`!hi`, `+unknown`) stays in the title.
 */
export const parseQuickAddEdit = (
  input: string,
  previousTitle: string,
  task: Pick<Task, 'tags' | 'dueDate'> | null,
  projects: Project[],
  now: Date = new Date()
): QuickAddEdit | null => {
  const applied = findNewSpans(input, previousTitle, now).filter((span) =>
    doesSomething(tokenText(input, span), projects, now)
  )
  if (applied.length === 0) return null

  // Parsed together so a repeat anchors to a date typed in the same edit.
  const parsed = parseQuickAdd(
    applied.map((span) => tokenText(input, span)).join(' '),
    projects,
    now
  )

  const title = stripSpans(input, applied) || previousTitle.trim()
  if (!title) return null

  const changes: Partial<Task> = {}
  if (parsed.priority !== 'none') changes.priority = parsed.priority
  if (parsed.projectId) changes.projectId = parsed.projectId
  if (parsed.tags.length > 0) changes.tags = mergeTags(task?.tags ?? [], parsed.tags)

  const typedDate = applied.some((span) => span.kind === 'datePhrase')
  if (typedDate && parsed.dueDate) {
    // A typed date says everything about the day, so a time it leaves out
    // clears the old one.
    changes.dueDate = parsed.dueDate
    changes.dueTime = parsed.dueTime
  } else if (parsed.repeat && parsed.dueDate && !task?.dueDate) {
    // The parser dates an undated repeat to its first occurrence; a task that
    // already has a due date keeps it.
    changes.dueDate = parsed.dueDate
  }
  if (parsed.repeat) {
    changes.repeatConfig = parsed.repeat
    changes.isRepeating = true
  }

  return { title, changes }
}
