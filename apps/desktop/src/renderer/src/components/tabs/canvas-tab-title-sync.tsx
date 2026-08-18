/**
 * Keeps an open canvas tab's title on the canvas's real name.
 *
 * A tab's title is a SNAPSHOT taken when the tab opens (`handleCanvasOpen` in
 * `app-sidebar`), so a rename anywhere else leaves the tab reading the old name
 * until it is closed and reopened.
 *
 * It lives here, above the tab tree, rather than in the canvas page: only the
 * ACTIVE tab is mounted, so a page-level listener would never hear the rename
 * of a canvas sitting in a background tab — which is the case being fixed.
 *
 * Event-driven, where `AgentTabTitleSync` diffs tab state against a list it
 * already has: agent conversations live in a context in memory, canvas
 * summaries do not, so the diffing shape would mean holding a second copy of
 * the canvas list at App level and keeping it fresh.
 *
 * One subscription covers every way a canvas can be renamed, because they all
 * end at the same broadcast: the sidebar, an agent write, a pull from another
 * device (`sync/item-handlers/canvas-handler`), and vault reconcile.
 *
 * @module components/tabs/canvas-tab-title-sync
 */

import * as React from 'react'

import { useTabActions } from '@/contexts/tabs'
import { onCanvasUpdated } from '@/services/canvas-service'
import { useT } from '@memry/i18n/renderer'

export function CanvasTabTitleSync(): null {
  const { updateTabTitleByEntityId } = useTabActions()
  const { t } = useT('common')

  React.useEffect(() => {
    // `canvas:updated` carries every SAVE, not just renames — a scene autosave
    // fires it too. Nothing is filtered here: `updateTabTitleByEntityId` drops
    // a retitle to the name a tab already carries, which is where that guard
    // belongs, since a background canvas can be saved by sync just as often.
    return onCanvasUpdated((event) => {
      const canvas = event?.canvas
      if (!canvas?.id) return
      // The fallback `openTab` uses, so a title cleared by a remote write reads
      // as "Untitled canvas" rather than leaving the tab blank.
      updateTabTitleByEntityId(canvas.id, canvas.title || t('canvas.untitled'))
    })
  }, [t, updateTabTitleByEntityId])

  return null
}

export default CanvasTabTitleSync
