import { APP_COMMANDS } from './app'
import { CANVAS_COMMANDS } from './canvas'
import { EDITOR_COMMANDS } from './editor'
import { FILE_COMMANDS } from './file'
import { FOLDER_COMMANDS } from './folder'
import { JOURNAL_COMMANDS } from './journal'
import { NAV_COMMANDS } from './nav'
import { NOTE_COMMANDS } from './note'
import { PAGE_COMMANDS } from './pages'
import { PROJECT_COMMANDS } from './project'
import { SETTINGS_COMMANDS } from './settings-sections'
import { SIDEBAR_TREE_COMMANDS } from './sidebar-tree'
import { SYNC_COMMANDS } from './sync'
import { TABS_COMMANDS } from './tabs'
import { TASKS_COMMANDS } from './tasks'
import type { CommandMeta, CommandOwner } from './types'
import { VIEW_COMMANDS } from './view'

export * from './settings-sections'
export * from './types'

/**
 * Static metadata for every command: what Settings, the shortcuts help, conflict
 * detection, the native menu and the palette need without a mounted owner.
 * Behavior lives with each owner in the renderer. Table order is display order.
 */
export const COMMANDS = {
  ...NAV_COMMANDS,
  ...PAGE_COMMANDS,
  ...SIDEBAR_TREE_COMMANDS,
  ...TABS_COMMANDS,
  ...EDITOR_COMMANDS,
  ...NOTE_COMMANDS,
  ...JOURNAL_COMMANDS,
  ...PROJECT_COMMANDS,
  ...TASKS_COMMANDS,
  ...CANVAS_COMMANDS,
  ...FOLDER_COMMANDS,
  ...FILE_COMMANDS,
  ...VIEW_COMMANDS,
  ...SETTINGS_COMMANDS,
  ...SYNC_COMMANDS,
  ...APP_COMMANDS
} as const satisfies Record<string, CommandMeta>

export type CommandId = keyof typeof COMMANDS

/** The ids a runtime owner must supply behavior for. */
export type CommandIdsOf<O extends CommandOwner> = {
  [K in CommandId]: (typeof COMMANDS)[K]['owner'] extends O ? K : never
}[CommandId]

/** Commands with a keyboard entry: the rows of Settings → Shortcuts. */
export type KeyboardCommandId = {
  [K in CommandId]: (typeof COMMANDS)[K] extends { readonly keyboard: object } ? K : never
}[CommandId]

/** Commands the native menu lists as an item with this id. */
export type MenuCommandId = {
  [K in CommandId]: (typeof COMMANDS)[K] extends { readonly menu: true } ? K : never
}[CommandId]

/** Commands whose default binding the native menu shows as its accelerator. */
export type MenuAcceleratorCommandId = {
  [K in CommandId]: (typeof COMMANDS)[K] extends {
    readonly keyboard: { readonly menuAccelerator: true }
  }
    ? K
    : never
}[CommandId]

export function isKeyboardCommandId(id: CommandId): id is KeyboardCommandId {
  return 'keyboard' in COMMANDS[id]
}

export function isCommandId(value: unknown): value is CommandId {
  return typeof value === 'string' && Object.hasOwn(COMMANDS, value)
}

/**
 * The ids that existed as `ShortcutId` before commands did. Users' saved
 * `keyboard.overrides` are keyed by them, so their strings never change.
 */
export const LEGACY_SHORTCUT_IDS = [
  'nav.newNote',
  'nav.search',
  'nav.settings',
  'nav.switchVault',
  'nav.nextVault',
  'nav.prevVault',
  'tabs.closeTab',
  'tabs.nextTab',
  'tabs.prevTab',
  'tabs.reopenTab',
  'tabs.navBack',
  'tabs.navForward',
  'tabs.newTab',
  'tabs.closeAllTabs',
  'tabs.pinTab',
  'tabs.duplicateTab',
  'tabs.splitRight',
  'tabs.splitDown',
  'tabs.closeSplit',
  'editor.bold',
  'editor.italic',
  'editor.underline',
  'editor.strikethrough',
  'editor.code',
  'view.toggleSidebar',
  'view.toggleDayPanel',
  'view.shortcuts',
  'view.zoomIn',
  'view.zoomOut',
  'view.actualSize'
] as const satisfies readonly CommandId[]
