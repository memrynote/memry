import { useEffect, useRef } from 'react'
import { isInputFocused, isRichTextFocused } from '@/hooks/use-keyboard-shortcuts'
import { isMac, isShortcutRecording } from '@/hooks/use-keyboard-shortcuts-base'
import { useFolderNoteShortcuts, useShortcutOverrides } from '@/lib/shortcut-bindings'
import { isFolderNoteRunnable, runFolderNote } from './folder-note-runner'
import { focusOwnsLocalCommandMenu } from './local-command-menu'
import { resolveChord, resolveFolderChord, type KeydownEnv, type KeyPhase } from './resolve-chord'
import { isKeyboardBlocked, runCommand } from './run-command'
import { isCommandAvailable } from './store'

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return (
    element?.tagName === 'INPUT' ||
    element?.tagName === 'TEXTAREA' ||
    element?.isContentEditable === true ||
    isInputFocused()
  )
}

const PHASES: readonly KeyPhase[] = ['capture', 'bubble']

/**
 * The one keyboard dispatcher for commands, on two window listeners. A command
 * flagged `capture` runs ahead of every field and editor. The rest run in the
 * bubble phase, so a focused widget that handles a chord and stops propagation
 * (Excalidraw's ⌘[ and ⌘]) keeps it. A key is consumed only when its command is
 * available and not blocked, which is exactly when `runCommand` will run it.
 * Anything else passes through untouched.
 *
 * A folder's "new note" chord (Settings → Shortcuts) is not a command but is
 * dispatched here too, in the bubble phase and only when no command took the key.
 */
export function useCommandDispatcher(): void {
  const overrides = useShortcutOverrides()
  const overridesRef = useRef(overrides)
  const folderNoteShortcuts = useFolderNoteShortcuts()
  const folderNoteShortcutsRef = useRef(folderNoteShortcuts)

  useEffect(() => {
    overridesRef.current = overrides
    folderNoteShortcutsRef.current = folderNoteShortcuts
  }, [overrides, folderNoteShortcuts])

  useEffect(() => {
    const listen = (phase: KeyPhase): (() => void) => {
      const onKeyDown = (e: KeyboardEvent): void => {
        const env: KeydownEnv = {
          isMac,
          isRecording: isShortcutRecording(),
          isBlocked: isKeyboardBlocked(),
          isInInput: isTypingTarget(e.target),
          isRichTextFocused: isRichTextFocused(),
          focusOwnsLocalCommandMenu: focusOwnsLocalCommandMenu(),
          overrides: overridesRef.current,
          isAvailable: isCommandAvailable
        }
        const id = resolveChord(e, env, phase)
        if (id !== null) {
          e.preventDefault()
          e.stopPropagation()
          void runCommand(id, 'keyboard')
          return
        }

        if (phase !== 'bubble') return
        const folder = resolveFolderChord(e, env, folderNoteShortcutsRef.current)
        if (folder === null || !isFolderNoteRunnable()) return
        e.preventDefault()
        e.stopPropagation()
        runFolderNote(folder)
      }
      const capture = phase === 'capture'
      window.addEventListener('keydown', onKeyDown, { capture })
      return () => window.removeEventListener('keydown', onKeyDown, { capture })
    }

    const stops = PHASES.map(listen)
    return () => stops.forEach((stop) => stop())
  }, [])
}
