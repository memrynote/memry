import { forwardRef, type ComponentPropsWithoutRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { VaultInfo } from '../../../../preload/index.d'
import { VaultSwitcher } from '@/components/vault-switcher'
import { resolveVaultAccent } from '@/components/sidebar/vault-title-row'
import { indicatorWindow } from '@/lib/vault-swipe'
import { requestVaultPage, useVaultSwipeProgress } from '@/lib/vault-switch-state'
import { cn } from '@/lib/utils'

const DOT_PX = 6
const PILL_PX = 18
const EDGE_DOT_PX = 4
/** The incoming dot takes its colour over the first quarter of travel. */
const COLOR_RAMP = 0.25
const INACTIVE = 'var(--sidebar-dot-inactive)'

function mix(color: string, percent: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)))
  if (clamped >= 100) return color
  if (clamped <= 0) return INACTIVE
  return `color-mix(in srgb, ${color} ${clamped}%, ${INACTIVE})`
}

interface VaultIndicatorProps {
  /** Switchable vaults in the user's order, including the open one. */
  vaults: VaultInfo[]
  activePath: string
}

/**
 * Footer indicator: one dot per vault, the open one a tinted pill. Widths and
 * colours follow the live swipe progress. Dots switch on click; the pill opens
 * the full vault list, which is also how vaults outside the five-slot window
 * are reached without swiping through each one.
 */
export function VaultIndicator({ vaults, activePath }: VaultIndicatorProps) {
  const { t } = useT('common')
  const { targetPath, progress } = useVaultSwipeProgress()
  const activeIndex = vaults.findIndex((vault) => vault.path === activePath)
  const { start, end, moreBefore, moreAfter } = indicatorWindow(vaults.length, activeIndex)

  return (
    <div
      role="group"
      aria-label={t('vaultSwipe.indicatorLabel')}
      className="flex min-w-0 flex-1 items-center justify-center"
    >
      {vaults.slice(start, end).map((vault, offset) => {
        const index = start + offset
        const isActive = index === activeIndex
        const isTarget = vault.path === targetPath
        const isEdge = (index === start && moreBefore) || (index === end - 1 && moreAfter)
        const restWidth = isEdge ? EDGE_DOT_PX : DOT_PX

        if (isActive) {
          const width = PILL_PX - (PILL_PX - DOT_PX) * progress
          const position = t('vaultSwipe.position', {
            name: vault.name,
            index: index + 1,
            count: vaults.length
          })
          return (
            <VaultSwitcher
              key={vault.path}
              renderTrigger={() => (
                <IndicatorPill
                  aria-label={t('vaultSwipe.openList', { position })}
                  title={vault.name}
                  width={width}
                  color={mix('var(--tint)', (1 - progress) * 100)}
                />
              )}
            />
          )
        }

        const width = isTarget ? restWidth + (PILL_PX - restWidth) * progress : restWidth
        const color = isTarget
          ? mix(resolveVaultAccent(vault.accentColor), (progress / COLOR_RAMP) * 100)
          : INACTIVE
        return (
          <button
            key={vault.path}
            type="button"
            onClick={() => requestVaultPage({ path: vault.path })}
            aria-label={t('vaultSwipe.switchTo', { name: vault.name })}
            title={vault.name}
            className={cn(
              'flex h-7 items-center justify-center rounded-[5px] px-[3px] outline-none',
              'focus-visible:ring-1 focus-visible:ring-sidebar-foreground',
              'group/dot'
            )}
          >
            <span
              aria-hidden="true"
              className="block h-1.5 rounded-full transition-[width,background-color] duration-150 group-hover/dot:brightness-90 motion-reduce:transition-none"
              style={{
                width,
                height: isEdge && !isTarget ? EDGE_DOT_PX : DOT_PX,
                backgroundColor: color
              }}
            />
          </button>
        )
      })}
    </div>
  )
}

interface IndicatorPillProps extends ComponentPropsWithoutRef<'button'> {
  width: number
  color: string
}

/** The open vault's pill. Forwards ref and props so it can be the picker trigger. */
const IndicatorPill = forwardRef<HTMLButtonElement, IndicatorPillProps>(function IndicatorPill(
  { width, color, className, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'flex h-7 items-center justify-center rounded-[5px] px-[3px] outline-none',
        'focus-visible:ring-1 focus-visible:ring-sidebar-foreground',
        className
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className="block h-1.5 rounded-full transition-[width,background-color] duration-150 motion-reduce:transition-none"
        style={{ width, backgroundColor: color }}
      />
    </button>
  )
})
