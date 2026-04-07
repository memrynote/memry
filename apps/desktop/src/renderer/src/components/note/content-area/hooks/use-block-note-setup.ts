/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */

import { useEffect, useState } from 'react'
import { AIExtension } from '@blocknote/xl-ai'
import { DefaultChatTransport } from 'ai'
import type { HighlightInfo } from '../types'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:BlockNoteSetup')

interface BlockNoteSetupParams {
  editor: any
  aiPort?: number | null
  spellCheck?: boolean
  focusAtEndRef?: React.RefObject<(() => void) | null>
  editorContainerRef: React.RefObject<HTMLDivElement | null>
  onLinkClick?: (href: string) => void
  onInternalLinkClick?: (noteIdOrTitle: string) => void
  initialHighlight?: HighlightInfo
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
  onInternalLinkClick,
  initialHighlight
}: BlockNoteSetupParams): BlockNoteSetupResult {
  const [aiReady, setAiReady] = useState(false)

  // AI extension registration
  useEffect(() => {
    if (!aiPort) {
      setAiReady(false)
      return
    }
    if (editor.getExtension('ai')) {
      setAiReady(true)
      return
    }

    const transport = new DefaultChatTransport({
      api: `http://127.0.0.1:${aiPort}/api/ai/chat`
    })
    const aiExtension = AIExtension({ transport: transport as any })
    editor.registerExtension(aiExtension)
    setAiReady(true)
    log.info('AI extension registered, port:', aiPort)

    return () => {
      editor.unregisterExtension('ai')
      setAiReady(false)
    }
  }, [aiPort, editor])

  // AI keyboard shortcut (Cmd+J)
  useEffect(() => {
    if (!aiReady) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault()
        const ai = editor.getExtension('ai') as any
        if (!ai?.openAIMenuAtBlock) return
        const cursor = editor.getTextCursorPosition()
        if (cursor?.block?.id) {
          ai.openAIMenuAtBlock(cursor.block.id)
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [aiReady, editor])

  // E2E test instrumentation: expose the active editor on window so Playwright
  // tests can drive the editor via its API (avoiding typing-race conditions
  // with auto-promote handlers). Only the currently mounted editor is exposed.
  useEffect(() => {
    ;(window as unknown as { __memryEditor?: unknown }).__memryEditor = editor
    return () => {
      delete (window as unknown as { __memryEditor?: unknown }).__memryEditor
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

  // Link click handler
  useEffect(() => {
    if (!onLinkClick && !onInternalLinkClick) return

    const handleClick = (e: Event): void => {
      const mouseEvent = e as globalThis.MouseEvent
      const target = mouseEvent.target as HTMLElement
      const wikiLink = target.closest('[data-wiki-link]')
      if (wikiLink) {
        const targetTitle = wikiLink.getAttribute('data-target')?.trim()
        if (targetTitle) {
          mouseEvent.preventDefault()
          window.dispatchEvent(
            new CustomEvent('wikilink:click', { detail: { target: targetTitle } })
          )
          onInternalLinkClick?.(targetTitle)
          return
        }
      }
      const link = target.closest('a')
      if (link) {
        const href = link.getAttribute('href')
        if (href && !href.startsWith('#')) {
          mouseEvent.preventDefault()
          onLinkClick?.(href)
        }
      }
    }

    const editorElement = document.querySelector('.bn-editor')
    editorElement?.addEventListener('click', handleClick)

    return () => {
      editorElement?.removeEventListener('click', handleClick)
    }
  }, [onLinkClick, onInternalLinkClick])

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

  return { aiReady }
}
