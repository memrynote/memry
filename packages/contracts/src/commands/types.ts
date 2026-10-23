import type { ShortcutBinding } from '../settings-schemas'

/** `ShortcutBinding` that differs by platform. `meta` already means Ctrl off macOS. */
export type PlatformBinding =
  ShortcutBinding | { readonly mac: ShortcutBinding; readonly other: ShortcutBinding }

/** Where a command acts: the whole app, or the entity shown in the active tab. */
export type CommandContext =
  'app' | 'note' | 'journal' | 'project' | 'tasks' | 'canvas' | 'folder' | 'file'

/**
 * The domain slice whose runtime owner supplies the command's behavior. A slice
 * name, never a component path. `OwnerImpls<Owner>` is exhaustive over the ids
 * that name it, so a new command without an implementation does not compile.
 */
export type CommandOwner =
  | 'tabs'
  | 'shell'
  | 'settings'
  | 'vaultPager'
  | 'sidebar'
  | 'dayPanel'
  | 'zoom'
  | 'fold'
  | 'window'
  | 'appearance'
  | 'editor'
  | 'note'
  | 'journal'
  | 'project'
  | 'tasks'
  | 'canvas'
  | 'folder'
  | 'file'
  | 'pages'
  | 'sidebarTree'
  | 'sync'

/**
 * The first four are the Settings → Shortcuts categories, and their ids are keys
 * under `settings:shortcuts.categories`. The rest hold commands with no keyboard
 * entry, so Settings never lists them. The palette headings are keys under
 * `common:commandsPalette.groups`.
 */
export type CommandGroup =
  | 'navigation'
  | 'tabs'
  | 'editor'
  | 'view'
  | 'app'
  | 'note'
  | 'project'
  | 'tasks'
  | 'canvas'
  | 'folder'
  | 'file'
  | 'create'
  | 'settings'
  | 'sync'
  | 'help'

/** Where a chord may fire. */
export type InInputPolicy =
  /** Only chords held with ⌘/Ctrl, which never type a character (`chordAllowedInInput`). */
  | 'chord'
  /** Fires with the caret in any field. */
  | 'always'
  /** Stands down whenever a field has focus. */
  | 'never'

export interface ChordAlias {
  readonly chord: ShortcutBinding
  /** The alias exists only while the command's binding is still its default. */
  readonly whileDefault?: true
  /** Overrides the command's own `inInput` for this chord. */
  readonly inInput?: InInputPolicy
}

/** A shortcut the app dispatches. User overrides replace `default`. */
export interface AppKeyboardSpec {
  readonly owner: 'app'
  readonly default: PlatformBinding
  readonly aliases?: readonly ChordAlias[]
  /** Default `'chord'`. */
  readonly inInput?: InInputPolicy
  /** `'yield'`: stand down while rich text has focus (⌘B is Bold there). Default `'own'`. */
  readonly richText?: 'own' | 'yield'
  /** Ctrl+Alt is AltGr on Windows, so the chord must not fire for a typed character. */
  readonly skipAltGraph?: true
  /** Stand down while focus is inside a surface that owns its own ⌘K menu. */
  readonly yieldToLocalCommandMenu?: true
  /**
   * Fire in the window's capture phase, ahead of any field or editor. Default:
   * the bubble phase, where a widget that handles the key and stops propagation
   * (Excalidraw's ⌘[ and ⌘] reorder layers) keeps it. Set only where the chord
   * must win while a field that swallows keys has focus.
   */
  readonly capture?: true
  /** Show the binding as the native menu accelerator. Never on a `richText: 'yield'` command. */
  readonly menuAccelerator?: true
}

/** A key the note editor (ProseMirror) owns. Listed for display, never dispatched. */
export interface EditorKeyboardSpec {
  readonly owner: 'editor'
  readonly display: PlatformBinding
}

export type KeyboardSpec = AppKeyboardSpec | EditorKeyboardSpec

export interface CommandMeta {
  readonly context: CommandContext
  readonly owner: CommandOwner
  readonly group: CommandGroup
  /**
   * A command with a `keyboard` entry names its row in
   * `settings:shortcuts.entries`, which Settings → Shortcuts renders. Every other
   * command names a key in the `menu` namespace, which main (native menu) and the
   * renderer (palette) both load.
   */
  readonly i18nKey: string
  readonly keyboard?: KeyboardSpec
  /** Appears in the native menu under its own id. */
  readonly menu?: true
  /** Never has a keyboard default, and its owner confirms before acting. */
  readonly destructive?: true
  /** Hidden from the command palette. */
  readonly palette?: false
}

export function resolvePlatformBinding(binding: PlatformBinding, isMac: boolean): ShortcutBinding {
  if ('mac' in binding) return isMac ? binding.mac : binding.other
  return binding
}
