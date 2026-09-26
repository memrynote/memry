import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { readStoredSidebarLayout } from '@/components/ui/sidebar'
import { VaultTitleRow, resolveVaultAccent } from '@/components/sidebar/vault-title-row'
import { getVaultSwitchFrame, type VaultSwitchTarget } from '@/lib/vault-switch-state'
import { vaultTintStyle } from '@/lib/vault-sidebar-snapshot'

/**
 * Shown while main closes one vault and opens the next. It keeps the shell's
 * footprint (sidebar at its stored width, empty canvas). A switch started by
 * the sidebar pager left a frame of the sidebar with the incoming vault's page
 * in place, and that frame is held still here; other switches draw the incoming
 * vault's name where the sidebar will draw it.
 */
export function VaultSwitchingScreen({ target }: { target: VaultSwitchTarget }) {
  const { t } = useT('common')
  const [layout] = useState(readStoredSidebarLayout)
  const [frame] = useState(getVaultSwitchFrame)
  const accent = resolveVaultAccent(target.accentColor)

  return (
    <div
      className="flex h-screen w-full bg-background"
      role="status"
      aria-live="polite"
      aria-label={t('vaultSwipe.switchingTo', { name: target.name })}
    >
      {layout.open &&
        (frame ? (
          <div
            aria-hidden="true"
            inert
            data-testid="vault-switch-frame"
            className="pointer-events-none flex h-full shrink-0 flex-col overflow-hidden border-e bg-sidebar text-sidebar-foreground"
            style={{ ...vaultTintStyle(accent), width: layout.width }}
            dangerouslySetInnerHTML={{ __html: frame }}
          />
        ) : (
          <div className="flex h-full shrink-0 flex-col bg-sidebar" style={{ width: layout.width }}>
            <div className="drag-region h-9 shrink-0" />
            <VaultTitleRow name={target.name} dotColor={accent} className="pt-2" />
          </div>
        ))}
      <div className="drag-region h-9 flex-1" />
    </div>
  )
}
