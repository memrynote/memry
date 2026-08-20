import type { FocusEvent } from 'react'

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
 * pulling focus away, otherwise let the caller commit.
 */
export function handleInlineRenameBlur(
  event: FocusEvent<HTMLInputElement>,
  commit: () => void
): void {
  if (isMenuFocusSteal(event)) {
    event.currentTarget.focus()
    return
  }
  commit()
}
