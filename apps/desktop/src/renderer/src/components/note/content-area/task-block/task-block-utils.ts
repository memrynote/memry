import type {
  Task as DisplayTask,
  Priority,
  RepeatConfig as DisplayRepeatConfig
} from '@/data/task-model'
import type { Task as ServiceTask, TaskUpdateInput } from '@/services/tasks-service'
import type { Project } from '@/data/tasks-data'
import { formatDateKey, parseDueDate } from '@/lib/task-utils'
import { parseQuickAdd } from '@/lib/quick-add-parser'
import { toServiceRepeatConfig } from '@/features/tasks/use-task-queries'

// Pure task-block markdown helpers live in @memry/shared so the main-process
// CRDT seed/writeback can reuse the exact same logic. Re-exported here so the
// renderer's existing import sites stay unchanged.
export {
  serializeTaskBlock,
  parseTaskBlockSuffix,
  extractInlineText,
  normalizeTaskBlocks
} from '@memry/shared/task-block'
export type { TaskBlockProps } from '@memry/shared/task-block'

export const DB_PRIORITY_MAP: Record<number, Priority> = {
  0: 'none',
  1: 'low',
  2: 'medium',
  3: 'high',
  4: 'urgent'
}

export const PRIORITY_REVERSE: Record<string, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4
}

export interface TaskShorthandEdit {
  /** The typed text with every recognised marker lifted off. May be empty. */
  title: string
  /** Only the fields the markers actually named. Empty when there were none. */
  update: Omit<TaskUpdateInput, 'id'>
  hasMarkers: boolean
}

/**
 * Read quick-add markers off an inline task title so the journal speaks the
 * same shorthand the Tasks page does (#2241). `[[Title]]` is left in the text:
 * the block has no note list loaded to resolve it against, and silently
 * deleting a link the user typed is worse than not linking it.
 *
 * Tags merge rather than replace — the input only ever carries the tags being
 * added, never the ones the task already has.
 */
export function parseTaskShorthand(
  input: string,
  projects: Project[],
  existingTags: string[] = []
): TaskShorthandEdit {
  const parsed = parseQuickAdd(input, projects, { keepNoteLinks: true })
  const update: Omit<TaskUpdateInput, 'id'> = {}

  if (parsed.priority !== 'none') update.priority = PRIORITY_REVERSE[parsed.priority] ?? 0
  if (parsed.dueDate) {
    update.dueDate = formatDateKey(parsed.dueDate)
    if (parsed.dueTime) update.dueTime = parsed.dueTime
  }
  if (parsed.projectId) update.projectId = parsed.projectId
  if (parsed.repeat) {
    update.isRepeating = true
    update.repeatConfig = toServiceRepeatConfig(parsed.repeat)
  }

  const seen = new Set(existingTags.map((tag) => tag.toLowerCase()))
  const addedTags = parsed.tags.filter((tag) => !seen.has(tag.toLowerCase()))
  if (addedTags.length > 0) update.tags = [...existingTags, ...addedTags]

  return {
    title: parsed.title,
    update,
    hasMarkers: Object.keys(update).length > 0 || parsed.title !== input.trim()
  }
}

export function serviceTaskToDisplayTask(task: ServiceTask, fallbackStatusId: string): DisplayTask {
  let repeatConfig: DisplayRepeatConfig | null = null
  if (task.repeatConfig) {
    const rc = task.repeatConfig
    repeatConfig = {
      ...rc,
      endDate: rc.endDate ? new Date(rc.endDate) : null,
      createdAt: new Date(rc.createdAt)
    }
  }

  return {
    id: task.id,
    title: task.title,
    description: task.description ?? '',
    projectId: task.projectId,
    statusId: task.statusId ?? fallbackStatusId,
    priority: DB_PRIORITY_MAP[task.priority] ?? 'none',
    dueDate: task.dueDate ? parseDueDate(task.dueDate) : null,
    dueTime: task.dueTime ?? null,
    isRepeating: task.repeatConfig !== null,
    repeatConfig,
    linkedNoteIds: task.linkedNoteIds ?? [],
    sourceNoteId: task.sourceNoteId,
    tags: task.tags ?? [],
    parentId: task.parentId,
    subtaskIds: [],
    createdAt: new Date(task.createdAt),
    completedAt: task.completedAt ? new Date(task.completedAt) : null,
    archivedAt: task.archivedAt ? new Date(task.archivedAt) : null
  }
}

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
