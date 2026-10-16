import type { CommandMeta } from './types'

/** Acts on the Tasks page in the active tab. Bulk commands need a selection. */
export const TASKS_COMMANDS = {
  'tasks.newTask': {
    context: 'tasks',
    owner: 'tasks',
    group: 'tasks',
    i18nKey: 'commands.tasksNewTask'
  },
  'tasks.bulkComplete': {
    context: 'tasks',
    owner: 'tasks',
    group: 'tasks',
    i18nKey: 'commands.tasksBulkComplete'
  },
  'tasks.bulkDelete': {
    context: 'tasks',
    owner: 'tasks',
    group: 'tasks',
    i18nKey: 'commands.tasksBulkDelete',
    destructive: true
  }
} as const satisfies Record<string, CommandMeta>
