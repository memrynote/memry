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

import '@blocknote/shadcn/style.css'

import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'
import { extractTitleFromBlocks } from '@/lib/blocknote-title'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('Component:InboxContentEditor')

interface InboxContentEditorProps {
  /** Initial content (markdown) */
  initialContent: string | null
  /** Called when content changes */
  onContentChange?: (content: string) => void
  /** Called when the first line (title) changes */
  onTitleChange?: (title: string) => void
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
  onTitleChange,
  editable = true,
  placeholder = 'Edit your captured text...',
  className
}: InboxContentEditorProps) {
  const { t: tPhaseF } = useT('inbox')
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
      if (typeof initialContent !== 'string' || !initialContent.trim()) {
        isContentReadyRef.current = true
        return
      }
      try {
        // Inbox content is markdown (article extraction, captured text, screenshots).
        // Parse it like the note page so bold/headings/links render instead of raw `**…**`.
        const blocks = await editor.tryParseMarkdownToBlocks(initialContent)
        if (blocks.length > 0) {
          editor.replaceBlocks(editor.document, blocks)
        }
      } catch (error) {
        log.error('Failed to parse markdown content', error)
      } finally {
        isContentReadyRef.current = true
      }
    }
    void loadContent()
  }, [editor, initialContent])

  // Handle content changes - convert to HTML and notify parent
  const handleChange = useCallback(async () => {
    if (!isContentReadyRef.current) return

    try {
      onTitleChange?.(extractTitleFromBlocks(editor.document))

      if (onContentChange) {
        const markdown = await editor.blocksToMarkdownLossy(editor.document)
        onContentChange(markdown)
      }
    } catch (error) {
      log.error('Failed to convert content', error)
    }
  }, [editor, onContentChange, onTitleChange])

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
        '[&_.bn-container]:flex-1',
        editable && 'cursor-text',
        className
      )}
      role="region"
      aria-label={tPhaseF('phaseF.componentsInboxDetailInboxContentEditor.contentEditor')}
      onMouseDown={handleContainerMouseDown}
    >
      <BlockNoteView
        editor={editor}
        editable={editable}
        onChange={() => void handleChange()}
        theme={editorTheme}
      />
    </div>
  )
})

export default InboxContentEditor
