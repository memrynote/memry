import { useCallback, useMemo, useState, type ReactNode } from 'react'
import type { VaultInfo } from '../../../../preload/index.d'
import { useVault, useVaultList } from '@/hooks/use-vault'
import type { VaultSwitchDirection, VaultSwitchSource } from '@/lib/vault-switch-state'
import { VaultSwitcher } from '@/components/vault-switcher'
import { VaultPager } from '@/components/sidebar/vault-pager'
import { VaultPill } from '@/components/sidebar/vault-pill'
import { VaultGlyph } from '@/components/sidebar/vault-glyph'
import { VaultIconPicker } from '@/components/sidebar/vault-icon-picker'
import { resolveVaultAccent } from '@/components/sidebar/vault-title-row'
import { ChevronDown, Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

export interface SidebarVaultPages {
  /** Switchable vaults in stored order. A folder that is not reachable cannot open, so it is not a page. */
  vaults: VaultInfo[]
  activePath: string | null
  /** The open vault's list entry; null until the list has loaded. */
  activeVault: VaultInfo | null
  switchTo: (
    vault: VaultInfo,
    direction: VaultSwitchDirection,
    source: VaultSwitchSource
  ) => Promise<boolean>
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
    async (vault: VaultInfo, direction: VaultSwitchDirection, source: VaultSwitchSource) => {
      const result = await switchVault(vault.path, {
        name: vault.name,
        accentColor: vault.accentColor,
        icon: vault.icon,
        direction,
        source
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
  paused = false,
  children
}: {
  pages: SidebarVaultPages
  /** See `VaultPager`'s `paused`. */
  paused?: boolean
  children: ReactNode
}) {
  if (!pages.activePath) return <>{children}</>
  return (
    <VaultPager
      vaults={pages.vaults}
      activePath={pages.activePath}
      onSwitch={pages.switchTo}
      paused={paused}
    >
      {children}
    </VaultPager>
  )
}

/**
 * The panel's vault header: the open vault's icon, then its name opening the
 * vault list below it. The icon is its own button and opens the icon picker;
 * the name is the sidebar's one vault switcher, so ⌘⇧O opens this list. It
 * sits inside the pager, so icon and name travel with the page and a swipe
 * shows the incoming vault's.
 */
export function SidebarVaultHeader({ pages }: { pages: SidebarVaultPages }) {
  const { t } = useT('common')
  const [pickerOpen, setPickerOpen] = useState(false)
  const active = pages.activeVault

  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5 [&_[data-slot=sidebar-menu]]:w-full [&_[data-slot=sidebar-menu]]:min-w-0">
      {active && (
        <VaultIconPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          vaultPath={active.path}
          hasIcon={!!active.icon}
          side="bottom"
        >
          <button
            type="button"
            data-testid="sidebar-vault-icon"
            aria-label={t('vaultSwipe.iconButton', { name: active.name })}
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
            className={cn(
              'flex size-7 shrink-0 items-center justify-center rounded-[7px] outline-none',
              'hover:bg-sidebar-accent aria-expanded:bg-sidebar-accent',
              'focus-visible:ring-2 focus-visible:ring-sidebar-primary'
            )}
          >
            <VaultGlyph icon={active.icon} color={resolveVaultAccent(active.accentColor)} />
          </button>
        </VaultIconPicker>
      )}
      <VaultSwitcher
        placement={{ side: 'bottom', align: 'start' }}
        renderTrigger={({ isLoading, name }) => {
          const label = active?.name ?? name
          return (
            <button
              type="button"
              data-testid="sidebar-vault-header"
              aria-label={t('sidebar.vaultMenu', { name: label })}
              className={cn(
                'flex h-8 w-fit max-w-full min-w-0 items-center gap-2 rounded-[7px] pe-2 text-start outline-none',
                active ? 'ps-1.5' : 'ps-2.5',
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

/** Page icons at the panel's foot. With a single vault there is nothing to page between. */
export function SidebarVaultDots({ pages }: { pages: SidebarVaultPages }) {
  if (!pages.activeVault || pages.vaults.length < 2) return null
  return <VaultPill vaults={pages.vaults} activePath={pages.activeVault.path} />
}
