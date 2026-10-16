import type { CommandMeta } from './types'

/** Acts through the sidebar: its folder tree, and the creators that sit beside it. */
export const SIDEBAR_TREE_COMMANDS = {
  'create.folder': {
    context: 'app',
    owner: 'sidebarTree',
    group: 'create',
    i18nKey: 'commands.createFolder'
  },
  'create.canvas': {
    context: 'app',
    owner: 'sidebarTree',
    group: 'create',
    i18nKey: 'commands.createCanvas'
  },
  'create.project': {
    context: 'app',
    owner: 'sidebarTree',
    group: 'create',
    i18nKey: 'commands.createProject'
  },
  'folders.expandAll': {
    context: 'app',
    owner: 'sidebarTree',
    group: 'view',
    i18nKey: 'commands.expandFolders'
  },
  'folders.collapseAll': {
    context: 'app',
    owner: 'sidebarTree',
    group: 'view',
    i18nKey: 'commands.collapseFolders'
  }
} as const satisfies Record<string, CommandMeta>
