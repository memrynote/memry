/**
 * Pure task-block helpers shared between the renderer (BlockNote editor) and
 * the main process (CRDT seed + writeback). Kept dependency-free: blocks are
 * typed structurally so neither side has to pull in `@blocknote/core` here.
 *
 * A task is stored in markdown as a checkbox with a trailing `{task:<id>}`
 * suffix, e.g. `- [ ] Buy milk {task:abc}`. `normalizeTaskBlocks` upgrades such
 * `checkListItem` blocks into the custom `taskBlock` type; `serializeTaskBlock`
 * renders a `taskBlock` back to that markdown line.
 *
 * The one thing that may follow the suffix is Obsidian Tasks plugin syntax,
 * which that plugin appends when a user edits an imported task back in
 * Obsidian. See `parseTaskBlockSuffix`.
 */

import { parseObsidianTaskFields } from './obsidian-tasks'

const TASK_BLOCK_SUFFIX_OPEN = '{task:'

export interface TaskBlockProps {
  taskId: string
  title: string
  checked: boolean
  parentTaskId?: string
}

/**
 * Minimal structural shape both BlockNote `Block` (renderer + server editor)
 * and hand-built block trees satisfy. All fields optional so callers can pass
 * their richer block type unchanged.
 */
export interface TaskNormalizableBlock {
  id?: string
  type?: string
  props?: Record<string, unknown>
  content?: unknown
  children?: TaskNormalizableBlock[]
}

export function serializeTaskBlock(props: TaskBlockProps): string {
  const check = props.checked ? 'x' : ' '
  const indent = props.parentTaskId ? '  ' : ''
  return `${indent}- [${check}] ${props.title} {task:${props.taskId}}`
}

/**
 * Where `{task:` opens and its `}` closes, as indexes into right-trimmed text.
 * The id between them may be empty; it never contains `}`.
 */
interface TaskSuffixSpan {
  open: number
  close: number
}

// Parsed by hand rather than with a regex: a greedy-class-plus-end-anchor regex
// (`\{task:([^}]+)\}$`) backtracks quadratically on adversarial note content
// with many `{task:` starts — flagged as polynomial ReDoS on uncontrolled
// input. String ops keep it linear.
function locateTaskSuffix(trimmed: string): TaskSuffixSpan | null {
  if (trimmed.endsWith('}')) {
    const open = trimmed.lastIndexOf(TASK_BLOCK_SUFFIX_OPEN)
    if (open === -1) return null
    const close = trimmed.length - 1
    if (trimmed.slice(open, close).includes('}')) return null
    return { open, close }
  }

  // Memry and the Obsidian Tasks plugin both want the end of the line. When a
  // user completes or edits an imported task back in Obsidian, the plugin
  // appends its own field after this suffix, and a strict end-anchored read
  // would stop recognising the id Memry itself wrote: the block would regress
  // to a bare checkbox and the next open would mint a duplicate task. So a
  // suffix is still ours when everything behind it is plugin syntax, and only
  // then. Ordinary trailing prose still means this is not a task line.
  const open = trimmed.lastIndexOf(TASK_BLOCK_SUFFIX_OPEN)
  if (open === -1) return null
  const close = trimmed.indexOf('}', open)
  if (close === -1) return null
  if (parseObsidianTaskFields(trimmed.slice(close + 1)).description !== '') return null
  return { open, close }
}

export function parseTaskBlockSuffix(text: string): { taskId: string; title: string } | null {
  const trimmed = text.trimEnd()
  const span = locateTaskSuffix(trimmed)
  if (!span) return null
  const taskId = trimmed.slice(span.open + TASK_BLOCK_SUFFIX_OPEN.length, span.close)
  if (taskId.length === 0) return null
  return { taskId, title: trimmed.slice(0, span.open).trim() }
}

/**
 * Index where a checkbox line's text starts, or null for any other line. The
 * one definition of a task line's shape, shared by the scan and the strip so
 * the two can never disagree about what counts as one.
 *
 * Deliberately tolerant of what other editors emit: any list marker (`-`, `*`,
 * `+`), any indentation, and an upper- or lower-case `x`.
 */
