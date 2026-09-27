import { useCallback, useMemo, type ReactNode } from 'react'
import type { VaultInfo } from '../../../../preload/index.d'
import { useVault, useVaultList } from '@/hooks/use-vault'
import type { VaultSwitchDirection } from '@/lib/vault-switch-state'
import { VaultSwitcher } from '@/components/vault-switcher'
import { VaultPager } from '@/components/sidebar/vault-pager'
import { VaultPill } from '@/components/sidebar/vault-pill'
import { ChevronDown, Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

export interface SidebarVaultPages {
  /** Switchable vaults in stored order. A folder that is not reachable cannot open, so it is not a page. */
  vaults: VaultInfo[]
  activePath: string | null
  /** The open vault's list entry; null until the list has loaded. */
  activeVault: VaultInfo | null
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
    <VaultPager vaults={pages.vaults} activePath={pages.activePath} onSwitch={pages.switchTo}>
      {children}
    </VaultPager>
  )
}

/**
 * The panel's vault header: the open vault's name, opening the
 * vault list below it. It is the sidebar's one vault switcher, so ⌘⇧O opens this list. It sits inside the pager, so the
 * name travels with the page and a swipe shows the incoming vault's name.
 */
export function SidebarVaultHeader({ pages }: { pages: SidebarVaultPages }) {
  const { t } = useT('common')

  return (
    <div className="min-w-0 flex-1 [&_[data-slot=sidebar-menu]]:w-full">
      <VaultSwitcher
        placement={{ side: 'bottom', align: 'start' }}
        renderTrigger={({ isLoading, name }) => {
          const label = pages.activeVault?.name ?? name
          return (
            <button
              type="button"
              data-testid="sidebar-vault-header"
              aria-label={t('sidebar.vaultMenu', { name: label })}
              className={cn(
                'flex h-8 w-fit max-w-full min-w-0 items-center gap-2 rounded-[7px] ps-2.5 pe-2 text-start outline-none',
                'hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent',
                'focus-visible:ring-2 focus-visible:ring-sidebar-primary'
              )}
            >
              {isLoading && <Loader2 aria-hidden="true" className="size-3 shrink-0 animate-spin" />}
              <span className="min-w-0 truncate text-[13px] font-semibold text-sidebar-primary">
                {label}
              </span>
              <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-sidebar-foreground" />
            </button>
          )
        }}
      />
    </div>
  )
}

/** Page dots at the panel's foot. With a single vault there is nothing to page between. */
export function SidebarVaultDots({ pages }: { pages: SidebarVaultPages }) {
  if (!pages.activeVault || pages.vaults.length < 2) return null
  return <VaultPill vaults={pages.vaults} activePath={pages.activeVault.path} />
}
