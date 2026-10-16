import type { CommandMeta } from './types'

/** Acts on the project shown in the active tab. */
export const PROJECT_COMMANDS = {
  'project.edit': {
    context: 'project',
    owner: 'project',
    group: 'project',
    i18nKey: 'commands.projectEdit'
  },
  'project.archive': {
    context: 'project',
    owner: 'project',
    group: 'project',
    i18nKey: 'commands.projectArchive'
  },
  'project.addTask': {
    context: 'project',
    owner: 'project',
    group: 'project',
    i18nKey: 'commands.projectAddTask'
  },
  'project.addNote': {
    context: 'project',
    owner: 'project',
    group: 'project',
    i18nKey: 'commands.projectAddNote'
  },
  'project.addFile': {
    context: 'project',
    owner: 'project',
    group: 'project',
    i18nKey: 'commands.projectAddFile'
  },
  'project.addEvent': {
    context: 'project',
    owner: 'project',
    group: 'project',
    i18nKey: 'commands.projectAddEvent'
  }
} as const satisfies Record<string, CommandMeta>
