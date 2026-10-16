import type { CommandMeta } from './types'

/** Window and updater commands that exist for the native menu. */
export const APP_COMMANDS = {
  'app.checkForUpdates': {
    context: 'app',
    owner: 'window',
    group: 'help',
    i18nKey: 'app.checkForUpdates',
    menu: true
  },
  'app.closeWindow': {
    context: 'app',
    owner: 'window',
    group: 'app',
    i18nKey: 'file.close',
    menu: true
  }
} as const satisfies Record<string, CommandMeta>
