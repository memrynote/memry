/**
 * Finds the checklist lines an import should turn into real tasks.
 *
 * Importers write plain `- [ ] …` markdown, which only became a `tasks` row
 * once the user opened the note AND edited it: the editor's onChange analyzer
 * (renderer `scan-task-intents.ts`) converts one checkbox per 600ms debounce.
 * Most imported checklists therefore never became tasks at all. This module is
 * the same decision, taken once per note at import time.
 *
 * The rules are the editor's, deliberately:
 *   - a line already carrying `{task:<id>}` is a persisted task, never a
 *     candidate (converting it would mint a duplicate and drop the original id)
 *   - a line `obsidianTaskImportBlocker` rejects is left byte-identical
 *   - plugin fields are lifted off the title with `buildObsidianTaskImport`
 *   - 1-level subtask depth: a checkbox nested directly under a *top-level*
 *     converted checkbox is its subtask; anything deeper becomes a standalone
 *     task, exactly as the editor's analyzer resolves it
 *
 * Pure and side-effect free — `imported-note.ts` owns the DB writes.
 *
 * @module main/import/_shared/checklist-tasks
 */

import { createFenceTracker } from '@memry/shared/markdown-fences'
import { parseTaskBlockSuffix } from '@memry/shared/task-block'
import { obsidianTaskImportBlocker } from '@memry/shared/obsidian-tasks'
import {
  buildObsidianTaskImport,
  type ObsidianTaskImport
} from '@memry/shared/obsidian-task-import'

export interface PlannedChecklistTask {
  /** Index into the markdown's `\n`-split lines. */
  lineIndex: number
  /** The line's own leading whitespace, kept so the rewrite preserves nesting. */
  indent: string
  /** The line's own list marker (`-`, `*` or `+`). */
  listMarker: string
  checked: boolean
  /** Title after the Obsidian Tasks field lift. Never empty. */
  title: string
  /** The line's `#tags`, clamped to what the create contract accepts. */
  tags: string[]
  /** Index into this array, or null for a top-level task. */
  parentIndex: number | null
  /** Null when the line carries no Obsidian Tasks plugin syntax. */
  obsidian: ObsidianTaskImport | null
}

/**
 * `TaskCreateSchema`'s own limits. The import creates tasks through the domain
 * rather than the IPC handler, so nothing validates them on the way in — and a
 * row over these bounds is one the user's next edit cannot save. The editor's
 * converter clamps to the same numbers before its create (`tagsForCreate` in
 * ContentArea), so a line the schema would reject stays plain markdown here too.
 */
const TITLE_MAX_LENGTH = 500
const TAG_MAX_LENGTH = 50
const TAG_MAX_COUNT = 20

/** Case-insensitive union, first casing kept, as `setTaskTags` stores them. */
function tagsForCreate(tags: string[]): string[] {
  const byKey = new Map<string, string>()
  for (const tag of tags) {
    if (tag.length > TAG_MAX_LENGTH) continue
    const key = tag.toLowerCase()
    if (!byKey.has(key)) byKey.set(key, tag)
  }
  return [...byKey.values()].slice(0, TAG_MAX_COUNT)
}

/**
 * Only bullet markers. `scanTaskCheckboxStates` — the reconciler that keeps a
 * task row following its markdown checkbox — reads `-`, `*` and `+` only, so a
 * `1. [ ]` line rewritten with a `{task:}` suffix would carry an id nothing
 * ever reconciles. Ordered items still nest the items below them.
 */
const BULLET_MARKERS = new Set(['-', '*', '+'])

const LIST_ITEM = /^([ \t]*)([-*+]|\d+[.)]) +(.*)$/
const CHECKBOX = /^\[([ xX])\](?: +(.*))?$/

/** One tab indents as far as four spaces, which is how CommonMark reads it. */
function indentWidth(indent: string): number {
  let width = 0
  for (const char of indent) width += char === '\t' ? 4 : 1
  return width
}

/**
 * An enclosing list item, for resolving what a nested checkbox hangs under.
 * `planIndex` is null when the item is not a convertible checkbox — a plain
 * bullet, or a checkbox this module declined — because a task can only be a
 * subtask of a task that exists.
 */
interface OpenListItem {
  width: number
  planIndex: number | null
}

export function planChecklistTasks(markdown: string, now: Date): PlannedChecklistTask[] {
  const planned: PlannedChecklistTask[] = []
  const fence = createFenceTracker()
  const open: OpenListItem[] = []

  const lines = markdown.split('\n')
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]

    // A checkbox quoted inside a code fence is documentation, not a task.
    if (fence.consume(line)) continue

    const item = line.match(LIST_ITEM)
    if (!item) {
      // A blank line does not close a list (a loose list is still one list).
      // Any other non-list line closes every item it is not indented under.
      if (line.trim() === '') continue
      const width = indentWidth(line.match(/^[ \t]*/)?.[0] ?? '')
      while (open.length > 0 && open[open.length - 1].width >= width) open.pop()
      continue
    }

    const [, indent, listMarker, rest] = item
    const width = indentWidth(indent)
    while (open.length > 0 && open[open.length - 1].width >= width) open.pop()
    const enclosing = open.length > 0 ? open[open.length - 1] : null

    const planIndex = planChecklistLine({
      lineIndex,
      indent,
      listMarker,
      rest,
      enclosing,
      planned,
      now
    })
    open.push({ width, planIndex })
  }

  return planned
}

interface ChecklistLineInput {
  lineIndex: number
  indent: string
  listMarker: string
  rest: string
  enclosing: OpenListItem | null
  planned: PlannedChecklistTask[]
  now: Date
}

/** Appends the line's task to `planned` and returns its index, or null. */
function planChecklistLine(input: ChecklistLineInput): number | null {
  if (!BULLET_MARKERS.has(input.listMarker)) return null

  const checkbox = input.rest.match(CHECKBOX)
  if (!checkbox) return null

  const text = (checkbox[2] ?? '').trim()
  if (text === '') return null
  if (parseTaskBlockSuffix(text) !== null) return null
  if (obsidianTaskImportBlocker(text) !== null) return null

  const obsidian = buildObsidianTaskImport(text, input.now)
  const title = (obsidian?.title ?? text).trim()
  if (title === '' || title.length > TITLE_MAX_LENGTH) return null

  // 1-level subtask depth, as the editor resolves it: the enclosing item must
  // be a converted checkbox that is itself top-level. Deeper checkboxes become
  // standalone tasks, which is what the analyzer's `passAsParent` rule does.
  const parent = input.enclosing?.planIndex ?? null
  const parentIndex = parent !== null && input.planned[parent].parentIndex === null ? parent : null

  input.planned.push({
    lineIndex: input.lineIndex,
    indent: input.indent,
    listMarker: input.listMarker,
    checked: checkbox[1] !== ' ',
    title,
    tags: tagsForCreate(obsidian?.tags ?? []),
    parentIndex,
    obsidian
  })
  return input.planned.length - 1
}
