/**
 * useModifierHeld
 * Tracks whether the platform command modifier (⌘ on Mac, Ctrl elsewhere) is
 * currently held down. Used to reveal the sidebar section number shortcuts.
 *
 * Listens in the capture phase so it sees the modifier even while the note
 * editor or an auto-focused input (inbox composer, tasks quick-add) is focused
 * and stops event propagation — keeping the numbers in sync with the ⌘+digit
 * navigation, which works everywhere too. Resets on keyup and on window blur so
 * the affordance never gets stuck when focus leaves the window (e.g. ⌘-Tab away
 * while still holding).
 */

import { useEffect, useState } from 'react'
import { isMac } from './use-keyboard-shortcuts-base'
import { hintModeActiveRef } from '@/contexts/hint-mode'

export const useModifierHeld = (): boolean => {
  const [held, setHeld] = useState(false)

  useEffect(() => {
    const isModDown = (e: KeyboardEvent): boolean => (isMac ? e.metaKey : e.ctrlKey)

    const handleKeyDown = (e: KeyboardEvent): void => {
      setHeld(isModDown(e) && !hintModeActiveRef.current)
    }
    const handleKeyUp = (e: KeyboardEvent): void => {
      if (!isModDown(e)) setHeld(false)
    }
    const reset = (): void => setHeld(false)

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
      window.removeEventListener('blur', reset)
    }
  }, [])

  return held
}

export default useModifierHeld
