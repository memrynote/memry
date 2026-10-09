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

import { createFenceTracker } from './markdown-fences.ts'
import { parseObsidianTaskFields } from './obsidian-tasks.ts'

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
 * How many task levels a note body holds under a top-level task: the note's
 * markdown and its block tree (the Y.Doc every device syncs). Compat contract:
 * builds released before nested subtasks parse and write back only one level,
 * and misplace or drop lines below it (#2877). A deeper task stays deep in the
 * DB (`parentId`), which owns the hierarchy; the note lists it flat under its
 * top-level ancestor. Lift this only together with the client version floor
 * that retires those builds.
 */
export const MAX_NOTE_TASK_DEPTH = 1

/**
 * A top-level task block with every task block below `MAX_NOTE_TASK_DEPTH`
 * lifted to that depth, in document order, each `parentTaskId` naming its new
 * tree parent. Only the tree changes; the DB parents stay where they are.
 * Returns `block` itself when nothing sits too deep.
 */
export function capTaskTreeDepth<T extends TaskNormalizableBlock>(block: T): T {
  const tooDeep = (children: TaskNormalizableBlock[] | undefined, depth: number): boolean =>
    (children ?? []).some(
      (child) =>
        child.type === 'taskBlock' &&
        (depth > MAX_NOTE_TASK_DEPTH || tooDeep(child.children, depth + 1))
    )
  if (!tooDeep(block.children, 1)) return block

  const reparent = (children: T[], parentTaskId: string): T[] =>
    children.map((child) =>
      child.type === 'taskBlock' ? { ...child, props: { ...child.props, parentTaskId } } : child
    )
  // The node, then the task blocks lifted out from under it to its own level.
  const cap = (node: T, depth: number): T[] => {
    const kept: T[] = []
    const lifted: T[] = []
    for (const child of (node.children ?? []) as T[]) {
      if (child.type !== 'taskBlock') {
        kept.push(child)
        continue
      }
      const [self, ...below] = cap(child, depth + 1)
      if (depth < MAX_NOTE_TASK_DEPTH) kept.push(self, ...below)
      else lifted.push(self, ...below)
    }
    const parentTaskId = node.props?.taskId as string
    const own = depth < MAX_NOTE_TASK_DEPTH ? reparent(kept, parentTaskId) : kept
    return [{ ...node, children: own }, ...lifted]
  }
  return cap(block, 0)[0]
}

/**
 * A task block and the task blocks under it, one tight-list line each, capped
 * at `MAX_NOTE_TASK_DEPTH`. With the cap at one level the output is
 * byte-identical to what builds before nested subtasks wrote.
 */
export function serializeTaskBlockTree(block: TaskNormalizableBlock): string[] {
  // SAFETY: a `taskBlock`'s props are `TaskBlockProps`; callers pass only those.
  const lines = [serializeTaskBlock(block.props as unknown as TaskBlockProps)]
  const walk = (children: TaskNormalizableBlock[], depth: number): void => {
    for (const child of children) {
      if (child.type !== 'taskBlock') continue
      const props = child.props as unknown as TaskBlockProps
      lines.push('  '.repeat(depth) + serializeTaskBlock({ ...props, parentTaskId: '' }))
      walk(child.children ?? [], depth + 1)
    }
  }
  walk(capTaskTreeDepth(block).children ?? [], 1)
  return lines
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

/**
 * Each task line's title as written in `markdown`, by task id, in document
 * order. A task block keeps its line as a plain `title` string, and by the
 * time a checkbox reaches `normalizeTaskBlocks` the parser has already turned
 * `**Dune** [[Dune (2021)]]` into styled and linked nodes. Only the source
 * still holds the bytes that write the line back unchanged.
 */
function scanTaskLineTitles(markdown: string): Map<string, string[]> {
  const titles = new Map<string, string[]>()
  const fence = createFenceTracker()
  for (const line of markdown.split('\n')) {
    if (fence.consume(line)) continue
    const checkbox = checkboxTextStart(line)
    if (!checkbox) continue
    const parsed = parseTaskBlockSuffix(line.slice(checkbox.start))
    if (!parsed) continue
    const queue = titles.get(parsed.taskId)
    if (queue) queue.push(parsed.title)
    else titles.set(parsed.taskId, [parsed.title])
  }
  return titles
}

/**
 * Each task line's nesting depth among the task lines above it, by indent.
 * The first line for an id wins.
 */
function scanTaskLineDepths(markdown: string): Map<string, number> {
  const depths = new Map<string, number>()
  const fence = createFenceTracker()
  const open: number[] = []
  for (const line of markdown.split('\n')) {
    if (fence.consume(line) || line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    while (open.length > 0 && open[open.length - 1] >= indent) open.pop()
    const checkbox = checkboxTextStart(line)
    const parsed = checkbox ? parseTaskBlockSuffix(line.slice(checkbox.start)) : null
    if (!parsed) {
      if (indent === 0) open.length = 0
      continue
    }
    if (!depths.has(parsed.taskId)) depths.set(parsed.taskId, open.length)
    open.push(indent)
  }
  return depths
}

/**
 * BlockNote's markdown parser strips a task item's sub-lines inconsistently:
 * by one column below the content column, by the whole column at or past it.
 * A third-level `- [ ]` line two spaces deeper per level then lands under the
 * wrong parent. The parse keeps line order, so the tree is rebuilt from that
 * order and each line's source depth. A tree holding anything but task blocks,
 * or a task the source scan missed, is left as parsed.
 */
function renestTaskTree<T extends TaskNormalizableBlock>(root: T, depths: Map<string, number>): T {
  const rootId = root.props?.taskId as string
  const rootDepth = depths.get(rootId)
  if (rootDepth === undefined) return root
  const flat: T[] = []
  const collect = (children: TaskNormalizableBlock[] | undefined): boolean =>
    (children ?? []).every((child) => {
      if (child.type !== 'taskBlock' || !depths.has(child.props?.taskId as string)) return false
      flat.push(child as T)
      return collect(child.children)
    })
  if (!collect(root.children)) return root

  type Node = { block: T; depth: number; children: Node[] }
  const top: Node = { block: root, depth: rootDepth, children: [] }
  const stack = [top]
  for (const block of flat) {
    const depth = depths.get(block.props?.taskId as string)!
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop()
    if (stack[stack.length - 1].depth >= depth) return root
    const node: Node = { block, depth, children: [] }
    stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  const build = (node: Node, parentTaskId: string): T => ({
    ...node.block,
    props: { ...node.block.props, parentTaskId },
    children: node.children.map((child) => build(child, node.block.props?.taskId as string))
  })
  return build(top, (root.props?.parentTaskId as string) ?? '')
}

function words(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * Take the first queued source title that can be this block's line, or null.
 *
 * The scan is broader than the parser: a copy of the line in an HTML comment,
 * an indented code block or a deeply indented fence is queued too, and when it
 * comes first it would lend the real task its text. So a source title counts
 * only when the block's own plain-text words appear in it, in order. Not an
 * equality check: the plain text drops whatever the parser made a non-text
 * node (links, wiki links, mentions), so it is a subsequence of the line's
 * words, never the same list, and a stricter match would fall back to the
 * flattened title this exists to avoid.
 */
function takeSourceTitle(queue: string[] | undefined, plainTitle: string): string | null {
  if (!queue) return null
  const wanted = words(plainTitle)
  const index = queue.findIndex((candidate) => {
    let next = 0
    for (const word of words(candidate)) {
      if (word === wanted[next]) next++
    }
    return next === wanted.length
  })
  return index === -1 ? null : queue.splice(index, 1)[0]
}

/**
 * `source` is the markdown `blocks` were parsed from, or null for blocks that
 * did not come from markdown. Without it a title keeps only its plain text.
 */
export function normalizeTaskBlocks<T extends TaskNormalizableBlock>(
  blocks: T[],
  source: string | null
): { blocks: T[]; didChange: boolean } {
  const blockStr = JSON.stringify(blocks)
  if (!blockStr.includes('{task:')) {
    return { blocks, didChange: false }
  }

  const sourceTitles = source === null ? null : scanTaskLineTitles(source)
  const sourceDepths = source === null ? null : scanTaskLineDepths(source)
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
      const title = takeSourceTitle(sourceTitles?.get(parsed.taskId), parsed.title) ?? parsed.title

      const processedChildren = block.children?.length
        ? processBlocks(block.children as T[], parsed.taskId)
        : []

      // BlockNote's checkListItem exposes its state as `checked`; older callers
      // (and some tests) pass `isChecked`. Honour both so a `- [x]` round-trips.
      const checked = block.props?.checked ?? block.props?.isChecked ?? false

      const taskBlock = {
        type: 'taskBlock',
        props: {
          taskId: parsed.taskId,
          title,
          checked,
          parentTaskId
        },
        content: undefined,
        children: processedChildren,
        id: block.id
      } as unknown as T
      if (parentTaskId !== '') return taskBlock
      return capTaskTreeDepth(sourceDepths ? renestTaskTree(taskBlock, sourceDepths) : taskBlock)
    })
  }

  const nextBlocks = processBlocks(blocks, '')
  return { blocks: didChange ? nextBlocks : blocks, didChange }
}
