import { useCallback, useEffect, useState } from 'react'

export type PdfDisplayOption = 'embed' | 'link'

export const PDF_DISPLAY_OPTIONS: readonly PdfDisplayOption[] = ['embed', 'link']

interface PdfDisplayMenuState {
  blockId: string
  position: { x: number; y: number }
  selectedIndex: number
}

interface PdfDisplayEditor {
  getBlock: (id: string) => { props?: Record<string, unknown> } | undefined
  updateBlock: (id: string, update: { props: Record<string, unknown> }) => void
}

interface UsePdfDisplayMenuParams {
  editor: PdfDisplayEditor
  editorContainerRef: React.RefObject<HTMLDivElement | null>
  /** The Settings default: what the block already is, so it starts selected. */
  defaultDisplay: PdfDisplayOption | undefined
}

/**
 * The "Show as" popover offered right after a PDF lands in a note by drop (#2517).
 * The block is inserted with the Settings default first, so every way out of the
 * menu short of picking the other option (Escape, a click elsewhere, typing on)
 * keeps that default — the same contract as the pasted-URL menu.
 */
export function usePdfDisplayMenu({
  editor,
  editorContainerRef,
  defaultDisplay
}: UsePdfDisplayMenuParams) {
  const [state, setState] = useState<PdfDisplayMenuState | null>(null)
  const close = useCallback(() => {
    setState(null)
  }, [])

  const open = useCallback(
    (blockId: string) => {
      const container = editorContainerRef.current
      if (!container) return
      // The block's DOM lands a frame after insertBlocks returns.
      requestAnimationFrame(() => {
        const el = container.querySelector(`[data-id="${CSS.escape(blockId)}"]`)
        if (!el) return
        const rect = el.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()
        setState({
          blockId,
          // Anchored to the top edge: an embed is still loading and grows tall after this runs.
          position: { x: rect.left - containerRect.left, y: rect.top - containerRect.top + 8 },
          selectedIndex: Math.max(0, PDF_DISPLAY_OPTIONS.indexOf(defaultDisplay ?? 'embed'))
        })
      })
    },
    [editorContainerRef, defaultDisplay]
  )

  const select = useCallback(
    (option: PdfDisplayOption) => {
      if (!state) return
      const block = editor.getBlock(state.blockId)
      if (block) editor.updateBlock(state.blockId, { props: { ...block.props, display: option } })
      close()
    },
    [state, editor, close]
  )

  const isOpen = state !== null
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return
      const count = PDF_DISPLAY_OPTIONS.length

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const step = e.key === 'ArrowDown' ? 1 : -1
        setState((prev) =>
          prev ? { ...prev, selectedIndex: (prev.selectedIndex + step + count) % count } : prev
        )
        return
      }

      if (e.key === 'Enter' && state) {
        e.preventDefault()
        e.stopImmediatePropagation()
        select(PDF_DISPLAY_OPTIONS[state.selectedIndex])
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
      close()
    }

    const handleClickAway = (e: MouseEvent): void => {
      if ((e.target as HTMLElement).closest('[data-inline-choice-menu]')) return
      close()
    }

    // On the document, not the editor: a drop leaves focus wherever it was, so
    // the menu cannot count on the caret being inside the editor.
    document.addEventListener('keydown', handleKeyDown, { capture: true })
    document.addEventListener('mousedown', handleClickAway)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true })
      document.removeEventListener('mousedown', handleClickAway)
    }
  }, [isOpen, state, select, close])

  return { state, open, select }
}
