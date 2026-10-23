import { useAppCommands, type CommandSource } from '@/commands'
import { requestVaultPage } from '@/lib/vault-switch-state'
import { requestVaultSwitcherOpen } from '@/lib/vault-switcher-open'

/**
 * The owner of the vault commands: `nav.switchVault` opens the sidebar's
 * vault list, and `nav.nextVault` / `nav.prevVault` page between vaults through
 * the pager, so a shortcut plays the same transition as a swipe.
 *
 * `paused` (Settings is open and the sidebar shows its nav) disables paging
 * only. The switcher opens from anywhere, as ⌘⇧O always has.
 */
export function useVaultPagerCommands(paused: boolean): void {
  // The arrows are spatial: in RTL the next vault sits to the left. A menu item
  // or button asks for the next vault in list order, whatever the direction.
  const pageBy = (step: 1 | -1, source: CommandSource): void => {
    const rtl = source === 'keyboard' && document.documentElement.dir === 'rtl'
    requestVaultPage({ step: rtl ? (step === 1 ? -1 : 1) : step })
  }

  useAppCommands('vaultPager', {
    'nav.switchVault': {
      run: () => requestVaultSwitcherOpen()
    },
    'nav.nextVault': {
      enabled: !paused,
      run: ({ source }) => pageBy(1, source)
    },
    'nav.prevVault': {
      enabled: !paused,
      run: ({ source }) => pageBy(-1, source)
    }
  })
}
