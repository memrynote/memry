/**
 * Shortcut catalog
 *
 * The rows behind Settings → Shortcuts and the conflict check, derived from the
 * command metadata in `@memry/contracts/commands`. Defaults live there, never
 * here; user overrides live in `lib/shortcut-bindings.ts`.
 */

import {
  COMMANDS,
  resolvePlatformBinding,
  type CommandGroup,
  type CommandId,
  type KeyboardCommandId
} from '@memry/contracts/commands'
import type { FolderNoteShortcut, ShortcutBinding } from '@memry/contracts/settings-schemas'

/**
 * Every id with a runtime owner reads its effective binding through
 * `useShortcutBinding` (see `lib/shortcut-bindings.ts`). An id with no reader is
 * a settings row that silently does nothing.
 */
export type ShortcutId = KeyboardCommandId

export interface ShortcutEntry {
  id: ShortcutId
  /** Key under `settings:shortcuts.entries` for the row's label and description. */
  i18nKey: string
  group: CommandGroup
  defaultBinding: ShortcutBinding
  /**
   * Editor formatting keys are owned by the note editor (BlockNote/ProseMirror)
   * and cannot be remapped from settings. They stay listed for reference and
   * render read-only rather than offering a rebind that would never apply.
   */
  rebindable: boolean
}

/** The other shortcut that already uses a chord: a catalog command or a folder's new-note chord. */
export type ShortcutConflict =
  | {
      kind: 'command'
      conflictingId: ShortcutId
      /** `ShortcutEntry.i18nKey` of the entry that already uses the chord. */
      conflictingI18nKey: string
    }
  | { kind: 'folder'; conflictingId: string; folder: string }

// ============================================================================
// Platform detection
// ============================================================================

export const isMac =
  typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC')

function toEntry(id: ShortcutId): ShortcutEntry {
  const { keyboard, group, i18nKey } = COMMANDS[id]
  const editorOwned = keyboard.owner === 'editor'
  return {
    id,
    i18nKey,
    group,
    defaultBinding: resolvePlatformBinding(
      editorOwned ? keyboard.display : keyboard.default,
      isMac
    ),
    rebindable: !editorOwned
  }
}

export const SHORTCUT_ENTRIES: readonly ShortcutEntry[] = (
  Object.keys(COMMANDS) as CommandId[]
).flatMap((id) => ('keyboard' in COMMANDS[id] ? [toEntry(id as ShortcutId)] : []))

/** Display order of the groups in Settings → Shortcuts. */
export const SHORTCUT_GROUP_ORDER: readonly CommandGroup[] = [
  'navigation',
  'tabs',
  'editor',
  'view'
]

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a ShortcutBinding as a human-readable string (e.g., "⌘ Shift N")
 */
export function formatBinding(binding: ShortcutBinding): string {
  return bindingParts(binding).join(' ')
}

/**
 * The keycaps of a binding, in the platform's modifier order (macOS: ⌃ ⌥ ⇧ ⌘).
 */
export function bindingParts(binding: ShortcutBinding): string[] {
  const { meta, ctrl, alt, shift } = binding.modifiers
  const parts: string[] = []
  if (isMac) {
    if (ctrl) parts.push('⌃')
    if (alt) parts.push('⌥')
    if (shift) parts.push('⇧')
    if (meta) parts.push('⌘')
  } else {
    // Off macOS `meta` already is Ctrl.
    if (meta || ctrl) parts.push('Ctrl')
    if (alt) parts.push('Alt')
    if (shift) parts.push('Shift')
  }
  parts.push(formatKey(binding.key))
  return parts
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
    Space: '␣',
    ' ': '␣'
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
  return SHORTCUT_ENTRIES.find((entry) => entry.id === id)?.defaultBinding
}

/** Conflict ids for "new note in folder" shortcuts, which live outside the catalog. */
export const FOLDER_NOTE_SHORTCUT_PREFIX = 'folderNote:'

export const folderNoteShortcutId = (folder: string): string =>
  `${FOLDER_NOTE_SHORTCUT_PREFIX}${folder}`

/**
 * Find conflicts: other shortcuts, catalog or per-folder, that use the same
 * binding.
 *
 * Editor formatting keys do not conflict with catalog shortcuts: they only
 * apply while the caret is in rich text, so sharing a chord with an app-level
 * shortcut (⌘B is both Bold and Toggle Sidebar) is resolved by focus at
 * keypress time. A folder shortcut has no such focus rule and fires inside the
 * editor too, so it may not take an editor key.
 */
export function findConflicts(
  id: string,
  binding: ShortcutBinding,
  overrides: Record<string, ShortcutBinding>,
  folderNoteShortcuts: FolderNoteShortcut[] = []
): ShortcutConflict[] {
  const isFolderShortcut = id.startsWith(FOLDER_NOTE_SHORTCUT_PREFIX)
  const commandConflicts = SHORTCUT_ENTRIES.filter((entry) => {
    if (entry.id === id) return false
    if (!entry.rebindable && !isFolderShortcut) return false
    return bindingsEqual(resolveBinding(entry, overrides), binding)
  }).map((entry): ShortcutConflict => ({
    kind: 'command',
    conflictingId: entry.id,
    conflictingI18nKey: entry.i18nKey
  }))
  const folderConflicts = folderNoteShortcuts
    .filter(
      (entry) => folderNoteShortcutId(entry.folder) !== id && bindingsEqual(entry.binding, binding)
    )
    .map((entry): ShortcutConflict => ({
      kind: 'folder',
      conflictingId: folderNoteShortcutId(entry.folder),
      folder: entry.folder
    }))
  return [...commandConflicts, ...folderConflicts]
}

/**
 * Get shortcuts grouped in display order. Empty groups are omitted.
 */
export function getGroupedShortcuts(): Map<CommandGroup, ShortcutEntry[]> {
  const grouped = new Map<CommandGroup, ShortcutEntry[]>()
  for (const group of SHORTCUT_GROUP_ORDER) {
    const entries = SHORTCUT_ENTRIES.filter((entry) => entry.group === group)
    if (entries.length > 0) grouped.set(group, entries)
  }
  return grouped
}
