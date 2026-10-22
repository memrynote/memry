/**
 * The popovers the portal block's header opens: the hidden-blocks list and the
 * search portal's query editor. The block renders its own trigger buttons and
 * wraps each in the component registered for its slot (`portal/portal-slots`);
 * these wrap the trigger in a popover. Registered once per window, reference
 * counted, because every editor with the flows mounted asks for them.
 *
 * @module note/content-area/portal-flows/portal-slot-components
 */

import { useEffect, useState, type ReactElement } from 'react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useT } from '@memry/i18n/renderer'
import { updatePortalDefinition } from '../portal/portal-definition'
import { readPortalWindowBlocks, togglePortalBlockHidden } from '../portal/portal-hidden-blocks'
import {
  registerPortalActionHandlers,
  registerPortalHiddenBlocksSlot,
  registerPortalSearchQuerySlot,
  type PortalHandle,
  type PortalHiddenBlocksSlotProps,
  type PortalSearchQuerySlotProps
} from '../portal/portal-slots'
import { portalWindowKey } from '../portal/portal-window-plugin'
import { usePortalWindow } from '../portal/portal-window-registry'
import { getPortalFlowsApi } from './portal-flows-api'
import { PortalHiddenBlocksPanel, type PortalBlockRow } from './portal-hidden-blocks-popover'
import { PortalSearchQueryForm } from './portal-search-query-popover'
import type { PortalSearchTarget } from './portal-search-query'
import { consumeChooseChildren } from './portal-choose-children'

/** The rows for a portal's window: its root first, then the blocks under it. */
function windowRows(portal: PortalHandle, rootText: string | null): PortalBlockRow[] {
  const spec = {
    anchor: portal.definition.target.kind === 'block' ? portal.definition.target.block : null,
    hidden: portal.definition.hidden
  }
  const blocks = readPortalWindowBlocks(portal.blockId, spec) ?? []
  const underRoot = spec.anchor === null ? 0 : 1
  const rows: PortalBlockRow[] = []
  if (spec.anchor !== null && rootText !== null) {
    rows.push({
      key: 'root',
      text: rootText,
      depth: 0,
      isRoot: true,
      hidden: false,
      disabled: true
    })
  }
  for (const block of blocks) {
    rows.push({
      key: block.id,
      text: block.text,
      depth: block.depth + underRoot,
      isRoot: false,
      hidden: block.hidden || block.hiddenByAncestor,
      disabled: block.hiddenByAncestor && !block.hidden
    })
  }
  return rows
}

function HiddenBlocksSlot({ portal, children }: PortalHiddenBlocksSlotProps): ReactElement {
  const { t } = useT('notes')
  const [open, setOpen] = useState(false)
  // Re-renders when the window mounts or its view changes.
  const entry = usePortalWindow(portal.blockId)

  // A block portal picked with Tab opens its list as soon as its chrome exists.
  useEffect(() => {
    // eslint-disable-next-line react-you-might-not-need-an-effect/no-adjust-state-on-prop-change -- a one-shot hand-off from the picker, not state derived from props
    if (consumeChooseChildren(portal.blockId)) setOpen(true)
  }, [portal.blockId])

  const view = entry?.view
  const rootText = view ? (portalWindowKey.getState(view.state)?.rootText ?? null) : null
  const rows = open ? windowRows(portal, rootText) : []
  const sourceNoteId = portal.sourceNoteId

  const toggle = (row: PortalBlockRow): void => {
    const block = readPortalWindowBlocks(portal.blockId, {
      anchor: portal.definition.target.kind === 'block' ? portal.definition.target.block : null,
      hidden: portal.definition.hidden
    })?.find((each) => each.id === row.key)
    if (!block || !sourceNoteId) return
    void togglePortalBlockHidden({
      editor: portal.editor,
      portalBlockId: portal.blockId,
      sourceNoteId,
      block
    }).then((done) => {
      if (!done) toast.error(t('portalFlows.hiddenBlocks.toggleFailed'))
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[340px] rounded-md p-1 shadow-[var(--shadow-card-hover)]"
      >
        <PortalHiddenBlocksPanel
          rows={rows}
          onToggle={toggle}
          onShowAll={() => updatePortalDefinition(portal.editor, portal.blockId, { hidden: [] })}
        />
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
