import { useEffect } from 'react'
import { useHintModeContext } from '@/contexts/hint-mode'

const isEditorFocused = (): boolean => {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
}

export const useHintActivation = (): void => {
  const { state, activate, deactivate, typeChar, backspace } = useHintModeContext()

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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

        e.preventDefault()
        e.stopPropagation()
        return
      }

      if (e.code === 'KeyF' && e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        e.stopPropagation()
        activate()
        return
      }

      if (e.code === 'KeyF' && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        if (!isEditorFocused()) {
          e.preventDefault()
          e.stopPropagation()
          activate()
          return
        }
      }

      if (e.key === 'Escape' && isEditorFocused()) {
        ;(document.activeElement as HTMLElement)?.blur()
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [state.isActive, activate, deactivate, typeChar, backspace])
}
