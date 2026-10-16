import type { CommandMeta } from './types'

/** Acts on the folder or tag view in the active tab. The tag commands need a tag scope. */
export const FOLDER_COMMANDS = {
  'folder.newNote': {
    context: 'folder',
    owner: 'folder',
    group: 'folder',
    i18nKey: 'commands.folderNewNote'
  },
  'folder.search': {
    context: 'folder',
    owner: 'folder',
    group: 'folder',
    i18nKey: 'commands.folderSearch'
  },
  'folder.renameTag': {
    context: 'folder',
    owner: 'folder',
    group: 'folder',
    i18nKey: 'commands.folderRenameTag'
  },
  'folder.deleteTag': {
    context: 'folder',
    owner: 'folder',
    group: 'folder',
    i18nKey: 'commands.folderDeleteTag',
    destructive: true
  }
} as const satisfies Record<string, CommandMeta>
