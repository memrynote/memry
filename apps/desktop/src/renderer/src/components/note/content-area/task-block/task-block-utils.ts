import type { Block } from '@blocknote/core'

const ACTION_VERBS = new Set([
  'add',
  'announce',
  'approve',
  'arrange',
  'ask',
  'assign',
  'backup',
  'book',
  'build',
  'buy',
  'call',
  'cancel',
  'check',
  'clean',
  'clear',
  'close',
  'configure',
  'confirm',
  'connect',
  'copy',
  'create',
  'debug',
  'deploy',
  'design',
  'discuss',
  'do',
  'download',
  'draft',
  'drop',
  'edit',
  'email',
  'export',
  'file',
  'fill',
  'find',
  'finish',
  'fix',
  'flush',
  'follow',
  'get',
  'go',
  'implement',
  'import',
  'install',
  'investigate',
  'link',
  'look',
  'make',
  'meet',
  'merge',
  'migrate',
  'move',
  'notify',
  'open',
  'order',
  'organize',
  'pack',
  'patch',
  'pay',
  'pick',
  'pin',
  'plan',
  'post',
  'prepare',
  'print',
  'publish',
  'push',
  'read',
  'refactor',
  'release',
  'remind',
  'remove',
  'renew',
  'replace',
  'research',
  'resolve',
  'respond',
  'restore',
  'return',
  'review',
  'run',
  'scan',
  'schedule',
  'send',
  'set',
  'share',
  'ship',
  'sign',
  'sort',
  'start',
  'stop',
  'submit',
  'swap',
  'sync',
  'tag',
  'talk',
  'test',
  'try',
  'update',
  'upgrade',
  'upload',
  'validate',
  'verify',
  'watch',
  'write'
])

export function isLikelyTask(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 3 || trimmed.length > 200) return false
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase()
  return ACTION_VERBS.has(firstWord)
}

const TASK_BLOCK_SUFFIX_REGEX = /\{task:([^}]+)\}\s*$/

export interface TaskBlockProps {
  taskId: string
  title: string
  checked: boolean
}

export function serializeTaskBlock(props: TaskBlockProps): string {
  const check = props.checked ? 'x' : ' '
  return `- [${check}] ${props.title} {task:${props.taskId}}`
}

export function parseTaskBlockSuffix(text: string): { taskId: string; title: string } | null {
  const match = text.match(TASK_BLOCK_SUFFIX_REGEX)
  if (!match) return null
  return {
    taskId: match[1],
    title: text.replace(TASK_BLOCK_SUFFIX_REGEX, '').trim()
  }
}

function extractInlineText(content: unknown): string {
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

export function normalizeTaskBlocks(blocks: Block[]): { blocks: Block[]; didChange: boolean } {
  const blockStr = JSON.stringify(blocks)
  if (!blockStr.includes('{task:')) {
    return { blocks, didChange: false }
  }

  let didChange = false

  const nextBlocks = blocks.map((block) => {
    if (block.type !== 'checkListItem') return block

    const text = extractInlineText(block.content)
    const parsed = parseTaskBlockSuffix(text)
    if (!parsed) return block

    didChange = true
    return {
      type: 'taskBlock',
      props: {
        taskId: parsed.taskId,
        title: parsed.title,
        checked: (block.props as Record<string, unknown>).isChecked ?? false
      },
      content: undefined,
      children: [],
      id: block.id
    } as unknown as Block
  })

  return { blocks: didChange ? nextBlocks : blocks, didChange }
}
