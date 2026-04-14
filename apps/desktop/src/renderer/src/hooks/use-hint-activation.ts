import { useEffect } from 'react'
import { useHintModeContext } from '@/contexts/hint-mode'

const EDITOR_SELECTOR =
  '[contenteditable=""],[contenteditable="true"],input,textarea,.bn-container,.ProseMirror'

const isEditorFocused = (target: EventTarget | null): boolean => {
  const el = target instanceof HTMLElement ? target : (document.activeElement as HTMLElement | null)
  if (!el) return false
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return true
  return el.closest(EDITOR_SELECTOR) !== null
}

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
        if (!isEditorFocused(e.target)) {
          e.preventDefault()
          e.stopPropagation()
          activate()
          return
        }
      }

      if (e.key === 'Escape' && isEditorFocused(e.target)) {
        ;(document.activeElement as HTMLElement)?.blur()
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [state.isActive, activate, deactivate, typeChar, backspace])
}
