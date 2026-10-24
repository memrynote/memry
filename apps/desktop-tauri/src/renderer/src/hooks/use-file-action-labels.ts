/**
 * Labels for the "show this file on disk" / "open it in its default app"
 * actions.
 *
 * The handlers behind those menu items — `shell.showItemInFolder` and
 * `shell.openPath` — have always been cross-platform, but the wording was not:
 * only macOS has a Finder. The labels branch on the running platform so a
 * Windows user reads "Show in Explorer" and a Linux user "Show in file
 * manager", and every menu in the app pulls from this one key set instead of
 * carrying its own copy.
 *
 * @module hooks/use-file-action-labels
 */

import { useT } from '@memry/i18n/renderer'

export type FileManagerPlatform = 'mac' | 'windows' | 'linux'

/**
 * The platform family that decides the reveal wording. Anything that is
 * neither macOS nor Windows is treated as Linux, whose label is generic
 * enough ("file manager") to fit every remaining desktop.
 */
export function getFileManagerPlatform(): FileManagerPlatform {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform
  if (/mac/i.test(platform)) return 'mac'
  if (/win/i.test(platform)) return 'windows'
  return 'linux'
}

const REVEAL_KEYS = {
  mac: 'fileActions.revealInFinder',
  windows: 'fileActions.showInExplorer',
  linux: 'fileActions.showInFileManager'
} as const

export interface FileActionLabels {
  /** Menu label for revealing the file in the OS file manager. */
  revealInFolder: string
  /** Menu label for opening the file in whatever app the OS picks for it. */
  openInDefaultApp: string
}

export function useFileActionLabels(): FileActionLabels {
  const { t } = useT('common')

  return {
    revealInFolder: t(REVEAL_KEYS[getFileManagerPlatform()]),
    openInDefaultApp: t('fileActions.openInDefaultApp')
  }
}
