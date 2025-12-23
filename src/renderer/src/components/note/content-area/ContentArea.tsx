/**
 * ContentArea Component
 * BlockNote-based block editor for note content
 * Uses shadcn/ui components for consistent styling
 */

import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import { SuggestionMenuController, useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/shadcn'
import { BlockNoteSchema, defaultInlineContentSpecs, type Block } from '@blocknote/core'
import { useTheme } from 'next-themes'

// BlockNote styles
import '@blocknote/core/fonts/inter.css'
import '@blocknote/shadcn/style.css'

import { cn } from '@/lib/utils'
import { fuzzySearch } from '@/lib/fuzzy-search'
import { notesService } from '@/services/notes-service'
import type { ContentAreaProps, HeadingInfo } from './types'
import { createWikiLinkInlineContent, WikiLink } from './wiki-link'
import { WikiLinkMenu, type WikiLinkSuggestionItem } from './wiki-link-menu'

type NoteSuggestion = {
  id: string
  title: string
  modified?: Date | string
}

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
// WIKI LINK UTILITIES
// =============================================================================

const WIKI_LINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g

function splitWikiLinkQuery(query: string) {
  const [rawTarget, rawAlias] = query.split('|', 2)
  return {
    search: rawTarget?.trim() ?? '',
    alias: rawAlias?.trim() ?? ''
  }
}

function createStyledText(text: string, styles: Record<string, boolean | string>) {
  return { type: 'text', text, styles }
}

function splitTextWithWikiLinks(
  text: string,
  styles?: Record<string, boolean | string>
): { segments: Array<string | Record<string, unknown>>; didChange: boolean } {
  const segments: Array<string | Record<string, unknown>> = []
  const pattern = new RegExp(WIKI_LINK_PATTERN)
  let didChange = false
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    const [full, rawTarget, rawAlias] = match
    const target = rawTarget?.trim()
    const alias = rawAlias?.trim() ?? ''

    if (!target) {
      continue
    }

    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index)
      if (before) {
        segments.push(styles ? createStyledText(before, styles) : before)
      }
    }

    segments.push(createWikiLinkInlineContent(target, alias, styles ?? {}))
    didChange = true
    lastIndex = match.index + full.length
  }

  if (!didChange) {
    return { segments: [styles ? createStyledText(text, styles) : text], didChange: false }
  }

  const trailing = text.slice(lastIndex)
  if (trailing) {
    segments.push(styles ? createStyledText(trailing, styles) : trailing)
  }

  return { segments, didChange: true }
}

function normalizeInlineContent(
  content: string | Array<any>
): { content: string | Array<any>; didChange: boolean } {
  if (typeof content === 'string') {
    const { segments, didChange } = splitTextWithWikiLinks(content)
    if (!didChange) return { content, didChange: false }
    return { content: segments, didChange: true }
  }

  if (!Array.isArray(content)) {
    return { content, didChange: false }
  }

  let didChange = false
  const next: Array<any> = []

  for (const item of content) {
    if (typeof item === 'string') {
      const { segments, didChange: itemChanged } = splitTextWithWikiLinks(item)
      if (itemChanged) {
        didChange = true
        next.push(...segments)
      } else {
        next.push(item as any)
      }
      continue
    }

    if (item?.type === 'text') {
      const styles = item.styles ?? {}
      const { segments, didChange: itemChanged } = splitTextWithWikiLinks(item.text ?? '', styles)
      if (itemChanged) {
        didChange = true
        next.push(...segments)
      } else {
        next.push(item)
      }
      continue
    }

    if (item?.type === 'wikiLink') {
      next.push(item)
      continue
    }

    next.push(item)
  }

  return { content: didChange ? next : content, didChange }
}

function normalizeTableContent(tableContent: any): { content: any; didChange: boolean } {
  if (!tableContent?.rows) {
    return { content: tableContent, didChange: false }
  }

  let didChange = false
  const rows = tableContent.rows.map((row: any) => {
    let rowChanged = false
    const cells = row.cells.map((cell: any) => {
      if (Array.isArray(cell)) {
        const normalized = normalizeInlineContent(cell)
        if (normalized.didChange) {
          rowChanged = true
        }
        return normalized.content
      }

      if (cell?.type === 'tableCell') {
        const normalized = normalizeInlineContent(cell.content ?? '')
        if (normalized.didChange) {
          rowChanged = true
          return { ...cell, content: normalized.content }
        }
      }

      return cell
    })

    if (rowChanged) {
      didChange = true
      return { ...row, cells }
    }
    return row
  })

  if (!didChange) {
    return { content: tableContent, didChange: false }
  }

  return { content: { ...tableContent, rows }, didChange: true }
}

