/**
 * Keyboard shortcuts utilities and hook
 * Provides OS detection, input focus detection, and helpers for keyboard shortcuts
 */

/**
 * Detect if the current platform is macOS
 */
export const isMac = typeof navigator !== "undefined" && navigator.platform.toUpperCase().indexOf("MAC") >= 0

/**
 * Get the modifier key display string based on platform
 * Returns ⌘ for Mac, Ctrl for other platforms
 */
export const modifierKey = isMac ? "⌘" : "Ctrl"

/**
 * Get the alt/option key display string based on platform
 * Returns ⌥ for Mac, Alt for other platforms
 */
export const altKey = isMac ? "⌥" : "Alt"

/**
 * Check if the currently focused element is an input field
 * Used to determine if keyboard shortcuts should be triggered
 */
export const isInputFocused = (): boolean => {
  const activeElement = document.activeElement
  const tagName = activeElement?.tagName.toLowerCase()

  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    (activeElement as HTMLElement)?.isContentEditable === true
  )
}

/**
 * Check if a specific input element is the Quick-File input
 * Quick-File inputs should still allow certain shortcuts
 */
export const isQuickFileInput = (element: EventTarget | null): boolean => {
  if (!element || !(element instanceof HTMLElement)) return false
  return element.getAttribute("aria-label") === "Quick file folder search"
}

/**
 * Keyboard shortcut definition
 */
export interface ShortcutDefinition {
  key: string
  label: string
}

/**
 * Keyboard shortcut category for display
 */
export interface ShortcutCategory {
  title: string
  shortcuts: ShortcutDefinition[]
}

/**
 * Get all keyboard shortcuts organized by category for display in the help modal
 */
export const getKeyboardShortcuts = (): ShortcutCategory[] => [
  {
    title: "Navigation",
    shortcuts: [
      { key: "↓ / J", label: "Next item" },
      { key: "↑ / K", label: "Previous item" },
      { key: "Home", label: "First item" },
      { key: "End", label: "Last item" },
      { key: "PageUp", label: "Jump up 10 items" },
      { key: "PageDown", label: "Jump down 10 items" },
    ],
  },
  {
    title: "Selection",
    shortcuts: [
      { key: "X", label: "Toggle selection" },
      { key: `${modifierKey}+A`, label: "Select all" },
      { key: "Shift+↓", label: "Extend selection down" },
      { key: "Shift+↑", label: "Extend selection up" },
      { key: "Escape", label: "Clear selection" },
    ],
  },
  {
    title: "Actions",
    shortcuts: [
      { key: "Enter", label: "Open Filing Panel" },
      { key: "Space", label: "Toggle Preview Panel" },
      { key: ". / F", label: "Open Quick-File (List View)" },
      { key: "Delete", label: "Delete item(s)" },
      { key: "O", label: "Open original link" },
    ],
  },
  {
    title: "Panels",
    shortcuts: [
      { key: "Escape", label: "Close panel" },
      { key: `${modifierKey}+Enter`, label: "Confirm and file" },
      { key: "Tab", label: "Next field" },
      { key: "Shift+Tab", label: "Previous field" },
    ],
  },
  {
    title: "Quick-File",
    shortcuts: [
      { key: "↓ / ↑", label: "Navigate results" },
      { key: "Enter", label: "File to selected" },
      { key: "1-5", label: "Select result by number" },
      { key: "Escape", label: "Cancel" },
    ],
  },
  {
    title: "Global",
    shortcuts: [
      { key: "?", label: "Open shortcuts help" },
      { key: `${modifierKey}+/`, label: "Open shortcuts help" },
      { key: "V", label: "Toggle List/Card view" },
      { key: "R", label: "Refresh inbox" },
    ],
  },
]

