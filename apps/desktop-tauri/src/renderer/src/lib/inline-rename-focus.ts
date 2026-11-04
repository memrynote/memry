import type { FocusEvent, KeyboardEvent } from 'react'

/**
 * A Radix menu that is animating out is still mounted and still answering
 * pointer events: a pointer leaving an item runs `onItemLeave`, which focuses
 * the menu content again, and a pointer moving over an item focuses the item.
 * When the item just opened an inline rename field, that focus lands a beat
 * after the field did and blurs it — and in the sidebar trees a blur commits
 * and closes the field, so the rename dies before a key is ever pressed.
 *
 * The menus are made pointer-inert while closing (see `ui/context-menu.tsx`),
 * which leaves exactly one boundary event to absorb: the one the browser fires
 * when hit-testing changes. Treat that blur as noise and take focus back.
 *
 * @returns true when the blur came from a menu stealing focus, not the user.
 */
export function isMenuFocusSteal(event: FocusEvent<HTMLElement>): boolean {
  const next = event.relatedTarget
  if (!(next instanceof HTMLElement)) return false
  const menu = next.closest<HTMLElement>('[role="menu"],[data-radix-menu-content]')
  // Only a menu on its way out. A menu the user is deliberately OPENING over
  // an active field still owns focus — taking it back there would fight the
  // menu's own focus trap, and the two would trade focus until one gives up.
  return menu?.dataset.state === 'closed'
}

/**
 * `onBlur` for an inline rename field: keep the field when a closing menu is
 * pulling focus away or the app window itself lost focus, otherwise let the
 * caller commit.
 *
 * Switching to another window is not clicking away. Chromium (WebView2 on
 * Windows) blurs the focused field when the window is deactivated and focuses
 * it again on return, so without the window check alt-tab, a notification or
 * another app's window opening ended the rename. WebKit (macOS, Linux) fires no
 * `focusout` there, so React never saw that blur and the field already stayed.
 */
export function handleInlineRenameBlur(
  event: FocusEvent<HTMLInputElement>,
  commit: () => void
): void {
  if (!event.currentTarget.ownerDocument.hasFocus()) return
  if (isMenuFocusSteal(event)) {
    event.currentTarget.focus()
    return
  }
  commit()
}

/**
 * Keep an inline rename field's keystrokes away from the tree rows around it
 * (Enter opens a row, Space toggles a folder), but let app chords through.
 * Stopping every key made the field swallow ⌘W / ⌘N / ⌘, while it had
 * focus, and ⌘N itself leaves the new note's row in rename.
 */
export function stopInlineRenameKeyPropagation(event: KeyboardEvent<HTMLInputElement>): void {
  const isAppChord = (event.metaKey || event.ctrlKey) && event.key !== 'Enter'
  if (!isAppChord) event.stopPropagation()
}
