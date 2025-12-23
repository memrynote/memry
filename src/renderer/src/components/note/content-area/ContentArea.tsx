/**
 * ContentArea Component
 * BlockNote-based block editor for note content
 * Uses shadcn/ui components for consistent styling
 */

import { memo, useCallback, useEffect } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/shadcn'
import type { Block } from '@blocknote/core'
import { useTheme } from 'next-themes'

// BlockNote styles
import '@blocknote/core/fonts/inter.css'
import '@blocknote/shadcn/style.css'

import { cn } from '@/lib/utils'
import type { ContentAreaProps, HeadingInfo } from './types'

// =============================================================================
// HEADING EXTRACTION
// =============================================================================

/**
 * Extract headings from BlockNote blocks for outline navigation
 */
function extractHeadings(blocks: Block[]): HeadingInfo[] {
  const headings: HeadingInfo[] = []
  let position = 0

  function processBlock(block: Block) {
    if (block.type === 'heading') {
      const level = (block.props?.level as 1 | 2 | 3) || 1
      // Extract text from inline content
      const text = Array.isArray(block.content)
        ? block.content
          .map((item) => {
            if (typeof item === 'string') return item
            if (item && typeof item === 'object' && 'text' in item) return item.text
            return ''
          })
          .join('')
        : ''

      if (text.trim()) {
        headings.push({
          id: block.id,
          text: text.trim(),
          level,
          position: position * 40 // Approximate position
        })
      }
      position++
    }

    // Process children recursively
    if (block.children && Array.isArray(block.children)) {
      block.children.forEach((child) => processBlock(child as Block))
    }
  }

  blocks.forEach((block) => processBlock(block as Block))
  return headings
}

// =============================================================================
// CONTENT AREA COMPONENT
// =============================================================================

/**
 * ContentArea - BlockNote-based rich text editor
 *
 * Features:
 * - Block-based editing (Notion-style)
 * - Slash commands for inserting blocks
 * - Formatting toolbar on text selection
 * - Heading extraction for outline panel
 * - shadcn/ui styling integration
 */
export const ContentArea = memo(function ContentArea({
  initialContent,
  contentType = 'html',
  placeholder = "Start writing, or press '/' for commands...",
  editable = true,
  onContentChange,
  onMarkdownChange,
  onHeadingsChange,
  onLinkClick,
  className
}: ContentAreaProps) {
  // T030: Get current theme for dark mode support
  const { resolvedTheme } = useTheme()
  const editorTheme = resolvedTheme === 'dark' ? 'dark' : 'light'

  // Create the BlockNote editor
  const editor = useCreateBlockNote({
    // Configure placeholders
    placeholders: {
      default: placeholder,
      heading: 'Heading',
      bulletListItem: 'List item',
      numberedListItem: 'List item',
      checkListItem: 'To-do item'
    }
  })

  // Parse content based on content type
  useEffect(() => {
    async function loadContent() {
      if (typeof initialContent === 'string' && initialContent.trim()) {
        try {
          let blocks
          if (contentType === 'markdown') {
            blocks = await editor.tryParseMarkdownToBlocks(initialContent)
          } else {
            // Default to HTML parsing
            blocks = await editor.tryParseHTMLToBlocks(initialContent)
          }
          editor.replaceBlocks(editor.document, blocks)
        } catch (error) {
          console.error(`Failed to parse ${contentType} content:`, error)
        }
      } else if (Array.isArray(initialContent) && initialContent.length > 0) {
        // If it's already blocks, replace the document
        editor.replaceBlocks(editor.document, initialContent)
      }
    }
    loadContent()
  }, [editor, initialContent, contentType])

  // Handle content changes
  const handleChange = useCallback(async () => {
    const blocks = editor.document

    // Notify parent of content changes (blocks)
    onContentChange?.(blocks as Block[])

    // Notify parent of markdown changes if callback provided
    if (onMarkdownChange) {
      try {
        const markdown = await editor.blocksToMarkdownLossy(blocks)
        onMarkdownChange(markdown)
      } catch (error) {
        console.error('Failed to convert blocks to markdown:', error)
      }
    }

    // Extract and emit headings for outline
    if (onHeadingsChange) {
      const headings = extractHeadings(blocks as Block[])
      onHeadingsChange(headings)
    }
  }, [editor, onContentChange, onMarkdownChange, onHeadingsChange])

  // Initial heading extraction
  useEffect(() => {
    if (onHeadingsChange) {
      const headings = extractHeadings(editor.document as Block[])
      onHeadingsChange(headings)
    }
  }, [editor, onHeadingsChange])

  // Handle link clicks
  useEffect(() => {
    if (!onLinkClick) return

    const handleClick = (e: Event) => {
      const mouseEvent = e as globalThis.MouseEvent
      const target = mouseEvent.target as HTMLElement
      const link = target.closest('a')
      if (link) {
        const href = link.getAttribute('href')
        if (href && !href.startsWith('#')) {
          mouseEvent.preventDefault()
          onLinkClick(href)
        }
      }
    }

    // Add click listener to editor container
    const editorElement = document.querySelector('.bn-editor')
    editorElement?.addEventListener('click', handleClick)

    return () => {
      editorElement?.removeEventListener('click', handleClick)
    }
  }, [onLinkClick])

  return (
    <div className={cn('content-area h-full flex flex-col', className)}>
      {/* BlockNote Editor */}
      <div className="bn-container flex-1 min-h-[300px]">
        <BlockNoteView
          editor={editor}
          editable={editable}
          onChange={handleChange}
          theme={editorTheme}
        />
      </div>
    </div>
  )
})

export default ContentArea
