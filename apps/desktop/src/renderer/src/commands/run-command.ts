import { getI18n } from 'react-i18next'
import { toast } from 'sonner'
import type { CommandId } from '@memry/contracts/commands'
import { hintModeActiveRef } from '@/contexts/hint-mode'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { getVaultSwitchState } from '@/lib/vault-switch-state'
import { getCommandImpl } from './store'
import type { CommandOutcome, CommandSource } from './types'

const log = createLogger('Commands')

/**
 * Keystrokes stand down while hint mode owns the keyboard, and while a vault
 * switch is in flight: the leaving workspace stays on screen, and `inert` does
 * not stop window listeners, so its shortcuts would act on a half-open vault.
 * Menu, palette and button invocations are not held back here. Menu IPC is not
 * inert during a switch, so an owner whose command would act on the half-open
 * vault (a new note, a palette, the vault switcher) refuses it itself.
 */
export function isKeyboardBlocked(): boolean {
  return hintModeActiveRef.current || getVaultSwitchState().pending !== null
}

/**
 * The one way anything invokes a command: a key, a menu item, the palette, or a
 * button. It runs synchronously up to `run`'s first await, so a key can be
 * consumed in the same event that triggers it.
 */
export async function runCommand(id: CommandId, source: CommandSource): Promise<CommandOutcome> {
  const impl = getCommandImpl(id)
  if (!impl) return 'unavailable'
  if (source === 'keyboard' && isKeyboardBlocked()) return 'blocked'

  try {
    await impl.run({ source })
    return 'ran'
  } catch (error) {
    log.error('Command failed', { id, source }, error)
    toast.error(
      extractErrorMessage(error, getI18n().getFixedT(null, 'common')('commands.runFailed'))
    )
    return 'failed'
  }
}
