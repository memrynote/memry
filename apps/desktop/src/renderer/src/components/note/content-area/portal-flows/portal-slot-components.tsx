/**
 * The popovers the portal block opens: the hidden-blocks list (from the
 * toolbar's count or an inline "N hidden" row) and the search portal's query
 * editor. The block renders the triggers and mounts the component registered
 * for the slot (`portal/portal-slots`); these hold the popover. Registered once per window, reference
 * counted, because every editor with the flows mounted asks for them.
 *
 * @module note/content-area/portal-flows/portal-slot-components
 */

import { useEffect, useMemo, useState, type ReactElement, type RefObject } from 'react'
import { toast } from 'sonner'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useNote } from '@/hooks/use-notes-query'
import { useT } from '@memry/i18n/renderer'
import { createPortalActions } from '../portal/portal-actions'
import { updatePortalDefinition } from '../portal/portal-definition'
import {
  registerPortalActionHandlers,
  registerPortalHiddenBlocksSlot,
  registerPortalSearchQuerySlot,
  type PortalHandle,
  type PortalHiddenBlocksSlotProps,
  type PortalSearchQuerySlotProps
} from '../portal/portal-slots'
import type { PortalWindowBlock } from '../portal/portal-window-plugin'
import { usePortalWindowState } from '../portal/use-portal-window-view'
import { getPortalFlowsApi } from './portal-flows-api'
import { PortalHiddenBlocksPanel, type PortalBlockRow } from './portal-hidden-blocks-popover'
import { PortalSearchQueryForm } from './portal-search-query-popover'
import type { PortalSearchTarget } from './portal-search-query'

const PATH_SEPARATOR = ' \u203A '

function HiddenBlocksSlot({
  portal,
  scope,
  anchorEl,
  onClose
}: PortalHiddenBlocksSlotProps): ReactElement {
  const { t } = useT('notes')
  const state = usePortalWindowState(portal)
  const { note } = useNote(portal.sourceNoteId)
  const title = note?.title ?? ''

  const hidden: readonly PortalWindowBlock[] = useMemo(() => {
    if (!state || !scope) return []
    return scope.kind === 'siblings'
      ? state.hiddenSiblings
      : (state.hiddenChildren[scope.blockId] ?? [])
  }, [state, scope])

  const rows = useMemo<PortalBlockRow[]>(() => {
    if (!state || !scope) return []
    const parent =
      scope.kind === 'children'
        ? state.visible.find((block) => block.blockId === scope.blockId)
        : undefined
    const trail = scope.kind === 'siblings' ? state.ancestors : parent ? [parent] : []
    const path = [title, ...trail.map((block) => block.text)].filter(Boolean).join(PATH_SEPARATOR)
    return hidden.map((block) => ({ key: block.blockId, path, text: block.text }))
  }, [state, scope, hidden, title])

  // The count drops as blocks come in; the popover goes with the last one.
  const empty = scope !== null && state !== undefined && rows.length === 0
  useEffect(() => {
    if (empty) onClose()
  }, [empty, onClose])

  const actions = useMemo(() => createPortalActions(() => portal), [portal])
  const report = (done: boolean): void => {
    if (!done) toast.error(t('portalFlows.hiddenBlocks.showFailed'))
  }
  const pick = (row: PortalBlockRow): void => void actions.show(row.key).then(report)
  const showAll = (): void => {
    if (!scope) return
    const done =
      scope.kind === 'siblings' ? actions.showAllSiblings() : actions.expandAll(scope.blockId)
    void done.then(report)
    onClose()
  }

  const anchorRef = { current: anchorEl } as RefObject<HTMLElement>
  return (
    <Popover open={scope !== null && anchorEl !== null} onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[340px] rounded-lg p-0 shadow-[var(--shadow-dropdown)]"
      >
        <PortalHiddenBlocksPanel rows={rows} onPick={pick} onShowAll={showAll} />
      </PopoverContent>
    </Popover>
  )
}

function SearchQuerySlot({ portal, children }: PortalSearchQuerySlotProps): ReactElement {
  const [open, setOpen] = useState(false)
  const target = portal.definition.target
  const initial = target.kind === 'search' ? target : undefined

  const submit = (next: PortalSearchTarget): void => {
    updatePortalDefinition(portal.editor, portal.blockId, { target: next })
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[360px] rounded-xl p-2 shadow-[var(--shadow-dropdown)]"
        data-testid="portal-search-query"
      >
        <PortalSearchQueryForm initial={initial} onSubmit={submit} />
      </PopoverContent>
    </Popover>
  )
}

let mounted = 0
let unregister: (() => void) | null = null

/**
 * Plug the popovers into the portal block. Reference counted: every editor
 * that mounts the flows calls it, and the slots stay until the last unmounts.
 */
export function useRegisterPortalSlots(): void {
  useEffect(() => {
    mounted += 1
    if (mounted === 1) {
      const handlers = {
        pickAnotherBlock: (portal: PortalHandle) =>
          getPortalFlowsApi(portal.editor)?.pickAnotherBlock(portal.blockId)
      }
      const offs = [
        registerPortalHiddenBlocksSlot(HiddenBlocksSlot),
        registerPortalSearchQuerySlot(SearchQuerySlot),
        registerPortalActionHandlers(handlers)
      ]
      unregister = () => offs.forEach((off) => off())
    }
    return () => {
      mounted -= 1
      if (mounted === 0) {
        unregister?.()
        unregister = null
      }
    }
  }, [])
}
