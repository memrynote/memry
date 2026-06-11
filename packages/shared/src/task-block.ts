/**
 * Pure task-block helpers shared between the renderer (BlockNote editor) and
 * the main process (CRDT seed + writeback). Kept dependency-free: blocks are
 * typed structurally so neither side has to pull in `@blocknote/core` here.
 *
 * A task is stored in markdown as a checkbox with a trailing `{task:<id>}`
 * suffix, e.g. `- [ ] Buy milk {task:abc}`. `normalizeTaskBlocks` upgrades such
 * `checkListItem` blocks into the custom `taskBlock` type; `serializeTaskBlock`
 * renders a `taskBlock` back to that markdown line.
 */

const TASK_BLOCK_SUFFIX_REGEX = /\{task:([^}]+)\}\s*$/

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

export function parseTaskBlockSuffix(text: string): { taskId: string; title: string } | null {
  const match = text.match(TASK_BLOCK_SUFFIX_REGEX)
  if (!match) return null
  return {
    taskId: match[1],
    title: text.replace(TASK_BLOCK_SUFFIX_REGEX, '').trim()
  }
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
