/**
 * Hand-off between the note editor's own context menu and the native one.
 *
 * The native editable-text menu (menu.ts) is the only place spelling
 * suggestions exist: Chromium hands them to main in the `context-menu` event,
 * never to the page. When the note editor wants to show its own menu it claims
 * the next event synchronously from its DOM `contextmenu` handler, before
 * Chromium sends that event, and main forwards the spelling data to the
 * renderer instead of popping the native menu. Every other editable surface
 * makes no claim and keeps the native menu.
 */

/** A claim older than this belongs to a menu that never opened. */
const CLAIM_TTL_MS = 1_000

const claims = new Map<number, number>()

export function claimEditorContextMenu(webContentsId: number, now = Date.now()): void {
  claims.set(webContentsId, now)
}

/** True (and the claim is spent) when the editor claimed this window's next menu. */
export function takeEditorContextMenuClaim(webContentsId: number, now = Date.now()): boolean {
  const claimedAt = claims.get(webContentsId)
  claims.delete(webContentsId)
  return claimedAt !== undefined && now - claimedAt <= CLAIM_TTL_MS
}
