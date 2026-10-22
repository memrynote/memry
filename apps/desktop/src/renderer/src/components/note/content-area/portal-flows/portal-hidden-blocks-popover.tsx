/**
 * The list behind a portal's "N hidden" chip: every block the window could
 * show, each with an eye to show or hide it. Presentational: the slot that
 * hosts it (`portal-slot-components`) reads the window's blocks and writes the
 * result to the portal's definition.
 *
 * @module note/content-area/portal-flows/portal-hidden-blocks-popover
 */

import type { ReactElement } from 'react'
import { Eye, EyeOff } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

export interface PortalBlockRow {
  /** Stable key for the row: the block's id in the source note. */
  key: string
  text: string
  /** Nesting under the root block, 0 for the root. */
  depth: number
  isRoot: boolean
  hidden: boolean
  /** The eye does nothing: the root, or a block hidden through its parent. */
  disabled: boolean
}

interface PortalHiddenBlocksPanelProps {
  rows: readonly PortalBlockRow[]
  /** Flip one block. Never called for a disabled row. */
  onToggle: (row: PortalBlockRow) => void
  onShowAll: () => void
}

export function PortalHiddenBlocksPanel({
  rows,
  onToggle,
  onShowAll
}: PortalHiddenBlocksPanelProps): ReactElement {
  const { t } = useT('notes')
  const hiddenCount = rows.filter((row) => row.hidden).length

  return (
    <div className="flex flex-col" data-testid="portal-hidden-blocks">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <div className="flex-1 text-[13px] font-semibold leading-4 text-foreground">
          {t('portalFlows.hiddenBlocks.title')}
        </div>
        <button
          type="button"
          className="text-xs font-medium leading-4 text-tint outline-none hover:underline focus-visible:underline disabled:opacity-40 disabled:no-underline"
          disabled={hiddenCount === 0}
          onClick={onShowAll}
        >
          {t('portalFlows.hiddenBlocks.showAll')}
        </button>
      </div>
      <ul className="flex max-h-[320px] flex-col overflow-y-auto">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex min-h-7 items-center gap-1.5 rounded-[5px] pe-1.5"
            style={{ paddingInlineStart: `${2 + row.depth * 14}px` }}
          >
            <button
              type="button"
              className="flex size-6 shrink-0 items-center justify-center rounded-[5px] text-text-secondary outline-none hover:bg-surface-active focus-visible:bg-surface-active disabled:pointer-events-none disabled:opacity-40"
              disabled={row.disabled}
              aria-pressed={!row.hidden}
              aria-label={
                row.hidden
                  ? t('portalFlows.hiddenBlocks.show', { text: row.text })
                  : t('portalFlows.hiddenBlocks.hide', { text: row.text })
              }
              onClick={() => onToggle(row)}
            >
              {row.hidden ? (
                <EyeOff className="size-3.5" aria-hidden />
              ) : (
                <Eye className="size-3.5" aria-hidden />
              )}
            </button>
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[13px] leading-4',
                row.hidden ? 'text-text-tertiary' : 'text-foreground'
              )}
            >
              {row.text}
            </span>
            {row.isRoot ? (
              <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium leading-4 text-text-secondary">
                {t('portalFlows.hiddenBlocks.root')}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
