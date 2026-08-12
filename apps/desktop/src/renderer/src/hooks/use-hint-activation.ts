import { useEffect } from 'react'
import { hintModeActiveRef, useHintModeActions } from '@/contexts/hint-mode'
import { isInputFocused } from '@/hooks/use-keyboard-shortcuts'

export const useHintActivation = (): void => {
  // Actions only: the hint state object changes on every typed character, and
  // subscribing to it here would re-render the whole app shell and tear the
  // capture-phase window listener down and back up per keystroke. Active-ness is
  // read from hintModeActiveRef, the same gate use-keyboard-shortcuts-base,
  // use-chord-shortcuts and use-modifier-held already read at keypress time.
  const { activate, deactivate, typeChar, backspace } = useHintModeActions()

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return

      if (hintModeActiveRef.current) {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          deactivate()
          return
        }

        if (e.key === 'Backspace') {
          e.preventDefault()
          e.stopPropagation()
          backspace()
          return
        }

        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault()
          e.stopPropagation()
          typeChar(e.key)
          return
        }

        return
      }

      if (e.code === 'KeyF' && e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        e.stopPropagation()
        activate()
        return
      }

      if (e.code === 'KeyF' && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        if (!isInputFocused()) {
          e.preventDefault()
          e.stopPropagation()
          activate()
          return
        }
      }

      if (e.key === 'Escape' && isInputFocused()) {
        ;(document.activeElement as HTMLElement)?.blur()
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [activate, deactivate, typeChar, backspace])
}
