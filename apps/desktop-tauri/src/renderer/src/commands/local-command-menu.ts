/**
 * Surfaces with their own ⌘K menu (the calendar timeline) mark their focus
 * root with this attribute. While focus is inside one, a command whose spec sets
 * `yieldToLocalCommandMenu` leaves its primary chord to that menu.
 */
export const LOCAL_COMMAND_MENU_ATTR = 'data-local-command-menu'

export function focusOwnsLocalCommandMenu(): boolean {
  const active = document.activeElement
  return active instanceof Element && active.closest(`[${LOCAL_COMMAND_MENU_ATTR}]`) !== null
}
