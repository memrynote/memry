/**
 * InboxContentEditor Component
 * BlockNote-based editor for editing inbox item content
 * Simpler than the full note ContentArea - no wiki links or file attachments
 */

import { memo, useCallback, useEffect, useRef } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/shadcn'
import { useTheme } from 'next-themes'

// BlockNote styles
import '@blocknote/core/fonts/inter.css'
import '@blocknote/shadcn/style.css'

import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:InboxContentEditor')

interface InboxContentEditorProps {
  /** Initial content (plain text or HTML) */
  initialContent: string | null
  /** Called when content changes */
  onContentChange?: (content: string) => void
  /** Whether the editor is editable */
  editable?: boolean
  /** Optional placeholder text */
  placeholder?: string
  /** Optional className */
  className?: string
}

/**
 * InboxContentEditor - BlockNote-based rich text editor for inbox items
 *
 * Features:
 * - Block-based editing (Notion-style)
 * - Slash commands for inserting blocks
 * - Formatting toolbar on text selection
 * - Auto-saves on content change
 */
export const InboxContentEditor = memo(function InboxContentEditor({
  initialContent,
  onContentChange,
  editable = true,
  placeholder = 'Edit your captured text...',
  className
}: InboxContentEditorProps) {
  // Get current theme for dark mode support
  const { resolvedTheme } = useTheme()
  const editorTheme = resolvedTheme === 'dark' ? 'dark' : 'light'

  // Track if initial content has been loaded
  const initialContentLoadedRef = useRef(false)

  // Track if content is ready for saving
  const isContentReadyRef = useRef(false)

  // Create the BlockNote editor
  const editor = useCreateBlockNote({
    placeholders: {
      default: placeholder,
      heading: 'Heading',
      bulletListItem: 'List item',
      numberedListItem: 'List item',
      checkListItem: 'To-do item'
    }
  })

  // Parse and load initial content
  useEffect(() => {
    if (initialContentLoadedRef.current) {
      return
    }
    initialContentLoadedRef.current = true

    async function loadContent() {
      try {
        if (typeof initialContent === 'string' && initialContent.trim()) {
          // Try to parse as HTML first, fallback to plain text
          try {
            const blocks = await editor.tryParseHTMLToBlocks(initialContent)
            if (blocks.length > 0) {
              editor.replaceBlocks(editor.document, blocks)
            } else {
              // If HTML parsing gives empty result, try as plain text
              const plainTextBlock = {
                type: 'paragraph' as const,
                content: initialContent
              }
              editor.replaceBlocks(editor.document, [plainTextBlock])
            }
          } catch {
            // Fallback: treat as plain text
            const plainTextBlock = {
              type: 'paragraph' as const,
              content: initialContent
            }
            editor.replaceBlocks(editor.document, [plainTextBlock])
          }
        }
      } finally {
        isContentReadyRef.current = true
      }
    }
    loadContent()
  }, [editor, initialContent])

  // Handle content changes - convert to HTML and notify parent
  const handleChange = useCallback(async () => {
    if (!onContentChange || !isContentReadyRef.current) return

    try {
      // Convert blocks to HTML for storage
      const html = await editor.blocksToHTMLLossy(editor.document)
      onContentChange(html)
    } catch (error) {
      log.error('Failed to convert content', error)
    }
  }, [editor, onContentChange])

  const handleContainerMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!editable) return

      const target = e.target as HTMLElement

      if (
        target.closest('[contenteditable="true"]')?.contains(target) &&
        target.closest('.bn-block-content')
      ) {
        return
      }

      if (target.closest('button, a, input')) {
        return
      }

      const editorElement = (e.currentTarget as HTMLElement).querySelector(
        '.bn-editor [contenteditable="true"]'
      ) as HTMLElement

      if (editorElement) {
        e.preventDefault()
        editorElement.focus()
      }
    },
    [editable]
  )

  return (
    <div
      className={cn(
        'inbox-content-editor prose prose-sm dark:prose-invert max-w-none',
        'min-h-[300px] flex flex-col',
        '[&_.bn-editor]:min-h-[280px] [&_.bn-editor]:flex-1',
        '[&_.bn-container]:bg-transparent [&_.bn-container]:flex-1',
        editable && 'cursor-text',
        className
      )}
      role="region"
      aria-label="Content editor"
      onMouseDown={handleContainerMouseDown}
    >
      <BlockNoteView
        editor={editor}
        editable={editable}
        onChange={handleChange}
        theme={editorTheme}
      />
    </div>
  )
})

export default InboxContentEditor
