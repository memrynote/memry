/**
 * NotePlan markdown → Memry markdown, with tasks lifted out.
 *
 * NotePlan's list markers are inverted relative to plain markdown:
 *   `*` is a task, `+` is a checklist, `-` is a plain bullet.
 * Only `*` lines become real Memry task rows. Checklists carry NotePlan's
 * timeblocks and micro-steps (`+ 08:00 - 09:00 Reply to emails`); promoting
 * them would flood the Inbox project, so they survive as plain markdown
 * checkboxes instead.
 *
 * This module stays id-free: every task line ends with a
 * `{np-task:<tempId>}` placeholder, and the orchestrator swaps in the real
 * `{task:<id>}` suffix once the rows exist. Pure — no fs access.
 */

export interface ParsedTask {
  /** Stable within one `convertBody` call: `t0`, `t1`, … */
  tempId: string
  title: string
  state: 'open' | 'done' | 'cancelled'
  /** From a `>YYYY-MM-DD` token in the line. */
  dueDate: string | null
  /** From an `@done(YYYY-MM-DD)` token in the line. */
  completedAt: string | null
  /** Nearest shallower task, by indentation. */
  parentTempId: string | null
}

export interface ConvertedBody {
  markdown: string
  tasks: ParsedTask[]
}

export const TASK_PLACEHOLDER_PREFIX = '{np-task:'

export function taskPlaceholder(tempId: string): string {
  return `${TASK_PLACEHOLDER_PREFIX}${tempId}}`
}

const FENCE_RE = /^\s*(```|~~~)/
/**
 * Marker plus at least one space — so a `---` rule is never a list item.
 * No `$`: the input is always a single line, and anchoring the tail makes
 * ` +(.*)$` backtrack quadratically over a run of spaces.
 */
const LIST_RE = /^([ \t]*)([*+-]) +(.*)/
const STATE_RE = /^\[([ xX>-])\] */
/**
 * The spaces that lead up to a date token come off in `cutToken`, not in the
 * pattern — a leading ` *` on an unanchored regex scans quadratically.
 */
const DUE_RE = />(\d{4}-\d{2}-\d{2})\b/
const DONE_RE = /@done\((\d{4}-\d{2}-\d{2})(?:[ T][^)]*)?\)/

/** Cut a matched token out of `text`, taking the spaces before it with it. */
function cutToken(text: string, match: RegExpExecArray): string {
  let start = match.index
  while (start > 0 && text[start - 1] === ' ') start--
  return text.slice(0, start) + text.slice(match.index + match[0].length)
}

/**
 * Indent depth in levels. NotePlan writes tabs; a file touched by another
 * editor may carry spaces, so four spaces also count as one level.
 */
function indentDepth(indent: string): number {
  let tabs = 0
  let spaces = 0
  for (const ch of indent) {
    if (ch === '\t') tabs++
    else spaces++
  }
  return tabs + Math.floor(spaces / 4)
}

export function convertBody(source: string): ConvertedBody {
  const lines = source.split('\n')
  const out: string[] = []
  const tasks: ParsedTask[] = []
  /** Open tasks by depth, so a nested task can find its parent. */
  const stack: { depth: number; tempId: string }[] = []
  let inFence = false
  let counter = 0

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }

    const list = LIST_RE.exec(line)
    if (!list) {
      out.push(line)
      continue
    }

    const [, indent, marker, rest] = list
    const depth = indentDepth(indent)
    const pad = '  '.repeat(depth)

    // `-` is a plain bullet in NotePlan; re-emit it with normalised indent.
    if (marker === '-') {
      out.push(`${pad}- ${rest}`)
      continue
    }

    const stateMatch = STATE_RE.exec(rest)
    const box = stateMatch?.[1] ?? null
    const body = stateMatch ? rest.slice(stateMatch[0].length) : rest

    // `+` is a checklist: a plain checkbox, never a task row.
    if (marker === '+') {
      const checked = box === 'x' || box === 'X'
      out.push(`${pad}- [${checked ? 'x' : ' '}] ${body}`)
      continue
    }

    // `*` is a task.
    let state: ParsedTask['state'] = 'open'
    if (box === 'x' || box === 'X') state = 'done'
    else if (box === '-') state = 'cancelled'
    // `[>]` is "moved to another day" — still an open task.

    let title = body
    let dueDate: string | null = null
    let completedAt: string | null = null

    const done = DONE_RE.exec(title)
    if (done) {
      completedAt = done[1]
      title = cutToken(title, done)
    }

    const due = DUE_RE.exec(title)
    if (due) {
      dueDate = due[1]
      title = cutToken(title, due)
    }

    title = title.trim()

    // Nearest shallower task is the parent; anything at or below this depth
    // is a sibling or a closed branch.
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop()
    const parentTempId = stack.length > 0 ? stack[stack.length - 1].tempId : null

    const tempId = `t${counter++}`
    stack.push({ depth, tempId })
    tasks.push({ tempId, title, state, dueDate, completedAt, parentTempId })

    const checked = state === 'open' ? ' ' : 'x'
    out.push(`${pad}- [${checked}] ${title} ${taskPlaceholder(tempId)}`)
  }

  return { markdown: out.join('\n'), tasks }
}
