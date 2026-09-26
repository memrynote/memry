import { forwardRef, type ComponentPropsWithoutRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { VaultInfo } from '../../../../preload/index.d'
import { VaultSwitcher } from '@/components/vault-switcher'
import { resolveVaultAccent } from '@/components/sidebar/vault-title-row'
import { useVaultSwipeProgress } from '@/lib/vault-switch-state'
import { cn } from '@/lib/utils'

interface VaultPillProps {
  /** Switchable vaults in the user's order, including the open one. */
  vaults: VaultInfo[]
  activePath: string
}

/**
 * Footer vault control: one dot per vault in its accent colour, opening the
 * vault list. The open vault's dot is solid; the rest are dimmed. During a
 * swipe the emphasis follows the live progress from the open dot to the
 * incoming one. The vault name lives in the accessible name and tooltip.
 */
export function VaultPill({ vaults, activePath }: VaultPillProps) {
  const { t } = useT('common')
  const { targetPath, progress } = useVaultSwipeProgress()
  const activeIndex = vaults.findIndex((vault) => vault.path === activePath)
  const active = vaults[activeIndex]
  const hasTarget = !!targetPath && vaults.some((vault) => vault.path === targetPath)
  const travel = hasTarget ? progress : 0

  const position = t('vaultSwipe.position', {
    name: active?.name ?? '',
    index: activeIndex + 1,
    count: vaults.length
  })

  const dots = vaults.map((vault) => {
    let emphasis = 0
    if (vault.path === activePath) emphasis = 1 - travel
    else if (hasTarget && vault.path === targetPath) emphasis = travel
    return { path: vault.path, color: resolveVaultAccent(vault.accentColor), emphasis }
  })

  return (
    <div className="flex min-w-0 flex-1 justify-center">
      <VaultSwitcher
        renderTrigger={() => (
          <DotsButton
            aria-label={t('vaultSwipe.openList', { position })}
            title={active?.name}
            dots={dots}
          />
        )}
      />
    </div>
  )
}

interface DotsButtonProps extends ComponentPropsWithoutRef<'button'> {
  dots: { path: string; color: string; emphasis: number }[]
}

/** The trigger itself. Forwards ref and props so it can be the picker trigger. */
const DotsButton = forwardRef<HTMLButtonElement, DotsButtonProps>(function DotsButton(
  { dots, className, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      data-testid="vault-pill"
      className={cn(
        'flex h-[26px] max-w-full min-w-0 items-center gap-1.5 rounded-full px-2.5 outline-none',
        'focus-visible:ring-2 focus-visible:ring-[var(--tint-ring)]',
        className
      )}
      {...props}
    >
      {dots.map((dot) => (
        <span
          key={dot.path}
          aria-hidden="true"
          data-vault-dot={dot.path}
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: dot.color, opacity: 0.35 + 0.65 * dot.emphasis }}
        />
      ))}
    </button>
  )
})
