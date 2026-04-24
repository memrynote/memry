import { useEffect } from 'react'
import { useHintModeContext } from '@/contexts/hint-mode'
import { isInputFocused } from '@/hooks/use-keyboard-shortcuts'

export const useHintActivation = (): void => {
  const { state, activate, deactivate, typeChar, backspace } = useHintModeContext()

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return

      if (state.isActive) {
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
  }, [state.isActive, activate, deactivate, typeChar, backspace])
}