function normalizeWikiLinks(blocks: Block[]): { blocks: Block[]; didChange: boolean } {
  let didChange = false

  const nextBlocks = blocks.map((block) => {
    if (block.type === 'codeBlock') {
      return block
    }

    let blockChanged = false
    let nextBlock: Block = block

    if (block.content) {
      if (typeof block.content === 'string' || Array.isArray(block.content)) {
        const normalized = normalizeInlineContent(block.content as any)
        if (normalized.didChange) {
          blockChanged = true
          nextBlock = { ...nextBlock, content: normalized.content as any }
        }
      } else if ((block.content as any).type === 'tableContent') {
        const normalized = normalizeTableContent(block.content)
        if (normalized.didChange) {
          blockChanged = true
          nextBlock = { ...nextBlock, content: normalized.content }
        }
      }
    }

    if (block.children?.length) {
      const normalizedChildren = normalizeWikiLinks(block.children as Block[])
      if (normalizedChildren.didChange) {
        blockChanged = true
        nextBlock = { ...nextBlock, children: normalizedChildren.blocks }
      }
    }

    if (blockChanged) {
      didChange = true
    }

    return blockChanged ? nextBlock : block
  })

  return { blocks: didChange ? nextBlocks : blocks, didChange }
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
  onInternalLinkClick,
  className
}: ContentAreaProps) {
  // T030: Get current theme for dark mode support
  const { resolvedTheme } = useTheme()
  const editorTheme = resolvedTheme === 'dark' ? 'dark' : 'light'

  const schema = useMemo(
    () =>
      BlockNoteSchema.create({
        inlineContentSpecs: {
          ...defaultInlineContentSpecs,
          wikiLink: WikiLink
        }
      }),
    []
  )

  // Create the BlockNote editor
  const editor = useCreateBlockNote({
    schema,
    // Configure placeholders
    placeholders: {
      default: placeholder,
      heading: 'Heading',
      bulletListItem: 'List item',
      numberedListItem: 'List item',
      checkListItem: 'To-do item'
    }
  })

  const notesCacheRef = useRef<{ notes: NoteSuggestion[]; fetchedAt: number } | null>(null)

  const getWikiLinkItems = useCallback(
    async (query: string): Promise<WikiLinkSuggestionItem[]> => {
      const now = Date.now()
      const cache = notesCacheRef.current
      const shouldRefresh = !cache || now - cache.fetchedAt > 5000
      if (shouldRefresh) {
        try {
          const result = await notesService.list({ limit: 500, sortBy: 'modified' })
          notesCacheRef.current = {
            notes: result.notes.map((note) => ({
              id: note.id,
              title: note.title,
              modified: note.modified
            })),
            fetchedAt: now
          }
        } catch (error) {
          console.error('[ContentArea] Failed to load wiki link suggestions:', error)
          notesCacheRef.current = { notes: [], fetchedAt: now }
        }
      }

      const notes = notesCacheRef.current?.notes ?? []
      const { search, alias } = splitWikiLinkQuery(query)
      const filtered = search ? fuzzySearch(notes, search, ['title']) : notes
      const sorted = filtered.slice(0, 10)

      const suggestions: WikiLinkSuggestionItem[] = sorted.map((note) => ({
        id: note.id,
        title: note.title,
        target: note.title,
        alias,
        exists: true,
        type: 'note',
        lastEdited: note.modified instanceof Date ? note.modified.toISOString() : note.modified
      }))

      const hasExactMatch = search
        ? filtered.some((note) => note.title.toLowerCase() === search.toLowerCase())
        : true

      if (search && !hasExactMatch) {
        suggestions.push({
          id: `create:${search}`,
          title: search,
          target: search,
          alias,
          exists: false,
          type: 'create'
        })
      }

      return suggestions
    },
    []
  )

  const handleWikiLinkSelect = useCallback(
    (item: WikiLinkSuggestionItem) => {
      if (!item.target) return
      const styles = editor.getActiveStyles()
      editor.insertInlineContent(
        [createWikiLinkInlineContent(item.target, item.alias ?? '', styles as Record<string, boolean | string>)],
        { updateSelection: true }
      )
    },
    [editor]
  )

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
          const normalized = normalizeWikiLinks(blocks)
          editor.replaceBlocks(editor.document, normalized.blocks)
        } catch (error) {
          console.error(`Failed to parse ${contentType} content:`, error)
        }
      } else if (Array.isArray(initialContent) && initialContent.length > 0) {
        // If it's already blocks, replace the document
        const normalized = normalizeWikiLinks(initialContent as Block[])
        editor.replaceBlocks(editor.document, normalized.blocks)
      }
    }
    loadContent()
  }, [editor, initialContent, contentType])

  // Handle content changes
  const handleChange = useCallback(async () => {
    const blocks = editor.document
    const normalized = normalizeWikiLinks(blocks as Block[])
    if (normalized.didChange) {
      editor.replaceBlocks(editor.document, normalized.blocks)
      return
    }

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
    if (!onLinkClick && !onInternalLinkClick) return

    const handleClick = (e: Event) => {
      const mouseEvent = e as globalThis.MouseEvent
      const target = mouseEvent.target as HTMLElement
      const wikiLink = target.closest('[data-wiki-link]')
      if (wikiLink) {
        const targetTitle = wikiLink.getAttribute('data-target')?.trim()
        if (targetTitle) {
          mouseEvent.preventDefault()
          window.dispatchEvent(new CustomEvent('wikilink:click', { detail: { target: targetTitle } }))
          onInternalLinkClick?.(targetTitle)
          return
        }
      }
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
  }, [onLinkClick, onInternalLinkClick])

  return (
    <div className={cn('content-area h-full flex flex-col', className)}>
      {/* BlockNote Editor */}
      <div className="bn-container flex-1 min-h-[300px]">
        <BlockNoteView
          editor={editor}
          editable={editable}
          onChange={handleChange}
          theme={editorTheme}
        >
          <SuggestionMenuController
            triggerCharacter="[["
            getItems={getWikiLinkItems}
            suggestionMenuComponent={WikiLinkMenu}
            onItemClick={handleWikiLinkSelect}
          />
        </BlockNoteView>
      </div>
    </div>
  )
})

export default ContentArea
