/**
 * The list behind a portal's "N hidden" count (artboard 3): the blocks the
 * portal leaves out, each with the path it sits under. Enter brings the active
 * one in; "Show all" (Alt+Shift+A) brings every one. Presentational: the slot
 * that hosts it (`portal-slot-components`) reads the window and writes the
 * result to the portal's definition.
 *
 * @module note/content-area/portal-flows/portal-hidden-blocks-popover
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Search } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

/** A search box shows once the list is longer than this. */
const SEARCH_THRESHOLD = 5

export interface PortalBlockRow {
  /** The block's id in the source note. */
  key: string
  /** Where it sits: `Lecture 1 › DNA`. */
  path: string
  text: string
}

interface PortalHiddenBlocksPanelProps {
  rows: readonly PortalBlockRow[]
  /** Bring one block in. */
  onPick: (row: PortalBlockRow) => void
  onShowAll: () => void
}

export function PortalHiddenBlocksPanel({
  rows,
  onPick,
  onShowAll
}: PortalHiddenBlocksPanelProps): ReactElement {
  const { t } = useT('notes')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  // Without a search box nothing in the panel takes focus, so the keys
  // (arrows, Enter, Alt+Shift+A) would go to the note behind it.
  const panelRef = useRef<HTMLDivElement>(null)
  const searchable = rows.length > SEARCH_THRESHOLD
  useEffect(() => {
    if (!searchable) panelRef.current?.focus()
  }, [searchable])

  const needle = query.trim().toLowerCase()
  const shown = needle
    ? rows.filter((row) => `${row.path} ${row.text}`.toLowerCase().includes(needle))
    : rows
  const activeRow = shown[Math.min(active, shown.length - 1)]

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey && event.shiftKey && event.code === 'KeyA') {
      event.preventDefault()
      onShowAll()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((current) => (current + step + shown.length) % Math.max(shown.length, 1))
    } else if (event.key === 'Enter' && activeRow) {
      event.preventDefault()
      onPick(activeRow)
    }
  }

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="flex flex-col outline-none"
      data-testid="portal-hidden-blocks"
      onKeyDown={onKeyDown}
    >
      {searchable ? (
        <label className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            placeholder={t('portalFlows.hiddenBlocks.search')}
            aria-label={t('portalFlows.hiddenBlocks.search')}
            className="min-w-0 flex-1 bg-transparent text-[13px] leading-4 text-foreground outline-none placeholder:text-text-tertiary"
          />
        </label>
      ) : null}
      <ul
        role="listbox"
        aria-label={t('portalFlows.hiddenBlocks.title')}
        className="flex max-h-[320px] flex-col overflow-y-auto p-1"
      >
        {shown.map((row) => (
          <li
            key={row.key}
            role="option"
            aria-selected={row === activeRow}
            className={cn(
              'flex cursor-default flex-col rounded-[5px] px-2 py-1 text-start',
              row === activeRow && 'bg-surface-active'
            )}
            onMouseMove={() => setActive(shown.indexOf(row))}
            onClick={() => onPick(row)}
          >
            <span className="truncate text-[11px] leading-4 text-text-tertiary">{row.path}</span>
            <span className="truncate text-[13px] leading-4 text-foreground">{row.text}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between border-t border-border px-3 py-2">
        <button
          type="button"
          onClick={onShowAll}
          className="rounded-sm text-xs leading-4 text-text-secondary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {t('portalFlows.hiddenBlocks.showAll')}
        </button>
        <KbdGroup aria-hidden>
          <Kbd>{'\u2325'}</Kbd>
          <Kbd>{'\u21E7'}</Kbd>
          <Kbd>{'A'}</Kbd>
        </KbdGroup>
      </div>
    </div>
  )
}
