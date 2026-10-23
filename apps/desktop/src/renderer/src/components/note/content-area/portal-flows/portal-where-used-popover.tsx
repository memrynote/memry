/**
 * Where a block is used: the popover behind the usage chip. One row per note,
 * an icon saying portal or link, the note's folder in muted text. The rows
 * split into "Portals" and "Links" sections only when both kinds are present.
 * Enter opens the note, Shift+Enter (or Shift+click, or the split button that
 * shows on hover and focus) opens it beside the current one, and the arrow keys
 * move between rows.
 *
 * @module note/content-area/portal-flows/portal-where-used-popover
 */

import { useEffect, useRef, type KeyboardEvent, type ReactElement, type RefObject } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Columns2, Layers, Link } from '@/lib/icons'
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

/** `Notes 101/02 Lists.md` -> `Notes 101`. Empty for a note at the vault root. */
function folderOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? '' : path.slice(0, at)
}

function Row({
  host,
  onOpen
}: {
  host: PortalHost
  onOpen: PortalWhereUsedPopoverProps['onOpenHost']
}): ReactElement {
  const { t } = useT('notes')
  const Icon = isLink(host) ? Link : Layers
  const folder = folderOf(host.path)
  const openBeside = t('portalFlows.whereUsed.openBeside')
  return (
    <li className="group relative">
      <button
        type="button"
        data-where-used-row=""
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-start outline-none hover:bg-surface-active focus-visible:bg-surface-active"
        onClick={(event) => {
          onOpen(host, { beside: event.shiftKey })
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || !event.shiftKey) return
          event.preventDefault()
          onOpen(host, { beside: true })
        }}
      >
        <Icon className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground">
          {host.title}
        </span>
        {folder ? (
          <span className="max-w-[40%] shrink-0 truncate text-xs leading-4 text-text-tertiary transition-opacity group-focus-within:opacity-0 group-hover:opacity-0">
            {folder}
          </span>
        ) : null}
      </button>
      {/* The shortcut is Shift+Enter or Shift+click; the button is for whoever does not know it. */}
      <button
        type="button"
        data-where-used-beside=""
        aria-label={openBeside}
        title={openBeside}
        className="absolute end-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-text-secondary opacity-0 outline-none transition-opacity hover:bg-surface hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-foreground/60 group-focus-within:opacity-100 group-hover:opacity-100"
        onClick={() => {
          onOpen(host, { beside: true })
        }}
      >
        <Columns2 className="size-4" aria-hidden="true" />
      </button>
    </li>
  )
}

function Section({
  label,
  hosts,
  onOpen
}: {
  /** Null when the popover holds one kind only: the icon already says it. */
  label: string | null
  hosts: readonly PortalHost[]
  onOpen: PortalWhereUsedPopoverProps['onOpenHost']
}): ReactElement | null {
  if (hosts.length === 0) return null
  return (
    <section className="flex flex-col" aria-label={label ?? undefined}>
      {label ? (
        <h3 className="px-2 pt-1.5 pb-0.5 text-xs leading-4 text-text-secondary">{label}</h3>
      ) : null}
      <ul className="flex flex-col">
        {hosts.map((host) => (
          <Row key={`${host.kind ?? 'portal'}:${host.noteId}`} host={host} onOpen={onOpen} />
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
    const frame = requestAnimationFrame(() => {
      // oxlint-disable-next-line react/exhaustive-effect-dependencies -- listed deps are intentional re-run triggers that the body does not read
      rows()[0]?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
    }
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
        className="w-[320px] gap-0 rounded-xl p-1.5 shadow-[var(--shadow-dropdown)]"
        data-testid="portal-where-used"
        aria-label={t('portalFlows.whereUsed.aria')}
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
        }}
      >
        <Section
          label={links.length > 0 ? t('portalFlows.whereUsed.portals') : null}
          hosts={portals}
          onOpen={onOpenHost}
        />
        <Section
          label={portals.length > 0 ? t('portalFlows.whereUsed.links') : null}
          hosts={links}
          onOpen={onOpenHost}
        />
      </PopoverContent>
    </Popover>
  )
}
