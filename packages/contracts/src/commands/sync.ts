import type { CommandMeta } from './types'

export const SYNC_COMMANDS = {
  'sync.syncNow': {
    context: 'app',
    owner: 'sync',
    group: 'sync',
    i18nKey: 'commands.syncNow'
  },
  'sync.pause': {
    context: 'app',
    owner: 'sync',
    group: 'sync',
    i18nKey: 'commands.syncPause'
  },
  'sync.resume': {
    context: 'app',
    owner: 'sync',
    group: 'sync',
    i18nKey: 'commands.syncResume'
  }
} as const satisfies Record<string, CommandMeta>
