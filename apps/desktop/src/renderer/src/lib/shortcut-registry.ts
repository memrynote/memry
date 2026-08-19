/**
 * Shortcut Registry
 *
 * Central registry of all rebindable keyboard shortcuts with defaults,
 * categories, and conflict detection.
 */

import type { ShortcutBinding } from '@memry/contracts/settings-schemas'

/**
 * Every id in the registry has a runtime owner that reads its effective binding
 * through `useShortcutBinding` (see `lib/shortcut-bindings.ts`). Keep the two
 * in step: an entry with no owner is a settings row that silently does nothing.
 */
export type ShortcutId =
  | 'nav.newNote'
  | 'nav.search'
  | 'nav.settings'
  | 'tabs.closeTab'
  | 'tabs.nextTab'
  | 'tabs.prevTab'
  | 'tabs.reopenTab'
  | 'tabs.navBack'
  | 'tabs.navForward'
  | 'editor.bold'
  | 'editor.italic'
  | 'editor.underline'
  | 'view.toggleSidebar'
  | 'view.shortcuts'

export interface ShortcutEntry {
  id: ShortcutId
  i18nKey: string
  label: string
  description: string
  category: string
  defaultBinding: ShortcutBinding
  /**
   * Editor formatting keys are owned by the note editor (BlockNote/ProseMirror)
   * and cannot be remapped from settings. They stay listed for reference and
   * render read-only rather than offering a rebind that would never apply.
   */
  rebindable?: boolean
}

export interface ShortcutConflict {
  conflictingId: string
  conflictingLabel: string
}

// ============================================================================
// Platform detection
// ============================================================================

export const isMac =
  typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC')

// ============================================================================
// Default shortcut registry
// ============================================================================

export const SHORTCUT_REGISTRY: ShortcutEntry[] = [
  // Navigation
  {
    id: 'nav.newNote',
    i18nKey: 'nav.newNote',
    label: 'New Note',
    description: 'Create a new note',
    category: 'Navigation',
    defaultBinding: { key: 'n', modifiers: { meta: true } }
  },
  {
    id: 'nav.search',
    i18nKey: 'nav.search',
    label: 'Search',
    description: 'Open global search',
    category: 'Navigation',
    defaultBinding: { key: 'k', modifiers: { meta: true } }
  },
  {
    id: 'nav.settings',
    i18nKey: 'nav.settings',
    label: 'Open Settings',
    description: 'Open the settings panel',
    category: 'Navigation',
    defaultBinding: { key: ',', modifiers: { meta: true } }
  },

  // Tabs
  {
    id: 'tabs.closeTab',
    i18nKey: 'tabs.close',
    label: 'Close Tab',
    description: 'Close the current tab',
    category: 'Tabs',
    defaultBinding: { key: 'w', modifiers: { meta: true } }
  },
  {
    id: 'tabs.nextTab',
    i18nKey: 'tabs.next',
    label: 'Next Tab',
    description: 'Switch to the next tab',
    category: 'Tabs',
    defaultBinding: { key: 'Tab', modifiers: { ctrl: true } }
  },
  {
    id: 'tabs.prevTab',
    i18nKey: 'tabs.previous',
    label: 'Previous Tab',
    description: 'Switch to the previous tab',
    category: 'Tabs',
    defaultBinding: { key: 'Tab', modifiers: { ctrl: true, shift: true } }
  },
  {
    id: 'tabs.reopenTab',
    i18nKey: 'tabs.reopen',
    label: 'Reopen Last Tab',
    description: 'Reopen the most recently closed tab',
    category: 'Tabs',
    defaultBinding: { key: 't', modifiers: { meta: true, shift: true } }
  },
  {
    id: 'tabs.navBack',
    i18nKey: 'tabs.navBack',
    label: 'Navigate Back',
    description: 'Re-activate the previously active tab',
    category: 'Tabs',
    defaultBinding: { key: '[', modifiers: { meta: true } }
  },
  {
    id: 'tabs.navForward',
    i18nKey: 'tabs.navForward',
    label: 'Navigate Forward',
    description: 'Redo a back navigation',
    category: 'Tabs',
    defaultBinding: { key: ']', modifiers: { meta: true } }
  },

  // Editor — owned by the note editor, listed for reference only
  {
    id: 'editor.bold',
    i18nKey: 'editor.bold',
    label: 'Bold',
    description: 'Toggle bold formatting',
    category: 'Editor',
    defaultBinding: { key: 'b', modifiers: { meta: true } },
    rebindable: false
  },
  {
    id: 'editor.italic',
    i18nKey: 'editor.italic',
    label: 'Italic',
    description: 'Toggle italic formatting',
    category: 'Editor',
    defaultBinding: { key: 'i', modifiers: { meta: true } },
    rebindable: false
  },
  {
    id: 'editor.underline',
    i18nKey: 'editor.underline',
    label: 'Underline',
    description: 'Toggle underline formatting',
    category: 'Editor',
    defaultBinding: { key: 'u', modifiers: { meta: true } },
    rebindable: false
  },

  // View
  {
    id: 'view.toggleSidebar',
    i18nKey: 'view.toggleSidebar',
    label: 'Toggle Sidebar',
    description: 'Show or hide the sidebar',
    category: 'View',
    defaultBinding: { key: 'b', modifiers: { meta: true } }
  },
  {
    id: 'view.shortcuts',
    i18nKey: 'view.shortcuts',
    label: 'Keyboard Shortcuts Help',
    description: 'Show keyboard shortcuts reference',
    category: 'View',
    defaultBinding: { key: '/', modifiers: { meta: true } }
  }
]

