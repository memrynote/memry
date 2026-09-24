/**
 * The quick-add grammar: `@date`, `every …`, `!priority`, `+project`, `#tag`,
 * `[[note]]` (spec 004 D1: English only, `@` prefix required for dates).
 *
 * Offsets are JavaScript string indices — UTF-16 code units — and the
 * conformance vectors pin them that way, so a port indexes the same units.
 * `now` is the caller's clock; nothing here reads one.
 */
import { parseNaturalDate } from './natural-date.ts'
import { findRepeatPhrase, firstOccurrenceFor } from './repeat-phrase.ts'
import type { Priority, QuickAddProject, RepeatConfig } from './types.ts'

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
  /** Every `#tag` in the input, in order, with the typed casing kept. */
  tags: string[]
  /**
   * The titles inside `[[…]]`, in order. The parser only sees text, so the
   * surface maps these to note ids (see CaptureBar).
   */
  noteTitles: string[]
}

/** A stretch of the input that carries syntax rather than title text. */
export type QuickAddSpanKind = 'priority' | 'project' | 'tag' | 'noteLink' | 'datePhrase' | 'repeat'

export interface QuickAddSpan {
  start: number
  /** Exclusive. */
  end: number
  kind: QuickAddSpanKind
}

// ============================================================================
// MARKER GRAMMAR
// ============================================================================

/**
 * `!` starts a word and needs at least one letter after it, so prose keeps its
 * punctuation: "Ship it!" and "Wow!!" are titles, not priorities.
 */
const PRIORITY_PATTERN = /(?:^|\s)(![a-zA-Z]+)/g

/** `+` starts a word, so "1+2" and "C++" never read as a project. */
const PROJECT_PATTERN = /(?:^|\s)(\+[\w-]+)/g

/**
 * The note editor's tag grammar verbatim, nesting included — see
 * `HASH_TAG_PATTERN` in `components/note/content-area/hash-tag.tsx`, which also
 * requires the `#` to start a word. `C#` and `issue#12` are therefore prose.
 */
