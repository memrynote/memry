import type { CommandMeta } from './types'

/** Acts on the file shown in the active tab. */
export const FILE_COMMANDS = {
  'file.addToProject': {
    context: 'file',
    owner: 'file',
    group: 'file',
    i18nKey: 'commands.fileAddToProject'
  },
  'file.openExternal': {
    context: 'file',
    owner: 'file',
    group: 'file',
    i18nKey: 'commands.fileOpenExternal'
  },
  'file.revealInFinder': {
    context: 'file',
    owner: 'file',
    group: 'file',
    i18nKey: 'commands.fileRevealInFinder'
  }
} as const satisfies Record<string, CommandMeta>