// Category order for display
export const CATEGORY_ORDER = ['Navigation', 'Tabs', 'Editor', 'View']

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a ShortcutBinding as a human-readable string (e.g., "⌘ Shift N")
 */
export function formatBinding(binding: ShortcutBinding): string {
  const parts: string[] = []
  if (binding.modifiers.meta) parts.push(isMac ? '⌘' : 'Ctrl')
  if (binding.modifiers.ctrl) parts.push('Ctrl')
  if (binding.modifiers.alt) parts.push(isMac ? '⌥' : 'Alt')
  if (binding.modifiers.shift) parts.push('Shift')
  parts.push(formatKey(binding.key))
  return parts.join(' ')
}

/**
 * Format a raw key to display-friendly string
 */
function formatKey(key: string): string {
  const map: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Enter: '↩',
    Escape: 'Esc',
    Backspace: '⌫',
    Delete: '⌦',
    Tab: '⇥',
    Space: '␣'
  }
  return map[key] ?? key.toUpperCase()
}

/**
 * Resolve the effective binding for a shortcut (override takes precedence over default)
 */
export function resolveBinding(
  entry: ShortcutEntry,
  overrides: Record<string, ShortcutBinding>
): ShortcutBinding {
  return overrides[entry.id] ?? entry.defaultBinding
}

/**
 * Check if two bindings are identical
 */
export function bindingsEqual(a: ShortcutBinding, b: ShortcutBinding): boolean {
  return (
    a.key.toLowerCase() === b.key.toLowerCase() &&
    Boolean(a.modifiers.meta) === Boolean(b.modifiers.meta) &&
    Boolean(a.modifiers.ctrl) === Boolean(b.modifiers.ctrl) &&
    Boolean(a.modifiers.shift) === Boolean(b.modifiers.shift) &&
    Boolean(a.modifiers.alt) === Boolean(b.modifiers.alt)
  )
}

/**
 * Look up an entry's default binding by id
 */
export function getDefaultBinding(id: ShortcutId): ShortcutBinding | undefined {
  return SHORTCUT_REGISTRY.find((entry) => entry.id === id)?.defaultBinding
}

/**
 * Find conflicts: other rebindable shortcuts that use the same binding.
 *
 * Editor formatting keys are excluded: they only apply while the caret is in
 * rich text, so sharing a chord with an app-level shortcut (⌘B is both Bold and
 * Toggle Sidebar) is resolved by focus at keypress time, not a real collision.
 */
export function findConflicts(
  id: string,
  binding: ShortcutBinding,
  overrides: Record<string, ShortcutBinding>
): ShortcutConflict[] {
  return SHORTCUT_REGISTRY.filter((entry) => {
    if (entry.id === id) return false
    if (entry.rebindable === false) return false
    const effective = resolveBinding(entry, overrides)
    return bindingsEqual(effective, binding)
  }).map((entry) => ({ conflictingId: entry.id, conflictingLabel: entry.label }))
}

/**
 * Get shortcuts grouped by category in display order
 */
export function getGroupedShortcuts(): Map<string, ShortcutEntry[]> {
  const grouped = new Map<string, ShortcutEntry[]>()
  for (const cat of CATEGORY_ORDER) {
    grouped.set(cat, [])
  }
  for (const entry of SHORTCUT_REGISTRY) {
    const cat = entry.category
    if (!grouped.has(cat)) grouped.set(cat, [])
    grouped.get(cat)!.push(entry)
  }
  // Remove empty categories
  for (const [key, entries] of grouped) {
    if (entries.length === 0) grouped.delete(key)
  }
  return grouped
}