function checkboxTextStart(line: string): { checked: boolean; start: number } | null {
  const trimmed = line.trimStart()
  if (trimmed.length < 5) return null
  const marker = trimmed[0]
  if (marker !== '-' && marker !== '*' && marker !== '+') return null
  if (trimmed[1] !== ' ' || trimmed[2] !== '[' || trimmed[4] !== ']') return null

  const box = trimmed[3]
  const checked = box === 'x' || box === 'X'
  if (!checked && box !== ' ') return null
  return { checked, start: line.length - trimmed.length + 5 }
}

// Markdown is the source of truth for a task's checkbox state: editing
// `- [ ] … {task:id}` into `- [x] … {task:id}` in any external editor means the
// task is done, and vice versa. Scans a note body for those lines so the
// ingest paths (vault watcher, indexer) can reconcile the DB rows to match.
export function scanTaskCheckboxStates(markdown: string): Map<string, boolean> {
  const states = new Map<string, boolean>()
  if (!markdown.includes(TASK_BLOCK_SUFFIX_OPEN)) return states

  for (const line of markdown.split('\n')) {
    const checkbox = checkboxTextStart(line)
    if (!checkbox) continue

    const parsed = parseTaskBlockSuffix(line.slice(checkbox.start))
    if (!parsed) continue
    states.set(parsed.taskId, checkbox.checked)
  }

  return states
}

// A template is a snapshot, so it must not carry a task's identity: a
// `{task:<id>}` kept in a template put the SAME task into every note made from
// it, and deleting that task anywhere left a dead row in all the others. This
// turns every task line back into the plain checkbox it was typed as, so each
// note converts it into a task of its own. The empty `{task:}` a task block
// that never got an id writes goes too. Every other byte survives, including an
// Obsidian Tasks tail and CRLF line ends.
export function stripTaskBlockSuffixes(markdown: string): string {
  if (!markdown.includes(TASK_BLOCK_SUFFIX_OPEN)) return markdown

  return markdown
    .split('\n')
    .map((line) => {
      const checkbox = checkboxTextStart(line)
      if (!checkbox) return line

      const text = line.slice(checkbox.start)
      const trimmed = text.trimEnd()
      const span = locateTaskSuffix(trimmed)
      if (!span) return line

      return (
        line.slice(0, checkbox.start) +
        trimmed.slice(0, span.open).trimEnd() +
        trimmed.slice(span.close + 1) +
        text.slice(trimmed.length)
      )
    })
    .join('\n')
}

export function extractInlineText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((item: unknown) => {
      if (typeof item === 'string') return item
      if (
        item &&
        typeof item === 'object' &&
        'type' in item &&
        (item as Record<string, unknown>).type === 'text'
      ) {
        return ((item as Record<string, unknown>).text as string) || ''
      }
      return ''
    })
    .join('')
}

export function normalizeTaskBlocks<T extends TaskNormalizableBlock>(
  blocks: T[]
): { blocks: T[]; didChange: boolean } {
  const blockStr = JSON.stringify(blocks)
  if (!blockStr.includes('{task:')) {
    return { blocks, didChange: false }
  }

  let didChange = false

  function processBlocks(blockList: T[], parentTaskId: string): T[] {
    return blockList.map((block) => {
      if ((block.type as string) === 'taskBlock' && block.children?.length) {
        const taskId = (block.props as Record<string, unknown>).taskId as string
        const processedChildren = processBlocks(block.children as T[], taskId)
        if (processedChildren !== block.children) {
          didChange = true
          return { ...block, children: processedChildren } as T
        }
        return block
      }

      if (block.type !== 'checkListItem') return block

      const text = extractInlineText(block.content)
      const parsed = parseTaskBlockSuffix(text)
      if (!parsed) return block

      didChange = true

      const processedChildren = block.children?.length
        ? processBlocks(block.children as T[], parsed.taskId)
        : []

      // BlockNote's checkListItem exposes its state as `checked`; older callers
      // (and some tests) pass `isChecked`. Honour both so a `- [x]` round-trips.
      const checked = block.props?.checked ?? block.props?.isChecked ?? false

      return {
        type: 'taskBlock',
        props: {
          taskId: parsed.taskId,
          title: parsed.title,
          checked,
          parentTaskId
        },
        content: undefined,
        children: processedChildren,
        id: block.id
      } as unknown as T
    })
  }

  const nextBlocks = processBlocks(blocks, '')
  return { blocks: didChange ? nextBlocks : blocks, didChange }
}
