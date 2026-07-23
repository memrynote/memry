import type {
  Task as DisplayTask,
  Priority,
  RepeatConfig as DisplayRepeatConfig
} from '@/data/task-model'
import type { Task as ServiceTask } from '@/services/tasks-service'
import { parseDueDate } from '@/lib/task-utils'

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
