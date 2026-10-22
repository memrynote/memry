/**
 * Where a block is used: the popover behind the usage chip. Two sections,
 * "Portals" and "Links", one row per note. Enter opens the note, Shift+Enter
 * (or Shift+click) opens it beside the current one, and the arrow keys move
 * between rows.
 *
 * @module note/content-area/portal-flows/portal-where-used-popover
 */

import { useEffect, useRef, type KeyboardEvent, type ReactElement, type RefObject } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useT } from '@memry/i18n/renderer'
import type { PortalHost } from './portal-api'

export interface WhereUsedOpenOptions {
  /** Open in a split next to the current pane. */
  beside: boolean
}

interface PortalWhereUsedPopoverProps {
  /** The chip the popover hangs from. */
  anchorEl: HTMLElement | null
  hosts: readonly PortalHost[]
  onOpenHost: (host: PortalHost, options: WhereUsedOpenOptions) => void
  onClose: () => void
}

/** A host from an older main process carries no kind and is a portal. */
const isLink = (host: PortalHost): boolean => host.kind === 'link'

function Section({
  label,
  hosts,
  onOpen
}: {
  label: string
  hosts: readonly PortalHost[]
  onOpen: PortalWhereUsedPopoverProps['onOpenHost']
}): ReactElement | null {
  if (hosts.length === 0) return null
  return (
    <section className="flex flex-col gap-0.5" aria-label={label}>
      <h3 className="flex items-center justify-between px-2.5 pt-2 pb-1 text-[11px] font-semibold leading-4 text-text-tertiary">
        <span>{label}</span>
        <span>{hosts.length}</span>
      </h3>
      <ul className="flex flex-col gap-0.5">
        {hosts.map((host) => (
          <li key={`${host.kind ?? 'portal'}:${host.noteId}`}>
            <button
              type="button"
              data-where-used-row=""
              className="flex w-full flex-col rounded-md px-2.5 py-2 text-start outline-none hover:bg-surface-active focus-visible:bg-surface-active"
              onClick={(event) => onOpen(host, { beside: event.shiftKey })}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || !event.shiftKey) return
                event.preventDefault()
                onOpen(host, { beside: true })
              }}
            >
              <span className="truncate text-sm font-medium leading-[18px] text-foreground">
                {host.title}
              </span>
              <span className="truncate text-xs leading-4 text-text-tertiary">{host.path}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function PortalWhereUsedPopover({
  anchorEl,
  hosts,
  onOpenHost,
  onClose
}: PortalWhereUsedPopoverProps): ReactElement {
  const { t } = useT('notes')
  const anchorRef = { current: anchorEl } as RefObject<HTMLElement>
  const contentRef = useRef<HTMLDivElement>(null)
  const portals = hosts.filter((host) => !isLink(host))
  const links = hosts.filter(isLink)

  const rows = (): HTMLElement[] =>
    Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[data-where-used-row]') ?? [])

  // Open on the first row: the chip is a mouse-or-keyboard target and the
  // popover is only useful once a row can take Enter.
  useEffect(() => {
    if (anchorEl === null) return
    const frame = requestAnimationFrame(() => rows()[0]?.focus())
    return () => cancelAnimationFrame(frame)
  }, [anchorEl, hosts])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const all = rows()
    if (all.length === 0) return
    event.preventDefault()
    const at = all.indexOf(document.activeElement as HTMLElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    all[(at + step + all.length) % all.length]?.focus()
  }

  return (
    <Popover open={anchorEl !== null} onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        ref={contentRef}
        align="start"
        sideOffset={6}
        className="w-[360px] gap-0.5 rounded-xl p-2 shadow-[var(--shadow-dropdown)]"
        data-testid="portal-where-used"
        aria-label={t('portalFlows.whereUsed.aria')}
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="px-2.5 py-2 text-sm font-semibold leading-[18px] text-foreground">
          {t('portalFlows.whereUsed.title', { count: hosts.length })}
        </div>
        <Section label={t('portalFlows.whereUsed.portals')} hosts={portals} onOpen={onOpenHost} />
        <Section label={t('portalFlows.whereUsed.links')} hosts={links} onOpen={onOpenHost} />
        <div className="flex items-center justify-between px-2.5 py-2.5 text-xs leading-4 text-text-secondary">
          <span>{t('portalFlows.whereUsed.footer')}</span>
          <span className="text-text-tertiary">{t('portalFlows.whereUsed.hint')}</span>
        </div>
      </PopoverContent>
    </Popover>
  )
}
