import { useT } from '@memry/i18n/renderer'
import type { VaultInfo } from '../../../../preload/index.d'
import { resolveVaultAccent } from '@/components/sidebar/vault-title-row'
import { requestVaultPage, useVaultSwipeProgress } from '@/lib/vault-switch-state'
import { cn } from '@/lib/utils'

interface VaultPillProps {
  /** Switchable vaults in the user's order, including the open one. */
  vaults: VaultInfo[]
  activePath: string
}

/**
 * Page indicator at the foot of the sidebar panel: one dot per vault in its
 * accent colour. The open vault's dot is solid; the rest are dimmed. During a
 * swipe the emphasis follows the live progress from the open dot to the
 * incoming one. It stays put while the pages above it move.
 *
 * Each dot is a button: clicking another vault's dot asks the pager to page
 * to it, so the switch plays the same slide as a swipe.
 */
export function VaultPill({ vaults, activePath }: VaultPillProps) {
  const { t } = useT('common')
  const { targetPath, progress } = useVaultSwipeProgress()
  const hasTarget = !!targetPath && vaults.some((vault) => vault.path === targetPath)
  const travel = hasTarget ? progress : 0

  return (
    <div
      role="group"
      data-testid="vault-pill"
      aria-label={t('vaultSwipe.indicatorLabel')}
      className="flex min-w-0 flex-1 items-center justify-center"
    >
      {vaults.map((vault, index) => {
        const isActive = vault.path === activePath
        let emphasis = 0
        if (isActive) emphasis = 1 - travel
        else if (hasTarget && vault.path === targetPath) emphasis = travel
        return (
          <button
            key={vault.path}
            type="button"
            data-vault-dot-button={vault.path}
            aria-current={isActive ? 'true' : undefined}
            aria-label={
              isActive
                ? t('vaultSwipe.position', {
                    name: vault.name,
                    index: index + 1,
                    count: vaults.length
                  })
                : t('vaultSwipe.switchTo', { name: vault.name })
            }
            title={vault.name}
            onClick={() => {
              if (isActive) return
              requestVaultPage({ path: vault.path })
            }}
            className={cn(
              'group flex size-5 shrink-0 items-center justify-center rounded-full outline-none',
              'focus-visible:ring-2 focus-visible:ring-sidebar-primary',
              isActive ? 'cursor-default' : 'cursor-pointer'
            )}
          >
            <span
              aria-hidden="true"
              data-vault-dot={vault.path}
              className="size-1.5 rounded-full transition-transform group-hover:scale-125"
              style={{
                backgroundColor: resolveVaultAccent(vault.accentColor),
                opacity: 0.35 + 0.65 * emphasis
              }}
            />
          </button>
        )
      })}
    </div>
  )
}
