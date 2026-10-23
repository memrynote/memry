import { createPortal } from 'react-dom'
import { useEffect, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { WikiLinkDisplayProps } from '@memry/shared/wiki-link-props'
import { WikiLinkDisplayPanel } from './wiki-link-display-panel'
import { useT } from '@memry/i18n/renderer'

export type WikiLinkMenuAction =
  | 'open'
  | 'openInNewTab'
  | 'openToTheSide'
  | 'edit'
  | 'copy'
  | 'unlink'

/** A right-click on a wiki-link chip, captured when the menu opened. */
export interface WikiLinkMenuTarget {
  x: number
  y: number
  /** Document position of the chip */
  pos: number
  target: string
  alias: string
  /**
   * The link's display settings (#2845), or null when it is not alone in its
   * paragraph and so has none to offer.
   */
  display: WikiLinkDisplayProps | null
}

const NAVIGATION: WikiLinkMenuAction[] = ['open', 'openInNewTab', 'openToTheSide']
const EDITING: WikiLinkMenuAction[] = ['edit', 'copy', 'unlink']

/**
 * The right-click menu of a wiki-link chip, anchored at the click point the
 * same way the editor's own menu is. Edit and Remove are hidden in a read-only
 * editor; Copy stays.
 */
export function WikiLinkContextMenu({
  x,
  y,
  target,
  editable,
  display,
  onAction,
  onDisplayChange,
  onClose
}: {
  x: number
  y: number
  /** The note the link names. */
  target: string
  editable: boolean
  display: WikiLinkDisplayProps | null
  onAction: (action: WikiLinkMenuAction) => void
  onDisplayChange: (patch: Partial<WikiLinkDisplayProps>) => void
  onClose: () => void
}) {
  const { t } = useT('notes')
  const labels: Record<WikiLinkMenuAction, string> = {
    open: t('wikiLinkMenu.open'),
    openInNewTab: t('wikiLinkMenu.openInNewTab'),
    openToTheSide: t('wikiLinkMenu.openToTheSide'),
    edit: t('wikiLinkMenu.edit'),
    copy: t('wikiLinkMenu.copy'),
    unlink: t('wikiLinkMenu.unlink')
  }
  // Opened a microtask after mount so Radix sees closed -> open and moves focus
  // into the menu (same as EditorContextMenu).
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) setOpen(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const editing = editable ? EDITING : EDITING.filter((action) => action === 'copy')
  const item = (action: WikiLinkMenuAction) => (
    <DropdownMenuItem
      key={action}
      data-action={action}
      onSelect={() => {
        onAction(action)
      }}
    >
      {labels[action]}
    </DropdownMenuItem>
  )

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      {/* Portaled: the note canvas carries a transform, which would make
          `position: fixed` relative to it. */}
      {createPortal(
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden="true"
            style={{ position: 'fixed', top: y, left: x, width: 0, height: 0 }}
          />
        </DropdownMenuTrigger>,
        document.body
      )}
      <DropdownMenuContent
        align="start"
        aria-label={t('wikiLinkMenu.aria')}
        data-testid="wiki-link-context-menu"
        className="min-w-48"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
        }}
      >
        {NAVIGATION.map(item)}
        <DropdownMenuSeparator />
        {display && editable && (
          <>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-action="display">
                {t('wikiLinkMenu.displayRow')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="p-0">
                <WikiLinkDisplayPanel
                  target={target}
                  display={display}
                  onChange={onDisplayChange}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
          </>
        )}
        {editing.map(item)}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
