import {
  COMMANDS,
  resolvePlatformBinding,
  type AppKeyboardSpec,
  type CommandId,
  type CommandMeta,
  type InInputPolicy
} from '@memry/contracts/commands'
import type { FolderNoteShortcut, ShortcutBinding } from '@memry/contracts/settings-schemas'
import { chordAllowedInInput, matchesShortcut } from '@/hooks/use-keyboard-shortcuts-base'

/** Everything about the world that decides whether a keystroke means a command. */
export interface KeydownEnv {
  isMac: boolean
  /** Settings → Shortcuts is recording a chord. */
  isRecording: boolean
  /** Hint mode or a vault switch holds the keyboard. */
  isBlocked: boolean
  /** A text field, the note editor, or a block selection owns typing. */
  isInInput: boolean
  isRichTextFocused: boolean
  /** Focus is inside a surface that has its own ⌘K menu. */
  focusOwnsLocalCommandMenu: boolean
  /** The user's rebinds by command id. */
  overrides: Readonly<Record<string, ShortcutBinding>>
  isAvailable: (id: CommandId) => boolean
}

/** The window listener a chord belongs to, from its spec's `capture` flag. */
export type KeyPhase = 'capture' | 'bubble'

const COMMAND_META: Readonly<Record<CommandId, CommandMeta>> = COMMANDS

/** Commands the app dispatches itself, in table order. Editor-owned keys never appear. */
const KEYBOARD_COMMANDS: readonly { id: CommandId; spec: AppKeyboardSpec }[] = (
  Object.keys(COMMANDS) as CommandId[]
).flatMap((id) => {
  const keyboard = COMMAND_META[id].keyboard
  return keyboard?.owner === 'app' ? [{ id, spec: keyboard }] : []
})

/**
 * Symbols that sit on a shifted key on most layouts. A chord naming one without
 * a Shift modifier means "whichever key types this", so Shift is not held
 * against it. Every other chord without Shift rejects a held Shift.
 */
const SHIFTED_SYMBOLS = new Set('?!@#$%^&*()_+{}|:"<>~')

function matchesChord(e: KeyboardEvent, chord: ShortcutBinding, isMac: boolean): boolean {
  const { key, modifiers } = chord
  const shift =
    modifiers.shift === undefined && SHIFTED_SYMBOLS.has(key) ? e.shiftKey : modifiers.shift
  return matchesShortcut(e, key, { ...modifiers, shift }, isMac)
}

function allowedInInput(policy: InInputPolicy, chord: ShortcutBinding, e: KeyboardEvent): boolean {
  if (policy === 'always') return true
  if (policy === 'never') return false
  // Escape has always gone through, as in the base shortcut hook.
  return chordAllowedInInput(chord) || e.key === 'Escape'
}

/**
 * Which command, if any, does this keydown mean? Pure: no DOM, no store.
 *
 * Order: commands the user rebound come before the rest (a stale collision
 * resolves in the user's favor), then table order. A chord that matches but
 * fails a policy or has no available owner is skipped, so the key passes
 * through to whatever else listens. The winner is picked across every command,
 * whatever its phase, and is returned only to its own phase's listener: a
 * rebound bubble command still beats a default capture command on one chord.
 */
export function resolveChord(e: KeyboardEvent, env: KeydownEnv, phase: KeyPhase): CommandId | null {
  if (env.isRecording || env.isBlocked) return null

  const rebound = KEYBOARD_COMMANDS.filter(({ id }) => env.overrides[id] !== undefined)
  const rest = KEYBOARD_COMMANDS.filter(({ id }) => env.overrides[id] === undefined)

  for (const { id, spec } of [...rebound, ...rest]) {
    const override = env.overrides[id]
    const chords: { chord: ShortcutBinding; inInput: InInputPolicy; primary: boolean }[] = [
      {
        chord: override ?? resolvePlatformBinding(spec.default, env.isMac),
        inInput: spec.inInput ?? 'chord',
        primary: true
      }
    ]
    for (const alias of spec.aliases ?? []) {
      if (alias.whileDefault && override !== undefined) continue
      chords.push({
        chord: alias.chord,
        inInput: alias.inInput ?? spec.inInput ?? 'chord',
        primary: false
      })
    }

    for (const { chord, inInput, primary } of chords) {
      if (!matchesChord(e, chord, env.isMac)) continue
      if (spec.skipAltGraph && e.getModifierState('AltGraph')) continue
      if (spec.richText === 'yield' && env.isRichTextFocused) continue
      // Only the primary chord belongs to the local menu; aliases still reach the app.
      if (primary && spec.yieldToLocalCommandMenu && env.focusOwnsLocalCommandMenu) continue
      if (env.isInInput && !allowedInInput(inInput, chord, e)) continue
      if (!env.isAvailable(id)) continue
      return (spec.capture === true ? 'capture' : 'bubble') === phase ? id : null
    }
  }

  return null
}

/**
 * Which folder's "new note" shortcut, if any, does this keydown mean? The user
 * adds these chords at runtime, so they are data rather than commands. Callers ask
 * only after `resolveChord` found no command: a command always wins a shared
 * chord. A chord without ⌘/Ctrl stays out of fields, where it would eat typing.
 */
export function resolveFolderChord(
  e: KeyboardEvent,
  env: Pick<KeydownEnv, 'isMac' | 'isRecording' | 'isBlocked' | 'isInInput'>,
  shortcuts: readonly FolderNoteShortcut[]
): string | null {
  if (env.isRecording || env.isBlocked) return null
  for (const { folder, binding } of shortcuts) {
    if (!matchesChord(e, binding, env.isMac)) continue
    if (env.isInInput && !chordAllowedInInput(binding)) continue
    return folder
  }
  return null
}
