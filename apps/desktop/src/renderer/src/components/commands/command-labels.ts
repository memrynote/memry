import { COMMANDS, type CommandId } from '@memry/contracts/commands'
import { useT } from '@memry/i18n/renderer'

/**
 * The name a user sees for a command. A command with a key names its row in
 * Settings → Shortcuts; every other command names a key in the menu namespace.
 * An owner's own label (Unpin Tab) wins, because it knows the state.
 */
export function useCommandLabel(): (id: CommandId, ownerLabel?: string) => string {
  const { t: tSettings } = useT('settings')
  const { t: tMenu } = useT('menu')

  return (id, ownerLabel) => {
    if (ownerLabel !== undefined) return ownerLabel
    const meta = COMMANDS[id]
    return 'keyboard' in meta
      ? tSettings(`shortcuts.entries.${meta.i18nKey}.label`)
      : tMenu(meta.i18nKey)
  }
}
