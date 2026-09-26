import { useEffect, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Spinner } from '@/components/ui/spinner'
import { useVaultScope } from '@/contexts/vault-scope'
import { useVaultSwitchState, type VaultSwitchTarget } from '@/lib/vault-switch-state'

/**
 * Shown only when a switch takes longer than this, so a quick one never flashes.
 */
export const VAULT_SWITCH_COVER_DELAY_MS = 150

/**
 * Covers the content area of the vault being left while main swaps vaults.
 *
 * The sidebar already shows the incoming vault's page the moment the swipe
 * settles, but the tabs and the open note stay the outgoing vault's until main
 * has opened the next one, which can take a second or two. Without a cover the
 * user reads the old vault's note as belonging to the vault they just picked.
 */
export function VaultSwitchContentCover() {
  const { t } = useT('common')
  const scope = useVaultScope()
  const { pending } = useVaultSwitchState()
  const leavingTo = pending !== null && scope !== null && pending.path !== scope ? pending : null
  // Keyed by the switch itself (each one is a new target object), so every
  // switch waits out its own delay, even back to a vault shown before.
  const [shownFor, setShownFor] = useState<VaultSwitchTarget | null>(null)

  useEffect(() => {
    if (!leavingTo) return
    const timer = setTimeout(() => setShownFor(leavingTo), VAULT_SWITCH_COVER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [leavingTo])

  if (!leavingTo || shownFor !== leavingTo) return null

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="vault-switch-content-cover"
      className="absolute inset-0 z-50 flex items-center justify-center gap-2 bg-background animate-in fade-in duration-150 motion-reduce:animate-none"
    >
      <Spinner
        aria-hidden="true"
        className="size-4 text-muted-foreground motion-reduce:animate-none"
      />
      <span className="text-sm text-muted-foreground">
        {t('vaultSwipe.switchingTo', { name: leavingTo.name })}
      </span>
    </div>
  )
}
