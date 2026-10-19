/**
 * Wires the sticky windows to the rest of main: the edge tab follows the draft
 * list, the vault opening and closing, and the sticky window coming and going.
 * The sticky's shortcut is held only while a vault is open.
 *
 * @module main/stickies/runtime
 */

import { onVaultStatusChanged } from '../vault'
import { applyStickyShortcut } from '../ipc/settings-handlers'
import { setStickyDraftsChangedListener } from './drafts-changed'
import { closeEdgeTabWithLastAppWindow, refreshEdgeTab, setEdgeTabStickyProbe } from './edge-tab'
import { isStickyWindowOpen } from './sticky-window'

export function initStickyRuntime(): void {
  setEdgeTabStickyProbe(isStickyWindowOpen)
  setStickyDraftsChangedListener(refreshEdgeTab)
  closeEdgeTabWithLastAppWindow()
  // The shortcut and the tab both need the vault: drafts and settings live in it.
  onVaultStatusChanged(() => {
    applyStickyShortcut()
    refreshEdgeTab()
  })
}
