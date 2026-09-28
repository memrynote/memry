import { useEffect, useLayoutEffect, useRef, useState, type WheelEvent } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { VaultInfo } from '../../../../preload/index.d'
import { resolveVaultAccent } from '@/components/sidebar/vault-title-row'
import { VaultGlyph } from '@/components/sidebar/vault-glyph'
import { VaultIconPicker, useSetVaultIcon } from '@/components/sidebar/vault-icon-picker'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { requestVaultPage, useVaultSwipeProgress } from '@/lib/vault-switch-state'
import { Smile, X } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface VaultPillProps {
  /** Switchable vaults in the user's order, including the open one. */
  vaults: VaultInfo[]
  activePath: string
}

/** Edge fade while the row is wider than the panel; both edges, so RTL needs nothing. */
const OVERFLOW_MASK =
  'linear-gradient(to right, transparent, black 12px, black calc(100% - 12px), transparent)'

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

/**
 * Page indicator at the foot of the sidebar panel: one icon per vault in its
 * accent colour. The open vault's icon is solid; the rest are dimmed. During a
 * swipe the emphasis follows the live progress from the open icon to the
 * incoming one. It stays put while the pages above it move.
 *
 * A click on another vault's icon asks the pager to page to it, so the switch
 * plays the same slide as a swipe; a click never does anything else. The
 * context menu changes or resets the icon. More vaults than fit scroll
 * sideways, and the open (or incoming) vault is kept in view.
 */
export function VaultPill({ vaults, activePath }: VaultPillProps) {
  const { t } = useT('common')
  const { targetPath, progress } = useVaultSwipeProgress()
  const hasTarget = !!targetPath && vaults.some((vault) => vault.path === targetPath)
  const travel = hasTarget ? progress : 0
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [pickerPath, setPickerPath] = useState<string | null>(null)
  const setIcon = useSetVaultIcon()

  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const measure = (): void => setOverflowing(el.scrollWidth > el.clientWidth + 1)
    measure()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => observer.disconnect()
  }, [vaults.length])

  const focusPath = hasTarget && progress > 0.5 ? targetPath : activePath
  useEffect(() => {
    // eslint-disable-next-line react-you-might-not-need-an-effect/no-pass-ref-to-parent -- scrollerRef is this component's own node
    const button = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-vault-dot-button="${CSS.escape(focusPath)}"]`
    )
    if (typeof button?.scrollIntoView !== 'function') return
    // eslint-disable-next-line react-you-might-not-need-an-effect/no-pass-ref-to-parent -- scrollerRef is this component's own node; nothing crosses a component boundary
    button.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth'
    })
  }, [focusPath])

  // A mouse wheel only scrolls vertically; turn it sideways while the row overflows.
  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    const el = scrollerRef.current
    if (!el || !overflowing || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    const rtl = getComputedStyle(el).direction === 'rtl'
    el.scrollBy({ left: rtl ? -event.deltaY : event.deltaY })
  }

  return (
    <div
      role="group"
      data-testid="vault-pill"
      aria-label={t('vaultSwipe.indicatorLabel')}
      className="min-w-0 flex-1"
    >
      <div
        ref={scrollerRef}
        data-testid="vault-pill-scroller"
        onWheel={onWheel}
        className="scrollbar-none flex overflow-x-auto"
        style={
          overflowing ? { maskImage: OVERFLOW_MASK, WebkitMaskImage: OVERFLOW_MASK } : undefined
        }
      >
        {/* `w-max` + auto margins: centred while it fits, scrollable once it does not. */}
        <div className="mx-auto flex w-max items-center gap-0.5 px-3">
          {vaults.map((vault, index) => {
            const isActive = vault.path === activePath
            let emphasis = 0
            if (isActive) emphasis = 1 - travel
            else if (hasTarget && vault.path === targetPath) emphasis = travel
            return (
              <VaultIconPicker
                key={vault.path}
                open={pickerPath === vault.path}
                onOpenChange={(open) => setPickerPath(open ? vault.path : null)}
                vaultPath={vault.path}
                hasIcon={!!vault.icon}
                side="top"
              >
                <span className="flex">
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <button
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
                          'group flex size-6 shrink-0 items-center justify-center rounded-[6px] outline-none',
                          'focus-visible:ring-2 focus-visible:ring-sidebar-primary',
                          isActive ? 'cursor-default' : 'cursor-pointer'
                        )}
                      >
                        <span
                          data-vault-dot={vault.path}
                          className="flex transition-transform group-hover:scale-110"
                          style={{ opacity: 0.35 + 0.65 * emphasis }}
                        >
                          <VaultGlyph
                            icon={vault.icon}
                            color={resolveVaultAccent(vault.accentColor)}
                          />
                        </span>
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-44">
                      <ContextMenuItem onSelect={() => setPickerPath(vault.path)}>
                        <Smile />
                        {t('vaultSwipe.changeIcon')}
                      </ContextMenuItem>
                      {vault.icon && (
                        <ContextMenuItem onSelect={() => setIcon(vault.path, null)}>
                          <X />
                          {t('vaultSwipe.resetIcon')}
                        </ContextMenuItem>
                      )}
                    </ContextMenuContent>
                  </ContextMenu>
                </span>
              </VaultIconPicker>
            )
          })}
        </div>
      </div>
    </div>
  )
}
