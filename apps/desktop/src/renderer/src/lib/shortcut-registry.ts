/**
 * Shortcut Registry
 *
 * Central registry of all rebindable keyboard shortcuts with defaults,
 * categories, and conflict detection.
 */

import type { ShortcutBinding } from '@memry/contracts/settings-schemas'

export interface ShortcutEntry {
  id: string
  label: string
  description: string
  category: string
  defaultBinding: ShortcutBinding
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
    label: 'New Note',
    description: 'Create a new note',
    category: 'Navigation',
    defaultBinding: { key: 'n', modifiers: { meta: true } }
  },
  {
    id: 'nav.newTask',
    label: 'New Task',
    description: 'Create a new task',
    category: 'Navigation',
    defaultBinding: { key: 't', modifiers: { meta: true, shift: true } }
  },
  {
    id: 'nav.goToInbox',
    label: 'Go to Inbox',
    description: 'Navigate to the inbox',
    category: 'Navigation',
    defaultBinding: { key: 'i', modifiers: { meta: true, shift: true } }
  },
  {
    id: 'nav.goToNotes',
    label: 'Go to Notes',
    description: 'Navigate to notes',
    category: 'Navigation',
    defaultBinding: { key: 'e', modifiers: { meta: true, shift: true } }
  },
  {
    id: 'nav.goToTasks',
    label: 'Go to Tasks',
    description: 'Navigate to tasks',
    category: 'Navigation',
    defaultBinding: { key: 'k', modifiers: { meta: true, shift: true } }
  },
  {
    id: 'nav.search',
    label: 'Search',
    description: 'Open global search',
    category: 'Navigation',
    defaultBinding: { key: 'f', modifiers: { meta: true } }
  },
  {
    id: 'nav.settings',
    label: 'Open Settings',
    description: 'Open the settings panel',
    category: 'Navigation',
    defaultBinding: { key: ',', modifiers: { meta: true } }
  },

  // Tabs
  {
    id: 'tabs.closeTab',
    label: 'Close Tab',
    description: 'Close the current tab',
    category: 'Tabs',
    defaultBinding: { key: 'w', modifiers: { meta: true } }
  },
  {
    id: 'tabs.nextTab',
    label: 'Next Tab',
    description: 'Switch to the next tab',
    category: 'Tabs',
    defaultBinding: { key: 'Tab', modifiers: { ctrl: true } }
  },
  {
    id: 'tabs.prevTab',
    label: 'Previous Tab',
    description: 'Switch to the previous tab',
    category: 'Tabs',
    defaultBinding: { key: 'Tab', modifiers: { ctrl: true, shift: true } }
  },
  {
    id: 'tabs.reopenTab',
    label: 'Reopen Last Tab',
    description: 'Reopen the most recently closed tab',
    category: 'Tabs',
    defaultBinding: { key: 't', modifiers: { meta: true } }
  },

  // Editor
  {
    id: 'editor.save',
    label: 'Save',
    description: 'Save the current note',
    category: 'Editor',
    defaultBinding: { key: 's', modifiers: { meta: true } }
  },
  {
    id: 'editor.bold',
    label: 'Bold',
    description: 'Toggle bold formatting',
    category: 'Editor',
    defaultBinding: { key: 'b', modifiers: { meta: true } }
  },
  {
    id: 'editor.italic',
    label: 'Italic',
    description: 'Toggle italic formatting',
    category: 'Editor',
    defaultBinding: { key: 'i', modifiers: { meta: true } }
  },
  {
    id: 'editor.underline',
    label: 'Underline',
    description: 'Toggle underline formatting',
    category: 'Editor',
    defaultBinding: { key: 'u', modifiers: { meta: true } }
  },

  // View
  {
    id: 'view.toggleSidebar',
    label: 'Toggle Sidebar',
    description: 'Show or hide the sidebar',
    category: 'View',
    defaultBinding: { key: 's', modifiers: { meta: true, shift: true } }
  },
  {
    id: 'view.shortcuts',
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
 * Find conflicts: other shortcuts that use the same binding
 */
export function findConflicts(
  id: string,
  binding: ShortcutBinding,
  overrides: Record<string, ShortcutBinding>
): ShortcutConflict[] {
  return SHORTCUT_REGISTRY.filter((entry) => {
    if (entry.id === id) return false
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
