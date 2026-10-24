/**
 * Closes tabs whose entity has been deleted.
 *
 * Mounted once in App.tsx, for the reason `useFolderViewEvents` is: the tab
 * that has to close may be the unmounted one in the other pane, and the row the
 * user deleted from lives in a sidebar that can be collapsed away. A listener
 * inside the canvas tree — or inside the canvas page — would only ever see the
 * deletes that happened while it was on screen.
 *
 * It listens to the EVENT rather than hooking the delete call site, so one
 * subscription covers a delete from this window, from a second window, and one
 * arriving from another device through sync (`main/sync/item-handlers/
 * canvas-handler.ts` emits the same channel).
 *
 * Notes are deliberately NOT here. A deleted note keeps its tab and strikes the
 * title through (`pages/note.tsx`, `SET_TAB_DELETED`): the note's text is still
 * on screen, which is worth keeping. A canvas tab holds a live Excalidraw
 * editor over a tombstoned row, so leaving it open only buys failing autosaves.
 */

import { useEffect } from 'react'
import { onCanvasDeleted } from '@/services/canvas-service'
import { useTabActions } from '@/contexts/tabs'

export function useCloseTabsOnEntityDelete(): void {
  const { closeTabsByEntityId } = useTabActions()

  useEffect(() => {
    return onCanvasDeleted((event) => closeTabsByEntityId(event.id))
  }, [closeTabsByEntityId])
}
