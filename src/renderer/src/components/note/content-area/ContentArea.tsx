/**
 * ContentArea Component
 * BlockNote-based block editor for note content
 * Uses shadcn/ui components for consistent styling
 */

import { memo, useCallback, useEffect } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/shadcn'
import type { Block } from '@blocknote/core'

// BlockNote styles
import '@blocknote/core/fonts/inter.css'
import '@blocknote/shadcn/style.css'

import { cn } from '@/lib/utils'
import { ContentDivider } from './ContentDivider'
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
  placeholder = "Start writing, or press '/' for commands...",
  editable = true,
  onContentChange,
  onHeadingsChange,
  onLinkClick,
  className
}: ContentAreaProps) {
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

  // Parse HTML content if provided as string
  useEffect(() => {
    async function loadHTMLContent() {
      if (typeof initialContent === 'string' && initialContent.trim()) {
        try {
          const blocks = await editor.tryParseHTMLToBlocks(initialContent)
          editor.replaceBlocks(editor.document, blocks)
        } catch (error) {
          console.error('Failed to parse HTML content:', error)
        }
      } else if (Array.isArray(initialContent) && initialContent.length > 0) {
        // If it's already blocks, replace the document
        editor.replaceBlocks(editor.document, initialContent)
      }
    }
    loadHTMLContent()
  }, [editor, initialContent])

  // Handle content changes
  const handleChange = useCallback(() => {
    const blocks = editor.document

    // Notify parent of content changes
    onContentChange?.(blocks as Block[])

    // Extract and emit headings for outline
    if (onHeadingsChange) {
      const headings = extractHeadings(blocks as Block[])
      onHeadingsChange(headings)
    }
  }, [editor, onContentChange, onHeadingsChange])

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
    <div className={cn('content-area', className)}>
      {/* Content divider */}
      <ContentDivider />

      {/* BlockNote Editor */}
      <div className="bn-container min-h-[300px]">
        <BlockNoteView
          editor={editor}
          editable={editable}
          onChange={handleChange}
          theme="light"
        />
      </div>
    </div>
  )
})

export default ContentArea
