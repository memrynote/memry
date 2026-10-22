/**
 * Where a block is shown: the popover behind the usage chip. One row per host
 * note; a row opens that note.
 *
 * @module note/content-area/portal-flows/portal-where-used-popover
 */

import type { ReactElement, RefObject } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useT } from '@memry/i18n/renderer'
import type { PortalHost } from './portal-api'

interface PortalWhereUsedPopoverProps {
  /** The chip the popover hangs from. */
  anchorEl: HTMLElement | null
  hosts: readonly PortalHost[]
  onOpenHost: (host: PortalHost) => void
  onClose: () => void
}

function HostSubtext({ host }: { host: PortalHost }): ReactElement {
  const { t } = useT('notes')
  return (
    <>
      {host.hiddenCount > 0
        ? t('portalFlows.whereUsed.rowHidden', { count: host.count, hidden: host.hiddenCount })
        : t('portalFlows.whereUsed.rowWhole', { count: host.count })}
    </>
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

  return (
    <Popover open={anchorEl !== null} onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[360px] gap-0.5 rounded-xl p-2 shadow-[var(--shadow-dropdown)]"
        data-testid="portal-where-used"
      >
        <div className="px-2.5 py-2 text-sm font-semibold leading-[18px] text-foreground">
          {t('portalFlows.whereUsed.title', { count: hosts.length })}
        </div>
        <ul className="flex flex-col gap-0.5">
          {hosts.map((host) => (
            <li key={host.noteId}>
              <button
                type="button"
                className="flex w-full flex-col rounded-md px-2.5 py-2 text-start outline-none hover:bg-surface-active focus-visible:bg-surface-active"
                onClick={() => onOpenHost(host)}
              >
                <span className="truncate text-sm font-medium leading-[18px] text-foreground">
                  {host.title}
                </span>
                <span className="text-xs leading-4 text-text-tertiary">
                  <HostSubtext host={host} />
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="px-2.5 py-2.5 text-xs leading-4 text-text-secondary">
          {t('portalFlows.whereUsed.footer')}
        </div>
      </PopoverContent>
    </Popover>
  )
}
