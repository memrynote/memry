/**
 * The block side menu's portal entries: "Copy as portal", "Hide in this portal" (portal windows only) and the delete
 * that asks first when another note shows the block.
 *
 * @module note/content-area/portal-flows/portal-side-menu-items
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- BlockNote's own default
   drag-handle items type the editor as `<any, any, any>`; this file sits in the
   same menu and shares those call sites. */

import type { ReactElement, ReactNode } from 'react'
import {
  RemoveBlockItem,
  useBlockNoteEditor,
  useComponentsContext,
  useExtensionState
} from '@blocknote/react'
import { SideMenuExtension } from '@blocknote/core/extensions'
import { EyeOff, Layers } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'
import { getPortalFlowsApi } from './portal-flows-api'
import { getHideInPortal } from './portal-hide-in-portal'

interface MenuBlock {
  id: string
  type: string
  content?: unknown
}

/** Blocks whose text can carry the ` ^anchor` a portal addresses them by. */
const NOT_ANCHORABLE = new Set(['codeBlock', 'table', 'mathBlock'])

function useSideMenuBlock(): MenuBlock | undefined {
  const editor = useBlockNoteEditor<any, any, any>()
  return useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block
  }) as MenuBlock | undefined
}

export function PortalToBlockItem(): ReactElement | null {
  const { t } = useT('notes')
  const Components = useComponentsContext()!
  const editor = useBlockNoteEditor<any, any, any>()
  const block = useSideMenuBlock()
  const api = getPortalFlowsApi(editor)

  if (!block || !api || NOT_ANCHORABLE.has(block.type) || !Array.isArray(block.content)) {
    return null
  }

  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      icon={<Layers size={16} />}
      onClick={() => void api.copyPortalToBlock(block.id)}
    >
      {t('portalFlows.menu.copyAsPortal')}
    </Components.Generic.Menu.Item>
  )
}

export function HideInPortalItem(): ReactElement | null {
  const { t } = useT('notes')
  const Components = useComponentsContext()!
  const editor = useBlockNoteEditor<any, any, any>()
  const block = useSideMenuBlock()
  const handler = getHideInPortal(editor)

  if (!block || !handler || !handler.canHide(block.id)) return null

  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      icon={<EyeOff size={16} />}
      onClick={() => handler.hide(block.id)}
    >
      {t('portalFlows.menu.hideInPortal')}
    </Components.Generic.Menu.Item>
  )
}

/**
 * Block delete. Where the editor has the portal flows, a block shown elsewhere
 * is confirmed first; everywhere else this is BlockNote's own remove item.
 */
export function GuardedRemoveBlockItem({ children }: { children: ReactNode }): ReactElement | null {
  const Components = useComponentsContext()!
  const editor = useBlockNoteEditor<any, any, any>()
  const block = useSideMenuBlock()
  const api = getPortalFlowsApi(editor)

  if (!api) return <RemoveBlockItem>{children}</RemoveBlockItem>
  if (!block) return null

  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      onClick={() => {
        const selected = editor.getSelection()?.blocks as MenuBlock[] | undefined
        const targets = selected?.some((each) => each.id === block.id) ? selected : [block]
        void api.requestBlockRemoval(targets.map((each) => each.id))
      }}
    >
      {children}
    </Components.Generic.Menu.Item>
  )
}
