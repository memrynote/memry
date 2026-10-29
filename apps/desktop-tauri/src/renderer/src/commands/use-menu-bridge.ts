import { useEffect } from 'react'
import { isCommandId } from '@memry/contracts/commands'
import { createLogger } from '@/lib/logger'
import { windowApi } from '@/services/window-service'
import { runCommand } from './run-command'

const log = createLogger('MenuBridge')

/**
 * Runs the command a native menu item names. Main sends the id of the item's
 * `COMMANDS` entry, and an owner supplies the behavior, so a menu click and a
 * keystroke reach the same code. An id this build does not know is logged, not run.
 */
export function useMenuBridge(): void {
  useEffect(
    () =>
      windowApi.onMenuCommand(({ command }) => {
        if (!isCommandId(command)) {
          log.warn('Ignored unknown menu command', { command })
          return
        }
        void runCommand(command, 'menu')
      }),
    []
  )
}
