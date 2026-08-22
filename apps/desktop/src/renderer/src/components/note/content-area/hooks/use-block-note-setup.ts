/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useState } from 'react'
import { AIExtension } from '@blocknote/xl-ai'
import { DefaultChatTransport } from 'ai'
import type { HighlightInfo } from '../types'
import { scrollToAnchor } from '../scroll-to-anchor'
import { createLogger } from '@/lib/logger'

const _log = createLogger('Hook:BlockNoteSetup')

interface BlockNoteSetupParams {
  editor: any
  aiPort?: number | null
  spellCheck?: boolean
  focusAtEndRef?: React.RefObject<(() => void) | null>
  editorContainerRef: React.RefObject<HTMLDivElement | null>
  onLinkClick?: (href: string) => void
  initialHighlight?: HighlightInfo
  /** For 'note_date' reminders: scroll to the inline date pill with this anchor id. */
  initialAnchorId?: string
}

interface BlockNoteSetupResult {
  aiReady: boolean
}

export function useBlockNoteSetup({
  editor,
  aiPort,
  spellCheck,
  focusAtEndRef,
  editorContainerRef,
  onLinkClick,
  initialHighlight,
  initialAnchorId
}: BlockNoteSetupParams): BlockNoteSetupResult {
  const [aiReady, setAiReady] = useState(false)

  // AI extension registration
  useEffect(() => {
    if (!aiPort) return

    if (!editor.getExtension('ai')) {
      const transport = new DefaultChatTransport({
        api: `http://127.0.0.1:${aiPort}/api/ai/chat`
      })
      const aiExtension = AIExtension({ transport: transport as any })
      editor.registerExtension(aiExtension)
    }

    const readyTimer = window.setTimeout(() => {
      setAiReady(Boolean(editor.getExtension('ai')))
    }, 0)

    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault()
        const ai = editor.getExtension('ai')
        if (!ai?.openAIMenuAtBlock) return
        const cursor = editor.getTextCursorPosition()
        if (cursor?.block?.id) {
          ai.openAIMenuAtBlock(cursor.block.id)
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      window.clearTimeout(readyTimer)
      document.removeEventListener('keydown', handleKeyDown)
      editor.unregisterExtension('ai')
    }
  }, [aiPort, editor])

  // Expose the active editor on window. Production path for the Edit-menu
  // undo/redo and Insert/Format commands (lib/menu-commands.ts), and E2E
  // instrumentation. Read-only instances (template preview) must not claim the
  // global, and cleanup only clears its own registration so unmounting a later
  // preview/split pane doesn't deregister a still-live editor.
  useEffect(() => {
    if (!editor.isEditable) return
    const host = window as unknown as { __memryEditor?: unknown }
    host.__memryEditor = editor
    return () => {
      if (host.__memryEditor === editor) {
        delete host.__memryEditor
      }
    }
  }, [editor])

  // SpellCheck DOM sync
  useEffect(() => {
    if (spellCheck === undefined) return
    const container = editorContainerRef.current
    if (!container) return
    const applySpellCheck = (): void => {
      const ce = container.querySelector<HTMLElement>('[contenteditable="true"]')
      if (ce) ce.spellcheck = spellCheck
    }
    applySpellCheck()
    const t = setTimeout(applySpellCheck, 100)
    return () => clearTimeout(t)
  }, [spellCheck, editorContainerRef])

  // focusAtEndRef assignment
  useEffect(() => {
    if (!focusAtEndRef) return
    focusAtEndRef.current = () => {
      editor.focus()
      const blocks = editor.document
      if (blocks.length > 0) {
        const lastBlock = blocks[blocks.length - 1]
        editor.setTextCursorPosition(lastBlock.id, 'end')
      }
    }
  }, [editor, focusAtEndRef])

  // External link click handler.
  //
  // Wiki-link chips are NOT handled here any more. A chip reads as its raw
  // `[[…]]` while the caret is beside it, and the chip element is hidden to
  // make room for that — which happens between mousedown and mouseup on a
  // normal human click, so by the time `click` fires the chip is gone from the
  // DOM and the event has been retargeted to the paragraph. Navigation moved to
  // `createWikiLinkEditPlugin`'s `handleClickOn`, which reads the position
  // ProseMirror captured at mousedown. Do not restore a branch here: with both
  // in place a fast click fires both and the note opens twice.
  useEffect(() => {
    if (!onLinkClick) return

    const handleClick = (e: Event): void => {
      const mouseEvent = e as globalThis.MouseEvent
      const target = mouseEvent.target as HTMLElement
      const link = target.closest('a')
      if (link) {
        const href = link.getAttribute('href')
        if (href && !href.startsWith('#')) {
          mouseEvent.preventDefault()
          onLinkClick?.(href)
        }
      }
    }

    // Scope the lookup to this instance's own container. `document.querySelector`
    // returns whichever `.bn-editor` is first in the document, so with more than
    // one editor mounted (split view, or a note alongside the inbox/task
    // description editors) every instance bound to the same element: clicks in
    // the first pane fired every pane's callbacks, and clicks in any later pane
    // fired none.
    const editorElement = editorContainerRef.current?.querySelector('.bn-editor')
    editorElement?.addEventListener('click', handleClick)

    return () => {
      editorElement?.removeEventListener('click', handleClick)
    }
  }, [onLinkClick, editorContainerRef])

  // Scroll to highlight on mount
  useEffect(() => {
    if (!initialHighlight?.text || !editorContainerRef.current) return

    const scrollToHighlight = (): void => {
      const container = editorContainerRef.current
      if (!container) return

      const searchText = initialHighlight.text
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null)
      let node: Text | null

      while ((node = walker.nextNode() as Text | null)) {
        const nodeText = node.textContent || ''
        const index = nodeText.toLowerCase().indexOf(searchText.toLowerCase())

        if (index !== -1) {
          const parentElement = node.parentElement
          if (parentElement) {
            parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' })

            const originalBg = parentElement.style.backgroundColor
            parentElement.style.backgroundColor = 'rgba(251, 191, 36, 0.4)'
            parentElement.style.transition = 'background-color 0.3s ease'

            setTimeout(() => {
              parentElement.style.backgroundColor = originalBg
            }, 3000)
          }
          break
        }
      }
    }

    const timeoutId = setTimeout(scrollToHighlight, 500)
    return () => clearTimeout(timeoutId)
  }, [initialHighlight, editorContainerRef])

  // Scroll to inline date pill on mount (from note_date reminder navigation).
  // The pill DOM only exists once the CRDT doc has loaded and rendered, which
  // can take longer than a single fixed delay on large/slow notes — so retry
  // until the anchor is found (or give up after ~2s) instead of a lone 500ms
  // shot that silently misses.
  useEffect(() => {
    if (!initialAnchorId || !editorContainerRef.current) return

    let attempts = 0
    let timeoutId: ReturnType<typeof setTimeout>
    const tryScroll = (): void => {
      const container = editorContainerRef.current
      if (container && scrollToAnchor(container, initialAnchorId)) return
      if (++attempts >= 20) return
      timeoutId = setTimeout(tryScroll, 100)
    }
    timeoutId = setTimeout(tryScroll, 100)
    return () => clearTimeout(timeoutId)
  }, [initialAnchorId, editorContainerRef])

  // Derive aiReady so we don't reset state in an effect on prop change.
  return { aiReady: aiPort ? aiReady : false }
}