const TAG_PATTERN = /(?:^|\s)(#[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*)/g

/** `[[Note title]]` — note titles are arbitrary, so anything but the brackets. */
const NOTE_LINK_PATTERN = /\[\[([^[\]\n]+)\]\]/g

interface MarkerRun {
  start: number
  /** Exclusive. */
  end: number
  /** The run including its sigil, e.g. `!high`. */
  text: string
  /** The run without its sigil, e.g. `high`. */
  value: string
}

/**
 * Every run of `pattern` in `input`. The patterns above match a leading space
 * to anchor the sigil to a word start, so the run itself is capture group 1.
 */
const findMarkerRuns = (input: string, pattern: RegExp): MarkerRun[] => {
  const runs: MarkerRun[] = []
  for (const match of input.matchAll(pattern)) {
    const text = match[1]
    const start = match.index + match[0].length - text.length
    runs.push({ start, end: start + text.length, text, value: text.slice(1) })
  }
  return runs
}

export interface NoteLinkMatch {
  start: number
  /** Exclusive. */
  end: number
  /** The text between the brackets. */
  title: string
}

/** Every finished `[[…]]` run. An unclosed `[[` is still being typed. */
export const findNoteLinks = (input: string): NoteLinkMatch[] => {
  const links: NoteLinkMatch[] = []
  for (const match of input.matchAll(NOTE_LINK_PATTERN)) {
    links.push({
      start: match.index,
      end: match.index + match[0].length,
      title: match[1].trim()
    })
  }
  return links
}

/**
 * A note title is user text and may well contain a sigil — `[[Q3 #launch]]`
 * links a note, it does not tag the task. Markers inside a link are ignored.
 */
const isInsideLink = (links: NoteLinkMatch[], index: number): boolean =>
  links.some((link) => index >= link.start && index < link.end)

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
export const findDatePhrase = (input: string, now: Date): DatePhraseMatch | null => {
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
      const parsed = parseNaturalDate(phrase, now)
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
export const findProjectByName = (
  name: string,
  projects: readonly QuickAddProject[]
): string | null => {
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
 * Syntax (the note editor's grammar, so both surfaces agree):
 * - Due date: @tomorrow, @next wednesday, @dec 20 at 3pm
 * - Repeat: every day, every weekday, every monday, every 2 weeks, every month
 * - Priority: !urgent, !high, !medium, !low
 * - Project: +project-name, +personal, +work
 * - Tag: #launch, #work/client — every tag in the input counts
 * - Note link: [[Roadmap]]
 *
 * Examples:
 * - "Buy groceries @today !high" → title: "Buy groceries", due: today, priority: high
 * - "Review PR +work @next friday" → title: "Review PR", project: work, due: next Friday
 * - "Water plants every 2 weeks" → title: "Water plants", repeats every second week
 */
export const parseQuickAdd = (
  input: string,
  projects: readonly QuickAddProject[],
  now: Date
): ParsedQuickAdd => {
  const spans: QuickAddSpan[] = []
  let dueDate: Date | null = null
  let dueTime: string | null = null
  let priority: Priority = 'none'
  let projectId: string | null = null

  // Note links first: they own their whole run, sigils inside included.
  const noteLinks = findNoteLinks(input)
  for (const link of noteLinks) {
    spans.push({ start: link.start, end: link.end, kind: 'noteLink' })
  }

  // Natural-language due date: @tomorrow, @next wednesday
  const datePhrase = findDatePhrase(input, now)
  if (datePhrase && !isInsideLink(noteLinks, datePhrase.start)) {
    dueDate = datePhrase.date
    dueTime = datePhrase.time
    spans.push({ start: datePhrase.start, end: datePhrase.end, kind: 'datePhrase' })
  }

  // Repeat: every monday, every 2 weeks. Anchored to the due date so a bare
  // "every month" repeats on the day the task is actually due.
  const repeatPhrase = findRepeatPhrase(input, dueDate ?? now, now)
  const repeat =
    repeatPhrase && !isInsideLink(noteLinks, repeatPhrase.start) ? repeatPhrase.config : null
  if (repeatPhrase && repeat) {
    spans.push({ start: repeatPhrase.start, end: repeatPhrase.end, kind: 'repeat' })
  }

  // Priority: !high. The first run that names a priority wins; "!nope" is prose.
  for (const run of findMarkerRuns(input, PRIORITY_PATTERN)) {
    if (isInsideLink(noteLinks, run.start)) continue
    const parsedPriority = parsePriorityKeyword(run.value)
    if (parsedPriority) {
      priority = parsedPriority
      spans.push({ start: run.start, end: run.end, kind: 'priority' })
      break
    }
  }

  // Project: +work. Unresolved "+foo" stays in the title.
  for (const run of findMarkerRuns(input, PROJECT_PATTERN)) {
    if (isInsideLink(noteLinks, run.start)) continue
    const foundProjectId = findProjectByName(run.value, projects)
    if (foundProjectId) {
      projectId = foundProjectId
      spans.push({ start: run.start, end: run.end, kind: 'project' })
      break
    }
  }

  // Tags: unlike the other markers, every one counts — a task takes several.
  const tags: string[] = []
  for (const run of findMarkerRuns(input, TAG_PATTERN)) {
    if (isInsideLink(noteLinks, run.start)) continue
    tags.push(run.value)
    spans.push({ start: run.start, end: run.end, kind: 'tag' })
  }

  // A repeat only rolls forward from a due date, so give an undated repeating
  // task its first occurrence.
  if (repeat && !dueDate) {
    dueDate = firstOccurrenceFor(repeat, now)
  }

  return {
    title: stripSpans(input, dropOverlaps(spans)),
    dueDate,
    dueTime,
    priority,
    projectId,
    repeat,
    tags,
    noteTitles: noteLinks.map((link) => link.title).filter(Boolean)
  }
}

/**
 * The stretches of `input` that carry syntax, for the token overlay. Same
 * source of truth as {@link parseQuickAdd}, so a highlighted phrase is always
 * one that actually left the title.
 */
export const findQuickAddSpans = (input: string, now: Date): QuickAddSpan[] => {
  const spans: QuickAddSpan[] = []

  const noteLinks = findNoteLinks(input)
  for (const link of noteLinks) {
    spans.push({ start: link.start, end: link.end, kind: 'noteLink' })
  }

  const datePhrase = findDatePhrase(input, now)
  if (datePhrase && !isInsideLink(noteLinks, datePhrase.start)) {
    spans.push({ start: datePhrase.start, end: datePhrase.end, kind: 'datePhrase' })
  }

  const repeatPhrase = findRepeatPhrase(input, now, now)
  if (repeatPhrase && !isInsideLink(noteLinks, repeatPhrase.start)) {
    spans.push({ start: repeatPhrase.start, end: repeatPhrase.end, kind: 'repeat' })
  }

  // The sigil forms are painted as soon as they are typed, parseable or not —
  // an unfinished "!hi" or an unknown "+foo" still reads as syntax.
  const sigilKinds: [RegExp, QuickAddSpanKind][] = [
    [PRIORITY_PATTERN, 'priority'],
    [PROJECT_PATTERN, 'project'],
    [TAG_PATTERN, 'tag']
  ]
  for (const [pattern, kind] of sigilKinds) {
    for (const run of findMarkerRuns(input, pattern)) {
      if (isInsideLink(noteLinks, run.start)) continue
      spans.push({ start: run.start, end: run.end, kind })
    }
  }

  return dropOverlaps(spans)
}

// ============================================================================
// PREVIEW HELPERS
// ============================================================================

/**
 * Check if input has any special syntax
 */
export const hasSpecialSyntax = (input: string, now: Date): boolean => {
  // Scanned with matchAll rather than `.test()`: these patterns are global and
  // module-level, so `.test()` would carry `lastIndex` between calls.
  return (
    findMarkerRuns(input, PRIORITY_PATTERN).length > 0 ||
    findMarkerRuns(input, PROJECT_PATTERN).length > 0 ||
    findMarkerRuns(input, TAG_PATTERN).length > 0 ||
    findNoteLinks(input).length > 0 ||
    findDatePhrase(input, now) !== null || // @tomorrow
    findRepeatPhrase(input, now, now) !== null // every monday
  )
}

// ============================================================================
// GHOST COMPLETION FOR REPEAT PHRASES
// ============================================================================

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
