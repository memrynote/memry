import { useCallback, useEffect, useRef, useState } from 'react'
import { extractYouTubeVideoId } from '@/lib/youtube-utils'

const URL_REGEX = /^https?:\/\/\S+$/

function detectEmbedProvider(url: string): string | null {
  if (extractYouTubeVideoId(url)) return 'youtube'
  return null
}

export type PasteLinkOption = 'url' | 'mention' | 'embed'

interface PasteLinkMenuState {
  isOpen: boolean
  url: string
  position: { x: number; y: number }
  options: PasteLinkOption[]
  selectedIndex: number
}

const INITIAL_STATE: PasteLinkMenuState = {
  isOpen: false,
  url: '',
  position: { x: 0, y: 0 },
  options: [],
  selectedIndex: 0
}

interface UsePasteLinkMenuParams {
  editorContainerRef: React.RefObject<HTMLDivElement | null>
  onSelect: (option: PasteLinkOption, url: string) => void
}

export function usePasteLinkMenu({ editorContainerRef, onSelect }: UsePasteLinkMenuParams) {
  const [state, setState] = useState<PasteLinkMenuState>(INITIAL_STATE)
  const stateRef = useRef(state)
  stateRef.current = state

  const close = useCallback(() => setState(INITIAL_STATE), [])

  const handleSelect = useCallback(
    (option: PasteLinkOption) => {
      onSelect(option, stateRef.current.url)
      close()
    },
    [onSelect, close]
  )

  useEffect(() => {
    const container = editorContainerRef.current
    if (!container) return

    const handlePaste = (e: ClipboardEvent): void => {
      if (stateRef.current.isOpen) return

      const text = e.clipboardData?.getData('text/plain')?.trim()
      if (!text || !URL_REGEX.test(text)) return

      const options: PasteLinkOption[] = ['url', 'mention']
      if (detectEmbedProvider(text)) {
        options.push('embed')
      }

      requestAnimationFrame(() => {
        const selection = window.getSelection()
        const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null
        const containerRect = container.getBoundingClientRect()

        setState({
          isOpen: true,
          url: text,
          position: {
            x: rect ? rect.left - containerRect.left : 0,
            y: rect ? rect.bottom - containerRect.top + 4 : 0
          },
          options,
          selectedIndex: 0
        })
      })
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      const s = stateRef.current
      if (!s.isOpen) return

      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        close()
        return
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopImmediatePropagation()
        setState((prev) => ({
          ...prev,
          selectedIndex: (prev.selectedIndex + 1) % prev.options.length
        }))
        return
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopImmediatePropagation()
        setState((prev) => ({
          ...prev,
          selectedIndex: (prev.selectedIndex - 1 + prev.options.length) % prev.options.length
        }))
        return
      }

      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopImmediatePropagation()
        handleSelect(s.options[s.selectedIndex])
        return
      }

      close()
    }

    const handleClickAway = (e: MouseEvent): void => {
      if (!stateRef.current.isOpen) return
      const target = e.target as HTMLElement
      if (target.closest('[data-paste-link-menu]')) return
      close()
    }

    container.addEventListener('paste', handlePaste)
    container.addEventListener('keydown', handleKeyDown, { capture: true })
    document.addEventListener('mousedown', handleClickAway)

    return () => {
      container.removeEventListener('paste', handlePaste)
      container.removeEventListener('keydown', handleKeyDown, { capture: true })
      document.removeEventListener('mousedown', handleClickAway)
    }
  }, [editorContainerRef, handleSelect, close])

  return { state, close, handleSelect }
}
