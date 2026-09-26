import { useCallback, useMemo, type ReactNode } from 'react'
import type { VaultInfo } from '../../../../preload/index.d'
import { useVault, useVaultList } from '@/hooks/use-vault'
import type { VaultSwitchDirection } from '@/lib/vault-switch-state'
import { VaultSwitcher } from '@/components/vault-switcher'
import { VaultPager } from '@/components/sidebar/vault-pager'
import { VaultIndicator } from '@/components/sidebar/vault-indicator'

export interface SidebarVaultPages {
  /** Switchable vaults in stored order. A folder that is not reachable cannot open, so it is not a page. */
  vaults: VaultInfo[]
  activePath: string | null
  /** The open vault's list entry; null until the list has loaded. */
  activeVault: VaultInfo | null
  activeName: string
  switchTo: (vault: VaultInfo, direction: VaultSwitchDirection) => Promise<boolean>
}

/** The vault pages the sidebar swipes between, and the switch they perform. */
export function useSidebarVaultPages(): SidebarVaultPages {
  const { status, switchVault } = useVault()
  const { vaults: knownVaults } = useVaultList()
  const activePath = status?.path ?? null

  const vaults = useMemo(
    () => knownVaults.filter((vault) => !vault.isMissing || vault.path === activePath),
    [knownVaults, activePath]
  )
  const activeVault = vaults.find((vault) => vault.path === activePath) ?? null

  const switchTo = useCallback(
    async (vault: VaultInfo, direction: VaultSwitchDirection) => {
      const result = await switchVault(vault.path, {
        name: vault.name,
        accentColor: vault.accentColor,
        direction
      })
      return result.success
    },
    [switchVault]
  )

  return {
    vaults,
    activePath,
    activeVault,
    activeName: activeVault?.name ?? activePath?.split(/[\\/]/).pop() ?? '',
    switchTo
  }
}

/** The sidebar list, paged between vaults once a vault is open. */
export function SidebarVaultPager({
  pages,
  children
}: {
  pages: SidebarVaultPages
  children: ReactNode
}) {
  if (!pages.activePath) return <>{children}</>
  return (
    <VaultPager
      vaults={pages.vaults}
      activePath={pages.activePath}
      activeName={pages.activeName}
      onSwitch={pages.switchTo}
    >
      {children}
    </VaultPager>
  )
}

/**
 * The footer's vault control: the dot indicator once the vault list has
 * loaded, the plain switcher before that so ⌘⇧O always has a target.
 */
export function SidebarVaultIndicator({ pages }: { pages: SidebarVaultPages }) {
  if (!pages.activeVault) {
    return (
      <div className="flex-1 min-w-0">
        <VaultSwitcher />
      </div>
    )
  }
  return <VaultIndicator vaults={pages.vaults} activePath={pages.activeVault.path} />
}
